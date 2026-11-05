import { config, isConfigured } from './config'
import { getRawClient } from './db/client'
import {
  isPlaceholderName,
  mergeAddress,
  normalizePhone,
  numericShopifyOrderId,
  upgradeName,
  type OrderAddress,
} from './shopifyCustomerData'
import { logger } from './logger'

/**
 * Enhanced Shopify data fetching.
 *
 * Shopify webhooks send minimal data (name, city, country only).
 * This module uses the GraphQL Admin API to fetch full customer details:
 * - Email, phone, full address
 * - Order history and total spent
 * - Tags, notes, created/updated dates
 *
 * Also supports CSV import for bulk data enrichment.
 */

interface GraphQLResponse<T = any> {
  data?: T
  errors?: Array<{ message: string }>
}

/**
 * Set once Shopify answers ACCESS_DENIED for PII (plan-gated Customer data).
 * While set, enrichment attempts are skipped — the block is account-level and
 * only lifts after access is approved in the Shopify admin.
 */
let piiAccessDenied = false
export function isPiiAccessDenied(): boolean {
  return piiAccessDenied
}

async function graphqlRequest<T>(query: string, variables?: Record<string, any>): Promise<T | null> {
  if (!isConfigured()) return null
  if (piiAccessDenied) return null

  const url = `https://${config.shop}.myshopify.com/admin/api/${config.apiVersion}/graphql.json`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': config.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    })

    if (!res.ok) {
      logger.error({ status: res.status }, 'Shopify GraphQL request failed')
      return null
    }

    const json: GraphQLResponse<T> = await res.json()
    if (json.errors?.length) {
      // Plan-gated Customer PII (Shopify/Advanced/Plus only for unapproved
      // apps) is not a fault and not a token/scope problem: the token works
      // for orders, products and the rest of the sync. Latch the flag, warn
      // ONCE per process, and skip the payload quietly — logging it at ERROR
      // made every boot look like a broken integration when it is an
      // expected plan limitation that only the Shopify admin can lift.
      if (json.errors.some((e) => (e as any)?.extensions?.code === 'ACCESS_DENIED' && /Customer object|personally identifiable/i.test(e.message))) {
        if (!piiAccessDenied) {
          piiAccessDenied = true
          logger.warn('Shopify PII access denied (plan-gated) — customer/order enrichment paused until access is approved in the Shopify admin. Orders and products sync normally.')
        }
        return null
      }
      logger.error({ errors: json.errors }, 'Shopify GraphQL errors')
      return null
    }
    return json.data ?? null
  } catch (err) {
    logger.error({ err }, 'Shopify GraphQL request exception')
    return null
  }
}

// ─── Fetch full customer details ──────────────────────────────────

export interface ShopifyCustomer {
  id: string
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  ordersCount: number
  totalSpent: string
  tags: string[]
  createdAt: string
  updatedAt: string
  defaultAddress?: {
    address1: string
    address2: string
    city: string
    province: string
    zip: string
    country: string
    phone: string
  }
}

export async function fetchCustomerById(shopifyCustomerId: string): Promise<ShopifyCustomer | null> {
  // customerById was removed from the Admin GraphQL API — use node(id:)
  // with an inline fragment (works regardless of searchable fields).
  const gql = `query ($id: ID!) {
    node(id: $id) {
      ... on Customer {
        id
        firstName
        lastName
        email
        phone
        ordersCount
        totalSpent
        tags
        createdAt
        updatedAt
        defaultAddress {
          address1
          address2
          city
          province
          zip
          country
          phone
        }
      }
    }
  }`

  const data = await graphqlRequest<{ node: any }>(gql, { id: `gid://shopify/Customer/${shopifyCustomerId}` })
  if (!data?.node) return null

  const c = data.node
  return {
    id: c.id?.replace('gid://shopify/Customer/', '') || shopifyCustomerId,
    firstName: c.firstName || '',
    lastName: c.lastName || '',
    email: c.email || null,
    phone: c.phone || null,
    ordersCount: c.ordersCount || 0,
    totalSpent: c.totalSpent || '0.0',
    tags: c.tags || [],
    createdAt: c.createdAt || '',
    updatedAt: c.updatedAt || '',
    defaultAddress: c.defaultAddress ? {
      address1: c.defaultAddress.address1 || '',
      address2: c.defaultAddress.address2 || '',
      city: c.defaultAddress.city || '',
      province: c.defaultAddress.province || '',
      zip: c.defaultAddress.zip || '',
      country: c.defaultAddress.country || '',
      phone: c.defaultAddress.phone || '',
    } : undefined,
  }
}

