import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveUploadedImage, supabaseStorageConfig } from './uploads'

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 0, 0, 0, 0, 0,
])

function dataUrl(): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

test('without Supabase env, an upload stays on local disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opal-uploads-'))
  const prevDir = process.env.UPLOADS_DIR
  const prevUrl = process.env.SUPABASE_URL
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  process.env.UPLOADS_DIR = dir
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  try {
    assert.equal(supabaseStorageConfig(), null)
    const saved = await saveUploadedImage(dataUrl())
    assert.match(saved ?? '', /^\/uploads\/[a-f0-9]+-[a-f0-9-]+\.png$/)
    assert.equal(existsSync(join(dir, (saved ?? '').replace('/uploads/', ''))), true)
  } finally {
    if (prevDir === undefined) delete process.env.UPLOADS_DIR
    else process.env.UPLOADS_DIR = prevDir
    if (prevUrl === undefined) delete process.env.SUPABASE_URL
    else process.env.SUPABASE_URL = prevUrl
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey
    await rm(dir, { recursive: true, force: true })
  }
})

test('with Supabase env, an upload returns the public object URL and does not write a file', async () => {
  const prevUrl = process.env.SUPABASE_URL
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const prevBucket = process.env.SUPABASE_STORAGE_BUCKET
  process.env.SUPABASE_URL = 'https://project.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role'
  process.env.SUPABASE_STORAGE_BUCKET = 'product-images'
  const original = globalThis.fetch
  let called = ''
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    called = String(input)
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  try {
    const saved = await saveUploadedImage(dataUrl())
    assert.match(called, /\/storage\/v1\/object\/product-images\/products\//)
    assert.match(saved ?? '', /^https:\/\/project\.supabase\.co\/storage\/v1\/object\/public\/product-images\/products\/.+\.png$/)
  } finally {
    globalThis.fetch = original
    if (prevUrl === undefined) delete process.env.SUPABASE_URL
    else process.env.SUPABASE_URL = prevUrl
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey
    if (prevBucket === undefined) delete process.env.SUPABASE_STORAGE_BUCKET
    else process.env.SUPABASE_STORAGE_BUCKET = prevBucket
  }
})
