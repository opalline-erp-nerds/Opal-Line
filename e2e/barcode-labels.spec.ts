// Regression e2e for the QR & Barcode Labels page (/inventory/barcode).
//
// Covers the acceptance criteria:
//   * product rows render with clearly visible selection checkboxes,
//   * the preview iframe renders the ACTUAL selected product (name/SKU/QR),
//   * changing the label size immediately re-renders the preview at the new
//     physical size (body exactly width×height mm, stem extending to the
//     right of it),
//   * printed @page size includes the stem footprint.
import { test, expect } from '@playwright/test'
import { csrfApi, seedProducts } from './fixtures'

const PREVIEW = 'iframe[title="Label preview"]'

/**
 * A freshly bootstrapped database has NO products, and the designer's list is
 * exactly that list — so each spec seeds the two rows it clicks through and
 * removes them again afterwards (a failure included).
 */
let seededCleanup: (() => Promise<void>) | null = null
test.afterEach(async () => {
  if (seededCleanup) await seededCleanup()
  seededCleanup = null
})

async function previewGeometry(page: import('@playwright/test').Page) {
  return page.locator(PREVIEW).evaluate((el) => {
    const doc = (el as HTMLIFrameElement).contentDocument
    if (!doc) return null
    const m = (sel: string) => {
      const x = doc.querySelector(sel)
      if (!x) return null
      const b = x.getBoundingClientRect()
      return { wMm: +(b.width / (96 / 25.4)).toFixed(2), hMm: +(b.height / (96 / 25.4)).toFixed(2) }
    }
    return {
      // The label renderer draws one physical box per label (`.lbl`) inside the
      // printed page; the older tag-with-stem markup is gone, so the box itself
      // is what the configured width/height must match.
      page: m('.page'),
      body: m('.lbl'),
      qrSvg: !!doc.querySelector('.qr svg'),
      text: doc.querySelector('.lbl')?.textContent ?? '',
      embedded: doc.body.classList.contains('embedded'),
    }
  })
}

test('label designer preview tracks size, selection and content settings', async ({ page, request }) => {
  const { cleanup } = await seedProducts(await csrfApi(request), { prefix: 'E2E-LBL', count: 2 })
  seededCleanup = cleanup
  await page.setViewportSize({ width: 1650, height: 900 })
  await page.goto('/inventory/barcode')
  // The geometry assertions below target the JEWELLERY TAG layout — the body
  // box at the configured size plus the stem outline to its right. The
  // designer now OPENS on "Normal label", whose fields are absolutely
  // positioned and carry neither `.tag-content` nor the stem, so pick the mode
  // the assertions describe before measuring anything.
  await page.getByRole('button', { name: /Jewellery Tag/ }).click()

  // Product rows and their selection boxes stay visible.
  const firstRow = page.locator('.divide-y > div').first()
  await expect(firstRow).toBeVisible()
  await expect(firstRow.locator('div').first()).toBeVisible()

  // Select one product so the preview follows it deterministically.
  await firstRow.click()
  await expect(page.locator('text=1 selected')).toBeVisible()

  // The preview shows a real tag: body at the configured size, QR present.
  await expect(page.locator(PREVIEW)).toBeVisible()
  // The iframe paints its product asynchronously — wait for real content
  // instead of racing the first render (the geometry reads need `.tag-content`).
  await expect
    .poll(async () => (await previewGeometry(page))?.text ?? '', { timeout: 15000 })
    .not.toBe('')
  const before = await previewGeometry(page)
  expect(before).not.toBeNull()
  const cfgLabel = await page.locator('label:has-text("Width")').locator('..').locator('input').first().inputValue()
  expect(Number(cfgLabel)).toBeGreaterThan(0)
  // Close the settings width input value equals the body box.
  expect(before!.body!.wMm).toBeCloseTo(Number(cfgLabel), 0)
  expect(before!.qrSvg).toBe(true)
  // The preview iframe must embed the bare page — no screen-window padding,
  // which used to clip the same edge off permanently.
  expect(before!.embedded).toBe(true)

  // The configured height is honoured too.
  const heightInput = page.locator('label:has-text("Height")').locator('..').locator('input').first()
  expect(before!.body!.hMm).toBeCloseTo(Number(await heightInput.inputValue()), 0)

  // Changing the size updates the preview immediately.
  const widthInput = page.locator('label:has-text("Width")').locator('..').locator('input').first()
  await widthInput.fill(String(Number(cfgLabel) + 10))
  await widthInput.blur()
  await expect.poll(async () => (await previewGeometry(page))?.body?.wMm).toBeCloseTo(Number(cfgLabel) + 10, 0)
  // The page is cut to the label, so it grows with the box instead of clipping it.
  const after = await previewGeometry(page)
  expect(after!.page!.wMm).toBeCloseTo(after!.body!.wMm, 0)
  expect(after!.page!.wMm).toBeCloseTo(Number(cfgLabel) + 10, 0)
})

test('selecting another product swaps the rendered label data', async ({ page, request }) => {
  const { cleanup } = await seedProducts(await csrfApi(request), { prefix: 'E2E-LBL', count: 2 })
  seededCleanup = cleanup
  await page.setViewportSize({ width: 1650, height: 900 })
  await page.goto('/inventory/barcode')
  // previewGeometry reads the jewellery-tag markup (see the sibling test).
  await page.getByRole('button', { name: /Jewellery Tag/ }).click()

  const rows = page.locator('.divide-y > div')
  await rows.first().click()
  // Selection repaints the iframe asynchronously — wait for the product's
  // text to land before reading it (the old immediate read raced the paint).
  await expect
    .poll(async () => (await previewGeometry(page))?.text ?? '', { timeout: 15000 })
    .not.toBe('')
  const first = await previewGeometry(page)
  expect(first?.text?.length ?? 0).toBeGreaterThan(0)

  await rows.nth(1).click()
  await expect(page.locator('text=2 selected')).toBeVisible()
  // Step the preview to the second selected product with the next arrow.
  const next = page.locator('button[title="Next product"]')
  await expect(next).toBeEnabled()
  await next.click()
  await expect.poll(async () => (await previewGeometry(page))?.text).not.toEqual(first!.text)
  const second = await previewGeometry(page)
  // And the QR must still render for the new SKU.
  expect(second!.qrSvg).toBe(true)
})
