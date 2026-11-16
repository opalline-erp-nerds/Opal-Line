/** Minimum share of products vs last full pull before we treat the catalog as truncated. */
export const MIN_CATALOG_RATIO = 0.5

export const AUTO_SYNC_PAUSE_AFTER_FAILURES = 5

export const INTERVAL_WARN_BELOW_SECONDS = 300
export const INTERVAL_SUGGEST_SECONDS = 900
/** Upper bound for routine auto-sync (30 minutes). */
export const INTERVAL_ROUTINE_MAX_SECONDS = 1800

export function evaluateShopGuard(configuredShop: string | null, storedShop: string | null): CatalogGuardResult {
  const shop = configuredShop?.trim().toLowerCase() ?? ''
  const stored = storedShop?.trim().toLowerCase() ?? ''
  if (shop && stored && shop !== stored) {
    return {
      ok: false,
      reason: `Shopify store changed (${stored} → ${shop}). Run a manual full sync after verifying credentials.`,
      skipFailures: true,
    }
  }
  return { ok: true }
}

export type CatalogGuardInput = {
  configuredShop: string | null
  storedShop: string | null
  fullCatalog: boolean
  liveCount: number
  lastFullCount: number | null
}

export type CatalogGuardResult =
  | { ok: true }
  | { ok: false; reason: string; skipFailures: boolean }

/**
 * Post-fetch checks for scheduled auto-sync. Incremental pulls may legitimately
 * return zero rows; full pulls must not be empty or far below the last baseline.
 */
export function evaluateCatalogGuards(input: CatalogGuardInput): CatalogGuardResult {
  const shopVerdict = evaluateShopGuard(input.configuredShop, input.storedShop)
  if (!shopVerdict.ok) return shopVerdict
  if (input.fullCatalog && input.liveCount === 0) {
    return { ok: false, reason: 'Shopify returned an empty product catalog; auto-sync skipped.', skipFailures: true }
  }
  if (
    input.fullCatalog &&
    input.lastFullCount != null &&
    input.lastFullCount > 0 &&
    input.liveCount < input.lastFullCount * MIN_CATALOG_RATIO
  ) {
    return {
      ok: false,
      reason: `Shopify returned ${input.liveCount} products but the last full sync had ${input.lastFullCount}; auto-sync skipped as a safety measure.`,
      skipFailures: true,
    }
  }
  return { ok: true }
}

export function shouldPauseAutoSync(consecutiveFailures: number): boolean {
  return consecutiveFailures >= AUTO_SYNC_PAUSE_AFTER_FAILURES
}