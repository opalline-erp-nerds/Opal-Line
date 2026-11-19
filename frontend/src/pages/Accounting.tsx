import { useCallback, useEffect, useState } from 'react'
import {
  BookOpen,
  Calculator,
  DollarSign,
  FileSpreadsheet,
  Landmark,
  Loader2,
  RefreshCw,
  Scale,
  TrendingDown,
  TrendingUp,
  Wallet,
  ListFilter,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { accountingApi } from '@/lib/api'
import type {
  TrialBalanceResult,
  ProfitAndLossResult,
  BalanceSheetResult,
  AccountingDashboard,
  UnifiedTransaction,
  LedgerRow,
} from '@/lib/api'
import { formatCurrency } from '@/lib/format'

export default function AccountingPage() {
  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Double-Entry Accounting"
        subtitle="Unified Shopify + ERP accounting dashboard, ledger, transactions, and reports"
        icon={<Calculator className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />}
        iconTileClassName="bg-[#7547F5] text-white ring-[#7547F5] dark:bg-[#7547F5] dark:text-white dark:ring-[#7547F5]"
      />
      <Tabs defaultValue="dashboard">
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="dashboard"><Wallet className="h-4 w-4" /> Dashboard</TabsTrigger>
          <TabsTrigger value="transactions"><ListFilter className="h-4 w-4" /> Transactions</TabsTrigger>
          <TabsTrigger value="trial-balance"><Scale className="h-4 w-4" /> Trial Balance</TabsTrigger>
          <TabsTrigger value="profit-loss"><TrendingUp className="h-4 w-4" /> Profit & Loss</TabsTrigger>
          <TabsTrigger value="balance-sheet"><Landmark className="h-4 w-4" /> Balance Sheet</TabsTrigger>
          <TabsTrigger value="journal"><BookOpen className="h-4 w-4" /> Journal / Ledger</TabsTrigger>
        </TabsList>
        <TabsContent value="dashboard"><DashboardTab /></TabsContent>
        <TabsContent value="transactions"><TransactionsTab /></TabsContent>
        <TabsContent value="trial-balance"><TrialBalanceTab /></TabsContent>
        <TabsContent value="profit-loss"><ProfitLossTab /></TabsContent>
        <TabsContent value="balance-sheet"><BalanceSheetTab /></TabsContent>
        <TabsContent value="journal"><JournalEntriesTab /></TabsContent>
      </Tabs>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// TRIAL BALANCE
// ═══════════════════════════════════════════════════════════════════

function DashboardTab() {
  const [data, setData] = useState<AccountingDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [reconciling, setReconciling] = useState(false)
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { setData(await accountingApi.getDashboard()) } catch { /* ignore */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { queueMicrotask(load) }, [load])

  const reconcile = async () => {
    setReconciling(true); setReconcileMsg(null)
    try {
      const r = await accountingApi.reconcileShopify()
      setReconcileMsg(`Shopify orders: ${r.totalShopifyOrders}, matched: ${r.matched}, missing invoice: ${r.missingInvoice}, missing journal: ${r.missingJournal}`)
    } catch { setReconcileMsg('Reconciliation failed') } finally { setReconciling(false) }
  }

  if (loading) return <Card className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading dashboard...</Card>
  if (!data) return <Card className="p-8 text-center text-sm text-muted-foreground">No accounting dashboard data.</Card>
  const cards = [
    { label: 'Revenue', value: data.revenue, icon: TrendingUp, tone: 'text-emerald-400 bg-emerald-500/10' },
    { label: 'Expenses', value: data.expenses, icon: TrendingDown, tone: 'text-red-400 bg-red-500/10' },
    { label: 'Profit', value: data.profit, icon: DollarSign, tone: data.profit >= 0 ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10' },
    { label: 'Bank Balance', value: data.bankBalance, icon: Landmark, tone: 'text-sky-400 bg-sky-500/10' },
    { label: 'Receivable', value: data.receivable, icon: Wallet, tone: 'text-amber-400 bg-amber-500/10' },
    { label: 'Payable', value: data.payable, icon: FileSpreadsheet, tone: 'text-amber-400 bg-amber-500/10' },
  ]
  return (
    <div className="space-y-4">
      <Card><CardContent className="p-4 flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-4 w-4" /> Refresh</Button>
        <Button variant="outline" size="sm" onClick={reconcile} disabled={reconciling}>{reconciling ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Reconcile Shopify</Button>
        {reconcileMsg && <span className="text-xs text-muted-foreground">{reconcileMsg}</span>}
        <div className="ml-auto flex gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">Invoices: {data.counts.invoices}</Badge>
          <Badge variant="outline">Expenses: {data.counts.expenses}</Badge>
          <Badge variant="outline">Shopify Orders: {data.counts.shopifyOrders}</Badge>
        </div>
      </CardContent></Card>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <Card key={c.label} className="p-4"><div className="flex items-center gap-3">
            <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${c.tone}`}><c.icon className="h-5 w-5" /></div>
            <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">{c.label}</p><p className="text-lg font-bold text-foreground">{formatCurrency(c.value)}</p></div>
          </div></Card>
        ))}
      </div>
    </div>
  )
}

function TransactionsTab() {
  const [rows, setRows] = useState<UnifiedTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [source, setSource] = useState<'all'|'shopify'|'erp'>('all')
  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await accountingApi.getUnifiedTransactions({ source, limit: 200 })) } catch { /* ignore */ } finally { setLoading(false) }
  }, [source])
  useEffect(() => { queueMicrotask(load) }, [load])
  return (
    <div className="space-y-4">
      <Card><CardContent className="p-4 flex flex-wrap items-end gap-3">
        <div className="space-y-1"><Label className="text-xs text-muted-foreground">Source</Label>
          <select value={source} onChange={(e) => setSource(e.target.value as any)} className="h-9 rounded-md border border-input bg-background px-3 text-sm"><option value="all">All</option><option value="shopify">Shopify</option><option value="erp">ERP</option></select></div>
        <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
        <div className="ml-auto text-xs text-muted-foreground">{rows.length} transactions</div>
      </CardContent></Card>
      {loading ? <Card className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading transactions...</Card> :
      rows.length === 0 ? <Card className="p-8 text-center text-sm text-muted-foreground">No transactions found.</Card> :
      <Card><CardContent className="p-0"><Table>
        <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Type</TableHead><TableHead>Ref</TableHead><TableHead>Party</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead><TableHead>Source</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map((r) => (
          <TableRow key={`${r.type}-${r.id}`}><TableCell className="text-sm">{r.date ? String(r.date).slice(0,10) : '—'}</TableCell><TableCell className="text-sm">{r.type}</TableCell><TableCell className="font-mono text-xs">{r.ref || '—'}</TableCell><TableCell className="text-sm">{r.customer || '—'}</TableCell><TableCell className="text-right tabular-nums">{formatCurrency(Number(r.amount || 0))}</TableCell><TableCell><Badge variant="outline" className="text-[10px] capitalize">{r.status || '—'}</Badge></TableCell><TableCell><Badge variant={r.source === 'shopify' ? 'info' : 'outline'} className="text-[10px] uppercase">{r.source}</Badge></TableCell></TableRow>
        ))}</TableBody>
      </Table></CardContent></Card>}
    </div>
  )
}
function TrialBalanceTab() {
  const [data, setData] = useState<TrialBalanceResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await accountingApi.getTrialBalance({
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      })
      setData(res)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(load)
  }, [load])

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">From</Label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-[160px]" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-[160px]" />
            </div>
            <Button variant="outline" size="sm" onClick={load}>Apply Filters</Button>
            {data && (
              <Badge variant={data.isBalanced ? 'success' : 'danger'} className="ml-auto">
                {data.isBalanced ? '✓ Balanced' : '⚠ Unbalanced'}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <Card className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading trial balance...
        </Card>
      ) : !data || data.accounts.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          <Calculator className="mx-auto mb-2 h-8 w-8 opacity-40" />
          <p>No accounts found. Create accounts and post journal entries to populate the trial balance.</p>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Trial Balance</CardTitle>
            <CardDescription>All accounts with debit/credit totals</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">Code</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Debit (₹)</TableHead>
                  <TableHead className="text-right">Credit (₹)</TableHead>
                  <TableHead className="text-right">Balance (₹)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.accounts.map((row) => (
                  <TableRow key={row.accountId}>
                    <TableCell className="font-mono text-xs">{row.accountCode}</TableCell>
                    <TableCell className="font-medium">{row.accountName}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px] capitalize">{row.accountType}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{Number(row.totalDebit) > 0 ? formatCurrency(row.totalDebit) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(row.totalCredit) > 0 ? formatCurrency(row.totalCredit) : '—'}</TableCell>
                    <TableCell className={`text-right font-semibold tabular-nums ${Number(row.balance) >= 0 ? 'text-foreground' : 'text-red-600 dark:text-red-400'}`}>
                      {Number(row.balance) >= 0 ? '+' : ''}{formatCurrency(row.balance)}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-t-2 border-primary-200 bg-muted/50 font-bold">
                  <TableCell colSpan={3}>Totals</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(data.totalDebit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(data.totalCredit)}</TableCell>
                  <TableCell className={`text-right tabular-nums ${data.isBalanced ? 'text-success-700' : 'text-red-600 dark:text-red-400'}`}>
                    {data.isBalanced ? 'Balanced ✓' : `Difference: ${formatCurrency(Math.abs(data.totalDebit - data.totalCredit))}`}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// PROFIT & LOSS
// ═══════════════════════════════════════════════════════════════════
function ProfitLossTab() {
  const [data, setData] = useState<ProfitAndLossResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await accountingApi.getProfitAndLoss({
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      })
      setData(res)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(load)
  }, [load])

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">From</Label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-[160px]" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-[160px]" />
            </div>
            <Button variant="outline" size="sm" onClick={load}>Apply Filters</Button>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <Card className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading P&L statement...
        </Card>
      ) : !data ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          <DollarSign className="mx-auto mb-2 h-8 w-8 opacity-40" />
          <p>No financial data available. Post journal entries to populate the P&L statement.</p>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card className="p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success-50 text-success-700">
                  <TrendingUp className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Revenue</p>
                  <p className="text-lg font-bold text-foreground">{formatCurrency(data.totalRevenue)}</p>
                </div>
              </div>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 text-red-700">
                  <TrendingDown className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Expenses</p>
                  <p className="text-lg font-bold text-foreground">{formatCurrency(data.totalExpenses)}</p>
                </div>
              </div>
            </Card>
            <Card className={`p-4 ${data.netProfit >= 0 ? 'ring-2 ring-success-200' : 'ring-2 ring-red-200'}`}>
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${data.netProfit >= 0 ? 'bg-success-50 text-success-700' : 'bg-red-50 text-red-700'}`}>
                  <DollarSign className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Net Profit</p>
                  <p className={`text-lg font-bold ${data.netProfit >= 0 ? 'text-success-700' : 'text-red-700'}`}>{formatCurrency(data.netProfit)}</p>
                </div>
              </div>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Revenue</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.revenue.length === 0 ? (
                  <p className="px-5 py-4 text-xs text-muted-foreground">No revenue accounts</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Account</TableHead>
                        <TableHead className="text-right">Amount (₹)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.revenue.map((r) => (
                        <TableRow key={r.accountId}>
                          <TableCell>
                            <span className="font-mono text-[10px] text-muted-foreground mr-2">{r.accountCode}</span>
                            {r.accountName}
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums text-success-700">{formatCurrency(r.amount)}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="bg-muted/50 font-bold">
                        <TableCell>Total Revenue</TableCell>
                        <TableCell className="text-right tabular-nums text-success-700">{formatCurrency(data.totalRevenue)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Expenses</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.expenses.length === 0 ? (
                  <p className="px-5 py-4 text-xs text-muted-foreground">No expense accounts</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Account</TableHead>
                        <TableHead className="text-right">Amount (₹)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.expenses.map((r) => (
                        <TableRow key={r.accountId}>
                          <TableCell>
                            <span className="font-mono text-[10px] text-muted-foreground mr-2">{r.accountCode}</span>
                            {r.accountName}
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums text-red-600 dark:text-red-400">{formatCurrency(r.amount)}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="bg-muted/50 font-bold">
                        <TableCell>Total Expenses</TableCell>
                        <TableCell className="text-right tabular-nums text-red-600 dark:text-red-400">{formatCurrency(data.totalExpenses)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>

          <Card className={`p-5 ${data.netProfit >= 0 ? 'border-success-200 bg-success-50/30' : 'border-red-200 bg-red-50/30'}`}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground">Net Profit / (Loss)</span>
              <span className={`text-xl font-bold ${data.netProfit >= 0 ? 'text-success-700' : 'text-red-700'}`}>
                {data.netProfit >= 0 ? '+' : ''}{formatCurrency(data.netProfit)}
              </span>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// BALANCE SHEET
// ═══════════════════════════════════════════════════════════════════
function BalanceSheetTab() {
  const [data, setData] = useState<BalanceSheetResult | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    accountingApi.getBalanceSheet().then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [])

  return (
    <div className="space-y-4">
      {loading ? (
        <Card className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading balance sheet...
        </Card>
      ) : !data ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          <Landmark className="mx-auto mb-2 h-8 w-8 opacity-40" />
          <p>No balance sheet data available.</p>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card className="p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-info-50 text-info-700">
                  <Landmark className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Assets</p>
                  <p className="text-lg font-bold text-foreground">{formatCurrency(data.totalAssets)}</p>
                </div>
              </div>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-warning-50 text-warning-700">
                  <FileSpreadsheet className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Liabilities</p>
                  <p className="text-lg font-bold text-foreground">{formatCurrency(data.totalLiabilities)}</p>
                </div>
              </div>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success-50 text-success-700">
                  <Scale className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Equity</p>
                  <p className="text-lg font-bold text-foreground">{formatCurrency(data.totalEquity)}</p>
                </div>
              </div>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-sm">Assets</CardTitle></CardHeader>
              <CardContent className="p-0">
                {data.assets.length === 0 ? (
                  <p className="px-5 py-4 text-xs text-muted-foreground">No asset accounts</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>Account</TableHead><TableHead className="text-right">Balance (₹)</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.assets.map((r) => (
                        <TableRow key={r.accountId}>
                          <TableCell>
                            <span className="font-mono text-[10px] text-muted-foreground mr-2">{r.accountCode}</span>
                            {r.accountName}
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">{formatCurrency(r.balance)}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="bg-muted/50 font-bold">
                        <TableCell>Total Assets</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(data.totalAssets)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader><CardTitle className="text-sm">Liabilities</CardTitle></CardHeader>
                <CardContent className="p-0">
                  {data.liabilities.length === 0 ? (
                    <p className="px-5 py-4 text-xs text-muted-foreground">No liability accounts</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow><TableHead>Account</TableHead><TableHead className="text-right">Balance (₹)</TableHead></TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.liabilities.map((r) => (
                          <TableRow key={r.accountId}>
                            <TableCell>
                              <span className="font-mono text-[10px] text-muted-foreground mr-2">{r.accountCode}</span>
                              {r.accountName}
                            </TableCell>
                            <TableCell className="text-right font-semibold tabular-nums">{formatCurrency(r.balance)}</TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="bg-muted/50 font-bold">
                          <TableCell>Total Liabilities</TableCell>
                          <TableCell className="text-right tabular-nums">{formatCurrency(data.totalLiabilities)}</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-sm">Equity</CardTitle></CardHeader>
                <CardContent className="p-0">
                  {data.equity.length === 0 ? (
                    <p className="px-5 py-4 text-xs text-muted-foreground">No equity accounts</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow><TableHead>Account</TableHead><TableHead className="text-right">Balance (₹)</TableHead></TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.equity.map((r) => (
                          <TableRow key={r.accountId}>
                            <TableCell>
                              <span className="font-mono text-[10px] text-muted-foreground mr-2">{r.accountCode}</span>
                              {r.accountName}
                            </TableCell>
                            <TableCell className="text-right font-semibold tabular-nums">{formatCurrency(r.balance)}</TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="bg-muted/50 font-bold">
                          <TableCell>Total Equity</TableCell>
                          <TableCell className="text-right tabular-nums">{formatCurrency(data.totalEquity)}</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          <Card className="p-5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Liabilities + Equity</span>
              <span className="font-semibold tabular-nums">{formatCurrency(data.totalLiabilities + data.totalEquity)}</span>
            </div>
            <Separator className="my-2" />
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-foreground">Assets = Liabilities + Equity</span>
              <Badge variant={Math.abs(data.totalAssets - (data.totalLiabilities + data.totalEquity)) < 0.01 ? 'success' : 'danger'}>
                {Math.abs(data.totalAssets - (data.totalLiabilities + data.totalEquity)) < 0.01 ? 'Balanced ✓' : '⚠ Difference: ' + formatCurrency(Math.abs(data.totalAssets - (data.totalLiabilities + data.totalEquity)))}
              </Badge>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// JOURNAL ENTRIES / LEDGER
// ═══════════════════════════════════════════════════════════════════
function JournalEntriesTab() {
  const [entries, setEntries] = useState<LedgerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [source, setSource] = useState<'all'|'shopify'|'erp'|'manual'>('all')
  const [search, setSearch] = useState('')
  const load = useCallback(async () => {
    setLoading(true)
    try { setEntries(await accountingApi.getLedger({ dateFrom: dateFrom || undefined, dateTo: dateTo || undefined, source, search: search || undefined })) }
    catch { try { setEntries((await accountingApi.getJournalEntries({ dateFrom: dateFrom || undefined, dateTo: dateTo || undefined })).map((e:any)=>({ ...e, source: e.isAuto ? 'erp' : 'manual' }))) } catch {} }
    finally { setLoading(false) }
  }, [dateFrom, dateTo, source, search])
  useEffect(() => { queueMicrotask(load) }, [load])
  return (
    <div className="space-y-4">
      <Card><CardContent className="p-4"><div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1"><Label className="text-xs text-muted-foreground">From</Label><Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-[160px]" /></div>
        <div className="space-y-1"><Label className="text-xs text-muted-foreground">To</Label><Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-[160px]" /></div>
        <div className="space-y-1"><Label className="text-xs text-muted-foreground">Source</Label><select value={source} onChange={(e)=>setSource(e.target.value as any)} className="h-9 rounded-md border border-input bg-background px-3 text-sm"><option value="all">All</option><option value="shopify">Shopify</option><option value="erp">ERP</option><option value="manual">Manual</option></select></div>
        <div className="space-y-1"><Label className="text-xs text-muted-foreground">Search</Label><Input value={search} onChange={(e)=>setSearch(e.target.value)} placeholder="ref / entry / desc" className="w-[180px]" /></div>
        <Button variant="outline" size="sm" onClick={load}>Apply</Button>
        <div className="ml-auto text-xs text-muted-foreground">{entries.length} entries</div>
      </div></CardContent></Card>
      {loading ? <Card className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading ledger...</Card> :
      entries.length === 0 ? <Card className="p-8 text-center text-sm text-muted-foreground"><BookOpen className="mx-auto mb-2 h-8 w-8 opacity-40" /><p>No journal/ledger entries found.</p></Card> :
      <Card><CardContent className="p-0"><Table>
        <TableHeader><TableRow><TableHead>Entry #</TableHead><TableHead>Date</TableHead><TableHead>Description</TableHead><TableHead>Reference</TableHead><TableHead>Type</TableHead><TableHead>Source</TableHead></TableRow></TableHeader>
        <TableBody>{entries.map((e) => (
          <TableRow key={e.id}>
            <TableCell className="font-mono text-xs font-medium">{e.entryNumber}</TableCell>
            <TableCell className="text-sm">{e.date}</TableCell>
            <TableCell className="text-sm text-muted-foreground">{e.description || '—'}</TableCell>
            <TableCell className="font-mono text-xs">{e.reference || '—'}</TableCell>
            <TableCell><Badge variant={e.isAuto ? 'info' : 'outline'} className="text-[10px]">{e.isAuto ? 'Auto' : 'Manual'}</Badge></TableCell>
            <TableCell><Badge variant={e.source === 'shopify' ? 'info' : 'outline'} className="text-[10px] uppercase">{e.source}</Badge></TableCell>
          </TableRow>
        ))}</TableBody>
      </Table></CardContent></Card>}
    </div>
  )
}