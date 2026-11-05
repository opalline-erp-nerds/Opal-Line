import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { desc, eq, inArray, isNotNull, isNull, like, or, sql } from 'drizzle-orm'
import { config, isConfigured, normalizeShopDomain } from './config'
import { db, schema } from './db/client'
import {
  fillOrKeep,
  mergeAddress,
  normalizeEmail,
  normalizePhone,
  orderCustomerPiiRedacted,
  parseOrderAddress,
  upgradeName,
  usableText,
  type OrderAddress,
} from './shopifyCustomerData'
import type { SilverRateStepLog, SilverRateStepRecord } from './db/schema'
import type { SyncCustomer, SyncLogEntry, SyncOrder, SyncPrice, SyncProduct, SyncResource, SyncStore } from './types'
import { CONSTANTS } from './constants'
import { logger } from './logger'
import { recordAudit } from './activity'
import { applyStockMovement } from './stock'

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Sanitize a local product description for Shopify's body_html. Paragraph
 * and line-break tags are preserved (shop editors use them); scripts, event
 * handlers, iframes, styles and javascript: URLs are stripped so a local
 * editor can never inject active content into the storefront.
 */
export function sanitizeProductDescription(raw: string): string {
  const ALLOWED = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote'])
  let html = raw
  // Drop script/style blocks entirely, then any remaining tags not allowlisted.
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '')
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '')
  html = html.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (match, tag: string) => {
    if (!ALLOWED.has(tag.toLowerCase())) return ''
    return match.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '')
  })
  return html.trim()
}

export function toDescriptionHtml(localDescription: string | null | undefined, name: string): string {
  const text = (localDescription ?? '').trim()
  if (!text) return `<p>${escapeHtml(name)}</p>`
  // Plain text or text with no real HTML structure → escape and wrap as
  // paragraphs (this also escapes stray angle brackets users typed literally).
  if (!/<\s*(p|br|ul|ol|li|h[1-4]|div)\b/i.test(text)) {
    return text
      .split(/\n+/)
      .map((para) => `<p>${escapeHtml(para.trim())}</p>`)
      .join('')
  }
  return sanitizeProductDescription(text)
}

const MAX_STORE_ITEMS = 10000

export const store: SyncStore = {
  products: [],
  orders: [],
  customers: [],
  inventory: [],
  price: [],
  lastSync: {},
  syncing: false,
  logs: [],
}

let syncPromise: Promise<unknown> | null = null
let syncLockAcquired = false

async function acquireSyncLock(_label: string): Promise<boolean> {
  if (syncLockAcquired || syncPromise) return false
  syncLockAcquired = true
  syncPromise = Promise.resolve()
  store.syncing = true
  return true
}

function releaseSyncLock() {
  syncPromise = null
  syncLockAcquired = false
  store.syncing = false
}

let logSeq = 0

function addLog(resource: SyncResource, status: SyncLogEntry['status'], count: number, message?: string) {
  store.logs.unshift({
    id: `LOG-${++logSeq}`,
    resource,
    status,
    count,
    time: new Date().toISOString(),
    message,
  })
  store.logs = store.logs.slice(0, CONSTANTS.LOG_MAX_ENTRIES)
}

let dbLogSeq = 0

async function persistLog(entry: {
  entity: string
  shopifyId?: string | null
  direction: 'in' | 'out'
  action: string
  status: 'success' | 'failed' | 'skipped'
  error?: string
  retry?: boolean
}) {
  if (!db) return
  try {
    await db.insert(schema.syncLogs).values({
      id: `LOG-${Date.now()}-${++dbLogSeq}`,
      entity: entry.entity,
      shopifyId: entry.shopifyId ?? null,
      direction: entry.direction,
      action: entry.action,
      status: entry.status,
      time: new Date().toISOString(),
      error: entry.error ?? null,
      retry: entry.retry ?? false,
    })
  } catch {
    // Log persistence must never break a sync.
  }
}

const entityFor: Record<SyncResource, { entity: string; action: string }> = {
  orders: { entity: 'Order', action: 'Imported' },
  products: { entity: 'Product', action: 'Imported' },
  customers: { entity: 'Customer', action: 'Imported' },
  inventory: { entity: 'Inventory', action: 'Stock Update' },
  price: { entity: 'Price', action: 'Price Sync' },
}

class ShopifyError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
  }
}

function apiPath(version: string, resource: string) {
  return `https://${config.shop}.myshopify.com/admin/api/${version}/${resource}.json`
}

interface ShopifyResponse<T> {
  json: T
  nextPageToken: string | null
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function shopifyRequest<T>(resource: string, query = '', _attempt = 0): Promise<ShopifyResponse<T>> {
  if (!isConfigured()) {
    throw new ShopifyError('Shopify is not configured. Set SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN in server/.env', 503)
  }
  const url = new URL(apiPath(config.apiVersion, resource))
  const params = new URLSearchParams(query)
  params.set('limit', String(CONSTANTS.SHOPIFY_API_LIMIT))
  url.search = params.toString()

  const maxRetries = CONSTANTS.SHOPIFY_MAX_RETRIES
  const baseDelay = CONSTANTS.SHOPIFY_BASE_RETRY_DELAY_MS

  for (let tryNum = 0; tryNum <= maxRetries; tryNum++) {
    const res = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': config.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    })

    if (res.status === 401) {
      throw new ShopifyError('Shopify rejected the access token. Check SHOPIFY_ACCESS_TOKEN and app scopes.', 401)
    }
    if (res.status === 403) {
      throw new ShopifyError(`The access token is missing required scopes (read_orders, read_products, read_inventory, read_customers). ${SCOPE_FIX_HINT}`, 403)
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After')
      const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : baseDelay * Math.pow(2, tryNum)
      if (tryNum < maxRetries) {
        await sleep(delay)
        continue
      }
      throw new ShopifyError('Shopify rate limit exceeded. Please try again later.', 429)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      if (res.status >= 500 && tryNum < maxRetries) {
        await sleep(baseDelay * Math.pow(2, tryNum))
        continue
      }
      throw new ShopifyError(`Shopify API error ${res.status}: ${text.slice(0, 200)}`, res.status)
    }

    let nextPageToken: string | null = null
    const link = res.headers.get('link')
    if (link) {
      const match = link.match(/page_info=([^>]+)>;\s*rel="next"/)
      if (match) nextPageToken = match[1]
    }

    return { json: (await res.json()) as T, nextPageToken }
  }

  throw new ShopifyError('Max retries exceeded for Shopify API', 503)
}

/**
 * Admin API fetch that retries throttled (429) and transient server (5xx)
 * responses with the same backoff policy as shopifyRequest: honor Retry-After
 * when Shopify sends one, otherwise exponential backoff from the shared base
 * delay. Every other status — including a final 429/5xx once retries are
 * exhausted — is handed back to the caller so its own handling stays intact
 * (409/422 "already a member", 404 "already gone", ...). Collection membership
 * used to use bare fetch here, so a single throttle burst failed the sync with
 * "Shopify API error 429 while reading collection membership".
 */
async function adminFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const maxRetries = CONSTANTS.SHOPIFY_MAX_RETRIES
  const baseDelay = CONSTANTS.SHOPIFY_BASE_RETRY_DELAY_MS
  for (let tryNum = 0; tryNum <= maxRetries; tryNum++) {
    const res = await fetch(input, init)
    const retryable = res.status === 429 || res.status >= 500
    if (!retryable || tryNum === maxRetries) return res
    // Drain the body before waiting so the connection is released.
    await res.text().catch(() => '')
    const retryAfter = res.status === 429 ? res.headers.get('Retry-After') : null
    const parsed = retryAfter ? parseInt(retryAfter, 10) : Number.NaN
    const delay = Number.isFinite(parsed) && parsed >= 0 ? parsed * 1000 : baseDelay * Math.pow(2, tryNum)
    await sleep(delay)
  }
  throw new ShopifyError('Max retries exceeded for Shopify API', 503)
}

/**
 * The Admin API scopes Opal Line's Shopify integration actually uses: reads
 * for sync-in, writes for manual-order draft creation, order updates, and the
 * product/inventory pushes. A custom-app token issued without a write scope
 * passes a shop.json probe and then fails mid-flow ("Access denied for
 * draftOrderCreate field. Required access: `write_draft_orders` …"), so the
 * connection test names the gaps up front.
 */
export const REQUIRED_SHOPIFY_SCOPES = [
  'read_products',
  'read_orders',
  'read_customers',
  'read_inventory',
  'write_draft_orders',
  'write_orders',
  'write_products',
  'write_inventory',
] as const

const SCOPE_FIX_HINT =
  'To fix: in the Shopify admin open Settings → Apps and sales channels → the app → Configuration → Admin API scopes, '
  + 'tick the missing scopes and SAVE — then REGENERATE the Admin API access token, because an existing token keeps its '
  + 'old scopes — and paste the new token under Settings → Connections in Opal Line (or SHOPIFY_ACCESS_TOKEN in .env).'

/**
 * Appends actionable fix-it guidance to Shopify's raw missing-scope error so
 * the order toast says where to grant the scope, not just that it is missing.
 * Returns the message unchanged when it is not a scope error.
 */
export function withScopeFixHint(message: string): string {
  if (!/access denied|required access|missing .*scopes?|does not have the required scopes/i.test(message)) return message
  const scopes = [...message.matchAll(/`([a-z0-9_]+)`/g)]
    .map((m) => m[1])
    .filter((s) => s.includes('_'))
  const named =
    scopes.length > 0 ? ` Missing scope${scopes.length > 1 ? 's' : ''}: ${[...new Set(scopes)].join(', ')}.` : ''
  return `${message}${named} ${SCOPE_FIX_HINT}`
}

export async function testShopifyConnection(overrides?: {
  shop?: string
  accessToken?: string
}): Promise<{ ok: boolean; error?: string; shop?: string }> {
  const shop = overrides?.shop?.trim() ? normalizeShopDomain(overrides.shop) : config.shop
  const accessToken = overrides?.accessToken?.trim() ? overrides.accessToken.trim() : config.accessToken
  if (!shop || !accessToken) {
    return { ok: false, error: 'Shopify is not configured. Enter the store URL and access token, then click Save.' }
  }
  // eslint-disable-next-line no-control-regex -- deliberately matches the Latin-1 range to catch masked/corrupted credentials
  // eslint-disable-next-line no-control-regex -- deliberately matches the Latin-1 range to catch masked/corrupted credentials
  if (/[^\x00-\xFF]/.test(accessToken) || /[^\x00-\xFF]/.test(shop)) {
    return { ok: false, error: 'The saved Shopify credentials contain invalid characters — a masked or corrupted value was saved. Re-enter the store URL and access token, then click Save.' }
  }
  try {
    const start = Date.now()
    const url = `https://${shop}.myshopify.com/admin/api/${config.apiVersion}/shop.json`
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json', Accept: 'application/json' },
    })
    if (res.status === 401) {
      return { ok: false, error: 'Shopify rejected the access token. Double-check the token value.' }
    }
    if (res.status === 403) {
      return { ok: false, error: `Access token is missing the required Shopify scopes (read_products, read_orders, read_customers, read_inventory). ${SCOPE_FIX_HINT}` }
    }
    if (!res.ok) {
      return { ok: false, error: `Shopify API error ${res.status}: ${(await res.text()).slice(0, 200)}` }
    }
    const data = await res.json()
    // Best-effort scope check: custom-app Admin API tokens can answer
    // access_scopes.json. A token missing an outbound scope (e.g.
    // write_draft_orders) passes the shop.json probe above and only fails
    // mid-flow, so name the gaps here, at configuration time. Token types
    // that cannot answer simply skip this check.
    try {
      const scopesRes = await fetch(
        `https://${shop}.myshopify.com/admin/api/${config.apiVersion}/access_scopes.json`,
        { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json', Accept: 'application/json' } },
      )
      if (scopesRes.ok) {
        const scopesJson = (await scopesRes.json().catch(() => null)) as
          | { access_scopes?: Array<{ handle?: string }> }
          | null
        const granted = new Set(
          (scopesJson?.access_scopes ?? []).map((s) => String(s.handle ?? '').trim()).filter(Boolean),
        )
        if (granted.size > 0) {
          const missing = REQUIRED_SHOPIFY_SCOPES.filter((handle) => !granted.has(handle))
          if (missing.length > 0) {
            return {
              ok: false,
              error: `Access token is missing required Admin API scope${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ${SCOPE_FIX_HINT}`,
            }
          }
        }
      }
    } catch { /* scope probe is best-effort */ }
    logger.info({ ms: Date.now() - start }, 'Shopify connection verified')
    return { ok: true, shop: data.shop?.myshopify_domain ?? `${shop}.myshopify.com` }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Shopify error'
    return { ok: false, error: message }
  }
}

async function paginate<T>(resource: string, initialQuery = '', maxPages = CONSTANTS.SHOPIFY_MAX_PAGES): Promise<T[]> {
  const out: T[] = []
  let query = initialQuery
  for (let page = 0; page < maxPages; page++) {
    const res = await shopifyRequest<Record<string, T[]>>(resource, query)
    out.push(...(res.json[resource] ?? []))
    if (!res.nextPageToken) break
    query = `page_info=${encodeURIComponent(res.nextPageToken)}`
  }
  return out
}

export function normalizeProduct(raw: any): SyncProduct {
  const variant = raw.variants?.[0] ?? {}
  // Shopify-style options + every variant (not just the first): the pull
  // writes these into products.options / product_variants so a multi-variant
  // listing round-trips instead of collapsing onto its default variant.
  const options: Array<{ name: string; values: string[] }> = Array.isArray(raw.options)
    ? raw.options
        .map((o: any) => ({
          name: String(o?.name ?? '').trim(),
          values: Array.isArray(o?.values)
            ? o.values.map((v: any) => String(typeof v === 'object' ? (v?.value ?? '') : v).trim()).filter(Boolean)
            : [],
        }))
        .filter((o: { name: string; values: string[] }) => o.name !== '' && o.values.length > 0)
    : []
  const variants: NonNullable<SyncProduct['variants']> = Array.isArray(raw.variants)
    ? raw.variants.slice(0, 200).map((v: any) => ({
        id: Number(v?.id ?? 0),
        title: String(v?.title ?? ''),
        option1: v?.option1 ?? null,
        option2: v?.option2 ?? null,
        option3: v?.option3 ?? null,
        sku: String(v?.sku ?? ''),
        barcode: v?.barcode ?? null,
        price: String(v?.price ?? '0'),
        compareAtPrice: v?.compare_at_price ?? null,
        inventoryQuantity: Number(v?.inventory_quantity ?? 0),
        inventoryItemId: Number(v?.inventory_item_id ?? 0),
      }))
    : []
  const rawTags = typeof raw.tags === 'string' ? raw.tags : Array.isArray(raw.tags) ? raw.tags.join(',') : ''
  const tagList = rawTags.split(',').map((t: string) => t.trim()).filter(Boolean)
  const collectionTag = tagList.find((t: string) => t.startsWith('opal-collection:'))
  const collection = collectionTag
    ? collectionTag.replace('opal-collection:', '').trim()
    : (raw.product_type ?? '').trim()
  const chargeOnTaxTag = tagList.find((t: string) => t.startsWith('opal-chargeontax:'))
  const chargeOnTax = chargeOnTaxTag ? chargeOnTaxTag.replace('opal-chargeontax:', '').trim() !== 'false' : true
  return {
    id: raw.id,
    gid: raw.admin_graphql_api_id ?? '',
    title: raw.title ?? '',
    handle: raw.handle ?? '',
    vendor: raw.vendor ?? '',
    productType: raw.product_type ?? '',
    description: typeof raw.body_html === 'string' ? raw.body_html : '',
    collection,
    chargeOnTax,
    status: raw.status ?? '',
    sku: variant.sku ?? '',
    barcode: variant.barcode ?? null,
    price: variant.price ?? '0',
    compareAtPrice: variant.compare_at_price ?? null,
    image: raw.images?.[0]?.src ?? null,
    images: Array.isArray(raw.images)
      ? raw.images.map((img: { src?: string }) => String(img?.src ?? '')).filter(Boolean)
      : [],
    // The parent's stock is the ROLLUP of its variants (same model as the
    // local tables); a simple product keeps the single variant's count.
    inventoryQuantity: variants.length > 1 ? variants.reduce((a, v) => a + v.inventoryQuantity, 0) : (variant.inventory_quantity ?? 0),
    inventoryItemId: variant.inventory_item_id ?? 0,
    variantId: variant.id ?? 0,
    options,
    variants,
    createdAt: raw.created_at ?? '',
    updatedAt: raw.updated_at ?? '',
  }
}

export function normalizeOrder(raw: any): SyncOrder {
  return {
    id: raw.id,
    name: raw.name ?? '',
    orderNumber: raw.order_number ?? 0,
    createdAt: raw.created_at ?? '',
    financialStatus: raw.financial_status ?? 'pending',
    fulfillmentStatus: raw.fulfillment_status ?? null,
    customerName: raw.customer ? `${raw.customer.first_name ?? ''} ${raw.customer.last_name ?? ''}`.trim() : 'Guest',
    email: raw.customer?.email ?? null,
    totalPrice: raw.total_price ?? '0',
    currency: raw.currency ?? 'INR',
    lineItems: raw.line_items?.length ?? 0,
  }
}

export function normalizeCustomer(raw: any): SyncCustomer {
  return {
    id: raw.id,
    email: raw.email ?? null,
    firstName: raw.first_name ?? '',
    lastName: raw.last_name ?? '',
    phone: raw.phone ?? null,
    city: raw.default_address?.city ?? null,
    province: raw.default_address?.province ?? null,
    ordersCount: raw.orders_count ?? 0,
    totalSpent: raw.total_spent ?? '0',
    createdAt: raw.created_at ?? '',
  }
}

async function fetchLocations(): Promise<{ id: number; name: string }[]> {
  const res = await shopifyRequest<{ locations: any[] }>('locations')
  return res.json.locations.map((l) => ({ id: l.id, name: l.name }))
}

async function fetchInventoryLevels(): Promise<any[]> {
  const locations = await fetchLocations()
  if (locations.length === 0) return []
  return paginate<any>('inventory_levels', `location_ids=${locations.map((l) => l.id).join(',')}`)
}

async function attachInventoryToProducts() {
  if (store.products.length === 0) return
  const skuByItem = new Map<number, { sku: string; title: string }>()
  for (const p of store.products) {
    if (p.inventoryItemId) skuByItem.set(p.inventoryItemId, { sku: p.sku, title: p.title })
  }
  const availableByItem = new Map<number, number>()
  const levels = await fetchInventoryLevels()
  for (const raw of levels) {
    const id = raw.inventory_item_id
    availableByItem.set(id, (availableByItem.get(id) ?? 0) + (raw.available ?? 0))
  }
  store.products = store.products.map((p) => {
    // The parent quantity is the SUM of its variants' levels — the same
    // rollup normalizeProduct() builds from the REST payload and the same
    // model as the local products.stock column. p.inventoryItemId points at
    // the FIRST variant's item, so using it directly replaced the rollup with
    // just the first variant's count and every multi-variant product pulled
    // from Shopify landed with a wrong stock.
    const itemIds = (p.variants ?? [])
      .map((v) => v.inventoryItemId)
      .filter((id) => Number.isFinite(id) && id > 0)
    const quantity =
      itemIds.length > 1
        ? itemIds.reduce((sum, id) => sum + (availableByItem.get(id) ?? 0), 0)
        : availableByItem.get(p.inventoryItemId) ?? 0
    return { ...p, inventoryQuantity: quantity }
  })
  const nameById = new Map((await fetchLocations()).map((l) => [l.id, l.name]))
  store.inventory = levels.map((raw: any) => ({
    inventoryItemId: raw.inventory_item_id,
    locationId: raw.location_id,
    locationName: nameById.get(raw.location_id) ?? `Location #${raw.location_id}`,
    available: raw.available ?? 0,
    sku: skuByItem.get(raw.inventory_item_id)?.sku ?? '',
    title: skuByItem.get(raw.inventory_item_id)?.title ?? '',
  }))
}

async function syncProducts(): Promise<number> {
  const raw = await paginate<any>('products', 'status=active')
  store.products = raw.map(normalizeProduct).slice(0, MAX_STORE_ITEMS)
  try {
    await attachInventoryToProducts()
  } catch {
    // Inventory is an enhancement; product catalog must never fail because of it.
  }
  try {
    try {
      await attachCollectionsToProducts()
    } catch (err) {
      // Collections are an enhancement — never fail the catalog pull over
      // them, but record the failure so a broken collections sync shows up in
      // the sync log instead of silently doing nothing.
      const message = err instanceof Error ? err.message : 'Unknown error'
      logger.warn({ err }, 'Shopify collections could not be attached to products')
      await persistLog({ entity: 'Product', direction: 'in', action: 'Collection Sync', status: 'failed', error: message, retry: true })
    }
  } catch {
    // Collections are an enhancement too; never fail the catalog pull over them.
  }
  return store.products.length
}

