import { chromium } from '@playwright/test'

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:47195'
const USER = process.env.E2E_USER ?? 'admin'
const PASSWORD = process.env.E2E_PASSWORD ?? 'Opal@2026'

const browser = await chromium.launch({ channel: 'chrome' })

for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
  await ctx.addInitScript((t) => {
    if (t === 'dark') localStorage.setItem('opal-theme', 'dark')
    else localStorage.removeItem('opal-theme')
  }, theme)
  const page = await ctx.newPage()
  const read = (locator) =>
    locator.first().evaluate((el) => {
      const s = getComputedStyle(el)
      const icon = el.querySelector('svg')
      return {
        background: s.backgroundColor,
        color: s.color,
        icon: icon ? getComputedStyle(icon).color : null,
      }
    })

  const report = async (label, locator, action) => {
    if (action) await action()
    await page.waitForTimeout(300)
    console.log(`\n=== ${theme} ${label} ===`)
    console.log(JSON.stringify(await read(locator), null, 2))
  }

  const resetPointer = () => page.mouse.move(4, 4)

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('#username', USER)
  await page.fill('#password', PASSWORD)
  const loginButton = page.locator('button[type="submit"]').first()
  await report('login button normal', loginButton)
  await report('login button hovered', loginButton, () => loginButton.hover())
  await report('login button active', loginButton, () => page.mouse.down())
  await resetPointer()
  await page.mouse.up()
  await report('login button restored', loginButton, resetPointer)
  await page.click('button[type="submit"]')
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 25000 })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1800)

  const collect = () =>
    page.evaluate(() => {
      const style = (el) => (el ? getComputedStyle(el) : null)
      const pick = (el, props) => {
        const s = style(el)
        if (!s) return null
        return Object.fromEntries(props.map((p) => [p, s[p]]))
      }
      const activeNav = document.querySelector('aside a[href="/"]')
      const activeSegment = document.querySelector('button[aria-pressed="true"]')
      const activeTab = document.querySelector('[role="tab"][data-state="active"]')
      const input = document.querySelector('input:not([type="hidden"])')
      const tableHead = document.querySelector('thead th')
      const grid = document.querySelector('.recharts-cartesian-grid line')
      const axis = document.querySelector('.recharts-cartesian-axis-tick text')
      const hero = document.querySelector('section[aria-label="Opal Line overview"]')
      const heroImg = hero?.querySelector('img')
      return {
        theme: document.documentElement.className || 'light',
        body: pick(document.body, ['backgroundColor', 'color']),
        sidebar: pick(document.querySelector('aside'), ['backgroundColor', 'color']),
        header: pick(document.querySelector('header'), ['backgroundColor']),
        card: pick(document.querySelector('main .rounded-2xl'), ['backgroundColor', 'borderColor']),
        activeNav: pick(activeNav, ['backgroundColor', 'color']),
        activeSegment: activeSegment
          ? {
              ...pick(activeSegment, ['backgroundColor', 'color']),
              icon: getComputedStyle(activeSegment.querySelector('svg')).color,
            }
          : null,
        activeTab: pick(activeTab, ['backgroundColor', 'color']),
        input: pick(input, ['backgroundColor', 'color', 'borderColor']),
        tableHead: pick(tableHead, ['backgroundColor', 'color']),
        chartGrid: pick(grid, ['stroke']),
        chartAxis: pick(axis, ['fill']),
        hero: pick(hero, ['backgroundImage']),
        heroImage: heroImg
          ? {
              src: heroImg.currentSrc || heroImg.src,
              naturalWidth: heroImg.naturalWidth,
              naturalHeight: heroImg.naturalHeight,
              filter: getComputedStyle(heroImg).filter,
              objectFit: getComputedStyle(heroImg).objectFit,
              objectPosition: getComputedStyle(heroImg).objectPosition,
              maskImage: getComputedStyle(heroImg).maskImage,
              opacity: getComputedStyle(heroImg).opacity,
            }
          : null,
        productImageFilter: pick(document.querySelector('main img'), ['filter']),
      }
    })

  const primaryButton = page.locator('button.bg-primary:not([aria-pressed])').first()
  if (await primaryButton.count()) {
    await report('solid primary normal', primaryButton)
    await report('solid primary hovered', primaryButton, () => primaryButton.hover())
    await report('solid primary restored', primaryButton, resetPointer)
  }

  const headerButton = page.locator('header button[aria-label="Notifications"]').first()
  await report('header icon normal', headerButton)
  await report('header icon hovered', headerButton, () => headerButton.hover())
  await report('header icon active', headerButton, () => page.mouse.down())
  await page.mouse.up()
  await page.keyboard.press('Escape')
  await report('header icon restored', headerButton, resetPointer)

  const inactiveNav = page.locator("aside nav a:not([class~='bg-sidebar-active'])").first()
  await report('sidebar link normal', inactiveNav)
  await report('sidebar link hovered', inactiveNav, () => inactiveNav.hover())
  await report('sidebar link restored', inactiveNav, resetPointer)

  const selectedSegment = page.locator('button[aria-pressed="true"]').first()
  const deselectedSegment = page.locator('button[aria-pressed="false"]').first()
  await report('selected filter', selectedSegment)
  await report('deselected filter normal', deselectedSegment)
  await report('deselected filter hovered', deselectedSegment, () => deselectedSegment.hover())
  await report('deselected filter restored', deselectedSegment, resetPointer)
  await deselectedSegment.click()
  await report('newly selected filter', page.locator('button[aria-pressed="true"]').first())

  const profile = page.locator('header button').filter({ hasText: /admin/i }).first()
  if (await profile.count()) {
    await report('admin profile normal', profile)
    await report('admin profile hovered', profile, () => profile.hover())
    await profile.click()
    const menuItem = page.locator("[role='menuitem']:not([data-disabled]):not([aria-disabled='true'])").first()
    if (await menuItem.count()) {
      await report('menu item hovered', menuItem, () => menuItem.hover())
    }
    await page.keyboard.press('Escape')
  }

  console.log(`\n=== ${theme} dashboard ===`)
  console.log(JSON.stringify(await collect(), null, 2))

  await page.goto(`${BASE}/inventory/products`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1500)
  console.log(`\n=== ${theme} products ===`)
  console.log(JSON.stringify(await collect(), null, 2))

  await page.goto(`${BASE}/system/settings`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1500)
  const tab = page.locator('[role="tab"][data-state="active"]').first()
  const tabMetrics = await tab.evaluate((el) => {
    const s = getComputedStyle(el)
    const icon = el.querySelector('svg')
    return {
      background: s.backgroundColor,
      color: s.color,
      icon: icon ? getComputedStyle(icon).color : null,
    }
  })
  console.log(`\n=== ${theme} settings tab ===`)
  console.log(JSON.stringify(tabMetrics, null, 2))

  await ctx.close()
}

await browser.close()
