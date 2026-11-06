// Loyalty engine regression tests.
//
// Runs the real engine against the REAL Postgres schema in a THROWAWAY
// scratch database (opal_line_loyalty_test), the same pattern as
// shopifyCustomers.test.ts. It skips when DATABASE_URL is unset and never
// touches the app database. Covered:
//   - points earned on an invoice, and only once (repeat call = no-op)
//   - duplicate webhook / concurrent award for the same invoice
//   - paid Shopify order with no invoice earns; duplicate delivery does not
//   - an order award is adopted (not duplicated) by its later invoice
//   - partial refund reverses proportionally, same refund twice reverses once
//   - a second partial refund that completes the total reverses the rest
//   - cancellation reverses the full award
//   - redemption cannot take a balance negative; concurrent redemptions stay
//     correct and the ledger still sums to the balance
//   - manual adjustment audit trail, and a negative edit below zero is refused
//   - points expiry (FIFO), idempotent on re-run
//   - dashboard totals come from the ledger, reconciliation finds no drift
import 'dotenv/config'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import postgres from 'postgres'

const baseDbUrl = process.env.DATABASE_URL?.trim() ?? ''
const TEST_DB = 'opal_line_loyalty_test'

function scratchUrl(base: string): string {
  const url = new URL(base)
  url.pathname = `/${TEST_DB}`
  return url.toString()
}