/**
 * Resolve each product's real Shopify collections. The REST list endpoint
 * only exposes product_type/tags, so memberships come from the collects
 * endpoint (custom collections) plus the collection id in each collect row
 * (titles resolved from custom_collection + smart_collection listings).
 * Result: store.products[i].collection = "Collection A | Collection B".
 */
export async function attachCollectionsToProducts(): Promise<void> {
  if (store.products.length === 0) return
  const [custom, smart, collects] = await Promise.all([
    paginate<any>('custom_collections', 'limit=250'),
    paginate<any>('smart_collections', 'limit=250'),
    paginate<any>('collects', 'limit=250', CONSTANTS.SHOPIFY_COLLECTION_MAX_PAGES),
  ])
  const titleById = new Map<string, string>()
  for (const c of [...custom, ...smart]) {
    if (c?.id != null) titleById.set(String(c.id), String(c.title ?? '').trim())
  }
  if (titleById.size === 0) return
  const byProduct = new Map<string, string[]>()
  for (const col of collects) {
    const productId = String(col?.product_id ?? '')
    const title = titleById.get(String(col?.collection_id ?? ''))
    if (!productId || !title) continue
    const list = byProduct.get(productId) ?? []
    if (!list.includes(title)) list.push(title)
    byProduct.set(productId, list)
  }
  if (byProduct.size === 0) return
  store.products = store.products.map((p) => {
    const titles = byProduct.get(String(p.id))
    if (!titles || titles.length === 0) return p
    // Keep the tag-derived collection as a fallback member so it never regresses.
    const merged = [...titles]
    if (p.collection && !merged.includes(p.collection)) merged.unshift(p.collection)
    return { ...p, collection: merged.slice(0, 5).join(' | ') }
  })
}

// ---------------------------------------------------------------------------
// Collection membership — the missing half of the two-way collections sync.
//
// A push used to write only an `opal-collection:` tag and mirror the local
// collection into product_type; no collect was ever created, so the product
// never joined a Shopify collection and the storefront stayed out of sync with
// the billing catalogue. Every push now ensures membership of the matching
// custom collection, and a collection change removes the membership the app
// itself created earlier (tracked through the tag written by the previous
// push). Smart collections are rule-driven and reject collects with a 403, so
// they are reported as skipped instead of being duplicated.
// ---------------------------------------------------------------------------

export interface CollectionSyncOutcome {
  /** Memberships created by this push. */
  added: string[]
  /** Memberships that already existed. */
  existing: string[]
  /** Memberships removed because the local collection changed. */
  removed: string[]
  /** Titles needing no collect (smart collection, or empty value). */
  skipped: string[]
  /** Per-title failures; non-empty is surfaced in the sync log. */
  errors: string[]
}

type CollectionEntry = { id: number; kind: 'custom' | 'smart' }

// Titles resolved once per push batch (custom + smart collection listings).
// pushProductsToShopify() resets it at the start of every batch so a
// collection created in Shopify admin meanwhile is never duplicated.
let collectionDirectory: Map<string, CollectionEntry> | null = null

export function resetCollectionDirectory(): void {
  collectionDirectory = null
}

/** Split a collection field into titles: "Classic | Modern" → two entries. */
export function collectionSegments(value: unknown): string[] {
  if (typeof value !== 'string') return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of value.split('|')) {
    const title = part.trim()
    if (!title) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(title)
  }
  return out
}

/** The Opal collection encoded in a product's tags (`opal-collection:<title>`). */
export function collectionFromTags(tags: unknown): string | null {
  const raw = typeof tags === 'string' ? tags : Array.isArray(tags) ? tags.join(',') : ''
  const found = raw
    .split(',')
    .map((t) => t.trim())
    .find((t) => t.startsWith('opal-collection:'))
  const value = found ? found.slice('opal-collection:'.length).trim() : ''
  return value || null
}

async function loadCollectionDirectory(): Promise<Map<string, CollectionEntry>> {
  if (collectionDirectory) return collectionDirectory
  const [custom, smart] = await Promise.all([
    paginate<any>('custom_collections', 'limit=250'),
    paginate<any>('smart_collections', 'limit=250'),
  ])
  const dir = new Map<string, CollectionEntry>()
  // Custom first: only custom collections accept explicit membership, so a
  // custom collection must win a title clash with a smart one.
  for (const c of custom) {
    if (c?.id == null) continue
    dir.set(String(c.title ?? '').trim().toLowerCase(), { id: Number(c.id), kind: 'custom' })
  }
  for (const c of smart) {
    if (c?.id == null) continue
    const key = String(c.title ?? '').trim().toLowerCase()
    if (!dir.has(key)) dir.set(key, { id: Number(c.id), kind: 'smart' })
  }
  collectionDirectory = dir
  return dir
}

