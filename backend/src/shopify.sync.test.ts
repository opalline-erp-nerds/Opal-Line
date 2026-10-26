// End-to-end integration test of the two-way Shopify product sync: the REAL
// sync code — pushProductsToShopify (create + update paths), syncProductsToDb
// (full catalog pull), pushProductPriceToShopify and pushInventoryToShopify —
// running against a faithful in-memory mock of the Shopify Admin REST API.
//
// Everything below the fetch boundary is exercised for real: URL construction,
// auth headers, payload shapes, collection membership (create + change +
// remove), variant set reconciliation and inventory levels. No credentials and
// no network are involved; the scheduled live check
// (.github/workflows/live-sync-check.yml) remains the against-the-store
// companion.
//
// The run happens in a THROWAWAY database (opal_line_sync_test) because
// syncProductsToDb() deletes local rows that are missing from the live store —
// against the dev catalog with a mock store holding only the test product,
// that would wipe every dev row. Skipping when DATABASE_URL is unset follows
// the same convention as src/db/upgrade.test.ts.
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'

const baseDbUrl = process.env.DATABASE_URL?.trim() ?? ''
const TEST_DB = 'opal_line_sync_test'
const MOCK_HOST = 'mock-sync-test.myshopify.com'

function scratchUrl(base: string): string {
  const url = new URL(base)
  url.pathname = `/${TEST_DB}`
  return url.toString()
}

// ─── Mock Shopify Admin REST API ─────────────────────────────────────────────

interface MockVariant {
  id: number
  product_id: number
  title: string
  option1: string | null
  option2: string | null
  option3: string | null
  sku: string
  barcode: string | null
  price: string
  compare_at_price: string | null
  inventory_management: string | null
  taxable: boolean
  inventory_item_id: number
  position: number
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
  options: Array<{ name: string; values: string[] }>
  variants: MockVariant[]
  images: Array<{ id: number; src: string; alt: string | null }>
  created_at: string
  updated_at: string
}

interface MockCall {
  method: string
  path: string
  body: any
}

