// Printing for the desktop app.
//
// The renderer cannot open print popups: main.ts's window-open handler denies
// every window.open(), so the old popup-based printDocument() silently did
// nothing. Instead the built HTML is sent over IPC and handled here:
//
//   printHtml   → hidden BrowserWindow renders it, then
//                 webContents.print({ silent: true }) spools the job straight
//                 to the OS DEFAULT printer — no dialog, no app picker.
//                 If the default printer refuses the job (or none is
//                 configured) we show the window and retry once with the
//                 system print dialog so printing never fails silently
//                 (pass fallbackToDialog: false to disable, e.g. in tests).
//   pdfFromHtml → webContents.printToPDF() + a save dialog → a real .pdf
//                 (what "Export PDF" always meant; needs no printer).
//   previewHtml → a visible window with the document and no printing, for
//                 the Print Designer's preview.
//
// Jobs run one at a time (enqueue) so bulk printing keeps document order and
// never interleaves spool jobs on the default printer.

import { app, BrowserWindow, dialog } from 'electron'
import type { WebContents } from 'electron'
import { join } from 'node:path'
import { writeFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

export interface PrintResult {
  ok: boolean
  error?: string
}

/** How a print job should run: straight to the default printer, or through
 *  the system print dialog (the Ctrl+P-style picker). */
export type PrintMode = 'silent' | 'dialog'

export interface PdfResult {
  ok: boolean
  cancelled?: boolean
  path?: string
  error?: string
}

/** Sanity cap — a runaway renderer must not queue unbounded temp files. */
const MAX_HTML_BYTES = 16 * 1024 * 1024
const RENDER_TIMEOUT_MS = 45_000

let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.then(() => undefined, () => undefined)
  return run
}

function tooLarge(html: string): string | null {
  return Buffer.byteLength(html) > MAX_HTML_BYTES
    ? `document is too large to render (${Buffer.byteLength(html)} bytes)`
    : null
}

function tempHtmlFile(): string {
  return join(app.getPath('temp'), `opal-doc-${randomBytes(8).toString('hex')}.html`)
}

/** Paper geometry a job must print on. */
type PrintJobOptions = {
  margins?: { marginType: 'default' | 'none' | 'printableArea' | 'custom' }
  pageSize?: 'A3' | 'A4' | 'A5' | 'Legal' | 'Letter' | 'Tabloid'
}

/**
 * The page geometry a built document declares for itself in its own `@page`
 * rule (label sheets and invoices both emit `@page{size:…;margin:0;}` and lay
 * their content out inside that box, margins included).
 *
 * Chromium honours that rule when printing a window, but `printToPDF` answers
 * with its own defaults instead — 1 cm margins and "scale the content to fit
 * the paper" — which is what shrank label sheets onto a normal-looking page
 * and pushed the artwork 1 cm in from the sheet edge. Reading the declaration
 * back lets the desktop pipeline print and save exactly what the document asks
 * for: its own stock, its own margins, no scaling.
 */
function declaredPage(html: string): { size?: PrintJobOptions['pageSize']; marginZero: boolean } {
  const rule = /@page\s*\{([^}]*)\}/.exec(html)?.[1] ?? ''
  const sizes: Record<string, NonNullable<PrintJobOptions['pageSize']>> = {
    a3: 'A3',
    a4: 'A4',
    a5: 'A5',
    letter: 'Letter',
    legal: 'Legal',
  }
  const size = /(?:^|[;\s])size\s*:\s*(a3|a4|a5|letter|legal)\b/i.exec(rule)
  const marginZero = /(?:^|[;\s])margin\s*:\s*0(?:\.0+)?(?:px)?\s*(?:;|$)/i.test(rule)
  return {
    size: size ? sizes[size[1].toLowerCase()] : undefined,
    marginZero,
  }
}

/**
 * Write the HTML to a temp file, render it in a hidden window, run `fn` with
 * the loaded webContents, then always destroy the window and delete the file.
 * Rejects (never hangs) on load failure or a 45s render timeout.
 */
