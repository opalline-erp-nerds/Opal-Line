import { randomUUID } from 'node:crypto'
import { Router, type Request, type Response, json as expressJson } from 'express'
import argon2 from 'argon2'
import { desc, eq, ilike, inArray, or, sql, and, gte, lte, ne } from 'drizzle-orm'
import { db, schema, checkDbHealth } from '../db/client'
import {
  duplicateScanMessage,
  inactiveProductMessage,
  normalizeScanCode,
  scanCodeError,
} from '../scanCode'
import { findProductsBySku, generateUniqueSku, productCodeSettings } from '../lib/skuIdentity'
import { isGenericSku, migrationWarnings, planSkuMigration, type SkuReferences } from '../lib/skuMigration'
import { DEFAULT_LOCATION_ID, applyStockMovement,  assertStockAvailable, ensureDefaultLocation, InsufficientStockError, resolveMovementLocation, type Tx } from '../stock'
import { applyInvoiceReturn, aggregateReturnedBySku, nextInvoiceStatus, summarizeReturnLines } from '../invoiceReturn'
import { computeUserPermissions, isSuperAdminUser, requirePermission, roleGrantsAnyModule } from '../rbac'
import {
  validate,
  recoveryPasswordSchema,
  normalizeGstin,
  normalizeEmail,
  saveProductVariantsSchema,
  validateSupplierInput,
} from '../validation'
import { clearRecoveryPassword, getRecoveryPasswordSource, isRecoveryRole, RECOVERY_PASSWORD_HASH_KEY, RECOVERY_PASSWORD_KEY, setRecoveryPassword } from '../recoveryPassword'
import { actorFromRequest,  recordActivity } from '../activity'
import { recordProductPrice } from '../lib/productPriceHistory'
import { encrypt, decrypt,  encryptSecret } from '../lib/crypto'
import { isConfigured as isShopifyConfigured, config as shopifyConfig, normalizeShopDomain } from '../config'
import { upsertEnvVar } from '../lib/envfile'
import { DispatchError, dispatchOrder, confirmShipmentDelivered } from '../dispatch'
import { logger } from '../logger'
import {
  AGING_BUCKETS,
  ageInDays,
  agingBucketDefinition,
  agingBucketForDays,
  fifoEntryDate,
  toAgingIso,
  type AgingBucketKey,
} from '../lib/stockAging'
import { invoiceTotals } from '../invoiceTotals'
import { buildStockCountRows, stockCountDelta, stockAtLocation } from '../stockCount'
import { pushInventoryToShopify, getLatestSilverRate } from '../shopify'
import { escapeHtml } from '../htmlEscape'
import { routeParam } from '../lib/routeParams'
import {
  categoryNameError,
  categoryPrefixError,
  collectionNameError,
  fixedPriceError,
  normalizeCategoryName,
  normalizeCollectionName,
  normalizeCategoryPrefix,
} from '../lib/collections'
import {
  findCategoryById,
  findCollection,
  importRowAssociation,
  loadCollectionLookup,
  resolveProductAssociation,
  type CollectionLookup,
} from '../lib/collectionStore'

export const dbRouter = Router()

function requireDb(res: Response) {
  if (!db) {
    res.status(503).json({ error: 'Service temporarily unavailable' })
    return false
  }
  return true
}

const COLUMNS_KEY = Symbol.for('drizzle:Columns')

function columnsOf(table: any): string[] {
  const cols = table?.[COLUMNS_KEY] ?? table
  return Object.keys(cols)
}

/**
 * Full text of an error, including the wrapped driver cause. Drizzle wraps the
 * underlying Postgres error in a DrizzleQueryError whose own `message` is just
 * "Failed query: ...", so a unique-violation check that only reads `message`
 * would miss the driver's "duplicate key value violates unique constraint".
 */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return typeof err === 'string' ? err : 'Unknown error'
  const cause = (err as { cause?: unknown }).cause
  const causeText =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  return `${err.message} ${causeText}`.trim()
}

function sanitize(body: Record<string, unknown>, table: any): Record<string, unknown> {
  const allowed = new Set(columnsOf(table))
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body ?? {})) {
    if (allowed.has(key)) out[key] = value
  }
  // Login-lockout rules (Settings → Security): clamp rather than reject, so a
  // stale UI or scripted PUT can never store threshold 0 (protection off) or
  // a week-long lock. Mirrors normalizeLockoutPolicy in src/lockout.ts.
  if (table === s.settings) {
    const clampRule = (key: 'lockoutThreshold' | 'lockoutDurationMinutes', min: number, max: number) => {
      if (out[key] === undefined) return
      const n = Number(out[key])
      if (!Number.isFinite(n)) throw new Error(`${key} must be a number`)
      out[key] = Math.min(max, Math.max(min, Math.round(n)))
    }
    clampRule('lockoutThreshold', 1, 50)
    clampRule('lockoutDurationMinutes', 1, 1440)
    // Settings → Product codes: normalise rather than reject, so a scripted
    // PUT can never store a format template without {SEQ} (which would mint
    // identical SKUs forever) or a sequence shorter than the three digits the
    // house style requires (OL-RNG-001). Mirrors normalizedCodeSettings in
    // src/lib/productCodes.ts. The barcode prefix setting is gone: labels
    // carry a QR code encoding the SKU, never an EAN barcode.
    if (out.skuPrefix !== undefined) out.skuPrefix = String(out.skuPrefix ?? '').trim().toUpperCase().slice(0, 12) || null
    if (out.skuSuffix !== undefined) out.skuSuffix = String(out.skuSuffix ?? '').trim().toUpperCase().slice(0, 12) || null
    if (out.skuFormat !== undefined) {
      const fmt = String(out.skuFormat ?? '').trim().slice(0, 80)
      out.skuFormat = fmt.includes('{SEQ}') ? fmt : null
    }
    if (out.skuSeqLength !== undefined && out.skuSeqLength !== null) {
      const n = Number(out.skuSeqLength)
      if (!Number.isFinite(n)) throw new Error('skuSeqLength must be a number')
      out.skuSeqLength = Math.min(8, Math.max(3, Math.round(n)))
    } else if (out.skuSeqLength === null) {
      // NULL means "back to the shipped default" — never clamp it to 1.
      out.skuSeqLength = null
    }
    // Legacy column: the barcode workflow is removed, so any attempt to write
    // the old prefix setting is dropped instead of stored.
    delete out.barcodePrefix
  }
  // Stock/price floors: the transactional order/invoice paths guard stock with
  // row locks, but direct product writes must never push stock or prices negative.
  if (table === s.products) {
    if (out.stock !== undefined) {
      const n = Number(out.stock)
      if (!Number.isFinite(n) || n < 0) throw new Error('Stock cannot be negative')
      out.stock = Math.floor(n)
    }
    if (out.reorderLevel !== undefined) {
      const n = Number(out.reorderLevel)
      if (!Number.isFinite(n) || n < 0) throw new Error('Reorder level cannot be negative')
      out.reorderLevel = Math.floor(n)
    }
    for (const priceField of ['sellingPrice', 'compareAtPrice', 'costPrice', 'silverRate', 'makingCharge', 'fixedPieceRate'] as const) {
      if (out[priceField] !== undefined) {
        const n = Number(out[priceField])
        if (!Number.isFinite(n) || n < 0) throw new Error(`${priceField} cannot be negative`)
        out[priceField] = n
      }
    }
  }
  return out
}

function stripHash<T extends Record<string, unknown>>(row: T): T {
  if (row && 'passwordHash' in row) {
    const { passwordHash, resetToken, resetTokenExpiry, emailVerificationToken, emailVerificationExpiry, ...rest } = row
    void passwordHash; void resetToken; void resetTokenExpiry; void emailVerificationToken; void emailVerificationExpiry
    return rest as T
  }
  return row
}

const PASSWORD_RULES: Array<[RegExp, string]> = [
  [/[A-Z]/, 'Password must contain at least one uppercase letter'],
  [/[a-z]/, 'Password must contain at least one lowercase letter'],
  [/[0-9]/, 'Password must contain at least one number'],
  [/[^A-Za-z0-9]/, 'Password must contain at least one special character'],
]

export function assertStrongPassword(pwd: string): void {
  if (pwd.length < 8) throw new Error('Password must be at least 8 characters')
  if (pwd.length > 255) throw new Error('Password must not exceed 255 characters')
  for (const [pattern, message] of PASSWORD_RULES) {
    if (!pattern.test(pwd)) throw new Error(message)
  }
}

async function prepareUserBody(body: Record<string, unknown>, isUpdate = false): Promise<Record<string, unknown>> {
  const cleaned = sanitize(body, schema.users)
  delete cleaned.passwordHash
  const raw = body ?? {}
  const password = raw.password
  if (password != null && password !== '') {
    const pwd = String(password)
    assertStrongPassword(pwd)
    cleaned.passwordHash = await argon2.hash(pwd, { type: argon2.argon2id })
    // An admin setting a password has chosen it for the user, so the forced
    // rotation requirement is satisfied — otherwise requireAuth would keep
    // locking that account out of the API with no way to recover.
    cleaned.requirePasswordChange = false
  }
  if (isUpdate && password == null) delete cleaned.passwordHash
  delete cleaned.password
  return cleaned
}

/**
 * Module access is the super admin's call. The generic user create/update
 * routes must not smuggle it past the dedicated RBAC endpoints: writing the
 * `permissions` column (grant or reset), assigning the Super Admin role, or
 * assigning any role that carries module permissions all require a Super
 * Admin requester. Plain roles with no modules stay assignable to any
 * system-module editor.
 */
async function assertNoPrivilegeEscalation(
  req: Request,
  body: Record<string, unknown>,
): Promise<string | null> {
  const touchesPermissions = 'permissions' in body
  const targetRole = typeof body.role === 'string' ? body.role : null
  const privileged =
    touchesPermissions ||
    (targetRole !== null && (targetRole === 'Super Admin' || (await roleGrantsAnyModule(targetRole))))
  if (!privileged) return null
  if (await isSuperAdminUser(req.userId ?? '')) return null
  return 'Only a super admin can grant module access or assign privileged roles'
}

/**
 * Validation and normalisation shared by the supplier create/update routes.
 *
 * Name is required (on create, and on update when it is being changed); email
 * and GSTIN are optional but must be well-formed, and a GSTIN or name may not
 * be reused by another supplier. Throws with a user-facing message, which the
 * generic handlers surface for the supplier resource.
 */
async function prepareSupplierBody(
  body: Record<string, unknown>,
  opts: { isUpdate?: boolean; id?: string } = {},
): Promise<Record<string, unknown>> {
  const cleaned = sanitize(body, schema.suppliers)
  const text = (value: unknown): string | null => {
    const s = String(value ?? '').trim()
    return s === '' ? null : s
  }
  for (const key of ['name', 'contact', 'phone', 'alternatePhone', 'city', 'address'] as const) {
    if (key in cleaned) cleaned[key] = text(cleaned[key])
  }
  if ('email' in cleaned) cleaned.email = normalizeEmail(cleaned.email) || null
  if ('gstin' in cleaned) cleaned.gstin = normalizeGstin(cleaned.gstin) || null

  const nameProvided = Object.prototype.hasOwnProperty.call(body ?? {}, 'name')
  const invalid = validateSupplierInput(
    { name: cleaned.name, email: cleaned.email, gstin: cleaned.gstin },
    { requireName: !opts.isUpdate || nameProvided },
  )
  if (invalid) throw new Error(invalid)

  if (db) {
    if (cleaned.name) {
      const [clash] = await db
        .select({ id: schema.suppliers.id })
        .from(schema.suppliers)
        .where(eq(schema.suppliers.name, String(cleaned.name)))
        .limit(1)
      if (clash && clash.id !== opts.id) throw new Error('A supplier with that name already exists')
    }
    if (cleaned.gstin) {
      const [clash] = await db
        .select({ id: schema.suppliers.id })
        .from(schema.suppliers)
        .where(eq(schema.suppliers.gstin, String(cleaned.gstin)))
        .limit(1)
      if (clash && clash.id !== opts.id) throw new Error('A supplier with that GSTIN already exists')
    }
  }
  return cleaned
}

export function num(value: unknown, fallback: number) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function maskBankAccount(row: Record<string, unknown>): Record<string, unknown> {
  if (!row || row.account_number_encrypted == null) return row
  try {
    const full = decrypt(String(row.account_number_encrypted))
    row.accountNumber = full
  } catch {
    row.accountNumber = ''
  }
  delete row.account_number_encrypted
  return row
}

function orderedColumn(orderCol: any): any {
  if (!orderCol) return undefined
  if (orderCol.direction) return orderCol
  const colName = String(orderCol.name ?? '')
  // NULLS LAST: Postgres defaults DESC to NULLS FIRST, which floats rows
  // with no date to the top of the list (every legacy row above the newest
  // data). drizzle 0.45 has no descNullsLast helper, so spell it out.
  return /(date|time|timestamp|created|updated|_at)$/i.test(colName) ? sql`${orderCol} DESC NULLS LAST` : orderCol
}

async function paginate(table: any, query: any, orderCol: any, req: Request) {
  const page = Math.max(1, num(req.query.page, 1))
  const pageSize = Math.min(200, Math.max(1, num(req.query.limit, 50)))
  const offset = (page - 1) * pageSize
  const [rows, countResult] = await Promise.all([
    db!.select().from(table).orderBy(orderedColumn(orderCol)).limit(pageSize).offset(offset),
    db!.select({ count: sql<number>`count(*) over ()` }).from(table).limit(1),
  ])
  const count = countResult[0]?.count ?? 0
  return { page, pageSize, total: Number(count), data: rows }
}

const listOf = (table: any, orderCol?: any) =>
    async (req: Request, res: Response) => {
    if (!requireDb(res)) return
    try {
      const result = await paginate(table, req.query, orderCol ?? table.id, req)
      result.data = result.data.map(stripHash)
      res.json(result)
    } catch (err) {
      logger.error({ err }, 'listOf query failed')
      res.status(500).json({ error: 'Internal server error' })
    }
  }

const oneOf = (table: any, idCol: any) =>
    async (req: Request, res: Response) => {
    if (!requireDb(res)) return
    try {
      const rows = await db!.select().from(table).where(eq(idCol, routeParam(req.params.id))).limit(1)
      if (!rows[0]) return res.status(404).json({ error: 'Not found' })
      res.json(stripHash(rows[0]))
    } catch (err) {
      logger.error({ err }, 'oneOf query failed')
      res.status(500).json({ error: 'Internal server error' })
    }
  }

const s = schema

// Newest products first: orderedColumn descends *_at columns automatically,
// so the list opens on the latest creations (column headers still re-sort).
dbRouter.get('/products', listOf(s.products, s.products.createdAt))

// ─── SKU identity helpers ─────────────────────────────────────────────
// SKUs are the only product identifier: generated per category under an
// advisory lock so two concurrent creates in the same category cannot mint the
// same OL-{CODE}-{SEQ} code, and never rewritten implicitly on edit. Labels
// encode the SKU in a QR code (see src/barcodeLabels.ts) — there are no
// barcodes anywhere in the product workflow. The generation and scan-lookup
// helpers live in src/lib/skuIdentity.ts so they can be unit-tested.

// Next free SKU for a category, read from LIVE product + variant codes inside
// the same per-category advisory lock the create path uses. The product dialog
// fills its SKU field from this, so the proposal is database-derived instead of
// client-side only; POST /products re-validates/claims the code under the lock
// on save. `categoryId` (a Collections & Categories row) supplies the category's
// own prefix, so the proposal and the saved code agree. Registered before
// /products/:id to avoid param capture.
dbRouter.get('/products/next-sku', requirePermission('inventory', 'create'), async (req, res) => {
  if (!requireDb(res)) return
  const requestedName = String(req.query.category ?? '').trim()
  const categoryId = String(req.query.categoryId ?? '').trim()
  if (!requestedName && !categoryId) {
    return res.status(400).json({ error: 'A category is required to generate a SKU' })
  }
  try {
    const result = await db!.transaction(async (tx) => {
      // A stale id falls back to the name the caller sent; an id whose row still
      // exists is authoritative for both the name and the SKU prefix.
      const row = categoryId ? await findCategoryById(tx, categoryId) : null
      const category = row?.name ?? requestedName
      if (!category) return null
      const sku = await generateUniqueSku(tx, category, await productCodeSettings(tx), row?.prefix)
      return { sku, category }
    })
    if (!result) return res.status(400).json({ error: 'Unknown category' })
    res.json(result)
  } catch (err) {
    logger.error({ err }, 'next SKU lookup failed')
    res.status(500).json({ error: 'Could not generate a SKU' })
  }
})

// QR Code labels (must be before /products/:id to avoid param capture)
dbRouter.get('/products/labels/presets', requirePermission('inventory', 'view'), async (_req, res) => {
  const { LABEL_PRESET_LIST } = await import('../barcodeLabels')
  res.json(LABEL_PRESET_LIST)
})

// Parses optional custom label geometry from query/body. Values are clamped to
// sane physical ranges so a bad request can never produce a broken PDF.
function labelSizeOverride(src: Record<string, unknown>): Partial<{
  width: number
  height: number
  columns: number
  rows: number
  margin: number
  gap: number
}> {
  const num = (v: unknown, min: number, max: number): number | undefined => {
    const n = Number(v)
    if (!Number.isFinite(n)) return undefined
    return Math.min(Math.max(n, min), max)
  }
  const out: ReturnType<typeof labelSizeOverride> = {}
  const width = num(src.w ?? src.width, 10, 150)
  const height = num(src.h ?? src.height, 5, 150)
  const columns = num(src.cols ?? src.columns, 1, 12)
  const rows = num(src.rows, 1, 60)
  const margin = num(src.margin, 0, 40)
  const gap = num(src.gap, 0, 20)
  if (width !== undefined) out.width = width
  if (height !== undefined) out.height = height
  if (columns !== undefined) out.columns = Math.floor(columns)
  if (rows !== undefined) out.rows = Math.floor(rows)
  if (margin !== undefined) out.margin = margin
  if (gap !== undefined) out.gap = gap
  return out
}

async function labelRequestOptions(source: Record<string, unknown>) {
  const { resolveLabelPreset } = await import('../barcodeLabels')
  const preset = String(source.preset || '')
  const copiesRaw = source.copies
  const opts = resolveLabelPreset(preset, {
    showPrice: source.price !== 'false' && source.showPrice !== false,
    showWeight: source.weight !== 'false' && source.showWeight !== false,
    showQR: source.qr !== 'false' && source.showQR !== false,
    showBrand: source.brand !== 'false' && source.showBrand !== false,
    showName: source.name !== 'false' && source.showName !== false,
    showSku: source.sku !== 'false' && source.showSku !== false,
    showCategory: source.category !== 'false' && source.showCategory !== false,
    copies: copiesRaw == null ? 1 : Number(copiesRaw),
    page: source.page === 'letter' || source.pageSize === 'letter' ? 'letter' : (source.page === 'a4' ? 'a4' : undefined),
  })
  const brand = source.brandName
  if (typeof brand === 'string' && brand.trim()) opts.brand = brand.trim()
  return opts
}

function unknownLabelPresetMessage(error: unknown): string | null {
  return error instanceof Error && error.message.startsWith('Unknown label preset:')
    ? error.message
    : null
}

dbRouter.get('/products/labels', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { fetchAllProductLabels, fetchProductLabels, generateLabelsPDF } = await import('../barcodeLabels')
    // Optional `ids` query (comma-separated product IDs) → labels for selected products only
    const idsParam = String(req.query.ids ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    const products = idsParam.length > 0 ? await fetchProductLabels(idsParam) : await fetchAllProductLabels()
    if (products.length === 0) return res.status(404).json({ error: 'No products found' })
    const baseOpts = await labelRequestOptions(req.query as Record<string, unknown>)
    const sizeOpts = labelSizeOverride(req.query as Record<string, unknown>)
    const pdf = await generateLabelsPDF(products, { ...baseOpts, ...sizeOpts })
    if (!pdf) return res.status(500).json({ error: 'Label generation failed' })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="product-labels-${Date.now()}.pdf"`)
    res.send(pdf)
  } catch (err) {
    logger.error({ err }, 'label PDF generation failed')
    const presetError = unknownLabelPresetMessage(err)
    if (presetError) return res.status(400).json({ error: presetError })
    res.status(500).json({ error: 'Label generation failed' })
  }
})

dbRouter.post('/products/labels', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { fetchProductLabels, generateLabelsPDF } = await import('../barcodeLabels')
    const ids: string[] = Array.isArray(req.body?.productIds) ? req.body.productIds : []
    if (ids.length === 0) return res.status(400).json({ error: 'productIds is required' })
    const products = await fetchProductLabels(ids)
    if (products.length === 0) return res.status(404).json({ error: 'Products not found' })
    const baseOpts = await labelRequestOptions(req.body ?? {})
    const sizeOpts = labelSizeOverride((req.body ?? {}) as Record<string, unknown>)
    const pdf = await generateLabelsPDF(products, { ...baseOpts, ...sizeOpts })
    if (!pdf) return res.status(500).json({ error: 'Label generation failed' })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="product-labels-${Date.now()}.pdf"`)
    res.send(pdf)
  } catch (err) {
    logger.error({ err }, 'label PDF generation failed')
    const presetError = unknownLabelPresetMessage(err)
    if (presetError) return res.status(400).json({ error: presetError })
    res.status(500).json({ error: 'Label generation failed' })
  }
})

// Raw ZPL output for a ZPL-capable label printer / print server. Returns text
// only — it is never written to a raw socket from the server.
dbRouter.post('/products/labels/zpl', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { fetchProductLabels } = await import('../barcodeLabels')
    const { renderZpl, zplOptionsForPreset } = await import('../zpl')
    const ids: string[] = Array.isArray(req.body?.productIds) ? req.body.productIds : []
    if (ids.length === 0) return res.status(400).json({ error: 'productIds is required' })
    const products = await fetchProductLabels(ids)
    if (products.length === 0) return res.status(404).json({ error: 'Products not found' })
    const brandName = typeof req.body?.brandName === 'string' ? req.body.brandName.trim() : ''
    const opts = zplOptionsForPreset(String(req.body?.preset || ''), {
      copies: req.body?.copies == null ? 1 : Number(req.body.copies),
      showPrice: req.body?.showPrice !== false,
      showWeight: req.body?.showWeight !== false,
      showQR: req.body?.showQR !== false && req.body?.qr !== 'false',
      showBrand: req.body?.showBrand !== false,
      ...(brandName ? { brand: brandName } : {}),
    })
    const zpl = renderZpl(products, opts)
    if (!zpl) return res.status(400).json({ error: 'Invalid label dimensions' })
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="product-labels-${Date.now()}.zpl"`)
    res.send(zpl)
  } catch (err) {
    logger.error({ err }, 'label ZPL generation failed')
    const presetError = unknownLabelPresetMessage(err)
    if (presetError) return res.status(400).json({ error: presetError })
    res.status(500).json({ error: 'Label generation failed' })
  }
})

// ─── Safe SKU regeneration for generic SKUs ───────────────────────────
// Legacy generic codes (SLV-GEN-001) carry no category information. This
// utility plans OL-{CATEGORY}-{SEQ} replacements, REPORTS every reference it
// found (invoices, orders, inventory, Shopify, labels) and only writes inside
// one transaction guarded by an advisory lock. Dry-run by default: nothing
// changes until apply is requested explicitly.

async function collectSkuReferences(tx: any, skus: string[]): Promise<Map<string, SkuReferences>> {
  const refs = new Map<string, SkuReferences>()
  const fresh = (): SkuReferences => ({ invoiceItems: 0, orderItems: 0, stockMovements: 0, stockTransfers: 0, variants: 0, shopifyLinked: false })
  for (const sku of skus) refs.set(sku.toUpperCase(), fresh())
  const bucket = (sku: unknown) => refs.get(String(sku ?? '').trim().toUpperCase())

  const invoiceRows = await tx
    .select({ sku: s.salesInvoiceItems.sku })
    .from(s.salesInvoiceItems)
    .where(inArray(s.salesInvoiceItems.sku, skus))
  for (const r of invoiceRows) { const b = bucket(r.sku); if (b) b.invoiceItems++ }

  // Sales order lines live in a jsonb array — match both the parent SKU and
  // any variant SKU derived from it (parent-SMA style).
  const orderRows = await tx
    .select({ id: s.salesOrders.id, lineItems: s.salesOrders.lineItems })
    .from(s.salesOrders)
    .where(sql`(${s.salesOrders.lineItems})::text ILIKE ANY(${sql`ARRAY[${sql.join(skus.map((k) => sql`%${k}%`), sql`, `)}]`})`)
  for (const row of orderRows) {
    const lines = Array.isArray(row.lineItems) ? (row.lineItems as Array<Record<string, unknown>>) : []
    for (const line of lines) {
      const key = String(line?.sku ?? '').trim().toUpperCase()
      const parent = skus.find((k) => key === k.toUpperCase() || key.startsWith(`${k.toUpperCase()}-`))
      const b = parent ? refs.get(parent.toUpperCase()) : undefined
      if (b) b.orderItems++
    }
  }

  const movementRows = await tx
    .select({ sku: s.stockMovements.sku })
    .from(s.stockMovements)
    .where(inArray(s.stockMovements.sku, skus))
  for (const r of movementRows) { const b = bucket(r.sku); if (b) b.stockMovements++ }

  const transferRows = await tx
    .select({ sku: s.stockTransfers.sku })
    .from(s.stockTransfers)
    .where(inArray(s.stockTransfers.sku, skus))
  for (const r of transferRows) { const b = bucket(r.sku); if (b) b.stockTransfers++ }

  const variantRows = await tx
    .select({ sku: s.productVariants.sku })
    .from(s.productVariants)
    .where(sql`(${s.productVariants.sku}) = ANY(${sql`ARRAY[${sql.join(skus.map((k) => sql`${k} || '%'`), sql`, `)}]`})`)
  void variantRows // counted per product below (prefix match, any variant tail)
  for (const sku of skus) {
    const b = refs.get(sku.toUpperCase())
    if (!b) continue
    const [cnt] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(s.productVariants)
      .where(sql`(${s.productVariants.sku}) = ${sku} OR (${s.productVariants.sku}) LIKE ${sku || '\u0000'} || '-%'`)
    b.variants = Number(cnt?.n ?? 0)
  }

  const shopifyRows = await tx
    .select({ sku: s.products.sku, shopifyId: s.products.shopifyId, shopifyStatus: s.products.shopifyStatus })
    .from(s.products)
    .where(inArray(s.products.sku, skus))
  for (const r of shopifyRows) {
    const b = bucket(r.sku)
    if (b) {
      const linked = String(r.shopifyId ?? '').trim() !== '' && !String(r.shopifyId ?? '').trim().startsWith('#')
      b.shopifyLinked = linked && (r.shopifyStatus ?? '') === 'synced'
    }
  }
  return refs
}

// Summary for the Products screen: how many products still carry a generic
// SKU, so the migration action can surface only when it has work to do.
dbRouter.get('/products/skus/summary', requirePermission('inventory', 'view'), async (_req, res) => {
  if (!requireDb(res)) return
  try {
    const rows = await db!.select({ sku: s.products.sku }).from(s.products)
    res.json({ total: rows.length, generic: rows.filter((r) => isGenericSku(r.sku)).length })
  } catch (err) {
    logger.error({ err }, 'sku summary failed')
    res.status(500).json({ error: 'Could not load SKU summary' })
  }
})

// Regenerate generic SKUs. Body: { apply?: boolean, ids?: string[] }.
// Default (apply absent/false) is a dry run returning the full plan plus the
// references found; with apply: true the plan is executed in one transaction.
dbRouter.post('/products/skus/regenerate', requirePermission('inventory', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const apply = req.body?.apply === true
    const ids: string[] = Array.isArray(req.body?.ids)
      ? req.body.ids.map((x: unknown) => String(x).trim()).filter(Boolean)
      : []
    const [settingsRow] = await db!.select().from(s.settings).limit(1)
    const codeSettings = {
      skuPrefix: settingsRow?.skuPrefix ?? null,
      skuSuffix: settingsRow?.skuSuffix ?? null,
      skuFormat: settingsRow?.skuFormat ?? null,
      skuSeqLength: settingsRow?.skuSeqLength ?? null,
    }

    const result = await db!.transaction(async (tx) => {
      // One writer at a time: sequences are computed from live rows, so a
      // concurrent regeneration must not race the plan.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('sku:regenerate'))`)
      const products = await tx
        .select({ id: s.products.id, name: s.products.name, sku: s.products.sku, category: s.products.category })
        .from(s.products)
      const variantSkus = await tx.select({ sku: s.productVariants.sku }).from(s.productVariants)
      const scoped = ids.length > 0 ? products.filter((p) => ids.includes(p.id)) : products
      const plan = planSkuMigration(scoped, [...products.map((p) => p.sku), ...variantSkus.map((v) => v.sku)], codeSettings)

      const details: Array<{
        id: string
        name: string
        oldSku: string
        newSku: string
        references: SkuReferences
        warnings: string[]
        applied: boolean
        reason?: string
      }> = []
      const applied: Array<{ id: string; name: string; oldSku: string; newSku: string }> = []

      for (const c of plan) {
        const refsMap = await collectSkuReferences(tx, [c.oldSku])
        const refs = refsMap.get(c.oldSku.toUpperCase()) ?? {
          invoiceItems: 0, orderItems: 0, stockMovements: 0, stockTransfers: 0, variants: 0, shopifyLinked: false,
        }
        const warnings = migrationWarnings(refs)
        const entry = { id: c.id, name: c.name, oldSku: c.oldSku, newSku: c.newSku, references: refs, warnings, applied: false, reason: undefined as string | undefined }
        if (!apply) {
          details.push(entry)
          continue
        }
        // The new SKU must still be free inside the lock (plan → write race
        // with an ordinary create): re-check, bump by re-planning if taken.
        const allNow = await tx.select({ sku: s.products.sku }).from(s.products)
        const [clash] = await tx
          .select({ id: s.products.id })
          .from(s.products)
          .where(sql`upper(${s.products.sku}) = upper(${c.newSku})`)
          .limit(1)
        if (clash) {
          entry.reason = `target SKU ${c.newSku} is already in use`
          details.push(entry)
          continue
        }
        void allNow
        await tx.update(s.products).set({ sku: c.newSku }).where(and(eq(s.products.id, c.id), eq(s.products.sku, c.oldSku)))
        // Live references follow the rename inside the same transaction so no
        // ledger/variant row is left pointing at a SKU that no longer exists.
        const variantRows = await tx
          .select({ id: s.productVariants.id, sku: s.productVariants.sku })
          .from(s.productVariants)
          .where(sql`(${s.productVariants.sku}) = ${c.oldSku} OR (${s.productVariants.sku}) LIKE ${c.oldSku} || '-%'`)
        for (const v of variantRows) {
          const tail = v.sku === c.oldSku ? '' : v.sku.slice(c.oldSku.length)
          await tx.update(s.productVariants).set({ sku: `${c.newSku}${tail}` }).where(eq(s.productVariants.id, v.id))
        }
        await tx
          .update(s.stockMovements)
          .set({ sku: c.newSku })
          .where(eq(s.stockMovements.sku, c.oldSku))
        await tx
          .update(s.stockTransfers)
          .set({ sku: c.newSku })
          .where(eq(s.stockTransfers.sku, c.oldSku))
        entry.applied = true
        details.push(entry)
        applied.push({ id: c.id, name: c.name, oldSku: c.oldSku, newSku: c.newSku })
      }
      return { plan, details, applied }
    })

    if (apply && result.applied.length > 0) {
      const actor = actorFromRequest(req)
      void recordActivity({
        action: 'Regenerated generic SKUs',
        module: 'inventory',
        entity: `Product SKUs (${result.applied.length} regenerated)`,
        details: result.applied.slice(0, 10).map((p) => `${p.oldSku}→${p.newSku}`).join(', '),
        userId: actor.userId,
        ip: actor.ip,
      })
    }

    res.json({
      ok: true,
      apply,
      candidates: result.plan.length,
      applied: result.applied.length,
      details: result.details.slice(0, 200),
      // Labels are rendered live from the products table: printed sheets that
      // encode an old SKU must be re-printed after regeneration.
      note: 'Printed QR labels encode the SKU — re-print labels for regenerated products.',
    })
  } catch (err) {
    logger.error({ err }, 'sku regeneration failed')
    res.status(500).json({ error: 'Could not regenerate SKUs' })
  }
})

