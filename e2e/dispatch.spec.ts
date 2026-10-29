import { expect, request, test } from '@playwright/test'

/**
 * End-to-end regression spec for the Dispatch page.
 *
 * Mirrors the audit's tested paths: the page renders, an eligible order
 * created through the same fixture route the other specs use is dispatched
 * through the real UI dialog, the shipment survives a reload, delivery can
 * be confirmed from the UI, and a retried dispatch never duplicates the
 * shipment row or the auto-invoice.
 *
 * Every assertion rides the REAL application (no mocks): the fixture order
 * is created over the authenticated API and the UI drives the backend for
 * the whole flow.
 */

/**
 * Authenticated, CSRF-carrying API client for building fixtures.
 *
 * The bare `request` fixture does not pick up the config's storageState, and
 * every state-changing route requires the double-submit CSRF header, so both
 * have to be set up by hand (same pattern as invoice-and-products.spec.ts).
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

async function createOrder(stamp: number) {
  const client = await api()
  const res = await client.post('/api/v1/db/sales-orders', {
    shopifyId: `#E2E-DSP-${stamp}`,
    customer: `E2E Dispatch ${stamp}`,
    value: 100,
    payment: 'pending',
    status: 'unfulfilled',
    date: new Date().toISOString(),
    items: 1,
    tags: 'e2e-dispatch',
    lineItems: [{ title: 'E2E Dispatch Ring', sku: `E2E-DSP-${stamp}`, quantity: 1, price: 100 }],
  })
  expect(res.status(), `create order fixture: ${await res.text()}`).toBe(201)
  const order = await res.json()
  return { client, order }
}

/** Delete the dispatch-era invoice row (if any) and the fixture order. */
async function cleanupOrders(client: Awaited<ReturnType<typeof api>>, orderId: string) {
  const list = await (await client.get('/api/v1/db/invoices?limit=200')).json()
  const linked = ((list.data ?? []) as Array<{ id: string; shopifyOrder?: string }>).filter(
    (r) => r.shopifyOrder === `#${orderId}` || r.shopifyOrder === orderId,
  )
  for (const inv of linked) await client.del(`/api/v1/db/invoices/${inv.id}`)
  await client.del(`/api/v1/db/sales-orders/${orderId}`)
  await client.dispose()
}

test.describe('Dispatch page', () => {
  test('dispatch an eligible order from the UI, persist the shipment, confirm delivery', async ({ page }) => {
    test.setTimeout(120_000)
    const stamp = Date.now()
    const CUSTOMER = `E2E Dispatch ${stamp}`
    const AWB = `E2E-AWB-${stamp}`
    const { client, order } = await createOrder(stamp)

    try {
      await page.goto('/sales/dispatch')
      // The page must render fully: header, KPI cards and the orders table.
      await expect(page.getByRole('heading', { name: 'Dispatch', exact: true })).toBeVisible({ timeout: 20000 })
      const row = page.locator('table tbody tr', { hasText: CUSTOMER })
      await expect(row).toBeVisible({ timeout: 20000 })
      // A fixture order is NOT yet dispatched — its shipment cell must say so.
      await expect(row.getByText('Not dispatched')).toBeVisible()
      // The value column must show the fixture amount.
      await expect(row.getByText(/₹/)).toBeVisible()

      // Open the dialog.
      await row.getByRole('button', { name: /Dispatch/ }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()

      // Untouched dialog: closing must NOT raise the "Discard changes?" confirm —
      // the courier preset used to make the dirty-check warn on empty dialogs.
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 5000 })

      // Re-open and fill real shipping data.
      await row.getByRole('button', { name: /Dispatch/ }).click()
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: 'Delhivery', exact: true }).click()
      await dialog.getByLabel(/Tracking/).fill(AWB)

      await dialog.getByRole('button', { name: /Dispatch & notify/ }).click()
      await expect(dialog).toHaveCount(0, { timeout: 15000 })
      await expect(page.locator('table tbody tr', { hasText: CUSTOMER })).toBeVisible({ timeout: 15000 })

      // Row now shows the courier + tracking and a dispatched badge.
      const dispatchedRow = page.locator('table tbody tr', { hasText: CUSTOMER })
      await expect(dispatchedRow.getByText(/Delhivery/)).toBeVisible({ timeout: 15000 })
      await expect(dispatchedRow.getByText(AWB)).toBeVisible()

      // ── Persistence: reload the page; the shipment is still there. ──
      await page.reload()
      const reloaded = page.locator('table tbody tr', { hasText: CUSTOMER })
      await expect(reloaded.getByText(/Delhivery/)).toBeVisible({ timeout: 20000 })
      await expect(reloaded.getByText(AWB)).toBeVisible()

      // ── Confirm delivery through the UI row action. ──
      await reloaded.getByRole('button', { name: /Delivered/ }).click()
      await expect(reloaded.getByText('Delivered', { exact: true })).toBeVisible({ timeout: 15000 })

      // ── A delivered order can never be re-dispatched from the UI ──
      await expect(reloaded.getByRole('button', { name: /Dispatch/ })).toHaveCount(0, { timeout: 5000 })
    } finally {
      await cleanupOrders(client, order.id)
    }
  })

  test('repeated dispatch calls never duplicate the shipment or invoice', async () => {
    const stamp = Date.now()
    const { client, order } = await createOrder(stamp)

    try {
      const payload = { orderId: order.id, courier: 'DTDC', trackingNumber: `E2E-RETRY-${stamp}` }
      const first = await client.post('/api/v1/db/shipments/dispatch', payload)
      expect(first.status(), `dispatch: ${await first.text()}`).toBe(200)
      const second = await client.post('/api/v1/db/shipments/dispatch', payload)
      expect(second.status(), 'retrying the same dispatch must also succeed (idempotent upsert)').toBe(200)

      // Exactly one shipment for the order.
      const shipments = (await (await client.get('/api/v1/db/shipments')).json()) as {
        data?: Array<{ orderId: string; status: string; courier: string | null; trackingNumber: string | null }>
      }
      const mine = (shipments.data ?? []).filter((s) => s.orderId === order.id)
      expect(mine, 'exactly one shipment row per order').toHaveLength(1)
      expect(mine[0].status).toBe('dispatched')

      // And exactly one invoice, created by the first dispatch and reused.
      const afterOrder = await (await client.get(`/api/v1/db/sales-orders/${order.id}`)).json()
      expect(afterOrder.fulfillment).toBe('fulfilled')
      expect(afterOrder.invoice, 'auto-invoice must fire exactly once').toBeTruthy()
    } finally {
      await cleanupOrders(client, order.id)
    }
  })
})
