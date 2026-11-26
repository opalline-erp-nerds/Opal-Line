import { confirmDialog, toast } from '@/components/ui/confirm'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '@/auth/auth-context'
import { useSilverRate } from '@/lib/silver-rate-context'
import {
  Ban,
  Download,
  Eye,
  Layers,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  ShoppingBag,
  Trash2,
  Undo2,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select } from '@/components/ui/select'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import { DataTable } from '@/components/ui/data-table'
import { Pager } from '@/components/ui/pager'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { CustomerPicker, type CustomerHit } from '@/components/customer-picker'
import type { ColumnDef } from '@/lib/table'
import { dbApi } from '@/lib/api'
import { ApiError, formatApiError } from '@/lib/api/core'
import { allocationDraftIssues, allocationStatusFor, trackedQuantity, type AllocationDraft } from '@/lib/bookingAllocations'
import { bookingBalance, bookingStats } from '@/lib/bookingStats'
import { exportTable } from '@/lib/export'
import { bookingPricing } from '@/lib/bookingPricing'
import { locationLabel } from '@/lib/locations'
import {
  flattenSellableItems,
  parseSellableValue,
  sellableItemOptions,
  sellableItemPrice,
  sellableItemValue,
  type SellableItem,
} from '@/lib/sellableItems'
import {
  findVariantById,
  hasRealOptions,
  variantEffectivePrice,
  variantLabel,
  variantOptions,
} from '@/lib/productVariants'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format'
import type {
  BookingAllocationLine,
  BookingAllocationSummary,
  InventoryLocation,
  LocationStockAvailability,
  OrderFullDetail,
  Product,
  SalesOrder,
} from '@/types'

/** One editable line on the booking form. */
interface DraftLine {
  key: string
  /** Catalogue product the line points at (empty for hand-typed lines). */
  productId: string
  variantId: string
  title: string
  sku: string
  /** True when the row is typed by hand ("Type manually…"). */
  custom: boolean
  /** Whole pieces — a booking books units, never fractions. */
  qty: string
  /** PER-UNIT price, GST-inclusive — the sales_orders convention. */
  price: string
  /** Variant "Add to price (₹)" already folded into `price`, kept for display. */
  priceAdjustment?: number | null
}

const CUSTOM_PRODUCT = '__custom__'

function newLine(): DraftLine {
  return { key: crypto.randomUUID(), productId: '', variantId: '', title: '', sku: '', custom: false, qty: '1', price: '', priceAdjustment: undefined }
}

/** Untouched blank row — ignored by validation and by the payload. */
function isPristineLine(l: DraftLine): boolean {
  return l.title.trim() === '' && l.price === '' && l.qty === '1' && !l.custom
}

/** Header fields of the shared create/edit form. */
interface BookingFormState {
  customer: string
  /** The `customers` row the picker chose; '' for a walk-in. */
  customerId: string
  email: string
  phone: string
  /** Date-only `YYYY-MM-DD`. */
  date: string
  expectedDate: string
  gst: string
  discount: string
  advance: string
  note: string
  status: string
  /** The one store this booking sells from (id — never a display name). */
  locationId: string
}

const today = () => new Date().toISOString().slice(0, 10)

/**
 * The seeded main store — mirrors DEFAULT_LOCATION_ID in backend/src/stock.ts.
 * It is both the default for a NEW booking and what a legacy (location-less)
 * booking has always converted against, so selecting it changes nothing.
 */
const DEFAULT_STORE_ID = 'LOC-DEFAULT'

/** Fallback label when the locations list cannot be loaded (e.g. no inventory.view). */
const DEFAULT_STORE_FALLBACK: InventoryLocation = {
  id: DEFAULT_STORE_ID,
  name: 'Main Store',
  type: 'store',
  city: '',
  manager: '',
}

type BadgeVariant = NonNullable<BadgeProps['variant']>

const BOOKING_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  imported: { label: 'Imported', variant: 'muted' },
  confirmed: { label: 'Confirmed', variant: 'info' },
  processing: { label: 'Processing', variant: 'warning' },
  fulfilled: { label: 'Fulfilled', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'danger' },
  returned: { label: 'Returned', variant: 'muted' },
  refunded: { label: 'Refunded', variant: 'muted' },
}

const BOOKING_PAYMENT: Record<string, { label: string; variant: BadgeVariant }> = {
  paid: { label: 'Paid in full', variant: 'success' },
  pending: { label: 'Advance pending', variant: 'warning' },
  refunded: { label: 'Refunded', variant: 'muted' },
}

/** The only statuses a booking form may write — the rest are actions. */
const FORM_STATUSES = ['confirmed', 'processing'] as const

/** A cancelled booking is closed business everywhere on this page. */
function isCancelled(b: SalesOrder): boolean {
  return b.status === 'cancelled'
}

/** Still editable/convertible: never invoiced, never cancelled. */
function isOpenBooking(b: SalesOrder): boolean {
  return !b.invoice && !isCancelled(b)
}

function itemsSummary(b: SalesOrder): string {
  const lines = b.lineItems ?? []
  return lines
    .map((li) => {
      const base = `${li.quantity ?? 1}× ${li.title || li.sku || 'Item'}`
      // A variant line's title already carries the variant NAME; its CODE is
      // the half the list used to drop, and the half a counter matches a
      // physical label against.
      return li.variantId && li.sku ? `${base} (${li.sku})` : base
    })
    .join(', ')
}

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1.5">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-sm font-medium text-foreground">{value}</span>
    </div>
  )
}

