// Public API surface. Implementation lives in ./api/* — this barrel keeps
// every existing '@/lib/api' import working unchanged.
export * from './api/core'
export type { SyncCompareRow } from '@/types/shopify'
export * from './api/shopify'
export * from './api/uploads'
export * from './api/auth'
export * from './api/rbac'
export * from './api/db'
export * from './api/returns'
export * from './api/backup'
export * from './api/accounting'
export * from './api/printTemplates'
