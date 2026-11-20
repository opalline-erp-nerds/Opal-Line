import { and, gte, lte, ne, sql } from 'drizzle-orm'
import { db } from './db/client'
import * as schema from './db/schema'
import { logger } from './logger'
import { sendEmail } from './notifications'
import { loadNotificationPrefs } from './notificationPrefs'
import { escapeHtml } from './htmlEscape'
import { createScheduler } from './lib/scheduler'
import { collectedByInvoice, invoiceOutstanding } from './outstanding'

/**
 * Due-date reminders: daily at 09:15, email customers whose unpaid invoices
 * fall due within the next 3 days (or became due today). One email per
 * customer listing all their invoices coming due.
 */
const HOUR = 9
const MINUTE = 15
const WINDOW_DAYS = 3

function msUntilNextRun(now = new Date()): number {
  const next = new Date(now)
  next.setHours(HOUR, MINUTE, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

export async function runDueReminders(): Promise<{ sent: number; invoices: number }> {
  if (!db) return { sent: 0, invoices: 0 }
  const prefs = await loadNotificationPrefs()
  if (!prefs.dueRemindersEnabled) {
    logger.info('Due-date reminders skipped — disabled in notification settings')
    return { sent: 0, invoices: 0 }
  }
  const fromD = new Date()
  fromD.setHours(0, 0, 0, 0)
  const toD = new Date(fromD.getTime() + WINDOW_DAYS * 86_400_000)
  const from = fromD.toISOString()
  const to = toD.toISOString()

  const rows = await db
    .select({
      customer: schema.salesInvoices.customer,
      number: schema.salesInvoices.number,
      grandTotal: schema.salesInvoices.grandTotal,
      paymentStatus: schema.salesInvoices.paymentStatus,
      status: schema.salesInvoices.status,
      dueDate: schema.salesInvoices.dueDate,
      email: schema.customers.email,
    })
    .from(schema.salesInvoices)
    .leftJoin(schema.customers, sql`${schema.customers.name} = ${schema.salesInvoices.customer}`)
    .where(
      and(
        ne(schema.salesInvoices.paymentStatus, 'paid'),
        sql`${schema.salesInvoices.status} is distinct from 'cancelled'`,
        sql`${schema.salesInvoices.status} is distinct from 'refunded'`,
        gte(schema.salesInvoices.dueDate, from),
        lte(schema.salesInvoices.dueDate, to),
      ),
    )

  // What is ACTUALLY still owed per invoice (Phase 5.2): grandTotal minus
  // what payments already collected — a booking advance credited at
  // conversion or a partial payment shrinks the reminder to the real figure,
  // so we never ask a customer for money they have already paid.
  const paidByInvoice = await collectedByInvoice()
  const byCustomer = new Map<string, { email: string; invoices: Array<{ number: string; due: number; dueDate: string | null }> }>()
  for (const r of rows) {
    if (!r.customer || !r.email) continue
    const due = invoiceOutstanding(
      { grandTotal: r.grandTotal, paymentStatus: r.paymentStatus, status: r.status, number: r.number },
      paidByInvoice,
    )
    if (due <= 0) continue // fully collected already — nothing to remind about
    const entry = byCustomer.get(r.customer) ?? { email: r.email, invoices: [] }
    entry.invoices.push({ number: r.number, due, dueDate: r.dueDate })
    byCustomer.set(r.customer, entry)
  }

  let sent = 0
  for (const [customer, entry] of byCustomer) {
    const total = entry.invoices.reduce((a, i) => a + i.due, 0)
    const money = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
    const lines = entry.invoices
      .map((i) => `<li>${escapeHtml(i.number)} — ${escapeHtml(money(i.due))} — due ${i.dueDate ? new Date(i.dueDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : 'soon'}</li>`)
      .join('')
    const ok = await sendEmail({
      to: entry.email,
      subject: `Payment reminder: ${entry.invoices.length} invoice${entry.invoices.length === 1 ? '' : 's'} due by ${toD.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color:#d97706;">⏰ Friendly Payment Reminder</h2>
          <p style="color:#666;">Hi ${escapeHtml(customer)},</p>
          <p style="color:#666;">A gentle reminder that the following invoice(s) are due within the next ${WINDOW_DAYS} days:</p>
          <ul style="color:#374151;">${lines}</ul>
          <p style="color:#111;"><b>Total due: ${escapeHtml(money(total))}</b></p>
          <p style="color:#666;">Please arrange payment at your earliest convenience to avoid any late fees.</p>
          <p style="color: #999; font-size: 12px;">Opal Line ERP — Automated Reminder</p>
        </div>
      `,
    })
    if (ok) sent += 1
  }
  logger.info({ customers: byCustomer.size, sent }, 'Due-date reminders run complete')
  return { sent, invoices: rows.length }
}

const scheduler = createScheduler({
  label: 'Due-date reminders',
  msUntilNextRun,
  run: () => runDueReminders(),
})

export function startDueReminders(): void {
  if (scheduler.armed) return
  scheduler.schedule()
  logger.info({ next: new Date(Date.now() + msUntilNextRun()).toISOString() }, 'Due reminders scheduler started (daily 09:15)')
}

export function stopDueReminders(): void {
  scheduler.stop()
}
