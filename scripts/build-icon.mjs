#!/usr/bin/env node

/**
 * Generates the Windows app icon (build/icon.ico + build/icon.png) from the
 * frontend brand mark (frontend/public/favicon.svg) using the Playwright
 * Chromium already installed for the repo's audit scripts — no extra image
 * tooling required.
 *
 * Each size is rendered on a brand-teal rounded tile with the mark knocked
 * out to white, screenshotted to PNG (ICO entries may hold PNG data since
 * Vista), and packed into a single multi-size .ico.
 *
 * Usage: node scripts/build-icon.mjs
 */

import { chromium } from 'playwright'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'build')
const SVG_PATH = join(ROOT, 'frontend', 'public', 'favicon.svg')

// 16/24/32/48/64 cover taskbar + tray, 128/256 cover Explorer large tiles.
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const PRIMARY_SIZE = 256

function pageHtml(size, svgDataUrl) {
  const radius = Math.round(size * 0.22)
  const glyph = Math.round(size * 0.66)
  return `<!doctype html><html><body style="margin:0;background:transparent">
<div id="tile" style="width:${size}px;height:${size}px;border-radius:${radius}px;
background:linear-gradient(135deg,#10B981 0%,#008F78 45%,#006B5B 100%);
display:flex;align-items:center;justify-content:center;overflow:hidden">
<img src="${svgDataUrl}" style="width:${glyph}px;height:${glyph}px;object-fit:contain;
filter:brightness(0) invert(1) drop-shadow(0 1px 1px rgba(0,0,0,.15))" />
</div></body></html>`
}

/** Packs PNG buffers into a multi-image ICO (PNG-compressed entries). */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  let offset = 6 + 16 * entries.length
  const dirEntries = []
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size // 0 means 256
    e[1] = size >= 256 ? 0 : size
    e.writeUInt16LE(1, 4) // color planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    dirEntries.push(e)
  }
  return Buffer.concat([header, ...dirEntries, ...entries.map((e) => e.png)])
}

async function main() {
  const svg = readFileSync(SVG_PATH, 'utf8')
  const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`

  mkdirSync(OUT_DIR, { recursive: true })
  const browser = await chromium.launch()
  try {
    const entries = []
    for (const size of SIZES) {
      const context = await browser.newContext({
        viewport: { width: size, height: size },
        deviceScaleFactor: 1,
      })
      const page = await context.newPage()
      await page.setContent(pageHtml(size, svgDataUrl), { waitUntil: 'load' })
      const png = await page.locator('#tile').screenshot({
        omitBackground: true,
        animations: 'disabled',
      })
      entries.push({ size, png: Buffer.from(png) })
      if (size === PRIMARY_SIZE) {
        writeFileSync(join(OUT_DIR, 'icon.png'), png)
      }
      await context.close()
      console.log(`  rendered ${size}x${size}`)
    }
    writeFileSync(join(OUT_DIR, 'icon.ico'), buildIco(entries))
    console.log(`✅ Wrote ${join(OUT_DIR, 'icon.ico')} (+ icon.png, ${SIZES.join('/')} px)`)
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error('Icon build failed:', err)
  process.exit(1)
})
