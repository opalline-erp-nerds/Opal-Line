import { Check, Loader2, Minus, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'
import { pipelineSucceeded, stepsFromStepLog, type RatePipelineStep, type RateStepStatus } from '@/lib/silverRatePipeline'
import type { SilverRateRow } from '@/types'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'

// Visuals for the silver-rate update pipeline. The phase → step mapping lives
// in lib/silverRatePipeline.ts (pure, unit-tested); this file renders it.

const STATUS_TEXT: Record<RateStepStatus, string> = {
  pending: 'Not reached',
  active: 'Running',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
}

function StatusMarker({ status }: { status: RateStepStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border',
        status === 'done' && 'border-success-100 bg-success-50 text-success-700',
        status === 'failed' && 'border-red-100 bg-red-50 text-red-600 dark:text-red-400',
        status === 'active' && 'border-primary-100 bg-primary-50 text-primary-700',
        status === 'skipped' && 'border-border bg-muted text-muted-foreground',
        status === 'pending' && 'border-dashed border-border bg-card text-muted-foreground/60',
      )}
    >
      {status === 'done' ? (
        <Check className="h-3.5 w-3.5" />
      ) : status === 'failed' ? (
        <X className="h-3.5 w-3.5" />
      ) : status === 'active' ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : status === 'skipped' ? (
        <Minus className="h-3.5 w-3.5" />
      ) : null}
    </span>
  )
}

/**
 * Checklist of a rate update's steps: green ✓ succeeded, red ✗ failed (with the
 * error), spinner on the running step, grey for steps never reached. Pass
 * `complete` to append the final confirmation row once every step succeeded.
 */
export function SilverRatePipeline({
  steps,
  complete,
  showTimes,
  className,
}: {
  steps: RatePipelineStep[]
  /** Renders the final "Complete" row when every step succeeded. */
  complete?: boolean
  /** Show each step's finished-at timestamp (history/detail views). */
  showTimes?: boolean
  className?: string
}) {
  if (steps.length === 0) return null
  return (
    <ol className={cn('space-y-2', className)} aria-label="Rate update steps">
      {steps.map((step) => (
        <li key={step.key} className="flex items-start gap-2.5">
          <StatusMarker status={step.status} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <p
                className={cn(
                  'text-[13px] font-semibold',
                  step.status === 'failed'
                    ? 'text-red-600 dark:text-red-400'
                    : step.status === 'pending'
                      ? 'text-muted-foreground'
                      : 'text-foreground',
                )}
              >
                {step.label}
              </p>
              <span className="sr-only">— {STATUS_TEXT[step.status]}</span>
              {showTimes && step.finishedAt ? (
                <span className="text-[11px] tabular-nums text-muted-foreground">{formatDateTime(step.finishedAt)}</span>
              ) : null}
            </div>
            {step.detail && step.status !== 'failed' ? (
              <p className="truncate text-[11px] text-muted-foreground">{step.detail}</p>
            ) : null}
            {step.error ? (
              <p className="text-[11px] font-medium text-red-600 dark:text-red-400">{step.error}</p>
            ) : null}
          </div>
        </li>
      ))}
      {complete && pipelineSucceeded(steps) ? (
        <li className="flex items-start gap-2.5">
          <StatusMarker status="done" />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-foreground">Complete</p>
            <p className="text-[11px] text-muted-foreground">All steps succeeded.</p>
          </div>
        </li>
      ) : null}
    </ol>
  )
}

