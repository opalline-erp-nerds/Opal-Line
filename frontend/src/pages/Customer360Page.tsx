import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Mail, MapPin, Phone, ShoppingBag, Wallet } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { dbApi } from '@/lib/api'
import { SalesFollowUpsCard } from '@/components/sales-follow-ups-card'
import type { Customer, Customer360 } from '@/types'
import { formatCurrency, formatDate } from '@/lib/format'

function initials(name: string): string {
  return name.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
}

export default function Customer360Page() {
  const { name } = useParams()
  const navigate = useNavigate()
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [data, setData] = useState<Customer360 | null>(null)
  const [loyalty, setLoyalty] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!name) return
    let cancelled = false
    Promise.all([
      dbApi.customer360(decodeURIComponent(name)).catch(() => null),
      dbApi.getCustomers().catch(() => [] as Customer[]),
    ]).then(async ([d, cs]) => {
      if (cancelled) return
      const match = cs.find((c) => c.name === name) ?? null
      setData(d)
      setCustomer(match)
      // Resolve loyalty by customer id: Shopify-created customers can have a
      // blank name, which never resolves by name.
      const lb = await dbApi.loyaltyBalance(match ? match.id : decodeURIComponent(name)).catch(() => ({ found: false, balance: null }))
      if (cancelled) return
      setLoyalty(lb.found ? (lb.balance ?? 0) : null)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [name])

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-[1300px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
        <Skeleton className="h-10 w-72" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-40 rounded-lg md:col-span-2" />
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-[1300px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
        <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Card className="flex h-40 items-center justify-center text-sm text-muted-foreground">Customer not found.</Card>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[1300px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title={data.customer}
        subtitle="Single view of orders, invoices, dues, payments and loyalty."
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Contact</CardTitle>
          </CardHeader>
          <CardContent className="flex items-start gap-3">
            <Avatar className="h-10 w-10">
              <AvatarFallback className="bg-primary-100 text-primary-700">{initials(data.customer)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 space-y-1 text-sm">
              <p className="font-medium text-foreground">{data.customer}</p>
              {customer?.email ? (
                <p className="flex items-center gap-1.5 text-muted-foreground"><Mail className="h-3 w-3 shrink-0" /> <span className="truncate">{customer.email}</span></p>
              ) : null}
              {customer?.phone ? (
                <p className="flex items-center gap-1.5 text-muted-foreground"><Phone className="h-3 w-3 shrink-0" /> {customer.phone}</p>
              ) : null}
              {customer?.city ? (
                <p className="flex items-center gap-1.5 text-muted-foreground"><MapPin className="h-3 w-3 shrink-0" /> {[customer.city, customer.province].filter(Boolean).join(', ')}</p>
              ) : null}
              {customer?.status ? <Badge variant={customer.status === 'active' ? 'success' : 'outline'}>{customer.status}</Badge> : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Lifetime</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-muted-foreground">Total orders</p>
              <p className="text-xl font-bold text-foreground">{data.totalOrders}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Lifetime value</p>
              <p className="text-xl font-bold text-foreground">{formatCurrency(data.lifetimeValue)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Last order</p>
              <p className="text-sm font-medium text-foreground">{data.lastOrder ? formatDate(data.lastOrder) : '—'}</p>
            </div>
            <div>
              <p className="flex items-center gap-1 text-xs text-muted-foreground"><ShoppingBag className="h-3 w-3" /> Loyalty points</p>
              <p className="text-sm font-medium text-foreground">{loyalty ?? '—'}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm"><Wallet className="h-4 w-4 text-muted-foreground" /> Dues & Payments</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-xs text-muted-foreground">Outstanding</p>
              <p className={`text-xl font-bold ${data.outstanding > 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}>
                {formatCurrency(data.outstanding)}
              </p>
            </div>
            {data.payments.filter((p) => (p.amount ?? 0) !== 0).length > 0 ? (
              <div className="space-y-1">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Recent payments</p>
                {data.payments.slice(0, 4).map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{p.invoice ?? p.ref ?? '—'}</span>
                    <span className="shrink-0 tabular-nums font-medium">{formatCurrency(Number(p.amount ?? 0))}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No payments recorded.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <SalesFollowUpsCard customer={data.customer} title="Open follow-ups" />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Invoices</CardTitle>
          <CardDescription>Latest 25 invoices for this customer.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {data.invoices.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">No invoices yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Payment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.invoices.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell>
                      <Link to={`/sales/invoices/${inv.id}`} className="font-medium text-primary-700 hover:underline">
                        {inv.number}
                      </Link>
                    </TableCell>
                    <TableCell>{inv.date ? formatDate(inv.date) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(Number(inv.grandTotal ?? 0))}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant={inv.paymentStatus === 'paid' ? 'success' : inv.paymentStatus === 'partial' ? 'warning' : 'outline'}>
                        {inv.paymentStatus ?? '—'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Recent Orders</CardTitle>
          <CardDescription>Latest orders, including Shopify-synced ones.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {data.orders.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">No orders yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="text-right">Fulfilment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.orders.slice(0, 10).map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-mono text-[12px]">{o.internalId || o.shopifyId || o.id.slice(0, 8)}</TableCell>
                    <TableCell>{o.date ? formatDate(o.date) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(Number(o.value ?? 0))}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant={o.fulfillment === 'fulfilled' ? 'success' : 'outline'}>{o.fulfillment ?? '—'}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
