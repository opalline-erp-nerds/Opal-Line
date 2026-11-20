import { sql } from 'drizzle-orm'
import { db } from './db/client'
import * as schema from './db/schema'

/**
 * Per-invoice OUTSTANDING = `grandTotal − collectedAmount` (Phase 5.2).
 *
 * `collectedAmount` is what payments have actually credited against the
 * invoice number: positive payments with status success/settled/paid — which
 * includes a booking's Advance row the moment conversion points it at the
 * invoice — short of the invoice total. An invoice already flagged `paid`
 * counts as fully collected. This mirrors the dashboard receivables exactly
 * (`routes/dashboard.ts` COLLECTED_ON_INVOICE) so the Dues page, the payment
 * cap, customer summaries, reminders and statements can never disagree with
 * the reports.
 *
 * Used for every customer-facing outstanding figure so an operator can never
 * be asked for — nor able to record — more than the customer actually owes.
 */

export interface InvoiceLike {
  grandTotal?: unknown
  paymentStatus?: string | null
  status?: string | null
  number?: string | null
}

/** JS mirror of the SQL below: what payments have collected on one invoice. */
export function invoiceCollected(row: InvoiceLike, paidByInvoice: Map<string, number>): number {
  const gross = Number(row.grandTotal ?? 0) || 0
  const paidFlag =
    String(row.paymentStatus ?? '').toLowerCase() === 'paid' ||
    String(row.status ?? '').toLowerCase() === 'paid'
  const collected = paidFlag ? gross : Math.min(gross, paidByInvoice.get(String(row.number ?? '')) ?? 0)
  return Math.round(collected * 100) / 100
}

/** One invoice's still-owed amount, floored at zero. */
export function invoiceOutstanding(row: InvoiceLike, paidByInvoice: Map<string, number>): number {
  const gross = Number(row.grandTotal ?? 0) || 0
  return Math.max(0, Math.round((gross - invoiceCollected(row, paidByInvoice)) * 100) / 100)
}

/**
 * Positive, succeeded payments grouped by invoice number — the `collected`
 * half of the equation, fetched once per request.
 */
export async function collectedByInvoice(): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (!db) return map
  const rows = await db
    .select({
      invoice: schema.payments.invoice,
      total: sql<number>`coalesce(sum(coalesce(${schema.payments.amount}, 0)), 0)`,
    })
    .from(schema.payments)
    .where(
      sql`coalesce(${schema.payments.amount}, 0) > 0
        and lower(coalesce(${schema.payments.status}, '')) in ('success', 'settled', 'paid')
        and ${schema.payments.invoice} is not null`,
    )
    .groupBy(schema.payments.invoice)
  for (const r of rows) map.set(String(r.invoice), Number(r.total ?? 0))
  return map
}

/**
 * The same outstanding rule as a SQL expression (correlated per invoice row)
 * for aggregate queries like `collectDues`' GROUP BY — identical semantics to
 * `invoiceOutstanding`, so JS and SQL sides always agree.
 */
export const INVOICE_OUTSTANDING_SQL = sql<number>`greatest(
  coalesce(${schema.salesInvoices.grandTotal}, 0) - case
    when lower(coalesce(${schema.salesInvoices.paymentStatus}, '')) = 'paid'
      or lower(coalesce(${schema.salesInvoices.status}, '')) = 'paid'
      then coalesce(${schema.salesInvoices.grandTotal}, 0)
    else coalesce((
      select sum(coalesce(p.amount, 0))
        from ${schema.payments} p
       where p.invoice = ${schema.salesInvoices.number}
         and coalesce(p.amount, 0) > 0
         and lower(coalesce(p.status, '')) in ('success', 'settled', 'paid')
    ), 0)
  end, 0)`
