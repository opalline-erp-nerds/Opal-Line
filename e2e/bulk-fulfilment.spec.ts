import { expect, test } from '@playwright/test'

test.describe('bulk fulfilment printing and pipeline moves', () => {
  test('bulk print packing slips renders one document per selected order with thumbnails', async ({ page }) => {
    test.setTimeout(90_000)
    // Capture the generated documents: printDocument writes the built HTML
    // into a window opened via window.open. Stubbing it avoids racing the
    // auto-print close while still asserting the real markup. Must be
    // registered BEFORE the goto so the stub is installed at document-start.
    await page.addInitScript(() => {
      const realOpen = window.open.bind(window)
      ;(window as unknown as { open: (url?: string | URL, target?: string, features?: string) => Window | null }).open = ((url?: string | URL, target?: string, features?: string) => {
        const fake = {
          closed: false,
          opener: null,
          document: {
            open: () => fake.document,
            write: (html: string) => {
              ;(window as unknown as { __printedDocs?: string[] }).__printedDocs =
                (window as unknown as { __printedDocs?: string[] }).__printedDocs ?? []
              ;(window as unknown as { __printedDocs: string[] }).__printedDocs.push(html)
            },
            close: () => {},
          },
          focus: () => {},
          print: () => {},
          close: () => {},
        }
        return fake as unknown as Window
      }) as typeof window.open
      void realOpen
      void url
      void target
      void features
    })

    await page.goto('/sales/orders')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })

    // Bulk print needs two orders with items. On a freshly bootstrapped
    // database (installed desktop app, CI) the table only shows its
    // empty-state row — skip instead of failing on missing checkboxes.
    if ((await page.locator('table tbody tr input[type="checkbox"]').count()) < 2) {
      test.skip(true, 'no sales orders in this database (fresh install)')
      return
    }

    // Pick rows whose orders actually have line items (itemless orders are
    // skipped by the bulk printer).
    const rows = page
      .locator('table tbody tr')
      .filter({ hasNot: page.getByText(/0 item/) })
    await expect(rows.first()).toBeVisible({ timeout: 20000 })

    await rows.nth(0).locator('input[type="checkbox"]').check()
    await rows.nth(1).locator('input[type="checkbox"]').check()
    await expect(page.getByText('2 selected')).toBeVisible()
    await page.getByRole('button', { name: /Print Packing Slips/i }).click()
    await page.waitForTimeout(1500)

    const printed = await page.evaluate(() => (window as unknown as { __printedDocs?: string[] }).__printedDocs ?? [])
    expect(printed.length, 'one packing slip per selected order with items').toBe(2)
    for (const html of printed) {
      expect(html).toContain('PACKING SLIP')
      expect(html).toContain('Deliver To')
      expect(html).toContain('Packed By')
    }
    // Thumbnails are only possible for the products ON these slips, so the
    // check is scoped to the SKUs each document actually contains. (Testing
    // the whole catalogue would fail whenever the two printed orders happen to
    // hold products without photos.)
    const imagedSkus = await page.evaluate(async () => {
      const res = await fetch('/api/v1/db/products?limit=200')
      if (!res.ok) return [] as string[]
      const body = await res.json() as { data?: Array<{ sku?: string | null; image?: string | null }> }
      return (body.data ?? [])
        .filter((p) => typeof p.image === 'string' && p.image.length > 0 && p.sku)
        .map((p) => String(p.sku))
    })
    const slipsWithImagedItem = printed.filter((html) => imagedSkus.some((sku) => html.includes(sku)))
    if (slipsWithImagedItem.length > 0) {
      expect(
        slipsWithImagedItem.some((html) => html.includes('<img')),
        'thumbnail img rendered for imaged products',
      ).toBe(true)
    }
  })

  test('order pipeline supports checkbox selection and bulk move toolbar', async ({ page }) => {
    test.setTimeout(90_000)
    await page.goto('/sales/pipeline')
    await expect(page.getByRole('heading', { name: 'Order Pipeline' })).toBeVisible({ timeout: 20000 })

    // The pipeline renders one card per order — nothing to select on a
    // freshly bootstrapped database (installed desktop app, CI).
    if ((await page.locator('input[type="checkbox"]').count()) === 0) {
      test.skip(true, 'no orders in the pipeline (fresh install)')
      return
    }

    const card = page.locator('input[type="checkbox"]').first()
    await card.check({ timeout: 20000 })

    // Bulk toolbar appears with a move button per stage (exact names — the
    // column headers also render "Select all <stage> orders" buttons).
    await expect(page.getByText('1 selected')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Confirmed', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Processing', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Fulfilled', exact: true })).toBeVisible()

    // Clearing keeps everything intact without moving anything.
    await page.getByRole('button', { name: 'Clear' }).click()
    await expect(page.getByText('1 selected')).toHaveCount(0)
  })
})
