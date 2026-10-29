import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RATE_STEP_LABELS,
  pipelineSucceeded,
  stepsFromPhase,
  stepsFromResult,
  stepsFromStepLog,
} from './silverRatePipeline'
import type { SilverRateStepLog } from '@/types'

// The Silver Rate page's pipeline tracker is driven by two backend payloads:
// the live /silver/update/progress polling (phase + label) and the final
// result.steps / silver_rates.step_log. These tests pin the mapping — including
// the rule that a failure stops the run and never marks later steps complete.

const progress = (over: Partial<Parameters<typeof stepsFromPhase>[0]['progress']> = {}) => ({
  phase: 'idle' as const,
  label: '',
  total: 0,
  error: null,
  ...over,
})

test('sync-first run starts at the catalog sync; the other steps stay pending', () => {
  const steps = stepsFromPhase({ progress: progress({ phase: 'syncing', label: 'Syncing the product catalog from Shopify' }), syncFirst: true })
  assert.deepEqual(
    steps.map((s) => [s.key, s.status]),
    [
      ['sync', 'active'],
      ['rate', 'pending'],
      ['reprice', 'pending'],
      ['match', 'pending'],
      ['push', 'pending'],
    ],
  )
})

test('without sync-first the sync step is not part of the pipeline', () => {
  const steps = stepsFromPhase({ progress: progress({ phase: 'repricing' }), syncFirst: false })
  assert.deepEqual(steps.map((s) => s.key), ['rate', 'reprice', 'match', 'push'])
})

test('the repricing phase covers two steps: saving the rate, then repricing', () => {
  const beforeProducts = stepsFromPhase({ progress: progress({ phase: 'repricing', total: 0 }), syncFirst: false })
  assert.equal(beforeProducts.find((s) => s.key === 'rate')?.status, 'active')
  assert.equal(beforeProducts.find((s) => s.key === 'reprice')?.status, 'pending')

  const whileRepricing = stepsFromPhase({ progress: progress({ phase: 'repricing', total: 53, label: 'Repricing 53 product(s) from the new rate' }), syncFirst: false })
  assert.equal(whileRepricing.find((s) => s.key === 'rate')?.status, 'done')
  assert.equal(whileRepricing.find((s) => s.key === 'reprice')?.status, 'active')
  assert.equal(whileRepricing.find((s) => s.key === 'reprice')?.detail, 'Repricing 53 product(s) from the new rate')
})

test('matching and pushing mark the earlier steps done', () => {
  const matching = stepsFromPhase({ progress: progress({ phase: 'matching' }), syncFirst: true })
  assert.deepEqual(
    matching.map((s) => [s.key, s.status]),
    [
      ['sync', 'done'],
      ['rate', 'done'],
      ['reprice', 'done'],
      ['match', 'active'],
      ['push', 'pending'],
    ],
  )
  const pushing = stepsFromPhase({ progress: progress({ phase: 'pushing', total: 7 }), syncFirst: false })
  assert.equal(pushing.find((s) => s.key === 'push')?.status, 'active')
  assert.equal(pushing.find((s) => s.key === 'match')?.status, 'done')
})

test('a finished run without an error marks every step done', () => {
  const steps = stepsFromPhase({ progress: progress({ phase: 'done', label: 'Rate applied — 53 repriced, 0 pushed to Shopify' }), syncFirst: true })
  assert.ok(steps.every((s) => s.status === 'done'))
  assert.ok(pipelineSucceeded(steps))
})