/** Find a collection by title, creating a custom collection when the store has none. */
async function resolveCollection(title: string): Promise<CollectionEntry> {
  const dir = await loadCollectionDirectory()
  const key = title.toLowerCase()
  const hit = dir.get(key)
  if (hit) return hit
  const res = await adminFetch(new URL(apiPath(config.apiVersion, 'custom_collections')), {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': config.accessToken, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ custom_collection: { title } }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ShopifyError(`Shopify API error ${res.status} while creating collection "${title}": ${text.slice(0, 200)}`, res.status)
  }
  const json = (await res.json().catch(() => ({}))) as { custom_collection?: { id?: number } }
  const id = Number(json.custom_collection?.id ?? 0)
  if (!id) throw new ShopifyError(`Shopify did not return an id for collection "${title}"`, 502)
  const entry: CollectionEntry = { id, kind: 'custom' }
  dir.set(key, entry)
  return entry
}

/**
 * The collect row linking this product to this collection, if any. The
 * product_id/collection_id filters are applied server-side when supported and
 * verified client-side here, so a response that ignored them can never be
 * mistaken for this membership — a wrong id would delete the wrong collect.
 */
async function fetchCollectId(productId: number, collectionId: number): Promise<number | null> {
  const url = new URL(apiPath(config.apiVersion, 'collects'))
  url.search = new URLSearchParams({
    product_id: String(productId),
    collection_id: String(collectionId),
    limit: String(CONSTANTS.SHOPIFY_API_LIMIT),
  }).toString()
  const res = await adminFetch(url, { headers: { 'X-Shopify-Access-Token': config.accessToken, Accept: 'application/json' } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ShopifyError(`Shopify API error ${res.status} while reading collection membership: ${text.slice(0, 200)}`, res.status)
  }
  const json = (await res.json().catch(() => ({}))) as {
    collects?: Array<{ id?: number; product_id?: number; collection_id?: number }>
  }
  const match = (json.collects ?? []).find(
    (c) => Number(c.product_id) === productId && Number(c.collection_id) === collectionId,
  )
  return match ? Number(match.id) || null : null
}

async function postCollect(productId: number, collectionId: number): Promise<'created' | 'exists'> {
  const res = await adminFetch(new URL(apiPath(config.apiVersion, 'collects')), {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': config.accessToken, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ collect: { product_id: productId, collection_id: collectionId } }),
  })
  if (res.ok) return 'created'
  // 422/409 = already a member (concurrent push) — the desired state holds.
  if (res.status === 422 || res.status === 409) return 'exists'
  const text = await res.text().catch(() => '')
  throw new ShopifyError(`Shopify API error ${res.status} while adding the product to a collection: ${text.slice(0, 200)}`, res.status)
}

/**
 * Make Shopify collection membership match the local collection for one
 * product: add a collect for every current title (creating the custom
 * collection when the store has none) and drop memberships for titles the app
 * itself pushed earlier but the user has since changed or cleared. Failures
 * are collected per title instead of thrown, so a membership problem can
 * never fail the product push that triggered it.
 */
export async function syncLocalCollectionMembership(
  productId: number,
  collectionValue: unknown,
  previousCollection?: unknown,
): Promise<CollectionSyncOutcome> {
  const outcome: CollectionSyncOutcome = { added: [], existing: [], removed: [], skipped: [], errors: [] }
  if (!isConfigured() || !Number.isFinite(productId) || productId <= 0) return outcome
  const current = collectionSegments(collectionValue)
  const previous = collectionSegments(previousCollection)
  const currentKeys = new Set(current.map((t) => t.toLowerCase()))

  for (const title of current) {
    try {
      const entry = await resolveCollection(title)
      // Smart collections are rule-driven; POSTing a collect for one 403s.
      if (entry.kind === 'smart') {
        outcome.skipped.push(title)
        continue
      }
      const already = await fetchCollectId(productId, entry.id)
      if (already) {
        outcome.existing.push(title)
        continue
      }
      const created = await postCollect(productId, entry.id)
      if (created === 'created') outcome.added.push(title)
      else outcome.existing.push(title)
    } catch (err) {
      outcome.errors.push(`${title}: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  for (const title of previous) {
    if (currentKeys.has(title.toLowerCase())) continue
    try {
      const dir = await loadCollectionDirectory()
      const entry = dir.get(title.toLowerCase())
      // Only custom collections ever received a collect from us — nothing to remove.
      if (!entry || entry.kind !== 'custom') continue
      const collectId = await fetchCollectId(productId, entry.id)
      if (!collectId) continue
      const res = await adminFetch(new URL(apiPath(config.apiVersion, `collects/${collectId}`)), {
        method: 'DELETE',
        headers: { 'X-Shopify-Access-Token': config.accessToken, Accept: 'application/json' },
      })
      if (res.ok || res.status === 404) outcome.removed.push(title)
      else {
        const text = await res.text().catch(() => '')
        outcome.errors.push(`${title}: Shopify API error ${res.status} while removing membership: ${text.slice(0, 200)}`)
      }
    } catch (err) {
      outcome.errors.push(`${title}: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }
  return outcome
}

/**
 * Run the membership sync for a push and record the result in the sync log.
 * Never throws: collection membership is deliberately kept separate from the
 * product push so a membership failure cannot fail (or duplicate) the listing.
 */
async function pushCollectionMembership(
  local: LocalProductForPush,
  productId: number,
  previousCollection: string | null,
): Promise<void> {
  try {
    const outcome = await syncLocalCollectionMembership(productId, local.collection, previousCollection)
    if (outcome.errors.length > 0) {
      const message = outcome.errors.join('; ')
      addLog('products', 'failed', 1, `Collection sync failed for ${local.sku}: ${message}`)
      await persistLog({ entity: 'Product', shopifyId: local.sku, direction: 'out', action: 'Collection Sync', status: 'failed', error: message, retry: true })
      return
    }
    const changed = outcome.added.length > 0 || outcome.removed.length > 0
    if (changed) {
      const detail = [...outcome.added, ...outcome.removed.map((t) => `-${t}`)].join(', ')
      addLog('products', 'success', 1, `Collections updated for ${local.sku}: ${detail}`)
      await persistLog({ entity: 'Product', shopifyId: local.sku, direction: 'out', action: 'Collection Sync', status: 'success' })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    addLog('products', 'failed', 1, `Collection sync failed for ${local.sku}: ${message}`)
    await persistLog({ entity: 'Product', shopifyId: local.sku, direction: 'out', action: 'Collection Sync', status: 'failed', error: message, retry: true })
  }
}

async function syncOrders(): Promise<number> {
  const raw = await paginate<any>('orders', 'status=any&fulfillment_status=any')
  store.orders = raw.map(normalizeOrder).slice(0, MAX_STORE_ITEMS)
  return store.orders.length
}

async function syncCustomers(): Promise<number> {
  const raw = await paginate<any>('customers', '')
  store.customers = raw.map(normalizeCustomer).slice(0, MAX_STORE_ITEMS)
  return store.customers.length
}

async function syncInventory(): Promise<number> {
  if (store.products.length === 0) {
    await syncProducts()
  } else {
    await attachInventoryToProducts()
  }
  return store.inventory.length
}

export interface ProductsDbSyncResult {
  ok: boolean
  synced: number
  created: number
  updated: number
  removed: number
  errors: string[]
  message?: string
}

/**
 * Canonical selling price for a silver product: (rate + making charge) x net
 * weight plus GST. Exported so the silver-rate reprice loop and tests share a
 * single definition with backComputePricing, its inverse.
 */
export function computeSellingPrice(rate: number, netWeight: number, makingCharge: number): number {
  return round2((rate + makingCharge) * netWeight * 1.03)
}

export function backComputePricing(price: number, rate: number): { netWeight: number; makingCharge: number } | null {
  if (!price || price <= 0 || !rate || rate <= 0) return null
  const netWeight = price / ((rate + CONSTANTS.DEFAULT_MAKING_CHARGE) * 1.03)
  if (!Number.isFinite(netWeight) || netWeight <= 0) return null
  return { netWeight, makingCharge: CONSTANTS.DEFAULT_MAKING_CHARGE }
}

// Pull the live Shopify catalog (status=active) into the local billing database,
// keyed by SKU. Existing SKU matches are updated (keeping their pricing data),
// and local products that no longer exist on Shopify are removed so the billing
// catalog only ever mirrors live products. Products that were never pushed to
// Shopify (no live id / pending / not-listed) are preserved locally.
/**
 * Combine local image list with Shopify's gallery for the same product.
 * Local uploads ("/uploads/...") that were pushed to Shopify appear in the
 * Shopify list too — de-duplicate by filename suffix. Local-only entries are
 * preserved so nothing is lost on sync.
 */
export function mergeImages(local: string[] | null, shopify: string[]): string[] | null {
  const localList = (local ?? []).filter(Boolean)
  const remoteList = (shopify ?? []).filter(Boolean)
  if (remoteList.length === 0) return localList.length > 0 ? localList : null
  if (localList.length === 0) return remoteList
  const out = [...remoteList]
  for (const l of localList) {
    // A Shopify CDN URL that is no longer on the listing is definitively
    // stale (Shopify owns that file) — drop it, never re-introduce it.
    if (/^https?:\/\/cdn\.shopify\.com\//i.test(l)) continue
    const fileName = l.split('/').pop()?.split('-').slice(-1)[0] ?? l
    // Keep local entries that are clearly not among the Shopify sources
    if (!remoteList.some((r) => r.includes(fileName) || fileName.length > 8 && r.endsWith(fileName))) {
      out.push(l)
    }
  }
  return out
}

/**
 * Local catalog row as the pull sees it — the subset of products columns the
 * sync loop reads. Kept structural so tests can supply in-memory rows while
 * drizzle's `$inferSelect` rows satisfy it structurally.
 */
export interface CatalogRow {
  id: string
  sku: string
  name: string
  barcode: string | null
  category: string
  collection: string | null
  netWeight: number | null
  makingCharge: number | null
  silverRate: number | null
  stock: number | null
  vendor: string | null
  productType: string | null
  description: string | null
  compareAtPrice: number | null
  image: string | null
  images: unknown
  chargeOnTax: boolean
  shopifyId: string | null
  shopifyStatus: string | null
  status: string | null
  /**
   * Stable pricing-collection / category links (products.collection_id /
   * category_id). When a row carries either, its grouping text is owned
   * locally: the pull must not rewrite it with a Shopify product type or
   * collection label, or the ids and the text would disagree.
   */
  collectionId?: string | null
  categoryId?: string | null
}

/** Insert payload built by the pull — exactly what `insert(schema.products).values()` takes. */
export type CatalogInsertValues = typeof schema.products.$inferInsert

/** Update payload the pull writes through the update path. */
export interface CatalogPatch {
  name: string
  barcode: string | null
  category: string
  collection: string | null
  stock: number | null
  shopifyId: string
  shopifyStatus: string
  status: string
  vendor: string | null
  productType: string | null
  description: string | null
  compareAtPrice: number | null
  image: string | null
  images: string[] | null
  netWeight: number | null
  makingCharge: number | null
  silverRate: number | null
  chargeOnTax: boolean
}

/** Data access the pull needs; injected so the loop is unit-testable. */
export interface CatalogApplyIo {
  insert(values: CatalogInsertValues): Promise<CatalogRow | undefined>
  update(existing: CatalogRow, patch: CatalogPatch): Promise<void>
  /**
   * Replace the product's option definitions + variant rows from the live
   * listing (Shopify-style sync). Omitted by fakes that don't care.
   */
  saveVariants?(
    productId: string,
    options: SyncProduct['options'],
    variants: SyncProduct['variants'],
  ): Promise<void>
}

/**
 * Reconcile the live Shopify catalog into the local rows: existing SKUs are
 * updated (keeping pricing data), unknown SKUs are inserted.
 *
 * A fresh row is registered in the SKU map immediately, so a SECOND live
 * product carrying the same SKU takes the update path instead of colliding
 * with the insert: the store can contain duplicate SKUs, and on a brand-new
 * database that collision used to abort the entire first import on
 * products_sku_idx (warm databases never hit it — both products map onto the
 * existing row through the update path).
 */
export async function applyLiveCatalog(
  live: SyncProduct[],
  rows: CatalogRow[],
  pricingRate: number,
  io: CatalogApplyIo,
): Promise<{ created: number; updated: number }> {
  const bySku = new Map<string, CatalogRow>()
  for (const r of rows) {
    const key = String(r.sku ?? '').trim().toLowerCase()
    if (key) bySku.set(key, r)
  }
  // A pushed multi-variant product carries a VARIANT's SKU on Shopify, not
  // the local parent's — match on shopifyId first so a re-pull updates the
  // same row instead of inserting a duplicate under the variant SKU.
  const byShopifyId = new Map<string, CatalogRow>()
  for (const r of rows) {
    const key = String(r.shopifyId ?? '').trim()
    if (key && !key.startsWith('#')) byShopifyId.set(key, r)
  }

  let created = 0
  let updated = 0
  for (const p of live) {
    const sku = String(p.sku ?? '').trim() || `SHOP-${p.id}`
    const skuKey = sku.toLowerCase()
    if (!skuKey) continue
    const price = Number(p.price ?? 0) || 0
    const compareAt = p.compareAtPrice != null ? Number(p.compareAtPrice) : null
    const effectiveCompareAt = compareAt != null && compareAt > 0 ? compareAt : null
    const existing = byShopifyId.get(String(p.id)) ?? bySku.get(skuKey)
    // Options + variants only land when the listing actually has them — a
    // simple single-variant product never wipes local variants that simply
    // haven't been pushed yet.
    const hasLiveVariants = (p.options?.length ?? 0) > 0 && (p.variants?.length ?? 0) > 0
    const saveVariants = async (productId: string) => {
      if (hasLiveVariants && io.saveVariants) await io.saveVariants(productId, p.options, p.variants)
    }
    if (existing) {
      const hasWeight = existing.netWeight != null && Number(existing.netWeight) > 0
      const pricing = hasWeight ? null : backComputePricing(price, pricingRate)
      // Products created through the product dialog are linked to a pricing
      // collection and category; that grouping is local and stable, so the pull
      // leaves the text alone (the ids would otherwise point at names Shopify
      // overwrote). Rows without a link keep the original behaviour.
      const linked =
        String(existing.collectionId ?? '').trim() !== '' || String(existing.categoryId ?? '').trim() !== ''
      const patch: CatalogPatch = {
        name: p.title || existing.name,
        barcode: p.barcode ?? existing.barcode,
        category: linked ? existing.category : p.productType || existing.category,
        collection: linked ? existing.collection : p.collection || p.productType || existing.collection,
        stock: Number.isFinite(p.inventoryQuantity) ? p.inventoryQuantity : existing.stock,
        shopifyId: String(p.id),
        shopifyStatus: 'synced',
        status: 'active',
        vendor: p.vendor || existing.vendor,
        productType: p.productType || existing.productType,
        // Shopify body_html is authoritative for descriptions coming from
        // the storefront; keep local text when Shopify has none.
        description: p.description ? p.description : existing.description,
        compareAtPrice: effectiveCompareAt ?? existing.compareAtPrice,
        image: p.image ?? existing.image,
        // Mirror Shopify's gallery; keep any local-only uploads that aren't
        // yet on Shopify (they'll be pushed on the next product push).
        images: mergeImages(existing.images as string[] | null, p.images),
        netWeight: pricing ? pricing.netWeight : existing.netWeight,
        makingCharge: pricing ? pricing.makingCharge : existing.makingCharge,
        silverRate: pricing ? pricingRate : existing.silverRate,
        // Preserve existing chargeOnTax value; do not overwrite from Shopify list endpoint
        chargeOnTax: existing.chargeOnTax,
      }
      await io.update(existing, patch)
      await saveVariants(existing.id)
      updated++
    } else {
      const pricing = backComputePricing(price, pricingRate)
      // A product that only exists on Shopify has no local collection or
      // category link: it is created unlinked (silver-rate pricing applies
      // until someone assigns it a collection), never by guessing from a
      // Shopify collection/product-type label.
      const values: CatalogInsertValues = {
        id: randomUUID(),
        name: p.title || sku,
        sku,
        barcode: p.barcode ?? null,
        category: p.productType || 'Uncategorized',
        collection: p.collection || p.productType || null,
        purity: 92.5,
        grossWeight: null,
        stoneWeight: null,
        netWeight: pricing ? pricing.netWeight : null,
        makingCharge: pricing ? pricing.makingCharge : null,
        gst: 3,
        hsn: null,
        supplier: null,
        silverRate: pricing ? pricingRate : null,
        sellingPrice: price,
        compareAtPrice: effectiveCompareAt,
        stock: Number.isFinite(p.inventoryQuantity) ? p.inventoryQuantity : 0,
        reorderLevel: null,
        shopifyStatus: 'synced',
        shopifyId: String(p.id),
        status: 'active',
        image: p.image ?? null,
        images: p.images.length > 0 ? p.images : null,
        vendor: p.vendor || null,
        productType: p.productType || null,
        description: p.description || null,
        tags: null,
        trackInventory: true,
        // Set chargeOnTax from the product data (first sync) or preserve existing
        chargeOnTax: p.chargeOnTax ?? true,
        // Full timestamp: pulled products sort newest-first down to the second.
        createdAt: new Date().toISOString(),
      }
      const inserted = await io.insert(values)
      created++
      if (inserted) {
        bySku.set(skuKey, inserted)
        await saveVariants(inserted.id)
      }
    }
  }
  return { created, updated }
}

/**
 * Pick a variant SKU that is not already in `taken` (compared case-insensitively).
 * Shopify stores often reuse a SKU across listings; `product_variants.sku` is
 * unique, so a second copy gets a numeric tail (`007`, `007-2`, `007-3`, …)
 * instead of aborting the catalog pull. The chosen key is reserved in `taken`.
 */
export function claimUniqueVariantSku(preferred: string, taken: Set<string>): string {
  const base = preferred.trim() || 'VARIANT'
  let sku = base
  let n = 2
  while (taken.has(sku.toLowerCase())) {
    sku = `${base}-${n}`
    n += 1
    if (n > 10000) {
      sku = `${base}-${randomUUID().slice(0, 8)}`
      break
    }
  }
  taken.add(sku.toLowerCase())
  return sku
}

/**
 * Keep the first non-empty barcode. A later listing that repeats it is stored
 * with no barcode: `product_variants.barcode` is unique on this database, and
 * a second copy must not abort the catalog pull. Empty values stay empty.
 * A kept barcode is reserved in `taken`.
 */
export function claimUniqueBarcode(preferred: string | null | undefined, taken: Set<string>): string | null {
  const base = String(preferred ?? '').trim()
  if (!base) return null
  const key = base.toLowerCase()
  if (taken.has(key)) return null
  taken.add(key)
  return base
}

export async function syncProductsToDb(): Promise<ProductsDbSyncResult> {
  if (!isConfigured()) {
    return { ok: false, synced: 0, created: 0, updated: 0, removed: 0, errors: ['Shopify is not configured. See server/.env'], message: 'Shopify is not configured' }
  }
  if (!db) {
    return { ok: false, synced: 0, created: 0, updated: 0, removed: 0, errors: ['Database is not configured'], message: 'Database is not configured' }
  }
  const database = db
  if (!(await acquireSyncLock('products'))) {
    return { ok: false, synced: 0, created: 0, updated: 0, removed: 0, errors: [], message: 'A sync is already in progress' }
  }

  // Hoisted out of the try block so a failure still reports how far the pull
  // got instead of pretending nothing was written.
  let created = 0
  let updated = 0
  let removed = 0
  try {
    await syncProducts()

    const live = store.products
    const liveSkus = new Set(live.map((p) => (String(p.sku ?? '').trim() || `SHOP-${p.id}`).toLowerCase()).filter(Boolean))
    // Variant products carry a variant's SKU on Shopify, so a local parent's
    // SKU is no longer in liveSkus — also index by Shopify id or the
    // reconciliation below would delete every multi-variant product.
    const liveShopifyIds = new Set(live.map((p) => String(p.id)).filter(Boolean))

    const rows = await db.select().from(schema.products)

    const pricingRate = (await getLatestSilverRate())?.rate ?? 92.8
    // Variant SKUs are unique across the whole table, not per product. Track
    // every SKU already stored so a second listing that reuses "007" is saved
    // with a suffix instead of failing product_variants_sku_idx and aborting
    // the pull (which also blocks a silver-rate update that syncs first).
    const takenVariantSkus = new Set<string>()
    const variantSkusByProduct = new Map<string, string[]>()
    const takenVariantBarcodes = new Set<string>()
    const variantBarcodesByProduct = new Map<string, string[]>()
    const existingVariantSkus = await database
      .select({
        sku: schema.productVariants.sku,
        barcode: schema.productVariants.barcode,
        productId: schema.productVariants.productId,
      })
      .from(schema.productVariants)
    for (const row of existingVariantSkus) {
      const key = String(row.sku ?? '').trim().toLowerCase()
      if (key) {
        takenVariantSkus.add(key)
        const owned = variantSkusByProduct.get(row.productId) ?? []
        owned.push(key)
        variantSkusByProduct.set(row.productId, owned)
      }
      const barcode = String(row.barcode ?? '').trim().toLowerCase()
      if (barcode) {
        takenVariantBarcodes.add(barcode)
        const ownedBarcodes = variantBarcodesByProduct.get(row.productId) ?? []
        ownedBarcodes.push(barcode)
        variantBarcodesByProduct.set(row.productId, ownedBarcodes)
      }
    }
    const applied = await applyLiveCatalog(live, rows, pricingRate, {
      insert: async (values) => (await database.insert(schema.products).values(values).returning())[0],
      update: async (existing, patch) => {
        const sku = String(existing.sku ?? '').trim()
        const delta = Number(patch.stock) - Number(existing.stock ?? 0)
        if (sku && patch.stock != null && Number.isFinite(delta) && delta !== 0) {
          // Stock never lands as a raw column write on a pull: record the
          // change as a `shopify_sync` ledger movement so stock_levels
          // (availability), stock_movements (audit) and the products.stock
          // rollup stay in agreement. The semantics are unchanged — it is
          // still a SET: the movement delta is Shopify's count minus the
          // current local value.
          const { stock: _pulled, ...rest } = patch
          await applyStockMovement({
            sku,
            qty: delta,
            type: 'shopify_sync',
            refType: 'shopify_pull',
            note: `Inventory pull → ${Number(patch.stock)} on Shopify`,
            createdBy: 'system',
          })
          await database.update(schema.products).set(rest).where(eq(schema.products.id, existing.id))
        } else {
          // No stock change (or unknown SKU / non-finite count): plain write.
          await database.update(schema.products).set(patch).where(eq(schema.products.id, existing.id))
        }
      },
      // Replace-all: the listing owns the option/variant set, exactly like
      // the push. Parent stock above already carries the summed count.
      saveVariants: async (productId, options, variants) => {
        const liveVariants = variants ?? []
        // This product's current rows are about to be replaced, so their SKUs
        // are free again. Other products' SKUs stay reserved.
        const released = variantSkusByProduct.get(productId) ?? []
        for (const key of released) takenVariantSkus.delete(key)
        const releasedBarcodes = variantBarcodesByProduct.get(productId) ?? []
        for (const key of releasedBarcodes) takenVariantBarcodes.delete(key)
        const claimed: string[] = []
        const claimedBarcodes: string[] = []
        try {
          await database.transaction(async (tx) => {
            await tx.delete(schema.productVariants).where(eq(schema.productVariants.productId, productId))
            if (liveVariants.length === 0) {
              await tx.update(schema.products).set({ options: null }).where(eq(schema.products.id, productId))
              variantSkusByProduct.set(productId, [])
              variantBarcodesByProduct.set(productId, [])
              return
            }
            await tx.insert(schema.productVariants).values(
              liveVariants.map((v) => {
                const title = String(v.title ?? '').trim() || [v.option1, v.option2, v.option3].filter(Boolean).join(' / ')
                const preferred = String(v.sku ?? '').trim() || `SHOP-V${v.id}`
                const sku = claimUniqueVariantSku(preferred, takenVariantSkus)
                claimed.push(sku.toLowerCase())
                if (sku !== preferred) {
                  logger.warn(
                    { productId, from: preferred, to: sku },
                    'Variant SKU already used by another product — stored with a numeric suffix',
                  )
                }
                const barcode = claimUniqueBarcode(v.barcode, takenVariantBarcodes)
                if (barcode) claimedBarcodes.push(barcode.toLowerCase())
                else if (String(v.barcode ?? '').trim()) {
                  logger.warn(
                    { productId, barcode: String(v.barcode).trim(), sku },
                    'Variant barcode already used by another product — stored without a barcode',
                  )
                }
                return {
                  id: randomUUID(),
                  productId,
                  title,
                  optionValues: [v.option1, v.option2, v.option3]
                    .filter((x): x is string => Boolean(x) && String(x).trim() !== ''),
                  sku,
                  barcode,
                  sellingPrice: Number(v.price) || null,
                  compareAtPrice: v.compareAtPrice != null && Number(v.compareAtPrice) > 0 ? Number(v.compareAtPrice) : null,
                  costPrice: null,
                  grossWeight: null,
                  stock: Math.max(0, Math.floor(Number(v.inventoryQuantity) || 0)),
                  reorderLevel: null,
                  status: 'active',
                  createdAt: new Date().toISOString(),
                }
              }),
            )
            await tx.update(schema.products).set({ options: options ?? null }).where(eq(schema.products.id, productId))
            variantSkusByProduct.set(productId, claimed)
            variantBarcodesByProduct.set(productId, claimedBarcodes)
          })
        } catch (err) {
          for (const key of claimed) takenVariantSkus.delete(key)
          for (const key of released) takenVariantSkus.add(key)
          for (const key of claimedBarcodes) takenVariantBarcodes.delete(key)
          for (const key of releasedBarcodes) takenVariantBarcodes.add(key)
          throw err
        }
      },
    })
    created = applied.created
    updated = applied.updated

    for (const r of rows) {
      const key = String(r.sku ?? '').trim().toLowerCase()
      if (liveSkus.has(key)) continue
      if (liveShopifyIds.has(String(r.shopifyId ?? '').trim())) continue
      const shopifyId = String(r.shopifyId ?? '').trim()
      const shopifyStatus = String(r.shopifyStatus ?? '').trim().toLowerCase()
      const genuinelyLinked = shopifyId !== '' && !shopifyId.startsWith('#')
      const liveLinked = shopifyStatus === 'synced'
      if (!genuinelyLinked || !liveLinked) continue
      await db.delete(schema.stockTransfers).where(sql`${schema.stockTransfers.sku} = ${r.sku}`)
      await db.delete(schema.productVariants).where(eq(schema.productVariants.productId, r.id))
      await db.delete(schema.products).where(eq(schema.products.id, r.id))
      removed++
    }

    store.lastSync.products = new Date().toISOString()
    store.lastError = undefined
    addLog('products', 'success', live.length, `Synced ${live.length} live products into the local catalog`)
    await persistLog({ entity: 'Product', direction: 'in', action: 'Import', status: 'success' })
    return { ok: true, synced: live.length, created, updated, removed, errors: [] }
  } catch (err) {
    let message = err instanceof Error ? err.message : 'Unknown error'
    // Drizzle wraps the postgres error as `cause`; surface it so the sync log
    // and callers see the real constraint (e.g. duplicate SKU) instead of only
    // the generated SQL.
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : null
    if (cause && !message.includes(cause)) message = `${message} — ${cause}`
    store.lastError = message
    await persistLog({ entity: 'Product', direction: 'in', action: 'Import', status: 'failed', error: message, retry: true })
    return { ok: false, synced: 0, created, updated, removed, errors: [message], message }
  } finally {
    releaseSyncLock()
  }
}

interface LocalCatalogEntry {
  sku: string
  barcode: string
  title: string
  sellingPrice: number
}

async function getLocalCatalog(): Promise<LocalCatalogEntry[]> {
  if (!db) return []
  try {
    const rows = await db
      .select({
        sku: schema.products.sku,
        barcode: schema.products.barcode,
        title: schema.products.name,
        sellingPrice: schema.products.sellingPrice,
      })
      .from(schema.products)
    return rows.map((r) => ({
      sku: String(r.sku ?? '').trim(),
      barcode: String(r.barcode ?? '').trim().toLowerCase(),
      title: String(r.title ?? '').trim(),
      sellingPrice: Number(r.sellingPrice ?? 0),
    }))
  } catch {
    return []
  }
}

const STOP_WORDS = CONSTANTS.STOP_WORDS
const CATEGORY_WORDS = CONSTANTS.CATEGORY_WORDS

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

// Collapse case/punctuation/spacing so "SLV-RNG-00021" == "slv rng 00021" == "slvrng00021"
function normalizeKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

// Token-overlap score between two product titles. Rewarded for sharing
// meaningful (non-stop-word) tokens, with a small boost for category words.
function titleScore(a: string, b: string): number {
  const ta = tokenize(a)
  const tb = tokenize(b)
  const sigA = ta.filter((w) => !STOP_WORDS.has(w))
  const sigB = tb.filter((w) => !STOP_WORDS.has(w))
  const sigBSet = new Set(sigB)
  const sharedSig = [...new Set(sigA)].filter((w) => sigBSet.has(w))
  if (sharedSig.length === 0) return 0
  const overlap = sharedSig.length / Math.max(sigA.length, sigB.length)
  const combined = new Set([...ta, ...tb])
  const coverage = combined.size > 0 ? sharedSig.length / combined.size : 0
  const categoryHits = sharedSig.filter((w) => CATEGORY_WORDS.has(w)).length
  return overlap * 0.7 + coverage * 0.2 + Math.min(categoryHits, 2) * 0.05
}

const TITLE_MATCH_THRESHOLD = CONSTANTS.TITLE_MATCH_THRESHOLD

function buildMatcher(catalog: LocalCatalogEntry[]) {
  const bySku = new Map<string, LocalCatalogEntry>()
  const bySkuCompact = new Map<string, LocalCatalogEntry>()
  const byBarcode = new Map<string, LocalCatalogEntry>()
  const byTitle = new Map<string, LocalCatalogEntry>()
  const fuzzyClaimed = new Set<string>()
  for (const entry of catalog) {
    if (entry.sku) {
      bySku.set(entry.sku.toLowerCase(), entry)
      bySkuCompact.set(normalizeKey(entry.sku), entry)
    }
    if (entry.barcode) byBarcode.set(entry.barcode, entry)
    byTitle.set(tokenize(entry.title).join(' '), entry)
  }
  return {
    find(sku: string, barcode: string | null, title: string): LocalCatalogEntry | null {
      const skuKey = sku.trim().toLowerCase()
      const compactKey = normalizeKey(sku)
      const match = bySku.get(skuKey) ?? bySkuCompact.get(compactKey) ?? (barcode ? byBarcode.get(barcode.trim().toLowerCase()) : null)
      if (match) return match
      const tokens = tokenize(title)
      if (tokens.length === 0) return null
      const exact = byTitle.get(tokens.join(' '))
      if (exact) return exact
      let best: LocalCatalogEntry | null = null
      let bestScore = 0
      for (const entry of catalog) {
        if (fuzzyClaimed.has(entry.sku)) continue
        const score = titleScore(entry.title, title)
        if (score > bestScore) {
          bestScore = score
          best = entry
        }
      }
      if (best && bestScore >= TITLE_MATCH_THRESHOLD) {
        fuzzyClaimed.add(best.sku)
        return best
      }
      return null
    },
  }
}

async function syncPrices(): Promise<number> {
  try {
    const fresh = await paginate<any>('products', 'status=active')
    const priceById = new Map<string, string>()
    for (const raw of fresh) {
      priceById.set(String(raw.id), String(raw.variants?.[0]?.price ?? 0))
    }
    if (store.products.length === 0) {
      store.products = fresh.map(normalizeProduct)
    } else {
      store.products = store.products.map((p) => {
        const price = priceById.get(String(p.id))
        return price !== undefined ? { ...p, price } : p
      })
    }
  } catch (err) {
    if (store.products.length === 0) throw err
  }
  const catalog = await getLocalCatalog()
  const matcher = buildMatcher(catalog)
  const list: SyncPrice[] = []

  for (const p of store.products) {
    const sku = String(p.sku).trim().toLowerCase()
    const currentPrice = Number(p.price) || 0
    const local = matcher.find(sku, p.barcode, p.title)
    if (!local) {
      list.push({ productId: p.id, variantId: p.variantId, title: p.title, sku: p.sku, handle: p.handle, currentPrice, targetPrice: 0, status: 'no-match' })
      continue
    }
    const targetPrice = local.sellingPrice || 0
    const status: SyncPrice['status'] = Math.abs(currentPrice - targetPrice) > 0.005 ? 'update' : 'up-to-date'
    list.push({ productId: p.id, variantId: p.variantId, title: p.title, sku: p.sku, handle: p.handle, currentPrice, targetPrice, status })
  }

  store.price = list
  return list.filter((x) => x.status === 'update').length
}

async function setVariantPrice(variantId: number, price: number) {
  const url = new URL(apiPath(config.apiVersion, `variants/${variantId}`))
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'X-Shopify-Access-Token': config.accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ variant: { id: variantId, price: price.toFixed(2) } }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ShopifyError(`Shopify API error ${res.status}: ${text.slice(0, 200)}`, res.status)
  }
}

/**
 * Shopify caps the price a single variant may carry at $10,000.00 USD on
 * development (trial) stores — a price above that is rejected with
 * 422 `{"price":["can't exceed $10,000.00 USD"]}`. The install computes selling
 * prices in its own currency (INR), so heavy-weight silver items legitimately
 * carry price values above 10,000; those are a valid LOCAL price but can never
 * be accepted by this Shopify store. Exported so tests can share the boundary
 * with the pre-push guards in applyPriceSync / pushProductPriceToShopify.
 */
export const SHOPIFY_MAX_VARIANT_PRICE = 10000

/** True when a variant price would be rejected by Shopify's $10,000 USD cap. */
export function exceedsShopifyPriceCap(value: unknown): boolean {
  const n = Number(value)
  return Number.isFinite(n) && n > SHOPIFY_MAX_VARIANT_PRICE
}

export async function applyPriceSync(onProgress?: (done: number, total: number) => void) {
  const pending = store.price.filter((p) => p.status === 'update')
  if (!(await acquireSyncLock('price'))) return { ok: false, message: 'A sync is already in progress' }
  if (pending.length === 0) { releaseSyncLock(); return { ok: true, updated: 0, skipped: 0, errors: [] as string[] } }

  let updated = 0
  let skipped = 0
  const errors: string[] = []

  try {
    for (const [index, p] of pending.entries()) {
      if (!p.variantId) {
        p.status = 'no-match'
        skipped++
        continue
      }
      // A local price above Shopify's variant cap can never be accepted — push
      // failures would only burn API calls and mark every silver-rate run
      // "failed". Skip this row safely, keep it out of the retry queue and let
      // the other (valid) products continue syncing.
      if (exceedsShopifyPriceCap(p.targetPrice)) {
        p.status = 'skipped'
        skipped++
        const label = p.sku || p.title || `variant ${p.variantId}`
        const message = `Skipped ${label}: price ${p.targetPrice.toFixed(2)} exceeds Shopify's $10,000 USD variant cap`
        addLog('price', 'skipped', 1, message)
        await persistLog({ entity: 'Price', shopifyId: p.sku, direction: 'out', action: 'Price Update (skipped: over Shopify price cap)', status: 'skipped', error: message })
        continue
      }
      try {
        await setVariantPrice(p.variantId, p.targetPrice)
        p.status = 'updated'
        updated++
        onProgress?.(index + 1, pending.length)
        addLog('price', 'success', 1, `Price updated: ${p.sku}`)
        await persistLog({ entity: 'Price', shopifyId: p.sku, direction: 'out', action: 'Price Update', status: 'success' })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        p.status = 'update'
        errors.push(`${p.sku}: ${message}`)
        addLog('price', 'failed', 1, message)
        store.lastError = message
        await persistLog({ entity: 'Price', shopifyId: p.sku, direction: 'out', action: 'Price Update', status: 'failed', error: message, retry: true })
      }
    }
    onProgress?.(pending.length, pending.length)
    if (updated > 0) store.lastSync.price = new Date().toISOString()
    return { ok: errors.length === 0, updated, skipped, errors }
  } finally {
    releaseSyncLock()
  }
}

export interface ShopifyPricePushResult {
  ok: boolean
  updated: number
  skipped: number
  errors: string[]
  message?: string
}

export async function pushProductPriceToShopify(localProductId: string): Promise<ShopifyPricePushResult> {
  if (!isConfigured()) {
    return { ok: false, updated: 0, skipped: 0, errors: [], message: 'Shopify is not configured. See server/.env' }
  }
  if (!db) {
    return { ok: false, updated: 0, skipped: 0, errors: [], message: 'Database is not configured' }
  }
  if (!(await acquireSyncLock('price'))) {
    return { ok: false, updated: 0, skipped: 0, errors: [], message: 'A sync is already in progress' }
  }

  try {
  const [row] = await db.select().from(schema.products).where(eq(schema.products.id, localProductId)).limit(1)
  if (!row) { releaseSyncLock(); return { ok: false, updated: 0, skipped: 0, errors: ['Product not found'] } }

  const shopifyProductId = Number(row.shopifyId)
  if (!row.shopifyId || !shopifyProductId) {
    releaseSyncLock()
    return { ok: false, updated: 0, skipped: 0, errors: [`${row.sku} is not listed on Shopify yet`] }
  }

  const price = Number(row.sellingPrice)
  if (!Number.isFinite(price) || price <= 0) {
    releaseSyncLock()
    return { ok: false, updated: 0, skipped: 0, errors: [`${row.sku} has no valid selling price`] }
  }
  // Same cap guard as the batch push: an over-cap local price is valid here
  // (price computed in the install's currency) but Shopify would answer 422.
  // Report a deliberate skip — never a failed push — and leave the local
  // pricing untouched.
  if (exceedsShopifyPriceCap(price)) {
    const message = `Skipped ${row.sku}: price ${price.toFixed(2)} exceeds Shopify's $10,000 USD variant cap`
    addLog('price', 'skipped', 1, message)
    await persistLog({ entity: 'Price', shopifyId: row.sku, direction: 'out', action: 'Price Update (skipped: over Shopify price cap)', status: 'skipped', error: message })
    return { ok: true, updated: 0, skipped: 1, errors: [], message }
  }
  const compareAt = Number(row.compareAtPrice)

  let listingVariants: Array<{ id?: number; sku?: string | null }>
  try {
    const res = await shopifyRequest<any>(`products/${shopifyProductId}`)
    listingVariants = res.json?.product?.variants ?? []
    if (listingVariants.length === 0) {
      return { ok: false, updated: 0, skipped: 0, errors: [`No Shopify variant found for ${row.sku}`] }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    store.lastError = message
    return { ok: false, updated: 0, skipped: 0, errors: [message] }
  }

  const putVariantPrice = async (variantId: number, amount: number, cmp: number): Promise<string | null> => {
    const body: Record<string, unknown> = { id: variantId, price: amount.toFixed(2) }
    if (Number.isFinite(cmp) && cmp > 0) body.compare_at_price = cmp.toFixed(2)
    const url = new URL(apiPath(config.apiVersion, `variants/${variantId}`))
    const put = await fetch(url, {
      method: 'PUT',
      headers: {
        'X-Shopify-Access-Token': config.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ variant: body }),
    })
    if (!put.ok) {
      const text = await put.text().catch(() => '')
      return `Shopify API error ${put.status}: ${text.slice(0, 200)}`
    }
    return null
  }

  // Shopify-style product: push every local variant's price to its listing
  // variant (matched back by SKU). Simple products keep the single-variant
  // path below.
  const localVariants = await db.select().from(schema.productVariants).where(eq(schema.productVariants.productId, row.id))
  if (localVariants.length > 0) {
    const shopifyIdBySku = new Map<string, number>()
    for (const v of listingVariants) {
      const key = String(v.sku ?? '').trim().toLowerCase()
      if (key && v.id) shopifyIdBySku.set(key, Number(v.id))
    }
    let pushed = 0
    const variantErrors: string[] = []
    for (const v of localVariants) {
      const vPrice = Number(v.sellingPrice)
      const target = shopifyIdBySku.get(String(v.sku ?? '').trim().toLowerCase())
      if (!target || !Number.isFinite(vPrice) || vPrice <= 0) continue
      const putError = await putVariantPrice(target, vPrice, Number(v.compareAtPrice))
      if (putError) {
        variantErrors.push(`${v.sku}: ${putError}`)
      } else {
        pushed++
      }
    }
    if (pushed > 0) {
      store.lastSync.price = new Date().toISOString()
      addLog('price', 'success', pushed, `Variant prices updated: ${row.sku} (${pushed})`)
      await persistLog({ entity: 'Price', shopifyId: row.sku, direction: 'out', action: 'Price Update', status: 'success' })
    }
    if (variantErrors.length > 0) {
      const message = variantErrors.join('; ')
      addLog('price', 'failed', 1, message)
      store.lastError = message
      await persistLog({ entity: 'Price', shopifyId: row.sku, direction: 'out', action: 'Price Update', status: 'failed', error: message, retry: true })
    }
    if (pushed === 0 && variantErrors.length === 0) {
      return { ok: false, updated: 0, skipped: 0, errors: [`No Shopify variant matched a local variant of ${row.sku}`] }
    }
    return { ok: variantErrors.length === 0, updated: pushed, skipped: 0, errors: variantErrors }
  }

  const variantId = Number(listingVariants[0]?.id ?? 0)
  const putError = await putVariantPrice(variantId, price, compareAt)
  if (putError) {
    const message = putError
    addLog('price', 'failed', 1, message)
    store.lastError = message
    await persistLog({ entity: 'Price', shopifyId: row.sku, direction: 'out', action: 'Price Update', status: 'failed', error: message, retry: true })
    return { ok: false, updated: 0, skipped: 0, errors: [message] }
  }

  store.price = store.price.map((p) =>
    p.productId === shopifyProductId
      ? { ...p, currentPrice: price, targetPrice: price, status: 'up-to-date' as const }
      : p,
  )
  store.products = store.products.map((p) =>
    p.id === shopifyProductId
      ? { ...p, price: price.toFixed(2), compareAtPrice: Number.isFinite(compareAt) && compareAt > 0 ? compareAt.toFixed(2) : null }
      : p,
  )
  store.lastSync.price = new Date().toISOString()
  addLog('price', 'success', 1, `Price updated: ${row.sku}`)
  await persistLog({ entity: 'Price', shopifyId: row.sku, direction: 'out', action: 'Price Update', status: 'success' })
  return { ok: true, updated: 1, skipped: 0, errors: [] }
  } finally {
    releaseSyncLock()
  }
}

interface LocalProductForPush {
  id: string
  name: string
  sku: string
  barcode: string | null
  huid: string | null
  category: string | null
  collection: string | null
  purity: number | null
  supplier: string | null
  vendor: string | null
  productType: string | null
  description: string | null
  tags: string | null
  image: string | null
  images: string[] | null
  sellingPrice: number | null
  compareAtPrice: number | null
  stock: number | null
  trackInventory: boolean | null
  chargeOnTax: boolean | null
  shopifyId: string | null
  shopifyStatus: string | null
  status: string | null
  /** Shopify-style option definitions (products.options). */
  options?: Array<{ name: string; values: string[] }> | null
  /** The variant rows for this product (product_variants), when attached. */
  variants?: LocalVariantForPush[] | null
}

/** One local variant as it travels to Shopify. */
export interface LocalVariantForPush {
  id: string
  title: string
  optionValues: string[]
  sku: string
  barcode: string | null
  sellingPrice: number | null
  compareAtPrice: number | null
  stock: number | null
}

function buildShopifyTags(local: LocalProductForPush): string {
  return [
    local.collection ? `opal-collection:${local.collection}` : null,
    local.chargeOnTax !== false ? `opal-chargeontax:true` : `opal-chargeontax:false`,
    local.category,
    local.purity != null ? `${local.purity}%` : null,
    local.huid ? `huid:${local.huid}` : null,
    ...(local.tags ? local.tags.split(',').map((t) => t.trim()).filter(Boolean) : []),
  ]
    .filter(Boolean)
    .join(', ')
}

/**
 * Build the Shopify `images` payload from local uploads (served paths / data
 * URLs) and remote URLs. Local files are read from disk and attached as
 * base64 — the "push from local path" flow. Each locally-sourced image gets a
 * stable `alt` marker (filename or content hash) so a re-push can recognise
 * images already on the Shopify product instead of duplicating them.
 */
export async function buildShopifyImages(local: LocalProductForPush): Promise<Array<Record<string, string>>> {
  const imageSrcs = Array.from(new Set([...(local.images ?? []).filter(Boolean), local.image].filter(Boolean) as string[]))
  // IMAGE POLICY: only images the user actually provided (uploads, data URLs,
  // external URLs) are pushed to Shopify. cdn.shopify.com URLs are sync
  // artifacts written back into local rows after earlier pushes/imports —
  // re-attaching them would duplicate or reshuffle listings with images the
  // user never chose, so they are always skipped here.
  const pushable = imageSrcs.filter((src) => !/^https?:\/\/[^/]*cdn\.shopify\.com\//i.test(src))
  const images: Array<Record<string, string>> = []
  for (const src of pushable.slice(0, 20)) {
    if (/^data:image\//i.test(src)) {
      const base64 = src.slice(src.indexOf(',') + 1)
      if (base64) {
        const hash = createHash('sha1').update(Buffer.from(base64, 'base64')).digest('hex').slice(0, 16)
        images.push({ attachment: base64, alt: `data-${hash}` })
      }
    } else if (/^https?:\/\//i.test(src)) {
      images.push({ src })
    } else if (/^\/?(uploads|images)\//i.test(src)) {
      // Locally-served file path — read from disk and attach as base64
      try {
        const { readFileSync } = await import('node:fs')
        const { join } = await import('node:path')
        const { UPLOADS_DIR } = await import('./uploads')
        const fileName = path.basename(src.replace(/^\/(uploads|images)\//, ''))
        const buf = readFileSync(join(UPLOADS_DIR(), fileName))
        images.push({ attachment: buf.toString('base64'), filename: fileName, alt: fileName })
      } catch {
        // File missing on disk — skip rather than fail the whole push.
      }
    }
  }
  return images
}

async function createShopifyProduct(local: LocalProductForPush): Promise<{
  productId: number
  variantId: number
  inventoryItemId: number | null
  /** Every created variant (id + inventory item + sku) for per-variant stock. */
  variants: Array<{ id: number; inventoryItemId: number | null; sku: string }>
}> {
  if (!isConfigured()) {
    throw new ShopifyError('Shopify is not configured. Set SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN in server/.env', 503)
  }
  const url = new URL(apiPath(config.apiVersion, 'products'))
  const price = Number(local.sellingPrice)
  const trackInventory = local.trackInventory !== false
  const chargeOnTax = local.chargeOnTax !== false
  const variant: Record<string, string | number | boolean> = {}
  if (price > 0) variant.price = price.toFixed(2)
  if (Number(local.compareAtPrice) > 0) variant.compare_at_price = Number(local.compareAtPrice).toFixed(2)
  if (local.sku) variant.sku = local.sku
  if (local.barcode) variant.barcode = local.barcode
  if (trackInventory) variant.inventory_management = 'shopify'
  variant.taxable = chargeOnTax

  const tags = buildShopifyTags(local)

  // Shopify-style products carry their options and one variant per option-value
  // combination; simple products keep the single default variant above.
  const hasVariants = (local.options?.length ?? 0) > 0 && (local.variants?.length ?? 0) > 0
  const variantPayloads: Array<Record<string, string | number | boolean>> = hasVariants
    ? (local.variants ?? []).map((v) => {
        const entry: Record<string, string | number | boolean> = {}
        const vPrice = Number(v.sellingPrice)
        if (Number.isFinite(vPrice) && vPrice > 0) entry.price = vPrice.toFixed(2)
        else if (price > 0) entry.price = price.toFixed(2)
        if (Number(v.compareAtPrice) > 0) entry.compare_at_price = Number(v.compareAtPrice).toFixed(2)
        if (v.sku) entry.sku = v.sku
        if (v.barcode) entry.barcode = v.barcode
        if (trackInventory) entry.inventory_management = 'shopify'
        entry.taxable = chargeOnTax
        entry.option1 = String(v.optionValues[0] ?? '')
        entry.option2 = String(v.optionValues[1] ?? '')
        entry.option3 = String(v.optionValues[2] ?? '')
        return entry
      })
    : [variant]

  const body: Record<string, unknown> = {
    product: {
      title: local.name,
      body_html: toDescriptionHtml(local.description, local.name),
      vendor: local.vendor || local.supplier || 'Opal Line',
      product_type: collectionSegments(local.collection)[0] || local.productType || local.category || '',
      tags,
      status: 'active',
      variants: variantPayloads,
    },
  }
  if (hasVariants) {
    ;(body.product as Record<string, unknown>).options = (local.options ?? []).map((o) => ({
      name: o.name,
      values: o.values,
    }))
  }
  const images = await buildShopifyImages(local)
  if (images.length > 0) {
    body.product = { ...(body.product as object), images }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': config.accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ShopifyError(`Shopify API error ${res.status}: ${text.slice(0, 200)}`, res.status)
  }
  const json = (await res.json()) as { product?: { id?: number; variants?: Array<{ id?: number; sku?: string | null; inventory_item_id?: number }> } }
  const productId = Number(json.product?.id ?? 0)
  // The listing exists now — make storefront collection membership match the
  // local collection. Best-effort; never fails the product create.
  await pushCollectionMembership(local, productId, null)
  if (!productId) {
    throw new ShopifyError('Shopify returned an unexpected response while creating the product.', 502)
  }
  const createdVariants = (json.product?.variants ?? []).map((v) => ({
    id: Number(v?.id ?? 0),
    inventoryItemId: v?.inventory_item_id != null ? Number(v.inventory_item_id) : null,
    sku: String(v?.sku ?? ''),
  }))
  return {
    productId,
    variantId: createdVariants[0]?.id ?? 0,
    inventoryItemId: createdVariants[0]?.inventoryItemId ?? null,
    variants: createdVariants,
  }
}

/**
 * Push content (title, vendor, tags) and local images to an already-listed
 * Shopify product — the "push from local path" flow for edits. For
 * Shopify-style products the option/variant set is synced here too (matched
 * back by SKU; new combinations created, removed ones deleted). Simple
 * products leave their single variant alone: prices and inventory travel
 * through their own dedicated sync paths. Images already present on the
 * listing (matched by their stable alt marker / URL path) are filtered out
 * so re-pushes never duplicate the gallery.
 */
async function updateShopifyProductContent(local: LocalProductForPush): Promise<void> {
  if (!isConfigured()) {
    throw new ShopifyError('Shopify is not configured. Set SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN in server/.env', 503)
  }
  const id = Number(String(local.shopifyId ?? '').replace(/^#/, ''))
  if (!id) throw new ShopifyError('Product has no valid Shopify ID', 400)

  const url = new URL(apiPath(config.apiVersion, `products/${id}`))

  // Learn which images / variants the listing already has (best-effort).
  const existingAlt = new Set<string>()
  const existingSrcPaths = new Set<string>()
  let listingBefore: Array<{ id?: number; alt?: string | null; src?: string }> = []
  let previousCollection: string | null = null
  let listingVariants: Array<{ id?: number; sku?: string | null }> = []
  try {
    const get = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': config.accessToken, Accept: 'application/json' },
    })
    if (get.ok) {
      const json = (await get.json()) as { product?: { images?: Array<{ id?: number; alt?: string | null; src?: string }>; variants?: Array<{ id?: number; sku?: string | null }> } }
      listingBefore = json.product?.images ?? []
      listingVariants = json.product?.variants ?? []
      // Remember the collection the app pushed last time so a collection
      // change can drop exactly the membership it created earlier.
      previousCollection = collectionFromTags((json as { product?: { tags?: unknown } }).product?.tags)
      for (const img of listingBefore) {
        if (img.alt) existingAlt.add(img.alt)
        if (img.src) {
          try { existingSrcPaths.add(new URL(img.src).pathname) } catch { existingSrcPaths.add(img.src) }
        }
      }
    }
  } catch { /* fall through and send all images */ }

  const newImages = (await buildShopifyImages(local)).filter((img) => {
    if (typeof img.alt === 'string' && existingAlt.has(img.alt)) return false
    if (typeof img.src === 'string') {
      try { return !existingSrcPaths.has(new URL(img.src).pathname) } catch { return true }
    }
    return true
  })

  const product: Record<string, unknown> = {
    title: local.name,
    body_html: toDescriptionHtml(local.description, local.name),
    vendor: local.vendor || local.supplier || 'Opal Line',
    product_type: collectionSegments(local.collection)[0] || local.productType || local.category || '',
    tags: buildShopifyTags(local),
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'X-Shopify-Access-Token': config.accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ product: { id, ...product } }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ShopifyError(`Shopify API error ${res.status}: ${text.slice(0, 200)}`, res.status)
  }

  // A product PUT never creates gallery entries — new images must go through
  // the dedicated product-images endpoint (one call per image).
  // The content update landed — now make storefront collection membership
  // match the local collection (best-effort; never fails the content push).
  await pushCollectionMembership(local, id, previousCollection)

  // Shopify-style products: sync the option/variant set. Local variants are
  // matched back to listing variants by SKU (case-insensitive); matches
  // update in place, new combinations are created, and listing variants no
  // longer present locally are deleted afterwards.
  const localVariants = local.variants ?? []
  if ((local.options?.length ?? 0) > 0 && localVariants.length > 0) {
    const shopifyBySku = new Map<string, number>()
    for (const v of listingVariants) {
      const key = String(v.sku ?? '').trim().toLowerCase()
      if (key && v.id) shopifyBySku.set(key, Number(v.id))
    }
    const keptSkus = new Set<string>()
    const variantPayloads = localVariants.map((v) => {
      const entry: Record<string, unknown> = {
        option1: String(v.optionValues[0] ?? ''),
        option2: String(v.optionValues[1] ?? ''),
        option3: String(v.optionValues[2] ?? ''),
        sku: v.sku,
        taxable: local.chargeOnTax !== false,
      }
      const vPrice = Number(v.sellingPrice)
      if (Number.isFinite(vPrice) && vPrice > 0) entry.price = vPrice.toFixed(2)
      if (Number(v.compareAtPrice) > 0) entry.compare_at_price = Number(v.compareAtPrice).toFixed(2)
      if (v.barcode) entry.barcode = v.barcode
      if (local.trackInventory !== false) entry.inventory_management = 'shopify'
      const matchedId = shopifyBySku.get(v.sku.trim().toLowerCase())
      if (matchedId) {
        entry.id = matchedId
        keptSkus.add(String(matchedId))
      }
      return entry
    })
    const variantRes = await fetch(url, {
      method: 'PUT',
      headers: {
        'X-Shopify-Access-Token': config.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        product: {
          id,
          options: (local.options ?? []).map((o) => ({ name: o.name, values: o.values })),
          variants: variantPayloads,
        },
      }),
    })
    if (!variantRes.ok) {
      const text = await variantRes.text().catch(() => '')
      throw new ShopifyError(`Shopify API error ${variantRes.status} while syncing variants: ${text.slice(0, 200)}`, variantRes.status)
    }
    // Delete listing variants that no longer exist locally (best-effort;
    // Shopify requires at least one variant, which the PUT above guarantees).
    for (const v of listingVariants) {
      if (!v.id || keptSkus.has(String(v.id))) continue
      try {
        await fetch(new URL(apiPath(config.apiVersion, `variants/${v.id}`)), {
          method: 'DELETE',
          headers: { 'X-Shopify-Access-Token': config.accessToken, Accept: 'application/json' },
        })
      } catch { /* best-effort: a stale variant can be removed next push */ }
    }
  }

  const justAddedPathnames = new Set<string>()
  for (const img of newImages) {
    const image: Record<string, string> = {}
    if (img.attachment) image.attachment = img.attachment
    if (img.src) image.src = img.src
    if (img.alt) image.alt = img.alt
    const r = await fetch(new URL(apiPath(config.apiVersion, `products/${id}/images`)), {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': config.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ image }),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      throw new ShopifyError(`Shopify API error ${r.status} while adding product image: ${text.slice(0, 200)}`, r.status)
    }
    const created = (await r.json().catch(() => ({}))) as { image?: { src?: string } }
    if (created.image?.src) {
      try { justAddedPathnames.add(new URL(created.image.src).pathname) } catch { /* unparsable src */ }
    }
  }

  // Make the listing match the local gallery, then point the local row at
  // Shopify's hosted copies (CDN URLs). Never delete when the local gallery
  // is empty — that would wipe images the user manages elsewhere.
  const localRefs = [...new Set([...(local.images ?? []), local.image].filter(Boolean) as string[])]
  await reconcileListingImages(id, localRefs, justAddedPathnames, (imgs) =>
    writebackShopifyImageUrls(local.id, String(id), imgs),
  )
}

/**
 * Reconcile a Shopify listing's images with the local gallery after a push:
 *
 * - delete listing images that match no local ref — a *verified* DELETE with
 *   429/5xx backoff (commit 0952017: fire-and-forget deletes let rate-limited
 *   placeholder cards survive on the listing);
 * - hand the write-back only the kept survivors (post-delete view), never the
 *   pre-delete snapshot, so a poisoned local row can't re-add stale images;
 * - wait briefly for Shopify's async image processing so just-added images are
 *   visible before writing back (commit 78fe34f: racing the processor left the
 *   local row on the old local path).
 *
 * No-op when the local gallery is empty. Best-effort: never throws.
 * Exported so the image write-back regressions are covered by tests.
 */
export async function reconcileListingImages(
  productId: number,
  localRefsInput: string[],
  justAddedPathnames: Set<string>,
  writeback: (imgs?: Array<{ src?: string }>) => Promise<void>,
): Promise<{ kept: Array<{ src?: string }>; deleted: number }> {
  let kept: Array<{ src?: string }> = []
  let deleted = 0
  const localRefs = [...new Set(localRefsInput.filter(Boolean))]
  if (localRefs.length === 0) return { kept, deleted }

  const url = new URL(apiPath(config.apiVersion, `products/${productId}`))
  const localAlts = new Set(
    localRefs
      .filter((ref) => /^\/?uploads\//i.test(ref) || /^\/?images\//i.test(ref))
      .map((ref) => path.basename(ref)),
  )
  const localPathnames = new Set<string>()
  for (const ref of localRefs) {
    if (/^https?:\/\//i.test(ref)) {
      try { localPathnames.add(new URL(ref).pathname) } catch { /* skip unparsable */ }
    }
  }
  try {
    const get = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': config.accessToken, Accept: 'application/json' },
    })
    if (get.ok) {
      const json = (await get.json()) as { product?: { images?: Array<{ id?: number; alt?: string | null; src?: string }> } }
      const listedImages = json.product?.images ?? []
      const keptImages: Array<{ src?: string }> = []
      for (const img of listedImages) {
        if (!img.id || !img.src) continue
        let pathname = img.src
        try { pathname = new URL(img.src).pathname } catch { /* use raw */ }
        const keep =
          justAddedPathnames.has(pathname) ||
          (img.alt != null && localAlts.has(img.alt)) ||
          localPathnames.has(pathname)
        // Build the post-delete view: only images we keep are written back
        // locally, so a stale listing image (old placeholder card) can never
        // be mirrored into the local row again.
        if (keep) { keptImages.push({ src: img.src }); continue }
        // Stale listing image — delete it with a status check and 429/5xx
        // backoff. This used to be fire-and-forget: a rate-limited DELETE
        // failed silently while the write-back still recorded the image.
        if (await deleteShopifyImageWithRetry(productId, img.id)) deleted++
      }
      // Point the local row at Shopify's hosted copies (CDN URLs). Pass
      // keptImages (post-cleanup), not the pre-delete listing snapshot.
      // Shopify processes image uploads asynchronously: the just-added image
      // may not appear on the listing for a few seconds, which previously
      // made keptImages empty/stale and skipped the write-back. Wait briefly
      // and re-fetch until the listing reflects what we just added.
      let finalImgs = keptImages
      if (justAddedPathnames.size > 0) {
        const has = (imgs: Array<{ src?: string }>) =>
          imgs.filter((i) => {
            if (!i.src) return false
            try { return justAddedPathnames.has(new URL(i.src).pathname) } catch { return false }
          }).length
        for (let r = 0; r < 4 && has(finalImgs) < justAddedPathnames.size; r++) {
          await new Promise((res) => setTimeout(res, 1500))
          try {
            const g2 = await fetch(url, { headers: { 'X-Shopify-Access-Token': config.accessToken, Accept: 'application/json' } })
            if (g2.ok) {
              const j2 = (await g2.json()) as { product?: { images?: Array<{ src?: string }> } }
              finalImgs = j2.product?.images ?? []
            }
          } catch { /* retry */ }
        }
      }
      kept = finalImgs
      await writeback(finalImgs.length > 0 ? finalImgs : undefined)
    }
  } catch { /* best-effort image cleanup + write-back */ }
  return { kept, deleted }
}

/**
 * After a push, point the local row at Shopify's hosted image URLs (CDN).
 * Image bytes are never stored in the database — only the URL string — and
 * future pushes treat a CDN ref as idempotent (deduped by URL pathname).
 * Best-effort: never throws into the push flow.
 */
async function writebackShopifyImageUrls(
  localId: string,
  shopifyId: string | number | null,
  prefetched?: Array<{ src?: string }>,
): Promise<void> {
  if (!db) return
  const id = Number(String(shopifyId ?? '').replace(/^#/, ''))
  if (!id) return
  try {
    let imgs = prefetched
    if (!imgs) {
      const res = await fetch(apiPath(config.apiVersion, `products/${id}`), {
        headers: { 'X-Shopify-Access-Token': config.accessToken, Accept: 'application/json' },
      })
      if (!res.ok) return
      const json = (await res.json()) as { product?: { images?: Array<{ src?: string }> } }
      imgs = json.product?.images ?? []
    }
    const srcs = imgs.map((i) => i.src).filter((s): s is string => typeof s === 'string' && s.length > 0)
    if (srcs.length === 0) return
    const [current] = await db
      .select({ image: schema.products.image, images: schema.products.images })
      .from(schema.products)
      .where(eq(schema.products.id, localId))
      .limit(1)
    const cur = Array.isArray(current?.images) ? (current!.images as string[]) : []
    const unchanged = current?.image === srcs[0] && cur.length === srcs.length && cur.every((s, i) => s === srcs[i])
    if (unchanged) return
    await db.update(schema.products).set({ image: srcs[0], images: srcs }).where(eq(schema.products.id, localId))
  } catch { /* best-effort */ }
}

/**
 * DELETE a listing image with status verification and 429/5xx backoff.
 * Returns true when the image is gone (or already absent).
 * Exported for the one-off repair script (scripts/repair-listing-images).
 */
export async function deleteShopifyImageWithRetry(productId: number, imageId: number): Promise<boolean> {
  const url = new URL(apiPath(config.apiVersion, `products/${productId}/images/${imageId}`))
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500 * attempt))
    try {
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { 'X-Shopify-Access-Token': config.accessToken, Accept: 'application/json' },
      })
      if (res.ok || res.status === 404) return true
      if (res.status !== 429 && res.status < 500) {
        logger.warn({ productId, imageId, status: res.status }, 'shopify: image delete rejected')
        return false
      }
    } catch { /* network error — retry */ }
  }
  logger.warn({ productId, imageId }, 'shopify: image delete failed after retries')
  return false
}

export async function deleteShopifyProduct(productId: number): Promise<void> {
  const url = new URL(apiPath(config.apiVersion, `products/${productId}`))
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      'X-Shopify-Access-Token': config.accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  })
  if (res.status === 404) return
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ShopifyError(`Shopify API error ${res.status}: ${text.slice(0, 200)}`, res.status)
  }
}

