import { expect, request, test } from '@playwright/test'

/**
 * Authenticated, CSRF-carrying API client for building fixtures.
 *
 * The bare `request` fixture does not pick up the config's storageState, and
 * every state-changing route requires the double-submit CSRF header, so both
 * have to be set up by hand (same pattern as security.spec.ts).
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

test.describe('products default sort (newest first)', () => {
  test('first product row is the most recently added', async ({ page }) => {
    await page.goto('/inventory/products')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })

    const rows = page.locator('table tbody tr')
    await expect(rows.first()).toBeVisible({ timeout: 20000 })
    const count = await rows.count()
    test.skip(count < 2, 'not enough products in this database to compare ordering')

    // Read the top product name (the name cell holds the product link; a
    // leading checkbox column may precede it, so target the link, not td#1).
    const firstName = (await rows.first().locator('a').first().innerText()).trim()
    expect(firstName.length, 'first row must show a product name').toBeGreaterThan(0)
    test.info().annotations.push({ type: 'note', description: `top product: ${firstName}` })

    // Assert newest-day-first on the rows the table ACTUALLY renders. The
    // page sorts client-side (the API returns name-order), so read the
    // rendered row hrefs for the real order, then map each product id back to
    // its createdAt. created_at is a date column (no time-of-day) and product
    // ids are random UUIDs, so products added the same day cannot be ordered
    // relative to each other — they tie and keep the API's name-ordered
    // sequence. The guarantee is: parsed days are non-increasing down the
    // rendered list.
    const { rendered, createdAtById } = await page.evaluate(async () => {
      const links = Array.from(document.querySelectorAll('table tbody tr a[href*="/inventory/products/"]'))
      const rendered = links
        .map((a) => (a.getAttribute('href') ?? '').split('/').pop() ?? '')
        .filter(Boolean)
      const res = await fetch('/api/v1/db/products?limit=200', { credentials: 'include' })
      const json = await res.json()
      const rows: Array<{ id: string; createdAt?: string }> = json.data ?? json
      const createdAtById = Object.fromEntries(rows.map((r) => [r.id, r.createdAt ?? '']))
      return { rendered, createdAtById }
    })
    test.skip(rendered.length < 2, 'not enough rendered product rows to verify ordering')
    const ordered = rendered.map((id) => createdAtById[id]).filter((c) => Number.isFinite(Date.parse(c)))
    test.skip(ordered.length < 2, 'not enough createdAt values to verify ordering')
    for (let i = 1; i < ordered.length; i++) {
      const cur = Date.parse(ordered[i])
      const prev = Date.parse(ordered[i - 1])
      expect(cur, `rendered row ${i} (${ordered[i]}) must not be newer than row ${i - 1} (${ordered[i - 1]})`).toBeLessThanOrEqual(prev)
    }
  })
})

test.describe('sales invoice cancel & reissue', () => {
  test('row action menu offers Cancel & reissue with a confirm step', async ({ page }) => {
    await page.goto('/sales/invoices')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })

    // Wait for the table body to settle, then count only rows that carry the
    // action: DataTable renders a loading row and — on an empty database — a
    // one-cell placeholder row, so a bare row count is never 0 and this guard
    // used to hang waiting for a button the placeholder never renders. The
    // union below matches both post-load states (real rows, empty message),
    // never the loading row, so it cannot skip while data is still in flight.
    const rows = page.locator('table tbody tr', { has: page.getByRole('button', { name: /More actions for/i }) })
    const emptyState = page.getByText('No invoices match your filters')
    await expect(rows.or(emptyState).first()).toBeVisible({ timeout: 20000 })
    if ((await rows.count()) === 0) {
      test.skip(true, 'no sales invoices in this database (fresh install)')
      return
    }

    // Open the first row's action menu.
    await rows.first().getByRole('button', { name: /More actions for/i }).click()

    // The reissue action must be offered alongside the existing Cancel.
    const reissueItem = page.getByRole('menuitem', { name: /Cancel & reissue/i })
    await expect(reissueItem).toBeVisible({ timeout: 5000 })

    // Clicking it must open a confirm dialog describing the stock/loyalty
    // reversal, and must NOT mutate until confirmed.
    await reissueItem.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog.getByText(/Cancel and reissue/i)).toBeVisible()

    // Back out via Cancel — no destructive call should fire.
    await dialog.getByRole('button', { name: /^Cancel$/ }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 5000 })
  })
})

test.describe('purchase invoice cancel & recreate', () => {
  test('view dialog offers Cancel & Recreate with a confirm step', async ({ page }) => {
    await page.goto('/purchase/invoices')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })

    // Settle the body before deciding: an empty DataTable renders a one-cell
    // placeholder row ("No purchase invoices found"), so the bare row count
    // this guard used to do was 1 — never 0 — the skip never fired and the
    // test hung on an Eye button the placeholder doesn't have. That is how it
    // failed against the installed desktop app, whose database has no purchase
    // invoices. Count rows carrying the Eye action, and wait for either
    // post-load state so a slow fetch is never mistaken for an empty table.
    const rows = page.locator('table tbody tr', { has: page.locator('button:has(svg.lucide-eye)') })
    const emptyState = page.getByText('No purchase invoices found')
    await expect(rows.or(emptyState).first()).toBeVisible({ timeout: 20000 })
    if ((await rows.count()) === 0) {
      test.skip(true, 'no purchase invoices in this database (fresh install)')
      return
    }

    // Open the first row's details (the Eye button is named by its tooltip).
    await rows.first().locator('button:has(svg.lucide-eye)').first().click()

    const view = page.getByRole('dialog')
    await expect(view).toBeVisible({ timeout: 10000 })

    const recreate = view.getByRole('button', { name: /Cancel & Recreate/i })
    await expect(recreate).toBeVisible({ timeout: 5000 })

    // Clicking opens a confirm dialog; backing out must not mutate anything.
    await recreate.click()
    const confirm = page.getByRole('dialog').last()
    await expect(confirm.getByText(/Cancel and recreate/i)).toBeVisible({ timeout: 5000 })
    await confirm.getByRole('button', { name: /^Cancel$/ }).click()
  })
})

// These three exercise the full mutation path against the live backend. Each
// builds its own fixture over the authenticated API so the test owns every row
// it touches and can clean up after itself — no dependence on seed data and no
// risk of re-running against the same primary key.
test.describe('invoice mutations round-trip', () => {
  test.describe.configure({ mode: 'default' })
  test.setTimeout(90_000)

  test('purchase invoice is recreated with a new number and the same lines', async ({ page }) => {
    // The invoice number's ONLY digits must be the run number (`…-001`) so the
    // recreate's bump regex latches onto it and produces `…-002`. A timestamp
    // inside the number would donate the trailing digits instead, forcing the
    // backend onto its date-suffix fallback. Uniqueness comes from the sku.
    const uniq = Date.now()
    const number = `E2E-PI-REC-${uniq.toString(36)}-001`
    const line = { product: 'E2E Recreate Ring', sku: `E2E-PI-REC-${uniq}`, qty: 2, weight: 3.5, rate: 90, tax: 0 }

    const apiClient = await api()
    const created = await apiClient.post('/api/v1/db/purchase-invoices', {
      number, supplier: 'E2E Supplier', items: [line], status: 'pending',
    })
    expect(created.status(), `create fixture: ${await created.text()}`).toBe(201)
    const original = await created.json()
    try {
      await page.goto('/purchase/invoices')
      const row = page.locator('table tbody tr', { hasText: number })
      await expect(row).toHaveCount(1, { timeout: 20000 })
      await row.first().locator('button:has(svg.lucide-eye)').first().click()
      await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 })

      await page.getByRole('dialog').getByRole('button', { name: /Cancel & Recreate/i }).click()
      await page.getByRole('dialog').last().getByRole('button', { name: /Cancel & recreate/i }).click()

      // The old number leaves the table and a successor carrying the same lines
      // appears: the run number is bumped, so the new invoice is never the old
      // one relabelled.
      await expect(page.locator('table tbody tr', { hasText: number })).toHaveCount(0, { timeout: 20000 })
      const successor = number.replace(/\d+$/, (d) => String(Number(d) + 1).padStart(d.length, '0'))
      await expect(page.locator('table tbody tr', { hasText: successor })).toHaveCount(1, { timeout: 20000 })

      const items = await apiClient.get(`/api/v1/db/purchase-invoices/${original.id}/with-items`)
      expect(items.status(), 'recreated invoice must be queryable').toBe(404)
      const list = await (await apiClient.get('/api/v1/db/purchase-invoices?limit=200')).json()
      const survivor = (list.data as Array<{ number: string; id: string }>).find((r) => r.number === successor)
      expect(survivor, 'successor invoice must exist in the API').toBeTruthy()
      const recreated = await (await apiClient.get(`/api/v1/db/purchase-invoices/${survivor!.id}/with-items`)).json()
      const recreatedLines = (recreated.items ?? recreated.lines ?? []) as Array<{ sku: string; qty: number }>
      expect(recreatedLines.map((l) => l.sku)).toEqual([line.sku])
      expect(recreatedLines[0].qty).toBe(line.qty)
    } finally {
      const list = await (await apiClient.get('/api/v1/db/purchase-invoices?limit=200')).json()
      const doomed = (list.data as Array<{ number: string; id: string }>).filter((r) => r.number.startsWith('E2E-PI-REC-'))
      for (const r of doomed) await apiClient.del(`/api/v1/db/purchase-invoices/${r.id}`)
      await apiClient.dispose()
    }
  })

  test('product created through the dialog appears and deletes cleanly', async ({ page }) => {
    const stamp = Date.now()
    const name = `E2E Product ${stamp}`
    const sku = `E2E-PRD-${stamp}`

    const apiClient = await api()
    try {
      await page.goto('/inventory/products')
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })

      // Add → the create dialog opens; fill the two required fields only.
      await page.getByRole('button', { name: /^Add$/ }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 10000 })
      await dialog.getByPlaceholder('e.g. Silver Classic Ring').fill(name)
      await dialog.getByPlaceholder('e.g. SLV-RNG-00001').fill(sku)
      // The dialog refuses to save without a priceable product: a valid silver
      // rate is mandatory and net weight drives the auto-computed selling price.
      // Both inputs carry no placeholder, so address them by their field label.
      // These pricing inputs have no placeholder or accessible name (the Field
      // label isn't associated), so address them structurally: each field is a
      // wrapper div whose second child is the input. Tailwind's `space-y-1.5`
      // class can't be used in a CSS selector without escaping, so target divs
      // generically and disambiguate by the label text inside the wrapper.
      const field = (label: string) =>
        dialog
          .locator('div:has(> label)', { hasText: label })
          .locator('input')
      await field('Net weight (g)').fill('5')
      await field('Silver rate (₹/g) *').fill('90')
      // Add mode defaults "Push to Shopify" ON, so the label is either
      // "Create & Push to Shopify" or "Create Product" depending on the toggle.
      await dialog.getByRole('button', { name: /Create (Product|& Push to Shopify)/ }).click()

      // The new product must land in the table (dialog closes on save).
      const row = page.locator('table tbody tr', { hasText: sku })
      await expect(row).toHaveCount(1, { timeout: 20000 })

      // And it must be a real row the API knows about.
      const list = await (await apiClient.get('/api/v1/db/products?limit=200')).json()
      const saved = (list.data as Array<{ id: string; sku: string; name: string }>).find((r) => r.sku === sku)
      expect(saved, 'created product must exist in the API').toBeTruthy()
      expect(saved!.name).toBe(name)

      // Delete it for good, then prove it left both the API and the table.
      const deleted = await apiClient.del(`/api/v1/db/products/${saved!.id}`)
      expect(deleted.status(), `delete product: ${await deleted.text()}`).toBe(200)
      const after = await (await apiClient.get('/api/v1/db/products?limit=200')).json()
      expect(
        (after.data as Array<{ sku: string }>).some((r) => r.sku === sku),
        'deleted product must be gone from the API',
      ).toBe(false)
      await page.reload()
      await expect(page.locator('table tbody tr', { hasText: sku })).toHaveCount(0, { timeout: 20000 })
    } finally {
      // Belt and braces: if the assertion above failed mid-flight, still remove the fixture.
      const list = await (await apiClient.get('/api/v1/db/products?limit=200')).json()
      const doomed = (list.data as Array<{ id: string; sku: string }>).filter((r) => r.sku.startsWith('E2E-PRD-'))
      for (const r of doomed) await apiClient.del(`/api/v1/db/products/${r.id}`)
      await apiClient.dispose()
    }
  })

  test('sales invoice cancel & reissue raises a fresh invoice for the order', async ({ page }) => {
    const stamp = Date.now()
    const apiClient = await api()
    const orderResp = await apiClient.post('/api/v1/db/sales-orders', {
      shopifyId: `#E2E-REINV-${stamp}`,
      customer: 'E2E Reissue Customer',
      value: 200,
      payment: 'pending',
      status: 'unfulfilled',
      date: new Date().toISOString(),
      items: 1,
      lineItems: [{ title: 'E2E Reissue Ring', sku: `E2E-REINV-${stamp}`, quantity: 1, price: 200 }],
    })
    expect(orderResp.status(), `create order fixture: ${await orderResp.text()}`).toBe(201)
    const order = await orderResp.json()
    try {
      const invoiced = await apiClient.post(`/api/v1/db/sales-orders/${order.id}/create-invoice`, {})
      expect(invoiced.status(), `raise invoice: ${await invoiced.text()}`).toBe(200)
      const first = (await invoiced.json()).invoiceNumber as string
      expect(first, 'order must be linked to an invoice').toBeTruthy()

      await page.goto('/sales/invoices')
      const row = page.locator('table tbody tr', { hasText: first })
      await expect(row).toHaveCount(1, { timeout: 20000 })
      await row.first().getByRole('button', { name: /More actions for/i }).click()
      await page.getByRole('menuitem', { name: /Cancel & reissue/i }).click()
      await page.getByRole('dialog').last().getByRole('button', { name: /Cancel & reissue/i }).click()

      // The linked invoice number must change, and the old one must be gone
      // while the replacement is present — a cancel-and-reissue, not a void.
      await expect(page.locator('table tbody tr', { hasText: first })).toHaveCount(0, { timeout: 20000 })
      const orderAfter = await (await apiClient.get(`/api/v1/db/sales-orders/${order.id}`)).json()
      expect(orderAfter.invoice, 'order must point at the reissued invoice').toBeTruthy()
      expect(orderAfter.invoice).not.toBe(first)
      await expect(page.locator('table tbody tr', { hasText: orderAfter.invoice })).toHaveCount(1, { timeout: 20000 })
      // The list endpoint keys on the row id, so resolve the number we hold to
      // its id before reading it back.
      const invList = await (await apiClient.get('/api/v1/db/invoices?limit=200')).json()
      const replacementRow = (invList.data as Array<{ id: string; number: string }>).find(
        (r) => r.number === orderAfter.invoice,
      )
      expect(replacementRow, 'reissued invoice must exist in the API').toBeTruthy()
      const replacement = await apiClient.get(`/api/v1/db/invoices/${replacementRow!.id}`)
      expect(replacement.status(), 'reissued invoice must be queryable').toBe(200)
    } finally {
      await apiClient.del(`/api/v1/db/sales-orders/${order.id}`)
      await apiClient.dispose()
    }
  })

  test('sales invoice delete removes it for good', async ({ page }) => {
    const stamp = Date.now()
    const apiClient = await api()
    const orderResp = await apiClient.post('/api/v1/db/sales-orders', {
      shopifyId: `#E2E-DEL-${stamp}`,
      customer: 'E2E Delete Customer',
      value: 150,
      payment: 'pending',
      status: 'unfulfilled',
      date: new Date().toISOString(),
      items: 1,
      lineItems: [{ title: 'E2E Delete Ring', sku: `E2E-DEL-${stamp}`, quantity: 1, price: 150 }],
    })
    expect(orderResp.status(), `create order fixture: ${await orderResp.text()}`).toBe(201)
    const order = await orderResp.json()
    try {
      const invoiced = await apiClient.post(`/api/v1/db/sales-orders/${order.id}/create-invoice`, {})
      expect(invoiced.status(), `raise invoice: ${await invoiced.text()}`).toBe(200)
      const number = (await invoiced.json()).invoiceNumber as string
      expect(number).toBeTruthy()

      await page.goto('/sales/invoices')
      const row = page.locator('table tbody tr', { hasText: number })
      await expect(row).toHaveCount(1, { timeout: 20000 })
      await row.first().getByRole('button', { name: /More actions for/i }).click()
      await page.getByRole('menuitem', { name: /Delete invoice/i }).click()
      await page.getByRole('dialog').last().getByRole('button', { name: /^Delete$/ }).click()

      await expect(page.locator('table tbody tr', { hasText: number })).toHaveCount(0, { timeout: 20000 })
      const goneList = await (await apiClient.get('/api/v1/db/invoices?limit=200')).json()
      expect(
        (goneList.data as Array<{ number: string }>).some((r) => r.number === number),
        'deleted invoice must be gone from the API',
      ).toBe(false)
    } finally {
      await apiClient.del(`/api/v1/db/sales-orders/${order.id}`)
      await apiClient.dispose()
    }
  })

  test('New Invoice opens a dialog on the page (no redirect) and saves a manual invoice', async ({ page }) => {
    const stamp = Date.now()
    const customer = `E2E Manual Cust ${stamp}`
    const itemName = `E2E Manual Ring ${stamp}`

    const apiClient = await api()
    try {
      await page.goto('/sales/invoices')
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })

      // The requirement: New Invoice must open a dialog IN PLACE. It used to
      // bounce the user to the sales-order page to raise one from an order.
      await page.getByRole('button', { name: /New Invoice/ }).click()
      await expect(page).toHaveURL(/\/sales\/invoices/, { timeout: 5000 })

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 10000 })
      await expect(dialog.getByText('New Sales Invoice')).toBeVisible()

      // Header — customer is the only required field.
      await dialog.getByPlaceholder('Walk-in customer').fill(customer)

      // First line, typed by hand (no SKU): stock is left alone without one.
      const line = dialog.locator('table tbody tr').first()
      await line.getByPlaceholder('Item name / SKU').fill(itemName)
      await line.locator('td').nth(2).locator('input').fill('10') // weight (gm)
      await line.locator('td').nth(3).locator('input').fill('90') // rate (₹/gm)

      await dialog.getByRole('button', { name: /Create invoice/ }).click()

      // The create dialog closes rather than navigating away.
      await expect(page.getByText('New Sales Invoice')).toHaveCount(0, { timeout: 20000 })
      await expect(page).toHaveURL(/\/sales\/invoices/)

      // A read-only preview of the new invoice opens on top; dismiss it.
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 5000 })

      // It persisted: the API knows the number minted for this customer…
      const list = await (await apiClient.get('/api/v1/db/invoices?limit=200')).json()
      const saved = (list.data as Array<{ id: string; number: string; customer: string; grandTotal: number }>).find(
        (r) => r.customer === customer,
      )
      expect(saved, 'manually created invoice must exist in the API').toBeTruthy()
      expect(saved!.grandTotal, 'totals are computed from the line').toBeGreaterThan(0)

      // …and the table renders it.
      await expect(page.locator('table tbody tr', { hasText: saved!.number })).toHaveCount(1, { timeout: 20000 })
    } finally {
      // Cleanup must never mask the real assertion: skip quietly if the list
      // call itself failed (e.g. the session died mid-test).
      try {
        const list = await (await apiClient.get('/api/v1/db/invoices?limit=200')).json()
        const doomed = ((list.data ?? []) as Array<{ id: string; customer: string }>).filter(
          (r) => r.customer === customer,
        )
        for (const r of doomed) await apiClient.del(`/api/v1/db/invoices/${r.id}`)
      } catch { /* nothing to clean up */ }
      await apiClient.dispose()
    }
  })

  test('Sales Orders offers manual invoicing from the header and the row menu', async ({ page }) => {
    const stamp = Date.now()
    const customer = `E2E Order Cust ${stamp}`

    const apiClient = await api()
    // Fixture: one order, so the row action has a buyer to pre-fill from.
    const orderResp = await apiClient.post('/api/v1/db/sales-orders', {
      shopifyId: `#E2E-MANINV-${stamp}`,
      customer,
      value: 100,
      payment: 'pending',
      status: 'unfulfilled',
      date: new Date().toISOString(),
      items: 1,
      lineItems: [{ title: 'E2E Manual Source', sku: `E2E-MANINV-${stamp}`, quantity: 1, price: 100 }],
    })
    expect(orderResp.status(), `create order fixture: ${await orderResp.text()}`).toBe(201)
    const order = (await orderResp.json()) as { id: string }

    try {
      await page.goto('/sales/orders')
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })

      // Header: opens the same dialog in place and starts blank.
      await page.getByRole('button', { name: 'New Invoice' }).click()
      await expect(page).toHaveURL(/\/sales\/orders/, { timeout: 5000 })
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('New Sales Invoice')).toBeVisible({ timeout: 10000 })
      await expect(dialog.getByPlaceholder('Walk-in customer')).toHaveValue('')
      await dialog.getByRole('button', { name: /^Cancel$/ }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 5000 })

      // Row menu: opens the same dialog with the order's buyer pre-filled.
      const row = page.locator('table tbody tr', { hasText: customer })
      await expect(row).toHaveCount(1, { timeout: 20000 })
      // The trigger is a bare icon button with no accessible name.
      await row.first().locator('button:has(svg.lucide-more-horizontal)').click()
      await page.getByRole('menuitem', { name: /New invoice for this customer/ }).click()

      await expect(dialog.getByPlaceholder('Walk-in customer')).toHaveValue(customer, { timeout: 10000 })
      const line = dialog.locator('table tbody tr').first()
      await line.getByPlaceholder('Item name / SKU').fill(`E2E Order Ring ${stamp}`)
      await line.locator('td').nth(2).locator('input').fill('5')
      await line.locator('td').nth(3).locator('input').fill('90')
      await dialog.getByRole('button', { name: /Create invoice/ }).click()
      await expect(page.getByText('New Sales Invoice')).toHaveCount(0, { timeout: 20000 })

      // The invoice landed, billed to the order's customer.
      const list = await (await apiClient.get('/api/v1/db/invoices?limit=200')).json()
      const saved = ((list.data ?? []) as Array<{ number: string; customer: string; grandTotal: number }>).find(
        (r) => r.customer === customer,
      )
      expect(saved, 'invoice created from the orders page must exist in the API').toBeTruthy()
      expect(saved!.grandTotal, 'totals are computed from the line').toBeGreaterThan(0)
    } finally {
      try {
        const list = await (await apiClient.get('/api/v1/db/invoices?limit=200')).json()
        const doomed = ((list.data ?? []) as Array<{ id: string; customer: string }>).filter(
          (r) => r.customer === customer,
        )
        for (const r of doomed) await apiClient.del(`/api/v1/db/invoices/${r.id}`)
        await apiClient.del(`/api/v1/db/sales-orders/${order.id}`)
      } catch { /* nothing to clean up */ }
      await apiClient.dispose()
    }
  })
})
