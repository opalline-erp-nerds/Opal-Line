import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FinancialAgingBand, FinancialSummary } from '@/types'
import { CardError, FinancialAnalytics, ReceivableBody } from '@/components/dashboard/financial-analytics'
import { ExpenseDonutChart, IncomeExpenseChart, NetProfitChart, ReceivableAgingChart } from './financial-charts'
import { AGING_COLORS, EXPENSE, INCOME, LOSS, PROFIT, SLICE_COLORS, inr, rupeeTick } from './chart-theme'

/**
 * Server-rendered checks for the Financial Analytics section.
 *
 * recharts v3 paints its SVG from a layout effect, so `renderToStaticMarkup`
 * (no DOM, no effects) only ever yields the wrapper element — chart internals
 * such as bar fills and axis ticks are NOT assertable here. These tests
 * therefore cover what the section itself renders: wrapper sizing, the empty
 * overlays, the receivable card's three states, the per-card error block and
 * the palette/format helpers the charts are built from. The rendered charts
 * themselves were verified in the browser against the dev backend.
 */

const agingBand = (
  key: FinancialAgingBand['key'],
  label: string,
  value: number,
  count: number,
): FinancialAgingBand => ({ key, label, value, count })

const receivable = (over: Partial<FinancialSummary['receivable']>): FinancialSummary['receivable'] => ({
  paid: 0,
  outstanding: 0,
  invoicedTotal: 0,
  invoiceCount: 0,
  aging: [
    agingBand('current', 'Current', 0, 0),
    agingBand('over30', '>30 Days', 0, 0),
    agingBand('over60', '>60 Days', 0, 0),
    agingBand('over90', '>90 Days', 0, 0),
    agingBand('over120', '>120 Days', 0, 0),
    agingBand('older', 'Older', 0, 0),
  ],
  ...over,
})

const summary = (over: Partial<FinancialSummary> = {}): FinancialSummary => ({
  label: 'Last 12 Months',
  prevLabel: 'vs previous 12 months',
  sales: 0,
  returns: 0,
  invoiceCount: 0,
  netRevenue: 0,
  netRevenueDelta: '—',
  netRevenueTrend: 'flat',
  income: 0,
  expense: 0,
  expenseCount: 0,
  expenseDelta: '—',
  expenseTrend: 'flat',
  net: 0,
  expenses: [],
  topExpense: null,
  points: [],
  receivable: receivable({}),
  ...over,
})

test('income vs expense chart renders its wrapper at the fixed size', () => {
  const html = renderToStaticMarkup(
    <IncomeExpenseChart
      points={[{ key: '2025-11', label: 'Nov', date: '2025-11-01', income: 12000, expense: 4000 }]}
      fixedSize={{ width: 640, height: 240 }}
    />,
  )
  assert.ok(html.includes('recharts-wrapper'), 'the chart mounts a recharts wrapper')
  assert.ok(html.includes('width:640px') && html.includes('height:240px'), 'fixed size drives the wrapper')
  assert.ok(!html.includes('No income or expenses'), 'no empty overlay when the range is not blank')
})

test('blank series charts overlay their empty message', () => {
  const blank = [
    { key: '2025-11', label: 'Nov', date: '2025-11-01', income: 0, expense: 0 },
    { key: '2025-12', label: 'Dec', date: '2025-12-01', income: 0, expense: 0 },
  ]
  const message = 'No income or expenses in this period'
  const income = renderToStaticMarkup(<IncomeExpenseChart points={blank} fixedSize={{ width: 640, height: 240 }} emptyMessage={message} />)
  const profit = renderToStaticMarkup(<NetProfitChart points={blank} fixedSize={{ width: 640, height: 240 }} emptyMessage={message} />)
  assert.ok(income.includes(message), 'income chart shows the empty message')
  assert.ok(profit.includes(message), 'net profit chart shows the empty message')
})

test('donut charts render their centre label and value', () => {
  const aging = renderToStaticMarkup(
    <ReceivableAgingChart
      aging={[agingBand('current', 'Current', 5000, 2), ...receivable({}).aging.slice(1)]}
      centerLabel="Outstanding"
      centerValue="₹5,000"
      fixedSize={{ width: 210, height: 210 }}
    />,
  )
  const expenses = renderToStaticMarkup(
    <ExpenseDonutChart
      slices={[{ category: 'Rent', amount: 6000, share: 60 }]}
      centerLabel="Total"
      centerValue="₹6,000"
      fixedSize={{ width: 210, height: 210 }}
    />,
  )
  assert.ok(aging.includes('Outstanding') && aging.includes('₹5,000'), 'aging centre shows the outstanding total')
  assert.ok(expenses.includes('Total') && expenses.includes('₹6,000'), 'expense centre shows the total spent')
})

