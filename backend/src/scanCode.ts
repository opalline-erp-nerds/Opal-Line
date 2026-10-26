// Scan input handling for product lookup.
//
// Products are identified by their SKU everywhere: printed labels carry a QR
// code encoding ONLY the SKU (e.g. OL-RNG-001), and scanning one resolves the
// product through an exact SKU match. Barcode generation and barcode-based
// lookup have been removed from every product workflow.
//
// Everything in this module is pure so the rules can be unit-tested without a
// database, and so every scan entry point (stock count, sales orders, invoice
// lines) shares one definition of "valid input".

/**
 * Normalise raw scanner input. Keyboard-wedge scanners and phone QR scanners
 * usually append CR/LF and some models pad with spaces or NULs; stripping all
 * whitespace and control characters means the same physical scan always
 * resolves to the same SKU.
 *
 * Character codes are compared numerically (C0 controls 0x00-0x1f, DEL 0x7f)
 * rather than with a control-character class so this file stays plain ASCII.
 */
export function normalizeScanCode(value: unknown): string {
  if (value == null) return ''
  let out = ''
  for (const ch of String(value)) {
    const code = ch.codePointAt(0) ?? 0
    // Control characters and whitespace: keyboard-wedge padding that must be
    // stripped before lookup. Everything else is kept verbatim — a scan is
    // never rewritten, so the code scanned is the code matched.
    if (code <= 0x1f || code === 0x7f) continue
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') continue
    out += ch
    if (out.length >= 128) break
  }
  return out
}

/** Reject obviously malformed scan input before it ever reaches the database. */
export function scanCodeError(value: unknown): string | null {
  const code = normalizeScanCode(value)
  if (!code) return 'Scan code is required'
  if (code.length < 2) return 'Scan code is too short'
  return null
}

/** Two products claim the same code (legacy data) — cannot resolve safely. */
export function duplicateScanMessage(): string {
  return 'That code matches more than one product — fix the duplicate SKU first'
}

export function inactiveProductMessage(name: string, status: string): string {
  return `"${name}" is ${status} and cannot be scanned for stock changes`
}
