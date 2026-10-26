import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, ne } from 'drizzle-orm'
import { db } from './db/client'
import * as schema from './db/schema'
import { applyStockMovement, resolveMovementLocation } from './stock'
import { logger } from './logger'

/**
 * Purchases — line items, stock-in, input GST and the supplier payment ledger.
 *
 * Purchase invoices used to hold nothing but totals, which meant a purchase
 * could never add stock and a supplier payment could never be recorded. This
 * module owns both halves so the route file stays readable.
 */

const round2 = (n: number) => Math.round(n * 100) / 100

type DbClient = NonNullable<typeof db>
/** The transaction handle drizzle passes to a callback. */
type Tx = Parameters<Parameters<DbClient['transaction']>[0]>[0]

export interface PurchaseItemInput {
  product: string
  sku: string
  qty: number
  weight: number
  rate: number
  cost: number
  tax: number
  amount: number
}





/** Normalise + total a set of purchase lines. Cost is rate × weight. */
export function normalizePurchaseItems(raw: unknown): PurchaseItemInput[] {
  if (!Array.isArray(raw)) return []
  const items = raw
    .map((it) => {
      const item = it && typeof it === 'object' ? (it as Record<string, unknown>) : {}
      const weight = Number(item.weight ?? 0) || 0
      const rate = Number(item.rate ?? 0) || 0
      const qty = Math.max(1, Math.floor(Number(item.qty ?? 1) || 1))
      const cost =
        weight > 0 && rate > 0 ? round2(weight * rate) : round2(Number(item.cost ?? item.amount ?? 0) || 0)
      const tax = round2(Number(item.tax ?? 0) || 0)
      return {
        product: String(item.product ?? item.title ?? '').trim(),
        sku: String(item.sku ?? '').trim(),
        qty,
        weight,
        rate,
        cost,
        tax,
        amount: round2(cost + tax),
      }
    })
    .filter((it) => it.sku !== '' || it.product !== '')
  return items
}

export function purchaseTotals(items: PurchaseItemInput[]) {
  const weight = round2(items.reduce((a, it) => a + it.weight, 0))
  const qty = items.reduce((a, it) => a + it.qty, 0)
  const cost = round2(items.reduce((a, it) => a + it.cost, 0))
  const tax = round2(items.reduce((a, it) => a + it.tax, 0))
  const rate = weight > 0 ? Math.round((cost / weight) * 100) / 100 : 0
  return { weight, qty, cost, tax, total: round2(cost + tax), rate }
}

/** GSTIN → state name, for the input CGST/SGST vs IGST split. */
const STATE_BY_CODE: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh', '97': 'Other Territory',
}

export function stateFromGstin(gstin: string): string {
  return STATE_BY_CODE[gstin.slice(0, 2)] ?? ''
}

/**
 * Split input GST into CGST + SGST (same state) or IGST (other state).
 * With no supplier GSTIN we cannot know, so it is treated as intra-state —
 * the same assumption the sales-side HSN report makes for counter sales.
 */
export function splitInputGst(
  tax: number,
  supplierGstin: string | null | undefined,
  businessState: string,
): { cgst: number; sgst: number; igst: number; supplierState: string } {
  const supplierState = stateFromGstin(String(supplierGstin ?? ''))
  const intra =
    !supplierState || !businessState || supplierState.toLowerCase() === businessState.toLowerCase()
  return {
    cgst: intra ? round2(tax / 2) : 0,
    sgst: intra ? round2(tax / 2) : 0,
    igst: intra ? 0 : round2(tax),
    supplierState,
  }
}

/** Default TCS on bullion purchases (194Q) when the caller doesn't say. */
export function computeTcs(base: number, ratePercent: number | null | undefined) {
  const rate = Number(ratePercent ?? 0)
  if (!Number.isFinite(rate) || rate <= 0 || base <= 0) return { tcsRate: 0, tcsAmount: 0 }
  return { tcsRate: rate, tcsAmount: round2((base * rate) / 100) }
}

/** Business state, used to decide CGST/SGST vs IGST. */
export async function getBusinessState(): Promise<string> {
  if (!db) return ''
  const [row] = await db!.select({ address: schema.settings.address }).from(schema.settings).limit(1)
  const address = String(row?.address ?? '')
  // The GSTIN's state code is authoritative — an address that omits the state
  // name (or an empty address) must not silently make every purchase look
  // intra-state, which would charge CGST+SGST on an inter-state buy.
  const fromGstin = stateFromGstin(await getBusinessGstin())
  if (fromGstin) return fromGstin
  // No GSTIN configured: fall back to a state named in the address.
  for (const name of Object.values(STATE_BY_CODE)) {
    if (address.toLowerCase().includes(name.toLowerCase())) return name
  }
  return ''
}

let cachedGstin: string | null = null
export async function getBusinessGstin(): Promise<string> {
  if (!db) return ''
  if (cachedGstin !== null) return cachedGstin
  const [row] = await db!.select({ gstin: schema.settings.gstin }).from(schema.settings).limit(1)
  cachedGstin = String(row?.gstin ?? '').trim()
  return cachedGstin
}

