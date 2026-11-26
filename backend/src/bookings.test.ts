import 'dotenv/config'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import postgres from 'postgres'

// The booking workflow end to end against the REAL schema in a THROWAWAY
// scratch database (the same pattern as returns.test.ts), skipped when
// DATABASE_URL is unset. A booking stores price-only line items, so this pins
// the whole create → convert leg:
//
//   • converting raises an invoice priced from the booked amount (GST backed
//     out of the per-unit price, then applied) — it used to raise a ₹0 invoice
//     while still deducting the stock;
//   • the booking's own discount lands on the invoice, so the invoice grand
//     total equals the booking value the row, the advance clamp and the
//     convert endpoint's balance all work from;
//   • an advance ≥ value converts as a paid booking; a part advance stays due;
//   • the order ends up linked, `fulfilled` in BOTH status and fulfillment,
//     with the advance written to `payments` (method "Advance", gateway
//     "booking") and the conversion on the order timeline;
//   • the stock the booking's SKUs sell is actually deducted;
//   • conversion is guarded: a repeat convert and a cancelled booking are both
//     refused instead of raising a second invoice.

// A receipt mirrors stock to Shopify in production. These tests use a scratch
// database but the developer's real .env, so the mirror is disabled here.
process.env.OPAL_DISABLE_SHOPIFY_PUSH = '1'

const baseDbUrl = process.env.DATABASE_URL?.trim() ?? ''
const TEST_DB = 'opal_line_bookings_test'

function scratchUrl(base: string): string {
  const url = new URL(base)
  url.pathname = `/${TEST_DB}`
  return url.toString()
}

// ── Booking contact rules: pure, no database. bookings.ts must stay
//    importable without touching db/client, which is exactly what lets this
//    run before any scratch schema exists. ───────────────────────────────────
test('booking contact: blank clears, a real address passes, a malformed one is refused', async () => {
  const { parseBookingContact } = await import('./bookings')

  assert.deepEqual(parseBookingContact({}), { email: '', phone: '' }, 'no contact fields is a normal, valid state')
  assert.deepEqual(
    parseBookingContact({ email: ' priya@example.com ', phone: ' 98765 43210 ' }),
    { email: 'priya@example.com', phone: '98765 43210' },
    'contact is trimmed on the way in',
  )
  assert.deepEqual(
    parseBookingContact({ email: '', phone: '' }),
    { email: '', phone: '' },
    'clearing a field is a normal update, not an error',
  )

  const badEmail = parseBookingContact({ email: 'not-an-email' })
  assert.ok('error' in badEmail && /valid/.test(badEmail.error), 'a malformed email is a 400, never stored')
  const longPhone = parseBookingContact({ phone: 'x'.repeat(41) })
  assert.ok('error' in longPhone, 'oversized contact values are refused')
})

// ── Booking form payload rules: pure, no database. ──────────────────────────
test('booking items: whole pieces only, sane prices, product/variant ids and add-on kept', async () => {
  const { normalizeBookingItems } = await import('./bookings')

  const ok = normalizeBookingItems([
    { product: '  Silver Ring ', sku: ' RING-1 ', qty: 2.9, price: 1234.567, priceAdjustment: 200, productId: 'p1', variantId: 'v1' },
    { product: 'Chain', qty: '3', price: '500' },
    // Invalid rows are dropped, exactly as the old inline filter did.
    { product: '', qty: 1, price: 10 },
    { product: 'No qty', qty: 0, price: 10 },
  ])
  assert.ok(!('error' in ok))
  assert.equal(ok.items.length, 2, 'blank and zero-qty lines never reach storage')
  assert.deepEqual(ok.items[0], {
    title: 'Silver Ring',
    sku: 'RING-1',
    quantity: 2,
    price: 1234.57,
    priceAdjustment: 200,
    productId: 'p1',
    variantId: 'v1',
  }, 'trimmed, floored, rounded to the paisa, relationship kept')
  assert.deepEqual(ok.items[1], { title: 'Chain', sku: '', quantity: 3, price: 500 })

  const negative = normalizeBookingItems([{ product: 'Ring', qty: 1, price: -5 }])
  assert.ok('error' in negative && /negative/.test(negative.error), 'a negative price is refused')
  const junk = normalizeBookingItems([{ product: 'Ring', qty: 1, price: 'abc' }])
  assert.ok('error' in junk && /not a number/.test(junk.error), 'a non-numeric price is refused')
  const empty = normalizeBookingItems([{ product: 'Ring', qty: 0, price: 10 }])
  assert.ok('error' in empty && /at least one item/.test(empty.error), 'the classic empty-form error')
  assert.ok('error' in normalizeBookingItems('nope'), 'a non-array is refused')
})

test('booking header: dates round-trip, GST is bounded, status is a two-value whitelist', async () => {
  const { parseBookingHeader } = await import('./bookings')

  const full = parseBookingHeader({
    date: '2026-11-20T10:00:00.000Z',
    expectedDate: '2026-12-24',
    gst: 7.5,
    note: '  Deliver before Christmas  ',
    status: 'processing',
  })
  assert.ok(!('error' in full))
  assert.equal(full.date, '2026-11-20T10:00:00.000Z', 'a real instant round-trips as ISO')
  // Date-only input must keep its wall clock: routing it through the local
  // zone would store 2026-11-19T18:30Z for an IST client and the booking
  // would render a day early.
  const dateOnly = parseBookingHeader({ date: '2026-11-20' })
  assert.ok(!('error' in dateOnly))
  assert.ok(
    String(dateOnly.date).startsWith('2026-11-20'),
    `a date-only booking date never shifts days (got ${String(dateOnly.date)})`,
  )
  assert.equal(full.expectedDate, '2026-12-24', 'the expected date stays date-only (PO convention)')
  assert.equal(full.gst, 7.5)
  assert.equal(full.note, 'Deliver before Christmas', 'trimmed')
  assert.equal(full.status, 'processing')

  const cleared = parseBookingHeader({ expectedDate: '', gst: null, note: '', status: 'confirmed' })
  assert.ok(!('error' in cleared))
  assert.equal(cleared.expectedDate, null, 'clearing the expected date stores null')
  assert.equal(cleared.gst, null, 'an explicit null GST means "use the settings rate"')
  assert.equal(cleared.note, null, 'an empty note is null, never an empty string')

  assert.ok('error' in parseBookingHeader({ date: 'yesterday-ish' }), 'a junk booking date is refused')
  assert.ok('error' in parseBookingHeader({ expectedDate: 'soon' }), 'a junk expected date is refused')
  assert.ok('error' in parseBookingHeader({ gst: -1 }), 'GST below 0 is refused')
  assert.ok('error' in parseBookingHeader({ gst: 101 }), 'GST above 100 is refused')
  const badStatus = parseBookingHeader({ status: 'fulfilled' })
  assert.ok('error' in badStatus && /confirmed, processing/.test(badStatus.error), 'fulfilled/cancelled are NOT form statuses')
  assert.deepEqual(parseBookingHeader({}), {}, 'an empty body changes nothing')
})

// ── The money model: booking value ≡ invoice grand total, to the paisa. ─────
test('booking totals use the invoice formula, so preview and stored invoice agree', async () => {
  const { computeBookingTotals } = await import('./bookings')

  const booked = computeBookingTotals([{ price: 1500, quantity: 3 }], 7, 0)
  assert.equal(booked.linesTotal, 4500, 'lines total = Σ price × qty, GST-inclusive')
  assert.equal(booked.taxable, 4205.61, 'taxable = the line backed out of 7% GST')
  assert.equal(booked.gstAmount, 294.39)
  assert.equal(booked.value, 4500, 'taxable + GST round-trips to exactly what was booked')

  const discounted = computeBookingTotals([{ price: 2000, quantity: 2 }], 5, 250)
  assert.equal(discounted.taxable, 3809.52)
  assert.equal(discounted.gstAmount, 190.48)
  assert.equal(discounted.value, 3750, 'discount comes off the grand total, once')

  const noGst = computeBookingTotals([{ price: 100, quantity: 2 }], 0, 10)
  assert.deepEqual(noGst, { linesTotal: 200, taxable: 200, gstAmount: 0, discount: 10, value: 190 })

  // Multi-line rounding behaves the way the invoice rounds: per line, then summed.
  const multi = computeBookingTotals(
    [{ price: 333.33, quantity: 3 }, { price: 1999.5, quantity: 1 }],
    3,
    0,
  )
  const entered = Math.round((3 * 333.33 + 1999.5) * 100) / 100
  assert.ok(
    Math.abs(multi.value - entered) <= 0.02,
    `booked ${multi.value} within 2 paise of the entered ${entered}`,
  )

  // Negative or junk inputs can never produce a negative booking.
  const clamped = computeBookingTotals([{ price: 100, quantity: 1 }], -5, -20)
  assert.equal(clamped.value, 100, 'a negative rate/discount is clamped, never inverted')
})

test('a booked variant add-on is already in the per-unit price and is not added twice', async () => {
  const { computeBookingTotals } = await import('./bookings')
  // Base 669.50 + ₹200 add-on = ₹869.50 per unit, qty 2.
  const totals = computeBookingTotals([{ price: 869.5, quantity: 2, priceAdjustment: 200 }], 3, 0)
  assert.equal(totals.linesTotal, 1739, 'the GST-inclusive price including the add-on is the booked value')
  assert.equal(totals.taxable, 1688.35, 'backed out of GST exactly once')
  assert.equal(totals.gstAmount, 50.65)
  assert.equal(totals.value, 1739, 'no second add-on appears in the booking value')
})

