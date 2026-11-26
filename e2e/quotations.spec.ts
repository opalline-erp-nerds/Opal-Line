import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * The quotation workflow end to end — the page that went fully
 * non-functional when line items were absent from the list payload, the
 * dialog priced flat making charges, and no product search existed:
 *
 *  1. All quotations carry their line items (list and detail views).
 *  2. Create with product search: type a catalogue name, pick it from the
 *     dropdown, the SKU/net-weight/making-charge autofill and the per-gram
 *     line amount appear, the quotation persists.
 *  3. A piece-rate product (when the catalogue has one) bills its fixed
 *     rate × qty the way the server does.
 *  4. Edit round-trips without loss.
 *
 * Created quotations are deleted in a finally-ish cleanup block, so repeated
 * runs stay deterministic. Silver rate and stock are never modified.
 */

const MARKER = 'PW Quotation E2E'

function isQuotationRow(row: Record<string, unknown>): boolean {
  return String(row.customer ?? '').includes(MARKER)
}

/** Double-submit CSRF: the endpoint also sets the cookie; echo the token back. */
async function csrfHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.get('/api/v1/csrf-token')
  if (!res.ok()) return {}
  const body = (await res.json()) as { csrfToken?: string }
  return body.csrfToken ? { 'X-CSRF-Token': body.csrfToken } : {}
}

async function deleteMarkedQuotations(request: APIRequestContext): Promise<void> {
  const res = await request.get('/api/v1/db/quotations')
  if (!res.ok()) return
  const body = (await res.json()) as { data?: Array<Record<string, unknown>> }
  const rows = Array.isArray(body.data) ? body.data : []
  const headers = await csrfHeaders(request)
  for (const row of rows.filter(isQuotationRow)) {
    await request.delete(`/api/v1/db/quotations/${row.id}`, { headers })
  }
}

test.beforeEach(async ({ request }) => {
  await deleteMarkedQuotations(request)
})

test.afterEach(async ({ request }) => {
  await deleteMarkedQuotations(request)
})

type ProductRow = {
  id: string
  name: string
  sku: string
  netWeight: number | null
  makingCharge: number | null
  pieceRateProduct: boolean | null
  fixedPieceRate: number | null
  stock?: number | null
}

async function loadCatalogue(request: APIRequestContext): Promise<ProductRow[]> {
  const res = await request.get('/api/v1/db/products?limit=200')
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as { data?: ProductRow[] }
  return body.data ?? []
}