export interface ShopifyPurgeResult {
  ok: boolean
  shopifyDeleted: number
  localDeleted: number
  errors: string[]
}

export async function purgeProducts(): Promise<ShopifyPurgeResult> {
  if (!isConfigured()) {
    return { ok: false, shopifyDeleted: 0, localDeleted: 0, errors: ['Shopify is not configured. See server/.env'] }
  }

  const errors: string[] = []
  let shopifyDeleted = 0
  let localDeleted = 0

  let all: any[] = []
  try {
    all = await paginate<any>('products', '', CONSTANTS.SHOPIFY_MAX_PAGES * 4)
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'Failed to list Shopify products')
  }

  for (const raw of all) {
    try {
      await deleteShopifyProduct(Number(raw.id))
      shopifyDeleted++
    } catch (err) {
      errors.push(`${raw.id}: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  if (db) {
    try {
      const rows = await db.select({ id: schema.products.id }).from(schema.products)
      localDeleted = rows.length
      await db.delete(schema.products)
      await db.delete(schema.stockTransfers)
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'Failed to clear local products')
    }
  } else {
    errors.push('Database is not configured')
  }

  store.products = []
  store.inventory = []
  store.price = []
  store.lastSync = {}
  store.logs = []

  return { ok: errors.length === 0, shopifyDeleted, localDeleted, errors }
}

export interface ShopifyPushResult {
  ok: boolean
  created: number
  /** Already-listed products whose content/images were pushed as an update. */
  updated?: number
  skipped: number
  errors: string[]
  message?: string
}

export async function pushProductsToShopify(ids?: string[]): Promise<ShopifyPushResult> {
  if (!(await acquireSyncLock('products'))) return { ok: false, created: 0, skipped: 0, errors: [], message: 'A sync is already in progress' }
  if (!isConfigured()) {
    releaseSyncLock()
    return { ok: false, created: 0, skipped: 0, errors: ['Shopify is not configured. See server/.env'], message: 'Shopify is not configured. See server/.env' }
  }
  if (!db) {
    releaseSyncLock()
    return { ok: false, created: 0, skipped: 0, errors: ['Database is not configured'], message: 'Database is not configured' }
  }

  let rows: LocalProductForPush[]
  try {
    const selected = ids && ids.length > 0
      ? await db.select().from(schema.products).where(inArray(schema.products.id, ids))
      : await db.select().from(schema.products).where(or(isNull(schema.products.shopifyId), eq(schema.products.shopifyId, ''), like(schema.products.shopifyId, '#%')))
    rows = selected.map((r) => ({
      ...r,
      images: Array.isArray(r.images) ? (r.images as string[]).filter((x): x is string => typeof x === 'string') : null,
      options: Array.isArray(r.options) ? (r.options as Array<{ name: string; values: string[] }>) : null,
      variants: null,
    }))
    // Variant rows ride along so the create sends the full option/variant set
    // (one query for the whole batch — pushes are ≤200 products).
    if (rows.length > 0) {
      const variantRows = await db
        .select()
        .from(schema.productVariants)
        .where(inArray(schema.productVariants.productId, rows.map((r) => r.id)))
      const byProduct = new Map<string, LocalVariantForPush[]>()
      for (const v of variantRows) {
        const list = byProduct.get(v.productId) ?? []
        list.push({
          id: v.id,
          title: v.title,
          optionValues: Array.isArray(v.optionValues) ? (v.optionValues as string[]) : [],
          sku: v.sku,
          barcode: v.barcode,
          sellingPrice: v.sellingPrice,
          compareAtPrice: v.compareAtPrice,
          stock: v.stock,
        })
        byProduct.set(v.productId, list)
      }
      for (const r of rows) r.variants = byProduct.get(r.id) ?? null
    }
  } catch (err) {
    releaseSyncLock()
    return { ok: false, created: 0, skipped: 0, errors: [err instanceof Error ? err.message : 'Failed to read products'] }
  }
  let created = 0
  let updated = 0
  let skipped = 0
  const errors: string[] = []
  let locations: { id: number; name: string }[] = []
  // Shopify-side collections may have changed since the last push — refetch
  // the directory once per batch so a title never gets a duplicate collection.
  resetCollectionDirectory()

  try {
    for (const row of rows) {
      const placeHolderId = row.shopifyId != null && String(row.shopifyId).trim().startsWith('#')
      const genuinelyLinked = row.shopifyId != null && String(row.shopifyId).trim() !== '' && !placeHolderId
      if (genuinelyLinked) {
        // Explicitly selected (edit → "Push to Shopify"): sync content and
        // local images to the existing listing. The bulk "push all" query only
        // returns unlinked rows, so updates only run when the user asked.
        if (ids && ids.length > 0) {
          try {
            await updateShopifyProductContent(row)
            updated++
            addLog('products', 'success', 1, `Updated on Shopify: ${row.sku}`)
            await persistLog({ entity: 'Product', shopifyId: row.shopifyId ?? row.sku, direction: 'out', action: 'Update', status: 'success' })
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error'
            errors.push(`${row.sku}: ${message}`)
            addLog('products', 'failed', 1, message)
            await persistLog({ entity: 'Product', shopifyId: row.shopifyId ?? row.sku, direction: 'out', action: 'Update', status: 'failed', error: message, retry: true })
          }
        } else {
          skipped++
        }
        continue
      }
      if (row.status && row.status !== 'active') {
        skipped++
        continue
      }
      try {
        const { productId, variantId, inventoryItemId, variants: createdVariants } = await createShopifyProduct(row)
        await db.update(schema.products).set({ shopifyId: String(productId), shopifyStatus: 'synced' }).where(eq(schema.products.id, row.id))
        // Newly created listing already carries the local images — point the
        // local row at Shopify's hosted copies right away.
        await writebackShopifyImageUrls(row.id, productId)
        created++
        addLog('products', 'success', 1, `Created on Shopify: ${row.sku}`)
        await persistLog({ entity: 'Product', shopifyId: String(productId), direction: 'out', action: 'Create', status: 'success' })
        if (row.trackInventory !== false) {
          try {
            if (locations.length === 0) locations = await fetchLocations()
            const locationId = locations[0]?.id
            const localVariants = row.variants ?? []
            if (locationId && localVariants.length > 0) {
              // Variant product: each variant gets ITS stock on its own
              // inventory item, matched back by SKU.
              const stockBySku = new Map(localVariants.map((v) => [v.sku.trim().toLowerCase(), Math.max(0, Math.floor(Number(v.stock) || 0))]))
              for (const cv of createdVariants) {
                if (!cv.inventoryItemId) continue
                const qty = stockBySku.get(cv.sku.trim().toLowerCase()) ?? 0
                await setInventoryItemTracked(cv.inventoryItemId)
                await setInventoryLevel(cv.inventoryItemId, locationId, qty)
              }
            } else if (locationId && inventoryItemId) {
              await setInventoryItemTracked(inventoryItemId)
              await setInventoryLevel(inventoryItemId, locationId, Number(row.stock ?? 0))
            }
          } catch {
            // Inventory level is best-effort; the product itself is already created.
          }
        }
        if (variantId) {
          store.price = store.price.map((p) =>
            p.productId === productId ? { ...p, variantId, status: p.status === 'no-match' ? 'update' : p.status } : p,
          )
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        errors.push(`${row.sku}: ${message}`)
        addLog('products', 'failed', 1, message)
        await persistLog({ entity: 'Product', shopifyId: row.sku, direction: 'out', action: 'Create', status: 'failed', error: message, retry: true })
      }
    }
    if (created + updated > 0) {
      store.lastSync.products = new Date().toISOString()
      try {
        await syncProducts()
      } catch {
        // Best-effort refresh of the in-memory catalog after pushing.
      }
    }
    return { ok: errors.length === 0, created, updated, skipped, errors }
  } finally {
    releaseSyncLock()
  }
}

export interface ShopifyInventoryPushResult {
  ok: boolean
  updated: number
  skipped: number
  errors: string[]
  message?: string
}

async function setInventoryItemTracked(inventoryItemId: number) {
  const url = new URL(apiPath(config.apiVersion, `inventory_items/${inventoryItemId}`))
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'X-Shopify-Access-Token': config.accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ inventory_item: { id: inventoryItemId, tracked: true } }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ShopifyError(`Shopify API error ${res.status}: ${text.slice(0, 200)}`, res.status)
  }
}

async function setInventoryLevel(inventoryItemId: number, locationId: number, available: number) {
  const url = new URL(apiPath(config.apiVersion, 'inventory_levels/set'))
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': config.accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ inventory_item_id: inventoryItemId, location_id: locationId, available }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ShopifyError(`Shopify API error ${res.status}: ${text.slice(0, 200)}`, res.status)
  }
}

export async function pushInventoryToShopify(ids?: string[]): Promise<ShopifyInventoryPushResult> {
  if (!(await acquireSyncLock('inventory'))) return { ok: false, updated: 0, skipped: 0, errors: [], message: 'A sync is already in progress' }
  if (!isConfigured()) {
    releaseSyncLock()
    return { ok: false, updated: 0, skipped: 0, errors: ['Shopify is not configured. See server/.env'], message: 'Shopify is not configured. See server/.env' }
  }
  if (!db) {
    releaseSyncLock()
    return { ok: false, updated: 0, skipped: 0, errors: ['Database is not configured'], message: 'Database is not configured' }
  }

  try {
    if (store.products.length === 0) await syncProducts()
  } catch (err) {
    releaseSyncLock()
    return { ok: false, updated: 0, skipped: 0, errors: [err instanceof Error ? err.message : 'Failed to sync products'] }
  }

  let rows: Array<{ id: string; sku: string; stock: number | null }>
  try {
    rows = ids && ids.length > 0
      ? await db.select({ id: schema.products.id, sku: schema.products.sku, stock: schema.products.stock }).from(schema.products).where(inArray(schema.products.id, ids))
      : await db.select({ id: schema.products.id, sku: schema.products.sku, stock: schema.products.stock }).from(schema.products)
  } catch (err) {
    releaseSyncLock()
    return { ok: false, updated: 0, skipped: 0, errors: [err instanceof Error ? err.message : 'Failed to read products'] }
  }

  const bySku = new Map<string, SyncProduct>()
  const bySkuCompact = new Map<string, SyncProduct>()
  for (const p of store.products) {
    if (!p.sku) continue
    const key = p.sku.trim().toLowerCase()
    bySku.set(key, p)
    bySkuCompact.set(normalizeKey(key), p)
  }

  // Live VARIANTS indexed by SKU: a variant product carries the variant's SKU
  // on Shopify, so the parent loop below skips it — its stock travels per
  // variant here instead.
  const liveVariantBySku = new Map<string, number>()
  for (const p of store.products) {
    for (const v of p.variants ?? []) {
      const key = String(v.sku ?? '').trim().toLowerCase()
      if (key && v.inventoryItemId) liveVariantBySku.set(key, v.inventoryItemId)
    }
  }
  let variantRows: Array<{ sku: string; stock: number | null }> = []
  try {
    variantRows = ids && ids.length > 0
      ? await db.select({ sku: schema.productVariants.sku, stock: schema.productVariants.stock })
          .from(schema.productVariants)
          .where(inArray(schema.productVariants.productId, ids))
      : await db.select({ sku: schema.productVariants.sku, stock: schema.productVariants.stock })
          .from(schema.productVariants)
  } catch {
    // No variants table rows (older install mid-upgrade) — parent push only.
    variantRows = []
  }

  let locations: { id: number; name: string }[]
  try {
    locations = await fetchLocations()
  } catch (err) {
    releaseSyncLock()
    return { ok: false, updated: 0, skipped: 0, errors: [err instanceof Error ? err.message : 'Failed to fetch locations'] }
  }
  const locationId = locations[0]?.id
  if (!locationId) {
    releaseSyncLock()
    return { ok: false, updated: 0, skipped: 0, errors: ['No inventory locations found on the store'] }
  }

  let updated = 0
  let skipped = 0
  const errors: string[] = []

  try {
    for (const row of rows) {
      const skuKey = String(row.sku ?? '').trim().toLowerCase()
      if (!skuKey) {
        skipped++
        continue
      }
      const shop = bySku.get(skuKey) ?? bySkuCompact.get(normalizeKey(skuKey))
      if (!shop || !shop.inventoryItemId) {
        skipped++
        continue
      }
      const stock = Number(row.stock ?? 0)
      try {
        await setInventoryItemTracked(shop.inventoryItemId)
        await setInventoryLevel(shop.inventoryItemId, locationId, stock)
        updated++
        addLog('inventory', 'success', 1, `Stock set: ${shop.sku} = ${stock}`)
        await persistLog({ entity: 'Inventory', shopifyId: shop.sku, direction: 'out', action: 'Stock Update', status: 'success' })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        errors.push(`${shop.sku}: ${message}`)
        addLog('inventory', 'failed', 1, message)
        await persistLog({ entity: 'Inventory', shopifyId: shop.sku, direction: 'out', action: 'Stock Update', status: 'failed', error: message, retry: true })
      }
    }
    // Per-variant stock: each local variant's count lands on its own Shopify
    // inventory item (matched back by SKU). Parent rows above already covered
    // simple products.
    for (const v of variantRows) {
      const key = String(v.sku ?? '').trim().toLowerCase()
      const inventoryItemId = key ? liveVariantBySku.get(key) : undefined
      if (!inventoryItemId) {
        skipped++
        continue
      }
      try {
        await setInventoryItemTracked(inventoryItemId)
        await setInventoryLevel(inventoryItemId, locationId, Math.max(0, Math.floor(Number(v.stock) || 0)))
        updated++
        addLog('inventory', 'success', 1, `Stock set: ${v.sku} = ${Math.max(0, Math.floor(Number(v.stock) || 0))}`)
        await persistLog({ entity: 'Inventory', shopifyId: v.sku, direction: 'out', action: 'Stock Update', status: 'success' })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        errors.push(`${v.sku}: ${message}`)
        addLog('inventory', 'failed', 1, message)
        await persistLog({ entity: 'Inventory', shopifyId: v.sku, direction: 'out', action: 'Stock Update', status: 'failed', error: message, retry: true })
      }
    }
    if (updated > 0) {
      store.lastSync.inventory = new Date().toISOString()
      try {
        await syncInventory()
      } catch {
        // Best-effort refresh of in-memory inventory after pushing.
      }
    }
    return { ok: errors.length === 0, updated, skipped, errors }
  } finally {
    releaseSyncLock()
  }
}

const syncers: Record<SyncResource, () => Promise<number>> = {
  products: syncProducts,
  orders: syncOrders,
  customers: syncCustomers,
  inventory: syncInventory,
  price: syncPrices,
}

export interface PostRestoreSyncResult {
  ok: boolean
  products?: { created: number; skipped: number; errors: string[] }
  prices?: { updated: number; skipped: number; errors: string[] }
  inventory?: { updated: number; skipped: number; errors: string[] }
  errors: string[]
}

// After a backup restore has committed the local database, push the restored
// catalog, prices and stock levels to Shopify so the storefront matches the
// restored data. Best-effort: failures are collected but never throw.
export async function pushRestoredDataToShopify(): Promise<PostRestoreSyncResult> {
  if (!isConfigured()) return { ok: false, errors: ['Shopify is not configured. See server/.env'] }
  if (!db) return { ok: false, errors: ['Database is not configured'] }

  const errors: string[] = []
  const result: PostRestoreSyncResult = { ok: true, errors }

  try {
    const products = await pushProductsToShopify()
    result.products = { created: products.created, skipped: products.skipped, errors: products.errors }
    if (!products.ok) errors.push(...products.errors)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Product push failed'
    errors.push(message)
  }

  try {
    await syncProducts()
    await syncPrices()
    const prices = await applyPriceSync()
    result.prices = {
      updated: prices.updated ?? 0,
      skipped: prices.skipped ?? 0,
      errors: prices.errors ?? [],
    }
    if (!prices.ok) errors.push(...(prices.errors ?? []))
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Price sync failed'
    errors.push(message)
  }

  try {
    const inventory = await pushInventoryToShopify()
    result.inventory = { updated: inventory.updated, skipped: inventory.skipped, errors: inventory.errors }
    if (!inventory.ok) errors.push(...inventory.errors)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Inventory push failed'
    errors.push(message)
  }

  result.ok = errors.length === 0
  return result
}

export async function runSync(resources: SyncResource[] = ['orders', 'products', 'customers', 'inventory', 'price']) {
  if (!(await acquireSyncLock('sync'))) return { ok: false, message: 'A sync is already in progress' }
  store.lastError = undefined
  const results: Record<SyncResource, { ok: boolean; count: number; message?: string }> = {
    orders: { ok: false, count: 0 },
    products: { ok: false, count: 0 },
    customers: { ok: false, count: 0 },
    inventory: { ok: false, count: 0 },
    price: { ok: false, count: 0 },
  }

  try {
    for (const resource of resources) {
      try {
        const count = await syncers[resource]()
        store.lastSync[resource] = new Date().toISOString()
        results[resource] = { ok: true, count }
        addLog(resource, 'success', count)
        const meta = entityFor[resource]
        await persistLog({ entity: meta.entity, direction: resource === 'price' ? 'out' : 'in', action: meta.action, status: 'success' })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        results[resource] = { ok: false, count: 0, message }
        addLog(resource, 'failed', 0, message)
        store.lastError = message
        const meta = entityFor[resource]
        await persistLog({ entity: meta.entity, direction: resource === 'price' ? 'out' : 'in', action: meta.action, status: 'failed', error: message, retry: true })
      }
    }
    return { ok: true, results }
  } finally {
    releaseSyncLock()
  }
}

export async function ensureSynced(resource?: SyncResource) {
  const targets = resource ? [resource] : (Object.keys(syncers) as SyncResource[])
  const pending = targets.filter((r) => !store.lastSync[r])
  if (pending.length > 0) {
    await runSync(pending)
  }
}

export interface SilverUpdateResult {
  ok: boolean
  rate: number
  previousRate: number
  affected: number
  matched: number
  updated: number
  skipped: number
  errors: string[]
  message?: string
  /** Step-by-step progress for the UI status checklist. */
  steps?: Array<{ key: string; label: string; status: 'done' | 'failed' | 'skipped'; detail?: string }>
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

export async function getLatestSilverRate(): Promise<{ rate: number; purity: number; previousRate: number; updatedAt: string } | null> {
  if (!db) return null
  try {
    const rows = await db
      .select()
      .from(schema.silverRates)
      .orderBy(desc(schema.silverRates.updatedAt))
      .limit(1)
    const latest = rows[0]
    if (latest) {
      return {
        rate: Number(latest.rate ?? 0),
        purity: Number(latest.purity ?? 0),
        previousRate: Number(latest.previousRate ?? 0),
        updatedAt: String(latest.updatedAt ?? ''),
      }
    }
    // Read-only fallback: no rate change has ever been persisted, but the
    // products already carry a rate from the last product sync. Surface it so
    // the header and dashboard show the real current rate instead of a blank
    // value / perpetual "Loading…". Nothing is written to the database.
    const [productRow] = await db
      .select({ silverRate: schema.products.silverRate, purity: schema.products.purity, createdAt: schema.products.createdAt })
      .from(schema.products)
      .where(isNotNull(schema.products.silverRate))
      .orderBy(desc(schema.products.createdAt))
      .limit(1)
    const fallbackRate = Number(productRow?.silverRate ?? 0)
    if (!fallbackRate || fallbackRate <= 0) return null
    return {
      rate: fallbackRate,
      purity: Number(productRow?.purity ?? 0) || 92.5,
      previousRate: fallbackRate,
      updatedAt: String(productRow?.createdAt ?? ''),
    }
  } catch {
    return null
  }
}

// ─── Live progress for an in-flight silver-rate apply ──────────────────────
// The Silver Rate page polls this while its update request is running, so the
// user sees which phase the repricing is in (and how far along the Shopify
// push is) instead of a frozen spinner. One apply at a time.
export interface SilverRateProgress {
  running: boolean
  phase: 'idle' | 'syncing' | 'repricing' | 'matching' | 'pushing' | 'done'
  label: string
  done: number
  total: number
  startedAt: string | null
  error: string | null
}

let silverRateProgress: SilverRateProgress = {
  running: false,
  phase: 'idle',
  label: '',
  done: 0,
  total: 0,
  startedAt: null,
  error: null,
}

export function getSilverRateProgress(): SilverRateProgress {
  return { ...silverRateProgress }
}

function setSilverRateProgress(patch: Partial<SilverRateProgress>): void {
  silverRateProgress = { ...silverRateProgress, ...patch }
}

export async function applySilverRate(
  rate: number,
  options?: { syncFirst?: boolean; source?: 'manual' | 'auto' | 'approval'; actorName?: string | null },
): Promise<SilverUpdateResult> {
  setSilverRateProgress({
    running: true,
    phase: options?.syncFirst ? 'syncing' : 'repricing',
    label: options?.syncFirst ? 'Syncing the product catalog from Shopify' : 'Applying the new silver rate',
    done: 0,
    total: 0,
    startedAt: new Date().toISOString(),
    error: null,
  })
  const previous = await getLatestSilverRate()
  const previousRate = previous?.rate ?? 92.8

  // Per-step record of this run, persisted on the rate row (silver_rates.step_log)
  // so the history log can still show timestamps, counts and error text after
  // the in-memory result is gone. Only exists once a rate row does — a failure
  // in the optional catalog sync below leaves no history entry at all, which
  // matches what the history table has always recorded.
  const stepLog: SilverRateStepLog = {
    startedAt: new Date().toISOString(),
    finishedAt: '',
    ok: false,
    counts: { repriced: 0, matched: 0, pushed: 0, skipped: 0 },
    steps: [],
  }
  const recordStep = (
    step: Omit<SilverRateStepRecord, 'startedAt' | 'finishedAt'> & { startedAt?: string },
  ): void => {
    stepLog.steps.push({
      startedAt: step.startedAt ?? new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      ...step,
    })
  }
  // History annotation is best-effort: a failed write must never mask the
  // result of the rate change itself.
  const persistStepLog = async (rateRowId: string): Promise<void> => {
    if (!db) return
    try {
      await db.update(schema.silverRates).set({ stepLog }).where(eq(schema.silverRates.id, rateRowId))
    } catch { /* best-effort */ }
  }

  if (options?.syncFirst) {
    const syncStartedAt = new Date().toISOString()
    // A throw here used to escape applySilverRate, leaving progress running
    // forever — report it exactly like a sync that returned ok:false.
    const syncFailed = (message: string): SilverUpdateResult => {
      setSilverRateProgress({ running: false, phase: 'done', label: 'Product sync failed before repricing', error: message })
      return {
        ok: false,
        rate,
        previousRate,
        affected: 0,
        matched: 0,
        updated: 0,
        skipped: 0,
        errors: [`Product sync failed before silver rate update: ${message}`],
        message: 'Product sync failed before silver rate update',
      }
    }
    let synced: ProductsDbSyncResult
    try {
      synced = await syncProductsToDb()
    } catch (err) {
      return syncFailed(err instanceof Error ? err.message : 'Product sync failed')
    }
    if (!synced.ok) return syncFailed(synced.errors.join('; '))
    recordStep({
      key: 'sync',
      label: 'Sync catalog from Shopify',
      status: 'done',
      startedAt: syncStartedAt,
      detail: `${synced.synced} synced (${synced.created} created, ${synced.updated} updated, ${synced.removed} removed)`,
    })
  }

  if (!db) {
    setSilverRateProgress({ running: false, phase: 'done', label: 'Database is not configured', error: 'Database is not configured' })
    return { ok: false, rate, previousRate, affected: 0, matched: 0, updated: 0, skipped: 0, errors: [], message: 'Database is not configured' }
  }

  const change = round2(rate - previousRate)
  const changePercent = previousRate > 0 ? round2((change / previousRate) * 100) : 0
  const now = new Date().toISOString()
  // Who/what applied the change (for the history table + audit trail).
  const actorName = options?.actorName?.trim() || 'Admin'
  const source = options?.source ?? 'manual'

  // The row id is captured so the step log and sync status land on THIS run's
  // row — the old code re-queried "the latest row", which races a second apply.
  const rateRowId = randomUUID()
  const rateStartedAt = new Date().toISOString()
  try {
    await db.insert(schema.silverRates).values({
      id: rateRowId,
      purity: 92.5,
      rate,
      previousRate,
      updatedAt: now,
      change,
      changePercent,
      currency: 'INR',
      updatedBy: actorName,
      source,
      approvedBy: source === 'approval' ? actorName : null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save silver rate'
    setSilverRateProgress({ running: false, phase: 'done', label: 'Failed to save the new rate', error: message })
    return { ok: false, rate, previousRate, affected: 0, matched: 0, updated: 0, skipped: 0, errors: [err instanceof Error ? err.message : 'Failed to save silver rate'] }
  }

  // Step 1 of the run: the rate row itself. The pre-reprice price snapshot and
  // the reprice loop live in the try below (chandru1's step reporting), so
  // master's separately-hoisted snapshot is deliberately NOT duplicated here —
  // two snapshot loops would write two history rows per product.
  const rateDetail = `₹${previousRate.toFixed(2)} → ₹${rate.toFixed(2)}/gm`
  const steps: NonNullable<SilverUpdateResult['steps']> = [
    { key: 'rate', label: 'Save new rate', status: 'done', detail: rateDetail },
  ]
  recordStep({ key: 'rate', label: 'Save new rate', status: 'done', startedAt: rateStartedAt, detail: rateDetail })

  const repriceStartedAt = new Date().toISOString()
  let recomputed = 0
  try {
    const rows = await db
      .select({ id: schema.products.id, netWeight: schema.products.netWeight, makingCharge: schema.products.makingCharge, sellingPrice: schema.products.sellingPrice, pieceRateProduct: schema.products.pieceRateProduct })
      .from(schema.products)

    const snapshotAt = previous?.updatedAt ?? now
    for (const row of rows) {
      if (row.sellingPrice == null) continue
      try {
        await db.insert(schema.productPriceHistory).values({
          id: randomUUID(),
          productId: row.id,
          sellingPrice: Number(row.sellingPrice),
          recordedAt: snapshotAt,
        })
      } catch { /* history must not block a rate change */ }
    }

    setSilverRateProgress({ phase: 'repricing', label: `Repricing ${rows.length} product(s) from the new rate`, done: 0, total: rows.length })
    for (const row of rows) {
      // Piece Rate Products carry a fixed price per piece — a silver-rate change
      // must never recompute (and thereby overwrite) their selling price.
      if (row.pieceRateProduct) continue
      const netWeight = Number(row.netWeight)
      const makingCharge = Number(row.makingCharge)
      if (!netWeight || netWeight <= 0) continue
      const sellingPrice = computeSellingPrice(rate, netWeight, makingCharge)
      await db.update(schema.products).set({ sellingPrice, silverRate: rate }).where(eq(schema.products.id, row.id))
      try {
        await db.insert(schema.productPriceHistory).values({
          id: randomUUID(),
          productId: row.id,
          sellingPrice,
          recordedAt: now,
        })
      } catch { /* history must not block a rate change */ }
      recomputed++
      setSilverRateProgress({ done: recomputed })
    }
  } catch (err) {
    // The rate row exists but the catalogue is only partly repriced: name the
    // step that failed, stop (never continue to the Shopify steps) and release
    // the progress flag — it used to stay running forever and spin the UI.
    const message = err instanceof Error ? err.message : 'Failed to reprice products'
    const detail = `${recomputed} product(s) updated before the failure`
    steps.push({ key: 'reprice', label: 'Reprice products', status: 'failed', detail })
    recordStep({ key: 'reprice', label: 'Reprice products', status: 'failed', startedAt: repriceStartedAt, detail, error: message })
    stepLog.finishedAt = new Date().toISOString()
    stepLog.ok = false
    stepLog.counts.repriced = recomputed
    await persistStepLog(rateRowId)
    setSilverRateProgress({ running: false, phase: 'done', label: 'Repricing failed', error: message })
    return { ok: false, rate, previousRate, affected: recomputed, matched: 0, updated: 0, skipped: 0, errors: [message], steps }
  }

  const repriceDetail = `${recomputed} product(s) recomputed from the new rate`
  steps.push({ key: 'reprice', label: 'Reprice products', status: 'done', detail: repriceDetail })
  recordStep({ key: 'reprice', label: 'Reprice products', status: 'done', startedAt: repriceStartedAt, detail: repriceDetail })

  // The audit trail must never block (or look like a hang on) a rate change.
  try {
    await recordAudit({
      timestamp: now,
      user: actorName,
      action: `Silver rate updated to ₹${rate.toFixed(2)}/gm`,
      module: 'Silver',
      entity: 'silver_rates',
      changes: `previous=${previousRate}, rate=${rate}, source=${source}`,
      ip: null,
    })
  } catch { /* audit is best-effort */ }

  let matched = 0
  let updated = 0
  let skipped = 0
  const errors: string[] = []

  if (isConfigured()) {
    const matchStartedAt = new Date().toISOString()
    try {
      setSilverRateProgress({ phase: 'matching', label: 'Matching local products to the Shopify catalog', done: 0, total: 0 })
      await syncPrices()
      const pending = store.price.filter((p) => p.status === 'update')
      const unmatched = store.price.filter((p) => p.status === 'no-match').length
      matched = store.price.filter((p) => p.status !== 'no-match').length
      const matchDetail = `${matched} matched, ${unmatched} without a Shopify match`
      steps.push({ key: 'match', label: 'Match products to Shopify', status: 'done', detail: matchDetail })
      recordStep({ key: 'match', label: 'Match products to Shopify', status: 'done', startedAt: matchStartedAt, detail: matchDetail })
      if (pending.length > 0) {
        const pushStartedAt = new Date().toISOString()
        setSilverRateProgress({ phase: 'pushing', label: 'Pushing the new prices to Shopify', done: 0, total: pending.length })
        const result = await applyPriceSync((done) => setSilverRateProgress({ done }))
        updated = result.updated ?? 0
        skipped = result.skipped ?? 0
        errors.push(...(result.errors ?? []))
        const pushDetail = `${updated} pushed, ${skipped} skipped${errors.length ? `, ${errors.length} error(s)` : ''}`
        steps.push({
          key: 'push',
          label: 'Push prices to Shopify',
          status: errors.length === 0 ? 'done' : 'failed',
          detail: pushDetail,
        })
        recordStep({
          key: 'push',
          label: 'Push prices to Shopify',
          status: errors.length === 0 ? 'done' : 'failed',
          startedAt: pushStartedAt,
          detail: pushDetail,
          ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
        })
      } else {
        const pushDetail = 'All Shopify prices already match the new rate'
        steps.push({ key: 'push', label: 'Push prices to Shopify', status: 'skipped', detail: pushDetail })
        recordStep({ key: 'push', label: 'Push prices to Shopify', status: 'skipped', detail: pushDetail })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      store.lastError = message
      errors.push(message)
      // The try block spans matching + pushing: blame the step that actually
      // failed instead of always reporting the push.
      const failedKey = steps.some((s) => s.key === 'match') ? 'push' : 'match'
      const failedLabel = failedKey === 'match' ? 'Match products to Shopify' : 'Push prices to Shopify'
      steps.push({ key: failedKey, label: failedLabel, status: 'failed', detail: message })
      recordStep({ key: failedKey, label: failedLabel, status: 'failed', startedAt: matchStartedAt, detail: message, error: message })
      await persistLog({ entity: 'Price', direction: 'out', action: 'Silver Rate Update', status: 'failed', error: message, retry: true })
    }
  } else {
    const pushDetail = 'Shopify is not configured — prices updated locally only'
    steps.push({ key: 'push', label: 'Push prices to Shopify', status: 'skipped', detail: pushDetail })
    recordStep({ key: 'push', label: 'Push prices to Shopify', status: 'skipped', detail: pushDetail })
    await persistLog({ entity: 'Silver', direction: 'in', action: 'Rate Update (Shopify not configured)', status: 'success' })
  }

  // Record the Shopify push outcome AND the full step log on this run's rate
  // row for the history table (best-effort, never masks the result).
  const syncStatus = !isConfigured() ? 'skipped' : errors.length === 0 ? 'synced' : 'failed'
  stepLog.finishedAt = new Date().toISOString()
  stepLog.ok = errors.length === 0
  stepLog.counts = { repriced: recomputed, matched, pushed: updated, skipped }
  setSilverRateProgress({
    running: false,
    phase: 'done',
    label: errors.length === 0
      ? `Rate applied — ${recomputed} repriced, ${updated} pushed to Shopify`
      : `Finished with ${errors.length} error(s)`,
    error: errors.length > 0 ? errors[0] ?? null : null,
  })
  if (db) {
    try {
      await db.update(schema.silverRates).set({ syncStatus, stepLog }).where(eq(schema.silverRates.id, rateRowId))
    } catch {
      // History annotation is best-effort.
    }
  }

  return {
    ok: errors.length === 0,
    rate,
    previousRate,
    affected: recomputed,
    matched,
    updated,
    skipped,
    errors,
    steps,
  }
}

export interface DraftOrderLineInput {
  title: string
  quantity: number
  price: number | null
  sku?: string
  /** Shopify ProductVariant id (numeric or gid:// form) when the line was billed against a specific variant. */
  variantId?: string | number
}

/**
 * Stored/local order lines → DraftOrderLineInput[]. ERP `sales_orders.line_items`
 * prices are PER-UNIT and GST-inclusive, which is exactly what a draft line's
 * `originalUnitPrice` is:
 *
 *   Shopify line total = originalUnitPrice × quantity
 *
 * Feeding it a full line's GST-inclusive total (amount × 1.03) instead made
 * Shopify bill that total PER UNIT, so a manual order with a qty-3 line was
 * created on Shopify at ~3× its real value.
 */
export function draftOrderInputLines(
  lines: ReadonlyArray<unknown> | null | undefined,
): DraftOrderLineInput[] {
  if (!Array.isArray(lines)) return []
  return lines
    .map((raw): DraftOrderLineInput | null => {
      const li = (raw ?? null) as Record<string, unknown> | null
      if (!li) return null
      const title = String(li.title ?? '').trim()
      const quantity = Math.max(0, Math.floor(Number(li.quantity ?? 0)))
      if (!title || quantity <= 0) return null
      const price = Number(li.price)
      return {
        title,
        quantity,
        price: Number.isFinite(price) ? Math.round(price * 100) / 100 : null,
        ...(li.sku != null && String(li.sku).trim() !== '' ? { sku: String(li.sku).trim() } : {}),
        ...(li.variantId != null && String(li.variantId).trim() !== ''
          ? { variantId: li.variantId as string | number }
          : {}),
      }
    })
    .filter((li): li is DraftOrderLineInput => li !== null)
}

/** Shopify's GraphQL API wants variant ids in gid form. */
export function toShopifyVariantGid(variantId: string | number): string {
  const s = String(variantId).trim()
  return s.startsWith('gid://') ? s : `gid://shopify/ProductVariant/${s}`
}

/**
 * Draft-order line mapping, kept pure so the variant plumbing is testable:
 * a line with a variantId targets that exact Shopify variant (so multi-variant
 * products sync the right SKU/price), while flat lines keep the historic
 * title/sku/price shape.
 */
export function buildDraftOrderLineItems(lineItems: DraftOrderLineInput[]): Array<Record<string, unknown>> {
  return (lineItems ?? [])
    .filter((li) => li.title && li.quantity > 0)
    .map((li) => ({
      ...(li.variantId != null && String(li.variantId).trim() !== ''
        ? { variantId: toShopifyVariantGid(li.variantId) }
        : {}),
      title: li.title,
      quantity: li.quantity,
      sku: li.sku || undefined,
      originalUnitPrice:
        li.price != null && Number.isFinite(li.price) && li.price >= 0 ? li.price.toFixed(2) : '0.00',
    }))
}

export interface DraftOrderAddressInput {
  name?: string
  phone?: string
  address1?: string
  address2?: string
  city?: string
  province?: string
  zip?: string
  country?: string
}

export interface DraftOrderPayload {
  customerName?: string
  customerEmail?: string
  customerPhone?: string
  payment?: string
  billingAddress?: DraftOrderAddressInput
  shippingAddress?: DraftOrderAddressInput
  note?: string
  tags?: string
  lineItems: DraftOrderLineInput[]
}

interface ResolveCustomerInput {
  name?: string
  email?: string
  phone?: string
  billingAddress?: Record<string, unknown>
}

async function findShopifyCustomerId(query: string): Promise<string | undefined> {
  try {
    const url = `https://${config.shop}.myshopify.com/admin/api/${config.apiVersion}/customers/search.json?limit=5&query=${encodeURIComponent(query)}`
    const res = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': config.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    })
    if (!res.ok) return undefined
    const json = (await res.json().catch(() => null)) as { customers?: Array<{ id?: number | string }> } | null
    const id = json?.customers?.[0]?.id
    return id != null ? String(id) : undefined
  } catch {
    return undefined
  }
}

async function createShopifyCustomer(input: ResolveCustomerInput): Promise<string | undefined> {
  const nameParts = (input.name ?? '').split(/\s+/).filter(Boolean)
  const first = nameParts.shift()
  const customer: Record<string, unknown> = {
    ...(first ? { first_name: first } : {}),
    ...(nameParts.length ? { last_name: nameParts.join(' ') } : {}),
  }
  if (input.email) customer.email = input.email
  if (input.phone) customer.phone = input.phone
  const a = input.billingAddress
  if (a && Object.keys(a).length) {
    customer.addresses = [
      {
        ...(typeof a.firstName === 'string' ? { first_name: a.firstName } : {}),
        ...(typeof a.lastName === 'string' ? { last_name: a.lastName } : {}),
        ...(typeof a.phone === 'string' ? { phone: a.phone } : {}),
        ...(typeof a.address1 === 'string' ? { address1: a.address1 } : {}),
        ...(typeof a.address2 === 'string' ? { address2: a.address2 } : {}),
        ...(typeof a.city === 'string' ? { city: a.city } : {}),
        ...(typeof a.province === 'string' ? { province: a.province } : {}),
        ...(typeof a.zip === 'string' ? { zip: a.zip } : {}),
        ...(typeof a.country === 'string' ? { country: a.country } : {}),
        default: true,
      },
    ]
  }
  try {
    const url = `https://${config.shop}.myshopify.com/admin/api/${config.apiVersion}/customers.json`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': config.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ customer }),
    })
    if (!res.ok) return undefined
    const json = (await res.json().catch(() => null)) as { customer?: { id?: number | string } } | null
    return json?.customer?.id != null ? String(json.customer.id) : undefined
  } catch {
    return undefined
  }
}

