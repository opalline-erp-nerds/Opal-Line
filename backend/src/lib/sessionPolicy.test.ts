import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONSTANTS } from '../constants'
import { DEFAULT_SESSION_POLICY, evaluateSession } from './sessionPolicy'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 0, 1)

test('the shipped policy uses a 24h idle window, a 7-day cap and a 12h refresh threshold', () => {
  assert.equal(DEFAULT_SESSION_POLICY.idleTtlMs, DAY)
  assert.equal(DEFAULT_SESSION_POLICY.absoluteTtlMs, 7 * DAY)
  assert.equal(DEFAULT_SESSION_POLICY.refreshThresholdMs, 12 * HOUR)
  assert.equal(CONSTANTS.SESSION_TTL_MS, DEFAULT_SESSION_POLICY.idleTtlMs)
})

test('a session far from expiry is valid and is not rewritten on every request', () => {
  const decision = evaluateSession(T0, T0 + DAY, T0 + 1 * HOUR)
  assert.equal(decision.valid, true)
  assert.equal(decision.extendTo, null)
  assert.equal(decision.expiresAt, T0 + DAY)
})

test('activity inside the refresh threshold moves the expiry forward (the original bug)', () => {
  // Signed in 13h ago, only 11h of the 24h window left. Before this fix the
  // row stayed at login + 24h and the user was signed out mid-session.
  const now = T0 + 13 * HOUR
  const decision = evaluateSession(T0, T0 + DAY, now)
  assert.equal(decision.valid, true)
  assert.equal(decision.extendTo, now + DAY)
  assert.equal(decision.expiresAt, now + DAY)
})

test('a session idle for the whole window expires and is not extended', () => {
  const atDeadline = evaluateSession(T0, T0 + DAY, T0 + DAY)
  assert.equal(atDeadline.valid, false)
  assert.equal(atDeadline.extendTo, null)

  const afterDeadline = evaluateSession(T0, T0 + DAY, T0 + DAY + 1)
  assert.equal(afterDeadline.valid, false)
  assert.equal(afterDeadline.extendTo, null)
})

test('activity never extends a session past the absolute cap', () => {
  const cap = T0 + 7 * DAY
  const now = cap - 1 * HOUR
  // Even though a full 24h idle window would reach past the cap, the new
  // expiry is clamped to the cap.
  const decision = evaluateSession(T0, now + 30 * 60 * 1000, now)
  assert.equal(decision.valid, true)
  assert.equal(decision.extendTo, cap)
  assert.equal(decision.expiresAt, cap)
})

test('a session is invalid at the absolute cap even if its stored expiry is later', () => {
  const decision = evaluateSession(T0, T0 + 30 * DAY, T0 + 7 * DAY)
  assert.equal(decision.valid, false)
  assert.equal(decision.extendTo, null)
})

test('concurrent evaluations only ever move the same expiry forward', () => {
  const first = evaluateSession(T0, T0 + DAY, T0 + 13 * HOUR)
  assert.equal(first.valid, true)
  assert.ok(first.extendTo)

  // A second request arriving later reads the already-extended expiry.
  const second = evaluateSession(T0, first.extendTo!, T0 + 26 * HOUR)
  assert.equal(second.valid, true)
  assert.ok(second.extendTo! >= first.extendTo!)
})
