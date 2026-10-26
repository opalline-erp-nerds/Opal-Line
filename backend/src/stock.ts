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
import { and, eq, sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { db } from './db/client'
import * as schema from './db/schema'

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
  sku: string
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
 * Balance for ONE product at ONE location, on a caller-supplied client so it
 * can join an in-flight transaction and see that transaction's own writes.
 *
 * Availability must be checked against this and not products.stock: the global
 * rollup says a chain has 12 units when the branch actually being rung up has
 * 2, and the sale would drive that branch negative.
 */
export async function levelAt(client: Client, productId: string, locationId: string): Promise<number> {
  const [row] = await client
    .select({ qty: schema.stockLevels.qty })
    .from(schema.stockLevels)
    .where(and(eq(schema.stockLevels.productId, productId), eq(schema.stockLevels.locationId, locationId)))
    .limit(1)
  return Math.floor(num(row?.qty))
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
 * With no location this is the global rollup (products.stock); with a location
 * it is that branch's balance. It reads the SAME ledger that applyStockMovement
 * writes, so local and Shopify-synced stock are never counted twice — a Shopify
 * pull lands in this ledger as a `shopify_sync` movement, not alongside it.
 */
export async function availableFor(
  client: Client,
  sku: string,
  locationId?: string | null,
): Promise<number> {
  const value = String(sku ?? '').trim()
  if (!value || !client) return 0
  const [row] = await client
    .select({ id: schema.products.id, stock: schema.products.stock })
    .from(schema.products)
    .where(eq(schema.products.sku, value))
    .limit(1)
  if (!row) return 0
  if (!locationId) return Math.floor(num(row.stock))
  return levelAt(client, row.id, locationId)
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
    const [row] = await client
      .select({ id: schema.products.id, stock: schema.products.stock })
      .from(schema.products)
      .where(eq(schema.products.sku, entry.sku))
      .limit(1)
      .for('update')
    // Unknown SKU: nothing to deduct (applyStockDelta / applyStockMovement both
    // no-op on an unknown SKU), so it cannot oversell.
    if (!row) continue
    const available = locationId ? await levelAt(client, row.id, locationId) : Math.floor(num(row.stock))
    if (entry.requested <= available) continue
    short.push({ sku: entry.sku, name: entry.name, available, requested: entry.requested })
  }

  if (short.length > 0) throw new InsufficientStockError(short)
}

/**
 * Applies one stock movement.
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

  // Lock the product so two concurrent movements cannot interleave their
  // balance arithmetic.
  const [row] = await client
    .select({
      id: schema.products.id,
      sku: schema.products.sku,
      stock: schema.products.stock,
      costPrice: schema.products.costPrice,
    })
    .from(schema.products)
    .where(eq(schema.products.sku, sku))
    .limit(1)
    .for('update')
  if (!row) return null

  const [level] = await client
    .select({ qty: schema.stockLevels.qty })
    .from(schema.stockLevels)
    .where(and(eq(schema.stockLevels.productId, row.id), eq(schema.stockLevels.locationId, locationId)))
    .limit(1)

  const isFirstAtLocation = !level

  // Only the default location inherits the pre-ledger balance. A genuinely new
  // location starts empty — otherwise the first transfer into it would adopt
  // the whole existing stock and double-count it.
  let currentAtLocation = isFirstAtLocation ? 0 : num(level.qty)
  let productHasAnyLevel = true
  if (isFirstAtLocation) {
    const [anywhere] = await client
      .select({ locationId: schema.stockLevels.locationId })
      .from(schema.stockLevels)
      .where(eq(schema.stockLevels.productId, row.id))
      .limit(1)
    productHasAnyLevel = Boolean(anywhere)
    // Product has never moved through the ledger: products.stock predates it,
    // so that balance physically belongs to the default location.
    if (shouldAdoptPreLedgerBalance({ isFirstAtLocation, locationId, productHasAnyLevel })) {
      currentAtLocation = num(row.stock)
    }
  }
  const nextAtLocation = nextBalanceAtLocation({ currentAtLocation, qty })

  if (isFirstAtLocation) {
    await client
      .insert(schema.stockLevels)
      .values({ productId: row.id, locationId, qty: nextAtLocation })
      .onConflictDoUpdate({
        target: [schema.stockLevels.productId, schema.stockLevels.locationId],
        set: { qty: nextAtLocation },
      })
  } else {
    await client
      .update(schema.stockLevels)
      .set({ qty: nextAtLocation })
      .where(and(eq(schema.stockLevels.productId, row.id), eq(schema.stockLevels.locationId, locationId)))
  }

  // products.stock is the rollup, so reports that read it directly stay right.
  const [total] = await client
    .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
    .from(schema.stockLevels)
    .where(eq(schema.stockLevels.productId, row.id))

  const patch: Record<string, unknown> = { stock: Math.floor(num(total?.qty)) }

  // Weighted-average cost, maintained on the way in only. Removing stock does
  // not revalue: the remaining units keep the average they were bought at.
  const unitCost = num(input.unitCost)
  if (isInflow(type) && qty > 0 && unitCost > 0) {
    patch.costPrice = nextCostAfterStockIn({
      oldStock: num(row.stock),
      oldCost: num(row.costPrice),
      addedQty: qty,
      unitValue: unitCost,
    })
  }

  await client.update(schema.products).set(patch as never).where(eq(schema.products.id, row.id))

  await client.insert(schema.stockMovements).values({
    id: newId(),
    productId: row.id,
    sku: row.sku ?? sku,
    locationId,
    type,
    qty,
    stockAfter: nextAtLocation,
    unitCost: unitCost > 0 ? round2(unitCost) : null,
    refType: input.refType,
    refId: input.refId,
    note: input.note,
    createdBy: input.createdBy,
    date: new Date().toISOString(),
  })

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
 * products. Rows are locked FOR UPDATE so two concurrent orders on the same
 * SKU serialise here rather than racing on the balance arithmetic.
 *
 * Returns null for an empty or unknown SKU; callers decide whether that is a
 * skip (restoring an old line whose product was deleted) or an error.
 */
export async function resolveStockSku(client: Client, sku: string): Promise<StockSkuResolution | null> {
  const value = String(sku ?? '').trim()
  if (!value || !client) return null
  const [variant] = await client
    .select({ id: schema.productVariants.id, productId: schema.productVariants.productId })
    .from(schema.productVariants)
    .where(eq(schema.productVariants.sku, value))
    .limit(1)
    .for('update')
  if (variant) {
    const [parent] = await client
      .select({ sku: schema.products.sku })
      .from(schema.products)
      .where(eq(schema.products.id, variant.productId))
      .limit(1)
      .for('update')
    // Orphan variant (parent deleted): nothing trustworthy to deduct.
    if (!parent?.sku) return null
    return { productId: variant.productId, ledgerSku: parent.sku, variantId: variant.id }
  }
  const [product] = await client
    .select({ id: schema.products.id })
    .from(schema.products)
    .where(eq(schema.products.sku, value))
    .limit(1)
    .for('update')
  if (!product) return null
  return { productId: product.id, ledgerSku: value }
}

/**
 * Deducts ONE order line's stock inside the caller's transaction: resolves
 * the SKU to its product/variant, checks availability at the order's location
 * (and at the variant's own counter for variant lines), records the ledger
 * movement against the parent product and decrements the variant counter.
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
  // units while the shop actually taking the sale has 2.
  const level = await levelAt(input.tx, resolved.productId, input.locationId)
  if (level < qty) {
    throw new Error(`Insufficient stock for SKU ${sku} at this location: available ${level}, requested ${qty}`)
  }
  if (resolved.variantId) {
    // The variant's own counter is global (no per-location split); it must
    // not go negative either, or the rollup invariant breaks.
    const [variant] = await input.tx
      .select({ stock: schema.productVariants.stock })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, resolved.variantId))
      .limit(1)
    const variantStock = Math.floor(num(variant?.stock))
    if (variantStock < qty) {
      throw new Error(`Insufficient stock for SKU ${sku} at this location: available ${variantStock}, requested ${qty}`)
    }
  }

  await applyStockMovement({
    sku: resolved.ledgerSku,
    qty: -qty,
    type: 'sale_out',
    refType: input.refType ?? 'sales_order',
    locationId: input.locationId,
    tx: input.tx,
  })
  if (resolved.variantId) {
    await input.tx
      .update(schema.productVariants)
      .set({ stock: sql`${schema.productVariants.stock} - ${qty}` })
      .where(eq(schema.productVariants.id, resolved.variantId))
  }
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
    qty,
    type: 'sale_return_in',
    refType: input.refType ?? 'sales_order',
    locationId: input.locationId,
    tx: input.tx,
  })
  if (resolved.variantId) {
    await input.tx
      .update(schema.productVariants)
      .set({ stock: sql`${schema.productVariants.stock} + ${qty}` })
      .where(eq(schema.productVariants.id, resolved.variantId))
  }
  return { productId: resolved.productId }
}

/**
 * Moves stock between two locations as a matched pair of movements, so each
 * location's ledger shows its own side and neither total changes.
 */
export async function transferStock(input: {
  sku: string
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

    await conn.insert(schema.stockLevels).values({ productId: p.id, locationId, qty: Math.floor(qty) }).onConflictDoNothing()
    await conn.insert(schema.stockMovements).values({
      id: newId(),
      productId: p.id,
      sku: p.sku ?? null,
      locationId,
      type: 'opening',
      qty: Math.floor(qty),
      stockAfter: Math.floor(qty),
      note: 'opening balance carried over from before the stock ledger',
      date: openingEntryDate(p.createdAt),
    })
    created += 1
  }
  return created
}

/** Stock on hand at one location (or across all of them when omitted). */
export async function stockAt(sku: string, locationId?: string | null): Promise<number> {
  if (!db) return 0
  // Both conditions are required. Filtering by location alone returns the total
  // for EVERY product held there rather than this one, which silently
  // over-reports as soon as a second location exists.
  const filters = [eq(schema.products.sku, sku)]
  if (locationId) filters.push(eq(schema.stockLevels.locationId, locationId))
  const [row] = await db
    .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
    .from(schema.stockLevels)
    .innerJoin(schema.products, eq(schema.products.id, schema.stockLevels.productId))
    .where(and(...filters))
  return Math.floor(num(row?.qty))
}