function SummaryRow({ label, value, bold, negative }: { label: string; value: string; bold?: boolean; negative?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${bold ? 'border-t border-border/60 pt-1 font-semibold' : ''}`}>
      <span className={bold ? '' : 'text-muted-foreground'}>{label}</span>
      <span className={`tabular-nums ${negative ? 'text-danger-600 dark:text-danger-400' : ''}`}>{value}</span>
    </div>
  )
}

/**
 * Read-only view of one booking: identity and contact, the booked lines, the
 * full pricing breakdown the invoice will inherit, the payments recorded
 * against the conversion, and the order timeline. `detail` arrives from
 * GET /db/orders/:id/full; while it loads the summary still renders from the
 * list row, so the dialog is never empty. Kept presentational (props in,
 * markup out) so the regression tests can exercise it without booting the
 * page or its API.
 */
export function BookingDetailView({
  booking,
  detail,
  loading,
  error,
  locationName,
}: {
  booking: SalesOrder
  detail: OrderFullDetail | null
  loading?: boolean
  error?: string | null
  /** Human label of the booking's ONE selling store (resolved by the page). */
  locationName?: string
}) {
  const advance = Number(booking.advancePaid ?? 0)
  const discount = Number(booking.discount ?? 0)
  const items = booking.lineItems ?? []
  const status = BOOKING_STATUS[booking.status] ?? { label: booking.status || 'Unknown', variant: 'muted' as BadgeVariant }
  const payment = BOOKING_PAYMENT[booking.payment] ?? { label: booking.payment || '—', variant: 'muted' as BadgeVariant }
  const invoice = detail?.invoice ?? null
  const payments = detail?.payments ?? []
  const events = detail?.events ?? []
  // Customer 360 is matched by name, so a booking whose contact was never
  // enriched still resolves: the order-360 contact wins, the booking's own
  // stored columns fill the gap while that call is in flight or unavailable.
  const contact = detail?.contact ?? null
  const email = contact?.email ?? booking.customerEmail ?? null
  const phone = contact?.phone ?? booking.customerPhone ?? null
  const customerHref = booking.customer ? `/sales/customers/${encodeURIComponent(booking.customer)}` : null

  // The same money model the form preview and the converted invoice use. A
  // legacy booking without a stored rate previews at the default (3) — the
  // rate its invoice would fall back to on a default-configured store.
  const pricing = bookingPricing(
    items.map((li) => ({ price: Number(li.price ?? 0), qty: Number(li.quantity ?? 0) })),
    booking.gst != null ? Number(booking.gst) : 3,
    discount,
    advance,
  )
  const outstanding = pricing.outstanding

  return (
    <div className="space-y-3 text-sm">
      {error ? (
        <p className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-500 dark:text-red-400">{error}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={status.variant} dot>{status.label}</Badge>
        <Badge variant={payment.variant} dot>{payment.label}</Badge>
        {invoice ? (
          <Badge variant="default"><Receipt className="h-3 w-3" /> {invoice.number}</Badge>
        ) : (
          <Badge variant="secondary">Awaiting conversion</Badge>
        )}
        {outstanding > 0 ? <Badge variant="warning">{formatCurrency(outstanding)} outstanding</Badge> : null}
        {isOpenBooking(booking) && trackedQuantity(booking) > 0 ? (
          <AllocationStatusChip allocated={booking.allocated ?? 0} required={trackedQuantity(booking)} />
        ) : null}
      </div>

      <div className="grid gap-x-6 sm:grid-cols-2">
        <div>
          <DetailField label="Booking" value={booking.internalId || booking.id.slice(0, 8)} />
          <DetailField label="Booked on" value={formatDateTime(booking.date)} />
          {booking.expectedDelivery ? (
            <DetailField label="Expected delivery" value={formatDate(booking.expectedDelivery)} />
          ) : null}
          {locationName ? <DetailField label="Selling store" value={locationName} /> : null}
          <DetailField
            label="Customer"
            value={
              customerHref && booking.customer ? (
                <Link className="hover:underline" to={customerHref} title="Open Customer 360">
                  {booking.customer}
                </Link>
              ) : (
                booking.customer || '—'
              )
            }
          />
          {email ? <DetailField label="Email" value={email} /> : null}
          {phone ? <DetailField label="Phone" value={phone} /> : null}
        </div>
        <div>
          {invoice ? (
            <DetailField
              label="Invoice"
              value={
                <span className="inline-flex items-center gap-1">
                  <Receipt className="h-3 w-3" /> {invoice.number}
                </span>
              }
            />
          ) : null}
          <DetailField label="Booked value" value={formatCurrency(Number(booking.value ?? 0))} />
          {discount > 0 ? <DetailField label="Discount" value={formatCurrency(discount)} /> : null}
          <DetailField label="Advance collected" value={formatCurrency(advance)} />
          <DetailField label="Outstanding" value={formatCurrency(outstanding)} />
        </div>
      </div>

      {booking.note ? (
        <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">{booking.note}</p>
      ) : null}

      {items.length > 0 ? (
        <div className="rounded-md border border-border/60">
          <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground">Booked items</span>
            <span className="text-[11px] text-muted-foreground">{items.length} product(s)</span>
          </div>
          <div className="divide-y divide-border/50">
            {items.map((li, i) => (
              <div key={i} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-foreground">{li.title || 'Item'}</span>
                  {li.sku ? <span className="ml-1.5 font-mono text-muted-foreground">{li.sku}</span> : null}
                  {Number(li.priceAdjustment) > 0 ? (
                    <span className="ml-1.5 text-violet-700">+₹{li.priceAdjustment} add-on</span>
                  ) : null}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {li.quantity ?? 1} × {formatCurrency(li.price ?? 0)}
                </span>
                <span className="shrink-0 tabular-nums font-medium text-foreground">
                  {formatCurrency((li.price ?? 0) * (li.quantity ?? 0))}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Pricing breakdown — the numbers the converted invoice inherits. */}
      <div className="space-y-1 rounded-md border border-border/60 p-3">
        <SummaryRow label="Lines total (incl. GST)" value={formatCurrency(pricing.linesTotal)} />
        <SummaryRow label="Subtotal (taxable)" value={formatCurrency(pricing.taxable)} />
        <SummaryRow label={`GST (${booking.gst != null ? `${pricing.gstRate}%` : 'store rate'})`} value={formatCurrency(pricing.gstAmount)} />
        {discount > 0 ? <SummaryRow label="Discount" value={`− ${formatCurrency(discount)}`} negative /> : null}
        <SummaryRow label="Grand total" value={formatCurrency(pricing.grandTotal)} bold />
        <SummaryRow label="Advance collected" value={formatCurrency(advance)} />
        <SummaryRow label="Outstanding" value={formatCurrency(outstanding)} bold />
      </div>

      {payments.length > 0 ? (
        <div className="rounded-md border border-border/60">
          <div className="border-b border-border/60 px-3 py-2 text-xs font-medium text-muted-foreground">Payments</div>
          <div className="divide-y divide-border/50">
            {payments.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {p.method || 'Payment'}
                  {p.gateway ? <span className="ml-1.5 text-muted-foreground">via {p.gateway}</span> : null}
                </span>
                <span className="shrink-0 tabular-nums font-medium text-foreground">{formatCurrency(Number(p.amount ?? 0))}</span>
                <span className="w-20 shrink-0 text-right capitalize text-muted-foreground">{p.status ?? ''}</span>
                <span className="w-24 shrink-0 text-right text-muted-foreground">{p.date ? formatDateTime(p.date) : ''}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {loading && !detail ? (
        <p className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading booking history…
        </p>
      ) : null}

      {events.length > 0 ? (
        <div className="rounded-md border border-border/60">
          <div className="border-b border-border/60 px-3 py-2 text-xs font-medium text-muted-foreground">History</div>
          <div className="divide-y divide-border/50">
            {events.map((e) => (
              <div key={e.id} className="px-3 py-1.5 text-xs">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium text-foreground">{e.event}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{e.createdAt ? formatDateTime(e.createdAt) : ''}</span>
                </div>
                {e.details ? <p className="text-[11px] text-muted-foreground">{e.details}</p> : null}
                {e.actor ? <p className="text-[11px] text-muted-foreground">by {e.actor}</p> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Availability for ONE booking line: the variant identity (name, SKU, selling
 * price), the quantity this line requires, and stock broken out PER STORE.
 *
 * The combined figure is labelled informational — a booking never allocates
 * across stores, so a silent cross-store total would invite selling stock the
 * selling store does not hold. Presentational (props in, markup out) so the
 * regression tests can exercise every state without booting the page.
 */
export function BookingLineAvailability({
  sku,
  variantName,
  sellingPrice,
  priceAdjustment,
  required,
  availability,
  selectedLocationId,
}: {
  sku: string
  variantName?: string | null
  sellingPrice?: number | null
  /** Variant add-on already inside `sellingPrice`; shown for traceability. */
  priceAdjustment?: number | null
  required: number
  /** Resolved data, `null` while in flight, `{ error }` when the call failed. */
  availability: LocationStockAvailability | null | { error: string } | undefined
  /**
   * The booking's ONE selling store. When it resolves among the returned
   * stores, that row is the actionable availability (emphasised, short-flagged)
   * and every other store is shown strictly as informational context — a
   * single-store booking can never be satisfied out of another store.
   */
  selectedLocationId?: string | null
}) {
  const error = availability && 'error' in availability ? availability.error : null
  const loading = availability === null
  const stock = availability && !('error' in availability) ? availability : null
  const selected = selectedLocationId
    ? stock?.locations.find((l) => l.locationId === selectedLocationId) ?? null
    : null
  const otherStores = selected
    ? stock!.locations.filter((l) => l.locationId !== selected.locationId)
    : stock?.locations ?? []

  const storeRow = (
    loc: { locationId: string; name: string; available: number },
    opts: { emphasized?: boolean; informational?: boolean },
  ) => {
    const short = required > loc.available
    return (
      <li key={loc.locationId} className="flex items-center justify-between gap-2">
        <span
          className={`min-w-0 truncate ${opts.emphasized ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
        >
          {loc.name}
          {opts.emphasized ? (
            <span className="ml-1.5 rounded bg-primary-50 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary-700">
              selected store
            </span>
          ) : null}
          {opts.informational ? (
            <span className="ml-1.5 text-[10px] uppercase tracking-wide">informational</span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
          <span className={short ? 'font-medium text-warning-700' : opts.emphasized ? 'font-semibold text-foreground' : 'text-foreground'}>
            {loc.available} available
          </span>
          {short ? (
            <span className="rounded bg-warning-50 px-1 py-0.5 text-warning-700">
              short {required - loc.available}
            </span>
          ) : null}
        </span>
      </li>
    )
  }

  return (
    <div className="mt-1.5 space-y-1 rounded-md border border-border/50 bg-card/60 px-2.5 py-1.5 text-[11px]">
      {/* Identity: variant name, exact SKU, catalogue selling price. */}
      <p className="flex flex-wrap items-center gap-x-1.5">
        {variantName ? <span className="font-medium text-foreground">{variantName}</span> : null}
        <span className="text-muted-foreground">
          SKU <span className="font-mono">{sku || '—'}</span>
        </span>
        {sellingPrice != null ? (
          <span className="text-muted-foreground">· Selling {formatCurrency(sellingPrice)}</span>
        ) : null}
        {Number(priceAdjustment) > 0 ? (
          <span className="font-medium text-violet-700">· Add-on ₹{priceAdjustment}</span>
        ) : null}
      </p>

      <p className="font-medium text-foreground">Required: {required}</p>

      {error ? (
        <p className="text-red-600">{error}</p>
      ) : loading || !stock ? (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Availability by store…
        </p>
      ) : stock.locations.length === 0 ? (
        <p className="text-muted-foreground">No stores configured.</p>
      ) : (
        <>
          <ul className="space-y-0.5">
            {selected ? storeRow(selected, { emphasized: true }) : null}
            {selected && otherStores.length > 0 ? (
              <li className="pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                Other stores — informational only
              </li>
            ) : null}
            {otherStores.map((loc) => storeRow(loc, selected ? { informational: true } : {}))}
          </ul>
          {/* Combined is information ONLY: a single-store booking is satisfied
              by the selected store above, never by pooling stores. */}
          <p className="border-t border-border/50 pt-1 text-muted-foreground">
            All stores: <span className="tabular-nums text-foreground">{stock.combined}</span>
            {' '}· informational only — cross-store stock is never allocated
          </p>
        </>
      )}
    </div>
  )
}

// Allocation PLANNING helpers (status math, tracked quantities, draft
// validation) live in @/lib/bookingAllocations — the pure frontend half of
// backend/src/bookings.ts — so this file exports only components.

export function AllocationStatusChip({ allocated, required }: { allocated: number; required: number }) {
  if (!(required > 0)) return null // nothing tracked (legacy/custom lines) → no chip
  const status = allocationStatusFor(allocated, required)
  if (status === 'fully') return <Badge variant="success" dot>Fully allocated {allocated}/{required}</Badge>
  if (status === 'partial') return <Badge variant="warning" dot>Partially allocated {allocated}/{required}</Badge>
  return <Badge variant="muted" dot>Unallocated</Badge>
}

/**
 * The allocation editor body: one card per CATALOGUE line — required, draft
 * allocated and remaining quantities, the live status chip, every store's
 * CURRENT stock, and the draft store rows (add / edit / remove). Pure
 * planning: availability is shown per store and never pooled. Presentational
 * (props in, markup out) so the tests can exercise it without the page.
 */
export function BookingAllocationBody({
  lines,
  rows,
  locations,
  availability,
  serverError,
  serverLineErrors,
  onAdd,
  onRemove,
  onChange,
}: {
  lines: BookingAllocationLine[]
  rows: AllocationDraft[]
  locations: InventoryLocation[]
  availability: Record<string, LocationStockAvailability | null | { error: string } | undefined>
  serverError?: string | null
  serverLineErrors?: Record<number, string>
  onAdd: (lineIndex: number) => void
  onRemove: (rowKey: string) => void
  onChange: (rowKey: string, patch: Partial<AllocationDraft>) => void
}) {
  const issues = allocationDraftIssues({ lines, rows, locations, availability })
  const trackedLines = lines.filter((l) => l.tracked)
  const untrackedLines = lines.filter((l) => !l.tracked)

  return (
    <div className="space-y-3 text-sm">
      {serverError ? (
        <div className="whitespace-pre-line rounded-md border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">
          {serverError}
        </div>
      ) : null}

      {trackedLines.length === 0 ? (
        <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
          Nothing to allocate — this booking has no catalogue lines (hand-typed lines carry no product or variant).
        </p>
      ) : null}

      {trackedLines.map((line) => {
        const lineRows = rows.filter((r) => r.lineIndex === line.lineIndex)
        const draftAllocated = lineRows.reduce((sum, r) => sum + Math.max(0, Math.floor(Number(r.quantity) || 0)), 0)
        const remaining = Math.max(0, line.required - draftAllocated)
        const stock = availability[`${line.productId ?? ''}|${line.variantId ?? ''}`]
        const stockError = stock && 'error' in stock ? stock.error : null
        const stockData = stock && !('error' in stock) ? stock : null
        const usedStores = new Set(lineRows.map((r) => r.locationId))
        const error = issues.perLine[line.lineIndex] ?? serverLineErrors?.[line.lineIndex]
        return (
          <div key={line.lineIndex} className="rounded-lg border bg-muted/30 p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">
                  {line.title || 'Item'}
                  {line.sku ? <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{line.sku}</span> : null}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Required {line.required} · Draft allocated {draftAllocated} · Remaining {remaining}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <AllocationStatusChip allocated={draftAllocated} required={line.required} />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onAdd(line.lineIndex)}
                  disabled={remaining <= 0 || lineRows.length >= locations.length}
                >
                  <Plus className="h-3.5 w-3.5" /> Add store
                </Button>
              </div>
            </div>

            {/* Every store's CURRENT stock for this exact product/variant —
                exactly what the server validates a save against. */}
            {stockData ? (
              <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                {stockData.locations.map((loc) => (
                  <li key={loc.locationId}>
                    {loc.name}: <span className="tabular-nums text-foreground">{loc.available} available</span>
                  </li>
                ))}
              </ul>
            ) : stock === null ? (
              <p className="mt-1.5 text-[11px] text-muted-foreground">Loading store availability…</p>
            ) : stockError ? (
              <p className="mt-1.5 text-[11px] text-red-600">{stockError}</p>
            ) : null}

            <div className="mt-2 space-y-1.5">
              {lineRows.map((row) => {
                const storeName = locations.find((l) => l.id === row.locationId)?.name ?? 'Unknown store'
                const options = locations
                  .filter((l) => !usedStores.has(l.id) || l.id === row.locationId)
                  .map((l) => ({ value: l.id, label: locationLabel(null, l.id, locations) }))
                return (
                  <div key={row.key} className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <Select
                        options={options}
                        value={row.locationId}
                        onValueChange={(v) => onChange(row.key, { locationId: v })}
                      />
                    </div>
                    <Input
                      type="number"
                      min="1"
                      step="1"
                      className="w-20 text-right"
                      value={row.quantity}
                      onChange={(e) => onChange(row.key, { quantity: e.target.value })}
                      aria-label={`Quantity allocated at ${storeName}`}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onRemove(row.key)}
                      aria-label={`Remove store allocation at ${storeName}`}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                )
              })}
              {lineRows.length === 0 ? (
                <p className="text-[11px] text-warning-700">Not allocated to any store yet.</p>
              ) : null}
            </div>
            {error ? <p className="mt-1 text-[12px] text-red-600">{error}</p> : null}
          </div>
        )
      })}

      {untrackedLines.length > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {untrackedLines.length} hand-typed line(s) carry no catalogue product and need no allocation.
        </p>
      ) : null}
    </div>
  )
}

