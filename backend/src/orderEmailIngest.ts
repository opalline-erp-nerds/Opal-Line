import 'dotenv/config'
import { ImapFlow } from 'imapflow'
import { simpleParser, type ParsedMail } from 'mailparser'
import { and, eq, or, sql } from 'drizzle-orm'
import { db } from './db/client'
import * as schema from './db/schema'
import { invoiceTotals } from './invoiceTotals'
import { getLatestSilverRate } from './shopify'
import { decryptSecret } from './lib/crypto'
import { recountCustomerStatsBoth } from './customerStats'
import { applyStockMovement, resolveMovementLocation } from './stock'
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
        name: realName,
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
 * Deduct sold quantity from product stock. Never blocks invoicing on stock gaps.
 *
 * Email orders carry no shop, so they deduct from the default location unless
 * the order row already records one — which keeps a later reversal (edit or
 * cancellation) landing on the same balance the deduction did.
 */
async function deductStock(tx: any, sku: string, qty: number, locationId?: string | null): Promise<void> {
  if (!sku || !qty) return
  try {
    await applyStockMovement({
      sku,
      qty: -qty,
      type: 'sale_out',
      refType: 'email_order',
      locationId: await resolveMovementLocation(locationId ?? null, tx),
      tx,
    })
  } catch { /* stock tracking optional for email orders */ }
}

export interface CreateInvoiceOptions {
  /**
   * Move stock out for each invoiced item (default true). The Shopify order
   * import passes false: it already moved stock when the order row was
   * inserted, so invoicing must not deduct it a second time.
   */
  deductStock?: boolean
}

/**
 * Raise a tax invoice for any order row (email-synced or manual).
 * Idempotent: returns the existing invoice number if one is already linked.
 * Returns null when the order has no line items to invoice.
 */