async function resolveShopifyCustomerId(input: ResolveCustomerInput): Promise<string | undefined> {
  const queries: string[] = []
  if (input.email) queries.push(`email:${input.email}`)
  if (input.phone) queries.push(`phone:${input.phone}`)
  // Return the BARE numeric id — callers wrap it in gid:// form only where the
  // GraphQL API requires it. Persisting the gid form ("gid://shopify/Customer/…")
  // into customers.shopify_id broke every bare-id match and created duplicates.
  for (const q of queries) {
    const found = await findShopifyCustomerId(q)
    if (found) return found
  }
  if (input.email || input.phone || input.name) {
    const created = await createShopifyCustomer(input)
    if (created) return created
  }
  return undefined
}

function toMailingAddress(address?: DraftOrderAddressInput): Record<string, unknown> | undefined {
  if (!address) return undefined
  const name = (address.name ?? '').trim()
  const nameParts = name.split(/\s+/).filter(Boolean)
  const first = nameParts.shift()
  return {
    ...(first ? { firstName: first } : {}),
    ...(nameParts.length ? { lastName: nameParts.join(' ') } : {}),
    ...(address.phone ? { phone: address.phone } : {}),
    ...(address.address1 ? { address1: address.address1 } : {}),
    ...(address.address2 ? { address2: address.address2 } : {}),
    ...(address.city ? { city: address.city } : {}),
    ...(address.province ? { province: address.province } : {}),
    ...(address.zip ? { zip: address.zip } : {}),
    ...(address.country ? { country: address.country } : {}),
  }
}

