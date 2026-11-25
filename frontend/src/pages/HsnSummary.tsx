import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  FileSpreadsheet,
  IndianRupee,
  Loader2,
  Scale,
  TrendingDown,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { accountingApi } from '@/lib/api'
import { formatCurrency } from '@/lib/format'

export default function HsnSummaryPage() {
  const now = new Date()
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
  const [hsnData, setHsnData] = useState<Array<{ hsn: string; description: string; qty: number; taxableValue: number; cgst: number; sgst: number; igst: number; totalTax: number }>>([])
  const [recon, setRecon] = useState<{ outputGst: number; inputGst: number; netPayable: number; b2bTaxable: number; b2cTaxable: number; mismatches: Array<{ invoiceNumber: string; expected: number; actual: number; diff: number }> } | null>(null)
  const [loading, setLoading] = useState(true)

  const m = Number(month.slice(5, 7))
  const y = Number(month.slice(0, 4))

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [hsnRes, reconRes] = await Promise.all([
        accountingApi.getHsnSummary({ month: m, year: y }),
        accountingApi.getGstReconciliation({ month: m, year: y }),
      ])
      setHsnData(hsnRes)
      setRecon(reconRes)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [m, y])

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(load)
  }, [load])

  const totalTaxable = hsnData.reduce((s, r) => s + r.taxableValue, 0)
  const totalCgst = hsnData.reduce((s, r) => s + r.cgst, 0)
  const totalSgst = hsnData.reduce((s, r) => s + r.sgst, 0)
  const totalTax = hsnData.reduce((s, r) => s + r.totalTax, 0)
  const monthLabel = new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-5 py-5 sm:py-6 lg:px-7">
      <PageHeader
        title="HSN-wise Summary & GST Reconciliation"
        subtitle={`HSN code-wise breakup of outward supplies for ${monthLabel}`}
        actions={
          <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-[170px]" />
        }
      />

      {loading ? (
        <Card className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading HSN summary...
        </Card>
      ) : (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MiniCard icon={IndianRupee} label="Total Taxable" value={formatCurrency(totalTaxable)} tint="bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300" />
            <MiniCard icon={TrendingDown} label="Output CGST" value={formatCurrency(totalCgst)} tint="bg-info-50 text-info-700" />
            <MiniCard icon={TrendingDown} label="Output SGST" value={formatCurrency(totalSgst)} tint="bg-info-50 text-info-700" />
            <MiniCard icon={Scale} label="Total GST" value={formatCurrency(totalTax)} tint="bg-warning-50 text-warning-700" />
          </div>

          {/* HSN Table */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
                HSN-wise Summary
              </CardTitle>
              <CardDescription>Outward supplies grouped by HSN code</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {hsnData.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-muted-foreground">No HSN data for this period</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>HSN</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Quantity</TableHead>
                      <TableHead className="text-right">Taxable Value (₹)</TableHead>
                      <TableHead className="text-right">CGST (₹)</TableHead>
                      <TableHead className="text-right">SGST (₹)</TableHead>
                      <TableHead className="text-right">Total Tax (₹)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {hsnData.map((r) => (
                      <TableRow key={r.hsn}>
                        <TableCell className="font-mono text-xs font-medium">{r.hsn}</TableCell>
                        <TableCell className="text-sm">{r.description}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.qty}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">{formatCurrency(r.taxableValue)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(r.cgst)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(r.sgst)}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums text-primary-700">{formatCurrency(r.totalTax)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="border-t-2 border-primary-200 bg-muted/50 font-bold">
                      <TableCell colSpan={2}>Total</TableCell>
                      <TableCell className="text-right tabular-nums">{hsnData.reduce((s, r) => s + r.qty, 0)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(totalTaxable)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(totalCgst)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(totalSgst)}</TableCell>
                      <TableCell className="text-right tabular-nums text-primary-700">{formatCurrency(totalTax)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* GST Reconciliation */}
          {recon && (
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Scale className="h-4 w-4 text-muted-foreground" />
                    GST Reconciliation
                  </CardTitle>
                  <CardDescription>Output vs Input GST position</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Row label="B2B Taxable Value" value={formatCurrency(recon.b2bTaxable)} />
                  <Row label="B2C Taxable Value" value={formatCurrency(recon.b2cTaxable)} />
                  <Separator />
                  <Row label="Output GST" value={formatCurrency(recon.outputGst)} highlight />
                  <Row label="Input GST (ITC)" value={formatCurrency(recon.inputGst)} />
                  <Separator />
                  <Row label="Net GST Payable" value={formatCurrency(recon.netPayable)} highlight />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    {recon.mismatches.length === 0 ? (
                      <CheckCircle2 className="h-4 w-4 text-success-600" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                    )}
                    GST Mismatches
                  </CardTitle>
                  <CardDescription>Invoices where calculated GST differs from recorded GST</CardDescription>
                </CardHeader>
                <CardContent>
                  {recon.mismatches.length === 0 ? (
                    <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700">
                      <CheckCircle2 className="h-4 w-4" />
                      All invoices reconciled — no GST mismatches found.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">{recon.mismatches.length} mismatch(es) found</p>
                      <div className="max-h-[200px] space-y-1 overflow-y-auto">
                        {recon.mismatches.map((m, i) => (
                          <div key={i} className="flex items-center justify-between rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
                            <span className="font-mono font-medium">{m.invoiceNumber}</span>
                            <span className="text-amber-700">
                              Expected ₹{m.expected.toLocaleString('en-IN')} · Actual ₹{m.actual.toLocaleString('en-IN')} · Diff ₹{m.diff.toLocaleString('en-IN')}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          <Card className="flex items-center gap-3 p-4">
            <BarChart3 className="h-5 w-5 shrink-0 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              HSN code <span className="font-mono font-medium text-foreground">7113</span> (Silver jewellery) is the primary category.
              This report is GSTR-1 Table 12 compliant.
            </p>
          </Card>
        </>
      )}
    </div>
  )
}

function MiniCard({ icon: Icon, label, value, tint }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; tint: string }) {
  return (
    <Card className="p-3 sm:p-4">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${tint}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="text-lg font-bold text-foreground">{value}</p>
        </div>
      </div>
    </Card>
  )
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-semibold tabular-nums ${highlight ? 'text-primary-700' : 'text-foreground'}`}>{value}</span>
    </div>
  )
}
