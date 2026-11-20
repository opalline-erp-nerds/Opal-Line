import 'dotenv/config'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import postgres from 'postgres'

// Customer dues over-collection (Phase 5.2), end to end against the REAL
// schema in a THROWAWAY scratch database (same pattern as bookings.test.ts,
// skipped when DATABASE_URL is unset). The rule under test everywhere:
//
//   outstanding per invoice = grandTotal − collectedAmount
//
// so a booking advance credited at conversion, or any earlier partial
// payment, reduces what the customer can be asked for — and the payment
// endpoint records exactly the cash applied, per invoice, with FIFO intact.

const baseDbUrl = process.env.DATABASE_URL?.trim() ?? ''
const TEST_DB = 'opal_line_dues_test'

function scratchUrl(base: string): string {
  const url = new URL(base)
  url.pathname = `/${TEST_DB}`
  return url.toString()
}

test(
  'dues: outstanding is grandTotal − collected — advances, partials and FIFO never over-collect',
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
    // Conversion fires a loyalty award; keep the scratch run out of it.
    process.env.LOYALTY_ENABLED = 'false'

    try {
      const { bootstrapDatabase } = await import('./db/bootstrap')
      const boot = await bootstrapDatabase()
      assert.equal(boot.tablesCreated, true, 'fresh scratch schema must be created')

      const { db, schema } = await import('./db/client')
      const { eq, inArray } = await import('drizzle-orm')
      // Imported AFTER the DATABASE_URL swap so the helper binds to the scratch db.
      const { collectedByInvoice, invoiceOutstanding } = await import('./outstanding')
      assert.ok(db, 'test database client did not initialize')

      const marker = `dues-${Date.now()}`
      const customer = `${marker} Buyer`
      const adminId = `${marker}-admin`
      const allInvoiceNumbers: string[] = []

      // The authoritative silver rate — conversion refuses to run without it.
      await db!.insert(schema.silverRates).values({
        id: `${marker}-rate`,
        purity: 92.5,
        rate: 62,
        previousRate: 60,
        updatedAt: new Date().toISOString(),
        change: 2,
        changePercent: 3.33,
        currency: 'INR',
        updatedBy: 'test',
        source: 'manual',
      })
      // The product the booking sells (hand-typed line resolves to it).
      const sku = `${marker}-SKU`
      await db!.insert(schema.products).values({
        id: `${marker}-prod`,
        name: 'Dues fixture',
        sku,
        category: 'Tests',
        netWeight: 10,
        stock: 3,
      })

      const now = Date.now()
      const mkInvoice = async (suffix: string, grandTotal: number, opts: { paymentStatus?: string; date?: Date } = {}) => {
        const id = `${marker}-${suffix}`
        await db!.insert(schema.salesInvoices).values({
          id,
          number: id,
          customer,
          grandTotal,
          subtotal: grandTotal,
          gst: 0,
          gstAmount: 0,
          discount: 0,
          paymentStatus: opts.paymentStatus ?? 'pending',
          status: 'issued',
          date: (opts.date ?? new Date(now)).toISOString(),
        })
        allInvoiceNumbers.push(id)
        return id
      }
      const mkPayment = async (suffix: string, invoice: string, amount: number, status = 'paid') => {
        await db!.insert(schema.payments).values({
          id: `${marker}-${suffix}`,
          ref: `${marker}-${suffix}`,
          invoice,
          customer,
          amount,
          method: 'cash',
          status,
          date: new Date(now).toISOString(),
        })
      }

      // ── Fixtures ────────────────────────────────────────────────────────
      // A: 1000 gross, 400 already collected (a prior partial payment).
      const invA = await mkInvoice('A', 1000, { date: new Date(now - 40000) })
      await mkPayment('pre-a', invA, 400, 'paid')
      // BOOK: a REAL booking conversion — 1000 invoice, 300 advance credited
      // during conversion (the Phase 5.1 workflow), paymentStatus pending.
      await db!.insert(schema.salesOrders).values({
        id: `${marker}-book`,
        internalId: `${marker}-BKBK`,
        customer,
        value: 1000,
        payment: 'pending',
        fulfillment: 'pending',
        status: 'confirmed',
        date: new Date(now - 30000).toISOString(),
        items: 2,
        tags: 'booking',
        currency: 'INR',
        discount: 0,
        gst: 3,
        lineItems: [{ title: 'Dues fixture', sku, quantity: 2, price: 500 }],
        isBooking: true,
        advancePaid: 300,
      })
      const { convertBookingToInvoice } = await import('./bookings')
      const conv = await convertBookingToInvoice(`${marker}-book`, { actor: 'tester' })
      assert.ok(conv.ok, JSON.stringify(conv))
      const invBook = String(conv.ok ? conv.invoiceNumber : '')
      allInvoiceNumbers.push(invBook)
      // C: 1000 gross, 200 already collected. D: 500 gross, nothing paid.
      const invC = await mkInvoice('C', 1000, { date: new Date(now - 20000) })
      await mkPayment('pre-c', invC, 200, 'success')
      const invD = await mkInvoice('D', 500, { date: new Date(now - 10000) })
      // F: fully paid by flag — contributes nothing to dues.
      const invF = await mkInvoice('F', 800, { paymentStatus: 'paid' })

      // The conversion credited its advance exactly once, against the invoice.
      const bookPays = (await db!.select().from(schema.payments)).filter((p) => p.invoice === invBook)
      assert.equal(bookPays.length, 1, 'exactly one advance row after conversion')
      assert.equal(Number(bookPays[0].amount), 300)
      assert.equal(bookPays[0].method, 'Advance')
      assert.equal(bookPays[0].gateway, 'booking')
      assert.equal(bookPays[0].status, 'paid')

      // ── Harness: dbRouter on a bare express app, identity via header ────
      const express = (await import('express')).default
      const { dbRouter } = await import('./routes/db')
      await db!.insert(schema.users).values([
        { id: adminId, name: 'Dues Admin', email: `${marker}-admin@test.local`, role: 'Super Admin', status: 'active' },
      ])
      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        ;(req as { userId?: string }).userId = req.header('x-test-user') ?? undefined
        next()
      })
      app.use('/db', dbRouter)
      const server = app.listen(0, '127.0.0.1')
      await new Promise<void>((resolve) => server.once('listening', () => resolve()))
      const port = Number((server.address() as { port: number }).port)
      const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: {
            'x-test-user': adminId,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        return { status: res.status, body: (await res.json()) as Record<string, any> }
      }

      try {
        // ── Baseline: the true outstanding is gross MINUS collected ───────
        // A(1000−400) + BOOK(1000−300) + C(1000−200) + D(500) + F(flag paid→0)
        // = 2600, NOT the old Σ grandTotal = 4300.
        const paidMap = await collectedByInvoice()
        const invRows = await db!.select().from(schema.salesInvoices).where(inArray(schema.salesInvoices.number, allInvoiceNumbers))
        const byNumber = new Map(invRows.map((r) => [String(r.number), r]))
        assert.equal(invoiceOutstanding(byNumber.get(invA)!, paidMap), 600, 'A: prior partial payment reduces its due')
        assert.equal(invoiceOutstanding(byNumber.get(invBook)!, paidMap), 700, 'BOOK: the conversion advance reduces its due')
        assert.equal(invoiceOutstanding(byNumber.get(invC)!, paidMap), 800, 'C: prior cash reduces its due')
        assert.equal(invoiceOutstanding(byNumber.get(invF)!, paidMap), 0, 'F: flagged paid owes nothing')

        const dues1 = await call('GET', '/db/dues')
        assert.equal(dues1.status, 200, JSON.stringify(dues1.body).slice(0, 200))
        const due1 = (dues1.body.dues as Array<Record<string, any>>).find((d) => d.customer === customer)
        assert.ok(due1, 'the customer appears on the dues list')
        assert.equal(Number(due1!.total), 2600, 'dues list quotes the TRUE outstanding (old code: 4300)')

        // ── Overpayment attempts are refused ──────────────────────────────
        const overAll = await call('POST', '/db/dues/pay', { customer, amount: 2601, method: 'cash' })
        assert.equal(overAll.status, 400, JSON.stringify(overAll.body))
        assert.match(String(overAll.body.error), /exceeds outstanding \(2600\.00\)/, 'the cap is the real outstanding')

        // ── FIFO partial payment: applied against TRUE dues, one row per
        //    invoice so each invoice’s collected equals the cash it got. ────
        const partial = await call('POST', '/db/dues/pay', { customer, amount: 900, method: 'cash' })
        assert.equal(partial.status, 200, JSON.stringify(partial.body))
        assert.deepEqual(
          partial.body.settled,
          [invA],
          'only A settles fully at ₹900 (its due is 600) — BOOK merely goes PARTIAL with the remaining 300',
        )
        assert.equal(Number(partial.body.remainingOutstanding), 1700, 'what is left after the payment')
        const partialRows = (await db!.select().from(schema.payments)).filter((p) => p.ref === String(partial.body.ref))
        assert.equal(partialRows.length, 2, 'ONE payment row per invoice the cash was applied to')
        assert.deepEqual(
          partialRows.map((p) => [p.invoice, Number(p.amount)]),
          [[invA, 600], [invBook, 300]],
          'A got exactly its due, BOOK exactly its due — no invoice over-credited',
        )
        const paidAfter = await collectedByInvoice()
        const invRows2 = await db!.select().from(schema.salesInvoices).where(inArray(schema.salesInvoices.number, allInvoiceNumbers))
        const byNumber2 = new Map(invRows2.map((r) => [String(r.number), r]))
        assert.equal(invoiceOutstanding(byNumber2.get(invA)!, paidAfter), 0, 'A is fully settled')
        assert.equal(invoiceOutstanding(byNumber2.get(invBook)!, paidAfter), 400, 'BOOK still owes 400 — the 300 credit counted')
        assert.equal(byNumber2.get(invBook)!.paymentStatus, 'partial', 'BOOK is marked partial, not paid')
        assert.equal(byNumber2.get(invA)!.paymentStatus, 'paid', 'A is marked paid')

        // ── Overpayment against the REMAINING outstanding ─────────────────
        const over2 = await call('POST', '/db/dues/pay', { customer, amount: 1701, method: 'cash' })
        assert.equal(over2.status, 400, JSON.stringify(over2.body))
        assert.match(String(over2.body.error), /exceeds outstanding \(1700\.00\)/)

        // The Dues page follows along (collectDues uses the same rule).
        const dues2 = await call('GET', '/db/dues')
        const due2 = (dues2.body.dues as Array<Record<string, any>>).find((d) => d.customer === customer)
        assert.equal(Number(due2?.total), 1700, 'dues list tracks the real remaining balance')

        // ── Settle the rest exactly: FIFO across BOOK → C → D ─────────────
        const settle = await call('POST', '/db/dues/pay', { customer, amount: 1700, method: 'upi' })
        assert.equal(settle.status, 200, JSON.stringify(settle.body))
        assert.deepEqual(settle.body.settled, [invBook, invC, invD], 'BOOK(400) → C(800) → D(500), oldest first')
        assert.equal(Number(settle.body.remainingOutstanding), 0)
        const settleRows = (await db!.select().from(schema.payments)).filter((p) => p.ref === String(settle.body.ref))
        assert.equal(settleRows.length, 3, 'one row per invoice touched')
        assert.deepEqual(
          settleRows.map((p) => [p.invoice, Number(p.amount)]),
          [[invBook, 400], [invC, 800], [invD, 500]],
          'each invoice credited exactly what it was owed',
        )
        const paidFinal = await collectedByInvoice()
        const invRows3 = await db!.select().from(schema.salesInvoices).where(inArray(schema.salesInvoices.number, allInvoiceNumbers))
        const byNumber3 = new Map(invRows3.map((r) => [String(r.number), r]))
        assert.equal(invoiceOutstanding(byNumber3.get(invC)!, paidFinal), 0, 'C fully settled')
        assert.equal(invoiceOutstanding(byNumber3.get(invD)!, paidFinal), 0, 'D fully settled')
        // No invoice collected MORE than its gross (over-collection impossible):
        for (const num of [invA, invBook, invC, invD]) {
          const row = byNumber3.get(num)!
          const collected = Number(row.grandTotal ?? 0) - invoiceOutstanding(row, paidFinal)
          assert.ok(collected <= Number(row.grandTotal ?? 0) + 0.001, `${num} never collects beyond its grand total`)
        }

        // ── Fully paid: nothing left to collect ───────────────────────────
        const nothing = await call('POST', '/db/dues/pay', { customer, amount: 1, method: 'cash' })
        assert.equal(nothing.status, 400, JSON.stringify(nothing.body))
        assert.match(String(nothing.body.error), /No outstanding invoices/)
        const dues3 = await call('GET', '/db/dues')
        assert.ok(
          !(dues3.body.dues as Array<Record<string, any>>).some((d) => d.customer === customer),
          'a settled customer drops off the dues list entirely',
        )

        // Duplicate request safety: repeating the last payment changes nothing.
        const dup = await call('POST', '/db/dues/pay', { customer, amount: 1700, method: 'cash' })
        assert.equal(dup.status, 400, 'a duplicate payment is refused once settled')
        const totalRowsForCustomer = (await db!.select().from(schema.payments)).filter((p) => p.customer === customer).length
        assert.equal(
          totalRowsForCustomer,
          2 + 1 + 2 + 3,
          'prior cash (2) + the conversion advance (1) + the partial payment (2 rows) + the settlement (3 rows) — nothing duplicated',
        )
      } finally {
        server.close()
      }

      // Remove everything this run created, in dependency order — inside the
      // scope that owns `db` (same structure as bookings.test.ts).
      const invoiceRows = await db!
        .select({ id: schema.salesInvoices.id, number: schema.salesInvoices.number })
        .from(schema.salesInvoices)
        .where(eq(schema.salesInvoices.customer, customer))
      if (invoiceRows.length > 0) {
        await db!.delete(schema.payments).where(inArray(schema.payments.invoice, invoiceRows.map((i) => i.number)))
      }
      for (const inv of invoiceRows) {
        await db!.delete(schema.salesInvoiceItems).where(eq(schema.salesInvoiceItems.invoiceId, inv.id))
        await db!.delete(schema.salesInvoices).where(eq(schema.salesInvoices.id, inv.id))
      }
      await db!.delete(schema.orderEvents).where(eq(schema.orderEvents.orderId, `${marker}-book`))
      await db!.delete(schema.salesOrders).where(eq(schema.salesOrders.id, `${marker}-book`))
      await db!.delete(schema.users).where(eq(schema.users.id, adminId))
      await db!.delete(schema.products).where(eq(schema.products.id, `${marker}-prod`))
      await db!.delete(schema.silverRates).where(eq(schema.silverRates.id, `${marker}-rate`))
      await db!.delete(schema.customers).where(eq(schema.customers.name, customer))
    } finally {
      // Leave no scratch database behind — runs even if the sweep failed.
      const cleanup = postgres(baseDbUrl, { max: 1 })
      try {
        await cleanup.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
      } finally {
        await cleanup.end({ timeout: 5 })
      }
    }
  },
)
