import { expect, request, test, type Locator, type Page } from '@playwright/test'

/**
 * Sales Invoices (New Sales Invoice) and Sales Orders (Create Manual Order)
 * on the shared `lib/sellableItems` helper:
 *
 *  - a variant is its OWN row: typing `…-RED` selects `silver toy - red (…-RED)`;
 *  - a Piece Rate product prices from its fixed ₹/pc (₹2,000), never from
 *    `net wt × (silver rate + making)`;
 *  - stock is validated and deducted against the VARIANT (red has 4 while the
 *    parent holds 6 — an over-quantity of 5 must be refused);
 *  - the saved line carries productId/variantId/the variant SKU, and the
 *    invoice shows the variant name + SKU on its detail page.
 *
 * The fixture is created through the API (a Piece Rate product with red/white
 * variants and per-variant stock) so the spec runs on a fresh install and
 * removes everything it made.
 */

/** Authenticated, CSRF-carrying API client for fixtures/cleanup. */
async function api() {
  const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:47195'
  const ctx = await request.newContext({ baseURL, storageState: 'e2e/.auth/state.json' })
  const { csrfToken } = (await (await ctx.get('/api/v1/csrf-token')).json()) as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  return {
    get: (path: string) => ctx.get(path),
    post: (path: string, data: unknown) => ctx.post(path, { headers, data }),
    put: (path: string, data: unknown) => ctx.put(path, { headers, data }),
    del: (path: string) => ctx.delete(path, { headers }),
    dispose: () => ctx.dispose(),
  }
}

type ApiClient = Awaited<ReturnType<typeof api>>

interface ToyFixture {
  id: string
  name: string
  sku: string
  redSku: string
  whiteSku: string
}

/** A Piece Rate product (₹2,000/pc) with red/white variants holding stock. */
async function createVariantToy(apiClient: ApiClient, stamp: number): Promise<ToyFixture> {
  const sku = `E2E-SV-${stamp}`
  const name = `E2E Sellable Toy ${stamp}`
  const created = await apiClient.post('/api/v1/db/products', {
    name,
    sku,
    category: 'Silver Jewels',
    status: 'active',
    shopifyStatus: 'not-listed',
    // Piece Rate: sellingPrice/fixedPieceRate are the ₹2,000 the pickers fill
    // in; netWeight exists so a weight-based mis-price would be obvious.
    pieceRateProduct: true,
    fixedPieceRate: 2000,
    sellingPrice: 2000,
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
    createdAt: new Date().toISOString(),
  })
  expect(created.status(), `product fixture: ${await created.text()}`).toBe(201)
  const product = (await created.json()) as { id: string }

  // Per-variant stock: red 4, white 2 (parent rollup becomes 6).
  const variants = await apiClient.put(`/api/v1/db/products/${product.id}/variants`, {
    options: [{ name: 'color', values: ['red', 'white'] }],
    variants: [
      { title: 'red', optionValues: ['red'], sku: `${sku}-RED`, stock: 4 },
      { title: 'white', optionValues: ['white'], sku: `${sku}-WHI`, stock: 2 },
    ],
  })
  expect(variants.status(), `variant fixture: ${await variants.text()}`).toBe(200)

  return { id: product.id, name, sku, redSku: `${sku}-RED`, whiteSku: `${sku}-WHI` }
}

/** Current stock per SKU for the fixture's variants (the API's own view). */
async function variantStocks(apiClient: ApiClient, productId: string): Promise<Map<string, number>> {
  const res = await apiClient.get(`/api/v1/db/products/${productId}/variants`)
  const body = (await res.json()) as { variants: Array<{ sku: string; stock: number }> }
  return new Map((body.variants ?? []).map((v) => [v.sku, Number(v.stock)]))
}

/** Open a SearchableSelect and choose the option the query filters down to. */
async function pickOption(dialog: Locator, page: Page, triggerName: string, query: string) {
  await dialog.getByRole('button', { name: triggerName }).click()
  const menu = page.getByRole('menu', { name: triggerName })
  await menu.getByRole('textbox').fill(query)
  const option = menu.getByRole('button').filter({ hasText: query })
  await expect(option).toHaveCount(1)
  await option.click()
}

