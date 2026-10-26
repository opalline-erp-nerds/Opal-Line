import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { PreviousSilverRate } from './previous-silver-rate'
import { formatPreviousSilverRate } from '@/lib/previous-silver-rate'

test('renders the previous silver rate with two decimals', () => {
  const html = renderToStaticMarkup(<PreviousSilverRate previousRate={200} />)
  assert.match(html, /₹200\.00\/g/)
  assert.match(html, /title="Previous silver rate: ₹200\.00\/g"/)
})

test('renders an em dash when no previous rate is available', () => {
  const html = renderToStaticMarkup(<PreviousSilverRate previousRate={null} />)
  assert.match(html, />—</)
  assert.doesNotMatch(html, /₹/)
})

test('formatPreviousSilverRate mirrors the cell output', () => {
  assert.equal(formatPreviousSilverRate(300), '₹300.00/g')
  assert.equal(formatPreviousSilverRate(null), '—')
  assert.equal(formatPreviousSilverRate(Number.NaN), '—')
})
