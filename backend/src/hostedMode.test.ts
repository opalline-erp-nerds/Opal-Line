import test from 'node:test'
import assert from 'node:assert/strict'
import { HostedConfigError, isPublicHost, publicHostStartupError, seedAdminPassword } from './hostedMode'

const desktop = { NODE_ENV: 'production' } as NodeJS.ProcessEnv
const hosted = { HOST: '0.0.0.0', NODE_ENV: 'production' } as NodeJS.ProcessEnv

test('desktop production stays loopback and keeps the default admin password', () => {
  assert.equal(isPublicHost(desktop), false)
  assert.equal(publicHostStartupError(desktop), null)
  assert.equal(seedAdminPassword(desktop), 'Opal@2026')
})

test('a public bind requires both secrets and a chosen admin password', () => {
  assert.equal(isPublicHost(hosted), true)
  const message = publicHostStartupError(hosted)
  assert.match(message ?? '', /ENCRYPTION_KEY/)
  assert.match(message ?? '', /CSRF_SECRET/)
  assert.throws(() => seedAdminPassword(hosted), HostedConfigError)
  const ready = {
    ...hosted,
    ENCRYPTION_KEY: 'ab'.repeat(32),
    CSRF_SECRET: 'csrf-secret',
    SEED_ADMIN_PASSWORD: 'choose-a-long-password',
  }
  assert.equal(publicHostStartupError(ready), null)
  assert.equal(seedAdminPassword(ready), 'choose-a-long-password')
})