export async function fetchCustomerBySearch(query: string): Promise<ShopifyCustomer | null> {
  const gql = `query ($q: String!) {
    customers(first: 1, query: $q) {
      edges {
        node {
          id
          firstName
          lastName
          email
          phone
          ordersCount
          totalSpent
          tags
          createdAt
          updatedAt
          defaultAddress {
            address1
            address2
            city
            province
            zip
            country
            phone
          }
        }
      }
    }
  }`

  const data = await graphqlRequest<{ customers: { edges: Array<{ node: any }> } }>(gql, { q: query })
  if (!data?.customers?.edges?.length) return null

  const c = data.customers.edges[0].node
  return {
    id: c.id?.replace('gid://shopify/Customer/', '') || '',
    firstName: c.firstName || '',
    lastName: c.lastName || '',
    email: c.email || null,
    phone: c.phone || null,
    ordersCount: c.ordersCount || 0,
    totalSpent: c.totalSpent || '0.0',
    tags: c.tags || [],
    createdAt: c.createdAt || '',
    updatedAt: c.updatedAt || '',
    defaultAddress: c.defaultAddress ? {
      address1: c.defaultAddress.address1 || '',
      address2: c.defaultAddress.address2 || '',
      city: c.defaultAddress.city || '',
      province: c.defaultAddress.province || '',
      zip: c.defaultAddress.zip || '',
      country: c.defaultAddress.country || '',
      phone: c.defaultAddress.phone || '',
    } : undefined,
  }
}

// ─── Fetch full order details ─────────────────────────────────────

export interface ShopifyOrder {
  id: string
  name: string
  email: string | null
  phone: string | null
  totalPrice: string
  subtotalPrice: string
  totalTax: string
  currency: string
  financialStatus: string
  fulfillmentStatus: string
  createdAt: string
  updatedAt: string
  customer?: {
    id: string
    firstName: string
    lastName: string
    email: string
    phone: string
  }
  billingAddress?: {
    firstName: string
    lastName: string
    address1: string
    address2: string
    city: string
    province: string
    zip: string
    country: string
    phone: string
  }
  shippingAddress?: {
    firstName: string
    lastName: string
    address1: string
    address2: string
    city: string
    province: string
    zip: string
    country: string
    phone: string
  }
  lineItems: Array<{
    title: string
    sku: string
    quantity: number
    price: string
    variant?: { sku: string }
  }>
}

export async function fetchOrderById(shopifyOrderId: string): Promise<ShopifyOrder | null> {
  // NOTE: orderById was removed from the Admin GraphQL API — use the
  // orders(query:) search field instead (same fix as customerById).
  // orderById was removed from the Admin GraphQL API — use node(id:) with
  // an inline fragment instead.
  const query = `query ($id: ID!) {
    node(id: $id) {
      ... on Order {
        id
        name
        email
        phone
        totalPrice
        subtotalPrice
        totalTax
        displayFinancialStatus
        displayFulfillmentStatus
        createdAt
        updatedAt
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        customer {
          id
          firstName
          lastName
          email
          phone
        }
        billingAddress {
          firstName
          lastName
          address1
          address2
          city
          province
          zip
          country
          phone
        }
        shippingAddress {
          firstName
          lastName
          address1
          address2
          city
          province
          zip
          country
          phone
        }
        lineItems(first: 50) {
          edges {
            node {
              title
              sku
              quantity
              discountedTotalSet {
                shopMoney {
                  amount
                }
              }
              variant { sku }
            }
          }
        }
      }
    }
  }`

  const data = await graphqlRequest<{ node: any }>(query, { id: `gid://shopify/Order/${shopifyOrderId}` })
  const node = data?.node
  if (!node) return null

  const o = node
  return {
    id: o.id?.replace('gid://shopify/Order/', '') || shopifyOrderId,
    name: o.name || '',
    email: o.email || null,
    phone: o.phone || null,
    totalPrice: o.totalPrice || '0.0',
    subtotalPrice: o.subtotalPrice || '0.0',
    totalTax: o.totalTax || '0.0',
    currency: o.totalPriceSet?.shopMoney?.currencyCode || 'INR',
    financialStatus: o.displayFinancialStatus || '',
    fulfillmentStatus: o.displayFulfillmentStatus || '',
    createdAt: o.createdAt || '',
    updatedAt: o.updatedAt || '',
    customer: o.customer ? {
      id: o.customer.id?.replace('gid://shopify/Customer/', '') || '',
      firstName: o.customer.firstName || '',
      lastName: o.customer.lastName || '',
      email: o.customer.email || '',
      phone: o.customer.phone || '',
    } : undefined,
    billingAddress: o.billingAddress ? {
      firstName: o.billingAddress.firstName || '',
      lastName: o.billingAddress.lastName || '',
      address1: o.billingAddress.address1 || '',
      address2: o.billingAddress.address2 || '',
      city: o.billingAddress.city || '',
      province: o.billingAddress.province || '',
      zip: o.billingAddress.zip || '',
      country: o.billingAddress.country || '',
      phone: o.billingAddress.phone || '',
    } : undefined,
    shippingAddress: o.shippingAddress ? {
      firstName: o.shippingAddress.firstName || '',
      lastName: o.shippingAddress.lastName || '',
      address1: o.shippingAddress.address1 || '',
      address2: o.shippingAddress.address2 || '',
      city: o.shippingAddress.city || '',
      province: o.shippingAddress.province || '',
      zip: o.shippingAddress.zip || '',
      country: o.shippingAddress.country || '',
      phone: o.shippingAddress.phone || '',
    } : undefined,
    lineItems: o.lineItems?.edges?.map((e: any) => ({
      title: e.node.title || '',
      sku: e.node.sku || e.node.variant?.sku || '',
      quantity: e.node.quantity || 0,
      price: e.node.discountedTotalSet?.shopMoney?.amount || '0.0',
      variant: e.node.variant ? { sku: e.node.variant.sku || '' } : undefined,
    })) || [],
  }
}

