import type {
  ActivityLogEntry,
  EnvConfigData,
  SystemLogFileInfo,
  SystemLogTail,
  SystemPortsInfo,
  SystemStatusInfo,
} from '@/types'
import { API_BASE, request, requestText } from './core'
import type { LabelPreset } from '../labelPresets'
export type { LabelPreset, LabelPresetDesign } from '../labelPresets'

export interface BackupResult {
  ok: boolean
  type: string
  label?: string
  exportedAt?: string
  fileName?: string | null
  restoredAt?: string
  restored?: number
  skipped?: number
  tables?: number
  silverRateIncluded?: boolean
  safetyBackup?: string | null
  shopifySync?: {
    ok: boolean
    products?: { created: number; skipped: number; errors: string[] }
    prices?: { updated: number; skipped: number; errors: string[] }
    inventory?: { updated: number; skipped: number; errors: string[] }
    errors: string[]
  } | null
  data?: Record<string, unknown[]>
}

export interface BackupScopeInfo {
  key: string
  label: string
  description: string
}

export interface BackupFileInfo {
  fileName: string
  type: string | null
  label: string | null
  exportedAt: string | null
  fileSize: number
  isEncrypted: boolean
  isPreRestore: boolean
}

export interface BackupValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
  meta: { type?: string; label?: string; exportedAt?: string } | null
  tables: string[]
  totalRecords: number
  fileSize: number
  fileName: string
}

export interface RestoreOptions {
  restoreSilverRate?: boolean
  dryRun?: boolean
  skipShopify?: boolean
  createSafetyBackup?: boolean
  tables?: string[]
  /** Explicit typed confirmation — required by the server for real restores. */
  confirm?: string
}

export interface DryRunResult {
  ok: boolean
  dryRun: boolean
  scope: string
  label: string
  tables: Array<{
    name: string
    backupRecords: number
    currentRecords: number
    willInsert: number
    willDelete: number
    willUpdate: number
    hasIdOverlap: boolean
  }>
  totalWillInsert: number
  totalWillDelete: number
  restoreSilverRate: boolean
}

export interface BackupDiffResult {
  ok: boolean
  file1: string
  file2: string
  tables: Array<{
    name: string
    file1Count: number
    file2Count: number
    added: string[]
    removed: string[]
    modified: string[]
  }>
  summary: { totalAdded: number; totalRemoved: number; totalModified: number }
}

export const envConfigApi = {
  get: () => request<EnvConfigData>('/env-config'),
  update: (values: Record<string, string>) =>
    request<{ ok: boolean; updated: string[]; skipped: string[] }>('/env-config', {
      method: 'POST',
      body: JSON.stringify({ values }),
    }),
}

export const systemApi = {
  status: () => request<SystemStatusInfo>('/system/status'),
  ports: () => request<SystemPortsInfo>('/system/ports'),
  logFiles: () => request<{ directory: string; files: SystemLogFileInfo[] }>('/system/log-files'),
  logs: (file: string, lines = 200) => request<SystemLogTail>(`/system/logs?file=${encodeURIComponent(file)}&lines=${lines}`),
}

