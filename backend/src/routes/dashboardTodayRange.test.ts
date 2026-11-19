import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

// "Today" / "This Week" were reported as showing no data while month/year
// worked. The range resolver is covered by DB-less tests, but only a scratch
// database proves the SQL side: invoices booked at the current moment and at
// the IST day boundaries (00:30 and 23:30) must reach every range-driven
// widget — KPI cards, the sales chart, payment status and the financial
// analytics section — while rows just before the half-open window must not.
//
// Expected totals come from an independent JS Date oracle (simple `[from, to)`
// comparison) rather than from the endpoint code, so a disagreement between
// Postgres string/timestamp comparison and JS semantics fails the test.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied — the same contract as dashboardBuckets.test.ts. The URL
// is copied into DATABASE_URL before the db client is imported, every inserted
// row carries a unique marker, and everything is deleted again in `finally`.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

const pad = (n: number) => String(n).padStart(2, '0')

/** Local-naive timestamp in the format the app writes ('YYYY-MM-DDTHH:MM:SS'). */
const localNaive = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

/** Parse a formatted money string like '₹1,500' back to a number. */
const money = (v: string) => Number(v.replace(/[^0-9.-]/g, ''))

test(
  'today and this week include day-boundary invoices and exclude rows before the window',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { db, schema, getRawClient } = await import('../db/client')
    const { resolveDashboardRange } = await import('../lib/dashboardRange')
    const { dashboardRouter } = await import('./dashboard')
    assert.ok(db, 'test database client did not initialize')

    const todayRes = resolveDashboardRange({ period: 'today' })
    const weekRes = resolveDashboardRange({ period: 'week' })
    assert.ok(todayRes.ok, 'today range must resolve')
    assert.ok(weekRes.ok, 'week range must resolve')
    if (!todayRes.ok || !weekRes.ok) return
    const todayRange = todayRes.range
    const weekRange = weekRes.range
    const todayFrom = new Date(todayRange.from)
    const weekFrom = new Date(weekRange.from)

    const marker = `today-range-${Date.now()}`
    const invoices = [
      // Booked right now.
      { id: `${marker}-now`, number: `${marker}-NOW`, date: localNaive(new Date()), grandTotal: 1000, status: 'paid', paymentStatus: 'paid' },
      // First and last minutes of the IST day.
      { id: `${marker}-early`, number: `${marker}-EARLY`, date: localNaive(new Date(todayFrom.getTime() + 30 * 60_000)), grandTotal: 200, status: 'paid', paymentStatus: 'paid' },
      { id: `${marker}-late`, number: `${marker}-LATE`, date: localNaive(new Date(todayFrom.getTime() + 23.5 * 3600_000)), grandTotal: 300, status: 'paid', paymentStatus: 'paid' },
      // One second before today, and one second before the week: excluded from
      // today either way, excluded from the week by definition.
      { id: `${marker}-prev-day`, number: `${marker}-PREV-DAY`, date: localNaive(new Date(todayFrom.getTime() - 1000)), grandTotal: 9000, status: 'paid', paymentStatus: 'paid' },
      { id: `${marker}-prev-week`, number: `${marker}-PREV-WEEK`, date: localNaive(new Date(weekFrom.getTime() - 1000)), grandTotal: 90000, status: 'paid', paymentStatus: 'paid' },
    ]
    // The chart's order count comes from sales_orders, not from invoices, so the
    // fixture needs the order rows those invoices were raised from. `invoice`
    // is set so the ledger does not also add their value as uninvoiced revenue.
    const orders = invoices.map((inv, i) => ({
      id: `${marker}-order-${i}`,
      internalId: `${marker}-SO-${i}`,
      status: 'confirmed',
      date: inv.date,
      value: inv.grandTotal,
      invoice: inv.number,
      items: 1,
    }))
    const expenses = [
      { id: `${marker}-rent`, category: 'Rent', description: marker, amount: 500, date: localNaive(new Date()), status: 'paid' },
      { id: `${marker}-staff`, category: 'Staff', description: marker, amount: 700, date: localNaive(new Date(weekFrom.getTime() - 3600_000)), status: 'paid' },
    ]

    // Independent oracle: half-open `[from, to)` over JS Dates.
    const inWindow = <T extends { date: string }>(rows: T[], from: string, to: string) => {
      const a = new Date(from).getTime()
      const b = new Date(to).getTime()
      return rows.filter((r) => {
        const t = new Date(r.date).getTime()
        return t >= a && t < b
      })
    }
    const sum = (rows: { grandTotal?: number; amount?: number }[]) =>
      rows.reduce((acc, r) => acc + (r.grandTotal ?? r.amount ?? 0), 0)

    let server: Server | null = null
    try {
      await db!.insert(schema.salesInvoices).values(invoices)
      await db!.insert(schema.salesOrders).values(orders)
      await db!.insert(schema.expenses).values(expenses)

      // The dashboard router without the auth layer, so the test hits the real
      // handlers the page calls.
      const app = express()
      app.use(dashboardRouter)
      server = app.listen(0)
      const port = Number((server.address() as { port: number }).port)
      const get = async (path: string) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`)
        assert.equal(res.status, 200, `${path} responded ${res.status}`)
        return (await res.json()) as any
      }

      for (const range of [todayRange, weekRange]) {
        const expected = inWindow(invoices, range.from, range.to)
        const total = sum(expected)
        assert.ok(expected.length >= 3, `${range.label}: the three in-window invoices must be counted`)

        // KPI cards (Sales tile).
        const kpis = await get(`/dashboard/kpis?period=${range.key}`)
        const salesKpi = kpis.find((k: { key: string }) => k.key === 'sales')
        assert.ok(salesKpi, `${range.label}: sales KPI missing`)
        assert.equal(money(salesKpi.value), total, `${range.label}: sales KPI total`)

        // Sales chart: buckets must sum to the same total and count.
        const chart = await get(`/dashboard/sales-overview?period=${range.key}`)
        const chartRevenue = Math.round(chart.reduce((a: number, p: { revenue: number }) => a + Number(p.revenue ?? 0), 0))
        const chartOrders = chart.reduce((a: number, p: { orders: number }) => a + Number(p.orders ?? 0), 0)
        assert.equal(chartRevenue, total, `${range.label}: chart revenue must match`)
        assert.equal(chartOrders, expected.length, `${range.label}: chart order count must match`)

        if (range.key === 'today') {
          // The boundary invoices must land in their own hour buckets.
          const hourKey = (d: Date) =>
            `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00:00`
          const early = chart.find((p: { date: string }) => p.date === hourKey(new Date(todayFrom.getTime() + 30 * 60_000)))
          const late = chart.find((p: { date: string }) => p.date === hourKey(new Date(todayFrom.getTime() + 23.5 * 3600_000)))
          assert.equal(early?.revenue, 200, 'the 00:30 invoice must appear in its hour bucket')
          assert.equal(late?.revenue, 300, 'the 23:30 invoice must appear in its hour bucket')
        }

        // Payment status donut.
        const payment = await get(`/dashboard/payment-status?period=${range.key}`)
        assert.equal(Math.round(payment.total), total, `${range.label}: payment status total`)
        const paid = payment.segments.find((s: { status: string }) => s.status === 'paid')
        assert.equal(Math.round(paid?.value ?? -1), total, `${range.label}: paid segment`)

        // Financial analytics: net revenue, income/expense and top expense.
        const financial = await get(`/dashboard/financial?period=${range.key}`)
        assert.equal(Math.round(financial.netRevenue), total, `${range.label}: net revenue`)
        assert.equal(Math.round(financial.income), total, `${range.label}: income`)
        assert.equal(financial.invoiceCount, expected.length, `${range.label}: invoice count`)
        const expectedExpenses = sum(inWindow(expenses, range.from, range.to))
        assert.equal(Math.round(financial.expense), Math.round(expectedExpenses), `${range.label}: expense total`)
        assert.equal(
          financial.topExpense?.category ?? null,
          expectedExpenses > 0 ? 'Rent' : null,
          `${range.label}: top expense category`,
        )
      }
    } finally {
      const { inArray } = await import('drizzle-orm')
      await db!.delete(schema.salesInvoices).where(inArray(schema.salesInvoices.id, invoices.map((i) => i.id)))
      await db!.delete(schema.salesOrders).where(inArray(schema.salesOrders.id, orders.map((o) => o.id)))
      await db!.delete(schema.expenses).where(inArray(schema.expenses.id, expenses.map((e) => e.id)))
      server?.close()
      await getRawClient()?.end({ timeout: 5 })
    }
  },
)
