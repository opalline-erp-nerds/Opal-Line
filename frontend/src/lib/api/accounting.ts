import { request } from './core'

// â”€â”€â”€ Double-entry Accounting API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export interface TrialBalanceRow {
  accountId: string
  accountCode: string
  accountName: string
  accountType: string
  totalDebit: number
  totalCredit: number
  balance: number
}
export interface TrialBalanceResult {
  accounts: TrialBalanceRow[]
  totalDebit: number
  totalCredit: number
  isBalanced: boolean
}
export interface PnlRow {
  accountId: string
  accountCode: string
  accountName: string
  accountType: string
  totalDebit: number
  totalCredit: number
  amount: number
}
export interface ProfitAndLossResult {
  revenue: PnlRow[]
  expenses: PnlRow[]
  totalRevenue: number
  totalExpenses: number
  netProfit: number
}
export interface BalanceSheetRow {
  accountId: string
  accountCode: string
  accountName: string
  accountType: string
  totalDebit: number
  totalCredit: number
  balance: number
}
export interface BalanceSheetResult {
  assets: BalanceSheetRow[]
  liabilities: BalanceSheetRow[]
  equity: BalanceSheetRow[]
  totalAssets: number
  totalLiabilities: number
  totalEquity: number
}
export interface JournalEntry {
  id: string
  entryNumber: string
  date: string
  description: string | null
  reference: string | null
  referenceType: string | null
  referenceId: string | null
  isAuto: boolean
  branchId: string | null
  createdBy: string | null
  createdAt: string
}
export interface Account {
  id: string
  code: string
  name: string
  type: string
  subType: string | null
  parentId: string | null
  isGroup: boolean
  openingBalance: number
  currentBalance: number
  currency: string
  branchId: string | null
  isActive: boolean
  createdAt: string
}
export interface LedgerRow { id: string; entryNumber: string; date: string; description: string | null; reference: string | null; referenceType: string | null; referenceId: string | null; isAuto: boolean; source: 'shopify' | 'erp' | 'manual' }
export interface AccountingDashboard {
  revenue: number; expenses: number; profit: number; bankBalance: number; receivable: number; payable: number
  counts: { invoices: number; expenses: number; shopifyOrders: number }
}
export interface UnifiedTransaction { id: string; date: string; type: string; ref: string | null; customer: string | null; amount: number; status: string | null; source: 'shopify' | 'erp' }

export const accountingApi = {
  getAccounts: () => request<Account[]>('/accounts'),
  createAccount: (body: { code: string; name: string; type: string; subType?: string; parentId?: string; openingBalance?: number }) =>
    request<Account>('/accounts', { method: 'POST', body: JSON.stringify(body) }),
  updateAccount: (id: string, body: Partial<{ name: string; type: string; subType: string; isActive: boolean }>) =>
    request<Account>(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  getTrialBalance: (params?: { dateFrom?: string; dateTo?: string }) => {
    const q = new URLSearchParams()
    if (params?.dateFrom) q.set('dateFrom', params.dateFrom)
    if (params?.dateTo) q.set('dateTo', params.dateTo)
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return request<TrialBalanceResult>(`/accounts/trial-balance${suffix}`)
  },
  getProfitAndLoss: (params?: { dateFrom?: string; dateTo?: string }) => {
    const q = new URLSearchParams()
    if (params?.dateFrom) q.set('dateFrom', params.dateFrom)
    if (params?.dateTo) q.set('dateTo', params.dateTo)
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return request<ProfitAndLossResult>(`/accounts/profit-and-loss${suffix}`)
  },
  getBalanceSheet: () =>
    request<BalanceSheetResult>('/accounts/balance-sheet'),
  getJournalEntries: (params?: { dateFrom?: string; dateTo?: string; referenceType?: string }) => {
    const q = new URLSearchParams()
    if (params?.dateFrom) q.set('dateFrom', params.dateFrom)
    if (params?.dateTo) q.set('dateTo', params.dateTo)
    if (params?.referenceType) q.set('referenceType', params.referenceType)
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return request<JournalEntry[]>(`/accounts/journal-entries${suffix}`)
  },
  createJournalEntry: (body: { date: string; description?: string; reference?: string; referenceType?: string; referenceId?: string; lines: Array<{ accountId?: string; accountCode?: string; debit: number; credit: number; description?: string }> }) =>
    request<{ id: string; entryNumber: string }>('/accounts/journal-entries', { method: 'POST', body: JSON.stringify(body) }),
  postInvoiceToJournal: (invoiceId: string) =>
    request<{ id: string; entryNumber: string; invoiceNumber: string }>(`/accounts/journal-entries/post/${invoiceId}`, { method: 'POST' }),
  getLedger: (params?: { dateFrom?: string; dateTo?: string; source?: string; search?: string }) => {
    const q = new URLSearchParams()
    if (params?.dateFrom) q.set('dateFrom', params.dateFrom)
    if (params?.dateTo) q.set('dateTo', params.dateTo)
    if (params?.source && params.source !== 'all') q.set('source', params.source)
    if (params?.search) q.set('search', params.search)
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return request<LedgerRow[]>(`/accounts/ledger${suffix}`)
  },
  getDashboard: (params?: { dateFrom?: string; dateTo?: string }) => {
    const q = new URLSearchParams()
    if (params?.dateFrom) q.set('dateFrom', params.dateFrom)
    if (params?.dateTo) q.set('dateTo', params.dateTo)
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return request<AccountingDashboard>(`/accounts/dashboard${suffix}`)
  },
  getUnifiedTransactions: (params?: { source?: string; limit?: number }) => {
    const q = new URLSearchParams()
    if (params?.source && params.source !== 'all') q.set('source', params.source)
    if (params?.limit) q.set('limit', String(params.limit))
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return request<UnifiedTransaction[]>(`/accounts/unified-transactions${suffix}`)
  },
  reconcileShopify: (params?: { dateFrom?: string; dateTo?: string }) => {
    const q = new URLSearchParams()
    if (params?.dateFrom) q.set('dateFrom', params.dateFrom)
    if (params?.dateTo) q.set('dateTo', params.dateTo)
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return request<{ totalShopifyOrders: number; matched: number; missingInvoice: number; mismatched: number; ordersWithRefunds: number; missingJournal: number; unmatchedRefunds: number }>(`/accounts/reconcile/shopify${suffix}`, { method: 'POST' })
  },
  getHsnSummary: (params?: { month?: number; year?: number }) => {
    const q = new URLSearchParams()
    if (params?.month) q.set('month', String(params.month))
    if (params?.year) q.set('year', String(params.year))
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return request<{ hsn: string; description: string; qty: number; taxableValue: number; cgst: number; sgst: number; igst: number; totalTax: number }[]>(`/db/reports/hsn${suffix}`)
  },
  getGstReconciliation: (params?: { month?: number; year?: number }) => {
    const q = new URLSearchParams()
    if (params?.month) q.set('month', String(params.month))
    if (params?.year) q.set('year', String(params.year))
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return request<{ outputGst: number; inputGst: number; netPayable: number; b2bTaxable: number; b2cTaxable: number; mismatches: Array<{ invoiceNumber: string; expected: number; actual: number; diff: number }> }>(`/db/reports/gst-reconciliation${suffix}`)
  },
}