// ─── Enrich local customers with Shopify data ─────────────────────

export interface EnrichCustomersResult {
  enriched: number
  failed: number
  /** True when the Admin API refuses Customer PII (plan-gated). */
  piiAccessDenied: boolean
  /** Block reasons worth surfacing to the user instead of a silent no-op. */
  errors: string[]
}

const PII_DENIED_MESSAGE =
  'Shopify denies Customer PII over the Admin API (plan-gated) — approve access in the Shopify admin'

export async function enrichCustomersFromShopify(): Promise<EnrichCustomersResult> {
  const client = getRawClient()
  if (!client) return { enriched: 0, failed: 0, piiAccessDenied: false, errors: ['Database not available'] }
  if (isPiiAccessDenied()) {
    logger.debug('Customer enrichment skipped — Shopify PII access not approved yet')
    return { enriched: 0, failed: 0, piiAccessDenied: true, errors: [PII_DENIED_MESSAGE] }
  }

  let enriched = 0
  let failed = 0

  try {
    // Find customers incomplete in ANY enrichable field: missing email or
    // phone — or still named with the "Shopify Customer #<id>" placeholder,
    // which is exactly the row that NEEDS a name/address upgrade even when
    // email and phone already exist (requirement: enrichment works without
    // email/phone being available).
    const incomplete = await client.unsafe(
      `SELECT id, name, email, phone, shopify_id FROM customers
       WHERE shopify_id IS NOT NULL AND shopify_id != ''
         AND (
           email IS NULL OR email = ''
           OR phone IS NULL OR phone = ''
           OR name IS NULL OR name = ''
           OR name LIKE 'Shopify Customer #'
         )
       LIMIT 50`
    )

    for (const cust of incomplete as any[]) {
      try {
        const shopifyData = await fetchCustomerById(cust.shopify_id)
        if (!shopifyData) { failed++; continue }

        const updates: string[] = []
        const values: any[] = []

        // Name upgrade — the core placeholder fix: a real Shopify name
        // replaces "Shopify Customer #<id>" / "Guest" / a blank name, while
        // a real local name is never downgraded.
        const fullName = `${shopifyData.firstName || ''} ${shopifyData.lastName || ''}`.trim()
        const nextName = upgradeName(String(cust.name ?? ''), fullName || null)
        if (nextName && nextName !== String(cust.name ?? '')) {
          updates.push(`name = $${values.length + 1}`)
          values.push(nextName)
        }
        if (!cust.email && shopifyData.email) {
          updates.push(`email = $${values.length + 1}`)
          values.push(shopifyData.email)
        }
        if (!cust.phone && shopifyData.phone) {
          updates.push(`phone = $${values.length + 1}`)
          values.push(shopifyData.phone)
        }
        if (shopifyData.defaultAddress?.city && !cust.city) {
          updates.push(`city = $${values.length + 1}`)
          values.push(shopifyData.defaultAddress.city)
        }
        if (shopifyData.defaultAddress?.province && !cust.province) {
          updates.push(`province = $${values.length + 1}`)
          values.push(shopifyData.defaultAddress.province)
        }

        if (updates.length > 0) {
          values.push(cust.id)
          await client.unsafe(`UPDATE customers SET ${updates.join(', ')} WHERE id = $${values.length}`, values)
          enriched++
          logger.info({ customerId: cust.id, shopifyId: cust.shopify_id }, 'Customer enriched from Shopify')
        }
      } catch (err) {
        logger.error({ err, customerId: cust.id }, 'Customer enrichment failed')
        failed++
      }

      // Rate limit: 500ms between requests
      await new Promise(r => setTimeout(r, 500))
    }
  } catch (err) {
    logger.error({ err }, 'Customer enrichment batch failed')
  }

  const errors: string[] = []
  if (isPiiAccessDenied()) errors.push(PII_DENIED_MESSAGE)
  return { enriched, failed, piiAccessDenied: isPiiAccessDenied(), errors }
}

