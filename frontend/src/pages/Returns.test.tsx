import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReturnsView } from './Returns'
import { type ReturnsStats } from '@/lib/returns'
import type { SalesReturn } from '@/types'

// Regression coverage for the /sales/returns crash: the list rendered a badge
// with `statusMeta[row.original.status].variant`, and the invoice return
// workflow stores credit notes with the status `processed` (the column is
// nullable too). The lookup came back undefined, the cell threw
// "Cannot read properties of undefined (reading 'variant')" and the whole page
// fell into the error boundary ("Something went wrong").
//
// renderToStaticMarkup has no DOM and never runs effects, so the page is
// exercised the way the crash actually happened — through the view, fed the
// data the API returns.

const processedReturn: SalesReturn = {
  id: 'abe20a15-ced7-43e7-9219-b9f45d2fb5a3',
  number: 'CR202610-393819',
  order: '#1011',
  customer: 'rk',
  items: 1,
  amount: 6534,
  status: 'processed',
  date: '2026-10-26 05:13:22.341',
}

const pendingReturn: SalesReturn = {
  id: 'SR1',
  number: 'SR-2026-00006',
  order: '#10220',
  customer: 'Priya Sharma',
  items: 1,
  amount: 620,
  status: 'pending',
  date: '2026-08-05T09:00:00',
}

const stats: ReturnsStats = {
  total: 2,
  pending: 1,
  pendingAmount: 620,
  refunded: 0,
  refundedAmount: 0,
  rate: 15.38,
}

const noOp = () => {}

test('regression: a processed credit note renders instead of dropping the page', () => {
  const html = renderToStaticMarkup(
    <ReturnsView returns={[processedReturn]} loading={false} error={null} stats={stats} onStatusChange={noOp} />,
  )
  assert.ok(html.includes('Sales Returns'), 'the page heading is rendered')
  assert.ok(html.includes('CR202610-393819'), 'the return number is in the table')
  assert.ok(html.includes('Processed'), 'the credit-note status gets a badge')
  assert.ok(html.includes('6,534'), 'the refund amount is formatted')
})

test('a list mixing known, unknown and null statuses renders every row', () => {
  const unknown: SalesReturn = {
    ...processedReturn,
    id: 'SR0',
    number: 'SR-LEGACY',
    // The column is nullable text, so a status the list never knew about can
    // always reach the table.
    status: 'legacy_state' as unknown as SalesReturn['status'],
  }
  const noStatus: SalesReturn = {
    ...pendingReturn,
    id: 'SR2',
    number: 'SR-NULL',
    status: null as unknown as SalesReturn['status'],
  }
  const html = renderToStaticMarkup(
    <ReturnsView
      returns={[processedReturn, pendingReturn, unknown, noStatus]}
      loading={false}
      error={null}
      stats={stats}
      onStatusChange={noOp}
    />,
  )
  assert.ok(html.includes('Pending'), 'a pending return still shows its badge')
  assert.ok(html.includes('legacy_state'), 'an unknown status is shown as-is instead of crashing')
  assert.ok(html.includes('Unknown'), 'a null status renders a placeholder instead of undefined')
})

test('an empty list renders the empty message and dashes for the stats', () => {
  const html = renderToStaticMarkup(
    <ReturnsView returns={[]} loading={false} error={null} stats={null} onStatusChange={noOp} />,
  )
  assert.ok(html.includes('No returns found'), 'the table explains there is nothing to show')
  assert.ok(html.includes('Sales Returns'), 'the page still renders')
  assert.ok(html.includes('—'), 'stats placeholders stay a dash until they load')
})

test('a failed API call shows the error and still renders the page', () => {
  const html = renderToStaticMarkup(
    <ReturnsView returns={[]} loading={false} error="API error 500" stats={null} onStatusChange={noOp} />,
  )
  assert.ok(html.includes('API error 500'), 'the message reaches the screen')
  assert.ok(html.includes('Sales Returns'), 'the page does not fall into the error boundary')
  assert.ok(!html.includes('No returns found'), 'a failure is never mistaken for "no returns"')
})

test('loading state keeps the table skeleton up rather than an empty state', () => {
  const html = renderToStaticMarkup(
    <ReturnsView returns={[]} loading={true} error={null} stats={null} onStatusChange={noOp} />,
  )
  assert.ok(html.includes('Loading data...'), 'the request is still in flight')
  assert.ok(!html.includes('No returns found'), 'nothing is claimed while the request is in flight')
})
