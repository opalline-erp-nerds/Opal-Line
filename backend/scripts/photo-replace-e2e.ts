// Replace-photo E2E (live, then cleans up after itself):
//   1. create local test product with image A (from an existing upload)
//   2. push -> listing gets A, local row write-back -> CDN(A)
//   3. replace with image B (different upload file), PATCH local row
//   4. push again -> listing must end with exactly 1 image = B (A deleted)
//   5. third push -> strict no-op (idempotency after replacement)
//   6. cleanup: delete Shopify listing + local row
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { db, schema } from '../src/db/client'
import { pushProductsToShopify, deleteShopifyProduct } from '../src/shopify'
import { UPLOADS_DIR, saveUploadedImage } from '../src/uploads'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function pathnameOf(src: string | null | undefined): string {
  if (!src) return ''
  try { return new URL(src).pathname } catch { return src.split('?')[0] }
}
async function storeImages(pid: number): Promise<string[]> {
  for (let a = 0; a < 3; a++) {
    if (a) await sleep(500 * a)
    try {
      const { config } = await import('../src/config')
      const res = await fetch(`https://${config.shop}.myshopify.com/admin/api/${config.apiVersion}/products/${pid}`, {
        headers: { 'X-Shopify-Access-Token': config.accessToken, Accept: 'application/json' },
      })
      if (res.ok) {
        const json = (await res.json()) as { product?: { images?: Array<{ src?: string }> } }
        return (json.product?.images ?? []).map((i) => i.src ?? '').filter(Boolean)
      }
      if (res.status !== 429 && res.status < 500) return []
    } catch { /* retry */ }
  }
  return []
}

let failed = 0
const check = (name: string, ok: boolean, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

async function main() {
  if (!db) { console.log('NO_DB'); process.exit(1) }

  // Two distinct upload files -> fresh local uploads (unique content-addressed names)
  const dir = UPLOADS_DIR()
  const jpeg = readdirSync(dir).filter((f) => f.endsWith('.jpg')).slice(0, 2)
  if (jpeg.length < 2) { console.log('NEED_2_JPEGS'); process.exit(1) }
  const urlA = await saveUploadedImage(`data:image/jpeg;base64,${readFileSync(join(dir, jpeg[0])).toString('base64')}`)
  const urlB = await saveUploadedImage(`data:image/jpeg;base64,${readFileSync(join(dir, jpeg[1])).toString('base64')}`)
  if (!urlA || !urlB) { console.log('UPLOAD_FAILED'); process.exit(1) }
  const pathA = urlA
  const pathB = urlB
  check('setup: two distinct local images', pathA !== pathB)

  const id = randomUUID()
  const sku = `PHOTO-REPLACE-${Date.now()}`
  await db.insert(schema.products).values({
    id, name: 'Photo Replace E2E', sku, category: 'Rings',
    image: pathA, images: [pathA], status: 'active',
    netWeight: 10, makingCharge: 20, purity: 92.5, gst: 3, silverRate: 90,
    sellingPrice: 1150, stock: 2, shopifyStatus: 'not-listed', hsn: '71131130',
    createdAt: new Date().toISOString(),
  })

  try {
    // 2. push with A
    let r = await pushProductsToShopify([id])
    check('push#1 created listing', r.ok && r.created === 1, JSON.stringify({ created: r.created, errors: r.errors }))
    await sleep(800)
    const [row1] = await db.select({ shopifyId: schema.products.shopifyId, image: schema.products.image, images: schema.products.images }).from(schema.products).where(eq(schema.products.id, id))
    const pid = Number(String(row1.shopifyId).replace(/^#/, ''))
    check('push#1 write-back is CDN of A', /cdn\.shopify\.com/.test(row1.image) && pathnameOf(row1.image) !== pathnameOf(pathA), row1.image.slice(-45))
    const imgs1 = await storeImages(pid)
    check('push#1 store has exactly 1 image', imgs1.length === 1, JSON.stringify(imgs1.length))

    // 3. replace with B (same as the user editing the product in the UI)
    await db.update(schema.products).set({ image: pathB, images: [pathB] }).where(eq(schema.products.id, id))

    // 4. push again -> A must be deleted, B added, exactly 1 remains
    r = await pushProductsToShopify([id])
    check('push#2 updated', r.ok && (r.updated ?? 0) === 1, JSON.stringify({ updated: r.updated, errors: r.errors }))
    await sleep(1200)
    const imgs2 = await storeImages(pid)
    check('push#2 store has exactly 1 image (old deleted)', imgs2.length === 1, JSON.stringify(imgs2.length))
    const [row2] = await db.select({ image: schema.products.image, images: schema.products.images }).from(schema.products).where(eq(schema.products.id, id))
    check('push#2 store first image == local ref', pathnameOf(imgs2[0]) === pathnameOf(row2.image), `${pathnameOf(imgs2[0]).slice(-30)} vs ${pathnameOf(row2.image).slice(-30)}`)
    check('push#2 local write-back is a CDN URL', /cdn\.shopify\.com/.test(row2.image))
    check('push#2 new image differs from old', pathnameOf(imgs2[0]) !== pathnameOf(imgs1[0]))

    // 5. idempotency after replacement
    r = await pushProductsToShopify([id])
    await sleep(1000)
    const imgs3 = await storeImages(pid)
    check('push#3 idempotent (still 1 image, same file)', imgs3.length === 1 && pathnameOf(imgs3[0]) === pathnameOf(imgs2[0]), JSON.stringify(imgs3.length))

    // 6. cleanup
    try { await deleteShopifyProduct(pid) } catch (e) { console.log('note: store delete:', String(e).slice(0, 80)) }
    await sleep(600)
    const after = await storeImages(pid)
    check('cleanup: listing deleted from store', after.length === 0, JSON.stringify(after.length))
  } finally {
    await db.delete(schema.products).where(eq(schema.products.id, id))
    console.log('cleanup: local row deleted')
  }

  console.log(failed ? `RESULT FAIL (${failed})` : 'RESULT PASS (all)')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('ERR ' + (e?.message ?? e)); process.exit(1) })