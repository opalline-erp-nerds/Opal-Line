import 'dotenv/config'
import { ImapFlow } from 'imapflow'
import { simpleParser, type ParsedMail } from 'mailparser'
import { and, eq, or, sql } from 'drizzle-orm'
import { db } from './db/client'
import * as schema from './db/schema'
import { invoiceTotals } from './invoiceTotals'
import { buildManualInvoiceLines } from './orderPricing'
import { computeShopifyInvoiceAmounts } from './shopifyInvoiceAmounts'
import { getLatestSilverRate } from './shopify'
import { decryptSecret } from './lib/crypto'
import { recountCustomerStatsBoth } from './customerStats'
import { upgradeName } from './shopifyCustomerData'
import { applyStockMovement, assertStockAvailable, InsufficientStockError, resolveMovementLocation, resolveStockSku, type Tx } from './stock'
import { ensureInvoiceSideEffects } from './invoiceSideEffects'
import { logger } from './logger'

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * Shopify Order Email Ingestion
 * ─────────────────────────────
 * Shopify's API/webhook responses can be redacted (Protected Customer Data on
 * dev/preview apps) but the store-owner "New Order" notification email is NOT
 * redacted — it always contains the full customer name, phone, email and
 * billing/shipping address.
 *
 * This module polls a dedicated IMAP mailbox, finds "New order" emails,
 * parses the customer data and merges it into sales_orders (matching by
 * Shopify order number). It can also create the order if the webhook missed it.
 *
 * Setup:
 *   1. Shopify Admin → Settings → Notifications → staff order notification →
 *      set to ORDER_EMAIL_ADDRESS (a dedicated mailbox, e.g. orders@…)
 *   2. Gmail: enable 2FA, create an App Password, enable IMAP.
 *   3. backend/.env:
 *        ORDER_EMAIL_ADDRESS=orders@yourdomain.com
 *        ORDER_EMAIL_PASSWORD=xxxx-xxxx-xxxx-xxxx   (Gmail app password, encrypted)
 *        ORDER_EMAIL_HOST=imap.gmail.com
 *        ORDER_EMAIL_PORT=993
 *        ORDER_EMAIL_FOLDER=INBOX
 */

const POLL_INTERVAL_MS = 2 * 60 * 1000
const LOOKBACK_DAYS = 7
let pollTimer: NodeJS.Timeout | null = null
let running = false

export interface OrderEmailData {
  orderNumber: string
  customerName: string
  email: string
  phone: string
  billing: {
    name?: string
    address1?: string
    address2?: string
    city?: string
    province?: string
    zip?: string
    country?: string
    phone?: string
  } | null
  shipping: {
    name?: string
    address1?: string
    address2?: string
    city?: string
    province?: string
    zip?: string
    country?: string
    phone?: string
  } | null
  total: number
  items: Array<{
    title: string
    sku: string
    quantity: number
    price: number
    // ERP pricing fields (for manual orders)
    weight?: number
    silverRate?: number
    makingCharge?: number
    silverValue?: number
    makingValue?: number
    amount?: number
    variantId?: string | null
    priceAdjustment?: number | null
  }>
  paymentMethod: string
  date: string
}

export function isEmailIngestConfigured(): boolean {
  const user = process.env.ORDER_EMAIL_ADDRESS?.trim()
  const pass = process.env.ORDER_EMAIL_PASSWORD?.trim()
  return Boolean(user && pass)
}

export interface MailboxTestResult {
  ok: boolean
  provider: 'imap' | 'mailtm'
  mailbox: string | null
  host?: string
  folder?: string
  messageCount?: number
  error?: string
}

/** Verify the order-ingest mailbox credentials work — logs in without scanning. */
export async function testEmailIngestConnection(): Promise<MailboxTestResult> {
  const cfg = emailConfig()
  const provider = emailProvider()
  if (!cfg.user || !cfg.pass) {
    return { ok: false, provider, mailbox: null, error: 'Not configured — set ORDER_EMAIL_ADDRESS and ORDER_EMAIL_PASSWORD' }
  }
  if (provider === 'mailtm') {
    try {
      await mailtmToken(cfg.user, cfg.pass)
      return { ok: true, provider, mailbox: cfg.user }
    } catch (err) {
      return { ok: false, provider, mailbox: cfg.user, error: err instanceof Error ? err.message : 'mail.tm login failed' }
    }
  }
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    emitLogs: false,
  })
  // Transient socket errors must not surface as uncaughtException — the
  // connection test reports failure through its return value instead.
  client.on('error', () => {})
  try {
    await client.connect()
    const box = await client.mailboxOpen(cfg.folder)
    const messageCount = typeof box.exists === 'number' ? box.exists : undefined
    await client.logout()
    return { ok: true, provider, mailbox: cfg.user, host: cfg.host, folder: cfg.folder, messageCount }
  } catch (err) {
    try { client.close() } catch { /* already closed */ }
    return { ok: false, provider, mailbox: cfg.user, host: cfg.host, folder: cfg.folder, error: err instanceof Error ? err.message : 'IMAP login failed' }
  }
}

/** Which mailbox protocol to use: IMAP (Gmail etc.) or mail.tm REST API. */
function emailProvider(): 'imap' | 'mailtm' {
  const p = process.env.ORDER_EMAIL_PROVIDER?.trim().toLowerCase()
  if (p === 'mailtm' || p === 'mail.tm') return 'mailtm'
  if (p === 'imap') return 'imap'
  // Auto-detect: mail.tm domains end in .tm-hosted domains like uberip.com;
  // default to IMAP otherwise.
  const host = process.env.ORDER_EMAIL_HOST?.trim().toLowerCase() ?? ''
  if (host.includes('mail.tm')) return 'mailtm'
  return 'imap'
}

// ─── Email text parsing helpers ─────────────────────────────────────

const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
const cleanLines = (v: unknown): string[] =>
  typeof v === 'string'
    ? v
        .split('\n')
        .map((l) => l.trim())
        // Drop empty lines and dash/underscore separator rules — Gmail renders
        // CSS rules as dashes and templates use them as visual separators;
        // either way they must never be mistaken for values.
        .filter((l) => l && !/^[-=_*.\s]+$/.test(l))
    : []

// "Order #1042" / "New order #1042" / "Dev store order #1042" — capture digits.
const ORDER_NUM_RE = /#(\d{3,})/
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/
const PHONE_RE = /(\+?\d[\d\s\-()]{7,}\d)/

/** Subject like "New order #1042" or "Dev store order #1042". */
export function parseOrderNumberFromSubject(subject: string): string | null {
  const m = subject.match(ORDER_NUM_RE)
  return m ? m[1] : null
}

/**
 * Parse the plain-text part of a Shopify "New order" notification email.
 * Shopify templates include a "Customer" block with contact info and a
 * billing/shipping address block. This uses labeled line matching so it
 * survives minor template changes.
 */
