import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:47210'
const USER = process.env.E2E_USER ?? 'admin'
const PASSWORD = process.env.E2E_PASSWORD ?? 'Opal@2026'

const browser = await chromium.launch({ channel: 'chrome' })
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
await cdp.send('Network.enable')
await cdp.send('Performance.enable')

let recs = []
const inflight = new Map()
let phase = 'boot'

cdp.on('Network.requestWillBeSent', (e) => {
  if (e.type === 'Preflight') return
  const rec = { id: e.requestId, url: e.request.url, method: e.request.method, type: e.type, start: e.timestamp, phase, status: null, dur: null, bytes: 0 }
  recs.push(rec)
  inflight.set(e.requestId, rec)
})
cdp.on('Network.responseReceived', (e) => {
  const rec = inflight.get(e.requestId)
  if (rec) rec.status = e.response.status
})
cdp.on('Network.loadingFinished', (e) => {
  const rec = inflight.get(e.requestId)
  if (rec) {
    rec.dur = Math.round((e.timestamp - rec.start) * 1000)
    rec.bytes = e.encodedDataLength ?? 0
  }
})
cdp.on('Network.loadingFailed', (e) => {
  const rec = inflight.get(e.requestId)
  if (rec) {
    rec.failed = e.errorText
    rec.dur = Math.round((e.timestamp - rec.start) * 1000)
  }
})

await page.addInitScript(() => {
  window.__lt = []
  window.__commits = 0
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__lt.push(Math.round(entry.duration))
    }).observe({ entryTypes: ['longtask'] })
  } catch {
    /* unsupported */
  }
  // Minimal React DevTools hook: counts committed roots, including production builds.
  const hook = {
    supportsFiber: true,
    renderers: new Map(),
    inject() { return 1 },
    onCommitFiberRoot() { window.__commits += 1 },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  }
  Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook, configurable: true })
})

const heap = async () => {
  try {
    await cdp.send('HeapProfiler.collectGarbage').catch(() => {})
    const r = await cdp.send('Runtime.getHeapUsage')
    return Math.round((r.usedSize / 1048576) * 10) / 10
  } catch {
    return null
  }
}
const stats = async () => {
  const lt = await page.evaluate(() => window.__lt ?? []).catch(() => [])
  const commits = await page.evaluate(() => window.__commits ?? 0).catch(() => 0)
  return { lt, commits, heap: await heap() }
}
const reset = async () => {
  await page.evaluate(() => { window.__lt = []; window.__commits = 0 }).catch(() => {})
}

function summarize(name, phaseName, s) {
  const win = recs.filter((r) => r.phase === phaseName)
  const api = win.filter((r) => r.url.includes('/api/v1'))
  const byPath = new Map()
  for (const r of api) {
    if (r.method !== 'GET') continue
    const u = new URL(r.url)
    const key = u.pathname + (u.search || '')
    const cur = byPath.get(key) ?? { path: key, count: 0, durs: [], kb: 0, statuses: new Set() }
    cur.count += 1
    if (r.dur != null) cur.durs.push(r.dur)
    cur.kb += r.bytes
    cur.statuses.add(String(r.status ?? (r.failed ? 'FAILED' : 'pending')))
    byPath.set(key, cur)
  }
  const endpoints = [...byPath.values()]
    .map((e) => ({
      path: e.path,
      count: e.count,
      avgMs: e.durs.length ? Math.round(e.durs.reduce((a, b) => a + b, 0) / e.durs.length) : null,
      maxMs: e.durs.length ? Math.max(...e.durs) : null,
      kb: Math.round((e.kb / 1024) * 10) / 10,
      statuses: [...e.statuses].join(','),
    }))
    .sort((a, b) => b.count - a.count || (b.maxMs ?? 0) - (a.maxMs ?? 0))
  const durations = api.map((r) => r.dur).filter((d) => d != null)
  return {
    name,
    commits: s.commits,
    heapMB: s.heap,
    longTasks: { count: s.lt.length, totalMs: s.lt.reduce((a, b) => a + b, 0), maxMs: s.lt.length ? Math.max(...s.lt) : 0 },
    counts: {
      requests: win.length,
      api: api.length,
      uniqueEndpoints: endpoints.length,
      duplicateGetRequests: endpoints.reduce((sum, e) => sum + Math.max(0, e.count - 1), 0),
      apiTotalMs: durations.reduce((a, b) => a + b, 0),
      slowestApiMs: durations.length ? Math.max(...durations) : null,
    },
    endpoints,
  }
}

const results = []

phase = 'login'
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await page.fill('#username', USER)
await page.fill('#password', PASSWORD)
await page.click('button[type="submit"]')
await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 })
await page.waitForLoadState('networkidle').catch(() => {})
results.push(summarize('login + auth bootstrap', 'login', await stats()))

phase = 'dashboard'
await reset()
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForLoadState('networkidle').catch(() => {})
await page.waitForTimeout(9000)
results.push(summarize('dashboard initial load (production bundle)', 'dashboard', await stats()))

phase = 'dashboard-idle'
await reset()
await page.waitForTimeout(70000)
results.push(summarize('dashboard idle 70s (all polling incl. 60s refresh)', 'dashboard-idle', await stats()))

phase = 'source-toggle'
await reset()
for (const label of ['Shopify Sales', 'ERP Sales', 'All Sales', 'Shopify Sales', 'ERP Sales', 'All Sales']) {
  await page.getByRole('button', { name: label, exact: true }).click()
  await page.waitForTimeout(1400)
}
results.push(summarize('6x sales-source toggles (chart re-render)', 'source-toggle', await stats()))

phase = 'spa-nav'
await reset()
for (let i = 0; i < 3; i++) {
  await page.click('aside a[href="/sales/invoices"]')
  await page.waitForTimeout(2500)
  await page.click('aside a[href="/inventory/products"]')
  await page.waitForTimeout(2500)
  await page.click('aside a[href="/"]')
  await page.waitForTimeout(2500)
}
results.push(summarize('3x in-app nav cycles (production)', 'spa-nav', await stats()))

const heaps = []
for (let i = 0; i < 3; i++) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  heaps.push(await heap())
}
results.push({ name: 'heap after 3 dashboard reloads (post-GC)', heapMB: heaps })

const payload = { base: BASE, bundle: 'frontend/dist (production build)', producedAt: new Date().toISOString(), results }
writeFileSync('build/ui-redesign/audit-perf-prod.json', JSON.stringify(payload, null, 2))
console.log(JSON.stringify(payload, null, 2))
await browser.close()