// ─── Stock ──────────────────────────────────────────────────────────────────

/**
 * Add (or, with a negative qty, remove) purchased stock. Purchases are the one
 * flow that should push stock up; everything else only reverses stock.
 *
 * `unitValue` is the pre-tax cost of ONE unit just purchased. When given, the
 * product's cost price is re-weighted:
 *
 *     newCost = (oldStock × oldCost + addedQty × unitValue) / newStock
 *
 * Without this, buying at a new silver rate leaves `costPrice` at whatever it
 * was months ago and every margin report is quietly wrong. Removals (negative
 * qty) deliberately leave cost price alone — that is standard weighted-average
 * behaviour, where selling stock never revalues what remains.
 */
export async function applyPurchaseStock(
  sku: string,
  qty: number,
  opts?: { unitValue?: number; locationId?: string | null; tx?: Tx },
): Promise<boolean> {
  const delta = Math.floor(Number(qty ?? 0))
  if (!sku || delta === 0) return false
  // Stock-in and stock-reversal share the ledger; the sign of qty decides
  // which way it moves and whether cost is revalued.
  const result = await applyStockMovement({
    sku,
    qty: delta,
    type: delta > 0 ? 'purchase_in' : 'purchase_return_out',
    unitCost: Number(opts?.unitValue ?? 0),
    refType: 'purchase_invoice',
    // Goods received at a specific branch must land in that branch's balance.
    // Absent means the default store, which is where these already went.
    locationId: await resolveMovementLocation(opts?.locationId ?? null, opts?.tx),
    tx: opts?.tx,
  })
  return result !== null
}

/**
 * The location a purchase invoice's stock lives at.
 *
 * Reversals MUST resolve back to this rather than defaulting, or cancelling an
 * invoice removes stock from a different branch than the one it was received
 * into. NULL means the invoice predates locations, and its stock is where it
 * already went.
 */
async function invoiceLocation(client: NonNullable<typeof db>, invoiceId: string): Promise<string | null> {
  const [row] = await client
    .select({ locationId: schema.purchaseInvoices.locationId })
    .from(schema.purchaseInvoices)
    .where(eq(schema.purchaseInvoices.id, invoiceId))
    .limit(1)
  return (row?.locationId as string | null) ?? null
}

/** Reverse the stock a purchase invoice added (edit / cancel / delete). */
export async function reversePurchaseStock(invoiceId: string, tx?: Tx): Promise<number> {
  const client = tx ?? db
  if (!client) return 0
  const items = await client
    .select()
    .from(schema.purchaseInvoiceItems)
    .where(eq(schema.purchaseInvoiceItems.invoiceId, invoiceId))
  const locationId = await invoiceLocation(client, invoiceId)
  let reversed = 0
  for (const it of items) {
    const sku = String(it.sku ?? '')
    if (!sku) continue
    if (await applyPurchaseStock(sku, -Math.floor(Number(it.qty ?? 0)), { locationId, tx })) reversed += 1
  }
  return reversed
}

/**
 * Re-apply the stock a cancelled invoice had added. Cancelling keeps the line
 * items on file (so the invoice still shows what arrived); reinstating puts
 * that stock back without anyone having to retype the lines.
 */
export async function restorePurchaseStock(invoiceId: string, tx?: Tx): Promise<number> {
  const client = tx ?? db
  if (!client) return 0
  const items = await client
    .select()
    .from(schema.purchaseInvoiceItems)
    .where(eq(schema.purchaseInvoiceItems.invoiceId, invoiceId))
  const locationId = await invoiceLocation(client, invoiceId)
  let restored = 0
  for (const it of items) {
    const sku = String(it.sku ?? '')
    if (!sku) continue
    if (await applyPurchaseStock(sku, Math.floor(Number(it.qty ?? 0)), { locationId, tx })) restored += 1
  }
  return restored
}

// ─── Reading ────────────────────────────────────────────────────────────────

export interface PurchaseInvoiceWithItems {
  id: string
  number: string
  supplier: string | null
  status: string | null
  date: string | null
  total: number
  paidAmount: number
  balance: number
  supplierGstin: string | null
  supplierState: string | null
  cgst: number
  sgst: number
  igst: number
  tcsRate: number
  tcsAmount: number
  weight: number
  cost: number
  tax: number
  /** `items` on the invoice row is a count, so the lines come back under `lines`. */
  lines: PurchaseItemInput[]
}

/** Net amount still owed on an invoice (falls back for legacy rows). */
export function balanceOf(invoice: { total?: unknown; paidAmount?: unknown; status?: unknown }): number {
  const total = Number(invoice.total ?? 0)
  const paid = Number(invoice.paidAmount ?? 0)
  return round2(Math.max(0, total - paid))
}