export function parseOrderEmailText(text: string, subject: string): OrderEmailData | null {
  const orderNumber = parseOrderNumberFromSubject(subject)
  if (!orderNumber) return null

  // Strip URLs before scanning — Shopify "View order" links contain long digit
  // runs (order IDs) that would otherwise be mistaken for phone numbers.
  const textNoUrls = text.replace(/https?:\/\/\S+/g, ' ')
  const lines = cleanLines(textNoUrls)
  const lower = lines.map((l) => l.toLowerCase())

  const lineAfter = (labelRe: RegExp): string => {
    const idx = lower.findIndex((l) => labelRe.test(l))
    return idx >= 0 && idx + 1 < lines.length ? clean(lines[idx + 1]) : ''
  }

  // Customer name: line after "Customer" label (skip the order-number line itself).
  // HTML→text conversion wraps names across lines ("Karthik" / "Subramanian"),
  // so absorb consecutive single-word alpha fragments after the first line.
  let customerName = ''
  const custIdx = lower.findIndex((l) => /^customer\b/.test(l))
  if (custIdx >= 0) {
    const parts: string[] = []
    for (let i = custIdx + 1; i < Math.min(custIdx + 8, lines.length); i++) {
      const v = clean(lines[i])
      if (!v || ORDER_NUM_RE.test(v) || /^[-=_*.\s]+$/.test(v)) continue
      if (EMAIL_RE.test(v) || PHONE_RE.test(v)) break
      if (parts.length > 0 && (!/^[A-Za-z][A-Za-z.'-]*$/.test(v) || /^(email|phone|payment|billing|shipping|customer|note|order)\b/i.test(v))) break
      parts.push(v)
      if (parts.length >= 3) break
    }
    customerName = clean(parts.join(' '))
  }
  // Customer name: "placed by <Name>" in the subject (Shopify staff notification)
  if (!customerName) {
    const m = subject.match(/placed by\s+(.+?)\s*(?:\(|$)/i)
    if (m) customerName = clean(m[1])
  }
  // Body: "Priya Raghavan placed order #1035 on Sep 10 ..."
  if (!customerName) {
    for (const l of lines) {
      const m = l.match(/^([A-Za-z][\w'.&-]*(?:\s+[A-Za-z][\w'.&-]*){0,4})\s+placed order\b/)
      if (m) { customerName = clean(m[1]); break }
    }
  }
  // Last resort: the line after the "Shipping address" label. Careful: that is
  // a LABEL, not a name — if the value is a known section header (or itself the
  // label line), keep the fallback empty rather than inventing a customer
  // called "Shipping address" (seen live on order #1052).
  if (!customerName) {
    const fallback = lineAfter(/^(shipping|billing) address/)
    const isLabel = /^(shipping|billing|customer|email|phone|payment|note|order)\b/i.test(fallback)
    if (fallback && !isLabel) customerName = fallback
  }

  // Email: prefer a labeled "Email:" line, fall back to first address in body
  let email = ''
  const emailLblIdx = lower.findIndex((l) => /^email(?: address)?:/.test(l) || /^email$/.test(l))
  if (emailLblIdx >= 0) {
    const inline = lines[emailLblIdx].split(/:\s*(.+)$/)[1]
    const v = clean(inline || (lines[emailLblIdx + 1] ?? ''))
    const m = v.match(EMAIL_RE)
    if (m) email = m[0]
  }
  if (!email) {
    const m = textNoUrls.match(EMAIL_RE)
    if (m) email = m[0]
  }
  if (email) email = email.replace(/\.+$/, '') // strip trailing sentence period

  let phone = ''
  const phoneIdx = lower.findIndex((l) => /^(phone|phone number|contact number):?\s*$/.test(l))
  if (phoneIdx >= 0) {
    const inline = lines[phoneIdx].split(/:\s*(.+)$/)[1]
    phone = clean(inline || (lines[phoneIdx + 1] ?? ''))
  }
  if (!phone) {
    const allPhones = textNoUrls.match(new RegExp(PHONE_RE.source, 'g')) ?? []
    phone = clean(allPhones.find((p) => {
      const digits = p.replace(/\D/g, '')
      return digits.length >= 10 && digits.length <= 13
    }) ?? '')
  }

  // Address block: prefer Shipping Address, fall back to Billing Address.
  // Supports "Shipping address" / "Shipping address:" / "Shipping:" label forms.
  const parseAddr = (startRe: RegExp): OrderEmailData['shipping'] => {
    const start = lower.findIndex((l) => startRe.test(l))
    if (start < 0) return null
    const fields: { name?: string; address1?: string; address2?: string; city?: string; province?: string; zip?: string; country?: string; phone?: string } = {}
    const raw: string[] = []
    let zip = ''
    // Inline value on the label line itself ("Shipping: 48 Lake View Road")
    const labelLine = lines[start]
    if (labelLine.includes(':')) {
      const inlineVal = clean(labelLine.split(/:(.+)$/)[1] ?? '')
      if (inlineVal) raw.push(inlineVal)
    }
    let k = start + 1
    while (k < lines.length && k < start + 14) {
      const l = lines[k]
      const ll = lower[k]
      if (/^(billing address|shipping address|customer|payment method|payment|gateway|note|items?|email|phone).*$/.test(ll) && !PHONE_RE.test(l)) break
      if (EMAIL_RE.test(l)) break
      // Shopify mail footer — never part of the customer's address
      if (/^shopify$/i.test(l) || /ottawa/i.test(l)) break
      if (PHONE_RE.test(l) && !fields.phone) {
        fields.phone = clean(l.replace(/^phone\s*:\s*/i, ''))
        k++
        continue
      }
      const zipM = l.match(/^(\d{5,6})\b/)
      if (zipM) {
        zip = zipM[1]
        k++
        continue
      }
      // Compressed single-line form: "Thane, Maharashtra 400607" (city, province+zip)
      const tailZip = l.match(/,\s*([A-Za-z\s.]+?)\s+(\d{5,6})\s*$/)
      if (tailZip) {
        raw.push(l.replace(/,\s*[A-Za-z\s.]+?\s+\d{5,6}\s*$/, ''))
        raw.push(tailZip[1])
        zip = tailZip[2]
        k++
        continue
      }
      raw.push(l.replace(/,+$/, ''))
      k++
    }
    if (zip) {
      // Shopify's canonical layout: name, street…, city, province, <zip>, country.
      // A wordy line after the zip is the country.
      if (raw.length > 0 && /^[A-Za-z\s.'-]+$/.test(raw[raw.length - 1])) {
        fields.country = raw.pop()!
      }
      const before = raw
      // Names wrap across lines ("Karthik" / "Subramanian") — rejoin when the
      // first two lines match the known customer name from the Contact section.
      if (before.length >= 2 && customerName && !before[0].includes(' ')) {
        const joined = `${before[0]} ${before[1]}`
        if (joined.toLowerCase() === customerName.toLowerCase()) before.splice(0, 2, joined)
      }
      if (before.length >= 4) {
        fields.name = before[0]
        fields.address1 = before[1]
        const mid = before.slice(2, before.length - 2)
        if (mid.length) fields.address2 = mid.join(', ')
        fields.city = before[before.length - 2]
        fields.province = before[before.length - 1]
      } else if (before.length === 3) {
        fields.name = before[0]
        fields.address1 = before[1]
        fields.city = before[2]
      } else if (before.length === 2) {
        fields.name = before[0]
        fields.city = before[1]
      } else if (before.length === 1) {
        fields.name = before[0]
      }
      fields.zip = zip
    } else {
      if (raw.length > 0) fields.name = raw.shift()
      if (raw.length > 0) fields.address1 = raw.shift()
      if (raw.length > 0) fields.address2 = raw.join(', ')
    }
    return Object.values(fields).some(Boolean) ? fields : null
  }

  const shipping = parseAddr(/^shipping address/i) ?? parseAddr(/^shipping:/i) ?? parseAddr(/^billing address/i) ?? parseAddr(/^billing:/i)
  let billing = parseAddr(/^billing address/i) ?? parseAddr(/^billing:/i) ?? shipping
  // "Billing address\nSame as shipping address" — resolve to the real shipping block
  if (billing && shipping && !billing.address1 && !billing.phone && !billing.address2 && /same as shipping/i.test(billing.name ?? '')) {
    billing = shipping
  }

  // Items table (plain text): "1 × Silver Bangles 925 ₹3,200.00" variants
  const items: OrderEmailData['items'] = []
  const itemRe = /^\s*(\d+)\s*[×x]\s*(.+?)\s+(?:₹|Rs\.?|INR)?\s*([\d,]+(?:\.\d+)?)\s*$/
  // Shopify staff-email format: title line, then "Rs. 2,499.00 × 1"
  const qtyAfterRe = /^\s*(?:₹|Rs\.?|INR)?\s*([\d,]+(?:\.\d+)?)\s*×\s*(\d+)\s*$/
  const seenItems = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const m = l.match(itemRe)
    if (m) {
      const key = `${m[2]}|${m[1]}|${m[3]}`
      if (seenItems.has(key)) continue
      seenItems.add(key)
      items.push({
        title: clean(m[2]),
        sku: '',
        quantity: Math.max(0, parseInt(m[1], 10) || 0),
        price: Math.round(Number(m[3].replace(/,/g, '')) * 100) / 100,
      })
      continue
    }
    const q = l.match(qtyAfterRe)
    if (q && i > 0) {
      // mailparser's text conversion can split the price across lines
      // ("Rs." alone, then "1,299.00 × 1"), so walk back over currency-only
      // and bare-amount lines to find the real item title.
      const parts: string[] = []
      let j = i - 1
      while (j >= 0 && parts.length < 3) {
        const prev = lines[j]
        if (!prev) break
        if (/^(subtotal|shipping|total|tax|order summary|contact information|payment method|customer|email|phone)\b/i.test(prev)) break
        if (/^(?:₹|Rs\.?|INR)$/i.test(prev)) { j--; continue } // currency prefix — belongs to the price, not the title
        if (/^[\d,]+(?:\.\d+)?$/.test(prev)) { j--; continue } // bare amount wrapped onto its own line
        if (/^SKU/i.test(prev)) break
        if (/^[\d₹]/.test(prev)) break
        // Title fragments wrap across lines ("Silver" / "Stud Earrings") —
        // absorb consecutive alphabetic fragments after the first one.
        if (parts.length > 0 && !/^[A-Za-z][A-Za-z\s.&'-]*$/.test(prev)) break
        parts.unshift(prev)
        j--
      }
      const title = clean(parts.join(' '))
      if (!title) continue
      const key = `${title}|${q[2]}|${q[1]}`
      if (seenItems.has(key)) continue
      seenItems.add(key)
      const item = {
        title,
        sku: '',
        quantity: Math.max(0, parseInt(q[2], 10) || 0),
        price: Math.round(Number(q[1].replace(/,/g, '')) * 100) / 100,
      }
      // Attach SKU if it appears just below the price line ("SKU: X" or
      // "SKU:" with the value wrapped onto the next line)
      for (let k = i + 1; k <= Math.min(i + 3, lines.length - 1); k++) {
        const sk = lines[k].match(/^SKU:\s*(.+)$/i)
        if (sk && sk[1]) { item.sku = clean(sk[1]); break }
        if (/^SKU:?$/i.test(lines[k])) { item.sku = clean(lines[k + 1] ?? ''); break }
        if (lines[k] && !/^Rs/i.test(lines[k]) && !/^[\d,]/.test(lines[k])) break
      }
      items.push(item)
    }
  }

  // Totals
  let total = 0
  const totalLine = [...lines].reverse().find((l) => /^total\b/i.test(l))
  if (totalLine) {
    const m = totalLine.match(/([\d,]+(?:\.\d+)?)/)
    if (m) total = Math.round(Number(m[1].replace(/,/g, '')) * 100) / 100
  }
  if (!total) {
    const rsTotal = text.match(/(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)/g)
    if (rsTotal && rsTotal.length > 0) {
      const last = rsTotal[rsTotal.length - 1]
      const m = last.match(/([\d,]+(?:\.\d+)?)/)
      if (m) total = Math.round(Number(m[1].replace(/,/g, '')) * 100) / 100
    }
  }

  // Payment method: line after "Payment method" label (or inline after colon)
  let paymentMethod = ''
  const payIdx = lower.findIndex((l) => /^(payment method|payment processing method|payment|gateway):?\s*$/.test(l))
  if (payIdx >= 0) {
    const inline = lines[payIdx].split(/:\s*(.+)$/)[1]
    paymentMethod = clean(inline || (lines[payIdx + 1] ?? ''))
  }

  const date = new Date().toISOString()
  if (!customerName && !email && !phone && !shipping && !billing) return null

  return {
    orderNumber,
    customerName: customerName || 'Guest',
    email,
    phone,
    billing,
    shipping,
    total,
    items,
    paymentMethod,
    date,
  }
}

/**
 * Parse from a full parsed email (html or text). Tries text first, then strips
 * tags from html as a fallback so rich-only templates still work.
 */
export function parseOrderEmail(mail: ParsedMail): OrderEmailData | null {
  const subject = clean(mail.subject)
  if (!parseOrderNumberFromSubject(subject)) return null
  let result: OrderEmailData | null = null
  if (mail.text) {
    result = parseOrderEmailText(mail.text, subject)
  }
  if (!result && mail.html) {
    const html = typeof mail.html === 'string' ? mail.html : false
    if (html) {
      // Shopify staff notifications end with a footer (class="no-print")
      // carrying Shopify's own Ottawa address — cut everything after it so it
      // can never leak into a parsed address block.
      const cut = html.search(/class="no-print"|<footer/i)
      const body = cut >= 0 ? html.slice(0, cut) : html
      const text = body
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|td|th|h\d)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&#8377;|&rsquo;/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
      result = parseOrderEmailText(text, subject)
    }
  }
  // Prefer the email's own date over parse time
  if (result && mail.date) {
    const d = new Date(mail.date)
    if (!Number.isNaN(d.getTime())) result.date = d.toISOString()
  }
  return result
}

// ─── DB merge ───────────────────────────────────────────────────────

function normalizePayment(raw: string): string {
  const v = raw.toLowerCase()
  if (/cod|cash/.test(v)) return 'cod'
  if (/online|upi|card|razorpay|payu|paytm/.test(v)) return 'online'
  if (/bank|neft|imps|rtgs/.test(v)) return 'bank'
  return 'paid'
}

/**
 * Find the redacted placeholder customer row that belongs to a Shopify order.
 *
 * Dev/preview stores receive "Shopify Customer #9687733207291" rows with no
 * email or phone (Protected Customer Data). When the order-notification email
 * later delivers the real PII, this links the two so the email fills the
 * EXISTING customer instead of creating a near-duplicate row. The placeholder
 * id convention ("C-shop-<id>") and name convention ("Shopify Customer #<id>")
 * come from shopify.ts's customer import.
 */
export async function findRedactedCustomerForOrder(orderNumber: string): Promise<string | null> {
  if (!db) return null
  // 1. Direct link: the order row stores the customer's Shopify numeric id
  //    (sales_orders.customer_shopify_id, written by the API order sync).
  const [order] = await db
    .select({ customerShopifyId: schema.salesOrders.customerShopifyId })
    .from(schema.salesOrders)
    .where(eq(schema.salesOrders.shopifyId, `#${orderNumber}`))
    .limit(1)
  const linkedShopifyId = order?.customerShopifyId
  if (linkedShopifyId) {
    const [c] = await db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.shopifyId, linkedShopifyId))
      .limit(1)
    if (c) return c.id
  }
  // 2. Legacy fallback: the order row's customer field names the placeholder
  //    row directly ("Shopify Customer #<numeric id>").
  const [orderDetail] = await db
    .select({ customer: schema.salesOrders.customer })
    .from(schema.salesOrders)
    .where(eq(schema.salesOrders.shopifyId, `#${orderNumber}`))
    .limit(1)
  const orderCustomer = orderDetail?.customer ?? ''
  if (/^Shopify Customer #\d+$/.test(orderCustomer)) {
    const [c] = await db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.name, orderCustomer))
      .limit(1)
    if (c) return c.id
  }
  return null
}