export interface DraftOrderResult {
  ok: boolean
  draftId?: string
  name?: string
  completed?: boolean
  customerId?: string
  errors: string[]
  message?: string
}

export async function createShopifyDraftOrder(payload: DraftOrderPayload): Promise<DraftOrderResult> {
  if (!isConfigured()) {
    return {
      ok: false,
      errors: ['Shopify is not configured. Set SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN in server/.env'],
      message: 'Shopify is not configured',
    }
  }

  const lineItems = buildDraftOrderLineItems(payload.lineItems ?? [])

  if (lineItems.length === 0) {
    return { ok: false, errors: ['At least one line item with a quantity is required'] }
  }

  const input: Record<string, unknown> = {
    lineItems,
    note: payload.note || undefined,
    tags: payload.tags || undefined,
  }
  if (payload.customerEmail) input.email = payload.customerEmail
  const billingAddress = toMailingAddress(payload.billingAddress)
  const shippingAddress = toMailingAddress(payload.shippingAddress)
  if (billingAddress) input.billingAddress = billingAddress
  if (shippingAddress) input.shippingAddress = shippingAddress

  const customerId = await resolveShopifyCustomerId({
    name: payload.customerName,
    email: payload.customerEmail,
    phone: payload.customerPhone,
    billingAddress,
  })
  if (customerId) {
    // DraftOrderInput.customerId is a GraphQL ID: it needs the gid form.
    input.customerId = `gid://shopify/Customer/${customerId}`
  }

  const url = `https://${config.shop}.myshopify.com/admin/api/${config.apiVersion}/graphql.json`
  const query = `mutation draftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name }
      userErrors { field message }
    }
  }`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': config.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables: { input } }),
    })
    const resText = await res.text()
    let json: {
      data?: {
        draftOrderCreate?: {
          draftOrder?: { id?: string; name?: string }
          userErrors?: Array<{ field?: string[]; message?: string }>
        }
      }
      errors?: Array<{ message?: string }>
      extensions?: { userErrors?: Array<{ code?: string; message?: string }> }
    } | null = null
    try {
      json = JSON.parse(resText)
    } catch {
      // Non-JSON response (e.g. gateway/HTML error page).
    }

    if (!res.ok) {
      const text = json?.errors?.map((e) => e.message).join(' ') || `Shopify API error ${res.status}`
      await persistLog({ entity: 'Order', direction: 'out', action: 'Draft Order Create', status: 'failed', error: text })
      return { ok: false, errors: [text], message: withScopeFixHint(text) }
    }

    const result = json?.data?.draftOrderCreate
    if (!result?.draftOrder?.id) {
      const msg =
        result?.userErrors?.map((u) => (u.field ? `${u.field.join('.')}: ${u.message}` : u.message)).join(' ') ||
        json?.extensions?.userErrors?.map((u) => (u.code ? `${u.code}: ${u.message}` : u.message)).join(' ') ||
        json?.errors?.map((e) => e.message).join(' ') ||
        (resText && resText.trim() ? resText.slice(0, 500) : 'Shopify returned an unexpected response')
      await persistLog({ entity: 'Order', direction: 'out', action: 'Draft Order Create', status: 'failed', error: msg })
      return { ok: false, errors: [msg], message: withScopeFixHint(msg) }
    }

    const draftId = result.draftOrder.id
    let completed = false
    let name = result.draftOrder.name ?? undefined
    let completionError: string | null = null

    try {
      const completeRes = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': config.accessToken,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          query: `mutation draftOrderComplete($id: ID!, $paymentPending: Boolean!) {
            draftOrderComplete(id: $id, paymentPending: $paymentPending) {
              draftOrder { id status name order { id name } }
              userErrors { field message }
            }
          }`,
          variables: { id: draftId, paymentPending: payload.payment !== 'paid' },
        }),
      })
      const completeJson = (await completeRes.json().catch(() => null)) as
        | {
            data?: {
              draftOrderComplete?: {
                draftOrder?: { status?: string; name?: string; order?: { id?: string; name?: string } }
                userErrors?: Array<{ field?: string[]; message?: string }>
              }
            }
            errors?: Array<{ message?: string }>
          }
        | null
      const completeResult = completeJson?.data?.draftOrderComplete
      const completedOrder = completeResult?.draftOrder?.order
      if (completedOrder?.id || completedOrder?.name) {
        completed = true
        name = completedOrder.name ?? completeResult?.draftOrder?.name ?? name
      } else if (!completeRes.ok || completeResult?.userErrors?.length || completeJson?.errors?.length) {
        const msg =
          completeResult?.userErrors?.map((u) => (u.field ? `${u.field.join('.')}: ${u.message}` : u.message)).join(' ') ||
          completeJson?.errors?.map((e) => e.message).join(' ') ||
          `Shopify API error ${completeRes.status}`
        completionError = msg
        await persistLog({
          entity: 'Order',
          shopifyId: name ?? draftId,
          direction: 'out',
          action: 'Draft Order Complete',
          status: 'failed',
          error: msg,
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Draft order could not be completed'
      completionError = msg
      await persistLog({
        entity: 'Order',
        shopifyId: name ?? draftId,
        direction: 'out',
        action: 'Draft Order Complete',
        status: 'failed',
        error: msg,
      })
    }

    if (completionError) {
      return {
        ok: false,
        draftId,
        name,
        completed: false,
        errors: [completionError],
        message: `Draft order was created but could not be completed on Shopify: ${completionError}`,
      }
    }

    await persistLog({
      entity: 'Order',
      shopifyId: name ?? draftId,
      direction: 'out',
      action: completed ? 'Order Created' : 'Draft Order Created',
      status: 'success',
    })
    return { ok: true, draftId, name, completed, customerId: customerId || undefined, errors: [] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { ok: false, errors: [msg], message: 'Shopify draft order creation failed' }
  }
}

export interface ShopifyOrderUpdateInput {
  orderName?: string
  email?: string
  note?: string
  tags?: string
  shippingAddress?: DraftOrderAddressInput
}

export interface ShopifyOrderUpdateResult {
  ok: boolean
  errors: string[]
  message?: string
}

async function findShopifyOrderIdByName(name: string): Promise<string | undefined> {
  const url = `https://${config.shop}.myshopify.com/admin/api/${config.apiVersion}/graphql.json`
  const headers = {
    'X-Shopify-Access-Token': config.accessToken,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: `query($q: String!) { orders(first: 2, query: $q) { edges { node { id } } } }`,
          variables: { q: `name:${name.replace(/['"\\]/g, '')}` },
        }),
      })
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as {
          data?: { orders?: { edges?: Array<{ node?: { id?: string } }> } }
        } | null
        const gid = json?.data?.orders?.edges?.[0]?.node?.id
        if (gid) return gid
      }
    } catch {
      // transient failure — retry
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return undefined
}