function makeMockShopify() {
  const products = new Map<number, MockProduct>()
  const collections = new Map<number, { id: number; title: string }>()
  const collects = new Map<number, { id: number; product_id: number; collection_id: number }>()
  /** `${inventory_item_id}:${location_id}` → available */
  const levels = new Map<string, { inventory_item_id: number; location_id: number; available: number }>()
  const calls: MockCall[] = []
  const unmatched: string[] = []
  let nextProductId = 9_000_000_000_001
  let nextVariantId = 9_100_000_000_001
  let nextItemId = 9_200_000_000_001
  let nextCollectionId = 9_300_000_000_001
  let nextCollectId = 9_400_000_000_001
  let nextImageId = 9_500_000_000_001

  const availableFor = (itemId: number): number => {
    let total = 0
    for (const lvl of levels.values()) {
      if (lvl.inventory_item_id === itemId) total += lvl.available
    }
    return total
  }

  const serializeVariant = (v: MockVariant) => ({
    id: v.id,
    product_id: v.product_id,
    title: v.title,
    option1: v.option1,
    option2: v.option2,
    option3: v.option3,
    sku: v.sku,
    barcode: v.barcode,
    price: v.price,
    compare_at_price: v.compare_at_price,
    inventory_management: v.inventory_management,
    taxable: v.taxable,
    inventory_item_id: v.inventory_item_id,
    inventory_quantity: availableFor(v.inventory_item_id),
    position: v.position,
  })

  const serializeProduct = (p: MockProduct) => ({
    id: p.id,
    title: p.title,
    handle: p.handle,
    body_html: p.body_html,
    vendor: p.vendor,
    product_type: p.product_type,
    tags: p.tags,
    status: p.status,
    options: p.options,
    variants: p.variants.map(serializeVariant),
    images: p.images,
    created_at: p.created_at,
    updated_at: p.updated_at,
    admin_graphql_api_id: `gid://shopify/Product/${p.id}`,
  })

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const now = (): string => new Date().toISOString()

  const variantTitle = (v: { option1?: string | null; option2?: string | null; option3?: string | null }): string =>
    [v.option1, v.option2, v.option3].filter((x) => Boolean(x && String(x).trim())).join(' / ') || 'Default Title'

  const makeVariant = (productId: number, input: any, position: number): MockVariant => ({
    id: ++nextVariantId,
    product_id: productId,
    title: variantTitle(input ?? {}),
    option1: input?.option1 ?? null,
    option2: input?.option2 ?? null,
    option3: input?.option3 ?? null,
    sku: String(input?.sku ?? ''),
    barcode: input?.barcode ?? null,
    price: String(input?.price ?? '0.00'),
    compare_at_price: input?.compare_at_price ?? null,
    inventory_management: input?.inventory_management ?? null,
    taxable: input?.taxable ?? true,
    inventory_item_id: ++nextItemId,
    position,
  })

  const findVariant = (id: number): { product: MockProduct; variant: MockVariant } | null => {
    for (const product of products.values()) {
      const variant = product.variants.find((v) => v.id === id)
      if (variant) return { product, variant }
    }
    return null
  }

  async function fetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname !== MOCK_HOST) {
      throw new Error(`mock Shopify fetch: unexpected host "${url.hostname}" (network access in tests is forbidden)`)
    }
    const match = url.pathname.match(/^\/admin\/api\/[^/]+\/(.+)\.json$/)
    if (!match) return json(404, { errors: `mock: unhandled path ${url.pathname}` })
    const parts = match[1].split('/')
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path: parts.join('/'), body })

    // ── products collection ──────────────────────────────────────────────
    if (parts.length === 1 && parts[0] === 'products') {
      if (method === 'GET') {
        return json(200, { products: [...products.values()].map(serializeProduct) })
      }
      if (method === 'POST') {
        const input = body?.product ?? {}
        const id = ++nextProductId
        const variantInputs: any[] = Array.isArray(input.variants) && input.variants.length > 0 ? input.variants : [{}]
        const product: MockProduct = {
          id,
          title: String(input.title ?? ''),
          handle: String(input.handle ?? `${String(input.title ?? 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id}`),
          body_html: String(input.body_html ?? ''),
          vendor: String(input.vendor ?? ''),
          product_type: String(input.product_type ?? ''),
          tags: String(input.tags ?? ''),
          status: String(input.status ?? 'active'),
          options: Array.isArray(input.options) ? input.options.map((o: any) => ({ name: String(o?.name ?? ''), values: (o?.values ?? []).map(String) })) : [],
          variants: variantInputs.map((v, i) => makeVariant(id, v, i + 1)),
          images: (Array.isArray(input.images) ? input.images : []).map((img: any) => ({
            id: ++nextImageId,
            src: `https://cdn.shopify.com/s/files/mock/${id}/${++nextImageId}.jpg`,
            alt: img?.alt ?? null,
          })),
          created_at: now(),
          updated_at: now(),
        }
        products.set(id, product)
        return json(200, { product: serializeProduct(product) })
      }
    }

    // ── single product ───────────────────────────────────────────────────
    if (parts.length === 2 && parts[0] === 'products') {
      const id = Number(parts[1])
      const product = products.get(id)
      if (!product) return json(404, { errors: 'Not Found' })
      if (method === 'GET') return json(200, { product: serializeProduct(product) })
      if (method === 'DELETE') {
        products.delete(id)
        return json(200, {})
      }
      if (method === 'PUT') {
        const input = body?.product ?? {}
        // Shopify merges PUTs: only provided keys change.
        if (input.title != null) product.title = String(input.title)
        if (input.body_html != null) product.body_html = String(input.body_html)
        if (input.vendor != null) product.vendor = String(input.vendor)
        if (input.product_type != null) product.product_type = String(input.product_type)
        if (input.tags != null) product.tags = String(input.tags)
        if (input.status != null) product.status = String(input.status)
        if (Array.isArray(input.options)) {
          product.options = input.options.map((o: any) => ({ name: String(o?.name ?? ''), values: (o?.values ?? []).map(String) }))
        }
        if (Array.isArray(input.variants)) {
          for (const v of input.variants) {
            if (v?.id != null) {
              const existing = product.variants.find((x) => x.id === Number(v.id))
              if (!existing) return json(404, { errors: `variant ${v.id} not found` })
              if (v.option1 !== undefined) existing.option1 = v.option1
              if (v.option2 !== undefined) existing.option2 = v.option2
              if (v.option3 !== undefined) existing.option3 = v.option3
              if (v.sku !== undefined) existing.sku = String(v.sku)
              if (v.barcode !== undefined) existing.barcode = v.barcode
              if (v.price !== undefined) existing.price = String(v.price)
              if (v.compare_at_price !== undefined) existing.compare_at_price = v.compare_at_price
              if (v.inventory_management !== undefined) existing.inventory_management = v.inventory_management
              if (v.taxable !== undefined) existing.taxable = Boolean(v.taxable)
              existing.title = variantTitle(existing)
            } else {
              product.variants.push(makeVariant(product.id, v, product.variants.length + 1))
            }
          }
        }
        product.updated_at = now()
        return json(200, { product: serializeProduct(product) })
      }
    }

    // ── product images ───────────────────────────────────────────────────
    if (parts.length === 3 && parts[0] === 'products' && parts[2] === 'images' && method === 'POST') {
      const id = Number(parts[1])
      const product = products.get(id)
      if (!product) return json(404, { errors: 'Not Found' })
      const img = body?.image ?? {}
      const created = { id: ++nextImageId, src: `https://cdn.shopify.com/s/files/mock/${id}/${nextImageId}.jpg`, alt: img?.alt ?? null }
      product.images.push(created)
      return json(200, { image: created })
    }

    // ── single variant ───────────────────────────────────────────────────
    if (parts.length === 2 && parts[0] === 'variants') {
      const hit = findVariant(Number(parts[1]))
      if (!hit) return json(404, { errors: 'Not Found' })
      if (method === 'PUT') {
        const input = body?.variant ?? {}
        const v = hit.variant
        if (input.price !== undefined) v.price = String(input.price)
        if (input.compare_at_price !== undefined) v.compare_at_price = input.compare_at_price
        if (input.sku !== undefined) v.sku = String(input.sku)
        if (input.barcode !== undefined) v.barcode = input.barcode
        if (input.option1 !== undefined) v.option1 = input.option1
        if (input.option2 !== undefined) v.option2 = input.option2
        if (input.option3 !== undefined) v.option3 = input.option3
        if (input.inventory_management !== undefined) v.inventory_management = input.inventory_management
        if (input.taxable !== undefined) v.taxable = Boolean(input.taxable)
        v.title = variantTitle(v)
        return json(200, { variant: serializeVariant(v) })
      }
      if (method === 'DELETE') {
        hit.product.variants = hit.product.variants.filter((v) => v.id !== hit.variant.id)
        hit.product.updated_at = now()
        return json(200, {})
      }
    }

    // ── inventory ────────────────────────────────────────────────────────
    if (parts.length === 1 && parts[0] === 'inventory_levels' && method === 'GET') {
      return json(200, { inventory_levels: [...levels.values()] })
    }
    if (parts.length === 2 && parts[0] === 'inventory_levels' && parts[1] === 'set' && method === 'POST') {
      const itemId = Number(body?.inventory_item_id)
      const locationId = Number(body?.location_id)
      const available = Number(body?.available)
      levels.set(`${itemId}:${locationId}`, { inventory_item_id: itemId, location_id: locationId, available })
      return json(200, { inventory_level: { inventory_item_id: itemId, location_id: locationId, available } })
    }
    if (parts.length === 2 && parts[0] === 'inventory_items' && method === 'PUT') {
      return json(200, { inventory_item: { id: Number(parts[1]), tracked: body?.inventory_item?.tracked ?? true } })
    }
    if (parts.length === 1 && parts[0] === 'locations' && method === 'GET') {
      return json(200, { locations: [{ id: 1, name: 'Main Store' }] })
    }

    // ── collections + membership ─────────────────────────────────────────
    if (parts.length === 1 && parts[0] === 'custom_collections') {
      if (method === 'GET') return json(200, { custom_collections: [...collections.values()] })
      if (method === 'POST') {
        const id = ++nextCollectionId
        collections.set(id, { id, title: String(body?.custom_collection?.title ?? '') })
        return json(200, { custom_collection: { id, title: collections.get(id)!.title } })
      }
    }
    if (parts.length === 1 && parts[0] === 'smart_collections' && method === 'GET') {
      // The mock store has no smart (rule-driven) collections.
      return json(200, { smart_collections: [] })
    }
    if (parts.length === 1 && parts[0] === 'collects') {
      if (method === 'GET') {
        const productId = url.searchParams.get('product_id')
        const collectionId = url.searchParams.get('collection_id')
        const rows = [...collects.values()].filter(
          (c) =>
            (productId == null || String(c.product_id) === productId) &&
            (collectionId == null || String(c.collection_id) === collectionId),
        )
        return json(200, { collects: rows })
      }
      if (method === 'POST') {
        const productId = Number(body?.collect?.product_id)
        const collectionId = Number(body?.collect?.collection_id)
        const exists = [...collects.values()].some((c) => c.product_id === productId && c.collection_id === collectionId)
        // Real Shopify rejects a duplicate membership with 422/409.
        if (exists) return json(422, { errors: 'Product is already in this collection' })
        const id = ++nextCollectId
        collects.set(id, { id, product_id: productId, collection_id: collectionId })
        return json(200, { collect: { id, product_id: productId, collection_id: collectionId } })
      }
    }
    if (parts.length === 2 && parts[0] === 'collects' && method === 'DELETE') {
      collects.delete(Number(parts[1]))
      return json(200, {})
    }

    unmatched.push(`${method} ${parts.join('/')}`)
    return json(404, { errors: `mock: no handler for ${method} ${parts.join('/')}` })
  }

  return {
    fetchImpl,
    calls,
    unmatched,
    products,
    collections,
    collects,
    levels,
    availableFor,
    product: (id: string | number): MockProduct => {
      const p = products.get(Number(id))
      if (!p) throw new Error(`mock: no product ${id}`)
      return p
    },
    variantBySku: (sku: string): MockVariant => {
      for (const p of products.values()) {
        const v = p.variants.find((x) => x.sku === sku)
        if (v) return v
      }
      throw new Error(`mock: no variant with sku ${sku}`)
    },
    collectionIdByTitle: (title: string): number => {
      for (const c of collections.values()) {
        if (c.title === title) return c.id
      }
      throw new Error(`mock: no collection "${title}"`)
    },
    memberCollectionIds: (productId: number): number[] =>
      [...collects.values()].filter((c) => c.product_id === productId).map((c) => c.collection_id),
  }
}

