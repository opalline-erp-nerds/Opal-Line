import type { InventoryLocation } from '@/types'

/**
 * One shared location formatter/resolver for the whole inventory module.
 *
 * Locations are stored as ids (`inventory_locations.id`, UUIDs for anything
 * created in the UI; `LOC-DEFAULT` for the seeded main store) and legacy rows
 * sometimes store the display NAME instead. Every screen must show the human
 * reference — `Main Store · Store · Chennai` — and never a raw id or UUID, so
 * all presentation goes through here instead of each page rolling its own.
 *
 * Ids stay exactly where they belong: API payloads, `value=` on selects and
 * database relationships. Only the label changes.
 */

/** The name/type/city fields a location reference carries. */
export interface LocationDetails {
  name?: string | null
  type?: string | null
  city?: string | null
}

/** Resolved, display-ready view of one location reference. */
export interface ResolvedLocation {
  title: string
  /** `Store · Chennai` context line; empty when nothing is known. */
  subtitle: string
  /** True when a reference exists but no longer resolves to a location. */
  missing: boolean
}

/** Shown for a reference that cannot be resolved (deleted/unknown location). */
export const LOCATION_UNAVAILABLE = 'Location unavailable'

/** `store` → `Store`, `warehouse` → `Warehouse`, `workshop` → `Workshop`. */
export function locationTypeLabel(type?: string | null): string {
  const t = String(type ?? '').trim().toLowerCase()
  if (t === 'store') return 'Store'
  if (t === 'warehouse') return 'Warehouse'
  if (t === 'workshop') return 'Workshop'
  return ''
}

function details(loc: LocationDetails): { title: string; subtitle: string } {
  const title = String(loc.name ?? '').trim() || 'Unnamed location'
  const subtitle = [locationTypeLabel(loc.type), String(loc.city ?? '').trim()].filter(Boolean).join(' · ')
  return { title, subtitle }
}

/** The standard label: `Main Store · Store · Chennai`. */
export function formatLocationLabel(loc: LocationDetails | null | undefined): string {
  if (!loc || !String(loc.name ?? '').trim()) return LOCATION_UNAVAILABLE
  const { title, subtitle } = details(loc)
  return subtitle ? `${title} · ${subtitle}` : title
}

/**
 * Resolve one reference for display: the enriched data the API returns first,
 * then the loaded locations list (matching ids AND legacy name-valued rows),
 * then the safe fallback. Never returns an id or UUID.
 */
export function resolveLocation(
  enriched: LocationDetails | null | undefined,
  raw: string | null | undefined,
  known: InventoryLocation[],
): ResolvedLocation {
  if (enriched && String(enriched.name ?? '').trim()) return { ...details(enriched), missing: false }
  const value = String(raw ?? '').trim()
  // No reference at all (a movement with no location) reads as a dash rather
  // than as a broken reference.
  if (!value) return { title: '—', subtitle: '', missing: false }
  const match = known.find((l) => l.id === value || l.name === value)
  if (match) return { ...details(match), missing: false }
  return { title: LOCATION_UNAVAILABLE, subtitle: '', missing: true }
}

/** Single-line label for a resolved reference: `Main Store · Store · Chennai`. */
export function locationLabel(
  enriched: LocationDetails | null | undefined,
  raw: string | null | undefined,
  known: InventoryLocation[],
): string {
  const r = resolveLocation(enriched, raw, known)
  if (r.missing) return LOCATION_UNAVAILABLE
  if (r.title === '—') return '—'
  return r.subtitle ? `${r.title} · ${r.subtitle}` : r.title
}

/**
 * Label for an API row that carries both the id and the resolved metadata
 * (`locationId` + `locationName/locationType/locationCity`). A row whose id no
 * longer resolves — a location deleted after the movement was written — shows
 * the fallback, never the id.
 */
export interface EnrichedLocationRow {
  locationId?: string | null
  locationName?: string | null
  locationType?: string | null
  locationCity?: string | null
}

export function rowLocationLabel(row: EnrichedLocationRow | null | undefined): string {
  if (!row) return '—'
  if (String(row.locationName ?? '').trim()) {
    return formatLocationLabel({ name: row.locationName, type: row.locationType, city: row.locationCity })
  }
  return row.locationId ? LOCATION_UNAVAILABLE : '—'
}