// Scan-based stock count: look up a product by its EXACT SKU. Printed labels
// carry a QR code that encodes only the SKU (e.g. OL-RNG-001), so scanning one
// resolves the product here. Input is normalised first so a keyboard-wedge
// scan and a typed value resolve identically.
dbRouter.get('/products/scan', requirePermission('inventory', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const formatError = scanCodeError(req.query.code)
    if (formatError) return res.status(400).json({ error: formatError })
    const code = normalizeScanCode(req.query.code)
    // Exact SKU match only — no fuzzy/partial matching and no barcode lookup,
    // so a scan can never resolve to the wrong product.
    const rows = await findProductsBySku(db!, code)
    if (rows.length === 0) return res.status(404).json({ error: 'No product matches that SKU' })
    if (rows.length > 1) return res.status(409).json({ error: duplicateScanMessage() })
    const row = rows[0]
    if (row.status && row.status !== 'active') {
      return res.status(409).json({ error: inactiveProductMessage(row.name, row.status) })
    }
    res.json({ data: { id: row.id, name: row.name, sku: row.sku, stock: row.stock, category: row.category } })
  } catch (err) {
    logger.error({ err }, 'product scan lookup failed')
    res.status(500).json({ error: 'Scan lookup failed' })
  }
})

// Bulk stock-count: apply counted quantities for many products at once.
// body: { counts: [{ id, counted }], mode: 'set' | 'adjust', locationId?: string,
//         pushToShopify?: boolean }
dbRouter.post('/inventory/stock-count', requirePermission('inventory', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const counts = Array.isArray(req.body?.counts) ? req.body.counts : []
    const mode = req.body?.mode === 'adjust' ? 'adjust' : 'set'
    const pushToShopify = req.body?.pushToShopify === true
    if (counts.length === 0) return res.status(400).json({ error: 'counts array is required' })

    // A count is always taken at ONE location. Counting a branch must adjust
    // that branch's balance, so the target has to be read from stock_levels at
    // that location — never from products.stock, which is the cross-location
    // rollup and would make counting one shop silently correct another.
    const locationRaw = String(req.body?.locationId ?? '').trim()
    const locationId = locationRaw ? await resolveLocation(locationRaw) : await ensureDefaultLocation()
    if (!locationId) return res.status(400).json({ error: `Unknown location "${locationRaw}"` })

    const { rows, errors } = buildStockCountRows(counts)
    let applied = 0
    for (const c of rows) {
      try {
        const [product] = await db!
          .select({ id: s.products.id, sku: s.products.sku })
          .from(s.products)
          .where(eq(s.products.id, c.id))
          .limit(1)
        if (!product) {
          errors.push(`${c.id}: product not found`)
          continue
        }
        const [level] = await db!
          .select({ qty: s.stockLevels.qty })
          .from(s.stockLevels)
          .where(and(eq(s.stockLevels.productId, product.id), eq(s.stockLevels.locationId, locationId)))
          .limit(1)
        const current = stockAtLocation(level?.qty)
        const delta = stockCountDelta(current, c.counted, mode)
        if (delta === 0) {
          applied++
          continue
        }
        // A count is a correction, not a silent overwrite: record the delta as
        // a count_adjust movement so the ledger explains the new balance.
        await applyStockMovement({
          sku: String(product.sku ?? ''),
          qty: delta,
          type: 'count_adjust',
          locationId,
          refType: 'stock_count',
          note: mode === 'set' ? `counted ${c.counted} at ${locationId} (was ${current})` : `counted adjustment ${delta > 0 ? '+' : ''}${delta} at ${locationId}`,
          createdBy: actorFromRequest(req).userId ?? 'system',
        })
        applied++
      } catch (err) {
        errors.push(`${c.id}: ${err instanceof Error ? err.message : 'update failed'}`)
      }
    }
    // Optional round-trip: push the (already-applied) local stock to Shopify so
    // the store matches the physical count. Best-effort — local apply stands.
    let shopifyPush: Awaited<ReturnType<typeof pushInventoryToShopify>> | null = null
    if (pushToShopify && applied > 0) {
      try {
        shopifyPush = await pushInventoryToShopify(rows.map((c) => c.id))
      } catch (err) {
        shopifyPush = { ok: false, updated: 0, skipped: 0, errors: [err instanceof Error ? err.message : 'Shopify push failed'] }
      }
    }
    recordCrud('products', 'Updated', req, { stockCount: true, applied, mode, shopifyPush: shopifyPush ? shopifyPush.updated : undefined })
    res.json({ ok: errors.length === 0, applied, mode, errors, shopifyPush })
  } catch (err) {
    logger.error({ err }, 'stock count apply failed')
    res.status(500).json({ error: 'Stock count failed' })
  }
})

// Product catalog PDF + duplicate SKU detection (before /products/:id to avoid param capture)
dbRouter.get('/products/catalog-pdf', requirePermission('inventory', 'view'), async (_req, res) => {
  try {
    const { generateCatalogPDF } = await import('../catalogPdf')
    const pdf = await generateCatalogPDF()
    if (!pdf) return res.status(500).json({ error: 'Catalog generation failed' })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="product-catalog-${new Date().toISOString().slice(0, 10)}.pdf"`)
    res.send(pdf)
  } catch (err) {
    logger.error({ err }, 'catalog PDF failed')
    res.status(500).json({ error: 'Catalog generation failed' })
  }
})

// Duplicate SKU detection
dbRouter.get('/products/duplicates', requirePermission('inventory', 'view'), async (_req, res) => {
  if (!requireDb(res)) return
  try {
    const rows = await db!.execute<Record<string, unknown>>(sql`
      SELECT lower(sku) AS sku, count(*)::int AS cnt,
             string_agg(name || ' (' || id || ')', ' | ') AS products
      FROM products
      GROUP BY lower(sku)
      HAVING count(*) > 1
      ORDER BY cnt DESC
    `)
    res.json({ data: rows })
  } catch (err) {
    logger.error({ err }, 'duplicate check failed')
    res.status(500).json({ error: 'Duplicate check failed' })
  }
})

/** Last selling price recorded before local midnight, one row per product. */
dbRouter.get('/products/last-day-prices', requirePermission('inventory', 'view'), async (_req, res) => {
  if (!requireDb(res)) return
  try {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const pad = (n: number) => String(n).padStart(2, '0')
    const todayStart = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T00:00:00`
    const rows = await db!.execute<{ product_id: string; selling_price: string | number }>(sql`
      SELECT DISTINCT ON (product_id) product_id, selling_price
      FROM product_price_history
      WHERE recorded_at < ${todayStart}
      ORDER BY product_id, recorded_at DESC
    `)
    res.json({
      data: [...rows].map((r) => ({
        productId: r.product_id,
        sellingPrice: Number(r.selling_price),
      })),
    })
  } catch (err) {
    logger.error({ err }, 'last-day prices failed')
    res.status(500).json({ error: 'Could not load last-day prices' })
  }
})

// Duplicate customer-email detection (non-destructive advisory for the UI).
// Two legitimate Shopify identities can share an inbox — the banner warns,
// it never merges.
dbRouter.get('/customers/duplicate-emails', requirePermission('sales', 'view'), async (_req, res) => {
  if (!requireDb(res)) return
  try {
    const rows = await db!.execute<Record<string, unknown>>(sql`
      SELECT lower(email) AS email, count(*)::int AS cnt,
             string_agg(name || ' (' || id || ')', ' | ') AS customers
      FROM customers
      WHERE email IS NOT NULL AND email <> ''
      GROUP BY lower(email)
      HAVING count(*) > 1
      ORDER BY cnt DESC
    `)
    res.json({ data: rows })
  } catch (err) {
    logger.error({ err }, 'duplicate email check failed')
    res.status(500).json({ error: 'Duplicate email check failed' })
  }
})

