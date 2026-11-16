// Outbound ERP → Shopify queue: the real worker (src/shopifyOutbound.ts)
// driving the real push functions against an in-memory Admin REST mock and a
// throwaway database. Covers the failure modes that made ERP edits stop at the
// ERP: nothing was queued, a failed push was forgotten, and a duplicate
// enqueue would have pushed the same change twice.
//
// Same scratch-DB convention as shopify.sync.test.ts: skipped without
// DATABASE_URL, never touches the dev catalog.
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'

const baseDbUrl = process.env.DATABASE_URL?.trim() ?? ''
const TEST_DB = 'opal_line_outbound_test'
const MOCK_HOST = 'mock-outbound-test.myshopify.com'

function scratchUrl(base: string): string {
  const url = new URL(base)
  url.pathname = `/${TEST_DB}`
  return url.toString()
}

interface MockVariant {
  id: number
  product_id: number
  title: string
  sku: string
  price: string
  compare_at_price: string | null
  inventory_management: string | null
  taxable: boolean
  inventory_item_id: number
  position: number
  inventory_quantity: number
}

interface MockProduct {
  id: number
  title: string
  handle: string
  body_html: string
  vendor: string
  product_type: string
  tags: string
  status: string
  options: unknown[]
  images: unknown[]
  variants: MockVariant[]
  created_at: string
  updated_at: string
  admin_graphql_api_id: string
}

function makeMockShopify() {
  const product: MockProduct = {
    id: 5_000_001,
    title: 'Outbound Ring',
    handle: 'outbound-ring',
    body_html: '<p>old copy</p>',
    vendor: 'Opal Line',
    product_type: 'Rings',
    tags: '',
    status: 'active',
    options: [],
    images: [],
    variants: [
      {
        id: 6_000_001,
        product_id: 5_000_001,
        title: 'Default Title',
        sku: 'OUTBOUND-001',
        price: '900.00',
        compare_at_price: null,
        inventory_management: 'shopify',
        taxable: true,
        inventory_item_id: 7_000_001,
        position: 1,
        inventory_quantity: 2,
      },
    ],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    admin_graphql_api_id: 'gid://shopify/Product/5000001',
  }
  const levels = new Map<number, number>([[7_000_001, 2]])
  const calls: Array<{ method: string; path: string; body: any }> = []
  const unmatched: string[] = []
  /** When set, the next product PUT answers 500 (Shopify outage simulation). */
  let failProductPut = false

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const serializeVariant = (v: MockVariant) => ({ ...v, inventory_quantity: levels.get(v.inventory_item_id) ?? 0 })
  const serializeProduct = (p: MockProduct) => ({
    ...p,
    variants: p.variants.map(serializeVariant),
  })

  async function fetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname !== MOCK_HOST) {
      throw new Error(`mock Shopify fetch: unexpected host "${url.hostname}" (network access in tests is forbidden)`)
    }
    const match = url.pathname.match(/^\/admin\/api\/[^/]+\/(.+)\.json$/)
    if (!match) return json(404, { errors: `mock: unhandled path ${url.pathname}` })
    const path = match[1]
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path, body })

    if (path === 'products' && method === 'GET') return json(200, { products: [serializeProduct(product)] })
    if (path === `products/${product.id}` && method === 'GET') return json(200, { product: serializeProduct(product) })
    if (path === `products/${product.id}` && method === 'PUT') {
      if (failProductPut) {
        failProductPut = false
        return json(500, { errors: 'Internal Server Error' })
      }
      const input = body?.product ?? {}
      if (typeof input.title === 'string') product.title = input.title
      if (typeof input.body_html === 'string') product.body_html = input.body_html
      if (typeof input.tags === 'string') product.tags = input.tags
      product.updated_at = new Date().toISOString()
      return json(200, { product: serializeProduct(product) })
    }
    if (path === `variants/${product.variants[0].id}` && method === 'PUT') {
      const input = body?.variant ?? {}
      if (input.price != null) product.variants[0].price = String(input.price)
      if (input.compare_at_price != null) product.variants[0].compare_at_price = String(input.compare_at_price)
      return json(200, { variant: serializeVariant(product.variants[0]) })
    }
    if (path === 'locations' && method === 'GET') return json(200, { locations: [{ id: 1, name: 'Main Store' }] })
    if (path === 'inventory_items/7000001' && method === 'PUT') return json(200, { inventory_item: { id: 7_000_001, tracked: true } })
    if (path === 'inventory_levels/set' && method === 'POST') {
      const { inventory_item_id, location_id, available } = body ?? {}
      levels.set(Number(inventory_item_id), Number(available))
      return json(200, { inventory_level: { inventory_item_id, location_id, available } })
    }
    if (path === 'inventory_levels' && method === 'GET') {
      return json(200, {
        inventory_levels: [...levels.entries()].map(([inventory_item_id, available]) => ({
          inventory_item_id,
          location_id: 1,
          available,
        })),
      })
    }

    unmatched.push(`${method} ${path}`)
    return json(404, { errors: `mock: no handler for ${method} ${path}` })
  }

  return {
    fetchImpl,
    calls,
    unmatched,
    product,
    level: () => levels.get(7_000_001),
    failNextProductPut: () => {
      failProductPut = true
    },
    resetCalls: () => {
      calls.length = 0
    },
  }
}

