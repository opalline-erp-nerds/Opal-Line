import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDashboardRange } from './dashboardRange'

// Fixed reference instant: Friday 16 Oct 2026, 15:30 local. Monday of that week
// is 12 Oct, which keeps the preset expectations concrete.
const NOW = new Date(2026, 9, 16, 15, 30, 0)

function ok(query: Record<string, unknown>) {
  const r = resolveDashboardRange(query, NOW)
  assert.equal(r.ok, true)
  if (!r.ok) throw new Error('unreachable')
  return r.range
}

function err(query: Record<string, unknown>) {
  const r = resolveDashboardRange(query, NOW)
  assert.equal(r.ok, false)
  if (r.ok) throw new Error('unreachable')
  return r
}

test('today is a single IST day, bucketed hourly', () => {
  const r = ok({ period: 'today' })
  assert.equal(r.label, 'Today')
  assert.equal(r.from, '2026-10-16T00:00:00')
  assert.equal(r.to, '2026-10-17T00:00:00')
  assert.equal(r.prevFrom, '2026-10-15T00:00:00')
  assert.equal(r.prevTo, '2026-10-16T00:00:00')
  assert.equal(r.prevLabel, 'vs yesterday')
  assert.equal(r.days, 1)
  assert.equal(r.bucket, 'hour')
})

test('the period defaults to today', () => {
  assert.equal(ok({}).label, 'Today')
})

test('week runs Monday to today', () => {
  const r = ok({ period: 'week' })
  assert.equal(r.label, 'This Week')
  assert.equal(r.from, '2026-10-12T00:00:00')
  assert.equal(r.to, '2026-10-17T00:00:00')
  assert.equal(r.prevFrom, '2026-10-05T00:00:00')
  assert.equal(r.prevTo, '2026-10-10T00:00:00')
  assert.equal(r.prevLabel, 'vs last week')
  assert.equal(r.days, 5)
  assert.equal(r.bucket, 'day')
})

test('month runs from the 1st', () => {
  const r = ok({ period: 'month' })
  assert.equal(r.label, 'This Month')
  assert.equal(r.from, '2026-10-01T00:00:00')
  assert.equal(r.to, '2026-10-17T00:00:00')
  assert.equal(r.prevFrom, '2026-09-01T00:00:00')
  assert.equal(r.prevTo, '2026-09-17T00:00:00')
  assert.equal(r.prevLabel, 'vs last month')
  assert.equal(r.days, 16)
  assert.equal(r.bucket, 'day')
})

test('last month is the whole previous calendar month', () => {
  const r = ok({ period: 'lastMonth' })
  assert.equal(r.label, 'Last Month')
  assert.equal(r.from, '2026-09-01T00:00:00')
  assert.equal(r.to, '2026-10-01T00:00:00')
  assert.equal(r.prevFrom, '2026-08-01T00:00:00')
  assert.equal(r.prevTo, '2026-09-01T00:00:00')
  assert.equal(r.prevLabel, 'vs previous month')
  assert.equal(r.days, 30)
  assert.equal(r.bucket, 'day')
})

test('year runs from 1 Jan and buckets monthly', () => {
  const r = ok({ period: 'year' })
  assert.equal(r.label, 'This Year')
  assert.equal(r.from, '2026-01-01T00:00:00')
  assert.equal(r.to, '2026-10-17T00:00:00')
  assert.equal(r.prevFrom, '2025-01-01T00:00:00')
  assert.equal(r.prevTo, '2025-10-17T00:00:00')
  assert.equal(r.prevLabel, 'vs last year')
  assert.equal(r.bucket, 'month')
})

