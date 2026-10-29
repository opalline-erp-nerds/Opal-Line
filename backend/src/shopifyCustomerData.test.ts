import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PLACEHOLDER_NAME_RE,
  EMAIL_AS_NAME_RE,
  isPlaceholderName,
  upgradeName,
  fillOrKeep,
  mergeAddress,
  orderCustomerPiiRedacted,
  parseOrderAddress,
  pickCustomerMatch,
  placeholderName,
  normalizeEmail,
  normalizePhone,
  numericShopifyOrderId,
  usableText,
} from './shopifyCustomerData'

// Regression suite for the Shopify customer data sync. Every historical bug
// here came from a Shopify quirk: plan-gated PII (fields arrive EMPTY or
// email-only), placeholder rows ("Shopify Customer #<id>") that real names
// never replaced, and case/format-poisoned email & phone matching that
// created duplicate customers.

// ─── Redacted / empty PII handling ───────────────────────────────────────

test('blank and redacted fields are recognized as missing', () => {
  for (const v of [null, undefined, '', '   ', 'redacted', 'REDACTED (redacted by app)', '-', 'n/a', 'undefined']) {
    assert.equal(usableText(v), null, `usable:${String(v)}`)
  }
  assert.ok(isPlaceholderName('redacted'), 'redacted names are blank-equivalent slots')
  assert.ok(!isPlaceholderName('Priya Sharma'))
})

test('fillOrKeep never lets a null, empty or redacted Shopify value erase ERP data', () => {
  const existing = '9876543210'
  for (const incoming of [null, undefined, '', '   ', 'redacted', 'REDACTED (redacted by app)']) {
    assert.equal(fillOrKeep(existing, incoming), existing, `incoming:${String(incoming)}`)
  }
  assert.equal(fillOrKeep(existing, '+91 98765 43210'), '+91 98765 43210', 'a usable fresh value does win')
  assert.equal(fillOrKeep(null, null), null, 'nothing to keep either side → null, not ""')
})

// ─── Placeholder names (requirement 1) ──────────────────────────────────

test('placeholder names are detected', () => {
  assert.ok(PLACEHOLDER_NAME_RE.test('Shopify Customer #9687733207291'))
  assert.ok(!PLACEHOLDER_NAME_RE.test('Shopify Customer #abc'), 'id must be numeric')
  assert.ok(!PLACEHOLDER_NAME_RE.test('Priya Sharma'))
  assert.ok(isPlaceholderName(null))
  assert.ok(isPlaceholderName(''))
  assert.ok(isPlaceholderName('Shopify Customer #123'))
})

test('a real Shopify name replaces the placeholder', () => {
  assert.equal(upgradeName('Shopify Customer #9687733207291', 'Priya Sharma'), 'Priya Sharma')
  assert.equal(upgradeName('Guest', 'Priya Sharma'), 'Priya Sharma')
  assert.equal(upgradeName(null, 'Priya Sharma'), 'Priya Sharma')
  assert.equal(upgradeName('', 'Priya Sharma'), 'Priya Sharma')
  // Email standing in for a redacted name is also upgradeable.
  assert.ok(EMAIL_AS_NAME_RE.test('priya@example.com'))
  assert.equal(upgradeName('priya@example.com', 'Priya Sharma'), 'Priya Sharma')
})

test('a real name is never replaced by a placeholder, blank or email', () => {
  assert.equal(upgradeName('Priya Sharma', 'Shopify Customer #9687733207291'), 'Priya Sharma')
  assert.equal(upgradeName('Priya Sharma', ''), 'Priya Sharma')
  assert.equal(upgradeName('Priya Sharma', null), 'Priya Sharma')
  assert.equal(upgradeName('Priya Sharma', 'priya@example.com'), 'Priya Sharma')
})

test('an email fills a blank name slot but keeps the placeholder (it is a lookup key)', () => {
  assert.equal(upgradeName(null, 'priya@example.com'), 'priya@example.com')
  assert.equal(upgradeName('Shopify Customer #123', 'priya@example.com'), 'Shopify Customer #123')
  assert.ok(EMAIL_AS_NAME_RE.test('priya@example.com'))
})

// ─── Missing email / phone: names + address still enrich (requirement 2) ─

test('city/province survive a null Shopify return and update on a real value', () => {
  assert.equal(fillOrKeep('Mumbai', null), 'Mumbai')
  assert.equal(fillOrKeep('Mumbai', 'Pune'), 'Pune')
  assert.equal(fillOrKeep(null, 'Pune'), 'Pune')
  assert.equal(fillOrKeep(null, ''), null)
})

