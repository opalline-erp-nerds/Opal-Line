/**
 * Read-only production check for the Returns & Refunds integration.
 *
 * It NEVER creates a refund, a return or any Shopify mutation. It answers the
 * questions that must be verified against the real store instead of assumed:
 *
 *   1. Is Shopify configured, and does the ERP hold the same order currency as
 *      the live Shopify order? (Shopify is the source of truth for currency.)
 *   2. Are the refund/return ledger rows labelled with their order's currency?
 *   3. Does the public webhook callback exist, and is `refunds/create`
 *      registered against it?
 *   4. Does the real webhook secret accept a correctly signed delivery and
 *      reject a tampered one?
 *   5. Do duplicate deliveries get ignored, and does releasing a failed
 *      delivery let the Shopify retry through?
 *   6. Does Shopify report refundable quantities for a live order (read-only
 *      preview — the amount Shopify would pay back)?
 *
 *   cd backend && npx tsx scripts/live-production-check.mts
 */
import 'dotenv/config'
import { createHmac } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { bootstrapDatabase } from '../src/db/bootstrap'
import { db, getRawClient } from '../src/db/client'
import * as s from '../src/db/schema'
import { config, isConfigured } from '../src/config'
import { decryptSecret } from '../src/lib/crypto'
import { adminGraphQL, fetchRefundableOrder, previewRefund } from '../src/shopifyRefunds'
import { getWebhookHealth } from '../src/webhookRegistration'
import { markWebhookIdSeenDb, releaseWebhookId, verifyShopifyWebhook } from '../src/webhooks'

const ok = (label: string, value: unknown) => console.log(`[ok] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
const warn = (label: string, value: unknown) => console.log(`[!!] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)

function money(n: unknown): number {
  const v = Number(n ?? 0)
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0
}

/** Drive the real HMAC middleware with a signed/unsigned request. */
function hmacStatus(raw: string, signature: string | null): number {
  const headers: Record<string, string> = { 'x-shopify-topic': 'refunds/create' }
  if (signature) headers['x-shopify-hmac-sha256'] = signature
  const req = { headers, rawBody: Buffer.from(raw, 'utf8') } as unknown as Request
  let status = 200
  const res = {
    status(code: number) {
      status = code
      return this
    },
    json() {
      return this
    },
  } as unknown as Response
  verifyShopifyWebhook(req, res, (() => undefined) as NextFunction)
  return status
}

