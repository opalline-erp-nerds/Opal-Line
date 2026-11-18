import test from 'node:test'
import assert from 'node:assert/strict'
import type { InventoryLocation } from '@/types'
import {
  LOCATION_UNAVAILABLE,
  formatLocationLabel,
  locationLabel,
  locationTypeLabel,
  resolveLocation,
  rowLocationLabel,
} from './locations'

/**
 * The inventory module's single location label contract:
 *   `Main Store · Store · Chennai` — name, type, city; never an id or UUID;
 *   `Location unavailable` for a reference that no longer resolves; a dash
 *   when there is no reference at all. Every inventory screen formats through
 * these helpers, so these tests are the regression net for "no raw location
 * ids anywhere in the UI".
 */

const locations: InventoryLocation[] = [
  { id: 'LOC-DEFAULT', name: 'Main Store', type: 'store', city: 'Chennai', manager: '' },
  { id: 'e8a7b7cd-542f-406e-a13a-e7d5d9bcd27a', name: '2nd Store', type: 'warehouse', city: '', manager: '' },
  { id: 'LOC3', name: 'Warehouse - Bhiwandi', type: 'warehouse', city: 'Mumbai', manager: '' },
  { id: 'LOC4', name: 'Workshop - Zaveri Bazar', type: 'workshop', city: 'Mumbai', manager: '' },
]

test('formatLocationLabel renders name · type · city', () => {
  assert.equal(formatLocationLabel(locations[0]), 'Main Store · Store · Chennai')
  assert.equal(formatLocationLabel(locations[1]), '2nd Store · Warehouse')
  assert.equal(formatLocationLabel(locations[3]), 'Workshop - Zaveri Bazar · Workshop · Mumbai')
  assert.equal(formatLocationLabel({ name: 'Bare Yard', type: null, city: null }), 'Bare Yard')
})

test('formatLocationLabel never invents a label from nothing', () => {
  assert.equal(formatLocationLabel(null), LOCATION_UNAVAILABLE)
  assert.equal(formatLocationLabel(undefined), LOCATION_UNAVAILABLE)
  assert.equal(formatLocationLabel({ name: '  ', type: 'store', city: 'Pune' }), LOCATION_UNAVAILABLE)
})

test('locationTypeLabel maps the three kinds of place', () => {
  assert.equal(locationTypeLabel('store'), 'Store')
  assert.equal(locationTypeLabel('warehouse'), 'Warehouse')
  assert.equal(locationTypeLabel('workshop'), 'Workshop')
  assert.equal(locationTypeLabel(null), '')
  assert.equal(locationTypeLabel('depot'), '')
})

test('resolveLocation prefers enriched data, then ids, then legacy names', () => {
  // 1. Enriched reference from the API wins.
  assert.equal(
    resolveLocation({ name: 'Main Store', type: 'store', city: 'Chennai' }, 'LOC-DEFAULT', []).title,
    'Main Store',
  )
  // 2. Id-valued rows resolve through the loaded list.
  const byId = resolveLocation(null, 'e8a7b7cd-542f-406e-a13a-e7d5d9bcd27a', locations)
  assert.equal(byId.title, '2nd Store')
  assert.equal(byId.subtitle, 'Warehouse')
  assert.equal(byId.missing, false)
  // 3. Legacy rows store the display name instead of the id.
  const byName = resolveLocation(null, 'Warehouse - Bhiwandi', locations)
  assert.equal(byName.title, 'Warehouse - Bhiwandi')
  assert.equal(byName.subtitle, 'Warehouse · Mumbai')
})

test('resolveLocation degrades a deleted reference without exposing the id', () => {
  const raw = '0f8a1111-2222-3333-4444-555566667777'
  const r = resolveLocation(null, raw, locations)
  assert.equal(r.title, LOCATION_UNAVAILABLE)
  assert.equal(r.subtitle, '')
  assert.equal(r.missing, true)
  assert.ok(!r.title.includes(raw) && !r.subtitle.includes(raw), 'no part of the UUID is shown')
  // No reference at all reads as a dash, not as a broken reference.
  assert.deepEqual(resolveLocation(null, null, locations), { title: '—', subtitle: '', missing: false })
  assert.deepEqual(resolveLocation(null, '', locations), { title: '—', subtitle: '', missing: false })
})

test('locationLabel joins the standard single-line label', () => {
  assert.equal(locationLabel({ name: 'Main Store', type: 'store', city: 'Chennai' }, 'LOC-DEFAULT', locations), 'Main Store · Store · Chennai')
  assert.equal(locationLabel(null, 'LOC4', locations), 'Workshop - Zaveri Bazar · Workshop · Mumbai')
  assert.equal(locationLabel(null, 'ghost-id', locations), LOCATION_UNAVAILABLE)
  assert.equal(locationLabel(null, null, locations), '—')
})

test('rowLocationLabel handles API rows: enriched, unresolved and absent', () => {
  // Enriched row (what /inventory/movements and /inventory/levels now return).
  assert.equal(
    rowLocationLabel({ locationId: 'LOC-DEFAULT', locationName: 'Main Store', locationType: 'store', locationCity: 'Chennai' }),
    'Main Store · Store · Chennai',
  )
  // The location was deleted after the movement was written: the id is still
  // on the row, but the label must be the fallback, never the id.
  assert.equal(
    rowLocationLabel({ locationId: '0f8a1111-2222-3333-4444-555566667777', locationName: null, locationType: null, locationCity: null }),
    LOCATION_UNAVAILABLE,
  )
  // A movement with no location at all.
  assert.equal(rowLocationLabel({ locationId: null, locationName: null, locationType: null, locationCity: null }), '—')
  assert.equal(rowLocationLabel(null), '—')
  // Enriched but unnamed (defensive): falls back on the id, still no UUID shown.
  assert.equal(rowLocationLabel({ locationId: 'LOC-DEFAULT', locationName: ' ' }), LOCATION_UNAVAILABLE)
})
