import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { DashboardSeriesPoint, OrderSummaryPoint } from '@/types'
import { compactCurrency, formatNumber } from '@/lib/format'
import { ChartTooltipBox } from './chart-tooltip'
import { SERIES_COLORS, useChartTheme } from './chart-theme'

/** Online vs in-store orders for the Order Summary card. */
export function OrderSummaryBarChart({ data }: { data: OrderSummaryPoint[] }) {
  const theme = useChartTheme()
  return (
    <div className="h-[220px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} barGap={4} margin={{ top: 8, right: 4, left: -14, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={theme.grid} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fill: theme.axis }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={44}
            tick={{ fontSize: 10, fill: theme.axis }}
            tickFormatter={(value) => compactCurrency(Number(value))}
          />
          <Tooltip
            cursor={{ fill: 'rgba(124, 92, 230, 0.06)' }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const point = payload[0].payload as OrderSummaryPoint
              return (
                <ChartTooltipBox
                  title={String(label ?? point.label)}
                  rows={[
                    { label: 'Online', value: `${formatNumber(point.online)} orders`, color: SERIES_COLORS[1] },
                    { label: 'In-store', value: `${formatNumber(point.inStore)} orders`, color: SERIES_COLORS[3] },
                    { label: 'Revenue', value: compactCurrency(point.revenue) },
                  ]}
                />
              )
            }}
          />
          <Bar dataKey="online" name="Online" fill={SERIES_COLORS[1]} radius={[4, 4, 0, 0]} maxBarSize={18} />
          <Bar dataKey="inStore" name="In-store" fill={SERIES_COLORS[3]} radius={[4, 4, 0, 0]} maxBarSize={18} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Single-series daily bars used by the payments/collections/invoice cards. */
export function WidgetBarChart({
  data,
  color = SERIES_COLORS[0],
  height = 84,
  tooltipLabel = 'Value',
}: {
  data: DashboardSeriesPoint[]
  color?: string
  height?: number
  tooltipLabel?: string
}) {
  const theme = useChartTheme()
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }} barCategoryGap={2}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={theme.grid} />
          <XAxis dataKey="label" hide />
          <YAxis hide domain={[0, 'auto']} />
          <Tooltip
            cursor={{ fill: 'rgba(124, 92, 230, 0.06)' }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const point = payload[0].payload as DashboardSeriesPoint
              return (
                <ChartTooltipBox
                  title={point.label}
                  rows={[{ label: tooltipLabel, value: compactCurrency(point.value), color }]}
                />
              )
            }}
          />
          <Bar dataKey="value" fill={color} radius={[3, 3, 0, 0]} maxBarSize={16} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export interface DonutSlice {
  name: string
  value: number
  color: string
}

/** Reusable status donut with a centred total. */
export function StatusDonutChart({
  data,
  centerLabel,
  centerValue,
  height = 170,
}: {
  data: DonutSlice[]
  centerLabel: string
  centerValue: string
  height?: number
}) {
  return (
    <div className="relative w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const slice = payload[0].payload as DonutSlice
              return (
                <ChartTooltipBox
                  title={slice.name}
                  rows={[{ label: centerLabel, value: compactCurrency(slice.value), color: slice.color }]}
                />
              )
            }}
          />
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={52}
            outerRadius={74}
            paddingAngle={3}
            cornerRadius={4}
            strokeWidth={0}
          >
            {data.map((slice) => (
              <Cell key={slice.name} fill={slice.color} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{centerLabel}</p>
        <p className="text-base font-bold tabular-nums text-foreground">{centerValue}</p>
      </div>
    </div>
  )
}
