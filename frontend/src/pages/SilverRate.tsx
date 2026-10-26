import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock,
  Gem,
  History,
  IndianRupee,
  Maximize2,
  Minimize2,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Tag,
  TrendingUp,
  Undo2,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { dbApi, shopifyApi } from '@/lib/api'
import { useSilverRate } from '@/lib/silver-rate-context'
import type { PendingRateChange, Product, SilverRate, SilverRateAutoStatus, SilverRateProgress, SilverRateRequestRow, SilverRateRow } from '@/types'
import { formatCurrency, formatDateTime, formatWeight } from '@/lib/format'
import { cn } from '@/lib/utils'

interface SilverUpdateResult {
  ok: boolean
  rate: number
  previousRate: number
  affected: number
  matched: number
  updated: number
  skipped: number
  errors: string[]
  message?: string
  steps?: Array<{ key: string; label: string; status: 'done' | 'failed' | 'skipped'; detail?: string }>
}

interface Step {
  key: string
  label: string
  icon: LucideIcon
  desc: string
}

const steps: Step[] = [
  { key: 'request', label: 'Enter New Rate', icon: Tag, desc: 'Admin sets the new silver rate' },
  { key: 'preview', label: 'Preview Impact', icon: TrendingUp, desc: 'Review product price changes' },
  { key: 'approve', label: 'Approve & Sync', icon: ShieldCheck, desc: 'Push approved prices to Shopify' },
]

