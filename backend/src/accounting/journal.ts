import { randomBytes } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { recordAudit } from '../activity'

type Db = NonNullable<typeof db>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0] | Db

export const ACCOUNT_CODES = {
  cash: '1001',
  bank: '1002',
  receivable: '1003',
  inventory: '1004',
  silverInventory: '1005',
  gstInput: '1006',
  payable: '2001',
  gstOutput: '2002',
  tdsPayable: '2003',
  tcsPayable: '2004',
  equity: '3001',
  retainedEarnings: '3002',
  salesRevenue: '4001',
  otherIncome: '4002',
  cogs: '5001',
  purchaseExpense: '5002',
  makingCharges: '5003',
  operatingExpense: '5004',
  shopifyCharges: '5005',
  shippingExpense: '5006',
  discountExpense: '5007',
} as const

export interface AccountDef {
  code: string
  name: string
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
  subType: string
}

export const ACCOUNT_DEFS: AccountDef[] = [
  { code: '1001', name: 'Cash in Hand', type: 'asset', subType: 'current_asset' },
  { code: '1002', name: 'Bank Account', type: 'asset', subType: 'current_asset' },
  { code: '1003', name: 'Accounts Receivable', type: 'asset', subType: 'current_asset' },
  { code: '1004', name: 'Inventory', type: 'asset', subType: 'current_asset' },
  { code: '1005', name: 'Silver Inventory', type: 'asset', subType: 'current_asset' },
  { code: '1006', name: 'GST Input Credit', type: 'asset', subType: 'current_asset' },
  { code: '2001', name: 'Accounts Payable', type: 'liability', subType: 'current_liability' },
  { code: '2002', name: 'GST Output', type: 'liability', subType: 'current_liability' },
  { code: '2003', name: 'TDS Payable', type: 'liability', subType: 'current_liability' },
  { code: '2004', name: 'TCS Payable', type: 'liability', subType: 'current_liability' },
  { code: '3001', name: "Owner's Equity", type: 'equity', subType: 'equity' },
  { code: '3002', name: 'Retained Earnings', type: 'equity', subType: 'equity' },
  { code: '4001', name: 'Sales Revenue', type: 'revenue', subType: 'operating_revenue' },
  { code: '4002', name: 'Other Income', type: 'revenue', subType: 'other_income' },
  { code: '5001', name: 'Cost of Goods Sold', type: 'expense', subType: 'cost_of_goods_sold' },
  { code: '5002', name: 'Purchase Expense', type: 'expense', subType: 'cost_of_goods_sold' },
  { code: '5003', name: 'Making Charges', type: 'expense', subType: 'direct_expense' },
  { code: '5004', name: 'Operating Expenses', type: 'expense', subType: 'operating_expense' },
  { code: '5005', name: 'Shopify Charges', type: 'expense', subType: 'operating_expense' },
  { code: '5006', name: 'Shipping Expense', type: 'expense', subType: 'operating_expense' },
  { code: '5007', name: 'Discounts Given', type: 'expense', subType: 'operating_expense' },
]

export const ACCOUNT_ID_BY_CODE = Object.fromEntries(ACCOUNT_DEFS.map((a) => [a.code, `ACC${a.code}`])) as Record<string, string>

export interface JournalLineInput {
  accountCode: string
  accountId?: string
  debit?: number
  credit?: number
  description?: string | null
}

export interface JournalPostInput {
  date: string
  description?: string | null
  reference?: string | null
  referenceType: string
  referenceId: string
  source?: 'erp' | 'shopify' | 'manual' | 'system'
  branchId?: string | null
  createdBy?: string | null
  isAuto?: boolean
  lines: JournalLineInput[]
}

const round2 = (n: number) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100
const money = (n: unknown) => round2(Number(n || 0))

export async function ensureDefaultAccounts(tx: Tx = db!): Promise<void> {
  const codes = ACCOUNT_DEFS.map((def) => def.code)
  const existing = await tx
    .select({ code: schema.accounts.code })
    .from(schema.accounts)
    .where(inArray(schema.accounts.code, codes))
  const have = new Set(existing.map((row) => row.code))
  for (const def of ACCOUNT_DEFS) {
    if (have.has(def.code)) continue
    const id = ACCOUNT_ID_BY_CODE[def.code]
    await tx
      .insert(schema.accounts)
      .values({
        id,
        code: def.code,
        name: def.name,
        type: def.type,
        subType: def.subType,
        parentId: null,
        openingBalance: 0,
        currentBalance: 0,
        currency: 'INR',
        branchId: null,
        isActive: true,
        createdAt: new Date().toISOString(),
      } as any)
      .onConflictDoNothing({ target: schema.accounts.code })
  }
}

