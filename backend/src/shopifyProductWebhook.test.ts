import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { productFromWebhookBody } from './shopifyProductWebhook'

describe('shopifyProductWebhook', () => {
  test('productFromWebhookBody normalizes a REST product payload', () => {
    const p = productFromWebhookBody({
      id: 123,
      title: 'Webhook Item',
      variants: [{ id: 456, sku: 'W-1', price: '10', inventory_quantity: 1 }],
    })
    assert.ok(p)
    assert.equal(p?.id, 123)
    assert.equal(p?.sku, 'W-1')
  })
})