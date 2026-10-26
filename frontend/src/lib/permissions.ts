import type { ModulePermission, Permissions } from '@/types'

export const MODULES: Array<{ key: string; label: string; description: string }> = [
  { key: 'dashboard', label: 'Dashboard', description: 'Home dashboard and KPIs' },
  { key: 'silver-rate', label: 'Silver Rate', description: 'View and update silver rate' },
  { key: 'sales', label: 'Sales', description: 'Invoices, orders, customers and returns' },
  { key: 'purchase', label: 'Purchase', description: 'Purchase orders, invoices, suppliers and returns' },
  { key: 'inventory', label: 'Inventory', description: 'Products, stock, transfers, QR labels and low stock' },
  { key: 'accounts', label: 'Accounts', description: 'Expenses, payments, bank accounts and ledger' },
  { key: 'reports', label: 'Reports', description: 'Business, GST, sales and inventory reports' },
  { key: 'shopify', label: 'Shopify', description: 'Shopify sync, price and inventory push' },
  { key: 'system', label: 'System', description: 'Users & roles, settings and audit logs' },
]

export const ACTIONS: Array<{ key: keyof ModulePermission; label: string; hint: string }> = [
  { key: 'view', label: 'View', hint: 'See the module' },
  { key: 'create', label: 'Add', hint: 'Create records' },
  { key: 'edit', label: 'Edit', hint: 'Modify records' },
  { key: 'delete', label: 'Delete', hint: 'Remove records' },
]

const PATH_MODULE: Array<{ prefix: string; module: string }> = [
  { prefix: '/silver-rate', module: 'silver-rate' },
  { prefix: '/sales', module: 'sales' },
  { prefix: '/purchase', module: 'purchase' },
  { prefix: '/inventory', module: 'inventory' },
  { prefix: '/accounts', module: 'accounts' },
  { prefix: '/reports', module: 'reports' },
  { prefix: '/shopify', module: 'shopify' },
  { prefix: '/system', module: 'system' },
  { prefix: '/', module: 'dashboard' },
]

export function moduleForPath(path: string): string {
  const entry = PATH_MODULE.find((p) => path.startsWith(p.prefix))
  return entry?.module ?? 'dashboard'
}

/** The canonical entry path for a module ('/' for dashboard, '/sales', …). */
export function pathForModule(moduleKey: string): string {
  return PATH_MODULE.find((p) => p.module === moduleKey)?.prefix ?? '/'
}

export function emptyPermissions(): Permissions {
  const out: Permissions = {}
  for (const m of MODULES) out[m.key] = { view: false, create: false, edit: false, delete: false }
  return out
}

export function can(perms: Permissions | null | undefined, moduleKey: string, action: keyof ModulePermission): boolean {
  // '*' is the full-access marker the auth provider sets for Super Admin when
  // the permissions API is unreachable; without it the fallback locked the
  // super admin out of every module instead of granting them.
  if (perms?.['*']?.[action]) return true
  return Boolean(perms?.[moduleKey]?.[action])
}

export function hasAnyView(perms: Permissions | null | undefined): boolean {
  if (!perms) return false
  return MODULES.some((m) => perms[m.key]?.view)
}
