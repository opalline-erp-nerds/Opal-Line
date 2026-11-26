import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { InvoiceItemsCard, InvoicePaymentBadge, InvoicePaymentCard } from './InvoiceDetail'
import type { Invoice } from '@/types'

// These are the presentational halves of the detail screen. Server rendering
// them (the same pattern as Bookings.test.tsx) pins the payment and money copy
// without needing the API/effect lifecycle of the full page.

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-detail-1',
    number: 'SI202611268668',
    shopifyOrder: '#1001',
    customer: 'Ashok Testbuyer',
    customerEmail: 'ashok@example.com',
    customerPhone: '9000000001',
    customerAddress: '12 Test Street',
    customerCity: 'Coimbatore',
    customerState: 'Tamil Nadu',
    customerPincode: '641001',
    items: [
      { product: 'Silver Ring', sku: 'SKU-RING', hsn: '7113', qty: 1, weight: 25, silverRate: 100, makingCharge: 10, tax: 82.5, amount: 2750 },
    ],
    silverValue: 2500,
    makingCharge: 250,
    subtotal: 2750,
    gst: 3,
    gstAmount: 82.5,
    discount: 0,
    grandTotal: 2832.5,
    paymentMethod: '',
    paymentStatus: 'pending',
    status: 'issued',
    date: '2026-11-26T05:57:00',
    businessName: 'Opal Line',
    ...overrides,
  }
}

const render = (node: ReactNode) => renderToStaticMarkup(node)

test('an unpaid invoice with no payment id never renders a paid Razorpay card', () => {
  // The reported row had an empty Payment ID but still showed "Paid via
  // Razorpay", "Settled · reconciled with bank" and a gateway link.
  const invoice = makeInvoice({ paymentMethod: 'Pending' })
  const card = render(<InvoicePaymentCard invoice={invoice} />)
  const badge = render(<InvoicePaymentBadge invoice={invoice} />)

  assert.ok(badge.includes('PENDING'), 'badge must follow the real pending state')
  assert.ok(card.includes('Pending'), 'card headline must be Pending')
  assert.ok(card.includes('No payment recorded yet'))
  assert.ok(!card.includes('Paid via Razorpay'))
  assert.ok(!card.includes('Settled'))
  assert.ok(!card.includes('reconciled with bank'))
  assert.ok(!card.includes('Gateway'))
  assert.ok(!card.includes('View on Razorpay'))
  assert.ok(!card.includes('Payment ID'), 'an empty id must not be rendered at all')
})

test('a paid Cash or UPI invoice shows the real method and no gateway claim', () => {
  for (const method of ['Cash', 'UPI']) {
    const invoice = makeInvoice({ paymentMethod: method, paymentStatus: 'paid', status: 'paid' })
    const card = render(<InvoicePaymentCard invoice={invoice} />)
    const badge = render(<InvoicePaymentBadge invoice={invoice} />)

    assert.ok(badge.includes('PAID'))
    assert.ok(card.includes(`Paid · ${method}`), `${method} must be shown as the real method`)
    assert.ok(card.includes('Payment Method'))
    assert.ok(card.includes(method))
    assert.ok(!card.includes('via Razorpay'))
    assert.ok(!card.includes('Gateway'))
    assert.ok(!card.includes('View on Razorpay'))
    assert.ok(!card.includes('Payment ID'))
  }
})

test('a Razorpay card appears only when a real pay_ id is stored', () => {
  const paid = makeInvoice({
    paymentMethod: 'Razorpay',
    paymentStatus: 'paid',
    status: 'paid',
    paymentId: 'pay_Mx82KdL9pR7q2a',
  })
  const withId = render(<InvoicePaymentCard invoice={paid} />)
  assert.ok(withId.includes('Paid via Razorpay'))
  assert.ok(withId.includes('pay_Mx82KdL9pR7q2a'))
  assert.ok(withId.includes('Gateway'))
  assert.ok(withId.includes('View on Razorpay'))
  assert.ok(withId.includes('Razorpay payment captured for this invoice'))

  // A method alone is not proof of a captured payment. No id → no gateway,
  // settlement, id row or dashboard link, even if the method says Razorpay.
  const unverified = render(<InvoicePaymentCard invoice={makeInvoice({ ...paid, paymentId: undefined })} />)
  assert.ok(!unverified.includes('Paid via Razorpay'))
  assert.ok(!unverified.includes('Gateway'))
  assert.ok(!unverified.includes('View on Razorpay'))
  assert.ok(!unverified.includes('Payment ID'))

  const emptyId = render(<InvoicePaymentCard invoice={makeInvoice({ ...paid, paymentId: '' })} />)
  assert.ok(!emptyId.includes('Paid via Razorpay'))
  assert.ok(!emptyId.includes('View on Razorpay'))
})

test('badges reflect partial, refunded and cancelled states, not a hard-coded PAID', () => {
  const cases: Array<[Partial<Invoice>, string]> = [
    [{ paymentStatus: 'partial', status: 'issued' }, 'PARTIAL'],
    [{ paymentStatus: 'paid', status: 'refunded' }, 'REFUNDED'],
    [{ paymentStatus: 'paid', status: 'cancelled' }, 'CANCELLED'],
    [{ paymentStatus: 'failed', status: 'issued' }, 'FAILED'],
  ]
  for (const [overrides, expected] of cases) {
    assert.ok(render(<InvoicePaymentBadge invoice={makeInvoice(overrides)} />).includes(expected))
  }
})

test('detail line items and print agree on taxable, GST and gross money', () => {
  const invoice = makeInvoice({
    items: [
      { product: 'Silver Ring', sku: 'SKU-RING', hsn: '7113', qty: 1, weight: 25, silverRate: 100, makingCharge: 10, tax: 82.5, amount: 2750 },
      { product: 'Fixed Price Pendant', sku: 'SKU-FIX', hsn: '7113', qty: 1, weight: 0, silverRate: 0, makingCharge: 0, tax: 5.83, amount: 194.17 },
    ],
    subtotal: 2944.17,
    gstAmount: 88.33,
    grandTotal: 3032.5,
  })
  const html = render(<InvoiceItemsCard invoice={invoice} />)

  assert.ok(html.includes('2 line items'))
  assert.ok(html.includes('Taxable (ex GST)'))
  assert.ok(html.includes('Total (incl GST)'))
  assert.ok(html.includes('₹2,750.00'), 'weight line taxable money')
  assert.ok(html.includes('₹82.50'), 'weight line GST money')
  assert.ok(html.includes('₹2,832.50'), 'weight line gross money')
  assert.ok(html.includes('₹194.17'), 'piece-rate line taxable money')
  assert.ok(html.includes('₹5.83'), 'piece-rate line GST money')
  assert.ok(html.includes('₹200.00'), 'piece-rate line gross money')
  assert.ok(!html.includes('0.00 gm'), 'zero weight must be an em dash')
  assert.ok(html.includes('—'), 'unknown rate/making/weight values must dash')
})

test('one line item is singular on the detail screen', () => {
  const html = render(<InvoiceItemsCard invoice={makeInvoice()} />)
  assert.ok(html.includes('1 line item ·'))
  assert.ok(!html.includes('1 line items'))
  assert.ok(html.includes('1 item</span>'), 'footer count must be singular')
})
