import type {
  SalesOrder,
} from '@/types'
import type {
  ShopifyStatus,
  SyncCompareRow,
  SyncCustomer,
  SyncInventory,
  SyncOrder,
  SyncPrice,
  SyncProduct,
  SyncResource,
  SyncResult,
} from '@/types/shopify'
import { request } from './core'

export const shopifyApi = {
  getHealth: () => request<{ ok: boolean; shopifyConfigured: boolean }>('/health'),
  getStatus: () => request<ShopifyStatus>('/shopify/status'),
  testConnection: (creds?: { shopifyStoreUrl?: string; shopifyAccessToken?: string }) =>
    request<{ ok: boolean; error?: string; shop?: string }>('/shopify/test', {
      method: 'POST',
      body: creds ? JSON.stringify(creds) : undefined,
    }),
  sync: (resources?: SyncResource[]) =>
    request<SyncResult>('/shopify/sync', { method: 'POST', body: JSON.stringify({ resources }) }),
  pollCustomerExport: (): Promise<{ ok: boolean; scanned: number; attachmentsFound: number; imported: number; updated: number; errors: string[]; downloadUrl?: string | null; emailFound?: boolean }> =>
    request('/shopify/customer-export/poll', { method: 'POST' }),
  customersExportUrl: (): Promise<{ url: string }> =>
    request('/shopify/customers-export-url'),
  piiGap: (): Promise<{ missing: number }> =>
    request('/shopify/pii-gap'),
  createOrder: (body: {
    customer: string
    email?: string
    phone?: string
    payment?: string
    fulfillment?: string
    status?: string
    date?: string
    note?: string
    items: Array<{ title: string; sku?: string; quantity: number; price: number; variantId?: string }>
    billingAddress?: {
      name?: string
      phone?: string
      address1?: string
      address2?: string
      city?: string
      province?: string
      zip?: string
      country?: string
    }
    shippingAddress?: {
      name?: string
      phone?: string
      address1?: string
      address2?: string
      city?: string
      province?: string
      zip?: string
      country?: string
    }
    syncToShopify?: boolean
  }) =>
    request<{
      order: SalesOrder
      shopifySync: { ok: boolean; draftId?: string; name?: string; completed?: boolean; errors: string[]; message?: string } | null
    }>('/shopify/orders/create', { method: 'POST', body: JSON.stringify(body) }),
  updateOrder: (id: string, body: {
    customer: string
    email?: string
    phone?: string
    payment?: string
    fulfillment?: string
    status?: string
    date?: string
    note?: string
    items?: Array<{ title: string; sku?: string; quantity: number; price: number; variantId?: string }>
    billingAddress?: {
      name?: string
      phone?: string
      address1?: string
      address2?: string
      city?: string
      province?: string
      zip?: string
      country?: string
    }
    shippingAddress?: {
      name?: string
      phone?: string
      address1?: string
      address2?: string
      city?: string
      province?: string
      zip?: string
      country?: string
    }
    syncToShopify?: boolean
  }) =>
    request<{
      order: SalesOrder
      shopifySync: { ok: boolean; errors: string[]; message?: string } | null
    }>(`/shopify/orders/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  getOrders: () => request<{ syncedAt: string | null; data: SyncOrder[] }>('/shopify/orders'),
  syncOrders: () =>
    request<{ ok: boolean; imported: number; updated: number; errors: string[]; message?: string; piiRedacted?: { count: number; example: string; message: string } | null }>('/shopify/orders/sync', {
      method: 'POST',
    }),
  refreshOrder: (orderId: string) =>
    request<{ ok: boolean; updated?: boolean; message?: string }>(`/shopify/orders/${encodeURIComponent(orderId)}/refresh`, { method: 'POST' }),
  getAutoSyncStatus: () =>
    request<{ intervalHours: number; enabled: boolean; nextRunAt: string | null; lastRunAt: string | null; lastResult: { ok: boolean; synced?: number; created?: number; updated?: number; message?: string } | null; history: Array<{ at: string; ok: boolean; created?: number; updated?: number; message?: string }> }>('/shopify/products/auto-sync/status'),
  getAutoSyncInterval: () =>
    request<{ intervalHours: number }>('/shopify/products/auto-sync/interval'),
  setAutoSyncInterval: (intervalHours: number) =>
    request<{ ok: boolean; intervalHours: number }>('/shopify/products/auto-sync/interval', { method: 'POST', body: JSON.stringify({ intervalHours }) }),
  runAutoSync: () =>
    request<{ ok: boolean; synced?: number; created?: number; updated?: number; message?: string }>('/shopify/products/auto-sync', { method: 'POST' }),
  testEmail: (to?: string) =>
    request<{ ok: boolean; to?: string; error?: string }>('/settings/test-email', { method: 'POST', body: JSON.stringify({ to }) }),
  whatsappStatus: () =>
    request<{ configured: boolean; phoneNumberId: string | null }>('/settings/whatsapp-status'),
  testWhatsApp: (to: string) =>
    request<{ ok: boolean; error?: string }>('/settings/test-whatsapp', { method: 'POST', body: JSON.stringify({ to }) }),
  testWhatsAppConfig: () =>
    request<{ ok: boolean; message?: string; error?: string }>('/settings/test-whatsapp-config', { method: 'POST' }),
  testMailbox: () =>
    request<{ ok: boolean; provider: string; mailbox: string | null; host?: string; folder?: string; messageCount?: number; error?: string }>('/settings/test-mailbox', { method: 'POST' }),
  testRazorpay: () =>
    request<{ ok: boolean; mode?: string; message?: string; error?: string }>('/settings/test-razorpay', { method: 'POST' }),
  webhookHealth: () =>
    request<{ publicBaseUrl: string | null; expectedAddress: string | null; healthy: boolean; entries: Array<{ topic: string; status: string; address?: string; id?: number }> }>('/settings/webhook-health'),
  repairWebhooks: () =>
    request<{ healthy: boolean; entries: Array<{ topic: string; status: string }> }>('/settings/webhook-health/repair', { method: 'POST' }),
  offsiteBackupStatus: () =>
    request<{ configured: boolean; bucket: string | null; endpoint: string | null }>('/settings/offsite-backup'),
  testOffsiteBackup: () =>
    request<{ ok: boolean; bucket?: string; error?: string }>('/settings/offsite-backup/test', { method: 'POST' }),
  syncOffsiteBackup: () =>
    request<{ ok: boolean; uploaded: string[]; skipped: number; error?: string }>('/settings/offsite-backup/sync', { method: 'POST' }),
  syncCustomers: () =>
    request<{ ok: boolean; imported: number; updated: number; errors: string[]; message?: string }>('/shopify/customers/sync', {
      method: 'POST',
    }),
  enrichOrders: () =>
    request<{ ok: boolean; enriched: number; failed: number; skipped: number; errors: string[]; message?: string }>('/shopify/enrich', {
      method: 'POST',
    }),
  getProducts: () => request<{ syncedAt: string | null; data: SyncProduct[] }>('/shopify/products'),
  compareProducts: () => request<{ ok: boolean; rows: SyncCompareRow[]; syncedAt: string | null; error?: string }>('/shopify/products/compare'),
  pullProduct: (localId: string) =>
    request<{ ok: boolean; pulled?: { price: number; stock: number; title: string } }>(`/shopify/products/${encodeURIComponent(localId)}/pull`, { method: 'POST' }),
  getCustomers: () => request<{ syncedAt: string | null; data: SyncCustomer[] }>('/shopify/customers'),
  getInventory: () => request<{ syncedAt: string | null; data: SyncInventory[] }>('/shopify/inventory'),
  getPrice: () => request<{ syncedAt: string | null; data: SyncPrice[] }>('/shopify/price'),
  applyPrice: () => request<{ ok: boolean; updated: number; skipped: number; errors: string[] }>('/shopify/price/apply', { method: 'POST' }),
  pushProducts: (ids?: string[]) =>
    request<{ ok: boolean; created: number; updated?: number; skipped: number; errors: string[]; message?: string }>('/shopify/products/push', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  updateProductPrice: (id: string) =>
    request<{ ok: boolean; updated: number; skipped: number; errors: string[]; message?: string }>('/shopify/products/price', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  pushInventory: (ids?: string[]) =>
    request<{ ok: boolean; updated: number; skipped: number; errors: string[]; message?: string }>('/shopify/inventory/push', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  purgeProducts: () =>
    request<{ ok: boolean; shopifyDeleted: number; localDeleted: number; errors: string[] }>('/shopify/products/purge', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  syncProductsToDb: () =>
    request<{ ok: boolean; synced: number; created: number; updated: number; removed: number; errors: string[]; message?: string }>(
      '/shopify/products/sync-db',
      { method: 'POST', body: JSON.stringify({}) },
    ),
}
