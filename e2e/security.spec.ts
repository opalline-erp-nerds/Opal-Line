import { randomUUID } from 'node:crypto'
import { expect, request, test } from '@playwright/test'
import { clearLoginAttempts } from './db'

/**
 * Security regression suite for the Opal Line Billing backend.
 *
 * Anonymous checks run with an empty storage state; authenticated checks reuse
 * the shared admin session created by global-setup.
 */

// Endpoints that must never serve unauthenticated requests.
const PROTECTED_GET = [
  '/api/v1/auth/me',
  '/api/v1/system/status',
  '/api/v1/system/logs?file=app',
  '/api/v1/system/log-files',
  '/api/v1/system/ports',
  '/api/v1/env-config',
  '/api/v1/rbac/roles',
  '/api/v1/backup/scopes',
  '/api/v1/backup/files',
  '/api/v1/shopify/status',
  '/api/v1/settings/whatsapp-status',
  '/api/v1/db/settings/recovery-password',
  '/api/v1/db/silver-rates?limit=1',
  '/api/v1/db/dashboard/kpis',
  '/api/v1/print-templates',
  '/api/v1/print-templates/default/invoice',
  '/api/v1/print-templates/sample/invoice',
]

// State-changing endpoints that must reject requests without a CSRF token even
// when authenticated (an attacker page cannot obtain the token).
const PROTECTED_POST_NO_CSRF = [
  '/api/v1/print-templates',
  '/api/v1/backup/email',
  '/api/v1/backup/email-separate',
  '/api/v1/backup/notifications/daily-summary',
  '/api/v1/backup/notifications/low-stock',
]

