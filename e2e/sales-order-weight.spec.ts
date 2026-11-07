import { expect, request, test, type Locator, type Page } from '@playwright/test'

/**
 * Sales Orders — quantity → weight calculation, persistence through save and
 * re-edit, and the Edit Customer Details modal (scenario list from the
 * Sales Orders enhancement spec).
 *
 * Grounded in the real UI/API mechanics:
 * - The product/customer pickers are SearchableSelect menus whose options are
 *   plain buttons inside a Radix `menu` — the menu's accessible name is the
 *   closed trigger's text ("Select product" / "Select customer"), and its
 *   search box filters on the option label or keyword (the product's SKU).
 * - Each order line's weight is created through the API with a known
 *   weight-per-piece so every assertion below is exact.
 * - Locally saved orders get an ERP-native `MO-…` reference (no `#` prefix),
 *   so their edit dialog offers plain "Save Changes" (no Shopify push).
 *
 * Grams round to 3 dp everywhere (mirrors roundWeight in SalesOrders.tsx and
 * the backend's milligram rounding).
 */
const g = (n: number) => String(Math.round(n * 1000) / 1000)

/** The one weight-per-piece value every fixture product carries. */
const WEIGHT_PER_PIECE = 10

/**
 * Authenticated, CSRF-carrying API client for fixtures/cleanup
 * (same pattern as invoice-and-products.spec.ts).
 */
async function api() {
  const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:47195'
  const ctx = await request.newContext({ baseURL, storageState: 'e2e/.auth/state.json' })
  const { csrfToken } = (await (await ctx.get('/api/v1/csrf-token')).json()) as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  return {
    get: (path: string) => ctx.get(path),
    post: (path: string, data: unknown) => ctx.post(path, { headers, data }),
    del: (path: string) => ctx.delete(path, { headers }),
    dispose: () => ctx.dispose(),
  }
}

type ApiClient = Awaited<ReturnType<typeof api>>

/** Create a catalogue product with a configured weight and plenty of stock. */
async function createWeightedProduct(apiClient: ApiClient, stamp: number) {
  const sku = `E2E-WT-${stamp}`
  const resp = await apiClient.post('/api/v1/db/products', {
    name: `E2E Weighted Ring ${stamp}`,
    sku,
    category: 'Rings',
    status: 'active',
    netWeight: WEIGHT_PER_PIECE,
    makingCharge: 20,
    sellingPrice: 1000,
    stock: 100, // → an 'opening' ledger movement rolls the parent stock up to 100
  })
  expect(resp.status(), `product fixture: ${await resp.text()}`).toBe(201)
  const row = (await resp.json()) as { id: string; sku: string }
  return { id: row.id, sku: row.sku, netWeight: WEIGHT_PER_PIECE }
}

/** Open a SearchableSelect and choose the option the query filters down to. */
async function pickOption(dialog: Locator, page: Page, triggerName: string, query: string) {
  await dialog.getByRole('button', { name: triggerName }).click()
  // A DropdownMenuContent is role="menu"; its options are plain buttons and
  // the search box is its single textbox.
  const menu = page.getByRole('menu', { name: triggerName })
  await menu.getByRole('textbox').fill(query)
  // fill() resolves in the few-millisecond window before React re-renders the
  // filtered list — awaiting the matching option first makes the pick race-free.
  const option = menu.getByRole('button').filter({ hasText: query })
  await expect(option).toHaveCount(1)
  await option.click()
}