export async function getPurchaseInvoiceWithItems(invoiceId: string): Promise<PurchaseInvoiceWithItems | null> {
  if (!db) return null
  const [invoice] = await db.select().from(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.id, invoiceId)).limit(1)
  if (!invoice) return null
  const items = await db
    .select()
    .from(schema.purchaseInvoiceItems)
    .where(eq(schema.purchaseInvoiceItems.invoiceId, invoiceId))
  return {
    id: invoice.id,
    number: invoice.number,
    supplier: invoice.supplier ?? null,
    status: invoice.status ?? null,
    date: invoice.date ?? null,
    total: Number(invoice.total ?? 0),
    paidAmount: Number(invoice.paidAmount ?? 0),
    balance: balanceOf(invoice),
    supplierGstin: invoice.supplierGstin ?? null,
    supplierState: invoice.supplierState ?? null,
    cgst: Number(invoice.cgst ?? 0),
    sgst: Number(invoice.sgst ?? 0),
    igst: Number(invoice.igst ?? 0),
    tcsRate: Number(invoice.tcsRate ?? 0),
    tcsAmount: Number(invoice.tcsAmount ?? 0),
    weight: Number(invoice.weight ?? 0),
    cost: Number(invoice.cost ?? 0),
    tax: Number(invoice.tax ?? 0),
    lines: items.map((it) => ({
      product: String(it.product ?? ''),
      sku: String(it.sku ?? ''),
      qty: Number(it.qty ?? 0),
      weight: Number(it.weight ?? 0),
      rate: Number(it.rate ?? 0),
      cost: Number(it.cost ?? 0),
      tax: Number(it.tax ?? 0),
      amount: Number(it.amount ?? 0),
    })),
  }
}

/** Insert the line items for an invoice and add them to stock. */
export async function saveInvoiceItems(
  tx: DbClient,
  invoiceId: string,
  items: PurchaseItemInput[],
  opts: { addStock: boolean; locationId?: string | null },
): Promise<{ lines: number; stocked: number }> {
  let lines = 0
  let stocked = 0
  for (const it of items) {
    await tx.insert(schema.purchaseInvoiceItems).values({
      id: randomUUID(),
      invoiceId,
      product: it.product || null,
      sku: it.sku || null,
      qty: it.qty,
      weight: it.weight,
      rate: it.rate,
      cost: it.cost,
      tax: it.tax,
      amount: it.amount,
    })
    lines += 1
    // Cost is per LINE, so the per-unit value that revalues stock is cost ÷ qty.
    const unitValue = it.qty > 0 ? it.cost / it.qty : 0
    if (
      opts.addStock &&
      it.sku &&
      it.qty > 0 &&
      (await applyPurchaseStock(it.sku, it.qty, { unitValue, locationId: opts.locationId ?? null, tx: tx as never }))
    ) {
      stocked += 1
    }
  }
  return { lines, stocked }
}

// ─── Purchase order lines ───────────────────────────────────────────────────

export interface PurchaseOrderLineInput {
  product: string
  sku: string
  qty: number
  weight: number
  rate: number
  amount: number
}

/**
 * Normalise + total purchase-order lines. Amount is qty × weight × rate — the
 * weight column holds the PER-PIECE weight and rate is ₹ per gram (jewellery /
 * bullion pricing), falling back to whatever was sent so a plain "qty only"
 * order still saves.
 */
export function normalizeOrderLines(raw: unknown): PurchaseOrderLineInput[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((it) => {
      const item = it && typeof it === 'object' ? (it as Record<string, unknown>) : {}
      const qty = Math.max(1, Math.floor(Number(item.qty ?? 1) || 1))
      const weight = Number(item.weight ?? 0) || 0
      const rate = Number(item.rate ?? 0) || 0
      const amount =
        weight > 0 && rate > 0 ? round2(qty * weight * rate) : round2(Number(item.amount ?? 0) || 0)
      return {
        product: String(item.product ?? item.title ?? '').trim(),
        sku: String(item.sku ?? '').trim(),
        qty,
        weight,
        rate,
        amount,
      }
    })
    .filter((it) => it.sku !== '' || it.product !== '')
}

export function orderLineTotals(lines: PurchaseOrderLineInput[]) {
  return {
    items: lines.length,
    qty: lines.reduce((a, l) => a + l.qty, 0),
    // Header weight is the TOTAL grams: each line's weight is per-piece.
    weight: round2(lines.reduce((a, l) => a + l.qty * l.weight, 0)),
    value: round2(lines.reduce((a, l) => a + l.amount, 0)),
  }
}

/** Order lines for one PO (or all POs when no id is given). */
export async function getOrderLines(orderIds?: string[]) {
  if (!db) return []
  const rows = await db.select().from(schema.purchaseOrderItems)
  if (!orderIds || orderIds.length === 0) return rows
  const wanted = new Set(orderIds.map(String))
  return rows.filter((r) => wanted.has(String(r.orderId)))
}