// ─── Enrich orders with full customer data ────────────────────────

export async function enrichOrdersFromShopify(): Promise<{ enriched: number; failed: number; piiAccessDenied: boolean; errors: string[] }> {
  const client = getRawClient()
  if (!client) return { enriched: 0, failed: 0, piiAccessDenied: false, errors: ['Database not available'] }

  let enriched = 0
  let failed = 0

  if (isPiiAccessDenied()) {
    logger.debug('Order enrichment skipped — Shopify PII access not approved yet')
    return { enriched, failed, piiAccessDenied: true, errors: [PII_DENIED_MESSAGE] }
  }

  try {
    // Find orders missing billing address or with minimal customer data
    const incomplete = await client.unsafe(
      `SELECT id, shopify_id, customer FROM sales_orders
       WHERE (billing_address IS NULL OR billing_address = '{}'::jsonb OR customer IS NULL OR customer = '')
       AND shopify_id IS NOT NULL AND shopify_id != ''
       LIMIT 50`
    )

    for (const order of incomplete as any[]) {
      try {
        // The numeric Shopify order id is stored in the row's id column
        // ("shopify-<numericId>"); shopify_id holds the order name ("#1034").
        const numericId = numericShopifyOrderId(order.id)
        if (!numericId) { failed++; continue }

        const shopifyData = await fetchOrderById(numericId)
        if (!shopifyData) { failed++; continue }

        // Field-by-field merge: locally recovered address values survive a
        // redacted/partial payload, and a whole-null write never blanks them.
        const curBilling = order.billing_address && typeof order.billing_address === 'object' ? order.billing_address as OrderAddress : undefined
        const curShipping = order.shipping_address && typeof order.shipping_address === 'object' ? order.shipping_address as OrderAddress : undefined
        const nextBilling = mergeAddress(curBilling, shopifyData.billingAddress ?? undefined)
        const nextShipping = mergeAddress(curShipping, shopifyData.shippingAddress ?? undefined)

        const updates: string[] = []
        const values: any[] = []
        if (nextBilling) {
          updates.push(`billing_address = $${values.length + 1}`)
          values.push(JSON.stringify(nextBilling))
        }
        if (nextShipping) {
          updates.push(`shipping_address = $${values.length + 1}`)
          values.push(JSON.stringify(nextShipping))
        }

        if (updates.length > 0) {
          values.push(order.id)
          await client.unsafe(`UPDATE sales_orders SET ${updates.join(', ')} WHERE id = $${values.length}`, values)
          enriched++
          logger.info({ orderId: order.id, shopifyNumericId: numericId }, 'Order enriched from Shopify')
        }
      } catch (err) {
        logger.error({ err, orderId: order.id }, 'Order enrichment failed')
        failed++
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 500))
    }
  } catch (err) {
    logger.error({ err }, 'Order enrichment batch failed')
  }

  return { enriched, failed, piiAccessDenied: isPiiAccessDenied(), errors: isPiiAccessDenied() ? [PII_DENIED_MESSAGE] : [] }
}

// ─── Enrich all incomplete orders via GraphQL ─────────────────────

export interface EnrichResult {
  enriched: number
  failed: number
  skipped: number
  errors: string[]
  /** True when the batch was blocked by Shopify's plan-gated Customer PII. */
  piiAccessDenied?: boolean
}

