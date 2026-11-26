import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ownerBarTone,
  ownerBarWidth,
  ownerChartMax,
  ownerMarginLabel,
  ownerMoney,
  ownerMonthLabel,
  ownerProfitTone,
} from './ownerInsights'

test('money is formatted identically everywhere, with exactly two decimals', () => {
  assert.equal(ownerMoney(-1474401.22), '-₹14,74,401.22')
  assert.equal(ownerMoney(1234.5), '₹1,234.50')
  assert.equal(ownerMoney(0), '₹0.00')
  assert.equal(ownerMoney(null), '—')
})

test('month labels use the en-IN short form', () => {
  assert.equal(ownerMonthLabel('2026-09'), 'Sept 26')
  assert.equal(ownerMonthLabel('2026-01'), 'Jan 26')
})

test('chart scale covers all three series including negative excursions', () => {
  assert.equal(
    ownerChartMax([
      { revenue: 100, grossProfit: -400, netProfit: 20 },
      { revenue: 250, grossProfit: 30, netProfit: -90 },
    ]),
    400,
  )
  assert.equal(ownerChartMax([]), 1)
})

test('zero and invalid values render exactly zero-width bars, never a stub', () => {
  assert.equal(ownerBarWidth(0, 100), 0)
  assert.equal(ownerBarWidth(Number.NaN, 100), 0)
  assert.equal(ownerBarWidth(50, 0), 0)
  assert.equal(ownerBarWidth(50, 100), 50)
  assert.equal(ownerBarWidth(400, 100), 100)
})

test('profit colour and bar colour follow the sign', () => {
  assert.equal(ownerProfitTone(-1), 'text-destructive')
  assert.equal(ownerProfitTone(0), 'text-success')
  assert.equal(ownerProfitTone(1), 'text-success')
  assert.equal(ownerBarTone(-1, 'bg-success'), 'bg-destructive')
  assert.equal(ownerBarTone(0, 'bg-success'), 'bg-success')
})

test('margin labels keep two decimals and a percent sign', () => {
  assert.equal(ownerMarginLabel(-400.46), '-400.46%')
  assert.equal(ownerMarginLabel(0), '0.00%')
  assert.equal(ownerMarginLabel(Number.NaN), '0.00%')
})
