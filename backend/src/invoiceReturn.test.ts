import test from 'node:test'
import assert from 'node:assert/strict'

// Returns must be quantity-aware per invoice line: a partial return of one
// product can never flip the whole invoice into a "fully refunded"-style
// state or restock more units than were actually returned, and duplicate
// submissions must be rejected by the remaining-quantity check. These pure
// rules used to live inline in the route where nothing could pin them down.
import {
  aggregateReturnedBySku,
  parseStoredReturnItems,
  summarizeReturnLines,
  nextInvoiceStatus,
  parseReturnRequest,
  creditAmountFor,
  addReturnedQty,
  lineKey,
} from './invoiceReturn'

function linesFixture() {
  return [
    { sku: 'A', product: 'Product A', qty: 3, amount: 300 },
    { sku: 'B', product: 'Product B', qty: 2, amount: 200 },
  ]
}

const none = new Map<string, number>()

test('stored return_items rollup aggregates quantities and skips cancelled credits', () => {
  const rows = [
    { status: 'processed', returnItems: [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 2 }] },
    { status: 'processed', returnItems: [{ sku: 'A', qty: 2 }] },
    // Cancelled returns never merged inventory in — they must not consume
    // returnable quantity either.
    { status: 'cancelled', returnItems: [{ sku: 'A', qty: 99 }] },
    { status: null, returnItems: null },
    { status: 'processed', returnItems: 'not-a-list' },
  ] as never as Parameters<typeof aggregateReturnedBySku>[0]
  const returned = aggregateReturnedBySku(rows)
  assert.equal(returned.get(lineKey('A')), 3)
  assert.equal(returned.get(lineKey('B')), 2)
})

test('line summaries show sold / returned / remaining and cap returned at sold', () => {
  const returned = new Map([['a', 5]]) // intends to over-return
  const [a, b] = summarizeReturnLines(linesFixture(), returned)
  assert.deepEqual({ sku: a.sku, sold: a.sold, returned: a.returned, remaining: a.remaining, unitAmount: a.unitAmount }, {
    sku: 'A', sold: 3, returned: 3, remaining: 0, unitAmount: 100,
  })
  // Product B untouched: sold 2, returned 0.
  assert.deepEqual({ sku: b.sku, sold: b.sold, returned: b.returned, remaining: b.remaining }, {
    sku: 'B', sold: 2, returned: 0, remaining: 2,
  })
})

test('status derivation: no returns keeps the normal status, one piece is partial, everything is fully returned', () => {
  assert.equal(nextInvoiceStatus(summarizeReturnLines(linesFixture(), none)), null)
  const oneA = new Map([['a', 1]])
  assert.equal(nextInvoiceStatus(summarizeReturnLines(linesFixture(), oneA)), 'partially_returned')
  const all = new Map([['a', 3]])
  assert.equal(nextInvoiceStatus(summarizeReturnLines(linesFixture(), all)), 'partially_returned')
  const allB = new Map([['a', 3], ['b', 2]])
  assert.equal(nextInvoiceStatus(summarizeReturnLines(linesFixture(), allB)), 'fully_returned')
})

test('parseReturnRequest accepts a single piece of one product and leaves the rest returnable', () => {
  const lines = summarizeReturnLines(linesFixture(), none)
  const parsed = parseReturnRequest([{ sku: 'A', qty: 1 }], lines)
  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.items, [{ sku: 'A', product: 'Product A', qty: 1, amount: 100 }])
  // The credit-note amount for the partial return.
  assert.equal(creditAmountFor(new Map([['a', 1]]), lines), 100)
})

test('parseReturnRequest clamps a whole-invoice request to what is still returnable', () => {
  const before: Array<{ sku: string; qty: number }> = [{ sku: 'A', qty: 1 }]
  const existing = new Map(before.map((x) => [lineKey(x.sku), x.qty]))
  const lines = summarizeReturnLines(linesFixture(), existing)
  const parsed = parseReturnRequest(null, lines)
  assert.equal(parsed.error, undefined)
  // Remaining after the partial A×1: A×2 and B×2 — not the sold quantities.
  const qty = new Map<string, number>(parsed.qtyBySku)
  assert.equal(qty.get('a'), 2)
  assert.equal(qty.get('b'), 2)
  assert.equal(creditAmountFor(qty, lines), 400)
})

test('parseReturnRequest rejects returns beyond sold minus already returned', () => {
  const existing = new Map([[lineKey('A'), 1]])
  const lines = summarizeReturnLines(linesFixture(), existing)
  const parsed = parseReturnRequest([{ sku: 'A', qty: 3 }], lines)
  assert.match(parsed.error ?? '', /sold 3, 1 already returned, 2 remaining/)
})

test('parseReturnRequest rejects a SKU that is already fully returned', () => {
  const existing = new Map([[lineKey('A'), 3], [lineKey('B'), 2]])
  const lines = summarizeReturnLines(linesFixture(), existing)
  const parsed = parseReturnRequest([{ sku: 'A', qty: 1 }], lines)
  assert.match(parsed.error ?? '', /All 3 of A have already been returned/)
})

test('parseReturnRequest rejects unknown SKUs and perilous quantities', () => {
  const lines = summarizeReturnLines(linesFixture(), none)
  assert.match(parseReturnRequest([{ sku: 'NOPE', qty: 1 }], lines).error ?? '', /not a line on this invoice/)
  assert.match(parseReturnRequest([{ sku: 'A', qty: 0 }], lines).error ?? '', /positive whole number/)
  assert.match(parseReturnRequest([{ sku: 'A', qty: -1 }], lines).error ?? '', /positive whole number/)
  assert.match(parseReturnRequest([{ sku: 'A', qty: 1.5 }], lines).error ?? '', /positive whole number/)
  // Case-insensitive SKU matching, dup entries aggregate across rows.
  const dup = parseReturnRequest([{ sku: 'a', qty: 2 }, { sku: 'A', qty: 1 }], lines)
  assert.equal(dup.error, undefined)
  assert.equal(dup.qtyBySku?.get('a'), 3)
})

test('addReturnedQty merges a fresh return into the cumulative rollup', () => {
  const returned = new Map([[lineKey('A'), 1]])
  addReturnedQty(returned, 'B', 2)
  addReturnedQty(returned, 'A', 2)
  const lines = summarizeReturnLines(linesFixture(), returned)
  assert.deepEqual(lines.map((l) => [l.sku, l.returned, l.remaining]), [['A', 3, 0], ['B', 2, 0]])
  // Case-insensitive duplicate keys never split.
  addReturnedQty(returned, 'a', 1)
  assert.equal(returned.get('a'), 4)
})

test('stored return_items parsing tolerates legacy single-object payloads and junk', () => {
  assert.deepEqual(parseStoredReturnItems({ items: [{ sku: 'A', qty: 2 }] }), [{ sku: 'a', qty: 2 }])
  assert.deepEqual(parseStoredReturnItems([{ sku: 'B', qty: '2' }, { sku: 'C', qty: 0 }]), [{ sku: 'b', qty: 2 }])
  assert.deepEqual(parseStoredReturnItems(null), [])
  assert.deepEqual(parseStoredReturnItems([null, undefined, 'junk']), [])
})
