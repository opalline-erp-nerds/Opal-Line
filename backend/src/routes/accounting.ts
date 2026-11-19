import { Router, type Request, type Response } from 'express'
import { eq, and, gte, lte, desc, sql } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { accounts, journalEntries, journalEntryLines, salesInvoices } from '../db/schema'
import { requireAuth } from '../sessions'
import { requirePermission } from '../rbac'
import { randomBytes } from 'node:crypto'
import { logger } from '../logger'
import { routeParam } from '../lib/routeParams'
import { ensureDefaultAccounts, postJournalEntry, toIsoDate, ACCOUNT_CODES } from '../accounting/journal'
import { postSalesInvoiceJournal } from '../accounting/postings'

const router = Router()
const round2 = (n: number) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100

const entrySource = (e: { source?: string | null; reference?: string | null; referenceType?: string | null; isAuto?: boolean | null }) => {
  const stored = String(e.source ?? '').toLowerCase()
  if (stored === 'shopify' || stored === 'erp' || stored === 'manual' || stored === 'system') return stored
  return String(e.reference ?? '').startsWith('#') || String(e.referenceType ?? '').includes('shopify') ? 'shopify' : (e.isAuto ? 'erp' : 'manual')
}

// GET /api/v1/accounts — list all accounts
router.get('/', requireAuth, requirePermission('accounts', 'view'), async (_req: Request, res: Response) => {
  if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
  try {
    await ensureDefaultAccounts()
    const rows = await db.select().from(accounts).orderBy(accounts.code)
    res.json(rows)
  } catch (err) {
    logger.error({ err }, 'Failed to list accounts')
    res.status(500).json({ error: 'Failed to fetch accounts' })
  }
})

// POST /api/v1/accounts — create account
router.post('/', requireAuth, requirePermission('accounts', 'edit'), async (req: Request, res: Response) => {
  if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
  try {
    const { code, name, type, subType, parentId, isGroup, openingBalance, currency, branchId } = req.body ?? {}
    if (!code || !name || !type) {
      res.status(400).json({ error: 'code, name, and type are required' }); return
    }
    const id = `ACC-${randomBytes(6).toString('hex')}`
    const [row] = await db.insert(accounts).values({
      id,
      code: String(code).trim(),
      name: String(name).trim(),
      type: String(type),
      subType: subType ? String(subType) : null,
      parentId: parentId ? String(parentId) : null,
      isGroup: Boolean(isGroup),
      openingBalance: Number(openingBalance) || 0,
      currentBalance: Number(openingBalance) || 0,
      currency: currency ? String(currency) : 'INR',
      branchId: branchId ? String(branchId) : null,
      isActive: true,
      createdAt: new Date().toISOString(),
    }).returning()
    res.status(201).json(row)
  } catch (err) {
    logger.error({ err }, 'Failed to create account')
    res.status(500).json({ error: 'Failed to create account' })
  }
})

// PATCH /api/v1/accounts/:id — update account
router.patch('/:id', requireAuth, requirePermission('accounts', 'edit'), async (req: Request, res: Response) => {
  if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
  try {
    const accountId = routeParam(req.params.id)
    const updates: Record<string, unknown> = {}
    const { name, type, subType, parentId, isGroup, isActive, branchId } = req.body ?? {}
    if (name !== undefined) updates.name = String(name).trim()
    if (type !== undefined) updates.type = String(type)
    if (subType !== undefined) updates.subType = String(subType)
    if (parentId !== undefined) updates.parentId = String(parentId)
    if (isGroup !== undefined) updates.isGroup = Boolean(isGroup)
    if (isActive !== undefined) updates.isActive = Boolean(isActive)
    if (branchId !== undefined) updates.branchId = String(branchId)
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No fields to update' }); return
    }
    const [row] = await db.update(accounts).set(updates).where(eq(accounts.id, accountId)).returning()
    if (!row) { res.status(404).json({ error: 'Account not found' }); return }
    res.json(row)
  } catch (err) {
    logger.error({ err }, 'Failed to update account')
    res.status(500).json({ error: 'Failed to update account' })
  }
})