export async function enrichAllIncompleteOrders(): Promise<EnrichResult> {
  const client = getRawClient()
  if (!client) return { enriched: 0, failed: 0, skipped: 0, errors: ['Database not available'] }
  if (isPiiAccessDenied()) {
    return { enriched: 0, failed: 0, skipped: 0, piiAccessDenied: true, errors: ['Shopify PII access not approved — approve in Shopify admin (Protected customer data)'] }
  }

  const result: EnrichResult = { enriched: 0, failed: 0, skipped: 0, errors: [] }

  try {
    // Find orders with incomplete data: missing billing address, Guest customer, or missing shipping address
    const incomplete = await client.unsafe(
      `SELECT id, shopify_id, customer, billing_address, shipping_address
       FROM sales_orders
       WHERE shopify_id IS NOT NULL AND shopify_id != ''
         AND (
           billing_address IS NULL OR billing_address = '{}'::jsonb OR billing_address->>'name' = ''
           OR customer IS NULL OR customer = '' OR customer = 'Guest'
           OR shipping_address IS NULL OR shipping_address = '{}'::jsonb OR shipping_address->>'name' = ''
         )
       ORDER BY date DESC
       LIMIT 100`
    )

    if ((incomplete as any[]).length === 0) {
      return { enriched: 0, failed: 0, skipped: 0, errors: [] }
    }

    logger.info({ count: (incomplete as any[]).length }, 'Starting order enrichment via GraphQL')

    for (const order of incomplete as any[]) {
      try {
        // GraphQL node(id:) needs the NUMERIC order id, which the local row
        // keeps in its id column ("shopify-7660565233727"). shopify_id stores
        // the order NAME ("#1027"); feeding that name into node() resolved to
        // no order at all, so every enrichment run reported "0 enriched,
        // N skipped" and the Guest rows stayed Guest — a silent data loss.
        const shopifyIdNum = numericShopifyOrderId(order.id)
        if (!shopifyIdNum) { result.skipped++; continue }

        // Fetch full order details via GraphQL
        const gqlOrder = await fetchOrderById(shopifyIdNum)
        if (!gqlOrder) {
          result.skipped++
          continue
        }

        const updates: Record<string, any> = {}

        // Update customer name if we have a better one. Placeholder rows
        // ("Shopify Customer #<id>") count as Guest-like: they are the ones
        // that most need the real name once the API can see it.
        const currentName = order.customer || ''
        const candidateName = gqlOrder.customer ? `${gqlOrder.customer.firstName} ${gqlOrder.customer.lastName}`.trim() : ''
        if (candidateName && (currentName === 'Guest' || !currentName || isPlaceholderName(currentName))) {
          updates.customer = candidateName
        }
        if (gqlOrder.email && (currentName === 'Guest' || !currentName || isPlaceholderName(currentName))) {
          const gqlName = candidateName
          if (!gqlName && gqlOrder.email) updates.customer = gqlOrder.email
        }

        // Build billing address — every usable fetched field wins, locally
        // recovered values survive a redacted field, and nothing is written
        // when the merge produces no usable value.
        if (gqlOrder.billingAddress) {
          const existingBilling = order.billing_address && typeof order.billing_address === 'object' ? order.billing_address as OrderAddress : undefined
          const merged = mergeAddress(existingBilling, gqlOrder.billingAddress)
          if (merged) updates.billingAddress = merged
        }

        // Build shipping address
        if (gqlOrder.shippingAddress) {
          const existingShipping = order.shipping_address && typeof order.shipping_address === 'object' ? order.shipping_address as OrderAddress : undefined
          const merged = mergeAddress(existingShipping, gqlOrder.shippingAddress)
          if (merged) updates.shippingAddress = merged
        }

        // Update line items if available
        if (gqlOrder.lineItems?.length) {
          updates.lineItems = gqlOrder.lineItems.map(li => ({
            title: li.title,
            sku: li.sku,
            quantity: li.quantity,
            price: Math.round(Number(li.price) * 100) / 100,
          }))
        }

        if (Object.keys(updates).length === 0) {
          result.skipped++
          continue
        }

        await client.unsafe(
          `UPDATE sales_orders SET
            customer = COALESCE($1, customer),
            billing_address = COALESCE($2::jsonb, billing_address),
            shipping_address = COALESCE($3::jsonb, shipping_address),
            line_items = COALESCE($4::jsonb, line_items)
          WHERE id = $5`,
          [
            updates.customer || null,
            updates.billingAddress ? JSON.stringify(updates.billingAddress) : null,
            updates.shippingAddress ? JSON.stringify(updates.shippingAddress) : null,
            updates.lineItems ? JSON.stringify(updates.lineItems) : null,
            order.id,
          ]
        )
        result.enriched++
        logger.info({ orderId: order.id, shopifyId: order.shopify_id }, 'Order enriched via GraphQL')

        // Also enrich the customer record if we have customer data from the order
        if (gqlOrder.customer?.id) {
          try {
            const gqlCustomer = await fetchCustomerById(gqlOrder.customer.id)
            if (gqlCustomer) {
              const customerEmail = gqlCustomer.email || gqlOrder.email || null
              const customerPhone = gqlCustomer.phone || gqlOrder.phone || null
              const fullName = `${gqlCustomer.firstName} ${gqlCustomer.lastName}`.trim()

              if (customerEmail || customerPhone) {
                // Resolve ONE target row, identity-first: shopify_id, then a
                // case-normalized email, then a digits-normalized phone. The
                // old `WHERE shopify_id = … OR email = … OR phone = …` update
                // could also rewrite unrelated customers sharing an inbox.
                let targetId: string | null = null
                const byShopifyId = await client.unsafe(
                  `SELECT id FROM customers WHERE shopify_id = $1 LIMIT 1`,
                  [gqlOrder.customer.id],
                )
                targetId = (byShopifyId[0] as any)?.id ?? null
                if (!targetId && customerEmail) {
                  const byEmail = await client.unsafe(
                    `SELECT id FROM customers WHERE lower(coalesce(email, '')) = $1 LIMIT 1`,
                    [customerEmail.toLowerCase()],
                  )
                  targetId = (byEmail[0] as any)?.id ?? null
                }
                if (!targetId && customerPhone) {
                  const byPhone = await client.unsafe(
                    `SELECT id FROM customers WHERE regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = $1 LIMIT 1`,
                    [normalizePhone(customerPhone) ?? ''],
                  )
                  targetId = (byPhone[0] as any)?.id ?? null
                }

                if (targetId) {
                  // Fill-only: COALESCE keeps every stored value the API did
                  // not deliver (redactions included).
                  await client.unsafe(
                    `UPDATE customers SET
                      name = CASE
                        WHEN name IS NULL OR name = '' OR name = 'Guest' OR name LIKE 'Shopify Customer #'
                        THEN COALESCE($1, name) ELSE name END,
                      email = COALESCE(NULLIF($2, ''), email),
                      phone = COALESCE(NULLIF($3, ''), phone),
                      city = COALESCE(NULLIF($4, ''), city),
                      province = COALESCE(NULLIF($5, ''), province)
                    WHERE id = $6`,
                    [
                      fullName || null,
                      customerEmail,
                      customerPhone,
                      gqlCustomer.defaultAddress?.city || null,
                      gqlCustomer.defaultAddress?.province || null,
                      targetId,
                    ]
                  )
                }
              }
            }
          } catch {
            // Customer enrichment failure should not block order enrichment
          }
        }

        // Rate limit: 500ms between GraphQL requests
        await new Promise(r => setTimeout(r, 500))
      } catch (err) {
        logger.error({ err, orderId: order.id }, 'Order enrichment failed')
        result.failed++
        result.errors.push(err instanceof Error ? err.message : 'Unknown error')
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    logger.error({ err }, 'Enrichment batch failed')
    result.errors.push(msg)
  }

  logger.info({ enriched: result.enriched, failed: result.failed, skipped: result.skipped }, 'Order enrichment complete')
  if (isPiiAccessDenied()) {
    result.piiAccessDenied = true
    if (!result.errors.includes(PII_DENIED_MESSAGE)) result.errors.push(PII_DENIED_MESSAGE)
  }
  return result
}

// ─── CSV Import ───────────────────────────────────────────────────

export interface CSVImportResult {
  imported: number
  updated: number
  errors: string[]
}

// Shopify exports quote numeric cells with a leading apostrophe (Excel's
// "keep as text" escape) so IDs/phones survive spreadsheet round-trips, e.g.
// '9687511073019 or '+16135550142. Strip those before the value is stored or
// matched, otherwise shopify_id/phone lookups silently miss. Only digits and
// '+' follow the escape in practice, so a genuine leading apostrophe in a
// name (e.g. "'t Hoen") is left untouched.
export const normalizeCell = (v: string): string =>
  v.trim().replace(/^'+(?=[0-9+])/, '').trim()

/**
 * Accepts any Shopify customer identifier form and returns the bare numeric ID:
 * "gid://shopify/Customer/9687511073019" → "9687511073019",
 * "'9687511073019" → "9687511073019", "9687511073019" → unchanged.
 * Any other gid form (Order, Product, …) is not a customer id → "".
 */
export const normalizeShopifyCustomerId = (v: string): string => {
  const s = normalizeCell(v)
  if (s.startsWith('gid://')) {
    return s.startsWith('gid://shopify/Customer/')
      ? s.slice('gid://shopify/Customer/'.length) || ''
      : ''
  }
  return s || ''
}

/**
 * Accepts any Shopify order identifier form and returns the bare numeric ID.
 */
export const normalizeShopifyOrderId = (v: string): string =>
  normalizeCell(v).replace(/^gid:\/\/shopify\/Order\//, '') || ''

const pick = (row: Record<string, string>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = row[k]
    if (typeof v === 'string' && v.trim() !== '') return normalizeCell(v)
  }
  return ''
}

/**
 * Fill the customers table from a Shopify customers CSV export
 * (Shopify Admin → Customers → Export).
 *
 * This is the manual fallback of the PII recovery chain: rows the mailbox
 * never saw and the API cannot return (redacted) are recovered here. A row is
 * matched to an existing customer by shopify_id, then email, then phone; a
 * redacted placeholder ("Shopify Customer #<id>", no email/phone) is UPGRADED
 * in place rather than duplicated.
 */
export async function importCustomersFromCSV(rows: Record<string, string>[]): Promise<CSVImportResult> {
  const client = getRawClient()
  if (!client) return { imported: 0, updated: 0, errors: ['DB unavailable'] }

  const result: CSVImportResult = { imported: 0, updated: 0, errors: [] }

  for (const row of rows) {
    try {
      // Shopify's official export: First Name, Last Name, Email, Phone (1),
      // Accepts Email Marketing, Default Address City…, plus our generic set.
      const first = pick(row, 'First Name', 'first_name', 'firstName')
      const last = pick(row, 'Last Name', 'last_name', 'lastName')
      const name = pick(row, 'Name', 'name') || `${first} ${last}`.trim()
      const email = pick(row, 'Email', 'email') || null
      const phone = pick(row, 'Phone (1)', 'Phone', 'phone', 'mobile', 'Mobile') || null
      const city = pick(row, 'Default Address City', 'Default Address (City)', 'city', 'City') || null
      const province = pick(row, 'Default Address Province', 'Default Address Province Code', 'Default Address (Province)', 'province') || null

      const shopifyId = pick(row, 'Customer ID', 'customer_id', 'shopify_id', 'shopifyId', 'id')
        .replace(/^gid:\/\/shopify\/Customer\//, '') || null

      if (!name && !email) {
        result.errors.push('Row skipped: no name and no email')
        continue
      }

      // Match order: shopify_id (exact), then email, then phone.
      type ExistingCustomer = { id: string; email: string | null; phone: string | null; name: string; city: string | null; province: string | null }
      let existing: ExistingCustomer | undefined
      const findExisting = async (sql: string, param: string): Promise<ExistingCustomer | undefined> => {
        const found = await client.unsafe(sql, [param])
        return found[0] as unknown as ExistingCustomer | undefined
      }
      if (shopifyId) {
        existing = await findExisting(`SELECT id, email, phone, name, city, province FROM customers WHERE shopify_id = $1 LIMIT 1`, shopifyId)
      }
      if (!existing && email) {
        // Case-normalized: "Foo@Bar.com" in the CSV must match "foo@bar.com"
        // on file, or the import creates a duplicate customer.
        existing = await findExisting(`SELECT id, email, phone, name, city, province FROM customers WHERE lower(coalesce(email, '')) = lower($1) LIMIT 1`, email)
      }
      if (!existing && phone) {
        existing = await findExisting(`SELECT id, email, phone, name, city, province FROM customers WHERE phone = $1 LIMIT 1`, phone)
        if (!existing) {
          // Digits-normalized: "+91 98765 43210" must match "9876543210".
          existing = await findExisting(`SELECT id, email, phone, name, city, province FROM customers WHERE regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = $1 LIMIT 1`, normalizePhone(phone) ?? '')
        }
      }
      // Placeholder rows are named "Shopify Customer #<id>" and carry the id —
      // match them so the CSV UPGRADES the placeholder instead of duplicating it.
      if (!existing && shopifyId) {
        existing = await findExisting(`SELECT id, email, phone, name, city, province FROM customers WHERE name = $1 LIMIT 1`, `Shopify Customer #${shopifyId}`)
      }
      // Shopify's customer export has NO Customer ID column. Resolve one from
      // our own orders: a matching order row carries customer_shopify_id from
      // the API sync, and it belongs to the customer with this email/phone.
      let resolvedShopifyId: string | null = shopifyId
      if (!resolvedShopifyId && (email || phone)) {
        const cond = email ? `customer_email = $1` : `customer_phone = $1`
        const param = email ?? phone
        const found = await client.unsafe(
          `SELECT customer_shopify_id AS id FROM sales_orders
           WHERE ${cond} AND customer_shopify_id IS NOT NULL AND customer_shopify_id != ''
           LIMIT 1`,
          [param],
        )
        resolvedShopifyId = normalizeShopifyCustomerId((found[0] as any)?.id ?? '') || null
      }
      const finalShopifyId = resolvedShopifyId
      // A row resolved through orders can now reach its redacted placeholder
      // (the placeholder carries the shopify_id even though it has no email).
      if (!existing && finalShopifyId) {
        existing = await findExisting(`SELECT id, email, phone, name, city, province FROM customers WHERE shopify_id = $1 LIMIT 1`, finalShopifyId)
      }

      if (existing) {
        const updates: string[] = []
        const values: any[] = []
        const setIf = (col: string, v: string | null, current: string | null) => {
          if (v && !(current && String(current).trim() !== '')) {
            updates.push(`${col} = $${values.length + 1}`)
            values.push(v)
          }
        }
        // Only fill blanks — never overwrite data the ERP already has. The
        // primary target is the redacted placeholder: empty email/phone/name.
        setIf('email', email, existing.email)
        setIf('phone', phone, existing.phone)
        // A placeholder row is upgradeable to ANY usable name (including a
        // "Name" column-less "First Last" row); a real name never moves.
        setIf('name', name, isPlaceholderName(existing.name) ? null : existing.name)
        setIf('city', city, existing.city)
        setIf('province', province, existing.province)
        // Only stamp the resolved Shopify id when the row does not have one.
        if (finalShopifyId) {
          updates.push(`shopify_id = COALESCE(shopify_id, $${values.length + 1})`)
          values.push(finalShopifyId)
        }
        if (updates.length > 0) {
          values.push(existing.id)
          await client.unsafe(`UPDATE customers SET ${updates.join(', ')} WHERE id = $${values.length}`, values)
          result.updated++
        }
      } else {
        const id = `cust-csv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        await client.unsafe(
          `INSERT INTO customers (id, name, email, phone, city, province, shopify_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, name || email || 'Unknown', email, phone, city, province, finalShopifyId],
        )
        result.imported++
      }
    } catch (err) {
      result.errors.push(`Row error: ${err instanceof Error ? err.message : 'Unknown'}`)
    }
  }

  return result
}

export async function importOrdersFromCSV(rows: Record<string, string>[]): Promise<CSVImportResult> {
  const client = getRawClient()
  if (!client) return { imported: 0, updated: 0, errors: ['DB unavailable'] }

  const result: CSVImportResult = { imported: 0, updated: 0, errors: [] }

  for (const row of rows) {
    try {
      // Shopify orders export: Name (order number), Email, Phone, Billing/Shipping
      // Address blocks, Financial Status, Total, Created at, plus generic keys.
      const orderNumberRaw = pick(row, 'Name', 'name', 'order_number', 'Order Number', 'invoice', 'Invoice')
      const orderNumber = orderNumberRaw.replace(/^#*/, '')
      const customerName = pick(row, 'Customer', 'customer', 'Billing Address Name', 'Shipping Address Name')
      const email = pick(row, 'Email', 'email') || null
      const phone = pick(row, 'Phone', 'phone', 'Billing Address Phone', 'Shipping Address Phone') || null
      const total = pick(row, 'Total', 'total', 'Grand Total', 'grand_total') || '0'
      const dateRaw = pick(row, 'Created at', 'created_at', 'date', 'Date')
      const date = dateRaw || new Date().toISOString()
      const status = pick(row, 'Financial Status', 'status', 'Status') || 'confirmed'
      const shopifyCustomerId = pick(row, 'Customer ID', 'customer_id')
        .replace(/^gid:\/\/shopify\/Customer\//, '') || null

      if (!orderNumber) {
        result.errors.push(`Row skipped: no order number`)
        continue
      }

      const shopifyId = `#${orderNumber}`
      const existing = await client.unsafe(`SELECT id FROM sales_orders WHERE shopify_id = $1 LIMIT 1`, [shopifyId])

      if (existing.length > 0) {
        // Fill only what the existing row is missing (e.g. redacted PII).
        const updates: string[] = []
        const values: any[] = []
        const setIf = (col: string, v: string | null) => {
          if (v) { updates.push(`${col} = $${values.length + 1}`); values.push(v) }
        }
        setIf('customer_email', email)
        setIf('customer_phone', phone)
        setIf('customer', customerName || null)
        if (shopifyCustomerId) setIf('customer_shopify_id', shopifyCustomerId)
        if (updates.length > 0) {
          values.push(existing[0].id)
          await client.unsafe(`UPDATE sales_orders SET ${updates.join(', ')} WHERE id = $${values.length}`, values)
          result.updated++
        }
      } else {
        const id = `ord-csv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        await client.unsafe(
          `INSERT INTO sales_orders (id, shopify_id, internal_id, customer, customer_shopify_id, customer_email, customer_phone, value, status, date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, shopifyId, `SO-${orderNumber}`, customerName || 'Unknown', shopifyCustomerId, email, phone, parseFloat(total) || 0, status, date],
        )
        result.imported++
      }
    } catch (err) {
      result.errors.push(`Row error: ${err instanceof Error ? err.message : 'Unknown'}`)
    }
  }

  return result
}
/**
 * Count customers that still have no email AND no phone on file.
 *
 * Used by the PII recovery chain: after the mailbox poll and the Admin API
 * enrichment retry have both run, this is the size of the residue that only
 * the manual Shopify customers CSV export can fill (the API cannot return
 * redacted PII, and there is no email for rows the mailbox never saw).
 */
export async function missingPiiCustomerCount(): Promise<number> {
  const client = getRawClient()
  if (!client) return 0
  try {
    const rows = await client.unsafe(
      `SELECT count(*)::int AS n FROM customers
       WHERE (email IS NULL OR email = '') AND (phone IS NULL OR phone = '')`,
    )
    return Number((rows[0] as any)?.n ?? 0)
  } catch {
    return 0
  }
}
