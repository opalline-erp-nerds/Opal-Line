import { expect, test } from '@playwright/test'

/**
 * Walks the main application pages and fails on uncaught exceptions, React
 * error boundaries, or a "Page not found" render — the three ways a page
 * breakage surfaces in this SPA.
 */
const PAGES = [
  '/',
  '/system/status',
  '/system/updates',
  '/system/users',
  '/system/backup',
  '/system/settings',
  '/system/connections',
  '/system/activity',
  '/system/print-designer',
  '/inventory/products',
  '/inventory/locations',
  '/inventory/transfers',
  '/sales/invoices',
  '/sales/customers',
  '/sales/quotations',
  '/reports/business',
  '/shopify/dashboard',
  '/accounts/accounting',
]

for (const path of PAGES) {
  test(`renders ${path} without errors`, async ({ page }) => {
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })

    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })
    await expect(page.getByText('Page not found')).toHaveCount(0)
    await expect(page.getByText('An error occurred')).toHaveCount(0)

    expect(pageErrors, `uncaught exceptions on ${path}`).toEqual([])
    expect(
      consoleErrors.filter(
        (e) =>
          !/favicon|net::ERR_ABORTED|Load failed/i.test(e) &&
          // Expected on /system/print-designer: the preview iframe is
          // sandboxed WITHOUT allow-scripts, so Chromium logs the blocked
          // auto-print script, and the Google-Fonts import is blocked by the
          // page CSP inside the srcdoc frame (cosmetic — real print windows
          // are not sandboxed and load fonts fine).
          !/frame is sandboxed|violates the following Content Security Policy/i.test(e),
      ),
      `console errors on ${path}`,
    ).toEqual([])
  })
}

test('system status page shows live server info, updates and logs', async ({ page }) => {
  await page.goto('/system/status')
  await expect(page.getByRole('heading', { name: 'System Status' })).toBeVisible()
  // live data from the new /api/v1/system/status endpoint — the port depends on
  // the environment (47192 installed app / 47191 dev backend), so match the prefix.
  await expect(page.getByText(/^Port 47\d{3}/)).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('Healthy')).toBeVisible()
  // update card (desktop bridge may be absent in a plain browser — the card
  // must render either way)
  await expect(page.getByRole('heading', { name: 'Software updates' })).toBeVisible()
  // log viewer wired to /api/v1/system/logs
  await expect(page.getByRole('heading', { name: 'Server logs' })).toBeVisible()
  await expect(page.getByRole('button', { name: /app\.log/ })).toBeVisible()
})

test('navigation sidebar exposes the system section', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('link', { name: /System Status/i })).toBeVisible()
  await expect(page.getByRole('link', { name: /Users & Roles/i })).toBeVisible()
  await expect(page.getByRole('link', { name: /Backup & Restore/i })).toBeVisible()
  await expect(page.getByRole('link', { name: /Print Designer/i })).toBeVisible()
})

test('print designer renders live preview and option groups', async ({ page }) => {
  await page.goto('/system/print-designer')
  await expect(page.getByRole('heading', { name: 'Print Designer' })).toBeVisible()
  await expect(page.getByText('Live preview — invoice')).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('Header style').first()).toBeVisible()
  await expect(page.getByText('Accent color').first()).toBeVisible()
  await expect(page.getByText('Bank / payment details')).toBeVisible()
  // The preview iframe must be sandboxed (only same-origin, no scripts).
  const sandbox = await page.locator('iframe[title="Print preview"]').getAttribute('sandbox')
  expect(sandbox ?? '').not.toContain('allow-scripts')
})

test('customers page shows the PII-recovery tools', async ({ page }) => {
  await page.goto('/sales/customers')
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })
  // The Sync Customers control must exist regardless of gap state.
  await expect(page.getByRole('button', { name: /Sync Customers/i }).first()).toBeVisible({ timeout: 15000 })
})

test('dashboard shows error state when API fails', async ({ page }) => {
  // Mock the dashboard KPIs API to return an error
  // Trailing * so the pattern matches the ?period=... query string too.
  await page.route('**/api/v1/db/dashboard/kpis*', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Couldn\'t load sales data' }),
    })
  })

  await page.goto('/')

  // Wait for dashboard to load and error state to appear
  await expect(page.getByText('Couldn\'t load sales data')).toBeVisible({ timeout: 15000 })
  // Verify the empty state is NOT shown
  await expect(page.getByText('Nothing to report yet')).not.toBeVisible({ timeout: 5000 })
  // Verify the Retry button is present
  await expect(page.getByRole('button', { name: /Retry/i })).toBeVisible({ timeout: 5000 })
})
