// Variant pricing contract: the ERP-calculated selling price is the BASE for
// every variant. The "Add to price (₹)" delta lives in the dedicated
// product_variants.price_adjustment column, while selling_price is the
// EFFECTIVE price (base + add-on). Rows saved before the column existed still
// carry the delta in selling_price and must keep working. Final prices are
// derived, never written back into the base, so a repeated push or inbound pull
// can only re-derive the same price — it can never add the amount twice.
//
// Scenarios pinned here (faithful in-memory mock of the Admin REST API over a
// throwaway database — no credentials, no network, no real store):
//   1. create push sends 818.00 / 1018.00 for add-ons 200 / 400 on base 618
//   2. the price push (the exact function the outbound price job runs) agrees
//   3. repeated pushes + an inbound mirror keep 818/1018 and the add-ons
//   4. a silver-rate reprice moves the base and rebuilds base + add-on
//   5. a flat single-variant product still pushes its base (500, not 1000)
//   6. a legacy placeholder product (Title/Default Title options, absolute
//      mirror row 4800 on base 4738) pushes 4738 — never 4738 + 4800 = 9538
//   7. compare-at prices stay ABSOLUTE (never base + compare-at)
//
// Same scratch-DB convention as shopify.sync.test.ts: skipped without
// DATABASE_URL, and the fetch mock refuses any host but its own.
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'

const baseDbUrl = process.env.DATABASE_URL?.trim() ?? ''
const TEST_DB = 'opal_line_variant_pricing_test'
const MOCK_HOST = 'mock-variant-pricing.myshopify.com'

