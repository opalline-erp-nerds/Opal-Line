import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { Router } from 'express'
import { getRawClient } from '../db/client'
import { requirePermission } from '../rbac'
import { actorFromRequest, recordActivity } from '../activity'
import { logger } from '../logger'
import { pushRestoredDataToShopify } from '../shopify'
import { getMasterKey } from '../lib/crypto'
import { notifyBackupComplete, notifyLowStock,  notifyBackupFiles } from '../notifications'
import { sendInvoiceWhatsApp, sendOrderConfirmationWhatsApp, sendShippingUpdateWhatsApp, sendLowStockWhatsApp,  isWhatsAppConfigured } from '../whatsapp'
import { filterAttachableFiles, MAX_TOTAL_ATTACHMENT_MB } from '../mailAttachments'
import { routeParam } from '../lib/routeParams'
import { DEFAULT_REORDER_LEVEL } from '../lib/lowStock'

export const backupRouter = Router()

const MAX_BACKUP_SIZE = 50 * 1024 * 1024 // 50MB

const IST_TIMEZONE = 'Asia/Kolkata'

// Backups live under the backend package root (the nearest ancestor containing
// package.json), NOT process.cwd(), so files recorded in history keep resolving
// to the same stable folder no matter how the server is launched or restarted.
let _backupDir: string | null = null
function backendRoot(): string {
  let dir = __dirname
  for (let i = 0; i < 8; i++) {
    try {
      if (existsSync(path.join(dir, 'package.json'))) return dir
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.join(__dirname, '..', '..')
}

export function backupDirectory(): string {
  if (_backupDir) return _backupDir
  // Priority: explicit override → per-user data dir (desktop app; the install
  // directory under Program Files is read-only) → backend package root (dev).
  _backupDir = process.env.BACKUP_DIR
    ? path.resolve(process.env.BACKUP_DIR)
    : process.env.APP_DATA_DIR?.trim()
      ? path.join(process.env.APP_DATA_DIR.trim(), 'backups')
      : path.join(backendRoot(), 'backups')
  return _backupDir
}

function istStamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}-${get('hour')}-${get('minute')}-${get('second')}`
}

type TableName = string

export interface BackupScope {
  key: string
  label: string
  description: string
  tables: TableName[]
}

export const BACKUP_SCOPES: BackupScope[] = [
  {
    key: 'products',
    label: 'Products',
    description: 'Product catalog, pricing and stock',
    tables: ['products'],
  },
  {
    key: 'customers',
    label: 'Customers',
    description: 'Customer profiles',
    tables: ['customers'],
  },
  {
    key: 'orders',
    label: 'Orders',
    description: 'Sales orders and line items',
    tables: ['sales_orders', 'sales_invoice_items'],
  },
  {
    key: 'inventory',
    label: 'Inventory',
    description: 'Stock, locations and transfers',
    tables: ['products', 'inventory_locations', 'stock_transfers'],
  },
  {
    key: 'sales-reports',
    label: 'Sales Reports',
    description: 'Sales invoices, orders, returns and payments',
    tables: ['sales_orders', 'sales_invoices', 'sales_invoice_items', 'sales_returns', 'payments'],
  },
  {
    key: 'gst-reports',
    label: 'GST Reports',
    description: 'Sales & purchase invoices for GST',
    tables: ['sales_invoices', 'sales_invoice_items', 'purchase_invoices'],
  },
  {
    key: 'dashboard',
    label: 'Dashboard',
    description: 'Source data behind dashboard KPIs, summary and charts',
    tables: [
      'products', 'customers', 'suppliers', 'sales_orders', 'sales_invoices',
      'sales_invoice_items', 'purchase_orders', 'purchase_invoices', 'sales_returns',
      'purchase_returns', 'inventory_locations', 'stock_transfers', 'expenses',
      'payments', 'ledger_entries', 'bank_accounts', 'silver_rates',
    ],
  },
  {
    key: 'full',
    label: 'Full Backup',
    description: 'All business, catalog and configuration data',
    tables: [
      'products', 'customers', 'suppliers', 'sales_orders', 'sales_invoices',
      'sales_invoice_items', 'purchase_orders', 'purchase_invoices', 'sales_returns',
      'purchase_returns', 'inventory_locations', 'stock_transfers', 'bank_accounts',
      'ledger_entries', 'expenses', 'payments', 'silver_rates', 'settings', 'users', 'roles',
    ],
  },
]

const SCOPE_BY_KEY = new Map(BACKUP_SCOPES.map((s) => [s.key, s]))
const ALLOWED_TABLES = new Set(BACKUP_SCOPES.flatMap((s) => s.tables))

function requireDb(res: import('express').Response): boolean {
  const client = getRawClient()
  if (!client) {
    res.status(503).json({ error: 'Service temporarily unavailable' })
    return false
  }
  return true
}

function isValidTable(table: string): boolean {
  return ALLOWED_TABLES.has(table) && /^[a-z_]+$/.test(table)
}

function isValidColumnName(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) && name.length <= 128
}

function toDbValue(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}

// Credential material that must never leave the database in a backup file.
// Restores re-attach the live values so users keep their passwords (see executeRestore).
const USER_SECRET_COLUMNS = [
  'password_hash', 'reset_token', 'reset_token_expiry',
  'email_verification_token', 'email_verification_expiry',
] as const

function sanitizeExportRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  if (table !== 'users') return { ...row }
  const clean = { ...row }
  for (const col of USER_SECRET_COLUMNS) delete clean[col]
  return clean
}


function resolveScope(type: string | undefined): BackupScope {
  const key = typeof type === 'string' && SCOPE_BY_KEY.has(type) ? type : null
  if (key) return SCOPE_BY_KEY.get(key)!
  return SCOPE_BY_KEY.get('full')!
}

function resolveScopeFromData(data: Record<string, unknown[]>): BackupScope {
  const keys = new Set(Object.keys(data))
  let best = SCOPE_BY_KEY.get('full')!
  let bestScore = -1
  for (const scope of BACKUP_SCOPES) {
    if (scope.key === 'full') continue
    const scopeSet = new Set(scope.tables)
    const match = [...keys].filter((k) => scopeSet.has(k)).length
    if (match > bestScore) {
      bestScore = match
      best = scope
    }
  }
  if (bestScore > 0 && bestScore === keys.size) return best
  return SCOPE_BY_KEY.get('full')!
}

export interface ScopeExportResult {
  ok: boolean
  data: Record<string, unknown[]>
  type: string
  label: string
  error?: string
}

export async function exportScopeData(type: string | undefined): Promise<ScopeExportResult> {
  const scope = resolveScope(type)
  const client = getRawClient()
  if (!client) return { ok: false, data: {}, type: scope.key, label: scope.label, error: 'Service temporarily unavailable' }
  try {
    const out: Record<string, unknown[]> = {}
    for (const table of scope.tables) {
      const rows = await client.unsafe(`SELECT * FROM ${table}`)
      out[table] = rows.map((r: Record<string, unknown>) => sanitizeExportRow(table, r))
    }
    if (scope.key === 'products') {
      const silver = await client.unsafe('SELECT * FROM silver_rates')
      out['silver_rates'] = silver.map((r: Record<string, unknown>) => ({ ...r }))
    }
    return { ok: true, data: out, type: scope.key, label: scope.label }
  } catch (err) {
    return { ok: false, data: {}, type: scope.key, label: scope.label, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENCRYPTED BACKUP: AES-256-GCM encryption for backup files
// ─────────────────────────────────────────────────────────────────────────────

const ENCRYPTION_ALGO = 'aes-256-gcm'
const ENCRYPTION_KEY_LEN = 32
const ENCRYPTION_IV_LEN = 16
const ENCRYPTION_TAG_LEN = 16

function getBackupEncryptionKey(): Buffer {
  const raw = process.env.BACKUP_ENCRYPTION_KEY?.trim()
  if (raw) {
    const key = Buffer.from(raw, 'hex')
    if (key.length === ENCRYPTION_KEY_LEN) return key
    throw new Error('BACKUP_ENCRYPTION_KEY is set but invalid — expected 64 hex characters (32 bytes)')
  }
  // Derive from the master encryption key if available
  const masterRaw = process.env.ENCRYPTION_KEY?.trim()
  if (masterRaw) {
    const master = Buffer.from(masterRaw, 'hex')
    if (master.length === ENCRYPTION_KEY_LEN) return master
    throw new Error('ENCRYPTION_KEY is set but invalid — expected 64 hex characters (32 bytes)')
  }
  // Final fallback: the app's persisted random master key (.encryption-key).
  // Never fall back to a deterministic/constant key — that would make "encrypted"
  // backups trivially decryptable by anyone.
  return getMasterKey()
}

export function encryptBackupFile(data: string): string {
  const key = getBackupEncryptionKey()
  const iv = randomBytes(ENCRYPTION_IV_LEN)
  const cipher = createCipheriv(ENCRYPTION_ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(data, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

export function decryptBackupFile(encoded: string): string {
  const key = getBackupEncryptionKey()
  const buf = Buffer.from(encoded, 'base64')
  if (buf.length < ENCRYPTION_IV_LEN + ENCRYPTION_TAG_LEN + 1) {
    throw new Error('Encrypted backup is too short or corrupted')
  }
  const iv = buf.subarray(0, ENCRYPTION_IV_LEN)
  const tag = buf.subarray(ENCRYPTION_IV_LEN, ENCRYPTION_IV_LEN + ENCRYPTION_TAG_LEN)
  const encrypted = buf.subarray(ENCRYPTION_IV_LEN + ENCRYPTION_TAG_LEN)
  const decipher = createDecipheriv(ENCRYPTION_ALGO, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(encrypted, undefined, 'utf-8') + decipher.final('utf-8')
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKUP VALIDATION: Verify file integrity before restore
// ─────────────────────────────────────────────────────────────────────────────

interface BackupValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
  meta: { type?: string; label?: string; exportedAt?: string } | null
  tables: string[]
  totalRecords: number
  fileSize: number
}

async function validateBackupFile(filePath: string): Promise<BackupValidation> {
  const result: BackupValidation = { valid: true, errors: [], warnings: [], meta: null, tables: [], totalRecords: 0, fileSize: 0 }
  try {
    const stat = statSync(filePath)
    result.fileSize = stat.size
  } catch {
    result.valid = false
    result.errors.push('File does not exist or is not accessible')
    return result
  }

  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    result.valid = false
    result.errors.push('Could not read backup file')
    return result
  }

  // Check if it's encrypted
  let parsed: Record<string, unknown>
  try {
    const testParsed = JSON.parse(raw)
    // Handle { _encrypted: true, payload: '...' } wrapper from /export-encrypted
    if (testParsed && typeof testParsed === 'object' && '_encrypted' in testParsed && typeof (testParsed as any).payload === 'string') {
      try {
        const decrypted = decryptBackupFile((testParsed as any).payload)
        parsed = JSON.parse(decrypted) as Record<string, unknown>
        result.warnings.push('Backup file is encrypted (decrypted successfully)')
      } catch {
        result.valid = false
        result.errors.push('Could not decrypt backup file — may be corrupted or wrong key')
        return result
      }
    // Handle raw encrypted string (base64 with GCM tag, no wrapper)
    } else if (typeof testParsed === 'string' && testParsed.length > 100) {
      try {
        const decrypted = decryptBackupFile(testParsed)
        parsed = JSON.parse(decrypted) as Record<string, unknown>
        result.warnings.push('Backup file is encrypted (decrypted successfully)')
      } catch {
        result.valid = false
        result.errors.push('Could not decrypt backup file — may be corrupted or wrong key')
        return result
      }
    } else {
      parsed = testParsed as Record<string, unknown>
    }
  } catch {
    result.valid = false
    result.errors.push('Backup file is not valid JSON')
    return result
  }

  // Check metadata
  if (parsed && typeof parsed === 'object' && '_backup' in parsed) {
    const meta = parsed._backup as Record<string, unknown>
    result.meta = {
      type: (meta.type as string) ?? undefined,
      label: (meta.label as string) ?? undefined,
      exportedAt: (meta.exportedAt as string) ?? undefined,
    }
    if (!meta.type) result.warnings.push('Backup metadata missing type field')
    if (!meta.exportedAt) result.warnings.push('Backup metadata missing exportedAt field')
  } else {
    result.warnings.push('Backup file has no metadata header (legacy format)')
  }

  // Check data
  const data = (parsed.data ?? parsed) as Record<string, unknown[]>
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    result.valid = false
    result.errors.push('Backup data is missing or malformed')
    return result
  }

  result.tables = Object.keys(data)
  for (const table of result.tables) {
    if (!isValidTable(table)) {
      result.warnings.push(`Table "${table}" is not in the allowed list — will be skipped during restore`)
    }
    const rows = data[table]
    if (!Array.isArray(rows)) {
      result.errors.push(`Table "${table}" data is not an array`)
      continue
    }
    result.totalRecords += rows.length
    // Check for ID fields
    const firstRow = rows[0] as Record<string, unknown> | undefined
    if (rows.length > 0 && firstRow && !firstRow.id) {
      result.warnings.push(`Table "${table}" rows have no "id" field — upsert may not work correctly`)
    }
    // Check for empty tables
    if (rows.length === 0) {
      result.warnings.push(`Table "${table}" is empty in the backup`)
    }
  }

  if (result.totalRecords === 0) {
    result.warnings.push('Backup contains no records')
  }

  if (result.errors.length > 0) {
    result.valid = false
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// DRY RUN: Preview restore without actually writing
// ─────────────────────────────────────────────────────────────────────────────

interface DryRunResult {
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

async function previewRestore(
  data: Record<string, unknown[]>,
  scopeType: string,
  restoreSilverRate: boolean,
): Promise<DryRunResult> {
  const scope = resolveScope(scopeType)
  const client = getRawClient()!
  const scopeTables = new Set(scope.tables)
  const tables = Object.keys(data).filter((t) => isValidTable(t) && scopeTables.has(t))

  if (scope.key === 'products' && restoreSilverRate && Array.isArray(data['silver_rates'])) {
    tables.push('silver_rates')
  }

  const result: DryRunResult = {
    scope: scope.key,
    label: scope.label,
    tables: [],
    totalWillInsert: 0,
    totalWillDelete: 0,
    restoreSilverRate,
  }

  for (const table of tables) {
    const backupRows = data[table]
    if (!Array.isArray(backupRows)) continue

    const backupIds = new Set(backupRows.map((r) => (r as Record<string, unknown>).id).filter(Boolean))
    let currentCount = 0
    let idOverlap = 0
    try {
      const [{ count }] = await client.unsafe(`SELECT count(*) as count FROM "${table}"`)
      currentCount = Number(count)
      if (backupIds.size > 0) {
        const ids = [...backupIds]
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(',')
        const [{ overlap }] = await client.unsafe(
          `SELECT count(*) as overlap FROM "${table}" WHERE id IN (${placeholders})`,
          ids as any[],
        )
        idOverlap = Number(overlap)
      }
    } catch {
      // table might not exist yet
    }

    const willDelete = idOverlap
    const willInsert = backupRows.length
    result.tables.push({
      name: table,
      backupRecords: backupRows.length,
      currentRecords: currentCount,
      willInsert,
      willDelete,
      willUpdate: willDelete,
      hasIdOverlap: idOverlap > 0,
    })
    result.totalWillInsert += willInsert
    result.totalWillDelete += willDelete
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKUP DIFF: Compare two backup files
// ─────────────────────────────────────────────────────────────────────────────

interface BackupDiff {
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

async function compareBackups(file1: string, file2: string): Promise<BackupDiff> {
  const readBackup = async (fileName: string): Promise<Record<string, unknown[]>> => {
    const raw = await readFile(path.join(backupDirectory(), path.basename(fileName)), 'utf8')
    const parsed = JSON.parse(raw)
    // Handle encrypted backups
    if (parsed && typeof parsed === 'object' && '_encrypted' in parsed && typeof (parsed as any).payload === 'string') {
      const decrypted = decryptBackupFile((parsed as any).payload)
      const decryptedParsed = JSON.parse(decrypted) as Record<string, unknown>
      return (decryptedParsed.data ?? decryptedParsed) as Record<string, unknown[]>
    }
    return (parsed.data ?? parsed) as Record<string, unknown[]>
  }

  const data1 = await readBackup(file1)
  const data2 = await readBackup(file2)
  const allTables = new Set([...Object.keys(data1), ...Object.keys(data2)])

  const diff: BackupDiff = {
    file1, file2, tables: [],
    summary: { totalAdded: 0, totalRemoved: 0, totalModified: 0 },
  }

  for (const table of allTables) {
    const rows1 = (data1[table] ?? []) as Array<Record<string, unknown>>
    const rows2 = (data2[table] ?? []) as Array<Record<string, unknown>>
    const map1 = new Map(rows1.map((r) => [r.id, r]))
    const map2 = new Map(rows2.map((r) => [r.id, r]))
    const allIds = new Set([...map1.keys(), ...map2.keys()])

    const added: string[] = []
    const removed: string[] = []
    const modified: string[] = []

    for (const id of allIds) {
      const in1 = map1.has(id)
      const in2 = map2.has(id)
      if (!in1 && in2) added.push(String(id))
      else if (in1 && !in2) removed.push(String(id))
      else if (in1 && in2) {
        const r1 = JSON.stringify(map1.get(id))
        const r2 = JSON.stringify(map2.get(id))
        if (r1 !== r2) modified.push(String(id))
      }
    }

    diff.tables.push({ name: table, file1Count: rows1.length, file2Count: rows2.length, added, removed, modified })
    diff.summary.totalAdded += added.length
    diff.summary.totalRemoved += removed.length
    diff.summary.totalModified += modified.length
  }

  return diff
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE-RESTORE SAFETY BACKUP: Auto-backup before restore for undo
// ─────────────────────────────────────────────────────────────────────────────

async function createPreRestoreBackup(label: string): Promise<string | null> {
  try {
    const result = await exportScopeData('full')
    if (!result.ok) return null
    const dir = backupDirectory()
    await mkdir(dir, { recursive: true })
    const fileName = `pre-restore-${istStamp()}.json`
    const payload = {
      _backup: {
        type: 'pre-restore',
        label: `Pre-restore safety backup (${label})`,
        exportedAt: new Date().toISOString(),
        isPreRestore: true,
        triggeredBy: label,
      },
      data: result.data,
    }
    await writeFile(path.join(dir, fileName), JSON.stringify(payload, null, 2), 'utf8')
    return fileName
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESTORE CORE: The shared restore logic used by all restore modes
// ─────────────────────────────────────────────────────────────────────────────

async function executeRestore(
  data: Record<string, unknown[]>,
  scopeType: string,
  restoreSilverRate: boolean,
  options?: { tables?: string[] },
): Promise<{ restored: number; tables: number }> {
  const scope = resolveScope(scopeType)
  const client = getRawClient()!
  const scopeTables = new Set(scope.tables)
  let tables = Object.keys(data).filter((t) => isValidTable(t) && scopeTables.has(t))

  // If specific tables were requested, filter to only those
  if (options?.tables && options.tables.length > 0) {
    const requested = new Set(options.tables.filter(isValidTable))
    tables = tables.filter((t) => requested.has(t))
  }

  if (scope.key === 'products' && restoreSilverRate && Array.isArray(data['silver_rates'])) {
    if (!options?.tables || options.tables.includes('silver_rates')) {
      tables.push('silver_rates')
    }
  }

  if (tables.length === 0) {
    throw new Error('No valid tables found in backup data')
  }

  const result = await client.begin(async (tx) => {
    let restored = 0

    // Live user credential columns: exports are sanitized (no password hashes),
    // so when restoring users we re-attach the current hash/tokens by id so
    // accounts keep working after a restore.
    const liveUserSecrets = new Map<string, Record<string, unknown>>()
    if (tables.includes('users')) {
      const cols = USER_SECRET_COLUMNS.map((c) => `"${c}"`).join(', ')
      const existing = await tx.unsafe(`SELECT id, ${cols} FROM "users"`)
      for (const r of existing as Record<string, unknown>[]) {
        liveUserSecrets.set(String(r.id), r)
      }
    }

    for (const table of tables) {
      const rows = data[table]
      if (!Array.isArray(rows)) continue

      if (table === 'silver_rates') {
        await tx.unsafe('DELETE FROM "silver_rates"')
        if (rows.length > 0) {
          const firstRow = rows[0] as Record<string, unknown>
          const cols = Object.keys(firstRow).filter(isValidColumnName)
          const quotedCols = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ')
          for (const row of rows) {
            const rowObj = row as Record<string, unknown>
            const values = cols.map((c) => toDbValue(rowObj[c]))
            const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')
            await tx.unsafe(`INSERT INTO "silver_rates" (${quotedCols}) VALUES (${placeholders})`, values as any[])
          }
        }
        restored += rows.length
        continue
      }

      const ids = rows.map((r) => (r as Record<string, unknown>).id).filter((id) => id != null)
      if (ids.length > 0) {
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(',')
        await tx.unsafe(`DELETE FROM "${table}" WHERE id IN (${placeholders})`, ids as any[])
      }
      if (rows.length > 0) {
        const firstRow = rows[0] as Record<string, unknown>
        const cols = Object.keys(firstRow).filter(isValidColumnName)
        // User exports are sanitized, so force the credential columns into the
        // INSERT column list — values are re-attached from the live DB per row.
        if (table === 'users') {
          for (const col of USER_SECRET_COLUMNS) {
            if (!cols.includes(col)) cols.push(col)
          }
        }
        const quotedCols = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ')
        for (const row of rows) {
          const rowObj = row as Record<string, unknown>
          if (table === 'users') {
            const live = liveUserSecrets.get(String(rowObj.id))
            if (live) {
              for (const col of USER_SECRET_COLUMNS) {
                if (live[col] != null) rowObj[col] = live[col]
              }
            }
          }
          const values = cols.map((c) => toDbValue(rowObj[c]))
          const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')
          await tx.unsafe(`INSERT INTO "${table}" (${quotedCols}) VALUES (${placeholders})`, values as any[])
        }
      }
      restored += rows.length
    }

    return { restored, tables: tables.length }
  })

  return result
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═════════════════════════════════════════════════════════════════════════════

backupRouter.get('/scopes', requirePermission('system', 'view'), (_req, res) => {
  res.json(BACKUP_SCOPES.map(({ key, label, description }) => ({ key, label, description })))
})

backupRouter.get('/auto-status', requirePermission('system', 'view'), async (_req, res) => {
  try {
    const { getAutoBackupStatus } = await import('../autoBackup')
    res.json(await getAutoBackupStatus())
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown error' }, 'Auto backup status failed')
    res.status(500).json({ error: 'Could not load auto backup status' })
  }
})

// Auto-email toggle: when on, the 7 PM auto-backup attaches the fresh archive
// to an email (subject to the 20 MB attachment guard inside the send path).
backupRouter.get('/auto-email', requirePermission('system', 'view'), async (_req, res) => {
  try {
    const { isBackupEmailEnabled } = await import('../autoBackup')
    res.json({ enabled: await isBackupEmailEnabled() })
  } catch {
    res.status(500).json({ error: 'Could not load auto email setting' })
  }
})

backupRouter.post('/auto-email', requirePermission('system', 'edit'), async (req, res) => {
  try {
    const { setBackupEmailEnabled } = await import('../autoBackup')
    await setBackupEmailEnabled(req.body?.enabled === true)
    res.json({ ok: true, enabled: req.body?.enabled === true })
  } catch {
    res.status(500).json({ error: 'Could not save auto email setting' })
  }
})

backupRouter.get('/history', requirePermission('system', 'view'), async (_req, res) => {
  const client = getRawClient()
  if (!client) return res.status(503).json({ error: 'Service temporarily unavailable' })
  try {
    const rows = await client.unsafe(
      `SELECT id, timestamp, "user", action, module, entity, details, ip
       FROM activity_logs
       WHERE action IN ('Exported Backup', 'Restored Backup', 'Validated Backup', 'Compared Backups')
       ORDER BY timestamp DESC
       LIMIT 50`
    )
    res.json(rows)
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown error' }, 'Backup history query failed')
    res.status(500).json({ error: 'Could not load backup history' })
  }
})

backupRouter.get('/files', requirePermission('system', 'view'), async (_req, res) => {
  try {
    const dir = backupDirectory()
    await mkdir(dir, { recursive: true })
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json'))
    const files: Array<{
      fileName: string; type: string | null; label: string | null;
      exportedAt: string | null; fileSize: number; isEncrypted: boolean
      isPreRestore: boolean
    }> = []
    for (const name of names) {
      try {
        const filePath = path.join(dir, name)
        const stat = statSync(filePath)
        const raw = await readFile(filePath, 'utf8')
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(raw)
        } catch {
          // Might be encrypted
          files.push({ fileName: name, type: null, label: 'Encrypted', exportedAt: null, fileSize: stat.size, isEncrypted: true, isPreRestore: false })
          continue
        }
        let type: string | null = null
        let label: string | null = null
        let exportedAt: string | null = null
        let isPreRestore = false
        if (parsed && typeof parsed === 'object' && 'data' in parsed && parsed.data && typeof parsed.data === 'object') {
          const meta = parsed._backup as { type?: string; label?: string; exportedAt?: string; isPreRestore?: boolean } | undefined
          type = meta?.type ?? null
          label = meta?.label ?? null
          exportedAt = meta?.exportedAt ?? null
          isPreRestore = meta?.isPreRestore === true
        } else if (parsed && typeof parsed === 'object') {
          const detected = resolveScopeFromData(parsed as Record<string, unknown[]>)
          type = detected.key
          label = detected.label
        }
        files.push({ fileName: name, type, label, exportedAt, fileSize: stat.size, isEncrypted: false, isPreRestore })
      } catch {
        // skip unreadable/corrupt files
      }
    }
    files.sort((a, b) => (b.exportedAt ?? '').localeCompare(a.exportedAt ?? ''))
    res.json(files)
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown error' }, 'Backup files listing failed')
    res.status(500).json({ error: 'Could not list stored backups' })
  }
})

backupRouter.get('/export', requirePermission('system', 'view'), async (req, res) => {
  const result = await exportScopeData(String(req.query.type ?? ''))
  if (!result.ok) {
    logger.error({ err: result.error }, 'Backup export failed')
    return res.status(500).json({ error: 'Backup export failed' })
  }
  const exportedAt = new Date().toISOString()
  let fileName: string | null = null
  try {
    const dir = backupDirectory()
    await mkdir(dir, { recursive: true })
    fileName = `${result.type}-backup-${istStamp(new Date(exportedAt))}.json`
    const payload = {
      _backup: { type: result.type, label: result.label, exportedAt },
      data: result.data,
    }
    await writeFile(path.join(dir, fileName), JSON.stringify(payload, null, 2), 'utf8')
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown error' }, 'Backup file write failed')
  }

  const actor = actorFromRequest(req)
  void recordActivity({
    action: 'Exported Backup',
    module: 'system',
    entity: `Backup (${result.label})`,
    details: `${result.label} · ${Object.keys(result.data).length} table(s)${fileName ? ' · ' + fileName : ''}`,
    userId: actor.userId,
    ip: actor.ip,
  })
  logger.info({ type: result.type, tables: Object.keys(result.data).length }, 'Backup exported')

  return res.json({ ok: true, type: result.type, label: result.label, exportedAt, fileName, data: result.data })
})

// ─────────────────────────────────────────────────────────────────────────────
// ENCRYPTED EXPORT: Export a backup with AES-256-GCM encryption
// ─────────────────────────────────────────────────────────────────────────────

backupRouter.get('/export-encrypted', requirePermission('system', 'view'), async (req, res) => {
  const result = await exportScopeData(String(req.query.type ?? ''))
  if (!result.ok) {
    logger.error({ err: result.error }, 'Encrypted backup export failed')
    return res.status(500).json({ error: 'Backup export failed' })
  }
  const exportedAt = new Date().toISOString()
  let fileName: string | null = null
  try {
    const dir = backupDirectory()
    await mkdir(dir, { recursive: true })
    fileName = `${result.type}-encrypted-${istStamp(new Date(exportedAt))}.json`
    const payload = {
      _backup: { type: result.type, label: result.label, exportedAt, encrypted: true },
      data: result.data,
    }
    const jsonStr = JSON.stringify(payload)
    const encrypted = encryptBackupFile(jsonStr)
    await writeFile(path.join(dir, fileName), JSON.stringify({ _encrypted: true, payload: encrypted }), 'utf8')
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown error' }, 'Encrypted backup file write failed')
  }

  const actor = actorFromRequest(req)
  void recordActivity({
    action: 'Exported Backup',
    module: 'system',
    entity: `Encrypted Backup (${result.label})`,
    details: `Encrypted · ${result.label} · ${Object.keys(result.data).length} table(s)${fileName ? ' · ' + fileName : ''}`,
    userId: actor.userId,
    ip: actor.ip,
  })

  return res.json({ ok: true, type: result.type, label: result.label, exportedAt, fileName, encrypted: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATE: Check backup file integrity before restoring
// ─────────────────────────────────────────────────────────────────────────────

backupRouter.post('/validate', requirePermission('system', 'view'), async (req, res) => {
  const fileName = typeof req.body?.fileName === 'string' && req.body.fileName ? req.body.fileName : null
  if (!fileName) {
    return res.status(400).json({ error: 'fileName is required' })
  }

  const filePath = path.join(backupDirectory(), path.basename(fileName))
  const validation = await validateBackupFile(filePath)

  const actor = actorFromRequest(req)
  void recordActivity({
    action: 'Validated Backup',
    module: 'system',
    entity: `Backup (${fileName})`,
    details: `${validation.valid ? 'Valid' : 'Invalid'} · ${validation.tables.length} table(s) · ${validation.totalRecords} record(s)${validation.errors.length ? ' · ' + validation.errors.length + ' error(s)' : ''}${validation.warnings.length ? ' · ' + validation.warnings.length + ' warning(s)' : ''}`,
    userId: actor.userId,
    ip: actor.ip,
  })

  res.json({ ...validation, fileName })
})

// ─────────────────────────────────────────────────────────────────────────────
// DRY RUN: Preview what a restore would do without actually restoring
// ─────────────────────────────────────────────────────────────────────────────

backupRouter.post('/dry-run', requirePermission('system', 'view'), async (req, res) => {
  if (!requireDb(res)) return

  const fileName = typeof req.body?.fileName === 'string' && req.body.fileName ? req.body.fileName : null
  const restoreSilverRate = req.body?.restoreSilverRate === true
  const tables = Array.isArray(req.body?.tables) ? req.body.tables : undefined

  if (!fileName) {
    return res.status(400).json({ error: 'fileName is required' })
  }

  const filePath = path.join(backupDirectory(), path.basename(fileName))
  try {
    const st = statSync(filePath)
    if (st.size > MAX_BACKUP_SIZE) {
      return res.status(400).json({ error: `Backup file exceeds maximum size of ${MAX_BACKUP_SIZE / (1024 * 1024)}MB` })
    }
  } catch {
    return res.status(400).json({ error: 'Backup file not found' })
  }

  let data: Record<string, unknown[]>
  let scopeType: string | undefined

  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed._encrypted && parsed.payload) {
      const decrypted = decryptBackupFile(parsed.payload)
      const decryptedParsed = JSON.parse(decrypted)
      data = decryptedParsed.data as Record<string, unknown[]>
      scopeType = decryptedParsed._backup?.type
    } else if (parsed.data && typeof parsed.data === 'object') {
      data = parsed.data as Record<string, unknown[]>
      scopeType = parsed._backup?.type
    } else {
      data = parsed as Record<string, unknown[]>
    }
  } catch (err) {
    return res.status(400).json({ error: 'Could not read backup file: ' + (err instanceof Error ? err.message : 'Unknown error') })
  }

  // Validate backup structure: must have a `tables` object with arrays of rows
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: 'Invalid backup structure: expected a tables object' })
  }
  for (const [tableName, rows] of Object.entries(data)) {
    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: `Invalid backup structure: table "${tableName}" must be an array` })
    }
    for (const row of rows) {
      if (row && typeof row === 'object' && !('id' in row)) {
        return res.status(400).json({ error: `Invalid backup structure: rows in table "${tableName}" must have an "id" field` })
      }
    }
  }

  try {
    const preview = await previewRestore(data, scopeType ?? '', restoreSilverRate)

    // If specific tables were requested, filter the preview
    if (tables && tables.length > 0) {
      const requested = new Set(tables)
      preview.tables = preview.tables.filter((t) => requested.has(t.name))
      preview.totalWillInsert = preview.tables.reduce((s, t) => s + t.willInsert, 0)
      preview.totalWillDelete = preview.tables.reduce((s, t) => s + t.willDelete, 0)
    }

    res.json({ ok: true, fileName, ...preview })
  } catch (err) {
    res.status(500).json({ error: 'Dry run failed: ' + (err instanceof Error ? err.message : 'Unknown error') })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// DIFF: Compare two backup files
// ─────────────────────────────────────────────────────────────────────────────

backupRouter.post('/diff', requirePermission('system', 'view'), async (req, res) => {
  const file1 = typeof req.body?.file1 === 'string' && req.body.file1 ? req.body.file1 : null
  const file2 = typeof req.body?.file2 === 'string' && req.body.file2 ? req.body.file2 : null

  if (!file1 || !file2) {
    return res.status(400).json({ error: 'Both file1 and file2 are required' })
  }

  try {
    const diff = await compareBackups(file1, file2)
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Compared Backups',
      module: 'system',
      entity: 'Backup Comparison',
      details: `${file1} vs ${file2} · ${diff.summary.totalAdded} added, ${diff.summary.totalRemoved} removed, ${diff.summary.totalModified} modified`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ok: true, ...diff })
  } catch (err) {
    res.status(400).json({ error: 'Could not compare backups: ' + (err instanceof Error ? err.message : 'Unknown error') })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// RESTORE: The main restore endpoint with all advanced options
// ─────────────────────────────────────────────────────────────────────────────

backupRouter.post('/restore', requirePermission('system', 'edit'), async (req, res) => {
  if (!requireDb(res)) return

  const fileName = typeof req.body?.fileName === 'string' && req.body.fileName ? req.body.fileName : null
  const restoreSilverRate = req.body?.restoreSilverRate === true
  const dryRun = req.body?.dryRun === true
  const skipShopify = req.body?.skipShopify === true
  const createSafetyBackup = req.body?.createSafetyBackup !== false // default true
  const tables = Array.isArray(req.body?.tables) ? req.body.tables : undefined

  // CONFIRMATION GATE: A real restore (not a dry run) must carry an explicit
  // confirmation phrase, so a stray/malicious request can never wipe tables.
  if (!dryRun) {
    const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm.trim() : ''
    if (confirm !== 'RESTORE') {
      return res.status(400).json({
        error: "Restore requires explicit confirmation — send confirm: 'RESTORE' in the request body",
        needsConfirmation: true,
      })
    }
  }

  let data = req.body?.data
  let scopeType = req.body?.type
  let labelFromFile: string | null = null

  // Read backup from file
  if (fileName) {
    const filePath = path.join(backupDirectory(), path.basename(fileName))
    try {
      const st = statSync(filePath)
      if (st.size > MAX_BACKUP_SIZE) {
        return res.status(400).json({ error: `Backup file exceeds maximum size of ${MAX_BACKUP_SIZE / (1024 * 1024)}MB` })
      }
    } catch {
      return res.status(400).json({ error: 'Backup file not found' })
    }

    try {
      const raw = await readFile(filePath, 'utf8')
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(raw)
      } catch {
        return res.status(400).json({ error: 'Backup file is not valid JSON' })
      }

      // Check if encrypted
      if (parsed._encrypted && parsed.payload) {
        try {
          const decrypted = decryptBackupFile(parsed.payload as string)
          parsed = JSON.parse(decrypted)
        } catch {
          return res.status(400).json({ error: 'Could not decrypt backup file — wrong encryption key or corrupted file' })
        }
      }

      if (parsed && typeof parsed === 'object' && 'data' in parsed && parsed.data && typeof parsed.data === 'object') {
        const meta = parsed._backup as { type?: string; label?: string; exportedAt?: string } | undefined
        data = parsed.data as Record<string, unknown[]>
        if (meta?.type) scopeType = meta.type
        labelFromFile = meta?.label ?? null
        if (meta?.type !== 'products') {
          // Only honor restoreSilverRate for products scope
        }
      } else if (parsed && typeof parsed === 'object') {
        data = parsed as Record<string, unknown[]>
        const detected = resolveScopeFromData(data)
        scopeType = detected.key
        labelFromFile = detected.label
      }
    } catch (err) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        logger.error({ err: err instanceof Error ? err.message : 'Unknown error' }, 'Stored backup read failed')
        return res.status(400).json({ error: 'Could not read the stored backup file: ' + (err instanceof Error ? err.message : 'Unknown error') })
      }
    }
  }

  const scope = resolveScope(scopeType)
  const scopeLabel = labelFromFile ?? scope.label
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: 'Backup data is required' })
  }

  // Validate backup structure: must have tables with arrays of rows
  for (const [tableName, rows] of Object.entries(data)) {
    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: `Invalid backup structure: table "${tableName}" must be an array` })
    }
    for (const row of rows) {
      if (row && typeof row === 'object' && !('id' in row)) {
        return res.status(400).json({ error: `Invalid backup structure: rows in table "${tableName}" must have an "id" field` })
      }
    }
  }

  // DRY RUN MODE: Preview without actually restoring
  if (dryRun) {
    try {
      const preview = await previewRestore(data, scopeType ?? '', restoreSilverRate)
      if (tables && tables.length > 0) {
        const requested = new Set(tables)
        preview.tables = preview.tables.filter((t) => requested.has(t.name))
        preview.totalWillInsert = preview.tables.reduce((s, t) => s + t.willInsert, 0)
        preview.totalWillDelete = preview.tables.reduce((s, t) => s + t.willDelete, 0)
      }
      return res.json({ ok: true, dryRun: true, ...preview })
    } catch (err) {
      return res.status(500).json({ error: 'Dry run failed: ' + (err instanceof Error ? err.message : 'Unknown error') })
    }
  }

  // PRE-RESTORE SAFETY BACKUP: Auto-create a backup before restoring
  let safetyBackupFile: string | null = null
  if (createSafetyBackup) {
    safetyBackupFile = await createPreRestoreBackup(scopeLabel)
    if (safetyBackupFile) {
      logger.info({ file: safetyBackupFile }, 'Pre-restore safety backup created')
    }
  }

  try {
    const result = await executeRestore(data, scopeType ?? '', restoreSilverRate, { tables })

    // SHOPIFY RESYNC (optional)
    let shopifySync: unknown = null
    if (!skipShopify) {
      try {
        shopifySync = await pushRestoredDataToShopify()
      } catch (err) {
        shopifySync = { ok: false, errors: [err instanceof Error ? err.message : 'Shopify sync after restore failed'] }
      }
    }

    const syncState = skipShopify
      ? 'Shopify sync skipped'
      : shopifySync && typeof shopifySync === 'object' && (shopifySync as { ok?: boolean }).ok === true
        ? 'Shopify resynced'
        : 'Shopify sync failed'

    const actor = actorFromRequest(req)
    const details = [
      `${scopeLabel} · ${result.restored} record(s) restored`,
      restoreSilverRate ? '· silver rate reverted' : null,
      tables?.length ? `· ${tables.length} table(s) selected` : null,
      `· ${syncState}`,
      safetyBackupFile ? `· safety backup: ${safetyBackupFile}` : null,
    ].filter(Boolean).join(' ')

    void recordActivity({
      action: 'Restored Backup',
      module: 'system',
      entity: `Restore (${scopeLabel})`,
      details,
      userId: actor.userId,
      ip: actor.ip,
    })
    logger.info({ type: scope.key, tables: result.tables, restored: result.restored }, 'Backup restored')

    res.json({
      ok: true,
      type: scope.key,
      label: scopeLabel,
      restoredAt: new Date().toISOString(),
      silverRateIncluded: restoreSilverRate,
      safetyBackup: safetyBackupFile,
      shopifySync,
      ...result,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    logger.error({ err: message }, 'Backup restore failed')
    res.status(500).json({ error: 'Backup restore failed: ' + message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// DELETE: Remove a backup file
// ─────────────────────────────────────────────────────────────────────────────

backupRouter.delete('/files/:fileName', requirePermission('system', 'delete'), async (req, res) => {
  const fileName = routeParam(req.params.fileName)
  if (!fileName || !fileName.endsWith('.json')) {
    return res.status(400).json({ error: 'Invalid file name' })
  }
  const filePath = path.join(backupDirectory(), path.basename(fileName))
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup file not found' })
  }
  try {
    const { unlinkSync } = await import('node:fs')
    unlinkSync(filePath)
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Deleted Backup',
      module: 'system',
      entity: `Backup (${fileName})`,
      details: `Deleted backup file`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ok: true, fileName })
  } catch {
    res.status(500).json({ error: 'Could not delete backup file' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// DOWNLOAD: Download a backup file as an attachment
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS: Test email, send daily summary, check low stock
// ─────────────────────────────────────────────────────────────────────────────

backupRouter.post('/notifications/test', requirePermission('system', 'edit'), async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : process.env.NOTIFICATION_EMAIL?.trim()
  if (!email) return res.status(400).json({ error: 'No email configured. Set NOTIFICATION_EMAIL in .env or provide email in request.' })
  try {
    const sent = await notifyBackupComplete(email, { type: 'Test', tables: 0, fileName: 'test-backup.json', recordCount: 0 })
    res.json({ ok: sent, email })
  } catch (err) {
    res.status(500).json({ error: 'Failed to send test email: ' + (err instanceof Error ? err.message : 'Unknown') })
  }
})

backupRouter.post('/notifications/low-stock', requirePermission('system', 'view'), async (_req, res) => {
  const email = process.env.NOTIFICATION_EMAIL?.trim()
  if (!email) return res.status(400).json({ error: 'NOTIFICATION_EMAIL not configured' })
  const client = getRawClient()
  if (!client) return res.status(503).json({ error: 'DB unavailable' })
  try {
    const products = await client.unsafe(
      `SELECT name, sku, stock, reorder_level FROM products WHERE track_inventory != false AND stock IS NOT NULL AND stock <= COALESCE(reorder_level, ${DEFAULT_REORDER_LEVEL})`
    )
    if (products.length === 0) return res.json({ ok: true, message: 'No low stock items', count: 0 })
    const sent = await notifyLowStock(email, products.map((p: any) => ({ name: p.name, sku: p.sku, stock: Number(p.stock), reorderLevel: Number(p.reorder_level ?? DEFAULT_REORDER_LEVEL) })))
    res.json({ ok: sent, email, count: products.length })
  } catch {
    res.status(500).json({ error: 'Low stock check failed' })
  }
})

backupRouter.post('/notifications/daily-summary', requirePermission('system', 'edit'), async (_req, res) => {
  const email = process.env.NOTIFICATION_EMAIL?.trim()
  if (!email) return res.status(400).json({ error: 'NOTIFICATION_EMAIL not configured' })
  const client = getRawClient()
  if (!client) return res.status(503).json({ error: 'DB unavailable' })
  try {
    const { sendDailySummaryEmail } = await import('../autoBackup')
    const sent = await sendDailySummaryEmail(email)
    res.json({ ok: sent, email })
  } catch {
    res.status(500).json({ error: 'Daily summary failed' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL BACKUP FILES: send full-DB or per-scope backup files as attachments
// ─────────────────────────────────────────────────────────────────────────────

// Single shared budget for backup email attachments (see mailAttachments.ts).
const MAX_EMAIL_ATTACHMENT_BYTES = MAX_TOTAL_ATTACHMENT_MB * 1024 * 1024

backupRouter.post('/email', requirePermission('system', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  const email = typeof req.body?.email === 'string' && req.body.email.trim() ? req.body.email.trim() : process.env.NOTIFICATION_EMAIL?.trim()
  if (!email) return res.status(400).json({ error: 'No email configured. Set NOTIFICATION_EMAIL in .env or provide an email in the request.' })
  const scopeInput = typeof req.body?.scope === 'string' ? req.body.scope : 'full'
  if (!SCOPE_BY_KEY.has(scopeInput)) return res.status(400).json({ error: `Unknown scope "${scopeInput}"` })
  try {
    const result = await exportScopeData(scopeInput)
    if (!result.ok) return res.status(500).json({ error: result.error ?? 'Backup export failed' })
    const exportedAt = new Date().toISOString()
    const json = JSON.stringify({ _backup: { type: result.type, label: result.label, exportedAt }, data: result.data }, null, 2)
    const buffer = Buffer.from(json, 'utf8')
    const fileName = `${result.type}-backup-${istStamp(new Date(exportedAt))}.json`

    if (buffer.length > MAX_EMAIL_ATTACHMENT_BYTES) {
      return res.status(413).json({
        error: `Backup is ${(buffer.length / (1024 * 1024)).toFixed(1)} MB — too large to email (20 MB limit). Use Download instead, or email a narrower scope.`,
        sizeBytes: buffer.length,
      })
    }
    const recordCount = Object.values(result.data).reduce((a, rows) => a + (Array.isArray(rows) ? rows.length : 0), 0)
    const sent = await notifyBackupFiles(email, [{ fileName, content: buffer }], {
      scopeLabel: result.label,
      tableCount: Object.keys(result.data).length,
      recordCount,
    })
    if (!sent) return res.status(502).json({ error: 'Email send failed — check notification settings' })
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Emailed Backup',
      module: 'system',
      entity: `Backup (${result.label})`,
      details: `${result.label} · ${Object.keys(result.data).length} table(s) · ${fileName} → ${email}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ok: true, email, fileName, sizeBytes: buffer.length, tables: Object.keys(result.data).length, records: recordCount })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown' }, 'Backup email failed')
    res.status(500).json({ error: 'Backup email failed' })
  }
})

