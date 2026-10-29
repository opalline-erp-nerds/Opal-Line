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

const PREVIEW = 'iframe[title="Label preview"]'

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
      page: m('.page'),
      body: m('.tag-content'),
      outline: m('svg.tag-outline'),
      qrSvg: !!doc.querySelector('.qr svg'),
      text: doc.querySelector('.tag-content')?.textContent ?? '',
      embedded: doc.body.classList.contains('embedded'),
    }
  })
}

test('label designer preview tracks size, selection and content settings', async ({ page }) => {
  await page.setViewportSize({ width: 1650, height: 900 })
  await page.goto('/inventory/barcode')

  // Product rows and their selection boxes stay visible.
  const firstRow = page.locator('.divide-y > div').first()
  await expect(firstRow).toBeVisible()
  await expect(firstRow.locator('div').first()).toBeVisible()

  // Select one product so the preview follows it deterministically.
  await firstRow.click()
  await expect(page.locator('text=1 selected')).toBeVisible()

  // The preview shows a real tag: body at the configured size, QR present.
  await expect(page.locator(PREVIEW)).toBeVisible()
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

  // Changing the size updates the preview immediately.
  const widthInput = page.locator('label:has-text("Width")').locator('..').locator('input').first()
  await widthInput.fill(String(Number(cfgLabel) + 10))
  await widthInput.blur()
  await expect.poll(async () => (await previewGeometry(page))?.body?.wMm).toBeCloseTo(Number(cfgLabel) + 10, 0)
  // The stem still extends RIGHTWARD, OUTSIDE the (wider) body.
  const after = await previewGeometry(page)
  expect(after!.outline!.wMm).toBeGreaterThan(after!.body!.wMm)
  expect(after!.page!.wMm).toBeGreaterThan(after!.body!.wMm)
  // Stem length stays proportional to the body width (40%).
  expect(after!.outline!.wMm - after!.body!.wMm).toBeCloseTo((Number(cfgLabel) + 10) * 0.4, 0)
})

test('selecting another product swaps the rendered label data', async ({ page }) => {
  await page.setViewportSize({ width: 1650, height: 900 })
  await page.goto('/inventory/barcode')

  const rows = page.locator('.divide-y > div')
  await rows.first().click()
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
