// Electron entry for scripts/print-flow.test.mjs — runs the REAL print
// pipeline in a real (headless) Electron process:
//   1. printHtml → hidden window → load → webContents.print({ silent: true })
//      to the system default printer (no dialog: fallbackToDialog false).
//   2. printWebContents → the same, on an existing window (the "print the
//      app window" flows: Dashboard / DayBook / invoice dialog).
//   3. pdfFromHtml(savePath) → render + printToPDF, deterministic even on a
//      machine with no printer — proves the render path end-to-end.
// Prints one SMOKE_* JSON line per step for the test to assert on.
const { app, BrowserWindow } = require('electron')
const { printHtml, printWebContents, pdfFromHtml } = require('../electron/dist/print.js')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

// Pin the profile to a temp dir BEFORE app ready: a bare entry like this
// would otherwise inherit Electron's default userData (%APPDATA%\Electron)
// and litter the real profile directory on every dev/CI run. The shipped
// app pins its own userData in main.ts — this keeps smoke runs out of both.
app.setPath('userData', join(tmpdir(), 'opal-line-smoke-userdata'))

const PDF_PATH = process.env.OPAL_SMOKE_PDF_PATH
const LETTER_PDF_PATH = process.env.OPAL_SMOKE_LETTER_PDF_PATH

// Transient print windows come and go — without this listener Electron's
// default "all windows closed → quit" would kill this (otherwise windowless)
// process between steps, before the next SMOKE_* line is printed.
app.on('window-all-closed', () => {})

app.whenReady()
  .then(async () => {
    const html =
      '<!doctype html><html><head><title>Opal Line Billing print smoke</title></head>' +
      '<body style="font-family:sans-serif"><h1>Opal Line Billing — print smoke</h1></body></html>'

    const printed = await printHtml(html, {
      title: 'Opal Line Billing — print smoke',
      fallbackToDialog: false,
    })
    console.log('SMOKE_PRINT ' + JSON.stringify(printed))

    const win = new BrowserWindow({ show: false, width: 400, height: 300 })
    await win.loadURL('data:text/html,<h1>print smoke page</h1>')
    const page = await printWebContents(win.webContents, { fallbackToDialog: false })
    console.log('SMOKE_PAGE ' + JSON.stringify(page))
    if (!win.isDestroyed()) win.destroy()

    if (PDF_PATH) {
      const pdf = await pdfFromHtml(html, { savePath: PDF_PATH, title: 'Opal Line Billing print smoke' })
      console.log('SMOKE_PDF ' + JSON.stringify(pdf))
    }

    // "Save as PDF" must honour the stock the DOCUMENT declares: label sheets
    // and invoices emit @page{size:…;margin:0} themselves, and a Letter sheet
    // used to be exported on A4 paper (scaled and shifted), which is what made
    // saved label PDFs land off the labels. A doc with no @page keeps A4.
    if (LETTER_PDF_PATH) {
      const letterHtml =
        '<!doctype html><html><head><title>letter stock</title><style>' +
        '@page{size:letter;margin:0;} *{margin:0;padding:0}' +
        'body{background:#fff} .sheet{width:215.9mm;height:279.4mm;background:#fff;}' +
        '</style></head><body><div class="sheet"><h1>Letter sheet</h1></div></body></html>'
      const letter = await pdfFromHtml(letterHtml, { savePath: LETTER_PDF_PATH, title: 'Letter stock' })
      console.log('SMOKE_PDF_LETTER ' + JSON.stringify(letter))
    }

    app.exit(0)
  })
  .catch((err) => {
    console.error('SMOKE_ERROR ' + (err && err.stack ? err.stack : String(err)))
    app.exit(1)
  })
