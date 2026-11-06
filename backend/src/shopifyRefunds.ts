/**
 * Shopify ↔ ERP refunds.
 *
 * Shopify has no "loyalty credit" style shortcut for refunds: the only correct
 * way to move money back is the `refundCreate` mutation, and the only correct
 * amount is the one Shopify itself computes from the discounted line prices,
 * taxes and shipping. This module therefore:
 *
 *  - reads authoritative refundable state from the Admin GraphQL API
 *    (`lineItem.refundableQuantity`, `suggestedRefund` for the amount and the
 *    gateway/transaction to refund through),
 *  - validates the operator's request against THAT state (never against a local
 *    total that may have drifted),
 *  - submits `refundCreate` with `NO_RESTOCK` (goods are restocked only when the
 *    ERP's return is received and inspected — a refund must never add stock),
 *  - and only reports success once Shopify returns a refund id.
 *
 * Webhooks (`refunds/create`) come through `syncRefundFromWebhook`, which is
 * idempotent on the Shopify refund id so a retried delivery cannot duplicate a
 * refund.
 */
import {
  linkRefundToOpenReturn,
  normalizeOrderRef,
  normalizeRefundId,
  reconcileOrderPaymentAfterRefund,
  recordRefund,
  logRefundSync,
} from './returns'
import { config, isConfigured } from './config'
import { db } from './db/client'
import * as s from './db/schema'
import { eq, or, sql } from 'drizzle-orm'
import { logger } from './logger'
import { reverseAward } from './loyalty'

const GRAPHQL_TIMEOUT_MS = 20_000
const MAX_ATTEMPTS = 3

export interface ShopifyGraphQLResult<T> {
  ok: boolean
  data?: T
  error?: string
  throttled?: boolean
}

/** Exported so the live verification scripts can hit the same admin endpoint. */
export async function adminGraphQL<T>(query: string, variables: Record<string, unknown> = {}): Promise<ShopifyGraphQLResult<T>> {
  if (!isConfigured()) return { ok: false, error: 'Shopify is not configured' }
  const url = `https://${config.shop}.myshopify.com/admin/api/${config.apiVersion}/graphql.json`
  let lastError = 'Shopify request failed'

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': config.accessToken },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      })
      if (res.status === 429 || res.status === 503) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '1')
        await new Promise((resolve) => setTimeout(resolve, Math.max(500, retryAfter * 1000)))
        lastError = `Shopify rate limit (HTTP ${res.status})`
        continue
      }
      if (res.status === 401) return { ok: false, error: 'Shopify rejected the access token (HTTP 401)' }
      if (res.status === 403) {
        return { ok: false, error: 'The Shopify app is missing the read_orders / write_orders scopes needed to refund' }
      }
      if (!res.ok) {
        lastError = `Shopify responded HTTP ${res.status}`
        if (res.status >= 500) continue
        return { ok: false, error: lastError }
      }
      const json = (await res.json()) as {
        data?: T
        errors?: Array<{ message?: string; extensions?: { code?: string } }>
      }
      if (json.errors?.length) {
        const throttled = json.errors.some((e) => String(e.extensions?.code ?? '').toUpperCase() === 'THROTTLED')
        if (throttled && attempt < MAX_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
          lastError = 'Shopify throttled the request'
          continue
        }
        return {
          ok: false,
          throttled,
          error: json.errors.map((e) => e.message ?? 'GraphQL error').join('; ').slice(0, 500),
        }
      }
      return { ok: true, data: json.data }
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Shopify request failed'
      if (attempt === MAX_ATTEMPTS - 1) return { ok: false, error: lastError }
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, error: lastError }
}

