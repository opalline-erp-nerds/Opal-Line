import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  QrCode,
  FileText,
  Gem,
  LayoutDashboard,
  Package,
  Receipt,
  Search,
  ShoppingBag,
  Users,
  Building2,
  CircleDollarSign,
  type LucideIcon,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { dbApi, type SearchResults } from '@/lib/api'
import { useAuth } from '@/auth/auth-context'
import { navSections } from '@/config/navigation'

interface SearchResultGroup {
  label: string
  icon: LucideIcon
  path?: (id: string) => string
  module: string
  results: { id: string; label: string; sublabel?: string; icon: LucideIcon }[]
}

interface SearchCommandProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SearchCommand({ open, onOpenChange }: SearchCommandProps) {
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [results, setResults] = useState<SearchResults | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    // Defer the dialog reset out of the effect body (react/set-state-in-effect).
    queueMicrotask(() => {
      setQuery('')
      setActiveIndex(0)
      setTimeout(() => inputRef.current?.focus(), 30)
    })
  }, [open])

  useEffect(() => {
    // Defer out of the effect body (react/set-state-in-effect).
    queueMicrotask(() => setActiveIndex(0))
  }, [query])

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      // Defer the clear out of the effect body (react/set-state-in-effect).
      queueMicrotask(() => setResults(null))
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      dbApi
        .search(q)
        .then((d) => {
          if (!cancelled) setResults(d)
        })
        .catch(() => {
          if (!cancelled) setResults(null)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  const groups = useMemo<SearchResultGroup[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q || !results) return []
    const match = (...terms: string[]) => terms.some((t) => t?.toLowerCase().includes(q))

    // Jump-to-page group: search all navigation sections by title
    const pageGroup: SearchResultGroup = {
      label: 'Pages',
      icon: LayoutDashboard,
      module: 'dashboard',
      path: (id: string) => id,
      results: navSections
        .flatMap((section) => section.items)
        .filter((item) => match(item.title))
        .slice(0, 6)
        .map((item) => ({
          id: item.path,
          label: item.title,
          sublabel: 'Jump to page',
          icon: item.icon,
        })),
    }

    return [
      pageGroup,
      {
        label: 'Products',
        icon: Gem,
        module: 'inventory',
        path: (id: string) => `/inventory/products/${id}`,
        results: results.products
          .filter((p) => match(p.name, p.sku))
          .slice(0, 4)
          .map((p) => ({
            id: p.id,
            label: p.name,
            sublabel: `${p.sku} · ${p.stock ?? 0} pcs`,
            icon: Gem,
          })),
      },
      {
        label: 'Invoices',
        icon: FileText,
        module: 'sales',
        path: (id: string) => `/sales/invoices/${id}`,
        results: results.invoices
          .filter((i) => match(i.number, i.customer ?? '', i.shopifyOrder))
          .slice(0, 4)
          .map((i) => ({
            id: i.id,
            label: i.number,
            sublabel: `${i.customer ?? ''} · ₹${(i.grandTotal ?? 0).toLocaleString('en-IN')}`,
            icon: FileText,
          })),
      },
      {
        label: 'Shopify Orders',
        icon: ShoppingBag,
        module: 'sales',
        path: () => '/sales/orders',
        results: results.salesOrders
          .filter((o) => match(o.shopifyId, o.internalId, o.customer))
          .slice(0, 4)
          .map((o) => ({
            id: o.id,
            label: o.shopifyId,
            sublabel: `${o.customer} · ₹${o.value.toLocaleString('en-IN')}`,
            icon: ShoppingBag,
          })),
      },
      {
        label: 'Customers',
        icon: Users,
        module: 'sales',
        path: () => '/sales/customers',
        results: results.customers
          .filter((c) => match(c.name, c.email ?? '', c.phone ?? ''))
          .slice(0, 4)
          .map((c) => ({
            id: c.id,
            label: c.name,
            sublabel: c.email ?? '',
            icon: Users,
          })),
      },
      {
        label: 'Purchase Invoices',
        icon: Receipt,
        module: 'purchase',
        path: () => '/purchase/invoices',
        results: results.purchaseInvoices
          .filter((p) => match(p.number, p.supplier))
          .slice(0, 3)
          .map((p) => ({
            id: p.id,
            label: p.number,
            sublabel: `${p.supplier} · ₹${p.total.toLocaleString('en-IN')}`,
            icon: Receipt,
          })),
      },
      {
        label: 'Suppliers',
        icon: Building2,
        module: 'purchase',
        path: () => '/purchase/suppliers',
        results: results.suppliers
          .filter((s) => match(s.name, s.contact))
          .slice(0, 3)
          .map((s) => ({
            id: s.id,
            label: s.name,
            sublabel: s.city ?? '',
            icon: Building2,
          })),
      },
      {
        label: 'Razorpay Payments',
        icon: CircleDollarSign,
        module: 'accounts',
        path: () => '/accounts/payments',
        results: results.payments
          .filter((p) => match(p.ref, p.invoice))
          .slice(0, 3)
          .map((p) => ({
            id: p.id,
            label: p.ref,
            sublabel: `${p.invoice} · ₹${p.amount.toLocaleString('en-IN')}`,
            icon: CircleDollarSign,
          })),
      },
    ].filter((g) => g.results.length > 0 && hasPermission(g.module, 'view'))
  }, [query, results, hasPermission])

  const flat = useMemo(
    () =>
      groups.flatMap((g) =>
        g.results.map((r) => ({
          group: g,
          result: r,
        })),
      ),
    [groups],
  )

  useEffect(() => {
    if (!open || flat.length === 0) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => Math.min(i + 1, flat.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const current = flat[activeIndex]
        if (current) {
          const path = current.group.path?.(current.result.id) ?? '/'
          onOpenChange(false)
          navigate(path)
        }
      } else if (e.key === 'Escape') {
        onOpenChange(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, flat, activeIndex, navigate, onOpenChange])

  let runningIndex = 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideClose className="max-w-xl overflow-hidden p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>Global Search</DialogTitle>
          <DialogDescription>Search across the entire ERP</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products, SKU, invoices, orders, customers..."
            className="h-8 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
          />
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground">
            ESC
          </kbd>
        </div>

        <div className="max-h-[420px] overflow-y-auto p-2">
          {query.trim() === '' ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <div className="rounded-full bg-muted p-3">
                <QrCode className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">Search the Opal Line ERP</p>
              <p className="text-xs text-muted-foreground">
                Try "ring", "SI-2026-00047", "#10235" or "Rajesh Kumar"
              </p>
            </div>
          ) : flat.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-medium text-foreground">No results found</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Nothing matched "{query}". Try a different search term.
              </p>
            </div>
          ) : (
            groups.map((group) => {
              const start = runningIndex
              runningIndex += group.results.length
              return (
                <div key={group.label} className="mb-1">
                  <p className="px-2 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </p>
                  {group.results.map((r, offset) => {
                    const index = start + offset
                    const active = index === activeIndex
                    return (
                      <button
                        key={r.id}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => {
                          const path = group.path?.(r.id) ?? '/'
                          onOpenChange(false)
                          navigate(path)
                        }}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors',
                          active ? 'bg-primary-50' : 'hover:bg-muted',
                        )}
                      >
                        <div
                          className={cn(
                            'rounded-md p-1.5',
                            active ? 'bg-primary-100 text-primary-700' : 'bg-muted text-muted-foreground',
                          )}
                        >
                          <r.icon className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className={cn('truncate text-[13px] font-medium', active ? 'text-primary-800' : 'text-foreground')}>
                            {r.label}
                          </p>
                          {r.sublabel ? (
                            <p className="truncate text-[11px] text-muted-foreground">{r.sublabel}</p>
                          ) : null}
                        </div>
                        <span className="shrink-0 text-[10px] font-medium uppercase text-muted-foreground">
                          {active ? '↵' : <Package className="h-3 w-3 opacity-0" />}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>

        <div className="flex items-center gap-4 border-t bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <kbd className="rounded border bg-card px-1 font-mono text-[10px]">↑</kbd>
            <kbd className="rounded border bg-card px-1 font-mono text-[10px]">↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border bg-card px-1 font-mono text-[10px]">↵</kbd>
            select
          </span>
          <span className="ml-auto">{flat.length} results</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
