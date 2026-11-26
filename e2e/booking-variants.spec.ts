import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * Bookings → PRODUCTS & VARIANTS: the picker must offer a variant as its own
 * row, price it by the product's pricing mode, show ITS store stock and save
 * the variant relationship onto the booking.
 *
 * The fixture is a Piece Rate product (₹2,000/pc) with a red variant carrying
 * a durable ₹200 "Add to price" (effective ₹2,200), created through the API
 * here so the test runs on a fresh install — never against a developer's
 * catalogue. Everything it creates is removed again.
 */

async function csrfHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.get('/api/v1/csrf-token')
  if (!res.ok()) return {}
  const body = (await res.json()) as { csrfToken?: string }
  return body.csrfToken ? { 'X-CSRF-Token': body.csrfToken } : {}
}

test('a variant SKU is searchable, priced by its mode and saved with its variant', async ({ page, request }) => {
  test.setTimeout(120_000)
  const stamp = Date.now()
  const name = `E2E Booking Toy ${stamp}`
  const sku = `E2E-BKV-${stamp}`
  const redSku = `${sku}-RED`
  const customer = `E2E Booking ${stamp}`
  const headers = await csrfHeaders(request)
  let productId = ''

  try {
    // ── Fixture: a Piece Rate product whose variants are selectable rows. ──
    const created = await request.post('/api/v1/db/products', {
      headers,
      data: {
        name,
        sku,
        category: 'Silver Jewels',
        sellingPrice: 2000,
        pieceRateProduct: true,
        fixedPieceRate: 2000,
        netWeight: 200,
        makingCharge: 20,
        gst: 3,
        hsn: '71131130',
        purity: 92.5,
        grossWeight: 0,
        stoneWeight: 0,
        supplier: '',
        silverRate: 0,
        stock: 0,
        status: 'active',
        shopifyStatus: 'not-listed',
        createdAt: new Date().toISOString(),
      },
    })
    expect(created.status(), `create fixture product: ${await created.text()}`).toBe(201)
    productId = ((await created.json()) as { id: string }).id

    const variants = await request.put(`/api/v1/db/products/${productId}/variants`, {
      headers,
      data: {
        options: [{ name: 'color', values: ['red', 'white'] }],
        variants: [
          // Red's selling_price is the EFFECTIVE ₹2,200; the add-on itself
          // lives in priceAdjustment. White has no add-on.
          { title: 'red', optionValues: ['red'], sku: redSku, sellingPrice: 2200, priceAdjustment: 200, stock: 0 },
          { title: 'white', optionValues: ['white'], sku: `${sku}-WHI`, sellingPrice: 2000, priceAdjustment: 0, stock: 0 },
        ],
      },
    })
    expect(variants.status(), `create fixture variants: ${await variants.text()}`).toBe(200)

    await page.goto('/sales/bookings')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })
    await page.getByRole('button', { name: 'New Booking' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 10000 })

    // Walk-in customer. The picker's input lives in a Radix portal OUTSIDE
    // the dialog node, so it is addressed at page scope.
    await dialog.getByRole('button', { name: 'Search or type a name…' }).click()
    await page.getByLabel('Search customers').fill(customer)
    await page.keyboard.press('Escape')
    await expect(page.getByLabel('Search customers'), 'the customer menu must close before the next control').toHaveCount(0)

    // ── 1. The variant code is its own searchable row. ──────────────────────
    await dialog.getByRole('button', { name: 'Select product' }).click()
    await page.getByPlaceholder('Search name, SKU or variant…').fill(redSku)
    const option = page.getByRole('button', { name: new RegExp(`${name} - red \\(${redSku}\\)`) })
    await expect(option, 'typing the variant SKU must surface its row').toBeVisible({ timeout: 10000 })
    await option.click()

    // ── 2. The line carries the variant identity and its pricing mode: a
    //    Piece Rate product opens at the fixed ₹/pc PLUS the variant's
    //    GST-inclusive add-on (₹2,000 + ₹200 = ₹2,200), never at
    //    200 g × (silver rate + making). Inventory prices are per-unit and
    //    already include the add-on — the server must not add it again. ────
    await expect(dialog.getByLabel('Price per unit for line 1 (incl. GST)')).toHaveValue('2200')
    await expect(dialog.locator('span.font-mono', { hasText: redSku })).toBeVisible()

    // ── 3. Stock for THIS variant, per store (bookings never deduct). ───────
    await expect(dialog.getByText('Required: 1')).toBeVisible({ timeout: 15000 })
    await expect(dialog.getByText('Add-on ₹200', { exact: false })).toBeVisible({ timeout: 15000 })
    await expect(dialog.getByText(/available/).first()).toBeVisible({ timeout: 15000 })

    // ── 4. Save. ────────────────────────────────────────────────────────────
    await dialog.getByRole('button', { name: 'Create booking' }).click()
    await expect(dialog).toHaveCount(0, { timeout: 20000 })

    // ── 5. The list shows the variant name AND its SKU. ────────────────────
    await page.getByPlaceholder('Search booking number, customer, invoice…').fill(customer)
    const row = page.locator('table tbody tr', { hasText: customer })
    await expect(row).toHaveCount(1, { timeout: 15000 })
    await expect(row).toContainText(`${name} — red`)
    await expect(row).toContainText(redSku)

    // ── 6. What actually got stored. ────────────────────────────────────────
    const list = await (await request.get('/api/v1/db/sales-orders?limit=200')).json()
    const saved = (list.data as Array<{ id: string; customer: string; lineItems?: Array<Record<string, unknown>> }>)
      .find((o) => o.customer === customer)
    expect(saved, 'the booking must be retrievable from the API').toBeTruthy()
    const line = saved!.lineItems?.[0] as {
      sku?: string; variantId?: string; productId?: string; price?: number; priceAdjustment?: number
    }
    expect(line.sku).toBe(redSku)
    expect(line.variantId, 'the stored line must carry variant_id').toBeTruthy()
    expect(line.productId).toBeTruthy()
    expect(Number(line.priceAdjustment)).toBe(200, 'the durable add-on is snapshotted on the booking line')
    expect(Number(line.price)).toBe(2200, 'per-unit price already includes the add-on')
  } finally {
    // Bookings first (they name the product), then the fixture itself.
    const list = await (await request.get('/api/v1/db/sales-orders?limit=200')).json()
    const doomed = (list.data as Array<{ id: string; customer: string }>).filter((o) => o.customer === customer)
    for (const o of doomed) await request.delete(`/api/v1/db/sales-orders/${o.id}`, { headers })

    const products = await (await request.get('/api/v1/db/products?limit=200')).json()
    const fixtures = (products.data as Array<{ id: string; sku: string }>).filter((p) => p.sku === sku)
    for (const p of fixtures) await request.delete(`/api/v1/db/products/${p.id}`, { headers })
    if (productId && !fixtures.some((p) => p.id === productId)) {
      await request.delete(`/api/v1/db/products/${productId}`, { headers })
    }
  }
})
