import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import express from 'express'
import cookieParser from 'cookie-parser'
import { setSessionCookie } from './sessions'

function headerFlags(header: string): { names: string[]; sameSite: string | null } {
  const attrs = header.split(';').slice(1).map((part) => part.trim())
  const names = attrs.map((part) => part.split('=')[0])
  const same = attrs.find((part) => part.toLowerCase().startsWith('samesite='))
  return { names, sameSite: same ? same.split('=')[1] : null }
}

async function readSetCookie(): Promise<string> {
  const app = express()
  app.use(cookieParser())
  app.post('/login', (_req, res) => {
    setSessionCookie(res, 'token-value')
    res.json({ ok: true })
  })
  const server: Server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/login`, {
      method: 'POST',
      headers: { connection: 'close' },
    })
    const raw = res.headers.get('set-cookie')
    assert.ok(raw)
    assert.match(raw, /^opal\.session=/)
    return raw
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}

test('session cookie stays non-Secure and Strict when hosted env is absent', async () => {
  const prevSecure = process.env.COOKIE_SECURE
  const prevSite = process.env.COOKIE_SAMESITE
  delete process.env.COOKIE_SECURE
  delete process.env.COOKIE_SAMESITE
  try {
    const flags = headerFlags(await readSetCookie())
    assert.equal(flags.names.includes('Secure'), false)
    assert.equal(flags.sameSite, 'Strict')
    assert.equal(flags.names.includes('HttpOnly'), true)
  } finally {
    if (prevSecure === undefined) delete process.env.COOKIE_SECURE
    else process.env.COOKIE_SECURE = prevSecure
    if (prevSite === undefined) delete process.env.COOKIE_SAMESITE
    else process.env.COOKIE_SAMESITE = prevSite
  }
})

test('COOKIE_SECURE=true marks the session cookie Secure and keeps Strict', async () => {
  const prevSecure = process.env.COOKIE_SECURE
  const prevSite = process.env.COOKIE_SAMESITE
  process.env.COOKIE_SECURE = 'true'
  delete process.env.COOKIE_SAMESITE
  try {
    const flags = headerFlags(await readSetCookie())
    assert.equal(flags.names.includes('Secure'), true)
    assert.equal(flags.sameSite, 'Strict')
  } finally {
    if (prevSecure === undefined) delete process.env.COOKIE_SECURE
    else process.env.COOKIE_SECURE = prevSecure
    if (prevSite === undefined) delete process.env.COOKIE_SAMESITE
    else process.env.COOKIE_SAMESITE = prevSite
  }
})