export async function createInvoiceForOrderRow(
  order: typeof schema.salesOrders.$inferSelect,
  opts: CreateInvoiceOptions = {},
): Promise<string | null> {
  if (!db) return null
  if (order.invoice) return order.invoice
  const lineItems = Array.isArray(order.lineItems) ? (order.lineItems as OrderEmailData['items']) : []
  if (lineItems.length === 0) return null

  // Detect manual orders (created via ERP, not imported from Shopify)
  const isManualOrder = (order.tags ?? '').includes('manual-order') || !(order.shopifyId ?? '').startsWith('#')

  // Settings: gst rate + invoice prefix
  const [settingsRow] = await db.select().from(schema.settings).where(eq(schema.settings.id, 'app')).limit(1)
  const gstRate = Number(settingsRow?.gstRate ?? 3)
  const prefix = settingsRow?.invoicePrefix?.trim() || 'INV-'
  const payment = order.payment === 'paid' ? 'Online' : order.payment === 'cod' ? 'COD' : 'Pending'

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

  let items: Array<{
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
  }>
  let shopifySubtotal: number
  let erpSilverValue: number
  let erpMakingCharge: number
  let erpSubtotal: number
  let silverValue: number
  let makingCharge: number
  let subtotal: number
  let effectiveDiscount: number
  let gstAmount: number
  let grandTotal: number
  const discount = Number(order.discount ?? 0)

  if (isManualOrder) {
    // Manual orders: lineItems already contain ERP components (silverValue, makingValue, amount as subtotal, weight, silverRate, makingCharge)
    // Use them directly to ensure invoice totals match order totals exactly.
    items = lineItems.map((li) => {
      const qty = Number(li.quantity ?? 0)
      const weight = Number(li.weight ?? 0)
      const itemSilverRate = Number(li.silverRate ?? 0)
      const itemMakingCharge = Number(li.makingCharge ?? 0)
      const silverValue = Number(li.silverValue ?? (weight > 0 ? round2(weight * itemSilverRate) : 0))
      const makingValue = Number(li.makingValue ?? (weight > 0 ? round2(weight * itemMakingCharge) : 0))
      const amount = Number(li.amount ?? round2(silverValue + makingValue))
      return {
        product: String(li.title ?? '').trim(),
        sku: String(li.sku ?? ''),
        qty,
        weight,
        silverRate: itemSilverRate,
        makingCharge: itemMakingCharge,
        tax: round2((amount * gstRate) / 100),
        amount,      // Line subtotal (ex-GST)
        silverValue,
        makingValue,
      }
    })
    shopifySubtotal = round2(items.reduce((a, it) => a + it.amount, 0))
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
    // Shopify orders: the customer has already paid a specific price (Shopify price).
    // The invoice is a tax document for that transaction. The component breakdown MUST use
    // the actual Silver Rate Management rate. If the ERP-calculated subtotal differs from
    // the Shopify billed amount, the difference is reflected as a discount/adjustment.
    // This ensures the displayed rate equals the actual Silver Rate Management rate.
    items = lineItems.map((li) => {
      const qty = Number(li.quantity ?? 0)
      const price = Number(li.price ?? 0)
      const amount = Math.round(price * qty * 100) / 100
      // Product snapshot: net weight, making charge from catalogue.
      // Silver rate comes from Silver Rate Management (authoritative source).
      const product = productMap[String(li.sku ?? '')] ?? { netWeight: 0, makingCharge: 0 }
      const weight = product.netWeight > 0 ? Math.round(product.netWeight * qty * 1000) / 1000 : 0
      // Silver rate is the actual rate for items with weight > 0, 0 for zero-weight items
      const itemSilverRate = weight > 0 ? silverRate : 0
      return {
        product: String(li.title ?? '').trim(),
        sku: String(li.sku ?? ''),
        qty,
        weight,
        silverRate: itemSilverRate,  // Actual Silver Rate Management rate (0 for zero-weight items)
        makingCharge: product.makingCharge,
        tax: Math.round(((amount * gstRate) / 100) * 100) / 100,
        amount,      // Shopify billed amount per line
      }
    })
    shopifySubtotal = Math.round(items.reduce((a, it) => a + it.amount, 0) * 100) / 100

    // ERP-calculated components using ACTUAL Silver Rate Management rate
    erpSilverValue = Math.round(items.reduce((a, it) => a + it.weight * it.silverRate, 0) * 100) / 100
    erpMakingCharge = Math.round(items.reduce((a, it) => a + it.makingCharge * it.weight, 0) * 100) / 100
    erpSubtotal = round2(erpSilverValue + erpMakingCharge)

    // If ERP subtotal differs from Shopify billed amount, the difference is a discount/adjustment.
    // The invoice subtotal for tax purposes is the ERP subtotal.
    const adjustment = round2(erpSubtotal - shopifySubtotal)
    effectiveDiscount = discount + (adjustment > 0 ? adjustment : 0)
    subtotal = erpSubtotal
    const totals = invoiceTotals(subtotal, gstRate, effectiveDiscount)
    gstAmount = totals.gstAmount
    grandTotal = totals.grandTotal

    // Header totals use ERP-calculated components (no scaling)
    silverValue = erpSilverValue
    makingCharge = erpMakingCharge
  }

  // Customer snapshot: customer record first, then the order's addresses
  const [customer] = order.customer
    ? await db.select().from(schema.customers).where(eq(schema.customers.name, order.customer)).limit(1)
    : []
  const addr = (order.shippingAddress && (order.shippingAddress as Record<string, string>).address1)
    ? order.shippingAddress as Record<string, string>
    : (order.billingAddress as Record<string, string> | null) ?? {}
  const address1 = String(addr.address1 ?? '')
  const address2 = String(addr.address2 ?? '')

  const number = await nextInvoiceNumber(prefix)
  const invoiceId = crypto.randomUUID()
  try {
    await db.transaction(async (tx) => {
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
      const storedDiscount = effectiveDiscount
      await tx.insert(schema.salesInvoices).values({
        id: invoiceId,
        number,
        shopifyOrder: order.shopifyId ?? null,
        customer: order.customer,
        customerEmail: customer?.email ?? '',
        customerPhone: customer?.phone ?? String(addr.phone ?? ''),
        customerAddress: [address1, address2].filter(Boolean).join(', '),
        customerCity: String(addr.city ?? customer?.city ?? ''),
        customerState: String(addr.province ?? customer?.province ?? ''),
        customerPincode: String(addr.zip ?? ''),
        silverValue,
        makingCharge,
        subtotal,
        gst: gstRate,
        gstAmount,
        discount: storedDiscount,
        grandTotal,
        paymentMethod: payment,
        paymentStatus: order.payment,
        status: order.payment === 'paid' ? 'paid' : 'issued',
        date: order.date ?? new Date().toISOString(),
      })
      const orderLocationId = (order as { locationId?: string | null }).locationId ?? null
      for (const it of items) {
        await tx.insert(schema.salesInvoiceItems).values({ ...it, id: crypto.randomUUID(), invoiceId })
        // Deduct stock for the sold SKU, same rule as manual invoices. The
        // order's own location is honoured so the deduction and any later
        // reversal agree on which balance they touch. Skipped when the caller
        // already moved stock (Shopify order import).
        if (opts.deductStock !== false) {
          await deductStock(tx, it.sku, it.qty, orderLocationId)
        }
      }
    })
  } catch (err) {
    if ((err as Error & { code?: string }).code !== 'ORDER_ALREADY_INVOICED') throw err
    // Another request claimed the order first — return its invoice number
    // instead of failing or, worse, inserting a duplicate.
    const [fresh] = await db.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, order.id)).limit(1)
    if (fresh?.invoice) {
      logger.info({ orderId: order.id, invoice: fresh.invoice }, 'order already invoiced; reusing the linked invoice')
      return fresh.invoice
    }
    throw err
  }

  // Loyalty: award points for this invoice (fire-and-forget, never blocks sync)
  void import('./loyalty').then(({ earnForInvoice }) =>
    earnForInvoice({ id: invoiceId, number, customer: order.customer ?? '', grandTotal, status: order.payment === 'paid' ? 'paid' : 'issued' }),
  )
  // E-invoicing: in `automatic` mode the IRN must be generated for invoices
  // raised by THIS pipeline (fulfilment, email sync) too — not only for
  // invoices created through POST /invoices. Fire-and-forget, same rule as
  // the manual route: a gateway failure must never fail the invoice.
  void import('./einvoice')
    .then(async ({ resolveEInvoiceMode, generateEInvoiceForInvoice }) => {
      if ((await resolveEInvoiceMode()) !== 'automatic') return
      const result = await generateEInvoiceForInvoice(invoiceId)
      if (!result.ok) logger.error({ err: result.error, invoice: number }, 'automatic IRN generation failed for auto-raised invoice')
    })
    .catch(() => undefined)
  return number
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
