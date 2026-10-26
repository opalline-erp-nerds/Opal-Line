import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, Download, Printer, RotateCcw, Save, Search, Trash2, Upload } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/components/ui/confirm'
import { dbApi, printTemplatesApi, shopifyApi } from '@/lib/api'
import { mergeShopifyProducts } from '@/lib/mergeShopifyProducts'
import type { Product } from '@/types'
import type { SyncProduct } from '@/types/shopify'
import {
  DEFAULT_PRINT_CONFIG,
  LABEL_PRESETS,
  buildPrintHtml,
  mergePrintConfig,
  openHtmlPreview,
  resolveLabelSize,
  type PrintDesignerConfig,
  type PrintDoc,
  type PrintDocExtras,
} from '@/lib/printTemplate'

const DOC_TYPES = ['invoice', 'quotation', 'order', 'packing-slip', 'pick-list', 'barcode-label'] as const
type DocType = (typeof DOC_TYPES)[number]

const TAGLINES: Record<DocType, string> = {
  invoice: '92.5 Sterling Silver Jewellery',
  quotation: '92.5 Sterling Silver Jewellery',
  order: '92.5 Sterling Silver Jewellery',
  'packing-slip': '92.5 Sterling Silver Jewellery',
  'pick-list': '92.5 Sterling Silver Jewellery',
  'barcode-label': '92.5 Sterling Silver Jewellery',
}

