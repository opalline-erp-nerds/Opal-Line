// Core HTTP plumbing for the API modules: base URL, CSRF handling, request
// wrapper with 403-retry, list pagination and small helpers.
import type {
  Customer,
  Invoice,
  InvoiceItem,
  Payment,
  Product,
  PurchaseInvoice,
  SalesOrder,
  Supplier,
} from '@/types'
import { notifyUnauthorized, sessionEpoch } from '@/auth/sessionSignal'

// `?.` keeps this module importable outside Vite (node --test, SSR) where
// import.meta.env does not exist; Vite still statically injects the env object.
export const API_BASE = (import.meta.env?.VITE_API_BASE ?? '/api/v1').replace(/\/$/, '')

let csrfToken: string | null = null
let csrfTokenTime: number = 0
const CSRF_TOKEN_MAX_AGE = 30 * 60 * 1000 // 30 minutes

async function fetchCsrfToken(): Promise<string> {
  if (csrfToken && (Date.now() - csrfTokenTime) < CSRF_TOKEN_MAX_AGE) return csrfToken
  csrfToken = null
  csrfTokenTime = 0
  try {
    const res = await fetch(`${API_BASE}/csrf-token`, { credentials: 'include' })
    if (!res.ok) return ''
    const data = await res.json()
    csrfToken = data.csrfToken ?? null
    csrfTokenTime = Date.now()
    return csrfToken ?? ''
  } catch {
    return ''
  }
}

function resetCsrfToken(): void {
  csrfToken = null
}

export { resetCsrfToken }

export interface ApiErrorDetail {
  code?: string
  message?: string
  /** Per-product stock shortfalls for `INSUFFICIENT_STOCK`. */
  products?: Array<{ sku: string; name: string; available: number; requested: number }>
}

export class ApiError extends Error {
  status: number
  code?: string
  products?: ApiErrorDetail['products']

  constructor(status: number, message: string, detail?: ApiErrorDetail) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = detail?.code
    this.products = detail?.products
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData
  const isStateChanging = init?.method && !['GET', 'HEAD', 'OPTIONS'].includes(init.method)
  // Remember which session generation this request belongs to: a 401 is only
  // accepted if the session has not been re-established since it started.
  const requestEpoch = sessionEpoch()
  
  const headers: Record<string, string> = isFormData ? {} : { 'Content-Type': 'application/json' }
  
  if (isStateChanging) {
    const token = await fetchCsrfToken()
    if (token) headers['X-CSRF-Token'] = token
  }
  
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  })
  
  if (res.status === 403 && isStateChanging) {
    resetCsrfToken()
    const newToken = await fetchCsrfToken()
    if (newToken) {
      const retryRes = await fetch(`${API_BASE}${path}`, {
        ...init,
        credentials: 'include',
        headers: { ...headers, 'X-CSRF-Token': newToken, ...(init?.headers as Record<string, string> | undefined) },
      })
      if (!retryRes.ok) {
        const body = (await retryRes.json().catch(() => null)) as
          | { error?: string; code?: string; message?: string; products?: ApiErrorDetail['products'] }
          | null
        if (retryRes.status === 401 && !path.startsWith('/auth/')) {
          notifyUnauthorized(requestEpoch)
        }
        throw new ApiError(retryRes.status, body?.message ?? body?.error ?? `API error ${retryRes.status}`, {
          code: body?.code,
          message: body?.message,
          products: body?.products,
        })
      }
      return retryRes.json() as Promise<T>
    }
  }
  
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: string; code?: string; message?: string; products?: ApiErrorDetail['products'] }
      | null
    // Hand the loss to the auth provider. It clears the session once and the
    // router moves to /login, so a burst of failing requests does not reload
    // the page (and a stale request cannot sign out a newer session).
    if (res.status === 401 && !path.startsWith('/auth/')) {
      notifyUnauthorized(requestEpoch)
    }
    throw new ApiError(res.status, body?.message ?? body?.error ?? `API error ${res.status}`, {
      code: body?.code,
      message: body?.message,
      products: body?.products,
    })
  }
  return res.json() as Promise<T>
}

/**
 * Like `request`, but returns the raw response body as text. Used for
 * non-JSON payloads such as ZPL label streams.
 */
export async function requestText(path: string, init?: RequestInit): Promise<string> {
  const isStateChanging = init?.method && !['GET', 'HEAD', 'OPTIONS'].includes(init.method)
  const requestEpoch = sessionEpoch()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (isStateChanging) {
    const token = await fetchCsrfToken()
    if (token) headers['X-CSRF-Token'] = token
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    if (res.status === 401 && !path.startsWith('/auth/')) notifyUnauthorized(requestEpoch)
    throw new ApiError(res.status, body?.error ?? `API error ${res.status}`)
  }
  return res.text()
}

export async function list<T>(path: string, params?: Record<string, string | number>): Promise<T[]> {  const all: T[] = []
  let page = 1
  const pageSize = 200
  while (true) {
    const query = params
      ? Object.entries({ ...params, page, limit: pageSize })
          .filter(([, v]) => v != null)
          .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
          .join('&')
      : `page=${page}&limit=${pageSize}`
    const res = await request<{ data: T[]; total: number }>(`${path}${query ? `?${query}` : ''}`)
    all.push(...res.data)
    if (res.data.length < pageSize || all.length >= res.total) break
    page++
  }
  return all
}

export async function maybe<T>(path: string): Promise<T | undefined> {
  try {
    return await request<T>(path)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return undefined
    throw err
  }
}

/**
 * Human-readable message for any thrown API error.
 *
 * Stock shortfalls come back as a structured 409 with per-product detail; this
 * expands them into a line per product ("Name (SKU) — Available: X, Requested:
 * Y") so the user can see exactly which lines to reduce. Everything else falls
 * back to the server's own message.
 */
export function formatApiError(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof ApiError) {
    if (err.code === 'INSUFFICIENT_STOCK' && err.products && err.products.length > 0) {
      const lines = err.products.map(
        (p) => `${p.name || p.sku}${p.name && p.sku ? ` (${p.sku})` : ''} — Available: ${p.available}, Requested: ${p.requested}`,
      )
      return `Insufficient Stock:\n${lines.join('\n')}`
    }
    return err.message || fallback
  }
  return err instanceof Error ? err.message : fallback
}

export type SalesInvoiceRow = Omit<Invoice, 'items'>

export async function withItems(inv: SalesInvoiceRow): Promise<Invoice> {
  const items = await request<InvoiceItem[]>(`/db/invoices/${inv.id}/items`)
  return { ...inv, items }
}

export const PAGED = { limit: 200 }

export interface SearchResults {
  products: Product[]
  customers: Customer[]
  invoices: Array<Pick<Invoice, 'id' | 'number' | 'customer' | 'shopifyOrder' | 'grandTotal'>>
  suppliers: Supplier[]
  salesOrders: SalesOrder[]
  purchaseInvoices: PurchaseInvoice[]
  payments: Payment[]
}