/** Booking orders: take an advance, fulfil later, convert to invoice when ready. */
export default function Bookings() {
  const [bookings, setBookings] = useState<SalesOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [converting, setConverting] = useState<string | null>(null)
  // Which row's cancel call is in flight (avoids double-submits).
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [refunding, setRefunding] = useState<string | null>(null)

  // Catalogue + managed silver rate + store GST rate: everything the form
  // needs to price a line the way Sales Orders does.
  const [products, setProducts] = useState<Product[]>([])
  const [defaultGst, setDefaultGst] = useState('3')
  /** Stores the selling-store selector offers (and every store label resolves against). */
  const [locations, setLocations] = useState<InventoryLocation[]>([])
  const { rate } = useSilverRate()
  const ratePerGram = rate?.rate ?? 0

  // Shared create/edit form (Purchase Orders pattern: one dialog, an edit
  // target that is null for a new booking, a JSON baseline for the dirty
  // guard, and inline field/line errors).
  const [formOpen, setFormOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<SalesOrder | null>(null)
  const [form, setForm] = useState<BookingFormState>({
    customer: '', customerId: '', email: '', phone: '',
    date: today(), expectedDate: '', gst: '3', discount: '0', advance: '', note: '', status: 'confirmed',
    locationId: DEFAULT_STORE_ID,
  })
  const [lines, setLines] = useState<DraftLine[]>([newLine()])
  /**
   * Per-store availability for each line's product/variant, keyed by
   * `${productId}|${variantId}` so lines sharing a target share one request.
   * undefined = not requested, null = in flight, { error } = failed.
   * Display only — creating or editing a booking never reserves stock.
   */
  const [availability, setAvailability] = useState<Record<string, LocationStockAvailability | null | { error: string }>>({})
  const requestedTargets = useRef<Set<string>>(new Set())

  // ── Allocation (Phase 3): planning records across stores — they never
  //    reserve or move stock; conversion revalidates at fulfilment time. ──
  const [allocOpen, setAllocOpen] = useState(false)
  const [allocTarget, setAllocTarget] = useState<SalesOrder | null>(null)
  const [allocSummary, setAllocSummary] = useState<BookingAllocationSummary | null>(null)
  const [allocRows, setAllocRows] = useState<AllocationDraft[]>([])
  const [allocBaseline, setAllocBaseline] = useState('')
  const [allocLoading, setAllocLoading] = useState(false)
  const [allocSaving, setAllocSaving] = useState(false)
  const [allocError, setAllocError] = useState('')
  const [allocLineErrors, setAllocLineErrors] = useState<Record<number, string>>({})
  const [formBaseline, setFormBaseline] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({})

  // View (details) state: the row's eye action opens the same booking data the
  // table shows, plus the invoice / payments / history from the order-360 call.
  const [viewTarget, setViewTarget] = useState<SalesOrder | null>(null)
  const [viewDetail, setViewDetail] = useState<OrderFullDetail | null>(null)
  const [viewLoading, setViewLoading] = useState(false)
  const [viewError, setViewError] = useState('')

  // Listing: search, status filter, pagination (Purchase Orders chrome).
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [page, setPage] = useState(1)

  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { hasPermission } = useAuth()
  // The API enforces these too (requirePermission on every booking route);
  // hiding what a role cannot run keeps the page honest instead of failing
  // with an "Access denied" toast after the click.
  const canCreate = hasPermission('sales', 'create')
  const canEdit = hasPermission('sales', 'edit')

  const PAGE_SIZE = 20
  const load = async () => {
    setLoading(true)
    setError('')
    try {
      // Server-side predicate: booking rows only, never the store's other
      // orders (the page used to download everything and filter here).
      setBookings(await dbApi.getBookings())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bookings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(() => {
      void load()
    })
    dbApi.getProducts().then(setProducts).catch(() => setProducts([]))
    dbApi.getInventoryLocations().then(setLocations).catch(() => setLocations([]))
    dbApi.getSettings()
      .then((s) => {
        if (s?.gstRate != null) queueMicrotask(() => setDefaultGst(String(s.gstRate)))
      })
      .catch(() => undefined)
  }, [])

  const openView = (b: SalesOrder) => {
    setViewTarget(b)
    setViewDetail(null)
    setViewError('')
    setViewLoading(true)
    dbApi.getOrderFull(b.id)
      .then((d) => setViewDetail(d))
      .catch((err) => setViewError(err instanceof Error ? err.message : 'Failed to load the booking details'))
      .finally(() => setViewLoading(false))
  }

  /**
   * Open the shared form for a new booking (no argument) or to edit one.
   * Every field is prefilled from the stored row — including the product and
   * variant relationships — so a save round-trips exactly what was booked.
   */
  const openForm = useCallback((target?: SalesOrder) => {
    const next: BookingFormState = target
      ? {
          customer: target.customer ?? '',
          customerId: '',
          email: target.customerEmail ?? '',
          phone: target.customerPhone ?? '',
          date: target.date ? target.date.slice(0, 10) : today(),
          expectedDate: target.expectedDelivery ? target.expectedDelivery.slice(0, 10) : '',
          gst: target.gst != null ? String(target.gst) : defaultGst,
          discount: String(target.discount ?? 0),
          advance: String(target.advancePaid ?? 0),
          note: target.note ?? '',
          status: FORM_STATUSES.includes((target.status ?? '') as never) ? String(target.status) : 'confirmed',
          // A legacy booking (NULL) displays the default store — the only
          // store it has ever sold from — and keeps that NULL until the user
          // genuinely picks a different store.
          locationId: target.locationId ?? DEFAULT_STORE_ID,
        }
      : {
          customer: '', customerId: '', email: '', phone: '',
          date: today(), expectedDate: '', gst: defaultGst, discount: '0', advance: '', note: '', status: 'confirmed',
          locationId: DEFAULT_STORE_ID,
        }
    const nextLines: DraftLine[] = target
      ? (target.lineItems ?? []).map((li) => {
          const extra = li as { productId?: string; variantId?: string }
          return {
            key: crypto.randomUUID(),
            productId: extra.productId ?? '',
            variantId: extra.variantId ?? '',
            title: li.title ?? '',
            sku: li.sku ?? '',
            // Legacy/hand lines have no catalogue id: show them as typed rows.
            custom: !extra.productId && Boolean(li.title),
            qty: String(li.quantity ?? 1),
            price: li.price != null ? String(li.price) : '',
            // The add-on is already in the per-unit price; keep the durable
            // delta so re-open/save never adds it a second time.
            priceAdjustment: li.priceAdjustment ?? undefined,
          }
        })
      : [newLine()]
    if (nextLines.length === 0) nextLines.push(newLine())
    setEditTarget(target ?? null)
    setForm(next)
    setLines(nextLines)
    setFormBaseline(JSON.stringify({ form: next, lines: nextLines }))
    setFieldErrors({})
    setLineErrors({})
    setFormError('')
    setViewTarget(null)
    setFormOpen(true)
    // Only the GST default (a loaded setting) changes this callback's identity.
  }, [defaultGst])

  // The global "+" menu deep-links to /sales/bookings?new=1 — honour it, then
  // consume the flag so the NEXT visit to a clean /sales/bookings (or a second
  // click on the same menu entry) starts from a closed dialog, and so a plain
  // reload never re-opens a dialog the user just dismissed. Declared after
  // openForm so the reference needs no suppression.
  useEffect(() => {
    if (searchParams.get('new') !== '1') return
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('new')
      return next
    }, { replace: true })
    queueMicrotask(() => {
      if (canCreate) openForm()
    })
  }, [searchParams, setSearchParams, canCreate, openForm])

  const setFormValue = <K extends keyof BookingFormState>(key: K, value: BookingFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const setLine = (key: string, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))
    setLineErrors((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const removeLine = (key: string) =>
    setLines((prev) => (prev.length === 1 ? [newLine()] : prev.filter((l) => l.key !== key)))

  /**
   * Every row the Product dropdown can sell: one per VARIANT when the product
   * has them (so a held code like `OL-GIF-001-RED` is its own selectable,
   * searchable line), one for the product itself when it does not. Built from
   * the SAME helper the invoice and order pickers use, and re-keyed by the
   * per-store availability cache — which is itself keyed by
   * `${productId}|${variantId}`, exactly this option value.
   */
  const sellables = useMemo(
    () => flattenSellableItems(products, availability),
    [products, availability],
  )

  /**
   * Picking a catalogue row: name, SKU, relationship ids and the price all
   * come from that flattened row. The price follows the row's pricing mode —
   * a Piece Rate row opens at its fixed ₹/pc and a weight-based row at the
   * managed silver-rate calculation — so a ₹2,000/pc product can never be
   * re-priced by silver weight here. Both stay editable.
   */
  const selectProduct = (key: string, value: string) => {
    if (value === CUSTOM_PRODUCT) {
      setLine(key, { productId: '', variantId: '', title: '', sku: '', custom: true, price: '', priceAdjustment: undefined })
      return
    }
    const { productId, variantId } = parseSellableValue(value)
    // The requested pair first; a line pointing at a product that has since
    // gained variants falls back to the product's own row rather than silently
    // doing nothing.
    const item =
      sellables.find((s) => s.productId === productId && (s.variantId ?? null) === variantId) ??
      sellables.find((s) => s.productId === productId && s.variantId === null)
    if (!item) return
    applySellable(key, item)
  }

  /** Swap the variant: SKU, title and price all follow the selection. */
  const selectVariant = (key: string, variantId: string) => {
    const line = lines.find((l) => l.key === key)
    if (!line?.productId) return
    const item = sellables.find((s) => s.productId === line.productId && s.variantId === variantId)
    if (!item) return
    applySellable(key, item)
  }

  /** Write one flattened row onto a line — the single place titles come from. */
  const applySellable = (key: string, item: SellableItem) => {
    const price = sellableItemPrice(item, { silverRate: ratePerGram })
    setLine(key, {
      productId: item.productId,
      variantId: item.variantId ?? '',
      title: item.variantId ? `${item.productName} — ${item.variantName}` : item.productName,
      sku: item.sku,
      custom: false,
      price: price != null ? String(price) : '',
      // `sellableItemPrice` already includes this GST-inclusive delta; snapshot
      // it on the line so a later silver-rate change cannot silently lose it.
      priceAdjustment: item.priceAdjustment,
    })
  }

  /**
   * What the line points at, for display: the exact variant name and its
   * catalogue selling price (base + variant add-on, Default-Title safe — the
   * same fallback the auto-priced line price was filled from).
   */
  const lineIdentity = (line: DraftLine): { variantName: string | null; sellingPrice: number | null } => {
    if (!line.productId) return { variantName: null, sellingPrice: null }
    const p = products.find((x) => x.id === line.productId)
    if (!p) return { variantName: null, sellingPrice: null }
    const v = line.variantId ? findVariantById(p, line.variantId) : null
    return {
      variantName: v ? variantLabel(v) : null,
      sellingPrice: (v ? variantEffectivePrice(p.sellingPrice, v) : p.sellingPrice) ?? null,
    }
  }

  const productOptions = useMemo(() => {
    const options = sellableItemOptions(sellables)
    // A line saved BEFORE the pickers flattened variants — or written by a
    // client that only ever sent a bare product id — may name a pair that is
    // no longer an option of its own. Give that line its own row so opening
    // the form for an untouched edit never blanks the picker.
    for (const l of lines) {
      if (l.custom || !l.productId) continue
      const value = sellableItemValue({ productId: l.productId, variantId: l.variantId || null })
      if (options.some((o) => o.value === value)) continue
      const p = products.find((x) => x.id === l.productId)
      if (p) {
        options.push({
          value,
          label: p.name,
          subtitle: p.sku || undefined,
          keywords: [p.sku, p.name].filter(Boolean).join(' '),
        })
      }
    }
    options.push({ value: CUSTOM_PRODUCT, label: 'Type manually…', subtitle: 'Not in the catalogue', keywords: '' })
    return options
  }, [sellables, lines, products])

  /** What the selling-store selector offers; the default store is always present. */
  const knownLocations = useMemo(
    () => (locations.length > 0 ? locations : [DEFAULT_STORE_FALLBACK]),
    [locations],
  )
  const locationOptions = useMemo(
    () => knownLocations.map((l) => ({ value: l.id, label: locationLabel(null, l.id, knownLocations) })),
    [knownLocations],
  )

  // Live totals — the SAME formula the backend stores and the invoice will
  // hold (see lib/bookingPricing.ts, pinned against backend/src/bookings.ts).
  const totals = useMemo(() => {
    const counted = lines
      .filter((l) => l.title.trim() !== '')
      .map((l) => ({ price: Number(l.price) || 0, qty: Math.max(0, Math.floor(Number(l.qty) || 0)) }))
    return bookingPricing(counted, Number(form.gst) || 0, Number(form.discount) || 0, Number(form.advance) || 0)
  }, [lines, form.gst, form.discount, form.advance])

  /**
   * Fetch per-store availability for one `${productId}|${variantId}` target
   * into the shared cache — once per target (guarded by the ref, so StrictMode
   * double-runs and repeated effects never duplicate a request).
   */
  const requestAvailability = useCallback((target: string) => {
    if (requestedTargets.current.has(target)) return
    requestedTargets.current.add(target)
    setAvailability((prev) => ({ ...prev, [target]: null }))
    const [productId, variantId] = target.split('|')
    dbApi
      .getBookingStockByLocation(productId, variantId || undefined)
      .then((data) => setAvailability((prev) => ({ ...prev, [target]: data })))
      .catch((err) =>
        setAvailability((prev) => ({
          ...prev,
          [target]: { error: err instanceof Error ? err.message : 'Failed to load stock by location' },
        })),
      )
  }, [])

  // Form lines: fetched when a line points at a NEW product/variant (quantity
  // or price edits never refetch — stock does not depend on them). Read-only:
  // nothing is reserved or deducted, each store on its own row.
  const availabilitySignature = lines.map((l) => `${l.productId}:${l.variantId}`).join('|')
  useEffect(() => {
    const targets = [...new Set(lines.filter((l) => l.productId).map((l) => `${l.productId}|${l.variantId || ''}`))]
    for (const target of targets) requestAvailability(target)
    // `lines` is captured through the signature (same product/variant fields).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availabilitySignature, requestAvailability])

  // The allocation dialog needs availability for the BOOKING's lines (its rows
  // are not part of the form) — same cache, same once-per-target guard.
  useEffect(() => {
    if (!allocSummary) return
    const targets = [
      ...new Set(allocSummary.lines.filter((l) => l.tracked && l.productId).map((l) => `${l.productId}|${l.variantId ?? ''}`)),
    ]
    for (const target of targets) requestAvailability(target)
  }, [allocSummary, requestAvailability])

  const stats = useMemo(
    // A cancelled booking is closed business everywhere (Phase 5.1): it
    // leaves the pending/outstanding pipelines AND the active advance — its
    // advance was reversed in the payment ledger with an Advance Refund
    // entry, so counting it would report cash the business no longer holds.
    () => bookingStats(bookings),
    [bookings],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return bookings.filter((b) => {
      const matchQ =
        !q ||
        (b.internalId ?? '').toLowerCase().includes(q) ||
        (b.customer ?? '').toLowerCase().includes(q) ||
        (b.invoice ?? '').toLowerCase().includes(q)
      const matchStatus =
        statusFilter === 'all'
          ? true
          : statusFilter === 'awaiting'
            ? !b.invoice && !isCancelled(b)
            : statusFilter === 'fulfilled'
              ? Boolean(b.invoice)
              : b.status === statusFilter
      return matchQ && matchStatus
    })
  }, [bookings, query, statusFilter])

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pages)
  const pageRows = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
  )

  const onSearch = (value: string) => {
    setQuery(value)
    setPage(1)
  }
  const onStatusFilter = (value: string) => {
    setStatusFilter(value)
    setPage(1)
  }

  /**
   * Open the invoice a booking became. The list row only carries the invoice
   * NUMBER, and invoice detail routes by id — one order-360 call resolves it.
   */
  const openInvoice = async (b: SalesOrder) => {
    try {
      const d = await dbApi.getOrderFull(b.id)
      if (d.invoice) navigate(`/sales/invoices/${d.invoice.id}`)
      else toast.error('No invoice is linked to this booking yet')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to open the invoice')
    }
  }

  const sendPaymentLink = async (b: SalesOrder) => {
    try {
      const r = await dbApi.bookingPaymentLink(b.id)
      window.open(r.url, '_blank', 'noopener')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Payment link failed')
    }
  }

  const convert = async (b: SalesOrder) => {
    if (!(await confirmDialog({ title: `Convert booking ${b.internalId || b.id} to invoice? Advance of ${formatCurrency(Number(b.advancePaid ?? 0))} will be applied.` }))) return
    setConverting(b.id)
    setViewTarget(null)
    try {
      const r = await dbApi.convertBooking(b.id)
      toast.success(`Invoice ${r.invoiceNumber} created — advance ${formatCurrency(r.advanceApplied)}, balance ${formatCurrency(r.balance)}`)
      void load()
    } catch (err) {
      // A stock refusal arrives as a structured 409 — formatApiError expands
      // it to product/variant, available, requested and shortage per line.
      toast.error(formatApiError(err, 'Conversion failed'))
    } finally {
      setConverting(null)
    }
  }

  /**
   * Cancel an un-converted booking through the order-status endpoint every
   * other sales screen uses — the same `cancelled` the pipeline and the
   * follow-ups already understand, so a cancelled booking drops out of the
   * "needs chasing" lists without any extra bookkeeping. The advance already
   * collected is deliberately NOT touched: refunding money is a separate,
   * explicit act (returns/refunds), never a side effect of cancelling.
   */
  const cancelBooking = async (b: SalesOrder) => {
    const label = b.internalId || b.id.slice(0, 8)
    const confirmed = await confirmDialog({
      title: `Cancel booking ${label}?`,
      description:
        'The booking can no longer be edited or converted. Any advance already collected STAYS recorded — cancellation is not a refund. Record an advance refund from the booking once the money is actually returned.',
      confirmLabel: 'Cancel booking',
      danger: true,
    })
    if (!confirmed) return
    setCancelling(b.id)
    try {
      await dbApi.updateOrderStatus(b.id, 'cancelled')
      toast.success(`Booking ${label} cancelled`)
      if (viewTarget?.id === b.id) setViewTarget(null)
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not cancel the booking')
    } finally {
      setCancelling(null)
    }
  }

  /**
   * Record an ACTUAL advance refund (Phase 5.1 correction): cancellation
   * never moves money — this is the ONLY path an `Advance Refund` entry is
   * written, and only for cash the payment ledger still holds. The API caps
   * the amount at the refundable balance, so a duplicate full refund is
   * refused instead of double-paying; the original collection is untouched.
   */
  const refundAdvance = async (b: SalesOrder) => {
    const refundable = Number(b.advanceRefundable ?? 0)
    if (!(refundable > 0)) return
    if (
      !(await confirmDialog({
        title: `Record advance refund for ${b.internalId || b.id}?`,
        description: `Confirm that ${formatCurrency(refundable)} was actually returned to the customer. This adds an Advance Refund payment entry — the original collection is never changed or deleted.`,
        confirmLabel: 'Record refund',
      }))
    )
      return
    setRefunding(b.id)
    try {
      const r = await dbApi.refundBookingAdvance(b.id)
      toast.success(
        `Advance refund of ${formatCurrency(r.amount)} recorded — ${formatCurrency(r.refundable)} still refundable`,
      )
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Refund failed')
    } finally {
      setRefunding(null)
    }
  }

  /**
   * Open the allocation editor for a booking: the stored plan (or, for a
   * never-allocated booking, an UNSAVED prefill at the store the booking
   * already sells from — nothing is written until Save, so legacy bookings are
   * never silently converted into allocation records).
   */
  const openAllocation = (b: SalesOrder) => {
    setAllocTarget(b)
    setAllocSummary(null)
    setAllocRows([])
    setAllocBaseline('')
    setAllocError('')
    setAllocLineErrors({})
    setAllocLoading(true)
    setViewTarget(null)
    setAllocOpen(true)
    dbApi
      .getBookingAllocations(b.id)
      .then((summary) => {
        setAllocSummary(summary)
        const initial: AllocationDraft[] =
          summary.allocations.length > 0
            ? summary.allocations.map((a) => ({
                key: crypto.randomUUID(),
                lineIndex: a.lineIndex,
                locationId: a.locationId,
                quantity: String(a.quantity),
              }))
            : summary.lines
                .filter((l) => l.tracked && l.required > 0)
                .map((l) => ({
                  key: crypto.randomUUID(),
                  lineIndex: l.lineIndex,
                  locationId: summary.suggestedLocationId ?? DEFAULT_STORE_ID,
                  quantity: String(l.required),
                }))
        setAllocRows(initial)
        setAllocBaseline(JSON.stringify(initial))
      })
      .catch((err) => setAllocError(err instanceof Error ? err.message : 'Failed to load allocations'))
      .finally(() => setAllocLoading(false))
  }

  /** Add a store row for a line: the first unused store, qty = what still remains. */
  const addAllocRow = (lineIndex: number) => {
    setAllocRows((prev) => {
      const used = new Set(prev.filter((r) => r.lineIndex === lineIndex).map((r) => r.locationId))
      const free = knownLocations.find((l) => !used.has(l.id))
      if (!free) return prev
      const line = allocSummary?.lines.find((l) => l.lineIndex === lineIndex)
      const already = prev
        .filter((r) => r.lineIndex === lineIndex)
        .reduce((sum, r) => sum + Math.max(0, Math.floor(Number(r.quantity) || 0)), 0)
      const remaining = line ? Math.max(1, line.required - already) : 1
      return [...prev, { key: crypto.randomUUID(), lineIndex, locationId: free.id, quantity: String(remaining) }]
    })
  }

  const removeAllocRow = (key: string) => setAllocRows((prev) => prev.filter((r) => r.key !== key))

  const changeAllocRow = (key: string, patch: Partial<AllocationDraft>) =>
    setAllocRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  const allocIssues = useMemo(
    () =>
      allocSummary
        ? allocationDraftIssues({ lines: allocSummary.lines, rows: allocRows, locations: knownLocations, availability })
        : { invalid: false, perLine: {} as Record<number, string> },
    [allocSummary, allocRows, knownLocations, availability],
  )

  /**
   * Save the allocation set (replace-all: edit, redistribute or clear in one
   * call). The draft is validated client-side for instant feedback, then the
   * SERVER re-validates every row against each store's real availability —
   * shortfalls and line mismatches come back and are shown inline.
   */
  const saveAllocations = async () => {
    if (!allocTarget || !allocSummary) return
    const payload = allocRows.map((r) => {
      const line = allocSummary.lines.find((l) => l.lineIndex === r.lineIndex)
      return {
        lineIndex: r.lineIndex,
        locationId: r.locationId,
        quantity: Math.max(0, Math.floor(Number(r.quantity) || 0)),
        // Identity is sent so the server can prove the row still matches the
        // booked line (an unrelated variant/product is refused server-side).
        ...(line?.productId ? { productId: line.productId, variantId: line.variantId, sku: line.sku } : {}),
      }
    })
    setAllocSaving(true)
    setAllocError('')
    setAllocLineErrors({})
    try {
      await dbApi.putBookingAllocations(allocTarget.id, payload)
      // Rows are replaced wholesale (fresh ids) and availability entries are
      // keyed by allocation id — refetch to stay exact.
      const fresh = await dbApi.getBookingAllocations(allocTarget.id)
      setAllocSummary(fresh)
      const rowsNow = fresh.allocations.map((a) => ({
        key: crypto.randomUUID(),
        lineIndex: a.lineIndex,
        locationId: a.locationId,
        quantity: String(a.quantity),
      }))
      setAllocRows(rowsNow)
      setAllocBaseline(JSON.stringify(rowsNow))
      const tracked = fresh.lines.filter((l) => l.tracked)
      const allocated = tracked.reduce((a, l) => a + l.allocated, 0)
      const required = tracked.reduce((a, l) => a + l.required, 0)
      toast.success(
        fresh.status === 'fully'
          ? `Allocations saved — fully allocated (${allocated}/${required})`
          : fresh.status === 'partial'
            ? `Allocations saved — partially allocated (${allocated}/${required})`
            : 'Allocations saved — nothing allocated yet',
      )
      void load() // refresh the list's allocation totals
    } catch (err) {
      const api = err instanceof ApiError ? err : null
      setAllocError(formatApiError(err, 'Failed to save allocations'))
      if (api?.details) {
        const map: Record<number, string> = {}
        for (const d of api.details) {
          if (d.lineIndex === undefined) continue
          map[d.lineIndex] =
            d.required !== undefined && d.allocated !== undefined
              ? `Allocated ${d.allocated} but only ${d.required} booked — adjust the quantities.`
              : 'This line does not match the booked product/variant.'
        }
        setAllocLineErrors(map)
      } else if (api?.code === 'INSUFFICIENT_STOCK' && api.products) {
        const map: Record<number, string> = {}
        for (const p of api.products) {
          const idx = allocSummary.lines.find((l) => l.sku === p.sku)?.lineIndex
          if (idx !== undefined) {
            const short = p.shortage ?? Math.max(0, p.requested - p.available)
            map[idx] = `Only ${p.available} available at ${p.location ?? 'that store'} — ${short} short.`
          }
        }
        setAllocLineErrors(map)
      }
    } finally {
      setAllocSaving(false)
    }
  }

  /**
   * Validate the form the way the backend will, but inline: incomplete lines
   * get their own message, header fields get theirs, and nothing is sent that
   * the API would reject.
   */
  const submitForm = async () => {
    const nextField: Record<string, string> = {}
    const nextLine: Record<string, string> = {}
    const customer = form.customer.trim()
    if (!customer) nextField.customer = 'Customer name is required'
    if (!form.date) nextField.date = 'Booking date is required'
    const gst = Number(form.gst)
    if (!Number.isFinite(gst) || gst < 0 || gst > 100) nextField.gst = 'GST must be between 0 and 100'
    const discount = Number(form.discount)
    if (!Number.isFinite(discount) || discount < 0) nextField.discount = 'Discount cannot be negative'
    const advance = Number(form.advance || '0')
    if (!Number.isFinite(advance) || advance < 0) nextField.advance = 'Advance cannot be negative'
    if (!form.locationId) nextField.locationId = 'Selling store is required'

    let validCount = 0
    for (const l of lines) {
      if (isPristineLine(l)) continue
      const title = l.title.trim()
      const qty = Math.floor(Number(l.qty) || 0)
      const price = Number(l.price)
      if (!title) {
        nextLine[l.key] = 'Enter a product name'
        continue
      }
      if (!(qty >= 1)) {
        nextLine[l.key] = 'Quantity must be at least 1'
        continue
      }
      if (l.price === '' || !Number.isFinite(price) || price < 0) {
        nextLine[l.key] = 'Enter a price (₹)'
        continue
      }
      validCount++
    }
    if (validCount === 0) nextField.lines = 'Add at least one item with a product name, quantity and price'

    // Money rules — mirror the API's own guards so the user is told here.
    if (!nextField.gst && !nextField.discount) {
      const preDiscount = Math.round((totals.taxable + totals.gstAmount) * 100) / 100
      if (discount > preDiscount) nextField.discount = 'Discount cannot be the full booking amount'
      else if (!(preDiscount - discount > 0)) nextField.lines = 'The booking total must be greater than 0'
    }
    if (!nextField.advance && advance > totals.grandTotal) {
      nextField.advance = 'Advance cannot exceed the grand total'
    }

    setFieldErrors(nextField)
    setLineErrors(nextLine)
    if (Object.keys(nextField).length > 0 || Object.keys(nextLine).length > 0) {
      setFormError('')
      return
    }

    const payloadItems = lines
      .filter((l) => l.title.trim() && !nextLine[l.key])
      .map((l) => ({
        product: l.title.trim(),
        sku: l.sku.trim() || undefined,
        qty: Math.max(1, Math.floor(Number(l.qty) || 1)),
        price: Math.round((Number(l.price) || 0) * 100) / 100,
        // Already folded into `price` by the picker — never re-added by the
        // server. Kept so the booked line/converted invoice can name it.
        ...(l.priceAdjustment != null ? { priceAdjustment: l.priceAdjustment } : {}),
        ...(l.productId ? { productId: l.productId } : {}),
        ...(l.variantId ? { variantId: l.variantId } : {}),
      }))

    const payload = {
      customer,
      email: form.email.trim(),
      phone: form.phone.trim(),
      ...(form.customerId ? { customerId: form.customerId } : {}),
      date: form.date,
      expectedDate: form.expectedDate || null,
      // The single store: a NEW booking always records its store; an EDIT sends
      // one only when the selection differs from what the row already holds —
      // a legacy booking (NULL = default store) therefore keeps its NULL
      // instead of being silently rewritten to a default id.
      ...(editTarget
        ? form.locationId !== (editTarget.locationId ?? DEFAULT_STORE_ID)
          ? { locationId: form.locationId }
          : {}
        : { locationId: form.locationId }),
      gst,
      discount,
      advanceAmount: advance,
      note: form.note.trim(),
      items: payloadItems,
      // Only send a status when the select is actually available (it is
      // hidden for legacy statuses outside the form's two-value whitelist),
      // so an unexpected stored status can never be silently overwritten.
      ...(editTarget && FORM_STATUSES.includes((editTarget.status ?? '') as never)
        ? { status: form.status as 'confirmed' | 'processing' }
        : {}),
    }

    setSaving(true)
    setFormError('')
    try {
      if (editTarget) {
        await dbApi.updateBooking(editTarget.id, payload)
        toast.success(`Booking ${editTarget.internalId || editTarget.id} updated`)
      } else {
        const created = await dbApi.createBooking(payload)
        toast.success(`Booking ${created.internalId || 'created'} recorded`)
      }
      setFormOpen(false)
      setEditTarget(null)
      void load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save the booking')
    } finally {
      setSaving(false)
    }
  }

  const columns = useMemo<ColumnDef<SalesOrder>[]>(() => [
    {
      accessorKey: 'internalId',
      header: 'Booking',
      meta: { headerClassName: 'min-w-[170px]' },
      cell: ({ row }) => (
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
            <ShoppingBag className="h-4 w-4" />
          </div>
          <div>
            <p className="font-mono font-medium text-foreground">{row.original.internalId || row.original.id.slice(0, 8)}</p>
            <p className="text-[11px] text-muted-foreground">{formatDate(row.original.date)}</p>
          </div>
        </div>
      ),
    },
    {
      accessorKey: 'date',
      header: 'Date',
      cell: ({ row }) => (
        <div>
          <p className="text-sm text-foreground">{row.original.date ? formatDate(row.original.date) : '—'}</p>
          {row.original.expectedDelivery ? (
            <p className="text-[11px] text-muted-foreground">exp. {formatDate(row.original.expectedDelivery)}</p>
          ) : null}
        </div>
      ),
    },
    {
      accessorKey: 'customer',
      header: 'Customer',
      // Straight through to Customer 360 — bookings are matched by name, and
      // that page resolves orders, invoices and payments for any name.
      cell: ({ row }) =>
        row.original.customer ? (
          <Link className="text-sm hover:underline" to={`/sales/customers/${encodeURIComponent(row.original.customer)}`}>
            {row.original.customer}
          </Link>
        ) : (
          <span className="text-sm">—</span>
        ),
    },
    {
      id: 'items',
      header: 'Items',
      meta: { headerClassName: 'min-w-[180px]' },
      cell: ({ row }) => {
        const summary = itemsSummary(row.original)
        return summary ? (
          <div className="min-w-0">
            <p className="truncate text-sm text-foreground" title={summary}>{summary}</p>
            <p className="text-[11px] text-muted-foreground">{row.original.items ?? 0} pcs</p>
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )
      },
    },
    {
      accessorKey: 'value',
      header: 'Total',
      meta: { align: 'right' as const },
      cell: ({ row }) => (
        <span className="text-sm font-semibold tabular-nums text-foreground">{formatCurrency(Number(row.original.value ?? 0))}</span>
      ),
    },
    {
      accessorKey: 'advancePaid',
      header: 'Advance',
      meta: { align: 'right' as const },
      cell: ({ row }) => {
        const b = row.original
        const v = Number(b.value ?? 0)
        const adv = Number(b.advancePaid ?? 0)
        // A cancelled booking's money is REFUNDABLE, not active: show what
        // the payment ledger still holds and an operator may explicitly
        // return (Phase 5.1) — cancellation itself never moves cash.
        const refundable = Number(b.advanceRefundable ?? 0)
        if (isCancelled(b)) {
          return refundable > 0 ? (
            <Badge variant="warning">{formatCurrency(refundable)} refundable</Badge>
          ) : (
            <Badge variant="muted">{formatCurrency(adv)}</Badge>
          )
        }
        const full = v > 0 && adv >= v
        return <Badge variant={full ? 'default' : 'secondary'}>{formatCurrency(adv)}{full ? ' · Full' : ''}</Badge>
      },
    },
    {
      id: 'balance',
      header: 'Balance',
      meta: { align: 'right' as const },
      cell: ({ row }) => {
        if (isCancelled(row.original)) return <span className="text-sm text-muted-foreground">—</span>
        const balance = bookingBalance(row.original)
        return (
          <span className={`text-sm tabular-nums ${balance > 0 ? 'font-medium text-warning-700' : 'text-muted-foreground'}`}>
            {formatCurrency(balance)}
          </span>
        )
      },
    },
    {
      id: 'status',
      header: 'Status',
      meta: { align: 'center' as const },
      cell: ({ row }) => {
        // A cancelled booking is closed: it must never still read as waiting
        // for a conversion it can no longer perform.
        if (isCancelled(row.original)) return <Badge variant="danger" dot>Cancelled</Badge>
        const tracked = trackedQuantity(row.original)
        const allocationChip =
          tracked > 0 && isOpenBooking(row.original) ? (
            <AllocationStatusChip allocated={row.original.allocated ?? 0} required={tracked} />
          ) : null
        const primary = row.original.invoice ? (
          // The number is a live link: the list carries the NUMBER, so one
          // order-360 call resolves the id the invoice page routes by.
          <button
            type="button"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline"
            title="Open the invoice this booking became"
            onClick={() => void openInvoice(row.original)}
          >
            <Receipt className="h-3 w-3" /> {row.original.invoice}
          </button>
        ) : (() => {
          const meta = BOOKING_STATUS[row.original.status] ?? null
          return meta && row.original.status !== 'confirmed' ? (
            <Badge variant={meta.variant} dot>{meta.label}</Badge>
          ) : (
            <Badge variant="secondary">Awaiting conversion</Badge>
          )
        })()
        if (!allocationChip) return primary
        // Status + allocation state together: how far this open booking is
        // planned across stores.
        return (
          <div className="flex flex-col items-center gap-1">
            {primary}
            {allocationChip}
          </div>
        )
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      meta: { align: 'right' as const, headerClassName: 'w-10' },
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-0.5">
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="View booking" onClick={() => openView(row.original)}>
                  <Eye className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>View booking</TooltipContent>
            </Tooltip>
            {isOpenBooking(row.original) ? (
              <>
                  {canEdit ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="Edit booking" onClick={() => openForm(row.original)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Edit booking</TooltipContent>
                  </Tooltip>
                ) : null}
                {canEdit ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="Allocate stock" onClick={() => openAllocation(row.original)}>
                        <Layers className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Allocate across stores</TooltipContent>
                  </Tooltip>
                ) : null}
                {canCreate ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Convert to invoice"
                        disabled={converting === row.original.id}
                        onClick={() => convert(row.original)}
                      >
                        {converting === row.original.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Receipt className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Convert to invoice</TooltipContent>
                  </Tooltip>
                ) : null}
                {canEdit ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Send payment link"
                        title="Send a Razorpay payment link for the outstanding balance"
                        onClick={() => sendPaymentLink(row.original)}
                      >
                        <Link2 className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Send payment link</TooltipContent>
                  </Tooltip>
                ) : null}
                {canEdit ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Cancel booking"
                        disabled={cancelling === row.original.id}
                        onClick={() => void cancelBooking(row.original)}
                      >
                        {cancelling === row.original.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Ban className="h-3.5 w-3.5 text-red-600" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Cancel booking</TooltipContent>
                  </Tooltip>
                ) : null}
              </>
            ) : null}
            {isCancelled(row.original) && Number(row.original.advanceRefundable ?? 0) > 0 && canEdit ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Record advance refund"
                    disabled={refunding === row.original.id}
                    onClick={() => void refundAdvance(row.original)}
                  >
                    {refunding === row.original.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Undo2 className="h-3.5 w-3.5 text-warning-700" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Record advance refund</TooltipContent>
              </Tooltip>
            ) : null}
          </TooltipProvider>
        </div>
      ),
    },
    // The row handlers only touch stable setters and APIs, so recomputing the
    // columns whenever one is redefined would rebuild the whole table for
    // nothing; the permission flags ARE included (a role change must re-render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [converting, cancelling, refunding, canCreate, canEdit])

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Booking Orders"
        subtitle="Record customer bookings with an advance payment, then convert to an invoice on fulfilment."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={() => exportTable('bookings.csv', columns, filtered)}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            {canCreate ? (
              <Button size="sm" onClick={() => openForm()}>
                <Plus className="h-4 w-4" /> New Booking
              </Button>
            ) : null}
          </div>
        }
      />

      {error && <p className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-500 dark:text-red-400">{error}</p>}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Total booked value</p>
          <p className="text-xl font-semibold tabular-nums">{formatCurrency(stats.totalValue)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Advances collected</p>
          <p className="text-xl font-semibold tabular-nums text-emerald-600">{formatCurrency(stats.totalAdvance)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Outstanding</p>
          <p className="text-xl font-semibold tabular-nums text-warning-700">{formatCurrency(stats.outstanding)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Awaiting conversion</p>
          <p className="text-xl font-semibold tabular-nums">{stats.pending}</p>
        </CardContent></Card>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search booking number, customer, invoice…"
                value={query}
                onChange={(e) => onSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              options={[
                { value: 'all', label: 'All statuses' },
                { value: 'awaiting', label: 'Awaiting conversion' },
                { value: 'confirmed', label: 'Confirmed' },
                { value: 'processing', label: 'Processing' },
                { value: 'fulfilled', label: 'Converted' },
                { value: 'cancelled', label: 'Cancelled' },
              ]}
              value={statusFilter}
              onValueChange={onStatusFilter}
              className="w-[170px]"
            />
            <div className="ml-auto text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{filtered.length}</span> of {bookings.length} bookings
            </div>
          </div>

          <DataTable
            columns={columns}
            data={pageRows}
            loading={loading}
            emptyMessage={error ? '—' : 'No bookings found'}
            onRowClick={openView}
          />

          <Pager page={safePage} pages={pages} total={filtered.length} onChange={setPage} />
        </CardContent>
      </Card>

      {/* ── Shared create / edit form ─────────────────────────────────────── */}
      <AppDialog
        open={formOpen}
        onOpenChange={(open) => { if (!open) setFormOpen(false) }}
        size="xl"
        isDirty={formOpen && JSON.stringify({ form, lines }) !== formBaseline}
        title={editTarget ? `Edit booking ${editTarget.internalId || ''}` : 'New booking order'}
        description={
          editTarget
            ? 'Available until the booking is converted — afterwards edits go through the invoice.'
            : 'Take an advance now, convert to an invoice on fulfilment. Creating a booking never touches stock; stock moves at conversion.'
        }
        footer={
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setFormOpen(false)} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={() => void submitForm()} disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {editTarget ? 'Save changes' : 'Create booking'}
            </Button>
          </DialogFooter>
        }
      >
          <div className="space-y-4 text-sm">
            {formError ? (
              <div className="rounded-md border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">{formError}</div>
            ) : null}

            {/* Customer — type-ahead over the customer list, contact autofilled. */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Customer Details</Label>
                {form.customerId ? (
                  <span className="text-[11px] text-muted-foreground">
                    Linked to an existing customer ·{' '}
                    <button
                      type="button"
                      className="text-primary-700 hover:underline"
                      onClick={() => setFormValue('customerId', '')}
                    >
                      unlink
                    </button>
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">Pick an existing customer or keep typing for a walk-in</span>
                )}
              </div>
              <CustomerPicker
                onPick={(hit: CustomerHit) =>
                  setForm((f) => ({ ...f, customer: hit.name, customerId: hit.id, email: hit.email ?? '', phone: hit.phone ?? '' }))
                }
                onNameChange={(name) => setForm((f) => (f.customer === name ? f : { ...f, customer: name, customerId: '' }))}
                disabled={saving}
              />
              {fieldErrors.customer ? <p className="mt-1 text-[12px] text-red-600">{fieldErrors.customer}</p> : null}
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Email">
                  <Input type="email" value={form.email} onChange={(e) => setFormValue('email', e.target.value)} placeholder="priya@example.com" />
                </Field>
                <Field label="Phone">
                  <Input value={form.phone} onChange={(e) => setFormValue('phone', e.target.value)} placeholder="98765 43210" />
                </Field>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Contact travels with the booking onto its invoice, loyalty and the customer's 360 view.
              </p>
            </div>

            {/* Booking header — number, dates, status. */}
            <div>
              <Label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Booking Details</Label>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Booking number">
                  <Input
                    disabled
                    value={editTarget?.internalId ?? ''}
                    placeholder="Assigned on save"
                    className="font-mono"
                  />
                </Field>
                <Field label="Booking date *">
                  <Input type="date" value={form.date} onChange={(e) => setFormValue('date', e.target.value)} />
                  {fieldErrors.date ? <p className="mt-1 text-[12px] text-red-600">{fieldErrors.date}</p> : null}
                </Field>
                <Field label="Expected delivery">
                  <Input type="date" value={form.expectedDate} onChange={(e) => setFormValue('expectedDate', e.target.value)} />
                </Field>
                <Field label="Selling store *">
                  <Select
                    options={locationOptions}
                    value={form.locationId}
                    onValueChange={(v) => setFormValue('locationId', v)}
                    aria-label="Selling store"
                  />
                  {fieldErrors.locationId ? <p className="mt-1 text-[12px] text-red-600">{fieldErrors.locationId}</p> : null}
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    One store per booking — conversion validates and deducts here only.
                  </p>
                </Field>
                <Field label="Status">
                  {editTarget && FORM_STATUSES.includes((editTarget.status ?? '') as never) ? (
                    <Select
                      options={[
                        { value: 'confirmed', label: 'Confirmed' },
                        { value: 'processing', label: 'Processing' },
                      ]}
                      value={form.status}
                      onValueChange={(v) => setFormValue('status', v)}
                    />
                  ) : (
                    <Input
                      disabled
                      value={editTarget ? (BOOKING_STATUS[editTarget.status]?.label ?? editTarget.status ?? '') : 'Confirmed'}
                    />
                  )}
                  <p className="mt-1 text-[11px] text-muted-foreground">Converting and cancelling happen from the row actions.</p>
                </Field>
              </div>
            </div>

            {/* Items — catalogue search, variant, qty, price, stock hint. */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Products &amp; Variants</Label>
                <Button variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, newLine()])}>
                  <Plus className="h-3.5 w-3.5" /> Add item
                </Button>
              </div>
              <div className="space-y-2.5">
                {lines.map((l, index) => {
                  const product = products.find((x) => x.id === l.productId) ?? null
                  const variants = product && hasRealOptions(product.options) ? variantOptions(product) : []
                  const identity = lineIdentity(l)
                  const qty = Math.max(0, Math.floor(Number(l.qty) || 0))
                  const lineTotal = (Number(l.price) || 0) * qty
                  const availabilityKey = `${l.productId}|${l.variantId || ''}`
                  return (
                    <div key={l.key} className="rounded-lg border bg-muted/30 p-2.5">
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-12">
                        <div className={`col-span-2 min-w-0 ${variants.length > 0 ? 'sm:col-span-5' : 'sm:col-span-7'}`}>
                          <Label className="text-xs text-muted-foreground">Product</Label>
                          <SearchableSelect
                            placeholder="Select product"
                            searchPlaceholder="Search name, SKU or variant…"
                            options={productOptions}
                            value={
                              l.custom
                                ? CUSTOM_PRODUCT
                                : l.productId
                                  ? sellableItemValue({ productId: l.productId, variantId: l.variantId || null })
                                  : ''
                            }
                            onValueChange={(v) => selectProduct(l.key, v)}
                          />
                          {l.custom ? (
                            <Input
                              className="mt-1.5 h-8 text-xs"
                              value={l.title}
                              onChange={(e) => setLine(l.key, { title: e.target.value })}
                              placeholder="Item name (SKU optional)"
                            />
                          ) : null}
                        </div>
                        {variants.length > 0 ? (
                          <div className="col-span-2 sm:col-span-2">
                            <Label className="text-xs text-muted-foreground">Variant</Label>
                            <SearchableSelect
                              placeholder="Variant"
                              searchPlaceholder="Search…"
                              options={variants}
                              value={l.variantId}
                              onValueChange={(v) => selectVariant(l.key, v)}
                            />
                          </div>
                        ) : null}
                        <div className="sm:col-span-1">
                          <Label className="text-xs text-muted-foreground">Qty</Label>
                          <Input
                            type="number"
                            min="1"
                            step="1"
                            value={l.qty}
                            onChange={(e) => setLine(l.key, { qty: e.target.value })}
                            // The label above is a sibling, not a wrapper, so
                            // without this the field has no accessible name.
                            aria-label={`Qty for line ${index + 1}`}
                            className="text-right"
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <Label className="text-xs text-muted-foreground">Price / unit (incl. GST)</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={l.price}
                            onChange={(e) => setLine(l.key, { price: e.target.value })}
                            aria-label={`Price per unit for line ${index + 1} (incl. GST)`}
                            className="text-right"
                          />
                        </div>
                        <div className="flex items-end justify-between gap-2 sm:col-span-2">
                          <div className="min-w-0">
                            <Label className="text-xs text-muted-foreground">Total</Label>
                            <p className="text-sm font-semibold tabular-nums">{formatCurrency(lineTotal)}</p>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Remove line"
                            onClick={() => removeLine(l.key)}
                            disabled={lines.length === 1}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        </div>
                      </div>
                      {/* Variant identity + required qty + PER-STORE stock.
                          Replaces the old single "N in stock" hint, which read
                          the global mirror and silently summed every store. */}
                      {l.productId && !l.custom ? (
                        <div className="mt-2">
                          <BookingLineAvailability
                            sku={l.sku}
                            variantName={identity.variantName}
                            sellingPrice={identity.sellingPrice}
                            priceAdjustment={l.priceAdjustment}
                            required={qty}
                            availability={availability[availabilityKey]}
                            selectedLocationId={form.locationId}
                          />
                        </div>
                      ) : null}
                      {lineErrors[l.key] ? <p className="mt-1.5 text-[12px] text-red-600">{lineErrors[l.key]}</p> : null}
                    </div>
                  )
                })}
              </div>
              {fieldErrors.lines ? <p className="mt-1.5 text-[12px] text-red-600">{fieldErrors.lines}</p> : null}
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Prices fill in from the catalogue at the managed silver rate, exactly as Sales Orders prices them, and stay editable.
                A picked variant's GST-inclusive "Add to price (₹)" is already in the per-unit price and is snapshotted on the line, so a re-open or rate change cannot lose it or add it twice.
                {' '}Stock is shown for EACH store separately (the cross-store total is informational) — booking never reserves or deducts inventory.
              </p>
            </div>

            {/* Money — GST, discount, advance next to the live breakdown. */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid grid-cols-2 gap-3 self-start">
                <Field label="GST (%)">
                  <Input type="number" min="0" max="100" step="0.01" value={form.gst} onChange={(e) => setFormValue('gst', e.target.value)} />
                  {fieldErrors.gst ? <p className="mt-1 text-[12px] text-red-600">{fieldErrors.gst}</p> : null}
                </Field>
                <Field label="Discount (₹)">
                  <Input type="number" min="0" step="0.01" value={form.discount} onChange={(e) => setFormValue('discount', e.target.value)} />
                  {fieldErrors.discount ? <p className="mt-1 text-[12px] text-red-600">{fieldErrors.discount}</p> : null}
                </Field>
                <Field label="Advance collected (₹)">
                  <Input type="number" min="0" step="0.01" value={form.advance} onChange={(e) => setFormValue('advance', e.target.value)} placeholder="0" />
                  {fieldErrors.advance ? <p className="mt-1 text-[12px] text-red-600">{fieldErrors.advance}</p> : null}
                </Field>
                <Field label="Outstanding (₹)">
                  <Input disabled value={totals.outstanding.toFixed(2)} className="text-right" />
                </Field>
              </div>
              <div className="space-y-1 self-start rounded-md border border-border/60 p-3">
                <SummaryRow label="Lines total (incl. GST)" value={formatCurrency(totals.linesTotal)} />
                <SummaryRow label="Subtotal (taxable)" value={formatCurrency(totals.taxable)} />
                <SummaryRow label={`GST (${totals.gstRate}%)`} value={formatCurrency(totals.gstAmount)} />
                {totals.discount > 0 ? <SummaryRow label="Discount" value={`− ${formatCurrency(totals.discount)}`} negative /> : null}
                <SummaryRow label="Grand total" value={formatCurrency(totals.grandTotal)} bold />
                <SummaryRow label="Advance collected" value={formatCurrency(totals.advance)} />
                <SummaryRow label="Outstanding" value={formatCurrency(totals.outstanding)} bold />
              </div>
            </div>

            {/* Notes */}
            <Field label="Notes">
              <Textarea
                value={form.note}
                onChange={(e) => setFormValue('note', e.target.value)}
                placeholder="Anything the team should know — sizing, delivery promises, stones…"
                className="min-h-[70px]"
                maxLength={500}
              />
            </Field>
          </div>
      </AppDialog>

      {/* ── Allocation: planning records across stores (never moves stock) ── */}
      <AppDialog
        open={allocOpen}
        onOpenChange={(open) => { if (!open) setAllocOpen(false) }}
        size="lg"
        isDirty={allocOpen && JSON.stringify(allocRows) !== allocBaseline}
        title={allocTarget ? `Allocate stock — ${allocTarget.internalId || allocTarget.id.slice(0, 8)}` : 'Allocate stock'}
        description="Split each line across stores. Planning only: allocating never moves or reserves stock — conversion revalidates the fulfilment store when it runs."
        footer={
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setAllocOpen(false)} disabled={allocSaving}>
              Close
            </Button>
            <Button
              size="sm"
              onClick={() => void saveAllocations()}
              disabled={allocSaving || allocLoading || !allocSummary || allocIssues.invalid}
            >
              {allocSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save allocations
            </Button>
          </DialogFooter>
        }
      >
        {allocLoading || !allocSummary ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading allocation…
          </p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Saved allocation</span>
              <AllocationStatusChip
                allocated={allocSummary.lines.filter((l) => l.tracked).reduce((a, l) => a + l.allocated, 0)}
                required={allocSummary.lines.filter((l) => l.tracked).reduce((a, l) => a + l.required, 0)}
              />
            </div>
            <BookingAllocationBody
              lines={allocSummary.lines}
              rows={allocRows}
              locations={knownLocations}
              availability={availability}
              serverError={allocError || null}
              serverLineErrors={allocLineErrors}
              onAdd={addAllocRow}
              onRemove={removeAllocRow}
              onChange={changeAllocRow}
            />
          </>
        )}
      </AppDialog>

      {/* ── Booking details ───────────────────────────────────────────────── */}
      <AppDialog
        open={viewTarget !== null}
        onOpenChange={(open) => { if (!open) setViewTarget(null) }}
        size="lg"
        title={viewTarget ? `Booking ${viewTarget.internalId || viewTarget.id.slice(0, 8)}` : 'Booking'}
        description={viewTarget?.date ? `Booked on ${formatDateTime(viewTarget.date)}` : undefined}
        footer={
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setViewTarget(null)}>Close</Button>
            {viewTarget && isOpenBooking(viewTarget) && canEdit ? (
              <Button size="sm" onClick={() => openForm(viewTarget)}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            ) : null}
            {viewTarget && isOpenBooking(viewTarget) && canEdit ? (
              <Button variant="outline" size="sm" onClick={() => openAllocation(viewTarget)}>
                <Layers className="h-3.5 w-3.5" /> Allocate
              </Button>
            ) : null}
            {viewTarget && isOpenBooking(viewTarget) && canCreate ? (
              <Button size="sm" onClick={() => convert(viewTarget)} disabled={converting === viewTarget.id}>
                {converting === viewTarget.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Receipt className="h-3.5 w-3.5" />}
                Convert
              </Button>
            ) : null}
            {viewTarget && isOpenBooking(viewTarget) && canEdit ? (
              <Button variant="outline" size="sm" onClick={() => sendPaymentLink(viewTarget)}>
                <Link2 className="h-3.5 w-3.5" /> Payment link
              </Button>
            ) : null}
            {viewTarget && isOpenBooking(viewTarget) && canEdit ? (
              <Button
                variant="outline"
                size="sm"
                disabled={cancelling === viewTarget.id}
                onClick={() => void cancelBooking(viewTarget)}
                className="text-red-600 hover:text-red-700"
              >
                {cancelling === viewTarget.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                Cancel
              </Button>
            ) : null}
            {viewDetail?.invoice ? (
              <Button size="sm" onClick={() => { const inv = viewDetail.invoice; if (inv) navigate(`/sales/invoices/${inv.id}`) }}>
                <Receipt className="h-3.5 w-3.5" /> Open invoice
              </Button>
            ) : null}
          </DialogFooter>
        }
      >
          {viewTarget ? (
            <BookingDetailView
              booking={viewTarget}
              detail={viewDetail}
              loading={viewLoading}
              error={viewError}
              locationName={
                viewTarget
                  ? locationLabel(null, viewTarget.locationId ?? DEFAULT_STORE_ID, knownLocations)
                  : undefined
              }
            />
          ) : null}
      </AppDialog>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}
