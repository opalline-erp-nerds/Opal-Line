import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { SilverRatePoint } from '@/types'
import { rateAxisLabel } from '@/lib/format'
import { SERIES_COLORS, useChartTheme } from './chart-theme'
import { ChartTooltipBox } from './chart-tooltip'

/**
 * Silver rate line: one point per IST calendar day (7/30/90-day window).
 *
 * Like the financial charts, it accepts an optional `fixedSize`: server-rendered
 * tests pass an explicit width/height so the recharts wrapper exists without a
 * DOM; the dashboard card lets ResponsiveContainer fill its column instead.
 */
export function SilverRateChart({
  data,
  fixedSize,
}: {
  data: SilverRatePoint[]
  fixedSize?: { width: number; height: number }
}) {
  const theme = useChartTheme()
  const rates = data.map((d) => d.rate).filter((r) => Number.isFinite(r))
  const min = rates.length ? Math.floor(Math.min(...rates)) - 2 : 80
  const max = rates.length ? Math.ceil(Math.max(...rates)) + 2 : 100
  const domain = rates.length ? [Math.max(0, min), max] : [80, 100]
  const color = SERIES_COLORS[0]
  const renderDot = (props: { cx?: number; cy?: number; index?: number }) => {
    if (props.cx == null || props.cy == null) return <g />
    const isLast = props.index === data.length - 1
    if (!isLast && data.length > 14) return <g />
    return (
      <circle
        cx={props.cx}
        cy={props.cy}
        r={isLast ? 4 : 2.5}
        fill={color}
        stroke={isLast ? '#fff' : 'none'}
        strokeWidth={isLast ? 2 : 0}
      />
    )
  }

  const chart = (
    <ComposedChart
      data={data}
      width={fixedSize?.width}
      height={fixedSize?.height}
      margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
    >
      <defs>
        <linearGradient id="silver-rate-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>
      <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
      <XAxis
        dataKey="date"
        tickLine={false}
        axisLine={false}
        tick={{ fill: theme.axis, fontSize: 11 }}
        dy={6}
        minTickGap={24}
        tickFormatter={(v: string) => rateAxisLabel(v)}
      />
      <YAxis
        domain={domain as [number, number]}
        tickLine={false}
        axisLine={false}
        width={44}
        tick={{ fill: theme.axis, fontSize: 11 }}
        tickFormatter={(v: number) => `₹${v}`}
      />
      <Tooltip
        cursor={{ stroke: color, strokeWidth: 1, strokeDasharray: '4 4' }}
        content={({ active, payload, label }) => {
          if (!active || !payload?.length) return null
          const p = payload[0].payload as SilverRatePoint
          return (
            <ChartTooltipBox
              title={rateAxisLabel(String(label))}
              rows={[{ label: 'Rate', value: `₹${p.rate.toFixed(2)} / gm`, color }]}
            />
          )
        }}
      />
      <Area
        type="monotone"
        dataKey="rate"
        stroke="none"
        fill="url(#silver-rate-fill)"
        isAnimationActive={false}
      />
      <Line
        type="monotone"
        dataKey="rate"
        stroke={color}
        strokeWidth={2}
        dot={renderDot}
        activeDot={{ r: 4, fill: color, stroke: '#fff', strokeWidth: 2 }}
      />
    </ComposedChart>
  )

  return (
    <div
      className="relative w-full"
      style={fixedSize ? { width: fixedSize.width, height: fixedSize.height } : { height: 200 }}
    >
      {fixedSize ? chart : <ResponsiveContainer width="100%" height="100%">{chart}</ResponsiveContainer>}
    </div>
  )
}
