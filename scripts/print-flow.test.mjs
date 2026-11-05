// Proves the desktop print pipeline (electron/print.ts) end-to-end inside a
// REAL Electron process — the wiring unit tests cannot reach:
//
//   1. printHtml: hidden window → load → webContents.print({ silent: true })
//      to the OS default printer, no dialog. On a machine with no default
//      printer it must fail WITH A REASON (fallbackToDialog is disabled here
//      so CI can never block on a dialog).
//   2. printWebContents: the same, on an existing window — the path the
//      Dashboard / DayBook / invoice-dialog "print this page" buttons use.
//   3. pdfFromHtml(savePath): render + printToPDF — needs no printer, so it
//      must ALWAYS succeed and write a real PDF (proves the render path even
//      on printer-less CI).
//   4. Temp render files are cleaned up afterwards.
//
// The module is TypeScript, so electron/ is compiled with tsc first (the same
// command scripts/build-desktop.js runs) and the entry loads the emitted JS.
//
// Run: node --test scripts/print-flow.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(repoRoot, 'scripts', 'print-smoke-entry.js')

execSync('npx tsc', { cwd: join(repoRoot, 'electron'), stdio: 'pipe', timeout: 120000 })

const workDir = mkdtempSync(join(tmpdir(), 'opal-print-smoke-'))
const pdfPath = join(workDir, 'smoke.pdf')
const letterPdfPath = join(workDir, 'smoke-letter.pdf')

/** Width × height of the PDF's first page, in points. */
function mediaBox(path) {
  const s = readFileSync(path).toString('latin1')
  const m = s.match(/\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/)
  assert.ok(m, `PDF must declare a page size: ${path}`)
  return { width: Number(m[3]), height: Number(m[4]) }
}

after(() => rmSync(workDir, { recursive: true, force: true }))

function runSmoke() {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [entry], {
      cwd: repoRoot,
      env: { ...process.env, OPAL_SMOKE_PDF_PATH: pdfPath, OPAL_SMOKE_LETTER_PDF_PATH: letterPdfPath },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`print smoke timed out\nstdout:\n${out}\nstderr:\n${err}`))
    }, 150_000)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
  })
}

function parse(out, name) {
  const line = out.split('\n').find((l) => l.startsWith(name + ' '))
  assert.ok(line, `missing ${name} line in output:\n${out}`)
  return JSON.parse(line.slice(name.length + 1))
}

test('silent print, page print and PDF export run in a real Electron process', async () => {
  const { code, out, err } = await runSmoke()
  assert.equal(code, 0, `print smoke process failed (code=${code})\nstdout:\n${out}\nstderr:\n${err}`)

  // 1. Silent print: either the job was accepted, or it failed with a
  //    printer-stage reason (no default printer on this machine is fine —
  //    a swallowed or render-stage failure is not).
  const printed = parse(out, 'SMOKE_PRINT')
  if (printed.ok) {
    assert.equal(printed.error, undefined, 'a successful print must not carry an error')
  } else {
    assert.ok(
      printed.error && /print/i.test(printed.error),
      `print must fail with a printer-stage reason, got: ${JSON.stringify(printed)}`,
    )
    assert.ok(!/render|timed out while rendering/i.test(printed.error), `the document must render before printing: ${printed.error}`)
  }

  // 2. Page print reports a structured result too.
  const page = parse(out, 'SMOKE_PAGE')
  if (!page.ok) assert.ok(page.error && page.error.length > 0, 'a failed page print must explain why')

  // 3. PDF export needs no printer — it must always succeed and write a real PDF.
  const pdf = parse(out, 'SMOKE_PDF')
  assert.equal(pdf.ok, true, `PDF export must succeed even without a printer, got: ${pdf.error}`)
  const bytes = readFileSync(pdfPath)
  assert.ok(bytes.length > 200, `PDF too small: ${bytes.length} bytes`)
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'file must start with the PDF magic number')

  // 3b. …and it must land on the paper the DOCUMENT declares: a doc without a
  // @page keeps A4 (within Chromium's sub-point rounding), while a Letter label
  // sheet must NOT be exported on A4 — that mismatch is what made saved label
  // PDFs come out scaled and offset from the labels.
  const a4 = mediaBox(pdfPath)
  assert.ok(
    Math.abs(a4.width - 595.28) <= 3 && Math.abs(a4.height - 841.89) <= 3,
    `default export must be A4, got ${a4.width}×${a4.height}pt`,
  )
  const letter = parse(out, 'SMOKE_PDF_LETTER')
  assert.equal(letter.ok, true, `Letter PDF export must succeed, got: ${letter.error}`)
  const box = mediaBox(letterPdfPath)
  assert.ok(
    Math.abs(box.width - 612) <= 1 && Math.abs(box.height - 792) <= 1,
    `a document declaring @page{size:letter} must export on Letter paper, got ${box.width}×${box.height}pt`,
  )

  // 4. Temp render files are cleaned up (ignore files younger than 10s —
  //    another process could be mid-print right now).
  const cutoff = Date.now() - 10_000
  const stale = readdirSync(tmpdir())
    .filter((f) => /^opal-doc-.*\.html$/.test(f))
    .filter((f) => statSync(join(tmpdir(), f)).mtimeMs < cutoff)
  assert.deepEqual(stale, [], `leftover render files in ${tmpdir()}: ${stale.join(', ')}`)
})
