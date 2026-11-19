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
test('booking items: whole pieces only, sane prices, product and variant ids kept', async () => {
  const { normalizeBookingItems } = await import('./bookings')

  const ok = normalizeBookingItems([
    { product: '  Silver Ring ', sku: ' RING-1 ', qty: 2.9, price: 1234.567, productId: 'p1', variantId: 'v1' },
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
      const { eq, inArray, or, ilike } = await import('drizzle-orm')
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
        const server = app.listen(0, '127.0.0.1')
        // address() is null until the socket is actually listening.
        await new Promise<void>((resolve) => server.once('listening', () => resolve()))
        const port = Number((server.address() as { port: number }).port)
        const call = async (who: string, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) => {
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
        await db!.delete(schema.salesOrders).where(inArray(schema.salesOrders.id, allBookingIds))
        await db!.delete(schema.users).where(inArray(schema.users.id, [adminId, viewerId]))
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
