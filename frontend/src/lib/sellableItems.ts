import type { LocationStockAvailability, Product, ProductVariant } from '@/types'
import {
  isDefaultVariantName,
  productVariants,
  variantAddOn,
  variantEffectivePrice,
  variantLabel,
} from '@/lib/productVariants'
import { perUnitLinePrice } from '@/lib/orderPricing'
import { round2 } from '@/lib/utils'

/**
 * One flattened, selectable line item: a product, or ONE OF ITS VARIANTS.
 *
 * Every sales screen that sells from the catalogue (Bookings, New Sales
 * Invoice, Create Manual Order) needs the same shape — one dropdown row per
 * thing the counter can actually hand over, with the code, the label, the
 * price and the stock that row should bill and check. Building that per screen
 * is how the screens drifted: a picker that only listed parents made variant
 * SKUs (`OL-GIF-001-RED`) unsearchable even though the variant feature, the
 * variant stock ledger and the conversion guards were all variant-aware.
 *
 * Field names are camelCase like the rest of the app; the conceptual wire
 * fields this maps to are `product_id`, `variant_id`, `sku`, `label`,
 * `price`, `net_weight` and `pricing_type`.
 */

/** How a line's amount is derived — the rule the price autofill must follow. */
export type SellablePricingType = 'piece_rate' | 'weight_based'

export interface SellableStoreStock {
  locationId: string
  name: string
  available: number
}

export interface SellableItem {
  productId: string
  /** null only for a product that has no variant rows (a flat single-SKU row). */
  variantId: string | null
  /** The variant's own SKU when there is one, else the parent product's. */
  sku: string
  /** `{product.name} - {variant.name} ({variant.sku})`, or `{name} ({sku})`. */
  label: string
  productName: string
  variantName: string | null
  /** Catalogue base price for ONE piece, before the variant add-on. */
  basePrice: number | null
  /** The variant "Add to price (₹)" delta; 0 on flat/parent rows. */
  priceAdjustment: number
  /**
   * Catalogue price for ONE piece: a variant's base + its configured add-on
   * (the push rule — a 0 add-on must never zero the row), else the product's
   * own price.
   */
  price: number | null
  /** Per-piece net weight in grams. Variants carry no net weight of their own. */
  netWeight: number | null
  /** Making charge PER GRAM — the other half of the weight-based formula. */
  makingCharge: number | null
  pricingType: SellablePricingType
  /** ₹/pc for a Piece Rate product; null for weight-based ones. */
  fixedPieceRate: number | null
  /** The variant's own count, else the parent rollup. */
  stock: number | null
  /** Per-store stock for THIS item — empty until the caller supplies it. */
  stores: SellableStoreStock[]
}

/** Availability cache keyed by `${productId}|${variantId}` (Bookings' own key). */
export type SellableAvailability = Record<
  string,
  LocationStockAvailability | null | { error: string } | undefined
>

const positive = (value: unknown): number | null => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** The option value a picker stores: one stable key per product/variant pair. */
export function sellableItemValue(item: Pick<SellableItem, 'productId' | 'variantId'>): string {
  return `${item.productId}|${item.variantId ?? ''}`
}

/** Inverse of {@link sellableItemValue} — what a saved line points back at. */
export function parseSellableValue(value: string): { productId: string; variantId: string | null } {
  const [productId = '', variantId = ''] = value.split('|')
  return { productId, variantId: variantId || null }
}

function storesFor(
  item: Pick<SellableItem, 'productId' | 'variantId'>,
  availability: SellableAvailability | undefined,
): SellableStoreStock[] {
  const entry = availability?.[sellableItemValue(item)]
  if (!entry || 'error' in entry) return []
  return entry.locations.map((l) => ({ locationId: l.locationId, name: l.name, available: l.available }))
}

/**
 * The product's own row — `variantId: null`, its own label, its own price.
 *
 * This is the flat single-SKU row the rest of the ERP has always assumed, and
 * the row a legacy parent-SKU purchase line resolves back to.
 */
