export type AutoSyncUnit = 'seconds' | 'minutes' | 'hours'

export const DEFAULT_INTERVAL_SECONDS = 6 * 60 * 60
export const MIN_INTERVAL_SECONDS = 60
export const MAX_INTERVAL_SECONDS = 168 * 60 * 60

export function clampIntervalSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_INTERVAL_SECONDS
  if (seconds === 0) return 0
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.floor(seconds)))
}

export function secondsFromValueAndUnit(value: number, unit: AutoSyncUnit): number {
  if (value === 0) return 0
  if (unit === 'hours') return value * 3600
  if (unit === 'minutes') return value * 60
  return value
}

export function resolveAutoSyncIntervalSeconds(body: Record<string, unknown>): number | { error: string } {
  if (body.intervalSeconds !== undefined && body.intervalSeconds !== null && body.intervalSeconds !== '') {
    const n = Number(body.intervalSeconds)
    if (!Number.isFinite(n) || n < 0 || n > MAX_INTERVAL_SECONDS) {
      return { error: `intervalSeconds must be 0 or between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}` }
    }
    if (n > 0 && n < MIN_INTERVAL_SECONDS) {
      return { error: `Minimum interval is ${MIN_INTERVAL_SECONDS} seconds when auto-sync is enabled` }
    }
    return clampIntervalSeconds(n)
  }

  if (body.value !== undefined && body.unit !== undefined) {
    const value = Number(body.value)
    const unit = String(body.unit).trim().toLowerCase()
    if (!Number.isFinite(value) || value < 0) {
      return { error: 'value must be a non-negative number' }
    }
    if (value === 0) return 0
    if (unit !== 'seconds' && unit !== 'minutes' && unit !== 'hours') {
      return { error: 'unit must be seconds, minutes, or hours' }
    }
    const seconds = secondsFromValueAndUnit(value, unit as AutoSyncUnit)
    if (seconds > MAX_INTERVAL_SECONDS) {
      return { error: `Interval too long (max ${MAX_INTERVAL_SECONDS} seconds / 168 hours)` }
    }
    if (seconds < MIN_INTERVAL_SECONDS) {
      return { error: `Minimum interval is ${MIN_INTERVAL_SECONDS} seconds when auto-sync is enabled` }
    }
    return seconds
  }

  if (body.intervalHours !== undefined && body.intervalHours !== null && body.intervalHours !== '') {
    const hours = Number(body.intervalHours)
    if (!Number.isFinite(hours) || hours < 0 || hours > 168) {
      return { error: 'intervalHours must be between 0 and 168' }
    }
    return hours === 0 ? 0 : clampIntervalSeconds(hours * 3600)
  }

  return { error: 'Provide intervalSeconds, or value + unit, or intervalHours' }
}

export function readStoredIntervalSeconds(settings: Record<string, unknown> | null | undefined): number {
  const rawSec = settings?.autoSyncIntervalSeconds
  if (rawSec !== undefined && rawSec !== null && rawSec !== '') {
    const n = Number(rawSec)
    if (Number.isFinite(n) && n >= 0) return n === 0 ? 0 : clampIntervalSeconds(n)
  }
  const rawHrs = settings?.autoSyncIntervalHours
  const h = Number(rawHrs)
  if (Number.isFinite(h) && h >= 0) return h === 0 ? 0 : clampIntervalSeconds(h * 3600)
  return DEFAULT_INTERVAL_SECONDS
}

export function formatAutoSyncInterval(seconds: number): string {
  if (seconds <= 0) return 'Disabled'
  if (seconds % 3600 === 0) {
    const h = seconds / 3600
    return `Every ${h} hour${h === 1 ? '' : 's'}`
  }
  if (seconds % 60 === 0) {
    const m = seconds / 60
    return `Every ${m} minute${m === 1 ? '' : 's'}`
  }
  return `Every ${seconds} second${seconds === 1 ? '' : 's'}`
}