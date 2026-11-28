import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:47195'
const USER = process.env.E2E_USER ?? 'admin'
const PASSWORD = process.env.E2E_PASSWORD ?? 'Opal@2026'
const out = 'build/ui-redesign'
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome' })
const viewports = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '390x844', width: 390, height: 844 },
]

for (const vp of viewports) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
  })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${out}/login-${vp.name}.png`, fullPage: true })

  await page.fill('#username', USER)
  await page.fill('#password', PASSWORD)
  await page.click('button[type="submit"]')
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 25000 })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(2200)
  await page.screenshot({ path: `${out}/dashboard-${vp.name}.png`, fullPage: true })
  console.log('captured', vp.name)
  await ctx.close()
}

await browser.close()
