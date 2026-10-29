import { expect, test, type APIRequestContext } from '@playwright/test'

/** Double-submit CSRF: the endpoint also sets the cookie; echo the token back. */
async function csrfHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.get('/api/v1/csrf-token')
  if (!res.ok()) return {}
  const body = (await res.json()) as { csrfToken?: string }
  return body.csrfToken ? { 'X-CSRF-Token': body.csrfToken } : {}
}

/**
 * Inventory → Collections & Categories.
 *
 * Covers the foundation the backend tests cannot see: the page renders both
 * pricing collections with their stable ids, Silver Jewels is locked and lists
 * its seeded categories, the independent collection can be renamed (its id
 * stays put) and renamed back, and the category dialog suggests a SKU prefix.
 *
 * Nothing is created or deleted here, so the test is repeatable and leaves the
 * catalogue exactly as it found it. CRUD and authorization live in
 * backend/src/routes/collections.test.ts.
 */
// Restore the shipped display name even if an assertion fails mid-rename, so a
// red run never leaves the dev catalogue labelled "Preowned & Gifting".
test.afterEach(async ({ page }) => {
  const headers = await csrfHeaders(page.request)
  const res = await page.request.patch('/api/v1/db/inventory/collections/COL-OTHER-PRODUCTS', {
    headers,
    data: { name: 'Other Products' },
  })
  expect([200, 400], `could not restore the collection name (${res.status()})`).toContain(res.status())
})

test('collections page shows stable ids, locks Silver Jewels and renames the fixed-price collection', async ({ page }) => {
  const temporaryName = 'Preowned & Gifting'

  await page.goto('/inventory/collections')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Collections & Categories', {
    timeout: 20000,
  })

  // Both foundation collections, each with its stable id on display.
  await expect(page.getByText('ID COL-SILVER-JEWELS')).toBeVisible()
  await expect(page.getByText('ID COL-OTHER-PRODUCTS')).toBeVisible()

  // Silver Jewels is the system collection: silver-rate pricing, no rename.
  const silverCard = page.getByRole('button', { name: /Silver Jewels/ }).first()
  await expect(silverCard).toContainText('Silver rate')
  await expect(silverCard).toContainText('System')
  await expect(page.getByRole('button', { name: 'Rename Silver Jewels' })).toHaveCount(0)

  // Its seeded categories are listed with their established SKU prefixes.
  await silverCard.click()
  await expect(page.getByRole('cell', { name: /^Rings/ })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'RNG', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: /^Chains/ })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'CHN', exact: true })).toBeVisible()

  // The independent collection can be renamed; the id — not the name — is the
  // identity the page keeps showing.
  await page.getByRole('button', { name: 'Rename Other Products' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('ID COL-OTHER-PRODUCTS', { exact: false })).toBeVisible()
  await dialog.getByLabel('Display name').fill(temporaryName)
  await dialog.getByRole('button', { name: 'Save name' }).click()
  await expect(dialog).toHaveCount(0, { timeout: 10000 })
  await expect(page.getByText(temporaryName, { exact: true }).first()).toBeVisible()
  await expect(page.getByText('ID COL-OTHER-PRODUCTS')).toBeVisible()

  // Put the shipped name back so repeated runs start from the same state.
  await page.getByRole('button', { name: `Rename ${temporaryName}` }).click()
  const restore = page.getByRole('dialog')
  await restore.getByLabel('Display name').fill('Other Products')
  await restore.getByRole('button', { name: 'Save name' }).click()
  await expect(restore).toHaveCount(0, { timeout: 10000 })
  await expect(page.getByRole('button', { name: 'Rename Other Products' })).toBeVisible()

  // The category dialog derives the SKU prefix from the name; cancelling keeps
  // the catalogue untouched.
  await page.getByRole('button', { name: 'New Category' }).click()
  const categoryDialog = page.getByRole('dialog')
  await categoryDialog.getByLabel('Category name').fill('Bags')
  await expect(categoryDialog.getByLabel('SKU prefix')).toHaveValue('BAG')
  await categoryDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(categoryDialog).toHaveCount(0)
})