test(
  'ERP edits are queued, pushed by the worker, and retried on failure',
  { skip: baseDbUrl ? false : 'DATABASE_URL is not set — needs a local PostgreSQL to create the scratch database' },
  async () => {
    const admin = postgres(baseDbUrl, { max: 1 })
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
      await admin.unsafe(`CREATE DATABASE ${TEST_DB}`)
    } finally {
      await admin.end({ timeout: 5 })
    }

    // Env BEFORE any src/ module is imported (config + db/client cache env at
    // import time; node --test isolates this file in its own process).
    process.env.DATABASE_URL = scratchUrl(baseDbUrl)
    process.env.SHOPIFY_STORE_URL = `https://${MOCK_HOST}`
    process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_mock_outbound_test'
    process.env.SHOPIFY_API_VERSION = '2025-10'

    const mock = makeMockShopify()
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fetchImpl

    let rawClient: { end: (opts?: { timeout?: number }) => Promise<void> } | null | undefined
    try {
      const { bootstrapDatabase } = await import('./db/bootstrap')
      const boot = await bootstrapDatabase()
      assert.equal(boot.tablesCreated, true, 'fresh scratch schema must be created')

      const { db, getRawClient, schema: s } = await import('./db/client')
      assert.ok(db, 'scratch database must be connected')
      rawClient = getRawClient()

      const outbound = await import('./shopifyOutbound')
      const shopify = await import('./shopify')

      const productId = randomUUID()
      await db.insert(s.products).values({
        id: productId,
        name: 'Outbound Ring',
        sku: 'OUTBOUND-001',
        category: 'Rings',
        purity: 92.5,
        netWeight: 4,
        makingCharge: 300,
        silverRate: 92.8,
        gst: 3,
        stock: 4,
        sellingPrice: 1000,
        shopifyId: String(mock.product.id),
        shopifyStatus: 'synced',
        status: 'active',
        trackInventory: true,
        chargeOnTax: true,
        createdAt: '2026-10-14',
      })

      // ── 1. A save queues content/price/stock once per resource ──────────
      const queued = await outbound.queueProductOutbound(
        { id: productId, shopifyId: String(mock.product.id) },
        { content: true, price: true, inventory: true },
      )
      assert.deepEqual(queued.queued.sort(), ['inventory', 'price', 'product'], 'all three intents queued')
      // Ten more edits of the same product must not multiply the work.
      for (let i = 0; i < 3; i++) {
        await outbound.queueProductOutbound({ id: productId, shopifyId: String(mock.product.id) }, { content: true })
      }
      const jobRows = await db.select().from(s.shopifySyncJobs)
      assert.equal(jobRows.length, 3, 'idempotency key keeps one job per kind + product')
      assert.ok(jobRows.every((j) => j.status === 'pending'))

      // ── 2. The worker pushes all three to Shopify ───────────────────────
      const firstTick = await outbound.runOutboundShopifyJobs()
      assert.equal(firstTick.failed, 0, 'no failures on the happy path')
      assert.equal(firstTick.processed, 3, 'all three jobs completed')

      const productPut = mock.calls.find((c) => c.method === 'PUT' && c.path === `products/${mock.product.id}`)
      assert.ok(productPut, 'content push must PUT the listing')
      assert.equal(productPut.body.product.title, 'Outbound Ring', 'ERP title reached Shopify')
      const variantPut = mock.calls.find((c) => c.method === 'PUT' && c.path.startsWith('variants/'))
      assert.ok(variantPut, 'price push must PUT the variant')
      assert.equal(variantPut.body.variant.price, '1000.00', 'ERP selling price reached the variant')
      assert.equal(mock.level(), 4, 'ERP stock reached the Shopify location')

      const done = await db.select().from(s.shopifySyncJobs)
      assert.ok(done.every((j) => j.status === 'done'), 'every job settles as done')

      const logs = await db.select().from(s.syncLogs)
      const outboundLogs = logs.filter((l) => l.direction === 'out' && l.status === 'success')
      assert.ok(outboundLogs.length >= 3, 'each outbound resource writes a sync log')
      assert.ok(
        ['Product', 'Price', 'Inventory'].every((entity) => outboundLogs.some((l) => l.entity === entity)),
        'product, price and inventory outcomes are individually logged',
      )

      // ── 3. A failed push is logged and retryable, then succeeds ─────────
      mock.resetCalls()
      await db.update(s.products).set({ name: 'Outbound Ring v2' }).where(eq(s.products.id, productId))
      await outbound.queueProductOutbound({ id: productId, shopifyId: String(mock.product.id) }, { content: true })
      mock.failNextProductPut()
      const failedTick = await outbound.runOutboundShopifyJobs()
      assert.equal(failedTick.failed, 1, 'the outage is reported as a failed job, not a success')

      const [pending] = await db.select().from(s.shopifySyncJobs).where(eq(s.shopifySyncJobs.kind, 'product'))
      assert.equal(pending.status, 'pending', 'a retryable failure stays queued')
      assert.equal(pending.attempts, 1)
      assert.match(String(pending.lastError), /500|Internal Server Error/, 'the Shopify error is stored')
      const failureLog = (await db.select().from(s.syncLogs)).find((l) => l.status === 'failed')
      assert.ok(failureLog, 'the failure is written to the sync log')
      assert.equal(failureLog?.retry, true, 'the log marks the failure retryable')

      // Next tick before the backoff window: nothing is due yet.
      const early = await outbound.runOutboundShopifyJobs()
      assert.equal(early.processed, 0, 'backoff is respected')

      // Make it due (what the 30s timer would do) and retry.
      await db
        .update(s.shopifySyncJobs)
        .set({ nextAttemptAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(s.shopifySyncJobs.kind, 'product'))
      const retryTick = await outbound.runOutboundShopifyJobs()
      assert.equal(retryTick.failed, 0)
      assert.equal(mock.product.title, 'Outbound Ring v2', 'the retry applied the ERP edit')
      const [settled] = await db.select().from(s.shopifySyncJobs).where(eq(s.shopifySyncJobs.kind, 'product'))
      assert.equal(settled.status, 'done', 'the retry clears the job')

      // ── 4. Stock movements queue an inventory push; the pull does not ───
      mock.resetCalls()
      const { applyStockMovement } = await import('./stock')
      await applyStockMovement({
        sku: 'OUTBOUND-001',
        qty: 2,
        type: 'count_adjust',
        note: 'queue test',
        createdBy: 'test',
      })
      const [queuedInventory] = await db
        .select()
        .from(s.shopifySyncJobs)
        .where(eq(s.shopifySyncJobs.kind, 'inventory'))
      assert.equal(queuedInventory.status, 'pending', 'an ERP stock change queues a Shopify push')
      await outbound.runOutboundShopifyJobs()
      assert.equal(mock.level(), 6, 'the queued stock push lands on the Shopify location')

      // The inbound pull's own movement type must never echo back.
      await applyStockMovement({
        sku: 'OUTBOUND-001',
        qty: -1,
        type: 'shopify_sync',
        note: 'pull test',
        createdBy: 'system',
      })
      const [afterPull] = await db
        .select()
        .from(s.shopifySyncJobs)
        .where(eq(s.shopifySyncJobs.kind, 'inventory'))
      assert.equal(afterPull.status, 'done', 'a shopify_sync movement does not re-queue a push')

      // ── 5. An unlisted product is skipped, never created implicitly ─────
      const localOnly = randomUUID()
      await db.insert(s.products).values({
        id: localOnly,
        name: 'Local Only',
        sku: 'OUTBOUND-LOCAL',
        category: 'Rings',
        purity: 92.5,
        stock: 1,
        sellingPrice: 500,
        shopifyStatus: 'not-listed',
        status: 'active',
        createdAt: '2026-10-14',
      })
      const skippedQueue = await outbound.queueProductOutbound({ id: localOnly, shopifyId: null }, { content: true })
      assert.deepEqual(skippedQueue.queued, [], 'unlisted products are not queued')
      assert.equal(skippedQueue.skipped, 'not listed on Shopify')

      // No created listing for it (stock pushes also POST, so match the listing endpoint).
      assert.equal(
        mock.calls.filter((c) => c.method === 'POST' && c.path === 'products').length,
        0,
        'no product was created on Shopify',
      )

      // ── 6. Pending work protects ERP values from the inbound pull ───────
      await db
        .update(s.products)
        .set({ name: 'Edited In ERP', stock: 9 })
        .where(eq(s.products.id, productId))
      await outbound.queueProductOutbound({ id: productId, shopifyId: String(mock.product.id) }, { content: true })
      const pendingIds = await outbound.pendingShopifyProductIds()
      assert.ok(pendingIds.has(productId), 'the pending edit is visible to the pull')

      const pull = await shopify.syncProductsToDb()
      assert.equal(pull.ok, true, `pull failed: ${pull.errors.join('; ')}`)
      const [afterProtectedPull] = await db.select().from(s.products).where(eq(s.products.id, productId))
      assert.equal(afterProtectedPull.name, 'Edited In ERP', 'the pull kept the queued ERP title')
      assert.equal(mock.product.title, 'Outbound Ring v2', 'Shopify still has the pre-edit title')

      // Once pushed, the store catches up and a later pull agrees.
      await outbound.runOutboundShopifyJobs()
      assert.equal(mock.product.title, 'Edited In ERP', 'the queued edit then reached Shopify')

      // ── 7. A claim interrupted by a restart becomes processable again ───
      // A job is only ever moved out of `running` by its own settle. Killed
      // between claim and settle (deploy, SIGKILL, OOM), the row would sit in
      // `running` for ever: never retried, and the inbound pull would keep
      // treating that product as "push pending" for ever too. This is the
      // regression for that freeze.
      await db.update(s.products).set({ name: 'Interrupted Edit' }).where(eq(s.products.id, productId))
      await outbound.queueProductOutbound({ id: productId, shopifyId: String(mock.product.id) }, { content: true })
      await db
        .update(s.shopifySyncJobs)
        .set({ status: 'running', attempts: 1, updatedAt: new Date().toISOString() })
        .where(eq(s.shopifySyncJobs.kind, 'product'))

      // (a) a claim this fresh may still belong to a live worker: a tick must
      // not steal it, or two workers would push the same product at once.
      const inFlight = await outbound.runOutboundShopifyJobs()
      assert.equal(inFlight.processed, 0, 'a fresh claim is left to the worker that holds it')
      assert.equal(mock.product.title, 'Edited In ERP', 'nothing was pushed for the in-flight claim')
      const [held] = await db.select().from(s.shopifySyncJobs).where(eq(s.shopifySyncJobs.kind, 'product'))
      assert.equal(held.status, 'running', 'the in-flight row is untouched')

      // (b) a restart re-arms it immediately instead of waiting out the window.
      const bootRecovered = await outbound.recoverInterruptedOutboundJobs({ staleAfterMs: 0 })
      assert.equal(bootRecovered, 1, 'the boot pass re-arms what the previous process was holding')
      const [rearmed] = await db.select().from(s.shopifySyncJobs).where(eq(s.shopifySyncJobs.kind, 'product'))
      assert.equal(rearmed.status, 'pending', 'the interrupted job is processable again')
      assert.equal(rearmed.attempts, 1, 'the interrupted attempt still counts against the retry budget')

      const resumed = await outbound.runOutboundShopifyJobs()
      assert.equal(resumed.processed, 1, 'the recovered job ran')
      assert.equal(mock.product.title, 'Interrupted Edit', 'the interrupted push reached Shopify')
      const [afterResume] = await db.select().from(s.shopifySyncJobs).where(eq(s.shopifySyncJobs.kind, 'product'))
      assert.equal(afterResume.status, 'done', 'the recovered job settles like any other')

      // ── 8. A claim that dies while the server stays up is also recovered ─
      // The boot pass only runs once, so an interruption after start-up is
      // caught by the tick's staleness window instead.
      await db.update(s.products).set({ name: 'Crashed Edit' }).where(eq(s.products.id, productId))
      await outbound.queueProductOutbound({ id: productId, shopifyId: String(mock.product.id) }, { content: true })
      await db
        .update(s.shopifySyncJobs)
        .set({
          status: 'running',
          attempts: 1,
          updatedAt: new Date(Date.now() - outbound.STALE_RUNNING_MS - 60_000).toISOString(),
        })
        .where(eq(s.shopifySyncJobs.kind, 'product'))

      const staleTick = await outbound.runOutboundShopifyJobs()
      assert.equal(staleTick.processed, 1, 'a stalled claim is recovered by the tick itself')
      assert.equal(mock.product.title, 'Crashed Edit', 'the recovered push reached Shopify')
      const [afterStall] = await db.select().from(s.shopifySyncJobs).where(eq(s.shopifySyncJobs.kind, 'product'))
      assert.equal(afterStall.status, 'done', 'the recovered job settles')
    } finally {
      globalThis.fetch = originalFetch
      try {
        await rawClient?.end({ timeout: 5 })
      } catch {
        /* pool may already be closed */
      }
      const admin2 = postgres(baseDbUrl, { max: 1 })
      try {
        await admin2.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
      } catch {
        /* scratch cleanup is best-effort */
      }
      await admin2.end({ timeout: 5 })
    }
  },
)