// ─── Type-ahead search ──────────────────────────────────────────────
// Small, bounded lookups that back the comboboxes on the billing screens
// (new-invoice product picker, customer autofetch). Kept off the paginated
// list endpoints so a keystroke can never trigger a full-table scan, and
// capped so a broad query stays cheap. Registered BEFORE the /:id routes so
// "search" is never captured as an id.
const SEARCH_LIMIT = 15
const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`)

dbRouter.get('/products/search', async (req, res) => {
  if (!requireDb(res)) return
  try {
    const q = String(req.query.q ?? '').trim()
    if (!q) return res.json({ data: [] })
    const pattern = `%${escapeLike(q)}%`
    const rows = await db!
      .select()
      .from(s.products)
      .where(or(
        ilike(s.products.name, pattern),
        ilike(s.products.sku, pattern),
      ))
      .orderBy(s.products.name)
      .limit(SEARCH_LIMIT)
    res.json({ data: rows.map(stripHash) })
  } catch (err) {
    logger.error({ err }, 'product search failed')
    res.status(500).json({ error: 'Internal server error' })
  }
})

dbRouter.get('/products/:id', oneOf(s.products, s.products.id))

// Registered BEFORE /customers/:id so "search" is never treated as an id.
dbRouter.get('/customers/search', async (req, res) => {
  if (!requireDb(res)) return
  try {
    const q = String(req.query.q ?? '').trim()
    if (!q) return res.json({ data: [] })
    const pattern = `%${escapeLike(q)}%`
    const rows = await db!
      .select()
      .from(s.customers)
      .where(or(
        ilike(s.customers.name, pattern),
        ilike(s.customers.phone, pattern),
        ilike(s.customers.email, pattern),
      ))
      .orderBy(s.customers.name)
      .limit(SEARCH_LIMIT)
    // Same shape (and same router-level auth) as the /customers list, so the
    // picker receives a full Customer row and can autofill phone/email/city.
    res.json({ data: rows.map(stripHash) })
  } catch (err) {
    logger.error({ err }, 'customer search failed')
    res.status(500).json({ error: 'Internal server error' })
  }
})

dbRouter.get('/customers', listOf(s.customers, s.customers.name))
dbRouter.get('/customers/:id', oneOf(s.customers, s.customers.id))

dbRouter.get('/suppliers', listOf(s.suppliers, s.suppliers.name))
dbRouter.get('/suppliers/unmatched-products', requirePermission('purchase', 'view'), async (_req, res) => {
  if (!requireDb(res)) return
  try {
    const { unmatchedSupplierNames } = await import('../supplierLinking')
    const { getRawClient } = await import('../db/client')
    const client = getRawClient()
    if (!client) return res.status(503).json({ error: 'Database not configured' })
    const names = await unmatchedSupplierNames(client)
    res.json({ data: names })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch unmatched supplier names'
    res.status(500).json({ error: msg })
  }
})
dbRouter.post('/products/link-suppliers', requirePermission('purchase', 'edit'), async (_req, res) => {
  if (!requireDb(res)) return
  try {
    const { linkProductsToSuppliers } = await import('../supplierLinking')
    const { getRawClient } = await import('../db/client')
    const client = getRawClient()
    if (!client) return res.status(503).json({ error: 'Database not configured' })
    const result = await linkProductsToSuppliers(client)
    res.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to link suppliers'
    res.status(500).json({ error: msg })
  }
})
dbRouter.get('/suppliers/:id', oneOf(s.suppliers, s.suppliers.id))

dbRouter.get('/invoices', listOf(s.salesInvoices, s.salesInvoices.date))
dbRouter.get('/invoices/with-items', async (req, res) => {
  if (!requireDb(res)) return
  try {
    const limit = Math.min(200, Math.max(1, num(req.query.limit, 100)))
    const invoices = await db!.select().from(s.salesInvoices).orderBy(desc(s.salesInvoices.date)).limit(limit)
    const ids = invoices.map((i) => i.id)
    const items = ids.length > 0 ? await db!.select().from(s.salesInvoiceItems).where(inArray(s.salesInvoiceItems.invoiceId, ids)) : []
    const byInvoice = new Map<string, typeof items>()
    for (const it of items) {
      const key = String(it.invoiceId ?? '')
      const arr = byInvoice.get(key) ?? []
      arr.push(it)
      byInvoice.set(key, arr)
    }
  res.json({ page: 1, pageSize: limit, total: invoices.length, data: invoices.map((i) => ({ ...i, items: byInvoice.get(i.id) ?? [] })) })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})
dbRouter.get('/invoices/:id', oneOf(s.salesInvoices, s.salesInvoices.id))

dbRouter.get('/invoices/:id/items', async (req, res) => {
  if (!requireDb(res)) return
  try {
    const rows = await db!.select().from(s.salesInvoiceItems).where(eq(s.salesInvoiceItems.invoiceId, routeParam(req.params.id)))
  res.json(rows)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── Order PII repair ─────────────────────────────────────────────────────
// Dev stores get customer PII redacted over the REST API, so imported orders
// can end up with customer "Guest" and no addresses. The customers table may
// still hold the identity (matched by email or phone from earlier syncs, the
// Flow webhook or CSV imports). This repairs those order rows LOCALLY —
// nothing is pushed to Shopify and orders with real names are never touched.
//
// body: { orderIds?: string[] } — omit to scan every order.
// Returns { matched, repaired: [{ shopifyId, from, to }], unmatched: [...] }.
dbRouter.post('/orders/repair-pii', requirePermission('shopify', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const orderIds = Array.isArray(req.body?.orderIds)
      ? req.body.orderIds.map((x: unknown) => String(x)).filter(Boolean).slice(0, 500)
      : null
    const rows = orderIds && orderIds.length > 0
      ? await db!.select().from(s.salesOrders).where(inArray(s.salesOrders.id, orderIds))
      : await db!.select().from(s.salesOrders)

    const customers = await db!.select().from(s.customers)
    const byEmail = new Map<string, typeof customers[number]>()
    const byPhoneDigits = new Map<string, typeof customers[number]>()
    for (const c of customers) {
      // Guest-checkout customer rows (no real name) must never "repair" an
      // order's name — that would just write Guest back over Guest.
      if (!c.name || !c.name.trim() || c.name.trim().toLowerCase() === 'guest') continue
      if (c.email) byEmail.set(c.email.trim().toLowerCase(), c)
      const digits = (c.phone ?? '').replace(/\D/g, '')
      if (digits.length >= 6) byPhoneDigits.set(digits, c)
    }
    const isMissingName = (name: string | null | undefined) => !name || !name.trim() || name.trim().toLowerCase() === 'guest'

    let matched = 0
    const repaired: Array<{ shopifyId: string; from: string; to: string }> = []
    const unmatched: string[] = []
    for (const o of rows) {
      if (!isMissingName(o.customer)) continue
      const email = (o.customerEmail ?? '').trim().toLowerCase()
      const phoneDigits = (o.customerPhone ?? '').replace(/\D/g, '')
      const addr = (o.billingAddress ?? o.shippingAddress) as Record<string, unknown> | null
      const addrName = typeof addr?.name === 'string' ? addr.name.trim() : ''
      const addrPhone = typeof addr?.phone === 'string' ? addr.phone.replace(/\D/g, '') : ''

      // Identity match order: order email → order phone → address phone →
      // address block itself (only as a last resort).
      const byEmailHit = email ? byEmail.get(email) : undefined
      const byOrderPhoneHit = phoneDigits.length >= 6 ? byPhoneDigits.get(phoneDigits) : undefined
      const byAddrPhoneHit = addrPhone.length >= 6 ? byPhoneDigits.get(addrPhone) : undefined
      const hit = byEmailHit ?? byOrderPhoneHit ?? byAddrPhoneHit

      if (hit) {
        matched++
        const from = o.customer ?? ''
        const set: Record<string, unknown> = { customer: hit.name }
        if (hit.email && !o.customerEmail) set.customerEmail = hit.email
        if (hit.phone && !o.customerPhone) set.customerPhone = hit.phone
        if (!o.billingAddress && (hit.city || hit.province)) {
          set.billingAddress = { name: hit.name, city: hit.city ?? '', province: hit.province ?? '', phone: hit.phone ?? '' }
        }
        await db!.update(s.salesOrders).set(set).where(eq(s.salesOrders.id, o.id))
        repaired.push({ shopifyId: o.shopifyId ?? o.id, from, to: hit.name })
      } else if (addrName && addrName.toLowerCase() !== 'guest') {
        matched++
        const from = o.customer ?? ''
        const set: Record<string, unknown> = { customer: addrName }
        if (addr?.phone && !o.customerPhone) set.customerPhone = String(addr.phone)
        await db!.update(s.salesOrders).set(set).where(eq(s.salesOrders.id, o.id))
        repaired.push({ shopifyId: o.shopifyId ?? o.id, from, to: addrName })
      } else {
        unmatched.push(o.shopifyId ?? o.id)
      }
    }
    recordCrud('sales_orders', 'Updated', req, { piiRepair: true, repaired: repaired.length })
    res.json({ ok: true, matched, repaired, unmatched })
  } catch (err) {
    logger.error({ err }, 'order PII repair failed')
    res.status(500).json({ error: 'Order PII repair failed' })
  }
})

// ─── E-invoicing (GST IRN) ─────────────────────────────────────────────────
// Mode is a setting: off | manual | automatic. In `automatic` mode a newly
// issued invoice is pushed to the gateway without anyone clicking anything.
dbRouter.get('/einvoice/:invoiceId', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const { resolveEInvoiceMode, isRealGatewayConfigured, resolveProvider } = await import('../einvoice')
    const mode = await resolveEInvoiceMode()
    const [invoice] = await db!.select().from(s.salesInvoices).where(eq(s.salesInvoices.id, routeParam(req.params.invoiceId))).limit(1)
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })
    res.json({
      mode,
      provider: resolveProvider().name,
      gatewayConfigured: isRealGatewayConfigured(),
      status: invoice.irn ? 'generated' : mode === 'off' ? 'disabled' : 'pending',
      irn: invoice.irn ?? null,
      irnDate: invoice.irnDate ?? null,
      qrCode: invoice.qrCode ?? null,
    })
  } catch (err) {
    logger.error({ err }, 'einvoice status failed')
    res.status(500).json({ error: 'Internal server error' })
  }
})

dbRouter.post('/einvoice/:invoiceId/generate', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    if (!requireDb(res)) return
    const { generateEInvoiceForInvoice, resolveEInvoiceMode } = await import('../einvoice')
    const mode = await resolveEInvoiceMode()
    if (mode === 'off') return res.status(400).json({ error: 'E-invoicing is switched off in Settings → Tax & Compliance' })

    const [existing] = await db!.select({ irn: s.salesInvoices.irn }).from(s.salesInvoices).where(eq(s.salesInvoices.id, routeParam(req.params.invoiceId))).limit(1)
    if (!existing) return res.status(404).json({ error: 'Invoice not found' })
    if (existing.irn) return res.status(409).json({ error: 'This invoice already has an IRN', irn: existing.irn })

    const result = await generateEInvoiceForInvoice(routeParam(req.params.invoiceId))
    if (!result.ok) return res.status(502).json({ error: result.error })
    recordCrud('invoices', 'E-invoice generated', req, { invoiceId: routeParam(req.params.invoiceId), irn: result.irn, provider: result.provider })
    res.json({ ok: true, irn: result.irn, irnDate: result.irnDate, qrCode: result.qrCode, provider: result.provider })
  } catch (err) {
    logger.error({ err }, 'einvoice generate failed')
    res.status(500).json({ error: 'Failed to generate IRN' })
  }
})

dbRouter.post('/einvoice/:invoiceId/cancel', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    if (!requireDb(res)) return
    const { cancelEInvoiceForInvoice } = await import('../einvoice')
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim().slice(0, 100) : 'Cancelled by seller'
    const result = await cancelEInvoiceForInvoice(routeParam(req.params.invoiceId), reason)
    if (!result.ok) return res.status(400).json({ error: result.error })
    recordCrud('invoices', 'E-invoice cancelled', req, { invoiceId: routeParam(req.params.invoiceId), reason })
    res.json({ ok: true, cancelDate: result.cancelDate })
  } catch (err) {
    logger.error({ err }, 'einvoice cancel failed')
    res.status(500).json({ error: 'Failed to cancel IRN' })
  }
})

export function round2(value: number): number {
  // Add Number.EPSILON to handle floating-point precision issues (e.g., 1.005 * 100 = 100.4999...)
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/**
 * Apply an invoice's stock delta THROUGH THE LEDGER (stock_levels +
 * stock_movements + the products.stock rollup), all inside the caller's
 * transaction.
 *
 * The old implementation was `UPDATE products SET stock = stock + delta`,
 * which left the availability balances and the audit trail untouched — a
 * manual invoice never reduced what the app treats as shoppable stock, and
 * the rollup silently drifted from the ledger. The historical oversell guard
 * (row lock + insufficient-stock error) is preserved.
 */
async function applyStockDelta(tx: any, sku: string, delta: number): Promise<void> {
  if (!sku || !delta) return
  if (delta < 0) {
    // Centralised guard: one code path owns the "would this go negative?"
    // decision, so manual create/update and the duplicate/convert relays all
    // surface the same structured error the UI highlights.
    await assertStockAvailable(tx, [{ sku, qty: Math.abs(delta) }])
  }
  await applyStockMovement({
    sku,
    qty: delta,
    type: delta < 0 ? 'sale_out' : 'sale_return_in',
    refType: 'invoice',
    tx,
  })
}

/**
 * Turns an InsufficientStockError into the API's 409 response.
 *
 * Returns true when it handled the error, so callers can `catch` and fall
 * through to their generic 400/500 only for anything else. The payload carries
 * the per-product detail the client uses to highlight the offending lines.
 */
function respondInsufficientStock(res: Response, err: unknown): boolean {
  if (!(err instanceof InsufficientStockError)) return false
  res.status(409).json({
    error: 'Insufficient Stock',
    code: 'INSUFFICIENT_STOCK',
    message: err.message,
    products: err.products,
  })
  return true
}

export function normalizeInvoiceItems(raw: unknown, defaultSilverRate?: number): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return []
  return raw
    .map((it) => {
      const item = it && typeof it === 'object' ? (it as Record<string, unknown>) : {}
      const row = sanitize(item, s.salesInvoiceItems)
      delete row.id
      delete row.invoiceId
      row.product = String(item.product ?? item.title ?? '').trim()
      row.sku = String(item.sku ?? '').trim()
      row.qty = Math.max(1, Math.floor(num(item.qty, 1)))
      row.weight = num(item.weight, 0)
      // The rate from Silver Rate Management is AUTHORITATIVE whenever one is
      // available: a client-supplied number is only used as a last-resort
      // fallback so callers that predate rate management (order ingest,
      // duplicates) can still price a line. This is the single choke point the
      // invoice and patch routes share, so a stale or tampered payload can
      // never override the shop's current rate.
      const managedRate = num(defaultSilverRate, 0)
      const providedSilverRate = num(item.silverRate, 0)
      const effectiveSilverRate = managedRate > 0 ? managedRate : providedSilverRate
      row.silverRate = effectiveSilverRate
      row.makingCharge = num(item.makingCharge, 0)
      row.tax = num(item.tax, 0)
      const weight = num(item.weight, 0)
      const makingChargePerGram = num(item.makingCharge, 0)
      if (weight > 0 && effectiveSilverRate > 0) {
        // Correct formula: amount = (silverRate + makingChargePerGram) × weight
        // This matches computeSellingPrice: (rate + makingCharge) × netWeight × 1.03 (without GST)
        const silverValue = round2(weight * effectiveSilverRate)
        const makingValue = round2(weight * makingChargePerGram)
        row.amount = round2(silverValue + makingValue)
      } else {
        row.amount = num(item.amount, 0)
      }
      return row
    })
    .filter((it) => String(it.sku) !== '' || String(it.product) !== '')
}

/**
 * Piece-rate override for invoice lines, given the fixed piece rates keyed by
 * lowercased SKU.
 *
 * A Piece Rate Product bills at its fixed rate × qty: the silver-rate
 * calculation (weight × rate + making charge) that normally produces the line
 * amount does not apply, so the components are cleared with it and the invoice
 * header sums (silverValue / makingCharge) stay consistent with the total.
 */
export function applyPieceRateItems<T extends Record<string, unknown>>(
  items: T[],
  fixedRatesBySku: Map<string, number>,
): T[] {
  if (fixedRatesBySku.size === 0) return items
  return items.map((it) => {
    const fixed = fixedRatesBySku.get(String(it.sku ?? '').trim().toLowerCase())
    if (fixed == null || !(fixed > 0)) return it
    return { ...it, silverRate: 0, makingCharge: 0, amount: round2(fixed * num(it.qty, 1)) } as T
  })
}

/**
 * Loads the fixed piece rates for an invoice's SKUs and rewrites every line
 * that belongs to a Piece Rate Product. Returns the items untouched when no
 * line maps to one, so ordinary invoices never pay for the lookup.
 */
export async function applyPieceRateInvoiceItems<T extends Record<string, unknown>>(
  items: T[],
  client: any = db,
): Promise<T[]> {
  if (items.length === 0 || !client) return items
  const skus = [...new Set(items.map((it) => String(it.sku ?? '').trim()).filter(Boolean))]
  if (skus.length === 0) return items
  const rows = await client
    .select({ sku: s.products.sku, fixedPieceRate: s.products.fixedPieceRate })
    .from(s.products)
    .where(and(inArray(s.products.sku, skus), eq(s.products.pieceRateProduct, true)))
  const rates = new Map<string, number>()
  for (const r of rows) {
    const rate = Number(r.fixedPieceRate)
    if (Number.isFinite(rate) && rate > 0) rates.set(String(r.sku ?? '').trim().toLowerCase(), rate)
  }
  return applyPieceRateItems(items, rates)
}

// Duplicate an existing invoice into a fresh draft (same items/customer, new number, no payment)
dbRouter.post('/invoices/:id/duplicate', requirePermission('sales', 'create'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const [source] = await db!.select().from(s.salesInvoices).where(eq(s.salesInvoices.id, routeParam(req.params.id))).limit(1)
    if (!source) return res.status(404).json({ error: 'Invoice not found' })
    const sourceItems = await db!.select().from(s.salesInvoiceItems).where(eq(s.salesInvoiceItems.invoiceId, source.id))
    if (sourceItems.length === 0) return res.status(400).json({ error: 'Source invoice has no line items to duplicate' })

    // New invoice number using the configured prefix
    const [settingsRow] = await db!.select().from(s.settings).where(eq(s.settings.id, 'app')).limit(1)
    const prefix = settingsRow?.invoicePrefix?.trim() || 'INV-'
    const now = new Date()
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    let invoiceNumber = ''
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = `${prefix}${stamp}${Math.floor(1000 + Math.random() * 9000)}`
      const [clash] = await db!.select({ id: s.salesInvoices.id }).from(s.salesInvoices).where(eq(s.salesInvoices.number, candidate)).limit(1)
      if (!clash) { invoiceNumber = candidate; break }
    }
    if (!invoiceNumber) return res.status(500).json({ error: 'Could not generate invoice number' })

    const newId = randomUUID()
    const row = await db!.transaction(async (tx) => {
      const [created] = await tx.insert(s.salesInvoices).values({
        id: newId,
        number: invoiceNumber,
        customer: source.customer,
        customerEmail: source.customerEmail,
        customerPhone: source.customerPhone,
        customerAddress: source.customerAddress,
        customerCity: source.customerCity,
        customerState: source.customerState,
        customerPincode: source.customerPincode,
        silverValue: source.silverValue,
        makingCharge: source.makingCharge,
        subtotal: source.subtotal,
        gst: source.gst,
        gstAmount: source.gstAmount,
        discount: source.discount,
        grandTotal: source.grandTotal,
        paymentMethod: 'Pending',
        paymentStatus: 'pending',
        status: 'draft',
        date: new Date().toISOString(),
      }).returning()
      for (const it of sourceItems) {
        const { id: _oldId, invoiceId: _oldInvoiceId, ...itemData } = it
        await tx.insert(s.salesInvoiceItems).values({ ...itemData, id: randomUUID(), invoiceId: newId })
      }
      return created
    })
    recordCrud('invoices', 'Created', req, row)
    res.status(201).json(stripHash(row))
  } catch {
    res.status(400).json({ error: 'Failed to duplicate invoice' })
  }
})

// Next free sales-invoice number: the settings prefix plus a date stamp and a
// random run, retried against the unique index (same shape the order-raised
// invoices in orderEmailIngest.ts mint, kept in sync via the shared settings row).
async function nextSalesInvoiceNumber(): Promise<string> {
  const [settingsRow] = await db!.select().from(s.settings).where(eq(s.settings.id, 'app')).limit(1)
  const prefix = settingsRow?.invoicePrefix?.trim() || 'INV-'
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `${prefix}${stamp}${Math.floor(1000 + Math.random() * 9000)}`
    const [clash] = await db!.select({ id: s.salesInvoices.id }).from(s.salesInvoices).where(eq(s.salesInvoices.number, candidate)).limit(1)
    if (!clash) return candidate
  }
  return `${prefix}${stamp}${Date.now().toString().slice(-6)}`
}

dbRouter.post('/invoices', requirePermission('sales', 'create'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const body = req.body ?? {}
    // Fetch the authoritative silver rate from Silver Rate Management for new pricing.
    const latestRate = await getLatestSilverRate()
    if (!latestRate || !latestRate.rate || latestRate.rate <= 0) {
      return res.status(400).json({ error: 'Current silver rate is not available. Please update the rate in Silver Rate Management before creating invoices.' })
    }
    const silverRate = latestRate.rate

    const items = await applyPieceRateInvoiceItems(normalizeInvoiceItems(body.items, silverRate))
    const clean = sanitize(body, s.salesInvoices)
    delete clean.id
    delete clean.items
    // Manual (dialog-raised) invoices carry no number — mint one on the server
    // using the same settings-driven prefix and stamp as order-raised invoices,
    // so both flows share one numbering scheme and the client never invents it.
    if (!clean.number) clean.number = await nextSalesInvoiceNumber()
    // Every dated report (dashboard, GST, HSN, statements, day book) filters on
    // this column — an invoice without one is invisible in all of them.
    if (!clean.date) clean.date = new Date().toISOString()

    const hasItems = items.length > 0
    const gst = num(body.gst, 3)
    const subtotal = hasItems ? round2(items.reduce((a, it) => a + num(it.amount, 0), 0)) : num(clean.subtotal, 0)
    const discount = num(body.discount, 0)
    // Canonical totals: GST on the subtotal, discount off the grand total.
    const totals = invoiceTotals(subtotal, gst, discount)
    const gstAmount = hasItems ? totals.gstAmount : num(clean.gstAmount, totals.gstAmount)
    const grandTotal = hasItems ? totals.grandTotal : num(clean.grandTotal, totals.grandTotal)
    const silverValue = hasItems ? round2(items.reduce((a, it) => a + num(it.weight, 0) * num(it.silverRate, 0), 0)) : num(clean.silverValue, 0)
    // makingCharge in items is per-gram; header total must multiply by weight
    const makingCharge = hasItems ? round2(items.reduce((a, it) => a + num(it.makingCharge, 0) * num(it.weight, 0), 0)) : num(clean.makingCharge, 0)

    const id = randomUUID()
    const row = await db!.transaction(async (tx) => {
      // Validate the WHOLE basket before writing anything, so two lines of the
      // same SKU are checked against their combined demand and a shortfall
      // aborts the transaction without saving the invoice or deducting stock.
      await assertStockAvailable(
        tx,
        items.map((it) => ({ sku: String(it.sku ?? ''), qty: num(it.qty, 0), name: String(it.product ?? '') })),
      )
      const [invoice] = await tx
        .insert(s.salesInvoices)
        .values({
          ...clean,
          id,
          subtotal,
          gst,
          gstAmount,
          discount,
          grandTotal,
          silverValue,
          makingCharge,
        } as any)
        .returning()
      for (const it of items) {
        await tx.insert(s.salesInvoiceItems).values({ ...it, id: randomUUID(), invoiceId: id })
        await applyStockDelta(tx, String(it.sku ?? ''), -num(it.qty, 0))
      }
      return invoice
    })

    recordCrud('invoices', 'Created', req, row)
    // Loyalty: award points on new invoices (fire-and-forget, never blocks billing)
    void import('../loyalty').then(({ earnForInvoice }) =>
      earnForInvoice({ id: row.id, number: row.number ?? '', customer: row.customer ?? '', grandTotal: row.grandTotal, status: row.status }),
    )
    // E-invoicing: in `automatic` mode every new invoice is pushed to the
    // gateway straight away. Fire-and-forget so billing is never blocked.
    void import('../einvoice')
      .then(async ({ resolveEInvoiceMode, generateEInvoiceForInvoice }) => {
        if ((await resolveEInvoiceMode()) !== 'automatic') return
        const result = await generateEInvoiceForInvoice(row.id)
        if (!result.ok) logger.error({ err: result.error, invoice: row.number }, 'automatic IRN generation failed')
      })
      .catch(() => undefined)
    res.status(201).json(stripHash(row))
  } catch (err) {
    if (respondInsufficientStock(res, err)) return
    logger.error({ err }, 'invoice creation failed')
    res.status(400).json({ error: 'Failed to create invoice' })
  }
})

dbRouter.patch('/invoices/:id', requirePermission('sales', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const body = req.body ?? {}
    const clean = sanitize(body, s.salesInvoices)
    delete clean.id
    delete clean.items

    // Fetch the authoritative silver rate for any new/replaced items.
    // If items are provided without explicit silverRate, use the current managed rate.
    let silverRate: number | undefined
    if (body.items && Array.isArray(body.items) && body.items.length > 0) {
      const latestRate = await getLatestSilverRate()
      if (!latestRate || !latestRate.rate || latestRate.rate <= 0) {
        return res.status(400).json({ error: 'Current silver rate is not available. Please update the rate in Silver Rate Management before updating invoice items.' })
      }
      silverRate = latestRate.rate
    }

    const row = await db!.transaction(async (tx) => {
      const [existing] = await tx.select().from(s.salesInvoices).where(eq(s.salesInvoices.id, routeParam(req.params.id))).limit(1)
      if (!existing) return null
      const items = await applyPieceRateInvoiceItems(normalizeInvoiceItems(body.items, silverRate), tx)
      if (items.length > 0) {
        // First, restore old stock
        const oldItems = await tx.select().from(s.salesInvoiceItems).where(eq(s.salesInvoiceItems.invoiceId, routeParam(req.params.id)))
        for (const oi of oldItems) {
          await applyStockDelta(tx, String(oi.sku ?? ''), num(oi.qty, 0))
        }
        // Old stock is back, so the new basket is validated against the
        // restored headroom — as a whole, so duplicate lines cannot oversell.
        // A shortfall aborts the transaction and the restore rolls back too,
        // leaving the invoice and its stock exactly as they were.
        await assertStockAvailable(
          tx,
          items.map((it) => ({ sku: String(it.sku ?? ''), qty: num(it.qty, 0), name: String(it.product ?? '') })),
        )
        // Delete old items
        await tx.delete(s.salesInvoiceItems).where(eq(s.salesInvoiceItems.invoiceId, routeParam(req.params.id)))
        // Insert new items and deduct stock
        for (const it of items) {
          await tx.insert(s.salesInvoiceItems).values({ ...it, id: randomUUID(), invoiceId: routeParam(req.params.id) })
          await applyStockDelta(tx, String(it.sku ?? ''), -num(it.qty, 0))
        }
        const gst = num(body.gst, num(existing.gst, 3))
        const subtotal = round2(items.reduce((a, it) => a + num(it.amount, 0), 0))
        const discount = num(body.discount, num(existing.discount, 0))
        const { gstAmount, grandTotal } = invoiceTotals(subtotal, gst, discount)
        const silverValue = round2(items.reduce((a, it) => a + num(it.weight, 0) * num(it.silverRate, 0), 0))
        // makingCharge in items is per-gram; header total must multiply by weight
        const makingCharge = round2(items.reduce((a, it) => a + num(it.makingCharge, 0) * num(it.weight, 0), 0))
        clean.subtotal = subtotal
        clean.gst = gst
        clean.gstAmount = gstAmount
        clean.discount = discount
        clean.grandTotal = grandTotal
        clean.silverValue = silverValue
        clean.makingCharge = makingCharge
      } else if (clean.discount !== undefined || clean.gst !== undefined) {
        // Header-only edit that changes discount/GST: recompute the totals
        // from the existing subtotal so grandTotal never goes stale. No items
        // were sent, so stock is untouched.
        const subtotal = num(existing.subtotal, 0)
        const gst = num(clean.gst ?? existing.gst, 3)
        const discount = num(clean.discount ?? existing.discount, 0)
        const { gstAmount, grandTotal } = invoiceTotals(subtotal, gst, discount)
        clean.gstAmount = gstAmount
        clean.grandTotal = grandTotal
      }
      if (Object.keys(clean).length === 0) return existing
      const [updated] = await tx.update(s.salesInvoices).set(clean).where(eq(s.salesInvoices.id, routeParam(req.params.id))).returning()
      return updated
    })

    if (!row) return res.status(404).json({ error: 'Not found' })
    recordCrud('invoices', 'Updated', req, row)

    // Marking an invoice cancelled / refunded gives back the loyalty points it
    // earned (the earn entry is skipped when an invoice is voided up front).
    const nextStatus = String(row.status ?? '').toLowerCase()
    if (nextStatus === 'cancelled' || nextStatus === 'refunded') {
      void import('../loyalty')
        .then(({ reverseEarnedForInvoice }) =>
          reverseEarnedForInvoice({
            id: row.id,
            number: row.number,
            customer: String(row.customer ?? ''),
            reason: `Reversed — invoice ${row.number} marked ${nextStatus}`,
          }),
        )
        .catch(() => undefined)
    }

    res.json(stripHash(row))
  } catch (err) {
    if (respondInsufficientStock(res, err)) return
    res.status(400).json({ error: 'Failed to update invoice' })
  }
})

dbRouter.delete('/invoices/:id', requirePermission('sales', 'delete'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const removed = await db!.transaction(async (tx) => {
      const [existing] = await tx.select().from(s.salesInvoices).where(eq(s.salesInvoices.id, routeParam(req.params.id))).limit(1)
      if (!existing) return null
      const items = await tx.select().from(s.salesInvoiceItems).where(eq(s.salesInvoiceItems.invoiceId, routeParam(req.params.id)))
      for (const it of items) {
        await applyStockDelta(tx, String(it.sku ?? ''), num(it.qty, 0))
      }
      await tx.delete(s.salesInvoiceItems).where(eq(s.salesInvoiceItems.invoiceId, routeParam(req.params.id)))
      await tx.delete(s.salesInvoices).where(eq(s.salesInvoices.id, routeParam(req.params.id)))
      recordCrud('invoices', 'Deleted', req, existing)
      return existing
    })
    if (!removed) return res.status(404).json({ error: 'Not found' })
    // Deleting an invoice must undo everything it granted: stock is restored
    // above, and the loyalty points it earned go back too — the same rule as
    // marking it cancelled/refunded. Fire-and-forget so the delete never
    // blocks; reverseEarnedForInvoice tolerates the now-missing invoice row
    // (it falls back to reversing the full outstanding balance).
    void import('../loyalty')
      .then(({ reverseEarnedForInvoice }) =>
        reverseEarnedForInvoice({
          id: removed.id,
          number: String(removed.number ?? ''),
          customer: String(removed.customer ?? ''),
          reason: `Reversed — invoice ${removed.number} deleted`,
        }),
      )
      .catch(() => undefined)
    res.json({ ok: true, id: routeParam(req.params.id) })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

dbRouter.get('/sales-orders', listOf(s.salesOrders, s.salesOrders.date))
dbRouter.get('/sales-orders/:id', oneOf(s.salesOrders, s.salesOrders.id))

/** Raise an invoice for an order that doesn't have one yet (inline action). */
dbRouter.post('/sales-orders/:id/create-invoice', requirePermission('sales', 'create'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const [order] = await db!.select().from(s.salesOrders).where(eq(s.salesOrders.id, routeParam(req.params.id))).limit(1)
    if (!order) return res.status(404).json({ error: 'Order not found' })
    const { createInvoiceForOrderRow } = await import('../orderEmailIngest')
    const existing = order.invoice
    const invoiceNumber = await createInvoiceForOrderRow(order)
    if (invoiceNumber && !existing) {
      const [fresh] = await db!.select().from(s.salesOrders).where(eq(s.salesOrders.id, routeParam(req.params.id))).limit(1)
      if (fresh) recordCrud('sales-orders', 'Updated', req, fresh)
      await insertOrderEvent(routeParam(req.params.id), 'Invoice Created', `Invoice ${invoiceNumber} generated`, actorFromRequest(req).userId ?? 'system')
    }
    res.json({ created: Boolean(invoiceNumber) && !existing, invoiceNumber })
  } catch (err) {
    logger.error({ err }, 'create-invoice for order failed')
    res.status(500).json({ error: 'Failed to create invoice from order' })
  }
})

/**
 * Cancel an order's current invoice and raise a fresh one from the order's
 * line items. Cancel reverses everything the invoice granted — the stock it
 * sold goes back into inventory and the loyalty points it earned are
 * reversed — then the order is re-invoiced from scratch (new number, items
 * rebuilt from the order, stock deducted again). The order stays linked via
 * its `invoice` column, which is rewritten to the new number.
 */
dbRouter.post('/sales-orders/by-invoice/:invoice/reinvoice', requirePermission('sales', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    // Resolve the order by the invoice number it is currently linked to —
    // that is the number the invoices screen is looking at.
    const invoiceKey = routeParam(req.params.invoice)
    const [order] = await db!.select().from(s.salesOrders).where(eq(s.salesOrders.invoice, invoiceKey)).limit(1)
    if (!order) return res.status(404).json({ error: 'No order is linked to that invoice' })
    if (!order.invoice) return res.status(400).json({ error: 'This order has no invoice to replace' })
    const lineItems = Array.isArray(order.lineItems) ? order.lineItems : []
    if (lineItems.length === 0) return res.status(400).json({ error: 'This order has no line items to re-invoice' })

    // Cancel the current invoice: reverse the stock its lines sold, then
    // remove it. Loyalty reversal runs after, keyed off the removed invoice.
    const cancelledNumber = String(order.invoice)
    const removed = await db!.transaction(async (tx) => {
      const [existing] = await tx.select().from(s.salesInvoices).where(eq(s.salesInvoices.number, cancelledNumber)).limit(1)
      if (!existing) return null
      const items = await tx.select().from(s.salesInvoiceItems).where(eq(s.salesInvoiceItems.invoiceId, existing.id))
      for (const it of items) {
        await applyStockDelta(tx, String(it.sku ?? ''), num(it.qty, 0))
      }
      await tx.delete(s.salesInvoiceItems).where(eq(s.salesInvoiceItems.invoiceId, existing.id))
      await tx.delete(s.salesInvoices).where(eq(s.salesInvoices.id, existing.id))
      // Unlink so createInvoiceForOrderRow will raise the fresh one.
      await tx.update(s.salesOrders).set({ invoice: null }).where(eq(s.salesOrders.id, order.id))
      return existing
    })
    if (!removed) return res.status(404).json({ error: `Invoice ${cancelledNumber} not found` })
    recordCrud('invoices', 'Deleted', req, removed)
    void import('../loyalty')
      .then(({ reverseEarnedForInvoice }) =>
        reverseEarnedForInvoice({
          id: removed.id,
          number: String(removed.number ?? ''),
          customer: String(removed.customer ?? ''),
          reason: `Reversed — invoice ${removed.number} cancelled for re-issue`,
        }),
      )
      .catch(() => undefined)

    // Re-raise from the order's line items (same pipeline as first raise).
    const [freshOrder] = await db!.select().from(s.salesOrders).where(eq(s.salesOrders.id, order.id)).limit(1)
    const { createInvoiceForOrderRow } = await import('../orderEmailIngest')
    const invoiceNumber = await createInvoiceForOrderRow(freshOrder!)
    if (!invoiceNumber) return res.status(500).json({ error: 'Re-invoice failed: no new invoice was created' })
    recordCrud('sales-orders', 'Updated', req, { id: order.id, invoice: invoiceNumber })
    await insertOrderEvent(order.id, 'Invoice Reissued', `Invoice ${cancelledNumber} cancelled and reissued as ${invoiceNumber}`, actorFromRequest(req).userId ?? 'system')
    res.json({ ok: true, cancelled: cancelledNumber, invoiceNumber })
  } catch (err) {
    logger.error({ err }, 'reinvoice for order failed')
    res.status(500).json({ error: 'Failed to cancel and reissue invoice' })
  }
})

// ─── Bulk product import (CSV rows parsed client-side) ───────────────────────
const PRODUCT_FIELD_ALIASES: Record<string, string> = {
  name: 'name', title: 'name', product: 'name', 'product name': 'name',
  sku: 'sku', 'item code': 'sku', code: 'sku',
  category: 'category', type: 'category',
  collection: 'collection',
  purity: 'purity',
  grossweight: 'grossWeight', 'gross weight': 'grossWeight',
  stoneweight: 'stoneWeight', 'stone weight': 'stoneWeight',
  netweight: 'netWeight', 'net weight': 'netWeight',
  makingcharge: 'makingCharge', 'making charge': 'makingCharge', mc: 'makingCharge',
  gst: 'gst', 'gst rate': 'gst',
  hsn: 'hsn', 'hsn code': 'hsn',
  supplier: 'supplier',
  silverrate: 'silverRate', 'silver rate': 'silverRate', rate: 'silverRate',
  sellingprice: 'sellingPrice', 'selling price': 'sellingPrice', price: 'sellingPrice',
  compareatprice: 'compareAtPrice', 'compare at price': 'compareAtPrice', mrp: 'compareAtPrice',
  stock: 'stock', quantity: 'stock', qty: 'stock',
  reorderlevel: 'reorderLevel', 'reorder level': 'reorderLevel',
  status: 'status',
  vendor: 'vendor',
  producttype: 'productType', 'product type': 'productType',
  tags: 'tags',
  huid: 'huid',
  metal: 'metal',
  puritylabel: 'purityLabel', 'purity label': 'purityLabel', purityLabel: 'purityLabel',
  diamondweight: 'diamondWeight', 'diamond weight': 'diamondWeight', diamondWeight: 'diamondWeight',
}

function normalizeHeader(h: string): string {
  const key = h.trim().toLowerCase().replace(/[\s_-]+/g, ' ')
  return PRODUCT_FIELD_ALIASES[key] ?? PRODUCT_FIELD_ALIASES[key.replace(/\s/g, '')] ?? ''
}

function toNum(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(String(v).replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** The text columns both CSV import routes write for every row. */
function importRowText(mapped: Record<string, string>): Record<string, string | null> {
  return {
    name: mapped.name ?? '',
    category: mapped.category ?? 'Imported',
    hsn: mapped.hsn ?? null,
    supplier: mapped.supplier ?? null,
    status: mapped.status ?? 'active',
    vendor: mapped.vendor ?? null,
    productType: mapped.productType ?? null,
    tags: mapped.tags ?? null,
    huid: mapped.huid ?? null,
  }
}

/**
 * One CSV row's write plan, shared by /products/bulk-import and
 * /products/import-csv so both apply the same collection rules:
 *   • a `collection` cell naming a pricing collection links the row by stable
 *     id (and to that collection's matching category, if any);
 *   • a fixed-price collection requires one of its categories (that is where
 *     the SKU prefix comes from) and a selling price, and stores the price as
 *     the product's fixed price — never as silver-rate input;
 *   • rows without a collection cell keep their existing grouping and their
 *     silver-rate pricing, exactly as before.
 * `error` means the row must be skipped and reported.
 */
function planImportRow(
  lookup: CollectionLookup,
  mapped: Record<string, string>,
  numeric: { sellingPrice: number | null },
  rowNo: number,
  sku: string,
  existingPrice?: number | null,
): { text: Record<string, string | null>; pricing: Record<string, unknown> | null; error: string | null } {
  const association = importRowAssociation(lookup, mapped, importRowText(mapped))
  const { text, collection, category } = association
  const fixed = collection?.pricingType === 'fixed'
  if (fixed && !category) {
    return {
      text,
      pricing: null,
      error: `Row ${rowNo} (${sku}): "${collection!.name}" is fixed-price and needs one of its categories — create it under Inventory → Collections & Categories first — skipped`,
    }
  }
  if (!fixed) return { text, pricing: null, error: null }
  const price = numeric.sellingPrice ?? existingPrice ?? null
  if (price == null || !Number.isFinite(price) || price <= 0) {
    return {
      text,
      pricing: null,
      error: `Row ${rowNo} (${sku}): fixed-price products need a selling price — skipped`,
    }
  }
  return {
    text,
    pricing: { sellingPrice: price, fixedPieceRate: price, pieceRateProduct: true, silverRate: null },
    error: null,
  }
}

dbRouter.post('/products/bulk-import', requirePermission('inventory', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const rawRows: unknown[] = Array.isArray(req.body?.rows) ? req.body.rows : []
    if (rawRows.length === 0) return res.status(400).json({ error: 'rows is required (array of objects with CSV headers as keys)' })
    if (rawRows.length > 2000) return res.status(400).json({ error: 'Maximum 2000 rows per import' })

    const errors: string[] = []
    let created = 0
    let updated = 0

    // Load existing products by normalized SKU for upsert
    const existing = await db!
      .select({ id: s.products.id, sku: s.products.sku, sellingPrice: s.products.sellingPrice })
      .from(s.products)
    const bySku = new Map(existing.map((p) => [p.sku.trim().toLowerCase(), p]))

    // A `collection` cell that names a pricing collection links to it by stable
    // id, so the row lands in the right group with the right pricing model.
    // Rows without that column keep exactly the old behaviour: free-text
    // grouping, silver-rate pricing, no association written.
    const lookup = await loadCollectionLookup(db!)

    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i] as Record<string, unknown>
      if (!raw || typeof raw !== 'object') continue
      const mapped: Record<string, string> = {}
      for (const [k, v] of Object.entries(raw)) {
        const field = normalizeHeader(k)
        if (field && v != null && String(v).trim() !== '') mapped[field] = String(v).trim()
      }
      const rowNo = i + 2 // +2: header row + 1-indexed
      const name = mapped.name
      const sku = mapped.sku
      if (!name) { errors.push(`Row ${rowNo}: missing name — skipped`); continue }
      if (!sku) { errors.push(`Row ${rowNo}: missing SKU — skipped`); continue }
      const skuKey = sku.toLowerCase()
      const numeric = {
        purity: toNum(mapped.purity),
        grossWeight: toNum(mapped.grossWeight),
        stoneWeight: toNum(mapped.stoneWeight),
        netWeight: toNum(mapped.netWeight),
        makingCharge: toNum(mapped.makingCharge),
        gst: toNum(mapped.gst),
        silverRate: toNum(mapped.silverRate),
        sellingPrice: toNum(mapped.sellingPrice),
        compareAtPrice: toNum(mapped.compareAtPrice),
        stock: toNum(mapped.stock),
        reorderLevel: toNum(mapped.reorderLevel),
      }
      const hit = bySku.get(skuKey)
      const plan = planImportRow(lookup, mapped, numeric, rowNo, sku, hit?.sellingPrice ?? null)
      if (plan.error) { errors.push(plan.error); continue }
      const text = plan.text
      try {
        if (hit) {
          const patch: Record<string, unknown> = { ...text }
          for (const [k, v] of Object.entries(numeric)) if (v != null) patch[k] = v
          // The collection's pricing model wins over whatever the columns say.
          Object.assign(patch, plan.pricing ?? {})
          await db!.update(s.products).set(patch).where(eq(s.products.id, hit.id))
          updated++
        } else {
          const values: Record<string, unknown> = {
            id: randomUUID(), sku, ...text, ...numeric,
            stock: numeric.stock ?? 0,
            reorderLevel: numeric.reorderLevel ?? 5,
            purity: numeric.purity ?? 92.5,
            trackInventory: true,
            chargeOnTax: true,
            // Full timestamp: the products list orders newest-first and
            // same-day products must not tie.
            createdAt: new Date().toISOString(),
          }
          Object.assign(values, plan.pricing ?? {})
          const [row] = await db!.insert(s.products).values(values as typeof s.products.$inferInsert).returning()
          bySku.set(skuKey, { id: row.id, sku, sellingPrice: row.sellingPrice })
          created++
        }
      } catch (rowErr) {
        const base = rowErr instanceof Error ? rowErr.message : 'insert failed'
        const cause = rowErr instanceof Error && (rowErr as any).cause ? String((rowErr as any).cause?.message ?? (rowErr as any).cause) : ''
        errors.push(`Row ${rowNo} (${sku}): ${`${base} ${cause}`.replace(/\s+/g, ' ')}`)
      }
    }
    recordCrud('products', 'Created', req, { created, updated })
    res.json({ created, updated, errors })
  } catch (err) {
    logger.error({ err }, 'bulk import failed')
    res.status(500).json({ error: 'Bulk import failed' })
  }
})

// ─── Bulk image upload, auto-matched to products by SKU from filename ────────
// Own body limit: batches of data-URL images dwarf the global 1mb json limit
// (200-image cap × up to 8MB per image → allow up to 25mb like /uploads/image)
dbRouter.post('/products/bulk-images', requirePermission('inventory', 'edit'), expressJson({ limit: '25mb' }), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const images: Array<{ filename?: unknown; dataUrl?: unknown }> = Array.isArray(req.body?.images) ? req.body.images : []
    if (images.length === 0) return res.status(400).json({ error: 'images is required ([{ filename, dataUrl }])' })
    if (images.length > 200) return res.status(400).json({ error: 'Maximum 200 images per batch' })

    const { saveUploadedImage } = await import('../uploads')
    const all = await db!.select({ id: s.products.id, sku: s.products.sku }).from(s.products)
    const bySku = new Map(all.map((p) => [p.sku.trim().toLowerCase(), p.id]))

    let matched = 0
    const unmatched: string[] = []
    const errors: string[] = []
    for (const img of images) {
      const filename = typeof img.filename === 'string' ? img.filename : ''
      const dataUrl = typeof img.dataUrl === 'string' ? img.dataUrl : ''
      if (!filename || !dataUrl) { errors.push(`${filename || 'image'}: missing filename or data`); continue }
      const base = filename.split('/').pop() ?? filename
      const sku = base.replace(/\.[^.]+$/, '').trim().toLowerCase()
      const productId = bySku.get(sku)
      if (!productId) { unmatched.push(filename); continue }
      const path = saveUploadedImage(dataUrl)
      if (!path) { errors.push(`${filename}: invalid image data (must be a data:image/... URL)`); continue }
      const [prod] = await db!.select({ images: s.products.images, image: s.products.image }).from(s.products).where(eq(s.products.id, productId)).limit(1)
      const gallery = Array.isArray(prod?.images) ? (prod!.images as string[]) : []
      if (!gallery.includes(path)) gallery.push(path)
      await db!.update(s.products).set({ images: gallery, image: prod?.image ?? path }).where(eq(s.products.id, productId))
      matched++
    }
    res.json({ matched, unmatched, errors })
  } catch (err) {
    logger.error({ err }, 'bulk image match failed')
    res.status(500).json({ error: 'Bulk image upload failed' })
  }
})

// ─── Products CSV Import (server-side CSV parse + field mapping) ───────────
dbRouter.post('/products/import-csv', requirePermission('inventory', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const csvText = typeof req.body?.csv === 'string' ? req.body.csv : ''
    if (!csvText.trim()) return res.status(400).json({ error: 'csv is required (raw CSV text)' })

    const lines = csvText.split(/\r?\n/).filter((l: string) => l.trim() !== '')
    if (lines.length < 2) return res.status(400).json({ error: 'CSV must have a header row and at least one data row' })
    if (lines.length > 2001) return res.status(400).json({ error: 'Maximum 2000 data rows per import' })

    const splitCsvLine = (line: string): string[] => {
      const out: string[] = []
      let cur = ''
      let inQ = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"') {
          if (inQ && line[i + 1] === '"') { cur += '"'; i++ } else inQ = !inQ
        } else if (ch === ',' && !inQ) { out.push(cur); cur = '' } else cur += ch
      }
      out.push(cur)
      return out.map((c) => c.trim())
    }

    const headers = splitCsvLine(lines[0])
    const rawRows: Array<Record<string, string>> = lines.slice(1).map((line: string) => {
      const cells = splitCsvLine(line)
      const row: Record<string, string> = {}
      headers.forEach((h, i) => { if (cells[i] !== undefined && cells[i] !== '') row[h] = cells[i] })
      return row
    })

    if (rawRows.length === 0) return res.status(400).json({ error: 'No data rows found in CSV' })

    const errors: string[] = []
    let created = 0
    let updated = 0

    const existing = await db!
      .select({ id: s.products.id, sku: s.products.sku, sellingPrice: s.products.sellingPrice })
      .from(s.products)
    const bySku = new Map(existing.map((p) => [p.sku.trim().toLowerCase(), p]))

    // See planImportRow: a `collection` cell links the row to its stable
    // collection/category and applies that collection's pricing model.
    const lookup = await loadCollectionLookup(db!)

    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i]
      const mapped: Record<string, string> = {}
      for (const [k, v] of Object.entries(raw)) {
        const field = normalizeHeader(k)
        if (field && v != null && String(v).trim() !== '') mapped[field] = String(v).trim()
      }
      const rowNo = i + 2
      const name = mapped.name
      const sku = mapped.sku
      if (!name) { errors.push(`Row ${rowNo}: missing name — skipped`); continue }
      if (!sku) { errors.push(`Row ${rowNo}: missing SKU — skipped`); continue }
      const skuKey = sku.toLowerCase()
      const numeric = {
        purity: toNum(mapped.purity),
        grossWeight: toNum(mapped.grossWeight),
        stoneWeight: toNum(mapped.stoneWeight),
        netWeight: toNum(mapped.netWeight),
        makingCharge: toNum(mapped.makingCharge),
        gst: toNum(mapped.gst),
        silverRate: toNum(mapped.silverRate),
        sellingPrice: toNum(mapped.sellingPrice),
        compareAtPrice: toNum(mapped.compareAtPrice),
        stock: toNum(mapped.stock),
        reorderLevel: toNum(mapped.reorderLevel),
      }
      const hit = bySku.get(skuKey)
      const plan = planImportRow(lookup, mapped, numeric, rowNo, sku, hit?.sellingPrice ?? null)
      if (plan.error) { errors.push(plan.error); continue }
      const text = plan.text
      try {
        if (hit) {
          const patch: Record<string, unknown> = { ...text }
          for (const [k, v] of Object.entries(numeric)) if (v != null) patch[k] = v
          // The collection's pricing model wins over whatever the columns say.
          Object.assign(patch, plan.pricing ?? {})
          await db!.update(s.products).set(patch).where(eq(s.products.id, hit.id))
          updated++
        } else {
          const values: Record<string, unknown> = {
            id: randomUUID(), sku, ...text, ...numeric,
            stock: numeric.stock ?? 0,
            reorderLevel: numeric.reorderLevel ?? 5,
            purity: numeric.purity ?? 92.5,
            trackInventory: true,
            chargeOnTax: true,
            // Full timestamp: the products list orders newest-first and
            // same-day products must not tie.
            createdAt: new Date().toISOString(),
          }
          Object.assign(values, plan.pricing ?? {})
          const [row] = await db!.insert(s.products).values(values as typeof s.products.$inferInsert).returning()
          bySku.set(skuKey, { id: row.id, sku, sellingPrice: row.sellingPrice })
          created++
        }
      } catch (rowErr) {
        const base = rowErr instanceof Error ? rowErr.message : 'insert failed'
        const cause = rowErr instanceof Error && (rowErr as any).cause ? String((rowErr as any).cause?.message ?? (rowErr as any).cause) : ''
        errors.push(`Row ${rowNo} (${sku}): ${`${base} ${cause}`.replace(/\s+/g, ' ')}`)
      }
    }
    recordCrud('products', 'Created', req, { created, updated })
    res.json({ ok: true, imported: created + updated, created, updated, errors })
  } catch (err) {
    logger.error({ err }, 'CSV import failed')
    res.status(500).json({ error: 'CSV import failed' })
  }
})

// ─── Order status pipeline (kanban drag & drop) ──────────────────────────────
/**
 * Auto-raise the sales invoice when an order lands in the fulfilled stage.
 *
 * Idempotent (createInvoiceForOrderRow returns the existing number when the
 * order is already invoiced) and non-blocking: a failure here must never
 * undo the status move the user just asked for, so errors are logged and
 * swallowed. Returns the invoice number when one exists after the call.
 */
export async function autoInvoiceFulfilledOrder(
  order: typeof s.salesOrders.$inferSelect,
  actor: { userId?: string | null; ip?: string | null },
): Promise<string | null> {
  if (!db || order.invoice) return order.invoice ?? null
  try {
    const { createInvoiceForOrderRow } = await import('../orderEmailIngest')
    const invoiceNumber = await createInvoiceForOrderRow(order)
    if (invoiceNumber) {
      await insertOrderEvent(order.id, 'Invoice Created', `Invoice ${invoiceNumber} generated automatically on fulfilment`, actor.userId ?? 'system')
      void recordActivity({
        action: 'Auto-Invoiced Order',
        module: 'sales',
        entity: order.internalId ?? order.id,
        details: `Invoice ${invoiceNumber} created on fulfilment`,
        userId: actor.userId,
        ip: actor.ip,
      })
    }
    return invoiceNumber
  } catch (err) {
    logger.error({ err, orderId: order.id }, 'auto-invoice on fulfilment failed')
    return null
  }
}

dbRouter.patch('/sales-orders/:id/status', requirePermission('sales', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const status = String(req.body?.status ?? '').trim()
    const allowed = ['imported', 'confirmed', 'processing', 'fulfilled', 'cancelled']
    if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` })
    const [row] = await db!.update(s.salesOrders).set({ status }).where(eq(s.salesOrders.id, routeParam(req.params.id))).returning()
    if (!row) return res.status(404).json({ error: 'Order not found' })
    const actor = actorFromRequest(req)
    await insertOrderEvent(row.id, 'Status Change', `Status moved to ${status}`, actor.userId ?? 'system')
    void recordActivity({
      action: 'Updated Order Status',
      module: 'sales',
      entity: row.internalId ?? row.id,
      details: `Status → ${status}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    // Receiving the order (fulfilled stage) raises its sales invoice
    // automatically — the same idempotent pipeline the manual button uses.
    let autoInvoice: string | null = null
    if (status === 'fulfilled') autoInvoice = await autoInvoiceFulfilledOrder(row, actor)
    res.json({ ...row, autoInvoice })
  } catch {
    res.status(400).json({ error: 'Failed to update order status' })
  }
})

// ─── Returns & credit notes: return invoice items, restock, credit note ─────
// Quantity-aware: a return only consumes the returnable quantity of the SKUs
// in its payload (sold minus previously returned), and the invoice status is
// derived from the cumulative quantities — 'partially_returned' /
// 'fully_returned' — instead of the blanket 'refunded' the old handler left
// to a whole-invoice status flip.
dbRouter.post('/invoices/:id/return', requirePermission('sales', 'create'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const [invoice] = await db!.select({ id: s.salesInvoices.id, customer: s.salesInvoices.customer, number: s.salesInvoices.number })
      .from(s.salesInvoices)
      .where(eq(s.salesInvoices.id, routeParam(req.params.id)))
      .limit(1)
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })

    // Lock the invoice before applying the idempotent return transaction.
    const outcome = await db!.transaction(async (tx) => {
      await tx.select({ id: s.salesInvoices.id })
        .from(s.salesInvoices)
        .where(eq(s.salesInvoices.id, routeParam(req.params.id)))
        .limit(1)
        .for('update')
      return applyInvoiceReturn(tx, routeParam(req.params.id), {
        items: req.body?.items,
        restock: req.body?.restock,
        // The client generates one key per intended return; a retry with the
        // same key replays that credit note instead of double-restocking.
        idempotencyKey: typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined,
      })
    })

    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error })
    const { result } = outcome
    recordCrud('sales-returns', 'Created', req, { id: result.returnId, number: result.creditNoteNumber, invoiceId: routeParam(req.params.id), amount: result.amount, quantity: result.quantity })
    // Give back the points earned on the value being returned.
    void import('../loyalty')
      .then(({ reverseEarnedForInvoice }) =>
        reverseEarnedForInvoice({
          id: invoice.id,
          number: result.invoiceNumber,
          customer: String(invoice.customer ?? ''),
          value: result.amount,
          reason: `Reversed on return — credit note ${result.creditNoteNumber} (₹${result.amount.toLocaleString('en-IN')})`,
        }),
      )
      .catch(() => undefined)
    await insertOrderEvent(invoice.id, 'Return Processed', `Credit note ${result.creditNoteNumber} — ${result.quantity} item(s), ₹${result.amount.toLocaleString('en-IN')}${result.restocked ? ', restocked' : ''}`, actorFromRequest(req).userId ?? 'system')
    void import('../statusNotifications').then((m) => m.notifyReturnProcessed({ customer: invoice.customer, invoiceNumber: result.invoiceNumber, amount: result.amount, restocked: result.restocked, creditNoteNumber: result.creditNoteNumber })).catch(() => undefined)

    res.json({
      returnId: result.returnId,
      creditNoteNumber: result.creditNoteNumber,
      invoiceNumber: result.invoiceNumber,
      amount: result.amount,
      restocked: result.restocked,
      returnStatus: result.status,
      lines: result.lines,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    const cause = (err as { cause?: unknown })?.cause instanceof Error ? (err as Error & { cause: Error }).cause.message : ''
    logger.error({ err }, 'invoice return failed')
    const isDuplicate = /unique|duplicate key/i.test(`${msg} ${cause}`)
    res.status(isDuplicate ? 400 : 500).json({ error: isDuplicate ? 'That credit note number already exists — retry the return' : 'Failed to process return' })
  }
})

// The return dialog's per-line truth: sold / previously returned / remaining |
// returnable quantities per SKU plus the cumulative amount credited so far.
// The UI reads this on open, so a partially returned invoice shows only what
// is actually returnable and the Return action stays available until the
// eligible quantity is exhausted.
dbRouter.get('/invoices/:id/return-status', requirePermission('sales', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const [invoice] = await db!.select({ id: s.salesInvoices.id, number: s.salesInvoices.number, status: s.salesInvoices.status })
      .from(s.salesInvoices)
      .where(eq(s.salesInvoices.id, routeParam(req.params.id)))
      .limit(1)
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })
    const invItems = await db!.select().from(s.salesInvoiceItems).where(eq(s.salesInvoiceItems.invoiceId, invoice.id))
    const priorRows = await db!.select({ status: s.salesReturns.status, returnItems: s.salesReturns.returnItems, amount: s.salesReturns.amount })
      .from(s.salesReturns)
      .where(eq(s.salesReturns.invoiceId, invoice.id))
    const returned = aggregateReturnedBySku(priorRows)
    const lines = summarizeReturnLines(invItems, returned)
    // Amount credited so far = sum of every non-cancelled credit note's payload.
    const totalReturnedAmount = Math.round(priorRows
      .filter((r) => String(r.status ?? '').toLowerCase() !== 'cancelled')
      .reduce((a, r) => a + Number(r.amount ?? 0), 0) * 100) / 100
    res.json({
      invoiceId: invoice.id,
      number: invoice.number,
      status: invoice.status,
      returnStatus: nextInvoiceStatus(lines),
      anyReturnable: lines.some((l) => l.remaining > 0),
      totalReturnedAmount,
      lines,
    })
  } catch (err) {
    logger.error({ err }, 'invoice return-status failed')
    res.status(500).json({ error: 'Failed to load return status' })
  }
})

// ─── Booking orders: advance payment, convert to invoice on completion ──────
dbRouter.post('/bookings', requirePermission('sales', 'create'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const customer = String(req.body?.customer ?? '').trim()
    const rawItems: Array<{ product?: unknown; sku?: unknown; qty?: unknown; price?: unknown }> = Array.isArray(req.body?.items) ? req.body.items : []
    if (!customer) return res.status(400).json({ error: 'customer is required' })
    const items = rawItems
      .map((it) => ({ title: String(it.product ?? ''), sku: String(it.sku ?? ''), quantity: Number(it.qty ?? 0), price: Number(it.price ?? 0) }))
      .filter((it) => it.title && it.quantity > 0)
    if (items.length === 0) return res.status(400).json({ error: 'at least one item with product + qty is required' })
    const discount = toNum(req.body?.discount) ?? 0
    const value = Math.round((items.reduce((a, it) => a + it.price * it.quantity, 0) - discount) * 100) / 100
    const advancePaid = Math.min(Math.max(toNum(req.body?.advanceAmount) ?? 0, 0), value)

    const now = new Date()
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
    const internalId = `BK${ym}-${Math.floor(100000 + Math.random() * 900000)}`
    const [row] = await db!.insert(s.salesOrders).values({
      id: randomUUID(),
      internalId,
      customer,
      value,
      payment: advancePaid >= value && value > 0 ? 'paid' : 'pending',
      fulfillment: 'pending',
      status: 'confirmed',
      date: now.toISOString(),
      items: items.reduce((a, it) => a + it.quantity, 0),
      tags: 'booking',
      currency: 'INR',
      discount,
      lineItems: items,
      isBooking: true,
      advancePaid,
    }).returning()
    recordCrud('sales-orders', 'Created', req, row)
    await insertOrderEvent(row.id, 'Booking Created', `Booking ${internalId} — ${items.reduce((a, it) => a + it.quantity, 0)} item(s), value ₹${value.toLocaleString('en-IN')}, advance ₹${advancePaid.toLocaleString('en-IN')}`, actorFromRequest(req).userId ?? 'system')
    res.json(row)
  } catch (err) {
    logger.error({ err }, 'booking create failed')
    res.status(500).json({ error: 'Failed to create booking' })
  }
})

// Edit a booking that hasn't been converted to an invoice yet: customer,
// line items, discount and advance. Value/advance are recomputed the same
// way as create so totals never drift.
dbRouter.patch('/bookings/:id', requirePermission('sales', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const [booking] = await db!.select().from(s.salesOrders).where(eq(s.salesOrders.id, routeParam(req.params.id))).limit(1)
    if (!booking) return res.status(404).json({ error: 'Booking not found' })
    if (!booking.isBooking) return res.status(400).json({ error: 'Order is not a booking' })
    if (booking.invoice) return res.status(400).json({ error: 'Booking already converted to an invoice — edit the invoice instead' })

    const body = req.body ?? {}
    const patch: Partial<typeof s.salesOrders.$inferInsert> = {}

    if (body.customer !== undefined) {
      const customer = String(body.customer ?? '').trim()
      if (!customer) return res.status(400).json({ error: 'customer cannot be empty' })
      patch.customer = customer
    }

    let items = (Array.isArray(booking.lineItems) ? booking.lineItems : []) as Array<{ title?: string; sku?: string; quantity?: number; price?: number }>
    let discount = num(booking.discount, 0)
    if (body.items !== undefined) {
      const rawItems: Array<{ product?: unknown; sku?: unknown; qty?: unknown; price?: unknown }> = Array.isArray(body.items) ? body.items : []
      const parsed = rawItems
        .map((it) => ({ title: String(it.product ?? ''), sku: String(it.sku ?? ''), quantity: Number(it.qty ?? 0), price: Number(it.price ?? 0) }))
        .filter((it) => it.title && it.quantity > 0)
      if (parsed.length === 0) return res.status(400).json({ error: 'at least one item with product + qty is required' })
      items = parsed
      patch.lineItems = parsed
      patch.items = parsed.reduce((a, it) => a + it.quantity, 0)
    }
    if (body.discount !== undefined) {
      discount = Math.max(toNum(body.discount) ?? 0, 0)
      patch.discount = discount
    }

    if (body.items !== undefined || body.discount !== undefined) {
      const value = Math.round((items.reduce((a, it) => a + Number(it.price ?? 0) * Number(it.quantity ?? 0), 0) - discount) * 100) / 100
      const advancePaid = Math.min(Math.max(toNum(body.advanceAmount) ?? num(booking.advancePaid, 0), 0), Math.max(value, 0))
      patch.value = value
      patch.advancePaid = advancePaid
      patch.payment = advancePaid >= value && value > 0 ? 'paid' : 'pending'
    } else if (body.advanceAmount !== undefined) {
      const value = num(booking.value, 0)
      const advancePaid = Math.min(Math.max(toNum(body.advanceAmount) ?? 0, 0), Math.max(value, 0))
      patch.advancePaid = advancePaid
      patch.payment = advancePaid >= value && value > 0 ? 'paid' : 'pending'
    }

    if (Object.keys(patch).length === 0) return res.json(booking)
    const [updated] = await db!.update(s.salesOrders).set(patch).where(eq(s.salesOrders.id, routeParam(req.params.id))).returning()
    recordCrud('sales-orders', 'Updated', req, updated)
    await insertOrderEvent(updated.id, 'Booking Edited', `Booking ${updated.internalId ?? updated.id} — customer ${updated.customer}, value ₹${num(updated.value, 0).toLocaleString('en-IN')}, advance ₹${num(updated.advancePaid, 0).toLocaleString('en-IN')}`, actorFromRequest(req).userId ?? 'system')
    res.json(updated)
  } catch (err) {
    logger.error({ err }, 'booking update failed')
    res.status(500).json({ error: 'Failed to update booking' })
  }
})

// Booking advance payment link — customers pay their advance online via Razorpay
dbRouter.post('/bookings/:id/payment-link', requirePermission('sales', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const [booking] = await db!.select().from(s.salesOrders).where(eq(s.salesOrders.id, routeParam(req.params.id))).limit(1)
    if (!booking) return res.status(404).json({ error: 'Booking not found' })
    if (!booking.isBooking) return res.status(400).json({ error: 'Order is not a booking' })
    const value = Number(booking.value ?? 0)
    const advancePaid = Number(booking.advancePaid ?? 0)
    const remaining = Math.round((value - advancePaid) * 100) / 100
    if (remaining <= 0) return res.status(400).json({ error: 'Booking is already fully paid' })
    const { createRazorpayPaymentLink, isRazorpayConfigured } = await import('../paymentLinks')
    if (!isRazorpayConfigured()) return res.status(400).json({ error: 'Razorpay not configured (set RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET)', configured: false })
    const link = await createRazorpayPaymentLink({
      amount: remaining,
      customer: booking.customer ?? 'Customer',
      description: `Advance for booking ${booking.internalId ?? booking.id} — Opal Line`,
      referenceId: `BK-${booking.internalId ?? booking.id}`.replace(/[^a-zA-Z0-9-]/g, ''),
    })
    if (!link) return res.status(500).json({ error: 'Failed to create payment link' })
    res.json({ url: link.url, id: link.id, amount: remaining, configured: true })
  } catch (err) {
    logger.error({ err }, 'booking payment link failed')
    res.status(500).json({ error: 'Payment link generation failed' })
  }
})

dbRouter.post('/bookings/:id/convert', requirePermission('sales', 'create'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const [order] = await db!.select().from(s.salesOrders).where(eq(s.salesOrders.id, routeParam(req.params.id))).limit(1)
    if (!order) return res.status(404).json({ error: 'Booking not found' })
    if (order.invoice) return res.status(400).json({ error: `Already converted to invoice ${order.invoice}` })
    const value = Number(order.value ?? 0)
    const advancePaid = Number(order.advancePaid ?? 0)
    const fullyPaid = advancePaid >= value && value > 0
    await db!.update(s.salesOrders).set({ payment: fullyPaid ? 'paid' : 'pending' }).where(eq(s.salesOrders.id, order.id))
    const [fresh] = await db!.select().from(s.salesOrders).where(eq(s.salesOrders.id, order.id)).limit(1)
    const { createInvoiceForOrderRow } = await import('../orderEmailIngest')
    const invoiceNumber = await createInvoiceForOrderRow(fresh!)
    if (!invoiceNumber) return res.status(400).json({ error: 'Conversion failed: booking has no convertible line items' })
    await db!.update(s.salesOrders).set({ invoice: invoiceNumber, status: 'fulfilled' }).where(eq(s.salesOrders.id, order.id))
    if (advancePaid > 0) {
      await db!.insert(s.payments).values({
        id: randomUUID(), ref: order.internalId ?? order.id, invoice: invoiceNumber, customer: order.customer,
        amount: advancePaid, method: 'Advance', gateway: 'booking', status: 'paid', date: new Date().toISOString(),
      })
    }
    recordCrud('sales-orders', 'Updated', req, { id: order.id, invoice: invoiceNumber })
    await insertOrderEvent(order.id, 'Booking Converted', `Converted to invoice ${invoiceNumber}; advance applied ₹${advancePaid.toLocaleString('en-IN')}`, actorFromRequest(req).userId ?? 'system')
    res.json({ invoiceNumber, advanceApplied: advancePaid, balance: Math.round((value - advancePaid) * 100) / 100 })
  } catch (err) {
    logger.error({ err }, 'booking convert failed')
    res.status(500).json({ error: 'Failed to convert booking' })
  }
})

// ─── Order events timeline ───────────────────────────────────────────────────
export async function insertOrderEvent(orderId: string, event: string, details: string, actor?: string | null): Promise<void> {
  if (!db) return
  try {
    await db.insert(s.orderEvents).values({
      id: randomUUID(), orderId, event, details,
      actor: actor ?? null,
      createdAt: new Date().toISOString(),
    })
  } catch (err) {
    logger.warn({ err }, 'order event insert failed')
  }
}

// Seed a timeline for orders that have none (first time the dialog is opened)
async function ensureOrderTimeline(order: typeof s.salesOrders.$inferSelect): Promise<void> {
  const existing = await db!.select({ id: s.orderEvents.id }).from(s.orderEvents).where(eq(s.orderEvents.orderId, order.id)).limit(1)
  if (existing.length > 0) return
  const events: Array<[string, string]> = []
  if (order.date) events.push(['Order Created', order.shopifyId ? `Imported from Shopify order ${order.shopifyId}` : 'Order recorded'])
  if (order.isBooking && order.advancePaid) events.push(['Advance Received', `${Number(order.advancePaid).toLocaleString('en-IN')} collected at booking`])
  if (order.invoice) events.push(['Invoice Created', `Invoice ${order.invoice}`])
  if (order.status && order.status !== 'imported') events.push(['Status', `Status set to ${order.status}`])
  for (const [e, d] of events) {
    await insertOrderEvent(order.id, e, d, 'system')
  }
}

dbRouter.get('/orders/:id/events', requirePermission('sales', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const [order] = await db!.select().from(s.salesOrders).where(eq(s.salesOrders.id, routeParam(req.params.id))).limit(1)
    if (!order) return res.status(404).json({ error: 'Order not found' })
    await ensureOrderTimeline(order)
    const events = await db!.select().from(s.orderEvents).where(eq(s.orderEvents.orderId, routeParam(req.params.id))).orderBy(desc(s.orderEvents.createdAt))
    res.json({ data: events })
  } catch {
    res.status(500).json({ error: 'Failed to load order events' })
  }
})

// ─── Customer 360: everything about one customer in a single call ───────────
dbRouter.get('/customers/:name/summary', requirePermission('sales', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const customer = routeParam(req.params.name)
    const [orders, invoices, dues, pays] = await Promise.all([
      db!.select().from(s.salesOrders).where(eq(s.salesOrders.customer, customer)).orderBy(desc(s.salesOrders.date)).limit(25),
      db!.select().from(s.salesInvoices).where(eq(s.salesInvoices.customer, customer)).orderBy(desc(s.salesInvoices.date)).limit(25),
      db!.select().from(s.salesInvoices).where(sql`${s.salesInvoices.customer} = ${customer} and ${s.salesInvoices.paymentStatus} is distinct from 'paid' and ${s.salesInvoices.status} is distinct from 'cancelled' and ${s.salesInvoices.status} is distinct from 'refunded'`),
      db!.select().from(s.payments).where(eq(s.payments.customer, customer)).orderBy(desc(s.payments.date)).limit(15),
    ])
    const lifetimeValue = Math.round(orders.reduce((a, o) => a + Number(o.value ?? 0), 0) * 100) / 100
    const outstanding = Math.round(dues.reduce((a, i) => a + Number(i.grandTotal ?? 0), 0) * 100) / 100
    res.json({
      customer,
      totalOrders: orders.length,
      lifetimeValue,
      outstanding,
      lastOrder: orders[0]?.date ?? null,
      lastInvoice: invoices[0]?.number ?? null,
      orders,
      invoices,
      payments: pays,
    })
  } catch (err) {
    logger.error({ err }, 'customer summary failed')
    res.status(500).json({ error: 'Failed to load customer summary' })
  }
})

// ─── Bulk order actions: status update + invoice creation ────────────────────
dbRouter.post('/sales-orders/bulk-status', requirePermission('sales', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : []
    const status = String(req.body?.status ?? '').trim()
    const allowed = ['imported', 'confirmed', 'processing', 'fulfilled', 'cancelled']
    if (ids.length === 0) return res.status(400).json({ error: 'ids is required' })
    if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` })
    let updated = 0
    let invoicesCreated = 0
    const newInvoices: string[] = []
    for (const id of ids) {
      const [row] = await db!.update(s.salesOrders).set({ status }).where(eq(s.salesOrders.id, id)).returning()
      if (row) {
        updated++
        await insertOrderEvent(id, 'Status Change', `Bulk status moved to ${status}`, actorFromRequest(req).userId ?? 'system')
        if (status === 'fulfilled') {
          void import('../statusNotifications').then((m) => m.notifyOrderFulfilled(row)).catch(() => undefined)
          // Receiving the order raises its sales invoice automatically.
          const invoiceNumber = await autoInvoiceFulfilledOrder(row, actorFromRequest(req))
          if (invoiceNumber) { invoicesCreated++; newInvoices.push(invoiceNumber) }
        }
      }
    }
    recordCrud('sales-orders', 'Updated', req, { bulkStatus: status, updated })
    res.json({ updated, status, invoicesCreated, newInvoices })
  } catch (err) {
    logger.error({ err }, 'bulk status failed')
    res.status(500).json({ error: 'Bulk status update failed' })
  }
})

