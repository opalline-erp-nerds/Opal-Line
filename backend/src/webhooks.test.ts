import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import {
  captureWebhookRawBody,
  forgetWebhookId,
  isWebhookIdSeen,
  rememberWebhookId,
  resetWebhookDedupe,
  REPLAY_WINDOW_MS,
  verifyShopifyWebhook,
  WEBHOOK_BODY_PATHS,
} from './webhooks'

describe('webhook replay dedupe', () => {
  beforeEach(() => resetWebhookDedupe())

  test('first sight is unseen, then remembered', () => {
    const t0 = 1_000_000
    assert.equal(isWebhookIdSeen('id-1', t0), false)
    rememberWebhookId('id-1', t0)
    assert.equal(isWebhookIdSeen('id-1', t0 + 1), true)
  })

  test('ids expire after the replay window', () => {
    const t0 = 1_000_000
    rememberWebhookId('id-2', t0)
    assert.equal(isWebhookIdSeen('id-2', t0 + REPLAY_WINDOW_MS - 1), true)
    assert.equal(isWebhookIdSeen('id-2', t0 + REPLAY_WINDOW_MS), false)
  })

  test('expired id can be seen fresh again', () => {
    const t0 = 1_000_000
    rememberWebhookId('id-3', t0)
    assert.equal(isWebhookIdSeen('id-3', t0 + REPLAY_WINDOW_MS + 1), false)
    rememberWebhookId('id-3', t0 + REPLAY_WINDOW_MS + 2)
    assert.equal(isWebhookIdSeen('id-3', t0 + REPLAY_WINDOW_MS + 3), true)
  })

  test('cache is bounded (oldest entry evicted)', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 5100; i++) rememberWebhookId(`bulk-${i}`, t0)
    // The very first id must have been evicted; the newest must survive.
    assert.equal(isWebhookIdSeen('bulk-0', t0), false)
    assert.equal(isWebhookIdSeen('bulk-5099', t0), true)
  })

  test('reset clears everything', () => {
    rememberWebhookId('id-4', 0)
    resetWebhookDedupe()
    assert.equal(isWebhookIdSeen('id-4', 1), false)
  })

  test('a released id (failed processing) is processed on the retry', () => {
    rememberWebhookId('id-5', 0)
    assert.equal(isWebhookIdSeen('id-5', 1), true)
    forgetWebhookId('id-5')
    assert.equal(isWebhookIdSeen('id-5', 2), false)
  })
})

/**
 * The exact middleware Shopify talks to. Verified with a locally generated
 * secret so the signature rules are covered without the store's own secret.
 */
describe('shopify webhook HMAC', () => {
  const SECRET = 'test-webhook-secret'
  const previous = process.env.SHOPIFY_WEBHOOK_SECRET

  beforeEach(() => {
    process.env.SHOPIFY_WEBHOOK_SECRET = SECRET
  })

  const run = async (rawBody: string, signature: string | null, secret: string | null = SECRET) => {
    const headers: Record<string, string> = { 'x-shopify-topic': 'refunds/create' }
    if (signature !== null) headers['x-shopify-hmac-sha256'] = signature
    const req = { headers, rawBody: Buffer.from(rawBody, 'utf8') } as unknown as Request
    let status = 200
    let passed = false
    const res = {
      status(code: number) {
        status = code
        return this
      },
      json() {
        return this
      },
    } as unknown as Response
    await verifyShopifyWebhook(req, res, (() => {
      passed = true
    }) as NextFunction, async () => secret)
    return { status, passed, req }
  }

  const sign = (body: string) => createHmac('sha256', SECRET).update(body, 'utf8').digest('base64')

  test('a correctly signed delivery passes and exposes the topic', async () => {
    const body = JSON.stringify({ id: 9001, order_id: 1027 })
    const { status, passed, req } = await run(body, sign(body))
    assert.equal(status, 200)
    assert.equal(passed, true)
    assert.equal(req.shopifyWebhook?.topic, 'refunds/create')
  })

  test('a valid signature over non-canonical JSON whitespace passes unchanged', async () => {
    // Shopify signs the exact bytes it sent. Re-stringifying req.body would
    // change `\n  ` and key spacing, so this must succeed against raw bytes.
    const body = '{\n  "id": 9001,  "note": "two spaces"\n}'
    assert.notEqual(body, JSON.stringify(JSON.parse(body)))
    const { status, passed } = await run(body, sign(body))
    assert.equal(status, 200)
    assert.equal(passed, true)
  })

  test('a tampered body is rejected', async () => {
    const body = JSON.stringify({ id: 9001 })
    const { status, passed } = await run(`${body} `, sign(body))
    assert.equal(status, 401)
    assert.equal(passed, false)
  })

  test('an invalid signature is rejected', async () => {
    const body = JSON.stringify({ id: 9001 })
    const { status, passed } = await run(body, sign('a different body'))
    assert.equal(status, 401)
    assert.equal(passed, false)
  })

  test('a missing signature is rejected', async () => {
    const { status, passed } = await run(JSON.stringify({ id: 9001 }), null)
    assert.equal(status, 401)
    assert.equal(passed, false)
  })

  test('no configured secret fails closed', async () => {
    const body = JSON.stringify({ id: 9001 })
    const { status, passed } = await run(body, sign(body), null)
    assert.equal(status, 503)
    assert.equal(passed, false)
  })

  test('restore the environment', () => {
    if (previous === undefined) delete process.env.SHOPIFY_WEBHOOK_SECRET
    else process.env.SHOPIFY_WEBHOOK_SECRET = previous
    assert.ok(true)
  })

  test('raw body capture covers both signed webhook routes', () => {
    const payload = '{  "order_name": "#1001"  }'
    for (const path of WEBHOOK_BODY_PATHS) {
      const req = { path } as Parameters<typeof captureWebhookRawBody>[0]
      captureWebhookRawBody(req, {}, Buffer.from(payload, 'utf8'))
      assert.equal(req.rawBody?.toString('utf8'), payload, path)
    }
  })
})