/**
 * Ensure a customer record exists for the parsed order data.
 * Identity keys only (email/phone) — never name — so distinct customers with
 * the same name are not merged. Stats are derived afterwards via recount.
 *
 * Priority order when the email carries PII:
 *   1. the redacted placeholder row linked to this order (upgrade it),
 *   2. an existing customer matching by email or phone,
 *   3. create a new customer row.
 */
async function ensureCustomerFromEmail(d: OrderEmailData): Promise<void> {
  if (!db) return
  const email = d.email || null
  const phone = d.phone || null
  if (!email && !phone) return
  const city = d.billing?.city || d.shipping?.city || null
  const province = d.billing?.province || d.shipping?.province || null
  const realName = d.customerName && d.customerName !== 'Guest' ? d.customerName : undefined

  // 1. Prefer the redacted placeholder already linked to this order — filling
  //    it prevents a duplicate "real" customer coexisting with the placeholder.
  const placeholderId = await findRedactedCustomerForOrder(d.orderNumber)
  if (placeholderId) {
    await db
      .update(schema.customers)
      .set({
        ...(realName ? { name: realName } : {}),
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
        ...(city ? { city } : {}),
        ...(province ? { province } : {}),
      })
      .where(eq(schema.customers.id, placeholderId))
    return
  }

  // 2. Identity match by email or phone.
  const identityConditions = []
  if (email) identityConditions.push(eq(schema.customers.email, email))
  if (phone) identityConditions.push(eq(schema.customers.phone, phone))
  const [existing] = await db.select().from(schema.customers).where(or(...identityConditions)).limit(1)
  if (existing) {
    await db
      .update(schema.customers)
      .set({
        // Same rule as the API sync: a real name replaces a placeholder
        // ("Shopify Customer #<id>") / Guest / blank, but never a real name
        // — an email-parsed pseudo-name must not clobber it.
        name: realName ? upgradeName(existing.name, realName) : undefined,
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
        ...(city ? { city } : {}),
        ...(province ? { province } : {}),
      })
      .where(eq(schema.customers.id, existing.id))
    return
  }
  await db
    .insert(schema.customers)
    .values({
      id: `email-cust-${d.orderNumber}-${Date.now()}`,
      name: d.customerName || 'Guest',
      email,
      phone,
      city,
      province,
      orders: 0,
      totalSpent: 0,
      status: 'active',
      joined: new Date().toISOString().slice(0, 10),
    })
    .onConflictDoNothing()
}

/** Merge parsed email data into sales_orders, creating the order if missing. */
export async function mergeOrderData(d: OrderEmailData): Promise<{ updated: boolean; created: boolean }> {
  if (!db) throw new Error('Database is not configured')
  const shopifyId = `#${d.orderNumber}`
  const billingAddress = d.billing ?? undefined
  const shippingAddress = d.shipping ?? undefined

  // Always sync the customer into the customers table first — even when the
  // order row already exists and is complete, the customer record itself may
  // be missing (e.g. order arrived via webhook before any customer sync).
  await ensureCustomerFromEmail(d)

  const [existing] = await db
    .select({ id: schema.salesOrders.id, customer: schema.salesOrders.customer, billingAddress: schema.salesOrders.billingAddress, shippingAddress: schema.salesOrders.shippingAddress, lineItems: schema.salesOrders.lineItems, customerEmail: schema.salesOrders.customerEmail, customerPhone: schema.salesOrders.customerPhone })
    .from(schema.salesOrders)
    .where(eq(schema.salesOrders.shopifyId, shopifyId))
    .limit(1)

  if (existing) {
    const curAddr = (existing.billingAddress ?? {}) as Record<string, unknown>
    const curShip = (existing.shippingAddress ?? {}) as Record<string, unknown>
    const hasRealAddr = Boolean(
      (curAddr && typeof curAddr === 'object' && (curAddr.address1 || curAddr.phone)) ||
      (curShip && typeof curShip === 'object' && (curShip.address1 || curShip.phone)),
    )
    const guestish = !existing.customer || existing.customer === 'Guest' || existing.customer === ''
    const needAddr = !hasRealAddr && Boolean(billingAddress || shippingAddress)
    if (!guestish && hasRealAddr) {
      return { updated: false, created: false } // already complete
    }
    const newAddr = needAddr ? (billingAddress ?? shippingAddress) : undefined
    const newShipAddr = needAddr && billingAddress && shippingAddress ? shippingAddress : undefined
    const newCustomer = d.customerName && d.customerName !== 'Guest' ? d.customerName : undefined
    const newTotal = d.total > 0 ? d.total : undefined
    // Union line items across emails — the same order arrives via both the
    // staff notification and the customer confirmation, often with different
    // subsets parsed; never lose an already-parsed item.
    const prevItems = Array.isArray(existing.lineItems) ? (existing.lineItems as OrderEmailData['items']) : []
    const mergedItems = [...prevItems]
    for (const it of d.items) {
      const key = `${it.title}|${it.quantity}|${it.price}`
      if (!mergedItems.some((p) => `${p.title}|${p.quantity}|${p.price}` === key)) mergedItems.push(it)
    }
    const newLineItems = mergedItems.length > prevItems.length ? mergedItems : undefined
    const newItems = newLineItems ? mergedItems.reduce((s, i) => s + i.quantity, 0) : undefined
    // Backfill contact PII the API could not provide (redacted) — the order
    // notification email always carries it.
    const newEmail = !existing.customerEmail && d.email ? d.email : undefined
    const newPhone = !existing.customerPhone && d.phone ? d.phone : undefined
    if (!newAddr && !newCustomer && !newTotal && !newLineItems && !newEmail && !newPhone) {
      return { updated: false, created: false } // nothing meaningful to add
    }
    await db
      .update(schema.salesOrders)
      .set({
        customer: newCustomer,
        value: newTotal,
        items: newItems,
        lineItems: newLineItems,
        billingAddress: newAddr,
        shippingAddress: newShipAddr,
        customerEmail: newEmail,
        customerPhone: newPhone,
      })
      .where(eq(schema.salesOrders.shopifyId, shopifyId))
    return { updated: true, created: false }
  }

  // Create the order if webhook missed it
  await db
    .insert(schema.salesOrders)
    .values({
      id: `email-${d.orderNumber}-${Date.now()}`,
      shopifyId,
      internalId: `SO-${d.orderNumber}`,
      customer: d.customerName || 'Guest',
      value: d.total,
      payment: normalizePayment(d.paymentMethod),
      fulfillment: 'unfulfilled',
      invoice: null,
      status: 'imported',
      date: d.date,
      items: d.items.reduce((s, i) => s + i.quantity, 0),
      lineItems: d.items.length > 0 ? d.items : null,
      billingAddress: billingAddress ?? undefined,
      shippingAddress: shippingAddress ?? undefined,
      customerEmail: d.email || undefined,
      customerPhone: d.phone || undefined,
    })
    .onConflictDoNothing()
  return { updated: false, created: true }
}

// ─── Auto-invoice ───────────────────────────────────────────────

async function nextInvoiceNumber(prefix: string): Promise<string> {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `${prefix}${stamp}${Math.floor(1000 + Math.random() * 9000)}`
    const [clash] = await db!
      .select({ id: schema.salesInvoices.id })
      .from(schema.salesInvoices)
      .where(eq(schema.salesInvoices.number, candidate))
      .limit(1)
    if (!clash) return candidate
  }
  return `${prefix}${stamp}${Date.now().toString().slice(-6)}`
}

/**
 * Deduct sold quantity from product stock, inside the caller's transaction.
 *
 * The caller has already validated availability at THIS location through
 * assertStockAvailable (with the products row-locked), so a refusal here would
 * mean the ledger changed its mind between check and write — never swallow it:
 * a stock refusal must abort the document, not create an invoice that quietly
 * drove a balance negative. Email orders carry no shop, so they deduct from
 * the default location unless the order row already records one — which keeps
 * a later reversal (edit or cancellation) landing on the same balance the
 * deduction did.
 *
 * `variantId` names the exact variant when the line sold one: the movement is
 * pinned to that variant's bucket instead of being inferred from the SKU
 * string, so a line whose SKU and variant ever disagree still draws from the
 * variant the document actually billed (and records it in stock history).
 */
async function deductStock(
  tx: any,
  input: {
    sku: string
    qty: number
    locationId?: string | null
    variantId?: string | null
    ref?: { refId?: string; note?: string }
  },
): Promise<void> {
  const { sku, qty, locationId, variantId, ref } = input
  if (!sku || !qty) return
  try {
    await applyStockMovement({
      sku,
      ...(variantId ? { variantId } : {}),
      qty: -qty,
      type: 'sale_out',
      refType: 'email_order',
      // Fulfilled-from store: an allocation-driven deduction always names its
      // own store; a legacy call resolves exactly as before (NULL → default).
      locationId: await resolveMovementLocation(locationId ?? null, tx),
      // Optional traceability: multi-store booking fulfilments stamp the
      // invoice they belong to and the booking line they consumed.
      ...(ref?.refId ? { refId: ref.refId } : {}),
      ...(ref?.note ? { note: ref.note } : {}),
      tx,
    })
  } catch (err) {
    // A stock refusal is never swallowed; other ledger quirks stay
    // non-blocking so stock tracking remains optional for untracked SKUs.
    if (err instanceof InsufficientStockError) throw err
  }
}

