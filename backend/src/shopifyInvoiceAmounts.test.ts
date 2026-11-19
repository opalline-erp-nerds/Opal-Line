import test from 'node:test'
import assert from 'node:assert/strict'
import { computeShopifyInvoiceAmounts } from './shopifyInvoiceAmounts'

const round2 = (n: number) => Math.round(n * 100) / 100

test('a Shopify total is invoiced even when the SKU has no catalogue weight', () => {
  // The reported bug: order #1025 is worth ₹6,423.80 but the invoice was ₹0
  // because its SKU matched no product (zero weight, zero making charge).
  const amounts = computeShopifyInvoiceAmounts({
    total: 6423.8,
    gstRate: 3,
    lines: [{ price: 6423.8, quantity: 1, weight: 0, silverRate: 0, makingCharge: 0 }],
  })
  assert.equal(amounts.grandTotal, 6423.8)
  assert.equal(round2(amounts.subtotal + amounts.gstAmount - amounts.discount), 6423.8)
  assert.equal(round2(amounts.lines[0].amount + amounts.lines[0].tax), 6423.8)
  // No cost basis: excluded from profit rather than reported as 100% margin.
  assert.equal(amounts.silverValue, null)
  assert.equal(amounts.makingCharge, null)
})

test('declared Shopify tax and discount are mapped onto the invoice', () => {
  const amounts = computeShopifyInvoiceAmounts({
    total: 105,
    totalTax: 3.06,
    discount: 5,
    gstRate: 3,
    lines: [{ price: 105, quantity: 1 }],
  })
  assert.equal(amounts.gstAmount, 3.06)
  assert.equal(amounts.discount, 5)
  assert.equal(amounts.subtotal, 101.94 + 5)
  assert.equal(round2(amounts.subtotal + amounts.gstAmount - amounts.discount), 105)
})

test('catalogue components are scaled onto the actual billed value', () => {
  const amounts = computeShopifyInvoiceAmounts({
    total: 6423.8,
    gstRate: 3,
    lines: [{ price: 6423.8, quantity: 1, weight: 10, silverRate: 500, makingCharge: 100 }],
  })
  assert.equal(amounts.grandTotal, 6423.8)
  assert.ok(amounts.silverValue != null && amounts.makingCharge != null)
  assert.equal(round2((amounts.silverValue ?? 0) + (amounts.makingCharge ?? 0)), amounts.subtotal)
  assert.equal(amounts.silverValue, round2((5000 / 6000) * (6423.8 - amounts.gstAmount)))
})

test('line amounts and taxes always add up to the order total', () => {
  const amounts = computeShopifyInvoiceAmounts({
    total: 1000,
    gstRate: 3,
    lines: [
      { price: 333.33, quantity: 1 },
      { price: 333.33, quantity: 1 },
      { price: 333.34, quantity: 1 },
    ],
  })
  const lineSum = round2(amounts.lines.reduce((sum, line) => sum + line.amount + line.tax, 0))
  assert.equal(lineSum, 1000)
  assert.equal(round2(amounts.subtotal + amounts.gstAmount - amounts.discount), 1000)
})

test('an order without a stored total falls back to its Shopify line prices', () => {
  const amounts = computeShopifyInvoiceAmounts({
    total: 0,
    gstRate: 3,
    lines: [{ price: 500, quantity: 2 }],
  })
  assert.equal(amounts.grandTotal, 1000)
  assert.equal(round2(amounts.lines[0].amount + amounts.lines[0].tax), 1000)
})

test('a zero-value order stays zero and never invents an amount', () => {
  const amounts = computeShopifyInvoiceAmounts({
    total: 0,
    gstRate: 3,
    lines: [{ price: 0, quantity: 1 }],
  })
  assert.equal(amounts.grandTotal, 0)
  assert.equal(amounts.subtotal, 0)
  assert.equal(amounts.lines[0].amount, 0)
})
