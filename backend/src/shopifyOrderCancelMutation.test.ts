import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CANCEL_REASONS,
  ORDER_CANCEL_MUTATION,
  isCancelReason,
} from './shopifyOrderActions'

test('the cancel mutation declares Shopify non-null reason and restock variables', () => {
  assert.match(ORDER_CANCEL_MUTATION, /\$reason:\s*OrderCancelReason!/)
  assert.match(ORDER_CANCEL_MUTATION, /\$restock:\s*Boolean!/)
  assert.match(ORDER_CANCEL_MUTATION, /orderCancelUserErrors\s*\{\s*field\s+message\s*\}/)
})

test('cancellation reason validation accepts only Shopify enum values', () => {
  for (const reason of CANCEL_REASONS) {
    assert.equal(isCancelReason(reason), true)
    assert.equal(isCancelReason(reason.toLowerCase()), true)
  }
  assert.equal(isCancelReason(''), false)
  assert.equal(isCancelReason('not-a-reason'), false)
  assert.equal(isCancelReason(undefined), false)
})

test(
  'Shopify accepts non-null cancel variables (schema probe, no order changed)',
  { skip: process.env.SHOPIFY_CANCEL_PROBE === '1' ? false : 'SHOPIFY_CANCEL_PROBE is not set' },
  async () => {
    const { adminGraphQL } = await import('./shopifyRefunds')
    // A deliberately non-existent order id exercises variable/argument schema
    // validation without cancelling a real order. Any error must be about the
    // missing order, never a nullability mismatch on $reason/$restock.
    const result = await adminGraphQL(ORDER_CANCEL_MUTATION, {
      orderId: 'gid://shopify/Order/0',
      reason: 'OTHER',
      restock: true,
      notifyCustomer: false,
      staffNote: null,
      refundMethod: null,
    })
    const error = String(result.error ?? '')
    assert.doesNotMatch(error, /Nullability mismatch|Variable \$reason|Variable \$restock/i)
  },
)
