import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:47195'
const USER = process.env.E2E_USER ?? 'admin'
const PASSWORD = process.env.E2E_PASSWORD ?? 'Opal@2026'
const out = 'build/ui-redesign'
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome' })
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
})
const page = await ctx.newPage()

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await page.screenshot({ path: `${out}/login-1920x1080.png`, fullPage: true })

await page.fill('#username', USER)
await page.fill('#password', PASSWORD)
await page.click('button[type="submit"]')
try {
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 25000 })
} catch {
  await page.screenshot({ path: `${out}/login-failed-1920x1080.png`, fullPage: true })
  console.log('LOGIN_FAILED', await page.locator('body').innerText())
  await browser.close()
  process.exit(1)
}
await page.waitForLoadState('networkidle').catch(() => {})
await page.waitForTimeout(2500)

const routes = [
  ['dashboard', '/'],
  ['products', '/inventory/products'],
  ['sales-invoices', '/sales/invoices'],
  ['sales-orders', '/sales/orders'],
  ['stock-overview', '/inventory/stock'],
  ['silver-rate', '/silver-rate'],
  ['payments', '/accounts/payments'],
  ['business-reports', '/reports/business'],
  ['settings', '/system/settings'],
]

for (const [name, path] of routes) {
  if (path !== '/') {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(1800)
  }
  await page.screenshot({ path: `${out}/${name}-1920x1080.png`, fullPage: true })
  console.log('captured', name)
  if (name === 'dashboard') {
    const tokens = await page.evaluate(() => {
      const css = (el) => (el ? getComputedStyle(el) : null)
      const aside = document.querySelector('aside')
      const header = document.querySelector('header')
      const card = document.querySelector('main .rounded-2xl')
      const active = document.querySelector('aside a[href="/"]')
      return {
        bodyBackground: css(document.body)?.backgroundColor,
        sidebarBackground: css(aside)?.backgroundColor,
        headerBackground: css(header)?.backgroundColor,
        cardBackground: css(card)?.backgroundColor,
        cardRadius: css(card)?.borderRadius,
        cardBorderColor: css(card)?.borderColor,
        activeNavBackground: css(active)?.backgroundColor,
        activeNavColor: css(active)?.color,
        sidebarWidth: aside?.getBoundingClientRect().width,
        primaryCssVar: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
      }
    })
    console.log(JSON.stringify(tokens, null, 2))
  }
}

// Full-height dashboard capture: unwrap the app's internal scroll container so
// the lower analytics cards are included at 1920px wide.
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForLoadState('networkidle').catch(() => {})
await page.waitForTimeout(2200)
await page.addStyleTag({
  content: '.app-shell{height:auto!important;overflow:visible!important}.app-main{overflow:visible!important}aside{height:auto!important}',
})
await page.waitForTimeout(600)
await page.screenshot({ path: `${out}/dashboard-full-1920.png`, fullPage: true })
console.log('captured dashboard-full')

await browser.close()
