import test from 'node:test'
import assert from 'node:assert/strict'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { BookingDetailView } from './Bookings'
import type { OrderFullDetail, SalesOrder } from '@/types'

/** Server-render the view inside a router context — the customer link needs one. */
function renderView(view: ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter initialEntries={['/sales/bookings']}>{view}</MemoryRouter>)
}

// The Bookings page's view action (the row's eye button) opens this panel, so
// the panel is what gets pinned: the money the table promises (booked value,
// advance, outstanding), the booked lines, the invoice / payments / history the
// order-360 call adds once it resolves, and a usable summary while it is still
// loading or has failed. renderToStaticMarkup has no DOM and never runs
// effects, exactly like the Returns view tests — the fetch wiring lives in the
// page and is exercised by typecheck + the API contract.

const booking: SalesOrder = {
  id: 'bk-1',
  shopifyId: null as unknown as string,
  internalId: 'BK202611-123456',
  customer: 'Priya Sharma',
  customerEmail: 'priya@example.com',
  customerPhone: '9876543210',
  value: 10000,
  payment: 'pending',
  // The booking route stores `fulfillment: 'pending'` even though the shared
  // SalesOrder union (written for Shopify rows) does not list it — the fixture
  // mirrors what the API actually returns.
  fulfillment: 'pending' as unknown as SalesOrder['fulfillment'],
  invoice: null,
  status: 'confirmed',
  date: '2026-11-19T09:30:00.000Z',
  items: 2,
  tags: 'booking',
  currency: 'INR',
  discount: 0,
  lineItems: [{ title: 'Silver Ring', sku: 'RING-925', quantity: 2, price: 5000 }],
  isBooking: true,
  advancePaid: 3000,
}

const detail: OrderFullDetail = {
  order: {},
  items: [],
  invoice: {
    id: 'inv-1',
    number: 'INV-2026-00077',
    grandTotal: '10000',
    subtotal: '9708.74',
    gstAmount: '291.26',
    paymentStatus: 'pending',
    paymentMethod: 'Advance',
    status: 'issued',
    date: '2026-11-25T10:00:00.000Z',
    dueDate: null,
  },
  payments: [
    { id: 'pay-1', ref: 'BK202611-123456', amount: '3000', method: 'Advance', gateway: 'booking', status: 'paid', date: '2026-11-19T10:00:00.000Z' },
  ],
  shipment: null,
  events: [
    { id: 'ev-1', event: 'Booking Created', details: '2 item(s), value ₹10,000, advance ₹3,000', actor: 'admin', createdAt: '2026-11-19T09:30:01.000Z' },
    { id: 'ev-2', event: 'Booking Converted', details: 'Converted to invoice INV-2026-00077; advance applied ₹3,000', actor: 'admin', createdAt: '2026-11-25T10:00:00.000Z' },
  ],
  customer: null,
  contact: { name: 'Priya Sharma', email: 'priya@example.com', phone: '9876543210', address: null, city: null, state: null, pincode: null },
}

test('the booking view states the money: booked value, advance and what is still outstanding', () => {
  const html = renderView(<BookingDetailView booking={booking} detail={null} loading />)
  assert.ok(html.includes('BK202611-123456'), 'the booking number is shown')
  assert.ok(html.includes('Priya Sharma'), 'the customer is shown')
  assert.ok(html.includes('10,000'), 'the booked value is shown')
  assert.ok(html.includes('3,000'), 'the advance collected is shown')
  assert.ok(html.includes('7,000'), 'the outstanding balance (value − advance) is shown')
  assert.ok(html.includes('outstanding'), 'the outstanding figure is labelled')
  assert.ok(html.includes('Confirmed'), 'the booking status badge is rendered')
  assert.ok(html.includes('Advance pending'), 'the payment state badge is rendered')
  assert.ok(html.includes('Awaiting conversion'), 'an unconverted booking says so')
})

test('the booked line items list with quantities and line totals', () => {
  const html = renderView(<BookingDetailView booking={booking} detail={null} />)
  assert.ok(html.includes('Silver Ring'), 'the product name is listed')
  assert.ok(html.includes('RING-925'), 'the SKU is listed')
  assert.ok(html.includes('×'), 'the quantity × price line is listed')
  assert.ok(html.includes('5,000'), 'the per-unit price is listed')
  assert.ok(html.includes('10,000'), 'the line total (qty × price) is listed')
  assert.ok(html.includes('product(s)'), 'the line count is summarised')
})