// ─── The test ────────────────────────────────────────────────────────────────

test(
  'Shopify product sync round-trip (real sync code, mock Admin API, scratch DB)',
  { skip: baseDbUrl ? false : 'DATABASE_URL is not set — needs a local PostgreSQL to create the scratch database' },
  async () => {
    // 1. Scratch database, created/dropped around the run.
    const admin = postgres(baseDbUrl, { max: 1 })
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
      await admin.unsafe(`CREATE DATABASE ${TEST_DB}`)
    } finally {
      await admin.end({ timeout: 5 })
    }

    // 2. Env BEFORE any src/ module is imported (config + db/client cache env
    //    at import time; node --test isolates this file in its own process).
    process.env.DATABASE_URL = scratchUrl(baseDbUrl)
    process.env.SHOPIFY_STORE_URL = `https://${MOCK_HOST}`
    process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_mock_integration_test'
    process.env.SHOPIFY_API_VERSION = '2025-10'

    const mock = makeMockShopify()
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fetchImpl

    let rawClient: { end: (opts?: { timeout?: number }) => Promise<void> } | null | undefined
    try {
      // 3. The app's own first-run bootstrap creates the full schema — the
      //    exact DDL a fresh desktop install runs.
      const { bootstrapDatabase } = await import('./db/bootstrap')
      const boot = await bootstrapDatabase()
      assert.equal(boot.tablesCreated, true, 'fresh scratch schema must be created')

      const { db, getRawClient, schema: s } = await import('./db/client')
      assert.ok(db, 'scratch database must be connected')
      rawClient = getRawClient()

      const { config } = await import('./config')
      assert.equal(config.shop, 'mock-sync-test', 'mock store domain must be picked up')
      assert.equal(config.accessToken, 'shpat_mock_integration_test')

      const shopify = await import('./shopify')

      // ── Seed a local Shopify-style product (parent + Size variants) ────
      const p1 = randomUUID()
      const vS = randomUUID()
      const vM = randomUUID()
      await db.insert(s.products).values({
        id: p1,
        name: 'Mock Sync Ring',
        sku: 'MOCK-SYNC-001',
        category: 'Rings',
        collection: 'Rings',
        purity: 92.5,
        netWeight: 4.2,
        makingCharge: 300,
        silverRate: 92.8,
        gst: 3,
        stock: 5,
        reorderLevel: 2,
        shopifyStatus: 'not-listed',
        status: 'active',
        trackInventory: true,
        chargeOnTax: true,
        sellingPrice: 1000,
        options: [{ name: 'Size', values: ['S', 'M'] }],
        createdAt: '2026-10-14',
      })
      await db.insert(s.productVariants).values([
        { id: vS, productId: p1, title: 'S', optionValues: ['S'], sku: 'MOCK-SYNC-001-S', sellingPrice: 950, stock: 2, status: 'active' },
        { id: vM, productId: p1, title: 'M', optionValues: ['M'], sku: 'MOCK-SYNC-001-M', sellingPrice: 1050, stock: 3, status: 'active' },
      ])

      // ── Phase 1: PUSH (create listing + collection + inventory) ────────
      const push1 = await shopify.pushProductsToShopify([p1])
      assert.equal(push1.ok, true, `push create failed: ${push1.errors.join('; ')}`)
      assert.equal(push1.created, 1, 'exactly one listing created')

      const postProduct = mock.calls.find((c) => c.method === 'POST' && c.path === 'products')
      assert.ok(postProduct, 'POST /admin/api/../products.json must have been called')
      const payload = postProduct.body.product
      assert.equal(payload.title, 'Mock Sync Ring')
      assert.equal(payload.status, 'active')
      assert.equal(payload.product_type, 'Rings')
      assert.match(String(payload.tags), /opal-collection:Rings/, 'collection encoded in tags')
      assert.deepEqual(payload.options, [{ name: 'Size', values: ['S', 'M'] }], 'options travel with the create')
      assert.equal(payload.variants.length, 2)
      assert.deepEqual(
        payload.variants.map((v: any) => [v.option1, v.sku, v.price]),
        [
          ['S', 'MOCK-SYNC-001-S', '950.00'],
          ['M', 'MOCK-SYNC-001-M', '1050.00'],
        ],
        'one variant per option value, with per-variant SKU and price',
      )
      assert.ok(
        payload.variants.every((v: any) => v.inventory_management === 'shopify'),
        'variants are inventory-managed',
      )

      const [created1] = await db.select().from(s.products).where(eq(s.products.id, p1))
      assert.equal(created1.shopifyStatus, 'synced')
      const listingId = Number(created1.shopifyId)
      assert.ok(Number.isFinite(listingId) && listingId > 0, 'local row points at the new listing')

      const levelSets = mock.calls.filter((c) => c.method === 'POST' && c.path === 'inventory_levels/set')
      assert.deepEqual(
        levelSets.map((c) => c.body.available).sort((a: number, b: number) => a - b),
        [2, 3],
        'per-variant stock pushed to the matching inventory items',
      )
      assert.ok(levelSets.every((c) => c.body.location_id === 1), 'levels target the store location')

      const ringsId = mock.collectionIdByTitle('Rings')
      assert.deepEqual(mock.memberCollectionIds(listingId), [ringsId], 'listing is a member of the "Rings" collection')

      // ── Phase 2: PULL the catalog back into the local database ─────────
      const pull1 = await shopify.syncProductsToDb()
      assert.equal(pull1.ok, true, `pull failed: ${pull1.errors.join('; ')}`)
      assert.equal(pull1.created, 0, 'the pushed product must not be inserted again')
      assert.equal(pull1.updated, 1, 'the pushed product is updated in place')
      assert.equal(pull1.removed, 0, 'nothing removed — the listing is live')

      const [pulled] = await db.select().from(s.products).where(eq(s.products.id, p1))
      assert.equal(pulled.shopifyId, String(listingId))
      assert.deepEqual(pulled.options, [{ name: 'Size', values: ['S', 'M'] }], 'options round-trip through the pull')
      assert.equal(pulled.stock, 5, 'parent stock = SUM of the variant inventory levels (2 + 3)')
      assert.ok(String(pulled.createdAt).startsWith('2026-10-14'), 'pull keeps the local created date')

      const pulledVariants = await db.select().from(s.productVariants).where(eq(s.productVariants.productId, p1))
      assert.equal(pulledVariants.length, 2, 'variant rows replaced from the listing')
      const bySku = new Map(pulledVariants.map((v: any) => [v.sku, v]))
      assert.equal(bySku.get('MOCK-SYNC-001-S')?.stock, 2)
      assert.equal(bySku.get('MOCK-SYNC-001-S')?.sellingPrice, 950)
      assert.equal(bySku.get('MOCK-SYNC-001-M')?.stock, 3)
      assert.equal(bySku.get('MOCK-SYNC-001-M')?.sellingPrice, 1050)
      // The pull replace-all re-creates variant rows under fresh ids — later
      // edits must target the CURRENT rows, not the pre-pull ones.
      const pulledM = bySku.get('MOCK-SYNC-001-M')!

      const dupes = await db.select().from(s.products).where(eq(s.products.sku, 'MOCK-SYNC-001-S'))
      assert.equal(dupes.length, 0, 'no duplicate parent row under a variant SKU')
      const totalProducts = await db.select().from(s.products)
      assert.equal(totalProducts.length, 1, 'exactly one local product')

      // ── Phase 3: EDIT → update push (new variant, new price, new collection)
      await db
        .update(s.products)
        .set({ collection: 'Chains', stock: 9, options: [{ name: 'Size', values: ['S', 'M', 'L'] }] })
        .where(eq(s.products.id, p1))
      await db.update(s.productVariants).set({ sellingPrice: 1100 }).where(eq(s.productVariants.id, pulledM.id))
      const vL = randomUUID()
      await db.insert(s.productVariants).values({
        id: vL,
        productId: p1,
        title: 'L',
        optionValues: ['L'],
        sku: 'MOCK-SYNC-001-L',
        sellingPrice: 1150,
        stock: 4,
        status: 'active',
      })

      const push2 = await shopify.pushProductsToShopify([p1])
      assert.equal(push2.ok, true, `update push failed: ${push2.errors.join('; ')}`)
      assert.equal(push2.updated, 1, 'linked product takes the update path')

      const productPuts = mock.calls.filter((c) => c.method === 'PUT' && c.path === `products/${listingId}`)
      assert.ok(productPuts.length >= 2, 'content PUT + options/variants PUT')
      const variantPut = productPuts[productPuts.length - 1].body.product
      assert.deepEqual(variantPut.options, [{ name: 'Size', values: ['S', 'M', 'L'] }], 'option values grow with the new variant')
      assert.equal(variantPut.variants.length, 3)
      const idS = mock.variantBySku('MOCK-SYNC-001-S').id
      const idM = mock.variantBySku('MOCK-SYNC-001-M').id
      const putBySku = new Map<string, any>(variantPut.variants.map((v: any): [string, any] => [String(v.sku), v]))
      assert.equal(putBySku.get('MOCK-SYNC-001-S')?.id, idS, 'existing variant matched back by SKU')
      assert.equal(putBySku.get('MOCK-SYNC-001-M')?.id, idM)
      assert.equal(putBySku.get('MOCK-SYNC-001-M')?.price, '1100.00', 'edited variant price pushed')
      assert.equal(putBySku.get('MOCK-SYNC-001-L')?.id, undefined, 'new combination arrives without an id')
      assert.equal(mock.variantBySku('MOCK-SYNC-001-L').price, '1150.00', 'mock listing grew the L variant')

      const chainsId = mock.collectionIdByTitle('Chains')
      assert.deepEqual(
        mock.memberCollectionIds(listingId),
        [chainsId],
        'collection move: old membership dropped, new one created',
      )

      // ── Phase 4: REMOVE a variant locally → push deletes it on Shopify ─
      await db.delete(s.productVariants).where(eq(s.productVariants.id, vL))
      await db
        .update(s.products)
        .set({ options: [{ name: 'Size', values: ['S', 'M'] }] })
        .where(eq(s.products.id, p1))
      const push3 = await shopify.pushProductsToShopify([p1])
      assert.equal(push3.ok, true, `variant-removal push failed: ${push3.errors.join('; ')}`)
      assert.equal(push3.updated, 1)
      assert.deepEqual(
        mock.product(listingId).variants.map((v) => v.sku),
        ['MOCK-SYNC-001-S', 'MOCK-SYNC-001-M'],
        'listing variant removed after the local variant was deleted',
      )

      // ── Phase 5: PRICE push ────────────────────────────────────────────
      await db.update(s.productVariants).set({ sellingPrice: 1200 }).where(eq(s.productVariants.id, pulledM.id))
      const priceRes = await shopify.pushProductPriceToShopify(p1)
      assert.equal(priceRes.ok, true, `price push failed: ${priceRes.errors.join('; ')}`)
      assert.equal(priceRes.updated, 2, 'both variants matched by SKU on the listing')
      const mPut = mock.calls.find((c) => c.method === 'PUT' && c.path === `variants/${idM}`)
      assert.ok(mPut, 'PUT /variants/:id sent for the M variant')
      assert.equal(mPut.body.variant.price, '1200.00')
      assert.equal(mock.variantBySku('MOCK-SYNC-001-M').price, '1200.00', 'listing carries the new price')

      // ── Phase 6: INVENTORY push ────────────────────────────────────────
      await db.update(s.productVariants).set({ stock: 7 }).where(eq(s.productVariants.id, pulledM.id))
      const invRes = await shopify.pushInventoryToShopify([p1])
      assert.equal(invRes.ok, true, `inventory push failed: ${invRes.errors.join('; ')}`)
      assert.equal(mock.availableFor(mock.variantBySku('MOCK-SYNC-001-S').inventory_item_id), 2, 'unchanged variant keeps its level')
      assert.equal(mock.availableFor(mock.variantBySku('MOCK-SYNC-001-M').inventory_item_id), 7, 'edited stock lands on the variant inventory item')

      // ── Phase 7: PULL again — everything round-trips, nothing is lost ──
      const pull2 = await shopify.syncProductsToDb()
      assert.equal(pull2.ok, true, `second pull failed: ${pull2.errors.join('; ')}`)
      assert.equal(pull2.created, 0)
      assert.equal(pull2.updated, 1)
      assert.equal(pull2.removed, 0)

      const [final] = await db.select().from(s.products).where(eq(s.products.id, p1))
      assert.equal(final.shopifyStatus, 'synced')
      assert.equal(final.collection, 'Chains', 'pulled collection reflects the Shopify membership')
      assert.equal(final.stock, 9, 'parent stock follows the pushed levels (2 + 7)')
      assert.ok(String(final.createdAt).startsWith('2026-10-14'), 'created date still untouched by pulls')

      const finalVariants = await db.select().from(s.productVariants).where(eq(s.productVariants.productId, p1))
      const finalBySku = new Map(finalVariants.map((v: any) => [v.sku, v]))
      assert.equal(finalVariants.length, 2)
      assert.equal(finalBySku.get('MOCK-SYNC-001-M')?.stock, 7)
      assert.equal(finalBySku.get('MOCK-SYNC-001-M')?.sellingPrice, 1200)
      assert.equal(finalBySku.get('MOCK-SYNC-001-S')?.stock, 2)
      assert.equal(finalBySku.get('MOCK-SYNC-001-S')?.sellingPrice, 950)
      assert.notEqual(finalBySku.get('MOCK-SYNC-001-M')?.id, pulledM.id, 'second pull replaced the variant rows again')

      assert.deepEqual(mock.unmatched, [], 'every Admin API endpoint the sync touches is modelled by the mock')
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