/** Replace a PO's lines with these (no stock movement — stock moves on receipt). */
export async function saveOrderLines(orderId: string, lines: PurchaseOrderLineInput[]): Promise<number> {
  if (!db) return 0
  await db.delete(schema.purchaseOrderItems).where(eq(schema.purchaseOrderItems.orderId, orderId))
  for (const l of lines) {
    await db.insert(schema.purchaseOrderItems).values({
      id: randomUUID(),
      orderId,
      product: l.product || null,
      sku: l.sku || null,
      qty: l.qty,
      weight: l.weight,
      rate: l.rate,
      amount: l.amount,
    })
  }
  return lines.length
}

// ─── Purchase returns ───────────────────────────────────────────────────────

export interface PurchaseReturnLineInput {
  product: string
  sku: string
  qty: number
  weight: number
  rate: number
  amount: number
}

/** Normalise + total purchase-return lines. */
export function normalizeReturnLines(raw: unknown): PurchaseReturnLineInput[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((it) => {
      const item = it && typeof it === 'object' ? (it as Record<string, unknown>) : {}
      const weight = Number(item.weight ?? 0) || 0
      const rate = Number(item.rate ?? 0) || 0
      const amount =
        weight > 0 && rate > 0 ? round2(weight * rate) : round2(Number(item.amount ?? 0) || 0)
      return {
        product: String(item.product ?? item.title ?? '').trim(),
        sku: String(item.sku ?? '').trim(),
        qty: Math.max(1, Math.floor(Number(item.qty ?? 1) || 1)),
        weight,
        rate,
        amount,
      }
    })
    .filter((it) => it.sku !== '' || it.product !== '')
}

export function returnLineTotals(lines: PurchaseReturnLineInput[]) {
  return {
    items: lines.length,
    weight: round2(lines.reduce((a, l) => a + l.weight, 0)),
    amount: round2(lines.reduce((a, l) => a + l.amount, 0)),
  }
}

export async function getReturnLines(returnId: string) {
  if (!db) return []
  return db
    .select()
    .from(schema.purchaseReturnItems)
    .where(eq(schema.purchaseReturnItems.returnId, returnId))
}

/**
 * Save a return's lines and, when it is being *received*, take that stock back
 * out. A pending or approved return is just paperwork — nothing moves until the
 * goods actually come back, which is the same rule purchase invoices follow.
 */
export async function saveReturnLines(
  tx: DbClient,
  returnId: string,
  lines: PurchaseReturnLineInput[],
  opts: { reverseStock: boolean; locationId?: string | null },
): Promise<{ lines: number; reversed: number }> {
  let written = 0
  let reversed = 0
  for (const l of lines) {
    await tx.insert(schema.purchaseReturnItems).values({
      id: randomUUID(),
      returnId,
      product: l.product || null,
      sku: l.sku || null,
      qty: l.qty,
      weight: l.weight,
      rate: l.rate,
      amount: l.amount,
    })
    written += 1
    if (opts.reverseStock && l.sku && l.qty > 0) {
      // Returns must never drive stock negative — you cannot send back metal
      // the shop never received.
      const ok = await applyPurchaseStock(l.sku, -l.qty, { locationId: opts.locationId ?? null, tx: tx as never })
      if (ok) reversed += 1
      else logger.warn({ sku: l.sku, qty: l.qty, returnId }, 'Purchase return skipped: SKU not found')
    }
  }
  return { lines: written, reversed }
}

/** Put a received return's stock back (undo / reinstate). */
export async function restoreReturnStock(returnId: string, tx?: Tx): Promise<number> {
  const client = tx ?? db
  if (!client) return 0
  const lines = await client
    .select()
    .from(schema.purchaseReturnItems)
    .where(eq(schema.purchaseReturnItems.returnId, returnId))
  // A return leaves the shop the goods were received into, so it resolves
  // through the original invoice rather than defaulting to the main store.
  const [ret] = await client
    .select({ invoiceId: schema.purchaseReturns.invoiceId })
    .from(schema.purchaseReturns)
    .where(eq(schema.purchaseReturns.id, returnId))
    .limit(1)
  const locationId = ret?.invoiceId ? await invoiceLocation(client, String(ret.invoiceId)) : null
  let restored = 0
  for (const l of lines) {
    const sku = String(l.sku ?? '')
    if (!sku) continue
    if (await applyPurchaseStock(sku, Math.floor(Number(l.qty ?? 0)), { locationId, tx })) restored += 1
  }
  return restored
}

/** Take a received return's stock back out again (undoing a receipt). */
export async function reverseReturnStock(returnId: string, tx?: Tx): Promise<number> {
  const client = tx ?? db
  if (!client) return 0
  const lines = await client
    .select()
    .from(schema.purchaseReturnItems)
    .where(eq(schema.purchaseReturnItems.returnId, returnId))
  const [ret] = await client
    .select({ invoiceId: schema.purchaseReturns.invoiceId })
    .from(schema.purchaseReturns)
    .where(eq(schema.purchaseReturns.id, returnId))
    .limit(1)
  const locationId = ret?.invoiceId ? await invoiceLocation(client, String(ret.invoiceId)) : null
  let reversed = 0
  for (const l of lines) {
    const sku = String(l.sku ?? '')
    if (!sku) continue
    if (await applyPurchaseStock(sku, -Math.floor(Number(l.qty ?? 0)), { locationId, tx })) reversed += 1
  }
  return reversed
}