// GET /api/v1/accounts/journal-entries — list with filters
router.get('/journal-entries', requireAuth, requirePermission('accounts', 'view'), async (req: Request, res: Response) => {
  if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
  try {
    const { dateFrom, dateTo, referenceType, source } = req.query as Record<string, string | undefined>
    const conditions = []
    if (dateFrom) conditions.push(gte(journalEntries.date, dateFrom))
    if (dateTo) conditions.push(lte(journalEntries.date, dateTo))
    if (referenceType) conditions.push(eq(journalEntries.referenceType, referenceType))
    const where = conditions.length > 0 ? and(...conditions) : undefined
    const rows = await db.select().from(journalEntries).where(where).orderBy(desc(journalEntries.date))
    const filtered = source && source !== 'all' ? rows.filter((r) => entrySource(r) === source) : rows
    res.json(filtered)
  } catch (err) {
    logger.error({ err }, 'Failed to list journal entries')
    res.status(500).json({ error: 'Failed to fetch journal entries' })
  }
})

// POST /api/v1/accounts/journal-entries — create manual journal entry
router.post('/journal-entries', requireAuth, requirePermission('accounts', 'edit'), async (req: Request, res: Response) => {
  if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
  try {
    const { date, description, reference, referenceType, referenceId, lines } = req.body ?? {}
    if (!date || !Array.isArray(lines) || lines.length < 2) {
      res.status(400).json({ error: 'date and at least 2 lines are required' }); return
    }
    const result = await postJournalEntry({
      date: toIsoDate(date),
      description: description ? String(description) : null,
      reference: reference ? String(reference) : null,
      referenceType: referenceType ? String(referenceType) : 'manual',
      referenceId: referenceId ? String(referenceId) : `manual-${randomBytes(6).toString('hex')}`,
      source: 'manual',
      createdBy: req.userId ?? null,
      isAuto: false,
      lines: lines.map((line: any) => ({
        accountCode: line.accountCode,
        accountId: line.accountId,
        debit: Number(line.debit) || 0,
        credit: Number(line.credit) || 0,
        description: line.description ? String(line.description) : undefined,
      })),
    })
    res.status(result.created ? 201 : 200).json(result)
  } catch (err) {
    logger.error({ err }, 'Failed to create journal entry')
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create journal entry' })
  }
})

// GET /api/v1/accounts/trial-balance
router.get('/trial-balance', requireAuth, requirePermission('accounts', 'view'), async (req: Request, res: Response) => {
  if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
  try {
    await ensureDefaultAccounts()
    const { dateFrom, dateTo } = req.query as Record<string, string | undefined>
    const conditions = []
    if (dateFrom) conditions.push(gte(journalEntries.date, dateFrom))
    if (dateTo) conditions.push(lte(journalEntries.date, dateTo))
    const where = conditions.length > 0 ? and(...conditions) : undefined

    const rows = await db
      .select({
        accountId: accounts.id,
        accountCode: accounts.code,
        accountName: accounts.name,
        accountType: accounts.type,
        totalDebit: sql<number>`COALESCE(SUM(${journalEntryLines.debit}), 0)`.as('total_debit'),
        totalCredit: sql<number>`COALESCE(SUM(${journalEntryLines.credit}), 0)`.as('total_credit'),
      })
      .from(accounts)
      .leftJoin(journalEntryLines, eq(journalEntryLines.accountId, accounts.id))
      .leftJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
      .where(where)
      .groupBy(accounts.id, accounts.code, accounts.name, accounts.type)
      .orderBy(accounts.code)

    const balanceSheet = rows.map((r) => ({
      ...r,
      balance: Number(r.totalDebit) - Number(r.totalCredit),
    }))

    const totalDebit = balanceSheet.reduce((s, r) => s + Number(r.totalDebit), 0)
    const totalCredit = balanceSheet.reduce((s, r) => s + Number(r.totalCredit), 0)

    res.json({ accounts: balanceSheet, totalDebit, totalCredit, isBalanced: Math.abs(totalDebit - totalCredit) < 0.01 })
  } catch (err) {
    logger.error({ err }, 'Failed to generate trial balance')
    res.status(500).json({ error: 'Failed to generate trial balance' })
  }
})

