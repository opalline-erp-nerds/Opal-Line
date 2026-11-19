import { useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  FileUp,
  Loader2,
  Upload,
  UserPlus,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { dbApi, backupApi } from '@/lib/api'

export default function ImportDataPage() {
  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Import Data"
        subtitle="Bulk import products and customers from CSV files"
        icon={<FileUp className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />}
        iconTileClassName="bg-[#7547F5] text-white ring-[#7547F5] dark:bg-[#7547F5] dark:text-white dark:ring-[#7547F5]"
      />
      <Tabs defaultValue="products">
        <TabsList>
          <TabsTrigger value="products"><FileSpreadsheet className="h-4 w-4" /> Products</TabsTrigger>
          <TabsTrigger value="customers"><UserPlus className="h-4 w-4" /> Customers</TabsTrigger>
        </TabsList>
        <TabsContent value="products"><ProductsImportTab /></TabsContent>
        <TabsContent value="customers"><CustomersImportTab /></TabsContent>
      </Tabs>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// PRODUCTS CSV IMPORT
// ═══════════════════════════════════════════════════════════════════
function ProductsImportTab() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [csvText, setCsvText] = useState('')
  const [preview, setPreview] = useState<Record<string, string>[]>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; lines: string[] } | null>(null)

  const parseCsv = (text: string): { headers: string[]; rows: Record<string, string>[] } => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
    if (lines.length < 2) return { headers: [], rows: [] }
    const split = (line: string) => {
      const out: string[] = []
      let cur = ''
      let inQ = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"') {
          if (inQ && line[i + 1] === '"') { cur += '"'; i++ } else inQ = !inQ
        } else if (ch === ',' && !inQ) { out.push(cur); cur = '' } else cur += ch
      }
      out.push(cur)
      return out.map((c) => c.trim())
    }
    const hdrs = split(lines[0])
    const rows = lines.slice(1).map((line) => {
      const cells = split(line)
      const row: Record<string, string> = {}
      hdrs.forEach((h, i) => { if (cells[i] !== undefined) row[h] = cells[i] })
      return row
    })
    return { headers: hdrs, rows }
  }

  const handleFile = async (file: File) => {
    const text = await file.text()
    setCsvText(text)
    const parsed = parseCsv(text)
    setHeaders(parsed.headers)
    setPreview(parsed.rows.slice(0, 5))
    setResult(null)
  }

  const runImport = async () => {
    setBusy(true)
    setResult(null)
    try {
      const { rows } = parseCsv(csvText)
      if (rows.length === 0) {
        setResult({ ok: false, lines: ['No CSV rows found — include a header row and at least one product.'] })
        return
      }
      const r = await dbApi.bulkImportProducts(rows)
      const lines = [`Created ${r.created} new product${r.created === 1 ? '' : 's'}, updated ${r.updated}.`]
      for (const e of r.errors.slice(0, 10)) lines.push(`⚠ ${e}`)
      if (r.errors.length > 10) lines.push(`… and ${r.errors.length - 10} more issues`)
      setResult({ ok: r.errors.length === 0, lines })
    } catch (err) {
      setResult({ ok: false, lines: [err instanceof Error ? err.message : 'Import failed'] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Bulk Import Products (CSV)</CardTitle>
        <CardDescription>
          Upload a CSV file. Headers are auto-mapped: name, sku, category, purity, net weight, making charge, price, stock, huid.
          Existing SKUs are updated, new ones created.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
        <div className="flex gap-3">
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
            <Upload className="h-3.5 w-3.5" /> Choose CSV File
          </Button>
          {headers.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {headers.map((h) => (
                <Badge key={h} variant="outline" className="text-[10px]">{h}</Badge>
              ))}
            </div>
          )}
        </div>

        {preview.length > 0 && (
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {headers.map((h) => (
                    <TableHead key={h} className="whitespace-nowrap text-[11px]">{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.map((row, i) => (
                  <TableRow key={i}>
                    {headers.map((h) => (
                      <TableCell key={h} className="whitespace-nowrap text-xs">{row[h] || '—'}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="px-3 py-2 text-[11px] text-muted-foreground border-t">
              Showing first 5 rows of {parseCsv(csvText).rows.length} total
            </p>
          </div>
        )}

        {result && (
          <div className={`rounded-md border p-3 text-xs space-y-1 ${result.ok ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-amber-500/30 bg-amber-500/10'}`}>
            {result.lines.map((l, i) => (
              <p key={i} className="flex items-start gap-1.5">
                {l.startsWith('⚠') ? <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500 dark:text-amber-400" /> : <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />}
                <span>{l.replace(/^⚠ /, '')}</span>
              </p>
            ))}
          </div>
        )}

        <Button size="sm" onClick={runImport} disabled={busy || csvText.trim().length === 0}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Import {parseCsv(csvText).rows.length || 0} Products
        </Button>
      </CardContent>
    </Card>
  )
}

// ═══════════════════════════════════════════════════════════════════
// CUSTOMERS CSV IMPORT
// ═══════════════════════════════════════════════════════════════════
function CustomersImportTab() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [csvText, setCsvText] = useState('')
  const [preview, setPreview] = useState<Record<string, string>[]>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; lines: string[] } | null>(null)

  const parseCsv = (text: string): { headers: string[]; rows: Record<string, string>[] } => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
    if (lines.length < 2) return { headers: [], rows: [] }
    const split = (line: string) => {
      const out: string[] = []
      let cur = ''
      let inQ = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"') {
          if (inQ && line[i + 1] === '"') { cur += '"'; i++ } else inQ = !inQ
        } else if (ch === ',' && !inQ) { out.push(cur); cur = '' } else cur += ch
      }
      out.push(cur)
      return out.map((c) => c.trim())
    }
    const hdrs = split(lines[0])
    const rows = lines.slice(1).map((line) => {
      const cells = split(line)
      const row: Record<string, string> = {}
      hdrs.forEach((h, i) => { if (cells[i] !== undefined) row[h] = cells[i] })
      return row
    })
    return { headers: hdrs, rows }
  }

  const handleFile = async (file: File) => {
    const text = await file.text()
    setCsvText(text)
    const parsed = parseCsv(text)
    setHeaders(parsed.headers)
    setPreview(parsed.rows.slice(0, 5))
    setResult(null)
  }

  const runImport = async () => {
    setBusy(true)
    setResult(null)
    try {
      const { rows } = parseCsv(csvText)
      if (rows.length === 0) {
        setResult({ ok: false, lines: ['No CSV rows found — include a header row and at least one customer.'] })
        return
      }
      const r = await backupApi.importCustomersCSV(rows)
      const lines = [`Imported ${r.imported} new customer${r.imported === 1 ? '' : 's'}, updated ${r.updated}.`]
      for (const e of r.errors.slice(0, 10)) lines.push(`⚠ ${e}`)
      if (r.errors.length > 10) lines.push(`… and ${r.errors.length - 10} more issues`)
      setResult({ ok: r.errors.length === 0, lines })
    } catch (err) {
      setResult({ ok: false, lines: [err instanceof Error ? err.message : 'Import failed'] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Bulk Import Customers (CSV)</CardTitle>
        <CardDescription>
          Upload a CSV file with columns: name, email, phone, city, province, etc.
          Existing customers are matched by email or phone and updated.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
        <div className="flex gap-3">
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
            <Upload className="h-3.5 w-3.5" /> Choose CSV File
          </Button>
          {headers.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {headers.map((h) => (
                <Badge key={h} variant="outline" className="text-[10px]">{h}</Badge>
              ))}
            </div>
          )}
        </div>

        {preview.length > 0 && (
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {headers.map((h) => (
                    <TableHead key={h} className="whitespace-nowrap text-[11px]">{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.map((row, i) => (
                  <TableRow key={i}>
                    {headers.map((h) => (
                      <TableCell key={h} className="whitespace-nowrap text-xs">{row[h] || '—'}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="px-3 py-2 text-[11px] text-muted-foreground border-t">
              Showing first 5 rows of {parseCsv(csvText).rows.length} total
            </p>
          </div>
        )}

        {result && (
          <div className={`rounded-md border p-3 text-xs space-y-1 ${result.ok ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-amber-500/30 bg-amber-500/10'}`}>
            {result.lines.map((l, i) => (
              <p key={i} className="flex items-start gap-1.5">
                {l.startsWith('⚠') ? <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500 dark:text-amber-400" /> : <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />}
                <span>{l.replace(/^⚠ /, '')}</span>
              </p>
            ))}
          </div>
        )}

        <Button size="sm" onClick={runImport} disabled={busy || csvText.trim().length === 0}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Import {parseCsv(csvText).rows.length || 0} Customers
        </Button>
      </CardContent>
    </Card>
  )
}
