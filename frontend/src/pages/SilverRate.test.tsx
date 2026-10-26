import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import SilverRatePage from './SilverRate'
import { SilverRateContext } from '@/lib/silver-rate-context'

// Silver Rate Management page: the layout is the feature — hero rate + status
// card, three compact cards in one row, and a history table. Server rendering
// runs no effects (so no API calls), which pins the page's initial/empty
// state: the expanded approvals and scheduled lists must stay hidden, the
// merged drawer stays closed, and the removed impact tiles stay gone.

function renderPage() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SilverRateContext.Provider value={{ rate: null, refresh: async () => {} }}>
        <SilverRatePage />
      </SilverRateContext.Provider>
    </MemoryRouter>,
  )
}

test('hero card shows the current rate, change chip and update time', () => {
  const html = renderPage()
  assert.match(html, /Current silver rate/)
  assert.match(html, /₹0\.00/, 'the current rate renders large')
  assert.match(html, /per gram/)
  assert.match(html, /Last updated/)
  // No history yet → the sparkline (and its label) stays out of the way.
  assert.doesNotMatch(html, /Last \d+ rates/)
})

test('status card lists sync, repriced and pending approvals', () => {
  const html = renderPage()
  assert.match(html, /Shopify sync/)
  assert.match(html, /Products repriced/)
  assert.match(html, /Pending approvals/)
})

test('three compact cards render with a badge, one line and one action', () => {
  const html = renderPage()
  assert.match(html, />Approvals</)
  assert.match(html, />Scheduled</)
  assert.match(html, />Auto rate</)
  assert.match(html, /No rate changes waiting for approval\./)
  // Non-approvers see the permission line instead of a scheduling pitch.
  assert.match(html, /Only Admin or Super Admin can schedule a rate change\./)
  assert.match(html, />Update rate</)
  assert.match(html, />Schedule</)
  // No expanded list while there is nothing pending or queued.
  assert.doesNotMatch(html, /Rate change approvals/)
  assert.doesNotMatch(html, />Scheduled rate changes</)
})

test('amber rate-source banner only renders when the source is known-missing', () => {
  // autoStatus starts unknown (the fetch runs in an effect), so no banner yet.
  assert.doesNotMatch(renderPage(), /Rate source not configured/)
})

test('history table wraps in an overflow container with the slim columns', () => {
  const html = renderPage()
  assert.match(html, /overflow-x-auto/)
  assert.match(html, />Rate history</)
  const headers = ['Date', 'Rate', 'Change', 'Approved by', 'Shopify', 'Actions']
  for (const header of headers) {
    assert.ok(html.includes(`>${header}</th>`), `history header "${header}" renders`)
  }
  assert.doesNotMatch(html, />Old Rate</, 'old/new merged into one Rate column')
  assert.doesNotMatch(html, />New Rate</)
  assert.match(html, /No rate history yet\./)
})

test('the history log offers a date filter and a View action per row', () => {
  const html = renderPage()
  assert.match(html, /id="history-from"/, 'From date input renders')
  assert.match(html, /id="history-to"/, 'To date input renders')
  assert.match(html, /No rate history yet\./)
  assert.doesNotMatch(html, />View</, 'no View action without rows')
})

test('removed impact tiles and the closed drawer render nothing', () => {
  const html = renderPage()
  assert.doesNotMatch(html, /Total Value Shift/i, 'placeholder tile removed')
  assert.doesNotMatch(html, /Avg\.? Price Change/i, 'placeholder tile removed')
  assert.doesNotMatch(html, /Price Change Impact/, 'impact card removed')
  assert.doesNotMatch(html, /Apply now/, 'drawer stays closed until opened')
  assert.doesNotMatch(html, /Review prices/)
})
