/**
 * Auto-generation of product identifiers, driven by the configurable rules in
 * Settings → Product codes (skuPrefix / skuSuffix / skuFormat / skuSeqLength).
 *
 * This module is the server-side source of truth and is mirrored in
 * frontend/src/lib/productCodes.ts so the product dialog can generate codes
 * offline — the same convention as normalizeLockoutPolicy in src/lockout.ts.
 *
 * SKUs are built from a format template with tokens:
 *   {PREFIX}   settings prefix (default OL — the Opal Line house prefix)
 *   {CATEGORY} 3-letter category code (RNG, CHN …)
 *   {SEQ}      zero-padded running sequence (minimum three digits, e.g. 001)
 *   {SUFFIX}   settings suffix (default empty)
 * The default template `{PREFIX}-{CATEGORY}-{SEQ}` renders the house style
 * OL-RNG-001: category-based, sequences independent per category code.
 *
 * Barcodes are no longer generated anywhere in the product workflow: product
 * labels encode the SKU in a QR code (see src/barcodeLabels.ts).
 */

export const DEFAULT_SKU_PREFIX = 'OL'
export const DEFAULT_SKU_SUFFIX = ''
export const DEFAULT_SKU_FORMAT = '{PREFIX}-{CATEGORY}-{SEQ}'
/** Sequences are three-digit minimum: OL-RNG-001, never OL-RNG-1. */
export const DEFAULT_SKU_SEQ_LENGTH = 3
/** The shortest sequence the settings may configure (spec: three digits). */
export const MIN_SKU_SEQ_LENGTH = 3

/** The settings row slice that drives code generation. */
export interface ProductCodeSettings {
  skuPrefix?: string | null
  skuSuffix?: string | null
  skuFormat?: string | null
  skuSeqLength?: number | null
}

/** Category → the middle segment of auto-generated SKUs. */
const CATEGORY_PREFIX: Record<string, string> = {
  // The business default category still gets a real category code — generic
  // `OL-GEN-*` codes are reserved for rows with no usable category at all, so
  // no new generic SKUs are minted.
  'Silver jewels': 'SIL',
  Rings: 'RNG',
  Chains: 'CHN',
  Earrings: 'EAR',
  Necklaces: 'NCK',
  Bracelets: 'BRC',
  Bangles: 'BNG',
  Pendants: 'PND',
  Anklets: 'ANK',
  Mangalsutra: 'MNG',
  'Toe Rings': 'TRG',
  'Nose Pins': 'NSP',
  Accessories: 'CUF',
}

/** Lower-cased lookup so "rings" and "Rings" mint the same category code. */
const CATEGORY_PREFIX_BY_KEY = new Map(
  Object.entries(CATEGORY_PREFIX).map(([k, v]) => [k.toLowerCase(), v]),
)

export function categoryCode(category: string): string {
  const key = String(category ?? '').trim().toLowerCase()
  const known = CATEGORY_PREFIX_BY_KEY.get(key)
  if (known) return known
  const letters = String(category ?? '').replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase()
  return letters || 'GEN'
}

/** The settings slice with the shipped defaults filled in — never null. */
export interface NormalizedCodeSettings {
  skuPrefix: string
  skuSuffix: string
  skuFormat: string
  skuSeqLength: number
}

/** Sanitised view of the settings with the shipped defaults filled in. */
export function normalizedCodeSettings(settings?: ProductCodeSettings | null): NormalizedCodeSettings {
  const raw = settings ?? {}
  const prefix = String(raw.skuPrefix ?? '').trim().toUpperCase() || DEFAULT_SKU_PREFIX
  const suffix = String(raw.skuSuffix ?? '').trim().toUpperCase() || DEFAULT_SKU_SUFFIX
  const format = String(raw.skuFormat ?? '').trim() || DEFAULT_SKU_FORMAT
  const seqRaw = Number(raw.skuSeqLength)
  const seqLength = Number.isFinite(seqRaw)
    ? Math.min(8, Math.max(MIN_SKU_SEQ_LENGTH, Math.round(seqRaw)))
    : DEFAULT_SKU_SEQ_LENGTH
  return { skuPrefix: prefix, skuSuffix: suffix, skuFormat: format.includes('{SEQ}') ? format : DEFAULT_SKU_FORMAT, skuSeqLength: seqLength }
}