dbRouter.post('/sales-orders/bulk-invoice', requirePermission('sales', 'create'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (ids.length === 0) return res.status(400).json({ error: 'ids is required' })
    const { createInvoiceForOrderRow } = await import('../orderEmailIngest')
    let created = 0
    let alreadyInvoiced = 0
    let failed = 0
    const errors: string[] = []
    for (const id of ids) {
      const [order] = await db!.select().from(s.salesOrders).where(eq(s.salesOrders.id, id)).limit(1)
      if (!order) { failed++; errors.push(`${id}: not found`); continue }
      if (order.invoice) { alreadyInvoiced++; continue }
      try {
        const invoiceNumber = await createInvoiceForOrderRow(order)
        if (invoiceNumber) {
          created++
          await insertOrderEvent(id, 'Invoice Created', `Invoice ${invoiceNumber} generated (bulk)`, actorFromRequest(req).userId ?? 'system')
        } else { failed++; errors.push(`${order.internalId ?? order.id}: no convertible line items`) }
      } catch (e) {
        failed++
        errors.push(`${order.internalId ?? order.id}: ${e instanceof Error ? e.message : 'failed'}`)
      }
    }
    recordCrud('sales-orders', 'Updated', req, { bulkInvoice: true, created })
    res.json({ created, alreadyInvoiced, failed, errors })
  } catch (err) {
    logger.error({ err }, 'bulk invoice failed')
    res.status(500).json({ error: 'Bulk invoicing failed' })
  }
})

// ─── Dispatch / shipments ─────────────────────────────────────────────────

dbRouter.get('/shipments', requirePermission('sales', 'view'), async (_req, res) => {
  if (!requireDb(res)) return
  try {
    const rows = await db!.select().from(s.shipments).orderBy(desc(s.shipments.createdAt)).limit(300)
    res.json({ data: rows })
  } catch (err) {
    logger.error({ err }, 'shipments load failed')
    res.status(500).json({ error: 'Failed to load shipments' })
  }
})

dbRouter.post('/shipments/dispatch', requirePermission('sales', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    // All eligibility (cancelled orders, delivered shipments), the upsert
    // duplicate protection, the transaction and the auto-invoice live in
    // dispatchOrder (src/dispatch.ts) — the same rules the tests assert.
    const result = await dispatchOrder(req.body?.orderId, req.body ?? {}, actorFromRequest(req))
    recordCrud('sales-orders', 'Updated', req, { id: String(req.body?.orderId ?? ''), dispatched: true })
    res.json({ ok: true, ...result })
  } catch (err) {
    if (err instanceof DispatchError) return res.status(err.status).json({ error: err.message })
    logger.error({ err }, 'dispatch failed')
    res.status(500).json({ error: 'Dispatch failed' })
  }
})

dbRouter.post('/shipments/:id/delivered', requirePermission('sales', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const { shipment, alreadyDelivered } = await confirmShipmentDelivered(routeParam(req.params.id), actorFromRequest(req))
    res.json({ ok: true, alreadyDelivered, shipmentId: shipment.id })
  } catch (err) {
    if (err instanceof DispatchError) return res.status(err.status).json({ error: err.message })
    logger.error({ err }, 'delivery confirm failed')
    res.status(500).json({ error: 'Failed to confirm delivery' })
  }
})

// ─── Notification log (audit + resend) ────────────────────────────────────

dbRouter.get('/notifications/log', requirePermission('system', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const limit = Math.min(Number(req.query.limit ?? 100), 300)
    const rows = await db!.select().from(s.notificationLog).orderBy(desc(s.notificationLog.createdAt)).limit(limit)
    res.json({ data: rows })
  } catch (err) {
    logger.error({ err }, 'notification log load failed')
    res.status(500).json({ error: 'Failed to load notification log' })
  }
})

dbRouter.post('/notifications/resend', requirePermission('system', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const id = String(req.body?.id ?? '').trim()
    const [entry] = await db!.select().from(s.notificationLog).where(eq(s.notificationLog.id, id)).limit(1)
    if (!entry) return res.status(404).json({ error: 'Notification not found' })
    if (!entry.recipient) return res.status(400).json({ error: 'Original recipient unknown — cannot resend' })
    const ref = entry.ref ?? ''
    const { sendEmail } = await import('../notifications')
    const { sendWhatsAppMessage } = await import('../whatsapp')
    let ok = false
    if (entry.channel === 'email') {
      ok = await sendEmail({ to: entry.recipient, subject: `[Re-send] ${ref} — Opal Line`, html: `<p>Re-sent notification for <strong>${escapeHtml(ref)}</strong>.</p><p>Please contact us for the full details.</p>` })
    } else {
      ok = (await sendWhatsAppMessage(entry.recipient, `Re-sent notification for ${ref}. — Opal Line`)) !== null
    }
    await logResend(entry, ok)
    res.json({ ok })
  } catch (err) {
    logger.error({ err }, 'notification resend failed')
    res.status(500).json({ error: 'Resend failed' })
  }
})

async function logResend(entry: typeof s.notificationLog.$inferSelect, ok: boolean): Promise<void> {
  try {
    await db!.insert(s.notificationLog).values({
      id: randomUUID(),
      kind: entry.kind,
      channel: entry.channel,
      recipient: entry.recipient,
      ref: entry.ref,
      status: ok ? 'sent' : 'failed',
      error: ok ? 'manual resend' : 'manual resend failed',
      createdAt: new Date().toISOString(),
    })
  } catch { /* non-fatal */ }
}

// ─── Aging unsold stock: how long the units still on hand have been held ─────
//
// The balance on products.stock says nothing about age. This rebuilds it from
// the append-only stock ledger with FIFO: the units that entered first are the
// ones that sold first, so the oldest remaining lot is the entry date of the
// stock still on the shelf. That is what the 30/60/90/180 bands are based on —
// a restock does not make an old balance look fresh.
//
// "Last sold" is the newest sale across both channels the shop bills through:
// counter invoices and Shopify order line items. A cancelled/refunded document
// is not a sale, so it is excluded exactly like the reorder engine does.
dbRouter.get('/inventory/aging', requirePermission('inventory', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const allProducts = await db!.select().from(s.products)
    const inStock = allProducts.filter((p) => p.trackInventory !== false && Math.floor(Number(p.stock ?? 0)) > 0)

    // Only inflows matter: total outflow is derived from the balance, which is
    // the number the rest of the ERP already trusts. Reading every movement of
    // every product would also drag in years of history for sold-out SKUs.
    const inflowRows = await db!.execute(sql`
      SELECT sm.product_id AS product_id, sm.date AS date, sm.qty AS qty
      FROM stock_movements sm
      JOIN products p ON p.id = sm.product_id
      WHERE p.stock > 0 AND sm.qty > 0
      ORDER BY sm.product_id ASC, sm.date ASC, sm.id ASC
    `)
    const lotsByProduct = new Map<string, Array<{ date: unknown; qty: unknown }>>()
    for (const row of inflowRows as unknown as Array<Record<string, unknown>>) {
      const productId = String(row.product_id ?? '')
      if (!productId) continue
      const lots = lotsByProduct.get(productId)
      if (lots) lots.push({ date: row.date, qty: row.qty })
      else lotsByProduct.set(productId, [{ date: row.date, qty: row.qty }])
    }

    const soldRows = await db!.execute(sql`
      SELECT sku, max(last_sold) AS last_sold FROM (
        SELECT lower(trim(it.sku)) AS sku, i.date AS last_sold
        FROM sales_invoice_items it
        JOIN sales_invoices i ON i.id = it.invoice_id
        WHERE it.sku IS NOT NULL AND trim(it.sku) <> ''
          AND coalesce(i.status, '') NOT IN ('cancelled', 'refunded')
        UNION ALL
        SELECT lower(trim(li->>'sku')) AS sku, so.date AS last_sold
        FROM sales_orders so
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(so.line_items) = 'array' THEN so.line_items ELSE '[]'::jsonb END
        ) AS li
        WHERE so.line_items IS NOT NULL
          AND coalesce(so.status, '') NOT IN ('cancelled')
          AND li->>'sku' IS NOT NULL AND trim(li->>'sku') <> ''
      ) sold
      GROUP BY sku
    `)
    const lastSoldBySku = new Map<string, string>()
    for (const row of soldRows as unknown as Array<Record<string, unknown>>) {
      const sku = String(row.sku ?? '').trim().toLowerCase()
      const lastSold = toAgingIso(row.last_sold)
      if (!sku || !lastSold) continue
      const existing = lastSoldBySku.get(sku)
      if (!existing || lastSold > existing) lastSoldBySku.set(sku, lastSold)
    }

    const now = new Date()
    const rows = inStock.map((p) => {
      const quantity = Math.max(0, Math.floor(Number(p.stock ?? 0)))
      // Pre-ledger balances (or a ledger that cannot explain the balance) fall
      // back to the product record so the row still gets an age instead of
      // silently disappearing from the report.
      const stockEntryDate = fifoEntryDate({ stock: quantity, inflows: lotsByProduct.get(p.id) ?? [] })
        ?? toAgingIso(p.createdAt)
      const daysInStock = ageInDays(stockEntryDate, now) ?? 0
      const agingBucket = agingBucketForDays(daysInStock)
      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        category: p.category,
        quantity,
        stock: quantity,
        stockEntryDate,
        lastSoldDate: lastSoldBySku.get(String(p.sku ?? '').trim().toLowerCase()) ?? null,
        daysInStock,
        agingBucket,
        agingStatus: agingBucketDefinition(agingBucket).label,
        stockValue: Math.round(quantity * Number(p.sellingPrice ?? 0) * 100) / 100,
      }
    })
    rows.sort((a, b) => b.daysInStock - a.daysInStock || a.name.localeCompare(b.name))

    const buckets = AGING_BUCKETS.map((bucket) => {
      const matching = rows.filter((row) => row.agingBucket === bucket.key)
      return {
        key: bucket.key,
        label: bucket.label,
        tone: bucket.tone,
        count: matching.length,
        quantity: matching.reduce((sum, row) => sum + row.quantity, 0),
        value: Math.round(matching.reduce((sum, row) => sum + row.stockValue, 0) * 100) / 100,
      }
    })
    const totals = {
      products: rows.length,
      quantity: rows.reduce((sum, row) => sum + row.quantity, 0),
      value: Math.round(rows.reduce((sum, row) => sum + row.stockValue, 0) * 100) / 100,
      neverSold: rows.filter((row) => !row.lastSoldDate).length,
    }

    // The page filters locally for instant feedback; the API accepts the same
    // filters so reports/exports can request a subset without the catalogue.
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : ''
    const category = typeof req.query.category === 'string' ? req.query.category.trim() : ''
    const bucketRaw = typeof req.query.bucket === 'string' ? req.query.bucket.trim() : ''
    if (bucketRaw && !AGING_BUCKETS.some((bucket) => bucket.key === bucketRaw)) {
      return res.status(400).json({ error: `Unknown aging bucket: ${bucketRaw}` })
    }
    const bucket = bucketRaw as AgingBucketKey | ''
    const data = rows.filter((row) => {
      const matchesQuery = !q || row.name.toLowerCase().includes(q) || row.sku.toLowerCase().includes(q)
      const matchesCategory = !category || row.category === category
      const matchesBucket = !bucket || row.agingBucket === bucket
      return matchesQuery && matchesCategory && matchesBucket
    })

    res.json({
      generatedAt: new Date().toISOString(),
      data,
      buckets,
      totals,
      filters: { q, category, bucket },
    })
  } catch (err) {
    logger.error({ err }, 'aging unsold stock failed')
    res.status(500).json({ error: 'Failed to load aging unsold stock' })
  }
})

// ─── Auto reorder suggestions: sales velocity vs. stock on hand ─────────────
dbRouter.get('/inventory/reorder-suggestions', requirePermission('inventory', 'view'), async (_req, res) => {
  if (!requireDb(res)) return
  try {
    // Sales per SKU over the last 90 days.
    //
    // Velocity has to count what the shop *actually sold*, which means both
    // sources: tax invoices (counter sales typed straight into the ERP) and
    // order line items (Shopify / online). Reading only sales_orders made every
    // manually issued invoice count as zero, so the bestsellers sold over the
    // counter never earned a reorder suggestion. Orders that were invoiced are
    // skipped here to avoid counting the same sale twice.
    const salesRows = await db!.execute(sql`
      SELECT sku, sum(qty)::numeric AS qty_sold FROM (
        SELECT lower(trim(it.sku)) AS sku, coalesce(it.qty, 0)::numeric AS qty
        FROM sales_invoice_items it
        JOIN sales_invoices i ON i.id = it.invoice_id
        WHERE i.date > now() - interval '90 days'
          AND coalesce(i.status, '') NOT IN ('cancelled', 'refunded')
          AND it.sku IS NOT NULL AND trim(it.sku) <> ''
        UNION ALL
        SELECT lower(trim(li->>'sku')) AS sku, (li->>'quantity')::numeric AS qty
        FROM sales_orders, jsonb_array_elements(line_items) AS li
        WHERE date > now() - interval '90 days'
          AND coalesce(status, '') NOT IN ('cancelled', 'fulfilled', 'invoiced')
          AND li->>'sku' IS NOT NULL AND trim(li->>'sku') <> ''
      ) sold
      GROUP BY sku
    `)
    const soldMap = new Map<string, number>()
    for (const row of salesRows as any[]) {
      soldMap.set(String(row.sku), Number(row.qty_sold ?? 0))
    }
    // Products are matched by SKU case-insensitively, same as the query.

    const prods = await db!.select().from(s.products)
    const suggestions: Array<{
      id: string; name: string; sku: string; supplier: string | null; stock: number
      reorderLevel: number; sold90d: number; weeklyVelocity: number; weeksOfCover: number
      suggestedQty: number; priority: 'urgent' | 'soon' | 'ok'
    }> = []
    for (const p of prods) {
      if (p.trackInventory === false) continue
      const sold90d = soldMap.get(String(p.sku ?? '').trim().toLowerCase()) ?? 0
      const weeklyVelocity = Math.round((sold90d / 13) * 100) / 100 // 13 weeks ≈ 90 days
      const stock = p.stock ?? 0
      const weeksOfCover = weeklyVelocity > 0 ? Math.round((stock / weeklyVelocity) * 10) / 10 : 99
      const target = Math.max(p.reorderLevel ?? 5, Math.ceil(weeklyVelocity * 8)) // 8 weeks of stock
      if (stock <= (p.reorderLevel ?? 5) || weeksOfCover < 4) {
        suggestions.push({
          id: p.id, name: p.name, sku: p.sku, supplier: p.supplier,
          stock, reorderLevel: p.reorderLevel ?? 5, sold90d, weeklyVelocity,
          weeksOfCover,
          suggestedQty: Math.max(target - stock, 1),
          priority: stock <= 0 || weeksOfCover < 1 ? 'urgent' : weeksOfCover < 2 ? 'soon' : 'ok',
        })
      }
    }
    suggestions.sort((a, b) => {
      const rank = { urgent: 0, soon: 1, ok: 2 } as const
      if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority]
      return a.weeksOfCover - b.weeksOfCover
    })
    res.json({ data: suggestions, generatedAt: new Date().toISOString() })
  } catch (err) {
    logger.error({ err }, 'reorder suggestions failed')
    res.status(500).json({ error: 'Failed to generate reorder suggestions' })
  }
})