test.describe('sales order weight & customer editing', () => {
  test('quantity changes recalculate total weight; manual weight holds until qty/weight per piece changes', async ({ page }) => {
    test.setTimeout(90_000)
    const stamp = Date.now()
    const apiClient = await api()
    const product = await createWeightedProduct(apiClient, stamp)

    try {
      await page.goto('/sales/orders')
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })

      await page.getByRole('button', { name: 'Manual Order' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('Customer Details')).toBeVisible({ timeout: 10000 })
      await expect(dialog.getByText('Product Details')).toBeVisible()
      await expect(dialog.getByText('Weight & Pricing')).toBeVisible()

      // Weight per piece must come from the product record, never a constant.
      await pickOption(dialog, page, 'Select product', product.sku)

      const qty = dialog.getByLabel('Qty for line 1')
      const wpp = dialog.getByLabel(/Weight per piece for line 1/)
      const total = dialog.getByLabel(/Total weight for line 1/)
      await expect(qty).toHaveValue('1')
      // 1 × 10 g = 10 g — the spec's example table:
      await expect(wpp).toHaveValue(g(product.netWeight))
      await expect(total).toHaveValue(g(product.netWeight))

      // Quantity up → total weight up (5 × 10 = 50 g).
      await qty.fill('5')
      await expect(total).toHaveValue(g(product.netWeight * 5))
      // Quantity down → total weight down (2 × 10 = 20 g).
      await qty.fill('2')
      await expect(total).toHaveValue(g(product.netWeight * 2))

      // Manual total-weight edit is kept…
      await total.fill('77.7')
      await expect(total).toHaveValue('77.7')
      // …until the weight per piece changes (the documented rule re-applies
      // Total = Qty × Weight Per Piece).
      await wpp.fill('25')
      await expect(total).toHaveValue('50')
      // …and a quantity change recalculates too (5 × 25 = 125 g).
      await qty.fill('5')
      await expect(total).toHaveValue('125')

      // The section footer shows the calculated total before saving.
      await expect(dialog.getByText(/Total weight:/)).toContainText('125 g')

    // Cancel closes the dialog directly — the "Discard changes?" prompt is
    // reserved for Esc, × and click-outside (see AppDialog.shouldConfirmDiscard).
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10000 })
    } finally {
      await apiClient.del(`/api/v1/db/products/${product.id}`)
      await apiClient.dispose()
    }
  })

  test('edited customer details and weight persist through save and re-edit', async ({ page }) => {
    test.setTimeout(180_000)
    const stamp = Date.now()
    const custName = `E2E Wt Cust ${stamp}`
    const editedEmail = `edited.${stamp}@example.com`
    const editedPhone = '+91 98765 43210'
    const apiClient = await api()

    // Fixture: a customer to edit (must be updated in place — no duplicates).
    const custResp = await apiClient.post('/api/v1/db/customers', {
      name: custName,
      email: `wt.${stamp}@example.com`,
      phone: '9000000000',
      city: 'Pune',
      province: 'MH',
      status: 'active',
      joined: '2026-01-01',
    })
    expect(custResp.status(), `customer fixture: ${await custResp.text()}`).toBe(201)
    const customer = (await custResp.json()) as { id: string }
    const product = await createWeightedProduct(apiClient, stamp)

    try {
      await page.goto('/sales/orders')
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })
      await page.getByRole('button', { name: 'Manual Order' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('Customer Details')).toBeVisible({ timeout: 10000 })

      // Pick the fixture customer, then edit their details in place.
      await pickOption(dialog, page, 'Select customer', custName)
      await dialog.getByRole('button', { name: /Edit Customer Details/ }).click()

      const modal = page.getByRole('dialog').last()
      await expect(modal.getByText('Edit Customer Details')).toBeVisible({ timeout: 10000 })

      // Validation: a malformed email is rejected before anything saves.
      await modal.getByLabel('Email').fill('not-an-email')
      await modal.getByRole('button', { name: 'Save Changes' }).click()
      await expect(modal.getByText('Enter a valid email address')).toBeVisible()

      await modal.getByLabel('Email').fill(editedEmail)
      await modal.getByLabel('Phone').fill(editedPhone)
      await modal.getByPlaceholder('Street address, P.O. box').fill('101 Marine Drive')
      await modal.getByPlaceholder('City').fill('Mumbai')
      await modal.getByPlaceholder('PIN code').fill('400001')
      await modal.getByRole('button', { name: 'Save Changes' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(1, { timeout: 10000 }) // modal closed

      // The existing customer record was updated — no duplicate created.
      const custs = ((await (await apiClient.get('/api/v1/db/customers?limit=200')).json()) as {
        data: Array<{ id: string; name: string; email: string; phone: string; city: string }>
      }).data
      const sameName = custs.filter((c) => c.name === custName)
      expect(sameName, 'editing must not create a duplicate customer').toHaveLength(1)
      expect(sameName[0].id).toBe(customer.id)
      expect(sameName[0].phone).toBe(editedPhone)
      expect(sameName[0].email).toBe(editedEmail)
      expect(sameName[0].city).toBe('Mumbai')

      // Product + quantity: total weight = qty × the product's weight per piece.
      await pickOption(dialog, page, 'Select product', product.sku)

      const wpp = dialog.getByLabel(/Weight per piece for line 1/)
      const total = dialog.getByLabel(/Total weight for line 1/)
      await expect(wpp).toHaveValue(g(product.netWeight))
      await dialog.getByLabel('Qty for line 1').fill('2')
      await expect(total).toHaveValue(g(2 * product.netWeight))

      // Save locally — no Shopify store is configured in e2e.
      const syncSwitch = dialog.getByRole('switch').last()
      if ((await syncSwitch.getAttribute('aria-checked')) === 'true') await syncSwitch.click()
      await expect(syncSwitch).toHaveAttribute('aria-checked', 'false')
      await dialog.getByRole('button', { name: 'Create Order' }).click()
      await expect(page.getByText('Order created successfully')).toBeVisible({ timeout: 30000 })
      await dialog.getByRole('button', { name: 'Done' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10000 })

      // Persisted: weight snapshot + edited customer details on the order.
      const findOrder = async () => {
        const orders = ((await (await apiClient.get('/api/v1/db/sales-orders?limit=200')).json()) as {
          data: Array<Record<string, any>>
        }).data
        return orders.find((o) => o.customer === custName && !o.isBooking)
      }
      const created = await findOrder()
      expect(created, 'the manual order must exist in the API').toBeTruthy()
      expect(created!.lineItems[0].netWeight).toBe(product.netWeight)
      expect(created!.lineItems[0].weight).toBe(Number(g(2 * product.netWeight)))
      expect(created!.customerEmail).toBe(editedEmail)
      expect(created!.customerPhone).toBe(editedPhone)
      expect(created!.billingAddress?.address1).toBe('101 Marine Drive')
      expect(created!.billingAddress?.city).toBe('Mumbai')
      expect(created!.billingAddress?.zip).toBe('400001')

      // Re-edit: quantity 5 → total weight 5 × weight per piece, then persist.
      const row = page.locator('table tbody tr', { hasText: custName })
      await expect(row).toHaveCount(1, { timeout: 20000 })
      await row.first().getByRole('button', { name: /Edit order/ }).click()
      const editDialog = page.getByRole('dialog')
      await expect(editDialog.getByText(/Edit Order/)).toBeVisible({ timeout: 10000 })
      await expect(editDialog.getByLabel('Qty for line 1')).toHaveValue('2')
      await expect(editDialog.getByLabel(/Total weight for line 1/)).toHaveValue(g(2 * product.netWeight))

      await editDialog.getByLabel('Qty for line 1').fill('5')
      await expect(editDialog.getByLabel(/Total weight for line 1/)).toHaveValue(g(5 * product.netWeight))
      await editDialog.getByRole('button', { name: 'Save Changes' }).click()
      await expect(page.getByText('Order updated successfully')).toBeVisible({ timeout: 30000 })
      await editDialog.getByRole('button', { name: 'Done' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10000 })

      const updated = await findOrder()
      expect(updated!.lineItems[0].weight).toBe(Number(g(5 * product.netWeight)))
      expect(updated!.lineItems[0].netWeight).toBe(product.netWeight)
      expect(updated!.billingAddress?.city).toBe('Mumbai')
      expect(Number(updated!.value)).toBeGreaterThan(0)
    } finally {
      // Cleanup must never mask the real assertion.
      try {
        const orders = ((await (await apiClient.get('/api/v1/db/sales-orders?limit=200')).json()) as {
          data: Array<{ id: string; customer: string }>
        }).data
        for (const o of orders.filter((x) => x.customer === custName)) {
          await apiClient.del(`/api/v1/db/sales-orders/${o.id}`)
        }
        await apiClient.del(`/api/v1/db/customers/${customer.id}`)
      } catch { /* nothing to clean up */ }
      // The fixture product goes last (deleting it also retires its stock), so
      // no stock adjustment is needed after the sale.
      await apiClient.del(`/api/v1/db/products/${product.id}`)
      await apiClient.dispose()
    }
  })
})