// ─── Order reconciliation ───────────────────────────────────────────────────

export interface OrderReceipt {
  orderId: string
  number: string
  supplier: string | null
  status: string | null
  orderedQty: number
  orderedWeight: number
  receivedQty: number
  receivedWeight: number
  invoiceCount: number
  invoices: Array<{ id: string; number: string; status: string | null; qty: number; weight: number; date: string | null }>
  /** True when a cancelled invoice is counted; cancelled ones are ignored. */
  shortBy: number
  overBy: number
}

/**
 * Ordered vs received for a purchase order. Cancelled invoices are ignored —
 * counting them would make a short shipment look complete the moment someone
 * voided the invoice that recorded it.
 */
export async function reconcileOrder(orderId: string): Promise<OrderReceipt | null> {
  if (!db) return null
  const [order] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, orderId)).limit(1)
  if (!order) return null
  const orderedLines = await db
    .select()
    .from(schema.purchaseOrderItems)
    .where(eq(schema.purchaseOrderItems.orderId, orderId))
  const invoices = await db
    .select()
    .from(schema.purchaseInvoices)
    .where(eq(schema.purchaseInvoices.orderId, orderId))

  const live = invoices.filter((i) => String(i.status ?? '').toLowerCase() !== 'cancelled')
  const sum = (rows: Array<{ qty?: unknown; weight?: unknown }>, key: 'qty' | 'weight') =>
    round2(rows.reduce((a, r) => a + (Number(r[key] ?? 0) || 0), 0))

  const orderedQty = orderedLines.length > 0
    ? orderedLines.reduce((a, l) => a + (Number(l.qty ?? 0) || 0), 0)
    : Number(order.qty ?? 0) || 0
  const orderedWeight = orderedLines.length > 0
    ? round2(
        orderedLines.reduce(
          (a, l) => a + (Math.max(1, Math.floor(Number(l.qty ?? 1) || 1)) * (Number(l.weight ?? 0) || 0)),
          0,
        ),
      )
    : Number(order.weight ?? 0) || 0
  const receivedQty = sum(live, 'qty')
  const receivedWeight = sum(live, 'weight')

  return {
    orderId: order.id,
    number: order.number,
    supplier: order.supplier ?? null,
    status: order.status ?? null,
    orderedQty,
    orderedWeight,
    receivedQty,
    receivedWeight,
    invoiceCount: live.length,
    invoices: live.map((i) => ({
      id: i.id,
      number: i.number,
      status: i.status ?? null,
      qty: Number(i.qty ?? 0) || 0,
      weight: Number(i.weight ?? 0) || 0,
      date: i.date ?? null,
    })),
    shortBy: round2(Math.max(0, orderedQty - receivedQty)),
    overBy: round2(Math.max(0, receivedQty - orderedQty)),
  }
}

// ─── Supplier payments ──────────────────────────────────────────────────────

export interface SupplierAllocation {
  invoiceId: string
  invoiceNumber: string
  amount: number
  settled: boolean
}

/**
 * Record a payment against a supplier and allocate it oldest-invoice-first.
 * Allocation is bounded by each invoice's *balance* (total − paid), which is
 * what makes repeated partial payments settle correctly and stops a supplier
 * being over-paid.
 *
 * Everything happens inside ONE transaction with the candidate invoice rows
 * locked FOR UPDATE: the balance is re-read under the lock, so two payments
 * racing on the same invoice can never both read the same stale balance and
 * over-allocate it. Writing the ledger row outside that transaction (as an
 * earlier version did) could leave invoices marked paid with no payment
 * recorded if the process died in between.
 */
export async function recordSupplierPayment(input: {
  supplier: string
  amount: number
  method: string
  note?: string | null
  createdBy?: string | null
  /** Restrict allocation to these invoice ids (defaults to all open ones). */
  allocate?: string[] | null
}): Promise<
  | { ok: true; ref: string; paymentId: string; allocations: SupplierAllocation[]; outstanding: number; settled: string[] }
  | { ok: false; error: string }
