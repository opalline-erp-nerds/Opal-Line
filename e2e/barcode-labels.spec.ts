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

// Every rectangular preset listed after 50×10 mm · Compact.
const POST_COMPACT_PRESETS = [
  { key: 'label-50x22', widthMm: 50, heightMm: 22 },
  { key: 'avery-5160', widthMm: 63.5, heightMm: 25.4 },
  { key: 'avery-8160', widthMm: 38.1, heightMm: 21.2 },
  { key: 'dymo-30256', widthMm: 51, heightMm: 25 },
  { key: 'zlabel-50x30', widthMm: 50, heightMm: 30 },
  { key: 'zlabel-40x25', widthMm: 40, heightMm: 25 },
] as const

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
      page: m('.page'),
      body: m('.tag-content'),
      outline: m('svg.tag-outline'),
      qrSvg: !!doc.querySelector('.qr svg'),
      text: doc.querySelector('.tag-content')?.textContent ?? '',
      embedded: doc.body.classList.contains('embedded'),
    }
  })
}

async function previewText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator(PREVIEW).evaluate((el) => (el as HTMLIFrameElement).contentDocument?.body?.textContent ?? '')
}

interface DesignPreviewLayout {
  widthMm: number
  heightMm: number
  text: string
  fieldCount: number
  fieldsInside: boolean
  anyFieldOverlapsQr: boolean
  qrInside: boolean
  qrSvgCount: number
}