export async function resolveAccountId(input: { accountCode?: string; accountId?: string }, tx: Tx = db!): Promise<string> {
  const raw = String(input.accountCode ?? input.accountId ?? '').trim()
  if (!raw) throw new Error('Account is required')
  if (/^\d{4}$/.test(raw)) return accountIdForCode(raw, tx)
  await ensureDefaultAccounts(tx)
  const [row] = await tx.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.id, raw)).limit(1)
  if (row) return row.id
  const [byCode] = await tx.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.code, raw)).limit(1)
  if (byCode) return byCode.id
  throw new Error(`Account ${raw} not found`)
}

export async function accountIdForCode(code: string, tx: Tx = db!): Promise<string> {
  const raw = String(code ?? '').trim()
  if (!raw) throw new Error('Account code is required')
  await ensureDefaultAccounts(tx)
  const [byCode] = await tx.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.code, raw)).limit(1)
  if (byCode) return byCode.id
  // Existing installs may have the standard account under a non-standard id.
  const fallback = ACCOUNT_ID_BY_CODE[raw]
  if (fallback) {
    const [byId] = await tx.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.id, fallback)).limit(1)
    if (byId) return byId.id
  }
  throw new Error(`Account code ${raw} not found`)
}

function validateBalanced(lines: Array<{ debit: number; credit: number }>) {
  const debit = round2(lines.reduce((s, l) => s + l.debit, 0))
  const credit = round2(lines.reduce((s, l) => s + l.credit, 0))
  if (debit <= 0 || credit <= 0) throw new Error('Journal entry must have debit and credit amounts')
  if (Math.abs(debit - credit) > 0.01) throw new Error(`Unbalanced journal entry: debit ${debit} != credit ${credit}`)
  return { debit, credit }
}

async function normalizeLines(input: JournalPostInput, client: Tx) {
  const normalized = input.lines
    .map((l) => ({ accountCode: l.accountCode, accountId: l.accountId, debit: money(l.debit), credit: money(l.credit), description: l.description ?? null }))
    .filter((l) => l.debit > 0 || l.credit > 0)
  if (normalized.length < 2) throw new Error('Journal entry requires at least 2 non-zero lines')
  validateBalanced(normalized)
  await ensureDefaultAccounts(client)
  return normalized
}

async function applyLineBalances(lines: Array<{ debit: number; credit: number } & { accountCode?: string; accountId?: string }>, client: Tx, sign: 1 | -1) {
  for (const line of lines) {
    const accountId = await resolveAccountId(line, client)
    await client.update(schema.accounts).set({
      currentBalance: sql`coalesce(${schema.accounts.currentBalance}, 0) + ${sign * (line.debit - line.credit)}`,
    } as any).where(eq(schema.accounts.id, accountId))
  }
}

async function insertEntry(input: JournalPostInput, normalized: Array<{ accountCode?: string; accountId?: string; debit: number; credit: number; description: string | null }>, client: Tx) {
  const id = `JE-${randomBytes(8).toString('hex')}`
  const stamp = Date.now().toString(36).toUpperCase()
  const entryNumber = `JE-${input.referenceType.toUpperCase()}-${stamp}`
  await client.insert(schema.journalEntries).values({
    id,
    entryNumber,
    date: input.date,
    description: input.description ?? null,
    reference: input.reference ?? null,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    source: input.source ?? (input.isAuto === false ? 'manual' : 'system'),
    isAuto: input.isAuto ?? true,
    branchId: input.branchId ?? null,
    createdBy: input.createdBy ?? null,
    createdAt: new Date().toISOString(),
  } as any)
  for (const line of normalized) {
    const accountId = await resolveAccountId(line, client)
    await client.insert(schema.journalEntryLines).values({
      id: `JEL-${randomBytes(8).toString('hex')}`,
      journalEntryId: id,
      accountId,
      debit: line.debit,
      credit: line.credit,
      description: line.description ?? null,
      branchId: input.branchId ?? null,
    } as any)
  }
  await applyLineBalances(normalized, client, 1)
  void recordAudit({
    user: input.createdBy ?? 'System',
    action: 'Journal Posted',
    module: 'accounts',
    entity: `${input.referenceType}:${input.referenceId}`,
    changes: JSON.stringify({ entryNumber, reference: input.reference, source: input.source ?? (input.isAuto === false ? 'manual' : 'system'), debit: round2(normalized.reduce((s,l)=>s+l.debit,0)), credit: round2(normalized.reduce((s,l)=>s+l.credit,0)) }),
  })
  return { id, entryNumber }
}