test('a customer with no email or phone can still get its name upgraded', () => {
  // enrichCustomers selects by placeholder-name too; the name math is here.
  const updated = upgradeName('Shopify Customer #88', 'A. Kapoor')
  assert.equal(updated, 'A. Kapoor')
})

// ─── Partial addresses / billing + shipping mapping (requirement 5) ─────

test('mergeAddress fills every mapped field: name, lines, city, state, pincode, country, phone', () => {
  const merged = mergeAddress(
    { name: 'Old Name', address1: '5 Marine Drive' },
    { name: 'New Name', address2: 'Flat 12', city: 'Mumbai', province: 'MH', zip: '400001', country: 'India', phone: '+91 98765 43210' },
  )
  assert.deepEqual(merged, {
    name: 'New Name',
    address1: '5 Marine Drive',
    address2: 'Flat 12',
    city: 'Mumbai',
    province: 'MH',
    zip: '400001',
    country: 'India',
    phone: '+91 98765 43210',
  })
})

test('a redacted (empty) incoming order address keeps the locally recovered one', () => {
  const local = { name: 'Priya Sharma', address1: '5 Marine Drive', city: 'Mumbai', zip: '400001', phone: '9876543210' }
  const merged = mergeAddress(local, { name: '', address1: '', city: '' })
  assert.deepEqual(merged, local)
})

test('a null incoming address merges to nothing (drizzle omits the field)', () => {
  assert.equal(mergeAddress({ name: 'X' }, null), undefined)
  assert.equal(mergeAddress(undefined, undefined), undefined)
  assert.equal(mergeAddress(undefined, { name: '', city: '' }), undefined, 'all-empty incoming with nothing local writes nothing')
})

test('mergeAddress upgrades a placeholder receiver name but keeps real ones', () => {
  assert.equal(mergeAddress(undefined, { name: 'Shopify Customer #99', address1: 'A/2' })?.name, 'Shopify Customer #99')
  const merged = mergeAddress({ name: 'Shopify Customer #99' }, { name: 'Real Name' })
  assert.equal(merged?.name, 'Real Name')
  const kept = mergeAddress({ name: 'Real Name' }, { name: 'Shopify Customer #99' })
  assert.equal(kept?.name, 'Real Name')
})

// ─── Identity matching priority (requirement 3) ─────────────────────────

test('matching is Shopify id first, then email, then phone — never merged into duplicates', () => {
  const byId = { id: 'row-by-id' }
  const byEmail = { id: 'row-by-email' }
  const byPhone = { id: 'row-by-phone' }
  assert.equal(pickCustomerMatch({ byShopifyId: byId, byEmail: byEmail, byPhone: byPhone }), byId)
  assert.equal(pickCustomerMatch({ byShopifyId: null, byEmail: byEmail, byPhone: byPhone }), byEmail)
  assert.equal(pickCustomerMatch({ byShopifyId: null, byEmail: null, byPhone: byPhone }), byPhone)
  assert.equal(pickCustomerMatch({}), null)
})

test('email and phone matching is case/format normalized', () => {
  assert.equal(normalizeEmail(' Priya@Example.COM '), 'priya@example.com')
  assert.equal(normalizeEmail('redacted'), null)
  assert.equal(normalizePhone('+91 98765-43210'), '919876543210')
  assert.equal(normalizePhone('98765 43210'), '9876543210')
  assert.equal(normalizePhone('redacted'), null)
})

test('placeholderName builds the matchable placeholder string from a real id', () => {
  assert.equal(placeholderName('9687733207291'), 'Shopify Customer #9687733207291')
  assert.equal(placeholderName(''), null)
  assert.equal(placeholderName('gid://shopify/Customer/1'), null, 'gid form was never a stored name')
})

// ─── REST payload mass-redaction (plan-gated Protected Customer Data) ────
// Shopify answers HTTP 200 with the customer object reduced to {id} and the
// addresses reduced to region-only stubs. Imported silently that became a
// "Guest" order with no explanation — the detector must catch exactly this.

test('orderCustomerPiiRedacted: a mass-redacted REST payload is detected', () => {
  // Shape captured live from the plan-gated store (order #1027).
  assert.ok(
    orderCustomerPiiRedacted({
      id: 7660565233727,
      customer: { id: 10050987687999, verified_email: true },
      billing_address: { province: 'Tamil Nadu', country: 'India' },
      shipping_address: { province: 'Tamil Nadu', country: 'India' },
    }),
  )
})