test('palette tokens follow the agreed chart colours', () => {
  assert.equal(SLICE_COLORS[0], INCOME, 'first expense slice shares the income purple')
  assert.equal(AGING_COLORS[0], EXPENSE, 'the current band uses the healthy green')
  assert.equal(PROFIT, EXPENSE, 'surplus reuses the expense green')
  assert.notEqual(LOSS, PROFIT, 'deficit is distinct from surplus')
  assert.equal(new Set(SLICE_COLORS).size, SLICE_COLORS.length, 'expense palette has no duplicates')
  assert.equal(new Set(AGING_COLORS).size, AGING_COLORS.length, 'aging palette has no duplicates')
})

test('money formatting uses Indian grouping and compact axis ticks', () => {
  assert.equal(inr(3000), '₹3,000')
  assert.equal(inr(123456.78), '₹1,23,456.78')
  assert.equal(rupeeTick(0), '₹0k')
  assert.equal(rupeeTick(12500), '₹13k')
  assert.equal(rupeeTick(2500000), '₹3M')
})

test('receivable card shows an empty state before any invoice exists', () => {
  const html = renderToStaticMarkup(<ReceivableBody data={summary({})} />)
  assert.ok(html.includes('No invoices yet'), 'empty state title')
  assert.ok(!html.includes('Invoiced total'), 'no figures block without invoices')
})

test('receivable card reports a fully settled book', () => {
  const html = renderToStaticMarkup(
    <ReceivableBody data={summary({ receivable: receivable({ paid: 10000, invoicedTotal: 10000, invoiceCount: 1 }) })} />,
  )
  assert.ok(html.includes('₹10,000'), 'invoiced total is displayed')
  assert.ok(html.includes('1 invoice'), 'singular invoice count')
  assert.ok(html.includes('All invoices are settled'), 'settled message replaces the aging donut')
})

test('receivable card ages the open balance across the bands', () => {
  const html = renderToStaticMarkup(
    <ReceivableBody
      data={summary({
        receivable: receivable({
          paid: 7000,
          outstanding: 3000,
          invoicedTotal: 10000,
          invoiceCount: 2,
          aging: [
            agingBand('current', 'Current', 1000, 1),
            agingBand('over30', '>30 Days', 2000, 1),
            agingBand('over60', '>60 Days', 0, 0),
            agingBand('over90', '>90 Days', 0, 0),
            agingBand('over120', '>120 Days', 0, 0),
            agingBand('older', 'Older', 0, 0),
          ],
        }),
      })}
    />,
  )
  assert.ok(html.includes('₹10,000') && html.includes('2 invoices'), 'invoiced total with plural count')
  assert.ok(html.includes('₹7,000'), 'received amount')
  assert.ok(html.includes('₹3,000'), 'outstanding amount')
  assert.ok(html.includes('2 invoices'), 'plural invoice count')
  assert.ok(html.includes('&gt;30 Days') && html.includes('Current'), 'aging band labels are listed')
  assert.ok(html.includes('₹2,000') && html.includes('₹1,000'), 'per-band amounts')
  assert.ok(html.includes('—'), 'empty bands render a dash')
  assert.ok(html.includes('· 1'), 'bands with invoices show their count')
})

test('card error offers a retry', () => {
  const html = renderToStaticMarkup(<CardError onRetry={() => {}} />)
  assert.ok(html.includes('Couldn&#x27;t load this card') || html.includes("Couldn't load this card"), 'error title')
  assert.ok(html.includes('Retry'), 'retry action is offered')
})

test('section renders its header and per-card skeletons before the first fetch resolves', () => {
  const html = renderToStaticMarkup(<FinancialAnalytics />)
  assert.ok(html.includes('Financial Analytics'), 'section title')
  assert.ok(html.includes('Live from Orders, Invoices &amp; Expenses'), 'section provenance chip')
  assert.ok(html.includes('Income vs Expense'), 'card 1 title')
  assert.ok(html.includes('Receivable Summary') && html.includes('As of now'), 'card 2 is point-in-time')
  assert.ok(html.includes('Top Expense') && !html.includes('Net Profit'), 'card 3 title, Net Profit folded into Income vs Expense')
  assert.ok(html.includes('Last 12 Months'), 'the section defaults to Last 12 Months')
  assert.ok(html.includes('animate-pulse'), 'cards start as skeletons while loading')
})
