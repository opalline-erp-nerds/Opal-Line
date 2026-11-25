import test from 'node:test'
import assert from 'node:assert/strict'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { BookingAllocationBody, BookingDetailView, BookingLineAvailability, AllocationStatusChip } from './Bookings'
import type { BookingAllocationLine, InventoryLocation, LocationStockAvailability, OrderFullDetail, SalesOrder } from '@/types'

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

// ── Phase 1: variant identity + location-wise stock display ────────────────
// React separates adjacent JSX text nodes with <!-- -->, so these assertions
// normalise the markup first.
const plain = (html: string) => html.replace(/<!-- -->/g, '')

const twoStores = {
  locations: [
    { locationId: 'LOC-DEFAULT', name: 'Main Store', available: 5 },
    { locationId: 'LOC-2', name: '2nd Store', available: 2 },
  ],
  combined: 7,
}

test('a line shows the variant name, exact SKU and its selling price', () => {
  const html = plain(
    renderToStaticMarkup(
      <BookingLineAvailability
        sku="OL-GIF-001-RED"
        variantName="red"
        sellingPrice={4000}
        required={10}
        availability={twoStores}
      />,
    ),
  )
  assert.ok(html.includes('red'), 'the variant name is shown')
  assert.ok(html.includes('OL-GIF-001-RED'), 'the exact (variant) SKU is shown')
  assert.ok(html.includes('4,000'), 'the catalogue selling price is shown')
  assert.ok(html.includes('Required: 10'), 'the required quantity is stated next to availability')
})

test('stock is listed PER STORE, with the combined figure marked informational only', () => {
  const html = plain(
    renderToStaticMarkup(
      <BookingLineAvailability sku="OL-GIF-001-RED" variantName="red" required={10} availability={twoStores} />,
    ),
  )
  // Each store on its own row — never pre-combined.
  assert.ok(html.includes('Main Store') && html.includes('5 available'), 'Main Store balance on its own line')
  assert.ok(html.includes('2nd Store') && html.includes('2 available'), '2nd Store balance on its own line')
  // Required 10 vs 5 and 2 → both flagged, per store.
  assert.ok(html.includes('short 5'), 'Main Store shows it is short by 5')
  assert.ok(html.includes('short 8'), '2nd Store shows it is short by 8')
  // The combined total exists but is explicitly informational.
  assert.ok(html.includes('All stores:'), 'the combined figure is labelled')
  assert.ok(html.includes('7'), 'combined = 5 + 2')
  assert.ok(html.includes('informational only'), 'combined is never presented as spendable stock')
  assert.ok(html.includes('never allocated'), 'cross-store allocation is explicitly disclaimed')
})

test('a quantity every store can cover shows no shortage flags', () => {
  const html = plain(
    renderToStaticMarkup(
      <BookingLineAvailability sku="OL-GIF-001-RED" required={1} availability={twoStores} />,
    ),
  )
  assert.ok(html.includes('available'), 'per-store availability is still listed')
  assert.ok(!html.includes('short'), 'no shortage when every store covers the requirement')
  // The variant name renders as its own element — absent here (note: the
  // plain substring "red" also occurs inside "required", hence '>red<').
  assert.ok(!html.includes('>red</span>'), 'no variant name is invented for a product-only line')
})

test('loading and failure states are distinguishable from real stock', () => {
  const loading = plain(
    renderToStaticMarkup(<BookingLineAvailability sku="X" required={1} availability={null} />),
  )
  assert.ok(loading.includes('Availability by store'), 'in-flight state says availability is loading')
  assert.ok(!loading.includes('available'), 'no stock figures are shown before they are known')

  const failed = plain(
    renderToStaticMarkup(<BookingLineAvailability sku="X" required={1} availability={{ error: 'Failed to load stock by location' }} />),
  )
  assert.ok(failed.includes('Failed to load stock by location'), 'the fetch error surfaces')
  assert.ok(!failed.includes('available'), 'a failed fetch never renders as stock')
})