export async function updateShopifyOrder(payload: ShopifyOrderUpdateInput): Promise<ShopifyOrderUpdateResult> {
  if (!isConfigured()) {
    return { ok: false, errors: ['Shopify is not configured. Set SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN in server/.env'], message: 'Shopify is not configured' }
  }
  const orderName = payload.orderName?.trim()
  if (!orderName) return { ok: true, errors: [] }

  try {
    const gid = await findShopifyOrderIdByName(orderName)
    if (!gid) {
      return { ok: false, errors: [`Order ${orderName} was not found on Shopify`], message: `Order ${orderName} was not found on Shopify` }
    }

    const input: Record<string, unknown> = { id: gid }
    if (payload.note != null) input.note = payload.note
    if (payload.email) input.email = payload.email
    if (payload.tags) input.tags = payload.tags
    const shippingAddress = toMailingAddress(payload.shippingAddress)
    if (shippingAddress) input.shippingAddress = shippingAddress

    if (Object.keys(input).length <= 1) return { ok: true, errors: [] }

    const url = `https://${config.shop}.myshopify.com/admin/api/${config.apiVersion}/graphql.json`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': config.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query: `mutation orderUpdate($input: OrderInput!) {
          orderUpdate(input: $input) {
            order { id }
            userErrors { field message }
          }
        }`,
        variables: { input },
      }),
    })
    const json = (await res.json().catch(() => null)) as
      | {
          data?: { orderUpdate?: { userErrors?: Array<{ field?: string[]; message?: string }> } }
          errors?: Array<{ message?: string }>
        }
      | null
    const errors =
      json?.data?.orderUpdate?.userErrors
        ?.map((u) => (u.field ? `${u.field.join('.')}: ${u.message}` : u.message))
        .filter((m): m is string => Boolean(m)) ?? []
    const gqlErrors = json?.errors?.map((e) => e.message).filter((m): m is string => Boolean(m)) ?? []
    const all = [...errors, ...gqlErrors]
    const ok = res.ok && all.length === 0
    await persistLog({
      entity: 'Order',
      shopifyId: orderName,
      direction: 'out',
      action: 'Order Update',
      status: ok ? 'success' : 'failed',
      error: ok ? undefined : all.join(' ') || `Shopify API error ${res.status}`,
    })
    const message = ok ? undefined : withScopeFixHint(all.join(' ') || `Shopify API error ${res.status}`)
    return { ok, errors: all, message }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { ok: false, errors: [msg], message: 'Shopify order update failed' }
  }
}

export interface ShopifyOrdersImportResult {
  ok: boolean
  imported: number
  updated: number
  errors: string[]
  message?: string
  /** Present when Shopify redacted customer PII on the REST payloads (plan-gated). */
  piiRedacted?: { count: number; example: string; message: string } | null
}

function mapImportedPayment(status: string | null | undefined): string {
  switch (status) {
    case 'paid':
      return 'paid'
    case 'refunded':
    case 'partially_refunded':
      return 'refunded'
    case 'pending':
      return 'pending'
    default:
      return 'pending'
  }
}

function mapImportedFulfillment(status: string | null | undefined): string {
  switch (status) {
    case 'fulfilled':
      return 'fulfilled'
    case 'partial':
      return 'partial'
    default:
      return 'unfulfilled'
  }
}

function mapImportedStatus(raw: any): string {
  if (raw.cancelled_at || String(raw.financial_status ?? '') === 'voided') return 'cancelled'
  // Map Shopify fulfillment into pipeline stages so the kanban reflects reality
  if (raw.fulfillment_status === 'fulfilled') return 'fulfilled'
  if (raw.fulfillment_status === 'partial') return 'processing'
  if (Array.isArray(raw.fulfillments) && raw.fulfillments.length > 0) return 'processing'
  const closedAt = raw.closed_at ? Date.parse(raw.closed_at) : NaN
  if (Number.isFinite(closedAt)) return 'fulfilled'
  return 'imported'
}

export async function importShopifyOrders(): Promise<ShopifyOrdersImportResult> {
  if (!isConfigured()) {
    return { ok: false, imported: 0, updated: 0, errors: ['Shopify is not configured. Set SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN in server/.env'], message: 'Shopify is not configured' }
  }
  if (!db) {
    return { ok: false, imported: 0, updated: 0, errors: ['Database is not configured. Set DATABASE_URL in server/.env and run npm run db:push && npm run db:seed.'], message: 'Database is not configured' }
  }

  try {
    const raw = await paginate<any>('orders', 'status=any&fulfillment_status=any')
    const existing = await db.select({ shopifyId: schema.salesOrders.shopifyId }).from(schema.salesOrders)
    const knownShopifyIds = new Set(existing.map((r) => r.shopifyId).filter((x): x is string => Boolean(x)))
    // In-batch guard: Shopify can return the same order twice across pages
    // (concurrent edits between page fetches). Without this, the second copy
    // would take the insert path and hit the unique index as an error.
    const seenInBatch = new Set<string>()

    let customerStats = new Map<string, any>()
    try {
      const customers = await paginate<any>('customers', 'limit=250')
      customerStats = new Map(customers.map((c) => [String(c.id), c]))
    } catch {
      // Customer stats are a bonus; the import must never fail because of them.
    }

    let imported = 0
    let updated = 0
    const errors: string[] = []
    // Orders whose auto-invoice failed this run (reported in Sync Logs).
    const invoiceFailures: string[] = []
    // Orders whose customer payload was mass-redacted by Shopify's
    // plan-gated Protected Customer Data (HTTP 200, fields stripped). They
    // import as temporary "Guest" rows — surfaced so the sync explains WHY.
    const redactedOrders: string[] = []

    for (const o of raw) {
      const orderNumber = String(o.name ?? '').replace(/^#/, '')
      const shopifyId = orderNumber ? `#${orderNumber}` : ''
      if (!shopifyId) continue
      // Duplicate within this batch: update once, then skip the rest.
      if (seenInBatch.has(shopifyId)) continue
      seenInBatch.add(shopifyId)

      const customerId = o.customer?.id ? String(o.customer.id) : undefined
      if (orderCustomerPiiRedacted(o)) redactedOrders.push(shopifyId)
      // Shopify order REST API often has minimal customer object {id, email} without first_name/last_name.
      // The actual customer name is on billing_address. Fall back through: customer → billing_address → email → 'Guest'.
      // Some dev stores return literal "undefined" strings — treat those as empty.
      const safeStr = (v: unknown) => (typeof v === 'string' && v !== 'undefined' && v.trim()) ? v.trim() : ''
      const custFirstName = safeStr(o.customer?.first_name) || safeStr(o.billing_address?.first_name) || ''
      const custLastName = safeStr(o.customer?.last_name) || safeStr(o.billing_address?.last_name) || ''
      let customerName = `${custFirstName} ${custLastName}`.trim() || (safeStr(o.customer?.email) || safeStr(o.billing_address?.email) || 'Guest')
      // A raw email is a redaction artifact, not a display name. If Shopify
      // only gave us the email, keep the LOCAL name on updates and re-sync
      // after the Flow webhook / PII repair has recovered the real one.
      const apiNameIsEmail = /^[^\s@]+@[^\s@]+$/.test(customerName)
      const value = Math.round(Number(o.total_price ?? 0) * 100) / 100
      const items = o.line_items?.reduce((sum: number, li: any) => sum + Number(li.quantity ?? 0), 0) ?? 0
      const date = new Date(o.created_at ?? Date.now()).toISOString()
      const payment = mapImportedPayment(o.financial_status)
      const fulfillment = mapImportedFulfillment(o.fulfillment_status)
      const lineItems =
        o.line_items
          ?.map((li: any) => ({
            title: String(li.title ?? '').trim(),
            sku: li.sku ? String(li.sku) : '',
            quantity: Math.max(0, Number(li.quantity ?? 0)),
            price: Math.round(Number(li.price ?? 0) * 100) / 100,
          }))
          .filter((li: { title: string }) => li.title) ?? []
      const tags = String(o.tags ?? '').trim() || null
      const currency = String(o.currency ?? 'INR') || 'INR'
      const discount = Math.round(Number(o.total_discounts ?? 0) * 100) / 100

      const billingAddress = o.billing_address ? (() => {
        // parseOrderAddress keeps region-only redacted stubs (province/country);
        // the old name/address1/city/phone guard threw them away.
        return parseOrderAddress(o.billing_address)
      })() : null
      const shippingAddress = o.shipping_address ? (() => {
        return parseOrderAddress(o.shipping_address)
      })() : null

      if (knownShopifyIds.has(shopifyId)) {
        // Merge against the stored row: locally recovered addresses (repair /
        // webhook) must survive a redacted or partial payload — a whole-address
        // write of null or of a half-redacted object used to blank them out.
        const [cur] = await db
          .select({ billingAddress: schema.salesOrders.billingAddress, shippingAddress: schema.salesOrders.shippingAddress })
          .from(schema.salesOrders)
          .where(eq(schema.salesOrders.shopifyId, shopifyId))
          .limit(1)
        await db
          .update(schema.salesOrders)
          .set({
            ...(!apiNameIsEmail && customerName && customerName !== 'Guest' ? { customer: customerName } : {}),
            ...(customerId ? { customerShopifyId: customerId } : {}),
            value,
            payment,
            fulfillment,
            status: mapImportedStatus(o),
            items,
            tags,
            currency,
            discount,
            lineItems: lineItems.length > 0 ? lineItems : undefined,
            // undefined from mergeAddress = nothing worth writing → drizzle
            // omits the column and the stored address is untouched.
            billingAddress: mergeAddress(cur?.billingAddress as OrderAddress | undefined, billingAddress),
            shippingAddress: mergeAddress(cur?.shippingAddress as OrderAddress | undefined, shippingAddress),
          })
          .where(eq(schema.salesOrders.shopifyId, shopifyId))
        updated++
      } else {
        try {
          await db.transaction(async (tx) => {
            await tx
              .insert(schema.salesOrders)
              .values({
                id: `shopify-${o.id}`,
                shopifyId,
                internalId: `SO-${orderNumber}`,
                customer: customerName || 'Guest',
                customerShopifyId: customerId,
                customerEmail: safeStr(o.customer?.email) || safeStr(o.email) || undefined,
                customerPhone: safeStr(o.phone) || safeStr(o.billing_address?.phone) || undefined,
                value,
                payment,
                fulfillment,
                invoice: null,
                status: mapImportedStatus(o),
                date,
                items,
                tags,
                currency,
                discount,
                lineItems: lineItems.length > 0 ? lineItems : null,
                billingAddress: billingAddress ?? undefined,
                shippingAddress: shippingAddress ?? undefined,
              })
              .onConflictDoNothing()

            for (const li of lineItems) {
              const sku = String(li.sku ?? '').trim()
              const qty = Math.max(0, Math.floor(Number(li.quantity ?? 0)))
              if (!sku || qty <= 0) continue
              const [product] = await tx.select({ stock: schema.products.stock }).from(schema.products).where(eq(schema.products.sku, sku)).limit(1).for('update')
              if (!product) continue
              const current = Number(product.stock ?? 0)
              if (current - qty < 0) continue
              await tx.update(schema.products).set({ stock: sql`${schema.products.stock} - ${qty}` }).where(eq(schema.products.sku, sku))
            }
          })
          knownShopifyIds.add(shopifyId)
          imported++
        } catch (err) {
          errors.push(err instanceof Error ? err.message : 'Failed to import an order')
          continue
        }
      }

      if (customerId) {
        try {
          const cust = customerStats.get(customerId)
          const verifiedEmail =
            cust?.verified_email != null ? Boolean(cust.verified_email) : o.customer?.verified_email != null ? Boolean(o.customer.verified_email) : null
          const province = cust?.default_address?.province ?? cust?.addresses?.[0]?.province ?? null
          const city = cust?.default_address?.city ?? null
          const ordersCount = cust ? Number(cust.orders_count ?? 0) : null
          const totalSpent = cust ? Math.round(Number(cust.total_spent ?? value) * 100) / 100 : value
          const joined = cust?.created_at ? new Date(cust.created_at).toISOString().slice(0, 10) : date.slice(0, 10)
          // Prefer full customer object name > order billing_address name > email > fallback
          const custFullName = cust ? `${cust.first_name ?? ''} ${cust.last_name ?? ''}`.trim() : ''
          const label = custFullName || customerName || `Shopify Customer #${customerId}`
          // Also upgrade the order's customer field if we got a better name from the customer stats
          if (custFullName && custFullName !== customerName) {
            customerName = custFullName
          }
          const customerEmail = o.customer?.email ?? cust?.email ?? null
          const customerPhone = o.customer?.phone ?? cust?.phone ?? null

          // Match the local customer by Shopify id FIRST — two distinct
          // Shopify identities can share an email inbox (or a phone), and
          // email-first matching would merge their stats into one row.
          // Email/phone then fall back through case/format-normalized lookups
          // ("Foo@Bar.COM" vs "foo@bar.com", "+91 98.." vs "98..") so a
          // re-sync finds its row instead of creating a duplicate customer.
          let existingCustomer: typeof schema.customers.$inferSelect | null = null
          {
            const [byShopifyId] = await db
              .select()
              .from(schema.customers)
              .where(eq(schema.customers.shopifyId, customerId))
              .limit(1)
            if (byShopifyId) existingCustomer = byShopifyId
          }
          const emailLc = normalizeEmail(customerEmail)
          if (!existingCustomer && emailLc) {
            const [byEmail] = await db
              .select()
              .from(schema.customers)
              .where(sql`lower(coalesce(${schema.customers.email}, '')) = ${emailLc}`)
              .limit(1)
            if (byEmail) existingCustomer = byEmail
          }
          const phoneDigits = normalizePhone(customerPhone)
          if (!existingCustomer && phoneDigits) {
            const [byPhone] = await db
              .select()
              .from(schema.customers)
              .where(sql`regexp_replace(coalesce(${schema.customers.phone}, ''), '[^0-9]', '', 'g') = ${phoneDigits}`)
              .limit(1)
            if (byPhone) existingCustomer = byPhone
          }

          if (existingCustomer) {
            await db
              .update(schema.customers)
              .set({
                // A real Shopify name replaces a placeholder ("Shopify
                // Customer #<id>"), a Guest stand-in or an email; a
                // placeholder/blank/email never clobbers a real name.
                name: upgradeName(existingCustomer.name, label),
                // Redaction-safe: null, "" or redacted Shopify values keep the
                // stored data instead of blanking it out.
                email: fillOrKeep(existingCustomer.email, customerEmail ?? null),
                phone: fillOrKeep(existingCustomer.phone, customerPhone ?? null),
                province: fillOrKeep(existingCustomer.province, province ?? null),
                city: fillOrKeep(existingCustomer.city, city ?? null),
                emailVerified: verifiedEmail ?? existingCustomer.emailVerified,
                shopifyId: existingCustomer.shopifyId ?? customerId,
                // Platform-reported stats are authoritative — never accumulate on top of them.
                ...(ordersCount != null ? { orders: ordersCount } : {}),
                ...(cust?.total_spent != null ? { totalSpent: Math.round(Number(cust.total_spent) * 100) / 100 } : {}),
                status: existingCustomer.status ?? 'active',
              })
              .where(eq(schema.customers.id, existingCustomer.id))
          } else {
            await db
              .insert(schema.customers)
              .values({
                id: `C-shop-${customerId}`,
                name: label,
                email: customerEmail,
                phone: customerPhone,
                city: city ?? null,
                province: province ?? null,
                shopifyId: customerId,
                emailVerified: verifiedEmail,
                orders: ordersCount ?? 0,
                totalSpent,
                status: 'active',
                joined,
              })
              .onConflictDoNothing()
          }
        } catch {
          // Customer upsert must never break the order import.
        }
      }

      // Raise a tax invoice for paid orders so the dashboard's invoice-derived
      // widgets (sales, invoices, top products/category, payment status) have
      // data. Refunded and cancelled orders are skipped entirely, so a voided
      // order never becomes revenue. This is idempotent: an order that already
      // carries an invoice number is left alone, so re-syncing backfills the
      // existing paid orders exactly once. The import already moved stock on
      // insert, so the invoice must not move it again.
      if (payment === 'paid' && mapImportedStatus(o) !== 'cancelled') {
        try {
          const [orderRow] = await db
            .select()
            .from(schema.salesOrders)
            .where(eq(schema.salesOrders.shopifyId, shopifyId))
            .limit(1)
          if (orderRow && !orderRow.invoice) {
            const { createInvoiceForOrderRow } = await import('./orderEmailIngest')
            await createInvoiceForOrderRow(orderRow, { deductStock: false })
          }
        } catch (err) {
          // The import itself succeeded — record the failure in Sync Logs
          // instead of raising, so a missed invoice is visible and retryable
          // rather than silently absent from the dashboard.
          const msg = err instanceof Error ? err.message : String(err)
          invoiceFailures.push(`${shopifyId}: ${msg}`)
          logger.warn({ shopifyId, err: msg }, 'Shopify order import: auto-invoice failed')
        }
      }
    }

    // Surface auto-invoice failures in Sync Logs (System → Shopify → Sync
    // Logs). The orders themselves imported fine, so this is a per-order
    // warning, not a failed sync.
    if (invoiceFailures.length > 0) {
      await persistLog({
        entity: 'Invoice',
        direction: 'out',
        action: 'Auto-Invoice',
        status: 'failed',
        error: `${invoiceFailures.length} order(s) not invoiced: ${invoiceFailures.slice(0, 5).join('; ')}`,
        retry: true,
      })
    }

    let piiRedacted: ShopifyOrdersImportResult['piiRedacted'] = null
    if (redactedOrders.length > 0) {
      piiRedacted = {
        count: redactedOrders.length,
        example: redactedOrders[0],
        message:
          `Shopify stripped customer name/email/phone/addresses from ${redactedOrders.length} order(s) ` +
          '(plan-gated Protected Customer Data — e.g. ' + redactedOrders.slice(0, 3).join(', ') + '). ' +
          'They import as "Guest" until access is approved in the Shopify admin ' +
          '(Settings → Apps and sales channels → app → Protected customer data) or recovered via the customers CSV export / order-confirmation emails.',
      }
      await persistLog({
        entity: 'Customer',
        direction: 'in',
        action: 'Customer PII Redacted',
        status: 'failed',
        error: `${redactedOrders.length} order(s) arrived with customer details stripped by Shopify's plan-gated Protected Customer Data (${redactedOrders.slice(0, 5).join(', ')}). Approve access in the Shopify admin or recover via the customers CSV export / email ingestion.`,
        retry: true,
      })
    }

    await persistLog({
      entity: 'Order',
      direction: 'in',
      action: 'Orders Synced',
      status: 'success',
    })
    return { ok: true, imported, updated, errors, piiRedacted }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    await persistLog({ entity: 'Order', direction: 'in', action: 'Orders Synced', status: 'failed', error: msg })
    return { ok: false, imported: 0, updated: 0, errors: [msg], message: 'Shopify order sync failed' }
  }
}