test('orderCustomerPiiRedacted: a guest checkout with email survives is NOT redacted', () => {
  assert.ok(
    !orderCustomerPiiRedacted({
      customer: { id: 42, email: 'guest@example.com' },
      email: 'guest@example.com',
      billing_address: { address1: '12 Anna Salai', city: 'Chennai', zip: '600002' },
    }),
    'usable contact data anywhere on the order means it was not redacted',
  )
})

test('orderCustomerPiiRedacted: a real named customer is NOT redacted', () => {
  assert.ok(
    !orderCustomerPiiRedacted({
      customer: { id: 42, first_name: 'Priya', last_name: 'Sharma', email: 'priya@example.com' },
      billing_address: { first_name: 'Priya', address1: '12 Anna Salai', city: 'Chennai' },
    }),
  )
})

test('orderCustomerPiiRedacted: an order without any customer object is not a redaction case', () => {
  assert.ok(!orderCustomerPiiRedacted({ customer: null, billing_address: null }))
  assert.ok(!orderCustomerPiiRedacted(null))
})

// ─── Region-only redacted address stubs (the silent province/country loss) ─
// A plan-gated address lists ONLY province/country. The old builder required
// name/address1/city/phone to be non-empty, so the stub was discarded and the
// order row lost even the region data Shopify actually returned.

test('parseOrderAddress keeps a region-only redacted stub (live #1027 shape)', () => {
  assert.deepEqual(
    parseOrderAddress({ province: 'Tamil Nadu', country: 'India' }),
    { name: '', address1: '', address2: '', city: '', province: 'Tamil Nadu', zip: '', country: 'India', phone: '' },
  )
})

test('parseOrderAddress maps every real field and never leaks "undefined" strings', () => {
  const parsed = parseOrderAddress({
    first_name: 'Priya',
    last_name: 'Sharma',
    address1: '12 Anna Salai',
    address2: 'Flat 12',
    city: 'Chennai',
    province: 'Tamil Nadu',
    zip: '600002',
    country: 'India',
    phone: '+91 98765 43210',
  })
  assert.deepEqual(parsed, {
    name: 'Priya Sharma',
    address1: '12 Anna Salai',
    address2: 'Flat 12',
    city: 'Chennai',
    province: 'Tamil Nadu',
    zip: '600002',
    country: 'India',
    phone: '+91 98765 43210',
  })
  // Dev stores send literal "undefined" strings — they must parse as blank.
  const junk = parseOrderAddress({ first_name: 'undefined', last_name: 'undefined', address1: 'undefined', city: '' })
  assert.equal(junk, null, 'an all-redacted address parses to null, not an empty object')
  const partial = parseOrderAddress({ first_name: 'undefined', last_name: 'undefined', address1: '12 Anna Salai' })
  assert.equal(partial?.name, '', '"undefined" strings parse as blank name')
  assert.equal(partial?.address1, '12 Anna Salai', 'a real field survives junk siblings')
})

test('parseOrderAddress: an entirely empty address yields null', () => {
  assert.equal(parseOrderAddress({ first_name: '', last_name: '', country: '' }), null)
  assert.equal(parseOrderAddress(null), null)
  assert.equal(parseOrderAddress('nope'), null)
})

// ─── Numeric order id extraction (the silent "0 enriched, N skipped" bug) ─
// GraphQL node(id:) accepts only the numeric order id, which imported rows
// keep in their id column. Feeding it the display name ("#1027") resolved to
// no node, so enrichment skipped every Guest order without an error.

test('numericShopifyOrderId extracts the GraphQL id from the local row id', () => {
  assert.equal(numericShopifyOrderId('shopify-7660565233727'), '7660565233727')
  assert.equal(numericShopifyOrderId('shopify-1027'), '1027')
  // Non-imported rows (manual "MO-…", email-ingest, CSV) have nothing to fetch.
  assert.equal(numericShopifyOrderId('MO-202610-123456'), '')
  assert.equal(numericShopifyOrderId('email-1027-1769600000000'), '')
  assert.equal(numericShopifyOrderId('ord-csv-1700000000000-abc123'), '')
  assert.equal(numericShopifyOrderId(null), '')
  // The display name form is NOT an id — it must never leak through.
  assert.equal(numericShopifyOrderId('#1027'), '')
})
