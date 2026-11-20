import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from './db/client'
import * as schema from './db/schema'
import { logger } from './logger'

/**
 * GST e-invoicing.
 *
 * The IRP itself is not reachable without a GSTIN + signing identity, so this
 * module is deliberately provider-shaped: the invoice payload is built here
 * (GSTIRN schema v1.05), and a provider is responsible for the round trip.
 *
 *   • `mock`      — local provider used until real credentials exist. Produces
 *                   a well-formed 64-hex IRN so the whole flow (storage, QR,
 *                   status, cancel) can be exercised and demonstrated offline.
 *   • `cleartax`  — ClearTax e-invoice API. Enabled automatically when
 *                   CLEARTAX_GSTIN + CLEARTAX_AUTH_TOKEN are set.
 *
 * Switching to a real gateway means adding one adapter here — nothing in the
 * routes, UI or schema needs to change.
 */

export type EInvoiceMode = 'off' | 'manual' | 'automatic'

export interface EInvoiceResult {
  irn: string
  /** IRN date as reported by the gateway (ISO). */
  irnDate: string
  /** Signed QR payload, when the gateway provides one. */
  qrCode: string | null
  provider: string
}

export interface EInvoiceProvider {
  name: string
  generate(payload: Record<string, unknown>, invoiceNumber: string): Promise<EInvoiceResult>
  cancel(irn: string, reason: string): Promise<{ ok: boolean; cancelDate?: string; error?: string }>
}

const IRN_LENGTH = 64

/** A syntactically valid IRN (64 hex chars) for the offline provider. */
function fakeIrn(seed: string): string {
  return createHash('sha256').update(`${seed}:${randomBytes(8).toString('hex')}`).digest('hex').slice(0, IRN_LENGTH)
}

function toDateOnly(value: string | Date | null | undefined): string {
  const d = value ? new Date(value) : new Date()
  const iso = Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString()
  return iso.slice(0, 10)
}

/**
 * Offline provider. Never contacts the IRP — it exists so the approval flow,
 * storage and UI work end-to-end before credentials are configured. IRNs are
 * clearly marked in the QR payload so they are never mistaken for real ones.
 */
const mockProvider: EInvoiceProvider = {
  name: 'mock',
  async generate(payload, invoiceNumber) {
    const irn = fakeIrn(`${invoiceNumber}:${JSON.stringify(payload).length}`)
    const irnDate = new Date().toISOString()
    const qr = [
      `irn=${irn}`,
      'seller=OPAL LINE',
      'buyer=UNREGISTERED',
      `invoice=${invoiceNumber}`,
      'mock=true',
    ].join('|')
    return { irn, irnDate, qrCode: qr, provider: 'mock' }
  },
  async cancel() {
    return { ok: true, cancelDate: new Date().toISOString() }
  },
}

/** ClearTax e-invoice API adapter (activated by CLEARTAX_* env vars). */
const clearTaxProvider: EInvoiceProvider = {
  name: 'cleartax',
  async generate(payload, invoiceNumber) {
    const base = process.env.CLEARTAX_SANDBOX === 'true' ? 'https://einvoicing.internal.cleartax.in/einvoice' : 'https://einvoicing.cleartax.in/einvoice'
    const authToken = process.env.CLEARTAX_AUTH_TOKEN?.trim()
    if (!authToken) return { ...(await mockProvider.generate(payload, invoiceNumber)), provider: 'mock (cleartax token missing)' }
    const res = await fetch(`${base}/generate-irn`, {
      method: 'POST',
      headers: {
        'x-auth-token': authToken,
        'gstin': process.env.CLEARTAX_GSTIN?.trim() ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`ClearTax rejected the IRN request (${res.status}): ${body.slice(0, 200)}`)
    }
    const data = (await res.json()) as {
      IRN?: string
      IrnDate?: string
      SignedQRCode?: string
      ErrorMessage?: string
    }
    if (!data.IRN) throw new Error(`ClearTax returned no IRN: ${data.ErrorMessage ?? 'unknown error'}`)
    return {
      irn: data.IRN,
      irnDate: data.IrnDate ?? new Date().toISOString(),
      qrCode: data.SignedQRCode ?? null,
      provider: 'cleartax',
    }
  },
  async cancel(irn, reason) {
    const authToken = process.env.CLEARTAX_AUTH_TOKEN?.trim()
    if (!authToken) return { ok: false, error: 'CLEARTAX_AUTH_TOKEN is not configured' }
    const base = process.env.CLEARTAX_SANDBOX === 'true' ? 'https://einvoicing.internal.cleartax.in/einvoice' : 'https://einvoicing.cleartax.in/einvoice'
    const res = await fetch(`${base}/cancel-irn`, {
      method: 'POST',
      headers: {
        'x-auth-token': authToken,
        'gstin': process.env.CLEARTAX_GSTIN?.trim() ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ IRN: irn, Reason: reason, Action: 'CAN' }),
    })
    if (!res.ok) return { ok: false, error: `Cancel failed (${res.status})` }
    const data = (await res.json().catch(() => ({}))) as { CancelDate?: string; ErrorMessage?: string }
    if (data.ErrorMessage) return { ok: false, error: data.ErrorMessage }
    return { ok: true, cancelDate: data.CancelDate ?? new Date().toISOString() }
  },
}