export interface CreateInvoiceOptions {
  /**
   * Move stock out for each invoiced item (default true). The Shopify order
   * import passes false: it already moved stock when the order row was
   * inserted, so invoicing must not deduct it a second time.
   */
  deductStock?: boolean
  /**
   * GST rate to bill at instead of the store-wide settings rate. Bookings
   * carry the rate they were taken at (read from the LOCKED row inside the
   * transaction — a concurrent rate edit wins over any pre-read), so the
   * invoice matches what the customer was shown; every other caller keeps the
   * settings behaviour.
   */
  gstRate?: number
  /**
   * Actor recorded on the post-commit side effects (journal attribution).
   */
  actor?: string | null
  /**
   * Runs INSIDE the conversion transaction, after the invoice, its items,
   * its stock movements, the allocation fulfilment marks and the booking
   * financial workflow are written but BEFORE the transaction commits —
   * reserved for caller-specific extras (the tests use it to inject a
   * mid-transaction failure). The booking's status and advance payment are
   * NOT this hook's job: they are applied by the shared workflow below for
   * every entry point.
   */
  afterInvoice?: (
    tx: Tx,
    ctx: { invoiceId: string; number: string; order: typeof schema.salesOrders.$inferSelect },
  ) => Promise<void>
}

/** What `raiseInvoiceForOrder` produced: the number, and whether WE claimed it. */
export interface InvoiceRaiseResult {
  number: string | null
  /**
   * True when this call won the invoice claim — and therefore ran the
   * post-commit side effects and the `afterInvoice` hook. False on a
   * fast-path return or when a concurrent caller claimed the order first:
   * a caller that lost the race must NOT write its own financial records,
   * because the winner already wrote them inside that transaction.
   */
  claimed: boolean
}

type InvoiceArtifacts = {
  items: Array<{
    product: string
    sku: string
    qty: number
    weight: number
    silverRate: number
    makingCharge: number
    tax: number
    amount: number
    silverValue?: number
    makingValue?: number
    /** The variant the line sold, when the order named one. */
    variantId?: string | null
    /** Variant "Add to price (₹)" already folded into the line's price. */
    priceAdjustment?: number | null
  }>
  payment: string
  subtotal: number
  gstAmount: number
  effectiveDiscount: number
  grandTotal: number
  silverValue: number | null
  makingCharge: number | null
}

/**
 * An invoice line as the fulfilment write emits it: the money fields plus the
 * optional store/source provenance (set on every allocation-driven split part,
 * on unsplit items only when this call actually deducted at a store).
 */
type FulfilmentItem = InvoiceArtifacts['items'][number] & {
  locationId?: string
  bookingLineId?: string
  bookingAllocationId?: string
  /** Source booking line index (0-based) — transient, stripped before the insert. */
  lineIndex?: number
}

/**
 * Is this row an ERP-created manual order rather than a Shopify one?
 *
 * A manual order that was pushed to Shopify and imported back keeps the
 * `manual-order` tag but its imported lines no longer carry the ERP amount /
 * weight fields. It is a Shopify order now: its Shopify total is authoritative,
 * otherwise the manual branch recomputes ₹0 and never repairs the invoice.
 */
function isErpManualOrder(order: typeof schema.salesOrders.$inferSelect): boolean {
  const fromShopify = Boolean(order.shopifyGid) || (order.shopifyId ?? '').startsWith('#')
  return !fromShopify
    && ((order.tags ?? '').includes('manual-order') || !(order.shopifyId ?? '').startsWith('#'))
}

/**
 * The money half of an invoice raise: line items + header totals for ONE order
 * row, computed with the exact pre-existing rules (manual/booking component
 * vs price lines, Shopify billed-total spread). Extracted as a pure function so
 * the conversion transaction can REBUILD them from the freshly locked row when
 * the order changed between the pre-read and the lock — an invoice must always
 * mirror the row it claims, never a stale snapshot of it.
 */
function buildInvoiceArtifacts(
  order: typeof schema.salesOrders.$inferSelect,
  scalars: { gstRate: number; silverRate: number; productMap: Record<string, { netWeight: number; makingCharge: number }> },
): InvoiceArtifacts | null {
  const rawLineItems = Array.isArray(order.lineItems) ? (order.lineItems as OrderEmailData['items']) : []
  const isManualOrder = isErpManualOrder(order)
  const orderValue = round2(Number(order.value ?? 0))
  const lineItems: OrderEmailData['items'] = rawLineItems.length > 0
    ? rawLineItems
    : !isManualOrder && orderValue > 0
      ? [{ title: `Order ${order.shopifyId ?? ''}`.trim(), sku: '', quantity: 1, price: orderValue }]
      : []
  if (lineItems.length === 0) return null

  const { gstRate, silverRate, productMap } = scalars
  // `sales_orders.payment` is a STATE, not a method: only COD actually tells us
  // how the customer paid. An online Shopify order has no gateway evidence on
  // the order row, so leave the method empty rather than inventing "Online".
  const payment = order.payment === 'cod' ? 'cod' : ''
  const discount = Number(order.discount ?? 0)

  let items: InvoiceArtifacts['items']
  let erpSilverValue: number
  let erpMakingCharge: number
  let erpSubtotal: number
  let silverValue: number | null
  let makingCharge: number | null
  let subtotal: number
  let effectiveDiscount: number
  let gstAmount: number
  let grandTotal: number

  if (isManualOrder) {
    // Manual orders: component-shaped lines (silverValue, makingValue, amount,
    // weight, silverRate, makingCharge) bill from their stored components;
    // price-only lines — bookings — are billed from their price. One path for
    // both, so invoice totals always match the order's own value.
    items = buildManualInvoiceLines(lineItems, gstRate)
    // For manual orders, ERP components come directly from stored line items
    erpSilverValue = round2(items.reduce((a, it) => a + (it.silverValue ?? 0), 0))
    erpMakingCharge = round2(items.reduce((a, it) => a + (it.makingValue ?? 0), 0))
    erpSubtotal = round2(erpSilverValue + erpMakingCharge)
    // No adjustment needed for manual orders - they were priced using the same rate
    effectiveDiscount = discount
    subtotal = erpSubtotal
    const totals = invoiceTotals(subtotal, gstRate, effectiveDiscount)
    gstAmount = totals.gstAmount
    grandTotal = totals.grandTotal
    silverValue = erpSilverValue
    makingCharge = erpMakingCharge
  } else {
    // Shopify orders: the customer has already been billed a specific amount,
    // so the Shopify order total is authoritative — never the ERP catalogue's
    // weight × rate arithmetic (that is what produced ₹0 invoices when a SKU
    // had no catalogue weight). computeShopifyInvoiceAmounts spreads the billed
    // total across the Shopify lines and guarantees grandTotal === order total.
    const amounts = computeShopifyInvoiceAmounts({
      total: order.value,
      discount,
      gstRate,
      lines: lineItems.map((li) => {
        const qty = Number(li.quantity ?? 0)
        // Product snapshot: net weight, making charge from catalogue.
        // Silver rate comes from Silver Rate Management (authoritative source).
        const product = productMap[String(li.sku ?? '')] ?? { netWeight: 0, makingCharge: 0 }
        const weight = product.netWeight > 0 ? Math.round(product.netWeight * qty * 1000) / 1000 : 0
        return {
          price: Number(li.price ?? 0),
          quantity: qty,
          weight,
          // Actual Silver Rate Management rate (0 for zero-weight items).
          silverRate: weight > 0 ? silverRate : 0,
          makingCharge: product.makingCharge,
        }
      }),
    })
    items = lineItems.map((li, index) => {
      const priced = amounts.lines[index] ?? { amount: 0, tax: 0, weight: 0, silverRate: 0, makingCharge: 0 }
      return {
        product: String(li.title ?? '').trim(),
        sku: String(li.sku ?? ''),
        qty: Number(li.quantity ?? 0),
        weight: priced.weight,
        silverRate: priced.silverRate,
        makingCharge: priced.makingCharge,
        tax: priced.tax,
        amount: priced.amount,
        ...(li.priceAdjustment != null ? { priceAdjustment: li.priceAdjustment } : {}),
      }
    })
    subtotal = amounts.subtotal
    gstAmount = amounts.gstAmount
    effectiveDiscount = amounts.discount
    grandTotal = amounts.grandTotal
    silverValue = amounts.silverValue
    makingCharge = amounts.makingCharge
  }

  return { items, payment, subtotal, gstAmount, effectiveDiscount, grandTotal, silverValue, makingCharge }
}

/** Customer record + address block for the invoice snapshot (reusable under a lock). */
async function customerSnapshotFor(order: typeof schema.salesOrders.$inferSelect, client: any): Promise<{
  customer: typeof schema.customers.$inferSelect | undefined
  addr: Record<string, string>
}> {
  const [customer] = order.customer
    ? await client.select().from(schema.customers).where(eq(schema.customers.name, order.customer)).limit(1)
    : []
  const addr = (order.shippingAddress && (order.shippingAddress as Record<string, string>).address1)
    ? order.shippingAddress as Record<string, string>
    : (order.billingAddress as Record<string, string> | null) ?? {}
  return { customer, addr }
}

/**
 * Raise a tax invoice for any order row (email-synced or manual).
 * Idempotent: returns the existing invoice number if one is already linked.
 * Returns null when the order has no line items to invoice.
 *
 * TRANSACTION BOUNDARY (Phase 4): the order row lock, the LOCKED-SNAPSHOT
 * preparation (derived payment, customer, discount, GST, totals, line items —
 * a concurrent edit can never leak stale financials into the invoice), the
 * fulfilment plan, the stock guard, the claim, the invoice + items, the stock
 * movements, the allocation fulfilment marks, the booking financial workflow
 * (fulfilled status + the advance payment — shared by EVERY booking entry
 * point) and the caller's `afterInvoice` extras all happen in ONE
 * transaction: a failure at any point rolls back ALL of it, so no partially
 * completed financial state can exist. The external side effects (loyalty,
 * e-invoicing, accounting journals) run once, after commit, only for the call
 * that won the claim — and are DURABLY retried by the recovery sweep in
 * invoiceSideEffects.ts if they fail.
 */
