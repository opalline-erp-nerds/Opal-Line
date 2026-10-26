import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  Maximize2,
  Minimize2,
  MoreHorizontal,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { dbApi, shopifyApi } from '@/lib/api'
import { useSilverRate } from '@/lib/silver-rate-context'
import {
  RateUpdateDetailDialog,
  SilverRatePipeline,
  StepDots,
  SyncStatusBadge,
  ViewUpdateButton,
} from '@/components/dashboard/silver-rate-pipeline'
import { pipelineSucceeded, plannedSteps, stepsFromPhase, stepsFromResult, stepsFromStepLog } from '@/lib/silverRatePipeline'
import type { PendingRateChange, Product, SilverRate, SilverRateAutoStatus, SilverRateProgress, SilverRateRequestRow, SilverRateRow } from '@/types'
import { formatCurrency, formatDateTime, formatWeight, istDateKey } from '@/lib/format'
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

/** One row of the price preview inside the drawer (old → new retail price). */
interface PreviewRow {
  product: Product
  oldPrice: number
  newPrice: number
}

export default function SilverRatePage() {
  const { refresh: refreshSilverRate } = useSilverRate()
  const approvalsRef = useRef<HTMLDivElement>(null)
  // 0 = closed, 1 = edit (rate / when), 2 = review, 3 = result
  const [step, setStep] = useState(0)
  // One drawer, two flows: apply the rate now, or queue it for later.
  const [mode, setMode] = useState<'now' | 'schedule'>('now')
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
  // Products repriced by the most recent apply/fetch in this session; falls
  // back to the catalog size (that is what the last apply covered).
  const [lastRepriced, setLastRepriced] = useState<number | null>(null)
  // History log: From/To date filter + the "View" dialog for one update.
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [viewRow, setViewRow] = useState<SilverRateRow | null>(null)
  // One-off scheduled rate changes: a rate + a specific date/time applied
  // automatically then (queue lives in settings.scheduled_rate_changes).
  // Guided dialog state — rate → when → preview, plus edit-in-place.
  const [scheduled, setScheduled] = useState<PendingRateChange[]>([])
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
    setMode('now')
    setError('')
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
        setLastRepriced(res.updated)
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

  /** Old → new prices for every product at the dialog's rate (review step). */
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
    setMode('schedule')
    setSchError('')
    setSchSuccess('')
    setSchEditId(edit?.id ?? null)
    seedWhenPresets()
    if (edit) {
      const at = new Date(edit.applyAt)
      setSchRate(String(edit.rate))
      setSchDate(toDateInputValue(at))
      setSchTime(toTimeInputValue(at))
      setSchNote(edit.note ?? '')
    } else {
      setSchRate(String(currentRate.rate))
      // Sensible default: an hour from now, easy to nudge with the presets.
      const soon = hourFromNow()
      setSchDate(toDateInputValue(soon))
      setSchTime(toTimeInputValue(soon))
      setSchNote('')
    }
    setError('')
    setStep(1)
    setDialogOpen(true)
  }

  /**
   * One-click "when" presets — computed as an event (not during render) so
   * the clock is read exactly when the drawer opens and never goes stale.
   */
  const seedWhenPresets = () => {
    const tomorrow = (new Date().getDay() + 1) % 7
    setWhenPresets([
      { key: 'tmr-9', label: presetLabel(upcomingWeekdayAt(tomorrow, 9), 'Tomorrow'), date: upcomingWeekdayAt(tomorrow, 9) },
      { key: 'tmr-18', label: presetLabel(upcomingWeekdayAt(tomorrow, 18), 'Tomorrow'), date: upcomingWeekdayAt(tomorrow, 18) },
      { key: 'sat-10', label: presetLabel(upcomingWeekdayAt(6, 10), 'Saturday'), date: upcomingWeekdayAt(6, 10) },
      { key: 'mon-9', label: presetLabel(upcomingWeekdayAt(1, 9), 'Monday'), date: upcomingWeekdayAt(1, 9) },
    ])
  }

  /** Seed the schedule draft (rate + an hour from now) when it is still empty. */
  const seedScheduleDraft = () => {
    seedWhenPresets()
    if (!schDate) {
      const soon = hourFromNow()
      setSchDate(toDateInputValue(soon))
      setSchTime(toTimeInputValue(soon))
    }
    if (!Number.isFinite(parseFloat(schRate))) setSchRate(String(currentRate.rate))
  }

  /** Edit step → review step (rate + when must both be valid). */
  const reviewSchedule = () => {
    if (!scheduleRateValid) {
      setSchError('Enter a valid rate — ₹/gm greater than 0')
      return
    }
    if (!scheduleInstant) {
      setSchError('Pick the date and time to apply the rate')
      return
    }
    if (scheduleInstant.getTime() <= Date.now() + 60_000) {
      setSchError('Schedule the change at least a minute in the future')
      return
    }
    setSchError('')
    setStep(2)
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
      setDialogOpen(false)
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
      if (res.ok) setLastRepriced(res.repriced ?? null)
      loadAll()
    } catch (e) {
      setFetchNowResult({ ok: false, message: e instanceof Error ? e.message : 'Fetch failed' })
    } finally {
      setFetchingNow(false)
    }
  }

  const rollbackTo = (rate: number) => {
    setMode('now')
    setError('')
    setNewRate(String(rate))
    setStep(1)
    setRateProgress(null)
    setRateMinimized(false)
    setDialogOpen(true)
  }

  const pendingCount = useMemo(() => requests.filter((r) => r.status === 'pending').length, [requests])
  // Admin / Super Admin can apply a rate change (and fetch the spot rate)
  // directly; every other role always goes through approval.
  const canApprove = isApprover || autoStatus?.isApprover === true

  /** Pending rows first so the decision list leads the expanded card. */
  const sortedRequests = useMemo(
    () => [...requests].sort((a, b) => Number(a.status !== 'pending') - Number(b.status !== 'pending')),
    [requests],
  )

  const nextScheduled = useMemo(
    () => [...scheduled].sort((a, b) => Date.parse(a.applyAt) - Date.parse(b.applyAt))[0] ?? null,
    [scheduled],
  )

  /** Newest 5 recorded rates, oldest → newest, for the hero sparkline. */
  const sparkRates = useMemo(() => {
    const rows = [...history]
      .filter((h) => h.updatedAt && !Number.isNaN(Date.parse(h.updatedAt)))
      .sort((a, b) => Date.parse(b.updatedAt as string) - Date.parse(a.updatedAt as string))
      .slice(0, 5)
      .map((h) => h.rate)
    const list = rows.length >= 2 ? rows : [currentRate.previousRate, currentRate.rate]
    return list.filter((r) => Number.isFinite(r) && r > 0).reverse()
  }, [history, currentRate])

  // Rate field in view: apply mode edits `newRate`, schedule mode edits `schRate`.
  const activeRate = mode === 'now' ? rateValue : scheduleDialogRate
  const activeRateValid = mode === 'now' ? rateValid : scheduleRateValid
  const activeDelta = activeRateValid ? Math.round((activeRate - currentRate.rate) * 100) / 100 : 0

  const setActiveRate = (value: string) => (mode === 'now' ? setNewRate(value) : setSchRate(value))

  const adjustRate = (delta: number) => {
    const base = Number.isFinite(parseFloat(mode === 'now' ? newRate : schRate)) ? parseFloat(mode === 'now' ? newRate : schRate) : currentRate.rate
    setActiveRate((Math.round((base + delta) * 100) / 100).toFixed(2))
  }

  const resetRate = () => setActiveRate(String(currentRate.rate))

  const focusApprovals = () => {
    approvalsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    approvalsRef.current?.focus({ preventScroll: true })
  }

  const footerError = mode === 'now' ? error : schError

  const syncBadge = processing
    ? { variant: 'info' as const, label: 'Applying…' }
    : history[0]?.syncStatus === 'synced'
      ? { variant: 'success' as const, label: 'Synced' }
      : history[0]?.syncStatus === 'failed'
        ? { variant: 'danger' as const, label: 'Failed' }
        : history[0]?.syncStatus === 'skipped'
          ? { variant: 'muted' as const, label: 'Skipped' }
          : { variant: 'muted' as const, label: '—' }

  const repriced = lastRepriced ?? products.length

  /** Live pipeline while an apply runs (driven by the progress polling). */
  const liveSteps = useMemo(
    () =>
      rateProgress
        ? stepsFromPhase({
            progress: {
              phase: rateProgress.phase,
              label: rateProgress.label,
              total: rateProgress.total,
              error: rateProgress.error,
            },
            syncFirst,
          })
        : [],
    [rateProgress, syncFirst],
  )

  /** Final pipeline for the run just applied: result.steps + the row's step log. */
  const finalSteps = useMemo(() => {
    if (result?.steps && result.steps.length > 0) {
      const appliedRow = history.find((h) => h.rate === result.rate) ?? null
      return stepsFromResult(result.steps, appliedRow?.stepLog ?? null)
    }
    const newest = history[0]
    return newest?.stepLog ? stepsFromStepLog(newest.stepLog) : []
  }, [result, history])

  /** History rows narrowed by the From/To filter (IST calendar days). */
  const filteredHistory = useMemo(() => {
    if (!fromDate && !toDate) return history
    return history.filter((h) => {
      const day = istDateKey(h.updatedAt)
      if (!day) return true
      if (fromDate && day < fromDate) return false
      if (toDate && day > toDate) return false
      return true
    })
  }, [history, fromDate, toDate])

  const autoLine = !autoStatus
    ? 'Auto-rate status unavailable.'
    : autoStatus.lastError
      ? autoStatus.lastError
      : `Next run ${formatDateTime(autoStatus.nextRunAt)} · last fetch ${
          autoStatus.lastRate != null ? `₹${autoStatus.lastRate.toFixed(2)} / gm` : autoStatus.lastResult ?? 'never'
        }`

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link to="/" className="hover:text-primary-700">Dashboard</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-medium text-foreground">Silver Rate</span>
      </div>

      <PageHeader
        title="Silver Rate Management"
        subtitle="Silver rates drive all product pricing."
        actions={
          <>
            <Button variant="outline" onClick={syncProducts} disabled={syncingProducts} className="gap-2">
              <RefreshCw className={cn('h-4 w-4', syncingProducts && 'animate-spin')} />
              {syncingProducts ? 'Syncing…' : 'Sync products'}
            </Button>
            <Button onClick={openUpdate} className="gap-2">
              <TrendingUp className="h-4 w-4" /> {canApprove ? 'Update Silver Rate' : 'Request Rate Change'}
            </Button>
          </>
        }
      />

      {autoStatus && !autoStatus.apiUrlConfigured ? (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center sm:gap-x-3"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
          <div className="min-w-0 sm:flex-1">
            <p className="font-semibold">Rate source not configured</p>
            <p className="text-[13px] text-amber-800">
              Automatic spot-rate fetching stays off until SILVER_RATE_API_URL is set on the server.
            </p>
          </div>
          <Link
            to="/system/settings"
            className="rounded-md border border-amber-400 bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900 transition-colors hover:bg-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-1"
          >
            Open settings
          </Link>
        </div>
      ) : null}

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

      {/* ── Hero: current rate + status at a glance ─────────────────────── */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="overflow-hidden border-primary-100 bg-gradient-to-br from-primary-700 to-primary-900 text-white md:col-span-2">
          <CardContent className="p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-primary-200">
                  <Tag className="h-4 w-4" />
                  <p className="text-xs font-semibold uppercase tracking-wide">Current silver rate</p>
                </div>
                <div className="mt-2 flex flex-wrap items-end gap-3">
                  <p className="text-4xl font-bold tabular-nums tracking-tight sm:text-5xl">
                    ₹{currentRate.rate.toFixed(2)}
                  </p>
                  <Badge
                    variant="success"
                    className={cn(
                      'mb-1.5 border-white/20',
                      currentRate.change > 0
                        ? 'bg-success-500/20 text-success-100'
                        : currentRate.change < 0
                          ? 'bg-red-500/20 text-red-100'
                          : 'bg-white/10 text-primary-100',
                    )}
                  >
                    {`${currentRate.change > 0 ? '+' : currentRate.change < 0 ? '−' : ''}₹${Math.abs(currentRate.change).toFixed(2)} (${currentRate.change > 0 ? '+' : currentRate.change < 0 ? '−' : ''}${Math.abs(currentRate.changePercent).toFixed(2)}%)`}
                  </Badge>
                </div>
                <p className="text-sm font-medium text-primary-200">per gram · 92.5 sterling silver</p>
                <p className="mt-3 flex items-center gap-1.5 text-xs text-primary-200">
                  <Clock className="h-3.5 w-3.5" />
                  Last updated <span className="font-medium text-white">{formatDateTime(currentRate.updatedAt)}</span>
                </p>
              </div>
              {sparkRates.length >= 2 ? (
                <div className="shrink-0 text-left sm:text-right">
                  <p className="text-[10.5px] uppercase tracking-wide text-primary-200">
                    Last {sparkRates.length} rates
                  </p>
                  <RateSparkline rates={sparkRates} />
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</p>
            <dl className="mt-3 divide-y divide-border/70">
              <div className="flex items-center justify-between gap-3 pb-3">
                <dt className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <RefreshCw className="h-3.5 w-3.5" /> Shopify sync
                </dt>
                <dd>
                  <Badge variant={syncBadge.variant} dot>{syncBadge.label}</Badge>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-3">
                <dt className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <Gem className="h-3.5 w-3.5" /> Products repriced
                </dt>
                <dd className="text-sm font-bold tabular-nums text-foreground">{repriced.toLocaleString('en-IN')}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 pt-3">
                <dt className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <ShieldCheck className="h-3.5 w-3.5" /> Pending approvals
                </dt>
                <dd>
                  <Badge variant={pendingCount > 0 ? 'warning' : 'muted'} dot>
                    {pendingCount}
                  </Badge>
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>

      {/* ── Three compact cards ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <CompactCard
          icon={ShieldCheck}
          title="Approvals"
          badge={
            <Badge variant={pendingCount > 0 ? 'warning' : 'muted'} dot>
              {pendingCount > 0 ? `${pendingCount} pending` : 'None pending'}
            </Badge>
          }
          line={
            pendingCount > 0
              ? `${pendingCount} rate change request${pendingCount > 1 ? 's' : ''} waiting for a decision.`
              : 'No rate changes waiting for approval.'
          }
        >
          {pendingCount > 0 ? (
            <Button size="sm" onClick={focusApprovals}>Review</Button>
          ) : (
            <Button size="sm" variant="outline" onClick={openUpdate}>Update rate</Button>
          )}
        </CompactCard>

        <CompactCard
          icon={CalendarClock}
          title="Scheduled"
          badge={
            <Badge variant={scheduled.length > 0 ? 'warning' : 'muted'} dot>
              {scheduled.length > 0 ? `${scheduled.length} queued` : 'None'}
            </Badge>
          }
          line={
            !canApprove
              ? 'Only Admin or Super Admin can schedule a rate change.'
              : nextScheduled
                ? `₹${nextScheduled.rate.toFixed(2)} / gm · ${formatDateTime(nextScheduled.applyAt)} · ${timeUntil(nextScheduled.applyAt)}`
                : 'No rate changes scheduled.'
          }
        >
          <Button
            size="sm"
            variant="outline"
            onClick={() => openScheduleDialog()}
            disabled={!canApprove}
            title={canApprove ? undefined : 'Only Admin or Super Admin can schedule a rate change'}
          >
            Schedule
          </Button>
        </CompactCard>

        <CompactCard
          icon={Clock}
          title="Auto rate"
          badge={
            <Badge variant={autoStatus?.enabled ? 'success' : 'muted'} dot>
              {autoStatus?.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
          }
          line={autoLine}
        >
          <Button
            size="sm"
            variant={autoStatus?.enabled ? 'outline' : 'soft-primary'}
            onClick={toggleAuto}
            disabled={togglingAuto || !autoStatus}
          >
            {togglingAuto ? 'Saving…' : autoStatus?.enabled ? 'Disable auto rate' : 'Enable auto rate'}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="gap-1" aria-label="More auto-rate actions">
                <MoreHorizontal className="h-4 w-4" /> More
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={fetchNow}
                disabled={fetchingNow || !autoStatus?.apiUrlConfigured || !canApprove}
                title={canApprove ? undefined : 'Only Admin or Super Admin can fetch and apply the live silver rate'}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', fetchingNow && 'animate-spin')} />
                {fetchingNow ? 'Fetching…' : 'Fetch spot rate now'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={openScheduleEditor} disabled={!autoStatus}>
                <CalendarClock className="h-3.5 w-3.5" /> Edit schedule
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CompactCard>
      </div>

      {!dialogOpen && !scheduleOpen && (error || schError || schSuccess) ? (
        <div
          role="status"
          className={cn(
            'flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm',
            error || schError ? 'border-red-200 bg-red-50/60 text-red-700' : 'border-success-100 bg-success-50/60 text-success-700',
          )}
        >
          {error || schError ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{error || schError || schSuccess}</span>
        </div>
      ) : null}

      {/* ── Expanded lists: only when there is something to act on ──────── */}
      {pendingCount > 0 ? (
        <Card ref={approvalsRef} tabIndex={-1} className="focus:outline-none" id="pending-approvals">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Rate change approvals</CardTitle>
            </div>
            <Badge variant="warning" dot>{pendingCount} pending</Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            {sortedRequests.map((r) => (
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
          </CardContent>
        </Card>
      ) : null}

      {scheduled.length > 0 ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Scheduled rate changes</CardTitle>
            </div>
            <Badge variant="warning" dot>{scheduled.length} queued</Badge>
          </CardHeader>
          <CardContent className="space-y-2">
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
          </CardContent>
        </Card>
      ) : null}

      {/* ── History ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row flex-wrap items-end justify-between gap-3 space-y-0">
          <div>
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Rate history</CardTitle>
            </div>
            <CardDescription className="mt-0.5">
              Every rate change, with the steps each update went through.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="history-from" className="text-[11px] uppercase tracking-wide">From</Label>
              <Input
                id="history-from"
                type="date"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => setFromDate(e.target.value)}
                className="h-8 w-36"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="history-to" className="text-[11px] uppercase tracking-wide">To</Label>
              <Input
                id="history-to"
                type="date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => setToDate(e.target.value)}
                className="h-8 w-36"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={!fromDate && !toDate}
              onClick={() => {
                setFromDate('')
                setToDate('')
              }}
            >
              Clear
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table className="min-w-[860px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Rate</TableHead>
                  <TableHead>Change</TableHead>
                  <TableHead>Approved by</TableHead>
                  <TableHead className="text-center">Shopify</TableHead>
                  <TableHead className="text-center">Steps</TableHead>
                  <TableHead className="text-center">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredHistory.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                      {history.length === 0 ? 'No rate history yet.' : 'No updates in this date range.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredHistory.map((h) => {
                    const prev = h.previousRate ?? currentRate.previousRate
                    const diff = Math.round((h.rate - prev) * 100) / 100
                    const source = h.source ?? 'legacy'
                    const sourceLabel = source === 'auto' ? 'Auto fetch' : source === 'approval' ? 'Approved request' : source === 'manual' ? 'Manual' : 'Legacy entry'
                    return (
                      <TableRow key={h.id}>
                        <TableCell className="font-medium whitespace-nowrap">{formatDateTime(h.updatedAt)}</TableCell>
                        <TableCell className="tabular-nums whitespace-nowrap">
                          ₹{prev.toFixed(2)} <span className="text-muted-foreground">→</span>{' '}
                          <span className="font-semibold text-foreground">₹{h.rate.toFixed(2)}</span>
                        </TableCell>
                        <TableCell>
                          <Badge variant={diff > 0 ? 'success' : diff < 0 ? 'danger' : 'muted'}>
                            {diff > 0 ? '+' : diff < 0 ? '−' : ''}₹{Math.abs(diff).toFixed(2)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="leading-tight">
                            <p className="font-medium text-foreground">{h.approvedBy ?? h.updatedBy ?? 'Unknown'}</p>
                            <p className="text-[10.5px] text-muted-foreground">
                              {sourceLabel}
                              {h.approvedBy && h.approvedBy !== h.updatedBy ? ` · by ${h.updatedBy}` : ''}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="text-center">
                          <SyncStatusBadge status={h.syncStatus} />
                        </TableCell>
                        <TableCell className="text-center">
                          <StepDots steps={h.stepLog ? stepsFromStepLog(h.stepLog) : []} />
                        </TableCell>
                        <TableCell className="text-center">
                          <div className="flex items-center justify-center gap-1">
                            <ViewUpdateButton onClick={() => setViewRow(h)} />
                            {h.rate !== currentRate.rate ? (
                              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-primary" onClick={() => rollbackTo(h.rate)}>
                                <Undo2 className="h-3.5 w-3.5" /> Restore
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* ── Recurring auto-update schedule editor ───────────────────────── */}
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
                      'h-9 w-11 rounded-md border text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
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

      <RateUpdateDetailDialog
        row={viewRow}
        open={viewRow !== null}
        onOpenChange={(open) => {
          if (!open) setViewRow(null)
        }}
      />

      {/* ── One drawer: apply now or schedule ───────────────────────────── */}
      <AppDialog
        open={dialogOpen && !rateMinimized}
        onOpenChange={(open) => {
          if (open) { setDialogOpen(true); return }
          // Closing while the update runs minimises it to the floating pill —
          // the request keeps running, it is not cancelled.
          if (processing) setRateMinimized(true)
          else {
            setDialogOpen(false)
            setSchError('')
          }
        }}
        size="xl"
        isDirty={dialogOpen && (mode === 'now' ? newRate !== '' : schRate !== '' || schDate !== '' || schTime !== '')}
        title={
          mode === 'now'
            ? 'Update silver rate'
            : schEditId
              ? 'Edit scheduled rate change'
              : 'Schedule a silver rate change'
        }
        description={
          mode === 'now'
            ? 'Reprice every product from the new 92.5% silver rate, review the impact, then push approved prices to Shopify.'
            : 'Set a rate for an exact date & time — applied automatically then, even while the app is closed.'
        }
        footer={
          step < 3 ? (
            <DialogFooter className="mt-2">
              {footerError ? (
                <div className="mb-2 flex w-full items-start gap-2 rounded-md border border-red-200 bg-red-50/60 p-2.5 text-xs text-red-700">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{footerError}</span>
                </div>
              ) : null}
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              {step === 1 ? (
                mode === 'now' ? (
                  <Button onClick={confirmChange} disabled={!rateValid}>
                    Review prices <ArrowRight className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button onClick={reviewSchedule} disabled={!scheduleRateValid}>
                    Review and schedule <ArrowRight className="h-4 w-4" />
                  </Button>
                )
              ) : mode === 'now' ? (
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
                        <ShieldCheck className="h-4 w-4" /> Approve &amp; Update Shopify
                      </>
                    )}
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="outline" onClick={() => setStep(1)} disabled={schSaving}>Back</Button>
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
                </>
              )}
            </DialogFooter>
          ) : null
        }
      >
        {step < 3 ? (
          <div className="space-y-4">
            {step === 1 ? (
              <>
                <Tabs
                  value={mode}
                  onValueChange={(v) => {
                    const next = v as 'now' | 'schedule'
                    if (next === 'schedule') seedScheduleDraft()
                    setMode(next)
                    setError('')
                    setSchError('')
                  }}
                >
                  <TabsList aria-label="When the rate applies">
                    <TabsTrigger value="now">Apply now</TabsTrigger>
                    <TabsTrigger value="schedule">Schedule</TabsTrigger>
                  </TabsList>
                </Tabs>

                <div className="rounded-lg border border-primary-200 bg-primary-50/60 p-3">
                  <Label htmlFor="silver-rate-input" className="text-[11px] uppercase tracking-wide text-primary-700">
                    Rate (₹ / gm)
                  </Label>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <span className="text-lg font-bold text-foreground">₹</span>
                    <Input
                      id="silver-rate-input"
                      autoFocus
                      type="number"
                      min="0"
                      step="0.1"
                      value={mode === 'now' ? newRate : schRate}
                      onChange={(e) => setActiveRate(e.target.value)}
                      className="h-9 w-32 border-primary-200 font-bold tabular-nums focus-visible:ring-primary"
                    />
                    <span className="text-sm font-medium text-muted-foreground">/ gm</span>
                    {activeRateValid ? (
                      <Badge variant={activeDelta >= 0 ? 'success' : 'danger'}>
                        {activeDelta >= 0 ? '+' : '−'}₹{Math.abs(activeDelta).toFixed(2)} vs today
                      </Badge>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Quick adjust (₹ / gm)
                  </Label>
                  <div className="flex flex-wrap gap-1.5">
                    {[-1, -0.5, 0.5, 1].map((delta) => (
                      <button
                        key={delta}
                        type="button"
                        aria-label={`Adjust rate ${delta > 0 ? 'up' : 'down'} by ${Math.abs(delta)} rupees`}
                        onClick={() => adjustRate(delta)}
                        className="h-9 rounded-md border border-border bg-card px-3 text-xs font-semibold tabular-nums text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                      >
                        {delta > 0 ? '+' : '−'}{Math.abs(delta)}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={resetRate}
                      className="h-9 rounded-md border border-border bg-card px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                    >
                      Reset
                    </button>
                  </div>
                </div>

                {mode === 'schedule' ? (
                  <div className="space-y-4 border-t border-border/60 pt-4">
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
                                'h-9 rounded-md border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
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
                ) : null}

                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border bg-muted/40 p-3 sm:grid-cols-4">
                  <SummaryItem label="Current rate" value={`₹${currentRate.rate.toFixed(2)}`} sub="per gram" />
                  <SummaryItem
                    label="Change"
                    value={activeRateValid ? `${activeDelta >= 0 ? '+' : '−'}₹${Math.abs(activeDelta).toFixed(2)}` : '—'}
                    sub={activeRateValid ? 'vs today' : 'enter a rate'}
                    accent={activeRateValid ? (activeDelta >= 0 ? 'green' : 'red') : undefined}
                  />
                  <SummaryItem label="Products affected" value={`${products.length}`} sub="repriced" />
                  <SummaryItem
                    label={mode === 'now' ? 'Goes to Shopify' : 'Applies'}
                    value={
                      mode === 'now'
                        ? 'After approval'
                        : scheduleInstant
                          ? formatDateTime(scheduleInstant.toISOString())
                          : '—'
                    }
                    sub={
                      mode === 'now'
                        ? 'immediately'
                        : scheduleInstant
                          ? timeUntil(scheduleInstant.toISOString())
                          : 'pick date & time'
                    }
                  />
                </dl>
              </>
            ) : null}

            {step === 2 && mode === 'now' ? (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  <MiniBadge label="Old Rate" value={`₹${currentRate.rate.toFixed(2)}`} />
                  <MiniBadge label="New Rate" value={`₹${rateValue.toFixed(2)}`} />
                  <MiniBadge
                    label="Change"
                    value={`${rateValue >= currentRate.rate ? '+' : ''}₹${(rateValue - currentRate.rate).toFixed(2)}`}
                    accent={rateValue >= currentRate.rate ? 'green' : 'red'}
                  />
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {processing ? 'Update pipeline' : 'This update will'}
                    </p>
                  </div>
                  <SilverRatePipeline steps={processing ? liveSteps : plannedSteps(syncFirst)} />
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Preview — {products.length} products
                    </p>
                    <Badge variant="warning">{formatCurrency(totalDelta)} total shift</Badge>
                  </div>
                  <PreviewTable rows={affected} />
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
              </div>
            ) : null}

            {step === 2 && mode === 'schedule' ? (
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

                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Preview — {products.length} products
                    </p>
                    <Badge variant="warning">{formatCurrency(scheduleTotalDelta)} total shift</Badge>
                  </div>
                  <PreviewTable rows={scheduleImpact ?? []} />
                </div>

                <p className="rounded-lg border border-primary-100 bg-primary-50/40 p-3 text-xs text-primary-900">
                  Applies {scheduleInstant ? formatDateTime(scheduleInstant.toISOString()) : '—'}
                  {scheduleInstant ? ` · ${timeUntil(scheduleInstant.toISOString())}` : ''} — products are repriced and
                  pushed to Shopify automatically at that moment.
                </p>
              </div>
            ) : null}
          </div>
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
            {finalSteps.length > 0 ? (
              <div className="w-full max-w-md space-y-2 py-2 text-left">
                <SilverRatePipeline steps={finalSteps} complete={pipelineSucceeded(finalSteps)} />
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
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

/** Badge + one line + one action — the three status cards share this shell. */
function CompactCard({
  icon: Icon,
  title,
  badge,
  line,
  children,
}: {
  icon: LucideIcon
  title: string
  badge: ReactNode
  line: string
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-sm">{title}</CardTitle>
        </div>
        {badge}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[13px] leading-snug text-muted-foreground">{line}</p>
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      </CardContent>
    </Card>
  )
}

/** One cell of the drawer's summary grid (`<dl>` item). */
function SummaryItem({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string
  sub?: string
  accent?: 'green' | 'red'
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'mt-0.5 truncate text-sm font-bold tabular-nums',
          accent === 'green' ? 'text-success-700' : accent === 'red' ? 'text-red-600 dark:text-red-400' : 'text-foreground',
        )}
      >
        {value}
      </dd>
      {sub ? <dd className="truncate text-[11px] text-muted-foreground">{sub}</dd> : null}
    </div>
  )
}

/** Old → new retail prices for the review step (scrollable, mobile-safe). */
function PreviewTable({ rows }: { rows: PreviewRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border px-3 py-6 text-center text-[13px] text-muted-foreground">
        No products to preview yet.
      </p>
    )
  }
  return (
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
          {rows.map(({ product, oldPrice, newPrice }) => {
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
  )
}

/** Tiny trend line of the last few rates for the hero card. */
function RateSparkline({ rates }: { rates: number[] }) {
  if (rates.length < 2) return null
  const w = 150
  const h = 44
  const pad = 5
  const min = Math.min(...rates)
  const max = Math.max(...rates)
  const span = max - min || 1
  const points = rates.map((rate, i) => {
    const x = pad + (i * (w - pad * 2)) / (rates.length - 1)
    const y = h - pad - ((rate - min) / span) * (h - pad * 2)
    return { x, y }
  })
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const last = points[points.length - 1]
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`Last ${rates.length} rates: ₹${rates[0].toFixed(2)} to ₹${rates[rates.length - 1].toFixed(2)} per gram`}
      className="mt-1"
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last.x} cy={last.y} r="3.5" fill="currentColor" />
    </svg>
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

/** One hour from now — the default instant for a new scheduled change. */
function hourFromNow(from = new Date()): Date {
  return new Date(from.getTime() + 60 * 60_000)
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