export function resolveProvider(): EInvoiceProvider {
  if (process.env.CLEARTAX_GSTIN?.trim() && process.env.CLEARTAX_AUTH_TOKEN?.trim()) return clearTaxProvider
  return mockProvider
}

export function isRealGatewayConfigured(): boolean {
  return Boolean(process.env.CLEARTAX_GSTIN?.trim() && process.env.CLEARTAX_AUTH_TOKEN?.trim())
}

/**
 * Effective mode: the legacy `einvoiceEnabled` switch still counts, so a shop
 * that turned e-invoicing on before this setting existed lands on `manual`.
 */
export async function resolveEInvoiceMode(): Promise<EInvoiceMode> {
  if (!db) return 'off'
  const [row] = await db
    .select({ enabled: schema.settings.einvoiceEnabled, mode: schema.settings.einvoiceMode })
    .from(schema.settings)
    .limit(1)
  if (!row) return 'off'
  if (row.enabled === false) return 'off'
  const mode = String(row.mode ?? '').trim().toLowerCase()
  if (mode === 'manual' || mode === 'automatic') return mode
  return row.enabled ? 'manual' : 'off'
}

/** GST state code (first two digits of the GSTIN) → needs a name for the payload. */
function placeOfSupply(gstin: string): string {
  return gstin.slice(0, 2)
}

