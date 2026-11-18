import test from 'node:test'
import assert from 'node:assert/strict'
import type { InventoryLocation } from '@/types'
import { locationTypeLabel, resolveRouteEndpoint, routeOptionLabel, transferOwnerLabel } from './transferRoute'

/**
 * Stock-transfer route labels.
 *
 * The list used to print whatever the row held — `LOC-DEFAULT → <uuid>` when
 * the destination row's location had been deleted. These tests pin the label
 * contract: enriched reference → locations list (ids AND legacy name-valued
 * rows) → an explicit "Location unavailable" marker, never a raw id; plus the
 * owner line that answers "where is the stock now".
 */

const locations: InventoryLocation[] = [
  { id: 'LOC-DEFAULT', name: 'Main Store', type: 'store', city: 'Mumbai', manager: '' },
  { id: 'e8a7b7cd-542f-406e-a13a-e7d5d9bcd27a', name: '2nd Store', type: 'warehouse', city: '', manager: '' },
  { id: 'LOC3', name: 'Warehouse - Bhiwandi', type: 'warehouse', city: 'Mumbai', manager: '' },
  { id: 'LOC4', name: 'Workshop - Zaveri Bazar', type: 'workshop', city: 'Mumbai', manager: '' },
]

test('enriched endpoints display the name and its context, never the id', () => {
  const ep = resolveRouteEndpoint({ name: 'Main Store', type: 'store', city: 'Mumbai' }, 'LOC-DEFAULT', [])
  assert.equal(ep.title, 'Main Store')
  assert.equal(ep.subtitle, 'Store · Mumbai')
  assert.equal(ep.missing, false)
})

test('id-valued rows resolve through the loaded locations list', () => {
  const ep = resolveRouteEndpoint(null, 'e8a7b7cd-542f-406e-a13a-e7d5d9bcd27a', locations)
  assert.equal(ep.title, '2nd Store')
  assert.equal(ep.subtitle, 'Warehouse')
  assert.equal(ep.missing, false)
})

test('historical name-valued transfers resolve by display name', () => {
  // Rows written before the id backfill store the name directly.
  const ep = resolveRouteEndpoint(null, 'Warehouse - Bhiwandi', locations)
  assert.equal(ep.title, 'Warehouse - Bhiwandi')
  assert.equal(ep.subtitle, 'Warehouse · Mumbai')
})

test('a deleted location degrades to a marker — never a UUID', () => {
  const raw = '0f8a1111-2222-3333-4444-555566667777'
  const ep = resolveRouteEndpoint(null, raw, locations)
  assert.equal(ep.title, 'Location unavailable')
  assert.equal(ep.missing, true)
  assert.equal(ep.subtitle, '', 'no id of any kind is exposed')
  assert.notEqual(ep.title, raw)
  assert.ok(!ep.subtitle.includes(raw), 'the full UUID never reaches the screen')
})

test('an empty reference shows a dash instead of crashing', () => {
  assert.deepEqual(resolveRouteEndpoint(null, null, locations), { title: '—', subtitle: '', missing: false })
  assert.deepEqual(resolveRouteEndpoint(null, '', locations), { title: '—', subtitle: '', missing: false })
  assert.deepEqual(resolveRouteEndpoint(undefined, undefined, []), { title: '—', subtitle: '', missing: false })
})

test('locationTypeLabel maps the three kinds of place', () => {
  assert.equal(locationTypeLabel('store'), 'Store')
  assert.equal(locationTypeLabel('warehouse'), 'Warehouse')
  assert.equal(locationTypeLabel('workshop'), 'Workshop')
  assert.equal(locationTypeLabel(null), '')
  assert.equal(locationTypeLabel('depot'), '')
})

test('dropdown options read as the standard location label — no UUIDs', () => {
  assert.equal(routeOptionLabel(locations[0]), 'Main Store · Store · Mumbai')
  assert.equal(routeOptionLabel(locations[1]), '2nd Store · Warehouse')
  assert.equal(routeOptionLabel({ name: 'Plain Yard', type: null, city: '' }), 'Plain Yard')
})

test('the owner line answers where the stock sits for every status', () => {
  const base = {
    from: 'LOC-DEFAULT',
    to: 'e8a7b7cd-542f-406e-a13a-e7d5d9bcd27a',
    fromLocation: { id: 'LOC-DEFAULT', name: 'Main Store', type: 'store', city: 'Mumbai' },
    toLocation: { id: 'e8a7b7cd-542f-406e-a13a-e7d5d9bcd27a', name: '2nd Store', type: 'warehouse', city: '' },
  }
  assert.equal(transferOwnerLabel({ ...base, status: 'pending' }, locations), 'Stock still at Main Store')
  assert.equal(transferOwnerLabel({ ...base, status: 'in-transit' }, locations), 'In transit — held at neither location')
  assert.equal(transferOwnerLabel({ ...base, status: 'received' }, locations), 'Stock now at 2nd Store')
  assert.equal(transferOwnerLabel({ ...base, status: 'cancelled' }, locations), 'Stock stays at Main Store')
})

test('the owner line stays readable when a location was removed', () => {
  const base = { from: 'LOC-DEFAULT', to: 'gone-location', fromLocation: null, toLocation: null }
  assert.equal(transferOwnerLabel({ ...base, status: 'pending' }, locations), 'Stock still at Main Store')
  assert.equal(transferOwnerLabel({ ...base, status: 'received' }, locations), 'Stock arrived at the destination')
  assert.equal(transferOwnerLabel({ ...base, status: 'cancelled' }, locations), 'Stock stays at Main Store')
})