function withRenderedDocument<T>(html: string, title: string, fn: (win: BrowserWindow) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tooBig = tooLarge(html)
    if (tooBig) { reject(new Error(tooBig)); return }

    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 760,
      title,
      webPreferences: { sandbox: true },
    })
    const file = tempHtmlFile()
    let done = false
    const finish = (run: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { if (!win.isDestroyed()) win.destroy() } catch { /* already gone */ }
      try { rmSync(file, { force: true }) } catch { /* best effort */ }
      run()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error('timed out while rendering the document'))),
      RENDER_TIMEOUT_MS,
    )

    win.webContents.once('did-fail-load', (_e, code, desc) =>
      finish(() => reject(new Error(`could not render the document: ${desc} (${code})`))))
    win.webContents.once('did-finish-load', () => {
      // Rendering is done — the print phase below has its own per-attempt
      // timeouts (the system print dialog may legitimately stay open for
      // minutes), so the render timer must not cut it short.
      clearTimeout(timer)
      try { win.setTitle(title) } catch { /* cosmetic only */ }
      fn(win).then(
        (value) => finish(() => resolve(value)),
        (err) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
      )
    })

    try { writeFileSync(file, html, 'utf8') } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))))
      return
    }
    win.loadFile(file).catch((err) => finish(() => reject(err)))
  })
}

function printOnce(win: BrowserWindow, silent: boolean, opts?: PrintJobOptions): Promise<boolean> {
  return printAttempt(win.webContents, silent, opts)
}

/**
 * Print an EXISTING webContents (the app's own window — the @media print
 * flows: Dashboard, DayBook, invoice dialog) to the default printer.
 */
/** Per-attempt ceilings. On a machine with NO default printer
 *  webContents.print()'s callback may never fire at all — without these the
 *  promise hangs forever (the Dashboard cleanup awaits it). Silent attempts
 *  must fail fast; the system print dialog gets a generous window for the
 *  user to pick a printer. */
const SILENT_PRINT_TIMEOUT_MS = 30_000
const DIALOG_PRINT_TIMEOUT_MS = 300_000

function printAttempt(wc: WebContents, silent: boolean, opts?: PrintJobOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), silent ? SILENT_PRINT_TIMEOUT_MS : DIALOG_PRINT_TIMEOUT_MS)
    // `opts` carries the document's own paper/margins: without them Electron
    // prints on the printer's default stock with its default margins, which
    // shifts label sheets off the labels they are laid out for.
    try { wc.print({ silent, ...opts }, (ok) => done(ok)) } catch { done(false) }
  })
}