function parentSellable(product: Product): SellableItem {
  // Piece Rate: sellingPrice IS the fixed price for legacy rows that never
  // got a fixedPieceRate column value, so fall back to it rather than to the
  // silver-rate maths the flag exists to switch OFF.
  const fixedPieceRate =
    product.pieceRateProduct === true ? (positive(product.fixedPieceRate) ?? positive(product.sellingPrice)) : null
  const pricingType: SellablePricingType = fixedPieceRate != null ? 'piece_rate' : 'weight_based'
  const base = fixedPieceRate ?? (Number(product.sellingPrice) || null)
  return {
    productId: product.id,
    variantId: null,
    sku: product.sku ?? '',
    label: product.sku ? `${product.name} (${product.sku})` : product.name,
    productName: product.name,
    variantName: null,
    basePrice: base,
    priceAdjustment: 0,
    price: base,
    netWeight: positive(product.netWeight),
    makingCharge: product.makingCharge != null ? Number(product.makingCharge) : null,
    pricingType,
    fixedPieceRate,
    stock: product.stock ?? null,
    stores: [],
  }
}

/** One row for a variant: the parent's pricing inputs, the variant's identity. */
function variantSellable(product: Product, variant: ProductVariant): SellableItem {
  const fixedPieceRate =
    product.pieceRateProduct === true ? (positive(product.fixedPieceRate) ?? positive(product.sellingPrice)) : null
  const pricingType: SellablePricingType = fixedPieceRate != null ? 'piece_rate' : 'weight_based'
  const base = fixedPieceRate ?? (Number(product.sellingPrice) || null)
  return {
    productId: product.id,
    variantId: variant.id,
    sku: variant.sku ?? '',
    label: variant.sku
      ? `${product.name} - ${variantLabel(variant)} (${variant.sku})`
      : `${product.name} - ${variantLabel(variant)}`,
    productName: product.name,
    variantName: variantLabel(variant),
    // The delta is kept apart from the effective price so a live-rate reprice
    // can rebuild the line without ever re-adding the add-on.
    basePrice: base,
    priceAdjustment: variantAddOn(variant),
    price: variantEffectivePrice(base, variant),
    netWeight: positive(product.netWeight),
    makingCharge: product.makingCharge != null ? Number(product.makingCharge) : null,
    pricingType,
    fixedPieceRate,
    stock: variant.stock ?? product.stock ?? null,
    stores: [],
  }
}

/** The product's variants, minus the Shopify "Default Title" mirror rows. */
function realVariants(product: Product): ProductVariant[] {
  // A lone "Default Title" row is the mirror every flat/legacy product carries —
  // it IS the product, not a second thing to transact on, so it collapses back
  // to the parent exactly as it did before variants were selectable.
  return productVariants(product).filter((v) => !isDefaultVariantName(v.name))
}

/**
 * Flatten the catalogue into one selectable row per sellable thing.
 *
 * A product WITH variants never appears on its own — its variants do, each
 * carrying the parent's relationship so a line can still resolve stock,
 * allocations and Shopify sync through the product. A product without variants
 * is emitted once with `variantId: null`, which is the flat single-SKU row the
 * rest of the ERP has always assumed.
 *
 * Pass the per-store availability cache (Bookings keeps one keyed by
 * `${productId}|${variantId}` — the SAME key as {@link sellableItemValue}) to
 * give every option its variant-level store stock.
 */
export function flattenSellableItems(
  products: Product[],
  availability?: SellableAvailability,
): SellableItem[] {
  const out: SellableItem[] = []
  for (const product of products) {
    const variants = realVariants(product)
    if (variants.length === 0) {
      const item = parentSellable(product)
      out.push({ ...item, stores: storesFor(item, availability) })
      continue
    }
    for (const variant of variants) {
      const item = variantSellable(product, variant)
      out.push({ ...item, stores: storesFor(item, availability) })
    }
  }
  return out
}

/**
 * Purchase-side flatten: the product itself **and** each of its variants.
 *
 * Purchases receive stock for a product exactly as they always have — keyed by
 * the code on the line — so a legacy PO / Purchase Invoice / Purchase Return
 * line that points at the PARENT sku must keep resolving to a selectable row.
 * (A sales picker drops the parent instead: a sale always names the exact
 * variant that leaves the shelf.) The parent row is also a genuine receiving
 * target — `applyStockMovement` splits a parent-keyed credit across the
 * product's variants.
 */
export function flattenPurchasableItems(products: Product[]): SellableItem[] {
  const out: SellableItem[] = []
  for (const product of products) {
    out.push(parentSellable(product))
    for (const variant of realVariants(product)) out.push(variantSellable(product, variant))
  }
  return out
}

/**
 * Case-insensitive search over the three identities the counter actually says
 * out loud: the variant's code, the variant's name and the parent product's
 * name (plus the label, which carries all three).
 */
