import { request } from './core'
import type { PrintDocType } from '../printTemplate'

export type { PrintDocType } from '../printTemplate'

export interface PrintTemplateRow {
  id: string
  docType: PrintDocType
  name: string
  config: unknown
  isDefault: boolean
  updatedAt: string | null
}

export const printTemplatesApi = {
  list: (docType?: PrintDocType) =>
    request<{ templates: PrintTemplateRow[] }>(`/print-templates${docType ? `?docType=${docType}` : ''}`),
  getDefault: (docType: PrintDocType) =>
    request<{ config: unknown; name: string | null; id: string | null }>(`/print-templates/default/${docType}`),
  getSample: (docType: PrintDocType) =>
    request<{ doc: Record<string, unknown> }>(`/print-templates/sample/${docType}`),
  create: (body: { docType: PrintDocType; name: string; config: unknown; setDefault?: boolean }) =>
    request<{ ok: boolean; id: string }>('/print-templates', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: { name?: string; config?: unknown; setDefault?: boolean }) =>
    request<{ ok: boolean }>(`/print-templates/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  setDefault: (id: string) =>
    request<{ ok: boolean }>(`/print-templates/${id}/default`, { method: 'POST' }),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/print-templates/${id}`, { method: 'DELETE' }),
  // Auto UPI QR from Settings (enabled=false when no UPI ID configured).
  getUpiQr: (total: number, businessName?: string) =>
    request<{ enabled: boolean; dataUrl: string | null }>(
      `/print-templates/upi-qr?total=${encodeURIComponent(String(total))}${businessName ? `&businessName=${encodeURIComponent(businessName)}` : ''}`,
    ),
}

