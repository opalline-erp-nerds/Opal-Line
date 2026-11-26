import type { Product, ProductVariant } from '@/types'

/**
 * Adapter for the product-variant feature under development on the product
 * page. Invoice and order flows must not depend on its exact wire shape, so
 * everything here reads a product's `variants` array defensively: field names
 * the variant feature may use (`price`, `inventoryQuantity`, `variantId`,
 * Shopify's `option1..3`) are all accepted and normalized into the single
 * `ProductVariant` shape the rest of the app consumes.
 *
 * Products without a populated `variants` array are treated exactly as the
 * flat single-SKU products the ERP has always had.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

/** Shopify option values ("Size: M") folded into one readable label. */
function optionsLabel(v: Record<string, unknown>): string | null {
  const parts = ['option1', 'option2', 'option3']
    .map((k) => asText(v[k]))
    .filter((x): x is string => x !== null)
  return parts.length > 0 ? parts.join(' / ') : null
}

export function normalizeVariant(raw: unknown): ProductVariant | null {
  const v = asRecord(raw)
  if (!v) return null
  const sku = asText(v.sku) ?? ''
  const id = asText(v.id) ?? asText(v.variantId) ?? asText(v.shopifyVariantId)
  if (!sku && !id) return null
  return {
    id: id ?? sku,
    name: asText(v.name) ?? asText(v.title) ?? asText(v.label) ?? optionsLabel(v),
    sku,
    sellingPrice: asNumber(v.sellingPrice) ?? asNumber(v.price),
    priceAdjustment: asNumber(v.priceAdjustment),
    stock: asNumber(v.stock) ?? asNumber(v.inventoryQuantity),
    barcode: asText(v.barcode),
    shopifyVariantId: asNumber(v.shopifyVariantId) ?? asNumber(v.variantId) ?? asNumber(v.id),
  }
}

/** The product's variants, normalized; empty when the product is flat. */
export function productVariants(product: Pick<Product, 'variants'> | null | undefined): ProductVariant[] {
  const raw = product?.variants
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeVariant).filter((v): v is ProductVariant => v !== null)
}

export function productHasVariants(product: Pick<Product, 'variants'> | null | undefined): boolean {
  return productVariants(product).length > 0
}

export function variantLabel(v: ProductVariant): string {
  return v.name || v.sku || v.id
}

/**
 * True when a variant row is the Shopify single-variant placeholder — the
 * "Default Title" mirror every flat/legacy product carries. Its stored price
 * is a legacy absolute value and must never be added to the base.
 */
export function isDefaultVariantName(name: string | null | undefined): boolean {
  const t = String(name ?? '').trim().toLowerCase()
  return t === '' || t === 'default title'
}

/** The fields needed to price a variant row (both normalized and raw API shapes). */
export interface VariantPriceFields {
  /** Normalized adapter field. */
  name?: string | null
  /** Raw `product_variants` field from the catalogue endpoints. */
  title?: string | null
  optionValues?: string[] | null
  /** EFFECTIVE price on new rows; the legacy ADD-ON on rows predating the column. */
  sellingPrice?: number | string | null
  /** The canonical "Add to price (₹)" delta (0 = base price). */
  priceAdjustment?: number | string | null
}

/**
 * Default-Title detection that works on BOTH wire shapes. The catalogue
 * endpoints return `title` (not `name`), so calling `isDefaultVariantName(v.name)
 * on a raw row read as "default" and silently dropped its add-on — the exact
 * reason a saved +₹200 still rendered as the base price on Product Detail.
 */
export function variantIsDefaultRow(v: VariantPriceFields): boolean {
  const values = Array.isArray(v.optionValues) ? v.optionValues : []
  if (values.some((x) => String(x ?? '').trim().toLowerCase() !== 'default title')) return false
  return isDefaultVariantName(v.name ?? v.title)
}

/**
 * The "Add to price (₹)" amount for a row. New rows carry `priceAdjustment`;
 * older rows stored the add-on in `sellingPrice`, which is kept as a fallback
 * so a product saved before the dedicated column still prices correctly.
 */