export async function raiseInvoiceForOrder(
  order: typeof schema.salesOrders.$inferSelect,
  opts: CreateInvoiceOptions = {},
): Promise<InvoiceRaiseResult> {
  if (!db) return { number: null, claimed: false }

  const rawLineItems = Array.isArray(order.lineItems) ? (order.lineItems as OrderEmailData['items']) : []
  // Detect manual orders (created via ERP, not imported from Shopify)
  const isManualOrder = isErpManualOrder(order)
  const orderValue = round2(Number(order.value ?? 0))

  // An invoiced order is normally left alone. The one exception is an invoice
  // that carries no amount for a real order — the Shopify import used to build
  // the total from catalogue weights only, so a SKU missing from the catalogue
  // produced a ₹0 invoice for a valid Shopify order. Those are repaired from
  // the order they belong to instead of being skipped forever.
  if (order.invoice) {
    const [linked] = await db
      .select({ grandTotal: schema.salesInvoices.grandTotal, paymentStatus: schema.salesInvoices.paymentStatus })
      .from(schema.salesInvoices)
      .where(eq(schema.salesInvoices.number, order.invoice))
      .limit(1)
    if (!linked) {
      // The invoice was deleted but the order kept its number. Leaving the
      // stale reference made every future "Create invoice" click return a
      // non-existent invoice number forever. Clear it and raise a real one.
      await db.update(schema.salesOrders).set({ invoice: null }).where(eq(schema.salesOrders.id, order.id))
      order = { ...order, invoice: null }
    } else if (
      Number(linked.grandTotal ?? 0) > 0 &&
      (orderValue <= 0 || Math.abs(Number(linked.grandTotal ?? 0) - orderValue) <= 0.01) &&
      String(linked.paymentStatus ?? '').toLowerCase() === String(order.payment ?? '').toLowerCase()
    ) {
      return { number: order.invoice, claimed: false }
    }
  }

  // Older Shopify rows were imported without line items. Their order total is
  // still a real sale, so invoice it as one line rather than returning null.
  const lineItems: OrderEmailData['items'] = rawLineItems.length > 0
    ? rawLineItems
    : !isManualOrder && orderValue > 0
      ? [{ title: `Order ${order.shopifyId ?? ''}`.trim(), sku: '', quantity: 1, price: orderValue }]
      : []
  if (lineItems.length === 0) return { number: null, claimed: false }

  // Settings: gst rate + invoice prefix
  const [settingsRow] = await db.select().from(schema.settings).where(eq(schema.settings.id, 'app')).limit(1)
  const gstRate = opts.gstRate != null && Number.isFinite(Number(opts.gstRate))
    ? Number(opts.gstRate)
    : Number(settingsRow?.gstRate ?? 3)
  const prefix = settingsRow?.invoicePrefix?.trim() || 'INV-'

  // Authoritative silver rate from Silver Rate Management (silver_rates table).
  // This is the single source of truth for new pricing operations.
  const latestRate = await getLatestSilverRate()
  if (!latestRate || !latestRate.rate || latestRate.rate <= 0) {
    throw new Error('Current silver rate is not available. Please update the rate in Silver Rate Management before creating invoices.')
  }
  const silverRate = latestRate.rate

  // Load product data keyed by SKU for invoice-item snapshots (weight, making charge).
  // Silver rate comes from Silver Rate Management, not the product catalogue.
  const productData = await db
    .select({
      sku: schema.products.sku,
      netWeight: schema.products.netWeight,
      makingCharge: schema.products.makingCharge,
    })
    .from(schema.products)
  const productMap = Object.fromEntries(
    productData.map((p) => [
      p.sku,
      {
        netWeight: Number(p.netWeight ?? 0),
        makingCharge: Number(p.makingCharge ?? 0),
      },
    ])
  )

  // The money half — one pure builder shared with the in-transaction rebuild
  // below, so the pre-read and the locked state can never price differently.
  const art = buildInvoiceArtifacts(order, { gstRate, silverRate, productMap })
  if (!art) return { number: null, claimed: false }
  const items = art.items
  const subtotal = art.subtotal
  const gstAmount = art.gstAmount
  const effectiveDiscount = art.effectiveDiscount
  const grandTotal = art.grandTotal
  const silverValue = art.silverValue
  const makingCharge = art.makingCharge

  // (The customer/address snapshot is taken INSIDE the transaction from the
  // locked row — see lockedSnap below — so a concurrent contact edit cannot
  // leak a stale snapshot into the invoice.)

  // Repair path: the top guard only falls through when the linked invoice has
  // no amount. Write the amounts derived from the order and rebuild its lines,
  // keeping the same invoice number so every existing reference stays valid.
  if (order.invoice) {
    const [existing] = await db
      .select()
      .from(schema.salesInvoices)
      .where(eq(schema.salesInvoices.number, order.invoice))
      .limit(1)
    if (existing && grandTotal > 0) {
      await db.transaction(async (tx) => {
        await tx
          .update(schema.salesInvoices)
          .set({
            silverValue,
            makingCharge,
            subtotal,
            gst: gstRate,
            gstAmount,
            discount: effectiveDiscount,
            grandTotal,
            // The order is the authority for a linked invoice. This repairs
            // old rows where the invoice amount/status had drifted from the
            // Shopify order (e.g. an invoice marked paid for a pending order).
            paymentStatus: order.payment,
            status:
              order.payment === 'refunded'
                ? 'refunded'
                : order.payment === 'paid'
                  ? 'paid'
                  : existing.status === 'paid'
                    ? 'issued'
                    : existing.status,
            currency: order.currency ?? existing.currency ?? 'INR',
          })
          .where(eq(schema.salesInvoices.id, existing.id))
        await tx.delete(schema.salesInvoiceItems).where(eq(schema.salesInvoiceItems.invoiceId, existing.id))
        for (const it of items) {
          await tx.insert(schema.salesInvoiceItems).values({ ...it, id: crypto.randomUUID(), invoiceId: existing.id })
        }
      })
      logger.info({ orderId: order.id, invoice: order.invoice, grandTotal }, 'Repaired zero-value invoice from its order total')
    }
    return { number: order.invoice, claimed: false }
  }

  const number = await nextInvoiceNumber(prefix)
  const invoiceId = crypto.randomUUID()
  try {
    const written = await db.transaction(async (tx) => {
      // 1. LOCK THE ORDER ROW FIRST: allocation edits, booking edits and this
      //    conversion all serialise on this lock, so the saved plan can never
      //    change underneath fulfilment and two conversions cannot interleave.
      const [lockedRow] = await tx
        .select()
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.id, order.id))
        .limit(1)
        .for('update')
      if (!lockedRow || lockedRow.invoice) {
        // Vanished, or a concurrent caller claimed it first — the catch below
        // reuses the winner's invoice instead of raising a second one.
        const err = new Error(`Sales order ${order.id} is already linked to an invoice`)
        ;(err as Error & { code?: string }).code = 'ORDER_ALREADY_INVOICED'
        throw err
      }
      // The ONE snapshot everything below is built from: we hold the row lock,
      // so no edit can interleave between this read and the commit.
      let fresh = lockedRow

      // 1b. LOCK-FIRST PREPARATION (hardening): a booking's derived
      //    `payment` is levelled from ITS OWN advance/value on the locked row
      //    FIRST, so the invoice's payment fields, the advance payment row and
      //    every later reader reflect one consistent snapshot. This runs for
      //    EVERY booking entry point (Convert, kanban fulfilment,
      //    create-invoice, re-invoice) — and the levelled update commits or
      //    rolls back with the invoice.
      if (fresh.isBooking) {
        const value = Number(fresh.value ?? 0)
        const advance = Number(fresh.advancePaid ?? 0)
        const leveled = advance >= value && value > 0 ? 'paid' : 'pending'
        if (String(fresh.payment ?? '') !== leveled) {
          await tx.update(schema.salesOrders).set({ payment: leveled }).where(eq(schema.salesOrders.id, fresh.id))
          fresh = { ...fresh, payment: leveled }
        }
      }
      // The GST rate this invoice bills at: a booking's rate lives on the
      // LOCKED row (a concurrent rate edit wins over the caller's pre-read);
      // every other caller keeps its caller/settings rate exactly as before.
      const lockedGstRate =
        fresh.isBooking && fresh.gst != null && Number.isFinite(Number(fresh.gst)) ? Number(fresh.gst) : gstRate
      // The money THIS invoice is built from — from the locked row, never the
      // pre-lock read, so a concurrent header edit (discount, GST, customer,
      // advance, lines) can never produce an invoice priced from stale values.
      const lockedArt = buildInvoiceArtifacts(fresh, { gstRate: lockedGstRate, silverRate, productMap })
      if (!lockedArt) return null
      const lockedSnap = await customerSnapshotFor(fresh, tx)

      // 2. Multi-store fulfilment plan (Phase 4, Option A): when the booking
      //    carries explicit allocations, EVERY catalogue-tracked line must be
      //    fully allocated (hand-typed lines are exempt — they carry no
      //    product to allocate) and the invoice items split per store, each
      //    naming its source booking line and allocation. Identity is
      //    re-checked here: an allocation can never fulfil a different line
      //    than the one it was saved against. Bookings with NO allocation
      //    rows (every legacy/single-store booking) skip this entirely and
      //    keep the single-store path byte-for-byte.
      const allocations = await tx
        .select()
        .from(schema.bookingAllocations)
        .where(eq(schema.bookingAllocations.orderId, fresh.id))
      let planItems: FulfilmentItem[] | null = null
      if (allocations.length > 0) {
        const freshLines = Array.isArray(fresh.lineItems) ? (fresh.lineItems as unknown[]) : []
        const { buildBookingFulfilmentPlan } = await import('./bookings')
        planItems = buildBookingFulfilmentPlan({ lineItems: freshLines, items: lockedArt.items, gstRate: lockedGstRate, allocations })
      }
      const finalItems: FulfilmentItem[] = planItems ?? (lockedArt.items as FulfilmentItem[])

      // 3. Validate the WHOLE basket at EACH store the deduction will land on,
      //    BEFORE anything is written — the standard locked guard, once per
      //    store (aggregating per SKU within the store, resolving variants to
      //    their own balances, counting the default store's pre-ledger
      //    adoption). A shortfall throws INSUFFICIENT_STOCK carrying that
      //    store's own id + name, and the transaction rolls back completely —
      //    no invoice, no claim, no movement, no marks, nothing converted.
      //    Combined/cross-store stock is never consulted: each bucket is
      //    measured only where its units will actually leave.
      //
      //    Only checked when THIS call will move stock: a caller that opted out
      //    (the Shopify order import) already deducted — and was already
      //    validated — when the order row was inserted.
      const deduct = opts.deductStock !== false
      const resolvedOrderLocation = deduct ? await resolveMovementLocation(fresh.locationId ?? null, tx) : undefined
      if (deduct) {
        const groups = new Map<string, Array<{ sku: string; qty: number; name: string }>>()
        for (const it of finalItems) {
          const loc = it.locationId || resolvedOrderLocation!
          const entry = { sku: it.sku, qty: it.qty, name: it.product }
          const group = groups.get(loc)
          if (group) group.push(entry)
          else groups.set(loc, [entry])
        }
        const locationIds = [...groups.keys()].sort((a, b) => a.localeCompare(b))
        if (locationIds.length > 1) {
          // Deterministic lock order across stores: take EVERY product and
          // variant lock ONCE, in the same SKU order assertStockAvailable
          // itself uses, before any per-store comparison — two multi-store
          // conversions (or one against a single-store writer) can then never
          // deadlock against each other.
          const skus = [...new Set(finalItems.map((it) => String(it.sku ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
          for (const sku of skus) await resolveStockSku(tx, sku)
        }
        for (const locationId of locationIds) {
          await assertStockAvailable(tx, groups.get(locationId)!, { locationId })
        }
      }
      // Atomically claim the order for THIS invoice. The UPDATE locks the
      // order row and only matches while it is still un-invoiced, so a
      // concurrent or repeated create-invoice request loses the race here —
      // it gets ORDER_ALREADY_INVOICED instead of silently raising a second
      // invoice (and deducting stock twice). The claim lives in the same
      // transaction as the inserts below, so a failure rolls it back too.
      const claimed = await tx
        .update(schema.salesOrders)
        .set({ invoice: number })
        .where(and(
          eq(schema.salesOrders.id, order.id),
          sql`(${schema.salesOrders.invoice} IS NULL OR ${schema.salesOrders.invoice} = '')`,
        ))
        .returning({ id: schema.salesOrders.id })
      if (claimed.length === 0) {
        const err = new Error(`Sales order ${order.id} is already linked to an invoice`)
        ;(err as Error & { code?: string }).code = 'ORDER_ALREADY_INVOICED'
        throw err
      }
      // Store effectiveDiscount (includes adjustment) so that grandTotal = subtotal + gstAmount - discount holds
      const storedDiscount = lockedArt.effectiveDiscount
      const lockedAddress1 = String(lockedSnap.addr.address1 ?? '')
      const lockedAddress2 = String(lockedSnap.addr.address2 ?? '')
      await tx.insert(schema.salesInvoices).values({
        id: invoiceId,
        number,
        shopifyOrder: fresh.shopifyId ?? null,
        customer: fresh.customer,
        // Fall back to the order's own contact columns when the customer row
        // could not be matched (placeholder 'Guest' name on a guest checkout
        // still left a fillable customer_email / customer_phone on the order).
        customerEmail: lockedSnap.customer?.email || String(fresh.customerEmail ?? ''),
        customerPhone: lockedSnap.customer?.phone || String(lockedSnap.addr.phone ?? '') || String(fresh.customerPhone ?? ''),
        customerAddress: [lockedAddress1, lockedAddress2].filter(Boolean).join(', '),
        customerCity: String(lockedSnap.addr.city ?? lockedSnap.customer?.city ?? ''),
        customerState: String(lockedSnap.addr.province ?? lockedSnap.customer?.province ?? ''),
        customerPincode: String(lockedSnap.addr.zip ?? ''),
        silverValue: lockedArt.silverValue,
        makingCharge: lockedArt.makingCharge,
        subtotal: lockedArt.subtotal,
        gst: lockedGstRate,
        gstAmount: lockedArt.gstAmount,
        discount: storedDiscount,
        grandTotal: lockedArt.grandTotal,
        currency: fresh.currency ?? 'INR',
        date: fresh.date ?? new Date().toISOString(),
      })
      // 5. Items + ONE location-correct deduction per item. Split parts carry
      //    their own store and their exact source line/allocation; unsplit
      //    legacy items record the store they were actually deducted at (NULL
      //    only when this call did not move stock, e.g. the Shopify import —
      //    never a fabricated location). Σ(split amounts) ≡ the whole line's
      //    amount by construction, so header totals are identical to a
      //    single-store conversion.
      const lineRows = Array.isArray(fresh.lineItems) ? (fresh.lineItems as Array<{ id?: string }>) : []
      const stampByIndex = planItems == null && finalItems.length === lineRows.length
      const bookingRef = `Booking ${String(fresh.internalId ?? fresh.id)}`
      let idx = 0
      for (const it of finalItems) {
        const { lineIndex, ...row } = it
        const sourceLineId = row.bookingLineId ?? (stampByIndex ? lineRows[idx]?.id : undefined)
        idx++
        const locationId = row.locationId ?? resolvedOrderLocation
        await tx.insert(schema.salesInvoiceItems).values({
          ...row,
          id: crypto.randomUUID(),
          invoiceId,
          ...(locationId ? { locationId } : {}),
          ...(sourceLineId ? { bookingLineId: sourceLineId } : {}),
        })
        // Deduct stock for the sold SKU, same rule as manual invoices. The
        // item's own location is honoured so the deduction and any later
        // reversal agree on which balance they touch — and it is the SAME
        // location the availability guard above measured. Skipped when the
        // caller already moved stock (Shopify order import). Allocation-driven
        // movements additionally name the invoice and the booking line they
        // fulfilled, for the audit trail.
        if (deduct) {
          await deductStock(tx, {
            sku: it.sku,
            qty: it.qty,
            locationId,
            // The exact variant this line billed: the guard above measured ITS
            // balance at this store, so the write must move that same bucket.
            variantId: it.variantId ?? null,
            ...(planItems
              ? { ref: { refId: invoiceId, note: lineIndex !== undefined ? `${bookingRef} line ${lineIndex + 1}` : bookingRef } }
              : {}),
          })
        }
      }

      // 6. Allocation fulfilment marks — SAME transaction as the invoice, so
      //    an allocation is either consumed by a committed invoice or still
      //    open; it can never be half-marked, and a rollback leaves the plan
      //    exactly as it was saved.
      if (planItems) {
        await tx
          .update(schema.bookingAllocations)
          .set({ invoiceId: number, fulfilledAt: new Date().toISOString() })
          .where(eq(schema.bookingAllocations.orderId, fresh.id))
      }

      // 7. Booking financial workflow — EVERY booking→invoice entry point
      //    (Convert button, kanban fulfilment auto-invoice, create-invoice,
      //    re-invoice) runs the SAME atomic block: fulfilled status + the
      //    advance payment row, recorded exactly ONCE (an existing Advance
      //    row for this booking is re-pointed to the invoice instead of being
      //    inserted again). A failure here rolls EVERYTHING back, so no
      //    partially completed financial state can be committed.
      if (fresh.isBooking) {
        const { applyBookingInvoiceFinancials } = await import('./bookings')
        await applyBookingInvoiceFinancials(tx, fresh, number)
      }
      // Caller-specific extras (tests inject a mid-transaction failure here).
      if (opts.afterInvoice) await opts.afterInvoice(tx, { invoiceId, number, order: fresh })
      return true
    })
    if (!written) return { number: null, claimed: false }
  } catch (err) {
    if ((err as Error & { code?: string }).code !== 'ORDER_ALREADY_INVOICED') throw err
    // Another request claimed the order first — return its invoice number
    // instead of failing or, worse, inserting a duplicate. `claimed: false`
    // tells the caller NOT to write its own financial records: the winner's
    // transaction already wrote them (status, advance, marks and all).
    const [fresh] = await db.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, order.id)).limit(1)
    if (fresh?.invoice) {
      logger.info({ orderId: order.id, invoice: fresh.invoice }, 'order already invoiced; reusing the linked invoice')
      return { number: fresh.invoice, claimed: false }
    }
    throw err
  }

  // ── Post-commit side effects: run ONCE, only for the call that won the
  //    claim (every lost race and every retry returned above) — and DURABLY.
  //    The invoice transaction itself never runs external work (it would
  //    hold product/order locks across network calls), so if any effect
  //    fails in this window, `ensureInvoiceSideEffects`' periodic recovery
  //    sweep re-runs just the missing ones. Every effect is idempotent, so a
  //    retry can never duplicate a journal, an award or an IRN — and a
  //    conversion retry never reaches here at all (no second claim → no
  //    second invoice → no second advance payment).
  void ensureInvoiceSideEffects(invoiceId, { actor: opts.actor ?? null })
    .catch((err) => logger.warn({ err, invoiceId }, 'post-commit side effects failed — recovery will retry'))
  return { number, claimed: true }
}