// Email a set of separate per-scope backup files (products, customers, orders, …)
backupRouter.post('/email-separate', requirePermission('system', 'edit'), async (req, res) => {
  if (!requireDb(res)) return
  const email = typeof req.body?.email === 'string' && req.body.email.trim() ? req.body.email.trim() : process.env.NOTIFICATION_EMAIL?.trim()
  if (!email) return res.status(400).json({ error: 'No email configured. Set NOTIFICATION_EMAIL in .env or provide an email in the request.' })
  try {
    const scopeKeys = BACKUP_SCOPES.filter((s) => s.key !== 'full').map((s) => s.key)
    const files: Array<{ fileName: string; content: Buffer; label: string; records: number }> = []
    const exportedAt = new Date().toISOString()
    let skipped: string[] = []
    for (const key of scopeKeys) {
      const result = await exportScopeData(key)
      if (!result.ok) { skipped.push(`${result.label}: ${result.error ?? 'export failed'}`); continue }
      const json = JSON.stringify({ _backup: { type: result.type, label: result.label, exportedAt }, data: result.data }, null, 2)
      const buffer = Buffer.from(json, 'utf8')
      if (buffer.length > MAX_EMAIL_ATTACHMENT_BYTES) { skipped.push(`${result.label}: file too large to email`); continue }
      files.push({
        fileName: `${result.type}-backup-${istStamp(new Date(exportedAt))}.json`,
        content: buffer,
        label: result.label,
        records: Object.values(result.data).reduce((a, rows) => a + (Array.isArray(rows) ? rows.length : 0), 0),
      })
    }
    if (files.length === 0) return res.status(500).json({ error: 'No scope could be exported', skipped })
    // Attachment budget: send what fits (shared helper), report the rest as
    // skipped so the response stays truthful about what was emailed.
    const budget = filterAttachableFiles(files)
    if (budget.attachable.length === 0) {
      return res.status(413).json({
        error: `Exported files are too large for one email (20 MB limit). Use Download instead.`,
        skipped: [...skipped, ...budget.skipped.map((s) => `${s.fileName}: ${s.reason}`)],
      })
    }
    for (const s of budget.skipped) skipped.push(`${s.fileName}: ${s.reason}`)
    const totalRecords = budget.attachable.reduce(
      (a, f) => a + (files.find((f2) => f2.fileName === f.fileName)?.records ?? 0),
      0,
    )
    const sent = await notifyBackupFiles(
      email,
      budget.attachable,
      { scopeLabel: 'All scopes (separate files)', tableCount: budget.attachable.length, recordCount: totalRecords, note: skipped.length ? `Skipped: ${skipped.join('; ')}` : undefined },
    )
    if (!sent) return res.status(502).json({ error: 'Email send failed — check notification settings' })
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Emailed Backup',
      module: 'system',
      entity: 'Backup (all scopes, separate files)',
      details: `${files.length} file(s) · ${totalRecords} record(s) → ${email}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ok: true, email, files: budget.attachable.map((f) => f.fileName), totalBytes: budget.totalMb * 1024 * 1024, skipped })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown' }, 'Backup email (separate) failed')
    res.status(500).json({ error: 'Backup email failed' })
  }
})

// Email an existing backup file from disk (Backup & Restore history table action)
backupRouter.post('/files/:name/email', requirePermission('system', 'edit'), async (req, res) => {
  const email = typeof req.body?.email === 'string' && req.body.email.trim() ? req.body.email.trim() : process.env.NOTIFICATION_EMAIL?.trim()
  if (!email) return res.status(400).json({ error: 'No email configured. Set NOTIFICATION_EMAIL in .env or provide an email in the request.' })
  try {
    const name = path.basename(String(routeParam(req.params.name) ?? ''))
    const filePath = path.join(backupDirectory(), name)
    if (!name.endsWith('.json') || !existsSync(filePath)) return res.status(404).json({ error: 'Backup file not found' })
    const content = await readFile(filePath)
    if (content.length > MAX_EMAIL_ATTACHMENT_BYTES) {
      return res.status(413).json({ error: `File is ${(content.length / (1024 * 1024)).toFixed(1)} MB — too large to email (20 MB limit).`, sizeBytes: content.length })
    }
    const stat = statSync(filePath)
    const sent = await notifyBackupFiles(email, [{ fileName: name, content }], {
      scopeLabel: 'Saved backup file',
      tableCount: 0,
      recordCount: 0,
      note: `File saved on ${stat.mtime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} · ${(stat.size / 1024).toFixed(0)} KB on disk.`,
    })
    if (!sent) return res.status(502).json({ error: 'Email send failed — check notification settings' })
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Emailed Backup',
      module: 'system',
      entity: `Backup file (${name})`,
      details: `${name} → ${email}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ok: true, email, fileName: name, sizeBytes: content.length })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown' }, 'Backup file email failed')
    res.status(500).json({ error: 'Backup file email failed' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP: Send invoice, order, and notification messages
// ─────────────────────────────────────────────────────────────────────────────

backupRouter.get('/whatsapp/status', requirePermission('system', 'view'), (_req, res) => {
  res.json({ configured: isWhatsAppConfigured() })
})

backupRouter.post('/whatsapp/send-invoice', requirePermission('sales', 'create'), async (req, res) => {
  if (!isWhatsAppConfigured()) return res.status(400).json({ error: 'WhatsApp not configured. Set WHATSAPP_API_KEY in .env' })
  const { phoneNumber, invoiceId } = req.body ?? {}
  if (!phoneNumber || !invoiceId) return res.status(400).json({ error: 'phoneNumber and invoiceId required' })
  const client = getRawClient()
  if (!client) return res.status(503).json({ error: 'DB unavailable' })
  try {
    const [inv] = await client.unsafe(`SELECT * FROM sales_invoices WHERE id = $1`, [invoiceId]) as any[]
    if (!inv) return res.status(404).json({ error: 'Invoice not found' })
    const items = await client.unsafe(`SELECT count(*) as c FROM sales_invoice_items WHERE invoice_id = $1`, [invoiceId])
    const sent = await sendInvoiceWhatsApp(phoneNumber, {
      invoiceNumber: inv.invoice_number || invoiceId,
      customerName: inv.customer_name || inv.customer || 'Customer',
      grandTotal: Number(inv.grand_total || 0),
      itemCount: Number(items[0]?.c || 0),
    })
    res.json({ ok: sent, phoneNumber })
  } catch {
    res.status(500).json({ error: 'Failed to send WhatsApp' })
  }
})

backupRouter.post('/whatsapp/send-order', requirePermission('sales', 'create'), async (req, res) => {
  if (!isWhatsAppConfigured()) return res.status(400).json({ error: 'WhatsApp not configured' })
  const { phoneNumber, orderNumber, customerName, totalAmount, itemCount } = req.body ?? {}
  if (!phoneNumber || !orderNumber) return res.status(400).json({ error: 'phoneNumber and orderNumber required' })
  const sent = await sendOrderConfirmationWhatsApp(phoneNumber, {
    orderNumber, customerName: customerName || 'Customer', totalAmount: Number(totalAmount || 0), itemCount: Number(itemCount || 0),
  })
  res.json({ ok: sent, phoneNumber })
})

backupRouter.post('/whatsapp/send-shipping', requirePermission('sales', 'create'), async (req, res) => {
  if (!isWhatsAppConfigured()) return res.status(400).json({ error: 'WhatsApp not configured' })
  const { phoneNumber, orderNumber, customerName, trackingId, carrier } = req.body ?? {}
  if (!phoneNumber || !orderNumber) return res.status(400).json({ error: 'phoneNumber and orderNumber required' })
  const sent = await sendShippingUpdateWhatsApp(phoneNumber, {
    orderNumber, customerName: customerName || 'Customer', trackingId, carrier,
  })
  res.json({ ok: sent, phoneNumber })
})

backupRouter.post('/whatsapp/send-low-stock', requirePermission('system', 'edit'), async (req, res) => {
  if (!isWhatsAppConfigured()) return res.status(400).json({ error: 'WhatsApp not configured' })
  const { phoneNumber } = req.body ?? {}
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' })
  const client = getRawClient()
  if (!client) return res.status(503).json({ error: 'DB unavailable' })
  const products = await client.unsafe(
    `SELECT name, stock FROM products WHERE track_inventory != false AND stock IS NOT NULL AND reorder_level IS NOT NULL AND stock <= reorder_level`
  )
  if (products.length === 0) return res.json({ ok: true, message: 'No low stock items', count: 0 })
  const sent = await sendLowStockWhatsApp(phoneNumber, products.map((p: any) => ({ name: p.name, stock: Number(p.stock) })))
  res.json({ ok: sent, phoneNumber, count: products.length })
})

// ─────────────────────────────────────────────────────────────────────────────
// SHOPIFY DATA ENHANCEMENT: Enrich customers/orders, CSV import
// ─────────────────────────────────────────────────────────────────────────────

backupRouter.post('/shopify/enrich-customers', requirePermission('system', 'edit'), async (_req, res) => {
  try {
    const { enrichCustomersFromShopify } = await import('../shopifyDataEnhance')
    const result = await enrichCustomersFromShopify()
    // ACCESS_DENIED is not "success with 0 enriched": surface the block so
    // the UI explains the plan-gated PII permission instead of a silent no-op.
    res.json({
      ...result,
      ok: !result.piiAccessDenied,
      piiAccessDenied: result.piiAccessDenied,
      errors: result.errors,
      message: result.piiAccessDenied
        ? 'Shopify denies Customer PII over the Admin API (plan-gated) — approve access in the Shopify admin (Settings → Apps and sales channels → Protected customer data), or use the CSV export.'
        : undefined,
    })
  } catch (err) {
    res.status(500).json({ error: 'Customer enrichment failed: ' + (err instanceof Error ? err.message : 'Unknown') })
  }
})

backupRouter.post('/shopify/enrich-orders', requirePermission('system', 'edit'), async (_req, res) => {
  try {
    const { enrichAllIncompleteOrders } = await import('../shopifyDataEnhance')
    const result = await enrichAllIncompleteOrders()
    res.json({ ok: !result.piiAccessDenied, message: result.piiAccessDenied ? result.errors[0] : undefined, ...result })
  } catch (err) {
    res.status(500).json({ error: 'Order enrichment failed: ' + (err instanceof Error ? err.message : 'Unknown') })
  }
})

backupRouter.post('/shopify/import-customers', requirePermission('system', 'edit'), async (req, res) => {
  try {
    const { importCustomersFromCSV } = await import('../shopifyDataEnhance')
    const rows = req.body?.rows
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows array is required (each row is an object with name, email, phone, etc.)' })
    }
    const result = await importCustomersFromCSV(rows)
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ error: 'Customer import failed: ' + (err instanceof Error ? err.message : 'Unknown') })
  }
})

