export interface SyncProduct {
  id: number
  gid: string
  title: string
  handle: string
  vendor: string
  productType: string
  collection: string
  chargeOnTax: boolean
  status: string
  sku: string
  barcode: string | null
  price: string
  compareAtPrice: string | null
  image: string | null
  inventoryQuantity: number
  inventoryItemId: number
  variantId: number
  createdAt: string
  updatedAt: string
}

export interface SyncOrder {
  id: number
  name: string
  orderNumber: number
  createdAt: string
  financialStatus: string
  fulfillmentStatus: string | null
  customerName: string
  email: string | null
  totalPrice: string
  currency: string
  lineItems: number
}

export interface SyncCustomer {
  id: number
  email: string | null
  firstName: string
  lastName: string
  phone: string | null
  city: string | null
  ordersCount: number
  totalSpent: string
  createdAt: string
}

export interface SyncInventory {
  inventoryItemId: number
  locationId: number
  locationName: string
  available: number
  sku: string
  title: string
}

export type SyncPriceStatus = 'up-to-date' | 'update' | 'updated' | 'skipped' | 'no-match'

export interface SyncPrice {
  productId: number
  variantId: number
  title: string
  sku: string
  handle: string
  currentPrice: number
  targetPrice: number
  status: SyncPriceStatus
}

export type SyncResource = 'orders' | 'products' | 'customers' | 'inventory' | 'price'
export type SyncLogStatus = 'success' | 'failed' | 'skipped'

export interface SyncLogEntry {
  id: string
  resource: SyncResource
  status: SyncLogStatus
  count: number
  time: string
  message?: string
}

export interface ShopifyStatus {
  configured: boolean
  store: string | null
  syncing: boolean
  totals: Record<SyncResource, number>
  lastSync: Partial<Record<SyncResource, string>>
  lastError: string | null
  logs: SyncLogEntry[]
}

export interface SyncResult {
  ok: boolean
  message?: string
  results: Record<SyncResource, { ok: boolean; count: number; message?: string }>
  db?: Record<string, string>
}

export interface SyncCompareRow {
  localId: string
  sku: string
  name: string
  localPrice: number | null
  shopifyPrice: number | null
  priceDelta: number | null
  localStock: number | null
  shopifyStock: number | null
  stockDelta: number | null
  shopifyId: number | null
  shopifyStatus: string | null
  localStatus: string | null
  localUpdatedAt: string | null
  shopifyUpdatedAt: string | null
  state: 'in-sync' | 'price-diff' | 'stock-diff' | 'both-diff' | 'local-only' | 'shopify-only'
}