// Create draft purchase orders from reorder suggestions, grouped by supplier.
// Body: { ids: string[] } — subset of suggestion product ids; omitted = all suggestions.
dbRouter.post('/purchase-orders/from-reorder', requirePermission('purchase', 'create'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const ids = Array.isArray((req.body as { ids?: string[] })?.ids) ? (req.body as { ids: string[] }).ids : null
    // Reuse the suggestion engine
    const salesRows = await db!.execute(sql`
      SELECT li->>'sku' AS sku,
             sum((li->>'quantity')::numeric) AS qty_sold
      FROM sales_orders, jsonb_array_elements(line_items) AS li
      WHERE date > now() - interval '90 days'
        AND li->>'sku' IS NOT NULL AND li->>'sku' <> ''
      GROUP BY li->>'sku'
    `)
    const soldMap = new Map<string, number>()
    for (const row of salesRows as any[]) soldMap.set(String(row.sku), Number(row.qty_sold ?? 0))

    const prods = (await db!.select().from(s.products)).filter((p) => {
      if (p.trackInventory === false) return false
      if (ids && !ids.includes(p.id)) return false
      const sold90d = soldMap.get(String(p.sku ?? '').trim().toLowerCase()) ?? 0
      const weeklyVelocity = Math.round((sold90d / 13) * 100) / 100
      const stock = p.stock ?? 0
      const weeksOfCover = weeklyVelocity > 0 ? Math.round((stock / weeklyVelocity) * 10) / 10 : 99
      return stock <= (p.reorderLevel ?? 5) || weeksOfCover < 4
    })
    if (prods.length === 0) return res.status(400).json({ error: 'No products currently need reordering' })

    // Group by supplier (unknown supplier → 'Unassigned')
    const bySupplier = new Map<string, typeof prods>()
    for (const p of prods) {
      const key = p.supplier?.trim() || 'Unassigned'
      if (!bySupplier.has(key)) bySupplier.set(key, [])
      bySupplier.get(key)!.push(p)
    }

    const now = new Date()
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const created: Array<{ number: string; supplier: string; items: number; qty: number }> = []
    for (const [supplier, list] of bySupplier) {
      // Find next sequential PO number for this month
      let poNumber = ''
      const existing = await db!.select({ number: s.purchaseOrders.number }).from(s.purchaseOrders)
      const used = new Set(existing.map((e) => e.number))
      for (let n = 1; n < 10000; n++) {
        const candidate = `PO-${stamp}-${String(n).padStart(5, '0')}`
        if (!used.has(candidate)) { poNumber = candidate; break }
      }
      if (!poNumber) return res.status(500).json({ error: 'Could not generate PO number' })

      const qty = list.reduce((a, p) => {
        const sold90d = soldMap.get(String(p.sku ?? '').trim().toLowerCase()) ?? 0
        const weeklyVelocity = Math.round((sold90d / 13) * 100) / 100
        const target = Math.max(p.reorderLevel ?? 5, Math.ceil(weeklyVelocity * 8))
        return a + Math.max(target - (p.stock ?? 0), 1)
      }, 0)
      const weight = list.reduce((a, p) => a + Number(p.grossWeight ?? p.netWeight ?? 0) * Math.max(1, Math.floor(qty / Math.max(list.length, 1))), 0)
      const value = list.reduce((a, p) => a + Number(p.sellingPrice ?? 0) * Math.max(1, Math.floor(qty / Math.max(list.length, 1))), 0)
      const subtotal = Math.round(value * 100) / 100
      const gstAmount = round2((subtotal * 3) / 100)

      const [row] = await db!.insert(s.purchaseOrders).values({
        id: randomUUID(),
        number: poNumber,
        supplier,
        items: list.length,
        qty,
        weight: Math.round(weight * 100) / 100,
        value: subtotal,
        gst: 3,
        gstAmount,
        discount: 0,
        grandTotal: round2(subtotal + gstAmount),
        status: 'draft',
        date: new Date().toISOString(),
      }).returning()
      created.push({ number: row.number, supplier, items: list.length, qty })
      recordCrud('purchase-orders', 'Created', req, row)
    }

    res.status(201).json({ ok: true, created, suppliers: created.length, products: prods.length })
  } catch (err) {
    logger.error({ err }, 'auto-PO from reorder failed')
    res.status(500).json({ error: 'Failed to create purchase order drafts' })
  }
})

dbRouter.get('/purchase-invoices', listOf(s.purchaseInvoices, s.purchaseInvoices.date))
// Line items + live balance for one purchase invoice.
dbRouter.get('/purchase-invoices/:id/with-items', requirePermission('purchase', 'view'), async (req, res) => {
  try {
    const { getPurchaseInvoiceWithItems } = await import('../purchases')
    const invoice = await getPurchaseInvoiceWithItems(routeParam(req.params.id))
    if (!invoice) return res.status(404).json({ error: 'Purchase invoice not found' })
    res.json(invoice)
  } catch (err) {
    logger.error({ err }, 'purchase invoice with-items failed')
    res.status(500).json({ error: 'Failed to load purchase invoice' })
  }
})

// Create a purchase invoice with line items. Each line adds its quantity to
// stock — purchases were previously totals-only, so nothing ever arrived.
/**
 * Write a purchase invoice row and its line items, applying stock once.
 * Shared by the manual create route and the recreate (cancel + reissue)
 * route so totals, GST split, TCS and stock movement stay identical.
 */
async function insertPurchaseInvoice(input: Record<string, unknown>) {
  const {
    normalizePurchaseItems, purchaseTotals, saveInvoiceItems,
    splitInputGst, getBusinessState, computeTcs,
  } = await import('../purchases')
  const body = input
  const number = String(body.number ?? '').trim()
  const supplier = String(body.supplier ?? '').trim()
  if (!number) throw new Error('Supplier invoice number is required')
  if (!supplier) throw new Error('supplier is required')

  const items = normalizePurchaseItems(body.items)
  if (items.length === 0) {
    throw new Error('At least one line item is required so stock can be updated')
  }
  const totals = purchaseTotals(items)
  const supplierGstin = String(body.supplierGstin ?? '').trim() || null
  const gstSplit = splitInputGst(totals.tax, supplierGstin, await getBusinessState())
  const tcs = computeTcs(totals.cost, body.tcsRate as number | null | undefined)
  const date = body.date ? String(body.date) : new Date().toISOString()
  const id = randomUUID()
  // Where the goods are being received. Absent means the default store.
  const locationId = await resolveMovementLocation(body.locationId as string | undefined)

  const result = await db!.transaction(async (tx) => {
    const [row] = await tx
      .insert(s.purchaseInvoices)
      .values({
        id,
        number,
        supplier,
        items: totals.qty,
        qty: totals.qty,
        weight: totals.weight,
        rate: totals.rate,
        cost: totals.cost,
        tax: totals.tax,
        total: totals.total,
        paidAmount: 0,
        supplierGstin,
        supplierState: gstSplit.supplierState || null,
        cgst: gstSplit.cgst,
        sgst: gstSplit.sgst,
        igst: gstSplit.igst,
        tcsRate: tcs.tcsRate,
        tcsAmount: tcs.tcsAmount,
        // Link back to the PO this received, so ordered-vs-received works.
        orderId: body.orderId ? String(body.orderId) : null,
        status: String(body.status ?? 'pending'),
        date,
        // Goods can be delivered to a branch rather than the main store.
        locationId,
      } as any)
      .returning()
    const saved = await saveInvoiceItems(tx as never, id, items, { addStock: true, locationId })
    return { row, saved }
  })
  return { row: result.row, saved: result.saved, items, totals }
}

dbRouter.post('/purchase-invoices', requirePermission('purchase', 'create'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const number = String(body.number ?? '').trim()
    if (!number) return res.status(400).json({ error: 'Supplier invoice number is required' })
    if (!String(body.supplier ?? '').trim()) return res.status(400).json({ error: 'supplier is required' })

    const result = await insertPurchaseInvoice(body)

    recordCrud('purchase-invoices', 'Created', req, result.row)
    logger.info(
      { number, supplier: result.row.supplier, lines: result.saved.lines, stocked: result.saved.stocked, total: result.totals.total },
      'Purchase invoice received — stock updated',
    )
    res.status(201).json({ ...stripHash(result.row), items: result.items, lines: result.saved.lines, stockedSkus: result.saved.stocked })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    logger.error({ err }, 'purchase invoice create failed')
    // Drizzle wraps the driver error, so the constraint text ("duplicate key
    // value violates unique constraint") lives on the cause, not the message.
    const causeMsg = (err as { cause?: unknown })?.cause instanceof Error ? (err as Error & { cause: Error }).cause.message : ''
    const isDuplicate = /unique|duplicate key/i.test(`${msg} ${causeMsg}`)
    res.status(isDuplicate ? 400 : 500).json({ error: isDuplicate ? 'That supplier invoice number already exists' : 'Failed to create purchase invoice' })
  }
})

// Update a purchase invoice: replacing the lines reverses the stock the old
// lines added and applies the new ones. Cancelling takes the stock back out.
dbRouter.patch('/purchase-invoices/:id', requirePermission('purchase', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const {
      normalizePurchaseItems, purchaseTotals, saveInvoiceItems,
      splitInputGst, getBusinessState, computeTcs, reversePurchaseStock,
      restorePurchaseStock, balanceOf,
    } = await import('../purchases')
    const body = (req.body ?? {}) as Record<string, unknown>
    const [existing] = await db!.select().from(s.purchaseInvoices).where(eq(s.purchaseInvoices.id, routeParam(req.params.id))).limit(1)
    if (!existing) return res.status(404).json({ error: 'Purchase invoice not found' })

    const paid = Number(existing.paidAmount ?? 0)
    const nextStatus = body.status !== undefined ? String(body.status) : null
    const beingCancelled = nextStatus === 'cancelled' && String(existing.status ?? '') !== 'cancelled'
    const beingReinstated = String(existing.status ?? '') === 'cancelled' && nextStatus && nextStatus !== 'cancelled'

    const patch: Record<string, unknown> = {}
    for (const key of ['number', 'supplier', 'supplierGstin', 'orderId', 'date'] as const) {
      if (body[key] !== undefined) patch[key] = body[key] === null ? null : String(body[key])
    }
    if (nextStatus) patch.status = nextStatus

    const rawItems = body.items !== undefined ? normalizePurchaseItems(body.items) : null
    if (rawItems && rawItems.length > 0) {
      const totals = purchaseTotals(rawItems)
      const supplierGstin = String(body.supplierGstin ?? existing.supplierGstin ?? '').trim() || null
      const gstSplit = splitInputGst(totals.tax, supplierGstin, await getBusinessState())
      const tcs = computeTcs(totals.cost, (body.tcsRate ?? existing.tcsRate) as number | null | undefined)
      Object.assign(patch, {
        items: totals.qty,
        qty: totals.qty,
        weight: totals.weight,
        rate: totals.rate,
        cost: totals.cost,
        tax: totals.tax,
        total: totals.total,
        supplierGstin,
        supplierState: gstSplit.supplierState || null,
        cgst: gstSplit.cgst,
        sgst: gstSplit.sgst,
        igst: gstSplit.igst,
        tcsRate: tcs.tcsRate,
        tcsAmount: tcs.tcsAmount,
      })
      if (Number(totals.total) < paid - 0.01) {
        return res.status(400).json({ error: `Total is lower than the ${paid.toFixed(2)} already paid — adjust the payment first` })
      }
    }

    const { updated, reversedSkus, stockedSkus } = await db!.transaction(async (tx) => {
      let reversed = 0
      let stocked = 0
      // Lines are only rewritten when the caller actually sends new ones. A
      // metadata-only edit (renumbering, fixing a GSTIN) must never drop them
      // — that would silently delete the record of what arrived while leaving
      // its stock in place, with no way to reconcile it later.
      const replacingLines = Boolean(rawItems && rawItems.length > 0)
      if (replacingLines) {
        // Take back what the previous lines added, then apply the new ones.
        reversed = await reversePurchaseStock(existing.id, tx as never)
        await tx.delete(s.purchaseInvoiceItems).where(eq(s.purchaseInvoiceItems.invoiceId, existing.id))
        // A cancelled invoice still records its lines — they just don't move stock.
        stocked = (await saveInvoiceItems(tx as never, existing.id, rawItems!, { addStock: !beingCancelled, locationId: existing.locationId ?? null })).stocked
      } else if (beingCancelled) {
        // Cancelling reverses the stock but KEEPS the lines, so the invoice
        // still shows what was received and can be reinstated as-is.
        reversed = await reversePurchaseStock(existing.id, tx as never)
      } else if (beingReinstated) {
        // Put back exactly the stock the kept lines describe.
        stocked = await restorePurchaseStock(existing.id, tx as never)
      }
      const [row] = await tx
        .update(s.purchaseInvoices)
        .set(patch as never)
        .where(eq(s.purchaseInvoices.id, existing.id))
        .returning()
      return { updated: row, reversedSkus: reversed, stockedSkus: stocked }
    })

    recordCrud('purchase-invoices', 'Updated', req, updated)
    res.json({
      ...stripHash(updated),
      balance: balanceOf(updated),
      reversedSkus,
      stockedSkus,
      note: beingReinstated ? 'Invoice reinstated — stock re-applied' : undefined,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    logger.error({ err }, 'purchase invoice update failed')
    res.status(500).json({ error: msg })
  }
})
// Permanently remove a purchase invoice. Cancelling is usually enough, but a
// duplicate or test entry should not sit in the books forever. Stock the
// invoice added is reversed in the same transaction, and the ledger rows that
// reference it go with it (ON DELETE CASCADE).
dbRouter.delete('/purchase-invoices/:id', requirePermission('purchase', 'delete'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const { reversePurchaseStock } = await import('../purchases')
    const wasCancelled = String((await db!.select({ status: s.purchaseInvoices.status })
      .from(s.purchaseInvoices)
      .where(eq(s.purchaseInvoices.id, routeParam(req.params.id)))
      .limit(1))[0]?.status ?? '').toLowerCase() === 'cancelled'
    const removed = await db!.transaction(async (tx) => {
      const [existing] = await tx.select().from(s.purchaseInvoices).where(eq(s.purchaseInvoices.id, routeParam(req.params.id))).limit(1)
      if (!existing) return null
      // A cancelled invoice already had its stock taken back, so don't take it
      // out a second time.
      if (!wasCancelled) await reversePurchaseStock(existing.id, tx as never)
      await tx.delete(s.purchaseInvoices).where(eq(s.purchaseInvoices.id, existing.id))
      return existing
    })
    if (!removed) return res.status(404).json({ error: 'Purchase invoice not found' })
    recordCrud('purchase-invoices', 'Deleted', req, removed)
    res.json({ ok: true, id: routeParam(req.params.id) })
  } catch (err) {
    logger.error({ err }, 'purchase invoice delete failed')
    res.status(500).json({ error: 'Failed to delete purchase invoice' })
  }
})

/**
 * Cancel a purchase invoice and recreate it from scratch. Cancel reverses
 * the stock the lines added (unless it was already cancelled), then a fresh
 * invoice is written with a new supplier invoice number carrying the same
 * lines and metadata. Payments are not carried over — record them against
 * the new invoice.
 */
dbRouter.post('/purchase-invoices/:id/recreate', requirePermission('purchase', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const { normalizePurchaseItems, bumpPurchaseInvoiceNumber } = await import('../purchases')
    const [existing] = await db!.select().from(s.purchaseInvoices).where(eq(s.purchaseInvoices.id, routeParam(req.params.id))).limit(1)
    if (!existing) return res.status(404).json({ error: 'Purchase invoice not found' })

    // Load the current line items before cancelling.
    const currentItems = await db!.select().from(s.purchaseInvoiceItems).where(eq(s.purchaseInvoiceItems.invoiceId, existing.id))
    const lines = normalizePurchaseItems(
      currentItems.map((it) => ({
        product: it.product,
        sku: it.sku,
        qty: it.qty,
        weight: it.weight,
        rate: it.rate,
        cost: it.cost,
        tax: it.tax,
        amount: it.amount,
      })),
    )
    if (lines.length === 0) return res.status(400).json({ error: 'This invoice has no line items to recreate' })

    const wasCancelled = String(existing.status ?? '').toLowerCase() === 'cancelled'
    // New supplier invoice number: bump the run number (INV-005 → INV-006,
    // PI-2026-0041 → PI-2026-0042); the helper falls back to a date suffix
    // when the number has no digits. Shared with the pure unit tests in
    // purchases.test.ts so the multi-digit-run case stays pinned.
    const number = String(existing.number ?? '').trim()
    let newNumber = bumpPurchaseInvoiceNumber(number)
    // Avoid a unique-number clash.
    for (let attempt = 1; attempt <= 20; attempt++) {
      const [clash] = await db!.select({ id: s.purchaseInvoices.id }).from(s.purchaseInvoices).where(eq(s.purchaseInvoices.number, newNumber)).limit(1)
      if (!clash) break
      newNumber = bumpPurchaseInvoiceNumber(number, 1 + attempt)
    }

    // Cancel the old invoice: take back the stock it added (once), then
    // remove the old rows. Fire the stock reversal inside the transaction so
    // the books stay consistent if the recreate fails.
    const removed = await db!.transaction(async (tx) => {
      if (!wasCancelled) {
        const { reversePurchaseStock } = await import('../purchases')
        await reversePurchaseStock(existing.id, tx as never)
      }
      await tx.delete(s.purchaseInvoiceItems).where(eq(s.purchaseInvoiceItems.invoiceId, existing.id))
      await tx.delete(s.purchaseInvoices).where(eq(s.purchaseInvoices.id, existing.id))
      return existing
    })
    recordCrud('purchase-invoices', 'Deleted', req, removed)

    // Reuse the create helper so stock is applied exactly once and totals,
    // GST split and TCS are computed the same way as a manual entry.
    const created = await insertPurchaseInvoice({
      number: newNumber,
      supplier: existing.supplier,
      items: lines,
      supplierGstin: existing.supplierGstin,
      date: new Date().toISOString(),
      orderId: existing.orderId,
      status: 'pending',
      locationId: existing.locationId,
    })
    recordCrud('purchase-invoices', 'Created', req, created.row)
    res.status(201).json({
      ok: true,
      cancelled: number,
      invoice: newNumber,
      ...stripHash(created.row),
      lines: created.saved.lines,
      stockedSkus: created.saved.stocked,
    })
  } catch (err) {
    logger.error({ err }, 'purchase invoice recreate failed')
    res.status(500).json({ error: 'Failed to recreate purchase invoice' })
  }
})

dbRouter.get('/purchase-invoices/:id', oneOf(s.purchaseInvoices, s.purchaseInvoices.id))
dbRouter.get('/purchase-orders', listOf(s.purchaseOrders, s.purchaseOrders.date))

// Purchase orders with their line items attached (an order without lines only
// carries totals, so the "what did we actually order" question is unanswerable).
dbRouter.get('/purchase-orders/with-items', requirePermission('purchase', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const { getOrderLines } = await import('../purchases')
    const limit = Math.min(200, Math.max(1, num(req.query.limit, 100)))
    const orders = await db!.select().from(s.purchaseOrders).orderBy(desc(s.purchaseOrders.date)).limit(limit)
    const lines = await getOrderLines(orders.map((o) => o.id))
    const byOrder = new Map<string, typeof lines>()
    for (const l of lines) {
      const key = String(l.orderId)
      const arr = byOrder.get(key) ?? []
      arr.push(l)
      byOrder.set(key, arr)
    }
    res.json({
      page: 1,
      pageSize: limit,
      total: orders.length,
      data: orders.map((o) => ({
        ...o,
        lines: (byOrder.get(o.id) ?? []).map((l) => ({
          id: l.id,
          product: l.product ?? '',
          sku: l.sku ?? '',
          qty: Number(l.qty ?? 0),
          weight: Number(l.weight ?? 0),
          rate: Number(l.rate ?? 0),
          amount: Number(l.amount ?? 0),
        })),
      })),
    })
  } catch (err) {
    logger.error({ err }, 'purchase orders with-items failed')
    res.status(500).json({ error: 'Failed to load purchase orders' })
  }
})

dbRouter.get('/purchase-orders/:id/with-items', requirePermission('purchase', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const { getOrderLines } = await import('../purchases')
    const [order] = await db!.select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, routeParam(req.params.id))).limit(1)
    if (!order) return res.status(404).json({ error: 'Purchase order not found' })
    const lines = await getOrderLines([order.id])
    res.json({
      ...order,
      lines: lines.map((l) => ({
        id: l.id,
        product: l.product ?? '',
        sku: l.sku ?? '',
        qty: Number(l.qty ?? 0),
        weight: Number(l.weight ?? 0),
        rate: Number(l.rate ?? 0),
        amount: Number(l.amount ?? 0),
      })),
    })
  } catch (err) {
    logger.error({ err }, 'purchase order with-items failed')
    res.status(500).json({ error: 'Failed to load purchase order' })
  }
})

// Shared GST math for a PO: subtotal (from lines or the stored value) plus
// the order's gst rate/discount → { gstAmount, grandTotal }.
function poMoneyTotals(subtotal: number, gstRate: number, discount: number) {
  const gstAmount = round2((subtotal * gstRate) / 100)
  return { gstAmount, grandTotal: round2(subtotal + gstAmount - discount) }
}

// GST rate for a stored PO row. NULL predates the GST columns (or was set
// explicitly) — fall back to the 3% default. Never use num() here: num(null, 3)
// returns 0 because Number(null) is a finite 0, which would silently zero the
// rate on every legacy edit.
function poGstRate(stored: unknown): number {
  return stored == null || stored === '' ? 3 : num(stored, 3)
}

// Full edit of a purchase order: header fields (supplier, status, dates,
// notes, GST rate, discount) plus optional replacement lines. Registered
// before the generic /:resource loop so it — not the generic handler — owns
// PATCH /purchase-orders/:id. Totals (items/qty/weight/value, gst amount,
// grand total) are ALWAYS derived server-side so the header can never drift
// from the lines.
dbRouter.patch('/purchase-orders/:id', requirePermission('purchase', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const { normalizeOrderLines, orderLineTotals, saveOrderLines, ensurePurchaseInvoiceForOrder } = await import('../purchases')
    const [order] = await db!.select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, routeParam(req.params.id))).limit(1)
    if (!order) return res.status(404).json({ error: 'Purchase order not found' })

    const body = sanitize(req.body ?? {}, s.purchaseOrders)
    delete body.id
    // Numbers are system-minted with a unique index — never client-editable.
    delete body.number
    // Derived fields are recomputed below, never taken from the client.
    delete body.items
    delete body.qty
    delete body.weight
    delete body.value
    delete body.gstAmount
    delete body.grandTotal

    const rawGst = (req.body ?? {}).gst
    const gst = rawGst === undefined || rawGst === null || rawGst === '' ? poGstRate(order.gst) : Number(rawGst)
    const rawDiscount = (req.body ?? {}).discount
    const discount = rawDiscount === undefined || rawDiscount === null || rawDiscount === '' ? num(order.discount, 0) : Number(rawDiscount)
    if (!Number.isFinite(gst) || gst < 0 || gst > 100) return res.status(400).json({ error: 'gst must be a percentage between 0 and 100' })
    if (!Number.isFinite(discount) || discount < 0) return res.status(400).json({ error: 'discount must be 0 or more' })

    // Lines are only replaced when an array was sent (count-shaped `items: 3`
    // from legacy bodies is ignored — it is a derived field, not line data).
    const rawLines = Array.isArray(req.body?.lines)
      ? req.body.lines
      : Array.isArray(req.body?.items)
        ? req.body.items
        : undefined
    let lines: Awaited<ReturnType<typeof normalizeOrderLines>> | null = null
    if (rawLines !== undefined) {
      lines = normalizeOrderLines(rawLines)
      if (lines.length === 0) return res.status(400).json({ error: 'At least one line item is required' })
    }

    const base = lines ? orderLineTotals(lines) : { items: order.items, qty: order.qty, weight: order.weight, value: order.value }
    const subtotal = num(base.value, 0)
    const { gstAmount, grandTotal } = poMoneyTotals(subtotal, gst, discount)

    const [updated] = await db!
      .update(s.purchaseOrders)
      .set({ ...body, gst, discount, gstAmount, grandTotal, ...base })
      .where(eq(s.purchaseOrders.id, order.id))
      .returning()
    let savedLines: number | undefined
    if (lines) savedLines = await saveOrderLines(order.id, lines)
    recordCrud('purchase-orders', 'Updated', req, updated)
    // Auto-invoice: edited lines change what is owed to the supplier, so the
    // linked purchase invoice is refreshed to match (header-only edits skip).
    let autoInvoice: string | undefined
    let autoInvoiceSkipped: string | undefined
    if (lines) {
      try {
        const ensured = await ensurePurchaseInvoiceForOrder(order.id)
        if (ensured.ok) {
          autoInvoice = ensured.invoice.number
          recordCrud('purchase-invoices', ensured.action === 'created' ? 'Created' : 'Updated', req, ensured.invoice)
        } else {
          autoInvoiceSkipped = ensured.skipped
        }
      } catch (err) {
        logger.error({ err }, 'auto purchase invoice refresh failed')
        autoInvoiceSkipped = 'auto-invoice failed — check server logs'
      }
    }
    res.json({
      ...stripHash(updated),
      ...(lines ? { lines } : {}),
      ...(savedLines !== undefined ? { linesSaved: savedLines } : {}),
      ...(autoInvoice ? { autoInvoice } : {}),
      ...(autoInvoiceSkipped ? { autoInvoiceSkipped } : {}),
    })
  } catch (err) {
    logger.error({ err }, 'purchase order update failed')
    res.status(500).json({ error: 'Failed to update purchase order' })
  }
})

// Replace a PO's lines. Orders only become stock when the purchase invoice is
// recorded, so this never touches inventory.
dbRouter.patch('/purchase-orders/:id/lines', requirePermission('purchase', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const { normalizeOrderLines, orderLineTotals, saveOrderLines, ensurePurchaseInvoiceForOrder } = await import('../purchases')
    const [order] = await db!.select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, routeParam(req.params.id))).limit(1)
    if (!order) return res.status(404).json({ error: 'Purchase order not found' })
    const lines = normalizeOrderLines(req.body?.items ?? req.body?.lines)
    if (lines.length === 0) return res.status(400).json({ error: 'At least one line item is required' })
    const totals = orderLineTotals(lines)
    // Recompute the GST breakdown too — the stored rate/discount apply to the
    // new subtotal so the header totals can never go stale after a line edit.
    const money = poMoneyTotals(num(totals.value, 0), poGstRate(order.gst), num(order.discount, 0))
    const [updated] = await db!
      .update(s.purchaseOrders)
      .set({ ...totals, ...money })
      .where(eq(s.purchaseOrders.id, order.id))
      .returning()
    const saved = await saveOrderLines(order.id, lines)
    recordCrud('purchase-orders', 'Updated', req, updated)
    // Auto-invoice: the order's lines are what gets billed — as soon as they
    // land, raise the order's purchase invoice (or refresh the one it has).
    // Never fails the order save itself; the next save retries idempotently.
    let autoInvoice: string | undefined
    let autoInvoiceSkipped: string | undefined
    try {
      const ensured = await ensurePurchaseInvoiceForOrder(order.id)
      if (ensured.ok) {
        autoInvoice = ensured.invoice.number
        recordCrud('purchase-invoices', ensured.action === 'created' ? 'Created' : 'Updated', req, ensured.invoice)
      } else {
        autoInvoiceSkipped = ensured.skipped
      }
    } catch (err) {
      logger.error({ err }, 'auto purchase invoice failed')
      autoInvoiceSkipped = 'auto-invoice failed — check server logs'
    }
    res.json({
      ...stripHash(updated),
      lines,
      linesSaved: saved,
      ...(autoInvoice ? { autoInvoice } : {}),
      ...(autoInvoiceSkipped ? { autoInvoiceSkipped } : {}),
    })
  } catch (err) {
    logger.error({ err }, 'purchase order lines update failed')
    res.status(500).json({ error: 'Failed to save purchase order lines' })
  }
})

dbRouter.get('/purchase-orders/:id', oneOf(s.purchaseOrders, s.purchaseOrders.id))

dbRouter.get('/sales-returns', listOf(s.salesReturns, s.salesReturns.date))
dbRouter.get('/sales-returns/:id', oneOf(s.salesReturns, s.salesReturns.id))

dbRouter.get('/purchase-returns', listOf(s.purchaseReturns, s.purchaseReturns.date))

// ─── Purchase returns ───────────────────────────────────────────────────────

// Returns carry line items so the goods can actually come back out of stock.
// Stock only moves when the return is RECEIVED — a pending or approved return
// is paperwork.
dbRouter.get('/purchase-returns/with-lines', requirePermission('purchase', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const { getReturnLines } = await import('../purchases')
    const limit = Math.min(200, Math.max(1, num(req.query.limit, 100)))
    const returns = await db!.select().from(s.purchaseReturns).orderBy(desc(s.purchaseReturns.date)).limit(limit)
    const byReturn = new Map<string, Awaited<ReturnType<typeof getReturnLines>>>()
    for (const r of returns) byReturn.set(r.id, await getReturnLines(r.id))
    res.json({
      page: 1,
      pageSize: limit,
      total: returns.length,
      data: returns.map((r) => ({
        ...r,
        lines: (byReturn.get(r.id) ?? []).map((l) => ({
          id: l.id,
          product: l.product ?? '',
          sku: l.sku ?? '',
          qty: Number(l.qty ?? 0),
          weight: Number(l.weight ?? 0),
          rate: Number(l.rate ?? 0),
          amount: Number(l.amount ?? 0),
        })),
      })),
    })
  } catch (err) {
    logger.error({ err }, 'purchase returns with-lines failed')
    res.status(500).json({ error: 'Failed to load purchase returns' })
  }
})

dbRouter.post('/purchase-returns', requirePermission('purchase', 'create'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const { normalizeReturnLines, returnLineTotals, saveReturnLines } = await import('../purchases')
    const body = (req.body ?? {}) as Record<string, unknown>
    const number = String(body.number ?? '').trim()
    const supplier = String(body.supplier ?? '').trim()
    if (!number) return res.status(400).json({ error: 'Return number is required' })
    if (!supplier) return res.status(400).json({ error: 'supplier is required' })
    const lines = normalizeReturnLines(body.items ?? body.lines)
    if (lines.length === 0) return res.status(400).json({ error: 'At least one line item is required so stock can be taken back' })
    const totals = returnLineTotals(lines)
    const status = String(body.status ?? 'pending')
    const reverseStock = status === 'received'
    // Goods go back to the shop they were received into, so resolve through the
    // original invoice rather than defaulting to the main store.
    const invoiceId = body.invoiceId ? String(body.invoiceId) : null
    let existingInvoiceLocation: string | null = null
    if (invoiceId) {
      const [inv] = await db!
        .select({ locationId: s.purchaseInvoices.locationId })
        .from(s.purchaseInvoices)
        .where(eq(s.purchaseInvoices.id, invoiceId))
        .limit(1)
      existingInvoiceLocation = inv?.locationId ?? null
    }

    const id = randomUUID()
    const result = await db!.transaction(async (tx) => {
      const [row] = await tx
        .insert(s.purchaseReturns)
        .values({
          id,
          number,
          supplier,
          invoiceId: invoiceId,
          items: totals.items,
          weight: totals.weight,
          amount: totals.amount,
          status,
          date: body.date ? String(body.date) : new Date().toISOString(),
        } as any)
        .returning()
      const saved = await saveReturnLines(tx as never, id, lines, { reverseStock, locationId: existingInvoiceLocation ?? null })
      return { row, saved }
    })

    recordCrud('purchase-returns', 'Created', req, result.row)
    logger.info(
      { number, supplier, lines: result.saved.lines, reversed: result.saved.reversed },
      'Purchase return recorded',
    )
    res.status(201).json({ ...stripHash(result.row), lines, linesSaved: result.saved.lines, reversedSkus: result.saved.reversed })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    logger.error({ err }, 'purchase return create failed')
    const isDuplicate = /unique|duplicate key/i.test(`${msg} ${(err as { cause?: unknown })?.cause instanceof Error ? (err as Error & { cause: Error }).cause.message : ''}`)
    res.status(isDuplicate ? 400 : 500).json({ error: isDuplicate ? 'That return number already exists' : 'Failed to create purchase return' })
  }
})

// Receiving a return takes the goods back out of stock; un-receiving puts them
// back. Cancelling a *received* return also reverses, so nothing is stranded.
dbRouter.patch('/purchase-returns/:id', requirePermission('purchase', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const { restoreReturnStock, reverseReturnStock } = await import('../purchases')
    const body = (req.body ?? {}) as Record<string, unknown>
    const [existing] = await db!.select().from(s.purchaseReturns).where(eq(s.purchaseReturns.id, routeParam(req.params.id))).limit(1)
    if (!existing) return res.status(404).json({ error: 'Purchase return not found' })

    const wasReceived = String(existing.status ?? '').toLowerCase() === 'received'
    const nextStatus = body.status !== undefined ? String(body.status).toLowerCase() : null
    const nowReceived = nextStatus === 'received'
    const nowCancelled = nextStatus === 'cancelled'
    const patch: Record<string, unknown> = {}
    for (const key of ['number', 'supplier', 'invoiceId', 'date'] as const) {
      if (body[key] !== undefined) patch[key] = body[key] === null ? null : String(body[key])
    }
    if (nextStatus) patch.status = nextStatus

    const { updated, moved } = await db!.transaction(async (tx) => {
      let moved = 0
      if (wasReceived && (nowCancelled || (nextStatus !== null && !nowReceived))) {
        // Leaving the received state — goods go back on the shelf.
        moved = await restoreReturnStock(existing.id, tx as never)
      } else if (!wasReceived && (nowReceived || nowCancelled)) {
        // Entering received (or being cancelled while already received).
        moved = await reverseReturnStock(existing.id, tx as never)
      }
      const [row] = await tx.update(s.purchaseReturns).set(patch as never).where(eq(s.purchaseReturns.id, existing.id)).returning()
      return { updated: row, moved }
    })

    recordCrud('purchase-returns', 'Updated', req, updated)
    res.json({ ...stripHash(updated), stockMoved: moved })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    logger.error({ err }, 'purchase return update failed')
    res.status(500).json({ error: msg })
  }
})