// GET /api/v1/accounts/profit-and-loss
router.get('/profit-and-loss', requireAuth, requirePermission('accounts', 'view'), async (req: Request, res: Response) => {
  if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
  try {
    await ensureDefaultAccounts()
    const { dateFrom, dateTo } = req.query as Record<string, string | undefined>
    const conditions = []
    if (dateFrom) conditions.push(gte(journalEntries.date, dateFrom))
    if (dateTo) conditions.push(lte(journalEntries.date, dateTo))
    const where = conditions.length > 0 ? and(...conditions) : undefined

    const rows = await db
      .select({
        accountId: accounts.id,
        accountCode: accounts.code,
        accountName: accounts.name,
        accountType: accounts.type,
        totalDebit: sql<number>`COALESCE(SUM(${journalEntryLines.debit}), 0)`.as('total_debit'),
        totalCredit: sql<number>`COALESCE(SUM(${journalEntryLines.credit}), 0)`.as('total_credit'),
      })
      .from(accounts)
      .leftJoin(journalEntryLines, eq(journalEntryLines.accountId, accounts.id))
      .leftJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
      .where(where)
      .groupBy(accounts.id, accounts.code, accounts.name, accounts.type)
      .orderBy(accounts.code)

    const revenue = rows
      .filter((r) => r.accountType === 'revenue')
      .map((r) => ({ ...r, amount: Number(r.totalCredit) - Number(r.totalDebit) }))
    const expenses = rows
      .filter((r) => r.accountType === 'expense')
      .map((r) => ({ ...r, amount: Number(r.totalDebit) - Number(r.totalCredit) }))

    const totalRevenue = revenue.reduce((s, r) => s + r.amount, 0)
    const totalExpenses = expenses.reduce((s, r) => s + r.amount, 0)
    const netProfit = totalRevenue - totalExpenses

    res.json({ revenue, expenses, totalRevenue, totalExpenses, netProfit })
  } catch (err) {
    logger.error({ err }, 'Failed to generate P&L')
    res.status(500).json({ error: 'Failed to generate profit and loss statement' })
  }
})

// GET /api/v1/accounts/balance-sheet
router.get('/balance-sheet', requireAuth, requirePermission('accounts', 'view'), async (_req: Request, res: Response) => {
  if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
  try {
    await ensureDefaultAccounts()
    const rows = await db
      .select({
        accountId: accounts.id,
        accountCode: accounts.code,
        accountName: accounts.name,
        accountType: accounts.type,
        totalDebit: sql<number>`COALESCE(SUM(${journalEntryLines.debit}), 0)`.as('total_debit'),
        totalCredit: sql<number>`COALESCE(SUM(${journalEntryLines.credit}), 0)`.as('total_credit'),
      })
      .from(accounts)
      .leftJoin(journalEntryLines, eq(journalEntryLines.accountId, accounts.id))
      .leftJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
      .groupBy(accounts.id, accounts.code, accounts.name, accounts.type)
      .orderBy(accounts.code)

    const assets = rows
      .filter((r) => r.accountType === 'asset')
      .map((r) => ({ ...r, balance: Number(r.totalDebit) - Number(r.totalCredit) }))
    const liabilities = rows
      .filter((r) => r.accountType === 'liability')
      .map((r) => ({ ...r, balance: Number(r.totalCredit) - Number(r.totalDebit) }))
    const equity = rows
      .filter((r) => r.accountType === 'equity')
      .map((r) => ({ ...r, balance: Number(r.totalCredit) - Number(r.totalDebit) }))

    const totalAssets = assets.reduce((s, r) => s + r.balance, 0)
    const totalLiabilities = liabilities.reduce((s, r) => s + r.balance, 0)
    const totalEquity = equity.reduce((s, r) => s + r.balance, 0)

    res.json({ assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity })
  } catch (err) {
    logger.error({ err }, 'Failed to generate balance sheet')
    res.status(500).json({ error: 'Failed to generate balance sheet' })
  }
})

