import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appDialogSizeClass,
  shouldConfirmDiscard,
  type AppDialogSize,
} from './app-dialog'

// AppDialog is the app's single dialog wrapper. Radix renders <DialogContent>
// through a portal, which has no DOM under renderToStaticMarkup, so the markup
// itself can't be asserted here (same constraint as the recharts tests). The
// two pieces of behaviour worth pinning are pure and exported for that reason:
//
//   - the width preset contract: every size resolves to min(<preset>, 95vw) so
//     dialogs never overflow a phone; presets grow sm < md < lg < xl.
//   - the unsaved-changes guard: only a dirty form being *dismissed* prompts.

test('every size preset clamps to 95vw so phones never overflow', () => {
  const sizes: AppDialogSize[] = ['sm', 'md', 'lg', 'xl']
  for (const size of sizes) {
    assert.match(appDialogSizeClass(size), /max-w-\[min\(95vw,/, `${size} must clamp to 95vw`)
  }
})

test('size presets grow in order sm < md < lg < xl', () => {
  const px = (size: AppDialogSize) => Number(/95vw,([\d.]+)rem/.exec(appDialogSizeClass(size))![1])
  assert.ok(px('sm') < px('md'), 'md is wider than sm')
  assert.ok(px('md') < px('lg'), 'lg is wider than md')
  assert.ok(px('lg') < px('xl'), 'xl is wider than lg')
  assert.equal(px('sm'), 26.25, 'sm ≈ 420px')
  assert.equal(px('md'), 40, 'md ≈ 640px')
  assert.equal(px('lg'), 56.25, 'lg ≈ 900px')
  assert.equal(px('xl'), 68.75, 'xl ≈ 1100px')
})

test('only a dirty form being dismissed needs the discard prompt', () => {
  assert.equal(shouldConfirmDiscard(false, true), true, 'dirty + closing → prompt')
  assert.equal(shouldConfirmDiscard(false, false), false, 'clean + closing → close')
  assert.equal(shouldConfirmDiscard(false, undefined), false, 'no isDirty → close')
  assert.equal(shouldConfirmDiscard(true, true), false, 'dirty + opening → never prompt')
  assert.equal(shouldConfirmDiscard(true, false), false, 'clean + opening → no prompt')
})