function ToggleRow({ title, description, checked, onCheckedChange }: { title: string; description: string; checked: boolean; onCheckedChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-2.5">
      <div>
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="pt-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{children}</p>
}

export default function PrintDesignerPage() {
  const [docType, setDocType] = useState<DocType>('invoice')
  const [config, setConfig] = useState<PrintDesignerConfig>(DEFAULT_PRINT_CONFIG)
  const [designName, setDesignName] = useState('My design')
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [savedList, setSavedList] = useState<Array<{ id: string; name: string; isDefault: boolean }>>([])
  const [sample, setSample] = useState<PrintDoc | null>(null)
  const [saving, setSaving] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // ── Product-label editing state ─────────────────────────────────────
  // The designer edits a working copy of the label's data (company, product,
  // SKU, rate). "Fetch from ERP" fills it from a real product.
  const [labelEdit, setLabelEdit] = useState({
    companyName: 'OPAL LINE JEWELS LLP',
    productName: '92.5 Sterling Silver Pendant',
    sku: 'SL-PD-001',
    rate: 3250,
    weight: 2.8,
  })
  const [products, setProducts] = useState<Product[]>([])
  const [productQuery, setProductQuery] = useState('')
  const [showProductPicker, setShowProductPicker] = useState(false)
  const isLabel = docType === 'barcode-label'

  useEffect(() => {
    printTemplatesApi.getSample(docType).then((r) => setSample(r.doc as unknown as PrintDoc)).catch(() => {})
    printTemplatesApi.getDefault(docType).then((r) => {
      setConfig(mergePrintConfig(r.config))
      setCurrentId(r.id)
      if (r.name) setDesignName(r.name)
    }).catch(() => {})
    printTemplatesApi.list(docType).then((r) => {
      setSavedList(r.templates.map((t) => ({ id: t.id, name: t.name, isDefault: t.isDefault })))
    }).catch(() => {})
  }, [docType])

  // Load the ERP catalogue once the product-label tab is opened so the
  // product picker can fill real SKU/rate data. Live Shopify products
  // are merged in (and a Shopify failure is ignored) so the picker also shows
  // store products that have not been synced into the local DB yet.
  useEffect(() => {
    if (!isLabel || products.length > 0) return
    let active = true
    Promise.all([
      dbApi.getProducts().catch(() => [] as Product[]),
      shopifyApi.getProducts().then((r) => r.data).catch(() => [] as SyncProduct[]),
    ]).then(([local, shopify]) => {
      if (active) setProducts(mergeShopifyProducts(local, shopify))
    })
    return () => { active = false }
  }, [isLabel, products.length])

  const set = <K extends keyof PrintDesignerConfig>(key: K, value: PrintDesignerConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }))

  const setMargin = (key: keyof PrintDesignerConfig['margins'], value: number) =>
    setConfig((c) => ({ ...c, margins: { ...c.margins, [key]: value } }))

  const applyProduct = (p: Product) => {
    setLabelEdit({
      companyName: labelEdit.companyName,
      productName: p.name,
      sku: p.sku,
      rate: Number(p.sellingPrice) || 0,
      weight: Number(p.netWeight) || 0,
    })
    setShowProductPicker(false)
    setProductQuery('')
    toast.info(`Loaded ${p.name} from inventory`)
  }

  const filteredProducts = useMemo(() => {
    const q = productQuery.trim().toLowerCase()
    const list = q
      ? products.filter((p) =>
          p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q),
        )
      : products
    return list.slice(0, 40)
  }, [products, productQuery])

  const readImage = (file: File, maxKb: number, apply: (dataUrl: string) => void) => {
    if (file.size > maxKb * 1024) {
      toast.error(`${file.name} must be under ${maxKb} KB`)
      return
    }
    const reader = new FileReader()
    reader.onload = () => apply(String(reader.result))
    reader.readAsDataURL(file)
  }

  const html = useMemo(() => {
    if (isLabel) {
      // Product labels build from the editable working copy — live as the
      // user types SKU / rate / names.
      const labelDoc: PrintDoc = {
        number: 'SO-2026-00789',
        customer: 'Retail Customer',
        businessName: labelEdit.companyName,
        gst: 3,
        gstAmount: 0,
        discount: 0,
        subtotal: 0,
        grandTotal: 0,
        date: new Date().toISOString(),
        items: [
          {
            product: labelEdit.productName,
            sku: labelEdit.sku,
            sellingPrice: labelEdit.rate,
            rate: labelEdit.rate,
            weight: labelEdit.weight,
          },
        ],
      }
      const extras: PrintDocExtras = { docType, tagline: TAGLINES[docType] }
      return buildPrintHtml(labelDoc, config, extras)
    }
    if (!sample) return null
    const extras: PrintDocExtras = {
      docType,
      tagline: TAGLINES[docType],
      extraBox:
        docType === 'quotation' && 'validUntil' in sample
          ? { label: 'Valid Until', value: new Date(String(sample.validUntil)).toLocaleDateString('en-IN') }
          : undefined,
      notes: 'notes' in sample && typeof sample.notes === 'string' ? sample.notes : undefined,
    }
    return buildPrintHtml(sample, config, extras)
  }, [sample, config, docType, isLabel, labelEdit])

  // Live preview: write the built HTML into a sandboxed iframe on every change.
  useEffect(() => {
    const frame = iframeRef.current
    if (!frame || html === null) return
    frame.srcdoc = html
  }, [html])

  const openPreviewWindow = () => {
    if (!html) return
    // Desktop: a real window via IPC (window.open is denied there);
    // browser: the old popup. No printing — this is a preview.
    void openHtmlPreview(html, `Print preview — ${docType}`)
  }

  const refreshList = () => {
    printTemplatesApi.list(docType).then((r) => {
      setSavedList(r.templates.map((t) => ({ id: t.id, name: t.name, isDefault: t.isDefault })))
    }).catch(() => {})
  }

  const save = async () => {
    setSaving(true)
    try {
      if (currentId) {
        await printTemplatesApi.update(currentId, { name: designName, config })
        toast.success(`Design "${designName}" updated`)
      } else {
        const r = await printTemplatesApi.create({ docType, name: designName, config, setDefault: true })
        setCurrentId(r.id)
        toast.success(`Design "${designName}" saved as the default for ${docType}s`)
      }
      refreshList()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const loadTemplate = async (id: string) => {
    const all = await printTemplatesApi.list(docType)
    const t = all.templates.find((x) => x.id === id)
    if (!t) return
    setConfig(mergePrintConfig(t.config))
    setCurrentId(t.id)
    setDesignName(t.name)
  }

  const makeDefault = async (id: string) => {
    try {
      await printTemplatesApi.setDefault(id)
      toast.success('Default design updated')
      refreshList()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not set default')
    }
  }

  const removeTemplate = async (id: string) => {
    try {
      await printTemplatesApi.remove(id)
      if (currentId === id) {
        setCurrentId(null)
        setConfig(DEFAULT_PRINT_CONFIG)
        setDesignName('My design')
      }
      toast.info('Design deleted')
      refreshList()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const resetToBuiltIn = () => {
    setCurrentId(null)
    setConfig(DEFAULT_PRINT_CONFIG)
    setDesignName('My design')
  }

  // ── Export / import the current design ────────────────────────────────
  // Export writes a self-contained .opal-print JSON file (docType + config +
  // version). Import validates the file locally, then runs it through the
  // server-side sanitizer before applying it to the canvas.
  const exportDesign = () => {
    const payload = {
      _opalPrint: 1 as const,
      docType,
      name: designName,
      exportedAt: new Date().toISOString(),
      config,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${docType}-${designName.replace(/[^a-z0-9-_]+/gi, '-')}.opal-print.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.success(`Design exported for ${docType}`)
  }

  const importDesignFile = async (file: File) => {
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as {
        _opalPrint?: number
        docType?: DocType
        name?: string
        config?: unknown
      }
      if (parsed._opalPrint !== 1 || !parsed.config) {
        toast.error('Not an Opal Line print design file')
        return
      }
      if (parsed.docType && parsed.docType !== docType) {
        toast.error(`This file is a ${parsed.docType} design — open the ${parsed.docType} tab and import it there.`)
        return
      }
      // Server-side sanitize returns a clamped config (or an error).
      const check = await fetch('/api/v1/print-templates/sanitize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ config: parsed.config }),
      })
      if (!check.ok) {
        toast.error('Design file failed validation')
        return
      }
      const { config: clean } = (await check.json()) as { config: PrintDesignerConfig }
      setCurrentId(null)
      setConfig(clean)
      if (parsed.name) setDesignName(`${parsed.name} (imported)`)
      toast.success('Design imported — review it, then Save to keep it')
    } catch {
      toast.error('Could not read the design file')
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1560px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Print Designer"
        subtitle="Design your own invoices, quotations and order printouts — the saved design applies to every future printout of that document type."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={openPreviewWindow}>
              <Printer className="h-3.5 w-3.5" /> Print preview
            </Button>
            <Button variant="outline" size="sm" onClick={exportDesign}>
              <Download className="h-3.5 w-3.5" /> Export design
            </Button>
            <label className="cursor-pointer">
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) void importDesignFile(f)
                }}
              />
              <span className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-input bg-card px-3 text-xs font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground">
                <Upload className="h-3.5 w-3.5" /> Import design
              </span>
            </label>
            <Button variant="outline" size="sm" onClick={resetToBuiltIn}>
              <RotateCcw className="h-3.5 w-3.5" /> Reset
            </Button>
            <Button size="sm" onClick={save} disabled={saving}>
              <Save className="h-3.5 w-3.5" /> {saving ? 'Saving…' : currentId ? 'Update design' : 'Save & set default'}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[420px_1fr]">
        <Card>
          <CardContent className="space-y-4 p-4">
            <Tabs value={docType} onValueChange={(v) => setDocType(v as DocType)}>
            <TabsList className="grid h-auto w-full grid-cols-3 gap-1.5 p-1.5">
              <TabsTrigger value="invoice" className="w-full justify-center px-2 text-xs">Invoice</TabsTrigger>
              <TabsTrigger value="quotation" className="w-full justify-center px-2 text-xs">Quotation</TabsTrigger>
              <TabsTrigger value="order" className="w-full justify-center px-2 text-xs">Order</TabsTrigger>
              <TabsTrigger value="packing-slip" className="w-full justify-center px-2 text-xs">Packing Slip</TabsTrigger>
              <TabsTrigger value="pick-list" className="w-full justify-center px-2 text-xs">Pick List</TabsTrigger>
              <TabsTrigger value="barcode-label" className="w-full justify-center px-2 text-xs">Product Label</TabsTrigger>
            </TabsList>

          <TabsContent value="invoice" />
          <TabsContent value="quotation" />
          <TabsContent value="order" />
          <TabsContent value="packing-slip" />
          <TabsContent value="pick-list" />
          <TabsContent value="barcode-label" />

            </Tabs>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Design name</Label>
              <Input value={designName} onChange={(e) => setDesignName(e.target.value)} maxLength={80} />
            </div>

            <div className="max-h-[calc(100vh-320px)] space-y-4 overflow-y-auto pr-1">
              {isLabel ? (
                <>
                  <SectionTitle>Label size</SectionTitle>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Preset (mm)</Label>
                    <Select
                      value={config.labelPreset}
                      onValueChange={(v) => set('labelPreset', v as PrintDesignerConfig['labelPreset'])}
                      options={[
                        ...(Object.keys(LABEL_PRESETS) as Array<PrintDesignerConfig['labelPreset']>).map((k) => ({
                          value: k,
                          label: `${LABEL_PRESETS[k as keyof typeof LABEL_PRESETS].width} × ${LABEL_PRESETS[k as keyof typeof LABEL_PRESETS].height} mm`,
                        })),
                        { value: 'custom', label: 'Custom size…' },
                      ]}
                    />
                  </div>
                  {config.labelPreset === 'custom' ? (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Width (mm)</Label>
                        <Input type="number" min={15} max={130} value={config.labelWidthMm} onChange={(e) => set('labelWidthMm', Number(e.target.value) || 50)} />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Height (mm)</Label>
                        <Input type="number" min={8} max={60} value={config.labelHeightMm} onChange={(e) => set('labelHeightMm', Number(e.target.value) || 25)} />
                      </div>
                    </div>
                  ) : null}
                  <p className="text-[11px] text-muted-foreground">
                    Prints at exactly {resolveLabelSize(config).width} × {resolveLabelSize(config).height} mm — no page margins or scaling.
                  </p>

                  <SectionTitle>Sides</SectionTitle>
                  <ToggleRow title="Front side" description="SKU and Rate (price tag style)" checked={config.labelShowFront} onCheckedChange={(v) => set('labelShowFront', v)} />
                  <ToggleRow title="Back side" description="Company name and Product name" checked={config.labelShowBack} onCheckedChange={(v) => set('labelShowBack', v)} />

                  {config.labelShowFront ? (
                    <>
                      <SectionTitle>Front (Price Tag)</SectionTitle>
                      <ToggleRow title="SKU" description="Show SKU on front" checked={!!config.labelFrontSku} onCheckedChange={(v) => set('labelFrontSku', v)} />
                      <ToggleRow title="Rate" description="Show Rate (₹)" checked={config.labelFrontRate} onCheckedChange={(v) => set('labelFrontRate', v)} />
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">Text size (mm, 0 = auto)</Label>
                          <Input type="number" min={0} max={10} step="0.1" value={config.labelFrontFontSizeMm ?? 0} onChange={(e) => set('labelFrontFontSizeMm', Number(e.target.value) || 0)} />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">Alignment</Label>
                          <Select
                            value={config.labelFrontFontAlign ?? 'right'}
                            onValueChange={(v) => set('labelFrontFontAlign', v as PrintDesignerConfig['labelFrontFontAlign'])}
                            options={[
                              { value: 'left', label: 'Left' },
                              { value: 'center', label: 'Centre' },
                              { value: 'right', label: 'Right' },
                            ]}
                          />
                        </div>
                      </div>
                    </>
                  ) : null}

                  {config.labelShowBack ? (
                    <>
                      <SectionTitle>Back</SectionTitle>
                      <ToggleRow title="Company Name" description="Show business name on back" checked={!!config.labelBackCompany} onCheckedChange={(v) => set('labelBackCompany', v)} />
                      <ToggleRow title="Product Name" description="Show product name on back" checked={!!config.labelBackProduct} onCheckedChange={(v) => set('labelBackProduct', v)} />
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">Text size (mm, 0 = auto)</Label>
                          <Input type="number" min={0} max={10} step="0.1" value={config.labelBackFontSizeMm ?? 0} onChange={(e) => set('labelBackFontSizeMm', Number(e.target.value) || 0)} />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">Alignment</Label>
                          <Select
                            value={config.labelBackFontAlign ?? 'left'}
                            onValueChange={(v) => set('labelBackFontAlign', v as PrintDesignerConfig['labelBackFontAlign'])}
                            options={[
                              { value: 'left', label: 'Left' },
                              { value: 'center', label: 'Centre' },
                              { value: 'right', label: 'Right' },
                            ]}
                          />
                        </div>
                      </div>
                    </>
                  ) : null}

                  <SectionTitle>Label data</SectionTitle>
                  <div className="rounded-lg border bg-muted/30 p-2.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => setShowProductPicker((v) => !v)}
                    >
                      <Search className="h-3.5 w-3.5" />
                      {showProductPicker ? 'Close product search' : 'Fetch SKU / rate from inventory'}
                    </Button>
                    {showProductPicker ? (
                      <div className="mt-2 space-y-1.5">
                        <Input
                          value={productQuery}
                          onChange={(e) => setProductQuery(e.target.value)}
                          placeholder="Search by product name or SKU…"
                          autoFocus
                        />
                        <div className="max-h-44 overflow-y-auto rounded-md border bg-card">
                          {filteredProducts.length === 0 ? (
                            <p className="px-2.5 py-3 text-xs text-muted-foreground">No products found.</p>
                          ) : (
                            filteredProducts.map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent"
                                onClick={() => applyProduct(p)}
                              >
                                <span className="truncate font-medium">{p.name}</span>
                                <span className="shrink-0 font-mono text-muted-foreground">{p.sku}</span>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Company name</Label>
                    <Input value={labelEdit.companyName} onChange={(e) => setLabelEdit((s) => ({ ...s, companyName: e.target.value }))} maxLength={120} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Product name</Label>
                    <Input value={labelEdit.productName} onChange={(e) => setLabelEdit((s) => ({ ...s, productName: e.target.value }))} maxLength={160} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">SKU</Label>
                    <Input value={labelEdit.sku} onChange={(e) => setLabelEdit((s) => ({ ...s, sku: e.target.value }))} maxLength={64} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Rate (₹)</Label>
                      <Input type="number" min={0} value={labelEdit.rate} onChange={(e) => setLabelEdit((s) => ({ ...s, rate: Number(e.target.value) || 0 }))} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Weight (g)</Label>
                      <Input type="number" min={0} step="0.01" value={labelEdit.weight} onChange={(e) => setLabelEdit((s) => ({ ...s, weight: Number(e.target.value) || 0 }))} />
                    </div>
                  </div>

                  <SectionTitle>Label styling</SectionTitle>
                  <ToggleRow title="Border" description="Show label border" checked={config.labelBorder !== false} onCheckedChange={(v) => set('labelBorder', v)} />
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Background</Label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={config.labelBackgroundColor || '#ffffff'} onChange={(e) => set('labelBackgroundColor', e.target.value)} className="h-9 w-10 cursor-pointer rounded-md border border-input bg-card p-1" aria-label="Background" />
                        <Input value={config.labelBackgroundColor || '#ffffff'} onChange={(e) => set('labelBackgroundColor', e.target.value)} className="h-9 flex-1 font-mono text-xs" maxLength={7} />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Corner radius (mm)</Label>
                      <Input type="number" min={0} max={5} step="0.1" value={config.labelRadiusMm ?? 1} onChange={(e) => set('labelRadiusMm', Number(e.target.value) || 0)} />
                    </div>
                  </div>
                </>
              ) : (
                <>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Header style</Label>
                <Select
                  value={config.headerStyle}
                  onValueChange={(v) => set('headerStyle', v as PrintDesignerConfig['headerStyle'])}
                  options={[
                    { value: 'banner', label: 'Navy banner (classic)' },
                    { value: 'modern', label: 'Modern split (label + rule)' },
                    { value: 'minimal', label: 'Minimal line' },
                    { value: 'boxed', label: 'Boxed border' },
                  ]}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Accent color</Label>
                  <div className="flex items-center gap-2">
                    <input type="color" value={config.accent} onChange={(e) => set('accent', e.target.value)} className="h-9 w-10 cursor-pointer rounded-md border border-input bg-card p-1" aria-label="Accent color" />
                    <Input value={config.accent} onChange={(e) => set('accent', e.target.value)} className="h-9 flex-1 font-mono text-xs" maxLength={7} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Header color</Label>
                  <div className="flex items-center gap-2">
                    <input type="color" value={config.accent2} onChange={(e) => set('accent2', e.target.value)} className="h-9 w-10 cursor-pointer rounded-md border border-input bg-card p-1" aria-label="Header color" />
                    <Input value={config.accent2} onChange={(e) => set('accent2', e.target.value)} className="h-9 flex-1 font-mono text-xs" maxLength={7} />
                  </div>
                </div>
              </div>
              <ToggleRow title="Logo" description="Show a logo image in the header" checked={config.showLogo} onCheckedChange={(v) => set('showLogo', v)} />
              {config.showLogo ? (
                <>
                  <div className="flex items-center gap-3">
                    <Select
                      value={config.logoAlign}
                      onValueChange={(v) => set('logoAlign', v as PrintDesignerConfig['logoAlign'])}
                      options={[
                        { value: 'left', label: 'Logo left' },
                        { value: 'center', label: 'Logo right' },
                      ]}
                      className="w-36"
                    />
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="text-xs"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) readImage(file, 200, (url) => { set('logoDataUrl', url); set('showLogo', true) })
                      }}
                    />
                    {config.logoDataUrl ? <img src={config.logoDataUrl} alt="logo preview" className="h-8 max-w-[80px] object-contain" /> : null}
                  </div>
                </>
              ) : null}
              <ToggleRow title="Tagline" description='"92.5 Sterling Silver Jewellery" under the name' checked={config.showTagline} onCheckedChange={(v) => set('showTagline', v)} />
              <ToggleRow title="GSTIN" description="Show business GSTIN on the printout" checked={config.showGSTIN} onCheckedChange={(v) => set('showGSTIN', v)} />

              <SectionTitle>Typography &amp; paper</SectionTitle>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Font</Label>
                  <Select
                    value={config.font}
                    onValueChange={(v) => set('font', v as PrintDesignerConfig['font'])}
                    options={[
                      { value: 'inter', label: 'Inter (modern)' },
                      { value: 'georgia', label: 'Georgia (serif)' },
                      { value: 'arial', label: 'Arial (classic)' },
                    ]}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Font scale</Label>
                  <Select
                    value={String(config.fontScale)}
                    onValueChange={(v) => set('fontScale', Number(v))}
                    options={[
                      { value: '0.9', label: 'Small' },
                      { value: '1', label: 'Normal' },
                      { value: '1.15', label: 'Large' },
                    ]}
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Page</Label>
                  <Select
                    value={config.pageSize}
                    onValueChange={(v) => set('pageSize', v as PrintDesignerConfig['pageSize'])}
                    options={[
                      { value: 'a4', label: 'A4' },
                      { value: 'letter', label: 'Letter' },
                    ]}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Paper tint</Label>
                  <Select
                    value={config.paperTint}
                    onValueChange={(v) => set('paperTint', v as PrintDesignerConfig['paperTint'])}
                    options={[
                      { value: 'white', label: 'White' },
                      { value: 'cream', label: 'Cream' },
                    ]}
                  />
                </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Corner radius (px)</Label>
                      <Input type="number" min={0} max={16} value={config.cornerRadius} onChange={(e) => set('cornerRadius', Number(e.target.value) || 0)} />
                    </div>

              </div>
              <div className="grid grid-cols-4 gap-2">
                {(['top', 'right', 'bottom', 'left'] as const).map((m) => (
                  <div key={m} className="space-y-1.5">
                    <Label className="text-xs capitalize text-muted-foreground">{m} (mm)</Label>
                    <Input type="number" min={0} max={40} value={config.margins[m]} onChange={(e) => setMargin(m, Number(e.target.value) || 0)} />
                  </div>
                ))}
              </div>

              <SectionTitle>Items table</SectionTitle>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Header style</Label>
                  <Select
                    value={config.tableHeaderStyle}
                    onValueChange={(v) => set('tableHeaderStyle', v as PrintDesignerConfig['tableHeaderStyle'])}
                    options={[
                      { value: 'dark', label: 'Dark bar' },
                      { value: 'accent', label: 'Accent bar' },
                      { value: 'light', label: 'Light + underline' },
                    ]}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Borders</Label>
                  <Select
                    value={config.borderStyle}
                    onValueChange={(v) => set('borderStyle', v as PrintDesignerConfig['borderStyle'])}
                    options={[
                      { value: 'rows', label: 'Row lines' },
                      { value: 'full', label: 'Full grid' },
                      { value: 'none', label: 'No lines' },
                    ]}
                  />
                </div>
              </div>
              <ToggleRow title="Row striping" description="Alternate row background" checked={config.tableZebra} onCheckedChange={(v) => set('tableZebra', v)} />
              <ToggleRow title="HSN column" description="Show the HSN code column" checked={config.showHsn} onCheckedChange={(v) => set('showHsn', v)} />
              <ToggleRow title="Weight & rate" description="Weight, rate/making columns" checked={config.showWeight && config.showRate} onCheckedChange={(v) => { set('showWeight', v); set('showRate', v) }} />
              <ToggleRow title="GST column" description="Per-item tax percentage column" checked={config.showTax} onCheckedChange={(v) => set('showTax', v)} />

              <SectionTitle>Sections</SectionTitle>
              <ToggleRow title="Info boxes" description="Number / date / payment boxes under the header" checked={config.showContactBoxes} onCheckedChange={(v) => set('showContactBoxes', v)} />
              <ToggleRow title="Payment box" description="Payment method + status box" checked={config.showPayment} onCheckedChange={(v) => set('showPayment', v)} />
              <ToggleRow title="Amount in words" description="Grand total spelled out in words" checked={config.showAmountWords} onCheckedChange={(v) => set('showAmountWords', v)} />
              <ToggleRow title="Signature lines" description="Customer + authorised signatory" checked={config.showSignature} onCheckedChange={(v) => set('showSignature', v)} />
              <ToggleRow title="Declaration" description="The legal declaration block" checked={config.showDeclaration} onCheckedChange={(v) => set('showDeclaration', v)} />

              <SectionTitle>QR code</SectionTitle>
              <ToggleRow title="Show QR code" description="e.g. UPI QR next to the totals" checked={config.showQr} onCheckedChange={(v) => set('showQr', v)} />
              {config.showQr ? (
                <div className="space-y-2">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="text-xs"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) readImage(file, 200, (url) => { set('qrDataUrl', url); set('showQr', true) })
                    }}
                  />
                  <Input value={config.qrCaption} onChange={(e) => set('qrCaption', e.target.value)} maxLength={120} placeholder="Caption, e.g. Scan to pay (UPI)" />
                </div>
              ) : null}

              <SectionTitle>Texts</SectionTitle>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Thank-you note</Label>
                <Input value={config.thankYouNote} onChange={(e) => set('thankYouNote', e.target.value)} maxLength={300} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Footer note</Label>
                <Input value={config.footerNote} onChange={(e) => set('footerNote', e.target.value)} maxLength={500} placeholder="e.g. Goods once sold are not returnable" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Declaration text</Label>
                <textarea
                  className="min-h-[64px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  value={config.declaration}
                  onChange={(e) => set('declaration', e.target.value)}
                  maxLength={1000}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Bank / payment details (optional)</Label>
                <textarea
                  className="min-h-[56px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  value={config.bankDetails}
                  onChange={(e) => set('bankDetails', e.target.value)}
                  maxLength={600}
                  placeholder={'A/C 1234567890 · Opal Line Jewels LLP\nIFSC SBIN0001234 · UPI opalline@upi'}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Signatory line (optional)</Label>
                <Input value={config.signatoryName} onChange={(e) => set('signatoryName', e.target.value)} maxLength={120} placeholder="Defaults to the business name" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Watermark</Label>
                <Input value={config.watermark ?? ''} onChange={(e) => set('watermark', e.target.value || null)} placeholder="e.g. PAID" maxLength={40} />
              </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-3">
          {savedList.length > 0 ? (
            <Card>
              <CardContent className="flex flex-wrap items-center gap-2 p-3">
                <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Saved designs</span>
                {savedList.map((t) => (
                  <span key={t.id} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
                    <button className="font-medium hover:underline" onClick={() => void loadTemplate(t.id)}>{t.name}</button>
                    {t.isDefault ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-label="default" /> : null}
                    {!t.isDefault ? (
                      <button className="text-muted-foreground hover:text-foreground" title="Set as default" onClick={() => void makeDefault(t.id)}>★</button>
                    ) : null}
                    <button className="text-muted-foreground hover:text-red-600" title="Delete" onClick={() => void removeTemplate(t.id)}>
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </CardContent>
            </Card>
          ) : null}

          <Card className="overflow-hidden">
            <CardContent className="p-0">
              <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2">
                <span className="text-xs font-medium text-muted-foreground">Live preview — {docType}</span>
                <span className="text-xs text-muted-foreground">{config.pageSize.toUpperCase()} · {config.headerStyle} · {config.font}</span>
              </div>
              <iframe
                ref={iframeRef}
                title="Print preview"
                sandbox="allow-same-origin"
                className="h-[calc(100vh-260px)] min-h-[560px] w-full bg-white"
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
