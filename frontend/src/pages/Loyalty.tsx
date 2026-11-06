import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CalendarClock,
  Eye,
  Gift,
  History,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Star,
  Store,
  Tag,
  TrendingDown,
  TrendingUp,
  Users,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import { Select } from '@/components/ui/select'
import type { ColumnDef } from '@/lib/table'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import { dbApi } from '@/lib/api'
import { useAuth } from '@/auth/auth-context'
import type {
  Customer,
  LoyaltyConfig,
  LoyaltyCustomerProfile,
  LoyaltyCustomerRow,
  LoyaltyEntry,
  LoyaltySummary,
  LoyaltySyncStatus,
  LoyaltyTransactionRow,
} from '@/types'
import { formatDate, formatDateTime } from '@/lib/format'

/** How each ledger movement is labelled and coloured. */
const TYPE_META: Record<string, { label: string; variant: 'success' | 'warning' | 'info' | 'danger' | 'muted' }> = {
  earn: { label: 'Earned', variant: 'success' },
  redeem: { label: 'Redeemed', variant: 'warning' },
  adjust: { label: 'Adjusted', variant: 'info' },
  refund: { label: 'Refunded', variant: 'danger' },
  expire: { label: 'Expired', variant: 'muted' },
}

const SOURCE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  shopify_order: 'Shopify order',
  shopify_refund: 'Shopify refund',
  return: 'Return',
  manual: 'Manual',
  expiry: 'Expiry',
  redeem: 'Redemption',
  cancel: 'Cancellation',
}

const TYPE_OPTIONS = [
  { label: 'All types', value: 'all' },
  { label: 'Earned', value: 'earn' },
  { label: 'Redeemed', value: 'redeem' },
  { label: 'Adjusted', value: 'adjust' },
  { label: 'Refunded', value: 'refund' },
  { label: 'Expired', value: 'expire' },
]

const TIER_COLORS: Record<string, string> = {
  Platinum: 'bg-violet-100 dark:bg-violet-950/40 text-violet-700',
  Gold: 'bg-amber-100 text-amber-700',
  Silver: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  Bronze: 'bg-orange-50 dark:bg-orange-950/40 text-orange-700',
}

const EMPTY_SUMMARY: LoyaltySummary = {
  enrolledCustomers: 0,
  pointsIssued: 0,
  pointsRedeemed: 0,
  pointsRefunded: 0,
  pointsAdjusted: 0,
  pointsExpired: 0,
  pointsOutstanding: 0,
  transactions: 0,
  lastActivityAt: null,
}

/** Customers created by Shopify can legitimately have a blank name. */
function customerLabel(row: {
  id: string
  name?: string | null
  customerName?: string | null
  shopifyId?: string | null
}): string {
  const label = row.name?.trim() || row.customerName?.trim()
  if (label) return label
  if (row.shopifyId) return `Shopify customer #${row.shopifyId}`
  return `Customer ${row.id.slice(0, 8)}`
}

function points(value: number | null | undefined): string {
  return Number(value ?? 0).toLocaleString('en-IN')
}