/**
 * Back-compat wrapper around `raiseInvoiceForOrder` for callers that only
 * need the invoice number (email sync, kanban auto-invoice, create-invoice,
 * duplicate/convert relays).
 */
export async function createInvoiceForOrderRow(
  order: typeof schema.salesOrders.$inferSelect,
  opts: CreateInvoiceOptions = {},
): Promise<string | null> {
  return (await raiseInvoiceForOrder(order, opts)).number
}

/**
 * Keep a linked invoice's payment state level with its order.
 *
 * Shopify is authoritative for a Shopify order: a webhook that moves PAID →
 * PARTIALLY_REFUNDED/REFUNDED must not leave the invoice saying "paid" (which
 * made Paid and Refunded both look true in the dashboard). Only the payment
 * state is changed here; the invoice amount is repaired separately from the
 * order total when it is next generated.
 */
export async function syncInvoicePaymentFromOrder(orderId: string): Promise<void> {
  if (!db) return
  const [order] = await db.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, orderId)).limit(1)
  if (!order?.invoice) return
  const [invoice] = await db
    .select({ id: schema.salesInvoices.id, paymentStatus: schema.salesInvoices.paymentStatus, status: schema.salesInvoices.status })
    .from(schema.salesInvoices)
    .where(eq(schema.salesInvoices.number, order.invoice))
    .limit(1)
  if (!invoice) return

  const paymentStatus = String(order.payment ?? '').toLowerCase()
  if (!['paid', 'pending', 'partial', 'refunded', 'failed'].includes(paymentStatus)) return
  const nextStatus =
    paymentStatus === 'refunded'
      ? 'refunded'
      : paymentStatus === 'paid'
        ? 'paid'
        : invoice.status === 'paid'
          ? 'issued'
          : invoice.status
  if (invoice.paymentStatus === paymentStatus && invoice.status === nextStatus) return
  await db
    .update(schema.salesInvoices)
    .set({ paymentStatus, status: nextStatus })
    .where(eq(schema.salesInvoices.id, invoice.id))
}

