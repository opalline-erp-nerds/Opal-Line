export interface SyncProduct {
  id: number
  gid: string
  title: string
  handle: string
  vendor: string
  productType: string
  description: string
  collection: string
  chargeOnTax: boolean
  status: string
  sku: string
  barcode: string | null
  price: string
  compareAtPrice: string | null
  image: string | null
  images: string[]
  inventoryQuantity: number
  inventoryItemId: number
  variantId: number
  /**
   * Shopify-style options on the live product:
   * `[{ name: 'Size', values: ['Small', 'Large'] }]`. Empty for a simple
   * single-variant listing.
   */
  options?: Array<{ name: string; values: string[] }>
  /** Every variant on the live product (not just the first). */
  variants?: Array<{
    id: number
    title: string
    option1: string | null
    option2: string | null
    option3: string | null
    sku: string
    barcode: string | null
    price: string
    compareAtPrice: string | null
    inventoryQuantity: number
    inventoryItemId: number
  }>
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
  province: string | null
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

export type SyncStatus = 'success' | 'failed' | 'skipped'

export interface SyncLogEntry {
  id: string
  resource: SyncResource
  status: SyncStatus
  count: number
  time: string
  message?: string
}

export interface SyncStore {
  products: SyncProduct[]
  orders: SyncOrder[]
  customers: SyncCustomer[]
  inventory: SyncInventory[]
  price: SyncPrice[]
  lastSync: Partial<Record<SyncResource, string>>
  syncing: boolean
  logs: SyncLogEntry[]
  lastError?: string
}

export interface ModulePermission {
  view: boolean
  create: boolean
  edit: boolean
  delete: boolean
}

export type Permissions = Record<string, ModulePermission>

export interface Role {
  id: string
  name: string
  description: string | null
  permissions: Permissions
  isSystem: boolean
  createdAt: string | null
}

export interface RbacModule {
  key: string
  label: string
  description: string
}

export interface UserPermissions {
  userId: string
  role: string
  rolePermissions: Permissions
  overrides: Permissions | null
  effective: Permissions
}
