/**
 * The single write path for stock.
 *
 * Stock used to be mutated in six or seven unrelated places, each doing its own
 * arithmetic on products.stock. That left no way to answer "why is this
 * number what it is" — a stock count silently overwrote a purchase, a transfer
 * record moved nothing, and no report could show anything but the current
 * balance.
 *
 * Every change now goes through applyStockMovement, which writes an append-only
 * stock_movements row and maintains stock_levels per location. products.stock
 * stays as the rollup across locations, so existing reports keep working.
 */
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { db } from './db/client'
import * as schema from './db/schema'
import { splitQtyAcrossVariants, type VariantWeightEntry } from './lib/variantSplit'
import { enqueueShopifyJob, isListedOnShopify } from './shopifyOutbound'

/** Anything the app can do to a stock balance. */
export type MovementType =
  | 'purchase_in'
  | 'purchase_return_out'
  | 'sale_out'
  | 'sale_return_in'
  | 'transfer_in'
  | 'transfer_out'
  | 'count_adjust'
  | 'shopify_sync'
  | 'opening'
  | 'manual'

export const DEFAULT_LOCATION_ID = 'LOC-DEFAULT'
export const DEFAULT_LOCATION_NAME = 'Main Store'

export type Tx = Parameters<Parameters<NonNullable<typeof db>['transaction']>[0]>[0]
type Client = Tx | NonNullable<typeof db>

export interface StockMovementInput {
  /**
   * The document's SKU: a product SKU or a variant SKU. Resolution is done
   * against BOTH catalogues (see `resolveStockSku`), so a variant line no
   * longer needs the caller to know which one it is holding.
   */
  sku: string
  /**
   * Forces the movement onto one specific variant. Set by flows that already
   * resolved the line (transfers, order lines); when absent the SKU decides.
   */
  variantId?: string | null
  /** Signed quantity: positive adds stock, negative removes it. */
  qty: number
  type: MovementType
  locationId?: string | null
  /** Unit cost for valuation; also revalues the weighted average on stock-in. */
  unitCost?: number
  refType?: string
  refId?: string
  note?: string
  createdBy?: string
  tx?: Tx
}