async function removeExistingEntry(referenceType: string, referenceId: string, client: Tx, reason: string, actor?: string | null) {
  const [existing] = await client.select().from(schema.journalEntries).where(and(eq(schema.journalEntries.referenceType, referenceType), eq(schema.journalEntries.referenceId, referenceId))).limit(1)
  if (!existing) return false
  const lines = await client.select().from(schema.journalEntryLines).where(eq(schema.journalEntryLines.journalEntryId, existing.id))
  for (const line of lines) {
    await client.update(schema.accounts).set({
      currentBalance: sql`coalesce(${schema.accounts.currentBalance}, 0) - ${Number(line.debit || 0) - Number(line.credit || 0)}`,
    } as any).where(eq(schema.accounts.id, line.accountId as string))
  }
  await client.delete(schema.journalEntryLines).where(eq(schema.journalEntryLines.journalEntryId, existing.id))
  await client.delete(schema.journalEntries).where(eq(schema.journalEntries.id, existing.id))
  void recordAudit({ user: actor ?? 'System', action: 'Journal Reversed/Removed', module: 'accounts', entity: `${referenceType}:${referenceId}`, changes: JSON.stringify({ entryNumber: existing.entryNumber, reason }) })
  return true
}

export async function postJournalEntry(input: JournalPostInput, tx: Tx = db!): Promise<{ id: string; entryNumber: string; created: boolean }> {
  if (!db) throw new Error('Database unavailable')
  const run = async (client: Tx) => {
    const existing = await client
      .select({ id: schema.journalEntries.id, entryNumber: schema.journalEntries.entryNumber })
      .from(schema.journalEntries)
      .where(and(eq(schema.journalEntries.referenceType, input.referenceType), eq(schema.journalEntries.referenceId, input.referenceId)))
      .limit(1)
    if (existing[0]) return { id: existing[0].id, entryNumber: existing[0].entryNumber, created: false }
    const normalized = await normalizeLines(input, client)
    const created = await insertEntry(input, normalized, client)
    return { ...created, created: true }
  }
  if (typeof (tx as any).transaction === 'function' && tx === db) return db!.transaction(async (trx) => run(trx as any))
  return run(tx)
}

export async function upsertJournalEntry(input: JournalPostInput, tx: Tx = db!): Promise<{ id: string; entryNumber: string; created: boolean; replaced: boolean }> {
  if (!db) throw new Error('Database unavailable')
  const run = async (client: Tx) => {
    const [existing] = await client.select({ id: schema.journalEntries.id, entryNumber: schema.journalEntries.entryNumber }).from(schema.journalEntries).where(and(eq(schema.journalEntries.referenceType, input.referenceType), eq(schema.journalEntries.referenceId, input.referenceId))).limit(1)
    if (existing) {
      await removeExistingEntry(input.referenceType, input.referenceId, client, 'replace', input.createdBy ?? null)
      const normalized = await normalizeLines(input, client)
      const created = await insertEntry(input, normalized, client)
      return { ...created, created: false, replaced: true }
    }
    const normalized = await normalizeLines(input, client)
    const created = await insertEntry(input, normalized, client)
    return { ...created, created: true, replaced: false }
  }
  if (typeof (tx as any).transaction === 'function' && tx === db) return db!.transaction(async (trx) => run(trx as any))
  return run(tx)
}

export async function removeJournalEntry(referenceType: string, referenceId: string, actor?: string | null, tx: Tx = db!): Promise<boolean> {
  if (!db) throw new Error('Database unavailable')
  const run = async (client: Tx) => removeExistingEntry(referenceType, referenceId, client, 'remove', actor ?? null)
  if (typeof (tx as any).transaction === 'function' && tx === db) return db!.transaction(async (trx) => run(trx as any))
  return run(tx)
}

export function toIsoDate(value: unknown): string {
  if (!value) return new Date().toISOString().slice(0, 10)
  const d = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10)
}
