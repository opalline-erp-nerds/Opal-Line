import type { LocationStockAvailability, Product } from '@/types'
import { isDefaultVariantName, productVariants, variantFinalPrice, variantLabel } from '@/lib/productVariants'
import { perUnitLinePrice } from '@/lib/orderPricing'

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
    // A lone "Default Title" row is the Shopify mirror every flat/legacy
    // product carries — it IS the product, not a second thing to sell. Emitting
    // it as its own option would double every plain product in the picker and
    // hand it a `- Default Title` label, so those rows collapse back to the
    // parent exactly as they did before variants were selectable.
    const variants = productVariants(product).filter((v) => !isDefaultVariantName(v.name))
    // Piece Rate: sellingPrice IS the fixed price for legacy rows that never
    // got a fixedPieceRate column value, so fall back to it rather than to the
    // silver-rate maths the flag exists to switch OFF.
    const fixedPieceRate =
      product.pieceRateProduct === true ? (positive(product.fixedPieceRate) ?? positive(product.sellingPrice)) : null
    const pricingType: SellablePricingType = fixedPieceRate != null ? 'piece_rate' : 'weight_based'
    const base = fixedPieceRate ?? (Number(product.sellingPrice) || null)

    if (variants.length === 0) {
      const item: SellableItem = {
        productId: product.id,
        variantId: null,
        sku: product.sku ?? '',
        label: product.sku ? `${product.name} (${product.sku})` : product.name,
        productName: product.name,
        variantName: null,
        price: base,
        netWeight: positive(product.netWeight),
        makingCharge: product.makingCharge != null ? Number(product.makingCharge) : null,
        pricingType,
        fixedPieceRate,
        stock: product.stock ?? null,
        stores: [],
      }
      out.push({ ...item, stores: storesFor(item, availability) })
      continue
    }
    for (const variant of variants) {
      const item: SellableItem = {
        productId: product.id,
        variantId: variant.id,
        sku: variant.sku ?? '',
        label: variant.sku
          ? `${product.name} - ${variantLabel(variant)} (${variant.sku})`
          : `${product.name} - ${variantLabel(variant)}`,
        productName: product.name,
        variantName: variantLabel(variant),
        // Base + add-on, never `variant.sellingPrice ?? product.sellingPrice`:
        // a fresh variant row stores 0 (no add-on), and `0 ?? base` would bill
        // a ₹0 line for a real product.
        price: variantFinalPrice(base, variant.sellingPrice, variant.name),
        netWeight: positive(product.netWeight),
        makingCharge: product.makingCharge != null ? Number(product.makingCharge) : null,
        pricingType,
        fixedPieceRate,
        stock: variant.stock ?? product.stock ?? null,
        stores: [],
      }
      out.push({ ...item, stores: storesFor(item, availability) })
    }
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
 * The price a freshly picked line should open at, honouring the pricing mode:
 *
 *  - **Piece Rate** — the fixed ₹/pc. It must NEVER fall through to
 *    `netWeight × (silverRate + making)`, which is exactly how a ₹2,000 piece
 *    arrived as a weight-based figure on the billing screens.
 *  - **Weight-Based** — the managed silver rate calculation, falling back to
 *    the catalogue price when the rate or the weight is not known yet.
 *
 * Both stay editable: this only decides what the field opens with.
 */
export function sellableItemPrice(
  item: SellableItem,
  opts: { silverRate: number | null | undefined },
): number | undefined {
  if (item.pricingType === 'piece_rate') {
    const fixed = item.fixedPieceRate ?? item.price
    return fixed != null ? fixed : undefined
  }
  return perUnitLinePrice({
    silverRate: opts.silverRate,
    netWeight: item.netWeight,
    makingCharge: item.makingCharge,
    fallback: item.price,
  })
}