backupRouter.post('/shopify/import-orders', requirePermission('system', 'edit'), async (req, res) => {
  try {
    const { importOrdersFromCSV } = await import('../shopifyDataEnhance')
    const rows = req.body?.rows
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows array is required' })
    }
    const result = await importOrdersFromCSV(rows)
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ error: 'Order import failed: ' + (err instanceof Error ? err.message : 'Unknown') })
  }
})

backupRouter.post('/shopify/parse-csv', requirePermission('system', 'edit'), async (req, res) => {
  try {
    const { csv } = req.body ?? {}
    if (typeof csv !== 'string') return res.status(400).json({ error: 'csv string is required' })
    // RFC 4180: fields can be quoted and contain commas/quotes/newlines —
    // Shopify exports ("8 Marine Drive, Near Gateway") always do. A naive
    // split(',') corrupts every quoted row.
    const parseLine = (line: string): string[] => {
      const out: string[] = []
      let cur = ''
      let inQuotes = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (inQuotes) {
          if (ch === '"') {
            if (line[i + 1] === '"') { cur += '"'; i++ }
            else inQuotes = false
          } else cur += ch
        } else if (ch === '"') {
          inQuotes = true
        } else if (ch === ',') {
          out.push(cur)
          cur = ''
        } else {
          cur += ch
        }
      }
      out.push(cur)
      return out.map((v) => v.trim())
    }
    const lines = csv.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((l) => l.trim() !== '')
    if (lines.length < 2) return res.status(400).json({ error: 'CSV must have header + at least 1 data row' })
    const headers = parseLine(lines[0])
    const rows: Record<string, string>[] = []
    for (let i = 1; i < lines.length; i++) {
      const values = parseLine(lines[i])
      const row: Record<string, string> = {}
      headers.forEach((h, idx) => { row[h] = values[idx] ?? '' })
      rows.push(row)
    }
    res.json({ ok: true, rows, count: rows.length, headers })
  } catch (err) {
    res.status(400).json({ error: 'CSV parse failed: ' + (err instanceof Error ? err.message : 'Unknown') })
  }
})

