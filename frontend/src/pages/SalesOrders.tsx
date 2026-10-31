import { confirmDialog, toast } from '@/components/ui/confirm'
import { ProductDialog } from '@/components/product-dialog'
import { ManualInvoiceDialog } from '@/components/manual-invoice-dialog'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ColumnDef } from '@/lib/table'
import {
  AlertTriangle,
  BookmarkPlus,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileText,
  ListChecks,
  MessageCircle,
  Package,
  MoreHorizontal,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  ScanQrCode,
  Search,
  UserRoundCheck,
  ShoppingBag,
  Trash2,
  X,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import { DataTable } from '@/components/ui/data-table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { dbApi, shopifyApi, printTemplatesApi, formatApiError } from '@/lib/api'
import { computeLineStockErrors, stockErrorsFromApiError } from '@/lib/orderStock'
import {
  findVariantById,
  matchProductByCode,
  productVariants,
  variantLabel,
  variantOptions,
} from '@/lib/productVariants'
import { printDocument, printDocuments, mergePrintConfig, DEFAULT_PRINT_CONFIG, type PrintDoc, type PrintDesignerConfig } from '@/lib/printTemplate'
import { exportTable } from '@/lib/export'
import type { Customer, Customer360, InventoryLocation, OrderEvent, OrderFullDetail, OrderStatus, Product, ProductVariant, SalesOrder } from '@/types'
import { cn } from '@/lib/utils'
import { formatCurrency, formatDate, formatDateTime, todayIST } from '@/lib/format'
import { perUnitLinePrice, orderLinesTotal } from '@/lib/orderPricing'

const statusMeta: Record<OrderStatus, { label: string; variant: 'success' | 'warning' | 'danger' | 'muted' | 'info' | 'purple' }> = {
  imported: { label: 'Imported', variant: 'info' },
  confirmed: { label: 'Confirmed', variant: 'purple' },
  processing: { label: 'Processing', variant: 'warning' },
  fulfilled: { label: 'Fulfilled', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'muted' },
  returned: { label: 'Returned', variant: 'warning' },
  refunded: { label: 'Refunded', variant: 'muted' },
}

const paymentMeta: Record<string, { label: string; variant: 'success' | 'warning' | 'muted' | 'info' }> = {
  paid: { label: 'Paid', variant: 'success' },
  pending: { label: 'Pending', variant: 'warning' },
  cod: { label: 'COD', variant: 'warning' },
  bank: { label: 'Bank Transfer', variant: 'info' },
  refunded: { label: 'Refunded', variant: 'muted' },
  Online: { label: 'Paid', variant: 'success' },
  online: { label: 'Paid', variant: 'success' },
  partially_paid: { label: 'Partial', variant: 'warning' },
  partially_refunded: { label: 'Partial Refund', variant: 'info' },
  voided: { label: 'Voided', variant: 'muted' },
}

function getPaymentMeta(val: string) {
  return paymentMeta[val] ?? { label: val || 'Unknown', variant: 'muted' as const }
}

const fulfillmentMeta: Record<string, { label: string; variant: 'success' | 'warning' | 'muted' | 'info' }> = {
  unfulfilled: { label: 'Unfulfilled', variant: 'muted' },
  pending: { label: 'Unfulfilled', variant: 'muted' },
  partial: { label: 'Partial', variant: 'warning' },
  fulfilled: { label: 'Fulfilled', variant: 'success' },
  processing: { label: 'Processing', variant: 'warning' },
  returned: { label: 'Returned', variant: 'muted' },
  restocked: { label: 'Restocked', variant: 'info' },
}

function getFulfillmentMeta(val: string) {
  return fulfillmentMeta[val] ?? { label: val || 'Unknown', variant: 'muted' as const }
}

interface OrderLineItem {
  key: string
  productId: string
  /** Selected variant, when the product has variants. */
  variantId?: string | null
  title: string
  sku: string
  qty: number
  price: number
  // Product fields needed for price recalculation
  netWeight?: number
  makingCharge?: number
}

interface CreateResult {
  order: SalesOrder
  shopifySync: { ok: boolean; draftId?: string; name?: string; completed?: boolean; errors: string[]; message?: string } | null
}

interface OrderAddress {
  name: string
  phone: string
  address1: string
  city: string
  province: string
  zip: string
  country: string
}

function emptyAddress(): OrderAddress {
  return { name: '', phone: '', address1: '', city: '', province: '', zip: '', country: '' }
}

function hasAddress(a: OrderAddress): boolean {
  return Boolean(
    a.name.trim() ||
      a.phone.trim() ||
      a.address1.trim() ||
      a.city.trim() ||
      a.province.trim() ||
      a.zip.trim() ||
      a.country.trim(),
  )
}

function toAddressPayload(a: OrderAddress, fallbackName: string): Record<string, string> | undefined {
  const name = a.name.trim() || fallbackName.trim()
  const out: Record<string, string> = {}
  if (name) out.name = name
  if (a.phone.trim()) out.phone = a.phone.trim()
  if (a.address1.trim()) out.address1 = a.address1.trim()
  if (a.city.trim()) out.city = a.city.trim()
  if (a.province.trim()) out.province = a.province.trim()
  if (a.zip.trim()) out.zip = a.zip.trim()
  if (a.country.trim()) out.country = a.country.trim()
  return Object.keys(out).length ? out : undefined
}

let lineSeq = 0

function emptyLine(): OrderLineItem {
  return { key: `li-${++lineSeq}`, productId: '', title: '', sku: '', qty: 1, price: 0 }
}

export default function SalesOrdersPage() {
  const navigate = useNavigate()
  const [orders, setOrders] = useState<SalesOrder[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [products, setProducts] = useState<Product[]>([])
  // Line key whose "New product…" row opened the product dialog (null = closed).
  const [newProductLineKey, setNewProductLineKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [colVis, setColVis] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('ordervis-cols') ?? '{}')
    } catch {
      return {}
    }
  })
  const handleColVis = useCallback((v: Record<string, boolean>) => {
    setColVis(v)
    try {
      localStorage.setItem('ordervis-cols', JSON.stringify(v))
    } catch { /* ignore */ }
  }, [])

  // Saved views: {name, query, status} persisted in localStorage
  interface SavedView { name: string; query: string; status: string }
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('ordervis-views') ?? '[]')
    } catch {
      return []
    }
  })
  const [viewName, setViewName] = useState('')
  const [viewDialogOpen, setViewDialogOpen] = useState(false)
  const saveView = () => {
    const name = viewName.trim() || `View ${savedViews.length + 1}`
    const next = [...savedViews.filter((v) => v.name !== name), { name, query: query.trim(), status }].slice(-8)
    setSavedViews(next)
    try { localStorage.setItem('ordervis-views', JSON.stringify(next)) } catch { /* ignore */ }
    setViewName('')
    setViewDialogOpen(false)
  }
  const deleteView = (name: string) => {
    const next = savedViews.filter((v) => v.name !== name)
    setSavedViews(next)
    try { localStorage.setItem('ordervis-views', JSON.stringify(next)) } catch { /* ignore */ }
  }
  const applyView = (v: SavedView) => {
    setQuery(v.query)
    setStatus(v.status)
  }

  const [dialogOpen, setDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [created, setCreated] = useState<CreateResult | null>(null)
  const [editing, setEditing] = useState<SalesOrder | null>(null)
  // Order-form snapshot as of dialog open, for the unsaved-changes close guard.
  const [formBaseline, setFormBaseline] = useState('')

  const [customerSel, setCustomerSel] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [billingAddr, setBillingAddr] = useState<OrderAddress>(emptyAddress())
  const [shippingAddr, setShippingAddr] = useState<OrderAddress>(emptyAddress())
  const [sameAsBilling, setSameAsBilling] = useState(true)
  const [orderDate, setOrderDate] = useState(todayIST())
  const [payment, setPayment] = useState('paid')
  const [fulfillment, setFulfillment] = useState('unfulfilled')
  const [orderStatus, setOrderStatus] = useState('confirmed')
  // Which shop this document belongs to. Stock movements follow it, so picking
  // the wrong one puts the goods on the wrong shelf.
  const [locations, setLocations] = useState<InventoryLocation[]>([])
  const [locationId, setLocationId] = useState('')

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      dbApi.getInventoryLocations()
        .then((locs) => {
          if (cancelled || !locs.length) return
          setLocations(locs)
          setLocationId((prev) => prev || locs[0].id)
        })
        .catch(() => undefined)
    })
    return () => { cancelled = true }
  }, [])

  const [note, setNote] = useState('')
  const [syncToShopify, setSyncToShopify] = useState(true)
  const [lineItems, setLineItems] = useState<OrderLineItem[]>([emptyLine()])
  // Stock shortfalls reported by the order endpoints, keyed by line key. The
  // live per-line check below handles the common case; this holds the
  // server's authoritative per-location answer until the line is edited.
  const [serverStockErrors, setServerStockErrors] = useState<Record<string, string>>({})
  const [scanInput, setScanInput] = useState('')
  const [scanFeedback, setScanFeedback] = useState<{ ok: boolean; text: string } | null>(null)
  const [silverRate, setSilverRate] = useState<number | null>(null)
  const [silverRateLoading, setSilverRateLoading] = useState(false)

  const [viewOrder, setViewOrder] = useState<SalesOrder | null>(null)
  const [printConfig, setPrintConfig] = useState<unknown>(null)
  // Fulfilment docs fall back to defaults until their saved designs load.
  const [packingConfig, setPackingConfig] = useState<PrintDesignerConfig>(DEFAULT_PRINT_CONFIG)
  const [pickConfig, setPickConfig] = useState<PrintDesignerConfig>(DEFAULT_PRINT_CONFIG)
  const [selectedOrders, setSelectedOrders] = useState<SalesOrder[]>([])
  const [bulkBusy, setBulkBusy] = useState(false)
  const [invoiceSavingId, setInvoiceSavingId] = useState<string | null>(null)
  const [syncingOrders, setSyncingOrders] = useState(false)
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // Manual invoice creation — the same dialog the Sales Invoices page uses, so
  // a walk-in / phone sale can be billed from either screen. The row action
  // seeds the buyer from the order it was opened on.
  const [manualInvoiceOpen, setManualInvoiceOpen] = useState(false)
  const [manualInvoiceOrder, setManualInvoiceOrder] = useState<SalesOrder | null>(null)

  const openManualInvoice = useCallback((order: SalesOrder | null) => {
    setManualInvoiceOrder(order)
    setManualInvoiceOpen(true)
  }, [])

  const reload = useCallback(() => {
    dbApi.getSalesOrders().then(setOrders).catch(() => {})
  }, [])

  const bulkInvoice = async () => {
    if (selectedOrders.length === 0) return
    if (!(await confirmDialog({ title: `Create invoices for ${selectedOrders.length} order(s)? Orders already invoiced are skipped.` }))) return
    setBulkBusy(true)
    try {
      const r = await dbApi.bulkOrderInvoice(selectedOrders.map((o) => o.id))
      const parts = [`${r.created} invoice(s) created`]
      if (r.alreadyInvoiced > 0) parts.push(`${r.alreadyInvoiced} already invoiced`)
      if (r.failed > 0) parts.push(`${r.failed} failed`)
      toast.success(parts.join(', '))
      setSelectedOrders([])
      reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bulk invoicing failed')
    } finally {
      setBulkBusy(false)
    }
  }

  const bulkStatus = async (status: string) => {
    if (selectedOrders.length === 0) return
    if (!(await confirmDialog({ title: `Set ${selectedOrders.length} order(s) to "${status}"?` }))) return
    setBulkBusy(true)
    try {
      const r = await dbApi.bulkOrderStatus(selectedOrders.map((o) => o.id), status)
      toast.success(`${r.updated} order(s) updated to ${r.status}${r.invoicesCreated ? ` · ${r.invoicesCreated} invoice(s) created` : ''}`)
      setSelectedOrders([])
      reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bulk status update failed')
    } finally {
      setBulkBusy(false)
    }
  }

  useEffect(() => {
    Promise.all([dbApi.getSalesOrders(), dbApi.getCustomers(), dbApi.getProducts()])
      .then(([o, c, p]) => {
        setOrders(o)
        setCustomers(c)
        setProducts(p)
        setLoading(false)
      })
      .catch(() => setLoading(false))
    printTemplatesApi.getDefault('order').then((r) => setPrintConfig(r.config)).catch(() => {})
    printTemplatesApi.getDefault('packing-slip').then((r) => setPackingConfig(mergePrintConfig(r.config))).catch(() => {})
    printTemplatesApi.getDefault('pick-list').then((r) => setPickConfig(mergePrintConfig(r.config))).catch(() => {})
  }, [])

  const buildOrderPrintDoc = (o: SalesOrder): PrintDoc => {
    const items = o.lineItems ?? []
    const subtotal = items.reduce((a, li) => a + (li.price ?? 0) * (li.quantity ?? 0), 0) || o.value
    const billing = (o.billingAddress ?? {}) as Record<string, string>
    const shipping = (o.shippingAddress ?? {}) as Record<string, string>
    const addr = shipping.address1 || billing.address1 || ''
    return {
      number: o.shopifyId,
      shopifyOrder: o.shopifyId,
      customer: o.customer,
      customerEmail: customers.find((c) => c.name === o.customer)?.email || '',
      customerPhone: shipping.phone || billing.phone || '',
      customerAddress: addr || undefined,
      customerCity: shipping.city || billing.city || undefined,
      customerState: shipping.province || billing.province || undefined,
      customerPincode: shipping.zip || billing.zip || undefined,
      gst: 0,
      gstAmount: 0,
      discount: o.discount ?? 0,
      subtotal,
      grandTotal: o.value,
      paymentMethod: o.payment,
      paymentStatus: o.fulfillment,
      date: o.date,
      items: items.map((li) => ({
        product: li.title,
        sku: li.sku ?? '',
        hsn: '',
        qty: li.quantity,
        weight: 0,
        silverRate: li.price,
        makingCharge: 0,
        tax: 0,
        amount: (li.price ?? 0) * (li.quantity ?? 0),
        // Product photo for fulfilment docs (packing slip / pick list).
        image: products.find((p) => p.sku === (li.sku ?? ''))?.image ?? undefined,
      })),
    }
  }

  const printOrder = (o: SalesOrder) => {
    printDocument(buildOrderPrintDoc(o), mergePrintConfig(printConfig), {
      docType: 'order',
      tagline: '92.5 Sterling Silver Jewellery',
      totalLabel: 'ORDER VALUE',
      terms: o.isBooking ? 'This is a booking confirmation, not a tax invoice.' : undefined,
    })
  }

  const printFulfilment = (o: SalesOrder, docType: 'packing-slip' | 'pick-list') => {
    const config = docType === 'packing-slip' ? packingConfig : pickConfig
    printDocument(buildOrderPrintDoc(o), config, {
      docType,
      tagline: '92.5 Sterling Silver Jewellery',
      billToLabel: docType === 'packing-slip' ? 'Deliver To' : 'Staging For',
      showImages: true,
    })
  }

  // Bulk print fulfilment docs: one print window per order with line items
  // (itemless orders are skipped — a packing slip with no products is noise).
  const bulkPrintFulfilment = (docType: 'packing-slip' | 'pick-list') => {
    if (selectedOrders.length === 0) return
    const withItems = selectedOrders.filter((o) => (o.lineItems ?? []).length > 0)
    if (withItems.length === 0) {
      toast.error('Selected orders have no line items to print.')
      return
    }
    const config = docType === 'packing-slip' ? packingConfig : pickConfig
    void printDocuments(
      withItems.map((o) => ({
        doc: buildOrderPrintDoc(o),
        config,
        extras: {
          docType,
          tagline: '92.5 Sterling Silver Jewellery',
          billToLabel: docType === 'packing-slip' ? 'Deliver To' : 'Staging For',
          showImages: true,
        },
      })),
    )
    if (withItems.length < selectedOrders.length) {
      toast.info(`${selectedOrders.length - withItems.length} order(s) without line items were skipped.`)
    }
  }

  const cancelOrder = useCallback(async (o: SalesOrder) => {
    if (!(await confirmDialog({ title: `Cancel order ${o.shopifyId}?` }))) return
    try {
      await dbApi.update('sales-orders', o.id, { status: 'cancelled' })
      setOrders((prev) => prev.map((x) => (x.id === o.id ? { ...x, status: 'cancelled' } : x)))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not cancel order')
    }
  }, [])

  const refreshFromShopify = useCallback(async (o: SalesOrder) => {
    setInvoiceSavingId(o.id)
    try {
      const res = await shopifyApi.refreshOrder(o.id)
      if (res.ok) {
        toast.success(`Order ${o.shopifyId ?? ''} refreshed from Shopify`)
        dbApi.getSalesOrders().then((r) => setOrders(r)).catch(() => undefined)
      } else {
        toast.error(res.message ?? 'Refresh failed')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      setInvoiceSavingId(null)
    }
  }, [])

  const createInvoiceFor = useCallback(
    async (o: SalesOrder) => {
      if (invoiceSavingId) return
      setInvoiceSavingId(o.id)
      try {
        // Server-side creation: same pipeline as auto-invoice (idempotent,
        // consistent numbering, full customer snapshot, stock deduction).
        const result = await dbApi.createInvoiceForOrder(o.id)
        if (!result.invoiceNumber) throw new Error('Order has no line items to invoice')
        setOrders((prev) => prev.map((x) => (x.id === o.id ? { ...x, invoice: result.invoiceNumber! } : x)))
        navigate(`/sales/invoices?highlight=${encodeURIComponent(result.invoiceNumber)}`)
      } catch (err) {
        toast.error(formatApiError(err, 'Could not create invoice'))
      } finally {
        setInvoiceSavingId(null)
      }
    },
    [navigate, invoiceSavingId],
  )

  const viewOnShopify = useCallback(async (o: SalesOrder) => {
    try {
      const s = await shopifyApi.getStatus()
      if (!s.store) {
        toast.error('Shopify is not configured.')
        return
      }
      const base = `https://${s.store}.myshopify.com/admin`
      const query = encodeURIComponent(o.shopifyId.replace(/^#/, ''))
      window.open(`${base}/orders?query=${query}`, '_blank', 'noopener')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open Shopify')
    }
  }, [])

  const syncOrders = async () => {
    setSyncingOrders(true)
    setSyncMsg(null)
    try {
      const res = await shopifyApi.syncOrders()
      if (res.ok) {
        setSyncMsg({
          ok: true,
          text: `Synced Shopify orders: ${res.imported} new, ${res.updated} updated.`,
        })
        reload()
      } else {
        setSyncMsg({ ok: false, text: res.message ?? res.errors[0] ?? 'Shopify order sync failed.' })
      }
    } catch (err) {
      setSyncMsg({ ok: false, text: err instanceof Error ? err.message : 'Shopify order sync failed.' })
    } finally {
      setSyncingOrders(false)
    }
  }

  const repairPii = async () => {
    if (
      !(await confirmDialog({
        title: 'Repair order customer details?',
        description:
          'Orders showing "Guest" get their customer name, email and address backfilled from matching local customer records (by email or phone). Nothing is pushed to Shopify, and orders with real names are never touched.',
        confirmLabel: 'Repair',
      }))
    )
      return
    setSyncingOrders(true)
    setSyncMsg(null)
    try {
      const res = await dbApi.repairOrderPii()
      setSyncMsg({
        ok: true,
        text: `Repaired ${res.repaired.length} order(s) from local customer records${res.unmatched.length ? ` — ${res.unmatched.length} could not be matched (use PII recovery on the Shopify page)` : ''}.`,
      })
      reload()
    } catch (err) {
      setSyncMsg({ ok: false, text: err instanceof Error ? err.message : 'Repair failed.' })
    } finally {
      setSyncingOrders(false)
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return orders.filter((o) => {
      const matchQ =
        !q ||
        o.shopifyId.toLowerCase().includes(q) ||
        o.internalId.toLowerCase().includes(q) ||
        o.customer.toLowerCase().includes(q)
      const matchS = !status || o.status === status
      return matchQ && matchS
    })
  }, [orders, query, status])

  const startEdit = useCallback((o: SalesOrder) => {
    setEditing(o)
    setFormError('')
    setServerStockErrors({})
    setCreated(null)
    const c = customers.find((x) => x.name === o.customer)
    setCustomerSel(c ? c.name : '__new__')
    setCustomerName(o.customer)
    setCustomerEmail(c?.email ?? '')
    setCustomerPhone(c?.phone ?? '')
    setBillingAddr(o.billingAddress && typeof o.billingAddress === 'object' ? { ...emptyAddress(), ...(o.billingAddress as Record<string, string>) } : emptyAddress())
    setShippingAddr(o.shippingAddress && typeof o.shippingAddress === 'object' ? { ...emptyAddress(), ...(o.shippingAddress as Record<string, string>) } : emptyAddress())
    setSameAsBilling(!o.shippingAddress)
    setOrderDate(String(o.date).slice(0, 10))
    setPayment(o.payment)
    setFulfillment(o.fulfillment)
    setOrderStatus(o.status)
    setNote('')
    setSyncToShopify(Boolean(o.shopifyId && o.shopifyId.startsWith('#')))
    setLineItems(
      o.lineItems && o.lineItems.length > 0
        ? o.lineItems.map((li) => ({ key: crypto.randomUUID(), productId: '', title: li.title, sku: li.sku ?? '', qty: li.quantity, price: li.price }))
        : [emptyLine()],
    )
    setSilverRate(null)
    setDialogOpen(true)
    // Fetch the current applied silver rate
    setSilverRateLoading(true)
    dbApi.getSilverRate()
      .then((rate) => {
        setSilverRate(rate.rate)
        setSilverRateLoading(false)
      })
      .catch(() => {
        setSilverRateLoading(false)
      })
  }, [customers])

  /** Clone a past order into a fresh draft — same customer/items, today's date, nothing synced. */
  const duplicateOrder = useCallback((o: SalesOrder) => {
    setEditing(null)
    setFormError('')
    setServerStockErrors({})
    setCreated(null)
    const c = customers.find((x) => x.name === o.customer)
    setCustomerSel(c ? c.name : '__new__')
    setCustomerName(o.customer)
    setCustomerEmail(c?.email ?? '')
    setCustomerPhone(c?.phone ?? '')
    setBillingAddr(o.billingAddress && typeof o.billingAddress === 'object' ? { ...emptyAddress(), ...(o.billingAddress as Record<string, string>) } : emptyAddress())
    setShippingAddr(o.shippingAddress && typeof o.shippingAddress === 'object' ? { ...emptyAddress(), ...(o.shippingAddress as Record<string, string>) } : emptyAddress())
    setSameAsBilling(!o.shippingAddress)
    setOrderDate(new Date().toISOString().slice(0, 10))
    setPayment(o.payment)
    setFulfillment(o.fulfillment)
    setOrderStatus(o.status)
    setNote('')
    setSyncToShopify(false)
    setLineItems(
      o.lineItems && o.lineItems.length > 0
        ? o.lineItems.map((li) => ({ key: crypto.randomUUID(), productId: '', title: li.title, sku: li.sku ?? '', qty: li.quantity, price: li.price }))
        : [emptyLine()],
    )
    setSilverRate(null)
    setDialogOpen(true)
    // Fetch the current applied silver rate
    setSilverRateLoading(true)
    dbApi.getSilverRate()
      .then((rate) => {
        setSilverRate(rate.rate)
        setSilverRateLoading(false)
      })
      .catch(() => {
        setSilverRateLoading(false)
      })
  }, [customers])

  const columns = useMemo<ColumnDef<SalesOrder>[]>(
    () => [
      {
        accessorKey: 'shopifyId',
        header: 'Shopify Order',
        meta: { headerClassName: 'min-w-[170px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-info-50 text-info-700">
              <ShoppingBag className="h-4 w-4" />
            </div>
            <div>
              <p className="font-mono font-medium text-foreground">{row.original.shopifyId}</p>
              <p className="text-[11px] text-muted-foreground">{row.original.internalId}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'customer',
        header: 'Customer',
        cell: ({ row }) => (
          <div>
            <p className="font-medium text-foreground">{row.original.customer}</p>
            <p className="text-[11px] text-muted-foreground">{row.original.items} items · {formatDate(row.original.date)}</p>
          </div>
        ),
      },
      {
        // What was actually ordered — titles/SKUs from the order's line items,
        // not just the money. Falls back to a dash for header-only rows.
        id: 'products',
        header: 'Products',
        meta: { headerClassName: 'min-w-[180px]' },
        cell: ({ row }) => {
          const items = row.original.lineItems ?? []
          if (items.length === 0) return <span className="text-xs text-muted-foreground">—</span>
          const first = items[0]
          return (
            <div className="min-w-0 max-w-[280px]">
              <p className="truncate text-[12.5px] text-foreground">
                <span className="font-medium">{first.title || first.sku || 'Item'}</span> ×{first.quantity ?? 1}
              </p>
              {items.length > 1 ? (
                <p className="truncate text-[11px] text-muted-foreground">
                  {items.slice(1, 4).map((li) => `${li.title || li.sku || 'Item'} ×${li.quantity ?? 1}`).join(', ')}
                  {items.length > 4 ? ` +${items.length - 4} more` : ''}
                </p>
              ) : null}
            </div>
          )
        },
      },
      {
        accessorKey: 'value',
        header: 'Order Value',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="font-semibold tabular-nums text-foreground">{formatCurrency(row.original.value)}</span>,
      },
      {
        id: 'payment',
        header: 'Payment',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const p = getPaymentMeta(row.original.payment)
          return <Badge variant={p.variant} dot>{p.label}</Badge>
        },
      },
      {
        id: 'fulfillment',
        header: 'Fulfillment',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const f = getFulfillmentMeta(row.original.fulfillment)
          return <Badge variant={f.variant}>{f.label}</Badge>
        },
      },
      {
        accessorKey: 'invoice',
        header: 'Invoice',
        cell: ({ row }) =>
          row.original.invoice ? (
            <button
              type="button"
              className="font-mono text-[12px] font-medium text-primary-700 hover:underline"
              onClick={(e) => {
                e.stopPropagation()
                navigate('/sales/invoices')
              }}
            >
              {row.original.invoice}
            </button>
          ) : (
            <Badge variant="muted">Not raised</Badge>
          ),
      },
      {
        id: 'status',
        header: 'Status',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const s = statusMeta[row.original.status as OrderStatus] ?? { label: row.original.status || 'Unknown', variant: 'muted' as const }
          return <Badge variant={s.variant} dot>{s.label}</Badge>
        },
      },
      {
        id: 'actions',
        header: 'Actions',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-0.5">
            <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`View order ${row.original.shopifyId}`} onClick={() => setViewOrder(row.original)}>
                <Eye className="h-3.5 w-3.5" />
              </Button>
              </TooltipTrigger>
              <TooltipContent>View order</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Edit order ${row.original.shopifyId}`} onClick={() => startEdit(row.original)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              </TooltipTrigger>
              <TooltipContent>Edit order</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Duplicate order ${row.original.shopifyId}`} onClick={() => duplicateOrder(row.original)}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
              </TooltipTrigger>
              <TooltipContent>Duplicate as new order</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={Boolean(row.original.invoice) || invoiceSavingId === row.original.id}
                onClick={() => createInvoiceFor(row.original)}
              >
                {invoiceSavingId === row.original.id ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
              </Button>
              </TooltipTrigger>
              <TooltipContent>{row.original.invoice ? 'Invoice raised' : 'Create invoice'}</TooltipContent>
            </Tooltip>
            <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-xs text-muted-foreground">More actions</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => viewOnShopify(row.original)}>
                <ExternalLink className="h-3.5 w-3.5" /> View on Shopify
              </DropdownMenuItem>
              {row.original.shopifyId && (
                <DropdownMenuItem disabled={invoiceSavingId === row.original.id} onClick={() => refreshFromShopify(row.original)}>
                  <RefreshCw className={`h-3.5 w-3.5 ${invoiceSavingId === row.original.id ? 'animate-spin' : ''}`} /> Refresh from Shopify
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => openManualInvoice(row.original)}>
                <FileText className="h-3.5 w-3.5" /> New invoice for this customer
              </DropdownMenuItem>
              <DropdownMenuItem className="text-red-600 dark:text-red-400 focus:text-red-600 dark:text-red-400" onClick={() => cancelOrder(row.original)}>Cancel Order</DropdownMenuItem>
            </DropdownMenuContent>
            </DropdownMenu>
            </TooltipProvider>
          </div>
        ),
      },
    ],
    [navigate, cancelOrder, createInvoiceFor, viewOnShopify, refreshFromShopify, invoiceSavingId, startEdit, duplicateOrder, openManualInvoice],
  )

  const snapshotForm = () =>
    JSON.stringify({
      customerSel,
      customerName,
      customerEmail,
      customerPhone,
      billingAddr,
      shippingAddr,
      sameAsBilling,
      orderDate,
      payment,
      fulfillment,
      orderStatus,
      note,
      syncToShopify,
      lineItems,
    })

  // Capture the freshly reset form each time the dialog opens (create, edit
  // and duplicate all set the fields right before setDialogOpen(true)).
  useEffect(() => {
    if (dialogOpen) setFormBaseline(snapshotForm())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen])

  const openDialog = () => {
    setEditing(null)
    setFormError('')
    setServerStockErrors({})
    setCreated(null)
    setCustomerSel('')
    setCustomerName('')
    setCustomerEmail('')
    setCustomerPhone('')
    setBillingAddr(emptyAddress())
    setShippingAddr(emptyAddress())
    setSameAsBilling(true)
    setOrderDate(todayIST())
    setPayment('paid')
    setFulfillment('unfulfilled')
    setOrderStatus('confirmed')
    setNote('')
    setSyncToShopify(true)
    setLineItems([emptyLine()])
    setSilverRate(null)
    setDialogOpen(true)
    // Fetch the current applied silver rate from Silver Rate Management
    setSilverRateLoading(true)
    dbApi.getSilverRate()
      .then((rate) => {
        setSilverRate(rate.rate)
        setSilverRateLoading(false)
      })
      .catch(() => {
        setSilverRateLoading(false)
      })
  }

  const totalValue = useMemo(() => orderLinesTotal(lineItems), [lineItems])

  // Live stock check per line: mirrors the order endpoints' per-line
  // validation against the catalog already loaded, so an over-quantity shows
  // under its own Qty field the moment it is typed. Variant lines carry the
  // variant's own stock; flat lines fall back to the product rollup.
  const stockByProductId = useMemo(() => new Map(products.map((p) => [p.id, p.stock])), [products])
  const variantById = useMemo(() => {
    const m = new Map<string, ProductVariant>()
    for (const p of products) for (const v of productVariants(p)) m.set(v.id, v)
    return m
  }, [products])
  const variantCountByProductId = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of products) {
      const n = productVariants(p).length
      if (n > 0) m.set(p.id, n)
    }
    return m
  }, [products])
  const stockCheckLines = useMemo(
    () =>
      lineItems.map((li) => ({
        ...li,
        stock: li.variantId ? (variantById.get(li.variantId)?.stock ?? undefined) : undefined,
      })),
    [lineItems, variantById],
  )
  const lineStockErrors = useMemo(() => {
    const merged: Record<string, string> = { ...serverStockErrors }
    for (const [key, msg] of Object.entries(computeLineStockErrors(stockCheckLines, stockByProductId))) {
      merged[key] = msg
    }
    return merged
  }, [stockCheckLines, stockByProductId, serverStockErrors])

  const clearServerStockError = (key: string) => {
    setServerStockErrors((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const selectProduct = (key: string, productId: string) => {
    const p = products.find((x) => x.id === productId)
    if (!p) return
    clearServerStockError(key)
    // Multi-variant products open on their first variant so the line is
    // immediately billable; the Variant dropdown swaps it. Flat products keep
    // the plain product values, exactly as before.
    const first = productVariants(p)[0] ?? null
    const price = perUnitLinePrice({
      silverRate,
      netWeight: p.netWeight,
      makingCharge: p.makingCharge,
      fallback: first?.sellingPrice ?? p.sellingPrice,
    })
    setLineItems((prev) =>
      prev.map((li) => {
        if (li.key !== key) return li
        return {
          ...li,
          productId,
          variantId: first?.id ?? null,
          title: first && p ? `${p.name} — ${variantLabel(first)}` : (p?.name ?? li.title),
          sku: first ? first.sku : (p?.sku ?? li.sku),
          price: price ?? li.price,
          netWeight: p.netWeight,
          makingCharge: p.makingCharge,
        }
      }),
    )
  }

  // Swap the variant on a line of a multi-variant product: its SKU, price and
  // (via variantById) stock all follow the selection.
  const selectVariant = (key: string, variantId: string) => {
    const li = lineItems.find((x) => x.key === key)
    const p = products.find((x) => x.id === (li?.productId ?? ''))
    const v = findVariantById(p ?? null, variantId)
    if (!p || !v) return
    clearServerStockError(key)
    setLineItems((prev) =>
      prev.map((row) =>
        row.key === key
          ? {
              ...row,
              variantId: v.id,
              title: `${p.name} — ${variantLabel(v)}`,
              sku: v.sku,
              price: perUnitLinePrice({
                silverRate,
                netWeight: p.netWeight,
                makingCharge: p.makingCharge,
                fallback: v.sellingPrice ?? row.price,
              }) ?? row.price,
              netWeight: p.netWeight,
              makingCharge: p.makingCharge,
            }
          : row,
      ),
    )
  }

  // Label scan: scanners type the code and press Enter instantly, so a plain
  // input with an Enter handler works. A label's QR encodes ONLY the SKU, so
  // resolution is product SKU → variant SKU (exact, case-insensitive).
  // Re-scanning the same product/variant pair bumps its quantity.
  const handleScan = () => {
    const code = scanInput.trim()
    const match = matchProductByCode(products, code)
    setScanInput('')
    if (!match) {
      setScanFeedback({ ok: false, text: `No product matches "${code}"` })
      return
    }
    const { product: p, variant } = match
    const title = variant ? `${p.name} — ${variantLabel(variant)}` : p.name
    const sku = variant ? variant.sku : p.sku
    const price = perUnitLinePrice({
      silverRate,
      netWeight: p.netWeight,
      makingCharge: p.makingCharge,
      fallback: variant?.sellingPrice ?? p.sellingPrice,
    }) ?? 0
    setScanFeedback({ ok: true, text: `Added ${title}${price ? ` · ₹${price.toFixed(2)}` : ''}` })
    setLineItems((prev) => {
      const existing = prev.find((li) => li.productId === p.id && (li.variantId ?? null) === (variant?.id ?? null))
      if (existing) {
        // Re-scanning bumps the quantity; the price stays PER-UNIT (refreshed
        // at the current rate). Pricing the full new quantity here and then
        // multiplying by quantity in the subtotal double-counted every rescan.
        const newQty = existing.qty + 1
        const newPrice =
          perUnitLinePrice({
            silverRate,
            netWeight: existing.netWeight,
            makingCharge: existing.makingCharge,
            fallback: existing.price,
          }) ?? existing.price
        return prev.map((li) => (li.key === existing.key ? { ...li, qty: newQty, price: newPrice } : li))
      }
      const fresh = {
        productId: p.id,
        variantId: variant?.id ?? null,
        title,
        sku,
        price,
        qty: 1,
        netWeight: p.netWeight,
        makingCharge: p.makingCharge,
      }
      // Fill the empty first line if it's untouched, otherwise append
      const firstEmpty = prev.length === 1 && !prev[0].productId && !prev[0].title
      if (firstEmpty) {
        return [{ ...prev[0], ...fresh }]
      }
      return [...prev, { key: crypto.randomUUID(), ...fresh }]
    })
  }

  const updateLineItem = (key: string, patch: Partial<OrderLineItem>) => {
    setLineItems((prev) =>
      prev.map((li) => {
        if (li.key !== key) return li
        const updated = { ...li, ...patch }
        if (patch.qty !== undefined && patch.qty !== li.qty) {
          // Refresh the PER-UNIT price at the current rate; the quantity must
          // never scale it — the subtotal multiplies price × qty once.
          const unit = perUnitLinePrice({
            silverRate,
            netWeight: li.netWeight,
            makingCharge: li.makingCharge,
            fallback: null,
          })
          if (unit !== undefined) updated.price = unit
        }
        return updated
      }),
    )
    // A changed quantity re-runs the live check; drop any stale server report.
    if ('qty' in patch) clearServerStockError(key)
  }

  const createOrder = async () => {
    const customer = customerSel === '__new__' ? customerName.trim() : customerSel
    if (!customer) {
      setFormError('Select a customer or enter a new customer name.')
      return
    }
    const items = lineItems
      .filter((li) => li.title.trim())
      .map((li) => ({
        title: li.title.trim(),
        sku: li.sku,
        quantity: Math.max(0, Math.floor(li.qty) || 0),
        price: Number(li.price) || 0,
        // Shopify sync targets the exact variant; the local invoice keeps
        // billing the variant's SKU, which the line already carries.
        ...(li.variantId
          ? {
              variantId: li.variantId,
              productSku: products.find((product) => product.id === li.productId)?.sku,
            }
          : {}),
      }))
    if (!editing && items.length === 0) {
      setFormError('Add at least one line item.')
      return
    }
    // Block the request (and any Shopify sync) while any line asks for more
    // than the catalog holds — the shortfall is already shown under that
    // line's Qty field.
    if (Object.keys(computeLineStockErrors(stockCheckLines, stockByProductId)).length > 0) {
      return
    }
    const originalItems = editing?.lineItems ?? null
    const itemsChanged =
      originalItems === null
        ? items.length > 0
        : originalItems.length !== items.length ||
          originalItems.some((oi, i) => {
            const cur = items[i]
            return !cur || String(oi.title ?? '') !== cur.title || String(oi.sku ?? '') !== cur.sku || Number(oi.quantity ?? 0) !== cur.quantity || Number(oi.price ?? 0) !== cur.price
          })
    setSaving(true)
    setFormError('')
    setServerStockErrors({})
    try {
      const shared = hasAddress(billingAddr) ? billingAddr : shippingAddr
      const billing = customerSel === '__new__' ? toAddressPayload(shared, customerName) : undefined
      const shipping =
        customerSel === '__new__' ? (sameAsBilling ? billing : toAddressPayload(shippingAddr, customerName)) : undefined
      const common = {
        customer,
        email: customerEmail.trim() || undefined,
        phone: customerPhone.trim() || undefined,
        payment,
        fulfillment,
        status: orderStatus,
        date: orderDate ? new Date(orderDate).toISOString() : undefined,
        note: note.trim() || undefined,
        billingAddress: billing,
        shippingAddress: shipping,
        syncToShopify,
        // Where the sale is rung up. Its stock movements — and every later
        // reversal of them — land on this location's balance.
        locationId: locationId || undefined,
      }
      const res = editing
        ? await shopifyApi.updateOrder(editing.id, { ...common, ...(itemsChanged ? { items } : {}) })
        : await shopifyApi.createOrder({ ...common, items })
      setCreated(res)
      reload()
    } catch (err) {
      // The order endpoints validate stock themselves (per location); put
      // their answer under the offending Qty field instead of the banner.
      const stockErrors = stockErrorsFromApiError(err, lineItems)
      if (Object.keys(stockErrors).length > 0) {
        setServerStockErrors(stockErrors)
      } else {
        setFormError(err instanceof Error ? err.message : 'Could not save order')
      }
    } finally {
      setSaving(false)
    }
  }

  const customerOptions = customers.map((c) => ({
    value: c.name,
    label: c.name,
    keywords: `${c.email ?? ''} ${c.phone ?? ''}`.trim(),
    subtitle: [c.email, c.phone].filter(Boolean).join(' · ') || undefined,
  }))

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-6 lg:px-6">
      <PageHeader
        title="Sales Orders"
        subtitle="Shopify orders imported into the ERP — tracked through confirmation, fulfillment and invoicing."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => exportTable('sales-orders.csv', columns, filtered)}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            <Button variant="outline" size="sm" onClick={syncOrders} disabled={syncingOrders}>
              {syncingOrders ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {syncingOrders ? 'Syncing...' : 'Sync Orders'}
            </Button>
            <Button variant="outline" size="sm" onClick={repairPii} disabled={syncingOrders}>
              <UserRoundCheck className="h-3.5 w-3.5" /> Repair customer info
            </Button>
            <Button size="sm" className="gap-1.5" onClick={openDialog}>
              <Plus className="h-4 w-4" /> Manual Order
            </Button>
            <Button size="sm" className="gap-1.5" onClick={() => openManualInvoice(null)}>
              <FileText className="h-4 w-4" /> New Invoice
            </Button>
          </>
        }
      />

      {syncMsg ? (
        <div
          className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs ${
            syncMsg.ok
              ? 'border-success-100 bg-success-50/70 text-success-700'
              : 'border-red-200 bg-red-50/60 text-red-700'
          }`}
        >
          <span className="flex items-center gap-2">
            {syncMsg.ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
            {syncMsg.text}
          </span>
          <button
            type="button"
            onClick={() => setSyncMsg(null)}
            className="shrink-0 font-medium underline-offset-2 hover:underline"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search order ID, customer..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              options={[
                { value: '', label: 'All Status' },
                { value: 'imported', label: 'Imported' },
                { value: 'confirmed', label: 'Confirmed' },
                { value: 'processing', label: 'Processing' },
                { value: 'fulfilled', label: 'Fulfilled' },
                { value: 'cancelled', label: 'Cancelled' },
                { value: 'returned', label: 'Returned' },
                { value: 'refunded', label: 'Refunded' },
              ]}
              value={status}
              onValueChange={setStatus}
              className="w-[150px]"
            />
            <div className="ml-auto text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{filtered.length}</span> of {orders.length} orders
            </div>
          </div>

          {selectedOrders.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2">
              <span className="text-xs font-medium">{selectedOrders.length} selected</span>
              <Button size="sm" variant="outline" onClick={bulkInvoice} disabled={bulkBusy}>
                <FileText className="h-3.5 w-3.5" /> Create Invoices
              </Button>
              <Button size="sm" variant="outline" onClick={() => bulkPrintFulfilment('packing-slip')} disabled={bulkBusy}>
                <Printer className="h-3.5 w-3.5" /> Print Packing Slips
              </Button>
              <Button size="sm" variant="outline" onClick={() => bulkPrintFulfilment('pick-list')} disabled={bulkBusy}>
                <ListChecks className="h-3.5 w-3.5" /> Print Pick Lists
              </Button>
              <Button size="sm" variant="outline" onClick={() => bulkStatus('confirmed')} disabled={bulkBusy}>Mark Confirmed</Button>
              <Button size="sm" variant="outline" onClick={() => bulkStatus('processing')} disabled={bulkBusy}>Mark Processing</Button>
              <Button size="sm" variant="outline" onClick={() => bulkStatus('fulfilled')} disabled={bulkBusy}>Mark Fulfilled</Button>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelectedOrders([])}>Clear</Button>
            </div>
          )}
          {savedViews.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {savedViews.map((v) => (
                <span
                  key={v.name}
                  className="group inline-flex items-center gap-1 rounded-full border bg-muted/40 py-0.5 pl-2.5 pr-1 text-xs text-muted-foreground hover:border-primary-300 hover:text-foreground"
                >
                  <button className="cursor-pointer" onClick={() => applyView(v)}>{v.name}</button>
                  <button
                    className="rounded-full p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
                    aria-label={`Delete view ${v.name}`}
                    onClick={() => deleteView(v.name)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="mb-3 flex items-center gap-2">
            <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={() => setViewDialogOpen(true)}>
              <BookmarkPlus className="h-3.5 w-3.5" /> Save current view
            </Button>
          </div>
          <DataTable
            onRowDoubleClick={startEdit}
            onRowClick={setViewOrder}
            onSelectionChange={setSelectedOrders}
            columns={columns}
            data={filtered}
            loading={loading}
            columnVisibility={colVis}
            onColumnVisibilityChange={handleColVis}
            emptyMessage="No orders match your filters"
          />
        </CardContent>
      </Card>

      <AppDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        size="lg"
        isDirty={dialogOpen && snapshotForm() !== formBaseline}
        title={editing ? `Edit Order ${editing.shopifyId}` : 'Create Manual Order'}
        description={
          editing
            ? 'Update the order in the ERP. If syncing is on, Shopify is updated with the note, email and shipping address.'
            : 'Create an order in the ERP and push it to Shopify. The order is created on Shopify with the same payment status you select below.'
        }
        footer={
          created ? (
            <Button onClick={() => setDialogOpen(false)}>Done</Button>
          ) : (
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
              <Button onClick={createOrder} disabled={saving}>
                {saving ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" /> {editing ? 'Saving...' : syncToShopify ? 'Creating & Syncing...' : 'Creating...'}
                  </>
                ) : editing ? (
                  syncToShopify ? (
                    'Save & Sync to Shopify'
                  ) : (
                    'Save Changes'
                  )
                ) : syncToShopify ? (
                  'Create & Sync to Shopify'
                ) : (
                  'Create Order'
                )}
              </Button>
            </DialogFooter>
          )
        }
      >
          {created ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-success-50 text-success-700">
                <CheckCircle2 className="h-7 w-7" />
              </div>
              <p className="text-base font-semibold text-foreground">{editing ? 'Order updated successfully' : 'Order created successfully'}</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Order <span className="font-mono font-semibold text-foreground">{created.order.internalId}</span> for{' '}
                {created.order.customer} · {formatCurrency(created.order.value)}
              </p>
              {created.shopifySync ? (
                created.shopifySync.ok ? (
                  <div className="flex items-center gap-2 rounded-lg bg-success-50 px-3 py-2 text-xs font-medium text-success-700">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {editing
                      ? `Order updated on Shopify (${created.order.shopifyId})`
                      : created.shopifySync.completed
                        ? `Order created on Shopify as ${created.shopifySync.name}`
                        : `Synced to Shopify as draft ${created.shopifySync.name}`}
                  </div>
                ) : (
                  <div className="flex w-full max-w-sm items-start gap-2 rounded-lg border border-warning-100 bg-warning-50/70 px-3 py-2 text-left text-xs text-warning-700">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      {editing ? 'Order updated locally, but Shopify sync failed: ' : 'Order saved locally, but Shopify sync failed: '}
                      {created.shopifySync.message ?? created.shopifySync.errors[0] ?? 'Unknown error'}
                    </span>
                  </div>
                )
              ) : null}
            </div>
          ) : (
            <>
              <div className="space-y-5">
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Customer</Label>
                    <span className="text-[11px] text-muted-foreground">Pick an existing customer or add a new one</span>
                  </div>
                  <SearchableSelect
                    placeholder="Select customer"
                    searchPlaceholder="Search customers..."
                    options={[...customerOptions, { value: '__new__', label: 'New customer…' }]}
                    value={customerSel}
                    onValueChange={(v) => {
                      setCustomerSel(v)
                      if (v !== '__new__') {
                        const c = customers.find((x) => x.name === v)
                        setCustomerEmail(c?.email ?? '')
                        setCustomerPhone(c?.phone ?? '')
                      }
                    }}
                  />
                  {customerSel === '__new__' ? (
                    <>
                      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <div className="sm:col-span-1">
                        <Label className="text-xs text-muted-foreground">Name *</Label>
                        <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Customer name" />
                      </div>
                      <div className="sm:col-span-1">
                        <Label className="text-xs text-muted-foreground">Email</Label>
                        <Input value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} placeholder="name@example.com" />
                      </div>
                      <div className="sm:col-span-1">
                        <Label className="text-xs text-muted-foreground">Phone</Label>
                        <Input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="+91 …" />
                      </div>
                    </div>

                    <div className="mt-3 space-y-3">
                      <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2.5">
                        <div>
                          <p className="text-sm font-medium text-foreground">Billing & shipping address are the same</p>
                          <p className="text-[11px] text-muted-foreground">Ship to the billing address</p>
                        </div>
                        <Switch
                          checked={sameAsBilling}
                          onCheckedChange={(on) => {
                            if (on) {
                              const base = hasAddress(billingAddr) ? billingAddr : shippingAddr
                              setBillingAddr(base)
                              setShippingAddr(base)
                            }
                            setSameAsBilling(on)
                          }}
                        />
                      </div>
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <AddressFields title="Billing Address" addr={billingAddr} onChange={setBillingAddr} fallbackName={customerName} />
                        {sameAsBilling ? (
                          <div className="flex min-h-[160px] items-center justify-center rounded-md border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
                            Shipping address will match the billing address. Toggle the switch to enter a different one.
                          </div>
                        ) : (
                          <AddressFields title="Shipping Address" addr={shippingAddr} onChange={setShippingAddr} fallbackName={customerName} />
                        )}
                      </div>
                    </div>
                  </>
                ) : null}
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Line Items</Label>
                  <Button variant="outline" size="sm" onClick={() => setLineItems((prev) => [...prev, emptyLine()])}>
                    <Plus className="h-3.5 w-3.5" /> Add Item
                  </Button>
                </div>
                {/* Silver rate indicator */}
                {silverRateLoading ? (
                  <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="animate-pulse">Loading current silver rate…</span>
                  </div>
                ) : silverRate ? (
                  <div className="mb-2 flex items-center justify-between text-xs">
                    <span className="text-success-700">Current Silver Rate: ₹{silverRate.toFixed(2)}/g (from Silver Rate Management)</span>
                    <Button variant="ghost" size="icon-sm" onClick={() => {
                      setSilverRateLoading(true)
                      dbApi.getSilverRate()
                        .then((rate) => {
                          setSilverRate(rate.rate)
                          setSilverRateLoading(false)
                        })
                        .catch(() => {
                          setSilverRateLoading(false)
                        })
                    }} disabled={silverRateLoading} title="Refresh silver rate">
                      <RefreshCw className={`h-3.5 w-3.5 ${silverRateLoading ? 'animate-spin' : ''}`} />
                    </Button>
                  </div>
                ) : (
                  <div className="mb-2 flex items-center gap-2 text-xs text-destructive">
                    <span>Silver rate unavailable — prices will be calculated after fetching rate</span>
                  </div>
                )}
                {!editing ? (
                  <div className="mb-3">
                    <div className="flex items-end gap-2">
                      <div className="min-w-0 flex-1">
                        <Label className="text-xs text-muted-foreground">Scan QR / SKU</Label>
                        <Input
                          value={scanInput}
                          onChange={(e) => setScanInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleScan() } }}
                          placeholder="Scan a label QR or type a SKU, then press Enter"
                          autoComplete="off"
                        />
                      </div>
                      <Button variant="outline" size="sm" className="h-9" onClick={handleScan} disabled={!scanInput.trim()}>
                        <ScanQrCode className="h-3.5 w-3.5" /> Add
                      </Button>
                    </div>
                    {scanFeedback ? (
                      <p className={`mt-1.5 text-[11px] ${scanFeedback.ok ? 'text-success-700' : 'text-destructive'}`}>{scanFeedback.text}</p>
                    ) : (
                      <p className="mt-1.5 text-[11px] text-muted-foreground">Re-scanning an item increases its quantity.</p>
                    )}
                  </div>
                ) : null}
                  {editing ? (
                    <p className="mb-2 text-[11px] text-muted-foreground">
                      Existing line items are not stored in the ERP. Add items below to change the total, or leave them blank to keep the current value.
                    </p>
                  ) : null}
                  <div className="space-y-2">
                    {lineItems.map((li) => {
                      const stockError = lineStockErrors[li.key]
                      const rowProduct = products.find((p) => p.id === li.productId)
                      const rowVariants = rowProduct ? variantOptions(rowProduct) : []
                      return (
                      <div key={li.key} className="flex items-end gap-2">
                        <div className="min-w-0 flex-1">
                          <Label className="text-xs text-muted-foreground">Product</Label>
                          <SearchableSelect
                            placeholder="Select product"
                            searchPlaceholder="Search products..."
                            options={[
                              ...products.map((p) => ({
                                value: p.id,
                                label: p.name,
                                keywords: p.sku,
                                subtitle: variantCountByProductId.has(p.id)
                                  ? `${variantCountByProductId.get(p.id)} variants`
                                  : p.sku,
                              })),
                              { value: '__new_product__', label: 'New product…', subtitle: 'Add it without leaving this order' },
                            ]}
                            value={li.productId}
                            onValueChange={(v) => {
                              // Manual-entry escape hatch: open the product
                              // dialog instead of selecting a line.
                              if (v === '__new_product__') {
                                setNewProductLineKey(li.key)
                                return
                              }
                              selectProduct(li.key, v)
                            }}
                           />
                        </div>
                        {rowVariants.length > 0 ? (
                          <div className="w-36">
                            <Label className="text-xs text-muted-foreground">Variant</Label>
                            <SearchableSelect
                              placeholder="Select variant"
                              searchPlaceholder="Search variants..."
                              options={rowVariants}
                              value={li.variantId ?? ''}
                              onValueChange={(v) => selectVariant(li.key, v)}
                            />
                          </div>
                        ) : null}
                        <div className="w-20">
                          <Label className="text-xs text-muted-foreground">Qty</Label>
                          <Input
                            type="number"
                            min="1"
                            value={li.qty}
                            onChange={(e) => updateLineItem(li.key, { qty: Math.max(1, Number(e.target.value)) })}
                            className={cn(
                              stockError &&
                                'border-red-500 focus-visible:border-red-500 focus-visible:ring-red-500/40',
                            )}
                            aria-invalid={stockError ? true : undefined}
                          />
                          {stockError ? (
                            <p className="mt-1 text-[11px] leading-snug text-red-600 dark:text-red-400">{stockError}</p>
                          ) : null}
                        </div>
                        <div className="w-28">
                          <Label className="text-xs text-muted-foreground">Price (?)</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={li.price}
                            onChange={(e) => updateLineItem(li.key, { price: Number(e.target.value) })}
                          />
                          {/* Show price breakdown when calculated from silver rate */}
                          {li.netWeight && li.netWeight > 0 && li.makingCharge && li.makingCharge > 0 && silverRate && (
                            <div className="mt-1 text-[10px] text-muted-foreground space-y-0.5">
                              <div>Silver: {silverRate.toFixed(2)} × {li.netWeight} × {li.qty} = ₹{(silverRate * li.netWeight * li.qty).toFixed(2)}</div>
                              <div>Making: {li.makingCharge.toFixed(2)} × {li.netWeight} × {li.qty} = ₹{(li.makingCharge * li.netWeight * li.qty).toFixed(2)}</div>
                              <div>Subtotal: ₹{(silverRate * li.netWeight * li.qty + li.makingCharge * li.netWeight * li.qty).toFixed(2)}</div>
                              <div>GST (3%): ₹{((silverRate * li.netWeight * li.qty + li.makingCharge * li.netWeight * li.qty) * 0.03).toFixed(2)}</div>
                              <div className="font-medium">Total: ₹{(silverRate * li.netWeight * li.qty + li.makingCharge * li.netWeight * li.qty + (silverRate * li.netWeight * li.qty + li.makingCharge * li.netWeight * li.qty) * 0.03).toFixed(2)}</div>
                            </div>
                          )}
                        </div>
                        <div className="w-28 pb-0.5 text-right text-sm font-semibold tabular-nums text-foreground">
                          {formatCurrency((Number.isFinite(li.price) ? li.price : 0) * (Number.isFinite(li.qty) ? li.qty : 0))}
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="mb-0.5 text-muted-foreground hover:text-red-600 dark:text-red-400"
                          disabled={lineItems.length === 1}
                          onClick={() => setLineItems((prev) => prev.filter((x) => x.key !== li.key))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      )
                    })}
                  </div>
                  <div className="mt-2 flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">{editing && totalValue === 0 ? 'Order value (unchanged)' : 'Total order value'}</span>
                    <span className="font-bold tabular-nums text-foreground">
                      {formatCurrency(totalValue > 0 ? totalValue : (editing?.value ?? 0))}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div>
                    <Label className="text-xs text-muted-foreground">Rung up at</Label>
                    <Select
                      options={locations.map((l) => ({ value: l.id, label: l.name }))}
                      value={locationId}
                      onValueChange={setLocationId}
                      placeholder="Select location"
                    />
                  </div>

                  <div>
                    <Label className="text-xs text-muted-foreground">Order Date</Label>
                    <Input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Payment</Label>
                    <Select
                      options={[
                        { value: 'paid', label: 'Paid' },
                        { value: 'pending', label: 'Pending' },
                      ]}
                      value={payment}
                      onValueChange={setPayment}
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Fulfillment</Label>
                    <Select
                      options={[
                        { value: 'unfulfilled', label: 'Unfulfilled' },
                        { value: 'processing', label: 'Processing' },
                        { value: 'partial', label: 'Partial' },
                        { value: 'fulfilled', label: 'Fulfilled' },
                      ]}
                      value={fulfillment}
                      onValueChange={setFulfillment}
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Order Status</Label>
                    <Select
                      options={[
                        { value: 'confirmed', label: 'Confirmed' },
                        { value: 'processing', label: 'Processing' },
                        { value: 'fulfilled', label: 'Fulfilled' },
                        { value: 'imported', label: 'Imported' },
                        { value: 'cancelled', label: 'Cancelled' },
                        { value: 'returned', label: 'Returned' },
                        { value: 'refunded', label: 'Refunded' },
                      ]}
                      value={orderStatus}
                      onValueChange={setOrderStatus}
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground">Note</Label>
                  <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note for the order" />
                </div>

                <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2.5">
                  <div>
                    <p className="text-sm font-medium text-foreground">Sync to Shopify</p>
                    <p className="text-[11px] text-muted-foreground">
                      {editing
                        ? 'Update the note, email and shipping address on the existing Shopify order'
                        : 'Create the order on Shopify with the selected payment status'}
                    </p>
                  </div>
                  <Switch checked={syncToShopify} onCheckedChange={setSyncToShopify} />
                </div>

                {formError ? (
                  <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50/60 p-2.5 text-xs text-red-700">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{formError}</span>
                  </div>
                ) : null}
              </div>
            </>
          )}
      </AppDialog>

      <AppDialog
        open={viewOrder !== null}
        onOpenChange={(open) => { if (!open) setViewOrder(null) }}
        size="xl"
        className="print-dialog"
        footerClassName="no-print"
        title={<>Order {viewOrder?.shopifyId ?? ''}</>}
        description={viewOrder ? `${viewOrder.internalId} · placed on ${formatDateTime(viewOrder.date)}` : ''}
        footer={
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" onClick={() => setViewOrder(null)}>Close</Button>
            <Button
              variant="outline"
              onClick={() => {
                const o = viewOrder
                setViewOrder(null)
                if (o) startEdit(o)
              }}
            >
              <Pencil className="h-4 w-4" /> Edit
            </Button>
            <Button variant="outline" onClick={() => viewOrder && printOrder(viewOrder)}>
              <Printer className="h-4 w-4" /> Print / PDF
            </Button>
            <Button variant="outline" onClick={() => viewOrder && printFulfilment(viewOrder, 'packing-slip')}>
              <Package className="h-4 w-4" /> Packing Slip
            </Button>
            <Button variant="outline" onClick={() => viewOrder && printFulfilment(viewOrder, 'pick-list')}>
              <ListChecks className="h-4 w-4" /> Pick List
            </Button>
            {(() => {
              const phone = viewOrder?.shippingAddress?.phone || viewOrder?.billingAddress?.phone || customers.find((c) => c.name === viewOrder?.customer)?.phone || ''
              if (!phone) return null
              return (
                <Button
                  variant="outline"
                  onClick={() => {
                    const digits = phone.replace(/\D/g, '')
                    const withCc = digits.length === 10 ? '91' + digits : digits
                    const text = encodeURIComponent(
                      `Order ${viewOrder?.shopifyId || viewOrder?.internalId}\nCustomer: ${viewOrder?.customer}\nAmount: ₹${Number(viewOrder?.value ?? 0).toLocaleString('en-IN')}\n\n— Opal Line`,
                    )
                    window.open(`https://wa.me/${withCc}?text=${text}`, '_blank')
                  }}
                >
                  <MessageCircle className="h-4 w-4" /> WhatsApp
                </Button>
              )
            })()}
            <Button
              disabled={Boolean(viewOrder?.invoice) || invoiceSavingId === viewOrder?.id}
              onClick={() => viewOrder && createInvoiceFor(viewOrder)}
            >
              {invoiceSavingId === viewOrder?.id ? <RefreshCw className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              {viewOrder?.invoice ? 'Invoice Raised' : 'Create Invoice'}
            </Button>
          </DialogFooter>
        }
      >
          {viewOrder ? (
            <div className="space-y-2 text-sm">
              {/* Customer contact: prefer the customer record, fall back to
                  what is stored on the order itself. Addresses render as the
                  formatted Billing/Shipping cards further down — no flat
                  duplicates here. */}
              <DetailRow label="Customer" value={viewOrder.customer || '—'} />
              {(() => {
                const cust = customers.find((c) => c.name === viewOrder.customer)
                  ?? customers.find((c) => viewOrder.shippingAddress?.phone && c.phone === viewOrder.shippingAddress.phone)
                const email = cust?.email ?? viewOrder.customerEmail ?? null
                const phone = cust?.phone ?? viewOrder.customerPhone ?? viewOrder.shippingAddress?.phone ?? viewOrder.billingAddress?.phone ?? null
                return (
                  <>
                    {email ? <DetailRow label="Email" value={email} /> : null}
                    {phone ? <DetailRow label="Phone" value={phone} /> : null}
                  </>
                )
              })()}
              <DetailRow label="Order Value" value={formatCurrency(viewOrder.value)} />
              {viewOrder.currency && viewOrder.currency.toUpperCase() !== 'INR' ? (
                <DetailRow label="Currency" value={viewOrder.currency} />
              ) : null}
              {viewOrder.discount && viewOrder.discount > 0 ? (
                <DetailRow label="Discount" value={formatCurrency(viewOrder.discount)} />
              ) : null}
              <DetailRow label="Items" value={`${viewOrder.items} item(s)`} />
              {viewOrder.lineItems && viewOrder.lineItems.length > 0 ? (
                <DetailRow
                  label="Items Subtotal"
                  value={formatCurrency(viewOrder.lineItems.reduce((sum, li) => sum + (li.price ?? 0) * (li.quantity ?? 0), 0))}
                />
              ) : null}
              {/* The actual products on the order — title/SKU/qty/line total. */}
              {viewOrder.lineItems && viewOrder.lineItems.length > 0 ? (
                <div className="border-b border-border/60 py-2">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-muted-foreground">Line Items</span>
                    <span className="text-[11px] text-muted-foreground">{viewOrder.lineItems.length} product(s)</span>
                  </div>
                  <div className="space-y-1">
                    {viewOrder.lineItems.map((li, i) => (
                      <div key={i} className="flex items-center justify-between gap-3 text-xs">
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-medium text-foreground">{li.title || 'Item'}</span>
                          {li.sku ? <span className="ml-1.5 font-mono text-muted-foreground">{li.sku}</span> : null}
                        </span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">{li.quantity ?? 1} × {formatCurrency(li.price ?? 0)}</span>
                        <span className="shrink-0 tabular-nums font-medium text-foreground">{formatCurrency((li.price ?? 0) * (li.quantity ?? 0))}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <DetailRow label="Payment" value={getPaymentMeta(viewOrder.payment).label} />
              <DetailRow label="Fulfillment" value={getFulfillmentMeta(viewOrder.fulfillment).label} />
              <DetailRow label="Invoice" value={viewOrder.invoice ?? 'Not raised'} />
              <DetailRow label="Status" value={statusMeta[viewOrder.status]?.label ?? viewOrder.status} />
              <DetailRow label="Order Date" value={formatDate(viewOrder.date)} />
              {viewOrder.tags ? <DetailRow label="Tags" value={viewOrder.tags.split(',').join(', ')} /> : null}
              {viewOrder.billingAddress && (viewOrder.billingAddress.name || viewOrder.billingAddress.address1) ? (
                <div className="border-b border-border/60 py-2">
                  <span className="text-muted-foreground">Billing Address</span>
                  <div className="mt-1 space-y-0.5 text-right text-sm">
                    {viewOrder.billingAddress.name ? <p className="font-medium text-foreground">{viewOrder.billingAddress.name}</p> : null}
                    {viewOrder.billingAddress.phone ? <p className="text-muted-foreground">{viewOrder.billingAddress.phone}</p> : null}
                    {viewOrder.billingAddress.address1 ? <p className="text-foreground">{viewOrder.billingAddress.address1}{viewOrder.billingAddress.address2 ? `, ${viewOrder.billingAddress.address2}` : ''}</p> : null}
                    {[viewOrder.billingAddress.city, viewOrder.billingAddress.province, viewOrder.billingAddress.zip].filter(Boolean).length > 0 ? (
                      <p className="text-foreground">{[viewOrder.billingAddress.city, viewOrder.billingAddress.province, viewOrder.billingAddress.zip].filter(Boolean).join(', ')}</p>
                    ) : null}
                    {viewOrder.billingAddress.country ? <p className="text-muted-foreground">{viewOrder.billingAddress.country}</p> : null}
                  </div>
                </div>
              ) : null}
              {viewOrder.shippingAddress && (viewOrder.shippingAddress.name || viewOrder.shippingAddress.address1) ? (
                <div className="border-b border-border/60 py-2">
                  <span className="text-muted-foreground">Shipping Address</span>
                  <div className="mt-1 space-y-0.5 text-right text-sm">
                    {viewOrder.shippingAddress.name ? <p className="font-medium text-foreground">{viewOrder.shippingAddress.name}</p> : null}
                    {viewOrder.shippingAddress.phone ? <p className="text-muted-foreground">{viewOrder.shippingAddress.phone}</p> : null}
                    {viewOrder.shippingAddress.address1 ? <p className="text-foreground">{viewOrder.shippingAddress.address1}{viewOrder.shippingAddress.address2 ? `, ${viewOrder.shippingAddress.address2}` : ''}</p> : null}
                    {[viewOrder.shippingAddress.city, viewOrder.shippingAddress.province, viewOrder.shippingAddress.zip].filter(Boolean).length > 0 ? (
                      <p className="text-foreground">{[viewOrder.shippingAddress.city, viewOrder.shippingAddress.province, viewOrder.shippingAddress.zip].filter(Boolean).join(', ')}</p>
                    ) : null}
                    {viewOrder.shippingAddress.country ? <p className="text-muted-foreground">{viewOrder.shippingAddress.country}</p> : null}
                  </div>
                </div>
              ) : null}
              <Customer360Card customer={viewOrder.customer} />
              <Order360Section orderId={viewOrder.id} />
              <OrderTimeline orderId={viewOrder.id} />
            </div>
          ) : null}
      </AppDialog>

      <ManualInvoiceDialog
        open={manualInvoiceOpen}
        onOpenChange={setManualInvoiceOpen}
        initialCustomer={manualInvoiceOrder?.customer ?? ''}
        initialCustomerPhone={manualInvoiceOrder?.customerPhone ?? ''}
      />

      <AppDialog
        open={viewDialogOpen}
        onOpenChange={setViewDialogOpen}
        size="sm"
        isDirty={viewDialogOpen && viewName.trim() !== ''}
        title="Save current view"
        description="Stores the current search and status filter as a one-click chip above the table."
        footer={
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setViewDialogOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={saveView}>Save view</Button>
          </DialogFooter>
        }
      >
        <Input
          placeholder="View name (e.g. Today's Shopify orders)"
          value={viewName}
          onChange={(e) => setViewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') saveView() }}
        />
      </AppDialog>

      <ProductDialog
        open={newProductLineKey !== null}
        onOpenChange={(open) => { if (!open) setNewProductLineKey(null) }}
        mode="add"
        onSaved={(product) => {
          const key = newProductLineKey
          setNewProductLineKey(null)
          if (!key) return
          // Wire the new product straight into the line that opened the
          // dialog (fields taken from the saved product itself, so no
          // re-fetch has to land first), then refresh the picker list.
          setLineItems((prev) =>
            prev.map((li) =>
              li.key === key
                ? { ...li, productId: product.id, title: product.name, sku: product.sku ?? li.sku, price: product.sellingPrice ?? li.price }
                : li,
            ),
          )
          dbApi.getProducts().then(setProducts).catch(() => {})
        }}
      />
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 py-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  )
}

function AddressFields({
  title,
  addr,
  onChange,
  fallbackName,
}: {
  title: string
  addr: OrderAddress
  onChange: (a: OrderAddress) => void
  fallbackName: string
}) {
  const set = (patch: Partial<OrderAddress>) => onChange({ ...addr, ...patch })
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <div>
        <Label className="text-xs text-muted-foreground">Name</Label>
        <Input value={addr.name} onChange={(e) => set({ name: e.target.value })} placeholder={fallbackName || 'Recipient name'} />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Address</Label>
        <Input value={addr.address1} onChange={(e) => set({ address1: e.target.value })} placeholder="Street address, P.O. box" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs text-muted-foreground">City</Label>
          <Input value={addr.city} onChange={(e) => set({ city: e.target.value })} placeholder="City" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">State</Label>
          <Input value={addr.province} onChange={(e) => set({ province: e.target.value })} placeholder="State" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">PIN / Zip</Label>
          <Input value={addr.zip} onChange={(e) => set({ zip: e.target.value })} placeholder="PIN code" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Phone</Label>
          <Input value={addr.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="Phone" />
        </div>
      </div>
    </div>
  )
}

/** Customer 360: lifetime stats, recent orders, outstanding dues for this order's customer. */
function Customer360Card({ customer }: { customer: string }) {
  const [data, setData] = useState<Customer360 | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open || !customer || data) return
    dbApi.customer360(customer).then(setData).catch(() => setData(null))
  }, [open, customer, data])

  if (!customer) return null
  return (
    <div className="border-b border-border/60 py-2">
      <button type="button" className="flex w-full items-center justify-between" onClick={() => setOpen((o) => !o)}>
        <span className="text-muted-foreground">Customer 360 — {customer}</span>
        <span className="text-[11px] text-muted-foreground">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {!data ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-md border p-2">
                  <p className="text-[10px] text-muted-foreground">Lifetime value</p>
                  <p className="text-sm font-semibold tabular-nums">{formatCurrency(data.lifetimeValue)}</p>
                </div>
                <div className="rounded-md border p-2">
                  <p className="text-[10px] text-muted-foreground">Orders</p>
                  <p className="text-sm font-semibold tabular-nums">{data.totalOrders}</p>
                </div>
                <div className={cn('rounded-md border p-2', data.outstanding > 0 && 'border-red-500/40 bg-red-500/10')}>
                  <p className="text-[10px] text-muted-foreground">Outstanding</p>
                  <p className="text-sm font-semibold tabular-nums">{formatCurrency(data.outstanding)}</p>
                </div>
              </div>
              {data.orders.length > 0 && (
                <div>
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Recent orders</p>
                  <div className="space-y-1">
                    {data.orders.slice(0, 5).map((o) => (
                      <div key={o.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{o.internalId || o.shopifyId || o.id.slice(0, 8)}</span>
                        <span className="shrink-0 text-muted-foreground">{o.date ? formatDate(o.date) : ''}</span>
                        <span className="shrink-0 tabular-nums font-medium">{formatCurrency(Number(o.value ?? 0))}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {data.payments.filter((p) => (p.amount ?? 0) !== 0).length > 0 && (
                <div>
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Recent payments</p>
                  <div className="space-y-1">
                    {data.payments.slice(0, 5).map((p) => (
                      <div key={p.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{p.invoice ?? p.ref ?? '—'}</span>
                        <span className="shrink-0 text-muted-foreground">{p.date ? formatDate(p.date) : ''}</span>
                        <span className={cn('shrink-0 tabular-nums font-medium', (p.amount ?? 0) < 0 && 'text-red-500 dark:text-red-400')}>
                          {formatCurrency(Number(p.amount ?? 0))}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Order timeline: every event from creation to delivery (lazily loaded). */
/** Invoice + payment + shipment detail pulled from the Order-360 endpoint */
function Order360Section({ orderId }: { orderId: string }) {
  const [detail, setDetail] = useState<OrderFullDetail | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open || detail || !orderId) return
    dbApi.getOrderFull(orderId).then(setDetail).catch(() => setDetail(null))
  }, [open, detail, orderId])

  if (!open) {
    return (
      <button
        className="flex w-full items-center justify-between border-b border-border/60 py-2 text-left"
        onClick={() => setOpen(true)}
      >
        <span className="text-sm font-medium text-foreground">Invoice · Payments · Shipment</span>
        <span className="text-xs text-muted-foreground">Show details</span>
      </button>
    )
  }

  const inv = detail?.invoice ?? null
  const ship = detail?.shipment ?? null
  const pays = detail?.payments ?? []

  return (
    <div className="space-y-2 border-b border-border/60 py-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">Invoice · Payments · Shipment</span>
        <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>Hide</button>
      </div>

      {inv ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Invoice {inv.number}</p>
          <DetailRow label="Grand Total" value={formatCurrency(Number(inv.grandTotal ?? 0))} />
          <DetailRow label="Payment Status" value={inv.paymentStatus ?? '—'} />
          {inv.dueDate ? <DetailRow label="Due Date" value={formatDate(inv.dueDate)} /> : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No invoice raised yet.</p>
      )}

      {pays.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payments ({pays.length})</p>
          {pays.map((p) => (
            <DetailRow
              key={p.id}
              label={`${p.method ?? 'Payment'}${p.ref ? ` · ${p.ref}` : ''}`}
              value={`${formatCurrency(Number(p.amount ?? 0))}${p.date ? ` · ${formatDate(p.date)}` : ''}`}
            />
          ))}
        </div>
      ) : null}

      {ship ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Shipment</p>
          <DetailRow label="Courier" value={ship.courier ?? '—'} />
          {ship.trackingNumber ? <DetailRow label="Tracking" value={ship.trackingNumber} /> : null}
          <DetailRow label="Status" value={ship.status} />
          {ship.deliveredAt ? <DetailRow label="Delivered" value={formatDateTime(ship.deliveredAt)} /> : null}
          {ship.expectedDelivery && !ship.deliveredAt ? <DetailRow label="Expected" value={formatDate(ship.expectedDelivery)} /> : null}
        </div>
      ) : null}
    </div>
  )
}

function OrderTimeline({ orderId }: { orderId: string }) {
  const [events, setEvents] = useState<OrderEvent[]>([])
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open || loaded || !orderId) return
    dbApi.getOrderEvents(orderId).then((r) => { setEvents(r.data ?? []); setLoaded(true) }).catch(() => setLoaded(true))
  }, [open, loaded, orderId])

  return (
    <div className="py-2">
      <button type="button" className="flex w-full items-center justify-between" onClick={() => setOpen((o) => !o)}>
        <span className="text-muted-foreground">Order Timeline</span>
        <span className="text-[11px] text-muted-foreground">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-0">
          {!loaded ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : events.length === 0 ? (
            <p className="text-xs text-muted-foreground">No events recorded yet.</p>
          ) : (
            events.map((e, i) => (
              <div key={e.id} className="flex gap-2">
                <div className="flex flex-col items-center">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary-500" />
                  {i < events.length - 1 && <span className="w-px flex-1 bg-border" />}
                </div>
                <div className="pb-3">
                  <p className="text-xs font-medium text-foreground">{e.event}</p>
                  {e.details ? <p className="text-[11px] text-muted-foreground">{e.details}</p> : null}
                  <p className="text-[10px] text-muted-foreground/70">
                    {formatDateTime(e.createdAt)}{e.actor ? ` · ${e.actor.slice(0, 8)}` : ''}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
