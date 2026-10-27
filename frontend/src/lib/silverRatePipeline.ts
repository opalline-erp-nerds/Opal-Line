import type { SilverRateProgress, SilverRateStepLog } from '@/types'

// Pure mapping between what the backend reports about a silver-rate update and
// the pipeline checklist the Silver Rate page renders. Kept out of the
// component file so the phase → step logic is unit-testable and the component
// file exports components only (Fast Refresh).
//
// Backend truth (applySilverRate in backend/src/shopify.ts): an apply runs
// optional "sync catalog" → save rate → reprice → match to Shopify → push
// prices, stopping at the first failure. While it runs, GET /silver/update/progress
// reports one of those phases; when it finishes, the response carries
// result.steps and the rate row stores the same steps as silver_rates.step_log.

export type RateStepKey = 'sync' | 'rate' | 'reprice' | 'match' | 'push'
export type RateStepStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped'

export interface RatePipelineStep {
  key: RateStepKey
  label: string
  status: RateStepStatus
  /** Short explanation (counts, price range) shown under the label. */
  detail?: string
  /** Failure text — rendered in red under a failed step. */
  error?: string
  startedAt?: string | null
  finishedAt?: string | null
}

/** Pipeline order. `sync` only appears when "sync first" was switched on. */
export const RATE_STEP_ORDER: RateStepKey[] = ['sync', 'rate', 'reprice', 'match', 'push']

/** User-facing wording for each backend step. */
export const RATE_STEP_LABELS: Record<RateStepKey, string> = {
  sync: 'Sync catalog from Shopify',
  rate: 'Rate updated in ERP',
  reprice: 'Products repriced',
  match: 'Matched to Shopify catalog',
  push: 'Pushed to Shopify',
}

/** Which pipeline step a progress phase is currently working on. */
const PHASE_STEP: Partial<Record<SilverRateProgress['phase'], RateStepKey>> = {
  syncing: 'sync',
  repricing: 'reprice',
  matching: 'match',
  pushing: 'push',
}

/**
 * Live pipeline while an apply is running: everything before the current step
 * is done, the current step is active, the rest are pending. A finished run
 * with an error marks the step named by the progress label as failed (the
 * backend stops at the first failure, so later steps stay pending).
 */
export function stepsFromPhase(input: {
  progress: Pick<SilverRateProgress, 'phase' | 'label' | 'total' | 'error'>
  syncFirst: boolean
}): RatePipelineStep[] {
  const { phase, label, total, error } = input.progress
  const keys = input.syncFirst ? RATE_STEP_ORDER : RATE_STEP_ORDER.filter((k) => k !== 'sync')

  let current: RateStepKey | null = null
  if (phase === 'syncing') current = 'sync'
  // The rate row is saved inside the 'repricing' phase: once products start
  // counting (total > 0) the reprice step is the one running.
  else if (phase === 'repricing') current = total > 0 ? 'reprice' : 'rate'
  else current = PHASE_STEP[phase] ?? null

  const failed = phase === 'done' && error ? inferFailedStep(label, keys) : null
  const currentIndex = current ? keys.indexOf(current) : keys.length
  // A failed run stops at that step: everything before it happened, everything
  // after it never ran (never mark later steps as complete).
  const doneBefore = failed ? keys.indexOf(failed) : currentIndex

  return keys.map((key, index) => {
    let status: RateStepStatus
    if (key === failed) status = 'failed'
    else if (key === current) status = 'active'
    else if (phase === 'done' && !error) status = 'done'
    else if (index < doneBefore) status = 'done'
    else status = 'pending'
    return {
      key,
      label: RATE_STEP_LABELS[key],
      status,
      detail: key === current ? label : undefined,
      error: status === 'failed' ? error ?? undefined : undefined,
    }
  })
}

/** Which step the backend's failure label refers to. */
function inferFailedStep(label: string, keys: RateStepKey[]): RateStepKey | null {
  const text = label.toLowerCase()
  const wanted: RateStepKey = text.includes('sync')
    ? 'sync'
    : text.includes('save')
      ? 'rate'
      : text.includes('repric')
        ? 'reprice'
        : 'push'
  return keys.includes(wanted) ? wanted : null
}

/** Final pipeline from an apply's `result.steps`, enriched with step_log times. */
export function stepsFromResult(
  resultSteps: Array<{ key: string; label: string; status: 'done' | 'failed' | 'skipped'; detail?: string }> | undefined,
  stepLog?: SilverRateStepLog | null,
): RatePipelineStep[] {
  const logByKey = new Map((stepLog?.steps ?? []).map((s) => [s.key, s]))
  return (resultSteps ?? []).map((s) => {
    const key = (RATE_STEP_ORDER.includes(s.key as RateStepKey) ? s.key : 'push') as RateStepKey
    const log = logByKey.get(key)
    return {
      key,
      label: RATE_STEP_LABELS[key],
      status: s.status,
      detail: s.detail ?? log?.detail,
      error: log?.error ?? (s.status === 'failed' ? s.detail : undefined),
      startedAt: log?.startedAt ?? null,
      finishedAt: log?.finishedAt ?? null,
    }
  })
}

/** Pipeline from a history row's persisted step log (newest run first). */
export function stepsFromStepLog(stepLog: SilverRateStepLog): RatePipelineStep[] {
  return [...stepLog.steps]
    .sort((a, b) => RATE_STEP_ORDER.indexOf(a.key) - RATE_STEP_ORDER.indexOf(b.key))
    .map((s) => ({
      key: s.key,
      label: RATE_STEP_LABELS[s.key] ?? s.label,
      status: s.status,
      detail: s.detail,
      error: s.error,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
    }))
}

/** True when every recorded step succeeded or was legitimately skipped. */
export function pipelineSucceeded(steps: RatePipelineStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.status === 'done' || s.status === 'skipped')
}

/** Grey checklist shown on the review step, before the run starts. */
export function plannedSteps(syncFirst: boolean): RatePipelineStep[] {
  return (syncFirst ? RATE_STEP_ORDER : RATE_STEP_ORDER.filter((k) => k !== 'sync')).map((key) => ({
    key,
    label: RATE_STEP_LABELS[key],
    status: 'pending' as const,
  }))
}