/**
 * Render one SKU from a format template. `seq` is the raw running number;
 * the caller passes already-computed candidates and handles collisions.
 * The sequence is always padded to at least MIN_SKU_SEQ_LENGTH digits.
 */
export function renderSku(
  settings: ProductCodeSettings | null | undefined,
  category: string,
  seq: number,
): string {
  const cfg = normalizedCodeSettings(settings)
  return cfg.skuFormat
    .replaceAll('{PREFIX}', cfg.skuPrefix)
    .replaceAll('{CATEGORY}', categoryCode(category))
    .replaceAll('{SEQ}', String(Math.max(0, Math.floor(seq))).padStart(Math.max(MIN_SKU_SEQ_LENGTH, cfg.skuSeqLength), '0'))
    .replaceAll('{SUFFIX}', cfg.skuSuffix)
    .trim()
}

/**
 * Highest {SEQ} already used among SKUs matching the configured format for
 * ONE category code. When `category` is omitted every category counts (used
 * by callers that only need a global view).
 *
 * A legacy house-style scan (ANYPREFIX-CODE-NNNNN with the same category
 * code) runs too, so upgrading an install that used SLV-RNG-00021 continues
 * that category's sequence instead of restarting from 1 — while a different
 * category (SLV-GEN-00099) never inflates this category's sequence: each
 * category sequence is independent.
 */
export function maxSequence(
  skus: Array<string | null | undefined>,
  settings?: ProductCodeSettings | null,
  category?: string,
): number {
  const cfg = normalizedCodeSettings(settings)
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const code = category !== undefined ? escape(categoryCode(category)) : '[A-Z]{2,5}'
  const pattern = cfg.skuFormat
    .split('{PREFIX}').join(escape(cfg.skuPrefix))
    .split('{CATEGORY}').join(code)
    .split('{SUFFIX}').join(cfg.skuSuffix ? escape(cfg.skuSuffix) : '')
    .split('{SEQ}').join('(\\d{1,8})')
  const configured = new RegExp(`^${pattern}$`, 'i')
  // Legacy fixed house style, kept so sequences survive the move to templates.
  // When a category is given, only that category's legacy codes count.
  const house = new RegExp(`^[A-Z]{2,5}-${code}-(\\d{1,5})$`, 'i')
  let max = 0
  for (const sku of skus) {
    const value = (sku ?? '').trim().toUpperCase()
    if (!value) continue
    const m = configured.exec(value) ?? house.exec(value)
    if (!m?.[1]) continue
    const n = Number.parseInt(m[1], 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

/**
 * Next free SKU for the category under the configured format: that category's
 * max sequence + 1, bumped while the candidate is already taken, so the
 * result never collides with `existing`. Sequences run independently per
 * category: Rng codes never consume the Chain sequence and vice versa.
 */
export function generateSku(
  existing: Array<string | null | undefined>,
  category: string,
  settings?: ProductCodeSettings | null,
): string {
  const cfg = normalizedCodeSettings(settings)
  const taken = new Set(existing.map((s) => (s ?? '').trim().toUpperCase()).filter(Boolean))
  let n = maxSequence([...taken], cfg, category) + 1
  let sku = renderSku(cfg, category, n)
  while (taken.has(sku.toUpperCase())) {
    n += 1
    sku = renderSku(cfg, category, n)
  }
  return sku
}

/**
 * Shopify-style variant SKU: the parent SKU plus a short code per option
 * value (Small / Red → -SMA-RED). Collisions bump a numeric tail.
 */
export function generateVariantSku(parentSku: string, optionValues: string[], taken: Iterable<string>): string {
  const base = parentSku.trim().toUpperCase()
  const codes = optionValues.map((v) => v.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 3) || 'VAR')
  const candidateBase = [base, ...codes].filter(Boolean).join('-')
  const used = new Set([...taken].map((s) => (s ?? '').trim().toUpperCase()))
  let candidate = candidateBase
  let n = 2
  while (used.has(candidate)) {
    candidate = `${candidateBase}-${n}`
    n += 1
  }
  return candidate
}