export const backupApi = {
  getScopes: (): Promise<BackupScopeInfo[]> => request<BackupScopeInfo[]>('/backup/scopes'),
  getHistory: (): Promise<ActivityLogEntry[]> => request<ActivityLogEntry[]>('/backup/history'),
  getAutoBackupStatus: (): Promise<{ enabled: boolean; scheduleLabel: string; nextRunAt: string; lastBackup: { fileName: string; exportedAt: string | null; sizeBytes: number } | null; backupCount: number; localDir?: string | null; lastLocalCopy?: string | null }> =>
    request('/backup/auto-status'),
  getBackupFiles: (): Promise<BackupFileInfo[]> => request<BackupFileInfo[]>('/backup/files'),
  backupEverything: (): Promise<BackupResult> =>
    request<BackupResult>('/backup/export?type=full'),
  backupEverythingEncrypted: (): Promise<BackupResult> =>
    request<BackupResult>('/backup/export-encrypted?type=full'),
  exportBackup: (type: string): Promise<BackupResult> =>
    request<BackupResult>(`/backup/export?type=${encodeURIComponent(type)}`),
  exportEncrypted: (type: string): Promise<BackupResult> =>
    request<BackupResult>(`/backup/export-encrypted?type=${encodeURIComponent(type)}`),
  validate: (fileName: string): Promise<BackupValidation> =>
    request<BackupValidation>('/backup/validate', {
      method: 'POST',
      body: JSON.stringify({ fileName }),
    }),
  dryRun: (fileName: string, opts?: { restoreSilverRate?: boolean; tables?: string[] }): Promise<DryRunResult> =>
    request<DryRunResult>('/backup/dry-run', {
      method: 'POST',
      body: JSON.stringify({ fileName, restoreSilverRate: opts?.restoreSilverRate, tables: opts?.tables }),
    }),
  autoBackupSettings: (): Promise<{ encrypted: boolean }> =>
    request('/settings/auto-backup'),
  setAutoBackupEncrypted: (encrypted: boolean): Promise<{ ok: boolean; encrypted: boolean }> =>
    request('/settings/auto-backup/encrypted', { method: 'POST', body: JSON.stringify({ encrypted }) }),
  verifyAllBackups: (): Promise<{ checked: number; ok: number; corrupt: Array<{ fileName: string; error: string }>; verifiedAt: string }> =>
    request('/backup/verify-all', { method: 'POST' }),
  getBackupAutoEmail: (): Promise<{ enabled: boolean }> => request('/backup/auto-email'),
  setBackupAutoEmail: (enabled: boolean): Promise<{ ok: boolean; enabled: boolean }> =>
    request('/backup/auto-email', { method: 'POST', body: JSON.stringify({ enabled }) }),
  diff: (file1: string, file2: string): Promise<BackupDiffResult> =>
    request<BackupDiffResult>('/backup/diff', {
      method: 'POST',
      body: JSON.stringify({ file1, file2 }),
    }),
  restoreBackup: (type: string, data: Record<string, unknown[]>, opts?: RestoreOptions): Promise<BackupResult> =>
    request<BackupResult>(`/backup/restore`, {
      method: 'POST',
      body: JSON.stringify({
        type, data,
        restoreSilverRate: opts?.restoreSilverRate ?? false,
        dryRun: opts?.dryRun ?? false,
        skipShopify: opts?.skipShopify ?? false,
        createSafetyBackup: opts?.createSafetyBackup ?? true,
        tables: opts?.tables,
        confirm: opts?.dryRun ? undefined : 'RESTORE',
      }),
    }),
  restoreFile: (fileName: string, opts?: RestoreOptions): Promise<BackupResult> =>
    request<BackupResult>(`/backup/restore`, {
      method: 'POST',
      body: JSON.stringify({
        fileName,
        restoreSilverRate: opts?.restoreSilverRate ?? false,
        dryRun: opts?.dryRun ?? false,
        skipShopify: opts?.skipShopify ?? false,
        createSafetyBackup: opts?.createSafetyBackup ?? true,
        tables: opts?.tables,
        confirm: opts?.dryRun ? undefined : 'RESTORE',
      }),
    }),
  deleteFile: (fileName: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>(`/backup/files/${encodeURIComponent(fileName)}`, { method: 'DELETE' }),
  downloadFile: (fileName: string) => {
    window.open(`${API_BASE}/backup/files/${encodeURIComponent(fileName)}/download`, '_blank', 'noopener')
  },
  cleanup: (keepLast = 10): Promise<{ ok: boolean; deleted: string[]; kept: number }> =>
    request(`/backup/cleanup`, {
      method: 'POST',
      body: JSON.stringify({ keepLast }),
    }),
  testNotification: (email?: string): Promise<{ ok: boolean; email: string }> =>
    request('/backup/notifications/test', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  sendLowStockAlert: (): Promise<{ ok: boolean; count: number }> =>
    request('/backup/notifications/low-stock', { method: 'POST' }),
  sendDailySummary: (): Promise<{ ok: boolean }> =>
    request('/backup/notifications/daily-summary', { method: 'POST' }),
  emailBackup: (scope: string, email?: string): Promise<{ ok: boolean; email: string; fileName: string; sizeBytes: number; tables: number; records: number }> =>
    request('/backup/email', { method: 'POST', body: JSON.stringify({ scope, email }) }),
  emailBackupSeparate: (email?: string): Promise<{ ok: boolean; email: string; files: string[]; totalBytes: number; skipped: string[] }> =>
    request('/backup/email-separate', { method: 'POST', body: JSON.stringify({ email }) }),
  emailBackupFile: (fileName: string, email?: string): Promise<{ ok: boolean; email: string; fileName: string; sizeBytes: number }> =>
    request(`/backup/files/${encodeURIComponent(fileName)}/email`, { method: 'POST', body: JSON.stringify({ email }) }),
  downloadInvoicePDF: (invoiceId: string) => {
    window.open(`${API_BASE}/db/invoices/${encodeURIComponent(invoiceId)}/pdf`, '_blank', 'noopener')
  },
  downloadQuotationPDF: (quotationId: string) => {
    window.open(`${API_BASE}/db/quotations/${encodeURIComponent(quotationId)}/pdf`, '_blank', 'noopener')
  },
  downloadCreditNotePDF: (returnId: string) => {
    window.open(`${API_BASE}/db/credit-notes/${encodeURIComponent(returnId)}/pdf`, '_blank', 'noopener')
  },
  downloadGstExport: (month: number, year: number, format: 'csv' | 'json') => {
    window.open(`${API_BASE}/dashboard/reports/gst/export?month=${month}&year=${year}&format=${format}`, '_blank', 'noopener')
  },
  downloadCustomerStatement: (customer: string) => {
    window.open(`${API_BASE}/db/customers/${encodeURIComponent(customer)}/statement`, '_blank', 'noopener')
  },
  emailCustomerStatement: (customer: string, to: string) =>
    request<{ sent: boolean; invoiceCount: number; outstanding: number }>(`/db/customers/${encodeURIComponent(customer)}/statement/email`, {
      method: 'POST',
      body: JSON.stringify({ to }),
    }),
  downloadAllLabels: (opts?: {
    preset?: string
    showPrice?: boolean
    showWeight?: boolean
    showQR?: boolean
    showBrand?: boolean
    copies?: number
    page?: 'a4' | 'letter'
    brandName?: string
    ids?: string[]
    width?: number
    height?: number
    columns?: number
    rows?: number
    margin?: number
    gap?: number
  }) => {
    const params = new URLSearchParams()
    if (opts?.preset) params.set('preset', opts.preset)
    if (opts?.showPrice === false) params.set('price', 'false')
    if (opts?.showWeight === false) params.set('weight', 'false')
    if (opts?.showQR === false) params.set('qr', 'false')
    if (opts?.showBrand === false) params.set('brand', 'false')
    if (opts?.copies && opts.copies > 1) params.set('copies', String(opts.copies))
    if (opts?.brandName) params.set('brandName', opts.brandName)
    if (opts?.page) params.set('page', opts.page)
    if (opts?.width) params.set('w', String(opts.width))
    if (opts?.height) params.set('h', String(opts.height))
    if (opts?.columns) params.set('cols', String(opts.columns))
    if (opts?.rows) params.set('rows', String(opts.rows))
    if (opts?.margin !== undefined) params.set('margin', String(opts.margin))
    if (opts?.gap !== undefined) params.set('gap', String(opts.gap))
    if (opts?.ids && opts.ids.length > 0) params.set('ids', opts.ids.join(','))
    window.open(`${API_BASE}/db/products/labels?${params.toString()}`, '_blank', 'noopener')
  },
  /**
   * Raw ZPL for a ZPL-capable label printer / print server. Saves the returned
   * text as a `.zpl` file — it is never written to a raw printer port.
   */
  downloadLabelsZpl: async (
    productIds: string[],
    opts?: {
      preset?: string
      copies?: number
      showPrice?: boolean
      showWeight?: boolean
      showQR?: boolean
      showBrand?: boolean
      brandName?: string
    },
  ): Promise<string> => {
    const text = await requestText('/db/products/labels/zpl', {
      method: 'POST',
      body: JSON.stringify({ productIds, ...opts }),
    })
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `product-labels-${Date.now()}.zpl`
    a.click()
    URL.revokeObjectURL(url)
    return text
  },
  downloadCatalogPdf: () => {
    window.open(`${API_BASE}/db/products/catalog-pdf`, '_blank', 'noopener')
  },
  downloadProductLabels: (productIds: string[], opts?: { preset?: string; showPrice?: boolean; showWeight?: boolean; showQR?: boolean }) =>
    request<Blob>('/db/products/labels', {
      method: 'POST',
      body: JSON.stringify({ productIds, ...opts }),
    }),
  getLabelPresets: (): Promise<LabelPreset[]> =>
    request('/db/products/labels/presets'),
  whatsappStatus: (): Promise<{ configured: boolean }> =>
    request('/backup/whatsapp/status'),
  sendInvoiceWhatsApp: (phoneNumber: string, invoiceId: string): Promise<{ ok: boolean }> =>
    request('/backup/whatsapp/send-invoice', {
      method: 'POST', body: JSON.stringify({ phoneNumber, invoiceId }),
    }),
  sendOrderWhatsApp: (phoneNumber: string, orderNumber: string, opts?: { customerName?: string; totalAmount?: number; itemCount?: number }): Promise<{ ok: boolean }> =>
    request('/backup/whatsapp/send-order', {
      method: 'POST', body: JSON.stringify({ phoneNumber, orderNumber, ...opts }),
    }),
  sendShippingWhatsApp: (phoneNumber: string, orderNumber: string, opts?: { customerName?: string; trackingId?: string; carrier?: string }): Promise<{ ok: boolean }> =>
    request('/backup/whatsapp/send-shipping', {
      method: 'POST', body: JSON.stringify({ phoneNumber, orderNumber, ...opts }),
    }),
  enrichCustomers: (): Promise<{ ok: boolean; enriched: number; failed: number }> =>
    request('/backup/shopify/enrich-customers', { method: 'POST' }),
  enrichOrders: (): Promise<{ ok: boolean; enriched: number; failed: number }> =>
    request('/backup/shopify/enrich-orders', { method: 'POST' }),
  emailIngestStatus: (): Promise<{ configured: boolean; mailbox: string | null; host: string }> =>
    request('/shopify/email-ingest/status'),
  pollOrderEmails: (): Promise<{ ok: boolean; scanned: number; parsed: number; updated: number; created: number; errors: string[] }> =>
    request('/shopify/email-ingest/poll', { method: 'POST' }),
  parseCSV: (csv: string): Promise<{ ok: boolean; rows: Record<string, string>[]; count: number; headers: string[] }> =>
    request('/backup/shopify/parse-csv', {
      method: 'POST', body: JSON.stringify({ csv }),
    }),
  importCustomersCSV: (rows: Record<string, string>[]): Promise<{ ok: boolean; imported: number; updated: number; errors: string[] }> =>
    request('/backup/shopify/import-customers', {
      method: 'POST', body: JSON.stringify({ rows }),
    }),
  importOrdersCSV: (rows: Record<string, string>[]): Promise<{ ok: boolean; imported: number; updated: number; errors: string[] }> =>
    request('/backup/shopify/import-orders', {
      method: 'POST', body: JSON.stringify({ rows }),
    }),
}
