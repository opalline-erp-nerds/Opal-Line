import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import type { Request, Response } from 'express'
import { logger } from './logger'

/** Supabase Storage. Absent on the desktop, which keeps writing local files. */
export function supabaseStorageConfig(env: NodeJS.ProcessEnv = process.env): { url: string; key: string; bucket: string } | null {
  const url = (env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  const key = (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  const bucket = (env.SUPABASE_STORAGE_BUCKET ?? '').trim() || 'product-images'
  if (!url || !key) return null
  return { url, key, bucket }
}

// Uploads live under the backend package root (same logic as backups), so the
// folder stays stable regardless of how the server process is launched.
let _uploadsDir: string | null = null
export function UPLOADS_DIR(): string {
  if (process.env.UPLOADS_DIR) return resolve(process.env.UPLOADS_DIR)
  if (_uploadsDir) return _uploadsDir
  let dir = __dirname
  for (let i = 0; i < 8; i++) {
    try {
      if (existsSync(join(dir, 'package.json'))) break
    } catch {
      /* keep walking up */
    }
    const parent = require('node:path').dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  _uploadsDir = process.env.UPLOADS_DIR
    ? resolve(process.env.UPLOADS_DIR)
    : process.env.APP_DATA_DIR?.trim()
      ? join(process.env.APP_DATA_DIR.trim(), 'uploads')
      : join(dir, 'uploads')
  return _uploadsDir
}

const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 // 8 MB per image

/**
 * Verify the file's magic bytes actually match the declared image type.
 * The client-declared mime in a data URL is trivially spoofed; without this
 * check a "PNG" could really be an HTML/SVG/EXE payload (stored-XSS or
 * download-and-run risk when served from /uploads).
 */
export function matchesImageMagic(buf: Buffer, mime: string): boolean {
  if (buf.length < 12) return false
  switch (mime) {
    case 'image/jpeg':
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
    case 'image/png':
      return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
    case 'image/gif':
      return buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a'
    case 'image/webp':
      return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP'
    case 'image/avif':
      // ISO-BMFF: bytes 4..8 are 'ftyp', 8..12 is the brand (avic/avif/mif1…)
      return buf.subarray(4, 8).toString('latin1') === 'ftyp' && /^(avic|avif|mif1|msf1|avis)$/.test(buf.subarray(8, 12).toString('latin1'))
    default:
      return false
  }
}

export function ensureUploadsDir(): string {
  const dir = UPLOADS_DIR()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Save one uploaded image. Accepts a data URL ("data:image/png;base64,...").
 * Desktop (no Supabase env) returns a local web path ("/uploads/<file>").
 * Hosted mode, when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set,
 * stores the bytes in that Storage bucket and returns the public object URL.
 * The bucket must be public so the browser and Shopify can fetch it.
 */
export async function saveUploadedImage(dataUrl: string): Promise<string | null> {
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl.trim())
  if (!match) return null
  const mime = match[1].toLowerCase()
  const ext = ALLOWED_MIME[mime]
  if (!ext) return null
  const buf = Buffer.from(match[2], 'base64')
  if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) return null
  if (!matchesImageMagic(buf, mime)) return null
  const hash = createHash('sha1').update(buf).digest('hex').slice(0, 16)
  const fileName = `${hash}-${randomUUID().slice(0, 8)}.${ext}`
  const storage = supabaseStorageConfig()
  if (storage) {
    const objectPath = `products/${fileName}`
    const res = await fetch(`${storage.url}/storage/v1/object/${encodeURIComponent(storage.bucket)}/${objectPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${storage.key}`,
        apikey: storage.key,
        'Content-Type': mime,
        'x-upsert': 'true',
      },
      body: buf,
    })
    if (!res.ok) {
      logger.error({ status: res.status }, 'Supabase storage upload failed')
      return null
    }
    return `${storage.url}/storage/v1/object/public/${storage.bucket}/${objectPath}`
  }
  ensureUploadsDir()
  const filePath = join(UPLOADS_DIR(), fileName)
  if (!existsSync(filePath)) {
    require('node:fs').writeFileSync(filePath, buf)
  }
  return `/uploads/${fileName}`
}

/**
 * Express middleware: POST /api/v1/uploads/image
 * Body: { dataUrl: "data:image/png;base64,..." } (single) or { dataUrls: [...] } (batch)
 * Returns: { paths: ["/uploads/xxx.png", ...] }
 */
export async function uploadImageHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as { dataUrl?: unknown; dataUrls?: unknown }
    const inputs: string[] = Array.isArray(body.dataUrls)
      ? (body.dataUrls as unknown[]).filter((x): x is string => typeof x === 'string')
      : typeof body.dataUrl === 'string'
        ? [body.dataUrl]
        : []
    if (inputs.length === 0) {
      res.status(400).json({ error: 'No image data provided' })
      return
    }
    if (inputs.length > 20) {
      res.status(400).json({ error: 'Too many images (max 20 per product)' })
      return
    }
    const paths: string[] = []
    const errors: string[] = []
    for (const [i, dataUrl] of inputs.entries()) {
      const saved = await saveUploadedImage(dataUrl)
      if (saved) paths.push(saved)
      else errors.push(`Image ${i + 1}: unsupported format or too large (max 8 MB, jpeg/png/webp/gif/avif)`)
    }
    if (paths.length === 0) {
      res.status(400).json({ error: errors.join('; ') || 'No valid images saved' })
      return
    }
    res.json({ ok: true, paths, errors: errors.length ? errors : undefined })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'Image upload failed')
    res.status(500).json({ error: 'Failed to save image' })
  }
}

/**
 * Express static fallback: GET /uploads/:fileName with basic hardening.
 * (express.static is mounted on the folder in index.ts; this handler is a
 * belt-and-braces resolver used by the SPA fallback path if needed.)
 */
export function resolveUploadPath(fileName: string): string | null {
  const safe = basename(fileName)
  if (safe !== fileName || safe.startsWith('.')) return null
  const resolved = join(UPLOADS_DIR(), safe)
  if (!resolved.startsWith(UPLOADS_DIR())) return null
  return existsSync(resolved) ? resolved : null
}

export function readUpload(fileName: string): Buffer | null {
  const p = resolveUploadPath(fileName)
  if (!p) return null
  try {
    return readFileSync(p)
  } catch {
    return null
  }
}
