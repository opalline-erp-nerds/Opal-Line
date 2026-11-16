import test from 'node:test'
import assert from 'node:assert/strict'
import { formatAutoSyncInterval, resolveAutoSyncIntervalSeconds } from './productAutoSync.interval'

test('resolveAutoSyncIntervalSeconds accepts value + unit', () => {
  assert.equal(resolveAutoSyncIntervalSeconds({ value: 2, unit: 'minutes' }), 120)
  assert.equal(resolveAutoSyncIntervalSeconds({ value: 0, unit: 'minutes' }), 0)
  assert.equal(resolveAutoSyncIntervalSeconds({ value: 1, unit: 'hours' }), 3600)
})

test('formatAutoSyncInterval', () => {
  assert.equal(formatAutoSyncInterval(0), 'Disabled')
  assert.equal(formatAutoSyncInterval(120), 'Every 2 minutes')
  assert.equal(formatAutoSyncInterval(3600), 'Every 1 hour')
})