test.describe('quotation workflow', () => {
  test('list rows carry their line items (page data fetched correctly)', async ({ request }) => {
    const res = await request.get('/api/v1/db/quotations')
    expect(res.ok()).toBeTruthy()
    const body = (await res.json()) as { data?: Array<{ items?: unknown[] }> }
    for (const row of body.data ?? []) {
      expect(Array.isArray(row.items), `quotation ${String(row.id)} must ship its items`).toBe(true)
    }
  })

  test('create with product search → persisted with items → edit round-trip', async ({ page, request }) => {
    const catalogue = await loadCatalogue(request)
    test.skip(catalogue.length === 0, 'catalogue is empty — nothing to quote')

    // Prefer a silver-rate product (per-gram formula preview), but accept any
    // catalogue product so the workflow is exercised whatever the shop stocks.
    const product =
      catalogue.find((p) => p.pieceRateProduct !== true && Number(p.netWeight) > 0) ?? catalogue[0]
    const isPieceRate = product.pieceRateProduct === true && Number(product.fixedPieceRate) > 0

    await page.goto('/sales/quotations')
    await expect(page.getByRole('heading', { level: 1, name: /Quotations/i })).toBeVisible({ timeout: 20000 })

    await page.getByRole('button', { name: 'New Quotation' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    await dialog.getByLabel('Customer name *').fill(`${MARKER} customer`)

    // Product search: type part of the name, pick the dropdown hit.
    const productField = dialog.getByPlaceholder('Search name or SKU…')
    await productField.fill(product.name.slice(0, 8))
    const hit = dialog.getByRole('button', { name: new RegExp(product.sku) }).first()
    await expect(hit).toBeVisible({ timeout: 10000 })
    await hit.click()

    // Auto-filled pricing from the catalogue.
    if (isPieceRate) {
      await expect(dialog.getByText(/Fixed ₹/)).toBeVisible()
    } else {
      await expect(dialog.getByLabel(/Net wt pc/i)).toHaveValue(
        String(Math.round((product.netWeight ?? 0) * 1000) / 1000),
      )
    }
    const lineAmount = dialog.getByText(/^Line \(/).first()
    await expect(lineAmount).toBeVisible()
    await expect(lineAmount).toContainText(/×/)
    if (isPieceRate) {
      // The fixed ₹/pc is GST-INCLUSIVE: the preview is the taxable value,
      // (fixed × qty) ÷ 1.03 — the header's 3% puts the GST back once.
      await expect(lineAmount).toContainText(currency.format(round2(Number(product.fixedPieceRate) / 1.03)))
    }

    await dialog.getByRole('button', { name: 'Create Quotation' }).click()
    await expect(dialog).toHaveCount(0, { timeout: 10000 })

    // Persisted server-side with items, and rebuilt on the client list.
    const listRes = await request.get('/api/v1/db/quotations')
    expect(listRes.ok()).toBeTruthy()
    const listBody = (await listRes.json()) as {
      data?: Array<Record<string, unknown> & { items?: Array<Record<string, unknown>> }>
    }
    const created = (listBody.data ?? []).find(isQuotationRow)
    expect(created, 'created quotation must persist').toBeTruthy()
    expect((created?.items ?? []).length, 'created quotation must have its line item').toBeGreaterThan(0)

    // The page shows the new row refreshed from the server.
    await expect(page.locator('table tbody tr').first()).toContainText(MARKER)

    // Edit round-trip keeps the line and the customer details.
    const row = page.locator('table tbody tr', { hasText: MARKER }).first()
    await row.getByRole('button', { name: /Edit/ }).click()
    const editDialog = page.getByRole('dialog')
    await expect(editDialog).toBeVisible()
    await expect(editDialog.getByLabel('Customer name *')).toHaveValue(`${MARKER} customer`)
    await expect(editDialog.getByRole('button', { name: 'Save Changes' })).toBeVisible()
    await editDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 5000 })
  })

  /** Same currency formatting the page uses (lib/format.ts). */
  const currency = new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 2, minimumFractionDigits: 0,
  })
  const round2 = (v: number) => Math.round(v * 100) / 100
  const round3 = (v: number) => Math.round(v * 1000) / 1000

  test('piece-rate product bills fixed rate × qty like the server', async ({ request }) => {
    const catalogue = await loadCatalogue(request)
    const piece = catalogue.find((p) => p.pieceRateProduct === true && Number(p.fixedPieceRate) > 0)
    test.skip(!piece, 'no piece-rate product in the catalogue')
    const product = piece as ProductRow
    // The fixed ₹/pc is GST-INCLUSIVE: the stored line is taxable, and the
    // header's 3% adds the GST back to give fixed × qty exactly.
    const taxable = round2((Number(product.fixedPieceRate) * 2) / 1.03)

    const res = await request.post('/api/v1/db/quotations', {
      headers: await csrfHeaders(request),
      data: {
        customer: `${MARKER} piece-rate`,
        items: [
          {
            product: product.name,
            sku: product.sku,
            qty: 2,
            weight: 0,
            silverRate: 0,
            makingCharge: 0,
            amount: taxable,
          },
        ],
      },
    })
    expect(res.ok(), await res.text()).toBeTruthy()
    const created = (await res.json()) as {
      items?: Array<{ amount: number; silverRate: number; makingCharge: number }>
      grandTotal?: number
    }
    const line = created.items?.[0]
    expect(Number(line?.amount)).toBe(taxable)
    expect(line?.silverRate).toBe(0)
    expect(line?.makingCharge).toBe(0)
    expect(Math.abs(Number(created.grandTotal) - Number(product.fixedPieceRate) * 2)).toBeLessThanOrEqual(
      0.02,
      'fixed × qty with the add-on (here zero) counted exactly once',
    )
  })

  test('picked variant add-on is backed out of the line and added back once', async ({ page, request }) => {
    const stamp = Date.now()
    const name = `E2E Quote Toy ${stamp}`
    const sku = `E2E-QT-${stamp}`
    const redSku = `${sku}-RED`
    const headers = await csrfHeaders(request)
    let productId = ''

    // A Piece Rate product (₹2,000/pc) whose red variant carries a durable
    // ₹200 add-on. NEW fixtures send `priceAdjustment`, with `sellingPrice`
    // kept as the EFFECTIVE ₹2,200.
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
          { title: 'red', optionValues: ['red'], sku: redSku, sellingPrice: 2200, priceAdjustment: 200, stock: 2 },
          { title: 'white', optionValues: ['white'], sku: `${sku}-WHI`, sellingPrice: 2000, priceAdjustment: 0, stock: 2 },
        ],
      },
    })
    expect(variants.status(), `create fixture variants: ${await variants.text()}`).toBe(200)

    try {
      await page.goto('/sales/quotations')
      await page.getByRole('button', { name: 'New Quotation' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await dialog.getByLabel('Customer name *').fill(`${MARKER} variant`)

      // Pick the VARIANT row by its own SKU (the parent row only carries the
      // base SKU, which is not a match for `${sku}-RED`).
      await dialog.getByPlaceholder('Search name or SKU…').fill(redSku)
      // Match the ↳ variant row, not the "use as custom line" button which
      // also echoes the query text.
      const hit = dialog.getByRole('button', {
        name: new RegExp(`↳ red[\\s\\S]*${redSku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      })
      await expect(hit, 'the variant must be its own selectable row').toBeVisible({ timeout: 10000 })
      await hit.click()
      await expect(dialog.getByText('+₹200 variant add-on (GST inclusive)')).toBeVisible()

      const taxable = round2((2000 + 200) / 1.03) // ₹2,135.92
      const lineText = dialog.getByText(/^Line \(/).first()
      await expect(lineText).toContainText('(₹2000 + ₹200) × 1 ÷ 1.03')
      await expect(lineText).toContainText(currency.format(taxable))
      // Default header GST is 3%: the add-on comes back exactly once, so the
      // customer pays ₹2,200 — not ₹2,000 (dropped) nor ₹2,266 (counted twice).
      await expect(dialog.getByText('Grand total').locator('..')).toContainText(currency.format(2200))

      await dialog.getByRole('button', { name: 'Create Quotation' }).click()
      await expect(dialog).toHaveCount(0, { timeout: 10000 })

      const listRes = await request.get('/api/v1/db/quotations')
      expect(listRes.ok()).toBeTruthy()
      const listBody = (await listRes.json()) as {
        data?: Array<Record<string, unknown> & { items?: Array<Record<string, unknown>> }>
      }
      const stored = (listBody.data ?? []).find(isQuotationRow)
      expect(stored, 'the quotation must persist').toBeTruthy()
      const item = (stored?.items ?? []).find((it) => it.sku === redSku)
      expect(item, 'the picked variant must be the stored line').toBeTruthy()
      expect(Number(item?.priceAdjustment)).toBe(200, 'quotation_items.price_adjustment snapshots the add-on')
      expect(Number(item?.amount)).toBe(taxable, 'the taxable amount includes addOn ÷ 1.03 once')
      expect(Number(stored?.grandTotal)).toBe(2200, 'the customer pays ₹2,000 + ₹200 once')
    } finally {
      if (productId) await request.delete(`/api/v1/db/products/${productId}`, { headers })
    }
  })

  test('convert to invoice: one invoice, one stock movement, clean delete rollback', async ({ request }) => {
    const catalogue = await loadCatalogue(request)
    const sellable = catalogue.find(
      (p) => !p.pieceRateProduct && Number(p.netWeight) > 0 && Number(p.stock) >= 1 && Number(p.makingCharge) >= 0,
    )
    test.skip(!sellable, 'no sellable silver-rate product in stock to convert')
    const product = sellable as ProductRow & { stock: number }

    const stockBefore = product.stock
    const headers = await csrfHeaders(request)

    // 1. Create a quotation for 1 piece of the product.
    const createRes = await request.post('/api/v1/db/quotations', {
      headers,
      data: {
        customer: `${MARKER} convert`,
        items: [
          {
            product: product.name,
            sku: product.sku,
            qty: 1,
            weight: product.netWeight,
            silverRate: 92.5,
            makingCharge: product.makingCharge,
          },
        ],
      },
    })
    expect(createRes.ok(), await createRes.text()).toBeTruthy()
    const quotation = (await createRes.json()) as { id: string; number: string }

    // 2. Convert — this goes through the same route the UI's Convert button

    //    hits and must produce exactly one invoice and deduct stock once.
    const convRes = await request.post(`/api/v1/db/quotations/${quotation.id}/convert`, { headers })
    expect(convRes.ok(), await convRes.text()).toBeTruthy()
    const { invoiceNumber, invoiceId } = (await convRes.json()) as { invoiceNumber: string; invoiceId: string }

    // 3. The quotation is terminal-converted, pointing at that one invoice.
    const listRes = await request.get('/api/v1/db/quotations')
    const listBody = (await listRes.json()) as { data?: Array<Record<string, unknown>> }
    const converted = (listBody.data ?? []).find((r) => r.id === quotation.id)
    expect(converted?.status).toBe('converted')
    expect(converted?.convertedInvoice).toBe(invoiceNumber)
    expect(Array.isArray(converted?.items), 'converted quotation still ships its items').toBe(true)

    // 4. The invoice exists exactly once with the quotation's line.
    const invRes = await request.get(`/api/v1/db/invoices/${invoiceId}`)
    expect(invRes.ok(), await invRes.text()).toBeTruthy()
    const invoice = (await invRes.json()) as { number?: string }
    expect(invoice.number).toBe(invoiceNumber)
    // Line items live on their own endpoint (the detail row omits them).
    const itemsRes = await request.get(`/api/v1/db/invoices/${invoiceId}/items`)
    const invoiceItems = (await itemsRes.json()) as Array<{ sku?: string }>
    expect(itemsRes.ok()).toBeTruthy()
    expect(invoiceItems.some((it) => it.sku === product.sku)).toBe(true)
    const sameNumbers = (listBody.data ?? []).filter((r) => r.convertedInvoice === invoiceNumber)
    expect(sameNumbers.length).toBe(1) // no duplicate conversions/invoices

    // 5. Stock was deducted exactly once: product rows report the delta…
    const afterInv = await loadCatalogue(request)
    const stockAfterConvert = afterInv.find((p) => p.sku === product.sku)?.stock
    expect(stockAfterConvert).toBe(stockBefore - 1)

    // 6. …and the delete endpoint restores it, undoing the whole test.
    const delRes = await request.delete(`/api/v1/db/invoices/${invoiceId}`, { headers })
    expect(delRes.ok(), await delRes.text()).toBeTruthy()
    const finalInv = await loadCatalogue(request)
    const stockFinal = finalInv.find((p) => p.sku === product.sku)?.stock
    expect(stockFinal).toBe(stockBefore)
  })

  test('sku-fragment search autofills exact catalogue values and prices the line', async ({ page, request }) => {
    const catalogue = await loadCatalogue(request)
    // A per-gram product (piece-rate rows have no weight-based formula).
    const silver = catalogue.find((p) => p.pieceRateProduct !== true && Number(p.netWeight) > 0)
    test.skip(!silver, 'no per-gram product in the catalogue')
    const product = silver as ProductRow

    await page.goto('/sales/quotations')
    await page.getByRole('button', { name: 'New Quotation' }).click()
    const dialog = page.getByRole('dialog')

    // Search by a SKU fragment (not the name) and pick the hit.
    const fragment = product.sku.slice(0, 4)
    await dialog.getByPlaceholder('Search name or SKU…').fill(fragment)
    const hit = dialog.getByRole('button', { name: new RegExp(product.sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first()
    await expect(hit).toBeVisible({ timeout: 10000 })
    await hit.click()

    // Exact catalogue autofill.
    await expect(dialog.getByLabel('Net wt pc for line 1')).toHaveValue(
      String(Math.round((product.netWeight ?? 0) * 1000) / 1000),
    )
    if (Number(product.makingCharge) > 0) {
      await expect(dialog.getByLabel('Making charge for line 1')).toHaveValue(
        String(Math.round((product.makingCharge ?? 0) * 100) / 100),
      )
    }

    // The seeded managed rate drives the price; fall back to typing one if the
    // Silver Rate service hasn't loaded in this environment.
    const rateInput = dialog.getByLabel('Silver rate for line 1')
    let rate = Number(await rateInput.inputValue())
    if (!(rate > 0)) {
      await rateInput.fill('92.5')
      rate = 92.5
    }

    // qty 2 → the module (and the backend) round the line weight first, then
    // price it: round2(round2(qty × per-piece net wt) × (rate + making)).
    await dialog.getByLabel('Qty for line 1').fill('2')
    const making = Number(product.makingCharge) > 0 ? Number(product.makingCharge) : 0
    const lineWeight = round2(2 * round3(Number(product.netWeight)))
    const expected = round2(lineWeight * (rate + making))
    const lineText = dialog.getByText(/^Line \(/).first()
    await expect(lineText).toContainText(currency.format(expected), { timeout: 5000 })
  })

  test('a query with no matches keeps the dropdown open and says so', async ({ page }) => {
    await page.goto('/sales/quotations')
    await page.getByRole('button', { name: 'New Quotation' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('Search name or SKU…').fill('zzqq-no-such-product')
    // Regression: the panel used to collapse silently on a resolved-empty
    // search, leaving the user with no explanation for the missing hits.
    await expect(dialog.getByText('No matching products')).toBeVisible({ timeout: 10000 })
  })

  test('multi-line totals with GST and discount match the ERP rules in dialog and storage', async ({ page, request }) => {
    const catalogue = await loadCatalogue(request)
    const silver = catalogue.find((p) => p.pieceRateProduct !== true && Number(p.netWeight) > 0)
    const piece = catalogue.find((p) => p.pieceRateProduct === true && Number(p.fixedPieceRate) > 0)
    test.skip(!silver, 'no per-gram product in the catalogue')
    test.skip(!piece, 'no piece-rate product in the catalogue')
    const silverProduct = silver as ProductRow
    const pieceProduct = piece as ProductRow

    await page.goto('/sales/quotations')
    await page.getByRole('button', { name: 'New Quotation' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Customer name *').fill(`${MARKER} totals`)

    // Line 1: product pick, rate from the managed value (or typed fallback).
    const search = dialog.getByPlaceholder('Search name or SKU…')
    await search.fill(silverProduct.name.slice(0, 6))
    await dialog
      .getByRole('button', { name: new RegExp(silverProduct.sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
      .first()
      .click() // closes the dropdown
    const rateInput = dialog.getByLabel('Silver rate for line 1')
    let rate = Number(await rateInput.inputValue())
    if (!(rate > 0)) {
      await rateInput.fill('92.5')
      rate = 92.5
    }
    await dialog.getByLabel('Qty for line 1').fill('2')
    const making = Number(silverProduct.makingCharge) > 0 ? Number(silverProduct.makingCharge) : 0
    // Same rounding steps as the dialog/backend: per-piece weight rounded to
    // 3dp on pick, line weight rounded to the paisa, then priced.
    const line1 = round2(round2(2 * round3(Number(silverProduct.netWeight))) * (rate + making))

    // Line 2: piece-rate product at its fixed rate. The ₹/pc is GST-INCLUSIVE,
    // so the taxable line amount is (fixed × qty) ÷ 1.03; the header's GST
    // (5% in this test) adds it back to the correct grand total.
    await dialog.getByRole('button', { name: 'Add line' }).click()
    const search2 = dialog.getByPlaceholder('Search name or SKU…').nth(1)
    await search2.fill(pieceProduct.name.slice(0, 6))
    await dialog
      .getByRole('button', { name: new RegExp(pieceProduct.sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
      .first()
      .click()
    await dialog.getByLabel('Qty for line 2').fill('3')
    const line2 = round2((3 * Number(pieceProduct.fixedPieceRate)) / 1.03)

    // GST on the subtotal, discount off the grand total — the ERP convention.
    const subtotal = round2(line1 + line2)
    const gstAmount = round2((subtotal * 5) / 100)
    const grandTotal = round2(subtotal + gstAmount - 25)
    await dialog.getByLabel('GST percent').fill('5')
    await dialog.getByLabel('Discount rupees').fill('25')

    await expect(dialog.getByText(currency.format(grandTotal), { exact: false }).first()).toBeVisible()

    await dialog.getByRole('button', { name: 'Create Quotation' }).click()
    await expect(dialog).toHaveCount(0, { timeout: 10000 })

    // The stored quotation matches the dialog preview exactly.
    const listRes = await request.get('/api/v1/db/quotations')
    expect(listRes.ok()).toBeTruthy()
    const listBody = (await listRes.json()) as { data?: Array<Record<string, unknown>> }
    const stored = (listBody.data ?? []).find(isQuotationRow)
    expect(stored, 'quotation must persist').toBeTruthy()
    expect(stored?.subtotal).toBe(subtotal)
    expect(stored?.gst).toBe(5)
    expect(stored?.gstAmount).toBe(gstAmount)
    expect(stored?.discount).toBe(25)
    expect(stored?.grandTotal).toBe(grandTotal)
    const storedItems = (stored?.items ?? []) as Array<{ amount?: number }>
    expect(storedItems.length).toBe(2)
    expect(storedItems.map((i) => i.amount).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([line1, line2].sort((a, b) => a - b))

    // Survives a full page reload.
    await page.reload()
    await expect(page.locator('table tbody tr', { hasText: MARKER }).first()).toBeVisible({ timeout: 15000 })
  })
})
