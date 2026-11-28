// Verifies the emerald-teal palette against WCAG, reading the real values out of
// the source CSS so it cannot drift from what ships.
// Run: node scripts/check-palette.mjs
import fs from 'node:fs'

const css = fs.readFileSync('frontend/src/index.css', 'utf8')

/** Pull `--token: H S% L%;` out of one block (":root", ".dark", print). */
function block(start) {
  const i = css.indexOf(start)
  if (i < 0) throw new Error(`block not found: ${start}`)
  const end = css.indexOf('\n  }', i)
  const body = css.slice(i, end < 0 ? undefined : end)
  const out = {}
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%;/g)) {
    out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])]
  }
  return out
}

const root = block(':root')
const dark = block('.dark {')

/** WCAG relative luminance from an HSL triple. */
function luminance([h, s, l]) {
  s /= 100; l /= 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = l - c / 2
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r + m) + 0.7152 * lin(g + m) + 0.0722 * lin(b + m)
}

function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/** [fg, bg, minimum, label] — minimum 4.5 for body text, 3 for large/UI. */
const CHECKS = [
  ['foreground', 'background', 4.5, 'body text on page'],
  ['card-foreground', 'card', 4.5, 'text on cards'],
  ['primary-foreground', 'primary', 4.5, 'primary button label'],
  ['muted-foreground', 'background', 4.5, 'secondary text'],
  ['muted-foreground', 'card', 4.5, 'secondary text on cards'],
  ['sidebar-foreground', 'sidebar', 4.5, 'sidebar nav label'],
  ['sidebar-muted', 'sidebar', 4.5, 'sidebar muted label'],
  ['sidebar-active-foreground', 'sidebar-active', 4.5, 'active nav label'],
  ['accent-foreground', 'accent', 4.5, 'text on accent fill'],
  ['gold-foreground', 'gold', 4.5, 'text on gold fill'],
  ['foreground', 'border', 3, 'input border vs page'],
  ['ring', 'background', 3, 'focus ring vs page'],
  ['destructive', 'background', 4.5, 'danger text on page'],
  ['success', 'background', 4.5, 'success text on page'],
  ['warning', 'background', 4.5, 'warning text on page'],
  ['info', 'background', 4.5, 'info text on page'],
]

let failed = 0
for (const [name, tokens] of [['LIGHT', root], ['DARK', dark]]) {
  console.log(`\n── ${name} ──`)
  for (const [fg, bg, min, label] of CHECKS) {
    if (!tokens[fg] || !tokens[bg]) {
      console.log(`  ?  ${label}: missing --${fg}/--${bg}`)
      failed++
      continue
    }
    const r = ratio(tokens[fg], tokens[bg])
    const ok = r >= min
    if (!ok) failed++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2).padStart(5)}:1  (min ${min})  ${label}`)
  }
}

// The print block must agree with light mode or invoices ship with one
// palette on screen and another on paper.
console.log('\n── PRINT vs LIGHT ──')
const printStart = css.indexOf('@media print')
const printBody = css.slice(printStart, css.indexOf('body *', printStart))
for (const t of ['background', 'foreground', 'primary', 'accent', 'muted-foreground', 'border']) {
  const pm = printBody.match(new RegExp(`--${t}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%;`))
  if (!pm) { console.log(`  FAIL  --${t} missing from print block`); failed++; continue }
  const same = root[t] && root[t].every((v, i) => Math.abs(v - Number(pm[i + 1])) < 0.01)
  console.log(`  ${same ? 'PASS' : 'FAIL'}  --${t} matches light mode`)
  if (!same) failed++
}

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILURE(S)`}`)
process.exit(failed === 0 ? 0 : 1)