function stateNameFromGstin(gstin: string): string {
  const code = placeOfSupply(gstin)
  const names: Record<string, string> = {
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
  return names[code] ?? 'Other Territory'
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Build the GSTIRN v1.05 payload for an invoice. Line items are grouped by rate
 * (the schema wants one row per tax rate, not per SKU) and discounts are pushed
 * down proportionally so the taxable values reconcile with the invoice.
 */
export async function buildEInvoicePayload(invoiceId: string): Promise<{ payload: Record<string, unknown>; invoiceNumber: string } | null> {
  if (!db) return null
  const [invoice] = await db.select().from(schema.salesInvoices).where(eq(schema.salesInvoices.id, invoiceId)).limit(1)
  if (!invoice) return null
  const items = await db.select().from(schema.salesInvoiceItems).where(eq(schema.salesInvoiceItems.invoiceId, invoiceId))
  if (items.length === 0) return null
  const [settings] = await db.select().from(schema.settings).limit(1)

  const gstin = String(settings?.gstin ?? '').trim()
  const buyerGstin = String(invoice.buyerGstin ?? '').trim()
  const totalAmount = Number(invoice.grandTotal ?? 0)
  const discount = Number(invoice.discount ?? 0)
  const amountSum = items.reduce((a, it) => a + Number(it.amount ?? 0), 0)
  const taxablePool = Math.max(0, Number(invoice.subtotal ?? 0) - discount)
  const rate = Number(invoice.gst ?? 0)

  const lines = items.map((it) => ({
    sku: String(it.sku ?? '').trim(),
    desc: String(it.product ?? it.sku ?? 'Item').trim(),
    qty: Number(it.qty ?? 1),
    // Discount is pushed down pro-rata across lines.
    taxable: round2(
      Number(it.amount ?? 0) * (amountSum > 0 ? taxablePool / amountSum : 1),
    ),
    rate,
    total: round2(Number(it.amount ?? 0) * (amountSum > 0 ? taxablePool / amountSum : 1) * (1 + rate / 100)),
  }))

  // The schema wants one line per tax rate.
  const byRate = new Map<number, typeof lines>()
  for (const line of lines) {
    const arr = byRate.get(line.rate) ?? []
    arr.push(line)
    byRate.set(line.rate, arr)
  }

  const payload = {
    Version: '1.05',
    IRN: invoice.irn ?? '',
    TransactionDate: toDateOnly(invoice.date),
    InvoiceNumber: String(invoice.number),
    InvoiceType: 'R',
    EInvoiceStatus: invoice.irn ? 'ACT' : 'N',
    Buyer: {
      GSTIN: buyerGstin || undefined,
      LegalName: String(invoice.customer ?? 'Walk-in Customer'),
      Address1: String(invoice.customerAddress ?? invoice.customerCity ?? '-'),
      Address2: undefined,
      Address3: undefined,
      Pincode: invoice.customerPincode ? Number(invoice.customerPincode) || undefined : undefined,
      StateCode: Number(buyerGstin.slice(0, 2)) || undefined,
      State: buyerGstin ? stateNameFromGstin(buyerGstin) : undefined,
      Country: 'India',
    },
    Seller: {
      GSTIN: gstin || undefined,
      LegalName: String(settings?.businessName ?? 'Opal Line'),
      Address1: String(settings?.address ?? '-'),
      Pincode: undefined,
      StateCode: Number(placeOfSupply(gstin)) || undefined,
      State: stateNameFromGstin(gstin),
      Country: 'India',
    },
    PlaceOfSupply: Number(placeOfSupply(gstin)) || 27,
    TotalValue: totalAmount,
    TaxableValue: taxablePool,
    TaxAmount: Number(invoice.gstAmount ?? round2(taxablePool * (rate / 100))),
    Discount: discount || undefined,
    OtherCharges: undefined,
    InvoiceTypeName: 'Original for Recipient',
    ReverseCharge: false,
    ItemList: [...byRate.entries()].map(([lineRate, group]) => ({
      NumberOfLines: group.length,
      TotalQuantity: group.reduce((a, l) => a + l.qty, 0),
      TotalAmount: round2(group.reduce((a, l) => a + l.total, 0)),
      TaxableValue: round2(group.reduce((a, l) => a + l.taxable, 0)),
      Tax: round2(group.reduce((a, l) => a + (l.taxable * lineRate) / 100, 0)),
      TaxRate: lineRate,
      Item: group.map((l) => ({
        Description: l.desc,
        HSNCodes: undefined,
        Quantity: l.qty,
        Unit: 'NOS',
        UnitPrice: round2(l.taxable / (l.qty || 1)),
        Discount: undefined,
        TaxableAmount: l.taxable,
        TotalAmount: l.total,
        GSTIN: undefined,
        FreeFrom: false,
      })),
    })),
  }

  return { payload, invoiceNumber: String(invoice.number) }
}

/**
 * Generate and store an IRN for an invoice. Returns the stored row, or a
 * failure reason the caller can surface.
 */
export async function generateEInvoiceForInvoice(
  invoiceId: string,
): Promise<{ ok: true; irn: string; irnDate: string; qrCode: string | null; provider: string } | { ok: false; error: string }> {
  if (!db) return { ok: false, error: 'Database unavailable' }

  // Idempotent (Phase 4 hardening): an invoice that already carries an IRN
  // never calls the gateway again — a recovery retry or a repeated manual
  // trigger can therefore never mint a SECOND IRN for one invoice.
  const [existing] = await db
    .select({ irn: schema.salesInvoices.irn, irnDate: schema.salesInvoices.irnDate, qrCode: schema.salesInvoices.qrCode })
    .from(schema.salesInvoices)
    .where(eq(schema.salesInvoices.id, invoiceId))
    .limit(1)
  if (!existing) return { ok: false, error: 'Invoice not found' }
  if (existing.irn) {
    return { ok: true, irn: existing.irn, irnDate: existing.irnDate ?? '', qrCode: existing.qrCode ?? null, provider: 'existing' }
  }

  const built = await buildEInvoicePayload(invoiceId)
  if (!built) return { ok: false, error: 'Invoice or its line items could not be loaded' }

  const provider = resolveProvider()
  try {
    const result = await provider.generate(built.payload, built.invoiceNumber)
    await db
      .update(schema.salesInvoices)
      .set({ irn: result.irn, irnDate: result.irnDate, qrCode: result.qrCode })
      .where(eq(schema.salesInvoices.id, invoiceId))
    logger.info({ invoice: built.invoiceNumber, irn: result.irn, provider: result.provider }, 'e-invoice IRN generated')
    return { ok: true, irn: result.irn, irnDate: result.irnDate, qrCode: result.qrCode, provider: result.provider }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    logger.error({ err, invoice: built.invoiceNumber }, 'e-invoice generation failed')
    return { ok: false, error: message }
  }
}

/** Cancel an already-generated IRN (irreversible at the IRP). */
export async function cancelEInvoiceForInvoice(
  invoiceId: string,
  reason: string,
): Promise<{ ok: true; cancelDate?: string } | { ok: false; error: string }> {
  if (!db) return { ok: false, error: 'Database unavailable' }
  const [invoice] = await db.select().from(schema.salesInvoices).where(eq(schema.salesInvoices.id, invoiceId)).limit(1)
  if (!invoice) return { ok: false, error: 'Invoice not found' }
  if (!invoice.irn) return { ok: false, error: 'This invoice has no IRN to cancel' }

  const provider = resolveProvider()
  const result = await provider.cancel(invoice.irn, reason)
  if (!result.ok) return { ok: false, error: result.error ?? 'Cancel failed' }
  // Keep the IRN on the invoice as an audit trail, but flag the void.
  await db
    .update(schema.salesInvoices)
    .set({ status: 'cancelled', paymentStatus: 'cancelled' })
    .where(eq(schema.salesInvoices.id, invoiceId))
  logger.info({ invoice: invoice.number, irn: invoice.irn, reason }, 'e-invoice cancelled')
  return { ok: true, cancelDate: result.cancelDate }
}