export function printWebContents(
  wc: WebContents,
  opts: { fallbackToDialog?: boolean; mode?: PrintMode } = {},
): Promise<PrintResult> {
  const once = (silent: boolean): Promise<boolean> => printAttempt(wc, silent)
  // mode 'dialog' is the user's explicit "Choose printer & options" choice:
  // skip the silent attempt and go straight to the system print dialog.
  const silent = opts.mode !== 'dialog'
  return (async () => {
    try {
      if (silent && await once(true)) return { ok: true }
      if (silent && opts.fallbackToDialog === false) {
        return { ok: false, error: 'silent print to the default printer failed (is a default printer configured?)' }
      }
      const ok = await once(false)
      return ok ? { ok: true } : { ok: false, error: 'the system print dialog reported a failure' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })()
}

/**
 * Spool `html` to the printer, queued.
 * Default: silent, straight to the OS default printer. With `mode: 'dialog'`
 * (the user's explicit "Choose printer & options" pick) the system print
 * dialog is opened directly instead — the same window Ctrl+P gives.
 */
export function printHtml(
  html: string,
  opts: { title?: string; fallbackToDialog?: boolean; mode?: PrintMode } = {},
): Promise<PrintResult> {
  const title = opts.title ?? 'Opal Line Billing — Print'
  const silent = opts.mode !== 'dialog'
  const geo = declaredPage(html)
  const job: PrintJobOptions = {
    ...(geo.marginZero ? { margins: { marginType: 'none' as const } } : {}),
    ...(geo.size ? { pageSize: geo.size } : {}),
  }
  return enqueue(async () => {
    try {
      return await withRenderedDocument(html, title, async (win) => {
        if (silent && await printOnce(win, true, job)) return { ok: true }
        if (silent && opts.fallbackToDialog === false) {
          return { ok: false, error: 'silent print to the default printer failed (is a default printer configured?)' }
        }
        // The default printer refused — show the document and let the system
        // print dialog take over rather than failing silently.
        win.show()
        const ok = await printOnce(win, false, job)
        return ok ? { ok: true } : { ok: false, error: 'the system print dialog reported a failure' }
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/** Prompt for a save location (unless `savePath` skips it, e.g. tests) and
 *  write the PDF bytes. Shared by pdfFromHtml and exportPagePdf. */
async function savePdfData(data: Buffer, opts: { suggestedName?: string; savePath?: string }): Promise<PdfResult> {
  let filePath = opts.savePath
  if (!filePath) {
    const suggested = (opts.suggestedName ?? 'opal-line-document').replace(/[<>:"/\\|?*]+/g, '-')
    const save = await dialog.showSaveDialog({
      title: 'Save PDF',
      defaultPath: join(app.getPath('documents'), `${suggested}.pdf`),
      filters: [{ name: 'PDF document', extensions: ['pdf'] }],
    })
    if (save.canceled || !save.filePath) return { ok: false, cancelled: true }
    filePath = save.filePath
  }
  writeFileSync(filePath, data)
  return { ok: true, path: filePath }
}

/** Render `html` and save it as a PDF via a save dialog, queued.
 *  `savePath` skips the dialog (used by the smoke test). */
export function pdfFromHtml(
  html: string,
  opts: { suggestedName?: string; title?: string; savePath?: string } = {},
): Promise<PdfResult> {
  // The document declares its own stock and margins (see declaredPage): use
  // them instead of printToPDF's defaults (1 cm margins + scale-to-fit), which
  // is what made "Save as PDF" produce a shrunk, offset sheet.
  const geo = declaredPage(html)
  const pdfOptions = {
    printBackground: true,
    ...(geo.size
      ? { pageSize: geo.size, preferCSSPageSize: true }
      : { pageSize: 'A4' as const }),
    ...(geo.marginZero ? { margins: { top: 0, bottom: 0, left: 0, right: 0 } } : {}),
  }
  return enqueue(async () => {
    try {
      const data = await withRenderedDocument(html, opts.title ?? 'Opal Line Billing', (win) =>
        win.webContents.printToPDF(pdfOptions),
      )
      return await savePdfData(data, opts)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/** Save the APP WINDOW itself as a PDF (the @media-print flows: Dashboard,
 *  DayBook, invoice dialog). printToPDF runs the same print pipeline as
 *  webContents.print, so the caller's print-only DOM state (body class,
 *  open dialog) is captured exactly as it would be on paper. Queued like
 *  every other job. */
export function exportPagePdf(
  wc: WebContents,
  opts: { suggestedName?: string; savePath?: string } = {},
): Promise<PdfResult> {
  return enqueue(async () => {
    try {
      if (wc.isDestroyed()) return { ok: false, error: 'the window is gone' }
      const data = await wc.printToPDF({ printBackground: true, pageSize: 'A4' })
      return await savePdfData(data, opts)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/** Open `html` in a visible window (Print Designer preview). No printing. */
export function previewHtml(html: string, title = 'Print Preview'): Promise<PrintResult> {
  return new Promise((resolve) => {
    const tooBig = tooLarge(html)
    if (tooBig) { resolve({ ok: false, error: tooBig }); return }

    const win = new BrowserWindow({ show: true, width: 960, height: 800, title, webPreferences: { sandbox: true } })
    const file = tempHtmlFile()
    let settled = false
    const finish = (result: PrintResult) => {
      if (settled) return
      settled = true
      try { rmSync(file, { force: true }) } catch { /* best effort */ }
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'timed out while rendering the document' }), RENDER_TIMEOUT_MS)
    const clear = () => clearTimeout(timer)

    win.webContents.once('did-fail-load', (_e, code, desc) => {
      clear()
      if (!win.isDestroyed()) win.close()
      finish({ ok: false, error: `could not render the document: ${desc} (${code})` })
    })
    win.webContents.once('did-finish-load', () => {
      clear()
      try { win.setTitle(title) } catch { /* cosmetic only */ }
      finish({ ok: true })
    })
    // User closed it before the load finished — nothing to report but stop waiting.
    win.on('closed', () => finish({ ok: true, error: 'window closed before the load finished' }))

    try { writeFileSync(file, html, 'utf8') } catch (err) {
      clear()
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) })
      return
    }
    win.loadFile(file).catch((err) => finish({ ok: false, error: String(err) }))
  })
}