/**
 * Auto-raise a tax invoice when an email-synced order is created/updated.
 * Idempotent: skips orders that already have an invoice.
 */
export async function autoInvoiceOrder(d: OrderEmailData): Promise<{ created: boolean; invoiceNumber: string | null }> {
  if (!db) return { created: false, invoiceNumber: null }
  const shopifyId = `#${d.orderNumber}`
  const [order] = await db
    .select()
    .from(schema.salesOrders)
    .where(eq(schema.salesOrders.shopifyId, shopifyId))
    .limit(1)
  if (!order) return { created: false, invoiceNumber: null }
  const number = await createInvoiceForOrderRow(order)
  return { created: Boolean(number) && !order.invoice, invoiceNumber: number }
}

/** Raise an invoice for an order identified by its Shopify order number. */
export async function createInvoiceForOrderNumber(shopifyOrderNumber: string): Promise<{ created: boolean; invoiceNumber: string | null }> {
  if (!db) return { created: false, invoiceNumber: null }
  const shopifyId = shopifyOrderNumber.startsWith('#') ? shopifyOrderNumber : `#${shopifyOrderNumber}`
  const [order] = await db
    .select()
    .from(schema.salesOrders)
    .where(eq(schema.salesOrders.shopifyId, shopifyId))
    .limit(1)
  if (!order) return { created: false, invoiceNumber: null }
  const number = await createInvoiceForOrderRow(order)
  return { created: Boolean(number) && !order.invoice, invoiceNumber: number }
}

/**
 * Repair Shopify invoices that carry no amount while their order does.
 *
 * This is the backfill for real data written by the old importer: an invoice
 * exists and is linked to the order, but its grand_total is 0/null because the
 * total was rebuilt from catalogue weights and the SKU had none. The order's
 * own (Shopify-sourced) value is authoritative, so the invoice keeps its number
 * and identity and only its money fields are recomputed. Idempotent: a repaired
 * invoice no longer matches the zero-amount filter.
 */
export async function repairZeroValueShopifyInvoices(): Promise<{ repaired: number; failed: string[] }> {
  if (!db) return { repaired: 0, failed: [] }
  // Repair any linked Shopify invoice whose amount disagrees with the order
  // total, not only a ₹0 one. Old imports wrote catalogue-derived totals that
  // differed from what Shopify actually billed; leaving those rows meant the
  // invoice page and Payment Status disagreed about the same sale.
  const needsRepair = sql`(
    exists (
      select 1
        from ${schema.salesInvoices} as repair_invoice
       where repair_invoice.number = ${schema.salesOrders.invoice}
         and (
           coalesce(repair_invoice.grand_total, 0) <= 0
           or abs(coalesce(repair_invoice.grand_total, 0) - coalesce(${schema.salesOrders.value}, 0)) > 0.01
           or lower(coalesce(repair_invoice.payment_status, '')) is distinct from lower(coalesce(${schema.salesOrders.payment}, ''))
         )
    )
    or (
      nullif(trim(${schema.salesOrders.invoice}), '') is not null
      and not exists (
        select 1 from ${schema.salesInvoices} as missing_invoice
         where missing_invoice.number = ${schema.salesOrders.invoice}
      )
    )
  )`
  const rows = await db
    .select()
    .from(schema.salesOrders)
    .where(and(
      sql`${schema.salesOrders.shopifyId} like '#%'`,
      sql`coalesce(${schema.salesOrders.value}, 0) > 0`,
      sql`(lower(coalesce(${schema.salesOrders.status}, '')) <> 'cancelled' or lower(coalesce(${schema.salesOrders.payment}, '')) = 'refunded')`,
      sql`coalesce(${schema.salesOrders.shopifyStore}, '') <> 'not-in-store'`,
      needsRepair,
    ))

  let repaired = 0
  const failed: string[] = []
  for (const order of rows) {
    try {
      // A restore can leave the invoice pointing at the order while the order
      // no longer points back; re-link it before repairing so the normal
      // single-invoice relationship holds afterwards. A stale reference is
      // cleared; if no invoice exists, leave it un-invoiced for the operator.
      let target = order
      if (target.invoice) {
        const [linked] = await db
          .select({ number: schema.salesInvoices.number })
          .from(schema.salesInvoices)
          .where(eq(schema.salesInvoices.number, target.invoice))
          .limit(1)
        if (!linked) {
          await db.update(schema.salesOrders).set({ invoice: null }).where(eq(schema.salesOrders.id, target.id))
          target = { ...target, invoice: null }
        }
      }
      if (!target.invoice) continue
      const number = await createInvoiceForOrderRow(target, { deductStock: false })
      if (number) repaired++
    } catch (err) {
      failed.push(`${order.shopifyId ?? order.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { repaired, failed }
}

// ─── IMAP polling ───────────────────────────────────────────────────

function emailConfig() {
  const passEnc = process.env.ORDER_EMAIL_PASSWORD?.trim() ?? ''
  const password = passEnc ? decryptSecret(passEnc) : ''
  return {
    user: process.env.ORDER_EMAIL_ADDRESS?.trim() ?? '',
    pass: password,
    host: process.env.ORDER_EMAIL_HOST?.trim() || 'imap.gmail.com',
    port: Number(process.env.ORDER_EMAIL_PORT ?? 993),
    folder: process.env.ORDER_EMAIL_FOLDER?.trim() || 'INBOX',
  }
}

export interface IngestResult {
  ok: boolean
  scanned: number
  parsed: number
  updated: number
  created: number
  errors: string[]
}

/**
 * Customers created/updated by email ingestion start with orders=0 and
 * totalSpent=0 — derive those stats from the real order rows so the customers
 * list and reports reflect emailed orders immediately.
 */
// ─── Customer-export CSV watcher ──────────────────────────────────

export interface CustomerExportResult {
  ok: boolean
  scanned: number
  attachmentsFound: number
  imported: number
  updated: number
  errors: string[]
  /** Set when the export email was found but delivers a download LINK instead
   * of an attachment (current Shopify templates). The link needs the user's
   * logged-in Shopify admin session, so the frontend opens it in the browser
   * and then lets the user pick the downloaded CSV file for import. */
  downloadUrl?: string | null
  emailFound?: boolean
}

/**
 * Look for a Shopify customers-CSV export in the order mailbox and import it.
 *
 * Flow (user-facing): on the Customers page, click "Sync Customers" → the app
 * opens the Shopify admin customers page → the user clicks Export there and
 * Shopify emails the CSV to the order mailbox → clicking "Check for the CSV"
 * (or waiting for the 2-minute poll) ingests the attachment.
 *
 * The email arrives from Shopify with a subject like "Customer export for
 * <store>" and the CSV as an attachment. Every row is matched against an
 * existing customer by shopify_id → email → phone → the "Shopify Customer
 * #<id>" placeholder convention, so the import fills redacted rows instead of
 * duplicating them. Rows that match nothing new get a customer row keyed on
 * their email address, which future syncs merge by email.
 */
export async function pollCustomerExport(): Promise<CustomerExportResult> {
  const res: CustomerExportResult = { ok: false, scanned: 0, attachmentsFound: 0, imported: 0, updated: 0, errors: [] }
  if (!isEmailIngestConfigured()) {
    res.errors.push('Email ingestion not configured (ORDER_EMAIL_ADDRESS / ORDER_EMAIL_PASSWORD)')
    return res
  }
  const { importCustomersFromCSV } = await import('./shopifyDataEnhance')
  const cfg = emailConfig()
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    emitLogs: false,
  })
  // Socket errors (DNS failures, TLS resets) can fire on the underlying
  // socket outside the awaited connect() call — without a listener they
  // escape as uncaughtException and kill the whole backend. Poll failures
  // are already reported through res.errors / the catch below.
  client.on('error', () => {})
  try {
    await client.connect()
    await client.mailboxOpen(cfg.folder)
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    for await (const msg of client.fetch({ since }, { envelope: true, source: true, uid: true })) {
      res.scanned++
      if (!msg.source) continue
      try {
        const parsed = await simpleParser(msg.source)
        const subject = clean(parsed.subject ?? '')
        // Only customer-export notifications, not order notifications. Shopify
        // titles the email "Export of your customers".
        if (!/export of your customers|customer export|export.*customers|customers.*csv/i.test(subject)) continue
        res.emailFound = true
        // Shopify delivers the export two ways: as a .csv attachment, or (the
        // current template) as a "customers_export.csv" download link in the
        // body. The link requires the user's admin browser session (verified:
        // API token gets 401), so attachments are imported here while links are
        // handed back to the UI for the user to download and pick.
        const attachments = (parsed.attachments ?? []).filter((a) => /\.csv$/i.test(a.filename ?? ''))
        if (attachments.length > 0) {
          res.attachmentsFound += attachments.length
          for (const att of attachments) {
            const rows = parseCsvContent(att.content.toString('utf8'))
            if (rows.length === 0) {
              res.errors.push(`No rows parsed from ${att.filename ?? 'attachment'}`)
              continue
            }
            const result = await importCustomersFromCSV(rows)
            res.imported += result.imported
            res.updated += result.updated
            res.errors.push(...result.errors)
          }
        } else if (!res.downloadUrl) {
          const html = typeof parsed.html === 'string' ? parsed.html : ''
          const text = parsed.text ?? ''
          // Plain-text body renders the link as "( https://…/customers_export.csv/download )".
          const fromText = [...text.matchAll(/\(\s*(https:\/\/[^)\s]+\.csv\/download)\s*\)/g)].map((m) => m[1])
          const fromHtml = [...html.matchAll(/https:\/\/[^\s"'<>]+\/admin\/files\/[\w]+\/[^\s"'<>]*?\.csv\/download/g)].map((m) => m[0])
          const link = [...new Set([...fromText, ...fromHtml])][0]
          if (link) res.downloadUrl = link
        }
        logger.info({ subject, attachments: attachments.length, downloadUrl: res.downloadUrl ?? null, imported: res.imported, updated: res.updated }, 'Customer export email processed')
      } catch (err) {
        res.errors.push(err instanceof Error ? err.message : 'customer export parse error')
      }
    }
    res.ok = res.errors.length === 0
  } catch (err) {
    res.errors.push(err instanceof Error ? err.message : 'Unknown IMAP error')
    logger.error({ err: res.errors[0] }, 'Customer export ingestion failed')
  } finally {
    try {
      await client.logout()
    } catch { /* already closed */ }
  }
  return res
}

/** Minimal RFC 4180 CSV parser (quoted fields, embedded commas, CRLF). */
export function parseCsvContent(csv: string): Record<string, string>[] {
  const parseLine = (line: string): string[] => {
    const out: string[] = []
    let cur = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++ }
          else inQuotes = false
        } else cur += ch
      } else if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        out.push(cur)
        cur = ''
      } else {
        cur += ch
      }
    }
    out.push(cur)
    return out.map((v) => v.trim())
  }
  const lines = csv.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((l) => l.trim() !== '')
  if (lines.length < 2) return []
  const headers = parseLine(lines[0])
  const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i])
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => { row[h] = values[idx] ?? '' })
    rows.push(row)
  }
  return rows
}

async function recountAfterIngest(res: IngestResult): Promise<void> {
  if (res.updated === 0 && res.created === 0) return
  try {
    await recountCustomerStatsBoth()
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Customer stats recount after ingest failed')
  }
}

export async function pollOrderMailbox(): Promise<IngestResult> {
  const res: IngestResult = { ok: false, scanned: 0, parsed: 0, updated: 0, created: 0, errors: [] }
  if (!isEmailIngestConfigured()) {
    res.errors.push('Email ingestion not configured (ORDER_EMAIL_ADDRESS / ORDER_EMAIL_PASSWORD)')
    return res
  }
  if (running) {
    res.errors.push('Poll already in progress')
    return res
  }
  running = true
  const cfg = emailConfig()
  if (emailProvider() === 'mailtm') {
    try {
      await pollMailtm(cfg, res)
      res.ok = true
      logger.info({ scanned: res.scanned, parsed: res.parsed, updated: res.updated, created: res.created }, 'Order email ingestion complete (mail.tm)')
      await recountAfterIngest(res)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown mail.tm error'
      res.errors.push(message)
      logger.error({ err: message }, 'Order email ingestion failed')
    } finally {
      running = false
    }
    return res
  }
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    emitLogs: false,
  })
  // Same guard as the customer-export poller: without an 'error' listener a
  // stray socket reset (DNS flap, TLS reset) crashes the backend process.
  client.on('error', () => {})
  try {
    await client.connect()
    await client.mailboxOpen(cfg.folder)
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    for await (const msg of client.fetch({ since }, { envelope: true, source: true, uid: true })) {
      res.scanned++
      if (!msg.source) continue
      try {
        const parsed = await simpleParser(msg.source)
        const subject = clean(parsed.subject)
        // Customer-export emails ("Export of your customers") are handled by
        // the CSV watcher, not here.
        if (/export of your customers|customer export|export.*customers|customers.*csv/i.test(subject)) continue
        // Only order notifications — skip shipping/refund/etc.
        if (!parseOrderNumberFromSubject(subject)) continue
        if (/refund|return|cancel|cxl|shipping|fulfill|delivery/i.test(subject)) continue
        // Shopify's "send test notification" button uses fake order #9999 — skip
        // only that. Real orders in test mode carry [Testing] and MUST sync.
        if (/\[testing\]/i.test(subject) && /#9999\b/.test(subject)) continue
        const data = parseOrderEmail(parsed)
        if (!data) continue
        res.parsed++
        const merged = await mergeOrderData(data)
        if (merged.updated) res.updated++
        if (merged.created) res.created++
        // Auto-raise the tax invoice with the full customer snapshot
        try {
          const inv = await autoInvoiceOrder(data)
          if (inv.created) logger.info({ order: `#${data.orderNumber}`, invoice: inv.invoiceNumber }, 'Auto-invoice created from order email')
        } catch (invErr) {
          logger.error({ err: invErr instanceof Error ? invErr.message : String(invErr), order: data.orderNumber }, 'Auto-invoice failed')
        }
      } catch (err) {
        res.errors.push(err instanceof Error ? err.message : 'parse error')
      }
    }
    res.ok = true
    logger.info({ scanned: res.scanned, parsed: res.parsed, updated: res.updated, created: res.created }, 'Order email ingestion complete')
    await recountAfterIngest(res)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown IMAP error'
    res.errors.push(message)
    logger.error({ err: message }, 'Order email ingestion failed')
  } finally {
    try {
      await client.logout()
    } catch {
      try {
        client.close()
      } catch { /* already closed */ }
    }
    running = false
  }
  return res
}