test(
  'loyalty engine (real schema, scratch DB)',
  { skip: baseDbUrl ? false : 'DATABASE_URL is not set — needs a local PostgreSQL to create the scratch database' },
  async () => {
    const admin = postgres(baseDbUrl, { max: 1 })
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
      await admin.unsafe(`CREATE DATABASE ${TEST_DB}`)
    } finally {
      await admin.end({ timeout: 5 })
    }

    process.env.DATABASE_URL = scratchUrl(baseDbUrl)
    const marker = `lt-${Date.now().toString(36)}`
    let raw: postgres.Sql | null = null

    try {
      const { bootstrapDatabase } = await import('./db/bootstrap')
      const boot = await bootstrapDatabase()
      assert.equal(boot.tablesCreated, true, 'fresh scratch schema must be created')

      const { getRawClient } = await import('./db/client')
      raw = getRawClient()
      assert.ok(raw, 'scratch database must be connected')

      const loyalty = await import('./loyalty')
      loyalty.invalidateConfig()

      // ── Fixtures ───────────────────────────────────────────────────────
      const customerA = `C-${marker}-A`
      const customerB = `C-${marker}-B`
      const shopifyB = '9000000001'
      await raw.unsafe(
        `INSERT INTO customers (id, name, email, phone, status) VALUES ($1, $2, $3, $4, 'active')`,
        [customerA, 'Asha Rao', `${marker}.asha@example.com`, '9876543210'],
      )
      // Shopify-mapped customers can legitimately carry a blank name.
      await raw.unsafe(
        `INSERT INTO customers (id, name, email, phone, shopify_id, status) VALUES ($1, '', '', '', $2, 'active')`,
        [customerB, shopifyB],
      )

      const insertInvoice = async (id: string, number: string, customer: string, customerId: string, total: number, shopifyOrder: string | null = null) => {
        await raw!.unsafe(
          `INSERT INTO sales_invoices (id, number, customer, customer_email, grand_total, status, shopify_order, date)
           VALUES ($1, $2, $3, '', $4, 'issued', $5, now())`,
          [id, number, customer, total, shopifyOrder],
        )
        return { id, number, customer, customerId, grandTotal: total, status: 'issued', shopifyOrder }
      }

      const balanceOf = async (customerId: string) => {
        const rows = await raw!.unsafe<{ b: string }[]>(`SELECT coalesce(sum(points), 0)::numeric AS b FROM loyalty_transactions WHERE customer_id = $1`, [customerId])
        return Number(rows[0]?.b ?? 0)
      }
      const countOf = async (customerId: string, type: string) => {
        const rows = await raw!.unsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM loyalty_transactions WHERE customer_id = $1 AND type = $2`,
          [customerId, type],
        )
        return Number(rows[0]?.n ?? 0)
      }

      // ── 1. Earn on an invoice, exactly once ────────────────────────────
      const invoiceA = await insertInvoice(`INV-${marker}-A`, `SI-${marker}-A`, 'Asha Rao', customerA, 10_000)
      const firstEarn = await loyalty.earnForInvoice(invoiceA)
      assert.equal(firstEarn?.points, 100, '₹10,000 at 1 point per ₹100 earns 100 points')
      assert.equal(await balanceOf(customerA), 100)

      const repeatEarn = await loyalty.earnForInvoice(invoiceA)
      assert.equal(repeatEarn, null, 'the repeat call awards nothing')
      assert.equal(await countOf(customerA, 'earn'), 1, 'a repeat call posts nothing new')
      assert.equal(await balanceOf(customerA), 100)

      // ── 2. Concurrent duplicate delivery of the same invoice ───────────
      const invoiceA2 = await insertInvoice(`INV-${marker}-A2`, `SI-${marker}-A2`, 'Asha Rao', customerA, 5_000)
      await Promise.all([loyalty.earnForInvoice(invoiceA2), loyalty.earnForInvoice(invoiceA2), loyalty.earnForInvoice(invoiceA2)])
      assert.equal(await countOf(customerA, 'earn'), 2, 'concurrent duplicates still post one row')
      assert.equal(await balanceOf(customerA), 150)

      // ── 3. Paid Shopify order without an invoice earns ─────────────────
      const orderEarn = await loyalty.earnForShopifyOrder({
        name: '#5002',
        total: 3_000,
        financialStatus: 'paid',
        customerShopifyId: shopifyB,
      })
      assert.equal(orderEarn?.points, 30)
      assert.equal(await balanceOf(customerB), 30, 'blank-name Shopify customer still earns (resolved by Shopify id)')

      const orderAgain = await loyalty.earnForShopifyOrder({ name: '#5002', total: 3_000, financialStatus: 'paid', customerShopifyId: shopifyB })
      assert.equal(orderAgain, null, 'a retried order webhook awards nothing')
      assert.equal(await countOf(customerB, 'earn'), 1)

      // Unpaid and cancelled orders earn nothing.
      assert.equal(await loyalty.earnForShopifyOrder({ name: '#5003', total: 9_000, financialStatus: 'pending', customerShopifyId: shopifyB }), null)
      assert.equal(
        await loyalty.earnForShopifyOrder({ name: '#5004', total: 9_000, financialStatus: 'paid', cancelledAt: new Date().toISOString(), customerShopifyId: shopifyB }),
        null,
      )

      // ── 4. The later invoice adopts the order award (no double count) ──
      const invoiceC = await insertInvoice(`INV-${marker}-C`, `SI-${marker}-C`, '', customerB, 3_000, '#5002')
      const claim = await loyalty.earnForInvoice(invoiceC)
      assert.equal(claim?.points, 30, 'the order award is claimed by its invoice')
      assert.equal(await countOf(customerB, 'earn'), 1, 'no second award for the same order')
      assert.equal(await balanceOf(customerB), 30)

      // ── 5. Partial refunds reverse proportionally, once ────────────────
      const partial = await loyalty.reverseEarnedForInvoice({
        id: invoiceA.id,
        number: invoiceA.number,
        value: 4_000,
        reason: 'Partial refund',
        reference: 'refund:7001',
      })
      assert.equal(partial?.points, -40, '₹4,000 of a ₹10,000 award reverses 40 of 100 points')
      assert.equal(await balanceOf(customerA), 110)

      const sameRefund = await loyalty.reverseEarnedForInvoice({
        id: invoiceA.id,
        number: invoiceA.number,
        value: 4_000,
        reason: 'Partial refund retried',
        reference: 'refund:7001',
      })
      assert.equal(sameRefund, null, 'the same refund id reverses nothing more')
      assert.equal(await balanceOf(customerA), 110)

      // ── 6. A second partial refund that completes the total ────────────
      const secondPartial = await loyalty.reverseEarnedForInvoice({
        id: invoiceA.id,
        number: invoiceA.number,
        value: 6_000,
        reason: 'Remaining refund',
        reference: 'refund:7002',
      })
      assert.equal(secondPartial?.points, -60, 'cumulative refunds reach the full award')
      assert.equal(await balanceOf(customerA), 50)
      const refundedA = await raw.unsafe<{ p: string }[]>(
        `SELECT coalesce(sum(points), 0)::numeric AS p FROM loyalty_transactions WHERE customer_id = $1 AND type = 'refund'`,
        [customerA],
      )
      assert.equal(Number(refundedA[0]?.p ?? 0), -100, 'exactly the award was reversed')

      // ── 7. Cancellation reverses the whole award ───────────────────────
      const invoiceD = await insertInvoice(`INV-${marker}-D`, `SI-${marker}-D`, 'Asha Rao', customerA, 2_000)
      await loyalty.earnForInvoice(invoiceD)
      assert.equal(await balanceOf(customerA), 70)
      const cancelled = await loyalty.reverseEarnedForInvoice({ id: invoiceD.id, number: invoiceD.number, reason: 'Invoice cancelled' })
      assert.equal(cancelled?.points, -20, 'cancellation reverses the full award')
      assert.equal(await balanceOf(customerA), 50)

      // ── 8. Manual adjustment keeps an audit trail ──────────────────────
      await loyalty.adjust(customerA, 15, 'Festive bonus', 'tester')
      const adjustRow = await raw.unsafe<{ points: string; note: string; created_by: string }[]>(
        `SELECT points, note, created_by FROM loyalty_transactions WHERE customer_id = $1 AND note = 'Festive bonus'`,
        [customerA],
      )
      assert.equal(Number(adjustRow[0]?.points ?? 0), 15)
      assert.equal(String(adjustRow[0]?.created_by ?? ''), 'tester', 'the acting user is recorded')
      assert.equal(await balanceOf(customerA), 65)

      await assert.rejects(
        () => loyalty.adjust(customerA, -1_000, 'Over-deduct'),
        /Insufficient points/i,
        'a manual adjustment cannot take the balance below zero',
      )
      assert.equal(await balanceOf(customerA), 65, 'the refused adjustment posted nothing')
      await loyalty.adjust(customerA, -15, 'Reversal of bonus', 'tester')
      assert.equal(await balanceOf(customerA), 50)

      // ── 9. Redemption guards ───────────────────────────────────────────
      const tooMuch = await loyalty.redeem(customerB, 10_000)
      assert.equal(tooMuch.ok, false, 'redeeming more than the balance is refused')
      assert.equal(await balanceOf(customerB), 30)

      const okRedeem = await loyalty.redeem(customerB, 10)
      assert.equal(okRedeem.ok, true)
      if (okRedeem.ok) assert.equal(okRedeem.balanceAfter, 20)
      assert.equal(await balanceOf(customerB), 20)

      // ── 10. Concurrency: parallel redemptions never overdraw ───────────
      await loyalty.adjust(customerA, 500, 'Bulk credit')
      assert.equal(await balanceOf(customerA), 550)
      const attempts = await Promise.all(Array.from({ length: 20 }, () => loyalty.redeem(customerA, 50)))
      const succeeded = attempts.filter((r) => r.ok).length
      const remainingA = await balanceOf(customerA)
      assert.equal(succeeded, 11, '11 of 20 redemptions of 50 fit inside 550 points')
      assert.equal(remainingA, 0, 'the balance lands exactly on zero')
      assert.ok(remainingA >= 0, 'concurrent redemptions never overdraw')

      // ── 11. Expiry is FIFO and idempotent ──────────────────────────────
      const invoiceE = await insertInvoice(`INV-${marker}-E`, `SI-${marker}-E`, 'Asha Rao', customerA, 3_000)
      await loyalty.earnForInvoice(invoiceE)
      assert.equal(await balanceOf(customerA), 30)
      await raw.unsafe(
        `UPDATE loyalty_transactions SET expires_at = now() - interval '1 day' WHERE invoice_id = $1`,
        [invoiceE.id],
      )
      const expiryRun = await loyalty.expirePoints({ customerId: customerA })
      assert.equal(expiryRun.expiredPoints, 30, 'the expired lot is written off')
      assert.equal(await balanceOf(customerA), 0)
      assert.equal(await countOf(customerA, 'expire'), 1)

      const expiryAgain = await loyalty.expirePoints({ customerId: customerA })
      assert.equal(expiryAgain.expiredPoints, 0, 're-running expiry posts nothing new')
      assert.equal(await countOf(customerA, 'expire'), 1)

      // ── 12. Shopify refund webhook: payload → proportion of the award ──
      const shopifyOrderId = 9_900_001
      await raw.unsafe(
        `INSERT INTO sales_orders (id, shopify_id, customer, value, payment, status, date)
         VALUES ($1, '#6001', '', 5000, 'paid', 'imported', now())`,
        [`shopify-${shopifyOrderId}`],
      )
      const invoiceF = await insertInvoice(`INV-${marker}-F`, `SI-${marker}-F`, '', customerB, 5_000, '#6001')
      await loyalty.earnForInvoice(invoiceF)
      const balanceBeforeRefund = await balanceOf(customerB)
      assert.equal(balanceBeforeRefund, 70, 'invoice for the Shopify order earned 50 points')

      const { handleShopifyRefund, handleShopifyOrderCancelled, refundValueFromPayload } = await import('./shopifyLoyalty')
      assert.equal(
        refundValueFromPayload({ refund_line_items: [{ subtotal: '1200.50' }, { subtotal: '799.50' }] }),
        2_000,
        'refund value is the sum of line subtotals',
      )
      assert.equal(
        refundValueFromPayload({ transactions: [{ amount: '500', kind: 'refund' }] }),
        500,
        'refund value falls back to refund transactions',
      )

      const firstRefund = await handleShopifyRefund({
        id: 8_001,
        order_id: shopifyOrderId,
        refund_line_items: [{ subtotal: '2000' }],
      })
      assert.equal(firstRefund.reversed, 20, '₹2,000 of a ₹5,000 order reverses 20 of 50 points')
      assert.equal(await balanceOf(customerB), 50)

      const duplicateRefund = await handleShopifyRefund({
        id: 8_001,
        order_id: shopifyOrderId,
        refund_line_items: [{ subtotal: '2000' }],
      })
      assert.equal(duplicateRefund.reversed, 0, 'a retried refund delivery reverses nothing')
      assert.equal(await balanceOf(customerB), 50)

      const secondRefund = await handleShopifyRefund({
        id: 8_002,
        order_id: shopifyOrderId,
        refund_line_items: [{ subtotal: '3000' }],
      })
      assert.equal(secondRefund.reversed, 30, 'the second partial refund completes the reversal')
      assert.equal(await balanceOf(customerB), 20, 'only the order award was reversed')

      const cancelAfterRefund = await handleShopifyOrderCancelled('#6001')
      assert.equal(cancelAfterRefund.reversed, 0, 'a cancelled order with a fully reversed award owes nothing')

      // ── 13. Totals come from the ledger, reconciliation has no drift ───
      const summary = await loyalty.getSummary()
      const totals = await raw.unsafe(
        `SELECT
           coalesce(sum(points), 0)::numeric AS outstanding,
           coalesce(sum(case when type = 'earn' then points else 0 end), 0)::numeric AS issued,
           coalesce(sum(case when type = 'redeem' then -points else 0 end), 0)::numeric AS redeemed,
           coalesce(sum(case when type = 'refund' then -points else 0 end), 0)::numeric AS refunded,
           coalesce(sum(case when type = 'expire' then -points else 0 end), 0)::numeric AS expired,
           count(*)::int AS movements,
           count(distinct customer_id)::int AS customers
         FROM loyalty_transactions`,
      )
      const t = totals[0] as Record<string, string | number>
      assert.equal(summary.pointsOutstanding, Number(t.outstanding))
      assert.equal(summary.pointsIssued, Number(t.issued))
      assert.equal(summary.pointsRedeemed, Number(t.redeemed))
      assert.equal(summary.pointsRefunded, Number(t.refunded))
      assert.equal(summary.pointsExpired, Number(t.expired))
      assert.equal(summary.transactions, Number(t.movements))
      assert.equal(summary.enrolledCustomers, Number(t.customers))

      const reconciled = await loyalty.reconcileLedger()
      assert.equal(reconciled.mismatches.length, 0, JSON.stringify(reconciled.mismatches))
      assert.ok(reconciled.checked >= 2)

      const listed = await loyalty.listCustomers({ query: 'Asha' })
      assert.equal(listed.customers.length, 1)
      assert.equal(listed.customers[0]?.balance, 0)
      assert.equal(listed.customers[0]?.tier, 'Bronze')

      const txPage = await loyalty.listTransactions({ types: ['refund'], limit: 10 })
      assert.ok(txPage.transactions.length >= 2)
      assert.ok(txPage.transactions.every((row) => row.type === 'refund'))

      // ── 14. Ledger rows carry provenance + unique refs ─────────────────
      const refs = await raw.unsafe(
        `SELECT external_ref, count(*)::int AS n FROM loyalty_transactions WHERE external_ref IS NOT NULL GROUP BY external_ref HAVING count(*) > 1`,
      )
      assert.equal(refs.length, 0, 'no business event posted twice')
    } finally {
      if (raw) await raw.end({ timeout: 5 }).catch(() => undefined)
    }
  },
)
