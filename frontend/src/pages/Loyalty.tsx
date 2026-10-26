import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Gift,
  History,
  Loader2,
  Pencil,
  Plus,
  Search,
  Settings,
  Sparkles,
  Star,
  Tag,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import type { ColumnDef } from '@/lib/table'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import { dbApi } from '@/lib/api'
import type { Customer } from '@/types'
import { formatDate } from '@/lib/format'

interface LoyaltyEntry {
  id: string
  customerId?: string
  invoiceId?: string | null
  invoiceNumber?: string | null
  type: string
  points: number
  balanceAfter: number | null
  note: string | null
  createdBy?: string | null
  date: string
}

interface CustomerWithBalance {
  id: string
  name: string
  phone: string | null
  email: string | null
  balance: number
  tier: string
  totalEarned: number
  totalRedeemed: number
}

function getTier(balance: number): { label: string; color: string } {
  if (balance >= 1000) return { label: 'Platinum', color: 'bg-violet-100 dark:bg-violet-950/40 text-violet-700' }
  if (balance >= 500) return { label: 'Gold', color: 'bg-amber-100 text-amber-700' }
  if (balance >= 100) return { label: 'Silver', color: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' }
  return { label: 'Bronze', color: 'bg-orange-50 dark:bg-orange-950/40 text-orange-700' }
}

export default function LoyaltyPage() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [loyaltyData, setLoyaltyData] = useState<Map<string, { balance: number; entries: LoyaltyEntry[] }>>(new Map())

  // Form states
  const [showAddPoints, setShowAddPoints] = useState(false)
  const [showRedeemPoints, setShowRedeemPoints] = useState(false)
  const [addFormCustomer, setAddFormCustomer] = useState('')
  const [addFormPoints, setAddFormPoints] = useState('')
  const [addFormReason, setAddFormReason] = useState('')
  const [redeemFormCustomer, setRedeemFormCustomer] = useState('')
  const [redeemFormPoints, setRedeemFormPoints] = useState('')
  const [redeemFormReason, setRedeemFormReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  // Settings dialog (static config display)
  const [showSettings, setShowSettings] = useState(false)

  // Per-row edit: set a customer's balance to an absolute value by applying
  // the difference as a manual adjustment.
  const [editPointsFor, setEditPointsFor] = useState<CustomerWithBalance | null>(null)
  const [editPointsValue, setEditPointsValue] = useState('')
  const [editPointsReason, setEditPointsReason] = useState('')

  const openEditPoints = useCallback((c: CustomerWithBalance) => {
    setEditPointsFor(c)
    setEditPointsValue(String(Math.round(c.balance)))
    setEditPointsReason('')
    setError('')
  }, [])

  const editPointsDelta = editPointsFor
    ? Math.round(Number(editPointsValue || 0) - editPointsFor.balance)
    : 0

  const handleEditPoints = async () => {
    if (!editPointsFor) return
    const target = Math.round(Number(editPointsValue))
    if (!Number.isFinite(target) || target < 0) { setError('Enter a valid balance (0 or more)'); return }
    if (editPointsDelta === 0) { setEditPointsFor(null); return }
    setSaving(true)
    setError('')
    try {
      await dbApi.loyaltyAdjust(editPointsFor.name, editPointsDelta, editPointsReason.trim() || `Balance set to ${target}`)
      setMessage({ ok: true, text: `${editPointsFor.name}'s balance updated to ${target.toLocaleString('en-IN')} points` })
      setEditPointsFor(null)
      loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update points')
    } finally {
      setSaving(false)
    }
  }

  // All loyalty entries for recent transactions table
  const [allEntries, setAllEntries] = useState<LoyaltyEntry[]>([])

  // Load customers and their loyalty balances
  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const custs = await dbApi.getCustomers()
      setCustomers(custs)

      // Fetch loyalty balances for all customers with transactions
      const balanceMap = new Map<string, { balance: number; entries: LoyaltyEntry[] }>()
      const allEntriesList: LoyaltyEntry[] = []

      // Fetch balances in parallel (limited batch)
      const batch = custs.slice(0, 100)
      await Promise.allSettled(
        batch.map(async (c) => {
          try {
            const [balRes, histRes] = await Promise.all([
              dbApi.loyaltyBalance(c.name),
              dbApi.loyaltyHistory(c.name),
            ])
            if (balRes.found && balRes.balance != null && balRes.balance !== 0) {
              const mappedEntries: LoyaltyEntry[] = (histRes.entries ?? []).map((e) => ({
                ...e,
                points: Number(e.points ?? 0),
                balanceAfter: Number(e.balanceAfter ?? 0),
              }))
              balanceMap.set(c.id, {
                balance: balRes.balance,
                entries: mappedEntries,
              })
              for (const e of mappedEntries) {
                allEntriesList.push({ ...e, customerId: c.id })
              }
            }
          } catch {
            // Skip failed customers
          }
        })
      )

      setLoyaltyData(balanceMap)
      setAllEntries(
        allEntriesList
          .sort((a, b) => String(b.date).localeCompare(String(a.date)))
          .slice(0, 50)
      )
    } catch {
      // Ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Defer: loadData() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(loadData)
  }, [loadData])

  const enrichedCustomers = useMemo<CustomerWithBalance[]>(() => {
    return customers
      .map((c) => {
        const data = loyaltyData.get(c.id)
        const balance = data?.balance ?? 0
        const entries = data?.entries ?? []
        const totalEarned = entries
          .filter((e) => e.type === 'earn')
          .reduce((a, e) => a + Math.abs(Number(e.points)), 0)
        const totalRedeemed = entries
          .filter((e) => e.type === 'redeem')
          .reduce((a, e) => a + Math.abs(Number(e.points)), 0)
        return {
          ...c,
          balance,
          tier: getTier(balance).label,
          totalEarned,
          totalRedeemed,
        }
      })
      .filter((c) => c.balance !== 0 || loyaltyData.has(c.id))
      .sort((a, b) => b.balance - a.balance)
  }, [customers, loyaltyData])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return enrichedCustomers.filter(
      (c) =>
        !q ||
        c.name.toLowerCase().includes(q) ||
        (c.phone ?? '').toLowerCase().includes(q) ||
        c.tier.toLowerCase().includes(q)
    )
  }, [enrichedCustomers, query])

  const totalPoints = enrichedCustomers.reduce((a, c) => a + c.balance, 0)
  const totalEarnedAll = enrichedCustomers.reduce((a, c) => a + c.totalEarned, 0)
  const totalRedeemedAll = enrichedCustomers.reduce((a, c) => a + c.totalRedeemed, 0)

  const customerOptions = useMemo(
    () =>
      customers
        .filter((c) => c.status === 'active')
        .map((c) => ({
          label: c.name,
          value: c.name,
          subtitle: c.phone ?? c.email ?? '',
          keywords: [c.name, c.phone ?? '', c.email ?? ''].join(' '),
        })),
    [customers]
  )

  const handleAddPoints = async () => {
    if (!addFormCustomer.trim()) { setError('Select a customer'); return }
    const pts = parseInt(addFormPoints, 10)
    if (!pts || pts <= 0) { setError('Enter valid points'); return }
    setSaving(true)
    setError('')
    try {
      await dbApi.loyaltyAdjust(addFormCustomer, pts, addFormReason.trim() || 'Manual points addition')
      setMessage({ ok: true, text: `${pts} points added to ${addFormCustomer}` })
      setShowAddPoints(false)
      setAddFormCustomer('')
      setAddFormPoints('')
      setAddFormReason('')
      loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add points')
    } finally {
      setSaving(false)
    }
  }

  const handleRedeemPoints = async () => {
    if (!redeemFormCustomer.trim()) { setError('Select a customer'); return }
    const pts = parseInt(redeemFormPoints, 10)
    if (!pts || pts <= 0) { setError('Enter valid points'); return }
    setSaving(true)
    setError('')
    try {
      const result = await dbApi.loyaltyRedeem(redeemFormCustomer, pts)
      if (result.ok) {
        setMessage({ ok: true, text: `${pts} points redeemed for ${redeemFormCustomer}. Balance: ${result.balanceAfter}` })
        setShowRedeemPoints(false)
        setRedeemFormCustomer('')
        setRedeemFormPoints('')
        setRedeemFormReason('')
        loadData()
      } else {
        setError(result.error ?? 'Redemption failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to redeem points')
    } finally {
      setSaving(false)
    }
  }

  const customerColumns = useMemo<ColumnDef<CustomerWithBalance>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Customer',
        meta: { headerClassName: 'min-w-[180px]' },
        cell: ({ row }) => (
          <div>
            <p className="font-medium text-foreground">{row.original.name}</p>
            <p className="text-[11px] text-muted-foreground">{row.original.phone ?? row.original.email ?? '—'}</p>
          </div>
        ),
      },
      {
        accessorKey: 'totalEarned',
        header: 'Earned',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <span className="flex items-center justify-end gap-1 tabular-nums text-emerald-600">
            <TrendingUp className="h-3 w-3" />
            {row.original.totalEarned.toLocaleString('en-IN')}
          </span>
        ),
      },
      {
        accessorKey: 'totalRedeemed',
        header: 'Redeemed',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <span className="flex items-center justify-end gap-1 tabular-nums text-rose-600">
            <TrendingDown className="h-3 w-3" />
            {row.original.totalRedeemed.toLocaleString('en-IN')}
          </span>
        ),
      },
      {
        accessorKey: 'balance',
        header: 'Net Points',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <span className="font-semibold tabular-nums text-foreground">
            {row.original.balance.toLocaleString('en-IN')}
          </span>
        ),
      },
      {
        accessorKey: 'tier',
        header: 'Tier',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const t = getTier(row.original.balance)
          return <Badge className={t.color} variant="outline">{t.label}</Badge>
        },
      },
      {
        id: 'actions',
        header: 'Actions',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit points for ${row.original.name}`}
            onClick={() => openEditPoints(row.original)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        ),
      },
    ],
    [openEditPoints]
  )

  const transactionColumns = useMemo<ColumnDef<LoyaltyEntry>[]>(
    () => [
      {
        id: 'customer',
        header: 'Customer',
        cell: ({ row }) => {
          const cust = customers.find((c) => c.id === row.original.customerId)
          return <span className="font-medium text-foreground">{cust?.name ?? '—'}</span>
        },
      },
      {
        accessorKey: 'type',
        header: 'Type',
        meta: { align: 'center' as const },
        cell: ({ row }) => (
          <Badge
            variant={
              row.original.type === 'earn'
                ? 'success'
                : row.original.type === 'redeem'
                  ? 'warning'
                  : 'info'
            }
          >
            {row.original.type === 'earn' ? 'Earned' : row.original.type === 'redeem' ? 'Redeemed' : 'Adjusted'}
          </Badge>
        ),
      },
      {
        accessorKey: 'points',
        header: 'Points',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <span
            className={`tabular-nums font-semibold ${
              Number(row.original.points) >= 0 ? 'text-emerald-600' : 'text-rose-600'
            }`}
          >
            {Number(row.original.points) >= 0 ? '+' : ''}
            {Number(row.original.points).toLocaleString('en-IN')}
          </span>
        ),
      },
      {
        id: 'reference',
        header: 'Reference',
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.invoiceNumber ?? row.original.note ?? '—'}
          </span>
        ),
      },
      {
        accessorKey: 'date',
        header: 'Date',
        cell: ({ row }) => (
          <span className="text-muted-foreground">{formatDate(row.original.date)}</span>
        ),
      },
    ],
    [customers]
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Customer Loyalty"
        subtitle="Manage loyalty points — earn, redeem, and track customer rewards."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setShowSettings(true)}>
              <Settings className="h-3.5 w-3.5" /> Settings
            </Button>
            <Button variant="outline" size="sm" onClick={() => { setError(''); setShowRedeemPoints(true) }}>
              <TrendingDown className="h-3.5 w-3.5" /> Redeem Points
            </Button>
            <Button size="sm" onClick={() => { setError(''); setShowAddPoints(true) }}>
              <Plus className="h-4 w-4" /> Add Points
            </Button>
          </>
        }
      />

      {message && (
        <Card className={`border ${message.ok ? 'border-success-200 bg-success-50' : 'border-red-200 bg-red-50'}`}>
          <CardContent className="flex items-center gap-2 p-3 text-sm">
            {message.ok ? <Sparkles className="h-4 w-4 text-success-600" /> : <span className="text-red-600 dark:text-red-400">⚠</span>}
            <span className={message.ok ? 'text-success-800' : 'text-red-800'}>{message.text}</span>
          </CardContent>
        </Card>
      )}

      {/* Summary tiles */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Card className="p-3 sm:p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
              <Gift className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Active Points</p>
              <p className="text-lg font-bold text-foreground">{totalPoints.toLocaleString('en-IN')}</p>
            </div>
          </div>
        </Card>
        <Card className="p-3 sm:p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success-50 text-success-700">
              <TrendingUp className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Earned</p>
              <p className="text-lg font-bold text-foreground">{totalEarnedAll.toLocaleString('en-IN')}</p>
            </div>
          </div>
        </Card>
        <Card className="p-3 sm:p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-warning-50 text-warning-700">
              <TrendingDown className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Redeemed</p>
              <p className="text-lg font-bold text-foreground">{totalRedeemedAll.toLocaleString('en-IN')}</p>
            </div>
          </div>
        </Card>
        <Card className="p-3 sm:p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-info-50 text-info-700">
              <Star className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Enrolled Customers</p>
              <p className="text-lg font-bold text-foreground">{enrichedCustomers.length}</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Customer Loyalty Points Summary */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Customer Points Summary</h2>
            <div className="relative min-w-[240px] flex-1 max-w-sm ml-4">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search customer or tier..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
          <DataTable
            columns={customerColumns}
            data={filtered}
            loading={loading}
            emptyMessage="No loyalty data found. Add points to customers to get started."
          />
        </CardContent>
      </Card>

      {/* Recent Transactions */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Recent Transactions</h2>
          </div>
          <DataTable
            columns={transactionColumns}
            data={allEntries}
            loading={loading}
            emptyMessage="No loyalty transactions yet."
          />
        </CardContent>
      </Card>

      {/* Add Points Dialog */}
      <AppDialog
        open={showAddPoints}
        onOpenChange={(open) => { setShowAddPoints(open); if (!open) setError('') }}
        size="sm"
        isDirty={showAddPoints && Boolean(addFormCustomer || addFormPoints || addFormReason)}
        title="Add Loyalty Points"
        description="Manually add points to a customer's loyalty balance."
        footer={
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowAddPoints(false)}>Cancel</Button>
            <Button size="sm" onClick={handleAddPoints} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add Points
            </Button>
          </DialogFooter>
        }
      >
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Customer</Label>
              <SearchableSelect
                options={customerOptions}
                value={addFormCustomer}
                onValueChange={setAddFormCustomer}
                placeholder="Select customer"
                searchPlaceholder="Search by name or phone..."
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-points">Points to Add</Label>
              <Input
                id="add-points"
                type="number"
                min="1"
                value={addFormPoints}
                onChange={(e) => setAddFormPoints(e.target.value)}
                placeholder="e.g. 50"
              />
              <p className="text-[11px] text-muted-foreground">1 point = ₹1 value</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-reason">Reason</Label>
              <Input
                id="add-reason"
                value={addFormReason}
                onChange={(e) => setAddFormReason(e.target.value)}
                placeholder="e.g. Birthday bonus, festive reward..."
              />
            </div>
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
      </AppDialog>

      {/* Redeem Points Dialog */}
      <AppDialog
        open={showRedeemPoints}
        onOpenChange={(open) => { setShowRedeemPoints(open); if (!open) setError('') }}
        size="sm"
        isDirty={showRedeemPoints && Boolean(redeemFormCustomer || redeemFormPoints || redeemFormReason)}
        title="Redeem Loyalty Points"
        description="Deduct points from a customer's loyalty balance."
        footer={
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowRedeemPoints(false)}>Cancel</Button>
            <Button size="sm" onClick={handleRedeemPoints} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <TrendingDown className="h-4 w-4" />}
              Redeem Points
            </Button>
          </DialogFooter>
        }
      >
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Customer</Label>
              <SearchableSelect
                options={customerOptions}
                value={redeemFormCustomer}
                onValueChange={setRedeemFormCustomer}
                placeholder="Select customer"
                searchPlaceholder="Search by name or phone..."
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="redeem-points">Points to Redeem</Label>
              <Input
                id="redeem-points"
                type="number"
                min="1"
                value={redeemFormPoints}
                onChange={(e) => setRedeemFormPoints(e.target.value)}
                placeholder="e.g. 100"
              />
              <p className="text-[11px] text-muted-foreground">Each point = ₹1 discount at billing</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="redeem-reason">Reason</Label>
              <Input
                id="redeem-reason"
                value={redeemFormReason}
                onChange={(e) => setRedeemFormReason(e.target.value)}
                placeholder="e.g. Billing discount, store credit..."
              />
            </div>
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
      </AppDialog>

      {/* Edit Points Dialog */}
      <AppDialog
        open={editPointsFor !== null}
        onOpenChange={(open) => { if (!open) setEditPointsFor(null) }}
        size="sm"
        isDirty={editPointsFor !== null && (editPointsValue !== String(editPointsFor.balance) || Boolean(editPointsReason))}
        title={`Edit Points — ${editPointsFor?.name ?? ''}`}
        description="Set this customer's balance to an absolute value."
        footer={
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditPointsFor(null)}>Cancel</Button>
            <Button size="sm" onClick={() => void handleEditPoints()} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />}
              Save Points
            </Button>
          </DialogFooter>
        }
      >
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Current balance</span>
              <span className="font-semibold tabular-nums text-foreground">{editPointsFor ? editPointsFor.balance.toLocaleString('en-IN') : '0'} pts</span>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-points-value">New balance</Label>
              <Input
                id="edit-points-value"
                type="number"
                min="0"
                value={editPointsValue}
                onChange={(e) => setEditPointsValue(e.target.value)}
                placeholder="e.g. 250"
              />
              <p className="text-[11px] text-muted-foreground">
                Adjustment applied: <b className={editPointsDelta >= 0 ? 'text-emerald-600' : 'text-rose-600'}>{editPointsDelta >= 0 ? '+' : ''}{editPointsDelta}</b> points · 1 point = ₹1
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-points-reason">Reason</Label>
              <Input
                id="edit-points-reason"
                value={editPointsReason}
                onChange={(e) => setEditPointsReason(e.target.value)}
                placeholder="e.g. Manual correction, promo bonus..."
              />
            </div>
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
      </AppDialog>

      {/* Settings Dialog */}
      <AppDialog
        open={showSettings}
        onOpenChange={setShowSettings}
        size="md"
        title="Loyalty Program Settings"
        description="Configure how loyalty points are earned and redeemed."
        footer={
          <DialogFooter>
            <Button size="sm" onClick={() => setShowSettings(false)}>Done</Button>
          </DialogFooter>
        }
      >
          <div className="space-y-4">
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
              <div className="flex items-center gap-2 mb-2">
                <Tag className="h-4 w-4 text-primary-600" />
                <span className="text-sm font-semibold text-foreground">Program Rules</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
                <div>
                  <p>Earning Rate</p>
                  <p className="font-semibold text-foreground">1 point per ₹100 spent</p>
                </div>
                <div>
                  <p>Point Value</p>
                  <p className="font-semibold text-foreground">1 point = ₹1</p>
                </div>
                <div>
                  <p>Minimum for Redemption</p>
                  <p className="font-semibold text-foreground">1 point</p>
                </div>
                <div>
                  <p>Status</p>
                  <p className="font-semibold text-emerald-600">Active</p>
                </div>
              </div>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
              <p className="text-xs font-semibold text-foreground mb-2">Tier Structure</p>
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <Badge className="bg-violet-100 dark:bg-violet-950/40 text-violet-700" variant="outline">Platinum</Badge>
                  <span className="text-muted-foreground">1,000+ points</span>
                </div>
                <div className="flex items-center justify-between">
                  <Badge className="bg-amber-100 text-amber-700" variant="outline">Gold</Badge>
                  <span className="text-muted-foreground">500+ points</span>
                </div>
                <div className="flex items-center justify-between">
                  <Badge className="bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" variant="outline">Silver</Badge>
                  <span className="text-muted-foreground">100+ points</span>
                </div>
                <div className="flex items-center justify-between">
                  <Badge className="bg-orange-50 dark:bg-orange-950/40 text-orange-700" variant="outline">Bronze</Badge>
                  <span className="text-muted-foreground">0+ points</span>
                </div>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Points are automatically earned on invoice creation (1 point per ₹100 spent). 
              Configure advanced settings via the .env file: LOYALTY_ENABLED, LOYALTY_POINTS_PER.
            </p>
          </div>
      </AppDialog>
    </div>
  )
}