// ── Phase 2: single-store booking — the SELECTED store is actionable ───────
test('the selected store leads as actionable availability; other stores stay informational', () => {
  const html = plain(
    renderToStaticMarkup(
      <BookingLineAvailability
        sku="OL-GIF-001-RED"
        variantName="red"
        required={10}
        availability={twoStores}
        selectedLocationId="LOC-DEFAULT"
      />,
    ),
  )
  assert.ok(html.includes('Main Store') && html.includes('selected store'), 'the selected store is tagged as such')
  assert.ok(html.includes('5 available'), 'its balance is the actionable figure')
  assert.ok(html.includes('short 5'), 'the shortage is flagged ON the selected store')
  const selectedIdx = html.indexOf('Main Store')
  const groupIdx = html.indexOf('Other stores')
  const otherIdx = html.indexOf('2nd Store')
  assert.ok(selectedIdx > -1 && groupIdx > selectedIdx, 'the selected store row comes first, before the group label')
  assert.ok(otherIdx > groupIdx, 'other stores are grouped UNDER the informational label')
  assert.ok(html.includes('informational'), 'other stores are marked informational')
  assert.ok(html.includes('All stores:'), 'the combined figure remains visible')
  assert.ok(html.includes('informational only'), 'and is still labelled informational only')
})

test('selecting a different store flips which row is actionable', () => {
  const html = plain(
    renderToStaticMarkup(
      <BookingLineAvailability
        sku="OL-GIF-001-RED"
        required={10}
        availability={twoStores}
        selectedLocationId="LOC-2"
      />,
    ),
  )
  const selectedIdx = html.indexOf('2nd Store')
  const groupIdx = html.indexOf('Other stores')
  const otherIdx = html.indexOf('Main Store')
  assert.ok(selectedIdx > -1 && groupIdx > selectedIdx, '2nd Store becomes the selected row')
  assert.ok(otherIdx > groupIdx, 'Main Store drops into the informational group')
  assert.ok(html.includes('short 8'), 'the shortage now tracks the newly selected store (10 − 2)')
})

test('the booking view shows the selling store', () => {
  const html = renderView(
    <BookingDetailView booking={booking} detail={null} locationName="Main Store · Store · Chennai" />,
  )
  assert.ok(html.includes('Selling store'), 'the view names the store the booking sells from')
  assert.ok(html.includes('Main Store · Store · Chennai'), 'with the standard human location label')

  // Without the label nothing invents a store row (legacy pages stay intact).
  const without = renderView(<BookingDetailView booking={booking} detail={null} />)
  assert.ok(!without.includes('Selling store'), 'no store row is invented when the label is absent')
})

// ── Phase 3: allocation status chip + allocation editor body ────────────────
test('the allocation status chip covers Unallocated / Partial / Fully', () => {
  assert.ok(
    plain(renderToStaticMarkup(<AllocationStatusChip allocated={0} required={10} />)).includes('Unallocated'),
    'nothing planned yet',
  )
  assert.ok(
    plain(renderToStaticMarkup(<AllocationStatusChip allocated={4} required={10} />)).includes('Partially allocated 4/10'),
    'a partial plan shows its counts',
  )
  assert.ok(
    plain(renderToStaticMarkup(<AllocationStatusChip allocated={10} required={10} />)).includes('Fully allocated 10/10'),
    'a complete plan reads as fully allocated',
  )
  assert.equal(
    plain(renderToStaticMarkup(<AllocationStatusChip allocated={0} required={0} />)),
    '',
    'nothing tracked (legacy/hand-typed lines) renders no chip at all',
  )
})

const allocLines: BookingAllocationLine[] = [
  {
    lineIndex: 0,
    title: 'Silver toy — red',
    sku: 'OL-GIF-001-RED',
    productId: 'p1',
    variantId: 'v1',
    tracked: true,
    required: 10,
    allocated: 4,
    remaining: 6,
    status: 'partial',
  },
  {
    lineIndex: 1,
    title: 'Hand typed extra',
    sku: '',
    productId: null,
    variantId: null,
    tracked: false,
    required: 3,
    allocated: 0,
    remaining: 3,
    status: 'unallocated',
  },
]

