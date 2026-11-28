import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, Loader2, Printer, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { dbApi } from '@/lib/api'
import { printCurrentPage } from '@/lib/printTemplate'
import { formatCurrency, formatDateTime } from '@/lib/format'

interface DayBookData {
  date: string
  totals: { invoiced: number; collected: number; expenses: number; netCash: number }
  invoices: Array<{ id: string; number: string; customer: string | null; grandTotal: string | number | null; paymentStatus: string | null; date: string | null }>
  orders: Array<{ id: string; shopifyId: string | null; customer: string | null; value: string | number | null; status: string | null; date: string | null }>
  payments: Array<{ id: string; ref: string | null; customer: string | null; amount: string | number | null; method: string | null; date: string | null }>
  expenses: Array<{ id: string; category: string | null; description: string | null; amount: string | number | null; by: string | null; date: string | null }>
  shipments: Array<{ id: string; orderRef: string | null; customer: string | null; courier: string | null; trackingNumber: string | null; status: string | null; createdAt: string | null }>
  activities: Array<{ id: string; user: string | null; action: string | null; module: string | null; entity: string | null; details: string | null; timestamp: string | null }>
}

const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null
  return (
    <Card className="daybook-section">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          {title} <Badge variant="muted">{count}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">{children}</CardContent>
    </Card>
  )
}

function Row({ left, sub, right, badge }: { left: string; sub?: string | null; right: string; badge?: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2 text-sm last:border-0">
      <div className="min-w-0">
        <p className="truncate font-medium text-foreground">{left}</p>
        {sub ? <p className="truncate text-xs text-muted-foreground">{sub}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {badge ? <Badge variant="outline">{badge}</Badge> : null}
        <span className="font-semibold tabular-nums text-foreground">{right}</span>
      </div>
    </div>
  )
}

export default function DayBookPage() {
  const [date, setDate] = useState(todayStr())
  const [data, setData] = useState<DayBookData | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await dbApi.get<DayBookData>(`reports/day-book?date=${encodeURIComponent(date)}`)
      setData(d)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => {
    // Defer out of the effect body: load() flips loading state synchronously.
    queueMicrotask(load)
  }, [load])

  const totals = data?.totals

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-5 py-6 lg:px-7">
      <PageHeader
        title="Day Book"
        subtitle="Everything that happened on this day — invoices, orders, payments, expenses and dispatches on one printable page."
        actions={
          <div className="flex items-center gap-2 no-print">
            <Input type="date" value={date} max={todayStr()} onChange={(e) => setDate(e.target.value || todayStr())} className="w-40" />
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              {loading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={() => void printCurrentPage()}>
              <Printer className="h-3.5 w-3.5" /> Print
            </Button>
          </div>
        }
      />

      {loading && !data ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !data ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">Could not load the day book. Try again.</CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Card>
              <CardContent className="p-4">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><CalendarDays className="h-3 w-3" /> Invoiced</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-foreground">{formatCurrency(totals?.invoiced ?? 0)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Collected</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-success-700">{formatCurrency(totals?.collected ?? 0)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Expenses</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-destructive">{formatCurrency(totals?.expenses ?? 0)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Net Cash</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-foreground">{formatCurrency(totals?.netCash ?? 0)}</p>
              </CardContent>
            </Card>
          </div>

          <Section title="Invoices" count={data.invoices.length}>
            {data.invoices.map((i) => (
              <Row key={i.id} left={i.number} sub={i.customer ?? undefined} right={formatCurrency(Number(i.grandTotal ?? 0))} badge={i.paymentStatus ?? undefined} />
            ))}
          </Section>

          <Section title="New Orders" count={data.orders.length}>
            {data.orders.map((o) => (
              <Row key={o.id} left={o.shopifyId ?? o.id} sub={o.customer ?? undefined} right={formatCurrency(Number(o.value ?? 0))} badge={o.status ?? undefined} />
            ))}
          </Section>

          <Section title="Payments In" count={data.payments.length}>
            {data.payments.map((p) => (
              <Row key={p.id} left={p.ref ?? p.id} sub={[p.customer, p.method].filter(Boolean).join(' · ')} right={formatCurrency(Number(p.amount ?? 0))} />
            ))}
          </Section>

          <Section title="Expenses" count={data.expenses.length}>
            {data.expenses.map((e) => (
              <Row key={e.id} left={e.category ?? 'Expense'} sub={[e.description, e.by].filter(Boolean).join(' · ')} right={formatCurrency(Number(e.amount ?? 0))} />
            ))}
          </Section>

          <Section title="Dispatches" count={data.shipments.length}>
            {data.shipments.map((s) => (
              <Row key={s.id} left={s.orderRef ?? s.id} sub={[s.courier, s.trackingNumber].filter(Boolean).join(' · ')} right={s.status ?? ''} badge={formatDateTime(s.createdAt)} />
            ))}
          </Section>

          <Section title="Activity" count={data.activities.length}>
            <div className="max-h-72 overflow-y-auto">
              {data.activities.map((a) => (
                <Row key={a.id} left={`${a.user ?? 'system'} · ${a.action ?? ''}`} sub={[a.module, a.entity, a.details].filter(Boolean).join(' · ')} right={formatDateTime(a.timestamp)} />
              ))}
            </div>
          </Section>

          {data.invoices.length + data.orders.length + data.payments.length + data.expenses.length + data.shipments.length === 0 && (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">Nothing recorded on {data.date}.</CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
