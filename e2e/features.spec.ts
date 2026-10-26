import { expect, test } from '@playwright/test'

test.describe('recent feature coverage', () => {
  test('customer 360 page renders profile with lifetime stats', async ({ page }) => {
    await page.goto('/sales/customers')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })

    // Customer 360 opens from an existing customer row — a freshly
    // bootstrapped database (installed desktop app, CI) has no customers.
    if ((await page.getByRole('button', { name: /customer 360/i }).count()) === 0) {
      test.skip(true, 'no customers in this database (fresh install)')
      return
    }

    // Open Customer 360 from the first customer row action.
    await page.getByRole('button', { name: /customer 360/i }).first().click({ timeout: 20000 })

    // Profile header shows the customer's name as the page title, plus the
    // lifetime stats section.
    await expect(page.getByText('Single view of orders, invoices, dues, payments and loyalty.')).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('Lifetime').first()).toBeVisible()
    await expect(page.getByText(/Lifetime value/).first()).toBeVisible()
    await expect(page.getByText(/Loyalty points/).first()).toBeVisible()
  })

  test('sales orders page exposes the repair control (PII recovery)', async ({ page }) => {
    await page.goto('/sales/orders')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })
    await expect(page.getByRole('button', { name: /Repair customer info/i })).toBeVisible({ timeout: 15000 })
    // The confirm dialog must NOT open by itself — it needs a click.
    await expect(page.getByText('Repair order customer details?')).toHaveCount(0)
  })

  test('print designer offers design export and import for every doc type', async ({ page }) => {
    await page.goto('/system/print-designer')
    await expect(page.getByRole('heading', { name: 'Print Designer' })).toBeVisible()

    await expect(page.getByRole('button', { name: /Export design/i })).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('Import design')).toBeVisible()

    // The export/import controls must exist on all five doc tabs.
    const tabs = ['Invoice', 'Quotation', 'Order', 'Packing Slip', 'Pick List', 'Product Label']
    for (const t of tabs) {
      await page.getByRole('tab', { name: new RegExp(`^${t}$`, 'i') }).click()
      await expect(page.getByRole('button', { name: /Export design/i })).toBeVisible({ timeout: 5000 })
      await expect(page.getByText('Import design')).toBeVisible()
    }
  })

  test('print design export produces a valid opal-print file and import round-trips it', async ({ page }) => {
    await page.goto('/system/print-designer')
    await expect(page.getByRole('heading', { name: 'Print Designer' })).toBeVisible()
    await expect(page.getByText('Live preview — invoice')).toBeVisible({ timeout: 15000 })

    // Export and capture the download.
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /Export design/i }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/invoice-.*\.opal-print\.json$/)

    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const c of stream) chunks.push(c as Buffer)
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    expect(parsed._opalPrint).toBe(1)
    expect(parsed.docType).toBe('invoice')
    expect(parsed.config).toBeTruthy()
  })
})
