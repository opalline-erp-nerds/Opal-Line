import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_TOPICS,
  describeFetchError,
  getWebhookHealth,
  registerShopifyWebhooks,
  resolvePublicBaseUrl,
  shopifyAdminHost,
  type WebhookRegistrationDeps,
} from './webhookRegistration'

const PUBLIC_BASE = 'https://erp.example.com'

describe('resolvePublicBaseUrl', () => {
  test('unset, blank or non-https is not a public base', () => {
    assert.equal(resolvePublicBaseUrl({}), null)
    assert.equal(resolvePublicBaseUrl({ PUBLIC_BASE_URL: '   ' }), null)
    assert.equal(resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'http://erp.example.com' }), null)
    assert.equal(resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'erp.example.com' }), null)
  })

  test('localhost, loopback and their ports are skipped', () => {
    assert.equal(resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'https://localhost' }), null)
    assert.equal(resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'https://localhost:47191/' }), null)
    assert.equal(resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'https://127.0.0.1:47191' }), null)
    assert.equal(resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'https://[::1]:47191' }), null)
    assert.equal(resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'https://localhost:47191/api/v1/webhooks/shopify' }), null)
    assert.equal(resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'https://0.0.0.0:47191' }), null)
  })

  test('a public HTTPS base is kept, without a trailing slash', () => {
    assert.equal(resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'https://erp.example.com/' }), PUBLIC_BASE)
    assert.equal(resolvePublicBaseUrl({ PUBLIC_BASE_URL: ' https://erp.example.com/app/// ' }), 'https://erp.example.com/app')
  })
})

describe('shopifyAdminHost', () => {
  test('normalizes pasted admin URLs and bare domains', () => {
    assert.equal(shopifyAdminHost('opal-line'), 'opal-line.myshopify.com')
    assert.equal(shopifyAdminHost('https://opal-line.myshopify.com/admin'), 'opal-line.myshopify.com')
    assert.equal(shopifyAdminHost('WWW.Opal-Line.myshopify.com'), 'opal-line.myshopify.com')
  })
})

describe('describeFetchError', () => {
  test('restores the cause undici hides behind "fetch failed"', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) })
    assert.equal(describeFetchError(err), 'fetch failed (ENOTFOUND)')
  })

  test('plain errors and non-errors still read sensibly', () => {
    assert.equal(describeFetchError(new Error('boom')), 'boom')
    assert.equal(describeFetchError('nope'), 'nope')
  })
})

// ── A fake Admin API ──────────────────────────────────────────────────────

interface Call {
  method: string
  url: string
  body: unknown
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function makeFetch(plan: {
  list?: Array<{ id: number; topic: string; address: string }>
  failFirst?: number
  failAlways?: boolean
  postStatus?: number
}) {
  const calls: Call[] = []
  let failuresLeft = plan.failFirst ?? 0
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (plan.failAlways || failuresLeft > 0) {
      if (failuresLeft > 0) failuresLeft--
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) })
    }
    if (method === 'GET' && url.includes('/webhooks.json')) return json(200, { webhooks: plan.list ?? [] })
    if (method === 'POST' && url.includes('/webhooks.json')) return json(plan.postStatus ?? 201, { webhook: { id: 1 } })
    if (method === 'PUT' && /\/webhooks\/\d+\.json/.test(url)) return json(200, { webhook: { id: 1 } })
    return json(404, { errors: 'unexpected' })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function deps(fetchImpl: typeof fetch, overrides: Partial<WebhookRegistrationDeps> = {}): WebhookRegistrationDeps & { sleeps: number[] } {
  const sleeps: number[] = []
  return Object.assign(
    {
      sleeps,
      fetchImpl,
      env: { PUBLIC_BASE_URL: PUBLIC_BASE } as NodeJS.ProcessEnv,
      shop: 'opal-line',
      token: 'shpat_test',
      apiVersion: '2025-10',
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
    },
    overrides,
  ) as WebhookRegistrationDeps & { sleeps: number[] }
}

describe('getWebhookHealth', () => {
  test('is never healthy when no public base URL is configured', async () => {
    const mock = makeFetch({
      list: WEBHOOK_TOPICS.map((topic, i) => ({ id: i + 1, topic, address: `https://old.example.com/${topic}` })),
    })
    const health = await getWebhookHealth(deps(mock.fetchImpl, { env: {} as NodeJS.ProcessEnv }))
    assert.equal(health.expectedAddress, null)
    assert.equal(health.healthy, false, 'an old registration cannot count as healthy')
  })

  test('is healthy only when every topic points at the expected address', async () => {
    const address = `${PUBLIC_BASE}/api/v1/webhooks/shopify`
    const mock = makeFetch({ list: WEBHOOK_TOPICS.map((topic, i) => ({ id: i + 1, topic, address })) })
    const health = await getWebhookHealth(deps(mock.fetchImpl))
    assert.equal(health.healthy, true)
    assert.equal(health.entries.filter((e) => e.status === 'registered').length, WEBHOOK_TOPICS.length)
  })
})