const allocLocations: InventoryLocation[] = [
  { id: 'LOC-DEFAULT', name: 'Main Store', type: 'store', city: '', manager: '' },
  { id: 'L2', name: '2nd Store', type: 'store', city: '', manager: '' },
]

const allocAvailability: Record<string, LocationStockAvailability> = {
  'p1|v1': {
    locations: [
      { locationId: 'LOC-DEFAULT', name: 'Main Store', available: 6 },
      { locationId: 'L2', name: '2nd Store', available: 0 },
    ],
    combined: 6,
  },
}

const allocNoOps = { onAdd: () => {}, onRemove: () => {}, onChange: () => {} }

test('the allocation body shows identity, quantities, per-store stock and status', () => {
  const html = plain(
    renderToStaticMarkup(
      <BookingAllocationBody
        lines={allocLines}
        rows={[{ key: 'r1', lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: '4' }]}
        locations={allocLocations}
        availability={allocAvailability}
        {...allocNoOps}
      />,
    ),
  )
  assert.ok(html.includes('Silver toy — red') && html.includes('OL-GIF-001-RED'), 'product/variant identity of the line')
  assert.ok(html.includes('Required 10 · Draft allocated 4 · Remaining 6'), 'required, allocated and remaining quantities')
  assert.ok(html.includes('Partially allocated 4/10'), 'the live draft status chip')
  assert.ok(html.includes('Main Store:') && html.includes('6 available'), 'Main stock listed for THIS variant')
  assert.ok(html.includes('2nd Store:') && html.includes('0 available'), 'the other store listed separately — never pooled')
  assert.ok(html.includes('hand-typed line'), 'untracked lines are called out as needing no allocation')
  assert.ok(!html.includes('All stores'), 'the allocation body never shows a combined figure')
})

test('the allocation body surfaces validation errors per line', () => {
  const overStore = plain(
    renderToStaticMarkup(
      <BookingAllocationBody
        lines={allocLines}
        rows={[{ key: 'r1', lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: '7' }]}
        locations={allocLocations}
        availability={allocAvailability}
        {...allocNoOps}
      />,
    ),
  )
  assert.ok(overStore.includes('Only 6 available at that store'), 'an impossible store quantity is flagged inline')

  const serverSide = plain(
    renderToStaticMarkup(
      <BookingAllocationBody
        lines={allocLines}
        rows={[]}
        locations={allocLocations}
        availability={allocAvailability}
        serverError={'Insufficient Stock:\nSilver toy — red (OL-GIF-001-RED) @ Main Store — Available: 6, Requested: 9, Short by: 3'}
        serverLineErrors={{ 0: 'Allocated 9 but only 10 booked' }}
        {...allocNoOps}
      />,
    ),
  )
  assert.ok(serverSide.includes('Insufficient Stock'), 'the server refusal is shown')
  assert.ok(serverSide.includes('@ Main Store'), '…naming the store it measured')
  assert.ok(serverSide.includes('Allocated 9 but only 10 booked'), 'per-line server errors land on the line')
})

test('availability still loading is distinguished from real stock', () => {
  const html = plain(
    renderToStaticMarkup(
      <BookingAllocationBody
        lines={allocLines}
        rows={[]}
        locations={allocLocations}
        availability={{ 'p1|v1': null }}
        {...allocNoOps}
      />,
    ),
  )
  assert.ok(html.includes('Loading store availability'), 'in-flight state is explicit')
  assert.ok(!html.includes('available'), 'no stock figures are invented while loading')
})

test('a fully allocated line stops offering more stores', () => {
  const html = plain(
    renderToStaticMarkup(
      <BookingAllocationBody
        lines={allocLines}
        rows={[{ key: 'r1', lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: '10' }]}
        locations={allocLocations}
        availability={allocAvailability}
        {...allocNoOps}
      />,
    ),
  )
  const idx = html.indexOf('Add store')
  assert.ok(idx > -1, 'the add-store control exists')
  assert.ok(html.slice(0, idx).includes('disabled'), 'disabled once nothing remains unallocated')
  assert.ok(html.includes('Fully allocated 10/10'), 'the chip reflects the completed plan')
})