// POST /api/v1/accounts/journal-entries/post/:id — auto-generate journal entry for an invoice
router.post('/journal-entries/post/:id', requireAuth, requirePermission('accounts', 'edit'), async (req: Request, res: Response) => {
  if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
  try {
    const invoiceId = routeParam(req.params.id)
    const [invoice] = await db.select().from(salesInvoices).where(eq(salesInvoices.id, invoiceId)).limit(1)
    if (!invoice) { res.status(404).json({ error: 'Invoice not found' }); return }
    const result = await postSalesInvoiceJournal(invoiceId, req.userId ?? null)
    res.status(result?.created ? 201 : 200).json(result ?? { created: false })
  } catch (err) {
    logger.error({ err }, 'Failed to post invoice to journal')
    res.status(500).json({ error: 'Failed to post invoice to journal' })
  }
})

// GET /api/v1/accounts/ledger — unified/general ledger view
router.get('/ledger', requireAuth, requirePermission('accounts', 'view'), async (req: Request, res: Response) => {
  if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
  try {
    const { dateFrom, dateTo, source, search } = req.query as Record<string, string | undefined>
    const conditions = []
    if (dateFrom) conditions.push(gte(journalEntries.date, dateFrom))
    if (dateTo) conditions.push(lte(journalEntries.date, dateTo))
    const where = conditions.length > 0 ? and(...conditions) : undefined
    const entries = await db.select().from(journalEntries).where(where).orderBy(desc(journalEntries.date)).limit(500)
    let rows = entries.map((e) => ({
      id: e.id, entryNumber: e.entryNumber, date: e.date, description: e.description, reference: e.reference,
      referenceType: e.referenceType, referenceId: e.referenceId, isAuto: e.isAuto,
      source: entrySource(e),
    }))
    if (source && source !== 'all') rows = rows.filter((r) => r.source === source)
    if (search) {
      const q = search.toLowerCase()
      rows = rows.filter((r) => `${r.entryNumber} ${r.reference ?? ''} ${r.description ?? ''} ${r.referenceType ?? ''}`.toLowerCase().includes(q))
    }
    res.json(rows)
  } catch (err) {
    logger.error({ err }, 'Failed to fetch ledger')
    res.status(500).json({ error: 'Failed to fetch ledger' })
  }
})

