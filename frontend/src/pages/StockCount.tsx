import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, ScanLine, Save, Trash2, AlertCircle, CloudUpload } from 'lucide-react'
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
import type { InventoryLocation } from '@/types'
import { Switch } from '@/components/ui/switch'

interface ScannedItem {
  id: string
  name: string
  sku: string
  systemStock: number | null
  counted: number
}

export default function StockCountPage() {
  const [items, setItems] = useState<ScannedItem[]>([])
  const [code, setCode] = useState('')
  const [mode, setMode] = useState<'set' | 'adjust'>('set')
  // A count is taken at ONE location. The backend adjusts that location's
  // balance, so the user has to say which shop they are standing in.
  const [locations, setLocations] = useState<InventoryLocation[]>([])
  const [locationId, setLocationId] = useState('')
  // Stock on hand AT the chosen location, used for the variance column so the
  // number shown matches the number the backend will act on.
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
        return
      }
      dbApi.getStockLevels()
        .then((rows) => {
          if (cancelled) return
          const next = Object.fromEntries(rows.filter((r) => r.locationId === locationId).map((r) => [r.productId, r.qty]))
          levelsRef.current = next
          setLevels(next)
        })
        .catch(() => { if (!cancelled) setLevels({}) })
    })
    return () => { cancelled = true }
  }, [locationId])

  const lookup = useCallback(async (rawCode: string) => {
    const c = rawCode.trim()
    if (!c) return
    setError('')
    try {
      const res = await dbApi.scanProduct(c)
      const p = res.data
      setItems((prev) => {
        const existing = prev.find((x) => x.id === p.id)
        if (existing) {
          // Same item scanned again → increment counted qty by 1
          return prev.map((x) => (x.id === p.id ? { ...x, counted: x.counted + 1 } : x))
        }
        return [
          ...prev,
          {
            id: p.id,
            name: p.name,
            sku: p.sku,
            systemStock: levelsRef.current[p.id] ?? p.stock,
            counted: 1,
          },
        ]
      })
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
        items.map((x) => ({ id: x.id, counted: x.counted })),
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
  const baselineFor = (x: ScannedItem): number | null => levels[x.id] ?? x.systemStock
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
                options={locations.map((l) => ({ value: l.id, label: l.name }))}
                value={locationId}
                onValueChange={setLocationId}
                placeholder="Select location"
              />
            </div>
            <div>
              <Label>Apply mode</Label>
              <div className="mt-1 flex gap-2">
                <Button size="sm" variant={mode === 'set' ? 'default' : 'outline'} onClick={() => setMode('set')}>
                  Set stock
                </Button>
                <Button size="sm" variant={mode === 'adjust' ? 'default' : 'outline'} onClick={() => setMode('adjust')}>
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
                    <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                      Nothing scanned yet — scan an item to begin.
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((x) => (
                    <TableRow key={x.id}>
                      <TableCell className="text-sm font-medium">{x.name}</TableCell>
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
                              prev.map((y) => (y.id === x.id ? { ...y, counted: Math.max(0, Number(e.target.value) || 0) } : y))
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
                        <Button size="sm" variant="ghost" onClick={() => setItems((prev) => prev.filter((y) => y.id !== x.id))}>
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
    </div>
  )
}
