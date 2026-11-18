import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, ScanLine, Save, Trash2, AlertCircle, CloudUpload, Loader2, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { dbApi } from '@/lib/api'
import type { InventoryLocation, StockAnomalies, UnattributedBalance } from '@/types'
import { formatLocationLabel } from '@/lib/locations'
import { Switch } from '@/components/ui/switch'

interface ScannedItem {
  /**
   * `productId` for a product-level row, `productId::variantId` for a variant
   * row — a multi-variant product counts once per variant, so the product id
   * alone is no longer a unique key on the sheet.
   */
  key: string
  id: string
  variantId: string | null
  variantTitle: string | null
  name: string
  sku: string
  systemStock: number | null
  counted: number
}

/**
 * What a freshly added (or mode-switched) row starts at.
 *
 * `set` pre-fills what the ledger already says, so applying an untouched sheet
 * is a no-op instead of replacing stock with whatever was last typed;
 * `adjust` pre-fills zero, because in that mode the number IS the delta.
 */
function prefillCounted(mode: 'set' | 'adjust', baseline: number | null): number {
  if (mode === 'adjust') return 0
  return baseline != null ? Math.max(0, baseline) : 0
}

export default function StockCountPage() {
  const [items, setItems] = useState<ScannedItem[]>([])
  const [code, setCode] = useState('')
  const [mode, setMode] = useState<'set' | 'adjust'>('set')
  // A count is taken at ONE location. The backend adjusts that location's
  // balance, so the user has to say which shop they are standing in.
  const [locations, setLocations] = useState<InventoryLocation[]>([])
  const [locationId, setLocationId] = useState('')
  // Stock on hand AT the chosen location: keyed by product id for the
  // product-level total AND by `productId::variantId` for each variant's own
  // balance, so a multi-variant product shows what EACH variant holds there.
  const [levels, setLevels] = useState<Record<string, number>>({})
  // Mirrors `levels` so the scan handler can read the current per-location
  // balance without taking it as a dependency — adding it would rebuild the
  // callback on every load and risk it closing over a stale map.
  const levelsRef = useRef<Record<string, number>>({})
  const [pushToShopify, setPushToShopify] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      dbApi.getInventoryLocations()
        .then((locs) => {
          if (cancelled || !locs.length) return
          setLocations(locs)
          // Default to the first location so the field is never blank and a
          // count can never be filed against the wrong shop by accident.
          setLocationId((prev) => prev || locs[0].id)
        })
        .catch(() => undefined)
    })
    return () => { cancelled = true }
  }, [])

  // Reload per-location balances when the counted location changes, so the
  // variance column reflects that location rather than the global total.
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!locationId) {
        setLevels({})
        levelsRef.current = {}
        return
      }
      dbApi.getStockLevels()
        .then((rows) => {
          if (cancelled) return
          const next: Record<string, number> = {}
          for (const r of rows) {
            if (r.locationId !== locationId) continue
            // The product's total at this location …
            next[r.productId] = (next[r.productId] ?? 0) + r.qty
            // … and each variant's own balance within it.
            if (r.variantId) {
              const key = `${r.productId}::${r.variantId}`
              next[key] = (next[key] ?? 0) + r.qty
            }
          }
          levelsRef.current = next
          setLevels(next)
        })
        .catch(() => {
          if (!cancelled) {
            setLevels({})
            levelsRef.current = {}
          }
        })
    })
    return () => { cancelled = true }
  }, [locationId])

  // The scan handler reads the current mode without taking it as a dependency
  // (a dependency would rebuild the callback on every toggle and let it close
  // over a stale sheet).
  const modeRef = useRef<'set' | 'adjust'>(mode)
  useEffect(() => { modeRef.current = mode }, [mode])

  // Switching modes changes what the number MEANS, so the sheet is re-based
  // with it: `set` shows what the ledger already holds (applying it unchanged
  // is a no-op), `adjust` shows 0 (the number is the delta).
  const changeMode = (next: 'set' | 'adjust') => {
    setMode(next)
    setItems((prev) => prev.map((x) => ({ ...x, counted: prefillCounted(next, levels[x.key] ?? x.systemStock) })))
  }

  const lookup = useCallback(async (rawCode: string) => {
    const c = rawCode.trim()
    if (!c) return
    setError('')
    try {
      const res = await dbApi.scanProduct(c)
      const p = res.data
      const add = (item: ScannedItem) => {
        setItems((prev) => {
          const existing = prev.find((x) => x.key === item.key)
          if (existing) {
            // Same row scanned again → increment its counted qty by 1
            return prev.map((x) => (x.key === item.key ? { ...x, counted: x.counted + 1 } : x))
          }
          return [...prev, item]
        })
      }
      const baselineOf = (key: string) => levelsRef.current[key] ?? null

      if (p.variantId) {
        // The scanned LABEL belonged to one variant: count exactly that one.
        add({
          key: `${p.id}::${p.variantId}`,
          id: p.id,
          variantId: p.variantId,
          variantTitle: p.variantTitle ?? null,
          name: p.name,
          sku: p.variantSku ?? p.sku,
          systemStock: baselineOf(`${p.id}::${p.variantId}`),
          counted: prefillCounted(modeRef.current, baselineOf(`${p.id}::${p.variantId}`)),
        })
      } else {
        const variantSet = await dbApi.getProductVariants(p.id).catch(() => null)
        const variants = variantSet?.variants ?? []
        if (variants.length > 1) {
          // A multi-variant product is counted ONE ROW PER VARIANT: a single
          // product-level number could never say which variant was physically
          // there, and the backend refuses to guess for it.
          for (const v of variants) {
            const key = `${p.id}::${v.id}`
            add({
              key,
              id: p.id,
              variantId: v.id,
              variantTitle: v.title ?? v.name ?? null,
              name: p.name,
              sku: v.sku,
              systemStock: baselineOf(key),
              counted: prefillCounted(modeRef.current, baselineOf(key)),
            })
          }
        } else {
          add({
            key: p.id,
            id: p.id,
            variantId: null,
            variantTitle: null,
            name: p.name,
            sku: p.sku,
            systemStock: baselineOf(p.id),
            counted: prefillCounted(modeRef.current, baselineOf(p.id)),
          })
        }
      }
      setCode('')
      inputRef.current?.focus()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lookup failed')
      setCode('')
      inputRef.current?.focus()
    }
  }, [])

  const submit = async () => {
    if (items.length === 0) return
    setSaving(true)
    setSavedMsg('')
    try {
      const res = await dbApi.applyStockCount(
        // Each row carries its own variant when it has one, so a multi-variant
        // sheet adjusts each variant's balance — never the product as a whole.
        items.map((x) => ({ id: x.id, counted: x.counted, ...(x.variantId ? { variantId: x.variantId } : {}) })),
        mode,
        pushToShopify,
        locationId,
      )
      const where = locations.find((l) => l.id === locationId)?.name ?? 'the selected location'
      let msg = `Applied ${res.applied} item(s) (${mode === 'set' ? 'set stock' : 'adjust stock'}) at ${where}.`
      if (res.shopifyPush) {
        msg += res.shopifyPush.ok
          ? ` Pushed ${res.shopifyPush.updated} stock level(s) to Shopify.`
          : ` Shopify push failed: ${res.shopifyPush.errors?.[0] ?? 'unknown error'}`
      }
      setSavedMsg(msg)
      setItems([])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Apply failed')
    } finally {
      setSaving(false)
    }
  }

  // Prefer the live per-location balance over the snapshot taken at scan time, so
  // switching the counted location re-bases every row already on the sheet.
  // Variant rows read THEIR balance (the key carries the variant), product rows
  // the product's total — which is exactly what the backend will act on.
  const baselineFor = (x: ScannedItem): number | null => levels[x.key] ?? x.systemStock
  const totalVariance = items.reduce((a, x) => {
    const base = baselineFor(x)
    return a + (base != null ? x.counted - base : 0)
  }, 0)

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Scan Stock Count"
        subtitle="Scan a product's QR label (or type its SKU) to count stock quickly, then apply."
        actions={
          <Button onClick={() => void submit()} disabled={saving || items.length === 0}>
            <Save className="h-4 w-4" />
            Apply Count ({items.length})
          </Button>
        }
      />

      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div>
              <Label htmlFor="scan-input">QR / SKU</Label>
              <div className="relative mt-1">
                <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="scan-input"
                  ref={inputRef}
                  className="pl-9 font-mono"
                  placeholder="Scan or type, press Enter…"
                  value={code}
                  autoComplete="off"
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void lookup(code)
                    }
                  }}
                />
              </div>
            </div>
            <div>
              <Label>Count at</Label>
              <Select
                className="mt-1"
                options={locations.map((l) => ({ value: l.id, label: formatLocationLabel(l) }))}
                value={locationId}
                onValueChange={setLocationId}
                placeholder="Select location"
              />
            </div>
            <div>
              <Label>Apply mode</Label>
              <div className="mt-1 flex gap-2">
                <Button size="sm" variant={mode === 'set' ? 'default' : 'outline'} onClick={() => changeMode('set')}>
                  Set stock
                </Button>
                <Button size="sm" variant={mode === 'adjust' ? 'default' : 'outline'} onClick={() => changeMode('adjust')}>
                  Adjust (+/−)
                </Button>
              </div>
            </div>
            <div>
              <Label>Shopify</Label>
              <label className="mt-1 flex h-9 cursor-pointer items-center gap-2 rounded-md border bg-card px-3 text-sm">
                <Switch checked={pushToShopify} onCheckedChange={setPushToShopify} />
                <CloudUpload className="h-3.5 w-3.5 text-muted-foreground" />
                Push to Shopify
              </label>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-950/30">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}
          {savedMsg && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 p-3 text-sm text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-950/30">
              <CheckCircle2 className="h-4 w-4" />
              {savedMsg}
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Variant</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead className="text-right">System stock</TableHead>
                  <TableHead className="text-right">Counted</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                      Nothing scanned yet — scan an item to begin.
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((x) => (
                    <TableRow key={x.key}>
                      <TableCell className="text-sm font-medium">{x.name}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {x.variantTitle ?? (x.variantId ? x.sku : '—')}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{x.sku}</TableCell>
                      <TableCell className="text-right text-sm">{baselineFor(x) ?? '—'}</TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          min={0}
                          className="ml-auto h-8 w-20 text-right font-mono"
                          value={x.counted}
                          onChange={(e) =>
                            setItems((prev) =>
                              prev.map((y) => (y.key === x.key ? { ...y, counted: Math.max(0, Number(e.target.value) || 0) } : y))
                            )
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        {baselineFor(x) == null ? (
                          <Badge variant="muted">—</Badge>
                        ) : x.counted === baselineFor(x) ? (
                          <Badge variant="success">OK</Badge>
                        ) : (
                          <Badge variant={x.counted > baselineFor(x)! ? 'info' : 'warning'}>
                            {x.counted > baselineFor(x)! ? '+' : ''}
                            {x.counted - baselineFor(x)!}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button size="sm" variant="ghost" onClick={() => setItems((prev) => prev.filter((y) => y.key !== x.key))}>
                          <Trash2 className="h-3.5 w-3.5 text-red-500 dark:text-red-400" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {items.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {items.length} item(s) · total variance{' '}
              <span className={totalVariance < 0 ? 'font-semibold text-red-600 dark:text-red-400' : totalVariance > 0 ? 'font-semibold text-emerald-600' : ''}>
                {totalVariance > 0 ? '+' : ''}
                {totalVariance}
              </span>{' '}
              pcs {mode === 'set' ? '(counted value replaces stock)' : '(counted value adds to stock)'}
            </p>
          )}
        </CardContent>
      </Card>

      <StockReconciliation />
    </div>
  )
}

/**
 * What the ledger cannot explain yet — reported, and changed only when a human
 * says so.
 *
 * `unattributed` balances can be attributed to one named variant (explicit
 * confirmation, one transaction, recorded in the activity log). Orphans —
 * balances whose product row is gone — are display-only here: they are
 * evidence, and nothing on this page can move, delete or re-attach them.
 */
function StockReconciliation() {
  const [data, setData] = useState<StockAnomalies | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    dbApi.getStockAnomalies()
      .then((next) => setData(next))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the reconciliation report'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { queueMicrotask(load) }, [load])

  const attribute = async (row: UnattributedBalance, variantId: string) => {
    setBusy(true)
    setMessage('')
    setError('')
    try {
      const res = await dbApi.attributeStockBalance({
        productId: row.productId,
        locationId: row.locationId,
        variantId,
        confirm: true,
      })
      setMessage(
        `${row.qty} pcs of ${row.productSku} at ${row.locationName ?? 'that location'} are now ${res.variantSku} — nothing was created, moved between locations or deleted.`,
      )
      setConfirming('')
      setChoice((prev) => {
        const next = { ...prev }
        delete next[`${row.productId}::${row.locationId}`]
        return next
      })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not attribute the balance')
      setConfirming('')
    } finally {
      setBusy(false)
    }
  }

  const totals = data?.totals
  const hasFindings =
    (data?.unattributed.length ?? 0) > 0 ||
    (data?.orphaned.length ?? 0) > 0 ||
    !(data?.consistency.ok ?? true)

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Stock reconciliation</p>
            <p className="text-xs text-muted-foreground">
              Every balance must be either attributed to a variant or openly unattributed:{' '}
              <span className="font-medium text-foreground">product stock = attributed + unattributed</span>. Nothing here
              changes stock on its own.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>

        {error ? (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-950/30 dark:text-red-400">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        ) : null}
        {message ? (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-950/40 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" /> {message}
          </div>
        ) : null}

        {loading && !data ? (
          <p className="text-sm text-muted-foreground">Loading reconciliation…</p>
        ) : !data ? null : (
          <>
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
              <div className="rounded-md border bg-card p-2.5">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Attributed</p>
                <p className="font-semibold tabular-nums text-foreground">{totals?.attributedUnits ?? 0}</p>
              </div>
              <div className="rounded-md border bg-card p-2.5">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Unattributed</p>
                <p className={`font-semibold tabular-nums ${totals && totals.unattributedUnits > 0 ? 'text-warning-600 dark:text-warning-500' : 'text-foreground'}`}>
                  {totals?.unattributedUnits ?? 0}
                </p>
              </div>
              <div className="rounded-md border bg-card p-2.5">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Product-level</p>
                <p className="font-semibold tabular-nums text-foreground">{totals?.productLevelUnits ?? 0}</p>
              </div>
              <div className="rounded-md border bg-card p-2.5">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Orphaned</p>
                <p className={`font-semibold tabular-nums ${totals && totals.orphanedUnits > 0 ? 'text-warning-600 dark:text-warning-500' : 'text-foreground'}`}>
                  {totals?.orphanedUnits ?? 0}
                </p>
              </div>
              <div className="rounded-md border bg-card p-2.5">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Ledger total</p>
                <p className="font-semibold tabular-nums text-foreground">{totals?.ledgerUnits ?? 0}</p>
              </div>
            </div>

            <div className={`rounded-lg border p-3 text-sm ${data.consistency.ok ? 'border-emerald-200 bg-emerald-50/60 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-400' : 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/40 dark:bg-red-950/30 dark:text-red-400'}`}>
              {data.consistency.ok ? (
                <p>Consistency check passed — every rollup and variant counter equals its own balances.</p>
              ) : (
                <div className="space-y-1">
                  <p className="font-medium">
                    {data.consistency.mismatches.length} balance(s) disagree with their counter:
                  </p>
                  {data.consistency.mismatches.map((m, i) => (
                    <p key={`${m.productId}-${m.variantId ?? 'rollup'}-${i}`} className="text-xs">
                      {m.variantSku ?? m.productSku ?? m.productId}: {m.kind === 'rollup' ? 'product stock' : 'variant counter'}{' '}
                      {m.kind === 'rollup' ? m.productStock : m.variantStock} vs ledger {m.ledgerTotal}
                      {m.note ? ` — ${m.note}` : ''}
                    </p>
                  ))}
                </div>
              )}
              {data.consistency.preLedger > 0 ? (
                <p className="mt-1 text-xs opacity-80">
                  {data.consistency.preLedger} product(s) still hold stock the ledger has not recorded yet — their first
                  movement (or the next boot) materialises it.
                </p>
              ) : null}
            </div>

            {data.unattributed.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Unattributed balances — attribute one only when a count proves which variant holds it
                </p>
                {data.unattributed.map((row) => {
                  const id = `${row.productId}::${row.locationId}`
                  const variantId = choice[id] ?? ''
                  const open = confirming === id
                  return (
                    <div key={id} className="rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium text-foreground">
                            {row.productName}{' '}
                            <span className="font-mono text-xs text-muted-foreground">({row.productSku})</span>
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {row.locationName ?? row.locationId} ·{' '}
                            <span className="font-semibold">{row.qty} pcs</span> unattributed · {row.variants.length}{' '}
                            variant{row.variants.length === 1 ? '' : 's'}
                            {row.variants.length > 0 ? ` (${row.variants.map((v) => `${v.title} ${v.stock}`).join(', ')})` : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Select
                            options={[
                              { value: '', label: 'Choose variant…' },
                              ...row.variants.map((v) => ({ value: v.id, label: `${v.title} · ${v.sku}` })),
                            ]}
                            value={variantId}
                            onValueChange={(v) => {
                              setChoice((prev) => ({ ...prev, [id]: v }))
                              setConfirming('')
                            }}
                            placeholder="Choose variant…"
                            className="w-[220px]"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!variantId || busy}
                            onClick={() => setConfirming(open ? '' : id)}
                          >
                            Attribute…
                          </Button>
                        </div>
                      </div>
                      {open && variantId ? (
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning-200 bg-warning-50 p-2.5 text-xs dark:border-warning-500/40 dark:bg-warning-500/10">
                          <p className="text-warning-700 dark:text-warning-500">
                            Move all {row.qty} pcs at {row.locationName ?? row.locationId} to{' '}
                            <span className="font-semibold">
                              {row.variants.find((v) => v.id === variantId)?.title} (
                              {row.variants.find((v) => v.id === variantId)?.sku})
                            </span>
                            ? Nothing is created, split or deleted — the balance only becomes that variant&apos;s, and the
                            action is recorded in the activity log.
                          </p>
                          <div className="flex gap-2">
                            <Button size="sm" variant="ghost" onClick={() => setConfirming('')} disabled={busy}>
                              Cancel
                            </Button>
                            <Button size="sm" onClick={() => void attribute(row, variantId)} disabled={busy}>
                              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Confirm attribution
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ) : null}

            {data.orphaned.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Orphaned balances — reported only, never modified here
                </p>
                {data.orphaned.map((row, i) => (
                  <div
                    key={`${row.productId}-${row.locationId}-${i}`}
                    className="rounded-lg border border-dashed p-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-mono text-xs text-muted-foreground">{row.productId}</p>
                        <p className="text-xs text-muted-foreground">
                          {row.locationName ?? row.locationId} ·{' '}
                          <span className="font-semibold">{row.qty} pcs</span> · {row.movements} ledger movement
                          {row.movements === 1 ? '' : 's'} still reference it
                        </p>
                      </div>
                      <Badge variant="muted">No product row</Badge>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">{row.note}</p>
                  </div>
                ))}
              </div>
            ) : null}

            {!hasFindings ? (
              <p className="text-sm text-muted-foreground">Nothing to reconcile — every balance is accounted for.</p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}
