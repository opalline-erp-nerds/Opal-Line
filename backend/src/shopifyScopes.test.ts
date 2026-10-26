import test from 'node:test'
import assert from 'node:assert/strict'
import { REQUIRED_SHOPIFY_SCOPES, withScopeFixHint } from './shopify'

// Regression suite for the opaque "Access denied for draftOrderCreate field"
// error: a custom-app Admin API token without the write_draft_orders scope
// passed the connection probe and only failed when the first manual order
// tried to sync. The raw Shopify message must now name the missing scopes and
// say exactly where to grant and regenerate the token.

test("the real draftOrderCreate scope error becomes an actionable message", () => {
  const raw =
    'Access denied for draftOrderCreate field. Required access: `write_draft_orders` access scope or `write_quick_sale` access scope. ' +
    'The user must have access to manage draft orders.'
  const hint = withScopeFixHint(raw)
  assert.ok(hint.startsWith(raw), 'keeps Shopify\u2019s own words first')
  assert.match(hint, /Missing scope[s]?: write_draft_orders, write_quick_sale\./, 'names both accepted scopes')
  assert.match(hint, /Admin API scopes/, 'points at the Shopify admin screen')
  assert.match(hint, /REGENERATE/, 'an existing token keeps its old scopes — regeneration must be mentioned')
  assert.match(hint, /Settings → Connections/, 'points at where the new token goes in this app')
})

test('other API errors pass through unchanged', () => {
  const raw = 'Shopify API error 500: Internal Server Error'
  assert.equal(withScopeFixHint(raw), raw)
  assert.equal(withScopeFixHint('Order #1234 was not found on Shopify'), 'Order #1234 was not found on Shopify')
})

test('the required scope list covers every outbound flow', () => {
  for (const scope of ['write_draft_orders', 'write_orders', 'write_products', 'write_inventory'] as const) {
    assert.ok(REQUIRED_SHOPIFY_SCOPES.includes(scope), `${scope} is checked by the connection test`)
  }
  for (const scope of ['read_products', 'read_orders', 'read_customers', 'read_inventory'] as const) {
    assert.ok(REQUIRED_SHOPIFY_SCOPES.includes(scope), `${scope} is checked by the connection test`)
  }
})