test.describe('sellable variants on invoices and manual orders', () => {
  test('New Sales Invoice picks a variant, bills its fixed price and deducts its stock', async ({ page }) => {
    test.setTimeout(120_000)
    const stamp = Date.now()
    const customer = `E2E SV Invoice ${stamp}`
    const apiClient = await api()
    const toy = await createVariantToy(apiClient, stamp)

    try {
      await page.goto('/sales/invoices')
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })
      await page.getByRole('button', { name: /New Invoice/ }).click()

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 10000 })

      // Walk-in customer (the picker's menu is portalled outside the dialog).
      await dialog.locator('label', { hasText: 'Customer *' }).getByRole('button').click()
      await page.getByRole('textbox', { name: 'Search customers' }).fill(customer)
      await page.keyboard.press('Escape')

      // ── 1. The variant code resolves to its own row. ──────────────────────
      const escapeRegExp = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      await dialog.getByLabel('Search products').fill(toy.redSku)
      const option = page.getByRole('button', {
        name: new RegExp(escapeRegExp(`${toy.name} - red (${toy.redSku})`)),
      })
      await expect(option, 'the variant must be its own selectable row').toBeVisible({ timeout: 10000 })
      await option.click()
      await expect(dialog.getByLabel('Search products')).toHaveValue(`${toy.name} - red (${toy.redSku})`)

      // ── 2. Pricing mode: Piece Rate, so no weight/rate maths. ─────────────
      await expect(dialog.getByText('₹2000 / pc')).toBeVisible()
      await expect(dialog.getByLabel('Net weight per piece for line 1 (g)')).toBeDisabled()
      await expect(dialog.getByLabel('Making charge for line 1 (₹/g)')).toBeDisabled()
      // Amount cell = qty × fixed (title says so), and GST rides on top:
      // 1 × ₹2,000 → subtotal ₹2,000 → grand total ₹2,060. formatCurrency
      // drops decimals for whole amounts, hence "₹2,000" and not "₹2,000.00".
      await expect(dialog.locator('td[title*="fixed piece rate"]')).toHaveText('₹2,000')
      await expect(dialog.getByText('₹2,060')).toBeVisible()

      // ── 3. Save. ──────────────────────────────────────────────────────────
      await dialog.getByRole('button', { name: /Create invoice/ }).click()
      await expect(page.getByText('New Sales Invoice')).toHaveCount(0, { timeout: 20000 })
      // A read-only preview of the new invoice opens on top; dismiss it.
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 5000 })

      // ── 4. What got stored: the variant, its SKU and the fixed amount. ────
      const list = (await (await apiClient.get('/api/v1/db/invoices/with-items?limit=200')).json()) as {
        data: Array<{ id: string; customer: string; grandTotal: number; items?: Array<Record<string, unknown>> }>
      }
      const saved = list.data.find((r) => r.customer === customer)
      expect(saved, 'the invoice must exist in the API').toBeTruthy()
      expect(saved!.grandTotal).toBe(2060, '1 × ₹2,000 + 3% GST')
      const line = saved!.items?.[0] as { sku?: string; variantId?: string; amount?: number; product?: string }
      expect(line.sku).toBe(toy.redSku, 'the line carries the VARIANT sku')
      expect(line.variantId, 'sales_invoice_items.variant_id must be persisted').toBeTruthy()
      expect(Number(line.amount)).toBe(2000, 'the fixed piece rate, not weight × (rate + making)')
      expect(String(line.product)).toContain('red', 'the variant name reaches the stored line')

      // ── 5. Stock moved from the VARIANT, not the parent total. ────────────
      const stocks = await variantStocks(apiClient, toy.id)
      expect(stocks.get(toy.redSku)).toBe(3, 'red: 4 − 1')
      expect(stocks.get(toy.whiteSku)).toBe(2, 'white untouched')
      const parent = (await (await apiClient.get(`/api/v1/db/products/${toy.id}`)).json()) as { stock: number }
      expect(Number(parent.stock)).toBe(5, 'the parent rollup is re-derived as Σ variant stock')

      // ── 6. The detail view names the variant and its code. ────────────────
      await page.goto(`/sales/invoices/${saved!.id}`)
      await expect(page.getByText(`${toy.name} - red`, { exact: false }).first()).toBeVisible({ timeout: 20000 })
      await expect(page.getByText(toy.redSku, { exact: false }).first()).toBeVisible()
    } finally {
      // The invoice first (it restores what it took), then the fixture.
      try {
        const list = (await (await apiClient.get('/api/v1/db/invoices/with-items?limit=200')).json()) as {
          data: Array<{ id: string; customer: string }>
        }
        for (const inv of list.data.filter((r) => r.customer === customer)) {
          await apiClient.del(`/api/v1/db/invoices/${inv.id}`)
        }
      } catch { /* nothing to clean up */ }
      await apiClient.del(`/api/v1/db/products/${toy.id}`)
      await apiClient.dispose()
    }
  })

  test('Create Manual Order selects and scans variants, prices them and checks variant stock', async ({ page }) => {
    test.setTimeout(120_000)
    const stamp = Date.now()
    const customer = `E2E SV Order ${stamp}`
    const apiClient = await api()
    const toy = await createVariantToy(apiClient, stamp)

    try {
      await page.goto('/sales/orders')
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })
      await page.getByRole('button', { name: 'Manual Order' }).click()

      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('Product Details')).toBeVisible({ timeout: 10000 })

      // The fixture's stock sits at the DEFAULT store (that is where a count
      // correction lands it); the form defaults to whatever the locations list
      // returns first, so pin the store the deduction must leave from.
      const locs = (await (await apiClient.get('/api/v1/db/inventory/locations?limit=200')).json()) as {
        data: Array<{ id: string; name: string }>
      }
      const store = locs.data.find((l) => l.id === 'LOC-DEFAULT') ?? locs.data[0]
      expect(store, 'the store list must offer a store to ring up at').toBeTruthy()
      const storeSelect = dialog.getByLabel('Rung up at')
      // The options render once the page's location fetch lands — wait for the
      // one we want rather than racing it.
      await expect(storeSelect.locator(`option[value="${store!.id}"]`)).toHaveCount(1, { timeout: 15000 })
      await storeSelect.selectOption(store!.id)

      // Walk-in customer.
      await pickOption(dialog, page, 'Select customer', 'New customer…')
      await dialog.getByPlaceholder('Customer name').fill(customer)

      // ── 1. The Product dropdown resolves the variant code. ────────────────
      await pickOption(dialog, page, 'Select product', toy.redSku)
      await expect(dialog.getByLabel('Unit price for line 1 (₹)')).toHaveValue('2000', 'Piece Rate price, not 200 g × (rate + making)')

      // ── 2. The scanner resolves the OTHER variant by its code. ────────────
      const scan = dialog.getByPlaceholder('Scan a label QR or type a SKU, then press Enter')
      await scan.fill(toy.whiteSku)
      await scan.press('Enter')
      const added = `${toy.name} — white`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      await expect(dialog.getByText(new RegExp(`Added ${added}`))).toBeVisible()
      await expect(dialog.getByLabel('Unit price for line 2 (₹)')).toHaveValue('2000')

      // ── 3. Stock is checked against the VARIANT (4), not the parent (6). ──
      const qty1 = dialog.getByLabel('Qty for line 1')
      await qty1.fill('5')
      await expect(dialog.getByText('Only 4 units available. You entered 5.')).toBeVisible()
      await qty1.fill('1')
      await expect(dialog.getByText('Only 4 units available. You entered 5.')).toHaveCount(0)

      // ── 4. Save WITHOUT the Shopify push (the fixture is local-only). ─────
      const sync = dialog.getByRole('switch').last()
      await expect(sync).toHaveAttribute('aria-checked', 'true')
      await sync.click()
      await expect(sync).toHaveAttribute('aria-checked', 'false')
      await dialog.getByRole('button', { name: 'Create Order' }).click()
      await expect(dialog.getByText('Order created successfully')).toBeVisible({ timeout: 20000 })
      await dialog.getByRole('button', { name: 'Done' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10000 })

      // ── 5. What got stored. ───────────────────────────────────────────────
      const list = (await (await apiClient.get('/api/v1/db/sales-orders?limit=200')).json()) as {
        data: Array<{
          id: string
          customer: string
          value: number
          lineItems?: Array<{ sku?: string; variantId?: string; productId?: string; price?: number }>
        }>
      }
      const saved = list.data.find((r) => r.customer === customer)
      expect(saved, 'the order must exist in the API').toBeTruthy()
      expect(saved!.lineItems?.length, 'both picked rows are lines').toBe(2)
      expect(saved!.lineItems?.[0]?.sku).toBe(toy.redSku)
      expect(saved!.lineItems?.[0]?.variantId, 'the line carries variant_id').toBeTruthy()
      expect(saved!.lineItems?.[0]?.productId, 'the line carries product_id').toBeTruthy()
      expect(Number(saved!.lineItems?.[0]?.price)).toBe(2000, 'the fixed piece rate as the unit price')
      expect(saved!.lineItems?.[1]?.sku).toBe(toy.whiteSku, 'the scanned variant landed as its own line')
      expect(Math.abs(Number(saved!.value) - 4000)).toBeLessThanOrEqual(0.02, '2 × ₹2,000')

      // ── 6. Both variants were deducted. ───────────────────────────────────
      const stocks = await variantStocks(apiClient, toy.id)
      expect(stocks.get(toy.redSku)).toBe(3, 'red: 4 − 1')
      expect(stocks.get(toy.whiteSku)).toBe(1, 'white: 2 − 1')
    } finally {
      try {
        const list = (await (await apiClient.get('/api/v1/db/sales-orders?limit=200')).json()) as {
          data: Array<{ id: string; customer: string }>
        }
        for (const order of list.data.filter((r) => r.customer === customer)) {
          await apiClient.del(`/api/v1/db/sales-orders/${order.id}`)
        }
      } catch { /* nothing to clean up */ }
      await apiClient.del(`/api/v1/db/products/${toy.id}`)
      await apiClient.dispose()
    }
  })
})
