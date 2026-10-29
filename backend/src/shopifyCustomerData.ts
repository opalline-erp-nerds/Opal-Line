/**
 * Pure helpers for the Shopify customer / order data sync.
 *
 * Shopify governs this data with three quirks this module exists for:
 *   1. Plan-gated PII (Protected Customer Data) — every customer/email/phone
 *      field can arrive EMPTY or be replaced by an email-only stand-in. The
 *      sync must never write an empty value over a real one.
 *   2. Placeholder rows — without PII the import named customers
 *      "Shopify Customer #<id>". Once a real name arrives (mailbox, CSV, API)
 *      it must replace the placeholder, but never clobber a real name.
 *   3. Loose identity matching — the same customer can appear with a
 *      differently-cased email or a differently-formatted phone.
 *
 * No imports, no DB, no Shopify: every function is pure so the historical
 * redaction bugs are covered by unit tests.
 */

/** Placeholder the API sync creates when it cannot see the customer's name. */
export const PLACEHOLDER_NAME_RE = /^Shopify Customer #\d+$/

/** A bare email in the name field is a redaction artifact, not a name. */
export const EMAIL_AS_NAME_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Values Shopify writes when it REDACTS a field (or a user enters nothing).
 * Case-insensitive compare; keep the list tight — a real customer could
 * plausibly be named "None" but never "Redacted (redacted by app)".
 */
const REDACTED_VALUES = new Set([
  '',
  '-',
  '—',
  'guest',
  'n/a',
  'na',
  'none',
  'null',
  'redacted',
  'redacted (redacted by app)',
  'undefined',
])

/** Non-empty, non-redaction value; returns the trimmed text or null. */
export function usableText(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  if (REDACTED_VALUES.has(s.toLowerCase())) return null
  if (s.toLowerCase().startsWith('redacted')) return null
  return s
}

/** True when the value is missing entirely after redaction handling. */
export function isBlankPii(v: unknown): boolean {
  return usableText(v) === null
}

/** "Foo@Bar.COM " → "foo@bar.com"; unusable → null. */
export function normalizeEmail(v: unknown): string | null {
  const s = usableText(v)
  return s ? s.toLowerCase() : null
}

/** Digits only, for comparing "+91 98765 43210" with "9876543210". */
export function normalizePhone(v: unknown): string | null {
  const s = usableText(v)
  return s ? s.replace(/\D/g, '') : null
}

/** Placeholder or blank → treat as a name slot that may be upgraded. */
export function isPlaceholderName(v: string | null | undefined): boolean {
  const s = usableText(v)
  if (!s) return true
  return PLACEHOLDER_NAME_RE.test(s)
}

/**
 * The name a record currently carries is "weak" (upgradeable) when it is
 * blank, the "Shopify Customer #<id>" placeholder, the "Guest" stand-in, or
 * an email standing in for a redacted name.
 */
function isWeakName(v: string | null | undefined): boolean {
  return isPlaceholderName(v) || EMAIL_AS_NAME_RE.test((v ?? '').trim())
}

/**
 * Resolve the display name between an existing record and a fresh value.
 *
 * A real Shopify name replaces a placeholder / blank / Guest / email-name.
 * A placeholder, blank or email-value NEVER replaces a real name.
 *
 * An email value only fills a BLANK slot: the "Shopify Customer #<id>"
 * placeholder is a lookup key elsewhere (mailbox recovery, CSV import), so it
 * survives until a real name arrives.
 */
export function upgradeName(existing: string | null | undefined, incoming: string | null | undefined): string {
  const next = usableText(incoming)
  const cur = usableText(existing)
  if (next && !isPlaceholderName(next) && !EMAIL_AS_NAME_RE.test(next)) {
    return isWeakName(existing) ? next : cur ?? next
  }
  // Incoming is blank/placeholder/email: keep the existing name (real OR
  // intentional placeholder); fall back to the incoming value only when the
  // existing slot is empty.
  return cur ?? next ?? ''
}

/**
 * Preserve the existing value whenever the fresh one is missing
 * (null / '' / redaction). Used for email, phone, city, province … where a
 * redacted Shopify response must not blank out ERP data.
 */
export function fillOrKeep(existing: string | null | undefined, incoming: string | null | undefined): string | null {
  const next = usableText(incoming)
  if (next) return next
  const cur = usableText(existing)
  return cur ?? (existing == null ? null : String(existing))
}

export interface OrderAddress {
  name?: string
  address1?: string
  address2?: string
  city?: string
  province?: string
  zip?: string
  country?: string
  phone?: string
}

const ADDRESS_KEYS: Array<keyof OrderAddress> =
  ['name', 'address1', 'address2', 'city', 'province', 'zip', 'country', 'phone']

/**
 * Order receiver name: the API returns the fresher snapshot of this order's
 * addresses, so a real non-email name wins even over a stored real name —
 * but a redacted (blank) or email-shaped incoming value never erases the
 * locally recovered one. Placeholder input is kept when nothing better exists.
 */
function resolveReceiverName(existing: string | null | undefined, incoming: string | null | undefined): string {
  const next = usableText(incoming)
  if (next && !isPlaceholderName(next) && !EMAIL_AS_NAME_RE.test(next)) return next
  return upgradeName(usableText(existing), next)
}