// Ordered vs received — what a PO actually got, ignoring cancelled invoices.
dbRouter.get('/purchase-orders/:id/receipt', requirePermission('purchase', 'view'), async (req, res) => {
  try {
    const { reconcileOrder } = await import('../purchases')
    const receipt = await reconcileOrder(routeParam(req.params.id))
    if (!receipt) return res.status(404).json({ error: 'Purchase order not found' })
    res.json(receipt)
  } catch (err) {
    logger.error({ err }, 'order receipt reconciliation failed')
    res.status(500).json({ error: 'Failed to reconcile purchase order' })
  }
})
dbRouter.get('/purchase-returns/:id', oneOf(s.purchaseReturns, s.purchaseReturns.id))

dbRouter.get('/inventory/locations', listOf(s.inventoryLocations, s.inventoryLocations.name))

/**
 * Per-location aggregates for the locations list: how many products are held
 * there, how many units in total, and what they are worth at cost. Kept out of
 * the plain list route so the existing `/inventory/locations` shape (used by
 * the transfer dropdowns) does not change.
 *
 * Registered before `/inventory/locations/:id` so "stock-summary" is not
 * swallowed by the :id pattern.
 */
dbRouter.get('/inventory/locations/stock-summary', requirePermission('inventory', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const rows = await db!
      .select({
        locationId: s.stockLevels.locationId,
        products: sql<number>`count(distinct ${s.stockLevels.productId})::int`,
        quantity: sql<string>`coalesce(sum(${s.stockLevels.qty}), 0)`,
        valueAtCost: sql<string>`coalesce(sum(${s.stockLevels.qty} * coalesce(${s.products.costPrice}, 0)), 0)`,
      })
      .from(s.stockLevels)
      .innerJoin(s.products, eq(s.products.id, s.stockLevels.productId))
      .groupBy(s.stockLevels.locationId)

    const summary = new Map(rows.map((r) => [r.locationId, {
      products: Number(r.products ?? 0),
      quantity: Number(r.quantity ?? 0),
      valueAtCost: Number(r.valueAtCost ?? 0),
    }]))
    res.json(summary)
  } catch (err) {
    logger.error({ err }, 'location stock summary failed')
    res.status(500).json({ error: 'Could not load location stock summary' })
  }
})

/**
 * Create a location, optionally counting stock in at the point of opening it.
 *
 * A new location starts empty, so without this the only way to give it stock is
 * a transfer or a stock count some time later. The counted quantities post as
 * `opening` movements at the new location, which is deliberate: they are stock
 * that physically exists and belongs to the business, so the total across all
 * locations goes UP. This is not a split of an existing position — that is what
 * a transfer is for.
 */
dbRouter.post('/inventory/locations', requirePermission('inventory', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const name = String(req.body?.name ?? '').trim()
    if (!name) return res.status(400).json({ error: 'Location name is required' })
    if (name.length > 120) return res.status(400).json({ error: 'Location name is too long' })

    const [existing] = await db!.select({ id: s.inventoryLocations.id }).from(s.inventoryLocations).where(eq(s.inventoryLocations.name, name)).limit(1)
    if (existing) return res.status(400).json({ error: `A location called "${name}" already exists` })

    const opening = Array.isArray(req.body?.openingBalances) ? req.body.openingBalances : []

    // Resolve every SKU up front so a typo fails the whole request instead of
    // silently opening a location that is missing stock the user counted.
    const wanted = new Map<string, number>()
    for (const entry of opening) {
      const sku = String((entry as { sku?: unknown })?.sku ?? '').trim()
      const qty = Math.floor(Number((entry as { qty?: unknown })?.qty ?? 0))
      if (!sku || Number.isNaN(qty) || qty === 0) continue
      wanted.set(sku, (wanted.get(sku) ?? 0) + qty)
    }
    const skus = [...wanted.keys()]
    const products = skus.length
      ? await db!.select({ id: s.products.id, sku: s.products.sku }).from(s.products).where(inArray(s.products.sku, skus))
      : []
    const found = new Set(products.map((p) => p.sku))
    const missing = skus.filter((sku) => !found.has(sku))
    if (missing.length) return res.status(400).json({ error: `Unknown SKU: ${missing.join(', ')}` })

    const result = await db!.transaction(async (tx) => {
      const [location] = await tx
        .insert(s.inventoryLocations)
        .values({
          id: randomUUID(),
          name,
          type: String(req.body?.type ?? '').trim() || 'store',
          city: req.body?.city != null && String(req.body.city).trim() ? String(req.body.city).trim() : null,
          manager: req.body?.manager != null && String(req.body.manager).trim() ? String(req.body.manager).trim() : null,
        })
        .returning()

      const actor = actorFromRequest(req).userId ?? 'system'
      for (const product of products) {
        await applyStockMovement({
          sku: product.sku,
          qty: wanted.get(product.sku) ?? 0,
          type: 'opening',
          locationId: location.id,
          refType: 'inventory_location',
          refId: location.id,
          note: `opening balance for ${name}`,
          createdBy: actor,
          tx,
        })
      }
      return location
    })

    recordCrud('inventory/locations', 'Created', req, { name, type: result.type, openingLines: products.length })
    res.status(201).json({ ...result, openingLines: products.length })
  } catch (err) {
    logger.error({ err }, 'location create failed')
    res.status(500).json({ error: err instanceof Error ? err.message : 'Could not create location' })
  }
})

dbRouter.get('/inventory/locations/:id', oneOf(s.inventoryLocations, s.inventoryLocations.id))

// ─── Inventory pricing collections & categories ───────────────────────────
// Foundation only: these routes describe how products are grouped (Silver
// Jewels → silver-rate pricing, Other Products → fixed-price pricing). They do
// not read or write product prices, SKUs, sales or Shopify, and products keep
// their free-text category/collection columns exactly as they are. Category
// names are globally unique so products.category stays unambiguous; SKU
// prefixes are globally unique so future category-based codes cannot collide.

dbRouter.get('/inventory/collections', requirePermission('inventory', 'view'), async (_req, res) => {
  if (!requireDb(res)) return
  try {
    const rows = await db!
      .select({
        id: s.collections.id,
        name: s.collections.name,
        pricingType: s.collections.pricingType,
        isSystem: s.collections.isSystem,
        createdAt: s.collections.createdAt,
        updatedAt: s.collections.updatedAt,
        categoryCount: sql<number>`count(distinct ${s.productCategories.id})::int`,
        productCount: sql<number>`count(${s.products.id})::int`,
      })
      .from(s.collections)
      .leftJoin(s.productCategories, eq(s.productCategories.collectionId, s.collections.id))
      // Products still store their category as text; matching on the name is
      // what lets the page show how much of the catalogue each group holds.
      .leftJoin(s.products, eq(s.products.category, s.productCategories.name))
      .groupBy(s.collections.id)
      .orderBy(desc(s.collections.isSystem), s.collections.name)
    res.json({ data: rows })
  } catch (err) {
    logger.error({ err }, 'collections list failed')
    res.status(500).json({ error: 'Could not load collections' })
  }
})

/**
 * Rename a collection. The id is the identity: only the display name changes,
 * so categories, products and any future references keep pointing at the same
 * row. System collections (Silver Jewels) and the pricing type are immutable.
 */
dbRouter.patch('/inventory/collections/:id', requirePermission('inventory', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const id = routeParam(req.params.id)
    const [collection] = await db!.select().from(s.collections).where(eq(s.collections.id, id)).limit(1)
    if (!collection) return res.status(404).json({ error: 'Collection not found' })

    const requestedPricing = req.body?.pricingType
    if (requestedPricing !== undefined && String(requestedPricing) !== collection.pricingType) {
      return res.status(400).json({ error: 'A collection\'s pricing type is fixed when it is created' })
    }
    if ('isSystem' in (req.body ?? {}) && Boolean(req.body.isSystem) !== collection.isSystem) {
      return res.status(400).json({ error: 'The system flag cannot be changed' })
    }
    if (collection.isSystem) {
      return res.status(400).json({
        error: 'The Silver Jewels collection is fixed — its name and pricing behaviour cannot be changed',
      })
    }
    if (req.body?.name === undefined) return res.status(400).json({ error: 'Nothing to update' })

    const name = normalizeCollectionName(req.body.name)
    const invalid = collectionNameError(name)
    if (invalid) return res.status(400).json({ error: invalid })

    const [clash] = await db!
      .select({ id: s.collections.id })
      .from(s.collections)
      .where(sql`lower(${s.collections.name}) = lower(${name}) and ${s.collections.id} <> ${id}`)
      .limit(1)
    if (clash) return res.status(400).json({ error: `A collection called "${name}" already exists` })

    const [row] = await db!
      .update(s.collections)
      .set({ name, updatedAt: new Date().toISOString() })
      .where(eq(s.collections.id, id))
      .returning()

    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Renamed collection',
      module: 'inventory',
      entity: `${collection.name} → ${row.name}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json(row)
  } catch (err) {
    logger.error({ err }, 'collection rename failed')
    res.status(400).json({ error: 'Could not rename the collection' })
  }
})

dbRouter.get('/inventory/categories', requirePermission('inventory', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const collectionId = String(req.query.collectionId ?? '').trim()
    const rows = await db!
      .select({
        id: s.productCategories.id,
        collectionId: s.productCategories.collectionId,
        name: s.productCategories.name,
        prefix: s.productCategories.prefix,
        createdAt: s.productCategories.createdAt,
        updatedAt: s.productCategories.updatedAt,
        productCount: sql<number>`count(${s.products.id})::int`,
      })
      .from(s.productCategories)
      .leftJoin(s.products, eq(s.products.category, s.productCategories.name))
      .where(collectionId ? eq(s.productCategories.collectionId, collectionId) : undefined)
      .groupBy(s.productCategories.id)
      .orderBy(s.productCategories.name)
    res.json({ data: rows })
  } catch (err) {
    logger.error({ err }, 'categories list failed')
    res.status(500).json({ error: 'Could not load categories' })
  }
})

dbRouter.post('/inventory/categories', requirePermission('inventory', 'create'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const collectionId = String(req.body?.collectionId ?? '').trim()
    const name = normalizeCategoryName(req.body?.name)
    const prefix = normalizeCategoryPrefix(req.body?.prefix)
    if (!collectionId) return res.status(400).json({ error: 'Choose the collection this category belongs to' })
    const nameInvalid = categoryNameError(name)
    if (nameInvalid) return res.status(400).json({ error: nameInvalid })
    const prefixInvalid = categoryPrefixError(prefix)
    if (prefixInvalid) return res.status(400).json({ error: prefixInvalid })

    const [collection] = await db!.select({ id: s.collections.id, name: s.collections.name }).from(s.collections).where(eq(s.collections.id, collectionId)).limit(1)
    if (!collection) return res.status(400).json({ error: 'Unknown collection' })

    const [clash] = await db!
      .select({ id: s.productCategories.id, name: s.productCategories.name, prefix: s.productCategories.prefix })
      .from(s.productCategories)
      .where(or(sql`lower(${s.productCategories.name}) = lower(${name})`, eq(s.productCategories.prefix, prefix)))
      .limit(1)
    if (clash) {
      return res.status(400).json({
        error: clash.prefix === prefix
          ? `SKU prefix ${prefix} is already used by "${clash.name}"`
          : `A category called "${name}" already exists`,
      })
    }

    const now = new Date().toISOString()
    const [row] = await db!
      .insert(s.productCategories)
      .values({ id: randomUUID(), collectionId, name, prefix, createdAt: now, updatedAt: now })
      .returning()

    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Created category',
      module: 'inventory',
      entity: `${row.name} (${row.prefix}) in ${collection.name}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.status(201).json({ ...row, productCount: 0 })
  } catch (err) {
    logger.error({ err }, 'category create failed')
    res.status(400).json({ error: 'Could not create the category' })
  }
})

/**
 * Edit a category or move it to another collection. Renaming propagates to the
 * products that carry the old name (products.category is text), so no product
 * is left pointing at a category that no longer exists. SKUs, prices and stock
 * are never touched.
 */
dbRouter.patch('/inventory/categories/:id', requirePermission('inventory', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const id = routeParam(req.params.id)
    const [category] = await db!.select().from(s.productCategories).where(eq(s.productCategories.id, id)).limit(1)
    if (!category) return res.status(404).json({ error: 'Category not found' })

    const name = req.body?.name === undefined ? category.name : normalizeCategoryName(req.body.name)
    const prefix = req.body?.prefix === undefined ? category.prefix : normalizeCategoryPrefix(req.body.prefix)
    const collectionId = req.body?.collectionId === undefined
      ? category.collectionId
      : String(req.body.collectionId).trim()
    if (!collectionId) return res.status(400).json({ error: 'Choose the collection this category belongs to' })

    const nameInvalid = categoryNameError(name)
    if (nameInvalid) return res.status(400).json({ error: nameInvalid })
    const prefixInvalid = categoryPrefixError(prefix)
    if (prefixInvalid) return res.status(400).json({ error: prefixInvalid })

    const [collection] = await db!.select({ id: s.collections.id }).from(s.collections).where(eq(s.collections.id, collectionId)).limit(1)
    if (!collection) return res.status(400).json({ error: 'Unknown collection' })

    const [clash] = await db!
      .select({ name: s.productCategories.name, prefix: s.productCategories.prefix })
      .from(s.productCategories)
      .where(and(
        ne(s.productCategories.id, id),
        or(sql`lower(${s.productCategories.name}) = lower(${name})`, eq(s.productCategories.prefix, prefix)),
      ))
      .limit(1)
    if (clash) {
      return res.status(400).json({
        error: clash.prefix === prefix
          ? `SKU prefix ${prefix} is already used by "${clash.name}"`
          : `A category called "${name}" already exists`,
      })
    }

    const result = await db!.transaction(async (tx) => {
      const renamed = name !== category.name
      let productsUpdated = 0
      if (renamed) {
        const [counted] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(s.products)
          .where(sql`lower(${s.products.category}) = lower(${category.name})`)
        productsUpdated = Number(counted?.n ?? 0)
        if (productsUpdated > 0) {
          await tx
            .update(s.products)
            .set({ category: name })
            .where(sql`lower(${s.products.category}) = lower(${category.name})`)
        }
      }
      const [row] = await tx
        .update(s.productCategories)
        .set({ name, prefix, collectionId, updatedAt: new Date().toISOString() })
        .where(eq(s.productCategories.id, id))
        .returning()
      return { row, productsUpdated }
    })

    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Updated category',
      module: 'inventory',
      entity: `${category.name} → ${result.row.name} (${result.row.prefix})`,
      details: result.productsUpdated > 0 ? `${result.productsUpdated} product(s) relabelled` : undefined,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ...result.row, productsUpdated: result.productsUpdated })
  } catch (err) {
    logger.error({ err }, 'category update failed')
    res.status(400).json({ error: 'Could not update the category' })
  }
})

dbRouter.get('/inventory/transfers', listOf(s.stockTransfers, s.stockTransfers.date))
dbRouter.get('/inventory/transfers/:id', oneOf(s.stockTransfers, s.stockTransfers.id))

// The stock ledger: every movement, newest first. Optionally filtered to one
// SKU and/or a date window, which is what the product page shows.
dbRouter.get('/inventory/movements', requirePermission('inventory', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const sku = typeof req.query.sku === 'string' ? req.query.sku.trim() : ''
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200) || 200))

    // A date-only "to" bound is inclusive, so widen it to the end of that day —
    // otherwise everything on the final day is silently dropped.
    const fromRaw = typeof req.query.from === 'string' ? req.query.from.trim() : ''
    const toRaw = typeof req.query.to === 'string' ? req.query.to.trim() : ''
    const from = fromRaw ? new Date(fromRaw) : null
    let to = toRaw ? new Date(toRaw) : null
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(toRaw)) to = new Date(to.getTime() + 86_399_999)

    const filters = []
    if (sku) filters.push(eq(s.stockMovements.sku, sku))
    if (from && !Number.isNaN(from.getTime())) filters.push(gte(s.stockMovements.date, from.toISOString()))
    if (to && !Number.isNaN(to.getTime())) filters.push(lte(s.stockMovements.date, to.toISOString()))
    const where = filters.length ? and(...filters) : undefined

    const rows = await db!
      .select()
      .from(s.stockMovements)
      .where(where)
      .orderBy(desc(s.stockMovements.date))
      .limit(limit)
    res.json(rows)
  } catch (err) {
    logger.error({ err }, 'stock movements list failed')
    res.status(500).json({ error: 'Could not load stock movements' })
  }
})

// Stock on hand per location for one product, or for everything.
dbRouter.get('/inventory/levels', requirePermission('inventory', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const sku = typeof req.query.sku === 'string' ? req.query.sku.trim() : ''
    const rows = sku
      ? await db!.select().from(s.stockLevels).innerJoin(s.products, eq(s.products.id, s.stockLevels.productId)).where(eq(s.products.sku, sku))
      : await db!.select().from(s.stockLevels)
    res.json(rows.map((r) => {
      const level = 'stock_levels' in r ? r.stock_levels : r
      const product = 'products' in r ? r.products : null
      return {
        productId: level.productId,
        sku: product?.sku ?? null,
        locationId: level.locationId,
        qty: Number(level.qty ?? 0),
      }
    }))
  } catch (err) {
    logger.error({ err }, 'stock levels list failed')
    res.status(500).json({ error: 'Could not load stock levels' })
  }
})

// Create a transfer. This is what makes a transfer actually move stock: the
// record and the paired ledger movements are written together, so the document
// and the balances can never disagree.
/** Resolves a location by canonical ID, with display-name fallback for legacy transfers. */
async function resolveLocation(input: string, tx?: Tx): Promise<string | null> {
  const value = String(input ?? '').trim()
  const client = tx ?? db
  if (!value || !client) return null
  const [byId] = await client.select({ id: s.inventoryLocations.id }).from(s.inventoryLocations).where(eq(s.inventoryLocations.id, value)).limit(1)
  if (byId) return byId.id
  const [byName] = await client.select({ id: s.inventoryLocations.id }).from(s.inventoryLocations).where(eq(s.inventoryLocations.name, value)).limit(1)
  return byName?.id ?? null
}

dbRouter.post('/inventory/transfers', requirePermission('inventory', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const sku = String(req.body?.sku ?? '').trim()
    const qty = Number(req.body?.qty)
    const fromRaw = String(req.body?.from ?? '').trim()
    const toRaw = String(req.body?.to ?? '').trim()
    if (!sku || !Number.isSafeInteger(qty) || qty <= 0 || !fromRaw || !toRaw) {
      return res.status(400).json({ error: 'sku, positive whole-number qty, from and to are required' })
    }

    const created = await db!.transaction(async (tx) => {
      const from = await resolveLocation(fromRaw, tx)
      const to = await resolveLocation(toRaw, tx)
      if (!from) throw Object.assign(new Error(`Unknown source location "${fromRaw}"`), { status: 400 })
      if (!to) throw Object.assign(new Error(`Unknown destination location "${toRaw}"`), { status: 400 })
      if (from === to) throw Object.assign(new Error('Source and destination must differ'), { status: 400 })

      const [product] = await tx.select({ id: s.products.id, name: s.products.name }).from(s.products).where(eq(s.products.sku, sku)).limit(1)
      if (!product) throw Object.assign(new Error(`Unknown SKU ${sku}`), { status: 404 })

      // Lock the product before checking source stock. Concurrent transfers and
      // sales then serialize on the same row instead of both trusting a stale balance.
      await tx.select({ id: s.products.id }).from(s.products).where(eq(s.products.id, product.id)).for('update')
      const [fromLevel] = await tx.select({ qty: s.stockLevels.qty })
        .from(s.stockLevels)
        .where(and(eq(s.stockLevels.productId, product.id), eq(s.stockLevels.locationId, from)))
        .limit(1)
      const available = Number(fromLevel?.qty ?? 0)
      if (available < qty) {
        throw Object.assign(new Error(`Only ${available} in stock at ${fromRaw}, tried to move ${qty}`), { status: 400 })
      }

      // Generate identifiers on the server. Client-side list counts are stale
      // under multi-computer use and can produce duplicate transfer numbers.
      // The 8-hex suffix is random, not sequential: two concurrent creates cannot
      // race for a shared counter, and the unique index is the final backstop.
      const number = `ST-${new Date().getFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`
      // from/to store the canonical location IDs — the id, not a display name
      // that breaks the moment a location is renamed. The bootstrap upgrade
      // migrates legacy name-valued rows to their IDs.
      const [row] = await tx.insert(s.stockTransfers).values({
        id: randomUUID(),
        number,
        from,
        to,
        product: product.name ?? null,
        sku,
        qty,
        weight: req.body?.weight != null ? Number(req.body.weight) : null,
        initiatedBy: actorFromRequest(req).userId ?? 'system',
        // Pending means the goods are still sitting at the source. Stock moves
        // on dispatch, not on creation — otherwise a transfer that is never
        // dispatched has already emptied the shelf it was meant to refill.
        status: 'pending',
        date: new Date().toISOString(),
      }).returning()
      return row
    })

    recordCrud('stockTransfers', 'Created', req, { number: created.number, sku, qty, from: created.from, to: created.to })
    res.status(201).json(created)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    if (status === 500) logger.error({ err }, 'stock transfer create failed')
    res.status(status).json({ error: err instanceof Error ? err.message : 'Transfer failed' })
  }
})

/** Dispatch: the goods leave the source, so the balance there drops. */
dbRouter.post('/inventory/transfers/:id/dispatch', requirePermission('inventory', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const updated = await db!.transaction(async (tx) => {
      // FOR UPDATE serialises concurrent dispatch attempts on the same
      // transfer: the second arrives after the first committed and hits the
      // status check, instead of both moving the stock.
      const [transfer] = await tx.select().from(s.stockTransfers).where(eq(s.stockTransfers.id, routeParam(req.params.id))).limit(1).for('update')
      if (!transfer) throw Object.assign(new Error('Transfer not found'), { status: 404 })
      if (transfer.status !== 'pending') {
        throw Object.assign(new Error(`Cannot dispatch a transfer that is ${transfer.status}`), { status: 400 })
      }
      const from = await resolveLocation(String(transfer.from ?? ''), tx)
      const to = await resolveLocation(String(transfer.to ?? ''), tx)
      if (!from || !to) throw Object.assign(new Error('Transfer locations no longer exist'), { status: 400 })

      const sku = String(transfer.sku ?? '')
      const [product] = await tx.select({ id: s.products.id }).from(s.products).where(eq(s.products.sku, sku)).limit(1)
      if (!product) throw Object.assign(new Error(`Unknown SKU ${sku}`), { status: 400 })
      const [level] = await tx
        .select({ qty: s.stockLevels.qty })
        .from(s.stockLevels)
        .where(and(eq(s.stockLevels.productId, product.id), eq(s.stockLevels.locationId, from)))
        .limit(1)
      const available = Number(level?.qty ?? 0)
      if (available < Number(transfer.qty ?? 0)) {
        throw Object.assign(new Error(`Only ${available} in stock at ${transfer.from}, tried to move ${transfer.qty}`), { status: 400 })
      }

      // Stock physically leaves the source. It lands at the destination on
      // receive, so goods in transit are in neither location's balance. The
      // movement rides the caller's transaction: if the status update below
      // fails, the deduction rolls back with it rather than evaporating stock.
      await applyStockMovement({
        sku,
        qty: -Number(transfer.qty ?? 0),
        type: 'transfer_out',
        locationId: from,
        refType: 'stock_transfer',
        refId: transfer.id,
        createdBy: actorFromRequest(req).userId ?? 'system',
        tx,
      })
      const [row] = await tx
        .update(s.stockTransfers)
        .set({ status: 'in-transit' })
        .where(eq(s.stockTransfers.id, transfer.id))
        .returning()
      return row
    })
    recordCrud('stockTransfers', 'Updated', req, { id: routeParam(req.params.id), status: 'in-transit' })
    res.json(updated)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    if (status === 500) logger.error({ err }, 'transfer dispatch failed')
    res.status(status).json({ error: err instanceof Error ? err.message : 'Dispatch failed' })
  }
})

/**
 * Receive: the goods arrive, so the destination balance rises.
 *
 * The counted quantity may differ from what was dispatched — goods go missing
 * or turn up extra between stores. That variance needs no correcting movement:
 * dispatch already removed the dispatched quantity from the source, so posting
 * only what was actually counted leaves the total across locations correctly
 * lower (or higher) by exactly the variance. Recording it on the transfer and
 * in the movement note is what makes the difference explainable rather than a
 * mystery discrepancy.
 */
dbRouter.post('/inventory/transfers/:id/receive', requirePermission('inventory', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const updated = await db!.transaction(async (tx) => {
      const [transfer] = await tx.select().from(s.stockTransfers).where(eq(s.stockTransfers.id, routeParam(req.params.id))).limit(1).for('update')
      if (!transfer) throw Object.assign(new Error('Transfer not found'), { status: 404 })
      if (transfer.status !== 'in-transit') {
        throw Object.assign(new Error(`Cannot receive a transfer that is ${transfer.status}`), { status: 400 })
      }
      const to = await resolveLocation(String(transfer.to ?? ''), tx)
      if (!to) throw Object.assign(new Error('Destination location no longer exists'), { status: 400 })

      const dispatched = Math.floor(Number(transfer.qty ?? 0))
      // Absent means "received in full", so callers that post no body keep the
      // previous behaviour unchanged.
      const raw = req.body?.receivedQty
      const received = raw == null || raw === '' ? dispatched : Math.floor(Number(raw))
      if (!Number.isFinite(received) || received < 0) {
        throw Object.assign(new Error('Counted quantity must be zero or more'), { status: 400 })
      }
      const variance = received - dispatched

      // received === 0 is legitimate (everything was lost or refused); it just
      // has no inbound movement to post.
      if (received > 0) {
        await applyStockMovement({
          sku: String(transfer.sku ?? ''),
          qty: received,
          type: 'transfer_in',
          locationId: to,
          refType: 'stock_transfer',
          refId: transfer.id,
          note: variance === 0 ? undefined : `received ${received} of ${dispatched} (${variance < 0 ? `${-variance} short` : `${variance} over`})`,
          createdBy: actorFromRequest(req).userId ?? 'system',
          tx,
        })
      }

      const [row] = await tx
        .update(s.stockTransfers)
        .set({ status: 'received', receivedQty: received, variance })
        .where(eq(s.stockTransfers.id, transfer.id))
        .returning()
      return row
    })
    recordCrud('stockTransfers', 'Updated', req, {
      id: routeParam(req.params.id),
      status: 'received',
      receivedQty: updated.receivedQty,
      variance: updated.variance,
    })
    res.json(updated)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    if (status === 500) logger.error({ err }, 'transfer receive failed')
    res.status(status).json({ error: err instanceof Error ? err.message : 'Receive failed' })
  }
})

/** Cancel: an in-transit transfer has to put the stock back where it came from. */
dbRouter.post('/inventory/transfers/:id/cancel', requirePermission('inventory', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const updated = await db!.transaction(async (tx) => {
      const [transfer] = await tx.select().from(s.stockTransfers).where(eq(s.stockTransfers.id, routeParam(req.params.id))).limit(1).for('update')
      if (!transfer) throw Object.assign(new Error('Transfer not found'), { status: 404 })
      // Only a pending or in-transit transfer can be cancelled. Repeating a
      // cancel used to fall through as a silent no-op write; the second
      // request is refused instead of pretending to transition again.
      if (transfer.status !== 'pending' && transfer.status !== 'in-transit') {
        throw Object.assign(new Error(`Cannot cancel a transfer that is ${transfer.status}`), { status: 400 })
      }
      if (transfer.status === 'in-transit') {
        const from = await resolveLocation(String(transfer.from ?? ''), tx)
        if (!from) throw Object.assign(new Error('Source location no longer exists'), { status: 400 })
        // It left the source on dispatch, so cancelling returns it there. The
        // return must commit with the status flip, or a failed cancel would
        // leave stock duplicated (deducted on dispatch, "restored" here).
        await applyStockMovement({
          sku: String(transfer.sku ?? ''),
          qty: Number(transfer.qty ?? 0),
          type: 'transfer_in',
          locationId: from,
          refType: 'stock_transfer',
          refId: transfer.id,
          note: 'transfer cancelled — returned to source',
          createdBy: actorFromRequest(req).userId ?? 'system',
          tx,
        })
      }
      const [row] = await tx
        .update(s.stockTransfers)
        .set({ status: 'cancelled' })
        .where(eq(s.stockTransfers.id, transfer.id))
        .returning()
      return row
    })
    recordCrud('stockTransfers', 'Updated', req, { id: routeParam(req.params.id), status: 'cancelled' })
    res.json(updated)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    if (status === 500) logger.error({ err }, 'transfer cancel failed')
    res.status(status).json({ error: err instanceof Error ? err.message : 'Cancel failed' })
  }
})

dbRouter.get('/bank-accounts', async (req, res) => {
  if (!requireDb(res)) return
  try {
    const result = await paginate(s.bankAccounts, req.query, s.bankAccounts.name, req)
    result.data = result.data.map(stripHash).map(maskBankAccount)
    res.json(result)
  } catch (err) { logger.error({ err }, 'bank-accounts list failed'); res.status(500).json({ error: 'Internal server error' }) }
})
dbRouter.get('/bank-accounts/:id', async (req, res) => {
  if (!requireDb(res)) return
  try {
    const rows = await db!.select().from(s.bankAccounts).where(eq(s.bankAccounts.id, routeParam(req.params.id))).limit(1)
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(maskBankAccount(stripHash(rows[0])))
  } catch (err) { logger.error({ err }, 'bank-accounts get failed'); res.status(500).json({ error: 'Internal server error' }) }
})

dbRouter.get('/ledger', listOf(s.ledgerEntries, s.ledgerEntries.date))
dbRouter.get('/ledger/:id', oneOf(s.ledgerEntries, s.ledgerEntries.id))

dbRouter.get('/expenses', listOf(s.expenses, s.expenses.date))
dbRouter.get('/expenses/:id', oneOf(s.expenses, s.expenses.id))

dbRouter.get('/payments', listOf(s.payments, s.payments.date))
dbRouter.get('/payments/:id', oneOf(s.payments, s.payments.id))

dbRouter.get('/users', requirePermission('system', 'view'), listOf(s.users, s.users.name))
dbRouter.get('/users/:id', requirePermission('system', 'view'), oneOf(s.users, s.users.id))

dbRouter.get('/audit-logs', listOf(s.auditLogs, s.auditLogs.timestamp))
dbRouter.get('/audit-logs/:id', oneOf(s.auditLogs, s.auditLogs.id))

dbRouter.get('/activity-logs', listOf(s.activityLogs, s.activityLogs.timestamp))
dbRouter.get('/activity-logs/:id', oneOf(s.activityLogs, s.activityLogs.id))

dbRouter.get('/sync-logs', listOf(s.syncLogs, desc(s.syncLogs.time)))
dbRouter.get('/sync-logs/:id', oneOf(s.syncLogs, s.syncLogs.id))

dbRouter.get('/silver-rates', listOf(s.silverRates, s.silverRates.updatedAt))
dbRouter.get('/silver-rates/:id', oneOf(s.silverRates, s.silverRates.id))

dbRouter.get('/gold-rates', listOf(s.goldRates, s.goldRates.updatedAt))
dbRouter.get('/gold-rates/:id', oneOf(s.goldRates, s.goldRates.id))

dbRouter.get('/currencies', listOf(s.currencies, s.currencies.code))

dbRouter.get('/currencies/exchange-rate', requirePermission('system', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const from = String(req.query.from ?? '').trim().toUpperCase()
    const to = String(req.query.to ?? 'INR').trim().toUpperCase()
    if (!from) return res.status(400).json({ error: 'from parameter is required' })

    const rows = await db!.select().from(s.currencies)
    const byCode = new Map(rows.map((r) => [r.code, r]))

    const fromCurrency = byCode.get(from)
    const toCurrency = byCode.get(to)
    if (!fromCurrency) return res.status(404).json({ error: `Currency ${from} not found` })
    if (!toCurrency) return res.status(404).json({ error: `Currency ${to} not found` })

    // Both rates are relative to INR; convert through INR
    const fromRate = Number(fromCurrency.exchangeRate ?? 1)
    const toRate = Number(toCurrency.exchangeRate ?? 1)
    const rate = toRate / fromRate

    res.json({ from, to, rate: Math.round(rate * 10000) / 10000, fromCurrency, toCurrency })
  } catch (err) {
    logger.error({ err }, 'exchange rate lookup failed')
    res.status(500).json({ error: 'Exchange rate lookup failed' })
  }
})

const SETTINGS_ID = 'app'

