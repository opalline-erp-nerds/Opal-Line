import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Printer,
  Tag,
  QrCode,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Search,
  FileDown,
  Eye,
  Settings2,
  SlidersHorizontal,
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Select } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/confirm'
import { dbApi, backupApi, shopifyApi } from '@/lib/api'
import { mergeShopifyProducts } from '@/lib/mergeShopifyProducts'
import {
  buildLabelSheet,
  computeGrid,
  configFromPreset,
  expandLabels,
  LABEL_PRESETS,
  MM_TO_PX,
  PAGE_SIZES,
  clamp,
  tagStem,
  type LabelConfig,
  type LabelProduct,
} from '@/lib/labelSheet'
import {
  FALLBACK_LABEL_PRESETS,
  validateReferenceLabelPresets,
  type LabelPreset,
} from '@/lib/labelPresets'
import {
  choosePrintMode,
  exportHtmlPdf,
  openHtmlPreview,
  printHtmlToPrinter,
} from '@/lib/printTemplate'
import type { Product } from '@/types'
import type { SyncProduct } from '@/types/shopify'

const CONFIG_STORAGE_KEY = 'opal-line.barcodeLabelConfig'

function loadConfig(): LabelConfig {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LabelConfig>
      if (parsed && typeof parsed === 'object' && typeof parsed.widthMm === 'number') {
        const base = configFromPreset(parsed.presetKey ?? 'jewellery-tag-55x20')
        return { ...base, ...parsed, labelType: parsed.labelType ?? base.labelType }
      }
    }
  } catch {
    // fall through to defaults
  }
  return configFromPreset('jewellery-tag-55x20')
}

function toLabelProduct(p: Product): LabelProduct {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku,
    price: p.sellingPrice ?? 0,
    weight: p.netWeight || undefined,
    purity: p.purity,
    category: p.category,
    huid: p.huid || undefined,
  }
}

interface NumberFieldProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  onChange: (value: number) => void
}

function NumberField({ label, value, min, max, step = 0.5, suffix = 'mm', onChange }: NumberFieldProps) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="relative mt-1">
        <Input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          className="h-8 pr-8 text-sm"
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            if (!Number.isNaN(v)) onChange(v)
          }}
          onBlur={(e) => {
            const v = parseFloat(e.target.value)
            onChange(Number.isNaN(v) ? min : clamp(v, min, max))
          }}
        />
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
          {suffix}
        </span>
      </div>
    </div>
  )
}

