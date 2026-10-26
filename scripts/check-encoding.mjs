#!/usr/bin/env node
// Fails when source files contain mojibake (double-encoded UTF-8) or are not
// valid UTF-8. The ₹/—/·/…/→ glyphs are the usual victims on Windows editors,
// so they are checked explicitly as well as any U+FFFD replacement character.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const roots = ['frontend/src', 'frontend/index.html', 'backend/src', 'scripts', 'docs', 'e2e', 'electron']
const skipDirs = new Set(['node_modules', 'dist', 'dist-electron', 'build', 'coverage', '.git'])
const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.sql', '.prisma', '.yml', '.yaml', '.txt', '.broken', '.tmp'])
const needles = ['Γé╣', 'â‚¹', 'ΓÇö', 'â€”', 'ΓÇô', 'â€“', 'ΓÇª', 'â€¦', '┬╖', 'Γå', 'â†', '\uFFFD']

const hits = []
function checkFile(full) {
  if (full === fileURLToPath(import.meta.url)) return
  const buf = readFileSync(full)
  if (buf.includes(0)) return
  const text = buf.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(buf)) {
    hits.push(`${relative(root, full)}: not valid UTF-8`)
    return
  }
  text.split(/\r?\n/).forEach((line, i) => {
    for (const needle of needles) {
      if (line.includes(needle)) hits.push(`${relative(root, full)}:${i + 1}: contains ${JSON.stringify(needle)}`)
    }
  })
}

function walk(target) {
  let info
  try {
    info = statSync(target)
  } catch {
    return
  }
  if (info.isDirectory()) {
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(join(target, entry.name))
      } else if (exts.has(extname(entry.name).toLowerCase()) || entry.name === 'index.html') {
        checkFile(join(target, entry.name))
      }
    }
    return
  }
  checkFile(target)
}

for (const target of roots) walk(resolve(root, target))

if (hits.length > 0) {
  console.error('Encoding check failed:\n' + hits.map((h) => `  ${h}`).join('\n'))
  process.exit(1)
}
console.log('Encoding check passed (UTF-8, no mojibake).')
