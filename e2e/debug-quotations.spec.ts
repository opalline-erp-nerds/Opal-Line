import { expect, test } from '@playwright/test'

/**
 * TEMPORARY diagnostic — reproduces the reported failure exactly like a user:
 * focus, type characters one by one, watch dropdown, pick a product, read
 * net-weight / line total / grand total, capture console errors and failed
 * network responses. Deleted after the investigation.
 */

test('debug: quotation form interaction with console/network capture', async ({ page, request }) => {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const failedResponses: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('favicon')) {
      failedResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`)
    }
  })

  const productsRes = await request.get('/api/v1/db/products?limit=200')
  const prodsBody = (await productsRes.json()) as { data?: Array<{
    name: string
    sku: string
    netWeight: number | null
    makingCharge: number | null
    pieceRateProduct: boolean | null
    stock: number | null
  }> }
  const catalogue = prodsBody.data ?? []
  const pick = catalogue.find((p) => !p.pieceRateProduct && Number(p.netWeight) > 0) ?? catalogue[0]
  console.log('CATALOGUE SIZE:', catalogue.length)
  console.log('PICK:', JSON.stringify(pick))

  const silverRes = await request.get('/api/v1/silver/rate')
  console.log('SILVER RATE RESPONSE:', silverRes.status(), (await silverRes.text()).slice(0, 200))

  await page.goto('/sales/quotations')
  await expect(page.getByRole('heading', { level: 1, name: /Quotations/i })).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: 'New Quotation' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  // Let catalogue/rate loads settle.
  await page.waitForTimeout(1500)

  const productField = dialog.getByPlaceholder('Search name or SKU…')
  // Real typing, character by character, like a user.
  await productField.click()
  const probe = pick.name.slice(0, 6)
  await productField.pressSequentially(probe, { delay: 60 })
  await page.waitForTimeout(700)

  // Screenshot immediately after typing for visual confirmation.
  await page.screenshot({ path: 'test-results/debug-typed.png', fullPage: false })
  console.log('PRODUCT FIELD VALUE after typing:', await productField.inputValue())

  const hits = dialog.getByRole('button', { name: new RegExp(pick.sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
  console.log('DROPDOWN HIT COUNT for', pick.sku, ':', await hits.count())
  if ((await hits.count()) === 0) {
    // Log whatever dropdown buttons exist at all.
    const anyButtons = dialog.locator('div.absolute.z-20 button')
    const texts = await anyButtons.allTextContents()
    console.log('DROPDOWN BUTTONS SEEN:', JSON.stringify(texts.slice(0, 12)))
  }
  await expect(hits.first()).toBeVisible({ timeout: 10000 })
  await hits.first().click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'test-results/debug-picked.png', fullPage: false })

  console.log('PRODUCT FIELD VALUE after pick:', await productField.inputValue())
  const netW = dialog.getByLabel(/Net wt pc/i)
  console.log('NET WT VALUE:', await netW.inputValue())
  const lineText = await dialog.locator('text=/^Line \\(/').first().textContent()
  console.log('LINE TOTAL TEXT:', lineText)
  const totalsBlock = await dialog.locator('p', { hasText: /Grand total/i }).allTextContents()
  console.log('GRAND TOTAL AREA:', JSON.stringify(totalsBlock))
  const gstArea = await dialog.locator('div', { hasText: 'Grand total' }).last().textContent()
  console.log('TOTALS BLOCK TEXT:', (gstArea ?? '').slice(0, 300))

  console.log('CONSOLE ERRORS:', JSON.stringify(consoleErrors.slice(0, 10)))
  console.log('PAGE ERRORS:', JSON.stringify(pageErrors.slice(0, 5)))
  console.log('FAILED RESPONSES:', JSON.stringify(failedResponses.slice(0, 10)))
})