describe('registerShopifyWebhooks', () => {
  test('skips cleanly without a public base URL (desktop / localhost)', async () => {
    const mock = makeFetch({})
    const report = await registerShopifyWebhooks(deps(mock.fetchImpl, { env: {} as NodeJS.ProcessEnv }))
    assert.equal(report.skipped, 'no-public-base-url')
    assert.equal(report.registered.length, 0)
    assert.equal(mock.calls.length, 0, 'no request is attempted when Shopify cannot call us')
  })

  test('skips cleanly when Shopify is not configured', async () => {
    const mock = makeFetch({})
    const report = await registerShopifyWebhooks(deps(mock.fetchImpl, { shop: '', token: '' }))
    assert.equal(report.skipped, 'not-configured')
    assert.equal(mock.calls.length, 0)
  })

  test('registers every topic at the public address', async () => {
    const mock = makeFetch({})
    const report = await registerShopifyWebhooks(deps(mock.fetchImpl))
    assert.equal(report.skipped, null)
    assert.equal(report.error, undefined)
    assert.deepEqual(report.registered, [...WEBHOOK_TOPICS])
    const posts = mock.calls.filter((c) => c.method === 'POST')
    assert.equal(posts.length, WEBHOOK_TOPICS.length)
    for (const post of posts) {
      assert.equal(post.url, 'https://opal-line.myshopify.com/admin/api/2025-10/webhooks.json')
      assert.deepEqual((post.body as { webhook: { address: string } }).webhook.address, `${PUBLIC_BASE}/api/v1/webhooks/shopify`)
    }
  })

  test('leaves an already-correct registration alone', async () => {
    const address = `${PUBLIC_BASE}/api/v1/webhooks/shopify`
    const mock = makeFetch({
      list: WEBHOOK_TOPICS.map((topic, i) => ({ id: i + 1, topic, address })),
    })
    const report = await registerShopifyWebhooks(deps(mock.fetchImpl))
    assert.deepEqual(report.unchanged, [...WEBHOOK_TOPICS])
    assert.equal(mock.calls.filter((c) => c.method === 'POST' || c.method === 'PUT').length, 0)
  })

  test('re-points a stale webhook instead of duplicating it', async () => {
    const mock = makeFetch({
      list: WEBHOOK_TOPICS.map((topic, i) => ({ id: i + 1, topic, address: 'https://old.example.com/api/v1/webhooks/shopify' })),
    })
    const report = await registerShopifyWebhooks(deps(mock.fetchImpl))
    assert.equal(report.registered.length, WEBHOOK_TOPICS.length)
    assert.equal(mock.calls.filter((c) => c.method === 'PUT').length, WEBHOOK_TOPICS.length)
    assert.equal(mock.calls.filter((c) => c.method === 'POST').length, 0)
  })

  test('retries a cold-start network failure and then succeeds', async () => {
    const mock = makeFetch({ failFirst: 1 })
    const d = deps(mock.fetchImpl)
    const report = await registerShopifyWebhooks(d)
    assert.equal(report.error, undefined)
    assert.deepEqual(report.registered, [...WEBHOOK_TOPICS])
    assert.deepEqual(d.sleeps, [WEBHOOK_RETRY_DELAYS_MS[0]], 'one backoff between the two attempts')
  })

  test('a persistent failure is reported with the real cause and never throws', async () => {
    const mock = makeFetch({ failAlways: true })
    const d = deps(mock.fetchImpl)
    const report = await registerShopifyWebhooks(d)
    assert.equal(report.skipped, null)
    assert.equal(report.error, 'fetch failed (ENOTFOUND)')
    assert.equal(report.registered.length, 0)
    assert.equal(d.sleeps.length, WEBHOOK_RETRY_DELAYS_MS.length, 'every retry was used')
  })

  test('a rejected topic is reported without stopping the rest', async () => {
    const mock = makeFetch({})
    const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST' && String(input).includes('webhooks.json')) {
        return json(422, { errors: { topic: ['is invalid'] } })
      }
      return mock.fetchImpl(input, init)
    }) as typeof fetch
    const report = await registerShopifyWebhooks(deps(failing))
    assert.equal(report.registered.length, 0)
    assert.equal(report.failed.length, WEBHOOK_TOPICS.length)
    assert.ok(report.failed.every((f) => f.status === 422))
  })
})
