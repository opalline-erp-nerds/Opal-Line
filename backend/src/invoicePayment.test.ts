import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeInvoicePayment,
  normalizeInvoicePaymentPatch,
  paymentMethodLabel,
  paymentStatusLabel,
} from './invoicePayment'
import { formatIstDate } from './istDate'

test('status words never become a payment method', () => {
  for (const method of ['Pending', 'pending', 'paid', 'issued', 'Settled', '', undefined]) {
    const row = normalizeInvoicePayment({ paymentMethod: method, paymentStatus: 'pending', status: 'issued' })
    assert.equal(row.paymentMethod, null, `${String(method)} is not a real method`)
    assert.equal(row.paymentStatus, 'pending')
  }
  assert.equal(paymentMethodLabel('Pending'), '—')
  assert.equal(paymentMethodLabel('cod'), 'Cash on delivery')
})

test('unpaid and Cash/UPI payments keep a truthful state and id', () => {
  const unpaid = normalizeInvoicePayment({ paymentMethod: 'Pending', paymentStatus: 'pending', status: 'issued' })
  assert.deepEqual(unpaid, { paymentMethod: null, paymentStatus: 'pending', paymentId: null, status: 'issued' })

  const cash = normalizeInvoicePayment({ paymentMethod: 'Cash', paymentStatus: 'paid', status: 'paid' })
  assert.equal(cash.paymentMethod, 'Cash')
  assert.equal(cash.paymentStatus, 'paid')
  assert.equal(cash.paymentId, null, 'cash has no gateway id')

  const upi = normalizeInvoicePayment({ paymentMethod: 'upi', paymentStatus: 'paid', status: 'paid' })
  assert.equal(upi.paymentMethod, 'UPI')
  assert.equal(upi.paymentStatus, 'paid')
  assert.equal(upi.paymentId, null)
})

test('a real Razorpay id is persisted and drives the gateway method', () => {
  const fromId = normalizeInvoicePayment({
    paymentMethod: '',
    paymentStatus: 'paid',
    status: 'paid',
    razorpayPaymentId: 'pay_Mx82KdL9pR7q2a',
  })
  assert.equal(fromId.paymentId, 'pay_Mx82KdL9pR7q2a')
  assert.equal(fromId.paymentMethod, 'Razorpay')
  assert.equal(fromId.paymentStatus, 'paid')

  const fromPaymentId = normalizeInvoicePayment({
    paymentMethod: 'Razorpay',
    paymentStatus: 'paid',
    status: 'paid',
    paymentId: 'pay_ABC123',
  })
  assert.equal(fromPaymentId.paymentId, 'pay_ABC123')

  // A gateway name or method with no real id must never invent an id.
  const unverified = normalizeInvoicePayment({
    paymentMethod: 'Razorpay',
    paymentGateway: 'razorpay',
    paymentStatus: 'paid',
    status: 'paid',
  })
  assert.equal(unverified.paymentId, null)

  // The id identifies the channel even when the attempt is still unpaid.
  const pendingAttempt = normalizeInvoicePayment({
    paymentStatus: 'pending',
    status: 'issued',
    paymentId: 'pay_PENDING123',
  })
  assert.equal(pendingAttempt.paymentId, 'pay_PENDING123')
  assert.equal(pendingAttempt.paymentMethod, 'Razorpay')
  assert.equal(pendingAttempt.paymentStatus, 'pending')
})

test('terminal document states override a stale paid snapshot', () => {
  const refunded = normalizeInvoicePayment({ paymentStatus: 'paid', status: 'refunded' })
  assert.equal(refunded.paymentStatus, 'refunded')
  assert.equal(refunded.status, 'refunded')

  const cancelled = normalizeInvoicePayment({ paymentStatus: 'paid', status: 'cancelled' })
  assert.equal(cancelled.paymentStatus, 'cancelled')
  assert.equal(paymentStatusLabel('partially_returned'), 'Partial')
})

test('PATCH only touches the payment fields the caller actually sent', () => {
  assert.deepEqual(normalizeInvoicePaymentPatch({ status: 'cancelled' }), {
    paymentStatus: 'cancelled',
    status: 'cancelled',
  })
  assert.deepEqual(normalizeInvoicePaymentPatch({ customer: 'ignored' } as never), {})
  const methodOnly = normalizeInvoicePaymentPatch({ paymentMethod: 'Pending' })
  assert.equal(methodOnly.paymentMethod, null)
  assert.equal(methodOnly.paymentStatus, undefined, 'a method edit must not reset the state')

  // Refunding preserves the real method/id: the historical payment channel is
  // still part of the record even though the money was returned.
  const refundPatch = normalizeInvoicePaymentPatch(
    { status: 'refunded', paymentStatus: 'refunded' },
    { paymentMethod: 'Cash', paymentStatus: 'paid', status: 'paid' },
  )
  assert.deepEqual(refundPatch, { paymentMethod: 'Cash', paymentStatus: 'refunded', status: 'refunded' })

  const razorpayPatch = normalizeInvoicePaymentPatch(
    { paymentStatus: 'refunded' },
    { paymentMethod: 'Razorpay', paymentStatus: 'paid', status: 'paid', paymentId: 'pay_REFUND1' },
  )
  assert.equal(razorpayPatch.paymentMethod, 'Razorpay')
  assert.equal(razorpayPatch.paymentId, undefined, 'an omitted id is never rewritten')
  assert.equal(razorpayPatch.paymentStatus, 'refunded')

  // A state-only edit still cleans a legacy status word out of the method.
  assert.equal(
    normalizeInvoicePaymentPatch({ paymentStatus: 'pending' }, { paymentMethod: 'Pending' }).paymentMethod,
    null,
  )
})

test('invoice and quotation PDF dates use the IST clock', () => {
  assert.match(formatIstDate('2026-11-26T05:57:00'), /26 Nov 2026/)
  assert.match(formatIstDate('2026-11-26T05:57:00', { withTime: true }), /11:27\s?am/i)
  assert.match(formatIstDate('2026-11-26 05:57:00', { withTime: true }), /11:27\s?am/i)
  assert.doesNotMatch(formatIstDate('2026-11-26T05:57:00', { withTime: true }), /5:57/)
})