/**
 * Merge a fresh order address over the locally stored one, field by field:
 * every usable incoming value wins; locally recovered values survive a
 * redacted (empty) incoming field. Fields that end up empty are DROPPED so an
 * empty string is never written into the jsonb address. Returns undefined
 * when there is nothing worth writing (incoming absent, or a redacted payload
 * against no existing data).
 */
export function mergeAddress(
  existing: OrderAddress | null | undefined,
  incoming: OrderAddress | null | undefined,
): OrderAddress | undefined {
  if (!incoming) return undefined
  const out: OrderAddress = {}
  let any = false
  for (const key of ADDRESS_KEYS) {
    const merged = key === 'name'
      ? resolveReceiverName(usableText(existing?.[key]), usableText(incoming[key]))
      : fillOrKeep(usableText(existing?.[key]), usableText(incoming[key])) ?? ''
    if (merged) {
      out[key] = merged
      any = true
    }
  }
  if (!any) return undefined
  return out
}

/**
 * Identity matching order enforced across every sync/import path:
 * the numeric Shopify customer id wins, then email, then phone. Each source
 * is passed already-resolved (or null) by the caller.
 */
export function pickCustomerMatch<T>(sources: {
  byShopifyId?: T | null
  byEmail?: T | null
  byPhone?: T | null
}): T | null {
  return sources.byShopifyId ?? sources.byEmail ?? sources.byPhone ?? null
}

/**
 * Shopify returns HTTP 200 with customer PII silently STRIPPED when an app
 * token lacks Protected Customer Data approval (plan-gated): the order still
 * carries customer.id, but first_name / last_name / email / phone are dropped
 * and the addresses are reduced to region-only fields (province + country).
 * Imported as-is that payload became a "Guest" row with no error anywhere —
 * this detector gives the sync the means to SAY what is missing instead of
 * pretending there was no data.
 *
 * True only when a customer object is present but completely stripped AND no
 * contact field survives anywhere on the order (customer email/phone, the
 * order-level email/phone, no readable address detail). A guest checkout that
 * simply has no name still has its email, and matches no false positive.
 */
export function orderCustomerPiiRedacted(order: unknown): boolean {
  if (!order || typeof order !== 'object') return false
  const o = order as Record<string, unknown>
  const customer = (o.customer ?? null) as Record<string, unknown> | null
  if (!customer || customer.id == null) return false
  if (
    usableText(customer.first_name) ||
    usableText(customer.last_name) ||
    usableText(customer.email) ||
    usableText(customer.phone) ||
    usableText(o.email) ||
    usableText(o.phone)
  ) return false
  // The addresses must survive, if at all, as region-only stubs: any readable
  // address1 / name / phone / city means the order was NOT mass-redacted.
  const addressStubs = [o.billing_address, o.shipping_address].filter(
    (a): a is Record<string, unknown> => Boolean(a && typeof a === 'object'),
  )
  for (const a of addressStubs) {
    if (
      usableText(a.address1) ||
      usableText(a.name) ||
      usableText(a.phone) ||
      (usableText(a.city) && usableText(a.zip))
    ) return false
  }
  return true
}

/**
 * Whether a placeholder-named row must be matched by its name even when no
 * email/phone exists ("Shopify Customer #<id>", id required to be real).
 */
export function placeholderName(shopifyNumericId: string | null | undefined): string | null {
  const s = (shopifyNumericId ?? '').trim()
  return /^\d+$/.test(s) ? `Shopify Customer #${s}` : null
}

/**
 * Build an OrderAddress from a Shopify REST address object, or null when
 * nothing usable survives.
 *
 * A redacted address (plan-gated Protected Customer Data) lists ONLY
 * province/country. Those fields are real, usable region data and MUST be
 * kept: the old local builder kept an address only when name/address1/city/
 * phone was non-empty, so a province/country-only stub was thrown away and
 * the order row lost even the region Shopify actually returned.
 */
export function parseOrderAddress(src: unknown): OrderAddress | null {
  if (!src || typeof src !== 'object') return null
  const s = src as Record<string, unknown>
  const val = (v: unknown) => usableText(v) ?? ''
  const addr: OrderAddress = {
    name: `${val(s.first_name)} ${val(s.last_name)}`.trim(),
    address1: val(s.address1),
    address2: val(s.address2),
    city: val(s.city),
    province: val(s.province),
    zip: val(s.zip),
    country: val(s.country),
    phone: val(s.phone),
  }
  for (const key of ADDRESS_KEYS) {
    if (addr[key]) return addr
  }
  return null
}

/**
 * The NUMERIC Shopify order id from a local sales_orders row id.
 *
 * Imported rows keep it in the id column ("shopify-7660565233727"), while
 * shopify_id holds the display name ("#1027"). GraphQL's node(id:) only
 * accepts the numeric form — feeding it the display name resolves to no node,
 * which used to make every order-enrichment run skip silently.
 */
export function numericShopifyOrderId(rowId: unknown): string {
  return String(rowId ?? '').trim().match(/^shopify-(\d+)$/)?.[1] ?? ''
}
