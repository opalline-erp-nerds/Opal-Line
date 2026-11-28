import { useId } from 'react'
import { cn } from '@/lib/utils'

interface SparklineProps {
  /** Real series values. Empty/one-point series render a flat line. */
  values?: number[]
  color?: string
  className?: string
  /** Fill the area under the line. Defaults to true. */
  area?: boolean
  /** Snapshot metrics (outstanding, low stock) have no time series; draw a
   *  dashed flat line so the card stays balanced without inventing a trend. */
  snapshot?: boolean
}

/**
 * Tiny dependency-free trend line shared by the dashboard KPI cards and the
 * Sales Overview mini cards. Renders nothing data-like when there is no
 * series; the caller decides whether a snapshot placeholder is appropriate.
 */
export function Sparkline({
  values = [],
  color = '#008F78',
  className,
  area = true,
  snapshot = false,
}: SparklineProps) {
  const series = snapshot ? [0, 0] : values.length > 1 ? values : [values[0] ?? 0, values[0] ?? 0]
  const min = Math.min(...series)
  const max = Math.max(...series)
  const span = max - min || 1
  const coords = series.map((value, index) => {
    const x = (index / (series.length - 1)) * 100
    const y = snapshot ? 14 : 25 - ((value - min) / span) * 21
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const gradientId = `spark-${useId().replace(/:/g, '')}`

  return (
    <svg
      viewBox="0 0 100 28"
      className={cn('h-7 w-full', className)}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {area && !snapshot ? (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.16} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <polygon points={`0,28 ${coords.join(' ')} 100,28`} fill={`url(#${gradientId})`} />
        </>
      ) : null}
      <polyline
        points={coords.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
        strokeLinecap="round"
        strokeDasharray={snapshot ? '3 3' : undefined}
        opacity={snapshot ? 0.55 : 1}
      />
    </svg>
  )
}