> {
  if (!db) return { ok: false, error: 'Database not configured' }
  const supplier = input.supplier.trim()
  const amount = round2(input.amount)
  if (!supplier) return { ok: false, error: 'supplier required' }
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'amount must be > 0' }

  const paymentId = randomUUID()
  const ref = `SP-${Date.now().toString(36).toUpperCase()}${Math.floor(10 + Math.random() * 89)}`
  const now = new Date().toISOString()

  const result = await db.transaction(async (tx) => {
    // Lock the candidate rows so a concurrent payment for the same supplier
    // cannot slip in between reading the balances and writing them.
    const open = await tx
      .select()
      .from(schema.purchaseInvoices)
      .where(
        and(
          eq(schema.purchaseInvoices.supplier, supplier),
          ne(schema.purchaseInvoices.status, 'paid'),
          ne(schema.purchaseInvoices.status, 'cancelled'),
        ),
      )
      .orderBy(asc(schema.purchaseInvoices.date))
      .for('update')

    const eligible = open
      .filter((inv) => balanceOf(inv) > 0)
      .filter((inv) => !input.allocate || input.allocate.map(String).includes(inv.id))
    if (eligible.length === 0) return { ok: false as const, error: 'No outstanding invoices for this supplier' }

    const outstanding = round2(eligible.reduce((a, inv) => a + balanceOf(inv), 0))
    if (amount > outstanding + 0.01) {
      return { ok: false as const, error: `Amount exceeds outstanding (${outstanding.toFixed(2)})` }
    }

    const allocations: SupplierAllocation[] = []
    let remaining = amount
    for (const inv of eligible) {
      if (remaining <= 0.009) break
      const balance = balanceOf(inv)
      const applied = round2(Math.min(balance, remaining))
      if (applied <= 0) continue
      remaining = round2(remaining - applied)
      const paidSoFar = round2(Number(inv.paidAmount ?? 0) + applied)
      const fullySettled = paidSoFar >= Number(inv.total ?? 0) - 0.01
      allocations.push({ invoiceId: inv.id, invoiceNumber: inv.number, amount: applied, settled: fullySettled })
      await tx
        .update(schema.purchaseInvoices)
        .set({ paidAmount: paidSoFar, status: fullySettled ? 'paid' : 'partial' })
        .where(eq(schema.purchaseInvoices.id, inv.id))
    }

    // Ledger row and its allocations commit with the balances above, or not at all.
    await tx.insert(schema.supplierPayments).values({
      id: paymentId,
      ref,
      supplier,
      amount,
      method: input.method,
      note: input.note ?? null,
      date: now,
      createdBy: input.createdBy ?? null,
    })
    for (const a of allocations) {
      await tx.insert(schema.supplierPaymentAllocations).values({
        id: randomUUID(),
        paymentId,
        invoiceId: a.invoiceId,
        invoiceNumber: a.invoiceNumber,
        amount: a.amount,
      })
    }

    return { ok: true as const, outstanding, allocations }
  })

  if (!result.ok) return result

  const { outstanding, allocations } = result
  logger.info({ supplier, amount, ref, allocations }, 'Supplier payment recorded')
  return {
    ok: true,
    ref,
    paymentId,
    allocations,
    outstanding: round2(outstanding - amount),
    settled: allocations.filter((a) => a.settled).map((a) => a.invoiceNumber),
  }
}

export async function getSupplierPayments(supplier?: string | null, limit = 50) {
  if (!db) return []
  return db
    .select()
    .from(schema.supplierPayments)
    .where(supplier ? eq(schema.supplierPayments.supplier, supplier) : undefined)
    .orderBy(desc(schema.supplierPayments.date))
    .limit(limit)
}

export async function getPaymentAllocations(paymentId: string) {
  if (!db) return []
  return db
    .select()
    .from(schema.supplierPaymentAllocations)
    .where(eq(schema.supplierPaymentAllocations.paymentId, paymentId))
}

// ─── Dues + aging ───────────────────────────────────────────────────────────

export interface SupplierAging {
  supplier: string | null
  invoiceCount: number
  total: number
  paid: number
  balance: number
  oldestDate: string | null
  /**
   * Aging buckets, named to match the receivables aging used elsewhere in the
   * app: `current` is not yet due (0 days), `d1_30` is 1–30 days past the due
   * date, `d31_60` is 31–60 and `d60plus` is over 60.
   */
  current: number
  d1_30: number
  d31_60: number
  d60plus: number
}

/** Days since a date, in whole days (0 for today). */
function daysSince(value: string | null | undefined): number {
  if (!value) return 0
  const then = new Date(value).getTime()
  if (!Number.isFinite(then)) return 0
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000))
}

/**
 * Outstanding supplier dues with an aging split. Cancelled invoices are
 * excluded — they were previously counted as money owed, which meant the
 * headline total could never be paid off.
 */
export type AgingBucketKey = 'current' | 'd1_30' | 'd31_60' | 'd60plus'

/**
 * Which aging bucket an invoice of a given age falls into. Boundaries match
 * the receivables aging: today is `current`, then 1–30, 31–60 and 60+.
 */
export function agingBucketFor(ageDays: number): AgingBucketKey {
  const age = Number(ageDays)
  if (!Number.isFinite(age) || age <= 0) return 'current'
  if (age <= 30) return 'd1_30'
  if (age <= 60) return 'd31_60'
  return 'd60plus'
}