// GET /api/v1/accounts/dashboard — accounting dashboard KPIs from journals/real data
router.get('/dashboard', requireAuth, requirePermission('accounts', 'view'), async (req: Request, res: Response) => {
  if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
  try {
    await ensureDefaultAccounts()
    const { dateFrom, dateTo } = req.query as Record<string, string | undefined>
    const conditions = []
    if (dateFrom) conditions.push(gte(journalEntries.date, dateFrom))
    if (dateTo) conditions.push(lte(journalEntries.date, dateTo))
    const where = conditions.length > 0 ? and(...conditions) : undefined

    const sums = await db.execute(sql`
      select
        coalesce(sum(case when a.code = ${ACCOUNT_CODES.salesRevenue} then jel.credit - jel.debit else 0 end),0) as revenue,
        coalesce(sum(case when a.type = 'expense' then jel.debit - jel.credit else 0 end),0) as expenses,
        coalesce(sum(case when a.code in (${ACCOUNT_CODES.cash}, ${ACCOUNT_CODES.bank}) then jel.debit - jel.credit else 0 end),0) as bank_balance,
        coalesce(sum(case when a.code = ${ACCOUNT_CODES.receivable} then jel.debit - jel.credit else 0 end),0) as receivable,
        coalesce(sum(case when a.code = ${ACCOUNT_CODES.payable} then jel.credit - jel.debit else 0 end),0) as payable
      from journal_entry_lines jel
      join journal_entries je on je.id = jel.journal_entry_id
      join accounts a on a.id = jel.account_id
      ${where ? sql`where ${dateFrom ? sql`je.date >= ${dateFrom}` : sql`true`} and ${dateTo ? sql`je.date <= ${dateTo}` : sql`true`}` : sql``}
    ` as any)
    const row: any = (sums as any)?.rows?.[0] ?? (Array.isArray(sums) ? sums[0] : {}) ?? {}
    const revenue = round2(Number(row.revenue || 0))
    const expenses = round2(Number(row.expenses || 0))
    const profit = round2(revenue - expenses)

    const [invoiceCount] = await db.select({ count: sql<number>`count(*)` }).from(schema.salesInvoices)
    const [expenseCount] = await db.select({ count: sql<number>`count(*)` }).from(schema.expenses)
    const [shopifyOrders] = await db.select({ count: sql<number>`count(*)` }).from(schema.salesOrders).where(sql`${schema.salesOrders.shopifyId} is not null`)
    res.json({
      revenue, expenses, profit,
      bankBalance: round2(Number(row.bank_balance || 0)),
      receivable: round2(Number(row.receivable || 0)),
      payable: round2(Number(row.payable || 0)),
      counts: { invoices: Number(invoiceCount?.count ?? 0), expenses: Number(expenseCount?.count ?? 0), shopifyOrders: Number(shopifyOrders?.count ?? 0) },
    })
  } catch (err) {
    logger.error({ err }, 'Failed to fetch accounting dashboard')
    res.status(500).json({ error: 'Failed to fetch accounting dashboard' })
  }
})

