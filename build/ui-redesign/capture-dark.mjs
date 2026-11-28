import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:47195'
const USER = process.env.E2E_USER ?? 'admin'
const PASSWORD = process.env.E2E_PASSWORD ?? 'Opal@2026'
const out = 'build/ui-redesign'
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome' })
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
await ctx.addInitScript(() => localStorage.setItem('opal-theme', 'dark'))
const page = await ctx.newPage()

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1000)
await page.screenshot({ path: `${out}/dark-login-1920x1080.png`, fullPage: true })

await page.fill('#username', USER)
await page.fill('#password', PASSWORD)
await page.click('button[type="submit"]')
await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 25000 })
await page.waitForLoadState('networkidle').catch(() => {})
await page.waitForTimeout(2200)

const routes = [
  ['dashboard', '/'],
  ['products', '/inventory/products'],
  ['sales-invoices', '/sales/invoices'],
  ['stock-overview', '/inventory/stock'],
  ['payments', '/accounts/payments'],
  ['settings', '/system/settings'],
]

for (const [name, path] of routes) {
  if (path !== '/') {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(1600)
  }
  await page.screenshot({ path: `${out}/dark-${name}-1920x1080.png`, fullPage: true })
  console.log('captured dark', name)
}

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForLoadState('networkidle').catch(() => {})
await page.waitForTimeout(1800)
const metrics = await page.evaluate(() => {
  const css = (selector) => {
    const el = document.querySelector(selector)
    return el ? getComputedStyle(el) : null
  }
  const active = document.querySelector('button[aria-pressed="true"]')
  const nav = document.querySelector('aside a[href="/"]')
  const hero = document.querySelector('section[aria-label="Opal Line overview"]')
  const heroImg = hero?.querySelector('img')
  return {
    theme: document.documentElement.className,
    bodyBackground: css('body')?.backgroundColor,
    sidebarBackground: css('aside')?.backgroundColor,
    headerBackground: css('header')?.backgroundColor,
    cardBackground: css('main .rounded-2xl')?.backgroundColor,
    borderColor: css('main .rounded-2xl')?.borderColor,
    primaryText: css('body')?.color,
    activeSegmentBackground: active ? getComputedStyle(active).backgroundColor : null,
    activeSegmentText: active ? getComputedStyle(active).color : null,
    activeSegmentIcon: active ? getComputedStyle(active.querySelector('svg')).color : null,
    activeNavBackground: nav ? getComputedStyle(nav).backgroundColor : null,
    activeNavText: nav ? getComputedStyle(nav).color : null,
    heroBackground: hero ? getComputedStyle(hero).backgroundImage : null,
    heroImageFilter: heroImg ? getComputedStyle(heroImg).filter : null,
    globalImageFilter: getComputedStyle(document.querySelector('img')).filter,
  }
})
console.log(JSON.stringify(metrics, null, 2))
await page.screenshot({ path: `${out}/dark-dashboard-segment.png`, fullPage: false })

await browser.close()
