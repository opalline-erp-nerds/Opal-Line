import type { AppSettings, Product } from '@/types'

/**
 * Auto-generation of product identifiers, driven by the configurable rules in
 * Settings → Product codes. This file mirrors backend/src/lib/productCodes.ts
 * (the server-side source of truth) so the product dialog can generate codes
 * offline — the same convention as the lockout policy mirror in permissions.
 *
 * SKUs are built from a format template with tokens:
 *   {PREFIX}   settings prefix (default OL — the Opal Line house prefix)
 *   {CATEGORY} 3-letter category code (RNG, CHN …)
 *   {SEQ}      zero-padded running sequence (minimum three digits, e.g. 001)
 *   {SUFFIX}   settings suffix (default empty)
 * The default template `{PREFIX}-{CATEGORY}-{SEQ}` renders the house style
 * OL-RNG-001: category-based, sequences independent per category code.
 *
 * No barcodes are generated anywhere: printed labels carry a QR code that
 * encodes only the SKU.
 */

/** The settings slice that drives code generation. */
export type ProductCodeSettings = Pick<
  AppSettings,
  'skuPrefix' | 'skuSuffix' | 'skuFormat' | 'skuSeqLength'
>

export const DEFAULT_SKU_FORMAT = '{PREFIX}-{CATEGORY}-{SEQ}'
/** Sequences are three-digit minimum: OL-RNG-001, never OL-RNG-1. */
export const MIN_SKU_SEQ_LENGTH = 3

/** Category → the middle segment of auto-generated SKUs. */
export const CATEGORY_PREFIX: Record<string, string> = {
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

/**
 * The middle segment a SKU is minted with. A catalogue category's own prefix
 * wins (Inventory → Collections & Categories), so a category created there
 * mints exactly its stated code; without one the built-in mapping applies.
 */
export function skuCode(category: string, prefix?: string | null): string {
  const explicit = String(prefix ?? '').replace(/[^a-zA-Z]/g, '').slice(0, 5).toUpperCase()
  return explicit || categoryCode(category)
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
  const prefix = String(raw.skuPrefix ?? '').trim().toUpperCase() || 'OL'
  const suffix = String(raw.skuSuffix ?? '').trim().toUpperCase() || ''
  const format = String(raw.skuFormat ?? '').trim() || DEFAULT_SKU_FORMAT
  const seqRaw = Number(raw.skuSeqLength)
  const seqLength = Number.isFinite(seqRaw)
    ? Math.min(8, Math.max(MIN_SKU_SEQ_LENGTH, Math.round(seqRaw)))
    : 3
  return {
    skuPrefix: prefix,
    skuSuffix: suffix,
    skuFormat: format.includes('{SEQ}') ? format : DEFAULT_SKU_FORMAT,
    skuSeqLength: seqLength,
  }
}

/** Render one SKU from the configured format template. */
export function renderSku(
  settings: ProductCodeSettings | null | undefined,
  category: string,
  seq: number,
  prefix?: string | null,
): string {
  const cfg = normalizedCodeSettings(settings)
  return cfg.skuFormat
    .replaceAll('{PREFIX}', cfg.skuPrefix)
    .replaceAll('{CATEGORY}', skuCode(category, prefix))
    .replaceAll('{SEQ}', String(Math.max(0, Math.floor(seq))).padStart(Math.max(MIN_SKU_SEQ_LENGTH, cfg.skuSeqLength), '0'))
    .replaceAll('{SUFFIX}', cfg.skuSuffix)
    .trim()
}

/**
 * Highest {SEQ} already used among SKUs matching the configured format for
 * ONE category code. When `category` is omitted every category counts. A
 * legacy house-style scan (PREFIX-CODE-NNNNN with the same category) runs
 * too, so moving to a new format continues the old sequence instead of
 * restarting from 1 — and each category's sequence stays independent.
 */
export function maxSequence(
  skus: Array<string | null | undefined>,
  settings?: ProductCodeSettings | null,
  category?: string,
  prefix?: string | null,
): number {
  const cfg = normalizedCodeSettings(settings)
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const code = category !== undefined ? escape(skuCode(category, prefix)) : '[A-Z]{2,5}'
  const pattern = cfg.skuFormat
    .split('{PREFIX}').join(escape(cfg.skuPrefix))
    .split('{CATEGORY}').join(code)
    .split('{SUFFIX}').join(cfg.skuSuffix ? escape(cfg.skuSuffix) : '')
    .split('{SEQ}').join('(\\d{1,8})')
  const configured = new RegExp(`^${pattern}$`, 'i')
  // Legacy fixed house style, kept so sequences survive the move to templates.
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
 * max sequence + 1, bumped while the candidate is already taken.
 */
export function generateSku(
  existing: Array<Product | string | null>,
  category: string,
  settings?: ProductCodeSettings | null,
  prefix?: string | null,
): string {
  const cfg = normalizedCodeSettings(settings)
  const taken = new Set(
    existing
      .map((p) => (typeof p === 'string' ? p : (p as Product).sku ?? ''))
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  )
  let n = maxSequence([...taken], cfg, category, prefix) + 1
  let sku = renderSku(cfg, category, n, prefix)
  while (taken.has(sku.toUpperCase())) {
    n += 1
    sku = renderSku(cfg, category, n, prefix)
  }
  return sku
}

export interface DuplicateMatch {
  field: 'sku'
  product: Product
}

/** Existing product already using this SKU (case-insensitive). */
export function findDuplicateProduct(
  products: Product[],
  sku: string,
  excludeId?: string,
): DuplicateMatch | null {
  const s = sku.trim().toLowerCase()
  if (!s) return null
  for (const p of products) {
    if (excludeId && p.id === excludeId) continue
    if ((p.sku ?? '').trim().toLowerCase() === s) return { field: 'sku', product: p }
  }
  return null
}

/**
 * Cartesian product of the option definitions, Shopify order: the LAST option
 * varies fastest (Size × Colour → Small/Red, Small/Blue, Large/Red, …).
 * Returns the joined title and the aligned per-option values.
 */
export function combineOptions(options: Array<{ name: string; values: string[] }>): Array<{ title: string; optionValues: string[] }> {
  if (options.length === 0) return []
  return options.reduce<Array<{ title: string; optionValues: string[] }>>(
    (acc, option) => {
      const values = option.values.filter((v) => v.trim() !== '')
      if (values.length === 0) return acc
      const next: Array<{ title: string; optionValues: string[] }> = []
      for (const base of acc) {
        for (const value of values) {
          next.push({ title: [...base.optionValues, value].join(' / '), optionValues: [...base.optionValues, value] })
        }
      }
      return next
    },
    [{ title: '', optionValues: [] }],
  )
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
