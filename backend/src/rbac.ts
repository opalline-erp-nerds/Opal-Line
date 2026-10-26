import { eq } from 'drizzle-orm'
import type { NextFunction, Request, Response } from 'express'
import { db, schema } from './db/client'
import type { ModulePermission, Permissions, RbacModule, UserPermissions } from './types'
import { logger } from './logger'

export const MODULES: RbacModule[] = [
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

export const MODULE_KEYS = MODULES.map((m) => m.key)

const all: ModulePermission = { view: true, create: true, edit: true, delete: true }

export const emptyPermissions = (): Permissions => {
  const out: Permissions = {}
  for (const m of MODULES) out[m.key] = { view: false, create: false, edit: false, delete: false }
  return out
}

/**
 * Default module permissions for a role.
 *
 * Only the Super Admin role ships with access. Every other role starts with
 * no modules at all: a super admin turns modules on per user (Users & Roles →
 * Permissions) or per custom role. The old per-role templates (Admin =
 * everything, Manager = sales + inventory, …) handed every new user broad
 * access without anyone deciding it, which is exactly what this removes.
 */
export function defaultRolePermissions(name: string): Permissions {
  const p = emptyPermissions()
  if (name === 'Super Admin') {
    for (const m of MODULES) p[m.key] = { ...all }
  }
  return p
}

export function mergePermissions(rolePermissions: Permissions, overrides: Permissions | null): Permissions {
  const out = emptyPermissions()
  for (const m of MODULES) {
    const base = rolePermissions[m.key] ?? { view: false, create: false, edit: false, delete: false }
    const ov = overrides?.[m.key]
    out[m.key] = {
      view: ov?.view ?? base.view,
      create: ov?.create ?? base.create,
      edit: ov?.edit ?? base.edit,
      delete: ov?.delete ?? base.delete,
    }
  }
  return out
}

export async function getRoleByName(name: string) {
  if (!db) return null
  const [row] = await db.select().from(schema.roles).where(eq(schema.roles.name, name)).limit(1)
  return row ?? null
}

export async function computeUserPermissions(userId: string): Promise<UserPermissions | null> {
  if (!db) return null
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1)
  if (!user) return null
  // A Super Admin has full access by definition: neither the stored role row
  // nor a personal override may ever narrow it (self-lockout guard — module
  // grants are this role's decisions to make, not its own constraints).
  if (user.role === 'Super Admin') {
    const full = defaultRolePermissions('Super Admin')
    return { userId: user.id, role: user.role, rolePermissions: full, overrides: null, effective: full }
  }
  const role = await getRoleByName(user.role)
  const rolePermissions: Permissions = (role?.permissions as Permissions | null) ?? defaultRolePermissions(user.role)
  const overrides = (user.permissions as Permissions | null) ?? null
  const effective = mergePermissions(rolePermissions, overrides)
  return { userId: user.id, role: user.role, rolePermissions, overrides, effective }
}

/** True when the user's role is Super Admin. */
export async function isSuperAdminUser(userId: string): Promise<boolean> {
  if (!db) return false
  const [user] = await db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, userId)).limit(1)
  return user?.role === 'Super Admin'
}

/** True when a role grants any module (its stored snapshot or its defaults). */
export async function roleGrantsAnyModule(roleName: string): Promise<boolean> {
  const role = await getRoleByName(roleName)
  const perms: Permissions = (role?.permissions as Permissions | null) ?? defaultRolePermissions(roleName)
  return MODULE_KEYS.some(
    (k) => perms[k]?.view || perms[k]?.create || perms[k]?.edit || perms[k]?.delete,
  )
}

/**
 * Module access is the super admin's call: only a Super Admin may switch a
 * module on for a user, define a role that carries permissions, or hand out
 * the Super Admin role itself. Everything else in the system module (creating
 * plain users, resetting passwords, …) stays with requirePermission('system', …).
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  const userId = req.userId
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' })
    return
  }
  if (!db) {
    res.status(503).json({ error: 'Database unavailable, cannot verify permissions' })
    return
  }
  isSuperAdminUser(userId)
    .then((ok) => {
      if (!ok) {
        res.status(403).json({ error: 'Only a super admin can manage module access' })
        return
      }
      next()
    })
    .catch((err) => {
      logger.error({ err: { message: err.message } }, 'Super admin check failed')
      res.status(500).json({ error: 'Permission check failed' })
    })
}

export function requirePermission(moduleKey: string, action: keyof ModulePermission) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' })
      return
    }
    if (!db) {
      res.status(503).json({ error: 'Database unavailable, cannot verify permissions' })
      return
    }
    const perms = await computeUserPermissions(userId)
    if (!perms) {
      res.status(401).json({ error: 'User not found' })
      return
    }
    const granted = perms.effective[moduleKey]?.[action]
    if (!granted) {
        res.status(403).json({ error: 'Access denied' })
      return
    }
    next()
  }
}

const RESOURCE_MODULE: Record<string, string> = {
  products: 'inventory',
  customers: 'sales',
  suppliers: 'purchase',
  'sales-orders': 'sales',
  invoices: 'sales',
  'sales-invoice-items': 'sales',
  'purchase-orders': 'purchase',
  'purchase-invoices': 'purchase',
  'sales-returns': 'sales',
  'purchase-returns': 'purchase',
  inventory: 'inventory',
  'bank-accounts': 'accounts',
  ledger: 'accounts',
  expenses: 'accounts',
  payments: 'accounts',
  users: 'system',
  'audit-logs': 'system',
  'activity-logs': 'system',
  'sync-logs': 'shopify',
  'silver-rates': 'silver-rate',
  settings: 'system',
  'print-templates': 'system',
  stats: 'dashboard',
  search: 'dashboard',
  dashboard: 'dashboard',
  reports: 'reports',
}

export function enforceRbac(req: Request, res: Response, next: NextFunction) {
  const userId = req.userId
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' })
    return
  }
  if (!db) {
    res.status(503).json({ error: 'Database unavailable, cannot verify permissions' })
    return
  }

  const segments = req.path.split('/').filter(Boolean)
  const first = segments[0] ?? ''
  const moduleKey = RESOURCE_MODULE[first]
  if (!moduleKey) return next()

  const method = req.method.toLowerCase()
  const action: keyof ModulePermission =
    method === 'get' ? 'view' : method === 'post' ? 'create' : method === 'delete' ? 'delete' : 'edit'

  computeUserPermissions(userId)
    .then((perms) => {
      if (!perms) {
        res.status(401).json({ error: 'User not found' })
        return
      }
      if (!perms.effective[moduleKey]?.[action]) {
      res.status(403).json({ error: 'Access denied' })
        return
      }
      next()
    })
    .catch((err) => {
      logger.error({ err: { message: err.message } }, 'RBAC permission check failed')
      res.status(500).json({ error: 'Permission check failed' })
    })
}