// ─── Instant sync: IMAP IDLE push + webhook kicks ───────────────────

let idleClient: ImapFlow | null = null
let idleStopped = false
let idleReconnectTimer: ReturnType<typeof setTimeout> | null = null

function scheduleIdleReconnect(): void {
  if (idleStopped || idleReconnectTimer) return
  idleReconnectTimer = setTimeout(() => {
    idleReconnectTimer = null
    startImapIdle().catch(() => {})
  }, 10_000)
}

/**
 * Persistent IMAP connection using IDLE (push). Gmail fires an `exists` event
 * the moment a new email lands, so order notifications are processed within
 * seconds instead of waiting for the next interval poll.
 */
async function startImapIdle(): Promise<void> {
  if (idleStopped || idleClient) return
  if (emailProvider() !== 'imap' || !isEmailIngestConfigured()) return
  const cfg = emailConfig()
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    emitLogs: false,
  })
  idleClient = client
  client.on('exists', () => {
    logger.info('IMAP IDLE: new email detected — syncing order data now')
    // Short delay so the message is fully delivered; second sweep as insurance.
    setTimeout(() => { pollOrderMailbox().catch(() => {}) }, 2_000)
    setTimeout(() => { pollOrderMailbox().catch(() => {}) }, 30_000)
  })
  client.on('error', (err) => {
    logger.warn({ err: err instanceof Error ? err.message : 'unknown' }, 'IMAP IDLE connection error')
  })
  client.on('close', () => {
    if (idleClient === client) idleClient = null
    scheduleIdleReconnect()
  })
  try {
    await client.connect()
    await client.mailboxOpen(cfg.folder)
    logger.info({ host: cfg.host, mailbox: cfg.folder }, 'IMAP IDLE listener connected — new order emails sync instantly')
  } catch (err) {
    if (idleClient === client) idleClient = null
    scheduleIdleReconnect()
    throw err
  }
}

/**
 * Trigger immediate mailbox polls (no-op when not configured). Used by the
 * Shopify order webhook: the webhook is the instant signal, the notification
 * email carries the full customer data — poll now and again shortly after
 * to cover email delivery lag.
 */
export function kickEmailIngest(): void {
  if (!isEmailIngestConfigured()) return
  setTimeout(() => { pollOrderMailbox().catch(() => {}) }, 1_000)
  setTimeout(() => { pollOrderMailbox().catch(() => {}) }, 30_000)
}

// ─── mail.tm REST provider (no IMAP needed) ───────────────────────

const MAILTM_API = 'https://api.mail.tm'

interface MailTmMessageSummary {
  id: string
  subject?: string
  from?: { address?: string; name?: string }
  createdAt?: string
}

interface MailTmMessageFull extends MailTmMessageSummary {
  text?: string
  html?: string[] | string
}

async function mailtmToken(user: string, pass: string): Promise<string> {
  const res = await fetch(`${MAILTM_API}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: user, password: pass }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`mail.tm auth failed (${res.status}) — check ORDER_EMAIL_ADDRESS / ORDER_EMAIL_PASSWORD`)
  const data = (await res.json()) as { token: string }
  return data.token
}

async function pollMailtm(cfg: { user: string; pass: string }, res: IngestResult): Promise<void> {
  const token = await mailtmToken(cfg.user, cfg.pass)
  const headers = { Authorization: `Bearer ${token}` }
  const since = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000

  for (let page = 1; page <= 5; page++) {
    const listRes = await fetch(`${MAILTM_API}/messages?page=${page}`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    })
    if (!listRes.ok) throw new Error(`mail.tm list failed (${listRes.status})`)
    const list = (await listRes.json()) as { 'hydra:member'?: MailTmMessageSummary[] }
    const messages = list['hydra:member'] ?? []
    if (messages.length === 0) break

    for (const m of messages) {
      if (m.createdAt && new Date(m.createdAt).getTime() < since) continue
      res.scanned++
      const subject = clean(m.subject)
      if (!parseOrderNumberFromSubject(subject)) continue
      if (/refund|return|cancel|cxl|shipping|fulfill|delivery/i.test(subject)) continue
      // Shopify's "send test notification" button uses fake order #9999 — skip
      // only that. Real orders in test mode carry [Testing] and MUST sync.
      if (/\[testing\]/i.test(subject) && /#9999\b/.test(subject)) continue
      try {
        const fullRes = await fetch(`${MAILTM_API}/messages/${m.id}`, {
          headers,
          signal: AbortSignal.timeout(20_000),
        })
        if (!fullRes.ok) continue
        const full = (await fullRes.json()) as MailTmMessageFull
        const html = Array.isArray(full.html) ? full.html.join('\n') : full.html
        // Reuse the same parser via a minimal ParsedMail-compatible object.
        const mailLike = { subject, text: full.text ?? '', html: html ?? false } as unknown as Parameters<typeof parseOrderEmail>[0]
        const data = parseOrderEmail(mailLike)
        if (!data) continue
        res.parsed++
        const merged = await mergeOrderData(data)
        if (merged.updated) res.updated++
        if (merged.created) res.created++
      } catch (err) {
        res.errors.push(err instanceof Error ? err.message : 'mail.tm fetch error')
      }
    }
  }
}

export function startOrderEmailIngest(): void {
  if (pollTimer) return
  if (!isEmailIngestConfigured()) {
    logger.debug('Order email ingestion not configured — skipping scheduler')
    return
  }
  // Initial poll after a short delay so boot isn't blocked
  setTimeout(() => {
    pollOrderMailbox().catch(() => {})
  }, 15_000)
  pollTimer = setInterval(() => {
    pollOrderMailbox().catch(() => {})
  }, POLL_INTERVAL_MS)
  // Instant sync: persistent IDLE connection pushes new-email events immediately
  if (emailProvider() === 'imap') {
    setTimeout(() => {
      startImapIdle().catch((err) => {
        logger.warn({ err: err instanceof Error ? err.message : 'unknown' }, 'IMAP IDLE listener failed to start — falling back to interval polling')
      })
    }, 20_000)
  }
  logger.info(
    { intervalMinutes: POLL_INTERVAL_MS / 60000, provider: emailProvider(), instant: emailProvider() === 'imap' },
    'Order email ingestion scheduler started',
  )
}

export function stopOrderEmailIngest(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  idleStopped = true
  if (idleReconnectTimer) {
    clearTimeout(idleReconnectTimer)
    idleReconnectTimer = null
  }
  if (idleClient) {
    const c = idleClient
    idleClient = null
    c.close()
  }
}