export default function LoyaltyPage() {
  const { hasPermission } = useAuth()
  const canAdjust = hasPermission('system', 'edit')

  const [summary, setSummary] = useState<LoyaltySummary>(EMPTY_SUMMARY)
  const [config, setConfig] = useState<LoyaltyConfig | null>(null)
  const [syncStatus, setSyncStatus] = useState<LoyaltySyncStatus | null>(null)

  const [customers, setCustomers] = useState<LoyaltyCustomerRow[]>([])
  const [customersTotal, setCustomersTotal] = useState(0)
  const [query, setQuery] = useState('')

  const [transactions, setTransactions] = useState<LoyaltyTransactionRow[]>([])
  const [txTotal, setTxTotal] = useState(0)
  const [txType, setTxType] = useState('all')
  const [txFrom, setTxFrom] = useState('')
  const [txTo, setTxTo] = useState('')
  const [txSearch, setTxSearch] = useState('')

  const [loadingSummary, setLoadingSummary] = useState(true)
  const [loadingCustomers, setLoadingCustomers] = useState(true)
  const [loadingTransactions, setLoadingTransactions] = useState(true)
  const [loadingSync, setLoadingSync] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  // Every customer (for the add/redeem selects) — loaded when a dialog opens.
  const [allCustomers, setAllCustomers] = useState<Customer[]>([])
  const [loadingAllCustomers, setLoadingAllCustomers] = useState(false)

  const [showAddPoints, setShowAddPoints] = useState(false)
  const [showRedeemPoints, setShowRedeemPoints] = useState(false)
  const [formCustomerId, setFormCustomerId] = useState('')
  const [formPoints, setFormPoints] = useState('')
  const [formReason, setFormReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const [editFor, setEditFor] = useState<LoyaltyCustomerRow | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editReason, setEditReason] = useState('')

  const [profile, setProfile] = useState<LoyaltyCustomerProfile | null>(null)
  const [profileId, setProfileId] = useState<string | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)

  const [showSettings, setShowSettings] = useState(false)
  const [settingsForm, setSettingsForm] = useState({
    enabled: true,
    pointsPer: '100',
    pointValue: '1',
    minOrderValue: '0',
    expiryMonths: '0',
    shopifySync: false,
    metafieldNamespace: 'opal_line',
    metafieldKey: 'loyalty_points',
  })
  const [savingSettings, setSavingSettings] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const loadSummary = useCallback(async () => {
    setLoadingSummary(true)
    try {
      const res = await dbApi.loyaltySummary()
      setSummary(res.summary)
      setConfig(res.config)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load loyalty totals')
    } finally {
      setLoadingSummary(false)
    }
  }, [])

  const loadSyncStatus = useCallback(async () => {
    setLoadingSync(true)
    try {
      setSyncStatus(await dbApi.loyaltySyncStatus())
    } catch {
      setSyncStatus(null)
    } finally {
      setLoadingSync(false)
    }
  }, [])

  const loadCustomers = useCallback(async (search: string) => {
    setLoadingCustomers(true)
    try {
      const res = await dbApi.loyaltyCustomers({ query: search || undefined, limit: 100 })
      setCustomers(res.customers)
      setCustomersTotal(res.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load loyalty customers')
    } finally {
      setLoadingCustomers(false)
    }
  }, [])

  const loadTransactions = useCallback(
    async (filters: { type: string; from: string; to: string; search: string }) => {
      setLoadingTransactions(true)
      try {
        const res = await dbApi.loyaltyTransactions({
          type: filters.type !== 'all' ? filters.type : undefined,
          from: filters.from || undefined,
          to: filters.to || undefined,
          search: filters.search || undefined,
          limit: 100,
        })
        setTransactions(res.transactions)
        setTxTotal(res.total)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load loyalty transactions')
      } finally {
        setLoadingTransactions(false)
      }
    },
    []
  )

  const refreshAll = useCallback(() => {
    void loadSummary()
    void loadSyncStatus()
    void loadCustomers(query)
  }, [loadSummary, loadSyncStatus, loadCustomers, query])

  useEffect(() => {
    queueMicrotask(() => {
      void loadSummary()
      void loadSyncStatus()
    })
  }, [loadSummary, loadSyncStatus])

  // Customer search is debounced so typing does not fire a query per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      void loadCustomers(query)
    }, 250)
    return () => clearTimeout(timer)
  }, [query, loadCustomers])

  // Ledger filters share one debounce.
  useEffect(() => {
    const timer = setTimeout(() => {
      void loadTransactions({ type: txType, from: txFrom, to: txTo, search: txSearch })
    }, 250)
    return () => clearTimeout(timer)
  }, [txType, txFrom, txTo, txSearch, loadTransactions])

  const loadAllCustomers = useCallback(async () => {
    if (allCustomers.length > 0) return
    setLoadingAllCustomers(true)
    try {
      setAllCustomers(await dbApi.getCustomers())
    } catch {
      setAllCustomers([])
    } finally {
      setLoadingAllCustomers(false)
    }
  }, [allCustomers.length])

  const openProfile = useCallback(async (customerId: string) => {
    setProfileId(customerId)
    setProfile(null)
    setProfileLoading(true)
    try {
      setProfile(await dbApi.loyaltyCustomerProfile(customerId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load customer history')
      setProfileId(null)
    } finally {
      setProfileLoading(false)
    }
  }, [])

  const customerOptions = useMemo(
    () =>
      allCustomers
        .filter((c) => c.status !== 'inactive')
        .map((c) => ({
          label: customerLabel(c),
          value: c.id,
          subtitle: c.phone ?? c.email ?? '',
          keywords: [c.name, c.phone ?? '', c.email ?? ''].join(' '),
        })),
    [allCustomers]
  )

  const handleAddPoints = async () => {
    if (!formCustomerId) { setFormError('Select a customer'); return }
    const pts = Math.floor(Number(formPoints))
    if (!Number.isFinite(pts) || pts <= 0) { setFormError('Enter a positive number of points'); return }
    setSaving(true)
    setFormError('')
    try {
      await dbApi.loyaltyAdjust(formCustomerId, pts, formReason.trim() || 'Manual points addition')
      setMessage({ ok: true, text: `${points(pts)} points added.` })
      setShowAddPoints(false)
      setFormCustomerId('')
      setFormPoints('')
      setFormReason('')
      refreshAll()
      void loadTransactions({ type: txType, from: txFrom, to: txTo, search: txSearch })
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to add points')
    } finally {
      setSaving(false)
    }
  }

  const handleRedeemPoints = async () => {
    if (!formCustomerId) { setFormError('Select a customer'); return }
    const pts = Math.floor(Number(formPoints))
    if (!Number.isFinite(pts) || pts <= 0) { setFormError('Enter a positive number of points'); return }
    setSaving(true)
    setFormError('')
    try {
      const result = await dbApi.loyaltyRedeem(formCustomerId, pts)
      if (!result.ok) { setFormError(result.error ?? 'Redemption failed'); return }
      setMessage({ ok: true, text: `${points(pts)} points redeemed. Balance: ${points(result.balanceAfter)}.` })
      setShowRedeemPoints(false)
      setFormCustomerId('')
      setFormPoints('')
      setFormReason('')
      refreshAll()
      void loadTransactions({ type: txType, from: txFrom, to: txTo, search: txSearch })
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to redeem points')
    } finally {
      setSaving(false)
    }
  }

  const openEditPoints = useCallback((row: LoyaltyCustomerRow) => {
    setEditFor(row)
    setEditValue(String(Math.round(row.balance)))
    setEditReason('')
    setFormError('')
  }, [])

  const editDelta = editFor ? Math.round(Number(editValue || 0) - editFor.balance) : 0

  const handleEditPoints = async () => {
    if (!editFor) return
    const target = Math.round(Number(editValue))
    if (!Number.isFinite(target) || target < 0) { setFormError('Enter a valid balance (0 or more)'); return }
    if (editDelta === 0) { setEditFor(null); return }
    setSaving(true)
    setFormError('')
    try {
      await dbApi.loyaltyAdjust(editFor.id, editDelta, editReason.trim() || `Balance set to ${target}`)
      setMessage({ ok: true, text: `${customerLabel(editFor)}'s balance updated to ${points(target)} points.` })
      setEditFor(null)
      refreshAll()
      void loadTransactions({ type: txType, from: txFrom, to: txTo, search: txSearch })
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to update points')
    } finally {
      setSaving(false)
    }
  }

  const openSettings = () => {
    if (config) {
      setSettingsForm({
        enabled: config.enabled,
        pointsPer: String(config.pointsPer),
        pointValue: String(config.pointValue),
        minOrderValue: String(config.minOrderValue),
        expiryMonths: String(config.expiryMonths ?? 0),
        shopifySync: config.shopifySync,
        metafieldNamespace: config.metafieldNamespace,
        metafieldKey: config.metafieldKey,
      })
    }
    setFormError('')
    setShowSettings(true)
    void loadAllCustomers()
  }

  const handleSaveSettings = async () => {
    setSavingSettings(true)
    setFormError('')
    try {
      const res = await dbApi.loyaltyUpdateSettings({
        enabled: settingsForm.enabled,
        pointsPer: Number(settingsForm.pointsPer),
        pointValue: Number(settingsForm.pointValue),
        minOrderValue: Number(settingsForm.minOrderValue),
        expiryMonths: Number(settingsForm.expiryMonths),
        shopifySync: settingsForm.shopifySync,
        metafieldNamespace: settingsForm.metafieldNamespace,
        metafieldKey: settingsForm.metafieldKey,
      })
      setConfig(res.config)
      setShowSettings(false)
      setMessage({ ok: true, text: 'Loyalty settings saved.' })
      void loadSyncStatus()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save settings')
    } finally {
      setSavingSettings(false)
    }
  }

  const handleSyncPush = async () => {
    setSyncing(true)
    try {
      const res = await dbApi.loyaltySync()
      setMessage({
        ok: res.failed === 0,
        text: res.failed === 0
          ? `Pushed ${res.pushed} customer balance${res.pushed === 1 ? '' : 's'} to Shopify.`
          : `Pushed ${res.pushed}, ${res.failed} failed. ${res.errors[0]?.error ?? ''}`,
      })
      void loadSyncStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Shopify push failed')
    } finally {
      setSyncing(false)
    }
  }

  const handleSyncRetry = async () => {
    setSyncing(true)
    try {
      const res = await dbApi.loyaltySyncRetry()
      setMessage({ ok: res.failed === 0, text: `Retried: ${res.pushed} pushed, ${res.failed} still failing.` })
      void loadSyncStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed')
    } finally {
      setSyncing(false)
    }
  }

  const handleRunExpiry = async () => {
    setSavingSettings(true)
    setFormError('')
    try {
      const res = await dbApi.loyaltyExpire()
      setMessage({ ok: true, text: `Expired ${points(res.expiredPoints)} points across ${res.lots} lot(s).` })
      setShowSettings(false)
      refreshAll()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Expiry run failed')
    } finally {
      setSavingSettings(false)
    }
  }

  const customerColumns = useMemo<ColumnDef<LoyaltyCustomerRow>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Customer',
        meta: { headerClassName: 'min-w-[190px]' },
        cell: ({ row }) => (
          <div>
            <p className="font-medium text-foreground">{customerLabel(row.original)}</p>
            <p className="text-[11px] text-muted-foreground">
              {row.original.phone ?? row.original.email ?? (row.original.shopifyId ? 'Shopify customer' : '—')}
            </p>
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
            {points(row.original.totalEarned)}
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
            {points(row.original.totalRedeemed)}
          </span>
        ),
      },
      {
        accessorKey: 'totalExpired',
        header: 'Expired',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">{points(row.original.totalExpired)}</span>
        ),
      },
      {
        accessorKey: 'balance',
        header: 'Balance',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <span className="font-semibold tabular-nums text-foreground">{points(row.original.balance)}</span>
        ),
      },
      {
        accessorKey: 'tier',
        header: 'Tier',
        meta: { align: 'center' as const },
        cell: ({ row }) => (
          <Badge className={TIER_COLORS[row.original.tier] ?? TIER_COLORS.Bronze} variant="outline">
            {row.original.tier}
          </Badge>
        ),
      },
      {
        id: 'actions',
        header: 'Actions',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`View history for ${customerLabel(row.original)}`}
              onClick={(event) => {
                event.stopPropagation()
                void openProfile(row.original.id)
              }}
            >
              <Eye className="h-3.5 w-3.5" />
            </Button>
            {canAdjust && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Edit points for ${customerLabel(row.original)}`}
                onClick={(event) => {
                  event.stopPropagation()
                  openEditPoints(row.original)
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        ),
      },
    ],
    [canAdjust, openEditPoints, openProfile]
  )

  const transactionColumns = useMemo<ColumnDef<LoyaltyTransactionRow>[]>(
    () => [
      {
        id: 'customer',
        header: 'Customer',
        meta: { headerClassName: 'min-w-[170px]' },
        cell: ({ row }) => (
          <div>
            <p className="font-medium text-foreground">{customerLabel(row.original)}</p>
            <p className="text-[11px] text-muted-foreground">{row.original.customerPhone ?? '—'}</p>
          </div>
        ),
      },
      {
        accessorKey: 'type',
        header: 'Type',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const meta = TYPE_META[row.original.type] ?? { label: row.original.type, variant: 'muted' as const }
          return <Badge variant={meta.variant}>{meta.label}</Badge>
        },
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
            {points(row.original.points)}
          </span>
        ),
      },
      {
        accessorKey: 'balanceAfter',
        header: 'Balance',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.balanceAfter == null ? '—' : points(row.original.balanceAfter)}
          </span>
        ),
      },
      {
        id: 'reference',
        header: 'Reference',
        cell: ({ row }) => (
          <div className="text-xs text-muted-foreground">
            <p className="font-medium text-foreground">
              {row.original.invoiceNumber ?? row.original.externalRef ?? '—'}
            </p>
            <p className="truncate max-w-[240px]">
              {row.original.source ? SOURCE_LABELS[row.original.source] ?? row.original.source : row.original.note ?? ''}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'date',
        header: 'Date',
        cell: ({ row }) => <span className="text-muted-foreground">{formatDate(row.original.date)}</span>,
      },
    ],
    []
  )

  const profileEntries = profile?.entries ?? []

  const entryColumns = useMemo<ColumnDef<LoyaltyEntry>[]>(
    () => [
      {
        accessorKey: 'type',
        header: 'Type',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const meta = TYPE_META[row.original.type] ?? { label: row.original.type, variant: 'muted' as const }
          return <Badge variant={meta.variant}>{meta.label}</Badge>
        },
      },
      {
        accessorKey: 'points',
        header: 'Points',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <span className={`tabular-nums font-semibold ${Number(row.original.points) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
            {Number(row.original.points) >= 0 ? '+' : ''}
            {points(row.original.points)}
          </span>
        ),
      },
      {
        accessorKey: 'balanceAfter',
        header: 'Balance',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.balanceAfter == null ? '—' : points(row.original.balanceAfter)}
          </span>
        ),
      },
      {
        id: 'detail',
        header: 'Detail',
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.note ?? row.original.invoiceNumber ?? row.original.source ?? '—'}
          </span>
        ),
      },
      {
        accessorKey: 'date',
        header: 'Date',
        cell: ({ row }) => <span className="text-muted-foreground">{formatDate(row.original.date)}</span>,
      },
    ],
    []
  )

  const tiles = [
    {
      label: 'Outstanding Points',
      value: points(summary.pointsOutstanding),
      hint: `Worth ₹${points(summary.pointsOutstanding * (config?.pointValue ?? 1))}`,
      icon: Gift,
      tone: 'bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300',
    },
    {
      label: 'Points Issued',
      value: points(summary.pointsIssued),
      hint: `${points(summary.transactions)} transactions`,
      icon: TrendingUp,
      tone: 'bg-success-50 text-success-700',
    },
    {
      label: 'Points Redeemed',
      value: points(summary.pointsRedeemed),
      hint: 'Redeemed at billing',
      icon: TrendingDown,
      tone: 'bg-warning-50 text-warning-700',
    },
    {
      label: 'Points Expired',
      value: points(summary.pointsExpired),
      hint: config?.expiryMonths ? `Expire after ${config.expiryMonths} months` : 'Expiry is off',
      icon: CalendarClock,
      tone: 'bg-muted text-muted-foreground',
    },
    {
      label: 'Reversed / Adjusted',
      value: points(summary.pointsRefunded + Math.abs(Math.min(0, summary.pointsAdjusted))),
      hint: 'Refunds, returns and corrections',
      icon: History,
      tone: 'bg-info-50 text-info-700',
    },
    {
      label: 'Loyalty Customers',
      value: points(summary.enrolledCustomers),
      hint: summary.lastActivityAt ? `Last activity ${formatDate(summary.lastActivityAt)}` : 'No activity yet',
      icon: Users,
      tone: 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300',
    },
  ]

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Customer Loyalty"
        subtitle="Manage loyalty points — earn, redeem, and track customer rewards."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => openSettings()}>
              <Settings className="h-3.5 w-3.5" /> Settings
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setFormError('')
                setFormCustomerId('')
                setFormPoints('')
                setFormReason('')
                setShowRedeemPoints(true)
                void loadAllCustomers()
              }}
            >
              <TrendingDown className="h-3.5 w-3.5" /> Redeem Points
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setFormError('')
                setFormCustomerId('')
                setFormPoints('')
                setFormReason('')
                setShowAddPoints(true)
                void loadAllCustomers()
              }}
            >
              <Plus className="h-4 w-4" /> Add Points
            </Button>
          </>
        }
      />

      {message && (
        <Card className={`border ${message.ok ? 'border-success-200 bg-success-50' : 'border-red-200 bg-red-50'}`}>
          <CardContent className="flex items-center gap-2 p-3 text-sm">
            {message.ok ? <Sparkles className="h-4 w-4 text-success-600" /> : <AlertTriangle className="h-4 w-4 text-red-600" />}
            <span className={message.ok ? 'text-success-800' : 'text-red-800'}>{message.text}</span>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setMessage(null)}>
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {error && (
        <Card className="border border-red-200 bg-red-50">
          <CardContent className="flex items-center gap-2 p-3 text-sm text-red-800">
            <AlertTriangle className="h-4 w-4" />
            <span>{error}</span>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setError('')}>
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Totals — read straight from the ledger, never summed in the browser. */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
        {tiles.map((tile) => (
          <Card key={tile.label} className="p-3 sm:p-4">
            <div className="flex items-start gap-3">
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tile.tone}`}>
                <tile.icon className="h-4.5 w-4.5" />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{tile.label}</p>
                <p className="text-lg font-bold text-foreground">
                  {loadingSummary ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : tile.value}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">{tile.hint}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Shopify synchronisation status */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Store className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">Shopify Synchronization</h2>
              {loadingSync ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : syncStatus ? (
                <Badge variant={syncStatus.enabled && syncStatus.shopifyConfigured ? 'success' : 'muted'}>
                  {!syncStatus.shopifyConfigured
                    ? 'Shopify not connected'
                    : syncStatus.enabled
                      ? 'Balance push enabled'
                      : 'Balance push off'}
                </Badge>
              ) : null}
            </div>
            {canAdjust && (
              <div className="flex items-center gap-2">
                {syncStatus && syncStatus.pendingRetries > 0 && (
                  <Button variant="outline" size="sm" onClick={() => void handleSyncRetry()} disabled={syncing}>
                    {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    Retry failed ({syncStatus.pendingRetries})
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => void handleSyncPush()} disabled={syncing}>
                  {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Push balances
                </Button>
              </div>
            )}
          </div>

          {syncStatus ? (
            <>
              <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                <div>
                  <p className="text-muted-foreground">Last successful sync</p>
                  <p className="font-semibold text-foreground">
                    {syncStatus.lastSyncedAt ? formatDateTime(syncStatus.lastSyncedAt) : 'Never'}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Synced (24h)</p>
                  <p className="font-semibold text-foreground">{syncStatus.successes24h}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Failures (24h)</p>
                  <p className={`font-semibold ${syncStatus.failures24h > 0 ? 'text-red-600' : 'text-foreground'}`}>
                    {syncStatus.failures24h}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Metafield</p>
                  <p className="font-semibold text-foreground">
                    {syncStatus.namespace}.{syncStatus.key}
                  </p>
                </div>
              </div>
              {syncStatus.recentErrors.length > 0 && (
                <div className="space-y-1 rounded-md border border-red-200 bg-red-50/60 p-2 text-[11px] text-red-800">
                  {syncStatus.recentErrors.map((e, index) => (
                    <p key={`${e.time}-${index}`} className="truncate">
                      {e.time ? formatDateTime(e.time) : 'Unknown time'} — {e.error ?? 'Unknown error'}
                    </p>
                  ))}
                </div>
              )}
              {!syncStatus.enabled && (
                <p className="text-[11px] text-muted-foreground">
                  Customers, orders, refunds and cancellations sync into the ERP automatically. Writing balances back
                  to Shopify is off — enable it in Settings once you are ready to publish points to customer metafields.
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Sync status is unavailable.</p>
          )}
        </CardContent>
      </Card>

      {/* Customer balances */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Customer Points Summary</h2>
              <p className="text-[11px] text-muted-foreground">
                {customersTotal} customer{customersTotal === 1 ? '' : 's'} with loyalty activity
              </p>
            </div>
            <div className="relative min-w-[240px] flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search customer, phone or email..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
          <DataTable
            columns={customerColumns}
            data={customers}
            loading={loadingCustomers}
            onRowClick={(row) => void openProfile(row.id)}
            emptyMessage={
              query
                ? `No loyalty customers match “${query}”.`
                : 'No loyalty activity yet. Points are earned automatically on invoices and paid Shopify orders.'
            }
          />
        </CardContent>
      </Card>

      {/* Ledger */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-muted-foreground" />
              <div>
                <h2 className="text-sm font-semibold text-foreground">Loyalty Transactions</h2>
                <p className="text-[11px] text-muted-foreground">{txTotal} movement{txTotal === 1 ? '' : 's'}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-[140px]">
                <Select
                  aria-label="Filter by transaction type"
                  options={TYPE_OPTIONS}
                  value={txType}
                  onValueChange={setTxType}
                />
              </div>
              <div className="w-[150px]">
                <Input
                  type="date"
                  aria-label="From date"
                  value={txFrom}
                  onChange={(e) => setTxFrom(e.target.value)}
                />
              </div>
              <div className="w-[150px]">
                <Input type="date" aria-label="To date" value={txTo} onChange={(e) => setTxTo(e.target.value)} />
              </div>
              <div className="relative w-[200px]">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Invoice, note, customer..."
                  value={txSearch}
                  onChange={(e) => setTxSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>
          </div>
          <DataTable
            columns={transactionColumns}
            data={transactions}
            loading={loadingTransactions}
            emptyMessage="No loyalty transactions match these filters."
          />
        </CardContent>
      </Card>

      {/* Add points */}
      <AppDialog
        open={showAddPoints}
        onOpenChange={(open) => { setShowAddPoints(open); if (!open) setFormError('') }}
        size="sm"
        isDirty={showAddPoints && Boolean(formCustomerId || formPoints || formReason)}
        title="Add Loyalty Points"
        description="Manually add points to a customer's loyalty balance. This is recorded in the audit trail."
        footer={
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowAddPoints(false)}>Cancel</Button>
            <Button size="sm" onClick={() => void handleAddPoints()} disabled={saving}>
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
              value={formCustomerId}
              onValueChange={setFormCustomerId}
              placeholder={loadingAllCustomers ? 'Loading customers...' : 'Select customer'}
              searchPlaceholder="Search by name or phone..."
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="add-points">Points to Add</Label>
            <Input
              id="add-points"
              type="number"
              min="1"
              value={formPoints}
              onChange={(e) => setFormPoints(e.target.value)}
              placeholder="e.g. 50"
            />
            <p className="text-[11px] text-muted-foreground">
              1 point = ₹{config?.pointValue ?? 1} at billing
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="add-reason">Reason</Label>
            <Input
              id="add-reason"
              value={formReason}
              onChange={(e) => setFormReason(e.target.value)}
              placeholder="e.g. Birthday bonus, festive reward..."
            />
          </div>
          {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
        </div>
      </AppDialog>

      {/* Redeem points */}
      <AppDialog
        open={showRedeemPoints}
        onOpenChange={(open) => { setShowRedeemPoints(open); if (!open) setFormError('') }}
        size="sm"
        isDirty={showRedeemPoints && Boolean(formCustomerId || formPoints)}
        title="Redeem Loyalty Points"
        description="Deduct points from a customer's loyalty balance."
        footer={
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowRedeemPoints(false)}>Cancel</Button>
            <Button size="sm" onClick={() => void handleRedeemPoints()} disabled={saving}>
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
              value={formCustomerId}
              onValueChange={setFormCustomerId}
              placeholder={loadingAllCustomers ? 'Loading customers...' : 'Select customer'}
              searchPlaceholder="Search by name or phone..."
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="redeem-points">Points to Redeem</Label>
            <Input
              id="redeem-points"
              type="number"
              min="1"
              value={formPoints}
              onChange={(e) => setFormPoints(e.target.value)}
              placeholder="e.g. 100"
            />
            <p className="text-[11px] text-muted-foreground">
              Each point = ₹{config?.pointValue ?? 1} discount at billing. The balance is checked server-side.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="redeem-reason">Reason</Label>
            <Input
              id="redeem-reason"
              value={formReason}
              onChange={(e) => setFormReason(e.target.value)}
              placeholder="e.g. Billing discount, store credit..."
            />
          </div>
          {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
        </div>
      </AppDialog>

      {/* Set balance */}
      <AppDialog
        open={editFor !== null}
        onOpenChange={(open) => { if (!open) setEditFor(null) }}
        size="sm"
        isDirty={editFor !== null && (editValue !== String(editFor.balance) || Boolean(editReason))}
        title={`Edit Points — ${editFor ? customerLabel(editFor) : ''}`}
        description="Set this customer's balance to an absolute value. The difference is posted as a manual adjustment."
        footer={
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditFor(null)}>Cancel</Button>
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
            <span className="font-semibold tabular-nums text-foreground">
              {editFor ? points(editFor.balance) : '0'} pts
            </span>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-points-value">New balance</Label>
            <Input
              id="edit-points-value"
              type="number"
              min="0"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              placeholder="e.g. 250"
            />
            <p className="text-[11px] text-muted-foreground">
              Adjustment applied:{' '}
              <b className={editDelta >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                {editDelta >= 0 ? '+' : ''}
                {editDelta}
              </b>{' '}
              points
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-points-reason">Reason</Label>
            <Input
              id="edit-points-reason"
              value={editReason}
              onChange={(e) => setEditReason(e.target.value)}
              placeholder="e.g. Manual correction, promo bonus..."
            />
          </div>
          {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
        </div>
      </AppDialog>

      {/* Customer history */}
      <AppDialog
        open={profileId !== null}
        onOpenChange={(open) => { if (!open) { setProfileId(null); setProfile(null) } }}
        size="lg"
        title={profile ? `Loyalty History — ${customerLabel(profile.customer)}` : 'Loyalty History'}
        description="Every point movement for this customer, newest first."
        footer={
          <DialogFooter>
            <Button size="sm" onClick={() => { setProfileId(null); setProfile(null) }}>Close</Button>
          </DialogFooter>
        }
      >
        {profileLoading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading history...
          </div>
        ) : profile ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
              {[
                { label: 'Balance', value: points(profile.balance) },
                { label: 'Earned', value: points(profile.totalEarned) },
                { label: 'Redeemed', value: points(profile.totalRedeemed) },
                { label: 'Reversed', value: points(profile.totalRefunded + Math.abs(Math.min(0, profile.totalAdjusted))) },
                { label: 'Expired', value: points(profile.totalExpired) },
              ].map((stat) => (
                <div key={stat.label} className="rounded-md border border-border/60 bg-muted/30 p-2">
                  <p className="text-muted-foreground">{stat.label}</p>
                  <p className="text-sm font-semibold tabular-nums text-foreground">{stat.value}</p>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <Badge className={TIER_COLORS[profile.tier] ?? TIER_COLORS.Bronze} variant="outline">
                {profile.tier}
              </Badge>
              {profile.customer.shopifyId && <span>Shopify ID {profile.customer.shopifyId}</span>}
              {profile.lastActivityAt && <span>Last activity {formatDate(profile.lastActivityAt)}</span>}
            </div>
            <DataTable
              columns={entryColumns}
              data={profileEntries}
              emptyMessage="No loyalty movements for this customer yet."
            />
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">Could not load this customer's history.</p>
        )}
      </AppDialog>

      {/* Settings */}
      <AppDialog
        open={showSettings}
        onOpenChange={(open) => { setShowSettings(open); if (!open) setFormError('') }}
        size="md"
        isDirty={false}
        title="Loyalty Program Settings"
        description="These rules drive earning, redemption, expiry and the Shopify metafield push."
        footer={
          <DialogFooter>
            <div className="mr-auto flex gap-2">
              {canAdjust && (config?.expiryMonths ?? 0) > 0 && (
                <Button variant="outline" size="sm" onClick={() => void handleRunExpiry()} disabled={savingSettings}>
                  <CalendarClock className="h-3.5 w-3.5" /> Expire due points
                </Button>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowSettings(false)}>Cancel</Button>
            <Button size="sm" onClick={() => void handleSaveSettings()} disabled={savingSettings}>
              {savingSettings ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Tag className="h-3.5 w-3.5" />}
              Save Settings
            </Button>
          </DialogFooter>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="loyalty-points-per">₹ spent per 1 point</Label>
              <Input
                id="loyalty-points-per"
                type="number"
                min="1"
                step="1"
                value={settingsForm.pointsPer}
                onChange={(e) => setSettingsForm((f) => ({ ...f, pointsPer: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="loyalty-point-value">₹ value of 1 point</Label>
              <Input
                id="loyalty-point-value"
                type="number"
                min="0.01"
                step="0.01"
                value={settingsForm.pointValue}
                onChange={(e) => setSettingsForm((f) => ({ ...f, pointValue: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="loyalty-min-order">Minimum order value (₹)</Label>
              <Input
                id="loyalty-min-order"
                type="number"
                min="0"
                step="1"
                value={settingsForm.minOrderValue}
                onChange={(e) => setSettingsForm((f) => ({ ...f, minOrderValue: e.target.value }))}
              />
              <p className="text-[11px] text-muted-foreground">0 = every purchase earns points</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="loyalty-expiry">Points expire after (months)</Label>
              <Input
                id="loyalty-expiry"
                type="number"
                min="0"
                step="1"
                value={settingsForm.expiryMonths}
                onChange={(e) => setSettingsForm((f) => ({ ...f, expiryMonths: e.target.value }))}
              />
              <p className="text-[11px] text-muted-foreground">0 = points never expire</p>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/60 bg-muted/30 px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Loyalty program enabled</p>
              <p className="text-[11px] text-muted-foreground">Off stops new points from being earned and redeemed.</p>
            </div>
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={settingsForm.enabled}
              onChange={(e) => setSettingsForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
          </div>

          <div className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Push balances to Shopify</p>
                <p className="text-[11px] text-muted-foreground">
                  Writes this ERP's points to a customer metafield. Shopify has no native loyalty balance.
                </p>
              </div>
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={settingsForm.shopifySync}
                onChange={(e) => setSettingsForm((f) => ({ ...f, shopifySync: e.target.checked }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="loyalty-namespace">Metafield namespace</Label>
                <Input
                  id="loyalty-namespace"
                  value={settingsForm.metafieldNamespace}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, metafieldNamespace: e.target.value }))}
                  placeholder="opal_line"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="loyalty-key">Metafield key</Label>
                <Input
                  id="loyalty-key"
                  value={settingsForm.metafieldKey}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, metafieldKey: e.target.value }))}
                  placeholder="loyalty_points"
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Keys written: <code>{settingsForm.metafieldKey || 'loyalty_points'}</code>,{' '}
              <code>{(settingsForm.metafieldKey || 'loyalty_points') + '_tier'}</code> and{' '}
              <code>{(settingsForm.metafieldKey || 'loyalty_points') + '_synced_at'}</code>. Other metafields are never touched.
            </p>
          </div>

          <div className="rounded-md border border-border/60 p-3 text-[11px] text-muted-foreground">
            <div className="mb-1 flex items-center gap-2">
              <Star className="h-3.5 w-3.5" />
              <span className="font-semibold text-foreground">Tiers (by current balance)</span>
            </div>
            Platinum 1,000+ · Gold 500+ · Silver 100+ · Bronze 0+
          </div>

          {!canAdjust && (
            <p className="text-[11px] text-muted-foreground">
              Saving rules, running expiry and pushing balances need system edit permission.
            </p>
          )}
          {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
        </div>
      </AppDialog>
    </div>
  )
}