// GET /api/v1/accounts/unified-transactions — real transactions view with source filter
router.get('/unified-transactions', requireAuth, requirePermission('accounts', 'view'), async (req: Request, res: Response) => {
  if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
  try {
    const { source = 'all', limit = '100' } = req.query as Record<string, string>
    const lim = Math.min(Number(limit) || 100, 500)
    const out: any[] = []
    const [invoices, purchases, expenses, payments, orders, refunds, salesReturns, purchaseReturns] = await Promise.all([
      db.select().from(schema.salesInvoices).orderBy(desc(schema.salesInvoices.date)).limit(lim),
      db.select().from(schema.purchaseInvoices).orderBy(desc(schema.purchaseInvoices.date)).limit(lim),
      db.select().from(schema.expenses).orderBy(desc(schema.expenses.date)).limit(lim),
      db.select().from(schema.payments).orderBy(desc(schema.payments.date)).limit(lim),
      db.select().from(schema.salesOrders).where(sql`${schema.salesOrders.shopifyId} is not null`).orderBy(desc(schema.salesOrders.date)).limit(lim),
      db.select().from(schema.refunds).orderBy(desc(schema.refunds.createdAt)).limit(lim),
      db.select().from(schema.salesReturns).orderBy(desc(schema.salesReturns.date)).limit(lim),
      db.select().from(schema.purchaseReturns).orderBy(desc(schema.purchaseReturns.date)).limit(lim),
    ])
    for (const inv of invoices) out.push({ id: inv.id, date: inv.date, type: 'Sales Invoice', ref: inv.number, customer: inv.customer, amount: inv.grandTotal, status: inv.paymentStatus || inv.status, source: inv.shopifyOrder ? 'shopify' : 'erp' })
    for (const p of purchases) out.push({ id: p.id, date: p.date, type: 'Purchase Invoice', ref: p.number, customer: p.supplier, amount: p.total, status: p.status, source: 'erp' })
    for (const e of expenses) out.push({ id: e.id, date: e.date, type: 'Expense', ref: e.category, customer: e.by, amount: e.amount, status: e.status, source: 'erp' })
    for (const p of payments) out.push({ id: p.id, date: p.date, type: 'Payment', ref: p.ref || p.invoice, customer: p.customer, amount: p.amount, status: p.status, source: p.gateway ? 'shopify' : 'erp' })
    for (const o of orders) out.push({ id: o.id, date: o.date, type: 'Shopify Order', ref: o.shopifyId, customer: o.customer, amount: o.value, status: o.shopifyFinancialStatus || o.payment, source: 'shopify' })
    for (const r of refunds) out.push({ id: r.id, date: r.processedAt || r.createdAt, type: r.source === 'shopify' ? 'Shopify Refund' : 'Refund', ref: r.shopifyRefundId || r.number, customer: r.customer, amount: r.refundedAmount || r.amount, status: r.status, source: r.source === 'shopify' ? 'shopify' : 'erp' })
    for (const r of salesReturns) out.push({ id: r.id, date: r.date ?? r.requestedAt, type: r.source === 'shopify' ? 'Shopify Sales Return' : 'Sales Return', ref: r.creditNoteNumber || r.number, customer: r.customer, amount: r.amount, status: r.status, source: r.source === 'shopify' || String(r.order ?? '').startsWith('#') ? 'shopify' : 'erp' })
    for (const r of purchaseReturns) out.push({ id: r.id, date: r.date, type: 'Purchase Return', ref: r.number, customer: r.supplier, amount: r.amount, status: r.status, source: 'erp' })
    const filtered = source === 'all' ? out : out.filter((row) => row.source === source)
    filtered.sort((a,b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
    res.json(filtered.slice(0, lim))
  } catch (err) {
    logger.error({ err }, 'Failed to fetch unified transactions')
    res.status(500).json({ error: 'Failed to fetch unified transactions' })
  }
})

// POST /api/v1/accounts/reconcile/shopify — basic Shopify payment reconciliation (orders vs invoices/payments/refunds)
router.post('/reconcile/shopify', requireAuth, requirePermission('accounts', 'edit'), async (_req: Request, res: Response) => {
  if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
  try {
    const orders = await db.select().from(schema.salesOrders).where(sql`${schema.salesOrders.shopifyId} is not null`)
    const invoices = await db.select().from(schema.salesInvoices).where(sql`${schema.salesInvoices.shopifyOrder} is not null`)
    const refunds = await db.select().from(schema.refunds)
    const journals = await db.select({ referenceId: journalEntries.referenceId }).from(journalEntries).where(eq(journalEntries.referenceType, 'invoice'))
    const journaledInvoiceIds = new Set(journals.map((j) => String(j.referenceId ?? '')))
    const invByOrder = new Map(invoices.map((i) => [String(i.shopifyOrder), i]))
    const orderRefs = new Set(orders.map((o) => String(o.shopifyId ?? '')))
    let matched = 0, missingInvoice = 0, mismatched = 0, refunded = 0, missingJournal = 0
    const unmatchedRefunds = refunds.filter((r) => r.source === 'shopify' && r.shopifyOrder && !orderRefs.has(String(r.shopifyOrder))).length
    for (const o of orders) {
      const inv = invByOrder.get(String(o.shopifyId))
      if (!inv) { missingInvoice++; continue }
      const orderRef = String(o.shopifyId ?? '')
      const orderRefunds = refunds.filter((r) => String(r.shopifyOrder) === orderRef && r.status === 'completed')
      const refundedAmt = orderRefunds.reduce((s,r) => s + Number(r.refundedAmount ?? r.amount ?? 0), 0)
      if (refundedAmt > 0) refunded++
      const diff = Math.abs(Number(inv.grandTotal ?? 0) - Number(o.value ?? 0))
      if (!journaledInvoiceIds.has(String(inv.id))) missingJournal++
      if (diff > 1) mismatched++
      else matched++
    }
    res.json({ totalShopifyOrders: orders.length, matched, missingInvoice, mismatched, ordersWithRefunds: refunded, missingJournal, unmatchedRefunds })
  } catch (err) {
    logger.error({ err }, 'Failed to reconcile shopify')
    res.status(500).json({ error: 'Failed to reconcile shopify' })
  }
})

export default router