export async function collectSupplierDues(): Promise<SupplierAging[]> {
  if (!db) return []
  const rows = await db
    .select({
      supplier: schema.purchaseInvoices.supplier,
      number: schema.purchaseInvoices.number,
      date: schema.purchaseInvoices.date,
      total: schema.purchaseInvoices.total,
      paidAmount: schema.purchaseInvoices.paidAmount,
    })
    .from(schema.purchaseInvoices)
    .where(
      and(
        ne(schema.purchaseInvoices.status, 'paid'),
        ne(schema.purchaseInvoices.status, 'cancelled'),
      ),
    )

  const bySupplier = new Map<string, SupplierAging>()
  for (const r of rows) {
    const key = r.supplier ?? 'Unknown'
    const balance = balanceOf(r)
    if (balance <= 0) continue
    const age = daysSince(r.date)
    const entry =
      bySupplier.get(key) ??
      ({
        supplier: r.supplier ?? null,
        invoiceCount: 0,
        total: 0,
        paid: 0,
        balance: 0,
        oldestDate: r.date ?? null,
        current: 0,
        d1_30: 0,
        d31_60: 0,
        d60plus: 0,
      } satisfies SupplierAging)
    entry.invoiceCount += 1
    entry.total = round2(entry.total + Number(r.total ?? 0))
    entry.paid = round2(entry.paid + Number(r.paidAmount ?? 0))
    entry.balance = round2(entry.balance + balance)
    const bucket = agingBucketFor(age)
    entry[bucket] = round2(entry[bucket] + balance)
    bySupplier.set(key, entry)
  }
  return [...bySupplier.values()].sort((a, b) => b.balance - a.balance)
}

/** Open invoices for one supplier, oldest first — for the payment dialog. */
export async function getSupplierOpenInvoices(supplier: string) {
  if (!db) return []
  const rows = await db
    .select()
    .from(schema.purchaseInvoices)
    .where(
      and(
        eq(schema.purchaseInvoices.supplier, supplier),
        ne(schema.purchaseInvoices.status, 'paid'),
        ne(schema.purchaseInvoices.status, 'cancelled'),
      ),
    )
    .orderBy(asc(schema.purchaseInvoices.date))
  return rows
    .map((r) => ({
      id: r.id,
      number: r.number,
      date: r.date ?? null,
      total: Number(r.total ?? 0),
      paidAmount: Number(r.paidAmount ?? 0),
      balance: balanceOf(r),
      ageDays: daysSince(r.date),
    }))
    .filter((r) => r.balance > 0)
}

// ─── Auto invoice: purchase order → purchase invoice ────────────────────────

export type EnsurePurchaseInvoiceResult =
  | { ok: true; action: 'created' | 'refreshed'; invoice: typeof schema.purchaseInvoices.$inferSelect }
  | { ok: false; skipped: string }

/**
 * Raise (and keep in step) the purchase invoice linked to a purchase order.
 *
 * Called every time a PO's lines are saved: a new order gets its invoice
 * immediately, and editing the order refreshes the one it already has — one
 * live invoice per order (cancelled ones are ignored), idempotent under
 * retries. The invoice mirrors the manual POST /db/purchase-invoices flow:
 *
 *  - line weight is the TOTAL for the line (qty × per-piece weight), which is
 *    what reconcileOrder compares ordered weight against;
 *  - tax carries the order's GST rate per line, so the invoice total matches
 *    the order's grand total (the PO discount has no invoice column — same as
 *    the manual flow);
 *  - stock moves now, because in this app a purchase invoice IS the receipt
 *    (cancel or delete the invoice to take the stock back out).
 *
 * Skips (never errors) when the order has no supplier or no line items — a
 * header-only row can't be billed.
 */
