/**
 * Real-browser check of the Returns & Refunds page against the RUNNING dev
 * stack (backend on :47191, Vite on :47195).
 *
 * It mints a normal database session for an existing admin (same mechanism as
 * logging in — no password is changed), opens the page in the installed Chrome,
 * exercises the tabs and the create dialogs (preview only, never submits a
 * money movement) and reports console errors plus non-2xx API responses.
 *
 *   cd backend && npx tsx scripts/_ui-check.mts
 */
import 'dotenv/config'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { db } from '../src/db/client'
import * as s from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { createSession, destroySession } from '../src/sessions'

const APP = process.env.UI_BASE ?? 'http://127.0.0.1:47195'
const SHOTS = join(tmpdir(), 'opal-line-returns-ui') + '/'


async function main() {
  if (!db) throw new Error('no database')
  const [admin] = await db
    .select({ id: s.users.id, email: s.users.email, role: s.users.role })
    .from(s.users)
    .where(eq(s.users.status, 'active'))
    .limit(1)
  if (!admin) throw new Error('no admin user to sign in as')
  console.log('session for', admin.email, `(${admin.role})`)

  const token = await createSession(admin.id)
  mkdirSync(SHOTS, { recursive: true })

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  await context.addCookies([{ name: 'opal.session', value: token, domain: '127.0.0.1', path: '/' }])
  const page = await context.newPage()

  const consoleErrors: string[] = []
  const badResponses: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300))
  })
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message.slice(0, 300)))
  page.on('response', (res) => {
    const url = res.url()
    if (!url.includes('/api/')) return
    if (res.status() >= 400) badResponses.push(`${res.status()} ${res.request().method()} ${url.replace(APP, '')}`)
  })

  const step = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (err) {
      console.log('STEP FAILED', label, err instanceof Error ? err.message : err)
    }
  }

  await page.goto(`${APP}/sales/returns`, { waitUntil: 'load' })
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1200)
  console.log('title visible:', await page.getByText('Returns & Refunds').first().isVisible().catch(() => false))
  console.log(
    'summary cards:',
    (await page.locator('text=/Open returns|Refunded|Pending refunds|Last Shopify sync/').allInnerTexts()).join(' | '),
  )
  await page.screenshot({ path: SHOTS + '01-returns.png', fullPage: false })

  await step('refunds tab', async () => {
    await page.getByRole('tab', { name: /Refunds/ }).click()
    await page.waitForTimeout(1500)
    await page.screenshot({ path: SHOTS + '02-refunds.png' })
    console.log('refunds table rows:', await page.locator('tbody tr').count())
    console.log('refunds empty/error:', await page.locator('text=/No refunds recorded|Failed to load/').first().innerText().catch(() => 'none'))
  })

  await step('new refund dialog + live preview', async () => {
    await page.getByRole('button', { name: /New refund/ }).click()
    await page.waitForTimeout(600)
    const orderInput = page.locator('input[placeholder*="order" i]').first()
    await orderInput.fill('1027')
    await page.waitForTimeout(2500)
    await page.getByRole('dialog').locator('button').filter({ hasText: '#1027' }).first().click()
    await page.waitForTimeout(5000)
    await page.screenshot({ path: SHOTS + '03-refund-dialog.png' })
    // Ask Shopify for a real preview (CSRF + suggestedRefund round-trip).
    await page.getByRole('dialog').locator('input[type=number]').first().fill('1')
    await page.waitForTimeout(4000)
    const body = await page.locator('[role="dialog"]').first().innerText().catch(() => '')
    console.log('refund dialog text:', body.replace(/\s+/g, ' ').slice(0, 1100))
    await page.goto(`${APP}/sales/returns`, { waitUntil: 'load' })
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(800)
  })

  await step('new return dialog', async () => {
    await page.getByRole('tab', { name: /Returns/ }).click()
    await page.waitForTimeout(800)
    await page.getByRole('button', { name: /New return/ }).click()
    await page.waitForTimeout(600)
    const search = page.locator('input[placeholder*="order" i]').first()
    await search.fill('1027')
    await page.waitForTimeout(2500)
    await page.getByRole('dialog').locator('button').filter({ hasText: '#1027' }).first().click()
    await page.waitForTimeout(3500)
    await page.screenshot({ path: SHOTS + '04-return-dialog.png' })
    const body = await page.locator('[role="dialog"]').first().innerText().catch(() => '')
    console.log('return dialog text:', body.replace(/\s+/g, ' ').slice(0, 900))
    await page.goto(`${APP}/sales/returns`, { waitUntil: 'load' })
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)
  })

  await step('open a return row', async () => {
    await page.waitForTimeout(800)
    const row = page.locator('tbody tr').first()
    console.log('return rows:', await page.locator('tbody tr').count())
    if ((await row.count()) > 0) {
      await row.dblclick()
      await page.waitForTimeout(1500)
      await page.screenshot({ path: SHOTS + '05-return-detail.png' })
      console.log('detail dialog:', await page.locator('[role="dialog"]').first().innerText().then((t) => t.replace(/\s+/g, ' ').slice(0, 400)).catch(() => 'none'))
    } else {
      console.log('no return rows to open yet')
    }
  })

  console.log('CONSOLE ERRORS:', consoleErrors.length ? consoleErrors : 'none')
  console.log('API FAILURES:', badResponses.length ? badResponses : 'none')

  await browser.close()
  await destroySession(token)
  process.exit(0)
}

void main().catch(async (err) => {
  console.error(err)
  process.exit(1)
})
