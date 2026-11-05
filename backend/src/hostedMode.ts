/** A process that listens beyond loopback. The desktop app and `npm run dev`
 * leave HOST unset, so they stay on 127.0.0.1 even when Electron sets
 * NODE_ENV=production. That production flag alone must not change them. */
export function isPublicHost(env: NodeJS.ProcessEnv = process.env): boolean {
  const host = (env.HOST ?? '').trim().toLowerCase()
  if (!host) return false
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]'
}

export class HostedConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostedConfigError'
  }
}

/** Missing ENCRYPTION_KEY or CSRF_SECRET on a public bind. Null on the desktop. */
export function publicHostStartupError(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isPublicHost(env)) return null
  const missing: string[] = []
  const key = (env.ENCRYPTION_KEY ?? '').trim()
  if (!/^[0-9a-fA-F]{64}$/.test(key)) missing.push('ENCRYPTION_KEY (64 hex characters)')
  if (!(env.CSRF_SECRET ?? '').trim()) missing.push('CSRF_SECRET')
  if (missing.length === 0) return null
  return `Refusing to start: HOST=${(env.HOST ?? '').trim()} is not loopback, so set ${missing.join(' and ')}.`
}

/** Desktop keeps the published default. A public bind must be given a password
 * and must not fall back to it. */
export function seedAdminPassword(env: NodeJS.ProcessEnv = process.env): string {
  const chosen = (env.SEED_ADMIN_PASSWORD ?? '').trim()
  if (!isPublicHost(env)) return chosen || 'Opal@2026'
  if (!chosen) {
    throw new HostedConfigError(
      'Refusing to create the first admin: set SEED_ADMIN_PASSWORD. The built-in default is not used when HOST is not loopback.',
    )
  }
  return chosen
}