backupRouter.get('/files/:fileName/download', requirePermission('system', 'view'), (req, res) => {
  const fileName = routeParam(req.params.fileName)
  if (!fileName || !fileName.endsWith('.json')) {
    return res.status(400).json({ error: 'Invalid file name' })
  }
  const filePath = path.join(backupDirectory(), path.basename(fileName))
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup file not found' })
  }
  res.download(filePath, fileName)
})

// Download all backup files as a single ZIP archive
backupRouter.get('/files/download-all', requirePermission('system', 'view'), async (_req, res) => {
  try {
    const { zipSync } = await import('fflate')
    const dir = backupDirectory()
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json'))
    if (names.length === 0) return res.status(404).json({ error: 'No backup files to download' })
    const zipEntries: Record<string, Uint8Array> = {}
    for (const name of names) {
      try {
        const buf = await readFile(path.join(dir, name))
        zipEntries[name] = new Uint8Array(buf)
      } catch { /* skip unreadable */ }
    }
    const zipped = zipSync(zipEntries, { level: 6 })
    await recordActivity({
      action: 'Exported Backup',
      module: 'system',
      entity: 'backup-archive',
      details: `Downloaded ZIP of ${Object.keys(zipEntries).length} backup files`,
      ...actorFromRequest(_req),
    })
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="opal-line-backups-${new Date().toISOString().slice(0, 10)}.zip"`)
    res.send(Buffer.from(zipped))
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown error' }, 'Backup ZIP download failed')
    res.status(500).json({ error: 'Could not create backup archive' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// CLEANUP: Prune old backup files (keep last N per scope type)
// ─────────────────────────────────────────────────────────────────────────────

backupRouter.post('/cleanup', requirePermission('system', 'edit'), async (req, res) => {
  const keepLast = typeof req.body?.keepLast === 'number' && req.body.keepLast > 0 ? req.body.keepLast : 10
  try {
    const dir = backupDirectory()
    await mkdir(dir, { recursive: true })
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json'))

    const files: Array<{ fileName: string; exportedAt: string | null; isPreRestore: boolean }> = []
    for (const name of names) {
      try {
        const raw = await readFile(path.join(dir, name), 'utf8')
        const parsed = JSON.parse(raw)
        const meta = parsed._backup as { exportedAt?: string; isPreRestore?: boolean } | undefined
        files.push({ fileName: name, exportedAt: meta?.exportedAt ?? null, isPreRestore: meta?.isPreRestore === true })
      } catch {
        files.push({ fileName: name, exportedAt: null, isPreRestore: false })
      }
    }

    // Keep the newest files, delete the oldest beyond keepLast
    const deletable = files.filter(f => !f.isPreRestore).sort((a, b) => (b.exportedAt ?? '').localeCompare(a.exportedAt ?? ''))
    const toDelete = deletable.slice(keepLast)

    // Always delete pre-restore backups older than 7 days
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const oldPreRestore = files.filter(f => f.isPreRestore && f.exportedAt && f.exportedAt < cutoff)

    const deleted: string[] = []
    for (const f of [...toDelete, ...oldPreRestore]) {
      try {
        const { unlinkSync } = await import('node:fs')
        unlinkSync(path.join(dir, f.fileName))
        deleted.push(f.fileName)
      } catch { /* skip */ }
    }

    if (deleted.length > 0) {
      const actor = actorFromRequest(req)
      void recordActivity({
        action: 'Cleaned Up Backups',
        module: 'system',
        entity: 'Backup Cleanup',
        details: `Deleted ${deleted.length} backup(s), kept ${files.length - deleted.length}`,
        userId: actor.userId,
        ip: actor.ip,
      })
    }

    res.json({ ok: true, deleted, kept: files.length - deleted.length, keepLast })
  } catch (err) {
    res.status(500).json({ error: 'Cleanup failed: ' + (err instanceof Error ? err.message : 'Unknown error') })
  }
})