export interface ShopifyCustomersImportResult {
  ok: boolean
  imported: number
  updated: number
  errors: string[]
  message?: string
}

export async function importShopifyCustomers(): Promise<ShopifyCustomersImportResult> {
  if (!isConfigured()) {
    return { ok: false, imported: 0, updated: 0, errors: ['Shopify is not configured'], message: 'Shopify is not configured' }
  }
  if (!db) {
    return { ok: false, imported: 0, updated: 0, errors: ['Database is not configured'], message: 'Database is not configured' }
  }

  try {
    const raw = await paginate<any>('customers', 'limit=250')
    const existing = await db.select().from(schema.customers)
    const knownByShopifyId = new Map(existing.filter((r) => r.shopifyId).map((r) => [r.shopifyId!, r]))
    const knownByEmail = new Map(existing.filter((r) => r.email).map((r) => [r.email!, r]))
    const knownByPhone = new Map(existing.filter((r) => r.phone).map((r) => [r.phone!, r]))
    // Normalized fallbacks — a case/format difference ("Foo@BAR.com",
    // "+91 98.." vs "98..") must find the same row, not create a duplicate.
    const knownByEmailLc = new Map<string, (typeof existing)[number]>()
    const knownByPhoneDigits = new Map<string, (typeof existing)[number]>()
    for (const r of existing) {
      const eK = normalizeEmail(r.email)
      if (eK && !knownByEmailLc.has(eK)) knownByEmailLc.set(eK, r)
      const pK = normalizePhone(r.phone)
      if (pK && !knownByPhoneDigits.has(pK)) knownByPhoneDigits.set(pK, r)
    }

    let imported = 0
    let updated = 0
    const errors: string[] = []

    for (const c of raw) {
      const shopifyId = String(c.id ?? '')
      const firstName = String(c.first_name ?? '').trim()
      const lastName = String(c.last_name ?? '').trim()
      const name = `${firstName} ${lastName}`.trim() || `Shopify Customer #${shopifyId}`
      const email = c.email ?? null
      const phone = c.phone ?? null
      const city = c.default_address?.city ?? c.addresses?.[0]?.city ?? null
      const province = c.default_address?.province ?? c.addresses?.[0]?.province ?? null
      const ordersCount = Number(c.orders_count ?? 0)
      const totalSpent = Math.round(Number(c.total_spent ?? 0) * 100) / 100
      const joined = c.created_at ? new Date(c.created_at).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
      const verifiedEmail = c.verified_email != null ? Boolean(c.verified_email) : null

      // Match existing customer by shopifyId, email, or phone (+ normalized
      // fallbacks for case/format differences).
      let existingCustomer = knownByShopifyId.get(shopifyId)
      if (!existingCustomer && email) existingCustomer = knownByEmail.get(email) ?? (knownByEmailLc.get(normalizeEmail(email) ?? '') ?? undefined)
      if (!existingCustomer && phone) existingCustomer = knownByPhone.get(phone) ?? (knownByPhoneDigits.get(normalizePhone(phone) ?? '') ?? undefined)

      try {
        if (existingCustomer) {
          // The real name replaces a placeholder / blankish name; a real
          // local name is never downgraded to the placeholder.
          const realName = firstName && lastName ? name : null
          await db
            .update(schema.customers)
            .set({
              name: upgradeName(existingCustomer.name, realName),
              // A redacted (null/\"\") API value keeps the stored PII.
              email: fillOrKeep(existingCustomer.email, email ?? null),
              phone: fillOrKeep(existingCustomer.phone, phone ?? null),
              city: usableText(city ?? null) ?? undefined,
              province: usableText(province ?? null) ?? undefined,
              shopifyId: existingCustomer.shopifyId ?? shopifyId,
              emailVerified: verifiedEmail ?? undefined,
              orders: ordersCount,
              totalSpent,
              status: existingCustomer.status ?? 'active',
            })
            .where(eq(schema.customers.id, existingCustomer.id))
          updated++
        } else {
          await db
            .insert(schema.customers)
            .values({
              id: `C-shop-${shopifyId}`,
              name,
              email,
              phone,
              city: city ?? null,
              province: province ?? null,
              shopifyId,
              emailVerified: verifiedEmail,
              orders: ordersCount,
              totalSpent,
              status: 'active',
              joined,
            })
            .onConflictDoNothing()
          imported++
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : 'Failed to import a customer')
      }
    }

    await persistLog({
      entity: 'Customer',
      direction: 'in',
      action: 'Customers Synced',
      status: 'success',
    })
    return { ok: true, imported, updated, errors }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    await persistLog({ entity: 'Customer', direction: 'in', action: 'Customers Synced', status: 'failed', error: msg })
    return { ok: false, imported: 0, updated: 0, errors: [msg], message: 'Shopify customer sync failed' }
  }
}

/**
 * Re-fetch a single order from Shopify by its local row id and update the
 * local copy (customer, value, payment/fulfillment/status, addresses).
 * Used by the "Refresh from Shopify" action on the Orders page.
 */
export async function refreshShopifyOrder(localOrderId: string): Promise<{ ok: boolean; updated?: boolean; message?: string }> {
  if (!isConfigured()) return { ok: false, message: 'Shopify is not configured' }
  if (!db) return { ok: false, message: 'Database is not configured' }

  const [local] = await db.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, localOrderId)).limit(1)
  if (!local) return { ok: false, message: 'Order not found locally' }
  const orderNumber = String(local.shopifyId ?? '').replace(/^#/, '')
  if (!orderNumber) return { ok: false, message: 'Order is not linked to Shopify' }

  // Local shopifyId stores the order NAME (e.g. "#1053"), but the REST
  // single-order endpoint needs the numeric REST id. Look up by name first
  // (name query requires status=any to include closed/cancelled orders).
  const matches = await paginate<any>('orders', `status=any&name=${encodeURIComponent(`#${orderNumber}`)}`)
  const restId = matches[0]?.id
  if (!restId) return { ok: false, message: `Order #${orderNumber} not found on Shopify` }

  // Single-order REST endpoint returns { order: {...} } — use shopifyRequest
  // directly (paginate only collects res.json[resource] arrays). apiPath appends
  // .json itself, so pass the bare resource path.
  let res: { json: Record<string, unknown> }
  try {
    res = await shopifyRequest<Record<string, unknown>>(`orders/${restId}`, '')
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 404) return { ok: false, message: `Order #${orderNumber} not found on Shopify` }
    throw err
  }
  const o = (res.json?.order ?? null) as any
  if (!o || (!o.id && !o.name)) return { ok: false, message: `Order #${orderNumber} not found on Shopify` }

  const safeStr = (v: unknown) => (typeof v === 'string' && v !== 'undefined' && v.trim()) ? v.trim() : ''
  const custFirstName = safeStr(o.customer?.first_name) || safeStr(o.billing_address?.first_name) || ''
  const custLastName = safeStr(o.customer?.last_name) || safeStr(o.billing_address?.last_name) || ''
  const customerName = `${custFirstName} ${custLastName}`.trim() || (safeStr(o.customer?.email) || safeStr(o.billing_address?.email) || 'Guest')
  const value = Math.round(Number(o.total_price ?? 0) * 100) / 100
  const items = o.line_items?.reduce((sum: number, li: any) => sum + Number(li.quantity ?? 0), 0) ?? 0
  const payment = mapImportedPayment(o.financial_status)
  const fulfillment = mapImportedFulfillment(o.fulfillment_status)

  const addrFrom = (src: any) => parseOrderAddress(src)
  const billingAddress = addrFrom(o.billing_address)
  const shippingAddress = addrFrom(o.shipping_address)

  await db
    .update(schema.salesOrders)
    .set({
      // A real fetched name wins over the placeholder/Guest/none, never the
      // other way round (same rule as the order sync's customer upsert).
      ...(customerName && customerName !== 'Guest' ? { customer: upgradeName(local.customer, customerName) } : {}),
      value,
      payment,
      fulfillment,
      items,
      // Locally recovered addresses survive a redacted or partial payload.
      billingAddress: mergeAddress(local.billingAddress as OrderAddress | undefined, billingAddress),
      shippingAddress: mergeAddress(local.shippingAddress as OrderAddress | undefined, shippingAddress),
    })
    .where(eq(schema.salesOrders.id, localOrderId))

  addLog('orders', 'success', 1, `Refreshed order #${orderNumber} from Shopify`)
  await persistLog({ entity: 'Order', shopifyId: `#${orderNumber}`, direction: 'in', action: 'Order Refreshed', status: 'success' })
  return { ok: true, updated: true }
}