/** Compact green/red/grey dots for a history row (the View dialog has detail). */
export function StepDots({ steps }: { steps: RatePipelineStep[] }) {
  if (steps.length === 0) return <span className="text-[11px] text-muted-foreground">—</span>
  return (
    <span className="inline-flex items-center gap-1" title={steps.map((s) => `${s.label}: ${STATUS_TEXT[s.status]}`).join(' · ')}>
      {steps.map((step) => (
        <span
          key={step.key}
          aria-label={`${step.label}: ${STATUS_TEXT[step.status]}`}
          className={cn(
            'h-2.5 w-2.5 rounded-full',
            step.status === 'done' && 'bg-success-500',
            step.status === 'failed' && 'bg-red-500',
            step.status === 'skipped' && 'bg-muted-foreground/40',
            step.status === 'active' && 'bg-primary-500',
            step.status === 'pending' && 'bg-muted',
          )}
        />
      ))}
    </span>
  )
}

function DetailItem({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn('truncate text-[13px] font-semibold tabular-nums text-foreground', className)}>{value}</dd>
    </div>
  )
}

/**
 * "View" for one rate-update log entry: who changed it, when, the old → new
 * rate, every step with its own timestamp (and error text), how many products
 * were repriced and what reached Shopify. Degrades gracefully for rows written
 * before step tracking existed.
 */
export function RateUpdateDetailDialog({
  row,
  open,
  onOpenChange,
}: {
  row: SilverRateRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const stepLog = row?.stepLog ?? null
  const steps = stepLog ? stepsFromStepLog(stepLog) : []
  const previousRate = row?.previousRate ?? null

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="Rate update details"
      description={row ? formatDateTime(row.updatedAt) : undefined}
    >
      {row ? (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border bg-muted/40 p-3 sm:grid-cols-3">
            <DetailItem
              label="Rate"
              value={
                previousRate != null ? `₹${previousRate.toFixed(2)} → ₹${row.rate.toFixed(2)}` : `₹${row.rate.toFixed(2)}`
              }
            />
            <DetailItem
              label="Change"
              value={`${(row.change ?? 0) >= 0 ? '+' : '−'}₹${Math.abs(row.change ?? 0).toFixed(2)}`}
              className={
                (row.change ?? 0) > 0
                  ? 'text-success-700'
                  : (row.change ?? 0) < 0
                    ? 'text-red-600 dark:text-red-400'
                    : undefined
              }
            />
            <DetailItem label="Updated by" value={row.updatedBy ?? 'Unknown'} />
            <DetailItem label="Approved by" value={row.approvedBy ?? '—'} />
            <DetailItem label="Source" value={row.source ?? 'Legacy entry'} />
            <DetailItem
              label="Shopify"
              value={
                row.syncStatus === 'synced' ? 'Synced' : row.syncStatus === 'failed' ? 'Failed' : row.syncStatus === 'skipped' ? 'Skipped' : '—'
              }
            />
          </dl>

          {steps.length > 0 ? (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Steps</p>
              <SilverRatePipeline steps={steps} complete={stepLog?.ok === true} showTimes />
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border bg-muted/40 p-3 sm:grid-cols-4">
                <DetailItem label="Repriced" value={`${stepLog?.counts.repriced ?? 0}`} />
                <DetailItem label="Matched" value={`${stepLog?.counts.matched ?? 0}`} />
                <DetailItem label="Pushed" value={`${stepLog?.counts.pushed ?? 0}`} />
                <DetailItem label="Skipped" value={`${stepLog?.counts.skipped ?? 0}`} />
              </dl>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed px-3 py-4 text-center text-[13px] text-muted-foreground">
              Recorded before step tracking was added — the per-step detail is not stored for this update.
            </p>
          )}
        </div>
      ) : null}
    </AppDialog>
  )
}

/** Shared "View" row action for the history log. */
export function ViewUpdateButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-primary" onClick={onClick}>
      View
    </Button>
  )
}

/** Shopify-status badge for a history row (shared by the log). */
export function SyncStatusBadge({ status }: { status: string | null }) {
  const variant = status === 'synced' ? 'success' : status === 'failed' ? 'danger' : 'muted'
  return (
    <Badge variant={variant} dot>
      {status === 'synced' ? 'Synced' : status === 'failed' ? 'Failed' : status === 'skipped' ? 'Skipped' : '—'}
    </Badge>
  )
}