test.describe('anonymous requests', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('security headers are set on API responses', async ({ request }) => {
    const res = await request.get('/api/v1/health')
    expect(res.status()).toBe(200)
    const h = res.headers()
    expect(h['content-security-policy']).toContain("default-src 'self'")
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['x-frame-options']).toBe('DENY')
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(h['x-powered-by']).toBeUndefined()
    expect(h['strict-transport-security']).toContain('max-age=31536000')
  })

  test('CORS never grants access to foreign origins', async ({ request }) => {
    const res = await request.get('/api/v1/health', { headers: { Origin: 'https://evil.example' } })
    const acao = res.headers()['access-control-allow-origin']
    // The configured ACAO value is a fixed string; it must never echo or match
    // a foreign origin (which is what would actually grant a cross-origin read).
    expect(acao).not.toBe('https://evil.example')
    expect(acao).not.toBe('*')
  })

  test('protected endpoints reject unauthenticated access', async ({ request }) => {
    for (const path of PROTECTED_GET) {
      const res = await request.get(path)
      expect([401, 403], `${path} returned HTTP ${res.status()}`).toContain(res.status())
    }
  })

  test('state-changing requests without a CSRF token are rejected', async ({ request }) => {
    const res = await request.post('/api/v1/auth/logout', { data: {} })
    expect(res.status()).toBe(403)
    const body = (await res.json()) as { error?: string }
    expect(body.error ?? '').toMatch(/csrf/i)
  })

  test('anonymous PATCH/DELETE are also rejected without a CSRF token', async ({ request }) => {
    const res = await request.patch('/api/v1/db/customers/000000000000000000', { data: { name: 'x' } })
    expect([403], `anonymous PATCH returned HTTP ${res.status()}`).toContain(res.status())
    const del = await request.delete('/api/v1/print-templates/000000000000000000')
    expect([403], `anonymous DELETE returned HTTP ${del.status()}`).toContain(del.status())
  })

  test('new mutation endpoints reject unauthenticated calls', async ({ request }) => {
    for (const path of PROTECTED_POST_NO_CSRF) {
      const res = await request.post(path, { data: { scope: 'customers' } })
      // 401 (no session) — never 200; unauthenticated callers must not be able
      // to trigger emails, template writes or backups.
      expect([401, 403], `${path} returned HTTP ${res.status()}`).toContain(res.status())
    }
  })

  test('Shopify webhook rejects unsigned payloads', async ({ request }) => {
    const res = await request.post('/api/v1/webhooks/shopify', {
      headers: { 'Content-Type': 'application/json' },
      data: { id: 123, title: 'orders/create' },
    })
    expect(res.status(), `unsigned webhook returned HTTP ${res.status()}`).not.toBe(200)
  })

  test('path traversal cannot read files outside the web roots', async ({ request }) => {
    const probes = [
      '/uploads/../../../windows/win.ini',
      '/uploads/..%2f..%2f..%2fwindows/win.ini',
      '/..%2f..%2fwindows/win.ini',
      '/assets/../../../windows/win.ini',
    ]
    for (const p of probes) {
      const res = await request.get(p)
      const text = await res.text()
      // win.ini marker text must never leak
      expect(text, `traversal probe leaked content: ${p}`).not.toContain('[fonts]')
      expect(text).not.toContain('for 16-bit app support')
    }
  })

  test('server secrets are never served statically', async ({ request }) => {
    for (const p of ['/.env', '/data/.env', '/.env.local', '/package.json', '/.git/config']) {
      const res = await request.get(p)
      const text = await res.text()
      expect(text, `${p} leaked sensitive content`).not.toContain('DATABASE_URL=')
      expect(text).not.toContain('.csrf-secret')
      expect(text).not.toContain('Ajith012')
      if (res.status() === 200) {
        // Only the SPA shell / its own assets may come back with 200. The Vite
        // dev server serves the frontend's own package.json (no secrets), the
        // production server does not — either way nothing secret may leak.
        const ct = res.headers()['content-type'] ?? ''
        expect(ct.includes('text/html') || (p === '/package.json' && ct.includes('json'))).toBe(true)
      }
    }
  })

  test('malformed JSON fails cleanly without leaking stack traces', async ({ request }) => {
    const res = await request.post('/api/v1/auth/login', {
      headers: { 'Content-Type': 'application/json' },
      data: '{ this is not json',
    })
    expect([400, 415]).toContain(res.status())
    const text = await res.text()
    expect(text).not.toMatch(/\n\s+at\s+\w+/) // node stack frames
  })

  test('login responses advertise rate-limit policy', async ({ request }) => {
    const res = await request.post('/api/v1/auth/login', {
      data: { username: `e2e-probe-${Date.now()}`, password: 'definitely-wrong' },
    })
    expect(res.status()).toBe(401)
    const h = res.headers()
    expect(h['ratelimit-limit'] ?? h['ratelimit-policy'] ?? h['x-ratelimit-limit']).toBeTruthy()
  })

  test('repeated failed logins lock the account (editable threshold honoured)', async () => {
    // Lockout is a per-install switch that ships OFF (Settings → Security →
    // Login lockout, default false). This test enables it with a CUSTOM
    // rule — 3 attempts / 10 minutes — to prove the editable Settings values
    // are what the login path actually enforces, then restores the shipped
    // defaults (off, 5 / 15) so later tests and manual runs see the shipped
    // behaviour.
    //
    // Three hard-won details: the settings endpoint is state-changing, so the
    // CSRF header is required (without it the PUT 403s and the lockout
    // silently stays off); the bare `request` fixture does not pick up the
    // config's storageState here — build an authenticated context explicitly
    // (global setup has written e2e/.auth/state.json by now); and the probe
    // identifier must be unique per run, because a lockout row left by an
    // interrupted earlier run would otherwise make the FIRST attempt 429
    // instead of 401.
    const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:47195'
    const ctx = await request.newContext({ baseURL, storageState: 'e2e/.auth/state.json' })
    try {
      const settings = '/api/v1/db/settings'
      const { csrfToken } = (await (await ctx.get('/api/v1/csrf-token')).json()) as { csrfToken: string }
      const headers = { 'x-csrf-token': csrfToken }
      const enable = await ctx.put(settings, {
        headers,
        data: { loginLockoutEnabled: true, lockoutThreshold: 3, lockoutDurationMinutes: 10 },
      })
      expect(enable.status(), 'enabling the lockout must succeed').toBeLessThan(300)
      // The stored rule must be exactly what was asked for (the server clamps
      // out-of-range values, so this also pins the editable bounds).
      const row = (await (await ctx.get(settings)).json()) as {
        lockoutThreshold: number
        lockoutDurationMinutes: number
      }
      expect(row.lockoutThreshold, 'custom attempts value is stored as-is').toBe(3)
      expect(row.lockoutDurationMinutes, 'custom minutes value is stored as-is').toBe(10)
      // Unique per run: cleanup is best-effort (the DB may be unreachable from
      // the test process), so isolation must not depend on it succeeding. The
      // previous fixed name made a re-run inside the 10-minute window start at
      // 429 — the exact failure this test used to report.
      const probe = `e2e-lockout-probe-${randomUUID()}`
      try {
        const data = { username: probe, password: 'definitely-wrong' }
        // With a threshold of 3 the first failures are ordinary 401s…
        const first = await ctx.post('/api/v1/auth/login', { data })
        expect(first.status(), 'first failure is a plain 401').toBe(401)
        const second = await ctx.post('/api/v1/auth/login', { data })
        expect(second.status(), 'second failure is still under the threshold').toBe(401)
        const third = await ctx.post('/api/v1/auth/login', { data })
        expect(third.status(), 'third failure records the third attempt').toBe(401)
        // …and the next attempt is locked — not after the shipped 5.
        const fourth = await ctx.post('/api/v1/auth/login', { data })
        expect(fourth.status(), 'account locks once the CUSTOM threshold is reached').toBe(429)
      } finally {
        const restore = await ctx.put(settings, {
          headers,
          data: { loginLockoutEnabled: false, lockoutThreshold: 5, lockoutDurationMinutes: 15 },
        })
        expect(restore.status(), 'restoring the defaults must succeed').toBeLessThan(300)
        const cleanup = await clearLoginAttempts(probe)
        if (!cleanup.ok) console.warn(`[security] lockout probe cleanup skipped: ${cleanup.error}`)
      }
    } finally {
      await ctx.dispose()
    }
  })

  test('frontend bundle ships without source maps', async ({ request }) => {
    const html = await (await request.get('/')).text()
    // Vite dev serves /src modules; the production build serves /assets/*.js.
    const match = html.match(/src="(\/assets\/[^"]+\.js)"/) ?? html.match(/src="(\/@vite\/client)"/)
    expect(match, 'no entry script found in index.html').toBeTruthy()
    if (match![1].startsWith('/assets/')) {
      const js = await (await request.get(match![1])).text()
      expect(js).not.toContain('sourceMappingURL')
    }
  })
})