export function searchSellableItems(items: SellableItem[], query: string): SellableItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter(
    (item) =>
      item.sku.toLowerCase().includes(q) ||
      (item.variantName ?? '').toLowerCase().includes(q) ||
      item.productName.toLowerCase().includes(q) ||
      item.label.toLowerCase().includes(q),
  )
}

/**
 * Scan resolution: the code the scanner is holding, matched EXACTLY (and
 * case-insensitively) against the variant SKU, the variant name or the parent
 * product name — the three things a label or a counter can name.
 *
 * An ambiguous name resolves to nothing on purpose: a parent with red + white
 * variants answers "red" once, but "silver toy" names two rows, and guessing
 * which colour was meant would book the wrong stock. The caller shows the
 * filtered list instead and lets the operator pick.
 */
export function resolveSellableByCode(items: SellableItem[], rawCode: string): SellableItem | null {
  const code = rawCode.trim()
  if (!code) return null
  const wanted = code.toLowerCase()
  const bySku = items.find((item) => item.sku.trim().toLowerCase() === wanted)
  if (bySku) return bySku
  const byName = items.filter(
    (item) =>
      item.productName.trim().toLowerCase() === wanted ||
      (item.variantName ?? '').trim().toLowerCase() === wanted ||
      item.label.trim().toLowerCase() === wanted,
  )
  return byName.length === 1 ? byName[0] : null
}

/** Dropdown rows for a SearchableSelect — the label already searches as-is. */
export function sellableItemOptions(
  items: SellableItem[],
): Array<{ value: string; label: string; subtitle: string | undefined; keywords: string }> {
  return items.map((item) => ({
    value: sellableItemValue(item),
    label: item.label,
    // The label carries a variant's code already; the parent row still wants
    // its SKU on the second line, exactly as it always did.
    subtitle: item.variantId ? undefined : item.sku || undefined,
    keywords: [item.productName, item.sku, item.variantName ?? ''].filter(Boolean).join(' '),
  }))
}

/**
 * Dropdown rows for the PURCHASE forms, keyed by the line's own code.
 *
 * A purchase line stores its SKU (never a product id) and every saved PO /
 * Purchase Invoice / Purchase Return line predates variants — so the option
 * value has to BE that code: a legacy parent SKU keeps resolving, and a
 * variant row answers with the variant's SKU.
 */
export function purchasableItemOptions(
  items: SellableItem[],
): Array<{ value: string; label: string; subtitle: string | undefined; keywords: string }> {
  return items.map((item) => ({
    value: item.sku,
    label: item.label,
    subtitle: item.variantId ? undefined : item.sku || undefined,
    keywords: [item.productName, item.sku, item.variantName ?? ''].filter(Boolean).join(' '),
  }))
}

/** Exact code match (parent or variant SKU) against a flattened catalogue. */
export function findSellableBySku(items: SellableItem[], sku: string): SellableItem | null {
  const wanted = sku.trim().toLowerCase()
  if (!wanted) return null
  return items.find((item) => (item.sku ?? '').trim().toLowerCase() === wanted) ?? null
}

/**
 * The price a freshly picked line should open at, honouring the pricing mode:
 *
 *  - **Piece Rate** — the fixed ₹/pc plus the variant's add-on. It must NEVER
 *    fall through to `netWeight × (silverRate + making)`, which is exactly how
 *    a ₹2,000 piece arrived as a weight-based figure on the billing screens.
 *  - **Weight-Based** — the managed silver rate calculation plus the add-on,
 *    falling back to the catalogue BASE price when the rate or weight is not
 *    known yet. The add-on is GST-inclusive, like the base selling price.
 *
 * Both stay editable: this only decides what the field opens with.
 */
export function sellableItemPrice(
  item: SellableItem,
  opts: { silverRate: number | null | undefined },
): number | undefined {
  const addOn = item.priceAdjustment ?? 0
  if (item.pricingType === 'piece_rate') {
    // `basePrice` is the fixed ₹/pc; `price` already includes the add-on, so
    // using it as the base here would add ₹200 twice.
    const fixed = item.basePrice ?? item.fixedPieceRate ?? item.price
    return fixed == null ? undefined : round2(fixed + addOn)
  }
  const base = perUnitLinePrice({
    silverRate: opts.silverRate,
    netWeight: item.netWeight,
    makingCharge: item.makingCharge,
    fallback: item.basePrice,
  })
  return base == null ? undefined : round2(base + addOn)
}