export function variantAddOn(v: VariantPriceFields): number {
  if (variantIsDefaultRow(v)) return 0
  const raw = v.priceAdjustment != null ? v.priceAdjustment : v.sellingPrice
  const n = Number(raw)
  return Number.isFinite(n) && n !== 0 ? Math.round(n * 100) / 100 : 0
}

/**
 * Price to show/charge for a variant: base + add-on. Never reads `sellingPrice`
 * when an explicit add-on exists — the stored effective price must not be
 * added a second time on re-open/re-save.
 */
export function variantEffectivePrice(
  basePrice: number | null | undefined,
  variant: VariantPriceFields,
): number {
  const base = Number.isFinite(Number(basePrice)) ? Number(basePrice) : 0
  return Math.round((base + variantAddOn(variant)) * 100) / 100
}

/**
 * Final price of a variant, mirroring the backend push rule
 * (backend/src/shopify.ts → variantPushPrice): a real option row is the ERP
 * selling price (base) plus the row's additional amount (base 618 + add-on
 * 200 → 818), while a "Default Title" mirror row prices from the base alone —
 * adding its stored value would double the product. The stored numbers are
 * never rewritten here, so re-reading after an edit or sync always re-derives
 * the same final price.
 */
export function variantFinalPrice(
  basePrice: number | null | undefined,
  additionalPrice: number | null | undefined,
  variantName: string | null | undefined,
): number {
  const base = Number.isFinite(Number(basePrice)) ? Number(basePrice) : 0
  if (isDefaultVariantName(variantName)) return Math.round(base * 100) / 100
  const additional = Number.isFinite(Number(additionalPrice)) ? Number(additionalPrice) : 0
  return Math.round((base + additional) * 100) / 100
}

/**
 * True when option definitions describe REAL variants: the Shopify
 * single-variant placeholder (Title / Default Title) that every flat legacy
 * product carries does not count — such products price from the base alone.
 */
export function hasRealOptions(options: Array<{ name?: string; values?: string[] }> | null | undefined): boolean {
  if (!Array.isArray(options)) return false
  return options.some((o) =>
    Array.isArray(o?.values) && o.values.some((v) => String(v ?? '').trim() !== 'Default Title'),
  )
}

/** Dropdown options for a product's variants. */
export function variantOptions(product: Pick<Product, 'variants'> | null | undefined): Array<{
  value: string
  label: string
  subtitle: string | undefined
}> {
  return productVariants(product).map((v) => ({
    value: v.id,
    label: variantLabel(v),
    subtitle: v.sku || undefined,
  }))
}

export function findVariantById(product: Pick<Product, 'variants'> | null | undefined, variantId: string): ProductVariant | null {
  return productVariants(product).find((v) => v.id === variantId) ?? null
}

/** Exact, case-insensitive SKU match against the product's variants. */
export function findVariantBySku(product: Pick<Product, 'variants'> | null | undefined, code: string): ProductVariant | null {
  const wanted = code.trim().toLowerCase()
  if (!wanted) return null
  return productVariants(product).find((v) => (v.sku ?? '').trim().toLowerCase() === wanted) ?? null
}

export interface ProductCodeMatch {
  product: Product
  /** The variant the code belongs to, or null when it is the product's own code. */
  variant: ProductVariant | null
}

/**
 * Scan resolution, in the order the counter expects: product SKU → variant
 * SKU. Labels carry a QR code encoding ONLY the SKU, so an exact SKU match is
 * the single scannable identity — there is no barcode lookup any more. A
 * variant match returns the parent product plus the variant so callers can
 * fill the line with the variant's SKU, price and stock.
 */
export function matchProductByCode(products: Product[], rawCode: string): ProductCodeMatch | null {
  const code = rawCode.trim()
  if (!code) return null
  const wanted = code.toLowerCase()
  const bySku = products.find((p) => (p.sku ?? '').trim().toLowerCase() === wanted)
  if (bySku) return { product: bySku, variant: null }
  for (const p of products) {
    const v = findVariantBySku(p, wanted)
    if (v) return { product: p, variant: v }
  }
  return null
}