/** Secrets are shown masked (••••last4) — never raw in API responses. */
const maskSecret = (v: string): string => (v ? (v.length <= 4 ? '••••' : '••••' + v.slice(-4)) : '')

// Encrypted credential columns must never be returned by the generic GET /settings
// (they are only surfaced through /settings/connections which masks them).
const SETTINGS_SECRET_COLUMNS = new Set([
  'shopifyStoreUrlEncrypted',
  'shopifyAccessTokenEncrypted',
  'webhookSecretEncrypted',
  'dbHostEncrypted',
  'dbPortEncrypted',
  'dbDatabaseEncrypted',
  'dbUserEncrypted',
  'dbPasswordEncrypted',
])

dbRouter.get('/settings', requirePermission('system', 'view'), async (_req, res) => {
  if (!requireDb(res)) return
  try {
    const rows = await db!.select().from(s.settings).where(eq(s.settings.id, SETTINGS_ID)).limit(1)
    const row = rows[0] ? { ...rows[0] } : null
    if (row) {
      for (const k of SETTINGS_SECRET_COLUMNS) delete row[k as keyof typeof row]
      // The recovery password (hash or legacy ciphertext) never rides along
      // in the generic payload — it is read/written only by
      // /settings/recovery-password.
      if (row.notificationSettings && typeof row.notificationSettings === 'object') {
        const ns = { ...(row.notificationSettings as Record<string, unknown>) }
        delete ns[RECOVERY_PASSWORD_KEY]
        delete ns[RECOVERY_PASSWORD_HASH_KEY]
        ;(row as Record<string, unknown>).notificationSettings = ns
      }
    }
    res.json(row ?? null)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

dbRouter.put('/settings', requirePermission('system', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const body = sanitize(req.body ?? {}, s.settings)
    delete body.id
    // Never allow writing encrypted credential columns through the generic
    // settings endpoint; connection secrets are managed via /settings/connections.
    for (const k of SETTINGS_SECRET_COLUMNS) delete body[k as keyof typeof body]
    // Same rule for the recovery password override: a settings round-trip must
    // preserve the stored value untouched (the dedicated endpoint manages it).
    // The two "Daily Summary" switches (Business Settings column + Notification
    // Settings flag) drive the same email, so a write to either one updates both.
    const wantsNsUpdate = !!(body.notificationSettings && typeof body.notificationSettings === 'object')
    if (wantsNsUpdate || typeof body.dailySummary === 'boolean') {
      const [current] = await db!.select({ ns: s.settings.notificationSettings }).from(s.settings).where(eq(s.settings.id, SETTINGS_ID)).limit(1)
      const existingNs = (current?.ns ?? null) as Record<string, unknown> | null
      const incoming: Record<string, unknown> = wantsNsUpdate
        ? { ...(body.notificationSettings as Record<string, unknown>) }
        : { ...existingNs }
      delete incoming[RECOVERY_PASSWORD_KEY]
      delete incoming[RECOVERY_PASSWORD_HASH_KEY]
      if (existingNs && RECOVERY_PASSWORD_KEY in existingNs) {
        incoming[RECOVERY_PASSWORD_KEY] = existingNs[RECOVERY_PASSWORD_KEY]
      }
      if (existingNs && RECOVERY_PASSWORD_HASH_KEY in existingNs) {
        incoming[RECOVERY_PASSWORD_HASH_KEY] = existingNs[RECOVERY_PASSWORD_HASH_KEY]
      }
      if (typeof body.dailySummary === 'boolean') {
        incoming.dailySummaryEnabled = body.dailySummary
      }
      body.notificationSettings = incoming
    }
    body.updatedAt = new Date().toISOString()
    const [row] = await db!
      .insert(s.settings)
      .values({ id: SETTINGS_ID, ...body })
      .onConflictDoUpdate({ target: s.settings.id, set: body })
      .returning()
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Updated Settings',
      module: 'system',
      entity: 'Settings',
      details: `Business settings updated (${Object.keys(body).filter((k) => k !== 'updatedAt').join(', ')})`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json(row)
  } catch {
    res.status(400).json({ error: 'Failed to update settings' })
  }
})

// ─── Superadmin recovery password ─────────────────────────────────────────
// The stable password that can act as an Admin / Super Admin login password
// when the owner has forgotten theirs (login-direct; see recoveryPassword.ts).
// Owner roles only: a system.view/edit user with any other role gets 403 and
// never sees the value.
async function ownerOnlyGuard(req: Request, res: Response): Promise<boolean> {
  const userId = req.userId
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' })
    return false
  }
  const perms = await computeUserPermissions(userId)
  if (!perms) {
    res.status(401).json({ error: 'User not found' })
    return false
  }
  if (!isRecoveryRole(perms.role)) {
    res.status(403).json({ error: 'Only Admin / Super Admin accounts can manage the recovery password' })
    return false
  }
  return true
}

dbRouter.get('/settings/recovery-password', requirePermission('system', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    if (!(await ownerOnlyGuard(req, res))) return
    res.json({ source: await getRecoveryPasswordSource() })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

dbRouter.put('/settings/recovery-password', requirePermission('system', 'edit'), validate(recoveryPasswordSchema), async (req, res) => {
  if (!requireDb(res)) return
  try {
    if (!(await ownerOnlyGuard(req, res))) return
    const reset = req.body?.reset === true
    if (reset) await clearRecoveryPassword()
    else await setRecoveryPassword(String(req.body?.password ?? ''))
    const actor = actorFromRequest(req)
    void recordActivity({
      action: reset ? 'Recovery Password Reset to Default' : 'Recovery Password Rotated',
      module: 'system',
      entity: 'Settings',
      details: reset
        ? 'Recovery password set back to the built-in default'
        : 'Recovery password changed to a custom value',
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ok: true, source: await getRecoveryPasswordSource() })
  } catch (err) {
    logger.error({ err }, 'recovery password update failed')
    res.status(500).json({ error: 'Failed to update recovery password' })
  }
})

dbRouter.get('/settings/connections', requirePermission('system', 'view'), async (_req, res) => {
  if (!requireDb(res)) return
  try {
    const rows = await db!.select().from(s.settings).where(eq(s.settings.id, SETTINGS_ID)).limit(1)
    const row = rows[0]
    if (!row) {
      res.json({
        shopifyStoreUrl: shopifyConfig.shop || '',
        shopifyAccessToken: maskSecret(shopifyConfig.accessToken || ''),
        shopifyApiVersion: shopifyConfig.apiVersion || '2025-10',
        webhookSecret: '',
        shopifyConfigured: isShopifyConfigured(),
        dbHost: '',
        dbPort: '5432',
        dbDatabase: 'opal_line',
        dbUser: '',
        dbPassword: '',
        dbConfigured: false,
      })
      return
    }

    let shopifyStoreUrl = ''
    let shopifyAccessToken = ''
    let webhookSecret = ''
    try { if (row.shopifyStoreUrlEncrypted) shopifyStoreUrl = decrypt(row.shopifyStoreUrlEncrypted) } catch { /* */ }
    try { if (row.shopifyAccessTokenEncrypted) shopifyAccessToken = decrypt(row.shopifyAccessTokenEncrypted) } catch { /* */ }
    try { if (row.webhookSecretEncrypted) webhookSecret = decrypt(row.webhookSecretEncrypted) } catch { /* */ }

    let dbHost = ''
    let dbPort = '5432'
    let dbDatabase = 'opal_line'
    let dbUser = ''
    let dbPassword = ''
    try { if (row.dbHostEncrypted) dbHost = decrypt(row.dbHostEncrypted) } catch { /* */ }
    try { if (row.dbPortEncrypted) dbPort = decrypt(row.dbPortEncrypted) } catch { /* */ }
    try { if (row.dbDatabaseEncrypted) dbDatabase = decrypt(row.dbDatabaseEncrypted) } catch { /* */ }
    try { if (row.dbUserEncrypted) dbUser = decrypt(row.dbUserEncrypted) } catch { /* */ }
    try { if (row.dbPasswordEncrypted) dbPassword = decrypt(row.dbPasswordEncrypted) } catch { /* */ }

    res.json({
      shopifyStoreUrl: shopifyStoreUrl || '',
      shopifyAccessToken: maskSecret(shopifyAccessToken),
      shopifyApiVersion: row.shopifyApiVersion ?? '2025-10',
      webhookSecret: maskSecret(webhookSecret),
      shopifyConfigured: isShopifyConfigured() || Boolean(shopifyStoreUrl && shopifyAccessToken),
      dbHost: dbHost || '',
      dbPort: dbPort || '',
      dbDatabase: dbDatabase || '',
      dbUser: dbUser || '',
      dbPassword: maskSecret(dbPassword),
      dbConfigured: Boolean(dbHost && dbUser && dbPassword),
    })
  } catch {
    res.status(500).json({ error: 'Failed to load connection settings' })
  }
})

// Masked values are •-prefixed (••••last4 or all bullets) — a real credential
// never starts with •, so prefix-matching is the safe “leave unchanged” test.
const MASKED_VALUE_PATTERN = /^•/

dbRouter.put('/settings/connections', requirePermission('system', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const { shopifyStoreUrl, shopifyAccessToken, shopifyApiVersion, webhookSecret, dbHost, dbPort, dbDatabase, dbUser, dbPassword } = req.body ?? {}
    const body: Record<string, unknown> = { updatedAt: new Date().toISOString() }

    const isMasked = (value: unknown): boolean =>
      typeof value === 'string' && (MASKED_VALUE_PATTERN.test(value) || value.includes('\uFFFD'))

    if (typeof shopifyStoreUrl === 'string' && shopifyStoreUrl.length > 0 && !isMasked(shopifyStoreUrl)) {
      body.shopifyStoreUrlEncrypted = encrypt(normalizeShopDomain(shopifyStoreUrl))
    } else if (shopifyStoreUrl === '') {
      body.shopifyStoreUrlEncrypted = null
    }

    if (typeof shopifyAccessToken === 'string' && shopifyAccessToken.length > 0 && !isMasked(shopifyAccessToken)) {
      body.shopifyAccessTokenEncrypted = encrypt(shopifyAccessToken)
    }

    if (typeof shopifyApiVersion === 'string') {
      body.shopifyApiVersion = shopifyApiVersion
    }

    if (typeof webhookSecret === 'string' && webhookSecret.length > 0 && !isMasked(webhookSecret)) {
      body.webhookSecretEncrypted = encrypt(webhookSecret)
    } else if (webhookSecret === '') {
      body.webhookSecretEncrypted = null
    }

    if (typeof dbHost === 'string' && dbHost.length > 0 && !isMasked(dbHost)) {
      body.dbHostEncrypted = encrypt(dbHost)
    }
    if (typeof dbPort === 'string' && dbPort.length > 0 && !isMasked(dbPort)) {
      body.dbPortEncrypted = encrypt(dbPort)
    }
    if (typeof dbDatabase === 'string' && dbDatabase.length > 0 && !isMasked(dbDatabase)) {
      body.dbDatabaseEncrypted = encrypt(dbDatabase)
    }
    if (typeof dbUser === 'string' && dbUser.length > 0 && !isMasked(dbUser)) {
      body.dbUserEncrypted = encrypt(dbUser)
    }
    if (typeof dbPassword === 'string' && dbPassword.length > 0 && !isMasked(dbPassword)) {
      body.dbPasswordEncrypted = encrypt(dbPassword)
    }

    await db!
      .insert(s.settings)
      .values({ id: SETTINGS_ID, ...body })
      .onConflictDoUpdate({ target: s.settings.id, set: body })
      .returning()

    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Updated Connection Settings',
      module: 'system',
      entity: 'Settings',
      details: 'Connection settings updated',
      userId: actor.userId,
      ip: actor.ip,
    })

    // If DB credentials changed, reconnect
    if (typeof dbHost === 'string' && typeof dbPassword === 'string' && typeof dbUser === 'string' && dbHost && dbUser && dbPassword && !isMasked(dbPassword)) {
      const { reconnect } = await import('../db/client')
      const port = (typeof dbPort === 'string' && dbPort) ? dbPort : '5432'
      const database = (typeof dbDatabase === 'string' && dbDatabase) ? dbDatabase : 'opal_line'
      const host = typeof dbHost === 'string' ? dbHost.replace(/[^\w.-]/g, '') : ''
      if (!host || !/^[a-zA-Z0-9._-]+$/.test(host)) {
        res.status(400).json({ error: 'Invalid database host' })
        return
      }
      const dbPortNum = parseInt(port, 10)
      if (isNaN(dbPortNum) || dbPortNum < 1 || dbPortNum > 65535) {
        res.status(400).json({ error: 'Invalid database port' })
        return
      }
      if (!/^[a-zA-Z0-9_]+$/.test(dbUser)) {
        res.status(400).json({ error: 'Invalid database user' })
        return
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(database)) {
        res.status(400).json({ error: 'Invalid database name' })
        return
      }
      const url = `postgresql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@${host}:${port}/${database}`
      const result = await reconnect(url)
      if (!result.ok) {
        res.json({ ok: true, reconnectError: result.error })
        return
      }
    }

    // Reload secrets into runtime config
    const { loadSecretsFromDb } = await import('../config')
    await loadSecretsFromDb()

    // Persist Shopify config to the .env file (encrypted) so it drives the app on next start too
    if (typeof shopifyStoreUrl === 'string' && shopifyStoreUrl.length > 0 && !isMasked(shopifyStoreUrl)) {
      upsertEnvVar('SHOPIFY_STORE_URL', encryptSecret(normalizeShopDomain(shopifyStoreUrl)))
    }
    if (typeof shopifyAccessToken === 'string' && shopifyAccessToken.length > 0 && !isMasked(shopifyAccessToken)) {
      upsertEnvVar('SHOPIFY_ACCESS_TOKEN', encryptSecret(shopifyAccessToken))
    }
    if (typeof shopifyApiVersion === 'string' && shopifyApiVersion.length > 0) {
      upsertEnvVar('SHOPIFY_API_VERSION', shopifyApiVersion)
    }
    if (typeof webhookSecret === 'string' && webhookSecret.length > 0 && !isMasked(webhookSecret)) {
      upsertEnvVar('SHOPIFY_WEBHOOK_SECRET', encryptSecret(webhookSecret))
    }

    // Test the Shopify connection and report the result to the caller
    const { testShopifyConnection } = await import('../shopify')
    const shopify = await testShopifyConnection()
    if (shopify.ok) {
      logger.info('Shopify connection verified on save')
    } else {
      logger.warn({ error: shopify.error }, 'Shopify connection test failed on save')
    }

    res.json({ ok: true, shopify })
  } catch {
    res.status(400).json({ error: 'Failed to save connection settings' })
  }
})

dbRouter.get('/settings/db-status', requirePermission('system', 'view'), async (_req, res) => {
  try {
    const { isDbConnected } = await import('../db/client')
    if (!isDbConnected()) {
      res.json({ connected: false, error: 'Not connected' })
      return
    }
    const health = await checkDbHealth()
    const url = process.env.DATABASE_URL ?? ''
    let host = '', port = '5432', dbname = '', user = ''
    try {
      const u = new URL(url)
      host = u.hostname
      port = u.port || '5432'
      dbname = u.pathname.replace(/^\//, '')
      user = u.username
    } catch { /* */ }

    res.json({
      connected: health.healthy,
      latencyMs: health.latencyMs,
      error: health.error,
      host: host || '',
      port: port || '',
      database: dbname || '',
      user: user || '',
    })
  } catch {
    res.json({ connected: false, error: 'Health check failed' })
  }
})

// products.stock is the rollup across stock_levels, recomputed on every
// movement. These two routes shadow the generic resource CRUD for products so
// the ledger stays the only writer: a direct write would be silently reverted
// by the next movement of any kind, which reads to a user as "my edit didn't
// save". Stock is changed by a stock count at a location, or by a transfer.
dbRouter.patch('/products/:id', requirePermission('inventory', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const body = sanitize(req.body ?? {}, s.products)
    delete body.id
    // Product identifiers are immutable through a general edit: an existing
    // SKU is never silently overwritten, and the barcode workflow is gone
    // (legacy column — never written from here either).
    delete body.sku
    delete body.barcode
    if (body.stock != null) {
      return res.status(400).json({
        error: 'Stock is managed by the stock ledger. Use a stock count for the location, or a transfer.',
      })
    }
    if (Object.keys(body).length === 0) return res.status(400).json({ error: 'No valid fields provided' })

    const [existing] = await db!
      .select()
      .from(s.products)
      .where(eq(s.products.id, routeParam(req.params.id)))
      .limit(1)
    if (!existing) return res.status(404).json({ error: 'Not found' })

    // Collection/category association. Only touched when the request carries
    // it, so an unrelated edit (status, image, price) never re-links a product.
    // The ids stay authoritative; the displayed names are refreshed from the
    // rows so a renamed collection/category reads correctly on the product.
    let collection: Awaited<ReturnType<typeof findCollection>> = null
    const touchesAssociation =
      body.collectionId !== undefined || body.categoryId !== undefined || body.category !== undefined
    if (touchesAssociation) {
      const association = await resolveProductAssociation(db!, {
        collectionId: body.collectionId === undefined ? existing.collectionId : body.collectionId,
        categoryId: body.categoryId === undefined ? existing.categoryId : body.categoryId,
        categoryName: body.category === undefined ? existing.category : body.category,
      })
      if (!association.ok) return res.status(400).json({ error: association.error })
      collection = association.collection
      if (association.category) {
        body.category = association.category.name
        body.categoryId = association.category.id
      } else if (body.categoryId !== undefined) {
        // Legacy free-text category (or the row was removed): keep the text,
        // drop the dangling link.
        body.categoryId = null
      }
      if (association.collection) {
        body.collectionId = association.collection.id
        body.collection = association.collection.name
      }
      if (!String(body.category ?? existing.category ?? '').trim()) {
        return res.status(400).json({ error: 'A category is required to generate the product SKU' })
      }
    }

    // A fixed-price collection prices from the entered selling price alone. The
    // piece-rate flag is the existing protection that keeps silver-rate changes
    // and Shopify pulls from overwriting it, so it is set from the collection
    // rather than left to the caller. Silver-collection edits keep every
    // existing pricing behaviour (including a product the user marked piece-rate).
    if (body.sellingPrice !== undefined && collection?.pricingType === 'fixed') {
      const error = fixedPriceError(body.sellingPrice)
      if (error) return res.status(400).json({ error })
      const price = Number(body.sellingPrice)
      body.sellingPrice = price
      body.fixedPieceRate = price
      body.pieceRateProduct = true
    }

    const [row] = await db!.update(s.products).set(body).where(eq(s.products.id, existing.id)).returning()
    if (!row) return res.status(404).json({ error: 'Not found' })
    if (body.sellingPrice !== undefined) await recordProductPrice(row.id, row.sellingPrice)
    recordCrud('products', 'Updated', req, row)
    res.json(row)
  } catch (err) {
    logger.error({ err }, 'product update failed')
    res.status(400).json({ error: 'Failed to update product' })
  }
})

// Set a product's count at ONE location, straight from the product edit
// dialog. Unlike POST /inventory/stock-count, the baseline here mirrors
// applyStockMovement's pre-ledger adoption rule: a product that has never
// been through the ledger counts against products.stock instead of a missing
// level row, which would double-count it. Each call posts a count_adjust
// movement, so the ledger still explains the new balance.
dbRouter.patch('/products/:id/stock', requirePermission('inventory', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const [product] = await db!
      .select({ id: s.products.id, sku: s.products.sku, stock: s.products.stock, shopifyId: s.products.shopifyId })
      .from(s.products)
      .where(eq(s.products.id, routeParam(req.params.id)))
      .limit(1)
    if (!product) return res.status(404).json({ error: 'Product not found' })
    const sku = String(product.sku ?? '').trim()
    if (!sku) return res.status(400).json({ error: 'Product has no SKU — stock cannot be tracked' })

    const target = Math.floor(Number(req.body?.stock))
    if (!Number.isFinite(target) || target < 0) {
      return res.status(400).json({ error: 'stock must be a whole number of 0 or more' })
    }

    const locationId = await resolveMovementLocation(String(req.body?.locationId ?? ''))
    const [level] = await db!
      .select({ qty: s.stockLevels.qty })
      .from(s.stockLevels)
      .where(and(eq(s.stockLevels.productId, product.id), eq(s.stockLevels.locationId, locationId)))
      .limit(1)
    let current = stockAtLocation(level?.qty)
    if (!level) {
      const [anywhere] = await db!
        .select({ locationId: s.stockLevels.locationId })
        .from(s.stockLevels)
        .where(eq(s.stockLevels.productId, product.id))
        .limit(1)
      if (!anywhere && locationId === DEFAULT_LOCATION_ID) current = stockAtLocation(product.stock)
    }

    const delta = target - current
    if (delta === 0) {
      return res.json({ ok: true, changed: false, stock: stockAtLocation(product.stock), previous: current, locationId })
    }
    const next = await applyStockMovement({
      sku,
      qty: delta,
      type: 'count_adjust',
      locationId,
      refType: 'product_edit',
      note: `stock set to ${target} from product edit (was ${current} at ${locationId})`,
      createdBy: actorFromRequest(req).userId ?? 'system',
    })
    // Push the new balance to Shopify for genuinely listed products — editing
    // a stock count in the product dialog must move the store too, not just
    // the ledger. Best-effort and awaited (same pattern as the stock-count
    // endpoint's pushToShopify): the local count already stands on failure.
    // Unlisted / placeholder-linked SKUs are skipped so a plain local edit
    // never triggers a Shopify round-trip.
    let shopifyPush: Awaited<ReturnType<typeof pushInventoryToShopify>> | null = null
    const shopifyId = String(product.shopifyId ?? '').trim()
    const linked = shopifyId !== '' && !shopifyId.startsWith('#')
    if (next !== null && linked) {
      try {
        shopifyPush = await pushInventoryToShopify([product.id])
      } catch (err) {
        shopifyPush = { ok: false, updated: 0, skipped: 0, errors: [err instanceof Error ? err.message : 'Shopify push failed'] }
      }
    }
    res.json({ ok: true, changed: true, stock: next ?? target, previous: current, locationId, shopifyPush })
  } catch (err) {
    logger.error({ err }, 'product stock update failed')
    res.status(400).json({ error: 'Failed to update stock' })
  }
})

