import { useEffect, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, Building2, FileCheck2, FileSpreadsheet, FileText, IndianRupee, Landmark, Loader2, Scale } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { dbApi, backupApi } from '@/lib/api'
import type { GstReportResult } from '@/types'
import { formatCurrency } from '@/lib/format'

export default function GstReportsPage() {
  const now = new Date()
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
  const [data, setData] = useState<GstReportResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    // Defer out of the effect body: the loaders set state synchronously
    // (react/set-state-in-effect).
    queueMicrotask(() => {
      setLoading(true)
      setError('')
      dbApi
        .getGstReport({ month: Number(month.slice(5, 7)), year: Number(month.slice(0, 4)) })
        .then((res) => {
          if (!cancelled) setData(res)
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load GST report')
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    })
    return () => {
      cancelled = true
    }
  }, [month])

  const s = data?.summary
  const g1 = data?.gstr1
  const maxGst = Math.max(1, ...(data?.monthly.map((m) => m.gst) ?? [1]))
  const monthLabel = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-5 py-5 sm:py-6 lg:px-7">
      <PageHeader
        title="GST Reports"
        subtitle="GSTR-1, GSTR-3B and input credit positions for the registered GSTIN."
        actions={
          <>
            <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-[170px]" />
            <Button
              variant="outline"
              size="sm"
              onClick={() => backupApi.downloadGstExport(Number(month.slice(5, 7)), Number(month.slice(0, 4)), 'csv')}
              title="Download GSTR-1 style CSV"
            >
              CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => backupApi.downloadGstExport(Number(month.slice(5, 7)), Number(month.slice(0, 4)), 'json')}
              title="Download JSON summary"
            >
              JSON
            </Button>
          </>
        }
      />

      {error ? (
        <Card className="p-4 text-sm text-red-600 dark:text-red-400">{error}</Card>
      ) : loading || !s || !g1 ? (
        <Card className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading GST report...
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MiniCard icon={IndianRupee} label="Taxable Supplies" value={formatCurrency(s.taxable)} sub={monthLabel} tint="bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300" />
            <MiniCard icon={ArrowUpRight} label="Output GST" value={formatCurrency(s.outputGst)} sub="Liability for period" tint="bg-warning-50 text-warning-700" />
            <MiniCard icon={ArrowDownRight} label="Input GST" value={formatCurrency(s.inputGst)} sub="Credit available" tint="bg-info-50 text-info-700" />
            <MiniCard icon={Scale} label="Net GST Payable" value={formatCurrency(s.netGst)} sub={`CGST ₹${s.cgst.toLocaleString('en-IN')} · SGST ₹${s.sgst.toLocaleString('en-IN')}`} tint="bg-success-50 text-success-700" />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardContent className="space-y-4 p-5">
                <div className="flex items-center gap-2">
                  <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-semibold text-foreground">GSTR-1 · Outward Supplies</h3>
                  <Badge variant="success" className="ml-auto" dot>Ready to file</Badge>
                </div>
                <div className="space-y-3">
                  <Row label="B2B Invoices" value={String(g1.b2b.invoices)} sub={`${formatCurrency(g1.b2b.taxable)} taxable`} />
                  <Row label="B2C Invoices" value={String(g1.b2c.invoices)} sub={`${formatCurrency(g1.b2c.taxable)} taxable`} />
                  <Row label="Exports (Zero rated)" value={String(g1.exports.invoices)} sub="—" />
                  <Row label="Credit / Debit Notes" value={String(g1.notes.invoices)} sub="Adjustment entries" />
                  <Row label="Nil Rated & Exempt" value={String(g1.nilRated.invoices)} sub="Zero-value invoices" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-4 p-5">
                <div className="flex items-center gap-2">
                  <FileCheck2 className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-semibold text-foreground">GSTR-3B · Summary Return</h3>
                  <Badge variant="info" className="ml-auto">Draft</Badge>
                </div>
                <div className="space-y-3">
                  <Row label="Total Taxable Value" value={formatCurrency(s.taxable)} />
                  <Row label="Output CGST" value={formatCurrency(s.cgst)} />
                  <Row label="Output SGST" value={formatCurrency(s.sgst)} />
                  <Row label="ITC Utilised" value={formatCurrency(s.itcUtilised)} />
                  <Row label="Net Tax Payable" value={formatCurrency(s.netGst)} highlight />
                  {/* TCS is collected from suppliers on bullion and deposited
                      on their behalf — a separate liability, never ITC. */}
                  <Row label="TCS Collected (194Q)" value={formatCurrency(s.tcs)} />
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardContent className="space-y-4 p-5">
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-semibold text-foreground">Monthly GST Trend</h3>
                </div>
                <div className="flex h-40 items-end gap-3">
                  {data.monthly.map((m) => {
                    const h = Math.max(4, Math.round((m.gst / maxGst) * 100))
                    return (
                      <div key={m.label} className="flex flex-1 flex-col items-center gap-1.5">
                        <span className="text-[11px] font-semibold tabular-nums text-foreground">{(m.gst / 1000).toFixed(1)}k</span>
                        <div className="w-full rounded-t-md bg-gradient-to-t from-primary-600 to-primary-400" style={{ height: `${h}px` }} />
                        <span className="text-[11px] text-muted-foreground">{m.label}</span>
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-4 p-5">
                <div className="flex items-center gap-2">
                  <Landmark className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-semibold text-foreground">Filing Status</h3>
                </div>
                <div className="space-y-3">
                  {data.filing.map((f) => (
                    <div key={f.month} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{f.month}</span>
                      <Badge variant={f.variant} dot>{f.status}</Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="flex items-center gap-3 p-4">
            <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              GSTIN <span className="font-mono font-medium text-foreground">{data.gstin}</span> · HSN summary and e-invoice details available for export.
            </p>
          </Card>
        </>
      )}
    </div>
  )
}

function MiniCard({ icon: Icon, label, value, sub, tint }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string; tint: string }) {
  return (
    <Card className="p-3 sm:p-4">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${tint}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="text-lg font-bold text-foreground">{value}</p>
          {sub ? <p className="text-[11px] text-muted-foreground">{sub}</p> : null}
        </div>
      </div>
    </Card>
  )
}

function Row({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b pb-2 text-sm last:border-0">
      <div>
        <p className="text-muted-foreground">{label}</p>
        {sub ? <p className="text-[11px] text-muted-foreground/70">{sub}</p> : null}
      </div>
      <span className={`font-semibold tabular-nums ${highlight ? 'text-primary-700' : 'text-foreground'}`}>{value}</span>
    </div>
  )
}