export async function ensurePurchaseInvoiceForOrder(orderId: string): Promise<EnsurePurchaseInvoiceResult> {
  if (!db) return { ok: false, skipped: 'database unavailable' }
  const [order] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, orderId)).limit(1)
  if (!order) return { ok: false, skipped: 'order not found' }
  const supplier = String(order.supplier ?? '').trim()
  if (!supplier) return { ok: false, skipped: 'order has no supplier' }
  const lines = await getOrderLines([orderId])
  if (lines.length === 0) return { ok: false, skipped: 'order has no line items' }

  // GST rate on the order (NULL predates the columns — 3% is the app default,
  // same rule as poGstRate in the route file). The cast keeps the legacy
  // empty-string guard: numeric columns have come back as '' before.
  const gstRaw = order.gst as unknown
  const gstRate = gstRaw == null || gstRaw === '' ? 3 : Number(gstRaw) || 0

  // PO line amount is qty × per-piece weight × rate; invoice cost is
  // total-weight × rate, so the weight must be the line total here.
  const items = normalizePurchaseItems(
    lines.map((l) => {
      const qty = Math.max(1, Math.floor(Number(l.qty ?? 1) || 1))
      const weight = round2(qty * (Number(l.weight ?? 0) || 0))
      const cost = round2(weight * (Number(l.rate ?? 0) || 0))
      return {
        product: l.product ?? '',
        sku: l.sku ?? '',
        qty,
        weight,
        rate: Number(l.rate ?? 0) || 0,
        cost,
        tax: round2((cost * gstRate) / 100),
      }
    }),
  )
  if (items.length === 0) return { ok: false, skipped: 'order has no billable lines' }
  const totals = purchaseTotals(items)

  const linked = await db
    .select()
    .from(schema.purchaseInvoices)
    .where(eq(schema.purchaseInvoices.orderId, orderId))
  const existing = linked.find((i) => String(i.status ?? '').toLowerCase() !== 'cancelled') ?? null

  const locationId = await resolveMovementLocation(null)

  if (existing) {
    // Same guard as the manual PATCH: never drop the total below what has
    // already been paid against the invoice.
    const paid = Number(existing.paidAmount ?? 0)
    if (paid > 0 && totals.total + 0.01 < paid) {
      return { ok: false, skipped: `linked invoice ${existing.number} is paid more than the new total` }
    }
    const gstSplit = splitInputGst(totals.tax, existing.supplierGstin, await getBusinessState())
    const invoice = await db.transaction(async (tx) => {
      // Replace the lines exactly like the manual edit does: reverse the old
      // stock, rewrite the lines, re-apply stock.
      await reversePurchaseStock(existing.id, tx as never)
      await tx.delete(schema.purchaseInvoiceItems).where(eq(schema.purchaseInvoiceItems.invoiceId, existing.id))
      const [row] = await tx
        .update(schema.purchaseInvoices)
        .set({
          supplier,
          items: totals.qty,
          qty: totals.qty,
          weight: totals.weight,
          rate: totals.rate,
          cost: totals.cost,
          tax: totals.tax,
          total: totals.total,
          supplierState: gstSplit.supplierState || null,
          cgst: gstSplit.cgst,
          sgst: gstSplit.sgst,
          igst: gstSplit.igst,
        })
        .where(eq(schema.purchaseInvoices.id, existing.id))
        .returning()
      await saveInvoiceItems(tx as never, existing.id, items, { addStock: true, locationId: existing.locationId ?? locationId })
      return row
    })
    if (!invoice) return { ok: false, skipped: 'invoice refresh failed' }
    return { ok: true, action: 'refreshed', invoice }
  }

  const id = randomUUID()
  const number = await mintPurchaseInvoiceNumber()
  const gstSplit = splitInputGst(totals.tax, null, await getBusinessState())
  const invoice = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.purchaseInvoices)
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
        supplierGstin: null,
        supplierState: gstSplit.supplierState || null,
        cgst: gstSplit.cgst,
        sgst: gstSplit.sgst,
        igst: gstSplit.igst,
        tcsRate: 0,
        tcsAmount: 0,
        // Link back so reconcileOrder counts it as received against the order.
        orderId: order.id,
        // 'pending' is the manual endpoint's default for an unpaid invoice.
        status: 'pending',
        date: order.date ? String(order.date) : new Date().toISOString(),
        locationId,
      })
      .returning()
    await saveInvoiceItems(tx as never, id, items, { addStock: true, locationId })
    return row
  })
  if (!invoice) return { ok: false, skipped: 'invoice create failed' }
  return { ok: true, action: 'created', invoice }
}

/**
 * `PI-YYYY-NNNN` — the same shape the New Invoice dialog mints. The
 * count-based suffix can collide after a delete, so the first free number
 * wins here; the unique index backs the whole thing up.
 */
async function mintPurchaseInvoiceNumber(): Promise<string> {
  if (!db) throw new Error('database unavailable')
  const year = new Date().getFullYear()
  const used = new Set(
    (await db.select({ number: schema.purchaseInvoices.number }).from(schema.purchaseInvoices)).map((r) => String(r.number)),
  )
  for (let n = 1; n < 100000; n++) {
    const candidate = `PI-${year}-${String(n).padStart(4, '0')}`
    if (!used.has(candidate)) return candidate
  }
  throw new Error('could not mint a purchase invoice number')
}

/**
 * Next supplier invoice number when recreating a cancelled one: keep
 * everything up to the LAST digit run and bump that run, preserving width
 * (INV-005 → INV-006, PI-2026-0007 → PI-2026-0008). A number with no digits
 * at all falls back to a dated suffix.
 *
 * The trailing run is located with /(\d+)(\D*)$/ plus index arithmetic rather
 * than a splitting pattern: every splitting attempt is either too greedy
 * (a greedy prefix steals the run down to its last digit: PI-2026-0019 →
 * PI-2026-00110) or too lazy (a lazy \D* prefix cannot cross a digit, so
 * multi-run numbers like the minted PI-YYYY-NNNN shape never matched and
 * fell through to the date-suffix fallback).
 *
 * Pure and synchronous — the route owns the clash-retry loop.
 */
export function bumpPurchaseInvoiceNumber(number: string, bump = 1): string {
  const trimmed = String(number ?? '').trim()
  const tail = trimmed.match(/(\d+)(\D*)$/)
  if (!tail || tail.index == null) {
    const now = new Date()
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    return bump === 1 ? `${trimmed}-${stamp}` : `${trimmed}-${stamp}-${bump}`
  }
  const digits = tail[1]
  const next = String(Number(digits) + bump)
  // padStart only pads, never truncates: on overflow (9999 + 1 = 10000) the
  // widened result must win, or we'd emit a mangled extra-digit prefix.
  const width = Math.max(digits.length, next.length)
  return `${trimmed.slice(0, tail.index)}${next.padStart(width, '0')}${tail[2]}`
}

