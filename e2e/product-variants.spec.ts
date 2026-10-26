import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * Settings → Product codes (SKU auto-generation) and the Shopify-style
 * variant builder in the product dialog:
 *
 *  1. The settings tab previews codes from the configured format and saves.
 *  2. A new product is minted under those rules, gets option-driven variants
 *     with per-variant SKU/price/stock, rolls the variant stock into
 *     the parent, and round-trips through edit + the detail page.
 *
 * The product created here is deleted at the end and the settings row is
 * restored in afterEach, so repeated runs (and the installed-app suite) stay
 * deterministic.
 */

const PRODUCT_NAME = 'PW Variant Test Ring'

// Snapshot of the code settings before the test touched them — restored after.
let savedCodeSettings: Record<string, unknown> | null = null

/** Double-submit CSRF: the endpoint also sets the cookie; echo the token back. */
async function csrfHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.get('/api/v1/csrf-token')
  if (!res.ok()) return {}
  const body = (await res.json()) as { csrfToken?: string }
  return body.csrfToken ? { 'X-CSRF-Token': body.csrfToken } : {}
}

test.beforeEach(async ({ request }) => {
  const res = await request.get('/api/v1/db/settings')
  if (res.ok()) savedCodeSettings = await res.json()
})

test.afterEach(async ({ request }) => {
  if (!savedCodeSettings) return
  const headers = await csrfHeaders(request)
  await request.put('/api/v1/db/settings', {
    headers,
    data: {
      skuPrefix: savedCodeSettings.skuPrefix ?? null,
      skuSuffix: savedCodeSettings.skuSuffix ?? null,
      skuFormat: savedCodeSettings.skuFormat ?? null,
      skuSeqLength: savedCodeSettings.skuSeqLength ?? null,
    },
  })
  savedCodeSettings = null
})

test.describe('product codes & variants', () => {
  test('settings drive SKU generation and variants save like Shopify', async ({ page }) => {
    test.setTimeout(150_000)

    // ── 1. Settings → Product codes ──────────────────────────────────────
    await page.goto('/system/settings')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })
    await page.getByRole('tab', { name: /Product Codes/i }).click()

    // Prefix + sequence length flow straight into the live preview.
    await page.getByLabel('SKU prefix').fill('TST')
    await page.getByLabel('SKU sequence digits').fill('4')
    await expect(page.getByTestId('sku-preview')).toHaveText('TST-RNG-0042')

    await page.getByRole('button', { name: /Save Changes/i }).click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10000 })

    // ── 2. New product honours the configured format ─────────────────────
    await page.goto('/inventory/products')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })
    await page.getByRole('button', { name: 'Add', exact: true }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 10000 })
    await dialog.getByLabel('Product title').fill(PRODUCT_NAME)

    // SKU minted under the saved format (category "Silver jewels" → SIL).
    await expect(dialog.getByLabel('Product SKU')).toHaveValue(/^TST-SIL-\d{4}$/)

    // Pricing inputs drive the auto price: (105 + 20) × 10g × 1.03 = 1287.5,
    // which locks the selling price field.
    await dialog.getByLabel('Silver rate').fill('105')
    await dialog.getByLabel('Net weight').fill('10')
    await expect(dialog.getByLabel('Selling price')).toHaveValue('1287.5')

    // ── 3. Shopify-style options → variants ──────────────────────────────
    await dialog.getByRole('button', { name: 'Add option' }).click()
    await dialog.getByLabel('Option 1 name').fill('Size')
    const values = dialog.getByLabel('Values for Size')
    await values.fill('S')
    await values.press('Enter')
    await values.fill('M')
    await values.press('Enter')

    // Two combinations, each with its own minted SKU (parent + value code).
    await expect(dialog.getByText('2 variants')).toBeVisible()
    const parentSku = await dialog.getByLabel('Product SKU').inputValue()
    await expect(dialog.getByLabel(`SKU for S`)).toHaveValue(new RegExp(`^${parentSku}-S$`))
    await expect(dialog.getByLabel(`SKU for M`)).toHaveValue(new RegExp(`^${parentSku}-M$`))

    // Variants inherit the auto-calculated price...
    await expect(dialog.getByLabel('Price for S')).toHaveValue('1287.5')
    await expect(dialog.getByLabel('Price for M')).toHaveValue('1287.5')
    // ...and follow it when the pricing inputs recompute ((105+30)×10×1.03).
    await dialog.getByLabel('Making charge').fill('30')
    await expect(dialog.getByLabel('Price for S')).toHaveValue('1390.5')
    await expect(dialog.getByLabel('Price for M')).toHaveValue('1390.5')

    await dialog.getByLabel('Stock for S').fill('3')
    await dialog.getByLabel('Stock for M').fill('5')

    // No Shopify push from the test (the dev store may be unreachable).
    await dialog.getByRole('switch').last().click()
    await dialog.getByRole('button', { name: 'Create Product' }).click()
    await expect(dialog).toHaveCount(0, { timeout: 20000 })

    // ── 4. List + detail show the variants and the rolled-up stock ───────
    const row = page.locator('table tbody tr', { hasText: PRODUCT_NAME }).first()
    await expect(row).toBeVisible({ timeout: 10000 })
    // The products list opens newest-first: the just-created product is the
    // top row.
    await expect(page.locator('table tbody tr').first()).toContainText(PRODUCT_NAME)
    await expect(row.getByText('2 variants')).toBeVisible()

    await row.getByRole('link', { name: PRODUCT_NAME }).first().click()
    await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(PRODUCT_NAME, { timeout: 20000 })

    await expect(page.getByText('Variants', { exact: true })).toBeVisible()
    const variantsTable = page.getByRole('table').filter({ hasText: `${parentSku}-S` })
    await expect(variantsTable.getByRole('cell', { name: 'S', exact: true })).toBeVisible()
    await expect(variantsTable.getByRole('cell', { name: 'M', exact: true })).toBeVisible()
    // Parent stock is the sum of the variant stocks (3 + 5).
    await expect(page.getByText('8 pcs', { exact: true }).first()).toBeVisible()

    // ── 5. Edit round-trip keeps options, values and variant codes ───────
    await page.getByRole('button', { name: /Edit Product/i }).click()
    const editDialog = page.getByRole('dialog')
    await expect(editDialog.getByLabel('Option 1 name')).toHaveValue('Size')
    await expect(editDialog.getByLabel('Values for Size')).toBeVisible()
    await expect(editDialog.getByText('2 variants')).toBeVisible({ timeout: 10000 })
    await expect(editDialog.getByLabel(`SKU for S`)).toHaveValue(new RegExp(`^${parentSku}-S$`))
    await editDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 5000 })

    // ── 6. Cleanup: remove the test product (variants cascade) ───────────
    const list = await page.request.get('/api/v1/db/products?limit=200')
    const body = (await list.json()) as { data?: Array<{ id: string; name: string }> }
    const all = Array.isArray(body.data) ? body.data : []
    const targets = all.filter((p) => p.name === PRODUCT_NAME)
    if (targets.length > 0) {
      const headers = await csrfHeaders(page.request)
      for (const target of targets) {
        const del = await page.request.delete(`/api/v1/db/products/${target.id}`, { headers })
        expect(del.ok()).toBeTruthy()
      }
    }
  })
})
