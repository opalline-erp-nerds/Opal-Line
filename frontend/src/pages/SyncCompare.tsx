import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDownUp, Clock, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { shopifyApi, type SyncCompareRow } from '@/lib/api'

const fmt = (n: number | null) => (n == null ? '—' : n.toLocaleString('en-IN'))

const stateBadge = (state: string) => {
  switch (state) {
    case 'both-diff':
      return <Badge variant="danger">Price + Stock</Badge>
    case 'price-diff':
      return <Badge variant="warning">Price</Badge>
    case 'stock-diff':
      return <Badge variant="warning">Stock</Badge>
    case 'local-only':
      return <Badge variant="info">Local only</Badge>
    case 'shopify-only':
      return <Badge variant="brand">Shopify only</Badge>
    default:
      return <Badge variant="success">In sync</Badge>
  }
}

type Filter = 'all' | 'diffs' | 'local-only' | 'shopify-only'
type IntervalUnit = 'seconds' | 'minutes' | 'hours'

const maxForUnit = (unit: IntervalUnit) => (unit === 'hours' ? 168 : unit === 'minutes' ? 168 * 60 : 168 * 3600)

function draftFromSeconds(seconds: number): { value: string; unit: IntervalUnit } {
  if (seconds <= 0) return { value: '0', unit: 'minutes' }
  if (seconds % 3600 === 0) return { value: String(seconds / 3600), unit: 'hours' }
  if (seconds % 60 === 0) return { value: String(seconds / 60), unit: 'minutes' }
  return { value: String(seconds), unit: 'seconds' }
}

