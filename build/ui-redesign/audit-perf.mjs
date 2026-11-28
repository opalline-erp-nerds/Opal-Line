import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:47195'
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
let routeLabel = 'boot'

cdp.on('Network.requestWillBeSent', (e) => {
  if (e.type === 'Preflight') return
  const rec = {
    id: e.requestId,
    url: e.request.url,
    method: e.request.method,
    type: e.type,
    start: e.timestamp,
    phase: routeLabel,
    status: null,
    dur: null,
    bytes: 0,
  }
  recs.push(rec)
  inflight.set(e.requestId, rec)
})
cdp.on('Network.responseReceived', (e) => {
  const rec = inflight.get(e.requestId)
  if (rec) {
    rec.status = e.response.status
    rec.mime = e.response.mimeType
  }
})
cdp.on('Network.loadingFinished', (e) => {
  const rec = inflight.get(e.requestId)
  if (rec) {
    rec.dur = Math.round((e.timestamp - rec.start) * 1000)
    rec.bytes = e.encodedDataLength ?? 0
    inflight.delete(e.requestId)
  }
})
cdp.on('Network.loadingFailed', (e) => {
  const rec = inflight.get(e.requestId)
  if (rec) {
    rec.failed = e.errorText
    rec.dur = Math.round((e.timestamp - rec.start) * 1000)
    inflight.delete(e.requestId)
  }
})

await page.addInitScript(() => {
  window.__lt = []
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__lt.push(Math.round(entry.duration))
    }).observe({ entryTypes: ['longtask'] })
  } catch {
    /* longtask unsupported */
  }
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

const longTasks = async () => {
  try {
    return await page.evaluate(() => window.__lt ?? [])
  } catch {
    return []
  }
}

function summarize(name, phaseName, h, lt) {
  const window = recs.filter((r) => r.phase === phaseName)
  const api = window.filter((r) => r.url.includes('/api/v1'))
  const byPath = new Map()
  for (const r of api) {
    if (r.method !== 'GET') continue
    const u = new URL(r.url)
    const key = u.pathname + (u.search || '')
    const cur = byPath.get(key) ?? { path: key, count: 0, durs: [], bytes: 0, statuses: [] }
    cur.count += 1
    if (r.dur != null) cur.durs.push(r.dur)
    cur.bytes += r.bytes
    cur.statuses.push(r.status ?? (r.failed ? 'FAILED' : 'pending'))
    byPath.set(key, cur)
  }
  const endpoints = [...byPath.values()]
    .map((e) => ({
      path: e.path,
      count: e.count,
      avgMs: e.durs.length ? Math.round(e.durs.reduce((a, b) => a + b, 0) / e.durs.length) : null,
      maxMs: e.durs.length ? Math.max(...e.durs) : null,
      kb: Math.round((e.bytes / 1024) * 10) / 10,
      statuses: [...new Set(e.statuses.map(String))].join(','),
    }))
    .sort((a, b) => b.count - a.count || (b.maxMs ?? 0) - (a.maxMs ?? 0))
  const allApi = window.filter((r) => r.url.includes('/api/v1'))
  const durations = allApi.map((r) => r.dur).filter((d) => d != null)
  return {
    name,
    heapMB: h,
    longTasks: { count: lt.length, totalMs: lt.reduce((a, b) => a + b, 0), maxMs: lt.length ? Math.max(...lt) : 0 },
    counts: {
      requests: window.length,
      api: allApi.length,
      apiDupes: endpoints.reduce((sum, e) => sum + Math.max(0, e.count - 1), 0),
      slowestApiMs: durations.length ? Math.max(...durations) : null,
      apiTotalMs: durations.reduce((a, b) => a + b, 0),
    },
    endpoints,
  }
}

const results = []

// 1) Login + first dashboard load
routeLabel = 'login'
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
const loginStart = Date.now() / 1000
await page.fill('#username', USER)
await page.fill('#password', PASSWORD)
await page.click('button[type="submit"]')
await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 25000 })
await page.waitForLoadState('networkidle').catch(() => {})
const loginSummary = summarize('login + auth bootstrap', 'login', await heap(), await longTasks())
results.push(loginSummary)

// 2) Dashboard mount (full reload)
routeLabel = 'dashboard'
await page.evaluate(() => { window.__lt = [] })
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForLoadState('networkidle').catch(() => {})
await page.waitForTimeout(8000)
results.push(summarize('dashboard initial load (8s)', 'dashboard', await heap(), await longTasks()))

// 3) Polling window on dashboard: 26s of idle
routeLabel = 'dashboard-idle'
await page.evaluate(() => { window.__lt = [] })
await page.waitForTimeout(26000)
results.push(summarize('dashboard idle 26s (polling)', 'dashboard-idle', await heap(), await longTasks()))

// 4) Full reload of two heavy pages
for (const [label, path] of [
  ['sales-invoices', '/sales/invoices'],
  ['products', '/inventory/products'],
  ['sales-orders', '/sales/orders'],
]) {
  routeLabel = label
  await page.evaluate(() => { window.__lt = [] })
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(6000)
  results.push(summarize(`${label} load (6s)`, label, await heap(), await longTasks()))
}

// 5) In-app navigation: dashboard -> invoices -> products -> dashboard, 3 cycles
routeLabel = 'spa-nav'
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForLoadState('networkidle').catch(() => {})
await page.waitForTimeout(3000)
await page.evaluate(() => { window.__lt = [] })
for (let i = 0; i < 3; i++) {
  await page.click('aside a[href="/sales/invoices"]')
  await page.waitForTimeout(2500)
  await page.click('aside a[href="/inventory/products"]')
  await page.waitForTimeout(2500)
  await page.click('aside a[href="/"]')
  await page.waitForTimeout(2500)
}
results.push(summarize('3x in-app nav cycles (dashboard/invoices/products)', 'spa-nav', await heap(), await longTasks()))

// 6) Heap after repeated mounts (leak proxy)
const heapAfter = []
for (let i = 0; i < 3; i++) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  heapAfter.push(await heap())
}
results.push({ name: 'heap after 3 more dashboard reloads', heapMB: heapAfter })

const origins = [...new Set(recs.filter((r) => r.url.includes('/api/')).map((r) => new URL(r.url).origin))]
const payload = { base: BASE, origins, producedAt: new Date().toISOString(), results }

writeFileSync('build/ui-redesign/audit-perf.json', JSON.stringify(payload, null, 2))
console.log(JSON.stringify(payload, null, 2))
await browser.close()