export default function SilverRatePage() {
  const { refresh: refreshSilverRate } = useSilverRate()
  const [step, setStep] = useState(0)
  const [newRate, setNewRate] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [processing, setProcessing] = useState(false)
  // Live backend progress of the in-flight apply, plus the minimised-pill view.
  const [rateProgress, setRateProgress] = useState<SilverRateProgress | null>(null)
  const [rateMinimized, setRateMinimized] = useState(false)
  const [error, setError] = useState('')
  const [products, setProducts] = useState<Product[]>([])
  const [syncFirst, setSyncFirst] = useState(true)
  const [currentRate, setCurrentRate] = useState<SilverRate>({ purity: 92.5, rate: 0, previousRate: 0, updatedAt: '', change: 0, changePercent: 0, currency: '₹' })
  const [history, setHistory] = useState<SilverRateRow[]>([])
  const [result, setResult] = useState<SilverUpdateResult | null>(null)
  const [pendingResult, setPendingResult] = useState<{ message: string; rate: number } | null>(null)
  const [syncingProducts, setSyncingProducts] = useState(false)
  const [syncResult, setSyncResult] = useState<{ ok: boolean; synced: number; created: number; updated: number; removed: number; errors: string[] } | null>(null)
  const [requests, setRequests] = useState<SilverRateRequestRow[]>([])
  const [isApprover, setIsApprover] = useState(false)
  const [autoStatus, setAutoStatus] = useState<SilverRateAutoStatus | null>(null)
  const [togglingAuto, setTogglingAuto] = useState(false)
  const [fetchingNow, setFetchingNow] = useState(false)
  const [fetchNowResult, setFetchNowResult] = useState<{ ok: boolean; message: string } | null>(null)
  // One-off scheduled rate changes: a rate + a specific date/time applied
  // automatically then (queue lives in settings.scheduled_rate_changes).
  // Guided dialog state — rate → when → preview, plus edit-in-place.
  const [scheduled, setScheduled] = useState<PendingRateChange[]>([])
  const [schOpen, setSchOpen] = useState(false)
  const [schStep, setSchStep] = useState(0)
  const [schRate, setSchRate] = useState('')
  const [schDate, setSchDate] = useState('')
  const [schTime, setSchTime] = useState('')
  const [schNote, setSchNote] = useState('')
  const [schEditId, setSchEditId] = useState<string | null>(null)
  const [schSaving, setSchSaving] = useState(false)
  const [schError, setSchError] = useState('')
  const [schSuccess, setSchSuccess] = useState('')
  const [whenPresets, setWhenPresets] = useState<Array<{ key: string; label: string; date: Date }>>([])

  const loadAll = useCallback(() => {
    refreshSilverRate()
    dbApi.getSilverRate().then(setCurrentRate).catch(() => {})
    dbApi.getProducts().then(setProducts).catch(() => setProducts([]))
    dbApi.getSilverRateRows().then((r) => setHistory(r.data ?? [])).catch(() => setHistory([]))
    dbApi.getSilverRateRequests().then((r) => {
      setRequests(r.requests ?? [])
      setIsApprover(r.isApprover)
    }).catch(() => {
      setRequests([])
      setIsApprover(false)
    })
    dbApi.getSilverRateAutoStatus().then(setAutoStatus).catch(() => setAutoStatus(null))
    dbApi.getScheduledRateChanges().then((r) => setScheduled(r.changes ?? [])).catch(() => setScheduled([]))
  }, [refreshSilverRate])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const syncProducts = async () => {
    setSyncingProducts(true)
    setSyncResult(null)
    try {
      const res = await shopifyApi.syncProductsToDb()
      setSyncResult(res)
      dbApi.getProducts().then(setProducts).catch(() => setProducts([]))
    } catch (e) {
      setSyncResult({ ok: false, synced: 0, created: 0, updated: 0, removed: 0, errors: [e instanceof Error ? e.message : 'Product sync failed'] })
    } finally {
      setSyncingProducts(false)
    }
  }

  const rateValue = parseFloat(newRate)
  const rateValid = !isNaN(rateValue) && rateValue > 0

  const affected = useMemo(() => {
    return products.map((p) => {
      const silverValue = p.netWeight * currentRate.rate
      const makingTotal = p.netWeight * p.makingCharge
      const subtotal = silverValue + makingTotal
      const gstPct = p.gst ?? 3
      const gstAmount = (subtotal * gstPct) / 100
      const oldPrice = subtotal + gstAmount
      const newSilverValue = p.netWeight * (rateValid ? rateValue : currentRate.rate)
      const newSubtotal = newSilverValue + makingTotal
      const newGst = (newSubtotal * gstPct) / 100
      const newPrice = newSubtotal + newGst
      return { product: p, oldPrice, newPrice }
    })
  }, [rateValid, rateValue, products, currentRate.rate])

  const totalDelta = useMemo(() => {
    if (!rateValid) return 0
    return affected.reduce((acc, a) => acc + (a.newPrice - a.oldPrice), 0)
  }, [affected, rateValid])

  const openUpdate = () => {
    setNewRate(String(currentRate.rate))
    setStep(1)
    setRateProgress(null)
    setRateMinimized(false)
    setDialogOpen(true)
  }

  // Poll the backend's live apply progress while the update request runs.
  useEffect(() => {
    if (!processing) return
    let alive = true
    const tick = () => {
      dbApi.getSilverRateProgress().then((p) => { if (alive) setRateProgress(p) }).catch(() => undefined)
    }
    tick()
    const id = setInterval(tick, 900)
    return () => { alive = false; clearInterval(id) }
  }, [processing])

  const confirmChange = () => {
    setStep(2)
  }

  const approve = async () => {
    setProcessing(true)
    setError('')
    try {
      const res = await dbApi.submitSilverRateRequest(rateValue, syncFirst)
      if (res.direct) {
        setResult(res)
      } else {
        setPendingResult({ message: res.message, rate: rateValue })
      }
      setStep(3)
      loadAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update silver rate')
    } finally {
      setProcessing(false)
      // One last fetch so the pill/panel keeps the final phase's label.
      dbApi.getSilverRateProgress().then(setRateProgress).catch(() => undefined)
    }
  }

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    try {
      if (decision === 'approve') await dbApi.approveSilverRateRequest(id)
      else await dbApi.rejectSilverRateRequest(id)
      loadAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to ${decision} request`)
    }
  }

  const toggleAuto = async () => {
    if (!autoStatus) return
    setTogglingAuto(true)
    try {
      await dbApi.toggleSilverRateAuto(!autoStatus.enabled)
      const fresh = await dbApi.getSilverRateAutoStatus()
      setAutoStatus(fresh)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to toggle auto rate')
    } finally {
      setTogglingAuto(false)
    }
  }

  // Edit-schedule dialog state — seeded from the live status when opened.
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [schedDays, setSchedDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6])
  const [schedTime, setSchedTime] = useState('09:00')
  const [savingSchedule, setSavingSchedule] = useState(false)

  const scheduleDialogRate = parseFloat(schRate)
  const scheduleRateValid = Number.isFinite(scheduleDialogRate) && scheduleDialogRate > 0

  /** Local-time instant the dialog's date+time fields describe, or null. */
  const scheduleInstant = useMemo(() => {
    if (!schDate || !schTime) return null
    const at = new Date(`${schDate}T${schTime}:00`)
    return Number.isNaN(at.getTime()) ? null : at
  }, [schDate, schTime])

  /** Old → new prices for every product at the dialog's rate (preview step). */
  const scheduleImpact = useMemo(() => {
    if (!scheduleRateValid || !scheduleInstant) return null
    return products.map((p) => {
      const makingTotal = p.netWeight * p.makingCharge
      const gstPct = p.gst ?? 3
      const oldPrice = (p.netWeight * currentRate.rate + makingTotal) * (1 + gstPct / 100)
      const newPrice = (p.netWeight * scheduleDialogRate + makingTotal) * (1 + gstPct / 100)
      return { product: p, oldPrice, newPrice }
    })
  }, [products, currentRate.rate, scheduleDialogRate, scheduleRateValid, scheduleInstant])

  const scheduleTotalDelta = useMemo(
    () => (scheduleImpact ? scheduleImpact.reduce((acc, a) => acc + (a.newPrice - a.oldPrice), 0) : 0),
    [scheduleImpact],
  )

  const openScheduleDialog = (edit?: PendingRateChange) => {
    setSchError('')
    setSchSuccess('')
    setSchEditId(edit?.id ?? null)
    // One-click "when" presets — computed here (an event, not render) so the
    // clock is read exactly when the dialog opens and never goes stale.
    const tomorrow = (new Date().getDay() + 1) % 7
    setWhenPresets([
      { key: 'tmr-9', label: presetLabel(upcomingWeekdayAt(tomorrow, 9), 'Tomorrow'), date: upcomingWeekdayAt(tomorrow, 9) },
      { key: 'tmr-18', label: presetLabel(upcomingWeekdayAt(tomorrow, 18), 'Tomorrow'), date: upcomingWeekdayAt(tomorrow, 18) },
      { key: 'sat-10', label: presetLabel(upcomingWeekdayAt(6, 10), 'Saturday'), date: upcomingWeekdayAt(6, 10) },
      { key: 'mon-9', label: presetLabel(upcomingWeekdayAt(1, 9), 'Monday'), date: upcomingWeekdayAt(1, 9) },
    ])
    if (edit) {
      const at = new Date(edit.applyAt)
      setSchRate(String(edit.rate))
      setSchDate(toDateInputValue(at))
      setSchTime(toTimeInputValue(at))
      setSchNote(edit.note ?? '')
    } else {
      setSchRate(String(currentRate.rate))
      // Sensible default: an hour from now, easy to nudge with the presets.
      const soon = new Date(Date.now() + 60 * 60_000)
      setSchDate(toDateInputValue(soon))
      setSchTime(toTimeInputValue(soon))
      setSchNote('')
    }
    setSchStep(0)
    setSchOpen(true)
  }

  const goNextFromRate = () => {
    if (!scheduleRateValid) {
      setSchError('Enter a valid rate — ₹/gm greater than 0')
      return
    }
    setSchError('')
    setSchStep(1)
  }

  const goNextFromWhen = () => {
    if (!scheduleInstant) {
      setSchError('Pick the date and time to apply the rate')
      return
    }
    if (scheduleInstant.getTime() <= Date.now() + 60_000) {
      setSchError('Schedule the change at least a minute in the future')
      return
    }
    setSchError('')
    setSchStep(2)
  }

  const submitSchedule = async () => {
    const rate = parseFloat(schRate)
    if (!Number.isFinite(rate) || rate <= 0) {
      setSchError('Enter the rate to schedule (₹/gm)')
      return
    }
    // Date + time are interpreted in this device's zone (IST for the shop).
    const at = new Date(`${schDate}T${schTime}:00`)
    if (Number.isNaN(at.getTime())) {
      setSchError('Invalid date or time')
      return
    }
    if (at.getTime() <= Date.now() + 60_000) {
      setSchError('Schedule the change at least a minute in the future')
      return
    }
    setSchSaving(true)
    setSchError('')
    try {
      const note = schNote.trim() || undefined
      const res = schEditId
        ? await dbApi.updateScheduledRateChange(schEditId, { rate, applyAt: at.toISOString(), note })
        : await dbApi.scheduleSilverRateChange({ rate, applyAt: at.toISOString(), note })
      setScheduled(res.changes)
      setSchOpen(false)
      setSchSuccess(
        schEditId
          ? `Updated — ₹${rate.toFixed(2)}/gm now applies ${formatDateTime(at.toISOString())}.`
          : `Scheduled — ₹${rate.toFixed(2)}/gm applies ${formatDateTime(at.toISOString())}, automatically.`,
      )
    } catch (e) {
      setSchError(
        e instanceof Error
          ? e.message
          : schEditId
            ? 'Failed to update the scheduled change'
            : 'Failed to schedule the rate change',
      )
    } finally {
      setSchSaving(false)
    }
  }

  const cancelScheduled = async (id: string) => {
    setSchError('')
    try {
      const res = await dbApi.cancelScheduledRateChange(id)
      setScheduled(res.changes)
    } catch (e) {
      setSchError(e instanceof Error ? e.message : 'Failed to cancel the scheduled change')
    }
  }

  const openScheduleEditor = () => {
    if (autoStatus?.schedule) {
      setSchedDays(autoStatus.schedule.days)
      setSchedTime(autoStatus.schedule.time)
    }
    setScheduleOpen(true)
  }

  const saveSchedule = async () => {
    if (schedDays.length === 0) {
      setError('Pick at least one day for the silver rate update')
      return
    }
    setSavingSchedule(true)
    setError('')
    try {
      await dbApi.setSilverRateSchedule({ days: schedDays, time: schedTime })
      setAutoStatus(await dbApi.getSilverRateAutoStatus())
      setScheduleOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the schedule')
    } finally {
      setSavingSchedule(false)
    }
  }

  const fetchNow = async () => {
    setFetchingNow(true)
    setFetchNowResult(null)
    try {
      const res = await dbApi.fetchSilverRateNow()
      setFetchNowResult({
        ok: res.ok,
        message: res.ok ? `Fetched ₹${(res.rate ?? 0).toFixed(2)}/gm — ${(res.repriced ?? 0).toLocaleString('en-IN')} products repriced` : res.error ?? 'Fetch failed',
      })
      loadAll()
    } catch (e) {
      setFetchNowResult({ ok: false, message: e instanceof Error ? e.message : 'Fetch failed' })
    } finally {
      setFetchingNow(false)
    }
  }

  const rollbackTo = (rate: number) => {
    setNewRate(String(rate))
    setStep(1)
    setDialogOpen(true)
  }

  const pendingCount = useMemo(() => requests.filter((r) => r.status === 'pending').length, [requests])
  // Admin / Super Admin can apply a rate change (and fetch the spot rate)
  // directly; every other role always goes through approval.
  const canApprove = isApprover || autoStatus?.isApprover === true

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link to="/" className="hover:text-primary-700">Dashboard</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-medium text-foreground">Silver Rate</span>
      </div>

      <PageHeader
        title="Silver Rate Management"
        subtitle="Silver rates drive all product pricing. Changes are previewed and approved before syncing to Shopify."
        actions={
          <>
            <Button variant="outline" onClick={syncProducts} disabled={syncingProducts} className="gap-2">
              <RefreshCw className={cn('h-4 w-4', syncingProducts && 'animate-spin')} />
              {syncingProducts ? 'Syncing products...' : 'Sync Products from Shopify'}
            </Button>
            <Button onClick={openUpdate} className="gap-2">
              <TrendingUp className="h-4 w-4" /> {canApprove ? 'Update Silver Rate' : 'Request Rate Change'}
            </Button>
          </>
        }
      />

      {!canApprove ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-800">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">Approval required</p>
            <p className="text-[13px]">
              Rate changes submitted by your role are queued for an Admin or Super Admin to approve. The rate stays unchanged until then.
            </p>
          </div>
        </div>
      ) : null}

      {syncResult ? (
        <div
          className={cn(
            'flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm',
            syncResult.ok ? 'border-success-100 bg-success-50/60 text-success-700' : 'border-red-200 bg-red-50/60 text-red-700',
          )}
        >
          {syncResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
          <div>
            <p className="font-semibold">{syncResult.ok ? 'Products synced' : 'Product sync failed'}</p>
            <p className="text-[13px]">
              {syncResult.ok
                ? `${syncResult.synced} live products synced from Shopify — ${syncResult.created} created, ${syncResult.updated} updated, ${syncResult.removed} removed.`
                : syncResult.errors.join(' ')}
            </p>
          </div>
        </div>
      ) : null}

      {fetchNowResult ? (
        <div
          className={cn(
            'flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm',
            fetchNowResult.ok ? 'border-success-100 bg-success-50/60 text-success-700' : 'border-red-200 bg-red-50/60 text-red-700',
          )}
        >
          {fetchNowResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
          <div>
            <p className="font-semibold">{fetchNowResult.ok ? 'Spot rate fetched' : 'Spot rate fetch failed'}</p>
            <p className="text-[13px]">{fetchNowResult.message}</p>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Rate Change Approvals</CardTitle>
            </div>
            {pendingCount > 0 ? <Badge variant="warning" className="text-[10px]">{pendingCount} pending</Badge> : <Badge variant="muted" className="text-[10px]">None pending</Badge>}
          </CardHeader>
          <CardContent>
            {requests.length === 0 ? (
              <p className="py-4 text-center text-[13px] text-muted-foreground">
                {canApprove
                  ? 'No rate change requests. Staff submissions will appear here for approval.'
                  : 'No rate change requests yet. Any rate change you submit is sent to an Admin or Super Admin for approval.'}
              </p>
            ) : (
              <div className="space-y-2">
                {requests.map((r) => (
                  <div key={r.id} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold tabular-nums text-foreground">₹{(r.rate ?? 0).toFixed(2)} / gm</span>
                      <Badge variant={r.status === 'pending' ? 'warning' : r.status === 'approved' ? 'success' : 'danger'} dot>
                        {r.status}
                      </Badge>
                      {r.previousRate != null ? (
                        <span className="text-[11px] text-muted-foreground">from ₹{r.previousRate.toFixed(2)}</span>
                      ) : null}
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {r.requestedBy ?? 'Unknown'}
                        {r.requestedByRole ? ` · ${r.requestedByRole}` : ''} · {formatDateTime(r.requestedAt)}
                      </span>
                    </div>
                    {r.decidedBy ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {r.status === 'approved' ? 'Approved' : 'Rejected'} by {r.decidedBy} · {formatDateTime(r.decidedAt)}
                        {r.decisionNote ? ` — "${r.decisionNote}"` : ''}
                      </p>
                    ) : null}
                    {r.resultNote ? <p className="mt-1 text-[11px] text-muted-foreground">{r.resultNote}</p> : null}
                    {isApprover && r.status === 'pending' ? (
                      <div className="mt-2 flex gap-2">
                        <Button size="sm" variant="success" className="gap-1" onClick={() => decide(r.id, 'approve')}>
                          <Check className="h-3.5 w-3.5" /> Approve &amp; Apply
                        </Button>
                        <Button size="sm" variant="outline" className="gap-1" onClick={() => decide(r.id, 'reject')}>
                          <XCircle className="h-3.5 w-3.5" /> Reject
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Auto Silver Rate</CardTitle>
            </div>
            <Badge variant={autoStatus?.enabled ? 'success' : 'muted'} dot>
              {autoStatus?.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            {autoStatus ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border p-3">
                    <p className="text-[10.5px] uppercase tracking-wide text-muted-foreground">Schedule</p>
                    <p className="mt-0.5 text-[13px] font-semibold text-foreground">{autoStatus.schedule ? describeRateSchedule(autoStatus.schedule) : 'Every day at 09:00 IST'}</p>
                    <p className="text-[11px] text-muted-foreground">Next: {formatDateTime(autoStatus.nextRunAt)}</p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-[10.5px] uppercase tracking-wide text-muted-foreground">Last fetch</p>
                    <p className="mt-0.5 text-[13px] font-semibold text-foreground">
                      {autoStatus.lastRate != null ? `₹${autoStatus.lastRate.toFixed(2)} / gm` : autoStatus.lastResult ?? '—'}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {autoStatus.lastRunAt ? formatDateTime(autoStatus.lastRunAt) : 'Never run'}
                      {autoStatus.lastResult ? ` · ${autoStatus.lastResult}` : ''}
                    </p>
                  </div>
                </div>
                {autoStatus.lastError ? (
                  <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-xs text-red-700">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{autoStatus.lastError}</span>
                  </div>
                ) : null}
                {!autoStatus.apiUrlConfigured ? (
                  <p className="text-[11px] text-muted-foreground">
                    Rate source not configured — set <code className="rounded bg-muted px-1">SILVER_RATE_API_URL</code> to enable spot-rate fetching.
                  </p>
                ) : null}
                {!canApprove ? (
                  <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11px] text-amber-800">
                    <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>Fetching applies the live spot rate and reprices products, so only Admin or Super Admin can run it.</span>
                  </p>
                ) : null}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={fetchNow}
                    disabled={fetchingNow || !autoStatus.apiUrlConfigured || !canApprove}
                    title={canApprove ? undefined : 'Only Admin or Super Admin can fetch and apply the live silver rate'}
                  >
                    <RefreshCw className={cn('h-3.5 w-3.5', fetchingNow && 'animate-spin')} />
                    {fetchingNow ? 'Fetching…' : 'Fetch spot rate now'}
                  </Button>
                  <Button size="sm" variant={autoStatus.enabled ? 'outline' : 'soft-primary'} onClick={toggleAuto} disabled={togglingAuto}>
                    {togglingAuto ? 'Saving…' : autoStatus.enabled ? 'Disable auto rate' : 'Enable auto rate'}
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={openScheduleEditor}>
                    <CalendarClock className="h-3.5 w-3.5" /> Edit schedule
                  </Button>
                </div>
              </>
            ) : (
              <p className="py-4 text-center text-[13px] text-muted-foreground">Auto-rate status unavailable.</p>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-muted-foreground" />
              <div>
                <CardTitle className="text-sm">Scheduled Rate Changes</CardTitle>
                <CardDescription className="mt-0.5">
                  One-off: set a rate for an exact date &amp; time — applied automatically then, even while the
                  app is closed (products repriced and pushed to Shopify).
                </CardDescription>
              </div>
            </div>
            <Badge variant={scheduled.length > 0 ? 'warning' : 'muted'} dot>
              {scheduled.length > 0 ? `${scheduled.length} queued` : 'None'}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            {!schOpen && schError ? (
              <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-xs text-red-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{schError}</span>
              </div>
            ) : null}
            {schSuccess ? (
              <div className="flex items-start gap-2 rounded-md border border-success-100 bg-success-50/60 px-3 py-2 text-xs text-success-700">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{schSuccess}</span>
              </div>
            ) : null}
            {canApprove ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button className="gap-1.5" onClick={() => openScheduleDialog()}>
                  <CalendarClock className="h-4 w-4" /> Schedule rate change
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  Changed your mind? Any queued change can be edited or cancelled until it applies.
                </p>
              </div>
            ) : (
              <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11px] text-amber-800">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Only Admin or Super Admin can schedule a rate change — submit a rate change request instead
                  and it will be applied once approved.
                </span>
              </p>
            )}
            {scheduled.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">
                Nothing scheduled yet — e.g. set Saturday's rate on Friday afternoon and forget about it.
              </p>
            ) : (
              <div className="space-y-2">
                {scheduled.map((c) => (
                  <div key={c.id} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-bold tabular-nums text-foreground">₹{c.rate.toFixed(2)} / gm</span>
                        <Badge variant={c.rate >= currentRate.rate ? 'success' : 'danger'}>
                          {c.rate >= currentRate.rate ? '+' : '−'}₹{Math.abs(c.rate - currentRate.rate).toFixed(2)} vs today
                        </Badge>
                        <Badge variant="warning" className="gap-1">
                          <Clock className="h-3 w-3" /> {timeUntil(c.applyAt)}
                        </Badge>
                      </div>
                      {canApprove ? (
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" className="gap-1" onClick={() => openScheduleDialog(c)}>
                            <Pencil className="h-3.5 w-3.5" /> Edit
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => cancelScheduled(c.id)}>
                            Cancel
                          </Button>
                        </div>
                      ) : null}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <CalendarClock className="h-3 w-3" /> {formatDateTime(c.applyAt)}
                      </span>
                      {c.note ? <span className="italic text-foreground">“{c.note}”</span> : null}
                      {c.requestedBy ? <span>by {c.requestedBy}</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <AppDialog
          open={scheduleOpen}
          onOpenChange={setScheduleOpen}
          size="md"
          isDirty={scheduleOpen}
          title="Silver rate update schedule"
          description="Choose the days and the time (IST) the automatic silver-rate update runs. Weekend days are allowed — note that MCX is closed on Saturdays and Sundays, so on those days the fetch may return the last traded rate or fail; manual entry stays available on this page."
          footer={
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setScheduleOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={saveSchedule} disabled={savingSchedule || schedDays.length === 0}>
                {savingSchedule ? 'Saving…' : 'Save schedule'}
              </Button>
            </DialogFooter>
          }
        >
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>Run on days</Label>
                <div className="flex flex-wrap gap-1.5">
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                    const active = schedDays.includes(d)
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={active}
                        onClick={() =>
                          setSchedDays((prev) => (active ? prev.filter((x) => x !== d) : [...prev, d]))
                        }
                        className={cn(
                          'h-9 w-11 rounded-md border text-xs font-semibold transition-colors',
                          active
                            ? 'border-primary-500 bg-primary-50 text-primary-700'
                            : 'border-border bg-card text-muted-foreground hover:bg-muted',
                        )}
                      >
                        {DAY_LABELS[d]}
                      </button>
                    )
                  })}
                </div>
                {schedDays.length === 0 ? (
                  <p className="text-xs text-destructive">Pick at least one day — the update never runs otherwise.</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rate-schedule-time">Run at (IST)</Label>
                <Input
                  id="rate-schedule-time"
                  type="time"
                  value={schedTime}
                  onChange={(e) => setSchedTime(e.target.value)}
                  className="w-40"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Currently active: {autoStatus?.schedule ? describeRateSchedule(autoStatus.schedule) : '—'}
              </p>
            </div>
        </AppDialog>

        <AppDialog
          open={schOpen}
          onOpenChange={(next) => {
            setSchOpen(next)
            if (!next) setSchError('')
          }}
          size="lg"
          isDirty={schOpen && (schRate !== '' || schDate !== '' || schTime !== '' || schNote !== '')}
          title={schEditId ? 'Edit scheduled rate change' : 'Schedule a silver rate change'}
          description="Set the rate and the exact date & time to apply it — like pressing “Approve & Update Shopify” at that moment, automatically."
          footer={
            <DialogFooter className="mt-2">
              {schError ? (
                <div className="mb-2 flex w-full items-start gap-2 rounded-md border border-red-200 bg-red-50/60 p-2.5 text-xs text-red-700">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{schError}</span>
                </div>
              ) : null}
              <Button variant="outline" onClick={() => setSchOpen(false)}>
                Cancel
              </Button>
              {schStep > 0 ? (
                <Button variant="outline" onClick={() => setSchStep((s) => s - 1)}>
                  Back
                </Button>
              ) : null}
              {schStep < 2 ? (
                <Button onClick={schStep === 0 ? goNextFromRate : goNextFromWhen}>
                  {schStep === 0 ? 'Next: when' : 'Next: preview'} <ArrowRight className="h-4 w-4" />
                </Button>
              ) : (
                <Button variant="success" onClick={submitSchedule} disabled={schSaving}>
                  {schSaving ? (
                    'Saving…'
                  ) : schEditId ? (
                    'Save changes'
                  ) : (
                    <>
                      <CalendarClock className="h-4 w-4" /> Schedule change
                    </>
                  )}
                </Button>
              )}
            </DialogFooter>
          }
        >

            <ScheduleStepper step={schStep} />

            {schStep === 0 ? (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border bg-muted/40 p-3">
                    <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Current rate</Label>
                    <p className="mt-1 text-lg font-bold tabular-nums text-foreground">₹{currentRate.rate.toFixed(2)} / gm</p>
                  </div>
                  <div className="rounded-lg border border-primary-200 bg-primary-50/60 p-3">
                    <Label htmlFor="sch-rate" className="text-[11px] uppercase tracking-wide text-primary-700">
                      Rate to apply
                      {scheduleRateValid
                        ? ` (${scheduleDialogRate >= currentRate.rate ? '+' : '−'}₹${Math.abs(scheduleDialogRate - currentRate.rate).toFixed(2)} vs today)`
                        : ''}
                    </Label>
                    <div className="mt-1 flex items-center gap-1.5">
                      <span className="text-lg font-bold text-foreground">₹</span>
                      <Input
                        id="sch-rate"
                        autoFocus
                        type="number"
                        min="0"
                        step="0.1"
                        value={schRate}
                        onChange={(e) => setSchRate(e.target.value)}
                        className="h-8 w-32 border-primary-200 font-bold tabular-nums focus-visible:ring-primary"
                      />
                      <span className="text-sm font-medium text-muted-foreground">/ gm</span>
                    </div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Quick adjustments</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {[-1, -0.5, 0.5, 1].map((delta) => (
                      <button
                        key={delta}
                        type="button"
                        onClick={() => {
                          const base = Number.isFinite(parseFloat(schRate)) ? parseFloat(schRate) : currentRate.rate
                          setSchRate((Math.round((base + delta) * 100) / 100).toFixed(2))
                        }}
                        className="h-9 rounded-md border border-border bg-card px-3 text-xs font-semibold tabular-nums text-muted-foreground transition-colors hover:bg-muted"
                      >
                        {delta > 0 ? '+' : '−'}₹{Math.abs(delta).toFixed(2)}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setSchRate(String(currentRate.rate))}
                      className="h-9 rounded-md border border-border bg-card px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted"
                    >
                      Same as today
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Adjustments apply to the number in the box. You'll see the product price impact before saving.
                  </p>
                </div>
              </div>
            ) : schStep === 1 ? (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Quick picks</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {whenPresets.map((p) => {
                      const active = schDate === toDateInputValue(p.date) && schTime === toTimeInputValue(p.date)
                      return (
                        <button
                          key={p.key}
                          type="button"
                          aria-pressed={active}
                          onClick={() => {
                            setSchDate(toDateInputValue(p.date))
                            setSchTime(toTimeInputValue(p.date))
                          }}
                          className={cn(
                            'h-9 rounded-md border px-3 text-xs font-semibold transition-colors',
                            active
                              ? 'border-primary-500 bg-primary-50 text-primary-700'
                              : 'border-border bg-card text-muted-foreground hover:bg-muted',
                          )}
                        >
                          {p.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="sch-date" className="text-[11px] uppercase tracking-wide">Date</Label>
                    <Input
                      id="sch-date"
                      type="date"
                      value={schDate}
                      onChange={(e) => setSchDate(e.target.value)}
                      className="h-9 w-44"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="sch-time" className="text-[11px] uppercase tracking-wide">Time (IST)</Label>
                    <Input
                      id="sch-time"
                      type="time"
                      value={schTime}
                      onChange={(e) => setSchTime(e.target.value)}
                      className="h-9 w-32"
                    />
                  </div>
                </div>
                {scheduleInstant ? (
                  <p className="text-[12px] text-foreground">
                    Applies on <span className="font-semibold">{formatDateTime(scheduleInstant.toISOString())}</span>
                    {' '}· <span className="text-muted-foreground">{timeUntil(scheduleInstant.toISOString())}</span>
                  </p>
                ) : null}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="sch-note" className="text-[11px] uppercase tracking-wide">Note (optional)</Label>
                    <span className="text-[10px] tabular-nums text-muted-foreground">{schNote.length}/120</span>
                  </div>
                  <Input
                    id="sch-note"
                    maxLength={120}
                    placeholder="e.g. weekend rate, festival offer…"
                    value={schNote}
                    onChange={(e) => setSchNote(e.target.value)}
                    className="h-9"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  <MiniBadge label="Rate" value={`₹${scheduleDialogRate.toFixed(2)}`} />
                  <MiniBadge
                    label="Change"
                    value={`${scheduleDialogRate >= currentRate.rate ? '+' : '−'}₹${Math.abs(scheduleDialogRate - currentRate.rate).toFixed(2)}`}
                    accent={scheduleDialogRate >= currentRate.rate ? 'green' : 'red'}
                  />
                  <MiniBadge label="Applies" value={scheduleInstant ? formatDateTime(scheduleInstant.toISOString()) : '—'} />
                </div>
                {schNote.trim() ? (
                  <p className="text-[12px] text-muted-foreground">
                    Note: <span className="italic text-foreground">“{schNote.trim()}”</span>
                  </p>
                ) : null}
                {scheduleImpact ? (
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Preview — price changes ({products.length} products)
                      </p>
                      <Badge variant="warning">{formatCurrency(scheduleTotalDelta)} total shift</Badge>
                    </div>
                    <div className="max-h-64 overflow-auto rounded-lg border">
                      <Table>
                        <TableHeader>
                          <TableRow className="sticky top-0 bg-muted/60">
                            <TableHead>Product</TableHead>
                            <TableHead className="text-right">Net Wt</TableHead>
                            <TableHead className="text-right">Old Price</TableHead>
                            <TableHead className="text-right">New Price</TableHead>
                            <TableHead className="text-right">Difference</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {scheduleImpact.map(({ product, oldPrice, newPrice }) => {
                            const diff = newPrice - oldPrice
                            const rounded = Math.abs(diff) < 0.01
                            return (
                              <TableRow key={product.id}>
                                <TableCell>
                                  <div className="flex items-center gap-2">
                                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
                                      <Gem className="h-3.5 w-3.5" />
                                    </div>
                                    <div>
                                      <p className="font-medium text-foreground">{product.name}</p>
                                      <p className="text-[10px] text-muted-foreground">{product.sku}</p>
                                    </div>
                                  </div>
                                </TableCell>
                                <TableCell className="text-right tabular-nums text-muted-foreground">{formatWeight(product.netWeight)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatCurrency(oldPrice)}</TableCell>
                                <TableCell className="text-right font-semibold tabular-nums text-foreground">{formatCurrency(newPrice)}</TableCell>
                                <TableCell className="text-right">
                                  <span className={cn('font-semibold tabular-nums', rounded ? 'text-muted-foreground' : diff > 0 ? 'text-success-700' : 'text-red-600 dark:text-red-400')}>
                                    {rounded ? '—' : `${diff > 0 ? '+' : ''}${formatCurrency(diff)}`}
                                  </span>
                                </TableCell>
                              </TableRow>
                            )
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
        </AppDialog>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="overflow-hidden border-primary-100 bg-gradient-to-br from-primary-700 to-primary-900 text-white lg:col-span-1">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-primary-200">
                <Tag className="h-4 w-4" />
                <p className="text-xs font-semibold uppercase tracking-wide">Current Silver Rate</p>
              </div>
              <Badge variant="success" className="bg-success-500/20 text-success-100 border-success-500/30">
                92.5 Sterling Silver
              </Badge>
            </div>
            <p className="mt-3 text-4xl font-bold tabular-nums tracking-tight">₹{currentRate.rate.toFixed(2)}</p>
            <p className="text-sm font-medium text-primary-200">per gram</p>
            <div className="mt-4 flex items-center gap-2 rounded-md bg-white/10 px-3 py-2 text-xs">
              <Clock className="h-3.5 w-3.5" />
              <span className="text-primary-200">Last updated:</span>
              <span className="font-medium text-white">{formatDateTime(currentRate.updatedAt)}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-1">
          <CardContent className="p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Today's Change</p>
            <div className="mt-2 flex items-end gap-3">
              <p className="text-3xl font-bold tabular-nums text-foreground">
                +₹{currentRate.change.toFixed(2)}
              </p>
              <Badge variant="success" className="mb-1">+{currentRate.changePercent.toFixed(2)}%</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">vs previous rate ₹{currentRate.previousRate.toFixed(2)} / gm</p>
            <div className="mt-4 rounded-md bg-success-50 px-3 py-2 text-xs font-medium text-success-700">
              Last update synced approved prices to {products.length} Shopify products
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-1">
          <CardContent className="p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Price Change Impact</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <ImpactTile label="Products Affected" value={`${products.length}`} icon={Gem} tint="text-primary-700 bg-primary-50" />
              <ImpactTile label="Total Value Shift" value={rateValid ? formatCurrency(totalDelta) : '—'} icon={IndianRupee} tint="text-warning-700 bg-warning-50" />
              <ImpactTile label="Avg. Price Change" value={rateValid ? formatCurrency(totalDelta / products.length) : '—'} icon={TrendingUp} tint="text-success-700 bg-success-50" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm">Rate History & Approvals</CardTitle>
          </div>
          <CardDescription>Every rate change is logged with the admin who approved it.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Old Rate</TableHead>
                <TableHead>New Rate</TableHead>
                <TableHead>Change</TableHead>
                <TableHead>Approved By</TableHead>
                <TableHead className="text-center">Shopify Sync</TableHead>
                <TableHead className="text-center">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    No rate history yet.
                  </TableCell>
                </TableRow>
              ) : (
                history.map((h) => {
                  const prev = h.previousRate ?? currentRate.previousRate
                  const diff = Math.round((h.rate - prev) * 100) / 100
                  const source = h.source ?? 'legacy'
                  const sourceLabel = source === 'auto' ? 'Auto fetch' : source === 'approval' ? 'Approved request' : source === 'manual' ? 'Manual' : 'Legacy entry'
                  return (
                    <TableRow key={h.id}>
                      <TableCell className="font-medium">{formatDateTime(h.updatedAt)}</TableCell>
                      <TableCell className="tabular-nums">₹{prev.toFixed(2)}</TableCell>
                      <TableCell className="tabular-nums font-semibold">₹{h.rate.toFixed(2)}</TableCell>
                      <TableCell>
                        <Badge variant={diff > 0 ? 'success' : diff < 0 ? 'danger' : 'muted'}>
                          {diff > 0 ? '+' : diff < 0 ? '−' : ''}₹{Math.abs(diff).toFixed(2)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="leading-tight">
                          <p className="font-medium text-foreground">{h.updatedBy ?? 'Unknown'}</p>
                          <p className="text-[10.5px] text-muted-foreground">
                            {sourceLabel}
                            {h.approvedBy && h.approvedBy !== h.updatedBy ? ` · approved by ${h.approvedBy}` : ''}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant={h.syncStatus === 'synced' ? 'success' : h.syncStatus === 'failed' ? 'danger' : 'muted'} dot>
                          {h.syncStatus === 'synced' ? 'Synced' : h.syncStatus === 'failed' ? 'Failed' : h.syncStatus === 'skipped' ? 'Skipped' : '—'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        {h.rate !== currentRate.rate ? (
                          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-primary" onClick={() => rollbackTo(h.rate)}>
                            <Undo2 className="h-3.5 w-3.5" /> Restore
                          </Button>
                        ) : (
                          <Badge variant="muted" className="text-[10px]">Current</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

        <AppDialog
          open={dialogOpen && !rateMinimized}
          onOpenChange={(open) => {
            if (open) { setDialogOpen(true); return }
            // Closing while the update runs minimises it to the floating pill —
            // the request keeps running, it is not cancelled.
            if (processing) setRateMinimized(true)
            else setDialogOpen(false)
          }}
          size="xl"
          isDirty={dialogOpen && newRate !== ''}
          title="Update Silver Rate"
          description="Set the new 92.5% silver rate. All product prices will be recomputed and previewed before syncing to Shopify."
          footer={
            step < 3 ? (
              <DialogFooter className="mt-2">
                {error ? (
                  <div className="mb-2 flex w-full items-start gap-2 rounded-md border border-red-200 bg-red-50/60 p-2.5 text-xs text-red-700">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                ) : null}
                {step === 1 ? (
                  <>
                    <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                    <Button onClick={confirmChange} disabled={!rateValid}>
                      Preview Changes <ArrowRight className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    {processing ? (
                      <Button variant="ghost" size="sm" className="mr-auto" onClick={() => setRateMinimized(true)}>
                        <Minimize2 className="h-3.5 w-3.5" /> Minimize
                      </Button>
                    ) : null}
                    <Button variant="outline" onClick={() => setStep(1)} disabled={processing}>Back</Button>
                    <Button variant="success" onClick={approve} disabled={processing}>
                      {processing ? (
                        <>
                          <RefreshCw className="h-4 w-4 animate-spin" /> {rateProgress?.label ? `${rateProgress.label}…` : 'Updating prices...'}
                        </>
                      ) : (
                        <>
                          <ShieldCheck className="h-4 w-4" /> Approve & Update Shopify
                        </>
                      )}
                    </Button>
                  </>
                )}
              </DialogFooter>
            ) : null
          }
        >

          {step < 3 ? (
            <>
              <Stepper step={step} />

              {step === 1 && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border bg-muted/40 p-3">
                      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Old Rate</Label>
                      <p className="mt-1 text-lg font-bold tabular-nums text-foreground">₹{currentRate.rate.toFixed(2)} / gm</p>
                    </div>
                    <div className="rounded-lg border border-primary-200 bg-primary-50/60 p-3">
                      <Label className="text-[11px] uppercase tracking-wide text-primary-700">New Rate</Label>
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className="text-lg font-bold text-foreground">₹</span>
                        <Input
                          autoFocus
                          type="number"
                          min="0"
                          step="0.1"
                          value={newRate}
                          onChange={(e) => setNewRate(e.target.value)}
                          className="h-8 w-32 border-primary-200 font-bold tabular-nums focus-visible:ring-primary"
                        />
                        <span className="text-sm font-medium text-muted-foreground">/ gm</span>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-warning-100 bg-warning-50/70 p-3">
                    <div className="flex items-start gap-2.5">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-700" />
                      <div className="text-xs text-warning-700">
                        <p className="font-semibold">Affects {products.length} products</p>
                        <p className="mt-0.5">
                          {rateValid
                            ? `Estimated total price change across catalog: ${formatCurrency(totalDelta)}.`
                            : 'Enter a valid rate to see the estimated impact.'}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {step === 2 && rateValid && (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    <MiniBadge label="Old Rate" value={`₹${currentRate.rate.toFixed(2)}`} />
                    <MiniBadge label="New Rate" value={`₹${rateValue.toFixed(2)}`} />
                    <MiniBadge label="Change" value={`${rateValue >= currentRate.rate ? '+' : ''}₹${(rateValue - currentRate.rate).toFixed(2)}`} accent={rateValue >= currentRate.rate ? 'green' : 'red'} />
                  </div>

                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Preview — estimated price changes ({products.length} products)
                      </p>
                      <Badge variant="warning">{formatCurrency(totalDelta)} total shift</Badge>
                    </div>
                    <div className="max-h-64 overflow-auto rounded-lg border">
                      <Table>
                        <TableHeader>
                          <TableRow className="sticky top-0 bg-muted/60">
                            <TableHead>Product</TableHead>
                            <TableHead className="text-right">Net Wt</TableHead>
                            <TableHead className="text-right">Old Price</TableHead>
                            <TableHead className="text-right">New Price</TableHead>
                            <TableHead className="text-right">Difference</TableHead>
                            <TableHead className="text-center">Shopify</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {affected.map(({ product, oldPrice, newPrice }) => {
                            const diff = newPrice - oldPrice
                            const rounded = Math.abs(diff) < 0.01
                            return (
                              <TableRow key={product.id}>
                                <TableCell>
                                  <div className="flex items-center gap-2">
                                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
                                      <Gem className="h-3.5 w-3.5" />
                                    </div>
                                    <div>
                                      <p className="font-medium text-foreground">{product.name}</p>
                                      <p className="text-[10px] text-muted-foreground">{product.sku}</p>
                                    </div>
                                  </div>
                                </TableCell>
                                <TableCell className="text-right tabular-nums text-muted-foreground">{formatWeight(product.netWeight)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatCurrency(oldPrice)}</TableCell>
                                <TableCell className="text-right font-semibold tabular-nums text-foreground">{formatCurrency(newPrice)}</TableCell>
                                <TableCell className="text-right">
                                  <span className={cn('font-semibold tabular-nums', rounded ? 'text-muted-foreground' : diff > 0 ? 'text-success-700' : 'text-red-600 dark:text-red-400')}>
                                    {rounded ? '—' : `${diff > 0 ? '+' : ''}${formatCurrency(diff)}`}
                                  </span>
                                </TableCell>
                                <TableCell className="text-center">
                                  <Badge variant={product.shopifyStatus === 'synced' ? 'success' : 'warning'} dot>
                                    {product.shopifyStatus === 'synced' ? 'Synced' : 'Pending'}
                                  </Badge>
                                </TableCell>
                              </TableRow>
                            )
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 rounded-lg border border-primary-100 bg-primary-50/40 p-3">
                    <div className="flex items-start gap-2.5">
                      <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-primary-700" />
                      <div className="text-xs text-primary-900">
                        <p className="font-semibold">Sync all products from Shopify first</p>
                        <p className="mt-0.5 text-primary-700/80">
                          Imports the live Shopify catalog into billing and removes obsolete products before applying the new rate.
                        </p>
                      </div>
                    </div>
                    <Switch checked={syncFirst} onCheckedChange={setSyncFirst} aria-label="Sync all products from Shopify first" />
                  </div>
                </div>
              )}

              {processing ? (
                <div data-testid="rate-progress" className="rounded-lg border border-primary-100 bg-primary-50/40 p-3">
                  <div className="flex items-center justify-between gap-2 text-xs font-medium text-primary-900">
                    <span className="flex min-w-0 items-center gap-2">
                      <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
                      <span className="truncate">{rateProgress?.label || 'Applying the new silver rate…'}</span>
                    </span>
                    {rateProgress && rateProgress.total > 0 ? (
                      <span className="shrink-0 tabular-nums text-primary-700">{rateProgress.done}/{rateProgress.total}</span>
                    ) : null}
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-primary-100">
                    {rateProgress && rateProgress.total > 0 ? (
                      <div
                        className="h-full rounded-full bg-primary-600 transition-all duration-300"
                        style={{ width: `${Math.min(100, Math.round((rateProgress.done / rateProgress.total) * 100))}%` }}
                      />
                    ) : (
                      <div className="h-full w-1/3 animate-pulse rounded-full bg-primary-600" />
                    )}
                  </div>
                  <p className="mt-1.5 text-[11px] text-primary-700/80">
                    Phase: {rateProgress?.phase ?? 'working'} — you can minimize this and keep working; the update continues.
                  </p>
                </div>
              ) : null}
            </>
          ) : (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <div className={cn('flex h-14 w-14 items-center justify-center rounded-full', result && !result.ok ? 'bg-red-50 text-red-600 dark:text-red-400' : 'bg-success-50 text-success-700')}>
                {result && !result.ok ? <AlertTriangle className="h-7 w-7" /> : <CheckCircle2 className="h-7 w-7" />}
              </div>
              {pendingResult ? (
                <>
                  <p className="text-base font-semibold text-foreground">Request submitted for approval</p>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {pendingResult.message} You asked for ₹{pendingResult.rate.toFixed(2)}/gm — an Admin or Super Admin must approve it before prices change.
                  </p>
                </>
              ) : (
                <p className="text-base font-semibold text-foreground">
                  {result && !result.ok ? 'Silver rate saved, but Shopify sync had errors' : 'Price update approved & synced'}
                </p>
              )}
              {result?.steps && result.steps.length > 0 ? (
                <div className="w-full max-w-md space-y-2 py-2 text-left">
                  {result.steps.map((s) => (
                    <div key={s.key} className="flex items-start gap-2.5 rounded-lg border px-3 py-2">
                      {s.status === 'done' ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success-700" />
                      ) : s.status === 'failed' ? (
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                      ) : (
                        <CircleDollarSign className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-foreground">{s.label}</p>
                        {s.detail ? <p className="text-xs text-muted-foreground">{s.detail}</p> : null}
                      </div>
                      <span
                        className={cn(
                          'ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                          s.status === 'done' && 'bg-success-50 text-success-700',
                          s.status === 'failed' && 'bg-red-50 text-red-600 dark:text-red-400',
                          s.status === 'skipped' && 'bg-muted text-muted-foreground',
                        )}
                      >
                        {s.status}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="max-w-sm text-sm text-muted-foreground">
                  New silver rate ₹{rateValue.toFixed(2)}/gm applied to {result ? result.affected : products.length} products
                  {result ? ` · ${result.updated} pushed to Shopify · ${result.skipped} skipped · ${result.matched} matched` : ''}.
                </p>
              )}
              {result && result.errors.length > 0 ? (
                <div className="max-h-24 w-full max-w-sm overflow-auto rounded-lg border border-red-200 bg-red-50/60 p-2 text-left text-xs text-red-700">
                  {result.errors.slice(0, 5).map((msg, i) => (
                    <p key={i} className="font-mono">{msg}</p>
                  ))}
                </div>
              ) : null}
              <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                <CircleDollarSign className="h-3.5 w-3.5 text-success-700" />
                Prices were recomputed from the new silver rate and synced to Shopify
              </div>
              <Button className="mt-2" onClick={() => setDialogOpen(false)}>
                <Check className="h-4 w-4" /> Done
              </Button>
            </div>
          )}
        </AppDialog>

      {/* Minimised live-progress pill — the update keeps running server-side
          while the wizard is hidden; click the expand icon to bring it back. */}
      {rateMinimized && dialogOpen ? (
        <div
          data-testid="rate-progress-pill"
          className="fixed bottom-5 right-5 z-[70] w-72 rounded-xl border border-primary-100 bg-card p-3 shadow-lg"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-foreground">
              {processing ? (
                <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin text-primary-700" />
              ) : (
                <CheckCircle2 className={cn('h-3.5 w-3.5 shrink-0', result && !result.ok ? 'text-red-600 dark:text-red-400' : 'text-success-600')} />
              )}
              <span className="truncate">Silver rate update</span>
            </div>
            <button
              type="button"
              aria-label="Restore rate update"
              onClick={() => setRateMinimized(false)}
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
            {rateProgress?.label || (processing ? 'Working…' : 'Idle')}
          </p>
          {rateProgress && rateProgress.total > 0 ? (
            <>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-primary-100">
                <div
                  className="h-full rounded-full bg-primary-600 transition-all duration-300"
                  style={{ width: `${Math.min(100, Math.round((rateProgress.done / rateProgress.total) * 100))}%` }}
                />
              </div>
              <p className="mt-1 text-right text-[10px] tabular-nums text-muted-foreground">
                {rateProgress.done}/{rateProgress.total}
              </p>
            </>
          ) : processing ? (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-primary-100">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-primary-600" />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => {
        const done = i < step
        const active = i === step
        return (
          <div key={s.key} className="flex min-w-0 flex-1 items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
                  done && 'border-success bg-success-50 text-success-700',
                  active && 'border-primary bg-primary text-white shadow-sm',
                  !done && !active && 'border-border text-muted-foreground',
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </div>
              <div className="min-w-0">
                <p className={cn('truncate text-xs font-semibold', active ? 'text-foreground' : done ? 'text-success-700' : 'text-muted-foreground')}>
                  {s.label}
                </p>
              </div>
            </div>
            {i < steps.length - 1 ? (
              <div className={cn('h-px flex-1', i < step ? 'bg-success/40' : 'bg-border')} />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function MiniBadge({ label, value, accent }: { label: string; value: string; accent?: 'green' | 'red' }) {
  return (
    <div className={cn('rounded-lg border p-3', accent === 'green' ? 'border-success-100 bg-success-50/60' : accent === 'red' ? 'border-red-100 bg-red-50/60' : 'bg-muted/40')}>
      <p className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-sm font-bold tabular-nums', accent === 'green' ? 'text-success-700' : accent === 'red' ? 'text-red-600 dark:text-red-400' : 'text-foreground')}>
        {value}
      </p>
    </div>
  )
}

function ImpactTile({ label, value, icon: Icon, tint }: { label: string; value: string; icon: LucideIcon; tint: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border bg-card p-2.5">
      <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md', tint)}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="truncate text-[13px] font-semibold tabular-nums text-foreground">{value}</p>
      </div>
    </div>
  )
}

// ── Silver-rate update schedule helpers ─────────────────────────────────────
// Weekday labels (index = JS day number, 0=Sun) for the Edit-schedule dialog.
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Human summary of the configured run schedule, e.g. `Every day at 09:00 IST`
 * or `Sat, Sun at 10:30 IST`. Mirrors describeRateSchedule on the backend
 * (backend/src/lib/rateSchedule.ts) so the card and tests agree.
 */
function describeRateSchedule(schedule: { days: number[]; time: string }): string {
  const set = new Set(schedule.days)
  const everyDay = set.size === 7
  const weekdays = set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))
  // Display weeks starting Monday so weekend pairs read "Sat, Sun".
  const sorted = [...set].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
  const label = everyDay ? 'Every day' : weekdays ? 'Mon–Fri' : sorted.map((d) => DAY_LABELS[d]).join(', ')
  return `${label} at ${schedule.time} IST`
}

/** Human countdown for a pending scheduled change (`in 2d 3h`, `due now`). */
function timeUntil(iso: string): string {
  const ms = Date.parse(iso) - Date.now()
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'due now'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `in ${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 48) return `in ${hrs}h ${mins % 60}m`
  return `in ${Math.round(hrs / 24)}d`
}

// ── Schedule-change dialog helpers ────────────────────────────────────────

/** Date for `<input type="date">` in the device zone (IST for the shop). */
function toDateInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Time for `<input type="time">` in the device zone. */
function toTimeInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * The next local-time instant at `weekday, hour:minute` that is still ahead
 * (today counts when the time hasn't passed yet; otherwise next week).
 */
function upcomingWeekdayAt(weekday: number, hour: number, minute = 0, from = new Date()): Date {
  const d = new Date(from)
  d.setHours(hour, minute, 0, 0)
  let delta = (weekday - d.getDay() + 7) % 7
  // Already past (or within a minute) on the matching day → next week.
  if (delta === 0 && d.getTime() <= from.getTime() + 60_000) delta = 7
  d.setDate(d.getDate() + delta)
  return d
}

/** Label for a preset instant, e.g. "Tomorrow 9:00 AM". */
function presetLabel(d: Date, prefix: string): string {
  const h12 = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12
  const ampm = d.getHours() >= 12 ? 'PM' : 'AM'
  return `${prefix} ${h12}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`
}

const SCHEDULE_STEP_LABELS = ['Set the rate', 'Pick date & time', 'Preview & confirm']

function ScheduleStepper({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2">
      {SCHEDULE_STEP_LABELS.map((label, i) => {
        const done = i < step
        const active = i === step
        return (
          <div key={label} className="flex min-w-0 flex-1 items-center gap-2">
            <div
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
                done && 'border-success bg-success-50 text-success-700',
                active && 'border-primary bg-primary text-white shadow-sm',
                !done && !active && 'border-border text-muted-foreground',
              )}
            >
              {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </div>
            <p
              className={cn(
                'min-w-0 truncate text-xs font-semibold',
                active ? 'text-foreground' : done ? 'text-success-700' : 'text-muted-foreground',
              )}
            >
              {label}
            </p>
            {i < SCHEDULE_STEP_LABELS.length - 1 ? (
              <div className={cn('h-px flex-1', done ? 'bg-success/40' : 'bg-border')} />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