test('a failed run names the failing step and leaves later steps pending', () => {
  const pushFailed = stepsFromPhase({
    progress: progress({ phase: 'done', label: 'Finished with 1 error(s)', error: 'Shopify push failed: 502' }),
    syncFirst: true,
  })
  assert.equal(pushFailed.find((s) => s.key === 'push')?.status, 'failed')
  assert.equal(pushFailed.find((s) => s.key === 'push')?.error, 'Shopify push failed: 502')
  assert.ok(pushFailed.slice(0, 4).every((s) => s.status === 'done'))
  assert.ok(!pipelineSucceeded(pushFailed))

  const syncFailed = stepsFromPhase({
    progress: progress({ phase: 'done', label: 'Product sync failed before repricing', error: '502 from Shopify' }),
    syncFirst: true,
  })
  assert.equal(syncFailed.find((s) => s.key === 'sync')?.status, 'failed')
  assert.ok(syncFailed.filter((s) => s.key !== 'sync').every((s) => s.status === 'pending'))

  const rateFailed = stepsFromPhase({
    progress: progress({ phase: 'done', label: 'Failed to save the new rate', error: 'relation silver_rates is offline' }),
    syncFirst: false,
  })
  assert.equal(rateFailed.find((s) => s.key === 'rate')?.status, 'failed')
  assert.equal(rateFailed.find((s) => s.key === 'reprice')?.status, 'pending')
})

test('step labels use the tracker wording, not the backend wording', () => {
  assert.equal(RATE_STEP_LABELS.rate, 'Rate updated in ERP')
  assert.equal(RATE_STEP_LABELS.reprice, 'Products repriced')
  assert.equal(RATE_STEP_LABELS.push, 'Pushed to Shopify')
})

const stepLog: SilverRateStepLog = {
  startedAt: '2026-10-26T09:00:00.000Z',
  finishedAt: '2026-10-26T09:01:00.000Z',
  ok: false,
  counts: { repriced: 53, matched: 40, pushed: 0, skipped: 0 },
  steps: [
    { key: 'rate', label: 'Save new rate', status: 'done', startedAt: '2026-10-26T09:00:00.000Z', finishedAt: '2026-10-26T09:00:01.000Z', detail: '₹160.00 → ₹165.00/gm' },
    { key: 'reprice', label: 'Reprice products', status: 'done', startedAt: '2026-10-26T09:00:01.000Z', finishedAt: '2026-10-26T09:00:20.000Z', detail: '53 product(s) recomputed from the new rate' },
    { key: 'match', label: 'Match products to Shopify', status: 'done', startedAt: '2026-10-26T09:00:20.000Z', finishedAt: '2026-10-26T09:00:30.000Z', detail: '40 matched, 13 without a Shopify match' },
    { key: 'push', label: 'Push prices to Shopify', status: 'failed', startedAt: '2026-10-26T09:00:30.000Z', finishedAt: '2026-10-26T09:01:00.000Z', detail: '0 pushed, 0 skipped, 1 error(s)', error: 'Shopify responded 502' },
  ],
}

test('stepsFromResult keeps backend statuses, normalises labels and borrows step_log times', () => {
  const steps = stepsFromResult(
    [
      { key: 'rate', label: 'Save new rate', status: 'done', detail: '₹160.00 → ₹165.00/gm' },
      { key: 'reprice', label: 'Reprice products', status: 'done', detail: '53 product(s) recomputed from the new rate' },
      { key: 'match', label: 'Match products to Shopify', status: 'done', detail: '40 matched, 13 without a Shopify match' },
      { key: 'push', label: 'Push prices to Shopify', status: 'failed', detail: '0 pushed, 0 skipped, 1 error(s)' },
    ],
    stepLog,
  )
  assert.deepEqual(steps.map((s) => s.label), [
    RATE_STEP_LABELS.rate,
    RATE_STEP_LABELS.reprice,
    RATE_STEP_LABELS.match,
    RATE_STEP_LABELS.push,
  ])
  assert.equal(steps[0].finishedAt, '2026-10-26T09:00:01.000Z')
  assert.equal(steps[3].status, 'failed')
  assert.equal(steps[3].error, 'Shopify responded 502')
  assert.ok(!pipelineSucceeded(steps))
})

test('stepsFromStepLog orders the steps however the row stored them', () => {
  const shuffled: SilverRateStepLog = { ...stepLog, steps: [...stepLog.steps].reverse() }
  assert.deepEqual(stepsFromStepLog(shuffled).map((s) => s.key), ['rate', 'reprice', 'match', 'push'])
})