test('a converted booking shows its invoice, the payment recorded and its history', () => {
  const html = renderView(<BookingDetailView booking={{ ...booking, invoice: 'INV-2026-00077', payment: 'paid' }} detail={detail} />)
  assert.ok(html.includes('INV-2026-00077'), 'the invoice number is linked in the header badge')
  assert.ok(!html.includes('Awaiting conversion'), 'a converted booking no longer reads as awaiting conversion')
  assert.ok(html.includes('Paid in full'), 'the paid state badge is rendered')
  assert.ok(html.includes('Advance'), 'the recorded payment method is listed')
  assert.ok(html.includes('Booking Created'), 'the creation event appears in the history')
  assert.ok(html.includes('Booking Converted'), 'the conversion event appears in the history')
  assert.ok(html.includes('INV-2026-00077; advance applied'), 'the event details are shown')
  assert.ok(html.includes('priya@example.com'), 'the customer contact from the order-360 call is shown')
})

test('the view stays useful while the detail call is in flight or has failed', () => {
  const loading = renderView(<BookingDetailView booking={booking} detail={null} loading />)
  assert.ok(loading.includes('Loading booking history'), 'a loading line is shown')
  assert.ok(loading.includes('10,000'), 'the summary renders from the row before the detail resolves')

  const failed = renderView(<BookingDetailView booking={booking} detail={null} error="Failed to load the booking details" />)
  assert.ok(failed.includes('Failed to load the booking details'), 'the fetch error is surfaced')
  assert.ok(failed.includes('10,000'), 'the row data still renders when the detail call fails')
})

test('a cancelled booking is labelled as cancelled, never as confirmed', () => {
  const html = renderView(
    <BookingDetailView booking={{ ...booking, status: 'cancelled' }} detail={null} />,
  )
  assert.ok(html.includes('Cancelled'), 'the cancelled status badge is rendered')
  assert.ok(!html.includes('Confirmed'), 'the stale confirmed badge is gone')
})

test('the customer links through to Customer 360', () => {
  const html = renderView(<BookingDetailView booking={booking} detail={null} />)
  assert.ok(
    html.includes('/sales/customers/Priya%20Sharma'),
    'the customer name is a link to their 360 page (bookings are matched by name)',
  )
})

test('contact stored on the booking shows before the order-360 call resolves', () => {
  const html = renderView(<BookingDetailView booking={booking} detail={null} loading />)
  assert.ok(html.includes('priya@example.com'), 'the booking email renders from the row itself')
  assert.ok(html.includes('9876543210'), 'the booking phone renders from the row itself')
})

test('the view shows the pricing breakdown the converted invoice inherits', () => {
  const html = renderView(<BookingDetailView booking={{ ...booking, gst: 7, discount: 100 }} detail={null} />)
  assert.ok(html.includes('Lines total (incl. GST)'), 'the entered (GST-inclusive) lines total is shown')
  assert.ok(html.includes('Subtotal (taxable)'), 'the taxable value is broken out')
  assert.ok(html.includes('GST (7%)'), 'the booked GST rate is shown, not a hard-coded one')
  assert.ok(html.includes('Discount'), 'the discount row is shown')
  assert.ok(html.includes('Grand total'), 'the grand total is labelled')
  assert.ok(html.includes('Outstanding'), 'the outstanding balance is shown')
  // 2 × 5000 @ 7% → taxable 9345.79, GST 654.21, − discount 100 → 9900.
  assert.ok(html.includes('9,345.79'), 'taxable = 10000 backed out of 7% GST')
  assert.ok(html.includes('9,900'), 'grand total = taxable + GST − discount')
})

test('expected delivery and notes travel onto the view', () => {
  const html = renderView(
    <BookingDetailView
      booking={{ ...booking, expectedDelivery: '2026-12-24 00:00:00', note: 'Deliver before Christmas', gst: 3 }}
      detail={null}
    />,
  )
  assert.ok(html.includes('Expected delivery'), 'the expected delivery row is shown')
  assert.ok(html.includes('Deliver before Christmas'), 'the note is shown')
})