test('custom is an inclusive day span with the same-length previous window', () => {
  const r = ok({ period: 'custom', start: '2026-09-01', end: '2026-09-30' })
  assert.equal(r.from, '2026-09-01T00:00:00')
  assert.equal(r.to, '2026-10-01T00:00:00')
  assert.equal(r.days, 30)
  assert.equal(r.prevFrom, '2026-08-02T00:00:00')
  assert.equal(r.prevTo, '2026-09-01T00:00:00')
  assert.equal(r.prevLabel, 'vs previous period')
  assert.equal(r.label, '01 Sep – 30 Sep 2026')
  assert.equal(r.bucket, 'day')
})

test('a single-day custom range buckets hourly', () => {
  const r = ok({ period: 'custom', start: '2026-09-01', end: '2026-09-01' })
  assert.equal(r.days, 1)
  assert.equal(r.bucket, 'hour')
})

test('a long custom range buckets monthly', () => {
  const r = ok({ period: 'custom', start: '2026-01-01', end: '2026-06-30' })
  assert.equal(r.bucket, 'month')
})

test('unknown periods are rejected', () => {
  assert.equal(err({ period: 'fortnight' }).status, 400)
})

test('custom requires valid start and end dates', () => {
  assert.equal(err({ period: 'custom' }).status, 400)
  assert.equal(err({ period: 'custom', start: 'nope', end: '2026-09-30' }).status, 400)
})

test('custom rejects an inverted or oversized range', () => {
  assert.equal(err({ period: 'custom', start: '2026-09-30', end: '2026-09-01' }).status, 400)
  assert.equal(err({ period: 'custom', start: '2025-01-01', end: '2026-09-01' }).status, 400)
})


test('last 7 days are the trailing 7 days ending tomorrow midnight', () => {
  const r = ok({ period: 'last7' })
  assert.equal(r.label, 'Last 7 Days')
  assert.equal(r.from, '2026-10-10T00:00:00')
  assert.equal(r.to, '2026-10-17T00:00:00')
  assert.equal(r.days, 7)
  assert.equal(r.bucket, 'day')
  assert.equal(r.prevLabel, 'vs previous 7 days')
})

test('last 30 days are the trailing 30 days', () => {
  const r = ok({ period: 'last30' })
  assert.equal(r.label, 'Last 30 Days')
  assert.equal(r.from, '2026-09-17T00:00:00')
  assert.equal(r.to, '2026-10-17T00:00:00')
  assert.equal(r.days, 30)
  assert.equal(r.bucket, 'day')
  assert.equal(r.prevLabel, 'vs previous 30 days')
})

test('last 3 months run whole calendar months from the 1st', () => {
  const r = ok({ period: 'last3m' })
  assert.equal(r.label, 'Last 3 Months')
  assert.equal(r.from, '2026-08-01T00:00:00')
  assert.equal(r.to, '2026-10-17T00:00:00')
  assert.equal(r.prevFrom, '2026-05-01T00:00:00')
  assert.equal(r.prevTo, '2026-08-01T00:00:00')
  assert.equal(r.prevLabel, 'vs previous 3 months')
  assert.equal(r.bucket, 'month')
})

test('last 6 months cross the year boundary cleanly', () => {
  const r = ok({ period: 'last6m' })
  assert.equal(r.label, 'Last 6 Months')
  assert.equal(r.from, '2026-05-01T00:00:00')
  assert.equal(r.prevFrom, '2025-11-01T00:00:00')
  assert.equal(r.prevTo, '2026-05-01T00:00:00')
  assert.equal(r.bucket, 'month')
})

test('last 12 months start last November and bucket monthly', () => {
  const r = ok({ period: 'last12m' })
  assert.equal(r.label, 'Last 12 Months')
  assert.equal(r.from, '2025-11-01T00:00:00')
  assert.equal(r.to, '2026-10-17T00:00:00')
  assert.equal(r.prevFrom, '2024-11-01T00:00:00')
  assert.equal(r.prevTo, '2025-11-01T00:00:00')
  assert.equal(r.prevLabel, 'vs previous 12 months')
  assert.equal(r.bucket, 'month')
})