export default function SyncComparePage() {
  const [rows, setRows] = useState<SyncCompareRow[]>([])
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<Filter>('diffs')
  const [pulling, setPulling] = useState<string | null>(null)
  const [pullMsg, setPullMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // Auto-sync scheduler state
  const [auto, setAuto] = useState<{
    intervalSeconds: number
    intervalLabel: string
    enabled: boolean
    nextRunAt: string | null
    lastRunAt: string | null
    lastResult: {
      ok: boolean
      created?: number
      updated?: number
      skipped?: number
      failed?: number
      durationMs?: number
      message?: string
    } | null
    paused: boolean
    pauseWarning: string | null
    intervalWarning: string | null
    history: Array<{
      at: string
      ok: boolean
      created?: number
      updated?: number
      skipped?: number
      failed?: number
      durationMs?: number
      message?: string
    }>
  } | null>(null)
  const [removeMissing, setRemoveMissing] = useState(false)
  const [stockPreview, setStockPreview] = useState<{
    parentChanges: number
    variantChanges: number
    samples: Array<{ sku: string; field: string; old: number; new: number }>
  } | null>(null)
  const [intervalDraft, setIntervalDraft] = useState('6')
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>('hours')
  const [autoBusy, setAutoBusy] = useState(false)
  const [autoMsg, setAutoMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const loadAuto = useCallback(async () => {
    try {
      const s = await shopifyApi.getAutoSyncStatus()
      setAuto(s)
      const draft = draftFromSeconds(s.intervalSeconds)
      setIntervalDraft(draft.value)
      setIntervalUnit(draft.unit)
    } catch { /* card simply stays hidden */ }
  }, [])

  useEffect(() => {
    // Defer: loadAuto() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(() => {
      void loadAuto()
    })
  }, [loadAuto])

  const saveInterval = async () => {
    const value = Number(intervalDraft)
    const max = maxForUnit(intervalUnit)
    if (!Number.isFinite(value) || value < 0 || value > max) {
      setAutoMsg({ ok: false, text: `Enter 0 to disable, or 1–${max} ${intervalUnit} (minimum 1 minute when enabled).` })
      return
    }
    setAutoBusy(true)
    try {
      const r = await shopifyApi.setAutoSyncInterval(value, intervalUnit)
      await loadAuto()
      setAutoMsg({
        ok: true,
        text: value === 0 ? 'Auto-sync disabled.' : `Auto-sync: ${r.intervalLabel}.`,
      })
    } catch (e) {
      setAutoMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed to save interval' })
    } finally {
      setAutoBusy(false)
    }
  }

  const previewStock = async () => {
    setAutoBusy(true)
    setAutoMsg(null)
    try {
      const p = await shopifyApi.previewSyncStock()
      if (!p.ok) {
        setStockPreview(null)
        setAutoMsg({ ok: false, text: p.message ?? 'Stock preview failed' })
        return
      }
      setStockPreview({ parentChanges: p.parentChanges, variantChanges: p.variantChanges, samples: p.samples })
      setAutoMsg({
        ok: true,
        text: `Push preview: ${p.parentChanges} parent · ${p.variantChanges} variant row(s) will change on Shopify.`,
      })
    } catch (e) {
      setAutoMsg({ ok: false, text: e instanceof Error ? e.message : 'Stock preview failed' })
    } finally {
      setAutoBusy(false)
    }
  }

  const runNow = async () => {
    if (removeMissing) {
      const ok = window.confirm(
        'Remove local products that are linked to Shopify but no longer exist in the live catalog? This cannot be undone.',
      )
      if (!ok) return
    }
    setAutoBusy(true)
    setAutoMsg(null)
    try {
      const r = await shopifyApi.runAutoSync({ allowRemovals: removeMissing })
      await loadAuto()
      setAutoMsg(r.ok
        ? {
            ok: true,
            text: `Full sync: ${r.created ?? 0} new, ${r.updated ?? 0} updated, ${r.removed ?? 0} removed, ${r.skipped ?? 0} skipped${r.durationMs != null ? ` (${Math.round(r.durationMs / 1000)}s)` : ''}${r.push ? ` · push: ${r.push}` : ''}.`,
          }
        : { ok: false, text: r.message ?? 'Sync failed' })
    } catch (e) {
      setAutoMsg({ ok: false, text: e instanceof Error ? e.message : 'Sync failed' })
    } finally {
      setAutoBusy(false)
    }
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await shopifyApi.compareProducts()
      setRows(res.rows)
      setSyncedAt(res.syncedAt)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Comparison failed')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(() => {
      void load()
    })
  }, [load])

  const counts = useMemo(() => {
    const c = { diffs: 0, 'local-only': 0, 'shopify-only': 0, all: 0 }
    for (const r of rows) {
      c.all++
      if (r.state === 'local-only') c['local-only']++
      else if (r.state === 'shopify-only') c['shopify-only']++
      else if (r.state !== 'in-sync') c.diffs++
    }
    return c
  }, [rows])

  const visible = useMemo(() => {
    if (filter === 'diffs') return rows.filter((r) => !['in-sync', 'local-only', 'shopify-only'].includes(r.state))
    if (filter === 'all') return rows
    return rows.filter((r) => r.state === filter)
  }, [rows, filter])

  const pull = async (row: SyncCompareRow) => {
    if (!row.localId) return
    setPulling(row.localId)
    setPullMsg(null)
    try {
      const res = await shopifyApi.pullProduct(row.localId)
      setPullMsg({ ok: true, text: `Pulled ${row.sku}: price ₹${fmt(res.pulled?.price ?? null)}, stock ${fmt(res.pulled?.stock ?? null)}` })
      await load()
    } catch (e) {
      setPullMsg({ ok: false, text: e instanceof Error ? e.message : 'Pull failed' })
    } finally {
      setPulling(null)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-5 py-5 sm:py-6 lg:px-7">
      <PageHeader
        title="Product Sync Compare"
        subtitle="Side-by-side local vs Shopify prices & stock, matched by SKU."
        actions={
          <Button onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Refresh comparison
          </Button>
        }
      />

      {syncedAt && (
        <p className="text-xs text-muted-foreground">Shopify catalog fetched {new Date(syncedAt).toLocaleString()}</p>
      )}

      {auto && (
        <Card>
          <CardContent className="space-y-3 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <h3 className="font-semibold text-foreground">Auto-Sync Schedule</h3>
              </div>
              <Badge variant={auto.enabled ? 'success' : 'muted'}>{auto.intervalLabel}</Badge>
            </div>
            {auto.paused && auto.pauseWarning && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">
                {auto.pauseWarning}
              </p>
            )}
            {auto.intervalWarning && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                {auto.intervalWarning}
              </p>
            )}
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs text-muted-foreground">Last run</p>
                <p className="font-medium">{auto.lastRunAt ? new Date(auto.lastRunAt).toLocaleString() : 'Not yet run'}</p>
                {auto.lastResult?.durationMs != null && (
                  <p className="text-xs text-muted-foreground">{Math.round(auto.lastResult.durationMs / 1000)}s</p>
                )}
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Next run</p>
                <p className="font-medium">
                  {auto.enabled && !auto.paused
                    ? auto.nextRunAt
                      ? new Date(auto.nextRunAt).toLocaleString()
                      : 'On next restart'
                    : '—'}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Last counts</p>
                <p className="font-medium text-xs leading-relaxed">
                  {auto.lastResult
                    ? `${auto.lastResult.created ?? 0} created · ${auto.lastResult.updated ?? 0} updated · ${auto.lastResult.skipped ?? 0} skipped · ${auto.lastResult.failed ?? 0} failed`
                    : '—'}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Last result</p>
                <p className="font-medium">
                  {auto.lastResult ? (auto.lastResult.ok ? 'OK' : auto.lastResult.message ?? 'Failed') : '—'}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="number"
                min={0}
                max={maxForUnit(intervalUnit)}
                value={intervalDraft}
                onChange={(e) => setIntervalDraft(e.target.value)}
                className="w-24"
              />
              <Select
                className="w-32"
                value={intervalUnit}
                onValueChange={(v) => setIntervalUnit(v as IntervalUnit)}
                options={[
                  { value: 'seconds', label: 'Seconds' },
                  { value: 'minutes', label: 'Minutes' },
                  { value: 'hours', label: 'Hours' },
                ]}
              />
              <span className="text-xs text-muted-foreground">0 = off · min 1 min when on</span>
              <Button size="sm" variant="outline" onClick={saveInterval} disabled={autoBusy}>Save Interval</Button>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={removeMissing}
                  onChange={(e) => setRemoveMissing(e.target.checked)}
                  disabled={autoBusy}
                />
                Remove missing from ERP (manual only)
              </label>
              <Button size="sm" variant="outline" onClick={() => void previewStock()} disabled={autoBusy}>
                Preview stock push
              </Button>
              <Button size="sm" variant="outline" onClick={() => void runNow()} disabled={autoBusy}>
                <RefreshCw className={autoBusy ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /> Full Sync Now
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The ERP is the source of truth for the catalogue: name, description, price, stock, images, product type and
              collection are never imported from Shopify. Scheduled auto-sync is <strong>incremental</strong> and only
              discovers new listings and refreshes links; <strong>Full Sync Now</strong> does the same and then pushes the
              ERP values to the store. Removing products that Shopify no longer lists stays a separate, manual choice.
              For hosted stores, <strong>15–30 minutes</strong> is a practical auto-sync window (webhooks cover most
              catalog edits between runs).
            </p>
            {stockPreview && stockPreview.samples.length > 0 && (
              <div className="rounded-md border px-3 py-2 text-xs">
                <p className="mb-1 font-semibold">Stock push preview (up to 10) — Shopify now → ERP after</p>
                <ul className="space-y-0.5">
                  {stockPreview.samples.map((s, i) => (
                    <li key={i}>
                      <span className="font-mono">{s.sku}</span> {s.field}: {s.old} → {s.new}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {autoMsg && (
              <p className={`text-xs font-medium ${autoMsg.ok ? 'text-success-700' : 'text-destructive'}`}>{autoMsg.text}</p>
            )}
            {auto.history.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent runs</p>
                <div className="max-h-44 overflow-y-auto rounded-md border">
                  {auto.history.map((h, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5 text-xs last:border-0">
                      <span className="shrink-0 text-muted-foreground">{new Date(h.at).toLocaleString()}</span>
                      {h.ok ? (
                        <span className="font-medium text-success-700">
                          {h.created ?? 0} new · {h.updated ?? 0} upd · {h.skipped ?? 0} skip
                          {h.durationMs != null ? ` · ${Math.round(h.durationMs / 1000)}s` : ''}
                        </span>
                      ) : (
                        <span className="max-w-[60%] truncate font-medium text-destructive" title={h.message}>{h.message ?? 'Failed'}</span>
                      )}
                    </div>
                  ))
                  }
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {pullMsg && (
        <div className={`rounded-lg border p-3 text-sm font-medium ${pullMsg.ok ? 'border-success-200 bg-success-50 text-success-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {pullMsg.text}
        </div>
      )}

      {error && (
        <Card>
          <CardContent className="p-5 text-sm text-red-600 dark:text-red-400">{error}</CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        {(
          [
            ['diffs', `Differences (${counts.diffs})`],
            ['local-only', `Local only (${counts['local-only']})`],
            ['shopify-only', `Shopify only (${counts['shopify-only']})`],
            ['all', `All (${counts.all})`],
          ] as Array<[Filter, string]>
        ).map(([key, label]) => (
          <Button key={key} size="sm" variant={filter === key ? 'default' : 'outline'} onClick={() => setFilter(key)}>
            {label}
          </Button>
        ))}
      </div>

      <Card>
        <CardContent className="pt-6">
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Comparing catalogs…</p>
          ) : visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Nothing here — everything matches.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Local ₹</TableHead>
                    <TableHead className="text-right">Shopify ₹</TableHead>
                    <TableHead className="text-right">Δ Price</TableHead>
                    <TableHead className="text-right">Local stock</TableHead>
                    <TableHead className="text-right">Shopify stock</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((r) => (
                    <TableRow key={r.localId || `shop-${r.shopifyId}`}>
                      <TableCell className="font-mono text-xs">{r.sku || '—'}</TableCell>
                      <TableCell className="max-w-[220px] truncate text-sm">{r.name}</TableCell>
                      <TableCell className="text-right text-sm">{fmt(r.localPrice)}</TableCell>
                      <TableCell className="text-right text-sm">{fmt(r.shopifyPrice)}</TableCell>
                      <TableCell className={`text-right text-sm font-medium ${r.priceDelta && r.priceDelta !== 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                        {r.priceDelta == null ? '—' : r.priceDelta > 0 ? `+${fmt(r.priceDelta)}` : fmt(r.priceDelta)}
                      </TableCell>
                      <TableCell className="text-right text-sm">{fmt(r.localStock)}</TableCell>
                      <TableCell className="text-right text-sm">{fmt(r.shopifyStock)}</TableCell>
                      <TableCell>{stateBadge(r.state)}</TableCell>
                      <TableCell className="text-right">
                        {r.localId && r.shopifyId && !['in-sync'].includes(r.state) ? (
                          <Button size="sm" variant="outline" onClick={() => void pull(r)} disabled={pulling === r.localId}>
                            <ArrowDownUp className="h-3 w-3" />
                            {pulling === r.localId ? 'Pulling…' : 'Pull'}
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