/** Geometry of the reference-style renderer used by every label preset. */
async function designPreviewLayout(page: import('@playwright/test').Page): Promise<DesignPreviewLayout | null> {
  return page.locator(PREVIEW).evaluate((el) => {
    const doc = (el as HTMLIFrameElement).contentDocument
    const label = doc?.querySelector('.lbl')
    const qr = label?.querySelector('.qr')
    if (!doc || !label || !qr) return null

    const pxToMm = (px: number): number => px / (96 / 25.4)
    const bounds = (node: Element) => {
      const b = node.getBoundingClientRect()
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }
    }
    const labelBox = bounds(label)
    const qrBox = bounds(qr)
    // A sub-pixel slack absorbs border rounding and iframe scaling; real
    // clipping or overlap is far larger than this.
    const eps = 1.5
    const inside = (b: typeof labelBox): boolean =>
      b.left >= labelBox.left - eps &&
      b.right <= labelBox.right + eps &&
      b.top >= labelBox.top - eps &&
      b.bottom <= labelBox.bottom + eps
    const overlaps = (a: typeof labelBox, b: typeof labelBox): boolean =>
      a.left < b.right - eps &&
      a.right > b.left + eps &&
      a.top < b.bottom - eps &&
      a.bottom > b.top + eps

    const fields = Array.from(label.children).filter((node) => node !== qr)
    return {
      widthMm: +pxToMm(labelBox.right - labelBox.left).toFixed(2),
      heightMm: +pxToMm(labelBox.bottom - labelBox.top).toFixed(2),
      text: fields
        .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' '),
      fieldCount: fields.length,
      fieldsInside: fields.every((node) => inside(bounds(node))),
      anyFieldOverlapsQr: fields.some((node) => overlaps(bounds(node), qrBox)),
      qrInside: inside(qrBox),
      qrSvgCount: qr.querySelectorAll('svg').length,
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

test('Net weight toggle shows and hides grams on the Normal label preview', async ({ page, request }) => {
  const { cleanup } = await seedProducts(await csrfApi(request), { prefix: 'E2E-LBL-WT', count: 1 })
  seededCleanup = cleanup
  await page.setViewportSize({ width: 1650, height: 900 })
  await page.goto('/inventory/barcode')

  // The designer opens on the reference "Normal label" template.
  await page.locator('.divide-y > div').first().click()
  const toggle = page.getByText('Net weight', { exact: true }).locator('..').getByRole('switch')
  if (!(await toggle.isChecked())) await toggle.click()

  // Seeded products are weight-based (netWeight: 10), so the reference chip
  // prints clean grams — never a raw floating-point value.
  await expect.poll(() => previewText(page), { timeout: 15000 }).toContain('Wt: 10g')
  const layout = await page.locator(PREVIEW).evaluate((el) => {
    const doc = (el as HTMLIFrameElement).contentDocument
    if (!doc) return null
    const weight = [...doc.querySelectorAll('div')].find((d) => d.textContent?.startsWith('Wt:'))
    const qr = doc.querySelector('.qr')
    const label = doc.querySelector('.lbl')
    if (!weight || !qr || !label) return null
    const w = weight.getBoundingClientRect()
    const q = qr.getBoundingClientRect()
    const l = label.getBoundingClientRect()
    return {
      inside: w.left >= l.left && w.right <= l.right && w.top >= l.top && w.bottom <= l.bottom,
      beforeQr: w.right <= q.left + 1,
    }
  })
  expect(layout).toEqual({ inside: true, beforeQr: true })

  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect.poll(() => previewText(page)).not.toContain('Wt:')

  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect.poll(() => previewText(page)).toContain('Wt: 10g')

  // Jewellery Tag keeps its own grams row and its existing "10 g" format.
  await page.getByRole('button', { name: /Jewellery Tag/ }).click()
  await expect.poll(() => previewText(page), { timeout: 15000 }).toContain('10 g')
})

test('post-compact presets keep every field and the QR inside the label', async ({ page, request }) => {
  const prefix = 'QP'
  const { cleanup } = await seedProducts(await csrfApi(request), { prefix, count: 1 })
  seededCleanup = cleanup
  await page.setViewportSize({ width: 1650, height: 900 })
  await page.goto('/inventory/barcode')

  await page.locator('.divide-y > div').first().click()
  const presetSelect = page.locator('select').first()

  for (const preset of POST_COMPACT_PRESETS) {
    // The UI receives the full preset list from the backend; wait for each
    // option instead of relying on the six-entry offline fallback.
    await expect(presetSelect.locator(`option[value="${preset.key}"]`)).toHaveCount(1)
    await presetSelect.selectOption(preset.key)

    await expect
      .poll(
        async () => {
          const layout = await designPreviewLayout(page)
          return (
            !!layout &&
            Math.abs(layout.widthMm - preset.widthMm) < 0.6 &&
            Math.abs(layout.heightMm - preset.heightMm) < 0.6 &&
            layout.qrSvgCount === 1
          )
        },
        { timeout: 15000 },
      )
      .toBe(true)

    const layout = await designPreviewLayout(page)
    expect(layout, `${preset.key} preview geometry`).not.toBeNull()
    const box = layout!
    for (const text of [
      'OPAL LINE',
      `${prefix} PRODUCT 1`,
      'Rate: 1000.00/-',
      `Code: ${prefix}-1`,
      'Rings',
      'Wt: 10g',
    ]) {
      expect(box.text, `${preset.key} renders ${text}`).toContain(text)
    }
    expect(box.fieldCount, `${preset.key} field count`).toBe(6)
    expect(box.fieldsInside, `${preset.key} fields inside the label`).toBe(true)
    expect(box.anyFieldOverlapsQr, `${preset.key} fields clear of the QR`).toBe(false)
    expect(box.qrInside, `${preset.key} QR inside the label`).toBe(true)
  }
})

test('preview stays compact and visible at the top when the product list is tall', async ({ page, request }) => {
  const { cleanup } = await seedProducts(await csrfApi(request), { prefix: 'E2E-LBL-LAYOUT', count: 12 })
  seededCleanup = cleanup
  await page.setViewportSize({ width: 1650, height: 900 })
  await page.goto('/inventory/barcode')

  await expect(page.locator(PREVIEW)).toBeVisible()
  await expect.poll(() => previewText(page), { timeout: 15000 }).not.toBe('')

  const layout = await page.locator(PREVIEW).evaluate((el) => {
    const iframe = el as HTMLIFrameElement
    const doc = iframe.contentDocument
    const label = doc?.querySelector('.lbl')
    if (!doc || !label) return null

    let panel: HTMLElement | null = null
    for (let parent = iframe.parentElement; parent; parent = parent.parentElement) {
      if (parent.classList.contains('rounded-xl')) {
        panel = parent
        break
      }
    }
    if (!panel) return null

    const frame = iframe.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const labelDoc = label.getBoundingClientRect()
    // The iframe is CSS-scaled; map its internal coordinates back to the page.
    const scaleX = frame.width / doc.documentElement.clientWidth
    const scaleY = frame.height / doc.documentElement.clientHeight
    return {
      viewportHeight: window.innerHeight,
      panelTop: panelRect.top,
      panelHeight: panelRect.height,
      position: getComputedStyle(panel).position,
      labelTop: frame.top + labelDoc.top * scaleY,
      labelBottom: frame.top + labelDoc.bottom * scaleY,
      labelLeft: frame.left + labelDoc.left * scaleX,
      labelRight: frame.left + labelDoc.right * scaleX,
      panelLeft: panelRect.left,
      panelRight: panelRect.right,
    }
  })
  expect(layout).not.toBeNull()
  const box = layout!
  expect(box.position).toBe('sticky')
  expect(box.panelHeight).toBeLessThan(650)
  expect(box.panelTop).toBeLessThan(275)
  expect(box.labelTop).toBeGreaterThanOrEqual(box.panelTop - 1)
  expect(box.labelTop - box.panelTop).toBeLessThan(200)
  expect(box.labelTop).toBeLessThan(box.viewportHeight / 2)
  expect(box.labelBottom).toBeLessThan(box.viewportHeight)
  expect(box.labelLeft).toBeGreaterThanOrEqual(box.panelLeft - 1)
  expect(box.labelRight).toBeLessThanOrEqual(box.panelRight + 1)

  // Narrow layouts still stack without clipping the preview horizontally.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator(PREVIEW)).toBeVisible()
  const mobile = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  expect(mobile.scrollWidth).toBeLessThanOrEqual(mobile.innerWidth + 1)
})