test.describe('authenticated requests', () => {
  test('session cookie is HttpOnly with SameSite=Strict', async ({ request }) => {
    const state = await request.storageState()
    const session = state.cookies.find((c) => c.name === 'opal.session')
    expect(session, 'session cookie missing — did global-setup log in?').toBeTruthy()
    expect(session!.httpOnly).toBe(true)
    expect(session!.sameSite).toBe('Strict')
  })

  test('authenticated PATCH/DELETE without a CSRF token are rejected', async ({ request }) => {
    // The CSRF middleware runs before auth and routing, so these must return
    // 403 (not 404/401) — proving the check fires for every mutating verb,
    // not just POST. IDs are dummy; a valid id must not change the outcome.
    const probes: Array<{ path: string; method: 'patch' | 'delete' }> = [
      { path: '/api/v1/db/customers/000000000000000000', method: 'patch' },
      { path: '/api/v1/print-templates/000000000000000000', method: 'patch' },
      { path: '/api/v1/print-templates/000000000000000000', method: 'delete' },
      { path: '/api/v1/db/quotations/000000000000000000', method: 'delete' },
    ]
    for (const { path, method } of probes) {
      const res = method === 'patch'
        ? await request.patch(path, { data: { name: 'csrf-probe' } })
        : await request.delete(path)
      expect(res.status(), `${method.toUpperCase()} ${path} returned HTTP ${res.status()}`).toBe(403)
      const body = (await res.json()) as { error?: string }
      expect(body.error ?? '').toMatch(/csrf/i)
    }
  })

  test('env-config never returns raw secret values', async ({ request }) => {
    const res = await request.get('/api/v1/env-config')
    expect(res.status()).toBe(200)
    const body = (await res.json()) as {
      defs: Array<{ key: string; secret?: boolean }>
      values: Record<string, string>
    }
    for (const def of body.defs) {
      if (!def.secret) continue
      const value = body.values[def.key] ?? ''
      expect(value, `${def.key} leaked a raw secret`).not.toMatch(/^(shpat_|rzp_|sk-|re_|EAAG|xoxb-)/)
      if (value) expect(value.startsWith('•'), `${def.key} is not masked`).toBe(true)
    }
  })

  test('system status endpoint works and exposes no filesystem secrets', async ({ request }) => {
    const res = await request.get('/api/v1/system/status')
    expect(res.status()).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('DATABASE_URL=')
    expect(text).not.toContain('password')
    const body = JSON.parse(text) as { ok: boolean; database: { healthy: boolean } }
    expect(body.ok).toBe(true)
    expect(body.database.healthy).toBe(true)
  })

  test('log viewer whitelists files (no traversal)', async ({ request }) => {
    const res = await request.get('/api/v1/system/logs?file=../../.env')
    expect(res.status()).toBe(400)
  })
})
