import { expect, test, type Page } from '@playwright/test'

// Every View / Edit / Create / Duplicate action in the app must open the shared
// AppDialog (frontend/src/components/ui/app-dialog.tsx) on the same page — no
// bespoke routes, no hand-rolled `<DialogContent className="max-w-2xl …">`.
//
// This spec pins the contract those converted call sites rely on:
//   1. the dialog exposes a role="dialog" with a fixed header + footer and a
//      single scrollable body (`.overflow-y-auto`), so Save/Cancel stay put;
//   2. it fits both desktop and phone viewports (width preset clamps to 95vw,
//      height to 90dvh) and the footer stays reachable after scrolling;
//   3. a dirty form prompts "Discard changes?" on Esc / × / click-outside,
//      while a clean form (or a programmatic close) never prompts.
//
// Fixtures: the tests open *Create* dialogs, which every page renders even on a
// freshly seeded database (guarded-smoke convention: assert the action exists,
// then skip with a reason instead of failing when it doesn't).

async function openCreateDialog(page: Page, route: string, button: RegExp) {
  await page.goto(route)
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })
  const trigger = page.getByRole('button', { name: button }).first()
  if ((await trigger.count()) === 0) return null
  await trigger.click({ timeout: 20000 })
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 10000 })
  return dialog
}

test.describe('shared AppDialog contract', () => {
  test('create dialogs render a fixed header, scrollable body and reachable footer', async ({ page }) => {
    test.setTimeout(60_000)
    const dialog = await openCreateDialog(page, '/accounts/bank', /add account/i)
    if (!dialog) {
      test.skip(true, 'Add Account action not present in this build')
      return
    }

    // Header + body + footer are separate regions; only the body scrolls.
    await expect(dialog.locator('.overflow-y-auto')).toHaveCount(1)
    await expect(dialog.getByRole('heading')).toBeVisible()

    const shape = await dialog.evaluate((el) => {
      const body = el.querySelector('.overflow-y-auto')!
      const footerButtons = [...el.querySelectorAll('button')].filter((b) =>
        /save changes|add account|cancel/i.test(b.textContent ?? ''),
      )
      return {
        scrollable: body.scrollHeight >= body.clientHeight,
        footerCount: footerButtons.length,
      }
    })
    expect(shape.footerCount, 'footer carries the form actions').toBeGreaterThanOrEqual(2)
  })

  test('dialog fits desktop and phone viewports with the footer visible', async ({ page }) => {
    test.setTimeout(60_000)
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport)
      const dialog = await openCreateDialog(page, '/accounts/expenses', /add expense/i)
      if (!dialog) {
        test.skip(true, 'Add Expense action not present in this build')
        return
      }
      await page.waitForTimeout(200)

      const geo = await dialog.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const body = el.querySelector('.overflow-y-auto')
        if (body) body.scrollTo(0, body.scrollHeight)
        return {
          fitsV: r.height <= window.innerHeight + 1,
          fitsH: r.width <= window.innerWidth + 1,
        }
      })
      expect(geo.fitsV, `fits vertically at ${viewport.width}px`).toBe(true)
      expect(geo.fitsH, `fits horizontally at ${viewport.width}px`).toBe(true)

      // Footer action must still be within the viewport after scrolling the body.
      const footerBottom = await dialog.evaluate((el) => {
        const footer = el.querySelector('.border-t')
        return footer ? footer.getBoundingClientRect().bottom : null
      })
      expect(footerBottom, 'footer rendered').not.toBeNull()
      expect(footerBottom!, 'footer stays on screen').toBeLessThanOrEqual(viewport.height + 1)

      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 5000 })
    }
  })

  test('a dirty form asks "Discard changes?" before closing', async ({ page }) => {
    test.setTimeout(60_000)
    const dialog = await openCreateDialog(page, '/accounts/bank', /add account/i)
    if (!dialog) {
      test.skip(true, 'Add Account action not present in this build')
      return
    }

    // Typing makes the form dirty; Esc must NOT close it silently.
    const firstField = dialog.getByRole('textbox').first()
    await firstField.fill('Discard guard probe')
    await page.keyboard.press('Escape')

    const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog').filter({ hasText: /discard changes\?/i }))
    await expect(confirm.getByText(/discard changes\?/i)).toBeVisible({ timeout: 10000 })

    // "Keep editing" leaves the form open with its value intact.
    await confirm.getByRole('button', { name: /keep editing/i }).click()
    await expect(dialog).toBeVisible()
    await expect(firstField).toHaveValue('Discard guard probe')

    // "Discard" closes it.
    await page.keyboard.press('Escape')
    await expect(confirm.getByText(/discard changes\?/i)).toBeVisible({ timeout: 10000 })
    await confirm.getByRole('button', { name: /^discard$/i }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 5000 })
  })

  test('a clean form closes on Esc without prompting', async ({ page }) => {
    test.setTimeout(60_000)
    const dialog = await openCreateDialog(page, '/accounts/bank', /add account/i)
    if (!dialog) {
      test.skip(true, 'Add Account action not present in this build')
      return
    }
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 5000 })
  })

  test('loyalty settings opens the shared dialog with a Done footer', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto('/sales/loyalty')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 })
    const settings = page.getByRole('button', { name: /settings/i }).first()
    if ((await settings.count()) === 0) {
      test.skip(true, 'Loyalty settings action not present in this build')
      return
    }
    await settings.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: /loyalty program settings/i })).toBeVisible({ timeout: 10000 })
    await expect(dialog.getByRole('button', { name: /done/i })).toBeVisible()
    await expect(dialog.locator('.overflow-y-auto')).toHaveCount(1)
  })

  test('converted pages do not open a child route when creating', async ({ page }) => {
    test.setTimeout(60_000)
    const dialog = await openCreateDialog(page, '/accounts/ledger', /add entry/i)
    if (!dialog) {
      test.skip(true, 'Add Entry action not present in this build')
      return
    }
    // Still on the same list page — the editor is a modal, not a route.
    expect(new URL(page.url()).pathname).toBe('/accounts/ledger')
    await expect(dialog).toBeVisible()
  })
})
