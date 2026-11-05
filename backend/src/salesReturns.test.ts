import test from 'node:test'
import assert from 'node:assert/strict'
import { planSalesReturn, type InvoiceItemRow, type PriorReturnRow, type ReturnRequestLine } from './salesReturns'

// The invoice return endpoint used to trust whatever the client sent, so the
// same return submitted twice restocked the shelf and wrote a second credit
// note for goods that had already gone back. planSalesReturn is the guard that
// runs before anything moves; these tests pin the rules the books depend on:
// never more than invoiced, never more than once, and amounts pro-rated to the
// line they came from.

const line = (sku: string, qty: number, amount: number): InvoiceItemRow => ({
  product: `${sku} product`,
  sku,
  qty,
  amount,
})

const req = (sku: string, qty: number): ReturnRequestLine => ({ sku, qty })

const prior = (... lines: Array<{ sku: string; qty: number }>): PriorReturnRow[] =>
  [{ returnItems: lines.map((l) => ({ sku: l.sku, qty: l.qty, amount: 0, product: 'p' })) }]

test('an explicit request returns exactly what was asked for', () => {
  const planned = planSalesReturn({
    invoiceItems: [line('A', 2, 1000)],
    requested: [req('A', 1)],
    priorReturns: [],
  })
  assert.ok(planned.ok, 'one unit of two is returnable')
  assert.equal(planned.items.length, 1)
  assert.equal(planned.items[0].qty, 1)
  // Pro-rated against the line: half of 1000.
  assert.equal(planned.items[0].amount, 500)
  assert.equal(planned.amount, 500)
})

test('a repeated return is rejected once the first credit note is recorded', () => {
  const planned = planSalesReturn({
    invoiceItems: [line('A', 1, 6534)],
    requested: [req('A', 1)],
    priorReturns: prior({ sku: 'A', qty: 1 }),
  })
  assert.equal(planned.ok, false, 'the same unit cannot be credited twice')
  assert.match(planned.ok ? '' : planned.error, /already returned/)
  assert.match(planned.ok ? '' : planned.error, /1 of 1 already returned/)
})

test('a second partial return is allowed while stock of the invoice is left', () => {
  const first = planSalesReturn({
    invoiceItems: [line('A', 2, 1000)],
    requested: [req('A', 1)],
    priorReturns: [],
  })
  assert.ok(first.ok, 'first half returns')

  const second = planSalesReturn({
    invoiceItems: [line('A', 2, 1000)],
    requested: [req('A', 1)],
    priorReturns: prior({ sku: 'A', qty: 1 }),
  })
  assert.ok(second.ok, 'the remaining unit still returns')
  assert.equal(second.amount, 500, 'the second credit is the remaining half')

  const third = planSalesReturn({
    invoiceItems: [line('A', 2, 1000)],
    requested: [req('A', 1)],
    priorReturns: prior({ sku: 'A', qty: 2 }),
  })
  assert.equal(third.ok, false, 'nothing is left to return')
})

test('quantities beyond what was invoiced are rejected with the SKU named', () => {
  const planned = planSalesReturn({
    invoiceItems: [line('A', 1, 100)],
    requested: [req('A', 3)],
    priorReturns: [],
  })
  assert.equal(planned.ok, false)
  assert.match(planned.ok ? '' : planned.error, /A: 3 requested, 0 of 1 already returned/)
})

test('a SKU that is not on the invoice is rejected', () => {
  const planned = planSalesReturn({
    invoiceItems: [line('A', 1, 100)],
    requested: [req('Z', 1)],
    priorReturns: [],
  })
  assert.equal(planned.ok, false)
  assert.match(planned.ok ? '' : planned.error, /Z is not on this invoice/)
})

test('a return with nothing usable on it is rejected', () => {
  const blank = planSalesReturn({ invoiceItems: [], requested: [], priorReturns: [] })
  assert.equal(blank.ok, false)
  assert.match(blank.ok ? '' : blank.error, /No matching items to return/)

  // Lines without a SKU can never be returned — there is no stock to give back.
  const unskued = planSalesReturn({
    invoiceItems: [{ product: 'Loose item', sku: null, qty: 1, amount: 100 }],
    requested: [{ sku: undefined, qty: 1 }],
    priorReturns: [],
  })
  assert.equal(unskued.ok, false)

  // Non-positive quantities are ignored rather than treated as a return.
  const zero = planSalesReturn({
    invoiceItems: [line('A', 1, 100)],
    requested: [req('A', 0)],
    priorReturns: [],
  })
  assert.equal(zero.ok, false)
})

test('an empty request means the whole invoice, and still respects prior returns', () => {
  const planned = planSalesReturn({
    invoiceItems: [line('A', 2, 1000), line('B', 1, 250)],
    requested: [],
    priorReturns: [],
  })
  assert.ok(planned.ok)
  assert.equal(planned.items.length, 2)
  assert.equal(planned.amount, 1250, 'every line is credited in full')

  const again = planSalesReturn({
    invoiceItems: [line('A', 2, 1000), line('B', 1, 250)],
    requested: [],
    priorReturns: prior({ sku: 'A', qty: 1 }),
  })
  assert.equal(again.ok, false, 'a whole-invoice return cannot replay a part-return')
  assert.match(again.ok ? '' : again.error, /A: 2 requested, 1 of 2 already returned/)
})

test('an SKU spread over several invoice lines splits and sums exactly', () => {
  const planned = planSalesReturn({
    invoiceItems: [line('A', 1, 100), line('A', 1, 150)],
    requested: [req('A', 2)],
    priorReturns: [],
  })
  assert.ok(planned.ok)
  assert.equal(planned.items.length, 2, 'each line is credited for its own share')
  assert.deepEqual(planned.items.map((i) => i.qty), [1, 1])
  assert.deepEqual(planned.items.map((i) => i.amount), [100, 150])
  assert.equal(planned.amount, 250, 'the credit note total is the sum of its lines')
})