function ToggleRow({
  label,
  icon,
  checked,
  onCheckedChange,
}: {
  label: string
  icon?: ReactNode
  checked: boolean
  onCheckedChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-2 text-sm text-foreground">
        {icon}
        {label}
      </span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

export default function BarcodeLabelsPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [duplicates, setDuplicates] = useState<Set<string>>(new Set())
  const [printMode, setPrintMode] = useState<'sheet' | 'label'>('label')
  const [cfg, setCfg] = useState<LabelConfig>(loadConfig)
  const [, setPresets] = useState<LabelPreset[]>(FALLBACK_LABEL_PRESETS)
  const [generating, setGenerating] = useState(false)

  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [stockFilter, setStockFilter] = useState('all')

  const previewRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [fitScale, setFitScale] = useState(1)
  const [previewIndex, setPreviewIndex] = useState(0)
  const [searchParams] = useSearchParams()

  useEffect(() => {
    let active = true
    Promise.all([
      Promise.all([
        dbApi.getProducts().catch((error: unknown) => {
          if (active) {
            const message = error instanceof Error ? error.message : 'Could not load products'
            toast.error(message)
          }
          return [] as Product[]
        }),
        shopifyApi.getProducts().then((r) => r.data).catch(() => [] as SyncProduct[]),
      ]).then(([local, shopify]) => {
        if (!active) return
        const data = mergeShopifyProducts(local, shopify)
        setProducts(data)
        const idsParam = (searchParams.get('ids') ?? '').split(',').map((x) => x.trim()).filter(Boolean)
        if (idsParam.length > 0) {
          const available = new Set(data.map((p) => p.id))
          setSelected(new Set(idsParam.filter((id) => available.has(id))))
        }
      }),
      dbApi.getProductDuplicates().then((r) => {
        if (active) setDuplicates(new Set(r.data.map((d) => d.sku.toLowerCase())))
      }).catch((error: unknown) => {
        if (active) toast.error(error instanceof Error ? error.message : 'Could not load duplicate SKU status')
      }),
      backupApi.getLabelPresets().then((list) => {
        if (!Array.isArray(list) || !validateReferenceLabelPresets(list, FALLBACK_LABEL_PRESETS)) {
          throw new Error('The server did not return complete geometry for all six reference templates')
        }
        if (active) {
          setPresets(list)
        }
      }).catch(() => {
        if (active) {
          setPresets(FALLBACK_LABEL_PRESETS)
        }
      }),
      dbApi.getSettings().then((s) => {
        if (active && s?.businessName) setCfg((prev) => ({ ...prev, companyName: prev.companyName || s.businessName }))
      }).catch(() => undefined),
    ]).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [searchParams])

  useEffect(() => {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(cfg))
  }, [cfg])

  const patch = useCallback((partial: Partial<LabelConfig>) => {
    setCfg((prev) => ({ ...prev, ...partial }))
  }, [])

  const patchSize = useCallback((partial: Partial<LabelConfig>) => {
    setCfg((prev) => ({ ...prev, ...partial, presetKey: 'custom' }))
  }, [])

  const applyPreset = useCallback((key: string) => {
    if (key === 'custom') {
      setCfg((prev) => ({ ...prev, presetKey: 'custom' }))
      return
    }
    const next = configFromPreset(key)
    setCfg((prev) => ({
      ...prev,
      presetKey: next.presetKey,
      widthMm: next.widthMm,
      heightMm: next.heightMm,
      marginMm: next.marginMm,
      gapMm: next.gapMm,
      labelType: next.labelType,
    }))
  }, [])

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const p of products) if (p.category) set.add(p.category)
    return [...set].sort()
  }, [products])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return products.filter((p) => {
      if (q && !(`${p.name} ${p.sku}`.toLowerCase().includes(q))) return false
      if (category !== 'all' && p.category !== category) return false
      if (stockFilter === 'in' && !(p.stock > 0)) return false
      if (stockFilter === 'out' && p.stock !== 0) return false
      if (stockFilter === 'low' && !(p.stock > 0 && p.stock <= (p.reorderLevel || 0))) return false
      return true
    })
  }, [products, search, category, stockFilter])

  const labelProducts = useMemo(() => {
    const source = selected.size > 0 ? products.filter((p) => selected.has(p.id)) : filtered
    return source.map(toLabelProduct)
  }, [products, filtered, selected])

  const grid = useMemo(() => computeGrid(cfg), [cfg])
  const expandedCount = useMemo(() => expandLabels(labelProducts, cfg).length, [labelProducts, cfg])

  const isTagLabel = cfg.labelType === 'tag'
  // The preview frame is sized from the SAME derivation the sheet/printer
  // HTML uses (labelCellSize), so the iframe can never contradict the paper.
  const stem = tagStem(cfg)
  const previewWidthMm = stem ? stem.overallW : cfg.widthMm
  const previewHeightMm = stem ? stem.overallH : cfg.heightMm
  const pageSize = { widthMm: previewWidthMm, heightMm: previewHeightMm, label: 'Label' }

  const safePreviewIndex = labelProducts.length === 0 ? 0 : Math.min(previewIndex, labelProducts.length - 1)
  const previewProduct = labelProducts.length > 0 ? labelProducts[safePreviewIndex] : null

  useEffect(() => {
    const el = previewRef.current
    if (!el || !previewProduct) return
    const update = () => {
      const availableW = el.clientWidth - 8
      const availableH = el.clientHeight - 8
      const naturalW = pageSize.widthMm * MM_TO_PX
      const naturalH = pageSize.heightMm * MM_TO_PX
      const s = Math.min(availableW / naturalW, availableH / naturalH)
      setFitScale(clamp(s, 0.1, 4))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [pageSize.widthMm, pageSize.heightMm, previewProduct, loading])

  const previewHtml = useMemo(() => {
    if (!previewProduct) return ''
    return buildLabelSheet([previewProduct], cfg, { mode: 'preview', paper: 'label' }).html
  }, [previewProduct, cfg])

  const scale = fitScale * zoom
  const pageWidthPx = pageSize.widthMm * MM_TO_PX
  const pageHeightPx = pageSize.heightMm * MM_TO_PX
  const scaledWidth = pageWidthPx * scale
  const scaledHeight = pageHeightPx * scale

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAllFiltered = () => {
    const allIds = filtered.map((p) => p.id)
    const everySelected = allIds.length > 0 && allIds.every((id) => selected.has(id))
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of allIds) {
        if (everySelected) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  const testPrint = () => {
    if (expandedCount === 0) {
      toast.info('No labels to print')
      return
    }
    const { html } = buildLabelSheet(labelProducts, cfg, { mode: 'print', paper: printMode })
    void openHtmlPreview(html, 'Test Print')
  }

  const downloadPdf = () => {
    if (expandedCount === 0) {
      toast.info('No labels to download')
      return
    }
    const { html } = buildLabelSheet(labelProducts, cfg, { mode: 'print', paper: printMode })
    void exportHtmlPdf(html, 'product-labels').then((res) => {
      if (!res.ok && !res.cancelled) toast.error(res.error || 'PDF export failed')
      else if (res.ok) toast.success('Labels saved as PDF')
    })
  }

  const printLabels = () => {
    if (expandedCount === 0) {
      toast.info('No labels to print')
      return
    }
    if (grid.overflow) {
      toast.error('Label size does not fit the page ... reduce size or margins')
      return
    }
    setGenerating(true)
    const pick = choosePrintMode()
    const sheet = buildLabelSheet(labelProducts, cfg, { mode: 'print', paper: printMode })
    void (async () => {
      try {
        const mode = await pick
        if (mode === 'cancel') return
        if (mode === 'pdf') {
          const res = await exportHtmlPdf(sheet.html, 'product-labels')
          if (!res.ok && !res.cancelled) toast.error(res.error || 'PDF export failed')
          else if (res.ok) toast.success('Labels saved as PDF')
          return
        }
        await printHtmlToPrinter(sheet.html, 'Product Labels', mode)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Printing failed')
      } finally {
        setGenerating(false)
      }
    })()
  }

  const setPrinterMode = (mode: 'thermal' | 'jewellery' | 'sheet') => {
    if (mode === 'thermal') {
      setPrintMode('label')
      patch({ labelType: 'label' })
    } else if (mode === 'jewellery') {
      setPrintMode('label')
      patch({ labelType: 'tag' })
    } else {
      setPrintMode('sheet')
    }
  }

  const activePrinterMode =
    printMode === 'sheet' ? 'sheet' : cfg.labelType === 'tag' ? 'jewellery' : 'thermal'

  if (loading) {
    return (
      <div className="flex h-full flex-col gap-4 p-4 lg:p-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid flex-1 grid-cols-3 gap-4">
          <Skeleton className="h-full" />
          <Skeleton className="h-full" />
          <Skeleton className="h-full" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4 lg:p-6">
      <div className="flex shrink-0 items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary-50 text-primary-700 ring-1 ring-primary-100 dark:bg-primary-50/60 dark:text-primary-300">
            <Tag className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">QR & Barcode Labels</h1>
            <p className="text-sm text-muted-foreground">Design, preview and print labels at true physical size from your product catalog</p>
          </div>
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-1 gap-3 md:grid-cols-3">
        {[
          { key: 'thermal', title: 'Thermal Label', desc: 'Direct thermal / label printer', icon: Printer },
          { key: 'jewellery', title: 'Jewellery Tag', desc: 'Tag-style jewellery labels', icon: Tag },
          { key: 'sheet', title: 'A4 Sheet', desc: 'A4 / Letter sheet printing', icon: FileText },
        ].map((m) => {
          const active = activePrinterMode === m.key
          const Icon = m.icon
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => setPrinterMode(m.key as 'thermal' | 'jewellery' | 'sheet')}
              className={`flex items-center gap-3 rounded-xl border p-4 text-left transition-all ${
                active
                  ? 'border-primary bg-primary-50 shadow-sm ring-1 ring-primary/30 dark:bg-primary-50/60'
                  : 'border-border bg-card hover:border-primary/40 hover:bg-muted/40'
              }`}
            >
              <div
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                  active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                }`}
              >
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{m.title}</p>
                <p className="truncate text-xs text-muted-foreground">{m.desc}</p>
              </div>
            </button>
          )
        })}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)_360px]">
        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Settings2 className="h-4 w-4" /> Label Settings
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Preset</label>
                <Select
                  className="mt-1"
                  options={LABEL_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
                  value={cfg.presetKey}
                  onValueChange={applyPreset}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Label type</label>
                <Select
                  className="mt-1"
                  options={[
                    { value: 'label', label: 'Normal label' },
                    { value: 'tag', label: 'Jewellery tag' },
                  ]}
                  value={cfg.labelType}
                  onValueChange={(v) => patch({ labelType: v as 'label' | 'tag' })}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <NumberField label="Width" value={cfg.widthMm} min={10} max={120} onChange={(v) => patchSize({ widthMm: v })} />
                <NumberField label="Height" value={cfg.heightMm} min={6} max={120} onChange={(v) => patchSize({ heightMm: v })} />
                <NumberField label="Page margin" value={cfg.marginMm} min={0} max={40} onChange={(v) => patchSize({ marginMm: v })} />
                <NumberField label="Gap" value={cfg.gapMm} min={0} max={20} onChange={(v) => patchSize({ gapMm: v })} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Paper</label>
                  <Select
                    className="mt-1"
                    options={Object.entries(PAGE_SIZES).map(([key, v]) => ({ value: key, label: v.label }))}
                    value={cfg.page}
                    onValueChange={(v) => patchSize({ page: v as LabelConfig['page'] })}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Copies / product</label>
                  <Input
                    type="number"
                    className="mt-1 h-9 text-sm"
                    min={1}
                    max={99}
                    value={cfg.copies}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10)
                      if (!Number.isNaN(v)) patch({ copies: clamp(v, 1, 99) })
                    }}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">Text size</label>
                  <span className="text-xs text-muted-foreground">{Math.round(cfg.fontScale * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0.7}
                  max={1.5}
                  step={0.05}
                  value={cfg.fontScale}
                  onChange={(e) => patch({ fontScale: parseFloat(e.target.value) })}
                  className="mt-2 w-full accent-[var(--primary)]"
                />
              </div>

              <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground space-y-1">
                <div className="flex justify-between">
                  <span>Grid</span>
                  <span className="font-medium text-foreground">{grid.columns} x {grid.rows} / page</span>
                </div>
                <div className="flex justify-between">
                  <span>Labels / page</span>
                  <span className="font-medium text-foreground">{grid.labelsPerPage}</span>
                </div>
                <div className="flex justify-between">
                  <span>Label size</span>
                  <span className="font-medium text-foreground">{cfg.widthMm} x {cfg.heightMm} mm</span>
                </div>
              </div>

              {grid.overflow && (
                <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Label + margins exceed the page ... reduce size or margins.
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <SlidersHorizontal className="h-4 w-4" /> Label Content
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <ToggleRow label="Product name" checked={cfg.showName} onCheckedChange={(v) => patch({ showName: v })} />
              <ToggleRow label="SKU" checked={cfg.showSku} onCheckedChange={(v) => patch({ showSku: v })} />
              <ToggleRow label="Price" checked={cfg.showPrice} onCheckedChange={(v) => patch({ showPrice: v })} />
              <ToggleRow label="Net weight" checked={cfg.showWeight} onCheckedChange={(v) => patch({ showWeight: v })} />
              <ToggleRow label="HUID" checked={cfg.showHuid} onCheckedChange={(v) => patch({ showHuid: v })} />
              <ToggleRow label="Category" checked={cfg.showCategory} onCheckedChange={(v) => patch({ showCategory: v })} />
              <ToggleRow
                label="QR code (encodes the SKU)"
                icon={<QrCode className="h-3.5 w-3.5 text-muted-foreground" />}
                checked={cfg.showQr}
                onCheckedChange={(v) => patch({ showQr: v })}
              />
              <ToggleRow label="Border" checked={cfg.showBorder} onCheckedChange={(v) => patch({ showBorder: v })} />
              <ToggleRow label="Company name" checked={cfg.showCompany} onCheckedChange={(v) => patch({ showCompany: v })} />
              {cfg.showCompany && (
                <Input
                  value={cfg.companyName}
                  onChange={(e) => patch({ companyName: e.target.value })}
                  placeholder="Company name"
                  className="h-8 text-sm"
                />
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="flex min-h-0 flex-col">
          <CardHeader className="flex-row items-center justify-between space-y-0 border-b">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Eye className="h-4 w-4" /> Preview
              </CardTitle>
              <p className="text-xs text-muted-foreground">{cfg.widthMm} x {cfg.heightMm} mm</p>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="Previous product"
                disabled={labelProducts.length <= 1 || safePreviewIndex <= 0}
                onClick={() => setPreviewIndex((i) => Math.max(0, i - 1))}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="w-12 text-center text-xs text-muted-foreground">
                {labelProducts.length > 0 ? `${safePreviewIndex + 1}/${labelProducts.length}` : '0/0'}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="Next product"
                disabled={labelProducts.length <= 1 || safePreviewIndex >= labelProducts.length - 1}
                onClick={() => setPreviewIndex((i) => Math.min(labelProducts.length - 1, i + 1))}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
              <div className="mx-1 h-4 w-px bg-border" />
              <Button variant="ghost" size="icon" className="h-7 w-7" title="Zoom out" onClick={() => setZoom((z) => clamp(z - 0.15, 0.3, 3))}>
                <ZoomOut className="h-3.5 w-3.5" />
              </Button>
              <span className="w-11 text-center text-xs text-muted-foreground">{Math.round(scale * 100)}%</span>
              <Button variant="ghost" size="icon" className="h-7 w-7" title="Zoom in" onClick={() => setZoom((z) => clamp(z + 0.15, 0.3, 3))}>
                <ZoomIn className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" title="Fit" onClick={() => setZoom(1)}>
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col p-0">
            <div
              ref={previewRef}
              className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-background p-2"
            >
              {previewProduct ? (
                <div
                  style={{
                    width: scaledWidth,
                    height: scaledHeight,
                  }}
                >
                  <iframe
                    title="Label preview"
                    // Remount on every content change: guarantees the iframe
                    // never keeps showing a stale document, no matter how the
                    // browser handles srcdoc re-navigation.
                    key={previewHtml}
                    srcDoc={previewHtml}
                    scrolling="no"
                    style={{
                      width: pageWidthPx,
                      height: pageHeightPx,
                      transform: `scale(${scale})`,
                      transformOrigin: 'top left',
                      border: 'none',
                      background: 'transparent',
                      display: 'block',
                    }}
                  />
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Tag className="h-8 w-8 opacity-40" />
                  <p>No products match the current filters.</p>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
              <span className="truncate">
                {previewProduct ? (
                  <>
                    <span className="font-medium text-foreground">{previewProduct.name}</span>
                    <span className="ml-2">{previewProduct.sku}</span>
                  </>
                ) : (
                  'No product selected'
                )}
              </span>
              <span>
                Body: {cfg.widthMm} x {cfg.heightMm} mm
                {isTagLabel ? ` · Overall: ${previewWidthMm} x ${previewHeightMm} mm` : ''}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="flex min-h-0 flex-col">
          <CardHeader className="space-y-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Products</CardTitle>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {selected.size > 0 ? `${selected.size} selected` : `${filtered.length} shown`}
                </span>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={selectAllFiltered}>
                  {filtered.length > 0 && filtered.every((p) => selected.has(p.id)) ? 'Deselect all' : 'Select shown'}
                </Button>
              </div>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or SKU..."
                className="h-8 pl-8 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Select
                options={[
                  { value: 'all', label: 'All categories' },
                  ...categories.map((c) => ({ value: c, label: c })),
                ]}
                value={category}
                onValueChange={setCategory}
                className="h-8 text-sm"
              />
              <Select
                options={[
                  { value: 'all', label: 'Any stock' },
                  { value: 'in', label: 'In stock' },
                  { value: 'low', label: 'Low stock' },
                  { value: 'out', label: 'Out of stock' },
                ]}
                value={stockFilter}
                onValueChange={setStockFilter}
                className="h-8 text-sm"
              />
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto p-0">
            {filtered.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">No products found.</div>
            ) : (
              <div className="divide-y divide-border">
                {filtered.map((product) => {
                  const isSelected = selected.has(product.id)
                  return (
                    <div
                      key={product.id}
                      className={`flex cursor-pointer items-center gap-3 border-l-2 px-4 py-2.5 transition-colors hover:bg-muted/50 ${
                        isSelected ? 'border-primary bg-primary-100 font-medium text-primary-900 dark:bg-primary-500/30 dark:text-primary-100' : 'border-transparent'
                      }`}
                      onClick={() => toggleSelect(product.id)}
                    >
                      <div
                        className={`flex shrink-0 items-center justify-center rounded border transition-colors ${
                          isSelected ? 'border-primary bg-primary text-primary-foreground shadow-sm ring-1 ring-primary/30' : 'border-border bg-background text-transparent'
                        }`}
                        style={{ width: 20, height: 20 }}
                      >
                        {isSelected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{product.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {product.sku}
                          {product.sku && duplicates.has(product.sku.toLowerCase()) && (
                            <Badge variant="warning" className="ml-1.5 text-[10px]">
                              Dup SKU
                            </Badge>
                          )}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-semibold text-primary-700">
                          ?{(product.sellingPrice ?? 0).toLocaleString('en-IN')}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {product.netWeight ? `${product.netWeight}g` : ''}
                          {product.stock !== undefined ? ` ... ${product.stock} pcs` : ''}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex shrink-0 flex-col gap-3 rounded-xl border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{labelProducts.length}</span> product
          {labelProducts.length === 1 ? '' : 's'} ·{' '}
          <span className="font-medium text-foreground">{cfg.copies}</span> cop
          {cfg.copies === 1 ? 'y' : 'ies'} / product ·{' '}
          <span className="font-medium text-foreground">{expandedCount}</span> label
          {expandedCount === 1 ? '' : 's'} total
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={testPrint} disabled={expandedCount === 0}>
            <Printer className="h-4 w-4" />
            Test Print
          </Button>
          <Button variant="outline" onClick={downloadPdf} disabled={expandedCount === 0}>
            <FileDown className="h-4 w-4" />
            Export PDF
          </Button>
          <Button onClick={printLabels} disabled={generating || expandedCount === 0}>
            <Printer className="h-4 w-4" />
            {generating ? 'Preparing...' : `Print Selected (${expandedCount})`}
          </Button>
        </div>
      </div>
    </div>
  )
}
