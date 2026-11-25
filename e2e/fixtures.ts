import type { APIRequestContext } from '@playwright/test'

/**
 * Shared fixtures for running the suite against a **freshly bootstrapped**
 * database — the installed desktop app CI boots has no catalogue, no seeded
 * silver rate and no Shopify credentials, so a spec that leans on the
 * developer's populated dev database passes locally and fails there.
 *
 * Everything here is self-contained: create what you need, delete it in
 * `finally`, and never depend on rows another test (or a human) left behind.
 */

/** The slice of an API client these fixtures need. */
export interface JsonApi {
  get(path: string): Promise<{ status(): number; json(): Promise<any>; text(): Promise<string> }>
  post(path: string, data: unknown): Promise<{ status(): number; json(): Promise<any>; text(): Promise<string> }>
}

/** An API client that can also delete (fixture cleanup). */
export interface CleanupApi extends JsonApi {
  del(path: string): Promise<{ status(): number; text(): Promise<string> }>
}

/**
 * Wrap the bare Playwright `request` fixture with the double-submit CSRF
 * header every state-changing route requires (the same pattern each spec's
 * local `api()` helper uses, kept here for specs that only need it once).
 */
export async function csrfApi(request: APIRequestContext): Promise<CleanupApi> {
  const { csrfToken } = (await (await request.get('/api/v1/csrf-token')).json()) as { csrfToken?: string }
  const headers = { 'x-csrf-token': csrfToken ?? '' }
  return {
    get: (path) => request.get(path),
    post: (path, data) => request.post(path, { headers, data }),
    del: (path) => request.delete(path, { headers }),
  }
}

/**
 * Make sure a MANAGED SILVER RATE exists before anything bills.
 *
 * A fresh install has no `silver_rates` row. `GET /silver/rate` papers over
 * that with its cosmetic 92.8 display default (so the header looks alive),
 * but every billing path reads the table through `getLatestSilverRate()` and
 * refuses with *"Current silver rate is not available. Please update the rate
 * in Silver Rate Management"* — which is why invoice raises returned 500, the
 * manual-invoice and manual-order dialogs stayed open, and dispatch's
 * auto-invoice silently left `invoice` null on CI while passing on a dev box.
 *
 * This applies the rate exactly the way an operator does on first setup
 * (a Super Admin applies directly; `syncFirst: false` skips the catalogue
 * sync, and the Shopify match/push steps are skipped when the shop is not
 * configured). It is a NO-OP when the database already has a rate, so a
 * developer's box — and every other spec — is never touched.
 */
export async function ensureSilverRate(client: JsonApi, rate = 92.8): Promise<void> {
  const current = await client.get('/api/v1/db/silver-rates?limit=1')
  const body = (await current.json()) as { data?: unknown[] } | null
  if (Array.isArray(body?.data) && body.data.length > 0) return

  const seeded = await client.post('/api/v1/silver/update', { rate, syncFirst: false })
  if (seeded.status() !== 200) {
    throw new Error(`seeding the silver rate failed: HTTP ${seeded.status()} ${await seeded.text()}`)
  }
}

export interface SeededProduct {
  id: string
  sku: string
  name: string
}

/**
 * Create `count` weight-based catalogue products and return a `cleanup` that
 * removes them again. Use it for any spec that needs rows to click in a
 * product list (label designer, quotation picker) — an empty catalogue is the
 * normal state of a fresh install.
 *
 * They are ordinary weight-based products (net weight + making charge) with a
 * `silverRate` of their own, which also satisfies `getLatestSilverRate()`'s
 * read-only fallback on a database that has never had a rate row.
 */
export async function seedProducts(
  client: CleanupApi,
  options: { prefix: string; count?: number },
): Promise<{ products: SeededProduct[]; cleanup: () => Promise<void> }> {
  const count = Math.max(1, options.count ?? 2)
  const created: SeededProduct[] = []
  const removeCreated = async (): Promise<void> => {
    for (const p of created) {
      try {
        await client.del(`/api/v1/db/products/${p.id}`)
      } catch {
        /* best-effort: cleanup must never mask the original failure */
      }
    }
  }
  try {
    for (let i = 1; i <= count; i++) {
      const sku = `${options.prefix}-${i}`
      const res = await client.post('/api/v1/db/products', {
        name: `${options.prefix} Product ${i}`,
        sku,
        category: 'Rings',
        status: 'active',
        shopifyStatus: 'not-listed',
        netWeight: 10,
        makingCharge: 20,
        sellingPrice: 1000,
        silverRate: 92.8,
        gst: 3,
        hsn: '71131130',
        purity: 92.5,
        grossWeight: 0,
        stoneWeight: 0,
        supplier: '',
        stock: 0,
        createdAt: new Date().toISOString(),
      })
      if (res.status() !== 201) {
        throw new Error(`seeding product ${sku} failed: HTTP ${res.status()} ${await res.text()}`)
      }
      const row = (await res.json()) as { id: string; name: string }
      created.push({ id: row.id, sku, name: row.name })
    }
  } catch (err) {
    // A half-built fixture must not outlive the test that asked for it.
    await removeCreated()
    throw err
  }
  return { products: created, cleanup: removeCreated }
}