async function main() {
  console.log('=== 1. Shopify configuration ===')
  ok('configured', isConfigured())
  ok('apiVersion', config.apiVersion)
  if (!isConfigured()) {
    warn('shopify', 'not configured — the rest of the live checks cannot run')
    return
  }

  await bootstrapDatabase()
  if (!db) {
    warn('database', 'unavailable')
    return
  }

  console.log('\n=== 2. Live order currency vs ERP (Shopify is authoritative) ===')
  const live = await adminGraphQL<{
    orders?: {
      nodes?: Array<{
        name: string
        currencyCode?: string | null
        presentmentCurrencyCode?: string | null
        totalPriceSet?: {
          shopMoney?: { amount?: string; currencyCode?: string }
          presentmentMoney?: { amount?: string; currencyCode?: string }
        }
        displayFinancialStatus?: string | null
      }>
    }
  }>(
    `#graphql
    query RecentOrders {
      orders(first: 15, sortKey: UPDATED_AT, reverse: true, query: "status:any") {
        nodes {
          name
          currencyCode
          presentmentCurrencyCode
          displayFinancialStatus
          totalPriceSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
        }
      }
    }`,
  )
  if (!live.ok) {
    warn('shopify orders', live.error ?? 'query failed')
  } else {
    const nodes = live.data?.orders?.nodes ?? []
    const names = nodes.map((n) => n.name)
    const localRows = names.length
      ? await db
          .select({ shopifyId: s.salesOrders.shopifyId, value: s.salesOrders.value, currency: s.salesOrders.currency })
          .from(s.salesOrders)
          .where(inArray(s.salesOrders.shopifyId, names))
      : []
    const local = new Map(localRows.map((r) => [r.shopifyId, r]))
    let compared = 0
    let mismatch = 0
    for (const node of nodes) {
      const presentmentCurrency = node.presentmentCurrencyCode ?? node.currencyCode ?? null
      const presentment = money(node.totalPriceSet?.presentmentMoney?.amount)
      const shopCurrency = node.totalPriceSet?.shopMoney?.currencyCode ?? node.currencyCode ?? null
      const shop = money(node.totalPriceSet?.shopMoney?.amount)
      const erp = local.get(node.name)
      if (!erp) {
        warn(`order ${node.name}`, `not in ERP yet (${presentmentCurrency} ${presentment})`)
        continue
      }
      compared += 1
      const erpCurrency = String(erp.currency ?? '').toUpperCase()
      const samePresentment =
        erpCurrency === String(presentmentCurrency ?? '').toUpperCase() && Math.abs(Number(erp.value ?? 0) - presentment) < 0.02
      // The ERP importer stores Shopify's shop-currency total (REST total_price).
      // A multi-currency order therefore legitimately differs from presentment;
      // that is not an ERP currency bug, so it is reported separately below.
      const sameShop =
        erpCurrency === String(shopCurrency ?? '').toUpperCase() && Math.abs(Number(erp.value ?? 0) - shop) < 0.02
      if (!samePresentment && !sameShop) {
        mismatch += 1
        warn(
          `order ${node.name}`,
          `ERP ${erp.currency} ${erp.value} vs Shopify ${presentmentCurrency} ${presentment} (shop ${shopCurrency} ${shop})`,
        )
      } else if (!samePresentment) {
        console.log(
          `   ${node.name} multi-currency: order row holds ${shopCurrency} ${shop}; customer paid ${presentmentCurrency} ${presentment} (refunds are paid in ${presentmentCurrency})`,
        )
      }
    }
    ok('orders compared', `${compared} (${mismatch} mismatch)`)
    if (nodes[0]) {
      const first = nodes.find((n) => n.displayFinancialStatus === 'PAID') ?? nodes[0]
      ok(
        `latest paid order ${first.name}`,
        `${first.presentmentCurrencyCode ?? first.currencyCode} ${money(first.totalPriceSet?.presentmentMoney?.amount)} (${first.displayFinancialStatus})`,
      )
    }
  }

  console.log('\n=== 3. Refund ledger currency ===')
  const refundRows = await db
    .select({
      number: s.refunds.number,
      order: s.refunds.shopifyOrder,
      currency: s.refunds.currency,
      amount: s.refunds.amount,
      status: s.refunds.status,
    })
    .from(s.refunds)
    .orderBy(desc(s.refunds.createdAt))
    .limit(50)
  const refundOrderRefs = [...new Set(refundRows.map((r) => r.order).filter((o): o is string => Boolean(o)))]
  const orderCurrencyRows = refundOrderRefs.length
    ? await db
        .select({ shopifyId: s.salesOrders.shopifyId, currency: s.salesOrders.currency })
        .from(s.salesOrders)
        .where(inArray(s.salesOrders.shopifyId, refundOrderRefs))
    : []
  const orderCurrency = new Map(orderCurrencyRows.map((r) => [r.shopifyId, String(r.currency ?? '').toUpperCase()]))
  ok('refunds recorded', refundRows.length)
  for (const row of refundRows.slice(0, 10)) {
    const expected = row.order ? (orderCurrency.get(row.order) ?? null) : null
    const stored = String(row.currency ?? '').toUpperCase() || null
    const verdict = !expected ? 'order not in ERP' : stored === expected ? 'ok' : `MISMATCH (expected ${expected})`
    console.log(`   ${row.number} ${row.order} ${row.status} ${row.amount} ${stored ?? 'unknown'} — ${verdict}`)
  }
  if (refundRows.length === 0) warn('refunds', 'none in the ERP yet — nothing to reconcile')

  const returnRows = await db
    .select({ number: s.salesReturns.number, order: s.salesReturns.order, currency: s.salesReturns.currency, amount: s.salesReturns.amount })
    .from(s.salesReturns)
    .orderBy(desc(s.salesReturns.date))
    .limit(50)
  ok('returns recorded', returnRows.length)
  const returnRefs = [...new Set(returnRows.map((r) => r.order).filter((o): o is string => Boolean(o)))]
  const returnOrderRows = returnRefs.length
    ? await db
        .select({ shopifyId: s.salesOrders.shopifyId, currency: s.salesOrders.currency })
        .from(s.salesOrders)
        .where(inArray(s.salesOrders.shopifyId, returnRefs))
    : []
  const returnOrderCurrency = new Map(returnOrderRows.map((r) => [r.shopifyId, String(r.currency ?? '').toUpperCase()]))
  let returnMismatch = 0
  for (const row of returnRows) {
    const expected = row.order ? (returnOrderCurrency.get(row.order) ?? null) : null
    const stored = String(row.currency ?? '').toUpperCase() || null
    if (expected && stored !== expected) {
      returnMismatch += 1
      console.log(`   ${row.number} ${row.order} ${row.amount} ${stored ?? 'unknown'} — MISMATCH (expected ${expected})`)
    }
  }
  ok('return currency mismatches', returnMismatch)

  console.log('\n=== 4. Webhook registration ===')
  const health = await getWebhookHealth()
  ok('PUBLIC_BASE_URL', health.publicBaseUrl ?? 'not set (or localhost) — webhooks cannot be registered automatically')
  ok('expected callback', health.expectedAddress ?? 'none')
  for (const entry of health.entries) {
    const line = `${entry.status.padEnd(10)} ${entry.topic}${entry.address ? ` → ${entry.address}` : ''}`
    if (entry.status === 'registered') console.log(`   ${line}`)
    else warn('webhook', line)
  }
  ok('all topics registered', health.healthy)

  console.log('\n=== 5. HMAC + duplicate delivery handling ===')
  const secret = decryptSecret(process.env.SHOPIFY_WEBHOOK_SECRET)
  if (!secret) {
    warn('HMAC', 'SHOPIFY_WEBHOOK_SECRET is not set — Shopify deliveries would be rejected with 500')
  } else {
    ok('secret', 'configured (value never printed)')
    const payload = JSON.stringify({ id: 1, order_id: 1, transactions: [] })
    const good = createHmac('sha256', secret).update(payload, 'utf8').digest('base64')
    ok('correctly signed delivery', hmacStatus(payload, good) === 200 ? 'accepted' : 'REJECTED')
    const tampered = `${payload} `
    ok('tampered body', hmacStatus(tampered, good) === 401 ? 'rejected (401)' : 'ACCEPTED — BAD')
    ok('missing signature', hmacStatus(payload, null) === 401 ? 'rejected (401)' : 'ACCEPTED — BAD')
  }

  const probeId = `production-check-${Date.now()}`
  const first = await markWebhookIdSeenDb(probeId)
  const second = await markWebhookIdSeenDb(probeId)
  ok('first delivery processed', first)
  ok('duplicate delivery ignored', !second)
  await releaseWebhookId(probeId)
  const afterRelease = await markWebhookIdSeenDb(probeId)
  ok('retry after failure is processed', afterRelease)
  await releaseWebhookId(probeId)
  const client = getRawClient()
  if (client) await client`DELETE FROM webhook_deliveries WHERE webhook_id = ${probeId}`

  console.log('\n=== 6. Live refundable state (read-only, NO refund is created) ===')
  const candidate = await db
    .select({ shopifyId: s.salesOrders.shopifyId })
    .from(s.salesOrders)
    .where(and(isNotNull(s.salesOrders.shopifyId), eq(s.salesOrders.payment, 'paid')))
    .orderBy(desc(s.salesOrders.date))
    .limit(3)
  for (const row of candidate) {
    if (!row.shopifyId) continue
    const refundable = await fetchRefundableOrder(row.shopifyId)
    if (!refundable.ok) {
      warn(`refundable ${row.shopifyId}`, refundable.error)
      continue
    }
    const order = refundable.order
    ok(
      `refundable ${order.orderName}`,
      `${order.currency} order ${order.totalPrice} already refunded ${order.totalRefunded} · ${order.financialStatus} · gateway ${order.paymentMethod ?? 'none'}`,
    )
    const line = order.lines.find((l) => l.refundableQuantity > 0)
    if (line) {
      const preview = await previewRefund(order.orderName, [{ lineItemId: line.lineItemId, quantity: 1 }], { shippingAmount: 0 })
      if (preview.ok) {
        ok(
          `preview ${order.orderName}`,
          `${preview.preview.currency} ${preview.preview.totalAmount} for 1 × ${line.sku} (max refundable ${preview.preview.maximumRefundable})`,
        )
      } else warn(`preview ${order.orderName}`, preview.error)
    }
    break
  }

  const withRefunds = await adminGraphQL<{ orders?: { nodes?: Array<{ name: string; refunds?: Array<{ id: string }> }> } }>(
    `#graphql
    query OrdersWithRefunds {
      orders(first: 20, sortKey: UPDATED_AT, reverse: true, query: "status:any") {
        nodes { name refunds { id } }
      }
    }`,
  )
  if (!withRefunds.ok) {
    warn('Shopify refunds', withRefunds.error ?? 'query failed')
  } else {
    const targets = (withRefunds.data?.orders?.nodes ?? []).filter((o) => (o.refunds?.length ?? 0) > 0)
    ok('orders with refunds in Shopify', targets.map((o) => `${o.name}(${o.refunds?.length})`).join(', ') || 'none')
    if (targets.length === 0) {
      warn('Shopify → ERP refund', 'no refund exists in the store yet, so no live refund can be imported (nothing was refunded by this check)')
    }
  }

  console.log('\nDone — no Shopify mutation was made.')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