function newId(): string {
  return `SM-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure rules, extracted so they can be unit-tested without a database.
//
// These are the parts that are easy to get subtly wrong and that silently
// corrupt the books rather than throwing: the signed-quantity convention, the
// weighted-average revaluation, and which products the backfill may touch.
// ─────────────────────────────────────────────────────────────────────────────

/** Movement types that move stock IN. The type is a label; the sign is the truth. */
const INFLOW_TYPES = new Set<MovementType>([
  'purchase_in',
  'sale_return_in',
  'transfer_in',
  'shopify_sync',
  'opening',
])

export function isInflow(type: MovementType): boolean {
  return INFLOW_TYPES.has(type)
}

/**
 * Normalises a caller-supplied quantity for a movement.
 *
 * Returns null when the movement should be skipped entirely: no SKU, or a
 * quantity that nets to zero. Callers must check this rather than assuming a
 * movement was written.
 */
export function normalizeMovementQty(input: { sku: string; qty: unknown }): number | null {
  const sku = String(input.sku ?? '').trim()
  if (!sku) return null
  const qty = Math.floor(num(input.qty))
  return qty === 0 ? null : qty
}

/**
 * The balance at a location after a movement, given what was there before.
 *
 * Only the DEFAULT location adopts a pre-ledger balance, and only when the
 * product has never been through the ledger. A genuinely new location starts
 * at zero — otherwise the first transfer into it would inherit the whole
 * existing stock and double-count it.
 */
export function nextBalanceAtLocation(input: {
  currentAtLocation: number
  qty: number
}): number {
  return Math.floor(num(input.currentAtLocation)) + Math.floor(num(input.qty))
}

/** Whether a first-ever movement at a location should adopt products.stock. */
export function shouldAdoptPreLedgerBalance(input: {
  isFirstAtLocation: boolean
  locationId: string
  productHasAnyLevel: boolean
}): boolean {
  return input.isFirstAtLocation && input.locationId === DEFAULT_LOCATION_ID && !input.productHasAnyLevel
}

/**
 * How a product's PRE-LEDGER balance (products.stock with nothing recorded in
 * the ledger yet) is shared out when it is materialised.
 *
 * One variant takes all of it — that product's balance IS that variant's.
 * Several split it by their recorded counts, largest remainder, so the parts
 * sum to the balance exactly (evenly when nothing is recorded at all). No
 * variant rows keeps it as a product-level balance.
 *
 * Shared by applyStockMovement (which materialises it) and setStockTotalTo
 * (which measures a target against it) so the two can never disagree — one
 * inventing a different split from the other is exactly how a total drifts.
 */
export function preLedgerShares(input: {
  stock: number
  variants: Array<{ id: string; sku: string; stock: number | null }>
}): Array<{ variantId: string | null; qty: number }> {
  const stock = Math.floor(num(input.stock))
  if (stock === 0) return []
  if (input.variants.length === 0) return [{ variantId: null, qty: stock }]
  if (input.variants.length === 1) return [{ variantId: input.variants[0]!.id, qty: stock }]
  return splitQtyAcrossVariants(
    stock,
    input.variants.map((v) => ({ variantId: v.id, weight: num(v.stock), key: String(v.sku ?? v.id) })),
  ).filter((share) => share.qty !== 0)
}

/**
 * Weighted-average cost after stock goes in.
 *
 * Stock on hand with no recorded cost adopts the buy price outright rather
 * than averaging against a meaningless zero, which would divide the new
 * purchase across nothing and understate it.
 */
export function nextCostAfterStockIn(input: {
  oldStock: number
  oldCost: number
  addedQty: number
  unitValue: number
}): number {
  const oldStock = num(input.oldStock)
  const oldCost = num(input.oldCost)
  const addedQty = num(input.addedQty)
  const unitValue = num(input.unitValue)
  if (addedQty <= 0 || unitValue <= 0) return round2(oldCost)
  const newStock = oldStock + addedQty
  if (newStock <= 0) return round2(unitValue)
  return round2(oldStock > 0 && oldCost > 0 ? (oldStock * oldCost + addedQty * unitValue) / newStock : unitValue)
}

/** Whether the opening-balance backfill may write an entry for a product. */
export function shouldBackfillOpening(input: {
  stock: number
  hasLevel: boolean
  hasMovement: boolean
}): boolean {
  return num(input.stock) !== 0 && !input.hasLevel && !input.hasMovement
}

/**
 * The date to put on a backfilled opening entry.
 *
 * Dated from the product's own creation date where available so the history
 * reads honestly rather than being backdated to the upgrade.
 */
export function openingEntryDate(createdAt: unknown, now: Date = new Date()): string {
  const parsed = createdAt ? new Date(String(createdAt)) : null
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : now.toISOString()
}

/**
 * The difference between what was dispatched and what was counted on arrival.
 * Negative is short in transit, positive is an overage.
 */
export function receiptVariance(dispatched: number, counted: number): number {
  return Math.floor(num(counted)) - Math.floor(num(dispatched))
}

/**
 * Creates the default location if missing.
 *
 * Stock predates locations, so every existing balance has to land somewhere.
 * Rather than a backfill that guesses, the default location is seeded on demand
 * and the first movement for a product claims its whole existing balance —
 * that is what it was physically there before locations existed.
 */
export async function ensureDefaultLocation(tx?: Tx): Promise<string> {
  const client = (tx ?? db) as Client
  if (!client) return DEFAULT_LOCATION_ID
  const [existing] = await client
    .select({ id: schema.inventoryLocations.id })
    .from(schema.inventoryLocations)
    .where(eq(schema.inventoryLocations.id, DEFAULT_LOCATION_ID))
    .limit(1)
  if (existing) return DEFAULT_LOCATION_ID
  await client
    .insert(schema.inventoryLocations)
    .values({ id: DEFAULT_LOCATION_ID, name: DEFAULT_LOCATION_NAME, type: 'store' })
    .onConflictDoNothing()
  return DEFAULT_LOCATION_ID
}

/**
 * The location a document's stock should move against.
 *
 * Documents created before locations existed have no location, and resolving
 * that to the default store is correct: it is exactly where their movements
 * already went. An explicit id wins so a caller can always say where the goods
 * really are.
 */
export async function resolveMovementLocation(explicit?: string | null, tx?: Tx): Promise<string> {
  const value = explicit == null ? '' : String(explicit).trim()
  return value || ensureDefaultLocation(tx)
}

/**
 * Balance for ONE product (optionally ONE variant) at ONE location, on a
 * caller-supplied client so it can join an in-flight transaction and see that
 * transaction's own writes.
 *
 * Availability must be checked against this and not products.stock: the global
 * rollup says a chain has 12 units when the branch actually being rung up has
 * 2, and the sale would drive that branch negative. With no variant it returns
 * the product's TOTAL at the location (every variant's row summed), which is
 * what a document keyed only to the parent product must be checked against.
 */
export async function levelAt(
  client: Client,
  productId: string,
  locationId: string,
  variantId?: string | null,
): Promise<number> {
  const where = variantId
    ? and(eq(schema.stockLevels.productId, productId), eq(schema.stockLevels.locationId, locationId), eq(schema.stockLevels.variantId, variantId))
    : and(eq(schema.stockLevels.productId, productId), eq(schema.stockLevels.locationId, locationId))
  const [total] = await client
    .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
    .from(schema.stockLevels)
    .where(where)
  return Math.floor(num(total?.qty))
}

/** Total across every location for one variant (its mirror value). */
export async function variantStockTotal(client: Client, variantId: string): Promise<number> {
  const [row] = await client
    .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
    .from(schema.stockLevels)
    .where(eq(schema.stockLevels.variantId, variantId))
  return Math.floor(num(row?.qty))
}

/**
 * Drives a bucket's ledger to a TARGET total — the one safe way for code that
 * learns a stock number from OUTSIDE the ledger (a CSV `stock` column, a
 * Shopify inventory pull, "Add Stock", a stock count) to make the ledger agree
 * with it.
 *
 * Only the DIFFERENCE is posted, through applyStockMovement, so:
 *   - nothing is overwritten: every location keeps the balance it holds and
 *     only the delta moves;
 *   - a REDUCTION is spread across the locations that actually hold the stock
 *     (largest remainder) — the sum reaches the target without any single
 *     location being driven negative by the rounding;
 *   - a GROWTH lands where the bucket already holds the most (the default
 *     store when it holds nothing anywhere). That is also the location a
 *     pre-ledger product adopts its old balance from, so a product that has
 *     never been through the ledger still lands exactly on its target;
 *   - for a product with variants the delta is split across them by what each
 *     holds at that location, exactly as every other parent-keyed movement is.
 *
 * `type` decides the ledger label and, for `shopify_sync`, that the change is
 * NOT echoed back to Shopify (a pull must never push its own number back).
 * Returns the bucket's new total, or null when the SKU resolves to nothing.
 */
export async function setStockTotalTo(input: {
  sku: string
  /** Narrow to one variant of that product (or of the variant's own SKU). */
  variantId?: string | null
  target: number
  type?: MovementType
  refType?: string
  note?: string
  createdBy?: string
  tx?: Tx
}): Promise<number | null> {
  const target = Math.max(0, Math.floor(num(input.target)))
  const client = (input.tx ?? db) as Client
  if (!client) return null

  // Identify the bucket WITHOUT locking: applyStockMovement takes the locks,
  // always product first, so doing it here would invert that order.
  let productId: string | null = null
  let variantId: string | null = input.variantId ?? null
  if (variantId) {
    const [variant] = await client
      .select({ productId: schema.productVariants.productId })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, variantId))
      .limit(1)
    productId = variant?.productId ?? null
    if (!productId) return null
  } else {
    const [product] = await client
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(eq(schema.products.sku, input.sku))
      .limit(1)
    productId = product?.id ?? null
    if (!productId) {
      const [variant] = await client
        .select({ id: schema.productVariants.id, productId: schema.productVariants.productId })
        .from(schema.productVariants)
        .where(eq(schema.productVariants.sku, input.sku))
        .limit(1)
      if (!variant) return null
      productId = variant.productId
      variantId = variant.id // a variant SKU drives that variant alone
    }
  }

  const bucketWhere = variantId
    ? and(eq(schema.stockLevels.productId, productId), eq(schema.stockLevels.variantId, variantId))
    : eq(schema.stockLevels.productId, productId)
  const balances = await client
    .select({ locationId: schema.stockLevels.locationId, qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
    .from(schema.stockLevels)
    .where(bucketWhere)
    .groupBy(schema.stockLevels.locationId)
  let current = balances.reduce((sum, b) => sum + Math.floor(num(b.qty)), 0)
  if (balances.length === 0) {
    // Nothing recorded for this bucket. If the whole product has never been
    // through the ledger either, its rollup IS the balance the first movement
    // will materialise — so the delta has to be measured against that (and,
    // for one variant, against THIS variant's share of it), or the product
    // would overshoot the target by exactly the pre-ledger amount.
    const [anyLevel] = await client
      .select({ locationId: schema.stockLevels.locationId })
      .from(schema.stockLevels)
      .where(eq(schema.stockLevels.productId, productId))
      .limit(1)
    if (!anyLevel) {
      if (variantId) {
        const [variant] = await client
          .select({ stock: schema.productVariants.stock })
          .from(schema.productVariants)
          .where(eq(schema.productVariants.id, variantId))
          .limit(1)
        const [product] = await client
          .select({ stock: schema.products.stock })
          .from(schema.products)
          .where(eq(schema.products.id, productId))
          .limit(1)
        const siblings = await client
          .select({ id: schema.productVariants.id, sku: schema.productVariants.sku, stock: schema.productVariants.stock })
          .from(schema.productVariants)
          .where(eq(schema.productVariants.productId, productId))
          .orderBy(schema.productVariants.sku, schema.productVariants.id)
        const share = preLedgerShares({ stock: num(product?.stock), variants: siblings })
          .find((s) => s.variantId === variantId)
        current = share ? share.qty : Math.floor(num(variant?.stock))
      } else {
        const [product] = await client
          .select({ stock: schema.products.stock })
          .from(schema.products)
          .where(eq(schema.products.id, productId))
          .limit(1)
        current = Math.floor(num(product?.stock))
      }
    }
  }
  const delta = target - current
  if (delta === 0) {
    // Already at the target — but the MIRRORS may still be wrong (a bypass that
    // wrote the column, a restore, a half-applied import). Recompute them from
    // the balances so a no-op call still leaves the invariant true, which is
    // exactly what the consistency report checks.
    if (variantId) {
      const [variantTotal] = await client
        .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
        .from(schema.stockLevels)
        .where(eq(schema.stockLevels.variantId, variantId))
      await client
        .update(schema.productVariants)
        .set({ stock: Math.floor(num(variantTotal?.qty)) })
        .where(eq(schema.productVariants.id, variantId))
    }
    const [productTotal] = await client
      .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
      .from(schema.stockLevels)
      .where(eq(schema.stockLevels.productId, productId))
    await client
      .update(schema.products)
      .set({ stock: Math.floor(num(productTotal?.qty)) })
      .where(eq(schema.products.id, productId))
    return current
  }

  const movement = {
    sku: input.sku,
    variantId,
    type: input.type ?? ('count_adjust' as MovementType),
    refType: input.refType,
    note: input.note,
    createdBy: input.createdBy,
    tx: input.tx,
  }

  // Nothing recorded anywhere: one movement at the default store. A pre-ledger
  // product adopts its old balance there first, so it still lands on target.
  if (balances.length === 0) {
    return applyStockMovement({ ...movement, qty: delta, locationId: await ensureDefaultLocation(input.tx) })
  }

  if (delta > 0) {
    // Growth joins the stock that is already there (deterministic tie-break).
    const [where] = [...balances].sort(
      (a, b) => Math.floor(num(b.qty)) - Math.floor(num(a.qty)) || (a.locationId < b.locationId ? -1 : 1),
    )
    return applyStockMovement({ ...movement, qty: delta, locationId: where!.locationId })
  }

  for (const part of splitQtyAcrossVariants(
    delta,
    balances.map((b) => ({ variantId: b.locationId, weight: Math.floor(num(b.qty)), key: b.locationId })),
  )) {
    if (part.qty === 0) continue
    await applyStockMovement({ ...movement, qty: part.qty, locationId: part.variantId })
  }

  const [total] = await client
    .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
    .from(schema.stockLevels)
    .where(bucketWhere)
  return Math.floor(num(total?.qty))
}

/** One product that could not be fulfilled with the stock on hand. */
export interface InsufficientStockDetail {
  sku: string
  name: string
  available: number
  requested: number
}

/**
 * Thrown when an invoice (or any stock-deducting document) asks for more of a
 * product than the ledger shows on hand.
 *
 * Carries per-product detail so the API can hand the UI a list to highlight
 * rather than a single opaque string. The `message` follows the required
 * wording ("Insufficient Stock — Available: X, Requested: Y.") for the common
 * single-product case and a compact summary when several lines are short.
 */
export class InsufficientStockError extends Error {
  readonly code = 'INSUFFICIENT_STOCK'
  readonly products: InsufficientStockDetail[]

  constructor(products: InsufficientStockDetail[]) {
    const first = products[0]
    const message =
      products.length === 1 && first
        ? `Insufficient Stock — Available: ${first.available}, Requested: ${first.requested}.`
        : `Insufficient Stock — ${products.length} products exceed available stock.`
    super(message)
    this.name = 'InsufficientStockError'
    this.products = products
  }
}

export interface StockCheckItem {
  sku: string
  qty: number
  /** Display name for the error payload; falls back to the SKU. */
  name?: string
}

function roundDetailName(name: unknown, sku: string): string {
  const value = String(name ?? '').trim()
  return value || sku
}

/**
 * Availability snapshot for one SKU, on a caller-supplied client so it can see
 * an in-flight transaction's own writes.
 *
 * A variant SKU answers with that variant's balance (its own ledger rows, or
 * its own total when no location is given); a product SKU with the product's.
 * With no location this is the global rollup (products.stock); with a location
 * it is that branch's balance. It reads the SAME ledger that applyStockMovement
 * writes, so local and Shopify-synced stock are never counted twice.
 */
export async function availableFor(
  client: Client,
  sku: string,
  locationId?: string | null,
): Promise<number> {
  const value = String(sku ?? '').trim()
  if (!value || !client) return 0
  const resolved = await resolveStockSku(client, value)
  if (!resolved) return 0
  if (!locationId) {
    if (resolved.variantId) return variantStockTotal(client, resolved.variantId)
    const [row] = await client
      .select({ stock: schema.products.stock })
      .from(schema.products)
      .where(eq(schema.products.id, resolved.productId))
      .limit(1)
    return Math.floor(num(row?.stock))
  }
  return levelAt(client, resolved.productId, locationId, resolved.variantId)
}

/**
 * Blocks a document that would drive any product's stock negative.
 *
 * Aggregates the requested quantity per SKU first, so an invoice with two lines
 * of the same product is checked against their combined demand rather than each
 * line passing on its own. Products are locked (`FOR UPDATE`) in SKU order
 * before the comparison, which serialises two concurrent invoices on the same
 * SKU so neither can read the other's pre-deduction balance and oversell.
 *
 * Must be called inside the same transaction that will write the document and
 * deduct the stock, so a rejection rolls the whole thing back and nothing is
 * saved.
 */
export async function assertStockAvailable(
  client: Client,
  items: StockCheckItem[],
  opts: { locationId?: string | null } = {},
): Promise<void> {
  if (!client) return
  const locationId = opts.locationId ?? null

  // Aggregate duplicate line items: two rows of SKU X demand qty twice.
  const demand = new Map<string, { sku: string; name: string; requested: number }>()
  for (const it of items) {
    const sku = String(it.sku ?? '').trim()
    const qty = Math.floor(num(it.qty))
    if (!sku || qty <= 0) continue
    const key = sku.toLowerCase()
    const existing = demand.get(key)
    if (existing) {
      existing.requested += qty
      if (!existing.name && it.name) existing.name = roundDetailName(it.name, sku)
    } else {
      demand.set(key, { sku, name: roundDetailName(it.name, sku), requested: qty })
    }
  }
  if (demand.size === 0) return

  // Deterministic lock order avoids deadlocks between concurrent invoices that
  // touch the same set of products in different item order.
  const ordered = [...demand.values()].sort((a, b) => a.sku.localeCompare(b.sku))
  const short: InsufficientStockDetail[] = []

  for (const entry of ordered) {
    // Resolves against BOTH catalogues (variant SKU → its variant, product SKU
    // → the product) and locks product then variant, so a variant line is
    // checked against ITS balance instead of silently passing as an unknown
    // SKU — which is exactly how variant sales used to oversell.
    const resolved = await resolveStockSku(client, entry.sku)
    if (!resolved) continue
    const [row] = await client
      .select({ stock: schema.products.stock })
      .from(schema.products)
      .where(eq(schema.products.id, resolved.productId))
      .limit(1)
    const available = locationId
      ? await levelAt(client, resolved.productId, locationId, resolved.variantId)
      : resolved.variantId
        ? await variantStockTotal(client, resolved.variantId)
        : Math.floor(num(row?.stock))
    if (entry.requested <= available) continue
    short.push({ sku: entry.sku, name: entry.name, available, requested: entry.requested })
  }

  if (short.length > 0) throw new InsufficientStockError(short)
}

/**
 * Applies one stock movement.
 *
 * A movement is written into ONE OR MORE buckets of (product, variant,
 * location) and never into a bare product counter any more:
 *
 *   - the SKU or an explicit `variantId` names the variant — a variant SKU
 *     resolves through product_variants first, so a line billing a variant
 *     moves THAT variant instead of silently no-oping;
 *   - a product SKU on a single-variant product resolves to its one variant
 *     (the "default variant" case), so legacy documents keep working;
 *   - a product SKU on a MULTI-variant product splits across the variants by
 *     what each holds where the movement is happening (or by their recorded
 *     counts when nothing is held there yet) — the parts always sum to the
 *     requested quantity, so the product total is exact even though no single
 *     variant can be named. A product that still owns an UNATTRIBUTED balance
 *     keeps the movement unattributed instead of guessing.
 *
 * `product_variants.stock` and `products.stock` are recomputed from the
 * balances afterwards: they are mirrors, never independently incremented —
 * which is what let Red 4 + White 4 = 8 disagree with a product total of 7.
 *
 * Returns the product's new total across all locations, or null when the SKU
 * is unknown or the quantity nets to zero. Safe to call inside a transaction:
 * pass `tx` so the movement commits or rolls back with the document that caused
 * it.
 */
export async function applyStockMovement(input: StockMovementInput): Promise<number | null> {
  const { sku, type } = input
  const normalized = normalizeMovementQty({ sku, qty: input.qty })
  if (normalized === null) return null
  const qty = normalized

  const client = (input.tx ?? db) as Client
  if (!client) return null
  const locationId = input.locationId ?? (await ensureDefaultLocation(input.tx))

  // ── 1. Find the product WITHOUT locking anything yet. Locks below are
  // always taken in one order (product, then its variants by sku), so two
  // concurrent documents on the same product serialise instead of deadlocking.
  let productId: string | null = null
  let skuVariantId: string | null = null
  if (input.variantId) {
    const [variant] = await client
      .select({ productId: schema.productVariants.productId })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, input.variantId))
      .limit(1)
    productId = variant?.productId ?? null
  } else {
    const [product] = await client
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(eq(schema.products.sku, sku))
      .limit(1)
    productId = product?.id ?? null
    if (!productId) {
      const [variant] = await client
        .select({ id: schema.productVariants.id, productId: schema.productVariants.productId })
        .from(schema.productVariants)
        .where(eq(schema.productVariants.sku, sku))
        .limit(1)
      if (!variant) return null
      productId = variant.productId
      skuVariantId = variant.id
    }
  }
  if (!productId) return null

  // ── 2. Lock the product (and every variant of it) so two movements cannot
  // interleave their balance arithmetic.
  const [row] = await client
    .select({
      id: schema.products.id,
      sku: schema.products.sku,
      stock: schema.products.stock,
      costPrice: schema.products.costPrice,
      shopifyId: schema.products.shopifyId,
    })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .limit(1)
    .for('update')
  if (!row) return null

  const variants = await client
    .select({ id: schema.productVariants.id, sku: schema.productVariants.sku, stock: schema.productVariants.stock })
    .from(schema.productVariants)
    .where(eq(schema.productVariants.productId, row.id))
    .orderBy(schema.productVariants.sku, schema.productVariants.id)
    .for('update')

  // ── 3. Which bucket(s) does this movement touch, and how is it split?
  const targets: Array<{ variantId: string | null; qty: number }> = []
  const weights: VariantWeightEntry[] = []
  const explicit = input.variantId ? variants.find((v) => v.id === input.variantId) : null
  if (input.variantId && !explicit) return null // not a variant of this product
  if (explicit) {
    targets.push({ variantId: explicit.id, qty })
  } else if (skuVariantId) {
    targets.push({ variantId: skuVariantId, qty })
  } else if (variants.length === 0) {
    // No variant rows at all: the product-level balance is all there is.
    targets.push({ variantId: null, qty })
  } else if (variants.length === 1) {
    targets.push({ variantId: variants[0]!.id, qty })
  } else {
    const [unattributed] = await client
      .select({ qty: schema.stockLevels.qty })
      .from(schema.stockLevels)
      .where(and(eq(schema.stockLevels.productId, row.id), isNull(schema.stockLevels.variantId)))
      .limit(1)
    if (unattributed) {
      // This product still owns stock no variant has claimed: a parent-keyed
      // movement stays unattributed rather than being guessed onto one variant.
      // The product total stays exact; the remainder stays visibly unclaimed.
      targets.push({ variantId: null, qty })
    } else {
      const balances = await client
        .select({ variantId: schema.stockLevels.variantId, qty: schema.stockLevels.qty })
        .from(schema.stockLevels)
        .where(
          and(
            eq(schema.stockLevels.productId, row.id),
            eq(schema.stockLevels.locationId, locationId),
            isNotNull(schema.stockLevels.variantId),
          ),
        )
      const atLocation = new Map(balances.map((b) => [String(b.variantId), num(b.qty)]))
      const totalAtLocation = balances.reduce((sum, b) => sum + num(b.qty), 0)
      for (const v of variants) {
        weights.push({
          variantId: v.id,
          // Split by what THIS location holds — that is what is moving. With
          // nothing held here yet, fall back to each variant's recorded count.
          weight: totalAtLocation > 0 ? (atLocation.get(v.id) ?? 0) : num(v.stock),
          key: String(v.sku ?? v.id),
        })
      }
      for (const part of splitQtyAcrossVariants(qty, weights)) {
        if (part.qty !== 0) targets.push({ variantId: part.variantId, qty: part.qty })
      }
    }
  }
  if (targets.length === 0) return null

  // ── 4. A product that has never been through the ledger adopts its old
  // products.stock balance — as REAL balances for its variants, with an
  // `opening` row each, at the DEFAULT location and nowhere else. Materialising
  // it for EVERY variant (not only the one this movement touches) is what keeps
  // `products.stock = Σ variant balances` true from the first movement instead
  // of dumping the whole product onto one variant and leaving the others'
  // recorded counts with no balance behind them.
  const [anywhere] = await client
    .select({ locationId: schema.stockLevels.locationId })
    .from(schema.stockLevels)
    .where(eq(schema.stockLevels.productId, row.id))
    .limit(1)
  const adopt = shouldAdoptPreLedgerBalance({
    isFirstAtLocation: !anywhere,
    locationId,
    productHasAnyLevel: Boolean(anywhere),
  })

  const unitCost = num(input.unitCost)
  const touchedVariants: string[] = []
  if (adopt && num(row.stock) !== 0) {
    for (const share of preLedgerShares({ stock: num(row.stock), variants })) {
      await client
        .insert(schema.stockLevels)
        .values({ productId: row.id, variantId: share.variantId, locationId, qty: share.qty })
      await client.insert(schema.stockMovements).values({
        id: newId(),
        productId: row.id,
        variantId: share.variantId,
        sku: row.sku ?? sku,
        locationId,
        type: 'opening',
        qty: share.qty,
        stockAfter: share.qty,
        note: 'opening balance carried over from before the stock ledger',
        date: new Date().toISOString(),
      })
      if (share.variantId) touchedVariants.push(share.variantId)
    }
  }

  // ── 5. Write every bucket: balance first, then the ledger row for it.
  // Read-then-write is safe because the product row above is locked FOR UPDATE
  // and every writer of this table takes that same lock first.
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!
    const where = target.variantId
      ? and(
          eq(schema.stockLevels.productId, row.id),
          eq(schema.stockLevels.locationId, locationId),
          eq(schema.stockLevels.variantId, target.variantId),
        )
      : and(
          eq(schema.stockLevels.productId, row.id),
          eq(schema.stockLevels.locationId, locationId),
          isNull(schema.stockLevels.variantId),
        )
    const [level] = await client
      .select({ qty: schema.stockLevels.qty })
      .from(schema.stockLevels)
      .where(where)
      .limit(1)
    // Any pre-ledger balance was materialised above, so "no row" really means
    // "nothing here yet" — no hidden head start inside the arithmetic.
    const current = level ? num(level.qty) : 0
    const nextAtLocation = nextBalanceAtLocation({ currentAtLocation: current, qty: target.qty })

    if (level) {
      await client.update(schema.stockLevels).set({ qty: nextAtLocation }).where(where)
    } else {
      await client
        .insert(schema.stockLevels)
        .values({ productId: row.id, variantId: target.variantId, locationId, qty: nextAtLocation })
    }

    await client.insert(schema.stockMovements).values({
      id: newId(),
      productId: row.id,
      variantId: target.variantId,
      sku: row.sku ?? sku,
      locationId,
      type,
      qty: target.qty,
      stockAfter: nextAtLocation,
      unitCost: unitCost > 0 ? round2(unitCost) : null,
      refType: input.refType,
      refId: input.refId,
      note: input.note,
      createdBy: input.createdBy,
      date: new Date().toISOString(),
    })
    if (target.variantId) touchedVariants.push(target.variantId)
  }

  // ── 6. Recompute the mirrors from the balances that were just written.
  const [total] = await client
    .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
    .from(schema.stockLevels)
    .where(eq(schema.stockLevels.productId, row.id))

  const patch: Record<string, unknown> = { stock: Math.floor(num(total?.qty)) }

  // Weighted-average cost, maintained on the way in only. Removing stock does
  // not revalue: the remaining units keep the average they were bought at.
  if (isInflow(type) && qty > 0 && unitCost > 0) {
    patch.costPrice = nextCostAfterStockIn({
      oldStock: num(row.stock),
      oldCost: num(row.costPrice),
      addedQty: qty,
      unitValue: unitCost,
    })
  }

  await client.update(schema.products).set(patch as never).where(eq(schema.products.id, row.id))

  for (const variantId of new Set(touchedVariants)) {
    const [variantTotal] = await client
      .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
      .from(schema.stockLevels)
      .where(eq(schema.stockLevels.variantId, variantId))
    await client
      .update(schema.productVariants)
      .set({ stock: Math.floor(num(variantTotal?.qty)) })
      .where(eq(schema.productVariants.id, variantId))
  }

  // ERP-originated stock change → queue the Shopify level update. `shopify_sync`
  // movements ARE the inbound pull: pushing those back would echo Shopify's own
  // number at the store (and loop). The job rides the caller's transaction, so
  // a rejected document takes its pending push with it. Failures are retried by
  // the outbound worker and reported in Sync Logs.
  if (type !== 'shopify_sync' && isListedOnShopify(row.shopifyId)) {
    await enqueueShopifyJob({
      kind: 'inventory',
      productId: row.id,
      tx: input.tx,
      reason: `stock movement ${type}`,
    })
  }

  return Math.floor(num(total?.qty))
}

// ─────────────────────────────────────────────────────────────────────
// Order lines vs the catalogue
// ─────────────────────────────────────────────────────────────────────

/**
 * A line SKU resolved to the rows whose stock it draws from.
 *
 * `productId` is always the PARENT product: stock_levels, stock_movements and
 * the products.stock rollup are keyed by it. `ledgerSku` is that product's SKU
 * — movements must be written under it because applyStockMovement resolves by
 * products.sku. `variantId` is set when the line billed a product_variants
 * SKU: variant stock is its own counter (product_variants.stock) that the
 * parent rollup mirrors, so a sale must move BOTH or the rollup invariant
 * (products.stock = Σ variant stock) silently drifts.
 */
export interface StockSkuResolution {
  productId: string
  ledgerSku: string
  variantId?: string
}

/**
 * Resolves a line SKU against BOTH catalogues — product_variants first
 * (variant SKUs are unique and need not match the parent's SKU), then
 * products.
 *
 * Rows are locked FOR UPDATE in the SAME order every writer uses — product
 * first, then variant — so two concurrent orders on the same product
 * serialise here instead of deadlocking against a movement that locks in the
 * opposite order.
 *
 * Returns null for an empty or unknown SKU; callers decide whether that is a
 * skip (restoring an old line whose product was deleted) or an error.
 */
export async function resolveStockSku(client: Client, sku: string): Promise<StockSkuResolution | null> {
  const value = String(sku ?? '').trim()
  if (!value || !client) return null

  // Identify first, without holding any lock.
  const [variant] = await client
    .select({ id: schema.productVariants.id, productId: schema.productVariants.productId })
    .from(schema.productVariants)
    .where(eq(schema.productVariants.sku, value))
    .limit(1)
  let productId = variant?.productId ?? null
  if (!productId) {
    const [product] = await client
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(eq(schema.products.sku, value))
      .limit(1)
    productId = product?.id ?? null
  }
  if (!productId) return null

  const [parent] = await client
    .select({ id: schema.products.id, sku: schema.products.sku })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .limit(1)
    .for('update')
  // Orphan variant (parent deleted): nothing trustworthy to deduct.
  if (!parent?.sku) return null

  if (variant) {
    const [locked] = await client
      .select({ id: schema.productVariants.id })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, variant.id))
      .limit(1)
      .for('update')
    if (!locked) return null
    return { productId: parent.id, ledgerSku: parent.sku, variantId: variant.id }
  }
  return { productId: parent.id, ledgerSku: parent.sku }
}

/**
 * Deducts ONE order line's stock inside the caller's transaction: resolves
 * the SKU to its product/variant, checks availability AT the order's location
 * for exactly that bucket, and posts one ledger movement that names the
 * variant — the balance, the movement and the mirrors all move together.
 *
 * Throws — rather than silently skipping — when a non-empty SKU matches
 * nothing in either catalogue: a manual order billing an unknown SKU must not
 * be saved pretending it moved stock it never moved. Returns the parent
 * product id (for the post-save Shopify inventory push), or null for an empty
 * line.
 */
export async function deductOrderLineStock(input: {
  tx: Tx
  locationId: string
  sku: string
  qty: number
  refType?: string
}): Promise<{ productId: string } | null> {
  const sku = String(input.sku ?? '').trim()
  const qty = Math.max(0, Math.floor(num(input.qty)))
  if (!sku || qty <= 0) return null

  const resolved = await resolveStockSku(input.tx, sku)
  if (!resolved) throw new Error(`Unknown SKU: ${sku}`)

  // Availability is checked AT the order's location: a chain can hold 12
  // units while the shop actually taking the sale has 2. A variant line is
  // checked against its OWN bucket, so selling Red can never be satisfied by
  // stock that is physically White.
  const available = await levelAt(input.tx, resolved.productId, input.locationId, resolved.variantId)
  if (available < qty) {
    throw new Error(`Insufficient stock for SKU ${sku} at this location: available ${available}, requested ${qty}`)
  }

  await applyStockMovement({
    sku: resolved.ledgerSku,
    variantId: resolved.variantId ?? null,
    qty: -qty,
    type: 'sale_out',
    refType: input.refType ?? 'sales_order',
    locationId: input.locationId,
    tx: input.tx,
  })
  return { productId: resolved.productId }
}

/**
 * Puts ONE order line's stock back — the mirror of deductOrderLineStock,
 * used when an edit replaces the old items and when an order is cancelled.
 * Unresolvable SKUs return null instead of throwing: a reversal must never
 * trap an edit or cancellation of an old order whose product has since been
 * deleted (such a line's original deduction is already void).
 */
export async function restoreOrderLineStock(input: {
  tx: Tx
  locationId: string
  sku: string
  qty: number
  refType?: string
}): Promise<{ productId: string } | null> {
  const sku = String(input.sku ?? '').trim()
  const qty = Math.max(0, Math.floor(num(input.qty)))
  if (!sku || qty <= 0) return null

  const resolved = await resolveStockSku(input.tx, sku)
  if (!resolved) return null

  await applyStockMovement({
    sku: resolved.ledgerSku,
    variantId: resolved.variantId ?? null,
    qty,
    type: 'sale_return_in',
    refType: input.refType ?? 'sales_order',
    locationId: input.locationId,
    tx: input.tx,
  })
  return { productId: resolved.productId }
}

/**
 * Moves stock between two locations as a matched pair of movements, so each
 * location's ledger shows its own side and neither total changes.
 *
 * `variantId` makes it a variant move: BOTH sides name the same variant, so
 * the source loses exactly what the destination gains — never a different
 * variant of the same product.
 */
export async function transferStock(input: {
  sku: string
  variantId?: string | null
  qty: number
  fromLocationId: string
  toLocationId: string
  refType?: string
  refId?: string
  createdBy?: string
  note?: string
  tx?: Tx
}): Promise<number | null> {
  const qty = Math.floor(num(input.qty))
  if (!input.sku || qty <= 0 || input.fromLocationId === input.toLocationId) return null

  const source = await applyStockMovement({
    sku: input.sku,
    variantId: input.variantId ?? null,
    qty: -qty,
    type: 'transfer_out',
    locationId: input.fromLocationId,
    refType: input.refType,
    refId: input.refId,
    createdBy: input.createdBy,
    note: input.note,
    tx: input.tx,
  })
  if (source === null) return null

  await applyStockMovement({
    sku: input.sku,
    variantId: input.variantId ?? null,
    qty,
    type: 'transfer_in',
    locationId: input.toLocationId,
    refType: input.refType,
    refId: input.refId,
    createdBy: input.createdBy,
    note: input.note,
    tx: input.tx,
  })
  return source
}

/**
 * Gives pre-ledger stock a dated opening entry.
 *
 * Stock predates the ledger, so an upgraded install has products with a balance
 * but no history. Without this, their first real movement silently adopts the
 * old balance and the ledger shows it as though it happened that day. Opening
 * entries are dated as early as the product record allows so the history reads
 * honestly rather than being backdated to the upgrade.
 *
 * Idempotent: only touches products with no movements at all.
 */
export async function backfillOpeningBalances(client?: Client): Promise<number> {
  const conn = (client ?? db) as Client | null
  if (!conn) return 0
  const locationId = await ensureDefaultLocation()

  const products = await conn
    .select({ id: schema.products.id, sku: schema.products.sku, stock: schema.products.stock, createdAt: schema.products.createdAt })
    .from(schema.products)

  let created = 0
  for (const p of products) {
    const qty = num(p.stock)
    if (qty === 0) continue

    const [existing] = await conn
      .select({ locationId: schema.stockLevels.locationId })
      .from(schema.stockLevels)
      .where(eq(schema.stockLevels.productId, p.id))
      .limit(1)

    const [moved] = await conn
      .select({ id: schema.stockMovements.id })
      .from(schema.stockMovements)
      .where(eq(schema.stockMovements.productId, p.id))
      .limit(1)

    if (!shouldBackfillOpening({ stock: qty, hasLevel: Boolean(existing), hasMovement: Boolean(moved) })) continue

    // Attribute the carried-over balance the same way the migration does:
    // one variant takes all of it, several split it by what they record, and
    // when there is nothing to split by the balance stays UNATTRIBUTED rather
    // than being invented onto a variant. The parts always sum to the original
    // quantity, so nothing is created or lost here either.
    const variants = await conn
      .select({ id: schema.productVariants.id, sku: schema.productVariants.sku, stock: schema.productVariants.stock })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.productId, p.id))
      .orderBy(schema.productVariants.sku, schema.productVariants.id)
    let buckets: Array<{ variantId: string | null; qty: number }> = [{ variantId: null, qty: Math.floor(qty) }]
    if (variants.length === 1) {
      buckets = [{ variantId: variants[0]!.id, qty: Math.floor(qty) }]
    } else if (variants.length > 1) {
      const weights = variants.map((v) => ({ variantId: v.id, weight: num(v.stock), key: String(v.sku ?? v.id) }))
      const totalWeight = weights.reduce((sum, w) => sum + Math.max(0, Math.floor(w.weight)), 0)
      if (totalWeight > 0) {
        buckets = splitQtyAcrossVariants(Math.floor(qty), weights).filter((b) => b.qty !== 0)
      }
    }

    for (const bucket of buckets) {
      await conn
        .insert(schema.stockLevels)
        .values({ productId: p.id, variantId: bucket.variantId, locationId, qty: bucket.qty })
        .onConflictDoNothing()
      await conn.insert(schema.stockMovements).values({
        id: newId(),
        productId: p.id,
        variantId: bucket.variantId,
        sku: p.sku ?? null,
        locationId,
        type: 'opening',
        qty: bucket.qty,
        stockAfter: bucket.qty,
        note: 'opening balance carried over from before the stock ledger',
        date: openingEntryDate(p.createdAt),
      })
    }

    // Mirror the new balance onto every variant it was attributed to: the
    // counters are derived, never incremented beside the ledger.
    for (const bucket of buckets) {
      if (!bucket.variantId) continue
      await conn
        .update(schema.productVariants)
        .set({ stock: bucket.qty })
        .where(eq(schema.productVariants.id, bucket.variantId))
    }
    created += 1
  }
  return created
}

/**
 * Stock on hand at one location (or across all of them when omitted).
 *
 * A variant SKU answers for THAT variant; a product SKU answers for the
 * product — every variant's balance summed, which is what the product-level
 * number has always meant.
 */
export async function stockAt(sku: string, locationId?: string | null): Promise<number> {
  if (!db) return 0
  const value = String(sku ?? '').trim()
  if (!value) return 0
  // Both conditions are required. Filtering by location alone returns the total
  // for EVERY product held there rather than this one, which silently
  // over-reports as soon as a second location exists.
  const [variant] = await db
    .select({ id: schema.productVariants.id })
    .from(schema.productVariants)
    .where(eq(schema.productVariants.sku, value))
    .limit(1)
  const filters = variant ? [eq(schema.stockLevels.variantId, variant.id)] : [eq(schema.products.sku, value)]
  if (locationId) filters.push(eq(schema.stockLevels.locationId, locationId))
  const [row] = await db
    .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
    .from(schema.stockLevels)
    .innerJoin(schema.products, eq(schema.products.id, schema.stockLevels.productId))
    .where(and(...filters))
  return Math.floor(num(row?.qty))
}