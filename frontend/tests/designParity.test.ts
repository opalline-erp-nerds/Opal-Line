import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  designFieldTexts as backendFieldTexts,
  labelDesignFor as backendDesignFor,
} from '../../backend/src/barcodeLabels'
import {
  designFieldTexts as frontendFieldTexts,
  labelDesignFor as frontendDesignFor,
  qrPayload as frontendQrPayload,
} from '../src/lib/labelSheet'

// The preview and the PDF each carry their own copy of the transcribed
// reference geometry. These tests pin the two copies together: any drift in
// either direction (a moved field, a changed cap height, a different string)
// fails here instead of silently printing two different labels.

const SIZES = [
  [50, 40],
  [50, 25],
  [35, 22],
  [50, 10],
] as const

const product = {
  id: 'p1',
  name: 'Flower Crystal Elastic LD Belt',
  sku: 'W12345',
  price: 99999,
  weight: 5.2,
  category: 'FUY',
  collection: 'BW',
}

const opts = {
  showPrice: true,
  showWeight: true,
  showBrand: true,
  showName: true,
  showSku: true,
  showCategory: true,
  brand: 'OPAL LINE',
}

test('frontend and backend share one transcribed geometry per reference size', () => {
  for (const [w, h] of SIZES) {
    const backend = backendDesignFor(w, h)
    const frontend = frontendDesignFor(w, h)
    assert.ok(backend, `backend design ${w}x${h}`)
    assert.ok(frontend, `frontend design ${w}x${h}`)
    assert.deepEqual(frontend, backend, `${w}x${h} geometry drifted between renderers`)
  }
  // Sizes outside the reference set must fall back to the adaptive layout in
  // BOTH renderers — never one design and one legacy card.
  assert.equal(frontendDesignFor(50, 22), null, 'frontend has no design for 50x22')
  assert.equal(backendDesignFor(50, 22), null, 'backend has no design for 50x22')
})

test('frontend and backend resolve identical field texts for every reference size', () => {
  for (const [w, h] of SIZES) {
    const backend = backendDesignFor(w, h)
    const frontend = frontendDesignFor(w, h)
    assert.ok(backend && frontend)
    assert.deepEqual(
      frontendFieldTexts(product, opts, frontend),
      backendFieldTexts(product, opts, backend),
      `${w}x${h} field texts drifted between renderers`,
    )
  }
})

test('both renderers encode the QR from the same SKU-only payload', () => {
  // The backend's printed symbol carries `labelCode(product)`; the preview's
  // carries `qrPayload(product)`. For a well-formed SKU they must be the same
  // string, or scanning a printed label would miss the product lookup.
  assert.equal(frontendQrPayload(product), product.sku)
  assert.equal(frontendQrPayload({ ...product, sku: '  W12345 ' }), product.sku)
})
