import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

// Gross Profit: the KPI must be based only on invoices that carry the app's
// cost basis (silver_value + making_charge) and must disclose that basis as
// "based on X of Y invoices". Before the fix an invoice imported with a NULL
// basis contributed its whole grand_total to profit (a 100% margin), and the
// caption just said "vs previous period" with no hint of coverage.
// The analytics margin card pairs costed revenue with costed cost for the
// same reason: it never divides the full period's sales by a subset of costs.
//
// Assertions are deltas against baselines fetched before the marker invoices
// are inserted, so leftovers from an earlier crashed run cannot make the test
// lie. A costed baseline invoice is inserted FIRST: on an empty scratch DB the
// KPI reads "N/A" (no cost basis exists), and comparing the new ₹1,050 against
// a non-numeric baseline would be meaningless. The analytics margin is asserted
// stable when an invoice without a basis arrives (the costed subset did not
// change) — an exact recompute would need the baseline sums and would duplicate
// the SQL under test.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied — the same contract as dashboardSecurity.test.ts.
// (Separate file on purpose: each test file runs in its own process, and a
// test that closes the pool in its finally would break a second test in the
// same file.)
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

const pad = (n: number) => String(n).padStart(2, '0')

const localNaive = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

const rupees = (v: string | undefined): number => {
  // KPI money strings carry paise now (₹1,48,382.44) and a Unicode minus for
  // negatives; parse the displayed amount, not just its digits. "N/A" is what
  // the KPI shows before any invoice carries a cost basis, and it means zero.
  const cleaned = (v ?? '').replace(/[₹,\s]/g, '').replace('−', '-')
  if (cleaned === '') return 0
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : 0
}

const basis = (label: string | null | undefined): { x: number; y: number } | null => {
  const m = /based on (\d+) of (\d+) invoices/.exec(label ?? '')
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null
}

test(
  'gross profit counts only costed invoices and says so in the KPI caption',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { db, schema, getRawClient } = await import('../db/client')
    const { dashboardRouter } = await import('./dashboard')
    assert.ok(db, 'test database client did not initialize')

    const marker = `gp-${Date.now()}`
    const baselineId = `${marker}-baseline` // basis present: gives the KPI a numeric starting value
    const costedId = `${marker}-costed` // basis present: profit 1200-100-50 = 1050
    const uncostedId = `${marker}-uncosted` // no basis: must add nothing to profit

    let server: Server | null = null
    try {
      const app = express()
      app.use(dashboardRouter)
      server = app.listen(0)
      const port = Number((server.address() as { port: number }).port)
      const get = async (path: string) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`)
        return { status: res.status, body: (await res.json()) as any }
      }
      const kpi = (body: unknown, key: string) =>
        (body as Array<{ key: string; label: string; value: string; deltaLabel: string | null }>).find((k) => k.key === key)
      const stat = (body: unknown, label: string) =>
        (body as Array<{ label: string; value: string }>).find((s) => s.label === label)

      const now = localNaive(new Date())
      await db!.insert(schema.salesInvoices).values({
        id: baselineId,
        number: `${marker}-BASELINE`,
        grandTotal: 500,
        silverValue: 100,
        makingCharge: 50,
        paymentStatus: 'paid',
        status: 'paid',
        date: now,
      })

      const baseK = await get('/dashboard/kpis?period=last30')
      assert.equal(baseK.status, 200)
      const baseA = await get('/dashboard/analytics?period=last30')
      assert.equal(baseA.status, 200)
      const baseProfit = rupees(kpi(baseK.body, 'grossProfit')?.value)
      const baseBasis = basis(kpi(baseK.body, 'grossProfit')?.deltaLabel)
      const baseInvoices = rupees(kpi(baseK.body, 'invoices')?.value)
      const baseMargin = stat(baseA.body, 'Gross Profit Margin')?.value

      await db!.insert(schema.salesInvoices).values({
        id: uncostedId,
        number: `${marker}-UNCOSTED`,
        grandTotal: 800,
        paymentStatus: 'paid',
        status: 'paid',
        date: now,
      })

      // An invoice without a cost basis changes nothing that is based on cost.
      const afterU = await get('/dashboard/kpis?period=last30')
      assert.equal(rupees(kpi(afterU.body, 'grossProfit')?.value), baseProfit, 'a NULL-basis invoice must not add its grand total to profit')
      const captionU = basis(kpi(afterU.body, 'grossProfit')?.deltaLabel)
      assert.equal(captionU?.x ?? 0, baseBasis?.x ?? 0, 'the costed-invoice count X does not move for a NULL-basis invoice')
      if (captionU) assert.equal(captionU.y, baseInvoices + 1, 'the invoice total Y in the caption still tracks every invoice')
      assert.equal(rupees(kpi(afterU.body, 'invoices')?.value), baseInvoices + 1, 'the invoice itself still counts for the Invoices KPI')
      const afterMarginU = await get('/dashboard/analytics?period=last30')
      assert.equal(
        stat(afterMarginU.body, 'Gross Profit Margin')?.value,
        baseMargin,
        'the margin card ignores invoices without a basis',
      )

      await db!.insert(schema.salesInvoices).values({
        id: costedId,
        number: `${marker}-COSTED`,
        grandTotal: 1200,
        silverValue: 100,
        makingCharge: 50,
        paymentStatus: 'paid',
        status: 'paid',
        date: now,
      })

      const afterC = await get('/dashboard/kpis?period=last30')
      assert.equal(afterC.status, 200)
      const gp = kpi(afterC.body, 'grossProfit')
      assert.ok(gp, 'the gross profit KPI is present')
      assert.equal(
        rupees(gp.value),
        baseProfit + 1050,
        'profit grows by grand_total minus silver minus making for the costed invoice only',
      )
      const caption = basis(gp.deltaLabel)
      assert.ok(caption, `caption reads "based on X of Y invoices", got: ${gp.deltaLabel}`)
      assert.equal(caption.x, (baseBasis?.x ?? 0) + 1, 'X counts the new costed invoice')
      assert.equal(caption.y, baseInvoices + 2, 'Y counts every invoice in the window')
      assert.ok(caption.x <= caption.y, 'basis never exceeds the invoice count')
    } finally {
      const { inArray } = await import('drizzle-orm')
      await db!.delete(schema.salesInvoices).where(inArray(schema.salesInvoices.id, [baselineId, costedId, uncostedId]))
      server?.close()
      await getRawClient()?.end({ timeout: 5 })
    }
  },
)
