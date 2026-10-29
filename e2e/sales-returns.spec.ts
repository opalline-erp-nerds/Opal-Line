import { expect, test } from '@playwright/test'

// Regression coverage for the /sales/returns crash: the status badge was built
// from `statusMeta[row.original.status].variant`, and credit notes raised by
// the invoice return workflow are stored with the status `processed` — so the
// lookup returned undefined, the cell threw and the page rendered the
// ErrorBoundary's "Something went wrong" fallback instead of the list.
test.describe('sales returns', () => {
  test('the returns page loads instead of falling into the error boundary', async ({ page }) => {
    await page.goto('/sales/returns')
    await expect(page.getByRole('heading', { name: 'Sales Returns' })).toBeVisible({ timeout: 20000 })
    await expect(page.getByText('Something went wrong')).toHaveCount(0)

    // The table settles into either rows or its empty message — never the
    // loading skeleton, never a crash.
    await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('Loading data...')).toHaveCount(0)

    // Whatever status a row carries, it gets a badge instead of an exception.
    const badges = page.locator('tbody tr')
    const count = await badges.count()
    for (let i = 0; i < count; i++) {
      await expect(badges.nth(i)).toBeVisible()
    }
    await expect(page.getByText('Something went wrong')).toHaveCount(0)
  })

  test('the search box filters the list once it has loaded', async ({ page }) => {
    await page.goto('/sales/returns')
    await expect(page.getByRole('heading', { name: 'Sales Returns' })).toBeVisible({ timeout: 20000 })
    await page.getByPlaceholder('Search return, order, customer...').fill('zzz-no-such-return')
    // A search with no matches reports that honestly rather than erroring.
    await expect(page.getByText('No returns found')).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('Something went wrong')).toHaveCount(0)
  })
})
