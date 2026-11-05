import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger'
import { publicHostStartupError } from '../hostedMode'

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 16
const TAG_LENGTH = 16
// Desktop app: the install directory (Program Files) is read-only, so the
// master key must live in the per-user data dir or every restart would mint a
// new key and permanently orphan all DB-encrypted secrets.
function keyFilePath(): string {
  const dataDir = process.env.APP_DATA_DIR?.trim()
  return dataDir ? join(dataDir, '.encryption-key') : join(process.cwd(), '.encryption-key')
}
const KEY_FILE = keyFilePath()

let masterKey: Buffer | null = null

function loadOrGenerateKey(): Buffer {
  if (masterKey) return masterKey

  const hostedError = publicHostStartupError()
  if (hostedError) {
    logger.error(hostedError)
    process.exit(1)
  }

  const envKey = process.env.ENCRYPTION_KEY?.trim()
  if (envKey) {
    masterKey = Buffer.from(envKey, 'hex')
    if (masterKey.length !== KEY_LENGTH) {
      logger.warn('ENCRYPTION_KEY is invalid length, generating temporary key')
      masterKey = randomBytes(KEY_LENGTH)
    }
    return masterKey
  }

  if (existsSync(KEY_FILE)) {
    try {
      const raw = readFileSync(KEY_FILE, 'utf-8').trim()
      masterKey = Buffer.from(raw, 'hex')
      if (masterKey.length === KEY_LENGTH) {
        logger.info('Loaded encryption key from .encryption-key')
        return masterKey
      }
    } catch {
      // fall through to generate
    }
  }

  masterKey = randomBytes(KEY_LENGTH)
  try {
    writeFileSync(KEY_FILE, masterKey.toString('hex'), { mode: 0o600 })
    logger.info('Generated new encryption key, saved to .encryption-key')
  } catch (err) {
    logger.error({ err }, 'CRITICAL: Could not persist encryption key to disk. Encrypted data may be unrecoverable after restart. Set ENCRYPTION_KEY env var as backup.')
  }
  return masterKey
}

export function encrypt(plaintext: string): string {
  const key = loadOrGenerateKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // Format: iv(16) + tag(16) + ciphertext — all base64
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

export function decrypt(ciphertext: string): string {
  const key = loadOrGenerateKey()
  const buf = Buffer.from(ciphertext, 'base64')
  if (buf.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Invalid ciphertext: too short')
  }
  const iv = buf.subarray(0, IV_LENGTH)
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(encrypted, undefined, 'utf-8') + decipher.final('utf-8')
}

const ENV_ENC_PREFIX = 'encV1:'

export function encryptSecret(plaintext: string): string {
  return ENV_ENC_PREFIX + encrypt(plaintext)
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENV_ENC_PREFIX)
}

export function decryptSecret(value: string | null | undefined): string {
  if (!value) return ''
  if (!value.startsWith(ENV_ENC_PREFIX)) return value
  try {
    return decrypt(value.slice(ENV_ENC_PREFIX.length))
  } catch (err) {
    // Never brick the process over one bad value (e.g. ciphertext written under
    // a different master key). Log and treat as empty so the app still boots.
    logger.error({ err }, 'decryptSecret failed — value was encrypted with a different key or is corrupt; treating as empty')
    return ''
  }
}

export function mask(value: string | null | undefined): string {
  if (!value) return ''
  return '••••••••'
}

/**
 * Returns the app's persisted master encryption key (env → .encryption-key → generate+persist).
 * Shared with the backup module so encrypted backups never fall back to a predictable key.
 */
export function getMasterKey(): Buffer {
  return loadOrGenerateKey()
}