test(
  'booking workflow: create → convert prices the invoice, moves the advance, deducts stock, stays guarded',
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
      const { convertBookingToInvoice } = await import('./bookings')
      const { eq, inArray, or, ilike, sql, and } = await import('drizzle-orm')
      assert.ok(db, 'test database client did not initialize')

      const marker = `bk-${Date.now()}`
      const skuA = `${marker}-RING`
      const skuB = `${marker}-CHAIN`
      const productId = `${marker}-prod`
      const customer = `${marker} Buyer`
      // Every booking this run creates — swept in one place at the end.
      const adminId = `${marker}-admin`
      const viewerId = `${marker}-viewer`
      const allBookingIds: string[] = []
      /** Products created by the stock-guard scenarios (swept with their ledger rows). */
      const stockProductIds: string[] = []
      const stockLocationId = `${marker}-loc`

      // Invoice creation refuses to run without the authoritative silver rate.
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
      // The SKU the booking sells must exist so conversion can deduct it.
      await db!.insert(schema.products).values({
        id: productId,
        name: 'Booked Ring (test)',
        sku: skuA,
        category: 'test',
        netWeight: 10,
        stock: 5,
      })

      // ── Booking 1: exactly what POST /db/bookings inserts — price-only
      //    line items, no weight components, a part advance. ────────────────
      const bookingA = {
        id: `${marker}-a`,
        internalId: `BK${marker}-A`,
        customer,
        // Contact captured with the booking: it must reach the invoice when
        // no customer record matches the walk-in name.
        customerEmail: 'priya@example.com',
        customerPhone: '9876543210',
        value: 10000,
        payment: 'pending',
        fulfillment: 'pending',
        status: 'confirmed',
        date: new Date().toISOString(),
        items: 2,
        tags: 'booking',
        currency: 'INR',
        discount: 0,
        lineItems: [{ title: 'Silver Ring', sku: skuA, quantity: 2, price: 5000 }],
        isBooking: true,
        advancePaid: 3000,
      }
      // ── Booking 2: a discount and a full advance in cash. ────────────────
      const bookingB = {
        id: `${marker}-b`,
        internalId: `BK${marker}-B`,
        customer,
        value: 9500, // 10000 booked − 500 discount
        payment: 'paid',
        fulfillment: 'pending',
        status: 'confirmed',
        date: new Date().toISOString(),
        items: 1,
        tags: 'booking',
        currency: 'INR',
        discount: 500,
        lineItems: [{ title: 'Silver Chain', sku: skuB, quantity: 1, price: 10000 }],
        isBooking: true,
        advancePaid: 9500,
      }
      // ── Booking 3: cancelled before anyone converts it. ──────────────────
      const bookingC = {
        id: `${marker}-c`,
        internalId: `BK${marker}-C`,
        customer,
        value: 5000,
        payment: 'pending',
        fulfillment: 'pending',
        status: 'cancelled',
        date: new Date().toISOString(),
        items: 1,
        tags: 'booking',
        currency: 'INR',
        discount: 0,
        lineItems: [{ title: 'Silver Payal', sku: `${marker}-PAYAL`, quantity: 1, price: 5000 }],
        isBooking: true,
        advancePaid: 0,
      }
      await db!.insert(schema.salesOrders).values([bookingA, bookingB, bookingC])
      allBookingIds.push(bookingA.id, bookingB.id, bookingC.id)

      const load = async (id: string) => {
        const [row] = await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, id)).limit(1)
        return row
      }

      try {
        // ── Convert booking 1 — the full route workflow, through the
        //    extracted service the route delegates to. ─────────────────────
        const resA = await convertBookingToInvoice(bookingA.id, { actor: 'tester' })
        assert.ok(resA.ok, JSON.stringify(resA))
        assert.equal(resA.advanceApplied, 3000, 'the advance is carried into the invoice')
        assert.equal(resA.balance, 7000, 'balance = value − advance: what is still due')
        assert.equal(resA.payment, 'pending', 'a part advance leaves the booking pending')

        // ₹10,000 booked: taxable = 10000 ÷ 1.03 = 9708.74, GST = 291.26.
        const [invoiceA] = await db!.select().from(schema.salesInvoices).where(eq(schema.salesInvoices.number, resA.invoiceNumber)).limit(1)
        assert.equal(Number(invoiceA.subtotal), 9708.74, 'subtotal = booked amount backed out of GST — never 0')
        assert.equal(Number(invoiceA.gstAmount), 291.26, 'GST = 3% of the taxable value')
        assert.equal(Number(invoiceA.discount), 0)
        assert.equal(Number(invoiceA.grandTotal), 10000, 'invoice grand total = the amount that was booked')
        assert.equal(
          Number(invoiceA.silverValue) + Number(invoiceA.makingCharge),
          Number(invoiceA.subtotal),
          'invoice components add up to the subtotal',
        )
        assert.equal(invoiceA.paymentStatus, 'pending', 'a part advance converts as a pending invoice')
        assert.equal(invoiceA.status, 'issued')
        // No customer record carries this walk-in name, so the booking's own
        // contact columns are what the invoice inherits.
        assert.equal(invoiceA.customerEmail, 'priya@example.com', 'the booking email reaches its invoice')
        assert.equal(invoiceA.customerPhone, '9876543210', 'the booking phone reaches its invoice')

        const itemsA = await db!.select().from(schema.salesInvoiceItems).where(eq(schema.salesInvoiceItems.invoiceId, invoiceA.id))
        assert.equal(itemsA.length, 1, 'one line per booked product')
        assert.equal(itemsA[0].product, 'Silver Ring')
        assert.equal(Number(itemsA[0].qty), 2)
        assert.equal(Number(itemsA[0].amount), 9708.74, 'the line carries the taxable value, not 0')
        assert.equal(Number(itemsA[0].tax), 291.26)
        assert.equal(Number(itemsA[0].weight), 0, 'no weight was recorded on the booking — never invented')

        // The order now agrees with itself: linked, fulfilled in both fields.
        const linkedA = await load(bookingA.id)
        assert.equal(linkedA!.invoice, resA.invoiceNumber, 'the booking points at its invoice')
        assert.equal(linkedA!.status, 'fulfilled', 'the booking status moves to fulfilled')
        assert.equal(linkedA!.fulfillment, 'fulfilled', 'the fulfillment column agrees with the status')
        assert.equal(linkedA!.payment, 'pending', 'a part advance keeps the booking pending')

        // The advance is a real payment row, visible to Accounts.
        const paysA = await db!.select().from(schema.payments).where(eq(schema.payments.invoice, resA.invoiceNumber))
        assert.equal(paysA.length, 1, 'the advance becomes one payment row')
        assert.equal(Number(paysA[0].amount), 3000, 'for exactly the advance collected')
        assert.equal(paysA[0].method, 'Advance')
        assert.equal(paysA[0].gateway, 'booking')
        assert.equal(paysA[0].status, 'paid')
        assert.equal(paysA[0].ref, bookingA.internalId, 'the payment references the booking number')

        // The timeline records the conversion, with the actor who ran it.
        const eventsA = await db!.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, bookingA.id))
        const converted = eventsA.find((e) => e.event === 'Booking Converted')
        assert.ok(converted, 'the conversion is on the order timeline')
        assert.ok(converted!.details!.includes(resA.invoiceNumber), 'the event names the invoice')
        assert.equal(converted!.actor, 'tester', 'the actor is recorded')

        // The stock the booking sold is actually deducted: 5 on hand − 2 sold.
        const [sold] = await db!.select({ stock: schema.products.stock }).from(schema.products).where(eq(schema.products.id, productId))
        assert.equal(Number(sold.stock), 3, 'conversion deducts the booked quantity from stock')

        // A repeated convert is refused — never a second invoice.
        const again = await convertBookingToInvoice(bookingA.id, { actor: 'tester' })
        assert.equal(again.ok, false, 'an already converted booking cannot convert twice')
        assert.equal(again.ok === false && again.status, 400)
        const allA = await db!.select({ id: schema.salesInvoices.id }).from(schema.salesInvoices).where(eq(schema.salesInvoices.number, resA.invoiceNumber))
        assert.equal(allA.length, 1, 'a second convert must not raise a second invoice')
        const paysAll = await db!.select().from(schema.payments).where(eq(schema.payments.invoice, resA.invoiceNumber))
        assert.equal(paysAll.length, 1, 'nor a second advance payment row')

        // ── Convert booking 2: discount + full advance → paid invoice at
        //    exactly the booking value, balance zero. ──────────────────────
        const resB = await convertBookingToInvoice(bookingB.id)
        assert.ok(resB.ok, JSON.stringify(resB))
        assert.equal(resB.payment, 'paid', 'a fully advanced booking converts as paid')
        assert.equal(resB.advanceApplied, 9500)
        assert.equal(resB.balance, 0, 'nothing left due')
        const [invoiceB] = await db!.select().from(schema.salesInvoices).where(eq(schema.salesInvoices.number, resB.invoiceNumber)).limit(1)
        assert.equal(Number(invoiceB.discount), 500, "the booking's discount lands on the invoice")
        assert.equal(Number(invoiceB.subtotal), 9708.74, '₹10,000 booked before the discount')
        assert.equal(Number(invoiceB.grandTotal), 9500, 'invoice grand total = booked 10000 − discount 500')
        assert.equal(invoiceB.paymentStatus, 'paid')
        assert.equal(invoiceB.status, 'paid')
        const linkedB = await load(bookingB.id)
        assert.equal(linkedB!.payment, 'paid', 'the booking itself is levelled to paid')
        const paysB = await db!.select().from(schema.payments).where(eq(schema.payments.invoice, resB.invoiceNumber))
        assert.equal(paysB.length, 1)
        assert.equal(Number(paysB[0].amount), 9500)

        // ── A cancelled booking never converts. ────────────────────────────
        const resC = await convertBookingToInvoice(bookingC.id)
        assert.equal(resC.ok, false, 'a cancelled booking is refused')
        assert.equal(resC.ok === false && resC.status, 400)
        assert.equal(resC.ok === false && /cancelled/.test(resC.error), true, 'the refusal says why')
        const linkedC = await load(bookingC.id)
        assert.equal(linkedC!.invoice, null, 'no invoice was raised for the cancelled booking')
        const invoicesC = await db!
          .select({ id: schema.salesInvoices.id })
          .from(schema.salesInvoices)
          .where(eq(schema.salesInvoices.customer, customer))
        // Exactly the two allowed conversions exist — nothing from booking 3.
        assert.equal(invoicesC.length, 2, 'only bookings A and B produced invoices')

        // An unknown id is a clean 404, not a crash.
        const missing = await convertBookingToInvoice(`${marker}-nope`)
        assert.equal(missing.ok, false)
        assert.equal(missing.ok === false && missing.status, 404)

        // ── The routes themselves, over HTTP: RBAC, validation and the
        //    create → edit → convert → cancel lifecycle a real client runs.
        //    Same harness as routes/collections.test.ts: the dbRouter on a
        //    bare express app, identity injected from the x-test-user header.
        const express = (await import('express')).default
        const { dbRouter } = await import('./routes/db')
        await db!.insert(schema.users).values([
          { id: adminId, name: 'Booking Admin', email: `${marker}-admin@test.local`, role: 'Super Admin', status: 'active' },
          {
            id: viewerId,
            name: 'Booking Viewer',
            email: `${marker}-viewer@test.local`,
            role: 'Staff',
            status: 'active',
            permissions: { sales: { view: true, create: false, edit: false, delete: false } },
          },
        ])
        const app = express()
        app.use(express.json())
        app.use((req, _res, next) => {
          ;(req as { userId?: string }).userId = req.header('x-test-user') ?? undefined
          next()
        })
        app.use('/db', dbRouter)
        // The day-book lives on the dashboard router — mounted here so the
        // Phase 5.1 test can assert real cash reporting for booking advances.
        const { dashboardRouter } = await import('./routes/dashboard')
        app.use('/db', dashboardRouter)
        const server = app.listen(0, '127.0.0.1')
        // address() is null until the socket is actually listening.
        await new Promise<void>((resolve) => server.once('listening', () => resolve()))
        const port = Number((server.address() as { port: number }).port)
        const call = async (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown) => {
          const res = await fetch(`http://127.0.0.1:${port}${path}`, {
            method,
            headers: {
              ...(who ? { 'x-test-user': who } : {}),
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
          return { status: res.status, body: (await res.json()) as Record<string, any> }
        }
        try {
          // RBAC: sales.view alone can never create a booking.
          const denied = await call(viewerId, 'POST', '/db/bookings', {
            customer: 'Nope',
            items: [{ product: 'X', qty: 1, price: 10 }],
          })
          assert.equal(denied.status, 403, 'a view-only sales role is refused with 403')

          // Validation mirrors the form: name, items, and a sane email.
          assert.equal(
            (await call(adminId, 'POST', '/db/bookings', { customer: '', items: [{ product: 'X', qty: 1, price: 10 }] })).status,
            400,
            'a customer name is required',
          )
          assert.equal(
            (await call(adminId, 'POST', '/db/bookings', { customer: 'Walk-in', items: [] })).status,
            400,
            'at least one item is required',
          )
          assert.equal(
            (await call(adminId, 'POST', '/db/bookings', { customer: 'Walk-in', email: 'not-an-email', items: [{ product: 'X', qty: 1, price: 10 }] })).status,
            400,
            'a malformed email is refused, never stored',
          )

          // ── Create: the full form payload — lines with relationships, header
          //    fields, advance, contact — plus the two promises the workflow
          //    makes: creating a booking NEVER moves stock, and it links a real
          //    customers row instead of leaving free text behind.
          const stockBeforeCreate = await db!
            .select({ stock: schema.products.stock })
            .from(schema.products)
            .where(eq(schema.products.id, productId))
          const created = await call(adminId, 'POST', '/db/bookings', {
            customer,
            email: 'priya@example.com',
            phone: '9876543210',
            date: '2026-11-20T10:00:00.000Z',
            expectedDate: '2026-12-24',
            gst: 7,
            note: 'Deliver before Christmas',
            items: [{ product: 'Silver Payal', sku: skuA, qty: 3, price: 1500, productId, variantId: null }],
            advanceAmount: 1000,
            discount: 0,
          })
          assert.equal(created.status, 200, JSON.stringify(created.body))
          allBookingIds.push(created.body.id)
          assert.equal(Number(created.body.value), 4500, 'value = qty × price − discount')
          assert.equal(Number(created.body.advancePaid), 1000)
          assert.equal(created.body.payment, 'pending')
          assert.equal(created.body.isBooking, true)
          assert.match(String(created.body.internalId), /^BK\d{6}-\d{6}$/, 'bookings are numbered BKyyyMM-######')
          assert.equal(created.body.customerEmail, 'priya@example.com', 'contact is stored on the booking')
          assert.equal(created.body.gst, 7, 'the booked GST rate is stored')
          assert.match(String(created.body.expectedDelivery), /2026-12-24/, 'expected delivery is stored as the sent date')
          assert.equal(created.body.note, 'Deliver before Christmas', 'the note is stored')
          assert.match(String(created.body.date), /2026-11-20/, 'the booking date round-trips as the sent date')
          const createdLine = (created.body.lineItems as Array<Record<string, unknown>>)[0]
          assert.equal(createdLine.productId, productId, 'the line keeps pointing at the catalogue product')
          const createdEvents = await db!.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, created.body.id))
          assert.ok(createdEvents.some((ev) => ev.event === 'Booking Created'), 'create writes the timeline event')
          const stockAfterCreate = await db!
            .select({ stock: schema.products.stock })
            .from(schema.products)
            .where(eq(schema.products.id, productId))
          assert.equal(
            Number(stockAfterCreate[0].stock),
            Number(stockBeforeCreate[0].stock),
            'CREATING a booking never moves inventory',
          )
          const createdCustomers = await db!.select().from(schema.customers).where(eq(schema.customers.email, 'priya@example.com'))
          assert.equal(createdCustomers.length, 1, 'a real customers row is linked for the contact')

          // Same contact, different typed name → ONE row, never a duplicate.
          const dupe = await call(adminId, 'POST', '/db/bookings', {
            customer: `${customer} (second)`,
            email: 'priya@example.com',
            items: [{ product: 'Silver Chain', qty: 1, price: 900 }],
          })
          assert.equal(dupe.status, 200, JSON.stringify(dupe.body))
          allBookingIds.push(dupe.body.id)
          const byEmail = await db!.select().from(schema.customers).where(eq(schema.customers.email, 'priya@example.com'))
          assert.equal(byEmail.length, 1, 'identity matching updates the row instead of duplicating it')
          assert.equal(byEmail[0].name, `${customer} (second)`, 'the booking name stays in step (invoices match by name)')

          // A walk-in with no contact stays name-linked: no customer is invented.
          const nameOnly = await call(adminId, 'POST', '/db/bookings', {
            customer: `${marker} Name Only`,
            items: [{ product: 'Ring', qty: 1, price: 600 }],
          })
          assert.equal(nameOnly.status, 200, JSON.stringify(nameOnly.body))
          allBookingIds.push(nameOnly.body.id)
          const nameRows = await db!.select().from(schema.customers).where(eq(schema.customers.name, `${marker} Name Only`))
          assert.equal(nameRows.length, 0, 'name-only bookings never create a blind customer record')

          // The picker's explicit customer id links that exact row.
          const pickedId = `${marker}-picked-cust`
          await db!.insert(schema.customers).values({
            id: pickedId,
            name: 'Picked Customer',
            email: `${marker}@picked.test`,
            orders: 0,
            totalSpent: 0,
            status: 'active',
            joined: '2026-01-01',
          })
          const picked = await call(adminId, 'POST', '/db/bookings', {
            customer: 'Picked Customer',
            customerId: pickedId,
            items: [{ product: 'Silver Payal', qty: 1, price: 700 }],
          })
          assert.equal(picked.status, 200, JSON.stringify(picked.body))
          allBookingIds.push(picked.body.id)
          const linkedPicked = await db!.select().from(schema.customers).where(eq(schema.customers.id, pickedId))
          assert.equal(linkedPicked.length, 1, 'the picked customer row is linked, not duplicated')

          // Edit: re-priced lines, header fields, status, refreshed contact.
          const edited = await call(adminId, 'PATCH', `/db/bookings/${created.body.id}`, {
            items: [{ product: 'Silver Payal', sku: skuA, qty: 2, price: 2000, productId }],
            advanceAmount: 500,
            email: 'priya.sharma@example.com',
            expectedDate: '2026-12-31',
            gst: 5,
            note: 'Call before delivery',
            status: 'processing',
          })
          assert.equal(edited.status, 200, JSON.stringify(edited.body))
          assert.equal(Number(edited.body.value), 4000, 'the booking value follows the edited lines')
          assert.equal(Number(edited.body.advancePaid), 500)
          assert.equal(edited.body.customerEmail, 'priya.sharma@example.com')
          assert.equal(edited.body.gst, 5, 'the GST rate is editable')
          assert.match(String(edited.body.expectedDelivery), /2026-12-31/, 'the expected date is editable')
          assert.equal(edited.body.note, 'Call before delivery', 'the note is editable')
          assert.equal(edited.body.status, 'processing', 'the form may move a booking to processing')

          // Form edits are validated server-side, not only in the UI.
          assert.equal((await call(adminId, 'PATCH', `/db/bookings/${created.body.id}`, { gst: 101 })).status, 400, 'GST above 100 refused')
          assert.equal((await call(adminId, 'PATCH', `/db/bookings/${created.body.id}`, { expectedDate: 'soon' })).status, 400, 'junk expected date refused')
          assert.equal((await call(adminId, 'PATCH', `/db/bookings/${created.body.id}`, { status: 'fulfilled' })).status, 400, 'fulfilled is not a form status')
          assert.equal(
            (await call(adminId, 'PATCH', `/db/bookings/${created.body.id}`, { items: [{ product: 'X', qty: 1, price: 100 }], discount: 500 })).status,
            400,
            'a discount above the booking total is refused',
          )

          const cleared = await call(adminId, 'PATCH', `/db/bookings/${created.body.id}`, { phone: '' })
          assert.equal(cleared.status, 200)
          assert.equal(cleared.body.customerPhone, null, 'clearing a contact field stores null')

          // Convert over HTTP: the invoice bills at the BOOKING's GST rate and
          // equals the edited booking value; stock moves NOW (not on create);
          // then the booking is frozen — edits are refused.
          const conv = await call(adminId, 'POST', `/db/bookings/${created.body.id}/convert`)
          assert.equal(conv.status, 200, JSON.stringify(conv.body))
          assert.equal(Number(conv.body.advanceApplied), 500)
          assert.equal(Number(conv.body.balance), 3500, 'balance = value − advance')
          const [invD] = await db!.select().from(schema.salesInvoices).where(eq(schema.salesInvoices.number, conv.body.invoiceNumber)).limit(1)
          assert.equal(Number(invD.gst), 5, 'the invoice bills at the GST rate the booking was taken at')
          assert.equal(Number(invD.subtotal), 3809.52, 'taxable = 4000 backed out of 5% GST')
          assert.equal(Number(invD.gstAmount), 190.48)
          assert.equal(Number(invD.grandTotal), 4000, 'invoice grand total = the booking value')
          const stockAfterConvert = await db!
            .select({ stock: schema.products.stock })
            .from(schema.products)
            .where(eq(schema.products.id, productId))
          assert.equal(Number(stockAfterConvert[0].stock), 1, 'conversion deducts the EDITED quantity: 3 on hand − 2 booked = 1')
          const frozen = await call(adminId, 'PATCH', `/db/bookings/${created.body.id}`, { customer: 'Changed' })
          assert.equal(frozen.status, 400, 'a converted booking refuses edits')

          // ── The bookings list: only booking rows, readable by a view-only
          //    role, and the form's status transition works before cancelling.
          const listed = await call(adminId, 'GET', '/db/bookings')
          assert.equal(listed.status, 200)
          const listRows = listed.body.data as Array<Record<string, unknown>>
          assert.ok(listRows.length >= 6, 'every booking this run created is listed')
          assert.ok(
            listRows.every((r) => r.isBooking || String(r.tags ?? '').toLowerCase().includes('booking')),
            'ONLY booking rows come back — never other sales orders',
          )
          assert.ok(listRows.some((r) => r.id === created.body.id))
          assert.equal(listed.body.total, listRows.length, 'total matches the payload the Pager needs')
          const viewerList = await call(viewerId, 'GET', '/db/bookings')
          assert.equal(viewerList.status, 200, 'a view-only sales role can still read the list')

          // Cancel over HTTP: the status flips, and conversion is refused after.
          const createdE = await call(adminId, 'POST', '/db/bookings', {
            customer,
            items: [{ product: 'Silver Ring', sku: `${marker}-RING2`, qty: 1, price: 5000 }],
          })
          assert.equal(createdE.status, 200, JSON.stringify(createdE.body))
          allBookingIds.push(createdE.body.id)
          const statusOk = await call(adminId, 'PATCH', `/db/bookings/${createdE.body.id}`, { status: 'processing' })
          assert.equal(statusOk.status, 200, JSON.stringify(statusOk.body))
          assert.equal(statusOk.body.status, 'processing')
          const cancelled = await call(adminId, 'PATCH', `/db/sales-orders/${createdE.body.id}/status`, { status: 'cancelled' })
          assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
          assert.equal(cancelled.body.status, 'cancelled')
          const convCancelled = await call(adminId, 'POST', `/db/bookings/${createdE.body.id}/convert`)
          assert.equal(convCancelled.status, 400, 'a cancelled booking cannot be converted over HTTP either')
          assert.match(String(convCancelled.body.error), /cancelled/, 'the refusal says why')
          const badStatus = await call(adminId, 'PATCH', `/db/sales-orders/${createdE.body.id}/status`, { status: 'nope' })
          assert.equal(badStatus.status, 400, 'an unknown status value is rejected outright')

          // Cancellation never deletes money or records: bookings and their
          // payments/timeline all survive.
          const keptPayments = await db!.select().from(schema.payments)
          assert.ok(keptPayments.length >= 2, 'cancel removed no payment rows')

          // ═══ Stock guard: a conversion can never drive inventory negative ═══
          // Every scenario gets its OWN product, so each starts exactly where
          // its fixture put it (creating a booking never moves stock — proven
          // above) and no scenario can interfere with another.
          const { applyStockMovement } = await import('./stock')
          const { createInvoiceForOrderRow } = await import('./orderEmailIngest')

          const mkProduct = async (suffix: string, stock: number) => {
            const id = `${marker}-${suffix}`
            const sku = `${marker}-${suffix}`
            await db!.insert(schema.products).values({
              id,
              name: `Stock fixture ${suffix}`,
              sku,
              category: 'Tests',
              stock,
            })
            stockProductIds.push(id)
            return { id, sku }
          }

          const mkBooking = async (opts: {
            suffix: string
            lines: Array<{ title: string; sku: string; qty: number; price: number; productId?: string; variantId?: string }>
            advance?: number
            locationId?: string
          }) => {
            const id = `${marker}-${opts.suffix}`
            const value = Math.round(opts.lines.reduce((a, l) => a + l.qty * l.price, 0) * 100) / 100
            await db!.insert(schema.salesOrders).values({
              id,
              internalId: `BK-${marker}-${opts.suffix}`,
              customer,
              value,
              payment: 'pending',
              fulfillment: 'pending',
              status: 'confirmed',
              date: new Date().toISOString(),
              items: opts.lines.reduce((a, l) => a + l.qty, 0),
              tags: 'booking',
              currency: 'INR',
              discount: 0,
              lineItems: opts.lines.map((l) => ({
                title: l.title,
                sku: l.sku,
                quantity: l.qty,
                price: l.price,
                ...(l.productId ? { productId: l.productId } : {}),
                ...(l.variantId ? { variantId: l.variantId } : {}),
              })),
              isBooking: true,
              advancePaid: opts.advance ?? 0,
              ...(opts.locationId ? { locationId: opts.locationId } : {}),
            })
            allBookingIds.push(id)
            return id
          }

          const stockOf = async (productId: string) => {
            const [p] = await db!
              .select({ stock: schema.products.stock })
              .from(schema.products)
              .where(eq(schema.products.id, productId))
            return Number(p?.stock ?? NaN)
          }

          const hasConvertedEvent = async (orderId: string) => {
            const evs = await db!.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, orderId))
            return evs.some((e) => e.event === 'Booking Converted')
          }

          // ── 1) Available 5, booking 20 → BLOCKED, with full detail. ───────
          const toy20 = await mkProduct('s20', 5)
          const b20 = await mkBooking({
            suffix: 's20',
            lines: [{ title: 'Silver toy — Big order', sku: toy20.sku, qty: 20, price: 500 }],
            advance: 1000,
          })
          const paymentsBeforeB20 = (await db!.select().from(schema.payments)).length
          const blocked20 = await convertBookingToInvoice(b20)
          assert.equal(blocked20.ok, false, '20 against 5 must be refused')
          assert.equal(blocked20.ok === false && blocked20.status, 409, 'a shortfall is a 409, not a 500')
          const detail20 = blocked20.ok === false ? blocked20.stock?.products[0] : undefined
          assert.ok(detail20, 'the refusal carries per-product detail')
          assert.equal(detail20!.sku, toy20.sku, 'names the SKU (variant SKUs resolve to their variant)')
          assert.equal(detail20!.name, 'Silver toy — Big order', 'product name and variant travel to the client')
          assert.equal(detail20!.available, 5)
          assert.equal(detail20!.requested, 20)
          assert.equal(detail20!.shortage, 15, 'shortage = required − available')

          // Nothing partial happened: stock, invoice, advance, timeline,
          // payments and the customer link are exactly as they were.
          assert.equal(await stockOf(toy20.id), 5, 'no stock was deducted')
          const rowB20 = await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, b20)).limit(1)
          assert.equal(rowB20[0].invoice, null, 'no invoice was raised')
          assert.equal(rowB20[0].status, 'confirmed', 'the booking status is untouched')
          assert.equal(Number(rowB20[0].advancePaid), 1000, 'the advance stays recorded on the booking')
          assert.equal(await hasConvertedEvent(b20), false, 'no "Booking Converted" timeline entry')
          assert.equal(
            (await db!.select().from(schema.payments)).length,
            paymentsBeforeB20,
            'no payment row was created for the failed conversion',
          )
          const customersAfterFail = await db!.select().from(schema.customers).where(eq(schema.customers.email, 'priya.sharma@example.com'))
          assert.equal(customersAfterFail.length, 1, 'the customer link survives the refusal')

          // The same refusal over HTTP: the standard 409 payload the UI reads.
          const httpBlocked = await call(adminId, 'POST', `/db/bookings/${b20}/convert`)
          assert.equal(httpBlocked.status, 409, JSON.stringify(httpBlocked.body))
          assert.equal(httpBlocked.body.code, 'INSUFFICIENT_STOCK')
          assert.equal(httpBlocked.body.error, 'Insufficient Stock')
          const httpDetail = httpBlocked.body.products?.[0]
          assert.ok(httpDetail, 'the 409 body carries products[]')
          assert.equal(httpDetail.sku, toy20.sku)
          assert.equal(httpDetail.name, 'Silver toy — Big order')
          assert.equal(httpDetail.available, 5)
          assert.equal(httpDetail.requested, 20)
          assert.equal(httpDetail.shortage, 15)
          assert.equal(await stockOf(toy20.id), 5, 'the retried conversion still moves nothing')

          // ── 2) Available 5, booking 5 → succeeds; stock lands on 0. ───────
          const toy5 = await mkProduct('s5', 5)
          const b5 = await mkBooking({ suffix: 's5', lines: [{ title: 'Silver toy', sku: toy5.sku, qty: 5, price: 400 }] })
          const ok5 = await convertBookingToInvoice(b5)
          assert.ok(ok5.ok, JSON.stringify(ok5))
          assert.equal(await stockOf(toy5.id), 0, 'exact fit converts and empties the balance')

          // ── 3) Available 5, booking 3 → succeeds; stock lands on 2. ───────
          const toy3 = await mkProduct('s3', 5)
          const b3 = await mkBooking({ suffix: 's3', lines: [{ title: 'Silver toy', sku: toy3.sku, qty: 3, price: 400 }] })
          const ok3 = await convertBookingToInvoice(b3)
          assert.ok(ok3.ok, JSON.stringify(ok3))
          assert.equal(await stockOf(toy3.id), 2, 'a partial draw converts and leaves the rest')

          // ── 4) Multiple products: ONE short line blocks the WHOLE basket. ─
          const multi1 = await mkProduct('m1', 5)
          const multi2 = await mkProduct('m2', 5)
          const bMulti = await mkBooking({
            suffix: 'multi',
            lines: [
              { title: 'Ring', sku: multi1.sku, qty: 3, price: 300 },
              { title: 'Chain', sku: multi2.sku, qty: 7, price: 300 },
            ],
          })
          const blockedMulti = await convertBookingToInvoice(bMulti)
          assert.equal(blockedMulti.ok, false, 'the second short line refuses the entire conversion')
          const shortSkus = blockedMulti.ok === false ? (blockedMulti.stock?.products ?? []).map((p) => p.sku).sort() : []
          assert.deepEqual(shortSkus, [multi2.sku], 'only the short product is reported')
          assert.equal(await stockOf(multi1.id), 5, 'the SUFFICIENT line was not deducted either (no partial conversion)')
          assert.equal(await stockOf(multi2.id), 5)
          const rowMulti = await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, bMulti)).limit(1)
          assert.equal(rowMulti[0].invoice, null)

          // ── 5) Variant-specific stock: Red is short while White has it. ───
          const parent = await mkProduct('vpar', 8)
          await db!.insert(schema.productVariants).values([
            { id: `${marker}-vred`, productId: parent.id, title: 'Red', optionValues: ['Red'], sku: `${marker}-VRED`, stock: 3 },
            { id: `${marker}-vwhite`, productId: parent.id, title: 'White', optionValues: ['White'], sku: `${marker}-VWHITE`, stock: 5 },
          ])
          const bRed = await mkBooking({
            suffix: 'vred',
            lines: [{ title: 'Silver toy — Red', sku: `${marker}-VRED`, qty: 5, price: 300, productId: parent.id, variantId: `${marker}-vred` }],
          })
          const blockedRed = await convertBookingToInvoice(bRed)
          assert.equal(blockedRed.ok, false, 'Red must answer for RED stock, not the parent total')
          const redDetail = blockedRed.ok === false ? blockedRed.stock?.products[0] : undefined
          assert.equal(redDetail?.available, 3, "Red's own balance (the parent holds 8 across both variants)")
          assert.equal(redDetail?.requested, 5)
          assert.equal(redDetail?.shortage, 2)
          assert.equal(await stockOf(parent.id), 8, 'the parent total is untouched after the refusal')

          const bWhite = await mkBooking({
            suffix: 'vwhite',
            lines: [{ title: 'Silver toy — White', sku: `${marker}-VWHITE`, qty: 5, price: 300, productId: parent.id, variantId: `${marker}-vwhite` }],
          })
          const okWhite = await convertBookingToInvoice(bWhite)
          assert.ok(okWhite.ok, 'White has 5 — the same quantity converts against ITS bucket')
          assert.equal(await stockOf(parent.id), 3, "White's five left the parent; Red's three remain")

          // ── 6) Location-specific stock: validate WHERE the goods leave. ───
          await db!.insert(schema.inventoryLocations).values({ id: stockLocationId, name: `${marker} Counter`, type: 'store' })
          // Default store (pre-ledger adoption): 5 on hand, booking of 3 works…
          const locDefault = await mkProduct('ldef', 5)
          const bLocDefault = await mkBooking({ suffix: 'ldef', lines: [{ title: 'Toy', sku: locDefault.sku, qty: 3, price: 200 }] })
          const okLocDefault = await convertBookingToInvoice(bLocDefault)
          assert.ok(okLocDefault.ok, JSON.stringify(okLocDefault))
          assert.equal(await stockOf(locDefault.id), 2, 'the default store drew its own balance')
          // …but the SAME product has nothing at the counter, so a booking
          // selling from there is refused even though the rollup says 2.
          const bLocCounter = await mkBooking({
            suffix: 'ldef2',
            lines: [{ title: 'Toy', sku: locDefault.sku, qty: 2, price: 200 }],
            locationId: stockLocationId,
          })
          const blockedLoc = await convertBookingToInvoice(bLocCounter)
          assert.equal(blockedLoc.ok, false, 'a branch with no stock cannot sell it')
          const locDetail = blockedLoc.ok === false ? blockedLoc.stock?.products[0] : undefined
          assert.equal(locDetail?.available, 0, 'checked against the counter balance, not products.stock')
          assert.equal(await stockOf(locDefault.id), 2, 'the default store balance is untouched')

          // Stock that genuinely sits at the counter converts from the counter.
          const locCounter = await mkProduct('lctr', 0)
          await applyStockMovement({
            sku: locCounter.sku,
            qty: 5,
            type: 'purchase_in',
            refType: 'test',
            locationId: stockLocationId,
          })
          const bLocCtr = await mkBooking({
            suffix: 'lctr',
            lines: [{ title: 'Toy', sku: locCounter.sku, qty: 3, price: 200 }],
            locationId: stockLocationId,
          })
          const okLocCtr = await convertBookingToInvoice(bLocCtr)
          assert.ok(okLocCtr.ok, JSON.stringify(okLocCtr))
          const counterLevel = await db!
            .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
            .from(schema.stockLevels)
            .where(
              and(
                eq(schema.stockLevels.productId, locCounter.id),
                eq(schema.stockLevels.locationId, stockLocationId),
              ),
            )
          assert.equal(Math.floor(Number(counterLevel[0]?.qty ?? 0)), 2, 'the counter drew its own bucket')

          // ── 7) Sales Order → invoice uses the SAME guard (no regression). ─
          const soProduct = await mkProduct('so1', 5)
          await db!.insert(schema.salesOrders).values({
            id: `${marker}-mo`,
            shopifyId: `MO-${marker}`,
            internalId: `MO-${marker}`,
            customer,
            value: 1500,
            payment: 'pending',
            fulfillment: 'unfulfilled',
            status: 'confirmed',
            date: new Date().toISOString(),
            discount: 0,
            tags: 'manual-order',
            lineItems: [{ title: 'Stock fixture so1', sku: soProduct.sku, quantity: 6, price: 250, weight: 0, silverRate: 0, amount: 1500 }],
          })
          const [soRow] = await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, `${marker}-mo`)).limit(1)
          await assert.rejects(
            () => createInvoiceForOrderRow(soRow!),
            (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'INSUFFICIENT_STOCK',
            'a sales order short of stock is refused by the same guard',
          )
          assert.equal(await stockOf(soProduct.id), 5, 'the refused order moved no stock')
          const noInvoice = await db!
            .select({ id: schema.salesInvoices.id })
            .from(schema.salesInvoices)
            .where(eq(schema.salesInvoices.number, `MO-${marker}`))
          assert.equal(noInvoice.length, 0, 'no invoice exists for the refused order')
          const [refused] = await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, `${marker}-mo`)).limit(1)
          assert.equal(refused!.invoice, null, 'the refused attempt left the order claim rolled back')

          // …and once stock suffices, the SAME order invoices normally —
          // proving the guard blocks rather than breaks the workflow.
          await applyStockMovement({ sku: soProduct.sku, qty: 2, type: 'purchase_in', refType: 'test' })
          const soInvoice = await createInvoiceForOrderRow(soRow!)
          assert.ok(soInvoice, 'the same order converts once stock suffices')
          assert.equal(await stockOf(soProduct.id), 1, '7 on hand − 6 sold = 1')
          allBookingIds.push(`${marker}-mo`)

          // ── 8) Concurrency: two conversions cannot oversell the same stock. ─
          const race = await mkProduct('race', 5)
          const bRaceA = await mkBooking({ suffix: 'raceA', lines: [{ title: 'Raced', sku: race.sku, qty: 3, price: 100 }] })
          const bRaceB = await mkBooking({ suffix: 'raceB', lines: [{ title: 'Raced', sku: race.sku, qty: 3, price: 100 }] })
          const [raceA, raceB] = await Promise.all([
            convertBookingToInvoice(bRaceA),
            convertBookingToInvoice(bRaceB),
          ])
          const results = [raceA, raceB]
          const winner = results.find((r) => r.ok)
          const loser = results.find((r) => !r.ok)
          if (!winner || !winner.ok) assert.fail('exactly one concurrent conversion must win')
          if (!loser || loser.ok) assert.fail('the other conversion must be refused')
          assert.equal(loser.status, 409, 'the loser is refused on stock, not crash-merged')
          assert.equal(await stockOf(race.id), 2, '5 − 3 = 2: the race never drives stock negative')
          const raceOrders = await db!
            .select({ id: schema.salesOrders.id, invoice: schema.salesOrders.invoice })
            .from(schema.salesOrders)
            .where(inArray(schema.salesOrders.id, [bRaceA, bRaceB]))
          const invoiced = raceOrders.filter((o) => o.invoice)
          assert.equal(invoiced.length, 1, 'exactly one of the two bookings was invoiced')
          assert.equal(invoiced[0].id, winner.orderId, 'the invoice belongs to the winning conversion')
          const loserOrder = raceOrders.find((o) => o.id !== winner.orderId)
          assert.equal(loserOrder?.invoice, null, 'the loser booking stays un-invoiced, advance intact')

          // ═══ Bookings Phase 1: variant persistence + location-wise stock ═══
          // Fixture: one product, two variants, stock split across BOTH stores
          // through the real ledger (Red 5 @ Main + 2 @ counter, White 1 @ Main).
          const ph1 = await mkProduct('ph1', 0)
          await db!.insert(schema.productVariants).values([
            { id: `${marker}-ph1red`, productId: ph1.id, title: 'red', optionValues: ['red'], sku: `${marker}-PH1-RED`, stock: 0 },
            { id: `${marker}-ph1wht`, productId: ph1.id, title: 'white', optionValues: ['white'], sku: `${marker}-PH1-WHT`, stock: 0 },
          ])
          await applyStockMovement({ sku: `${marker}-PH1-RED`, qty: 5, type: 'purchase_in', refType: 'test' })
          await applyStockMovement({ sku: `${marker}-PH1-RED`, qty: 2, type: 'purchase_in', refType: 'test', locationId: stockLocationId })
          await applyStockMovement({ sku: `${marker}-PH1-WHT`, qty: 1, type: 'purchase_in', refType: 'test' })

          // ── Location-wise availability API: one row per store, variant-scoped.
          const redAvail = await call(adminId, 'GET', `/db/bookings/stock-by-location?productId=${ph1.id}&variantId=${marker}-ph1red`)
          assert.equal(redAvail.status, 200, JSON.stringify(redAvail.body))
          const redLocations = redAvail.body.locations as Array<{ locationId: string; name: string; available: number }>
          const redMain = redLocations.find((l) => l.locationId === 'LOC-DEFAULT')
          const redCounter = redLocations.find((l) => l.locationId === stockLocationId)
          assert.equal(redLocations.length, 2, 'one row per store — nothing silently merged')
          assert.equal(redLocations[0].locationId, 'LOC-DEFAULT', 'the default store is listed first')
          assert.equal(redMain?.available, 5, 'variant stock at its own store')
          assert.equal(redCounter?.available, 2, 'the SAME variant at the counter — separate buckets')
          assert.equal(redAvail.body.combined, 7, 'combined = sum of the listed stores (informational only)')

          const whiteAvail = await call(adminId, 'GET', `/db/bookings/stock-by-location?productId=${ph1.id}&variantId=${marker}-ph1wht`)
          assert.equal(whiteAvail.status, 200, JSON.stringify(whiteAvail.body))
          const whiteLocations = whiteAvail.body.locations as Array<{ locationId: string; name: string; available: number }>
          assert.equal(whiteLocations.find((l) => l.locationId === 'LOC-DEFAULT')?.available, 1, "White's own bucket at Main")
          assert.equal(whiteLocations.find((l) => l.locationId === stockLocationId)?.available, 0, 'White holds none at the counter')
          assert.equal(whiteAvail.body.combined, 1)

          // Without a variant: the product balance AT EACH STORE (5+1 / 2) —
          // still location-wise, never the global mirror alone.
          const parentAvail = await call(adminId, 'GET', `/db/bookings/stock-by-location?productId=${ph1.id}`)
          assert.equal(parentAvail.status, 200, JSON.stringify(parentAvail.body))
          const parentLocations = parentAvail.body.locations as Array<{ locationId: string; available: number }>
          assert.equal(parentLocations.find((l) => l.locationId === 'LOC-DEFAULT')?.available, 6, 'sum of BOTH variants at Main')
          assert.equal(parentLocations.find((l) => l.locationId === stockLocationId)?.available, 2)
          assert.equal(parentAvail.body.combined, 8)

          // A product that has never entered the ledger: the default store
          // shows its pre-ledger balance (exactly what a conversion would
          // validate there), other stores honestly show 0.
          const ph2 = await mkProduct('ph2', 3)
          const adoptionAvail = await call(adminId, 'GET', `/db/bookings/stock-by-location?productId=${ph2.id}`)
          assert.equal(adoptionAvail.status, 200, JSON.stringify(adoptionAvail.body))
          const adoptionLocations = adoptionAvail.body.locations as Array<{ locationId: string; available: number }>
          assert.equal(adoptionLocations.find((l) => l.locationId === 'LOC-DEFAULT')?.available, 3, 'default store adopts the pre-ledger balance')
          assert.equal(adoptionLocations.find((l) => l.locationId === stockLocationId)?.available, 0, 'no stock was ever recorded at the counter')
          assert.equal(adoptionAvail.body.combined, 3)

          // Contract errors: missing product, unknown product, foreign variant.
          assert.equal((await call(adminId, 'GET', '/db/bookings/stock-by-location')).status, 400)
          assert.equal((await call(adminId, 'GET', '/db/bookings/stock-by-location?productId=nope')).status, 404)
          const foreignVariant = await call(
            adminId,
            'GET',
            `/db/bookings/stock-by-location?productId=${parent.id}&variantId=${marker}-ph1red`,
          )
          assert.equal(foreignVariant.status, 404, 'a variant of ANOTHER product cannot be asked for')
          // Availability reads at the same right the bookings list itself needs.
          const viewerAvail = await call(viewerId, 'GET', `/db/bookings/stock-by-location?productId=${ph1.id}`)
          assert.equal(viewerAvail.status, 200, 'sales.view reads availability')

          // ── Persistence: exact product id, variant id, VARIANT sku, agreed
          //    price, multiple lines — and creating/editing moves NO stock. ──
          const ph1StockBeforeCreate = await stockOf(ph1.id)
          const phase1Booking = await call(adminId, 'POST', '/db/bookings', {
            customer,
            email: 'priya.sharma@example.com',
            items: [
              { product: 'Silver toy — red', sku: `${marker}-PH1-RED`, qty: 10, price: 999.5, productId: ph1.id, variantId: `${marker}-ph1red` },
              { product: 'Silver toy — white', sku: `${marker}-PH1-WHT`, qty: 1, price: 450.25, productId: ph1.id, variantId: `${marker}-ph1wht` },
            ],
            advanceAmount: 500,
            gst: 3,
          })
          assert.equal(phase1Booking.status, 200, JSON.stringify(phase1Booking.body))
          allBookingIds.push(phase1Booking.body.id)
          const ph1Lines = phase1Booking.body.lineItems as Array<Record<string, unknown>>
          assert.equal(ph1Lines.length, 2, 'multiple product/variant lines in one booking')
          assert.equal(ph1Lines[0].productId, ph1.id, 'exact product id persisted')
          assert.equal(ph1Lines[0].variantId, `${marker}-ph1red`, 'exact variant id persisted')
          assert.equal(ph1Lines[0].sku, `${marker}-PH1-RED`, 'the VARIANT sku is stored, never the parent sku')
          assert.equal(ph1Lines[0].price, 999.5, 'the AGREED booking price is stored exactly as entered')
          assert.equal(ph1Lines[0].quantity, 10, 'books MORE than the main store holds — booking never blocks on stock')
          assert.equal(ph1Lines[1].productId, ph1.id)
          assert.equal(ph1Lines[1].variantId, `${marker}-ph1wht`)
          assert.equal(ph1Lines[1].sku, `${marker}-PH1-WHT`)
          assert.equal(ph1Lines[1].price, 450.25)
          assert.equal(await stockOf(ph1.id), ph1StockBeforeCreate, 'CREATING a variant booking deducted no stock')

          const patchedPh1 = await call(adminId, 'PATCH', `/db/bookings/${phase1Booking.body.id}`, {
            items: [
              { product: 'Silver toy — red', sku: `${marker}-PH1-RED`, qty: 10, price: 999.5, productId: ph1.id, variantId: `${marker}-ph1red` },
              { product: 'Silver toy — white', sku: `${marker}-PH1-WHT`, qty: 1, price: 450.25, productId: ph1.id, variantId: `${marker}-ph1wht` },
            ],
            advanceAmount: 500,
          })
          assert.equal(patchedPh1.status, 200, JSON.stringify(patchedPh1.body))
          const patchedLines = patchedPh1.body.lineItems as Array<Record<string, unknown>>
          assert.equal(patchedLines[0].variantId, `${marker}-ph1red`, 'variant selection survives an edit round-trip')
          assert.equal(patchedLines[0].sku, `${marker}-PH1-RED`)
          assert.equal(patchedLines[0].price, 999.5, 'editing never re-prices the agreed line')
          assert.equal(patchedLines[1].variantId, `${marker}-ph1wht`)
          assert.equal(await stockOf(ph1.id), ph1StockBeforeCreate, 'EDITING a variant booking deducted no stock')

          // ═══ Bookings Phase 2: single-store booking ═══
          // (a) A NEW booking defaults to the DEFAULT store — the behaviour
          //     every booking has always had — and reserves nothing.
          const p2 = await mkProduct('p2', 0)
          await applyStockMovement({ sku: p2.sku, qty: 3, type: 'purchase_in', refType: 'test' })
          const defaultBooking = await call(adminId, 'POST', '/db/bookings', {
            customer,
            items: [{ product: 'Phase two default', sku: p2.sku, qty: 1, price: 300 }],
            // deliberately NO locationId — the API must resolve the default
          })
          assert.equal(defaultBooking.status, 200, JSON.stringify(defaultBooking.body))
          allBookingIds.push(defaultBooking.body.id)
          assert.equal(defaultBooking.body.locationId, 'LOC-DEFAULT', 'a new booking without a store defaults to the default store')
          assert.equal(await stockOf(p2.id), 3, 'default-store booking creation reserved/deducted nothing')

          // (b) Selecting a different store persists verbatim.
          const counterBooking = await call(adminId, 'POST', '/db/bookings', {
            customer,
            items: [{ product: 'Phase two counter', sku: p2.sku, qty: 1, price: 300 }],
            locationId: stockLocationId,
          })
          assert.equal(counterBooking.status, 200, JSON.stringify(counterBooking.body))
          allBookingIds.push(counterBooking.body.id)
          assert.equal(counterBooking.body.locationId, stockLocationId, 'the selected store round-trips')

          // (c) Editing and reopening preserve the store; an explicit change
          //     works; an UNKNOWN store is refused rather than substituted.
          const editKeep = await call(adminId, 'PATCH', `/db/bookings/${counterBooking.body.id}`, { advanceAmount: 100 })
          assert.equal(editKeep.status, 200, JSON.stringify(editKeep.body))
          assert.equal(editKeep.body.locationId, stockLocationId, 'an edit that does not touch the store keeps it')
          const reopened = await call(adminId, 'GET', '/db/bookings')
          const reopenedRow = (reopened.body.data as Array<Record<string, unknown>>).find((r) => r.id === counterBooking.body.id)
          assert.ok(reopenedRow, 'the booking is still listed (what reopening the form reads)')
          assert.equal(reopenedRow!.locationId, stockLocationId, 'the reopened booking shows the same store')
          const switched = await call(adminId, 'PATCH', `/db/bookings/${counterBooking.body.id}`, { locationId: 'LOC-DEFAULT' })
          assert.equal(switched.body.locationId, 'LOC-DEFAULT', 'the selling store can be changed explicitly')
          const unknownStore = await call(adminId, 'POST', '/db/bookings', {
            customer,
            locationId: `${marker}-no-such-store`,
            items: [{ product: 'Ghost store', sku: p2.sku, qty: 1, price: 100 }],
          })
          assert.equal(unknownStore.status, 400, 'an unknown store is refused — never silently redirected')

          // (d) Variant stock validates at the SELECTED store only: Red has 5
          //     at Main and 2 at the counter — a counter booking of 5 fails
          //     against 2 even though Main could cover it.
          const blockedAtCounter = await mkBooking({
            suffix: 'p2blocked',
            locationId: stockLocationId,
            lines: [{ title: 'Silver toy — red', sku: `${marker}-PH1-RED`, qty: 5, price: 300, productId: ph1.id, variantId: `${marker}-ph1red` }],
          })
          const blockedRes = await convertBookingToInvoice(blockedAtCounter)
          assert.equal(blockedRes.ok, false, 'the selected store is short → conversion blocked')
          const blockedDetail = blockedRes.ok === false ? blockedRes.stock?.products[0] : undefined
          assert.equal(blockedDetail?.available, 2, "the COUNTER's own Red balance is what counts (Main's 5 never pools in)")
          assert.equal(blockedDetail?.shortage, 3)
          assert.equal(blockedDetail?.locationId, stockLocationId, 'the refusal names the store it measured')
          assert.equal(await stockOf(ph1.id), 8, 'the refused conversion moved no stock')

          // …and the availability API agrees with what conversion measured.
          const redAtCounter = await call(adminId, 'GET', `/db/bookings/stock-by-location?productId=${ph1.id}&variantId=${marker}-ph1red`)
          const counterRow = (redAtCounter.body.locations as Array<{ locationId: string; available: number }>)
            .find((l) => l.locationId === stockLocationId)
          assert.equal(counterRow?.available, 2, 'display and validation read the same store balance')
          // The same refusal over HTTP names the store for the UI.
          const httpStoreBlocked = await call(adminId, 'POST', `/db/bookings/${blockedAtCounter}/convert`)
          assert.equal(httpStoreBlocked.status, 409, JSON.stringify(httpStoreBlocked.body))
          assert.equal(httpStoreBlocked.body.location?.id, stockLocationId)
          assert.equal(httpStoreBlocked.body.location?.name, `${marker} Counter`, 'the 409 names the selected store')
          assert.equal(httpStoreBlocked.body.products?.[0]?.location, `${marker} Counter`, 'each short line carries the store name')

          // Conversion succeeds when the SELECTED store itself has enough:
          // exactly 2 Red at the counter → converts, and ONLY the counter moves.
          const okAtCounter = await mkBooking({
            suffix: 'p2ok',
            locationId: stockLocationId,
            lines: [{ title: 'Silver toy — red', sku: `${marker}-PH1-RED`, qty: 2, price: 300, productId: ph1.id, variantId: `${marker}-ph1red` }],
          })
          const okCounterRes = await convertBookingToInvoice(okAtCounter)
          assert.ok(okCounterRes.ok, JSON.stringify(okCounterRes))
          const levelWhere = async (locationId: string) => {
            const [row] = await db!
              .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
              .from(schema.stockLevels)
              .where(and(eq(schema.stockLevels.productId, ph1.id), eq(schema.stockLevels.locationId, locationId)))
            return Math.floor(Number(row?.qty ?? 0))
          }
          assert.equal(await levelWhere(stockLocationId), 0, 'the selected store was drawn down')
          assert.equal(await levelWhere('LOC-DEFAULT'), 6, 'Main Store was NOT touched (Red 5 + White 1 still there)')
          assert.equal(await stockOf(ph1.id), 6, 'variant mirror follows the counter deduction only')

          // (e) LEGACY bookings (location_id NULL) keep converting against the
          //     DEFAULT store — never pooling other stores' stock.
          const legacyProduct = await mkProduct('p2legacy', 0)
          await applyStockMovement({ sku: legacyProduct.sku, qty: 4, type: 'purchase_in', refType: 'test', locationId: stockLocationId })
          const legacyBooking = await mkBooking({
            suffix: 'p2legacy',
            lines: [{ title: 'Legacy line', sku: legacyProduct.sku, qty: 1, price: 100 }],
            // no locationId — exactly what a pre-Phase-2 booking carries
          })
          const legacyRow = await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, legacyBooking)).limit(1)
          assert.equal(legacyRow[0].locationId, null, 'the legacy booking really carries NULL')
          // An unrelated edit must NOT rewrite the legacy NULL into a default
          // id — historical rows keep the location they were created with.
          const legacyEdit = await call(adminId, 'PATCH', `/db/bookings/${legacyBooking}`, { advanceAmount: 10 })
          assert.equal(legacyEdit.status, 200, JSON.stringify(legacyEdit.body))
          assert.equal(legacyEdit.body.locationId, null, 'editing without picking a store leaves the legacy NULL untouched')
          const legacyRes = await convertBookingToInvoice(legacyBooking)
          assert.equal(legacyRes.ok, false, 'legacy rows validate at the default store, not where the stock happens to sit')
          const legacyDetail = legacyRes.ok === false ? legacyRes.stock?.products[0] : undefined
          assert.equal(legacyDetail?.locationId, 'LOC-DEFAULT', 'NULL resolves to the default store — its historical behaviour')
          assert.equal(legacyDetail?.available, 0, "the counter's 4 units never satisfy a legacy booking")
          assert.equal(await stockOf(legacyProduct.id), 4, 'the refused legacy conversion moved nothing')

          // ═══ Bookings Phase 3: explicit multi-store allocation ═══
          // Fixture: two variants — Red 5 @ Main + 5 @ counter, White 3 @ Main.
          const ap = await mkProduct('palloc', 0)
          await db!.insert(schema.productVariants).values([
            { id: `${marker}-palar`, productId: ap.id, title: 'red', optionValues: ['red'], sku: `${marker}-PALR`, stock: 0 },
            { id: `${marker}-palw`, productId: ap.id, title: 'white', optionValues: ['white'], sku: `${marker}-PALW`, stock: 0 },
          ])
          await applyStockMovement({ sku: `${marker}-PALR`, qty: 5, type: 'purchase_in', refType: 'test' })
          await applyStockMovement({ sku: `${marker}-PALR`, qty: 5, type: 'purchase_in', refType: 'test', locationId: stockLocationId })
          await applyStockMovement({ sku: `${marker}-PALW`, qty: 3, type: 'purchase_in', refType: 'test' })
          assert.equal(await stockOf(ap.id), 13, 'fixture: 10 Red + 3 White across both stores')

          const getAlloc = (id: string) => call(adminId, 'GET', `/db/bookings/${id}/allocations`)
          const putAlloc = (id: string, items: unknown) =>
            call(adminId, 'PUT', `/db/bookings/${id}/allocations`, { items })

          // ── (1) One-store allocation: a full split at a single store. ────
          const bOne = await mkBooking({
            suffix: 'p3one',
            lines: [{ title: 'Silver toy — red', sku: `${marker}-PALR`, qty: 5, price: 300, productId: ap.id, variantId: `${marker}-palar` }],
          })
          const putOne = await putAlloc(bOne, [{ lineIndex: 0, productId: ap.id, variantId: `${marker}-palar`, sku: `${marker}-PALR`, locationId: 'LOC-DEFAULT', quantity: 5 }])
          assert.equal(putOne.status, 200, JSON.stringify(putOne.body))
          assert.equal(putOne.body.status, 'fully', 'one store covering the whole line = fully allocated')
          const oneLine = putOne.body.lines[0]
          assert.equal(oneLine.allocated, 5)
          assert.equal(oneLine.remaining, 0)
          assert.equal(await stockOf(ap.id), 13, 'creating an allocation moved no stock')

          // ── (2) Multi-store allocation: the 5 + 5 example. ────────────────
          const p3Split = await mkBooking({
            suffix: 'p3multi',
            lines: [{ title: 'Silver toy — red', sku: `${marker}-PALR`, qty: 10, price: 300, productId: ap.id, variantId: `${marker}-palar` }],
          })
          const putMulti = await putAlloc(p3Split, [
            { lineIndex: 0, productId: ap.id, variantId: `${marker}-palar`, sku: `${marker}-PALR`, locationId: 'LOC-DEFAULT', quantity: 5 },
            { lineIndex: 0, productId: ap.id, variantId: `${marker}-palar`, sku: `${marker}-PALR`, locationId: stockLocationId, quantity: 5 },
          ])
          assert.equal(putMulti.status, 200, JSON.stringify(putMulti.body))
          assert.equal(putMulti.body.status, 'fully', '10 required = 5 + 5 across two stores')
          assert.equal(putMulti.body.allocations.length, 2, 'one row per line per store')
          const splitListed = await call(adminId, 'GET', '/db/bookings')
          const listedMulti = (splitListed.body.data as Array<Record<string, unknown>>).find((r) => r.id === p3Split)
          assert.equal(listedMulti?.allocated, 10, 'the list shows the computed allocation total')

          // ── (3) Identity: an allocation can never move to an unrelated
          //      variant/product, and a rejected payload changes nothing. ───
          const wrongVariant = await putAlloc(p3Split, [
            { lineIndex: 0, productId: ap.id, variantId: `${marker}-palw`, sku: `${marker}-PALW`, locationId: 'LOC-DEFAULT', quantity: 5 },
          ])
          assert.equal(wrongVariant.status, 400, JSON.stringify(wrongVariant.body))
          assert.match(String(wrongVariant.body.error), /variant does not match/, 'a different variant is refused')
          const wrongProduct = await putAlloc(p3Split, [
            { lineIndex: 0, productId: 'not-the-product', locationId: 'LOC-DEFAULT', quantity: 5 },
          ])
          assert.equal(wrongProduct.status, 400)
          assert.match(String(wrongProduct.body.error), /product does not match/)
          const afterIdentityFail = await getAlloc(p3Split)
          assert.equal(afterIdentityFail.body.allocations.length, 2, 'the rejected payloads left the plan untouched')
          assert.equal(afterIdentityFail.body.status, 'fully')

          // ── (4) Required quantity: over refused, partial allowed, clear works. ──
          const overAlloc = await putAlloc(p3Split, [
            { lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: 6 },
            { lineIndex: 0, locationId: stockLocationId, quantity: 5 },
          ])
          assert.equal(overAlloc.status, 400, JSON.stringify(overAlloc.body))
          assert.match(String(overAlloc.body.error), /exceeds the booked line/)
          assert.deepEqual(overAlloc.body.details?.[0], { lineIndex: 0, sku: `${marker}-PALR`, required: 10, allocated: 11 })
          assert.equal((await getAlloc(p3Split)).body.allocations.length, 2, 'over-allocation wrote nothing')
          const partial = await putAlloc(p3Split, [{ lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: 4 }])
          assert.equal(partial.status, 200, JSON.stringify(partial.body))
          assert.equal(partial.body.status, 'partial')
          assert.equal(partial.body.lines[0].remaining, 6, 'remaining unallocated quantity is tracked')
          const clearedPlan = await putAlloc(p3Split, [])
          assert.equal(clearedPlan.status, 200)
          assert.equal(clearedPlan.body.status, 'unallocated', 'an empty set clears the plan')
          assert.equal(clearedPlan.body.allocations.length, 0)

          // ── (5) Never more than the STORE holds (no combined stock). ──────
          const overStore = await putAlloc(p3Split, [
            { lineIndex: 0, productId: ap.id, variantId: `${marker}-palar`, sku: `${marker}-PALR`, locationId: stockLocationId, quantity: 6 },
          ])
          assert.equal(overStore.status, 409, JSON.stringify(overStore.body))
          assert.equal(overStore.body.code, 'INSUFFICIENT_STOCK')
          const shortDetail = overStore.body.products?.[0]
          assert.equal(shortDetail?.available, 5, "the counter's own Red balance")
          assert.equal(shortDetail?.requested, 6)
          assert.equal(shortDetail?.shortage, 1)
          assert.equal(shortDetail?.locationId, stockLocationId, 'the refusal names the store')
          assert.equal(shortDetail?.location, `${marker} Counter`, '…by its human name')
          assert.equal((await getAlloc(p3Split)).body.allocations.length, 0, 'the refused save left nothing behind')

          // ── (6) Availability aggregates per bucket across LINES: two lines
          //      of one variant cannot together exceed one store. ────────────
          const bAgg = await mkBooking({
            suffix: 'p3agg',
            lines: [
              { title: 'Silver toy — red', sku: `${marker}-PALR`, qty: 10, price: 300, productId: ap.id, variantId: `${marker}-palar` },
              { title: 'Silver toy — red (again)', sku: `${marker}-PALR`, qty: 5, price: 300, productId: ap.id, variantId: `${marker}-palar` },
            ],
          })
          const aggOver = await putAlloc(bAgg, [
            { lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: 3 },
            { lineIndex: 1, locationId: 'LOC-DEFAULT', quantity: 3 },
          ])
          assert.equal(aggOver.status, 409, JSON.stringify(aggOver.body))
          assert.equal(aggOver.body.products?.[0]?.available, 5, 'Main holds 5 Red — not the 10 held across BOTH stores')
          assert.equal(aggOver.body.products?.[0]?.requested, 6, 'both lines compete for the same store balance')
          assert.equal(aggOver.body.products?.[0]?.shortage, 1)
          const aggOk = await putAlloc(bAgg, [
            { lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: 2 },
            { lineIndex: 1, locationId: 'LOC-DEFAULT', quantity: 3 },
          ])
          assert.equal(aggOk.status, 200, JSON.stringify(aggOk.body))
          assert.equal(aggOk.body.status, 'partial', '5 of 15 booked units allocated in total')

          // ── (7) Redistribution: replace-all leaves EXACTLY the new set. ───
          const setA = await putAlloc(p3Split, [
            { lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: 5 },
            { lineIndex: 0, locationId: stockLocationId, quantity: 5 },
          ])
          assert.equal(setA.status, 200, JSON.stringify(setA.body))
          const setB = await putAlloc(p3Split, [
            { lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: 4 },
            { lineIndex: 0, locationId: stockLocationId, quantity: 5 },
          ])
          assert.equal(setB.status, 200, JSON.stringify(setB.body))
          const redistributed = await getAlloc(p3Split)
          assert.equal(redistributed.body.allocations.length, 2, 'no stale rows survive a redistribution')
          const byStore = new Map((redistributed.body.allocations as Array<{ locationId: string; quantity: number }>).map((a) => [a.locationId, a.quantity]))
          assert.equal(byStore.get('LOC-DEFAULT'), 4, 'Main was reduced 5 → 4 in place')
          assert.equal(byStore.get(stockLocationId), 5)
          assert.equal(redistributed.body.status, 'partial', '9 of 10 allocated after redistribution')

          // ── (8) Allocations never move stock (planning records). ──────────
          assert.equal(await stockOf(ap.id), 13, 'every allocation so far left the ledger untouched')

          // ── (9) Stock drops after allocation → shortage surfaced, and the
          //      SAME plan can no longer be saved until corrected. ──────────
          const bShort = await mkBooking({
            suffix: 'p3short',
            lines: [{ title: 'Silver toy — white', sku: `${marker}-PALW`, qty: 3, price: 300, productId: ap.id, variantId: `${marker}-palw` }],
          })
          const shortPut = await putAlloc(bShort, [
            { lineIndex: 0, productId: ap.id, variantId: `${marker}-palw`, sku: `${marker}-PALW`, locationId: 'LOC-DEFAULT', quantity: 3 },
          ])
          assert.equal(shortPut.status, 200, JSON.stringify(shortPut.body))
          await applyStockMovement({ sku: `${marker}-PALW`, qty: -2, type: 'sale_out', refType: 'test' })
          assert.equal(await stockOf(ap.id), 11, 'an unrelated sale took 2 White at Main')
          const stalePlan = await getAlloc(bShort)
          const whiteAvailability = (stalePlan.body.availability as Array<{ allocationId: string; available: number }>).find(
            (a) => a.allocationId === stalePlan.body.allocations[0]?.id,
          )
          assert.equal(whiteAvailability?.available, 1, 'the stored allocation now shows its CURRENT (short) availability')
          const staleSave = await putAlloc(bShort, [
            { lineIndex: 0, productId: ap.id, variantId: `${marker}-palw`, sku: `${marker}-PALW`, locationId: 'LOC-DEFAULT', quantity: 3 },
          ])
          assert.equal(staleSave.status, 409, 're-saving the now-impossible plan is refused until corrected')
          assert.equal(staleSave.body.products?.[0]?.shortage, 2, 'shortage shown so the user corrects the allocation')
          const corrected = await putAlloc(bShort, [
            { lineIndex: 0, productId: ap.id, variantId: `${marker}-palw`, sku: `${marker}-PALW`, locationId: 'LOC-DEFAULT', quantity: 1 },
          ])
          assert.equal(corrected.status, 200, JSON.stringify(corrected.body))
          assert.equal(corrected.body.status, 'partial', 'corrected to the real availability')

          // ── (10) A single-store allocation behaves exactly like Phase 2:
          //      conversion validates and deducts at the fulfilment store. ──
          const bConv = await mkBooking({
            suffix: 'p3conv',
            lines: [{ title: 'Silver toy — red', sku: `${marker}-PALR`, qty: 3, price: 300, productId: ap.id, variantId: `${marker}-palar` }],
          })
          const planConv = await putAlloc(bConv, [
            { lineIndex: 0, productId: ap.id, variantId: `${marker}-palar`, sku: `${marker}-PALR`, locationId: 'LOC-DEFAULT', quantity: 3 },
          ])
          assert.equal(planConv.status, 200, JSON.stringify(planConv.body))
          assert.equal(planConv.body.status, 'fully')
          const convRes = await convertBookingToInvoice(bConv)
          assert.ok(convRes.ok, JSON.stringify(convRes))
          assert.equal(await stockOf(ap.id), 8, 'conversion revalidated at the store and deducted 3 Red (11 → 8)')
          const afterConv = await putAlloc(bConv, [{ lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: 1 }])
          assert.equal(afterConv.status, 400, 'allocations are closed once the booking is converted')

          // ── (11) Legacy bookings: no records invented, still compatible. ──
          const legacyPlan = await getAlloc(legacyBooking)
          assert.equal(legacyPlan.status, 200, JSON.stringify(legacyPlan.body))
          assert.equal(legacyPlan.body.status, 'unallocated')
          assert.equal(legacyPlan.body.allocations.length, 0, 'no allocation records are invented for history')
          assert.equal(legacyPlan.body.lines[0]?.tracked, false, 'its hand-typed line has nothing to allocate')
          assert.equal(legacyPlan.body.suggestedLocationId, 'LOC-DEFAULT', 'the prefill hint is the default store only')
          const legacyStillNull = await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, legacyBooking)).limit(1)
          assert.equal(legacyStillNull[0].locationId, null, 'reading the plan never rewrites the legacy NULL')
          const legacyPut = await putAlloc(legacyBooking, [{ lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: 1 }])
          assert.equal(legacyPut.status, 400, 'an untracked line cannot be allocated')
          assert.match(String(legacyPut.body.error), /tracked catalogue product/)

          // ── (12) Concurrency: two simultaneous saves never merge. Stock
          //      context by now: Main holds 2 Red (convert took 3 of 5),
          //      the counter still holds 5. Both sets fit those balances. ──
          const bConc = await mkBooking({
            suffix: 'p3conc',
            lines: [{ title: 'Silver toy — red', sku: `${marker}-PALR`, qty: 10, price: 300, productId: ap.id, variantId: `${marker}-palar` }],
          })
          const [p3SaveA, p3SaveB] = await Promise.all([
            putAlloc(bConc, [
              { lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: 2 },
              { lineIndex: 0, locationId: stockLocationId, quantity: 5 },
            ]),
            putAlloc(bConc, [
              { lineIndex: 0, locationId: stockLocationId, quantity: 3 },
              { lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: 1 },
            ]),
          ])
          assert.equal(p3SaveA.status, 200, JSON.stringify(p3SaveA.body))
          assert.equal(p3SaveB.status, 200, JSON.stringify(p3SaveB.body))
          const finalPlan = await getAlloc(bConc)
          const finalRows = (finalPlan.body.allocations as Array<{ locationId: string; quantity: number }>)
            .map((a) => `${a.locationId}:${a.quantity}`)
            .sort()
          const setAJson = [`LOC-DEFAULT:2`, `${stockLocationId}:5`].sort()
          const setBJson = [`LOC-DEFAULT:1`, `${stockLocationId}:3`].sort()
          const matches = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])
          assert.ok(
            matches(finalRows, setAJson) || matches(finalRows, setBJson),
            `final plan must be EXACTLY one writer's set, got ${finalRows.join(', ')}`,
          )
          assert.equal(finalPlan.body.allocations.length, 2, 'the unique index prevented a merged/duplicated plan')

          // ── RBAC: reading needs sales.view, writing needs sales.edit. ─────
          const viewerPlan = await call(viewerId, 'GET', `/db/bookings/${bOne}/allocations`)
          assert.equal(viewerPlan.status, 200, 'a view-only sales role can read a plan')
          const viewerSave = await call(viewerId, 'PUT', `/db/bookings/${bOne}/allocations`, { items: [] })
          assert.equal(viewerSave.status, 403, 'a view-only sales role cannot change allocations')

          // ═══ Bookings Phase 4: multi-store fulfilment (Option A) ═══════════
          // One product, two variants, seeded to known balances per store.
          // Every scenario ensures/snapshots exactly what it needs, so the
          // block is order-independent: planning never moves stock, conversions
          // move ONLY their own units, at their own stores.
          const { raiseInvoiceForOrder } = await import('./orderEmailIngest')
          const { setSalesReturnStatus } = await import('./returns')
          const p4Prod = await mkProduct('p4', 0)
          await db!.insert(schema.productVariants).values([
            { id: `${marker}-p4red`, productId: p4Prod.id, title: 'red', optionValues: ['red'], sku: `${marker}-P4RED`, stock: 0 },
            { id: `${marker}-p4wht`, productId: p4Prod.id, title: 'white', optionValues: ['white'], sku: `${marker}-P4WHT`, stock: 0 },
          ])
          const p4RedId = `${marker}-p4red`
          const p4WhtId = `${marker}-p4wht`
          const p4RedSku = `${marker}-P4RED`
          const p4WhtSku = `${marker}-P4WHT`
          const p4Main = 'LOC-DEFAULT'

          const levelAt = async (variantId: string, locationId: string) => {
            const rows = await db!
              .select({ qty: schema.stockLevels.qty })
              .from(schema.stockLevels)
              .where(and(eq(schema.stockLevels.variantId, variantId), eq(schema.stockLevels.locationId, locationId)))
            return rows.reduce((a, r) => a + Number(r.qty ?? 0), 0)
          }
          const ensureAt = async (sku: string, variantId: string, locationId: string, need: number) => {
            const have = await levelAt(variantId, locationId)
            if (have < need) {
              await applyStockMovement({ sku, qty: need - have, type: 'purchase_in', refType: 'test', locationId })
            }
          }
          const invoiceByNumber = async (number: string) =>
            (await db!.select().from(schema.salesInvoices).where(eq(schema.salesInvoices.number, number)))[0]
          const itemsOf = async (invoiceId: string) =>
            db!.select().from(schema.salesInvoiceItems).where(eq(schema.salesInvoiceItems.invoiceId, invoiceId))
          const paymentsForRef = async (ref: string) =>
            (await db!.select().from(schema.payments)).filter((p) => p.ref === ref)
          const p4LineOf = (qty: number) => ({
            title: 'Phase4 — red',
            sku: p4RedSku,
            qty,
            price: 300,
            productId: p4Prod.id,
            variantId: p4RedId,
          })
          const readLine0 = async (orderId: string) => {
            const [row] = await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, orderId)).limit(1)
            return (row.lineItems as Array<Record<string, unknown>>)[0]
          }
          const assertOpenAndUnmarked = async (orderId: string, message: string) => {
            const [row] = await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, orderId)).limit(1)
            assert.equal(row.invoice, null, `${message}: no invoice claim survived`)
            const allocs = await db!.select().from(schema.bookingAllocations).where(eq(schema.bookingAllocations.orderId, orderId))
            assert.ok(allocs.every((a) => a.invoiceId == null && a.fulfilledAt == null), `${message}: no fulfilment marks survived`)
            return row
          }

          // ── (1) Stable booking-line identity across supported edits ───────
          const identRes = await call(adminId, 'POST', '/db/bookings', {
            customer,
            items: [{ product: 'Phase4 — red', sku: p4RedSku, qty: 10, price: 300, productId: p4Prod.id, variantId: p4RedId }],
          })
          assert.equal(identRes.status, 200, JSON.stringify(identRes.body))
          const p4Ident = String(identRes.body.id)
          allBookingIds.push(p4Ident)
          const lineIdA = String((await readLine0(p4Ident))?.id ?? '')
          assert.ok(lineIdA, 'a tracked line gets its stable id on create')

          const identKeep = await call(adminId, 'PATCH', `/db/bookings/${p4Ident}`, {
            items: [{ product: 'Phase4 — red', sku: p4RedSku, qty: 10, price: 350, productId: p4Prod.id, variantId: p4RedId }],
          })
          assert.equal(identKeep.status, 200, JSON.stringify(identKeep.body))
          assert.equal(String((await readLine0(p4Ident))?.id), lineIdA, 'a supported edit (price) keeps the stable id')

          await ensureAt(p4RedSku, p4RedId, p4Main, 5)
          await ensureAt(p4RedSku, p4RedId, stockLocationId, 5)
          const identPlan = await putAlloc(p4Ident, [
            { lineIndex: 0, locationId: p4Main, quantity: 5 },
            { lineIndex: 0, locationId: stockLocationId, quantity: 5 },
          ])
          assert.equal(identPlan.status, 200, JSON.stringify(identPlan.body))
          const identAllocs = await db!.select().from(schema.bookingAllocations).where(eq(schema.bookingAllocations.orderId, p4Ident))
          assert.equal(identAllocs.length, 2)
          assert.ok(
            identAllocs.every((a) => a.lineId === lineIdA),
            'every NEW allocation row carries the stable line id',
          )

          // A different variant at that position is a NEW line: the old id
          // never follows it, and the allocation refuses rather than remaps.
          const identHijack = await call(adminId, 'PATCH', `/db/bookings/${p4Ident}`, {
            items: [{ product: 'Phase4 — white', sku: p4WhtSku, qty: 10, price: 300, productId: p4Prod.id, variantId: p4WhtId }],
          })
          assert.equal(identHijack.status, 400, JSON.stringify(identHijack.body))
          assert.match(String(identHijack.body.error), /adjust the booking allocations/)

          // Shrinking below the allocated quantity is refused, with detail.
          const identShrink = await call(adminId, 'PATCH', `/db/bookings/${p4Ident}`, {
            items: [{ product: 'Phase4 — red', sku: p4RedSku, qty: 6, price: 350, productId: p4Prod.id, variantId: p4RedId }],
          })
          assert.equal(identShrink.status, 400, JSON.stringify(identShrink.body))
          assert.match(String(identShrink.body.error), /allocated 10 but would only book 6/)

          // Clearing the plan re-enables edits — and the id STILL survives.
          const identClear = await putAlloc(p4Ident, [])
          assert.equal(identClear.status, 200, JSON.stringify(identClear.body))
          const identEdit2 = await call(adminId, 'PATCH', `/db/bookings/${p4Ident}`, {
            items: [{ product: 'Phase4 — red', sku: p4RedSku, qty: 8, price: 350, productId: p4Prod.id, variantId: p4RedId }],
          })
          assert.equal(identEdit2.status, 200, JSON.stringify(identEdit2.body))
          assert.equal(String((await readLine0(p4Ident))?.id), lineIdA, 'ids survive unallocated edits too')

          // ── (2) Incomplete allocation refuses the WHOLE conversion ────────
          const p4Inc = await mkBooking({ suffix: 'p4inc', lines: [p4LineOf(10)] })
          await ensureAt(p4RedSku, p4RedId, p4Main, 4)
          const incPut = await putAlloc(p4Inc, [{ lineIndex: 0, locationId: p4Main, quantity: 4 }])
          assert.equal(incPut.status, 200, 'a partial plan is legal while planning')
          const incMainBefore = await levelAt(p4RedId, p4Main)
          const incConv = await call(adminId, 'POST', `/db/bookings/${p4Inc}/convert`)
          assert.equal(incConv.status, 400, JSON.stringify(incConv.body))
          assert.match(String(incConv.body.error), /not fully allocated/)
          assert.deepEqual(
            { ...(incConv.body.details?.[0] as Record<string, unknown>) },
            { lineIndex: 0, sku: p4RedSku, required: 10, allocated: 4 },
            'the refusal names the exact line, SKU and quantities',
          )
          await assertOpenAndUnmarked(p4Inc, 'incomplete allocation')
          assert.equal(await levelAt(p4RedId, p4Main), incMainBefore, 'no stock moved')

          // ── (3) Insufficient AFTER allocation: 409 naming THAT store, with
          //      every field of the shortage — never another entry's store. ──
          const p4Ins = await mkBooking({ suffix: 'p4ins', lines: [p4LineOf(10)] })
          await ensureAt(p4RedSku, p4RedId, p4Main, 5)
          await ensureAt(p4RedSku, p4RedId, stockLocationId, 5)
          const insPut = await putAlloc(p4Ins, [
            { lineIndex: 0, locationId: p4Main, quantity: 5 },
            { lineIndex: 0, locationId: stockLocationId, quantity: 5 },
          ])
          assert.equal(insPut.status, 200, JSON.stringify(insPut.body))
          const insMainBefore = await levelAt(p4RedId, p4Main)
          await applyStockMovement({ sku: p4RedSku, qty: -4, type: 'sale_out', refType: 'test', locationId: stockLocationId })
          const insConv = await call(adminId, 'POST', `/db/bookings/${p4Ins}/convert`)
          assert.equal(insConv.status, 409, JSON.stringify(insConv.body))
          assert.equal(insConv.body.code, 'INSUFFICIENT_STOCK')
          const insEntry = insConv.body.products?.[0]
          assert.ok(insEntry, 'the 409 carries per-product detail')
          assert.equal(insEntry.sku, p4RedSku)
          assert.equal(insEntry.name, 'Phase4 — red')
          assert.equal(insEntry.productId, p4Prod.id, 'the entry carries the product id')
          assert.equal(insEntry.variantId, p4RedId, 'the entry carries the variant id')
          assert.equal(insEntry.locationId, stockLocationId, 'the entry names the store IT was short at')
          assert.equal(insEntry.location, `${marker} Counter`, '…by its human name')
          assert.equal(insEntry.available, 1)
          assert.equal(insEntry.requested, 5)
          assert.equal(insEntry.shortage, 4)
          assert.equal(insConv.body.location?.id, stockLocationId, 'the single-store hint matches too')
          await assertOpenAndUnmarked(p4Ins, 'insufficient after allocation')
          assert.equal(await levelAt(p4RedId, p4Main), insMainBefore, 'the passing store was never touched')
          assert.equal(await levelAt(p4RedId, stockLocationId), 1, 'the failing store kept its stock')
          await ensureAt(p4RedSku, p4RedId, stockLocationId, 5)

          // ── (4) Full rollback when a LATER store fails: the store that
          //      already passed the guard never moves, and BOTH shortage
          //      entries carry their own store. ─────────────────────────────
          const p4Rb = await mkBooking({
            suffix: 'p4rb',
            lines: [
              p4LineOf(10),
              { title: 'Phase4 — white', sku: p4WhtSku, qty: 4, price: 300, productId: p4Prod.id, variantId: p4WhtId },
            ],
          })
          await ensureAt(p4RedSku, p4RedId, p4Main, 5)
          await ensureAt(p4RedSku, p4RedId, stockLocationId, 5)
          await ensureAt(p4WhtSku, p4WhtId, stockLocationId, 4)
          const rbPut = await putAlloc(p4Rb, [
            { lineIndex: 0, locationId: p4Main, quantity: 5 },
            { lineIndex: 0, locationId: stockLocationId, quantity: 5 },
            { lineIndex: 1, locationId: stockLocationId, quantity: 4 },
          ])
          assert.equal(rbPut.status, 200, JSON.stringify(rbPut.body))
          const rbRedMain = await levelAt(p4RedId, p4Main)
          const rbWhtMain = await levelAt(p4WhtId, p4Main)
          await applyStockMovement({ sku: p4RedSku, qty: -5, type: 'sale_out', refType: 'test', locationId: stockLocationId })
          await applyStockMovement({ sku: p4WhtSku, qty: -3, type: 'sale_out', refType: 'test', locationId: stockLocationId })
          const rbConv = await convertBookingToInvoice(p4Rb)
          assert.equal(rbConv.ok, false, 'the conversion is refused, never partially applied')
          const rbStock = rbConv.ok === false ? rbConv.stock : undefined
          assert.ok(rbStock && rbStock.products.length === 2, 'both short lines report')
          for (const entry of rbStock!.products) {
            assert.equal(entry.locationId, stockLocationId, 'EVERY shortage entry carries its own store id')
            assert.equal(entry.location, `${marker} Counter`, '…and its own store name — never a sibling’s')
          }
          assert.deepEqual(rbStock!.products.map((p) => p.sku).sort(), [p4RedSku, p4WhtSku].sort())
          const rbRedEntry = rbStock!.products.find((p) => p.sku === p4RedSku)!
          assert.equal(rbRedEntry.available, 0)
          assert.equal(rbRedEntry.requested, 5)
          assert.equal(rbRedEntry.shortage, 5)
          assert.equal(rbRedEntry.variantId, p4RedId)
          const rbWhtEntry = rbStock!.products.find((p) => p.sku === p4WhtSku)!
          assert.equal(rbWhtEntry.available, 1)
          assert.equal(rbWhtEntry.shortage, 3)
          assert.equal(rbWhtEntry.variantId, p4WhtId)
          // The store that PASSED the guard first was rolled back to untouched.
          assert.equal(await levelAt(p4RedId, p4Main), rbRedMain, 'the first store’s passing bucket never moved')
          assert.equal(await levelAt(p4WhtId, p4Main), rbWhtMain, 'the untouched store never moved')
          assert.equal(await levelAt(p4RedId, stockLocationId), 0, 'the failing store kept its stock')
          assert.equal(await levelAt(p4WhtId, stockLocationId), 1, 'the failing store kept its stock')
          await assertOpenAndUnmarked(p4Rb, 'later-store failure')
          await ensureAt(p4RedSku, p4RedId, stockLocationId, 5)
          await ensureAt(p4WhtSku, p4WhtId, stockLocationId, 4)

          // ── (5) Multi-store fulfilment 5 + 5: ONE invoice, items per store,
          //      exact per-store variant deductions, full provenance, and the
          //      advance recorded EXACTLY once. ──────────────────────────────
          const p4Ms = await mkBooking({ suffix: 'p4ms', lines: [p4LineOf(10)], advance: 1500 })
          const msRef = `BK-${marker}-p4ms`
          await ensureAt(p4RedSku, p4RedId, p4Main, 5)
          await ensureAt(p4RedSku, p4RedId, stockLocationId, 5)
          const msPut = await putAlloc(p4Ms, [
            { lineIndex: 0, locationId: p4Main, quantity: 5 },
            { lineIndex: 0, locationId: stockLocationId, quantity: 5 },
          ])
          assert.equal(msPut.status, 200, JSON.stringify(msPut.body))
          assert.equal(msPut.body.status, 'fully')
          const msRedMain = await levelAt(p4RedId, p4Main)
          const msRedCtr = await levelAt(p4RedId, stockLocationId)
          const msWhtMain = await levelAt(p4WhtId, p4Main)
          const msWhtCtr = await levelAt(p4WhtId, stockLocationId)
          const msConv = await convertBookingToInvoice(p4Ms, { actor: 'tester' })
          assert.ok(msConv.ok, JSON.stringify(msConv))
          const msNumber = msConv.ok ? msConv.invoiceNumber : ''
          const msInv = await invoiceByNumber(msNumber)
          assert.ok(msInv, 'exactly one invoice was raised')
          const msItems = await itemsOf(msInv!.id)
          assert.equal(msItems.length, 2, 'ONE invoice containing items fulfilled from TWO stores')
          const msByLoc = new Map(msItems.map((i) => [i.locationId, i]))
          assert.equal(msByLoc.get(p4Main)?.qty, 5, '5 units fulfilled from Main')
          assert.equal(msByLoc.get(stockLocationId)?.qty, 5, '5 units fulfilled from the counter')
          const msAllocRows = await db!.select().from(schema.bookingAllocations).where(eq(schema.bookingAllocations.orderId, p4Ms))
          assert.equal(msAllocRows.length, 2)
          for (const item of msItems) {
            assert.ok(item.bookingLineId, 'each item names its booking line')
            const source = msAllocRows.find((a) => a.id === item.bookingAllocationId)
            assert.ok(source, 'each item names the EXACT allocation it consumed')
            assert.equal(source!.lineId, item.bookingLineId, 'line + allocation agree')
            assert.equal(source!.invoiceId, msNumber, 'and the allocation points back at the invoice')
            assert.ok(source!.fulfilledAt, 'the allocation is marked fulfilled')
          }
          assert.equal(await levelAt(p4RedId, p4Main), msRedMain - 5, 'Main lost exactly its 5 Red')
          assert.equal(await levelAt(p4RedId, stockLocationId), msRedCtr - 5, 'the counter lost exactly its 5 Red')
          assert.deepEqual(
            { main: await levelAt(p4WhtId, p4Main), ctr: await levelAt(p4WhtId, stockLocationId) },
            { main: msWhtMain, ctr: msWhtCtr },
            'the White variant never moved — variant-exact fulfilment',
          )
          const msPays = await paymentsForRef(msRef)
          assert.equal(msPays.length, 1, 'the advance payment row exists EXACTLY once')
          assert.equal(Number(msPays[0].amount), 1500)
          assert.equal(msPays[0].invoice, msNumber, '…against this invoice')
          assert.equal(msPays[0].method, 'Advance')
          assert.equal(msConv.ok ? msConv.balance : NaN, 1500, 'outstanding = value − advance')
          const msAgain = await convertBookingToInvoice(p4Ms)
          assert.equal(msAgain.ok, false, 'a repeat conversion is refused')
          assert.equal(msAgain.ok === false && msAgain.status, 400)
          assert.equal((await paymentsForRef(msRef)).length, 1, 'the repeat never adds a payment')

          // ── (6) Duplicate conversion under a RACE: one winner, one invoice,
          //      one advance — the loser writes NO financial record. ─────────
          const p4Dup = await mkBooking({ suffix: 'p4dup', lines: [p4LineOf(2)], advance: 100 })
          await ensureAt(p4RedSku, p4RedId, p4Main, 2)
          const dupPut = await putAlloc(p4Dup, [{ lineIndex: 0, locationId: p4Main, quantity: 2 }])
          assert.equal(dupPut.status, 200, JSON.stringify(dupPut.body))
          const [dupA, dupB] = await Promise.all([
            convertBookingToInvoice(p4Dup),
            convertBookingToInvoice(p4Dup),
          ])
          const dupRow = (await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, p4Dup)).limit(1))[0]
          assert.ok(dupRow.invoice, 'exactly one conversion claimed the booking')
          assert.ok(dupA.ok || dupB.ok, 'at least the winner reports success')
          if (dupA.ok && dupB.ok) {
            assert.equal(dupA.invoiceNumber, dupB.invoiceNumber, 'both racers agree on ONE invoice number')
          }
          const dupPays = await paymentsForRef(`BK-${marker}-p4dup`)
          assert.equal(dupPays.length, 1, 'the advance exists exactly once even under a race')
          assert.equal(
            (await db!.select().from(schema.salesInvoices).where(eq(schema.salesInvoices.number, dupRow.invoice))).length,
            1,
            'never two invoices',
          )

          // ── (7) A failure WHILE recording the advance rolls the ENTIRE
          //      conversion back: no invoice, no claim, no stock, no marks,
          //      no payment — no partially completed financial state. ────────
          const p4Pay = await mkBooking({ suffix: 'p4pay', lines: [p4LineOf(5)], advance: 700 })
          await ensureAt(p4RedSku, p4RedId, p4Main, 5)
          const payPut = await putAlloc(p4Pay, [{ lineIndex: 0, locationId: p4Main, quantity: 5 }])
          assert.equal(payPut.status, 200, JSON.stringify(payPut.body))
          const payMainBefore = await levelAt(p4RedId, p4Main)
          const payPaymentsBefore = (await db!.select().from(schema.payments)).length
          const payRow = (await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, p4Pay)).limit(1))[0]
          await assert.rejects(
            () =>
              raiseInvoiceForOrder(payRow, {
                afterInvoice: async (tx) => {
                  await tx.insert(schema.payments).values({
                    id: 'p4-pay-fail',
                    ref: 'p4-pay-fail',
                    invoice: 'p4-pay-fail',
                    customer,
                    amount: 700,
                    method: 'Advance',
                    gateway: 'booking',
                    status: 'paid',
                    date: new Date().toISOString(),
                  })
                  throw new Error('simulated payment-recording failure')
                },
              }),
            /simulated payment-recording failure/,
          )
          await assertOpenAndUnmarked(p4Pay, 'payment-recording failure')
          const payAfter = (await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, p4Pay)).limit(1))[0]
          assert.equal(payAfter.status, 'confirmed', 'no fulfilment status survived')
          assert.equal(await levelAt(p4RedId, p4Main), payMainBefore, 'no stock was deducted')
          assert.equal(
            (await db!.select().from(schema.payments)).length,
            payPaymentsBefore,
            'the advance insert rolled back with everything else',
          )
          assert.equal(await hasConvertedEvent(p4Pay), false, 'no timeline entry for a failed conversion')

          // ── (8) Concurrent conversion vs allocation edit: the booking row
          //      lock serialises them — one consistent plan, never half of
          //      each. ──────────────────────────────────────────────────────
          const p4Cc = await mkBooking({ suffix: 'p4cc', lines: [p4LineOf(10)] })
          await ensureAt(p4RedSku, p4RedId, p4Main, 5)
          await ensureAt(p4RedSku, p4RedId, stockLocationId, 5)
          const ccBase = await putAlloc(p4Cc, [
            { lineIndex: 0, locationId: p4Main, quantity: 5 },
            { lineIndex: 0, locationId: stockLocationId, quantity: 5 },
          ])
          assert.equal(ccBase.status, 200, JSON.stringify(ccBase.body))
          const ccMainBefore = await levelAt(p4RedId, p4Main)
          const ccCtrBefore = await levelAt(p4RedId, stockLocationId)
          const [ccConv, ccEdit] = await Promise.all([
            convertBookingToInvoice(p4Cc),
            putAlloc(p4Cc, [
              { lineIndex: 0, locationId: p4Main, quantity: 4 },
              { lineIndex: 0, locationId: stockLocationId, quantity: 5 },
            ]),
          ])
          const ccRow = (await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, p4Cc)).limit(1))[0]
          const ccAllocs = await db!.select().from(schema.bookingAllocations).where(eq(schema.bookingAllocations.orderId, p4Cc))
          if (ccConv.ok) {
            // Conversion won (the edit either landed first or was refused as
            // closed): the invoice mirrors the FINAL allocation set exactly.
            const ccInv = await invoiceByNumber(ccRow.invoice ?? '')
            assert.ok(ccInv, 'the winning conversion raised its invoice')
            const ccItems = await itemsOf(ccInv!.id)
            const planByStore = new Map(ccAllocs.map((a) => [a.locationId, Number(a.quantity)]))
            const itemsByStore = new Map(ccItems.map((i) => [i.locationId, Number(i.qty)]))
            assert.deepEqual(
              [...itemsByStore.entries()].sort(),
              [...planByStore.entries()].sort(),
              'invoice items mirror the final allocation set exactly',
            )
            assert.ok(
              ccAllocs.every((a) => a.invoiceId === ccRow.invoice),
              'every final row is marked fulfilled',
            )
            assert.equal(
              await levelAt(p4RedId, p4Main),
              ccMainBefore - (planByStore.get(p4Main) ?? 0),
              'Main deducted exactly its final share',
            )
            assert.equal(
              await levelAt(p4RedId, stockLocationId),
              ccCtrBefore - (planByStore.get(stockLocationId) ?? 0),
              'the counter exactly its own',
            )
          } else {
            // The edit won with a partial plan: conversion refused cleanly.
            assert.equal(ccConv.ok === false && ccConv.status, 400, JSON.stringify(ccConv))
            assert.equal(ccEdit.status, 200, 'the edit itself succeeded')
            assert.equal(ccRow.invoice, null, 'no invoice was raised')
            assert.equal(await levelAt(p4RedId, p4Main), ccMainBefore, 'no stock moved')
            assert.equal(await levelAt(p4RedId, stockLocationId), ccCtrBefore, 'no stock moved')
            assert.ok(ccAllocs.every((a) => a.invoiceId == null), 'the plan stays open')
          }

          // ── (9) Retry safety: a second raise reuses the winner's invoice
          //      without claiming, writing or paying anything again. ────────
          const msRow2 = (await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, p4Ms)).limit(1))[0]
          const retry = await raiseInvoiceForOrder(msRow2)
          assert.equal(retry.claimed, false, 'a retry never claims again')
          assert.equal(retry.number, msNumber, '…it reuses the winner’s invoice number')
          assert.equal((await paymentsForRef(msRef)).length, 1, '…and never duplicates the advance')

          // ── (10) Invoice totals identical to equivalent single-store
          //       fulfilment: the split bills exactly what the whole bills. ──
          const p4T1 = await mkBooking({ suffix: 'p4t1', lines: [p4LineOf(5)] })
          const p4T2 = await mkBooking({ suffix: 'p4t2', lines: [p4LineOf(5)] })
          // BOTH conversions draw their Main share: 5 for the single-store
          // equivalent, 3 for the split one — seed the store for both.
          await ensureAt(p4RedSku, p4RedId, p4Main, 8)
          await ensureAt(p4RedSku, p4RedId, stockLocationId, 2)
          const t1Put = await putAlloc(p4T1, [{ lineIndex: 0, locationId: p4Main, quantity: 5 }])
          const t2Put = await putAlloc(p4T2, [
            { lineIndex: 0, locationId: p4Main, quantity: 3 },
            { lineIndex: 0, locationId: stockLocationId, quantity: 2 },
          ])
          assert.equal(t1Put.status, 200, JSON.stringify(t1Put.body))
          assert.equal(t2Put.status, 200, JSON.stringify(t2Put.body))
          const t1Conv = await convertBookingToInvoice(p4T1)
          const t2Conv = await convertBookingToInvoice(p4T2)
          assert.ok(t1Conv.ok && t2Conv.ok, JSON.stringify([t1Conv, t2Conv]))
          const t1Inv = await invoiceByNumber(t1Conv.ok ? t1Conv.invoiceNumber : '')
          const t2Inv = await invoiceByNumber(t2Conv.ok ? t2Conv.invoiceNumber : '')
          assert.ok(t1Inv && t2Inv)
          assert.equal(Number(t2Inv!.grandTotal), 1500, 'the split invoice bills the full booked amount')
          for (const field of ['subtotal', 'gstAmount', 'discount', 'grandTotal'] as const) {
            assert.equal(
              Number(t2Inv![field]),
              Number(t1Inv![field]),
              `${field} is identical to single-store fulfilment`,
            )
          }
          const t2Items = await itemsOf(t2Inv!.id)
          assert.equal(t2Items.reduce((a, i) => a + Number(i.qty), 0), 5, 'the split items sum to the booked quantity')
          assert.equal(
            t2Items.reduce((a, i) => a + Number(i.amount), 0),
            Number(t2Inv!.subtotal),
            '…and the split amounts sum to the invoice subtotal',
          )

          // ── (11) Hand-typed lines stay exempt from allocation (no product
          //       to allocate) and fulfil at the booking's own store. ───────
          const p4Ht = await mkBooking({
            suffix: 'p4ht',
            lines: [p4LineOf(5), { title: 'Hand-typed extra', sku: `${marker}-NOPE`, qty: 1, price: 100 }],
          })
          await ensureAt(p4RedSku, p4RedId, p4Main, 5)
          const htPut = await putAlloc(p4Ht, [{ lineIndex: 0, locationId: p4Main, quantity: 5 }])
          assert.equal(htPut.status, 200, JSON.stringify(htPut.body))
          const htMainBefore = await levelAt(p4RedId, p4Main)
          const htConv = await convertBookingToInvoice(p4Ht)
          assert.ok(htConv.ok, JSON.stringify(htConv))
          const htInv = await invoiceByNumber(htConv.ok ? htConv.invoiceNumber : '')
          const htItems = await itemsOf(htInv!.id)
          assert.equal(htItems.length, 2, 'the allocated line (split) + the hand-typed line')
          const htTracked = htItems.find((i) => i.bookingAllocationId)
          assert.ok(htTracked && htTracked.locationId === p4Main, 'the allocated line fulfilled from Main')
          const htHand = htItems.find((i) => !i.bookingAllocationId)
          assert.ok(htHand, 'the hand-typed line still invoices')
          assert.equal(htHand!.locationId, p4Main, '…at the booking’s own store (legacy rule)')
          assert.equal(htHand!.bookingLineId, null, '…with no fabricated line reference')
          assert.equal(await levelAt(p4RedId, p4Main), htMainBefore - 5, 'only the tracked line moved stock')

          // ── (12) Re-invoice: every store is reversed and re-taken at ITS
          //       OWN store; the advance follows the replacement invoice. ────
          await ensureAt(p4RedSku, p4RedId, p4Main, 5)
          await ensureAt(p4RedSku, p4RedId, stockLocationId, 5)
          const rvMain = await levelAt(p4RedId, p4Main)
          const rvCtr = await levelAt(p4RedId, stockLocationId)
          const reinv = await call(adminId, 'POST', `/db/sales-orders/by-invoice/${msNumber}/reinvoice`)
          assert.equal(reinv.status, 200, JSON.stringify(reinv.body))
          const msNumber2 = String(reinv.body.invoiceNumber)
          assert.notEqual(msNumber2, msNumber, 'the re-raise mints a fresh invoice number')
          assert.equal(await levelAt(p4RedId, p4Main), rvMain, 'Main: reversed then re-taken AT MAIN — net zero')
          assert.equal(await levelAt(p4RedId, stockLocationId), rvCtr, 'the counter likewise')
          const msPays2 = await paymentsForRef(msRef)
          assert.equal(msPays2.length, 1, 'still exactly one advance row')
          assert.equal(msPays2[0].invoice, msNumber2, '…re-pointed to the replacement invoice, never duplicated')
          const msInv2 = await invoiceByNumber(msNumber2)
          assert.ok(msInv2, 'the replacement invoice exists')
          const msItems2 = await itemsOf(msInv2!.id)
          assert.equal(msItems2.length, 2, 'the replacement invoice is still split per store')
          assert.ok(
            msItems2.every((i) => i.bookingLineId && i.bookingAllocationId),
            '…with full booking-line + allocation provenance',
          )
          const msAllocs2 = await db!.select().from(schema.bookingAllocations).where(eq(schema.bookingAllocations.orderId, p4Ms))
          assert.ok(
            msAllocs2.every((a) => a.invoiceId === msNumber2),
            'the allocations follow the replacement invoice',
          )
          const msRow3 = (await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, p4Ms)).limit(1))[0]
          assert.equal(msRow3.invoice, msNumber2, 'the booking links the replacement')

          // ── (13) Returns restore the CORRECT stores: credit note, RMA
          //       receipt, and the RMA's reject-undo — each at its own store. ─
          const retBase = { main: await levelAt(p4RedId, p4Main), ctr: await levelAt(p4RedId, stockLocationId) }
          const cr = await call(adminId, 'POST', `/db/invoices/${msInv2!.id}/return`, {
            items: [{ sku: p4RedSku, qty: 3 }],
            restock: true,
          })
          assert.equal(cr.status, 200, JSON.stringify(cr.body))
          // Deterministic store order (the same localeCompare the split items
          // were inserted in): the counter fills first, then Main.
          assert.equal(
            await levelAt(p4RedId, stockLocationId),
            retBase.ctr + 3,
            'the credit note restocks the counter — its own units (5@Main + 5@Counter)',
          )
          assert.equal(await levelAt(p4RedId, p4Main), retBase.main, 'Main is untouched')

          const p4RmaId = `${marker}-p4rma`
          await db!.insert(schema.salesReturns).values({
            id: p4RmaId,
            number: `${marker}-RMA-P4`,
            invoiceId: msInv2!.id,
            orderId: p4Ms,
            returnItems: [{ sku: p4RedSku, qty: 2 }],
            status: 'in_transit',
            customer,
            items: 2,
            amount: 600,
            date: new Date().toISOString(),
          })
          const rmaRecv = await setSalesReturnStatus(p4RmaId, 'received')
          assert.ok(rmaRecv.ok, JSON.stringify(rmaRecv))
          assert.equal(
            await levelAt(p4RedId, stockLocationId),
            retBase.ctr + 5,
            'the RMA continues where the credit note left off — the counter’s 5-unit ceiling is never exceeded',
          )
          assert.equal(await levelAt(p4RedId, p4Main), retBase.main, 'Main still untouched')

          const rmaUndo = await setSalesReturnStatus(p4RmaId, 'rejected')
          assert.ok(rmaUndo.ok, JSON.stringify(rmaUndo))
          assert.equal(
            await levelAt(p4RedId, stockLocationId),
            retBase.ctr + 3,
            'rejecting the RMA undoes EXACTLY its own restock, at the same store',
          )
          assert.equal(await levelAt(p4RedId, p4Main), retBase.main, 'Main never involved')
          await db!.delete(schema.salesReturns).where(eq(schema.salesReturns.invoiceId, msInv2!.id))

          // ── (14) Invoice deletion restores EACH store the invoice
          //       fulfilled from — and a historical NULL-location invoice
          //       keeps the legacy default-store behaviour, byte for byte. ──
          const delMain = await levelAt(p4RedId, p4Main)
          const delCtr = await levelAt(p4RedId, stockLocationId)
          const delT2 = await call(adminId, 'DELETE', `/db/invoices/${t2Inv!.id}`)
          assert.equal(delT2.status, 200, JSON.stringify(delT2.body))
          assert.equal(await levelAt(p4RedId, p4Main), delMain + 3, 'Main got ITS 3 units back')
          assert.equal(await levelAt(p4RedId, stockLocationId), delCtr + 2, 'the counter got ITS 2 back')

          const legP4 = await mkProduct('p4leg', 4)
          await db!.insert(schema.salesInvoices).values({
            id: `${marker}-p4leginv`,
            number: `${marker}-P4LEG`,
            customer,
            grandTotal: 200,
            date: new Date().toISOString(),
          })
          await db!.insert(schema.salesInvoiceItems).values({
            id: `${marker}-p4legitem`,
            invoiceId: `${marker}-p4leginv`,
            product: 'Legacy NULL-location line',
            sku: legP4.sku,
            qty: 2,
            amount: 200,
          })
          const delLeg = await call(adminId, 'DELETE', `/db/invoices/${marker}-p4leginv`)
          assert.equal(delLeg.status, 200, JSON.stringify(delLeg.body))
          assert.equal(
            await stockOf(legP4.id),
            6,
            'NULL location → default store: exactly the legacy behaviour for historical invoices',
          )

          // ── (15) Legacy booking WITHOUT allocation records converts exactly
          //       as before — nothing invented, nothing fabricated. ──────────
          const p4LegB = `${marker}-p4legbk`
          await db!.insert(schema.salesOrders).values({
            id: p4LegB,
            internalId: `BK-${marker}-p4legbk`,
            customer,
            value: 900,
            payment: 'pending',
            fulfillment: 'pending',
            status: 'confirmed',
            date: new Date().toISOString(),
            items: 3,
            tags: 'booking',
            currency: 'INR',
            discount: 0,
            lineItems: [
              { title: 'Phase4 legacy — white', sku: p4WhtSku, quantity: 3, price: 300, productId: p4Prod.id, variantId: p4WhtId },
            ],
            isBooking: true,
            advancePaid: 0,
          })
          allBookingIds.push(p4LegB)
          await ensureAt(p4WhtSku, p4WhtId, p4Main, 3)
          const legWhtMain = await levelAt(p4WhtId, p4Main)
          const legConv = await convertBookingToInvoice(p4LegB)
          assert.ok(legConv.ok, JSON.stringify(legConv))
          const legAllocRows = await db!.select().from(schema.bookingAllocations).where(eq(schema.bookingAllocations.orderId, p4LegB))
          assert.equal(legAllocRows.length, 0, 'no allocation records are ever invented for legacy bookings')
          const legInv = await invoiceByNumber(legConv.ok ? legConv.invoiceNumber : '')
          const legItems = await itemsOf(legInv!.id)
          assert.equal(legItems.length, 1, 'one line → one item, never split')
          assert.equal(legItems[0].locationId, p4Main, 'legacy NULL selling store → the default store, as always')
          assert.equal(legItems[0].bookingLineId, null, 'no fabricated line reference on a line that never had an id')
          assert.equal(legItems[0].bookingAllocationId, null, 'no fabricated allocation reference')
          assert.equal(await levelAt(p4WhtId, p4Main), legWhtMain - 3, 'deducted from the default store, exactly as before')

          // ═══ Phase 4 hardening ════════════════════════════════════════════

          // ── (H1) A header-only booking edit racing conversion can NEVER
          //      produce an invoice priced from stale values: the invoice
          //      mirrors the booking's FINAL committed snapshot whichever
          //      side won. ─────────────────────────────────────────────────
          const raceRes = await call(adminId, 'POST', '/db/bookings', {
            customer,
            email: 'priya@example.com',
            items: [{ product: 'Phase4 — red', sku: p4RedSku, qty: 5, price: 300, productId: p4Prod.id, variantId: p4RedId }],
            advanceAmount: 300,
          })
          assert.equal(raceRes.status, 200, JSON.stringify(raceRes.body))
          const p4Race = String(raceRes.body.id)
          allBookingIds.push(p4Race)
          await ensureAt(p4RedSku, p4RedId, p4Main, 5)
          const raceMainBefore = await levelAt(p4RedId, p4Main)
          const [raceConv, raceEdit] = await Promise.all([
            convertBookingToInvoice(p4Race),
            call(adminId, 'PATCH', `/db/bookings/${p4Race}`, { discount: 100, advanceAmount: 600 }),
          ])
          assert.ok(raceConv.ok, JSON.stringify(raceConv))
          assert.ok(
            raceEdit.status === 200 || raceEdit.status === 409,
            `the edit either landed first or was refused as converted (got ${raceEdit.status}: ${JSON.stringify(raceEdit.body)})`,
          )
          const raceRow = (await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, p4Race)).limit(1))[0]
          const raceInv = await invoiceByNumber(String(raceRow.invoice))
          assert.ok(raceInv, 'exactly one invoice exists')
          const raceValue = Number(raceRow.value)
          const raceAdvance = Number(raceRow.advancePaid)
          // THE INVARIANT: whatever the race produced, the invoice and the
          // booking agree — never a stale discount, GST or advance.
          assert.equal(Number(raceInv!.grandTotal), raceValue, 'invoice grand total == the final booking value')
          assert.equal(
            Number(raceRow.discount ?? 0),
            raceEdit.status === 200 ? 100 : 0,
            'the booking carries the discount of whichever side won',
          )
          const racePays = await paymentsForRef(String(raceRow.internalId))
          if (raceAdvance > 0) {
            // Collections are immutable cash events: the create-time row plus,
            // if the edit won the race, an ADDITIONAL collection for the
            // increase — never an overwrite of history, never a duplicate of
            // the same event, and every row credits THE invoice.
            const raceCollected = Math.round(racePays.reduce((a, p) => a + Number(p.amount ?? 0), 0) * 100) / 100
            assert.ok(racePays.length >= 1, 'the advance is recorded')
            assert.ok(racePays.every((p) => Number(p.amount) > 0), 'only positive collection rows exist — no invented refund')
            assert.equal(raceCollected, raceAdvance, 'Σ collections == the FINAL advance, each cash event counted once')
            assert.ok(racePays.every((p) => p.invoice === raceRow.invoice), 'every collection is pointed at THE invoice')
          } else {
            assert.equal(racePays.length, 0, 'no advance row when the final booking has none')
          }
          const expectedPayment = raceAdvance >= raceValue && raceValue > 0 ? 'paid' : 'pending'
          assert.equal(raceRow.payment, expectedPayment, 'the booking payment field agrees with its own snapshot')
          assert.equal(raceInv!.paymentStatus, expectedPayment, '…and so does the invoice')
          assert.equal(await levelAt(p4RedId, p4Main), raceMainBefore - 5, 'stock deducted exactly once')

          // ── (H2) Kanban fulfilment auto-invoice runs the SAME booking
          //      financial workflow: advance exactly once, atomic, retry- and
          //      duplicate-safe. ───────────────────────────────────────────
          const kanRes = await call(adminId, 'POST', '/db/bookings', {
            customer,
            email: 'priya@example.com',
            items: [{ product: 'Phase4 — red', sku: p4RedSku, qty: 5, price: 300, productId: p4Prod.id, variantId: p4RedId }],
            advanceAmount: 400,
          })
          assert.equal(kanRes.status, 200, JSON.stringify(kanRes.body))
          const p4Kan = String(kanRes.body.id)
          allBookingIds.push(p4Kan)
          await ensureAt(p4RedSku, p4RedId, p4Main, 5)
          const kanMainBefore = await levelAt(p4RedId, p4Main)
          const kanPrePays = await paymentsForRef(String(kanRes.body.internalId))
          assert.equal(kanPrePays.length, 1, 'the advance is recorded at COLLECTION, before any fulfilment')
          assert.equal(kanPrePays[0].invoice, null, '…as a booking-scoped row, not yet invoiced')
          assert.equal(Number(kanPrePays[0].amount), 400, 'for the advance actually collected')

          // Two simultaneous "land in fulfilled" drops: one workflow wins.
          const [kan1, kan2] = await Promise.all([
            call(adminId, 'PATCH', `/db/sales-orders/${p4Kan}/status`, { status: 'fulfilled' }),
            call(adminId, 'PATCH', `/db/sales-orders/${p4Kan}/status`, { status: 'fulfilled' }),
          ])
          assert.equal(kan1.status, 200, JSON.stringify(kan1.body))
          assert.equal(kan2.status, 200, JSON.stringify(kan2.body))
          const kanRow = (await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, p4Kan)).limit(1))[0]
          assert.ok(kanRow.invoice, 'the auto-invoice raised its invoice')
          assert.equal(kanRow.status, 'fulfilled')
          assert.equal(kanRow.fulfillment, 'fulfilled', 'the shared workflow set BOTH status columns')
          const kanPays = await paymentsForRef(String(kanRow.internalId))
          assert.equal(kanPays.length, 1, 'the advance is recorded EXACTLY once by the kanban path')
          assert.equal(Number(kanPays[0].amount), 400)
          assert.equal(kanPays[0].invoice, kanRow.invoice, '…against the invoice it belongs to')
          assert.equal(kanRow.payment, 'pending', '₹400 of ₹1500 → still due (levelling ran on the locked row)')
          const kanInv = await invoiceByNumber(String(kanRow.invoice))
          assert.equal(kanInv!.paymentStatus, 'pending', 'the invoice mirrors the same snapshot')
          assert.equal(await levelAt(p4RedId, p4Main), kanMainBefore - 5, 'stock deducted exactly once')

          // Retry: create-invoice again → same invoice, no second advance.
          const kanRetry = await call(adminId, 'POST', `/db/sales-orders/${p4Kan}/create-invoice`)
          assert.equal(kanRetry.status, 200, JSON.stringify(kanRetry.body))
          assert.equal(kanRetry.body.created, false, 'a retry never raises a second invoice')
          assert.equal(kanRetry.body.invoiceNumber, kanRow.invoice, '…it reuses the winner’s number')
          assert.equal((await paymentsForRef(String(kanRow.internalId))).length, 1, '…and never a second advance')
          // Duplicate conversion attempt: the Convert button refuses cleanly.
          const kanConvert = await call(adminId, 'POST', `/db/bookings/${p4Kan}/convert`)
          assert.equal(kanConvert.status, 400, JSON.stringify(kanConvert.body))
          assert.match(String(kanConvert.body.error), /Already converted/)
          assert.equal((await paymentsForRef(String(kanRow.internalId))).length, 1, 'still exactly one advance row')

          // ── (H3) A side effect that fails AFTER the invoice commit is
          //      durably recovered — and a recovery retry can never duplicate
          //      a journal, an award, an invoice or an advance. ────────────
          const { ensureInvoiceSideEffects, runSideEffectRecovery } = await import('./invoiceSideEffects')
          const loyaltyMod = await import('./loyalty')
          const countJournals = async (refId: string, type: string) =>
            (await db!.select().from(schema.journalEntries)).filter((j) => j.referenceType === type && j.referenceId === refId)
          const countAwards = async (invId: string) =>
            (await db!.select().from(schema.loyaltyTransactions)).filter(
              (t) => t.externalRef === `invoice:${invId}` && t.type === 'earn',
            )
          // Enable loyalty for this scenario (the workflow run disables it).
          await db!.update(schema.settings).set({ loyaltyEnabled: true }).where(eq(schema.settings.id, 'app'))
          loyaltyMod.invalidateConfig()
          try {
            // An external outage right after the commit: journal + loyalty fail.
            process.env.OPAL_SIDEEFFECT_FAIL = 'journal,loyalty'
            const seRes = await call(adminId, 'POST', '/db/bookings', {
              customer,
              email: 'priya@example.com',
              items: [{ product: 'Phase4 — red', sku: p4RedSku, qty: 5, price: 300, productId: p4Prod.id, variantId: p4RedId }],
              advanceAmount: 250,
            })
            assert.equal(seRes.status, 200, JSON.stringify(seRes.body))
            const p4Se = String(seRes.body.id)
            allBookingIds.push(p4Se)
            await ensureAt(p4RedSku, p4RedId, p4Main, 5)
            const seMainBefore = await levelAt(p4RedId, p4Main)
            const seConv = await convertBookingToInvoice(p4Se, { actor: 'tester' })
            assert.ok(seConv.ok, JSON.stringify(seConv))
            // Let the fire-and-forget attempt run and (per the flag) fail.
            await new Promise((resolve) => setTimeout(resolve, 300))
            const seRow = (await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, p4Se)).limit(1))[0]
            const seInv = await invoiceByNumber(String(seRow.invoice))
            assert.ok(seInv, 'the invoice committed despite the side-effect outage')
            assert.equal((await paymentsForRef(String(seRow.internalId))).length, 1, 'the advance (an in-transaction record) committed too')
            assert.equal(await levelAt(p4RedId, p4Main), seMainBefore - 5, 'stock deducted exactly once, even with the outage')
            assert.equal((await countJournals(seInv!.id, 'invoice')).length, 0, 'the journal failed after commit — nothing landed')
            assert.equal((await countAwards(seInv!.id)).length, 0, 'the loyalty award failed after commit — nothing landed')

            // Clear the outage and recover: only the MISSING effects run.
            delete process.env.OPAL_SIDEEFFECT_FAIL
            const recover1 = await ensureInvoiceSideEffects(seInv!.id, { actor: 'tester' })
            assert.ok(recover1.ran.includes('journal'), `recovery re-ran the missing journal (${JSON.stringify(recover1)})`)
            assert.ok(recover1.ran.includes('loyalty'), `recovery re-ran the missing loyalty award (${JSON.stringify(recover1)})`)
            assert.ok(
              !recover1.failed.includes('journal') && !recover1.failed.includes('loyalty'),
              'the recovered effects succeeded',
            )
            assert.equal((await countJournals(seInv!.id, 'invoice')).length, 1, 'exactly ONE journal entry exists now')
            assert.equal((await countAwards(seInv!.id)).length, 1, 'exactly ONE loyalty award exists now')

            // A second recovery pass: nothing missing, nothing duplicated.
            const recover2 = await ensureInvoiceSideEffects(seInv!.id, { actor: 'tester' })
            assert.ok(
              !recover2.ran.includes('journal') && !recover2.ran.includes('loyalty'),
              'nothing was missing on the second pass',
            )
            assert.equal((await countJournals(seInv!.id, 'invoice')).length, 1, 'still exactly one journal')
            assert.equal((await countAwards(seInv!.id)).length, 1, 'still exactly one award')

            // A conversion retry after the failure: same invoice, no second
            // claim, no second advance — and safe to re-ensure from there.
            const seRetry = await raiseInvoiceForOrder(seRow)
            assert.equal(seRetry.claimed, false, 'a retry never claims again')
            assert.equal(seRetry.number, seRow.invoice, '…it reuses the committed invoice')
            assert.equal((await paymentsForRef(String(seRow.internalId))).length, 1, 'no second advance payment')
            assert.equal((await countJournals(seInv!.id, 'invoice')).length, 1, 'no second journal')

            // The periodic sweep uses the same ensure path and stays
            // idempotent over invoices that are already complete.
            const sweep = await runSideEffectRecovery()
            assert.ok(sweep.scanned > 0, 'the sweep looks at recent invoices')
            assert.equal((await countJournals(seInv!.id, 'invoice')).length, 1, 'sweep idempotent: still one journal')
            assert.equal((await countAwards(seInv!.id)).length, 1, 'sweep idempotent: still one award')
          } finally {
            delete process.env.OPAL_SIDEEFFECT_FAIL
            await db!.update(schema.settings).set({ loyaltyEnabled: null }).where(eq(schema.settings.id, 'app'))
            loyaltyMod.invalidateConfig()
          }

          // ── (H4) Split-invoice edit contract: locations flow through the
          //      API, header-only edits never touch fulfilment lines, and a
          //      store-less replacement line on a split invoice is refused
          //      with a clear message — never a silent default store. ──────
          const splitItems0 = await itemsOf(msInv2!.id)
          assert.equal(splitItems0.length, 2, 'the split invoice still has one item per store')
          const splitMain0 = await levelAt(p4RedId, p4Main)
          const splitCtr0 = await levelAt(p4RedId, stockLocationId)

          // (a) Header-only edit: fulfilment lines and their stores preserved.
          const headerEdit = await call(adminId, 'PATCH', `/db/invoices/${msInv2!.id}`, { discount: 10 })
          assert.equal(headerEdit.status, 200, JSON.stringify(headerEdit.body))
          const splitItems1 = await itemsOf(msInv2!.id)
          assert.equal(splitItems1.length, 2, 'a header edit never rewrites the lines')
          assert.deepEqual(
            splitItems1.map((i) => `${i.locationId}:${Number(i.qty)}`).sort(),
            splitItems0.map((i) => `${i.locationId}:${Number(i.qty)}`).sort(),
            '…and never moves a line to another store',
          )
          assert.equal(await levelAt(p4RedId, p4Main), splitMain0, 'stock untouched by a header edit')
          assert.equal(await levelAt(p4RedId, stockLocationId), splitCtr0, 'stock untouched by a header edit')

          // (b) Replacement lines WITHOUT a store on a split invoice → clear
          //     400, everything rolled back.
          const bareLine = (i: { product: string; sku: string; qty: number; tax: number; amount: number }) => ({
            product: i.product,
            sku: i.sku,
            qty: i.qty,
            weight: 0,
            silverRate: 0,
            makingCharge: 0,
            tax: i.tax,
            amount: i.amount,
          })
          const noStore = await call(adminId, 'PATCH', `/db/invoices/${msInv2!.id}`, {
            items: splitItems0.map((i) => bareLine({ product: String(i.product ?? ''), sku: String(i.sku ?? ''), qty: Number(i.qty), tax: Number(i.tax), amount: Number(i.amount) })),
          })
          assert.equal(noStore.status, 400, JSON.stringify(noStore.body))
          assert.match(String(noStore.body.error), /multiple stores/, 'the refusal explains exactly what is missing')
          assert.equal((await itemsOf(msInv2!.id)).length, 2, 'the refused edit wrote nothing')
          assert.equal(await levelAt(p4RedId, p4Main), splitMain0, 'stock untouched by the refused edit')

          // (c) Replacement lines WITH each line's store → applied at those
          //     stores through the existing API contract (net-zero here).
          const withStores = await call(adminId, 'PATCH', `/db/invoices/${msInv2!.id}`, {
            items: splitItems0.map((i) => ({
              ...bareLine({ product: String(i.product ?? ''), sku: String(i.sku ?? ''), qty: Number(i.qty), tax: Number(i.tax), amount: Number(i.amount) }),
              locationId: i.locationId,
            })),
          })
          assert.equal(withStores.status, 200, JSON.stringify(withStores.body))
          const splitItems3 = await itemsOf(msInv2!.id)
          assert.equal(splitItems3.length, 2)
          assert.deepEqual(
            splitItems3.map((i) => i.locationId).sort(),
            [p4Main, stockLocationId].sort(),
            'each replacement line carries its store through the API contract',
          )
          assert.equal(await levelAt(p4RedId, p4Main), splitMain0, 'Main: restored then re-deducted — net zero')
          assert.equal(await levelAt(p4RedId, stockLocationId), splitCtr0, 'the counter likewise')

          // (d) A SINGLE-store invoice keeps working without any location on
          //     the replacement lines — its own store is used, as before.
          const htItems0 = await itemsOf(htInv!.id)
          const htMain0 = await levelAt(p4RedId, p4Main)
          const singleEdit = await call(adminId, 'PATCH', `/db/invoices/${htInv!.id}`, {
            items: htItems0.map((i) => bareLine({ product: String(i.product ?? ''), sku: String(i.sku ?? ''), qty: Number(i.qty), tax: Number(i.tax), amount: Number(i.amount) })),
          })
          assert.equal(singleEdit.status, 200, JSON.stringify(singleEdit.body))
          assert.equal(await levelAt(p4RedId, p4Main), htMain0, 'net zero at the invoice’s own store')
          const htItems1 = await itemsOf(htInv!.id)
          assert.ok(
            htItems1.every((i) => i.locationId === p4Main),
            'the replacement lines recorded that store (the invoice’s single fulfilment store)',
          )

          // ═══ Phase 5.1: booking advance payment ledger ════════════════════
          // An APPEND-ONLY record of actual cash: a collection is written
          // once and never overwritten; an increase adds a separate delta
          // collection; a decrease without an actual refund moves no money;
          // CANCELLATION moves no money at all (it only makes the advance
          // refundable); an Advance Refund is written ONLY when an operator
          // confirms the cash actually went back, capped so a duplicate can
          // never double-pay. Day-book and statistics read these rows as-is.

          // ── (L1) CREATE: exactly one collection row, un-invoiced. ─────────
          const led1 = await call(adminId, 'POST', '/db/bookings', {
            customer,
            items: [{ product: 'Phase4 — red', sku: p4RedSku, qty: 2, price: 300, productId: p4Prod.id, variantId: p4RedId }],
            advanceAmount: 200,
          })
          assert.equal(led1.status, 200, JSON.stringify(led1.body))
          const led1Id = String(led1.body.id)
          allBookingIds.push(led1Id)
          const led1Ref = String(led1.body.internalId)
          let ledRows = await paymentsForRef(led1Ref)
          assert.equal(ledRows.length, 1, 'EXACTLY ONE collection row exists right after create')
          assert.equal(Number(ledRows[0].amount), 200, 'for the advance actually collected')
          assert.equal(ledRows[0].method, 'Advance')
          assert.equal(ledRows[0].gateway, 'booking')
          assert.equal(ledRows[0].status, 'paid')
          assert.equal(ledRows[0].invoice, null, 'not yet invoiced — it belongs to the booking')
          const led1RowId = ledRows[0].id

          // A booking with NO advance records no payment row.
          const led0 = await call(adminId, 'POST', '/db/bookings', {
            customer,
            items: [{ product: 'Phase4 — red', sku: p4RedSku, qty: 1, price: 300, productId: p4Prod.id, variantId: p4RedId }],
          })
          assert.equal(led0.status, 200, JSON.stringify(led0.body))
          const led0Id = String(led0.body.id)
          allBookingIds.push(led0Id)
          assert.equal((await paymentsForRef(String(led0.body.internalId))).length, 0, 'no advance → no ledger row')

          // ── (L2) EDIT: an increase is an ADDITIONAL collection (history is
          //      never overwritten); a decrease without an actual refund
          //      moves no money at all. ─────────────────────────────────────
          const ledInc = await call(adminId, 'PATCH', `/db/bookings/${led1Id}`, { advanceAmount: 350 })
          assert.equal(ledInc.status, 200, JSON.stringify(ledInc.body))
          assert.equal(Number(ledInc.body.advancePaid), 350, 'the booking TERMS move to the new amount')
          ledRows = await paymentsForRef(led1Ref)
          assert.equal(ledRows.length, 2, 'an increase records a SEPARATE additional-collection row')
          const ledOriginal = ledRows.find((p) => p.id === led1RowId)
          assert.ok(ledOriginal, 'the original collection still exists')
          assert.equal(Number(ledOriginal!.amount), 200, '…UNTOUCHED — a completed collection is never overwritten')
          const ledDelta = ledRows.find((p) => p.id !== led1RowId)
          assert.ok(ledDelta, 'the delta is its own auditable entry')
          assert.equal(Number(ledDelta!.amount), 150, 'for exactly the increase (350 − 200)')
          assert.equal(ledDelta!.method, 'Advance')
          const sumLed = (rows: typeof ledRows) => Math.round(rows.reduce((a, p) => a + Number(p.amount ?? 0), 0) * 100) / 100
          assert.equal(sumLed(ledRows), 350, 'Σ collections == the new terms, each cash event counted once')

          const ledDec = await call(adminId, 'PATCH', `/db/bookings/${led1Id}`, { advanceAmount: 150 })
          assert.equal(ledDec.status, 200, JSON.stringify(ledDec.body))
          assert.equal(Number(ledDec.body.advancePaid), 150, 'the TERMS decrease')
          ledRows = await paymentsForRef(led1Ref)
          assert.equal(ledRows.length, 2, 'a decrease without an actual refund adds NO ledger row')
          assert.equal(sumLed(ledRows), 350, '…and the recorded cash stays intact (terms 150 ≠ cash 350 by design)')
          assert.equal(ledRows.filter((p) => p.method === 'Advance Refund').length, 0, 'no refund was invented for a decrease')

          // A duplicate request (same value re-sent) is a no-op on the ledger.
          const ledDupEdit = await call(adminId, 'PATCH', `/db/bookings/${led1Id}`, { advanceAmount: 150 })
          assert.equal(ledDupEdit.status, 200, JSON.stringify(ledDupEdit.body))
          ledRows = await paymentsForRef(led1Ref)
          assert.equal(ledRows.length, 2, 're-sending the same advance never duplicates')

          // ── (L3) CANCELLATION WITHOUT REFUND: status only — no cash moves,
          //      the collection stays intact, and the booking is REPORTED as
          //      refundable instead. ────────────────────────────────────────
          const ledCancel = await call(adminId, 'PATCH', `/db/sales-orders/${led1Id}/status`, { status: 'cancelled' })
          assert.equal(ledCancel.status, 200, JSON.stringify(ledCancel.body))
          ledRows = await paymentsForRef(led1Ref)
          assert.equal(ledRows.length, 2, 'cancellation adds NO payment row')
          assert.equal(ledRows.filter((p) => p.method === 'Advance Refund').length, 0, 'cancellation is NOT a refund')
          assert.equal(sumLed(ledRows), 350, 'every collection is intact after cancellation')
          const ledEvents = await db!.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, led1Id))
          assert.ok(!ledEvents.some((e) => e.event === 'Advance Refunded'), 'no refund event fires on cancel — only on an explicit refund')

          // The API reports the cash truth: what is collected, and what is
          // refundable on this cancelled booking (ledger-only).
          const ledList1 = await call(adminId, 'GET', '/db/bookings')
          assert.equal(ledList1.status, 200)
          const led1Listed1 = (ledList1.body.data as Array<Record<string, any>>).find((r) => r.id === led1Id)
          assert.ok(led1Listed1, 'the booking is on the list')
          assert.equal(Number(led1Listed1!.advanceCollected), 350, 'statistics report ACTUAL cash (not the 150 terms)')
          assert.equal(Number(led1Listed1!.advanceRefundable), 350, 'a cancelled booking marks its held cash refundable')

          // The day book right after cancel: cash in, NO cash out yet.
          const dayAfterCancel = await call(adminId, 'GET', '/db/reports/day-book')
          assert.equal(dayAfterCancel.status, 200, JSON.stringify(dayAfterCancel.body).slice(0, 300))
          const day1Rows = (dayAfterCancel.body.payments as Array<Record<string, any>>).filter((p) => p.ref === led1Ref)
          assert.equal(day1Rows.length, 2, 'the day book shows only the two collections after cancel')
          assert.ok(day1Rows.every((p) => Number(p.amount) > 0), '…all cash-in: cancellation moved no money')

          // ── (L4) DUPLICATE REQUESTS: a repeated cancel still moves no      //      money, and editing a cancelled booking adds no rows. ──────────
          const ledCancel2 = await call(adminId, 'PATCH', `/db/sales-orders/${led1Id}/status`, { status: 'cancelled' })
          assert.equal(ledCancel2.status, 200, JSON.stringify(ledCancel2.body))
          ledRows = await paymentsForRef(led1Ref)
          assert.equal(ledRows.length, 2, 'cancelling twice never invents a refund')

          const ledCancelEdit = await call(adminId, 'PATCH', `/db/bookings/${led1Id}`, { advanceAmount: 400 })
          assert.equal(ledCancelEdit.status, 200, JSON.stringify(ledCancelEdit.body))
          ledRows = await paymentsForRef(led1Ref)
          assert.equal(ledRows.length, 2, 'an edit on a cancelled booking adds no ledger rows (cash untouched)')

          // ── (L5) EXPLICIT REFUND: only an operator confirmation moves money
          //      — validation, partial, over-refund, full, duplicate. ───────
          // Refunds are for CANCELLED bookings only:
          const badRefund = await call(adminId, 'POST', `/db/bookings/${led0Id}/refund-advance`, {})
          assert.equal(badRefund.status, 400, JSON.stringify(badRefund.body))
          assert.match(String(badRefund.body.error), /only on a cancelled booking/)

          // Partial refund of 100:
          const partialRefund = await call(adminId, 'POST', `/db/bookings/${led1Id}/refund-advance`, { amount: 100 })
          assert.equal(partialRefund.status, 200, JSON.stringify(partialRefund.body))
          assert.equal(Number(partialRefund.body.amount), 100, 'the requested partial amount was recorded')
          assert.equal(Number(partialRefund.body.refundable), 250, 'the remaining refundable balance comes back')
          ledRows = await paymentsForRef(led1Ref)
          assert.equal(ledRows.length, 3, 'ONE refund entry added; both collections untouched')
          assert.equal(Number(ledRows.find((p) => p.id === led1RowId)!.amount), 200, 'the original collection is still intact')
          const partialRow = ledRows.find((p) => Number(p.amount) === -100)
          assert.ok(partialRow, 'the partial refund is its own negative entry')
          assert.equal(partialRow!.method, 'Advance Refund')
          assert.equal(partialRow!.status, 'refunded')
          assert.equal(partialRow!.invoice, null, 'refund is booking-scoped')
          const ledEvents2 = await db!.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, led1Id))
          assert.ok(ledEvents2.some((e) => e.event === 'Advance Refunded'), 'the explicit refund is on the booking timeline')

          // Over-refund refused — the cap is the remaining refundable cash:
          const overRefund = await call(adminId, 'POST', `/db/bookings/${led1Id}/refund-advance`, { amount: 1000 })
          assert.equal(overRefund.status, 400, JSON.stringify(overRefund.body))
          assert.match(String(overRefund.body.error), /exceeds the refundable advance/)
          assert.equal((await paymentsForRef(led1Ref)).length, 3, 'the refused over-refund wrote nothing')

          // Full remaining refund (no amount = everything still refundable):
          const fullRefund = await call(adminId, 'POST', `/db/bookings/${led1Id}/refund-advance`, {})
          assert.equal(fullRefund.status, 200, JSON.stringify(fullRefund.body))
          assert.equal(Number(fullRefund.body.amount), 250, 'refunds the whole remaining balance')
          assert.equal(Number(fullRefund.body.refundable), 0, 'nothing refundable afterwards')
          ledRows = await paymentsForRef(led1Ref)
          assert.equal(ledRows.length, 4, 'two collections + two refunds — every event its own row')
          assert.equal(sumLed(ledRows), 0, 'net cash zero after the full refund')

          // A duplicate of the now-full refund is refused, changing nothing:
          const dupRefund = await call(adminId, 'POST', `/db/bookings/${led1Id}/refund-advance`, {})
          assert.equal(dupRefund.status, 400, JSON.stringify(dupRefund.body))
          assert.match(String(dupRefund.body.error), /Nothing refundable/)
          assert.equal((await paymentsForRef(led1Ref)).length, 4, 'the duplicate refund wrote nothing')

          const ledList2 = await call(adminId, 'GET', '/db/bookings')
          const led1Listed2 = (ledList2.body.data as Array<Record<string, any>>).find((r) => r.id === led1Id)
          assert.equal(Number(led1Listed2!.advanceCollected), 0, 'statistics follow the actual cash to zero')
          assert.equal(Number(led1Listed2!.advanceRefundable), 0, 'nothing left to refund')

          // ── (L6) CONVERSION: collections are RE-POINTED (each cash event
          //      credited exactly once), never duplicated; stock moves once. ─
          const led5 = await call(adminId, 'POST', '/db/bookings', {
            customer,
            items: [{ product: 'Phase4 — red', sku: p4RedSku, qty: 2, price: 300, productId: p4Prod.id, variantId: p4RedId }],
            advanceAmount: 250,
          })
          assert.equal(led5.status, 200, JSON.stringify(led5.body))
          const led5Id = String(led5.body.id)
          allBookingIds.push(led5Id)
          const led5Ref = String(led5.body.internalId)
          assert.equal((await paymentsForRef(led5Ref)).length, 1, 'recorded at collection')
          await ensureAt(p4RedSku, p4RedId, p4Main, 2)
          const led5Main = await levelAt(p4RedId, p4Main)
          const led5Conv = await convertBookingToInvoice(led5Id, { actor: 'tester' })
          assert.ok(led5Conv.ok, JSON.stringify(led5Conv))
          const led5Number = led5Conv.ok ? led5Conv.invoiceNumber : ''
          const led5Rows = await paymentsForRef(led5Ref)
          assert.equal(led5Rows.length, 1, 'conversion REUSES the collected advance — no second row')
          assert.equal(Number(led5Rows[0].amount), 250, 'the amount conversion saw is what was collected')
          assert.equal(led5Rows[0].invoice, led5Number, 'pointed at THE invoice it belongs to')
          assert.equal(await levelAt(p4RedId, p4Main), led5Main - 2, 'stock deducted exactly once')

          const led5Again = await convertBookingToInvoice(led5Id)
          assert.equal(led5Again.ok, false, 'a repeat conversion is refused')
          assert.equal((await paymentsForRef(led5Ref)).length, 1, '…and never duplicates the advance')

          // A booking whose advance was INCREASED before conversion: BOTH
          // collections credit the invoice, each exactly once.
          const led7 = await call(adminId, 'POST', '/db/bookings', {
            customer,
            items: [{ product: 'Phase4 — red', sku: p4RedSku, qty: 2, price: 300, productId: p4Prod.id, variantId: p4RedId }],
            advanceAmount: 100,
          })
          assert.equal(led7.status, 200, JSON.stringify(led7.body))
          const led7Id = String(led7.body.id)
          allBookingIds.push(led7Id)
          const led7Ref = String(led7.body.internalId)
          const led7Edit = await call(adminId, 'PATCH', `/db/bookings/${led7Id}`, { advanceAmount: 400 })
          assert.equal(led7Edit.status, 200, JSON.stringify(led7Edit.body))
          assert.equal((await paymentsForRef(led7Ref)).length, 2, 'initial + additional collection')
          await ensureAt(p4RedSku, p4RedId, p4Main, 2)
          const led7Conv = await convertBookingToInvoice(led7Id, { actor: 'tester' })
          assert.ok(led7Conv.ok, JSON.stringify(led7Conv))
          const led7Number = led7Conv.ok ? led7Conv.invoiceNumber : ''
          const led7Rows = await paymentsForRef(led7Ref)
          assert.equal(led7Rows.length, 2, 'conversion adds NO third row')
          assert.ok(led7Rows.every((p) => p.invoice === led7Number), 'BOTH collections are pointed at the invoice')
          assert.equal(sumLed(led7Rows), 400, 'the invoice is credited the full cash collected, once per event')
          const led7Again = await convertBookingToInvoice(led7Id)
          assert.equal(led7Again.ok, false)
          assert.equal((await paymentsForRef(led7Ref)).length, 2, 'a repeat conversion never duplicates')

          // ── (L7) DAY-BOOK: after the explicit refunds the cash-out rows
          //      appear; totals remain the raw sum (no double-counting). ────
          const dayBook = await call(adminId, 'GET', '/db/reports/day-book')
          assert.equal(dayBook.status, 200, JSON.stringify(dayBook.body).slice(0, 300))
          const dayPayments = dayBook.body.payments as Array<Record<string, any>>
          const led1Day = dayPayments.filter((p) => p.ref === led1Ref)
          assert.equal(led1Day.length, 4, 'two collections AND the two explicit refunds are in the day book')
          assert.ok(led1Day.some((p) => Number(p.amount) === 200), 'the original cash in')
          assert.ok(led1Day.some((p) => Number(p.amount) === 150), 'the additional collection')
          assert.ok(led1Day.some((p) => Number(p.amount) === -100), 'the partial refund is today’s cash out')
          assert.ok(led1Day.some((p) => Number(p.amount) === -250), '…and so is the full refund')
          const led5Day = dayPayments.find((p) => p.ref === led5Ref)
          assert.ok(led5Day && Number(led5Day.amount) === 250, 'a converted booking’s advance is in the day book too')
          const daySum = dayPayments.reduce((a, p) => a + Number(p.amount ?? 0), 0)
          assert.ok(
            Math.abs(daySum - Number(dayBook.body.totals.collected)) < 0.01,
            'totals.collected is the raw sum of the day’s payments — every cash event counted exactly once',
          )
        } finally {
          server.close()
        }
      } finally {
        // Remove everything this run created, in dependency order. The scratch
        // database holds nothing else, but the marker keeps the sweep precise.
        const invoiceRows = await db!
          .select({ id: schema.salesInvoices.id, number: schema.salesInvoices.number })
          .from(schema.salesInvoices)
          .where(eq(schema.salesInvoices.customer, customer))
        if (invoiceRows.length > 0) {
          await db!.delete(schema.payments).where(
            inArray(schema.payments.invoice, invoiceRows.map((i) => i.number)),
          )
        }
        for (const inv of invoiceRows) {
          await db!.delete(schema.salesInvoiceItems).where(eq(schema.salesInvoiceItems.invoiceId, inv.id))
          await db!.delete(schema.salesInvoices).where(eq(schema.salesInvoices.id, inv.id))
        }
        await db!.delete(schema.orderEvents).where(inArray(schema.orderEvents.orderId, allBookingIds))
        await db!.delete(schema.bookingAllocations).where(inArray(schema.bookingAllocations.orderId, allBookingIds))
        await db!.delete(schema.salesOrders).where(inArray(schema.salesOrders.id, allBookingIds))
        await db!.delete(schema.users).where(inArray(schema.users.id, [adminId, viewerId]))
        // Stock-guard fixtures: ledger rows first, then variants, then products.
        if (stockProductIds.length > 0) {
          await db!.delete(schema.stockLevels).where(inArray(schema.stockLevels.productId, stockProductIds))
          await db!.delete(schema.stockMovements).where(inArray(schema.stockMovements.productId, stockProductIds))
          await db!.delete(schema.productVariants).where(inArray(schema.productVariants.productId, stockProductIds))
          await db!.delete(schema.products).where(inArray(schema.products.id, stockProductIds))
        }
        await db!.delete(schema.inventoryLocations).where(eq(schema.inventoryLocations.id, stockLocationId))
        // Customers the HTTP workflow linked/created (scratch DB, marker-driven).
        await db!.delete(schema.customers).where(or(
          eq(schema.customers.email, 'priya@example.com'),
          eq(schema.customers.email, 'priya.sharma@example.com'),
          eq(schema.customers.id, `${marker}-picked-cust`),
          ilike(schema.customers.name, `${marker}%`),
        ))
        await db!.delete(schema.products).where(eq(schema.products.id, productId))
        await db!.delete(schema.silverRates).where(eq(schema.silverRates.id, `${marker}-rate`))
      }
    } finally {
      // Leave no scratch database behind.
      const cleanup = postgres(baseDbUrl, { max: 1 })
      try {
        await cleanup.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
      } finally {
        await cleanup.end({ timeout: 5 })
      }
    }
  },
)
