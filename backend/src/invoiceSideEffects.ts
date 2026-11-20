import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from './db/client'
import * as s from './db/schema'
import { logger } from './logger'
import { createScheduler } from './lib/scheduler'

/**
 * Post-commit side effects for a raised sales invoice — and their DURABLE
 * recovery (Phase 4 hardening).
 *
 * The invoice transaction deliberately never runs external work (it would hold
 * product/order locks across network calls), so loyalty, the accounting
 * journals and the e-invoice IRN happen AFTER commit. A crash or gateway
 * failure in that window used to lose them forever: the invoice was committed,
 * so no retry of the conversion would ever re-run them.
 *
 * The fix uses the committed invoice itself as the durable record — no new
 * outbox table. Every effect is IDEMPOTENT by construction:
 *
 *   • journal        `upsertJournalEntry` keyed (reference_type, reference_id)
 *                    — re-posting rewrites the SAME entry, never a second one;
 *   • loyalty        `earnForInvoice` keyed `external_ref = invoice:<id>` with
 *                    a partial unique index — a repeat posts nothing;
 *   • e-invoice IRN  generation is skipped when the invoice already carries an
 *                    IRN (the gateway is only ever called for a missing one);
 *   • advance journal `postPaymentJournal` upserts keyed (payment, id) — and
 *                    only the booking's single Advance row is considered.
 *
 * `ensureInvoiceSideEffects` therefore runs the MISSING effects for one
 * invoice and is safe to call any number of times: immediately after the
 * commit (best effort), from the periodic recovery sweep, or by hand. The
 * sweep retries the last `RECOVERY_WINDOW_HOURS`, so an effect that failed
 * after commit is repaired within one interval instead of never.
 *
 * `OPAL_SIDEEFFECT_FAIL` (comma-separated effect names) makes a named effect
 * throw BEFORE it runs — the failure-injection seam the tests use to simulate
 * an external outage after a successful commit (same convention as
 * `OPAL_DISABLE_SHOPIFY_PUSH`).
 */

export type SideEffectName = 'journal' | 'loyalty' | 'einvoice' | 'advance-journal'
export type SideEffectOutcome = 'done' | 'failed' | 'skipped'

/** How far back the recovery sweep looks for invoices to repair. */
const RECOVERY_WINDOW_HOURS = 48
const SWEEP_INTERVAL_MS = 15 * 60 * 1000

