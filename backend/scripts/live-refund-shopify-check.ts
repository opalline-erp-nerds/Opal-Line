/**
 * Live verification of the refund integration against the connected Shopify
 * store (never run by tests). Read-only except for `pullRefundsForOrder`, which
 * imports refunds that ALREADY exist in Shopify into the ERP — the same thing
 * the Refunds tab's "Sync" button does.
 *
 *   npx tsx scripts/live-refund-shopify-check.ts            # read + preview + pull
 *   npx tsx scripts/live-refund-shopify-check.ts --negative # also prove refundCreate parses
 */
import 'dotenv/config'
import { bootstrapDatabase } from '../src/db/bootstrap'
import { db } from '../src/db/client'
import * as s from '../src/db/schema'
import { desc, eq, and, isNotNull } from 'drizzle-orm'
import { isConfigured, config } from '../src/config'
import { fetchRefundableOrder, previewRefund, pullRefundsForOrder, adminGraphQL } from '../src/shopifyRefunds'

async function main() {
  const negative = process.argv.includes('--negative')
  await bootstrapDatabase()
  console.log('shopify configured:', isConfigured(), 'apiVersion:', config.apiVersion)
  if (!db) return console.log('no db')
  if (!isConfigured()) return console.log('shopify not configured')

  // 1. Live read + Shopify's own suggested refund calculation.
  const paid = await db
    .select({ shopifyId: s.salesOrders.shopifyId, payment: s.salesOrders.payment })
    .from(s.salesOrders)
    .where(and(isNotNull(s.salesOrders.shopifyId), eq(s.salesOrders.payment, 'paid')))
    .orderBy(desc(s.salesOrders.date))
    .limit(3)
  console.log('candidate orders:', paid.map((r) => r.shopifyId))

  for (const row of paid) {
    if (!row.shopifyId) continue
    const probe = await fetchRefundableOrder(row.shopifyId)
    if (!probe.ok) {
      console.log('LIVE READ FAILED', row.shopifyId, probe.error)
      continue
    }
    const o = probe.order
    console.log(
      `LIVE OK ${o.orderName} ${o.currency} total=${o.totalPrice} refunded=${o.totalRefunded} gateway=${o.paymentMethod} financial=${o.financialStatus}`,
    )
    console.log('  lines:', o.lines.map((l) => `${l.sku} qty=${l.quantity} refundable=${l.refundableQuantity} unit=${l.unitPrice}`))
    const line = o.lines.find((l) => l.refundableQuantity > 0)
    if (!line) continue
    const p = await previewRefund(row.shopifyId, [{ lineItemId: line.lineItemId, quantity: 1 }], { shippingAmount: 0 })
    console.log(
      p.ok
        ? `LIVE PREVIEW OK total=${p.preview.totalAmount} max=${p.preview.maximumRefundable} suggested=${JSON.stringify(p.preview.suggested)} warnings=${JSON.stringify(p.preview.warnings)}`
        : `LIVE PREVIEW FAILED: ${p.error}`,
    )
    break
  }

  // 2. Prove the refundCreate input is accepted by Shopify's schema without
  //    creating a refund: a nonexistent order id can only come back as a
  //    userError, never as a schema/type error or an authorization failure.
  if (negative) {
    const res = await adminGraphQL<{ refundCreate?: { userErrors?: Array<{ field?: string[]; message?: string }> } }>(
      `#graphql
      mutation ProbeRefund($input: RefundInput!) {
        refundCreate(input: $input) {
          refund { id }
          userErrors { field message }
        }
      }`,
      {
        input: {
          orderId: 'gid://shopify/Order/1',
          currency: 'USD',
          notify: false,
          refundLineItems: [{ lineItemId: 'gid://shopify/LineItem/1', quantity: 1, restockType: 'NO_RESTOCK' }],
          transactions: [
            {
              orderId: 'gid://shopify/Order/1',
              kind: 'REFUND',
              gateway: 'manual',
              amount: '0.01',
            },
          ],
        },
      },
    )
    console.log('NEGATIVE refundCreate ok=', res.ok, 'error=', res.error)
    console.log('NEGATIVE userErrors=', JSON.stringify(res.data?.refundCreate?.userErrors))
  }

  // 3. Shopify -> ERP: import refunds that already exist in the store.
  const withRefunds = await adminGraphQL<{
    orders?: { nodes?: Array<{ name: string; refunds?: Array<{ id: string }> | null }> }
  }>(
    `#graphql
    query OrdersWithRefunds {
      orders(first: 20, sortKey: UPDATED_AT, reverse: true, query: "status:any") {
        nodes { name updatedAt refunds { id } }
      }
    }`,
  )
  if (!withRefunds.ok) return console.log('refund lookup failed:', withRefunds.error)
  const targets = (withRefunds.data?.orders?.nodes ?? []).filter((o) => (o.refunds?.length ?? 0) > 0)
  console.log('orders with Shopify refunds:', targets.map((o) => `${o.name}(${o.refunds?.length})`))
  for (const target of targets.slice(0, 3)) {
    const pulled = await pullRefundsForOrder(target.name)
    console.log('PULL', target.name, JSON.stringify(pulled))
  }
  if (targets.length === 0 && paid[0]?.shopifyId) {
    // No refund exists in the store yet, so at least prove the pull query is
    // schema-valid and idempotent against a real order (0 refunds expected).
    const pulled = await pullRefundsForOrder(paid[0].shopifyId)
    console.log('PULL(no refunds)', paid[0].shopifyId, JSON.stringify(pulled))
  }
  if (db) {
    const rows = await db
      .select({
        number: s.refunds.number,
        order: s.refunds.shopifyOrder,
        source: s.refunds.source,
        status: s.refunds.status,
        amount: s.refunds.amount,
        refunded: s.refunds.refundedAmount,
        shopifyId: s.refunds.shopifyRefundId,
        gateway: s.refunds.gateway,
      })
      .from(s.refunds)
      .orderBy(desc(s.refunds.createdAt))
      .limit(8)
    console.log('ERP refund rows:', JSON.stringify(rows, null, 1))
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
