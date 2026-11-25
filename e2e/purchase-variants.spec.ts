import { expect, request, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { ensureSilverRate } from './fixtures'

/**
 * Purchase documents on variant SKUs and Piece Rate lines.
 *
 *  - Record Purchase (Purchase Invoice) selects a VARIANT row (e.g.
 *    `E2E-PV-…-RED`) and bills it at its fixed ₹/pc, not `net wt × rate`;
 *  - the saved line carries product_id / variant_id and the variant SKU;
 *  - stock rises on THAT variant only — the sibling variant is untouched and
 *    the parent total rolls up — and `stock_movements.variant_id` records the
 *    bucket it landed in (checked through the inventory movements API);
 *  - a Purchase Return against the same variant deducts only that variant, and
 *    linking it to the receipt sends `invoiceId` so the server takes the goods
 *    out of the store that received them;
 *  - a PO → PI conversion keeps both ids and the agreed piece-rate money;
 *  - a flat product (no variants) still receives stock with no variant id.
 *
 * Every fixture is created through the API and removed in `finally`, so the
 * spec runs on a freshly bootstrapped database.
 */

/** Authenticated, CSRF-carrying API client for fixtures, assertions and cleanup. */
async function api() {
  const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:47195'
  const ctx = await request.newContext({ baseURL, storageState: 'e2e/.auth/state.json' })
  const { csrfToken } = (await (await ctx.get('/api/v1/csrf-token')).json()) as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  return {
    get: (path: string) => ctx.get(path),
    post: (path: string, data: unknown) => ctx.post(path, { headers, data }),
    put: (path: string, data: unknown) => ctx.put(path, { headers, data }),
    patch: (path: string, data: unknown) => ctx.patch(path, { headers, data }),
    del: (path: string) => ctx.delete(path, { headers }),
    dispose: () => ctx.dispose(),
  }
}

type ApiClient = Awaited<ReturnType<typeof api>>

interface VariantProduct {
  id: string
  name: string
  sku: string
  redSku: string
  whiteSku: string
}

/** A Piece Rate product (₹2,000/pc) with red/white variants holding stock. */
async function createPieceRateProduct(apiClient: ApiClient, stamp: number): Promise<VariantProduct> {
  const sku = `E2E-PV-${stamp}`
  const name = `E2E Purchase Toy ${stamp}`
  const created = await apiClient.post('/api/v1/db/products', {
    name,
    sku,
    category: 'Silver Jewels',
    status: 'active',
    shopifyStatus: 'not-listed',
    // Piece Rate: netWeight exists so a weight-based mis-price is obvious.
    pieceRateProduct: true,
    fixedPieceRate: 2000,
    sellingPrice: 2000,
    netWeight: 10,
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

/** A plain single-SKU product — the path that must keep working unchanged. */
async function createFlatProduct(apiClient: ApiClient, stamp: number): Promise<{ id: string; name: string; sku: string }> {
  const sku = `E2E-PF-${stamp}`
  const name = `E2E Flat Purchase ${stamp}`
  const created = await apiClient.post('/api/v1/db/products', {
    name,
    sku,
    category: 'Silver Jewels',
    status: 'active',
    shopifyStatus: 'not-listed',
    netWeight: 10,
    makingCharge: 0,
    sellingPrice: 1000,
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
  expect(created.status(), `flat product fixture: ${await created.text()}`).toBe(201)
  const product = (await created.json()) as { id: string }
  return { id: product.id, name, sku }
}

/** Current stock per variant SKU (the API's own view of the variant counters). */
async function variantStocks(apiClient: ApiClient, productId: string): Promise<Map<string, number>> {
  const res = await apiClient.get(`/api/v1/db/products/${productId}/variants`)
  const body = (await res.json()) as { variants: Array<{ sku: string; stock: number }> }
  return new Map((body.variants ?? []).map((v) => [v.sku, Number(v.stock)]))
}

/** Variant id by SKU — what a purchase line stores beside the code. */
async function variantIds(apiClient: ApiClient, productId: string): Promise<Map<string, string>> {
  const res = await apiClient.get(`/api/v1/db/products/${productId}/variants`)
  const body = (await res.json()) as { variants: Array<{ id: string; sku: string }> }
  return new Map((body.variants ?? []).map((v) => [v.sku, v.id]))
}

async function parentStock(apiClient: ApiClient, productId: string): Promise<number> {
  const res = await apiClient.get(`/api/v1/db/products/${productId}`)
  const body = (await res.json()) as { stock: number }
  return Number(body.stock)
}

/** Pick a catalogue row in a purchase line's SearchableSelect by its SKU. */
async function pickPurchaseItem(page: Page, dialog: Locator, sku: string) {
  await dialog.getByRole('button', { name: /Select a product/ }).first().click()
  const search = page.getByPlaceholder('Search name, SKU or variant…')
  await search.fill(sku)
  const option = page.getByRole('menu').last().getByRole('button').filter({ hasText: sku })
  await expect(option, `${sku} must be its own selectable row`).toHaveCount(1)
  await option.click()
}

/** The native Select that offers `value` (supplier name / invoice id). */
function selectWithOption(dialog: Locator, page: Page, value: string): Locator {
  return dialog.locator('select').filter({ has: page.locator(`option[value="${value}"]`) })
}

interface PurchaseInvoiceLine {
  sku?: string
  product?: string
  productId?: string | null
  variantId?: string | null
  qty?: number
  weight?: number
  rate?: number
  cost?: number
  tax?: number
  amount?: number
}

async function invoiceByNumber(apiClient: ApiClient, number: string) {
  const list = (await (await apiClient.get('/api/v1/db/purchase-invoices?limit=200')).json()) as {
    data: Array<{ id: string; number: string; supplier: string; total: number }>
  }
  return list.data.find((r) => r.number === number) ?? null
}

async function invoiceLines(apiClient: ApiClient, invoiceId: string): Promise<PurchaseInvoiceLine[]> {
  const body = (await (await apiClient.get(`/api/v1/db/purchase-invoices/${invoiceId}/with-items`)).json()) as {
    lines?: PurchaseInvoiceLine[]
  }
  return body.lines ?? []
}

async function movements(apiClient: ApiClient, sku: string) {
  const body = (await (await apiClient.get(`/api/v1/db/inventory/movements?sku=${encodeURIComponent(sku)}&limit=100`)).json()) as Array<{
    type: string
    qty: number
    variantId: string | null
    sku: string | null
  }>
  return Array.isArray(body) ? body : []
}

/** Record Purchase form: number + supplier, so the dialog is ready for lines. */
async function openRecordPurchase(page: Page, number: string, supplier: string) {
  await page.goto('/purchase/invoices')
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: /Record Purchase/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 10000 })
  await dialog.getByPlaceholder('PI-2026-0001').fill(number)

  // The supplier options only render once the page's fetch lands — wait for
  // ours rather than racing it.
  const supplierSelect = selectWithOption(dialog, page, supplier)
  await expect(supplierSelect).toHaveCount(1, { timeout: 15000 })
  await supplierSelect.selectOption(supplier)
  return dialog
}

test.describe('purchase variants and piece-rate lines', () => {
  test('Record Purchase receives a variant at its ₹/pc and moves only that variant', async ({ page }) => {
    test.setTimeout(120_000)
    const stamp = Date.now()
    const supplier = `E2E PV Supplier ${stamp}`
    const invoiceNumber = `E2E-PI-${stamp}`
    const apiClient = await api()
    await ensureSilverRate(apiClient)
    const toy = await createPieceRateProduct(apiClient, stamp)

    const created = await apiClient.post('/api/v1/db/suppliers', { name: supplier, city: 'Chennai', status: 'active' })
    expect(created.status(), `supplier fixture: ${await created.text()}`).toBe(201)

    try {
      const dialog = await openRecordPurchase(page, invoiceNumber, supplier)

      // ── 1. The variant code resolves to its own row, at Piece Rate pricing. ─
      await pickPurchaseItem(page, dialog, toy.redSku)
      await expect(dialog.getByLabel('Price per piece')).toBeVisible({ timeout: 10000 })
      await dialog.getByLabel('Price per piece').fill('500')
      // Qty 2 × ₹500 = ₹1,000; the weight/rate pair never appears for this line.
      const row = dialog.locator('tbody tr').first()
      await row.locator('input[type="number"]').first().fill('2')
      await expect(row.getByText('₹1,000')).toBeVisible()

      await dialog.getByRole('button', { name: /Record purchase/i }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20000 })

      // ── 2. What got stored: the variant identity and the fixed money. ──────
      const invoice = await invoiceByNumber(apiClient, invoiceNumber)
      expect(invoice, 'the purchase invoice must exist in the API').toBeTruthy()
      const lines = await invoiceLines(apiClient, invoice!.id)
      expect(lines.length).toBe(1)
      const line = lines[0]!
      expect(line.sku).toBe(toy.redSku, 'the line carries the VARIANT sku')
      expect(line.variantId, 'purchase_invoice_items.variant_id must be persisted').toBeTruthy()
      expect(line.productId, 'purchase_invoice_items.product_id must be persisted').toBeTruthy()
      expect(String(line.product)).toContain('red', 'the variant name reaches the stored line')
      expect(Number(line.cost)).toBe(1000, 'the fixed ₹/pc, not weight × rate')
      expect(Number(line.weight), 'a piece-rate line has no grams').toBe(0)
      expect(Number(line.rate), 'a piece-rate line has no ₹/g rate').toBe(0)

      // ── 3. Stock moved from the VARIANT only. ──────────────────────────────
      const stocks = await variantStocks(apiClient, toy.id)
      expect(stocks.get(toy.redSku)).toBe(6, 'red: 4 + 2')
      expect(stocks.get(toy.whiteSku)).toBe(2, 'the sibling variant is untouched')
      expect(await parentStock(apiClient, toy.id)).toBe(8, 'the parent total rolls up to 6 + 2')

      // ── 4. The ledger records the bucket it landed in. ─────────────────────
      // Movements are written under the PRODUCT's ledger SKU with the variant
      // named alongside it — that is what pins the move to one bucket.
      const received = (await movements(apiClient, toy.sku)).filter((m) => m.type === 'purchase_in')
      expect(received.length).toBeGreaterThan(0)
      expect(received[0]!.variantId, 'stock_movements.variant_id must name the variant').toBe(line.variantId)
      expect(Number(received[0]!.qty)).toBe(2)

      // ── 5. The detail view names the variant and its code. ─────────────────
      // The list refreshes after the save; click the ROW (not the success
      // toast, which also carries the number) to open its detail view.
      const savedRow = page.getByRole('row').filter({ hasText: invoiceNumber }).first()
      await expect(savedRow).toBeVisible({ timeout: 15000 })
      await savedRow.click()
      const detail = page.getByRole('dialog')
      await expect(detail).toBeVisible({ timeout: 10000 })
      await expect(detail.getByText(`${toy.name} - red`, { exact: false }).first()).toBeVisible()
      await expect(detail.getByText(toy.redSku, { exact: false }).first()).toBeVisible()
      await expect(detail.getByText('₹500.00/pc')).toBeVisible()
      await page.keyboard.press('Escape')
    } finally {
      const invoices = (await (await apiClient.get('/api/v1/db/purchase-invoices?limit=200')).json()) as {
        data: Array<{ id: string; number: string }>
      }
      for (const inv of (invoices.data ?? []).filter((row) => row.number === invoiceNumber)) {
        await apiClient.del(`/api/v1/db/purchase-invoices/${inv.id}`)
      }
      await apiClient.del(`/api/v1/db/products/${toy.id}`)
      const suppliers = (await (await apiClient.get('/api/v1/db/suppliers?limit=200')).json()) as {
        data: Array<{ id: string; name: string }>
      }
      for (const s of (suppliers.data ?? []).filter((r) => r.name === supplier)) {
        await apiClient.del(`/api/v1/db/suppliers/${s.id}`)
      }
      await apiClient.dispose()
    }
  })

  test('Purchase Return deducts only the returned variant and links to its receipt', async ({ page }) => {
    test.setTimeout(120_000)
    const stamp = Date.now()
    const supplier = `E2E PR Supplier ${stamp}`
    const invoiceNumber = `E2E-PI-${stamp}`
    const apiClient = await api()
    await ensureSilverRate(apiClient)
    const toy = await createPieceRateProduct(apiClient, stamp)
    const created = await apiClient.post('/api/v1/db/suppliers', { name: supplier, city: 'Chennai', status: 'active' })
    expect(created.status(), `supplier fixture: ${await created.text()}`).toBe(201)

    try {
      // Receive 2 red pieces first (stock 4 → 6) so the return has something to
      // send back. Recorded through the API: this test is about the return.
      const invoice = await apiClient.post('/api/v1/db/purchase-invoices', {
        number: invoiceNumber,
        supplier,
        date: new Date().toISOString(),
        items: [
          {
            product: `${toy.name} - red`,
            sku: toy.redSku,
            productId: toy.id,
            qty: 2,
            weight: 0,
            rate: 0,
            cost: 1000,
            tax: 30,
          },
        ],
      })
      expect(invoice.status(), `receipt fixture: ${await invoice.text()}`).toBe(201)
      const invoiceId = ((await invoice.json()) as { id: string }).id
      expect((await variantStocks(apiClient, toy.id)).get(toy.redSku)).toBe(6)

      await page.goto('/purchase/returns')
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })
      await page.getByRole('button', { name: /Record Return/ }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 10000 })

      const supplierSelect = selectWithOption(dialog, page, supplier)
      await expect(supplierSelect).toHaveCount(1, { timeout: 15000 })
      await supplierSelect.selectOption(supplier)

      // Linking the receipt is what makes the server deduct the store that
      // received the goods instead of defaulting to the main store.
      const invoiceSelect = selectWithOption(dialog, page, invoiceId)
      await expect(invoiceSelect, 'the receipt must be offered to return against').toHaveCount(1, { timeout: 15000 })
      await invoiceSelect.selectOption(invoiceId)

      await pickPurchaseItem(page, dialog, toy.redSku)
      await dialog.getByLabel('Price per piece').fill('250')

      // Take the goods out of stock now rather than parking the return as paperwork.
      await dialog.getByRole('checkbox').check()
      await dialog.getByRole('button', { name: /Record return/i }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20000 })

      // ── Stock: only the returned variant, and the parent rolls down. ───────
      const stocks = await variantStocks(apiClient, toy.id)
      expect(stocks.get(toy.redSku)).toBe(5, 'red: 6 − 1')
      expect(stocks.get(toy.whiteSku)).toBe(2, 'the sibling variant is untouched')
      expect(await parentStock(apiClient, toy.id)).toBe(7, 'the parent total rolls down to 5 + 2')

      const sentBack = (await movements(apiClient, toy.sku)).filter((m) => m.type === 'purchase_return_out')
      expect(sentBack.length).toBeGreaterThan(0)
      expect(sentBack[0]!.variantId, 'the return movement names the variant').toBeTruthy()
      expect(Number(sentBack[0]!.qty)).toBe(-1)
      // The receipt movement and the return movement name the SAME bucket —
      // that is what makes the pair balance on one variant.
      const received = (await movements(apiClient, toy.sku)).filter((m) => m.type === 'purchase_in')
      expect(received[0]!.variantId).toBe(sentBack[0]!.variantId)

      // ── The return itself stored the variant and the link. ─────────────────
      const returns = (await (await apiClient.get('/api/v1/db/purchase-returns/with-lines?limit=100')).json()) as {
        data: Array<{ id: string; supplier: string; invoiceId?: string | null; lines?: PurchaseInvoiceLine[] }>
      }
      const saved = (returns.data ?? []).find((r) => r.supplier === supplier)
      expect(saved, 'the return must exist in the API').toBeTruthy()
      expect(saved!.invoiceId).toBe(invoiceId, 'the return records the receipt it came from')
      expect(saved!.lines?.[0]?.sku).toBe(toy.redSku)
      expect(saved!.lines?.[0]?.variantId, 'purchase_return_items.variant_id must be persisted').toBeTruthy()
      expect(saved!.lines?.[0]?.productId, 'purchase_return_items.product_id must be persisted').toBeTruthy()
    } finally {
      const returns = (await (await apiClient.get('/api/v1/db/purchase-returns/with-lines?limit=100')).json()) as {
        data: Array<{ id: string; supplier: string }>
      }
      for (const r of (returns.data ?? []).filter((row) => row.supplier === supplier)) {
        await apiClient.del(`/api/v1/db/purchase-returns/${r.id}`)
      }
      const invoices = (await (await apiClient.get('/api/v1/db/purchase-invoices?limit=200')).json()) as {
        data: Array<{ id: string; number: string }>
      }
      for (const inv of (invoices.data ?? []).filter((row) => row.number === invoiceNumber)) {
        await apiClient.del(`/api/v1/db/purchase-invoices/${inv.id}`)
      }
      await apiClient.del(`/api/v1/db/products/${toy.id}`)
      const suppliers = (await (await apiClient.get('/api/v1/db/suppliers?limit=200')).json()) as {
        data: Array<{ id: string; name: string }>
      }
      for (const s of (suppliers.data ?? []).filter((r) => r.name === supplier)) {
        await apiClient.del(`/api/v1/db/suppliers/${s.id}`)
      }
      await apiClient.dispose()
    }
  })

  test('a PO → PI conversion keeps the variant ids and the piece-rate total', async ({ page }) => {
    test.setTimeout(120_000)
    const stamp = Date.now()
    const supplier = `E2E PO Supplier ${stamp}`
    const poNumber = `E2E-PO-${stamp}`
    const apiClient = await api()
    await ensureSilverRate(apiClient)
    const toy = await createPieceRateProduct(apiClient, stamp)
    const created = await apiClient.post('/api/v1/db/suppliers', { name: supplier, city: 'Chennai', status: 'active' })
    expect(created.status(), `supplier fixture: ${await created.text()}`).toBe(201)

    try {
      // Creating a PO is header + lines; saving the lines raises the invoice.
      const po = await apiClient.post('/api/v1/db/purchase-orders', {
        number: poNumber,
        supplier,
        status: 'open',
        gst: 3,
        date: new Date().toISOString(),
      })
      expect(po.status(), `PO fixture: ${await po.text()}`).toBe(201)
      const orderId = ((await po.json()) as { id: string }).id

      const redId = (await variantIds(apiClient, toy.id)).get(toy.redSku)
      expect(redId, 'the fixture variant must have an id').toBeTruthy()
      const linesRes = await apiClient.patch(`/api/v1/db/purchase-orders/${orderId}/lines`, {
        items: [
          {
            product: `${toy.name} - red`,
            sku: toy.redSku,
            productId: toy.id,
            variantId: redId,
            qty: 3,
            weight: 0,
            rate: 0,
            amount: 1500,
          },
        ],
      })
      expect(linesRes.status(), `PO lines: ${await linesRes.text()}`).toBe(200)
      const ensured = (await linesRes.json()) as { autoInvoice?: string; autoInvoiceSkipped?: string }
      expect(ensured.autoInvoiceSkipped, 'the order must be billable').toBeUndefined()
      expect(ensured.autoInvoice, 'saving PO lines must raise the purchase invoice').toBeTruthy()

      const invoice = await invoiceByNumber(apiClient, ensured.autoInvoice as string)
      expect(invoice).toBeTruthy()
      const lines = await invoiceLines(apiClient, invoice!.id)
      expect(lines.length).toBe(1)
      expect(lines[0]!.sku).toBe(toy.redSku)
      expect(lines[0]!.productId, 'product_id survives the PO → PI conversion').toBe(toy.id)
      expect(lines[0]!.variantId, 'variant_id survives the PO → PI conversion').toBe(redId)
      expect(lines[0]!.weight, 'a piece-rate line gains no grams').toBe(0)
      expect(lines[0]!.rate, 'a piece-rate line gains no ₹/g rate').toBe(0)
      expect(Number(lines[0]!.cost), 'the agreed ₹1,500 must not collapse to ₹0').toBe(1500)

      // Stock lands on the variant the order named.
      const stocks = await variantStocks(apiClient, toy.id)
      expect(stocks.get(toy.redSku)).toBe(7, 'red: 4 + 3')
      expect(stocks.get(toy.whiteSku)).toBe(2, 'the sibling variant is untouched')

      // The order's receipt panel reflects what arrived.
      await page.goto('/purchase/orders')
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })
      await page.getByText(poNumber).first().click()
      const detail = page.getByRole('dialog')
      await expect(detail).toBeVisible({ timeout: 10000 })
      await expect(detail.getByText(`${toy.name} - red`, { exact: false }).first()).toBeVisible()
      await expect(detail.getByText(toy.redSku, { exact: false }).first()).toBeVisible()
      await expect(detail.getByText('Received against this order')).toBeVisible()
    } finally {
      const invoices = (await (await apiClient.get('/api/v1/db/purchase-invoices?limit=200')).json()) as {
        data: Array<{ id: string; supplier: string }>
      }
      for (const inv of (invoices.data ?? []).filter((row) => row.supplier === supplier)) {
        await apiClient.del(`/api/v1/db/purchase-invoices/${inv.id}`)
      }
      const orders = (await (await apiClient.get('/api/v1/db/purchase-orders?limit=200')).json()) as {
        data: Array<{ id: string; number: string }>
      }
      for (const o of (orders.data ?? []).filter((row) => row.number === poNumber)) {
        await apiClient.del(`/api/v1/db/purchase-orders/${o.id}`)
      }
      await apiClient.del(`/api/v1/db/products/${toy.id}`)
      const suppliers = (await (await apiClient.get('/api/v1/db/suppliers?limit=200')).json()) as {
        data: Array<{ id: string; name: string }>
      }
      for (const s of (suppliers.data ?? []).filter((r) => r.name === supplier)) {
        await apiClient.del(`/api/v1/db/suppliers/${s.id}`)
      }
      await apiClient.dispose()
    }
  })

  test('a flat product still receives stock with a null variant', async ({ page }) => {
    test.setTimeout(120_000)
    const stamp = Date.now()
    const supplier = `E2E PF Supplier ${stamp}`
    const invoiceNumber = `E2E-PI-${stamp}`
    const apiClient = await api()
    await ensureSilverRate(apiClient)
    const flat = await createFlatProduct(apiClient, stamp)
    const created = await apiClient.post('/api/v1/db/suppliers', { name: supplier, city: 'Chennai', status: 'active' })
    expect(created.status(), `supplier fixture: ${await created.text()}`).toBe(201)

    try {
      const dialog = await openRecordPurchase(page, invoiceNumber, supplier)

      // Weight-based line: 20 g × ₹50 = ₹1,000.
      const row = dialog.locator('tbody tr').first()
      const qty = row.locator('input[type="number"]').nth(0)
      const weight = row.locator('input[type="number"]').nth(1)
      const rate = row.locator('input[type="number"]').nth(2)
      // Qty first: the pick below fills the line's TOTAL grams, so a qty-2 line
      // of 10 g pieces must open at 20 g (not one piece).
      await qty.fill('2')
      await pickPurchaseItem(page, dialog, flat.sku)
      await expect(dialog.getByLabel('Price per piece')).toHaveCount(0, 'a flat line stays weight-based')
      await expect(weight).toHaveValue('20')
      await rate.fill('50')
      await expect(row.getByText('₹1,000')).toBeVisible()

      await dialog.getByRole('button', { name: /Record purchase/i }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20000 })

      const invoice = await invoiceByNumber(apiClient, invoiceNumber)
      expect(invoice).toBeTruthy()
      const lines = await invoiceLines(apiClient, invoice!.id)
      expect(lines[0]!.sku).toBe(flat.sku)
      expect(lines[0]!.productId, 'the flat line still records its product').toBe(flat.id)
      expect(lines[0]!.variantId, 'a flat product has no variant to record').toBeNull()
      expect(Number(lines[0]!.weight)).toBe(20)
      expect(Number(lines[0]!.cost)).toBe(1000)

      expect(await parentStock(apiClient, flat.id)).toBe(2)

      const received = (await movements(apiClient, flat.sku)).filter((m) => m.type === 'purchase_in')
      expect(received.length).toBeGreaterThan(0)
      expect(received[0]!.variantId, 'no variant row exists to name').toBeNull()
      expect(Number(received[0]!.qty)).toBe(2)
    } finally {
      const invoices = (await (await apiClient.get('/api/v1/db/purchase-invoices?limit=200')).json()) as {
        data: Array<{ id: string; number: string }>
      }
      for (const inv of (invoices.data ?? []).filter((row) => row.number === invoiceNumber)) {
        await apiClient.del(`/api/v1/db/purchase-invoices/${inv.id}`)
      }
      await apiClient.del(`/api/v1/db/products/${flat.id}`)
      const suppliers = (await (await apiClient.get('/api/v1/db/suppliers?limit=200')).json()) as {
        data: Array<{ id: string; name: string }>
      }
      for (const s of (suppliers.data ?? []).filter((r) => r.name === supplier)) {
        await apiClient.del(`/api/v1/db/suppliers/${s.id}`)
      }
      await apiClient.dispose()
    }
  })
})