// Creating a product may state an opening quantity, but it is posted through
// the ledger as an `opening` movement so the new product has real history
// rather than a balance that appears from nowhere.
dbRouter.post('/products', requirePermission('inventory', 'create'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const body = sanitize(req.body ?? {}, s.products)
    const name = String(body.name ?? '').trim()
    const requestedSku = String(body.sku ?? '').trim()
    // The category is what the SKU prefix is derived from (Chains → OL-CHN): a
    // product without one would mint a meaningless OL-GEN code, so it is
    // required here rather than left to the NOT NULL constraint. A categoryId
    // is enough on its own — its row names the category.
    const category = String(body.category ?? '').trim()
    if (!name) return res.status(400).json({ error: 'Product name is required' })
    if (!category && !String(body.categoryId ?? '').trim()) {
      return res.status(400).json({ error: 'A category is required to generate the product SKU' })
    }
    body.name = name
    if (category) body.category = category

    // Collection/category association: the stable ids decide the pricing model
    // (fixed-price collections price from the entered selling price) and the
    // SKU prefix (the category's own prefix). No explicit collection keeps the
    // legacy behaviour — free-text grouping and the silver-rate formula.
    const association = await resolveProductAssociation(db!, {
      collectionId: body.collectionId,
      collectionName: body.collection,
      categoryId: body.categoryId,
      categoryName: category,
    })
    if (!association.ok) return res.status(400).json({ error: association.error })
    if (association.category) {
      body.category = association.category.name
      body.categoryId = association.category.id
    } else {
      body.categoryId = null
    }
    if (association.collection) {
      body.collectionId = association.collection.id
      body.collection = association.collection.name
    } else if (body.collectionId === '') {
      body.collectionId = null
    }
    if (!String(body.category ?? '').trim()) {
      return res.status(400).json({ error: 'A category is required to generate the product SKU' })
    }
    // A fixed-price product never runs the silver formula: the entered selling
    // price is the price, and the piece-rate flag carries the existing
    // protection (silver-rate changes and Shopify pulls leave it alone).
    if (association.collection?.pricingType === 'fixed') {
      const priceError = fixedPriceError(body.sellingPrice)
      if (priceError) return res.status(400).json({ error: priceError })
      const price = Number(body.sellingPrice)
      body.sellingPrice = price
      body.fixedPieceRate = price
      body.pieceRateProduct = true
      body.silverRate = null
    }
    // Barcodes are gone: never write the legacy column from a create.
    delete body.barcode
    if (requestedSku) body.sku = requestedSku
    else delete body.sku

    const openingQty = Math.floor(Number(body.stock ?? 0))
    delete body.stock
    if (!body.id) body.id = randomUUID()
    // Every creation path stamps the time — the products list is ordered
    // newest-first down to the second, and NULLs would float to the top of a
    // DESC sort.
    if (!body.createdAt) body.createdAt = new Date().toISOString()

    const locationRaw = String((req.body as { locationId?: unknown })?.locationId ?? '').trim()
    const locationId = openingQty > 0 ? (locationRaw ? await resolveLocation(locationRaw) : await ensureDefaultLocation()) : null
    if (openingQty > 0 && !locationId) return res.status(400).json({ error: `Unknown location "${locationRaw}"` })

    const row = await db!.transaction(async (tx) => {
      // Concurrency-safe identity: a stated SKU is checked for duplicates
      // under a per-code advisory lock; an absent SKU is minted under the
      // category's advisory lock (generateUniqueSku). Either way two
      // concurrent creates can never commit the same identifier — the unique
      // index on products.sku is the final backstop.
      let sku: string
      if (requestedSku) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`sku:claim:${requestedSku.toUpperCase()}`}))`)
        const [dup] = await tx
          .select({ id: s.products.id })
          .from(s.products)
          .where(sql`upper(${s.products.sku}) = upper(${requestedSku})`)
          .limit(1)
        if (dup) throw new Error(`A product with that SKU already exists`)
        sku = requestedSku
      } else {
        // Mint under the configured Product codes settings so an API/scripted
        // create mints exactly what the dialog would have proposed. The
        // category's own prefix wins when the product belongs to a catalogue
        // category — the collection's name is never part of a SKU.
        sku = await generateUniqueSku(
          tx,
          String(body.category ?? ''),
          await productCodeSettings(tx),
          association.category?.prefix,
        )
      }

      const [created] = await tx.insert(s.products).values({ ...body, sku } as never).returning()
      if (openingQty > 0 && created.sku) {
        await applyStockMovement({
          sku: String(created.sku),
          qty: openingQty,
          type: 'opening',
          locationId,
          note: 'opening stock recorded when the product was created',
          createdBy: actorFromRequest(req).userId ?? 'system',
          tx,
        })
      }
      return created
    })
    if (row) await recordProductPrice(row.id, row.sellingPrice)
    recordCrud('products', 'Created', req, row)
    res.status(201).json(row)
  } catch (err) {
    const msg = errorText(err)
    logger.error({ err }, 'product create failed')
    if (msg.includes('SKU already exists')) return res.status(409).json({ error: msg })
    res.status(400).json({ error: msg.includes('duplicate') ? 'A product with that SKU already exists' : 'Failed to create product' })
  }
})

// ─── Shopify-style product variants ────────────────────────────────────────
// Option definitions live on the parent (products.options: [{ name, values }]);
// each option-value combination is a product_variants row with its own SKU,
// barcode, price and stock. products.stock is kept as the SUM of the variant
// stocks (via a count_adjust ledger movement, never a silent overwrite), so
// every existing sale, report and ledger flow keeps working on the parent.

dbRouter.get('/products/:id/variants', requirePermission('inventory', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const [product] = await db!
      .select({ id: s.products.id, options: s.products.options })
      .from(s.products)
      .where(eq(s.products.id, routeParam(req.params.id)))
      .limit(1)
    if (!product) return res.status(404).json({ error: 'Product not found' })
    const variants = await db!.select().from(s.productVariants).where(eq(s.productVariants.productId, product.id))
    res.json({ options: Array.isArray(product.options) ? product.options : [], variants })
  } catch (err) {
    logger.error({ err }, 'product variants read failed')
    res.status(500).json({ error: 'Failed to load variants' })
  }
})

// Replace-all save (the dialog owns the whole option/variant set, exactly
// like Shopify's editor): validate, then swap the variant rows in one
// transaction and roll the stock difference into the parent ledger.
dbRouter.put('/products/:id/variants', requirePermission('inventory', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  const parsed = saveProductVariantsSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors })
  }
  const { options, variants } = parsed.data
  try {
    const [product] = await db!
      .select({ id: s.products.id, sku: s.products.sku, stock: s.products.stock })
      .from(s.products)
      .where(eq(s.products.id, routeParam(req.params.id)))
      .limit(1)
    if (!product) return res.status(404).json({ error: 'Product not found' })

    // Identifier uniqueness: within the set, against sibling products, and
    // against variants of other products (the sku unique index would 500 on
    // a clash — answer with the conflicting code instead).
    const seenSku = new Set<string>()
    for (const v of variants) {
      const sku = v.sku.trim().toUpperCase()
      if (!sku) return res.status(400).json({ error: 'Every variant needs a SKU', field: 'sku' })
      if (seenSku.has(sku)) return res.status(400).json({ error: `Duplicate variant SKU: ${v.sku}`, field: 'sku' })
      seenSku.add(sku)
    }
    const skuList = variants.map((v) => v.sku.trim())
    const [skuClash] = await db!
      .select({ sku: s.products.sku })
      .from(s.products)
      .where(and(ne(s.products.id, product.id), inArray(sql`upper(${s.products.sku})`, skuList.map((x) => x.toUpperCase()))))
      .limit(1)
    if (skuClash) return res.status(400).json({ error: `SKU ${skuClash.sku} is already used by another product`, field: 'sku' })
    const newSum = variants.reduce((a, v) => a + Math.max(0, Math.floor(v.stock)), 0)
    const [oldAgg] = await db!
      .select({ sum: sql<number>`coalesce(sum(${s.productVariants.stock}), 0)` })
      .from(s.productVariants)
      .where(eq(s.productVariants.productId, product.id))
    const oldSum = Math.floor(Number(oldAgg?.sum ?? 0))

    // The barcode workflow is removed from the app, but the legacy column is
    // still what the Shopify sync reads for existing variants. A replace-all
    // save must not wipe it: keep each row's stored barcode, keyed by variant
    // id first (stable across re-ordering) and by SKU as the fallback.
    const prevVariants = await db!
      .select({ id: s.productVariants.id, sku: s.productVariants.sku, barcode: s.productVariants.barcode })
      .from(s.productVariants)
      .where(eq(s.productVariants.productId, product.id))
    const prevBarcodeById = new Map(prevVariants.map((r) => [r.id, r.barcode]))
    const prevBarcodeBySku = new Map(
      prevVariants.map((r) => [String(r.sku ?? '').trim().toUpperCase(), r.barcode]),
    )

    await db!.transaction(async (tx) => {
      await tx.delete(s.productVariants).where(eq(s.productVariants.productId, product.id))
      if (variants.length > 0) {
        await tx.insert(s.productVariants).values(
          variants.map((v) => {
            const keepBarcode =
              (v.id?.trim() && prevBarcodeById.get(v.id.trim())) ||
              prevBarcodeBySku.get(v.sku.trim().toUpperCase()) ||
              null
            return {
              id: v.id?.trim() || randomUUID(),
              productId: product.id,
              title: v.title.trim(),
              optionValues: v.optionValues,
              sku: v.sku.trim(),
              barcode: keepBarcode,
              sellingPrice: v.sellingPrice ?? null,
              compareAtPrice: v.compareAtPrice ?? null,
              costPrice: v.costPrice ?? null,
              grossWeight: v.grossWeight ?? null,
              stock: Math.max(0, Math.floor(v.stock)),
              reorderLevel: v.reorderLevel ?? null,
              status: v.status ?? 'active',
              createdAt: new Date().toISOString(),
            }
          }),
        )
      }
      await tx
        .update(s.products)
        .set({ options })
        .where(eq(s.products.id, product.id))
      // Roll the variant-stock difference into the parent's ledger as a
      // count correction — visible in stock history, never a silent overwrite.
      const delta = newSum - oldSum
      const sku = String(product.sku ?? '').trim()
      if (delta !== 0 && sku) {
        await applyStockMovement({
          sku,
          qty: delta,
          type: 'count_adjust',
          locationId: await ensureDefaultLocation(),
          refType: 'product_edit',
          note: `variant stock ${oldSum} → ${newSum} (${delta > 0 ? '+' : ''}${delta})`,
          createdBy: actorFromRequest(req).userId ?? 'system',
          tx,
        })
      }
    })

    recordCrud('products', 'Updated', req, { ...product, name: `variants of ${product.sku}` })
    const saved = await db!.select().from(s.productVariants).where(eq(s.productVariants.productId, product.id))
    const [parent] = await db!
      .select({ stock: s.products.stock, options: s.products.options })
      .from(s.products)
      .where(eq(s.products.id, product.id))
      .limit(1)
    res.json({ options: parent?.options ?? options, variants: saved, stock: parent?.stock ?? newSum })
  } catch (err) {
    logger.error({ err }, 'product variants save failed')
    res.status(400).json({ error: 'Failed to save variants' })
  }
})

const resources: Record<string, any> = {
  products: s.products,
  customers: s.customers,
  suppliers: s.suppliers,
  'sales-orders': s.salesOrders,
  'purchase-orders': s.purchaseOrders,
  'purchase-invoices': s.purchaseInvoices,
  'sales-returns': s.salesReturns,
  'purchase-returns': s.purchaseReturns,
  'inventory/locations': s.inventoryLocations,
  'inventory/transfers': s.stockTransfers,
  'bank-accounts': s.bankAccounts,
  ledger: s.ledgerEntries,
  expenses: s.expenses,
  payments: s.payments,
  users: s.users,
  'audit-logs': s.auditLogs,
  'sync-logs': s.syncLogs,
  'silver-rates': s.silverRates,
  'gold-rates': s.goldRates,
  batches: s.batches,
  boms: s.boms,
  'bom-items': s.bomItems,
  karigars: s.karigars,
  branches: s.branches,
}

const resourceModule: Record<string, string> = {
  products: 'inventory',
  customers: 'sales',
  suppliers: 'purchase',
  'sales-orders': 'sales',
  invoices: 'sales',
  'purchase-orders': 'purchase',
  'purchase-invoices': 'purchase',
  'sales-returns': 'sales',
  'purchase-returns': 'purchase',
  'inventory/locations': 'inventory',
  'inventory/transfers': 'inventory',
  'bank-accounts': 'accounts',
  ledger: 'accounts',
  expenses: 'accounts',
  payments: 'accounts',
  users: 'system',
  'audit-logs': 'system',
  'sync-logs': 'shopify',
  'silver-rates': 'silver-rate',
  'gold-rates': 'gold-rate',
  batches: 'inventory',
  boms: 'inventory',
  'bom-items': 'inventory',
  karigars: 'inventory',
  branches: 'system',
  currencies: 'system',
}

const RESOURCE_LABELS: Record<string, string> = {
  products: 'Product',
  customers: 'Customer',
  suppliers: 'Supplier',
  'sales-orders': 'Sales Order',
  invoices: 'Invoice',
  'purchase-orders': 'Purchase Order',
  'purchase-invoices': 'Purchase Invoice',
  'sales-returns': 'Sales Return',
  'purchase-returns': 'Purchase Return',
  'inventory/locations': 'Inventory Location',
  'inventory/transfers': 'Stock Transfer',
  'bank-accounts': 'Bank Account',
  ledger: 'Ledger Entry',
  expenses: 'Expense',
  payments: 'Payment',
  users: 'User',
  'audit-logs': 'Audit Log',
  'sync-logs': 'Sync Log',
  'silver-rates': 'Silver Rate',
  'gold-rates': 'Gold Rate',
  batches: 'Batch',
  boms: 'BOM',
  'bom-items': 'BOM Item',
  karigars: 'Karigar',
  branches: 'Branch',
}

function entityDisplayName(row: Record<string, unknown> | null): string {
  if (!row) return ''
  const name = String(row.name ?? row.number ?? row.ref ?? row.title ?? row.sku ?? row.description ?? '').trim()
  return name || String(row.id ?? '')
}

function recordCrud(name: string, action: string, req: Request, row: Record<string, unknown> | null) {
  const label = RESOURCE_LABELS[name] ?? name
  const entity = `${label} ${entityDisplayName(row)}`.trim()
  const actor = actorFromRequest(req)
  void recordActivity({
    action,
    module: resourceModule[name] ?? 'system',
    entity,
    details: undefined,
    userId: actor.userId,
    ip: actor.ip,
  })
}

for (const [name, table] of Object.entries(resources)) {
  dbRouter.post(`/${name}`, requirePermission(resourceModule[name], 'create'), async (req, res) => {
    if (!requireDb(res)) return
    try {
      const isUser = name === 'users'
      const isBankAccount = name === 'bank-accounts'
      const isSupplier = name === 'suppliers'
      let body = isSupplier
        ? await prepareSupplierBody(req.body ?? {})
        : isUser
          ? await prepareUserBody(req.body ?? {})
          : sanitize(req.body ?? {}, table)
      if (isUser) {
        const escalation = await assertNoPrivilegeEscalation(req, body)
        if (escalation) return res.status(403).json({ error: escalation })
      }
      if (isBankAccount && body.accountNumber && typeof body.accountNumber === 'string') {
        body.accountNumberEncrypted = encrypt(body.accountNumber)
        delete body.accountNumber
      }
      if (Object.keys(body).length === 0) return res.status(400).json({ error: 'No valid fields provided' })
      if (!body.id) body.id = randomUUID()
      const [row] = await db!.insert(table).values(body).returning()
      recordCrud(name, 'Created', req, row)
      res.status(201).json(stripHash(row))
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      if (name === 'suppliers' || msg.includes('password') || msg.includes('Password')) {
        res.status(400).json({ error: msg })
      } else {
        res.status(400).json({ error: 'Failed to create resource' })
      }
    }
  })

  dbRouter.patch(`/${name}/:id`, requirePermission(resourceModule[name], 'edit'), async (req, res) => {
    if (!requireDb(res)) return
    try {
      const isUser = name === 'users'
      if (isUser && routeParam(req.params.id) === req.userId) {
        return res.status(403).json({ error: 'Cannot modify your own account' })
      }
      const isBankAccount = name === 'bank-accounts'
      const isSupplier = name === 'suppliers'
      let body = isSupplier
        ? await prepareSupplierBody(req.body ?? {}, { isUpdate: true, id: routeParam(req.params.id) })
        : isUser
          ? await prepareUserBody(req.body ?? {}, true)
          : sanitize(req.body ?? {}, table)
      if (isUser) {
        const escalation = await assertNoPrivilegeEscalation(req, body)
        if (escalation) return res.status(403).json({ error: escalation })
      }
      if (isBankAccount && body.accountNumber && typeof body.accountNumber === 'string') {
        body.accountNumberEncrypted = encrypt(body.accountNumber)
        delete body.accountNumber
      }
      delete body.id
      if (Object.keys(body).length === 0) return res.status(400).json({ error: 'No valid fields provided' })
      const [row] = await db!.update(table).set(body).where(eq(table.id, routeParam(req.params.id))).returning()
      if (!row) return res.status(404).json({ error: 'Not found' })
      recordCrud(name, 'Updated', req, row)
      res.json(stripHash(row))
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      if (name === 'suppliers' || msg.includes('password') || msg.includes('Password')) {
        res.status(400).json({ error: msg })
      } else {
        res.status(400).json({ error: 'Failed to update resource' })
      }
    }
  })

  dbRouter.delete(`/${name}/:id`, requirePermission(resourceModule[name], 'delete'), async (req, res) => {
    if (!requireDb(res)) return
    try {
      if (name === 'users' && routeParam(req.params.id) === req.userId) {
        return res.status(400).json({ error: 'You cannot delete your own account' })
      }
      const [existing] = await db!.select().from(table).where(eq(table.id, routeParam(req.params.id))).limit(1)
      if (!existing) return res.status(404).json({ error: 'Not found' })
      await db!.delete(table).where(eq(table.id, routeParam(req.params.id)))
      recordCrud(name, 'Deleted', req, existing)
      res.json({ ok: true, id: routeParam(req.params.id) })
    } catch {
      res.status(500).json({ error: 'Failed to delete resource' })
    }
  })
}

dbRouter.get('/stats', async (_req, res) => {
  if (!requireDb(res)) return
  try {
    const [productCount] = await db!.select({ count: sql<number>`count(*)` }).from(s.products)
    const [customerCount] = await db!.select({ count: sql<number>`count(*)` }).from(s.customers)
    const [supplierCount] = await db!.select({ count: sql<number>`count(*)` }).from(s.suppliers)
    const [invoiceCount] = await db!.select({ count: sql<number>`count(*)` }).from(s.salesInvoices)
    const stock = await db!.select({ qty: sql<number>`coalesce(sum(stock),0)` }).from(s.products)
    res.json({
      totalProducts: Number(productCount.count),
      activeProducts: Number((await db!.select({ count: sql<number>`count(*)` }).from(s.products).where(eq(s.products.status, 'active')))[0].count),
      totalCustomers: Number(customerCount.count),
      totalSuppliers: Number(supplierCount.count),
      totalInvoices: Number(invoiceCount.count),
      totalStockQty: Number(stock[0].qty),
    })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

dbRouter.get('/search', async (req, res) => {
  if (!requireDb(res)) return
  try {
    const q = String(req.query.q ?? '').trim().toLowerCase().slice(0, 100)
    if (!q) return res.json({ products: [], customers: [], invoices: [], suppliers: [], salesOrders: [], purchaseInvoices: [], payments: [] })
    const escaped = q.replace(/[%_]/g, (ch) => `\\${ch}`)
    const like = `%${escaped}%`
    const [products, customers, invoices, suppliers, salesOrders, purchaseInvoices, payments] = await Promise.all([
      db!.select().from(s.products).where(ilike(s.products.name, like)).limit(8),
      db!.select().from(s.customers).where(ilike(s.customers.name, like)).limit(8),
      db!.select().from(s.salesInvoices).where(ilike(s.salesInvoices.number, like)).limit(8),
      db!.select().from(s.suppliers).where(ilike(s.suppliers.name, like)).limit(8),
      db!.select().from(s.salesOrders).where(ilike(s.salesOrders.shopifyId, like)).limit(8),
      db!.select().from(s.purchaseInvoices).where(ilike(s.purchaseInvoices.number, like)).limit(8),
      db!.select().from(s.payments).where(ilike(s.payments.ref, like)).limit(8),
    ])
    res.json({ products, customers, invoices, suppliers, salesOrders, purchaseInvoices, payments })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── Record a payment against a customer's outstanding invoices ───────────

dbRouter.post('/dues/pay', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not configured' })
    const customer = String(req.body?.customer ?? '').trim()
    const amount = Number(req.body?.amount ?? 0)
    const method = String(req.body?.method ?? 'cash').trim().toLowerCase()
    const allocate = Array.isArray(req.body?.allocate) ? req.body.allocate : null
    if (!customer) return res.status(400).json({ error: 'customer required' })
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be > 0' })

    // Open (unpaid, non-cancelled/refunded) invoices for this customer, oldest first
    const open = await db
      .select()
      .from(schema.salesInvoices)
      .where(
        sql`${schema.salesInvoices.customer} = ${customer} and ${schema.salesInvoices.paymentStatus} is distinct from 'paid' and ${schema.salesInvoices.status} is distinct from 'cancelled' and ${schema.salesInvoices.status} is distinct from 'refunded'`,
      )
      .orderBy(sql`${schema.salesInvoices.date} asc`)
    const outstanding = open.reduce((a, inv) => a + Number(inv.grandTotal ?? 0), 0)
    if (open.length === 0) return res.status(400).json({ error: 'No outstanding invoices for this customer' })
    if (amount > outstanding + 0.01) return res.status(400).json({ error: `Amount exceeds outstanding (${outstanding.toFixed(2)})` })

    // Allocation: explicit invoice list or FIFO across oldest first
    let remaining = amount
    const settled: string[] = []
    const touched: Array<{ inv: typeof open[number]; applied: number }> = []
    const plan = allocate
      ? open.filter((inv) => allocate.map(String).includes(inv.id))
      : open
    for (const inv of plan) {
      if (remaining <= 0) break
      const due = Number(inv.grandTotal ?? 0)
      const applied = Math.min(due, remaining)
      if (applied <= 0) continue
      remaining = Math.round((remaining - applied) * 100) / 100
      touched.push({ inv, applied })
      if (applied >= due - 0.01) {
        await db.update(schema.salesInvoices).set({ paymentStatus: 'paid', status: 'paid' }).where(eq(schema.salesInvoices.id, inv.id))
        settled.push(inv.number)
      } else {
        await db.update(schema.salesInvoices).set({ paymentStatus: 'partial' }).where(eq(schema.salesInvoices.id, inv.id))
      }
    }

    const ref = `PAY-${Date.now().toString(36).toUpperCase()}`
    await db.insert(schema.payments).values({
      id: randomUUID(),
      ref,
      invoice: touched[0]?.inv.number ?? null,
      customer,
      amount,
      method,
      gateway: method === 'razorpay' ? 'razorpay' : null,
      status: 'success',
      date: new Date().toISOString(),
      reconciled: true,
    } as any)

    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Recorded Payment',
      module: 'sales',
      entity: customer,
      details: `${ref} · ₹${amount} (${method})${settled.length ? ` · settled ${settled.join(', ')}` : ''}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    logger.info({ ref, customer, amount, method, settled }, 'Payment recorded from Dues page')
    res.json({ ok: true, ref, settled, remainingOutstanding: Math.round((outstanding - amount) * 100) / 100 })
  } catch (err) {
    logger.error({ err }, 'Record payment failed')
    res.status(500).json({ error: 'Failed to record payment' })
  }
})

// ─── Dues: outstanding summary + on-demand statement email ────────────────

dbRouter.get('/dues', requirePermission('sales', 'view'), async (_req, res) => {
  try {
    const { collectDues } = await import('../statements')
    const dues = await collectDues()
    const total = dues.reduce((a, d) => a + d.total, 0)
    res.json({ dues, total, customerCount: dues.length })
  } catch (err) {
    logger.error({ err }, 'Dues collection failed')
    res.status(500).json({ error: 'Failed to collect dues' })
  }
})

// Bulk payment reminders: one email per customer with outstanding dues.
// Recipients come from the customers table (matched by name); customers
// without an email on file are counted as skipped.
dbRouter.post('/dues/remind', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const { collectDues } = await import('../statements')
    const dues = await collectDues()
    if (dues.length === 0) return res.status(200).json({ sent: 0, skipped: 0, reason: 'No outstanding dues' })
    const customers = await db!.select({ name: schema.customers.name, email: schema.customers.email }).from(schema.customers)
    const emailByName = new Map(customers.filter((c) => c.email).map((c) => [c.name.toLowerCase(), c.email as string]))
    const { sendEmail } = await import('../notifications')
    let sent = 0
    let skipped = 0
    const failures: string[] = []
    for (const d of dues) {
      const to = emailByName.get((d.customer ?? '').toLowerCase())
      if (!to) { skipped++; continue }
      const invoiceList = d.invoiceNumbers.slice(0, 8).map((n) => `• ${escapeHtml(n)}`).join('<br/>')
      const ok = await sendEmail({
        to,
        subject: `Payment reminder — ${d.invoiceCount} outstanding invoice${d.invoiceCount === 1 ? '' : 's'} (₹${d.total.toLocaleString('en-IN')})`,
        html: `<p>Dear ${escapeHtml(d.customer)},</p><p>Our records show <strong>${d.invoiceCount}</strong> unpaid invoice${d.invoiceCount === 1 ? '' : 's'} totalling <strong>₹${d.total.toLocaleString('en-IN')}</strong>:</p><p style="font-family: monospace; font-size: 12px;">${invoiceList}</p><p>Please arrange payment at your earliest convenience. Reply to this email or call us if you have already paid or need a copy of any invoice.</p><p>— Opal Line Jewels LLP</p>`,
      })
      if (ok) sent++
      else failures.push(d.customer ?? 'unknown')
    }
    logger.info({ sent, skipped }, 'Bulk payment reminders processed')
    res.json({ sent, skipped, failures })
  } catch (err) {
    logger.error({ err }, 'payment reminders failed')
    res.status(500).json({ error: 'Failed to send payment reminders' })
  }
})

dbRouter.post('/dues/email', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const [settingsRow] = await db!.select().from(schema.settings).where(eq(schema.settings.id, 'app')).limit(1)
    const recipient = String(req.body?.to || '').trim() || process.env.NOTIFICATION_EMAIL?.trim() || settingsRow?.email?.trim()
    if (!recipient) return res.status(400).json({ error: 'No recipient (no "to", NOTIFICATION_EMAIL, or settings.email)' })
    const { generateDuesStatementPDF } = await import('../statements')
    const statement = await generateDuesStatementPDF()
    if (!statement) return res.status(200).json({ sent: false, reason: 'No outstanding dues — nothing to send' })
    const { notifyDuesStatement } = await import('../notifications')
    const sent = await notifyDuesStatement(recipient, statement)
    if (sent) logger.info({ recipient }, 'On-demand dues statement emailed')
    res.json({ sent, recipient, total: statement.totalDue, customerCount: statement.customerCount })
  } catch (err) {
    logger.error({ err }, 'Dues statement email failed')
    res.status(500).json({ error: 'Failed to send dues statement' })
  }
})

// ─── Customer account statements (PDF download + email) ───────────────────

dbRouter.get('/customers/:name/statement', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const customer = decodeURIComponent(routeParam(req.params.name))
    const { generateCustomerStatementPDF } = await import('../statements')
    const statement = await generateCustomerStatementPDF(customer)
    if (!statement) return res.status(404).json({ error: 'No invoices found for this customer' })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="statement-${customer.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf"`)
    res.send(statement.buffer)
  } catch (err) {
    logger.error({ err }, 'Customer statement PDF failed')
    res.status(500).json({ error: 'Statement generation failed' })
  }
})

dbRouter.post('/customers/:name/statement/email', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not configured' })
    const customer = decodeURIComponent(routeParam(req.params.name))
    const to = String(req.body?.to ?? '').trim()
    if (!to) return res.status(400).json({ error: 'Recipient "to" required' })
    const { generateCustomerStatementPDF } = await import('../statements')
    const statement = await generateCustomerStatementPDF(customer)
    if (!statement) return res.status(404).json({ error: 'No invoices found for this customer' })
    const { notifyCustomerStatement } = await import('../notifications')
    const sent = await notifyCustomerStatement(to, customer, statement)
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Emailed Customer Statement',
      module: 'sales',
      entity: customer,
      details: `Statement sent to ${to} (${statement.invoiceCount} invoices)`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ sent, invoiceCount: statement.invoiceCount, outstanding: statement.outstanding })
  } catch (err) {
    logger.error({ err }, 'Customer statement email failed')
    res.status(500).json({ error: 'Statement email failed' })
  }
})

// ─── Razorpay payment link ───────────────────────────────────────────────

dbRouter.post('/dues/payment-link', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const { createRazorpayPaymentLink, isRazorpayConfigured } = await import('../paymentLinks')
    if (!isRazorpayConfigured()) return res.status(400).json({ error: 'Razorpay not configured (set RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET)', configured: false })
    const customer = String(req.body?.customer ?? '').trim()
    const amount = Number(req.body?.amount ?? 0)
    if (!customer) return res.status(400).json({ error: 'customer required' })
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be > 0' })
    const link = await createRazorpayPaymentLink({
      amount,
      customer,
      description: `Outstanding dues for ${customer} — Opal Line`,
      referenceId: `OL-${customer.slice(0, 20).replace(/[^a-z0-9]/gi, '')}-${Date.now().toString(36).toUpperCase()}`,
    })
    if (!link) return res.status(500).json({ error: 'Failed to create payment link' })
    res.json({ url: link.url, id: link.id, configured: true })
  } catch (err) {
    logger.error({ err }, 'Razorpay payment link failed')
    res.status(500).json({ error: 'Payment link generation failed' })
  }
})

// ─── WhatsApp send (server-side) ────────────────────────────────────────────

dbRouter.post('/send-whatsapp', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const { sendWhatsAppMessage, isWhatsAppConfigured } = await import('../whatsapp')
    if (!isWhatsAppConfigured()) return res.status(400).json({ error: 'WhatsApp Business API not configured', configured: false })
    const phone = String(req.body?.phone ?? '').trim()
    const message = String(req.body?.message ?? '').trim()
    if (!phone || !message) return res.status(400).json({ error: 'phone and message required' })
    const result = await sendWhatsAppMessage(phone, message)
    if (!result) return res.status(500).json({ error: 'WhatsApp send failed', configured: true })
    const actor = actorFromRequest(req)
    void recordActivity({ action: 'Sent WhatsApp', module: 'sales', entity: phone, details: message.slice(0, 100), userId: actor.userId, ip: actor.ip })
    res.json({ ok: true, messageId: result.messageId, configured: true })
  } catch (err) {
    logger.error({ err }, 'WhatsApp send endpoint failed')
    res.status(500).json({ error: 'WhatsApp send failed' })
  }
})

// ─── Supplier purchase invoice aging (outstanding dues) ────────────────────

dbRouter.get('/supplier-dues', requirePermission('purchase', 'view'), async (_req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not configured' })
    const { collectSupplierDues } = await import('../purchases')
    const dues = await collectSupplierDues()
    const total = dues.reduce((a, d) => a + d.balance, 0)
    const aging = {
      current: dues.reduce((a, d) => a + d.current, 0),
      d1_30: dues.reduce((a, d) => a + d.d1_30, 0),
      d31_60: dues.reduce((a, d) => a + d.d31_60, 0),
      d60plus: dues.reduce((a, d) => a + d.d60plus, 0),
    }
    res.json({
      dues: dues.map((d) => ({ ...d, count: d.invoiceCount })),
      total,
      aging,
      supplierCount: dues.length,
    })
  } catch (err) {
    logger.error({ err }, 'Supplier dues query failed')
    res.status(500).json({ error: 'Failed to load supplier dues' })
  }
})

// Open invoices for one supplier — drives the payment dialog.
dbRouter.get('/supplier-dues/:supplier', requirePermission('purchase', 'view'), async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not configured' })
    const { getSupplierOpenInvoices, getSupplierPayments, getPaymentAllocations } = await import('../purchases')
    const supplier = decodeURIComponent(routeParam(req.params.supplier))
    const invoices = await getSupplierOpenInvoices(supplier)
    const payments = await getSupplierPayments(supplier, 25)
    const allocations = await Promise.all(payments.map((p) => getPaymentAllocations(p.id)))
    res.json({
      supplier,
      invoices,
      outstanding: Math.round(invoices.reduce((a, i) => a + i.balance, 0) * 100) / 100,
      payments: payments.map((p, i) => ({
        id: p.id,
        ref: p.ref,
        amount: Number(p.amount ?? 0),
        method: p.method,
        date: p.date,
        note: p.note,
        allocations: allocations[i],
      })),
    })
  } catch (err) {
    logger.error({ err }, 'Supplier dues detail failed')
    res.status(500).json({ error: 'Failed to load supplier dues' })
  }
})

// Record a supplier payment: writes a ledger row plus per-invoice allocations
// and advances each invoice's paid amount, so partial payments settle properly.
dbRouter.post('/supplier-dues/pay', requirePermission('purchase', 'edit'), async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not configured' })
    const { recordSupplierPayment } = await import('../purchases')
    const allocate = Array.isArray(req.body?.allocate) ? (req.body.allocate as unknown[]).map(String) : null
    const result = await recordSupplierPayment({
      supplier: String(req.body?.supplier ?? ''),
      amount: Number(req.body?.amount ?? 0),
      method: String(req.body?.method ?? 'cash').trim().toLowerCase(),
      note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : null,
      createdBy: actorFromRequest(req).userId ?? null,
      allocate,
    })
    if (!result.ok) return res.status(400).json({ error: result.error })

    const actor = actorFromRequest(req)
    recordCrud('purchase-invoices', 'Payment recorded', req, {
      supplier: String(req.body?.supplier ?? ''),
      ref: result.ref,
      allocations: result.allocations,
    })
    void recordActivity({
      action: 'Recorded Supplier Payment',
      module: 'purchase',
      entity: String(req.body?.supplier ?? ''),
      details: `${result.ref} · ₹${Number(req.body?.amount ?? 0).toLocaleString('en-IN')}${result.settled.length ? ` · settled ${result.settled.join(', ')}` : ''}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json(result)
  } catch (err) {
    logger.error({ err }, 'Supplier payment failed')
    res.status(500).json({ error: 'Failed to record supplier payment' })
  }
})

// Email the shop owner a summary of what is owed to suppliers and how overdue.
// Run the same summary the daily scheduler sends, on demand.
dbRouter.post('/supplier-dues/sweep', requirePermission('purchase', 'edit'), async (_req, res) => {
  try {
    const { runSupplierPayables } = await import('../supplierPayables')
    const result = await runSupplierPayables({ force: true })
    res.json({ ok: result.sent, ...result })
  } catch (err) {
    logger.error({ err }, 'supplier payables sweep failed')
    res.status(500).json({ error: 'Failed to run the supplier payables summary' })
  }
})

dbRouter.post('/supplier-dues/remind', requirePermission('purchase', 'edit'), async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not configured' })
    const { collectSupplierDues } = await import('../purchases')
    const { sendEmail } = await import('../notifications')
    const { escapeHtml } = await import('../htmlEscape')
    const [settingsRow] = await db!.select().from(s.settings).where(eq(s.settings.id, SETTINGS_ID)).limit(1)
    const recipient =
      typeof req.body?.to === 'string' && req.body.to.trim()
        ? req.body.to.trim()
        : (process.env.NOTIFICATION_EMAIL ?? String(settingsRow?.email ?? '')).trim()
    if (!recipient) return res.status(400).json({ error: 'No recipient configured — pass "to" or set the business email' })

    const dues = await collectSupplierDues()
    if (dues.length === 0) return res.json({ ok: true, sent: 0, message: 'No supplier dues outstanding' })
    const total = dues.reduce((a, d) => a + d.balance, 0)
    const rows = dues
      .map(
        (d) =>
          `<tr><td style="padding:6px;border-bottom:1px solid #eee">${escapeHtml(d.supplier ?? 'Unknown')}</td>` +
          `<td style="padding:6px;border-bottom:1px solid #eee;text-align:right">${d.invoiceCount}</td>` +
          `<td style="padding:6px;border-bottom:1px solid #eee;text-align:right">₹${d.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td></tr>`,
      )
      .join('')
    const sent = await sendEmail({
      to: recipient,
      subject: `Supplier dues — ₹${total.toLocaleString('en-IN')} outstanding`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
          <h2 style="color:#1a1a2e">Supplier payables</h2>
          <p>Total outstanding across ${dues.length} supplier(s).</p>
          <table style="width:100%;border-collapse:collapse;margin:12px 0">
            <tr><th align="left" style="padding:6px">Supplier</th><th align="right" style="padding:6px">Invoices</th><th align="right" style="padding:6px">Balance</th></tr>
            ${rows}
            <tr><td style="padding:6px;font-weight:bold">Total</td><td></td><td align="right" style="padding:6px;font-weight:bold">₹${total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td></tr>
          </table>
          <p style="color:#999;font-size:12px">Opal Line ERP — Purchase payables summary</p>
        </div>`,
    })
    if (!sent) return res.status(500).json({ error: 'Failed to send summary. Check server logs.' })
    res.json({ ok: true, sent: dues.length, to: recipient })
  } catch (err) {
    logger.error({ err }, 'supplier dues reminder failed')
    res.status(500).json({ error: 'Failed to send supplier dues summary' })
  }
})

// ─── Notification settings ─────────────────────────────────────────────────

dbRouter.get('/settings/notifications', requirePermission('system', 'view'), async (_req, res) => {
  try {
    const [row] = await db!.select().from(schema.settings).where(sql`${schema.settings.id} = 'app'`).limit(1)
    const notif = (row as any)?.notificationSettings ?? {
      dailySummaryEnabled: true,
      monthlyStatementsEnabled: true,
      dueRemindersEnabled: true,
      weeklyReportEnabled: true,
      recipientEmail: process.env.NOTIFICATION_EMAIL ?? '',
    }
    const out = { ...(notif as Record<string, unknown>) }
    delete out[RECOVERY_PASSWORD_KEY]
    delete out[RECOVERY_PASSWORD_HASH_KEY]
    res.json(out)
  } catch (err) {
    logger.error({ err }, 'Notification settings load failed')
    res.status(500).json({ error: 'Failed to load notification settings' })
  }
})

dbRouter.put('/settings/notifications', requirePermission('system', 'edit'), async (req, res) => {
  try {
    const body = { ...(req.body as Record<string, unknown>) }
    // The recovery password is managed only by its dedicated endpoint —
    // a generic notification-settings write must not inject it.
    delete body[RECOVERY_PASSWORD_KEY]
    delete body[RECOVERY_PASSWORD_HASH_KEY]
    const [row] = await db!.select().from(schema.settings).where(sql`${schema.settings.id} = 'app'`).limit(1)
    const existing = (row as any)?.notificationSettings ?? {}
    const merged = { ...existing, ...body }
    // Mirror the switch onto the legacy Business Settings column (same email).
    const setClause: Record<string, unknown> = { notificationSettings: merged }
    if (typeof body.dailySummaryEnabled === 'boolean') setClause.dailySummary = body.dailySummaryEnabled
    await db!.update(schema.settings).set(setClause as any).where(sql`${schema.settings.id} = 'app'`)
    const actor = actorFromRequest(req)
    void recordActivity({ action: 'Updated Notification Settings', module: 'system', entity: 'Notifications', details: Object.keys(body).join(', '), userId: actor.userId, ip: actor.ip })
    res.json(merged)
  } catch (err) {
    logger.error({ err }, 'Notification settings update failed')
    res.status(500).json({ error: 'Failed to update notification settings' })
  }
})

// ─── Email Invoice ────────────────────────────────────────────────────────

dbRouter.post('/invoices/:id/email', requirePermission('sales', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const { emailInvoicePDF } = await import('../invoicePdf')
    const invoiceId = routeParam(req.params.id)
    const [inv] = await db!.select({ customer: s.salesInvoices.customer, customerEmail: s.salesInvoices.customerEmail }).from(s.salesInvoices).where(eq(s.salesInvoices.id, invoiceId)).limit(1)
    if (!inv) return res.status(404).json({ error: 'Invoice not found' })

    let recipientEmail = typeof req.body?.to === 'string' ? req.body.to.trim() : ''
    if (!recipientEmail && inv.customerEmail) recipientEmail = inv.customerEmail.trim()
    if (!recipientEmail) {
      const [cust] = await db!.select({ email: s.customers.email }).from(s.customers).where(eq(s.customers.name, inv.customer ?? '')).limit(1)
      if (cust?.email) recipientEmail = cust.email.trim()
    }
    if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      return res.status(400).json({ error: 'No valid email address found. Provide "to" in request body or ensure the customer has an email.' })
    }

    const sent = await emailInvoicePDF(invoiceId, recipientEmail)
    if (!sent) return res.status(500).json({ error: 'Failed to send email. Check server logs.' })

    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Emailed Invoice',
      module: 'sales',
      entity: inv.customer ?? invoiceId,
      details: `Invoice emailed to ${recipientEmail}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ok: true, message: 'Invoice emailed successfully', to: recipientEmail })
  } catch (err) {
    logger.error({ err }, 'Email invoice failed')
    res.status(500).json({ error: 'Email invoice failed' })
  }
})

// ─── Invoice PDF Download ──────────────────────────────────────────────────

dbRouter.get('/invoices/:id/pdf', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const { generateInvoicePDF } = await import('../invoicePdf')
    const pdf = await generateInvoicePDF(routeParam(req.params.id))
    if (!pdf) return res.status(404).json({ error: 'Invoice not found or PDF generation failed' })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${routeParam(req.params.id)}.pdf"`)
    res.send(pdf)
  } catch {
    res.status(500).json({ error: 'PDF generation failed' })
  }
})

// ─── Credit Note PDF Download (for a sales return) ──────────────────────────

dbRouter.get('/credit-notes/:id/pdf', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const { generateCreditNotePDF } = await import('../creditNotePdf')
    const pdf = await generateCreditNotePDF(routeParam(req.params.id))
    if (!pdf) return res.status(404).json({ error: 'Credit note not found or PDF generation failed' })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="credit-note-${routeParam(req.params.id)}.pdf"`)
    res.send(pdf)
  } catch {
    res.status(500).json({ error: 'Credit note PDF generation failed' })
  }
})



// ─── Quotation PDF Download ──────────────────────────────────────────────────

dbRouter.get('/quotations/:id/pdf', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const { generateQuotationPDF } = await import('../quotationPdf')
    const pdf = await generateQuotationPDF(routeParam(req.params.id))
    if (!pdf) return res.status(404).json({ error: 'Quotation not found or PDF generation failed' })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="quotation-${routeParam(req.params.id)}.pdf"`)
    res.send(pdf)
  } catch {
    res.status(500).json({ error: 'Quotation PDF generation failed' })
  }
})

// ─── Quotations (pre-sale estimates → convert to invoice) ──────────────────
import { registerQuotationRoutes } from './quotations'
registerQuotationRoutes(dbRouter)