function injectedFailure(name: SideEffectName): boolean {
  const list = (process.env.OPAL_SIDEEFFECT_FAIL ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
  return list.includes(name)
}

async function attempt(name: SideEffectName, run: () => Promise<void>): Promise<SideEffectOutcome> {
  try {
    if (injectedFailure(name)) throw new Error(`injected ${name} failure (test seam)`)
    await run()
    return 'done'
  } catch (err) {
    // One effect failing never blocks the others; the recovery sweep retries
    // whatever is still missing on its next pass.
    logger.error({ err, effect: name }, 'invoice side effect failed — recovery will retry it')
    return 'failed'
  }
}

async function hasJournal(referenceType: string, referenceId: string): Promise<boolean> {
  if (!db) return true
  const [row] = await db
    .select({ id: s.journalEntries.id })
    .from(s.journalEntries)
    .where(and(eq(s.journalEntries.referenceType, referenceType), eq(s.journalEntries.referenceId, referenceId)))
    .limit(1)
  return Boolean(row)
}

export interface EnsureSideEffectsResult {
  /** Effects that were missing and were attempted. */
  ran: SideEffectName[]
  /** Effects that were attempted and failed (the sweep will retry them). */
  failed: SideEffectName[]
}

/**
 * Run whichever side effects this committed invoice is MISSING. Idempotent:
 * calling it twice lands each effect exactly once, and a conversion retry
 * (which never raises a second invoice) can safely call it again.
 */
export async function ensureInvoiceSideEffects(
  invoiceId: string,
  opts: { actor?: string | null } = {},
): Promise<EnsureSideEffectsResult> {
  const ran: SideEffectName[] = []
  const failed: SideEffectName[] = []
  if (!db) return { ran, failed }
  const [inv] = await db.select().from(s.salesInvoices).where(eq(s.salesInvoices.id, invoiceId)).limit(1)
  if (!inv) return { ran, failed }

  const status = String(inv.status ?? '').toLowerCase()
  const active = status !== 'cancelled' && status !== 'refunded' && status !== 'draft'
  const actor = opts.actor ?? null

  // 1. Sales-invoice journal (only active, non-trivial invoices have one —
  //    the posting function itself removes a journal for voided/zero rows).
  if (active && Number(inv.grandTotal ?? 0) > 0 && !(await hasJournal('invoice', invoiceId))) {
    ran.push('journal')
    const out = await attempt('journal', async () => {
      const { postSalesInvoiceJournal } = await import('./accounting/postings')
      await postSalesInvoiceJournal(invoiceId, actor)
    })
    if (out === 'failed') failed.push('journal')
  }

  // 2. Loyalty award (idempotent per invoice via its external_ref).
  if (active && Number(inv.grandTotal ?? 0) > 0) {
    const [earned] = await db
      .select({ id: s.loyaltyTransactions.id })
      .from(s.loyaltyTransactions)
      .where(and(eq(s.loyaltyTransactions.externalRef, `invoice:${invoiceId}`), eq(s.loyaltyTransactions.type, 'earn')))
      .limit(1)
    if (!earned) {
      ran.push('loyalty')
      const out = await attempt('loyalty', async () => {
        const { earnForInvoice } = await import('./loyalty')
        await earnForInvoice({
          id: inv.id,
          number: String(inv.number ?? ''),
          customer: String(inv.customer ?? ''),
          customerEmail: String(inv.customerEmail ?? ''),
          customerPhone: String(inv.customerPhone ?? ''),
          grandTotal: Number(inv.grandTotal ?? 0),
          status: String(inv.status ?? 'issued'),
          shopifyOrder: inv.shopifyOrder ?? null,
        })
      })
      if (out === 'failed') failed.push('loyalty')
    }
  }

  // 3. E-invoice IRN — only in automatic mode, only while the invoice has
  //    none: a recovery retry can never mint a second IRN.
  if (active && !inv.irn && (await eInvoiceMode()) === 'automatic') {
    ran.push('einvoice')
    const out = await attempt('einvoice', async () => {
      const { generateEInvoiceForInvoice } = await import('./einvoice')
      const result = await generateEInvoiceForInvoice(invoiceId)
      if (!result.ok) throw new Error(result.error)
    })
    if (out === 'failed') failed.push('einvoice')
  }

  // 4. The booking advance's payment journals — advances may consist of
  //    SEVERAL collection rows (initial + additional collections, Phase 5.1),
  //    each a separate cash event needing its own journal. The advance rows
  //    themselves are written inside the conversion transaction; only their
  //    journals are post-commit, and each is an upsert keyed by payment id,
  //    so a re-run never duplicates one. Refund rows are booking-scoped and
  //    never invoice-pointed, so they are not part of the invoice's journals.
  const advances = await db
    .select({ id: s.payments.id })
    .from(s.payments)
    .where(
      and(
        eq(s.payments.invoice, String(inv.number ?? '')),
        eq(s.payments.method, 'Advance'),
        eq(s.payments.gateway, 'booking'),
      ),
    )
  for (const advance of advances) {
    if (await hasJournal('payment', advance.id)) continue
    ran.push('advance-journal')
    const out = await attempt('advance-journal', async () => {
      const { postPaymentJournal } = await import('./accounting/postings')
      await postPaymentJournal(advance.id, actor)
    })
    if (out === 'failed') failed.push('advance-journal')
  }

  return { ran, failed }
}

async function eInvoiceMode(): Promise<string> {
  try {
    const { resolveEInvoiceMode } = await import('./einvoice')
    return await resolveEInvoiceMode()
  } catch {
    return 'off'
  }
}

/**
 * Recovery sweep: re-ensure the side effects of every recent ACTIVE invoice.
 * The committed invoice row is the durable record — nothing else is needed to
 * re-derive a missing journal, award or IRN, and because each effect is
 * idempotent, a sweep that runs over already-complete invoices writes
 * nothing.
 */
export async function runSideEffectRecovery(): Promise<{ scanned: number; repaired: number; failed: number }> {
  if (!db) return { scanned: 0, repaired: 0, failed: 0 }
  const cutoff = new Date(Date.now() - RECOVERY_WINDOW_HOURS * 3_600_000).toISOString()
  const rows = await db
    .select({ id: s.salesInvoices.id })
    .from(s.salesInvoices)
    .where(
      and(
        gte(s.salesInvoices.date, cutoff),
        sql`coalesce(${s.salesInvoices.status}, '') not in ('cancelled', 'refunded', 'draft')`,
      ),
    )
    .limit(500)

  let repaired = 0
  let failed = 0
  for (const row of rows) {
    const result = await ensureInvoiceSideEffects(row.id)
    if (result.failed.length > 0) failed += 1
    else if (result.ran.length > 0) repaired += 1
  }
  if (repaired > 0 || failed > 0) {
    logger.info({ scanned: rows.length, repaired, failed }, 'invoice side-effect recovery run')
  }
  return { scanned: rows.length, repaired, failed }
}

const scheduler = createScheduler({
  label: 'Invoice side-effect recovery',
  msUntilNextRun: () => SWEEP_INTERVAL_MS,
  run: () => runSideEffectRecovery(),
  // The sweep is a set of idempotent repairs; letting a slow pass overlap the
  // next tick is harmless, but rearm-then-run keeps the interval honest.
  mode: 'rearm-then-run',
})

/** Arm the periodic recovery (called at boot, next to the other schedulers). */
export function startSideEffectRecovery(): void {
  if (scheduler.armed) return
  scheduler.schedule()
  logger.info({ intervalMs: SWEEP_INTERVAL_MS, windowHours: RECOVERY_WINDOW_HOURS }, 'invoice side-effect recovery started')
}

export function stopSideEffectRecovery(): void {
  scheduler.stop()
}