/** Money as a plain number from a Shopify `{ amount }` / MoneyBag shape. */
function money(value: unknown): number {
  const amount =
    (value as { presentmentMoney?: { amount?: unknown }; shopMoney?: { amount?: unknown }; amount?: unknown } | null)
      ?.presentmentMoney?.amount ??
    (value as { shopMoney?: { amount?: unknown } } | null)?.shopMoney?.amount ??
    (value as { amount?: unknown } | null)?.amount
  const n = Number(amount ?? 0)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

/** ISO currency of a Shopify `MoneyBag`, presentment first (what was charged). */
function moneyCurrency(value: unknown): string | null {
  const code =
    (value as { presentmentMoney?: { currencyCode?: unknown }; shopMoney?: { currencyCode?: unknown } } | null)
      ?.presentmentMoney?.currencyCode ??
    (value as { shopMoney?: { currencyCode?: unknown } } | null)?.shopMoney?.currencyCode
  const text = String(code ?? '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(text) ? text : null
}

export interface RefundableLine {
  /** Shopify LineItem gid. */
  lineItemId: string
  name: string
  sku: string
  quantity: number
  refundableQuantity: number
  /** Discounted unit price — the base the refund is computed from. */
  unitPrice: number
  currency: string
}

export interface RefundableOrder {
  orderGid: string
  orderName: string
  currency: string
  totalPrice: number
  totalRefunded: number
  financialStatus: string
  paymentMethod: string | null
  lines: RefundableLine[]
}

const ORDER_REFUNDABLE_QUERY = `#graphql
  query RefundableOrder($query: String!) {
    orders(first: 1, query: $query) {
      nodes {
        id
        name
        displayFinancialStatus
        currencyCode
        presentmentCurrencyCode
        totalPriceSet { presentmentMoney { amount currencyCode } }
        totalRefundedSet { presentmentMoney { amount currencyCode } }
        transactions { id kind status gateway amountSet { presentmentMoney { amount } } }
        lineItems(first: 100) {
          nodes {
            id
            name
            sku
            quantity
            refundableQuantity
            discountedUnitPriceSet { presentmentMoney { amount } }
            originalUnitPriceSet { presentmentMoney { amount } }
          }
        }
      }
    }
  }`

interface OrderRefundableResponse {
  orders?: {
    nodes?: Array<{
      id: string
      name: string
      displayFinancialStatus?: string | null
      currencyCode?: string | null
      presentmentCurrencyCode?: string | null
      totalPriceSet?: unknown
      totalRefundedSet?: unknown
      transactions?: Array<{ kind?: string; status?: string; gateway?: string | null; amountSet?: unknown }> | null
      lineItems?: {
        nodes?: Array<{
          id: string
          name?: string | null
          sku?: string | null
          quantity?: number | null
          refundableQuantity?: number | null
          discountedUnitPriceSet?: unknown
          originalUnitPriceSet?: unknown
        }>
      }
    }>
  }
}

/** Fetch the live refundable state of one Shopify order by its `#name`. */
export async function fetchRefundableOrder(orderName: string): Promise<
  { ok: true; order: RefundableOrder } | { ok: false; error: string }
> {
  const ref = normalizeOrderRef(orderName)
  if (!ref) return { ok: false, error: 'A Shopify order number is required' }
  const result = await adminGraphQL<OrderRefundableResponse>(ORDER_REFUNDABLE_QUERY, {
    query: `name:${ref}`,
  })
  if (!result.ok) return { ok: false, error: result.error ?? 'Shopify request failed' }
  const order = result.data?.orders?.nodes?.[0]
  if (!order) return { ok: false, error: `Order ${ref} was not found on Shopify` }

  const lines = (order.lineItems?.nodes ?? [])
    .map((li) => ({
      lineItemId: li.id,
      name: String(li.name ?? li.sku ?? '').trim(),
      sku: String(li.sku ?? '').trim(),
      quantity: Math.max(0, Math.floor(Number(li.quantity ?? 0))),
      refundableQuantity: Math.max(0, Math.floor(Number(li.refundableQuantity ?? 0))),
      unitPrice: money(li.discountedUnitPriceSet) || money(li.originalUnitPriceSet),
      // Presentment (customer) currency: the amounts above are presentmentMoney.
      currency: String(order.presentmentCurrencyCode ?? order.currencyCode ?? 'INR'),
    }))
    .filter((li) => li.lineItemId)

  const sale = (order.transactions ?? []).find(
    (t) => String(t.kind ?? '').toUpperCase() === 'SALE' && String(t.status ?? '').toUpperCase() === 'SUCCESS',
  )

  return {
    ok: true,
    order: {
      orderGid: order.id,
      orderName: String(order.name ?? ref),
      currency: String(order.presentmentCurrencyCode ?? order.currencyCode ?? 'INR'),
      totalPrice: money(order.totalPriceSet),
      totalRefunded: money(order.totalRefundedSet),
      financialStatus: String(order.displayFinancialStatus ?? ''),
      paymentMethod: sale?.gateway ? String(sale.gateway) : null,
      lines,
    },
  }
}

export interface RefundRequestItem {
  lineItemId?: string | null
  sku?: string | null
  quantity: number
}

export interface RefundPreview {
  orderName: string
  currency: string
  /** Total Shopify says should be refunded for these items (tax and discounts included). */
  itemsAmount: number
  shippingAmount: number
  totalAmount: number
  maximumRefundable: number
  /** Gateway + parent transaction Shopify suggests refunding through. */
  suggested: Array<{ gateway: string; parentTransactionId: string | null; amount: number; kind?: string }>
  lines: Array<{ lineItemId: string; name: string; sku: string; quantity: number; amount: number }>
  warnings: string[]
}

interface SuggestedRefundResponse {
  order?: {
    suggestedRefund?: {
      amountSet?: unknown
      maximumRefundableSet?: unknown
      suggestedTransactions?: Array<{
        amountSet?: unknown
        gateway?: string | null
        formattedGateway?: string | null
        kind?: string | null
        parentTransaction?: { id?: string } | null
      }>
    } | null
  }
}

const SUGGESTED_REFUND_QUERY = `#graphql
  query SuggestedRefund($id: ID!, $refundLineItems: [RefundLineItemInput!]!) {
    order(id: $id) {
      suggestedRefund(refundLineItems: $refundLineItems) {
        amountSet { presentmentMoney { amount currencyCode } }
        maximumRefundableSet { presentmentMoney { amount } }
        suggestedTransactions {
          amountSet { presentmentMoney { amount } }
          gateway
          formattedGateway
          kind
          parentTransaction { id }
        }
      }
    }
  }`

/**
 * Resolve what a refund of these items would actually pay back.
 *
 * Amounts come from `suggestedRefund`, which is Shopify's own calculation
 * (discounts, taxes and line-level adjustments included) — never
 * `price × quantity`, which is wrong the moment the order had a discount.
 */
export async function previewRefund(
  orderName: string,
  items: RefundRequestItem[],
  opts: { shippingAmount?: number | null; restock?: boolean } = {},
): Promise<{ ok: true; preview: RefundPreview } | { ok: false; error: string; status?: number }> {
  const fetched = await fetchRefundableOrder(orderName)
  if (!fetched.ok) return { ok: false, error: fetched.error, status: 502 }
  const order = fetched.order
  const warnings: string[] = []

  const wanted = new Map<string, { line: RefundableLine; quantity: number }>()
  for (const it of items) {
    const quantity = Math.floor(Number(it.quantity ?? 0))
    if (quantity <= 0) continue
    const line = it.lineItemId
      ? order.lines.find((l) => l.lineItemId === it.lineItemId)
      : order.lines.find((l) => String(l.sku).toLowerCase() === String(it.sku ?? '').trim().toLowerCase())
    if (!line) {
      return { ok: false, error: `Line item ${it.sku ?? it.lineItemId} is not on order ${order.orderName}`, status: 400 }
    }
    const prev = wanted.get(line.lineItemId)
    const total = (prev?.quantity ?? 0) + quantity
    if (total > line.refundableQuantity) {
      return {
        ok: false,
        status: 400,
        error:
          line.refundableQuantity === 0
            ? `${line.name} has nothing left to refund on Shopify`
            : `Only ${line.refundableQuantity} × ${line.name} can be refunded on Shopify — ${total} requested`,
      }
    }
    wanted.set(line.lineItemId, { line, quantity: total })
  }
  if (wanted.size === 0) return { ok: false, error: 'Select at least one product and quantity to refund', status: 400 }

  const refundLineItems = [...wanted.values()].map(({ line, quantity }) => ({
    lineItemId: line.lineItemId,
    quantity,
    // Inventory is restocked only when the ERP return is physically received.
    restockType: opts.restock ? 'RETURN' : 'NO_RESTOCK',
  }))

  const suggested = await adminGraphQL<SuggestedRefundResponse>(SUGGESTED_REFUND_QUERY, {
    id: order.orderGid,
    refundLineItems,
  })

  let itemsAmount = 0
  let maximumRefundable = Math.round((order.totalPrice - order.totalRefunded) * 100) / 100
  let suggestedTransactions: RefundPreview['suggested'] = []

  if (suggested.ok && suggested.data?.order?.suggestedRefund) {
    const s = suggested.data.order.suggestedRefund
    itemsAmount = money(s.amountSet)
    const max = money(s.maximumRefundableSet)
    if (max > 0) maximumRefundable = max
    suggestedTransactions = (s.suggestedTransactions ?? [])
      .map((t) => ({
        gateway: String(t.gateway ?? ''),
        parentTransactionId: t.parentTransaction?.id ?? null,
        amount: money(t.amountSet),
        kind: t.kind ?? undefined,
      }))
      .filter((t) => t.gateway && t.amount > 0)
  } else {
    // Fallback: Shopify's suggested amount is unavailable (scope/quota). Use the
    // discounted unit prices, and say so, because the real amount may differ by
    // taxes or duties.
    itemsAmount = Math.round(
      [...wanted.values()].reduce((sum, { line, quantity }) => sum + line.unitPrice * quantity, 0) * 100,
    ) / 100
    warnings.push(
      `Shopify's suggested refund amount was unavailable${suggested.ok ? '' : ` (${suggested.error})`} — the amount shown is the discounted line total and may differ from what Shopify charges back.`,
    )
  }

  const requestedShipping = Math.max(0, Number(opts.shippingAmount ?? 0))
  const shippingAmount = Math.min(requestedShipping, Math.max(0, maximumRefundable - itemsAmount))
  if (requestedShipping > shippingAmount && shippingAmount >= 0) {
    warnings.push(`Shipping refund capped at ${shippingAmount.toFixed(2)} — that is all that is still refundable.`)
  }

  const totalAmount = Math.round((itemsAmount + shippingAmount) * 100) / 100
  if (totalAmount <= 0) {
    return { ok: false, error: 'This selection has nothing left to refund on Shopify', status: 400 }
  }
  if (!suggestedTransactions.length) {
    warnings.push(
      'Shopify did not suggest a payment transaction to refund through. The refund will be recorded, but no money can be returned until the order has a refundable payment.',
    )
  }

  return {
    ok: true,
    preview: {
      orderName: order.orderName,
      currency: order.currency,
      itemsAmount,
      shippingAmount,
      totalAmount,
      maximumRefundable,
      suggested: suggestedTransactions,
      lines: [...wanted.values()].map(({ line, quantity }) => ({
        lineItemId: line.lineItemId,
        name: line.name,
        sku: line.sku,
        quantity,
        amount: Math.round(line.unitPrice * quantity * 100) / 100,
      })),
      warnings,
    },
  }
}

export interface CreateRefundOptions {
  orderName: string
  items: RefundRequestItem[]
  shippingAmount?: number | null
  note?: string | null
  notify?: boolean
  returnId?: string | null
  createdBy?: string | null
  idempotencyKey?: string | null
  /** Restock on Shopify too. Off by default: the ERP's return receipt owns stock. */
  restock?: boolean
  /**
   * Re-attempt a refund that previously failed, updating that same row instead
   * of creating a second one. The failed row keeps its number, so the operator
   * sees one refund with a successful retry rather than a pile of attempts.
   */
  retryRefundId?: string | null
}

export interface CreateRefundOutcome {
  ok: boolean
  /** Present only once Shopify confirmed the refund. */
  refundId?: string | null
  refundNumber?: string | null
  amount?: number
  currency?: string
  status?: 'completed' | 'pending' | 'failed'
  /** True when the same ERP idempotency key had already produced a refund. */
  replayed?: boolean
  error?: string
  warnings?: string[]
}

const REFUND_CREATE_MUTATION = `#graphql
  mutation CreateRefund($input: RefundInput!) {
    refundCreate(input: $input) {
      refund {
        id
        totalRefundedSet { presentmentMoney { amount currencyCode } }
        transactions(first: 10) {
          nodes { id kind status gateway amountSet { presentmentMoney { amount } } }
        }
      }
      userErrors { field message }
    }
  }`

interface RefundCreateResponse {
  refundCreate?: {
    refund?: {
      id: string
      totalRefundedSet?: unknown
      transactions?: { nodes?: Array<{ id: string; kind?: string; status?: string; gateway?: string | null; amountSet?: unknown }> }
    } | null
    userErrors?: Array<{ field?: string[]; message?: string }>
  }
}

/**
 * Reverse the loyalty points earned by the refunded value.
 * Keyed by the Shopify refund id inside `reverseAward`, so the webhook that
 * follows an ERP push (or a retry) reverses nothing a second time.
 */
async function reverseAwardRefund(orderRef: string, amount: number, shopifyRefundId: string): Promise<void> {
  try {
    await reverseAward({
      orderName: orderRef,
      value: amount,
      // Normalised key: the webhook for this same refund must not post a second
      // reversal just because Shopify spells the id differently there.
      refundId: normalizeRefundId(shopifyRefundId) ?? shopifyRefundId,
      reason: `Reversed for refund ${amount.toLocaleString('en-IN')} on ${orderRef}`,
    })
  } catch (err) {
    logger.warn({ err, orderRef }, 'loyalty reversal after refund failed (non-fatal)')
  }
}

/**
 * Create a refund in Shopify and persist it.
 *
 * Refuses to call Shopify when the ERP already has a completed refund for the
 * same idempotency key, and refuses to report success unless Shopify returned a
 * refund id — a failed mutation is saved as a `failed` refund so the operator
 * can retry it from the Refunds tab.
 */
export async function createRefundInShopify(opts: CreateRefundOptions): Promise<CreateRefundOutcome> {
  if (!db) return { ok: false, error: 'Database unavailable' }
  if (!isConfigured()) return { ok: false, error: 'Shopify is not configured' }

  const idempotencyKey =
    typeof opts.idempotencyKey === 'string' && opts.idempotencyKey.trim() ? opts.idempotencyKey.trim() : null

  if (idempotencyKey && !opts.retryRefundId) {
    const [prior] = await db.select().from(s.refunds).where(eq(s.refunds.idempotencyKey, idempotencyKey)).limit(1)
    if (prior) {
      return {
        ok: prior.status !== 'failed',
        replayed: true,
        refundId: prior.shopifyRefundId,
        refundNumber: String(prior.number),
        amount: Number(prior.amount ?? 0),
        currency: (prior.currency as string | null) ?? undefined,
        status: (prior.status as 'completed' | 'pending' | 'failed'),
        error: prior.status === 'failed' ? String(prior.syncError ?? 'The previous attempt failed') : undefined,
      }
    }
  }

  const preview = await previewRefund(opts.orderName, opts.items, {
    shippingAmount: opts.shippingAmount ?? 0,
    restock: opts.restock,
  })
  if (!preview.ok) return { ok: false, error: preview.error }

  const p = preview.preview
  const orderRef = normalizeOrderRef(p.orderName)
  const [localOrder] = await db
    .select({ id: s.salesOrders.id, customer: s.salesOrders.customer, customerEmail: s.salesOrders.customerEmail })
    .from(s.salesOrders)
    .where(eq(s.salesOrders.shopifyId, orderRef))
    .limit(1)

  const fetched = await fetchRefundableOrder(p.orderName)
  if (!fetched.ok) return { ok: false, error: fetched.error }

  // Money only moves through payment transactions, so mirror the transactions
  // Shopify says are refundable. A split payment (card + gift card) has one per
  // gateway: submitting the total once through a single gateway would either be
  // rejected or refund money the customer never paid that way. Shipping is not
  // part of the suggested line amounts, so it rides on the largest one.
  const suggestedTotal = Math.round(p.suggested.reduce((sum, t) => sum + t.amount, 0) * 100) / 100
  const shippingExtra = Math.max(0, Math.round((p.totalAmount - suggestedTotal) * 100) / 100)
  const largest = [...p.suggested].sort((a, b) => b.amount - a.amount)[0]
  const transactions = p.suggested.length
    ? p.suggested.map((t) => ({
        orderId: fetched.order.orderGid,
        parentId: t.parentTransactionId ?? undefined,
        kind: 'REFUND',
        gateway: t.gateway,
        // `Money` is a plain decimal string; `currency` carries the code.
        amount: (t === largest ? t.amount + shippingExtra : t.amount).toFixed(2),
      }))
    : undefined

  if (!transactions) {
    // No refundable payment on the order (manual/bank-transfer payment, or it is
    // already fully refunded). Creating a "refund" with no transaction would put
    // a refund amount on the order while moving no money — the exact lie this
    // module exists to prevent.
    return {
      ok: false,
      warnings: p.warnings,
      error:
        'Shopify has no refundable payment transaction for this order. Refund it in Shopify admin (Refund → refund manually) and it will sync back here automatically.',
    }
  }

  const input: Record<string, unknown> = {
    orderId: fetched.order.orderGid,
    refundLineItems: p.lines.map((l) => ({
      lineItemId: l.lineItemId,
      quantity: l.quantity,
      restockType: opts.restock ? 'RETURN' : 'NO_RESTOCK',
    })),
    notify: Boolean(opts.notify),
    transactions,
  }
  if (p.shippingAmount > 0) {
    input.shipping = { amount: p.shippingAmount.toFixed(2) }
  }
  // Shopify requires the presentment currency when it differs from the shop's.
  if (p.currency) input.currency = p.currency
  if (opts.note) input.note = String(opts.note).slice(0, 250)

  const result = await adminGraphQL<RefundCreateResponse>(REFUND_CREATE_MUTATION, { input })
  const payload = result.data?.refundCreate

  if (!result.ok || !payload?.refund?.id) {
    const message =
      payload?.userErrors?.map((u) => (u.field ? `${u.field.join('.')}: ${u.message}` : u.message)).join('; ') ||
      result.error ||
      'Shopify did not return a refund'

    if (opts.retryRefundId) {
      await db
        .update(s.refunds)
        .set({
          status: 'failed',
          amount: p.totalAmount,
          refundedAmount: 0,
          syncError: message.slice(0, 1000),
          attempts: sql`coalesce(${s.refunds.attempts}, 0) + 1`,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(s.refunds.id, opts.retryRefundId))
      await logRefundSync({ refundId: opts.retryRefundId, action: 'retry', status: 'failed', message })
      logger.error({ orderRef, message, retryRefundId: opts.retryRefundId }, 'Shopify refund retry failed')
      return { ok: false, error: message, warnings: p.warnings }
    }

    const failed = await recordRefund({
      shopifyRefundId: null,
      shopifyOrder: orderRef,
      customer: localOrder?.customer ?? null,
      customerEmail: localOrder?.customerEmail ?? null,
      returnId: opts.returnId ?? null,
      source: 'erp',
      status: 'failed',
      requestedAmount: p.totalAmount,
      amount: p.totalAmount,
      refundedAmount: 0,
      currency: p.currency,
      paymentMethod: p.suggested[0]?.gateway ?? null,
      gateway: p.suggested[0]?.gateway ?? null,
      note: opts.note ?? null,
      items: p.lines.map((l) => ({ shopifyLineItemId: l.lineItemId, sku: l.sku, product: l.name, quantity: l.quantity, amount: l.amount })),
      createdBy: opts.createdBy ?? null,
      idempotencyKey,
      action: 'erp_push',
      syncMessage: `Shopify refund failed: ${message}`,
    })
    if (failed) {
      await db.update(s.refunds).set({ syncError: message.slice(0, 1000), updatedAt: new Date().toISOString() }).where(eq(s.refunds.id, failed.id))
    }
    logger.error({ orderRef, message }, 'Shopify refundCreate failed')
    return { ok: false, error: message, warnings: p.warnings }
  }

  const shopifyRefund = payload.refund
  const confirmedAmount = money(shopifyRefund.totalRefundedSet) || p.totalAmount
  const txNodes = shopifyRefund.transactions?.nodes ?? []
  const settled = txNodes.some((t) => String(t.status ?? '').toUpperCase() === 'SUCCESS')
  // Money has not moved until a transaction settles; a refund awaiting the
  // gateway is `pending`, never `completed`.
  const status: 'completed' | 'pending' | 'failed' = settled ? 'completed' : 'pending'

  if (opts.retryRefundId) {
    // Retry of a failed attempt: settle the row we already have, so the operator
    // sees one refund that finally succeeded rather than duplicate references.
    const now = new Date().toISOString()
    await db
      .update(s.refunds)
      .set({
        shopifyRefundId: shopifyRefund.id,
        status,
        amount: confirmedAmount,
        requestedAmount: p.totalAmount,
        refundedAmount: settled ? confirmedAmount : 0,
        paymentMethod: txNodes[0]?.gateway ?? p.suggested[0]?.gateway ?? null,
        gateway: txNodes[0]?.gateway ?? p.suggested[0]?.gateway ?? null,
        transactionIds: txNodes.map((t) => t.id).join(','),
        syncError: null,
        processedAt: settled ? now : null,
        attempts: sql`coalesce(${s.refunds.attempts}, 0) + 1`,
        updatedAt: now,
      })
      .where(eq(s.refunds.id, opts.retryRefundId))
    const [row] = await db
      .select({ number: s.refunds.number })
      .from(s.refunds)
      .where(eq(s.refunds.id, opts.retryRefundId))
      .limit(1)
    await logRefundSync({
      refundId: opts.retryRefundId,
      action: 'retry',
      status: 'success',
      message: `Retry succeeded — Shopify refund ${shopifyRefund.id} created`,
    })
    await reverseAwardRefund(orderRef, confirmedAmount, shopifyRefund.id)
    await reconcileOrderPaymentAfterRefund(orderRef).catch(() => undefined)
    return {
      ok: true,
      refundId: shopifyRefund.id,
      refundNumber: row?.number ? String(row.number) : null,
      amount: confirmedAmount,
      currency: p.currency,
      status,
      warnings: p.warnings,
    }
  }

  const saved = await recordRefund({
    shopifyRefundId: shopifyRefund.id,
    shopifyOrder: orderRef,
    customer: localOrder?.customer ?? null,
    customerEmail: localOrder?.customerEmail ?? null,
    returnId: opts.returnId ?? null,
    source: 'erp',
    status,
    requestedAmount: p.totalAmount,
    amount: confirmedAmount,
    refundedAmount: settled ? confirmedAmount : 0,
    currency: p.currency,
    paymentMethod: txNodes[0]?.gateway ?? p.suggested[0]?.gateway ?? null,
    gateway: txNodes[0]?.gateway ?? p.suggested[0]?.gateway ?? null,
    transactionIds: txNodes.map((t) => t.id).join(','),
    note: opts.note ?? null,
    items: p.lines.map((l) => ({ shopifyLineItemId: l.lineItemId, sku: l.sku, product: l.name, quantity: l.quantity, amount: l.amount })),
    createdBy: opts.createdBy ?? null,
    idempotencyKey,
    action: 'erp_push',
    syncMessage: `Refund created in Shopify (${shopifyRefund.id})`,
  })

  // Loyalty: reverse the earned points for the value refunded. Keyed by the
  // Shopify refund id, so the webhook that follows this push reverses nothing.
  await reverseAwardRefund(orderRef, confirmedAmount, shopifyRefund.id)

  await reconcileOrderPaymentAfterRefund(orderRef).catch(() => undefined)

  return {
    ok: true,
    refundId: shopifyRefund.id,
    refundNumber: saved?.number ?? null,
    amount: confirmedAmount,
    currency: p.currency,
    status,
    warnings: p.warnings,
  }
}

// ─── Shopify → ERP ──────────────────────────────────────────────────────────

export interface ShopifyRefundWebhook {
  id?: number | string
  order_id?: number | string
  created_at?: string
  note?: string | null
  refund_line_items?: Array<{
    id?: number | string
    line_item_id?: number | string
    quantity?: number | null
    subtotal?: string | number | null
    total_tax?: string | number | null
    restock_type?: string | null
    line_item?: { id?: number | string; name?: string | null; sku?: string | null; title?: string | null } | null
  }>
  transactions?: Array<{
    id?: number | string
    amount?: string | number | null
    kind?: string | null
    /** Presentment currency of THIS transaction — the money actually moved. */
    currency?: string | null
    gateway?: string | null
    status?: string | null
    parent_id?: number | string | null
  }>
  order?: { id?: number | string; name?: string | null; email?: string | null; currency?: string | null }
}

/** Resolve a Shopify order's `#name` from its numeric id (webhooks carry both, but not always the name). */
async function orderNameFromShopifyOrderId(orderId: number | string): Promise<string | null> {
  if (!isConfigured()) return null
  try {
    const res = await fetch(
      `https://${config.shop}.myshopify.com/admin/api/${config.apiVersion}/orders/${encodeURIComponent(String(orderId))}.json?fields=id,name`,
      { headers: { 'X-Shopify-Access-Token': config.accessToken, Accept: 'application/json' } },
    )
    if (!res.ok) return null
    const json = (await res.json()) as { order?: { name?: string } }
    return json.order?.name ? normalizeOrderRef(json.order.name) : null
  } catch {
    return null
  }
}

/**
 * Persist a `refunds/create` delivery.
 *
 * Idempotent on the Shopify refund id: a Shopify retry, or a refund we created
 * from the ERP and whose webhook then arrives, updates the existing row instead
 * of duplicating it. Returns the refund id so the caller can tie loyalty and
 * return state to the same record.
 */
export async function syncRefundFromWebhook(
  payload: ShopifyRefundWebhook | null | undefined,
  meta: { action?: string } = {},
): Promise<{ ok: boolean; refundId?: string | null; amount?: number; duplicate?: boolean; reason?: string }> {
  if (!payload || payload.id == null) return { ok: false, reason: 'Refund payload has no id' }

  const externalId = String(payload.id)
  let orderName = payload.order?.name ? normalizeOrderRef(payload.order.name) : ''
  if (!orderName && payload.order_id != null) {
    orderName = (await orderNameFromShopifyOrderId(payload.order_id)) ?? ''
    if (!orderName && db) {
      // Last resort: our own import may have keyed the order by Shopify's
      // numeric id (older rows used `shopify-<id>`).
      const [row] = await db
        .select({ shopifyId: s.salesOrders.shopifyId })
        .from(s.salesOrders)
        .where(
          or(
            eq(s.salesOrders.id, `shopify-${payload.order_id}`),
            eq(s.salesOrders.shopifyId, normalizeOrderRef(payload.order_id)),
          ),
        )
        .limit(1)
      orderName = row?.shopifyId ? normalizeOrderRef(row.shopifyId) : ''
    }
  }

  const transactions = payload.transactions ?? []
  const refundTx = transactions.filter((t) => String(t.kind ?? '').toUpperCase() === 'REFUND')
  const voided = transactions.some((t) => String(t.kind ?? '').toUpperCase() === 'VOID')
  const settledTx = refundTx.filter((t) => String(t.status ?? '').toUpperCase() === 'SUCCESS')
  const pendingTx = refundTx.filter((t) => ['PENDING', 'PROCESSING'].includes(String(t.status ?? '').toUpperCase()))
  const failedTx = refundTx.filter((t) => String(t.status ?? '').toUpperCase() === 'FAILURE')

  const lineAmount = (payload.refund_line_items ?? []).reduce(
    (sum, li) => sum + Number(li.subtotal ?? 0) + Number(li.total_tax ?? 0),
    0,
  )
  const txAmount = refundTx.reduce((sum, t) => sum + Number(t.amount ?? 0), 0)
  const amount = Math.round((txAmount > 0 ? txAmount : lineAmount) * 100) / 100

  let status: 'completed' | 'pending' | 'failed' = 'completed'
  if (voided && !refundTx.length) status = 'failed'
  else if (failedTx.length && !settledTx.length && !pendingTx.length) status = 'failed'
  else if (pendingTx.length && !settledTx.length) status = 'pending'
  else if (refundTx.length > 0 && !settledTx.length && !pendingTx.length) status = 'pending'

  const items = (payload.refund_line_items ?? []).map((li) => {
    const unit = Number(li.subtotal ?? 0) + Number(li.total_tax ?? 0)
    return {
      shopifyLineItemId: li.line_item_id != null ? String(li.line_item_id) : li.line_item?.id != null ? String(li.line_item.id) : null,
      product: li.line_item?.name ?? li.line_item?.title ?? null,
      sku: li.line_item?.sku ?? null,
      quantity: Math.max(0, Math.floor(Number(li.quantity ?? 0))),
      amount: Math.round(unit * 100) / 100,
      restockType: li.restock_type ?? null,
    }
  })

  // Currency of the money that moved. A refund transaction carries its own
  // presentment currency, which for a multi-currency order differs from the
  // order's shop currency; the transaction is the most specific source.
  const transactionCurrency = transactions
    .map((t) => String(t.currency ?? '').trim().toUpperCase())
    .find((code) => /^[A-Z]{3}$/.test(code))

  const saved = await recordRefund({
    shopifyRefundId: externalId,
    shopifyOrder: orderName || null,
    customerEmail: payload.order?.email ?? null,
    source: 'shopify',
    status,
    amount,
    refundedAmount: status === 'completed' ? amount : 0,
    requestedAmount: amount,
    currency: transactionCurrency ?? payload.order?.currency ?? null,
    paymentMethod: refundTx[0]?.gateway ?? null,
    gateway: refundTx[0]?.gateway ?? null,
    transactionIds: refundTx.map((t) => String(t.id ?? '')).filter(Boolean).join(','),
    note: payload.note ?? null,
    items,
    processedAt: payload.created_at ?? null,
    action: meta.action ?? 'webhook',
    syncMessage: `Shopify refund ${externalId} received (${status})`,
  })
  if (!saved) return { ok: false, reason: 'Could not save the refund' }

  if (orderName) {
    // A refund issued in the Shopify admin can settle an RMA the ERP already has
    // open; attach it when that is unambiguous.
    await linkRefundToOpenReturn(saved.id, orderName).catch(() => null)
    await reconcileOrderPaymentAfterRefund(orderName).catch(() => undefined)
  }

  return { ok: true, refundId: saved.id, amount, duplicate: !saved.created }
}

/** Pull every refund of one Shopify order into the ERP (the Retry/Refresh sync action). */
export async function pullRefundsForOrder(orderName: string): Promise<
  { ok: true; orderName: string; imported: number; updated: number } | { ok: false; error: string }
> {
  const ref = normalizeOrderRef(orderName)
  if (!ref) return { ok: false, error: 'A Shopify order number is required' }

  const query = `#graphql
    query OrderRefunds($query: String!) {
      orders(first: 1, query: $query) {
        nodes {
          name
          currencyCode
          # Refund amounts are presentment money: a store that sells in several
          # currencies must be labelled with the currency the customer paid in.
          presentmentCurrencyCode
          # No customer email field: reading customer PII needs a Shopify plan
          # this store may not have, and the ERP already holds the email.
          refunds {
            id
            createdAt
            note
            totalRefundedSet { presentmentMoney { amount currencyCode } }
            refundLineItems(first: 50) {
              nodes {
                quantity
                subtotalSet { presentmentMoney { amount } }
                restockType
                lineItem { id name sku }
              }
            }
            transactions(first: 10) {
              nodes { id kind status gateway amountSet { presentmentMoney { amount currencyCode } } }
            }
          }
        }
      }
    }`

  const res = await adminGraphQL<{
    orders?: {
      nodes?: Array<{
        name?: string
        currencyCode?: string | null
        presentmentCurrencyCode?: string | null
        refunds?: Array<{
          id: string
          createdAt?: string | null
          note?: string | null
          totalRefundedSet?: unknown
          refundLineItems?: {
            nodes?: Array<{ quantity?: number; subtotalSet?: unknown; restockType?: string | null; lineItem?: { id: string; name?: string | null; sku?: string | null } | null }>
          }
          transactions?: {
            nodes?: Array<{ id: string; kind?: string; status?: string; gateway?: string | null; amountSet?: unknown }>
          }
        }> | null
      }>
    }
  }>(query, { query: `name:${ref}` })

  if (!res.ok) return { ok: false, error: res.error ?? 'Shopify request failed' }
  const order = res.data?.orders?.nodes?.[0]
  if (!order) return { ok: false, error: `Order ${ref} was not found on Shopify` }

  let imported = 0
  let updated = 0
  for (const refund of order.refunds ?? []) {
    const nodes = refund.transactions?.nodes ?? []
    const refundTx = nodes.filter((t) => String(t.kind ?? '').toUpperCase() === 'REFUND')
    const settled = refundTx.some((t) => String(t.status ?? '').toUpperCase() === 'SUCCESS')
    const amount = money(refund.totalRefundedSet) || refundTx.reduce((sum, t) => sum + money(t.amountSet), 0)
    // The currency on the transaction is what the gateway actually refunded.
    const currency = refundTx.map((t) => moneyCurrency(t.amountSet)).find(Boolean) ?? moneyCurrency(refund.totalRefundedSet)
    const saved = await recordRefund({
      shopifyRefundId: refund.id,
      shopifyOrder: order.name ?? ref,
      source: 'shopify',
      status: settled || refundTx.length === 0 ? 'completed' : 'pending',
      amount,
      refundedAmount: settled || refundTx.length === 0 ? amount : 0,
      requestedAmount: amount,
      currency: currency ?? order.presentmentCurrencyCode ?? order.currencyCode ?? null,
      paymentMethod: refundTx[0]?.gateway ?? null,
      gateway: refundTx[0]?.gateway ?? null,
      transactionIds: refundTx.map((t) => t.id).join(','),
      note: refund.note ?? null,
      items: (refund.refundLineItems?.nodes ?? []).map((li) => ({
        shopifyLineItemId: li.lineItem?.id ?? null,
        product: li.lineItem?.name ?? null,
        sku: li.lineItem?.sku ?? null,
        quantity: Math.max(0, Math.floor(Number(li.quantity ?? 0))),
        amount: money(li.subtotalSet),
        restockType: li.restockType ?? null,
      })),
      processedAt: refund.createdAt ?? null,
      action: 'pull',
      syncMessage: `Pulled refund ${refund.id} from Shopify`,
    })
    if (saved?.created) imported++
    else if (saved) updated++
    // A refund that only ever arrives through a manual sync must still claw back
    // the points it earned. Keyed on the Shopify refund id, so a webhook for the
    // same refund arriving later reverses nothing a second time.
    if (saved && amount > 0 && (settled || refundTx.length === 0)) {
      await reverseAwardRefund(ref, amount, refund.id)
    }
  }
  await reconcileOrderPaymentAfterRefund(ref).catch(() => undefined)
  await logRefundSync({
    action: 'pull',
    status: 'success',
    message: `${ref}: ${imported} imported, ${updated} refreshed`,
  })
  return { ok: true, orderName: order.name ?? ref, imported, updated }
}

/**
 * Retry a refund that failed in the ERP (Shopify error, gateway hiccup).
 *
 * Re-runs the full validate-preview-refundCreate cycle against live Shopify
 * state, so quantities that were refunded in the meantime by hand cannot be
 * refunded twice.
 */
export async function retryFailedRefund(
  refundId: string,
  actor?: string | null,
): Promise<CreateRefundOutcome> {
  if (!db) return { ok: false, error: 'Database unavailable' }
  const [row] = await db.select().from(s.refunds).where(eq(s.refunds.id, refundId)).limit(1)
  if (!row) return { ok: false, error: 'Refund not found' }
  if (row.status !== 'failed') return { ok: false, error: `Only failed refunds can be retried (this one is ${row.status})` }
  if (row.source !== 'erp') return { ok: false, error: 'Shopify-created refunds are synced, not retried' }
  if (!row.shopifyOrder) return { ok: false, error: 'This refund is not linked to a Shopify order' }

  const lines = await db.select().from(s.refundLineItems).where(eq(s.refundLineItems.refundId, refundId))
  if (lines.length === 0) return { ok: false, error: 'This refund has no line items to retry' }

  return createRefundInShopify({
    orderName: row.shopifyOrder,
    items: lines.map((l) => ({
      lineItemId: l.shopifyLineItemId ?? null,
      sku: l.sku ?? null,
      quantity: Math.max(0, Math.floor(Number(l.quantity ?? 0))),
    })),
    note: row.note ?? null,
    returnId: row.returnId ?? null,
    createdBy: actor ?? row.createdBy ?? null,
    retryRefundId: refundId,
  })
}
