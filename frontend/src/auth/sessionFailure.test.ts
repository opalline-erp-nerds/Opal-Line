import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '@/lib/api/core'
import { isConfirmedSessionLoss } from './sessionFailure'

test('only a confirmed 401 signs the user out', () => {
  assert.equal(isConfirmedSessionLoss(new ApiError(401, 'Not authenticated')), true)
})

test('a transient backend failure keeps the current session', () => {
  assert.equal(isConfirmedSessionLoss(new ApiError(503, 'Database unavailable')), false)
  assert.equal(isConfirmedSessionLoss(new ApiError(500, 'Internal server error')), false)
  assert.equal(isConfirmedSessionLoss(new ApiError(502, 'Bad gateway')), false)
})

test('a network error keeps the current session', () => {
  assert.equal(isConfirmedSessionLoss(new TypeError('Failed to fetch')), false)
  assert.equal(isConfirmedSessionLoss(new Error('fetch failed')), false)
})

test('an authorization rejection that is not session loss keeps the user signed in', () => {
  // 403 PASSWORD_CHANGE_REQUIRED, CSRF failures and permission denials all
  // leave the session itself valid.
  assert.equal(isConfirmedSessionLoss(new ApiError(403, 'Password change required')), false)
})