// CI sets REQUIRE_DB_TESTS=1 on the dedicated step: a runner that lost its
// database must fail loudly rather than report green on a suite that never
// executed (same guard as shopifyOutbound.test.ts).
if (process.env.REQUIRE_DB_TESTS === '1' && !baseDbUrl) {
  throw new Error('REQUIRE_DB_TESTS=1 but DATABASE_URL is not set — the variant-pricing suite would have been skipped')
}

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
  'Variant pricing = ERP base + additional amount (mock store, scratch DB)',
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
    process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_mock_variant_pricing_test'
    process.env.SHOPIFY_API_VERSION = '2025-10'

    const mock = makeMockShopify()
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fetchImpl

    let rawClient: { end: (opts?: { timeout?: number }) => Promise<void> } | null | undefined
    try {
      // 3. The app's own first-run bootstrap creates the full schema.
      const { bootstrapDatabase } = await import('./db/bootstrap')
      const boot = await bootstrapDatabase()
      assert.equal(boot.tablesCreated, true, 'fresh scratch schema must be created')

      const { db, getRawClient, schema: s } = await import('./db/client')
      assert.ok(db, 'scratch database must be connected')
      rawClient = getRawClient()

      const shopify = await import('./shopify')

      // ── The rule, as a pure function ────────────────────────────────────
      assert.equal(shopify.finalVariantPrice(618, 200), 818, 'base 618 + add-on 200 = 818')
      assert.equal(shopify.finalVariantPrice(618, 400), 1018, 'base 618 + add-on 400 = 1018')
      assert.equal(shopify.finalVariantPrice(618, 0), 618, 'no add-on → the base alone')
      assert.equal(shopify.finalVariantPrice(618, null), 618, 'an unpriced variant falls back to the base')
      assert.equal(shopify.finalVariantPrice(618.455, 200), 818.46, 'the sum rounds to cents')
      assert.equal(shopify.isDefaultVariantRow('Default Title', ['Default Title']), true, 'the flat-product placeholder')
      assert.equal(shopify.isDefaultVariantRow('', []), true, 'an unnamed row is a mirror')
      assert.equal(shopify.isDefaultVariantRow('S', ['S']), false, 'a real option row')
      assert.equal(
        shopify.variantPushPrice(4738, { title: 'Default Title', optionValues: ['Default Title'], sellingPrice: 4800 }),
        4738,
        'mirror row: the base wins over the legacy absolute value (4738 + 4800 pushed 9538 in the live check)',
      )
      assert.equal(
        shopify.variantPushPrice(618, { title: 'S', optionValues: ['S'], sellingPrice: 200 }),
        818,
        'legacy real option row: the delta in selling_price is still the add-on',
      )
      assert.equal(
        shopify.variantPushPrice(618, { title: 'S', optionValues: ['S'], sellingPrice: 818, priceAdjustment: 200 }),
        818,
        'new row: the effective sellingPrice is never added a second time',
      )

      // ── Product A: optioned, base 618, add-ons 200 / 400 ───────────────
      const pA = randomUUID()
      await db.insert(s.products).values({
        id: pA,
        name: 'Variant Pricing Ring',
        sku: 'VAR-PRICE-001',
        category: 'Rings',
        collection: 'Rings',
        purity: 92.5,
        gst: 3,
        stock: 2,
        shopifyStatus: 'not-listed',
        status: 'active',
        trackInventory: true,
        chargeOnTax: true,
        sellingPrice: 618,
        options: [{ name: 'Size', values: ['S', 'M'] }],
        createdAt: '2026-11-17',
      })
      await db.insert(s.productVariants).values([
        { id: randomUUID(), productId: pA, title: 'S', optionValues: ['S'], sku: 'VAR-PRICE-001-S', sellingPrice: 200, compareAtPrice: 900, stock: 1, status: 'active' },
        { id: randomUUID(), productId: pA, title: 'M', optionValues: ['M'], sku: 'VAR-PRICE-001-M', sellingPrice: 400, compareAtPrice: 1200, stock: 1, status: 'active' },
      ])

      // ── 1. Initial creation push ────────────────────────────────────────
      const push1 = await shopify.pushProductsToShopify([pA])
      assert.equal(push1.ok, true, `create push failed: ${push1.errors.join('; ')}`)
      assert.equal(push1.created, 1, 'exactly one listing created')
      const [listedA] = await db.select().from(s.products).where(eq(s.products.id, pA))
      const listingA = Number(listedA.shopifyId)
      assert.ok(Number.isFinite(listingA) && listingA > 0, 'local row points at the new listing')
      const createdVariants = new Map<string, any>(mock.product(listingA).variants.map((v) => [v.sku, v]))
      assert.equal(createdVariants.get('VAR-PRICE-001-S')?.price, '818.00', 'base 618 + add-on 200 → 818')
      assert.equal(createdVariants.get('VAR-PRICE-001-M')?.price, '1018.00', 'base 618 + add-on 400 → 1018')
      assert.equal(createdVariants.get('VAR-PRICE-001-S')?.compare_at_price, '900.00', 'compare-at stays absolute on create')
      assert.equal(createdVariants.get('VAR-PRICE-001-M')?.compare_at_price, '1200.00', 'compare-at stays absolute on create')

      // ── 2. Price push — the exact function the outbound price job runs ──
      const pricePush1 = await shopify.pushProductPriceToShopify(pA)
      assert.equal(pricePush1.ok, true, `price push failed: ${pricePush1.errors.join('; ')}`)
      assert.equal(pricePush1.updated, 2, 'both variants matched by SKU')
      assert.equal(mock.product(listingA).variants.find((v) => v.sku === 'VAR-PRICE-001-S')?.price, '818.00')
      assert.equal(mock.product(listingA).variants.find((v) => v.sku === 'VAR-PRICE-001-M')?.price, '1018.00')

      // ── 3. Repeated sync must not add the amount again ──────────────────
      const pricePush2 = await shopify.pushProductPriceToShopify(pA)
      assert.equal(pricePush2.ok, true, pricePush2.errors.join('; '))
      const push2 = await shopify.pushProductsToShopify([pA])
      assert.equal(push2.ok, true, `update push failed: ${push2.errors.join('; ')}`)
      const pull = await shopify.syncProductsToDb()
      assert.equal(pull.ok, true, `pull failed: ${pull.errors.join('; ')}`)
      assert.deepEqual(
        mock.product(listingA).variants.map((v) => [v.sku, v.price]),
        [['VAR-PRICE-001-S', '818.00'], ['VAR-PRICE-001-M', '1018.00']],
        'still base + add-on after repeated pushes and an inbound pull',
      )
      const rowsAfter = await db.select().from(s.productVariants).where(eq(s.productVariants.productId, pA))
      assert.deepEqual(
        rowsAfter.map((v) => [v.sku, Number(v.sellingPrice)]).sort(),
        [['VAR-PRICE-001-M', 400], ['VAR-PRICE-001-S', 200]],
        'the pull never rewrites the stored add-ons',
      )
      const [productAfterPull] = await db.select().from(s.products).where(eq(s.products.id, pA))
      assert.equal(Number(productAfterPull.sellingPrice), 618, 'the base survives the pull')

      // ── 4. Silver-rate style reprice: only products.selling_price moves ─
      await db.update(s.products).set({ sellingPrice: 700 }).where(eq(s.products.id, pA))
      const pricePush3 = await shopify.pushProductPriceToShopify(pA)
      assert.equal(pricePush3.ok, true, pricePush3.errors.join('; '))
      assert.equal(mock.product(listingA).variants.find((v) => v.sku === 'VAR-PRICE-001-S')?.price, '900.00', 'new base 700 + 200 → 900')
      assert.equal(mock.product(listingA).variants.find((v) => v.sku === 'VAR-PRICE-001-M')?.price, '1100.00', 'new base 700 + 400 → 1100')
      const push3 = await shopify.pushProductsToShopify([pA])
      assert.equal(push3.ok, true, push3.errors.join('; '))
      const variantPut = mock.calls.filter((c) => c.method === 'PUT' && c.path === `products/${listingA}`).pop()
      assert.ok(variantPut, 'the content push sends the options/variants PUT')
      const putBySku = new Map<string, any>(variantPut.body.product.variants.map((v: any): [string, any] => [String(v.sku), v]))
      assert.equal(putBySku.get('VAR-PRICE-001-S')?.price, '900.00', 'the update push carries base + add-on too')
      assert.equal(putBySku.get('VAR-PRICE-001-M')?.price, '1100.00')
      assert.equal(putBySku.get('VAR-PRICE-001-S')?.compare_at_price, '900.00', 'compare-at is never base + compare-at')
      const rowsAfterReprice = await db.select().from(s.productVariants).where(eq(s.productVariants.productId, pA))
      assert.deepEqual(
        rowsAfterReprice.map((v) => Number(v.sellingPrice)).sort((a, b) => a - b),
        [200, 400],
        'the reprice never touches the stored add-ons',
      )

      // ── 5. Flat single-variant product: the base alone, never doubled ───
      const pB = randomUUID()
      await db.insert(s.products).values({
        id: pB,
        name: 'Flat Pricing Pendant',
        sku: 'VAR-PRICE-FLAT',
        category: 'Pendants',
        collection: 'Pendants',
        gst: 3,
        stock: 1,
        shopifyStatus: 'not-listed',
        status: 'active',
        trackInventory: true,
        chargeOnTax: true,
        sellingPrice: 500,
        compareAtPrice: 700,
        options: null,
        createdAt: '2026-11-17',
      })
      // Legacy mirror row: a flat product's variant row is never an add-on.
      await db.insert(s.productVariants).values({
        id: randomUUID(),
        productId: pB,
        title: 'Default Title',
        optionValues: [],
        sku: 'VAR-PRICE-FLAT',
        sellingPrice: 500,
        stock: 1,
        status: 'active',
      })

      const pushB = await shopify.pushProductsToShopify([pB])
      assert.equal(pushB.ok, true, `flat create push failed: ${pushB.errors.join('; ')}`)
      assert.equal(pushB.created, 1, 'the flat product is created as its own listing')
      const [listedB] = await db.select().from(s.products).where(eq(s.products.id, pB))
      const listingB = Number(listedB.shopifyId)
      assert.equal(mock.product(listingB).variants[0].price, '500.00', 'flat product pushes the base — base + mirror would be 1000')
      assert.equal(mock.product(listingB).variants[0].compare_at_price, '700.00', 'product compare-at stays absolute')

      const pricePushB = await shopify.pushProductPriceToShopify(pB)
      assert.equal(pricePushB.ok, true, pricePushB.errors.join('; '))
      assert.equal(mock.product(listingB).variants[0].price, '500.00', 'the flat price push is still the base, not base + mirror')

      // ── 6. Legacy placeholder product (the live-discovered case) ────────
      // Every product in the dev database looks like this: options hold the
      // Shopify single-variant placeholder and the row stores an ABSOLUTE
      // price (4800 on base 4738 — the old code pushed it standalone, and a
      // naive add-on rule would push 4738 + 4800 = 9538).
      const pC = randomUUID()
      await db.insert(s.products).values({
        id: pC,
        name: 'Legacy Mirror Product',
        sku: 'VAR-PRICE-MIRROR',
        category: 'Rings',
        collection: 'Rings',
        gst: 3,
        stock: 1,
        shopifyStatus: 'not-listed',
        status: 'active',
        trackInventory: true,
        chargeOnTax: true,
        sellingPrice: 4738,
        options: [{ name: 'Title', values: ['Default Title'] }],
        createdAt: '2026-11-17',
      })
      await db.insert(s.productVariants).values({
        id: randomUUID(),
        productId: pC,
        title: 'Default Title',
        optionValues: ['Default Title'],
        sku: 'VAR-PRICE-MIRROR',
        sellingPrice: 4800,
        stock: 1,
        status: 'active',
      })

      const pushC = await shopify.pushProductsToShopify([pC])
      assert.equal(pushC.ok, true, `mirror create push failed: ${pushC.errors.join('; ')}`)
      const [listedC] = await db.select().from(s.products).where(eq(s.products.id, pC))
      const listingC = Number(listedC.shopifyId)
      assert.equal(
        mock.product(listingC).variants[0].price,
        '4738.00',
        'the mirror row must NOT be added to the base (4738 + 4800 would push 9538)',
      )
      const pricePushC = await shopify.pushProductPriceToShopify(pC)
      assert.equal(pricePushC.ok, true, pricePushC.errors.join('; '))
      assert.equal(mock.product(listingC).variants[0].price, '4738.00', 'the price push sends the base for a mirror row too')

      // ── 7. Dedicated add-on column + mirror + real silver-rate reprice ───
      const pD = randomUUID()
      await db.insert(s.products).values({
        id: pD,
        name: 'Durable Add-on Ring',
        sku: 'VAR-PRICE-DELTA',
        category: 'Rings',
        gst: 3,
        netWeight: 10,
        makingCharge: 0,
        stock: 1,
        shopifyStatus: 'not-listed',
        status: 'active',
        trackInventory: true,
        chargeOnTax: true,
        sellingPrice: 618,
        options: [{ name: 'Size', values: ['S'] }],
        createdAt: '2026-11-26',
      })
      const variantD = randomUUID()
      await db.insert(s.productVariants).values({
        id: variantD,
        productId: pD,
        title: 'S',
        optionValues: ['S'],
        sku: 'VAR-PRICE-DELTA-S',
        sellingPrice: 818,
        priceAdjustment: 200,
        stock: 1,
        status: 'active',
      })
      const pushD = await shopify.pushProductsToShopify([pD])
      assert.equal(pushD.ok, true, `durable add-on push failed: ${pushD.errors.join('; ')}`)
      const [listedD] = await db.select().from(s.products).where(eq(s.products.id, pD))
      const listingD = Number(listedD.shopifyId)
      assert.equal(mock.product(listingD).variants[0].price, '818.00', 'effective price is the price pushed, once')

      // The two-way mirror used to copy 818 back into products.selling_price,
      // so the next push displayed/pushed 1018 and compounded every 10 minutes.
      const mirrored = await shopify.syncProductsToDb({ mirrorFromShopify: true })
      assert.equal(mirrored.ok, true, mirrored.errors.join('; '))
      const [afterMirror] = await db.select().from(s.products).where(eq(s.products.id, pD))
      assert.equal(Number(afterMirror.sellingPrice), 618, 'a mirror never overwrites the ERP base')
      const [variantAfterMirror] = await db.select().from(s.productVariants).where(eq(s.productVariants.id, variantD))
      assert.equal(Number(variantAfterMirror.priceAdjustment), 200, 'the add-on survives the mirror')

      // A real rate change recomputes the GST-inclusive base to ₹2,060
      // (10 g × ₹200 × 1.03) and rebuilds the variant's effective price above
      // it — +₹200, not +₹818.
      const repriced = await shopify.applySilverRate(200, { source: 'manual' })
      assert.ok(repriced.affected >= 1, `the rate change must reprice our new product: ${JSON.stringify(repriced)}`)
      const [afterReprice] = await db.select().from(s.products).where(eq(s.products.id, pD))
      assert.equal(Number(afterReprice.sellingPrice), 2060, 'the new GST-inclusive base comes from the new rate')
      const [variantAfterReprice] = await db.select().from(s.productVariants).where(eq(s.productVariants.id, variantD))
      assert.equal(Number(variantAfterReprice.priceAdjustment), 200, 'the durable delta is unchanged')
      assert.equal(Number(variantAfterReprice.sellingPrice), 2260, 'effective = new base + add-on')

      assert.deepEqual(mock.unmatched, [], 'every Admin API endpoint the pushes touch is modelled by the mock')
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
