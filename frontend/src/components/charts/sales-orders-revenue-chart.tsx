import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { SalesOverviewPoint } from '@/types'
import { formatCurrency, formatNumber } from '@/lib/format'
import { rupeeTick, useChartTheme } from './chart-theme'
import { ChartTooltipBox } from './chart-tooltip'

const ORDERS_COLOR = '#7C5CE6'
const REVENUE_COLOR = '#2FBF71'

/**
 * Sales Overview: orders as violet columns on the left axis, revenue as a green
 * line on the right axis. The series passed in are already filtered to the
 * selected platform, so the chart, tooltip and summary cards always agree.
 */
export function SalesOrdersRevenueChart({ data }: { data: SalesOverviewPoint[] }) {
  const theme = useChartTheme()

  return (
    <div className="w-full">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm" style={{ background: ORDERS_COLOR }} />
          Orders
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full" style={{ background: REVENUE_COLOR }} />
          Revenue
        </span>
      </div>
      <div className="h-[300px] w-full sm:h-[340px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fill: theme.axis, fontSize: 11 }}
              tickMargin={8}
              minTickGap={18}
            />
            <YAxis
              yAxisId="orders"
              orientation="left"
              width={34}
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              tick={{ fill: theme.axis, fontSize: 11 }}
            />
            <YAxis
              yAxisId="revenue"
              orientation="right"
              width={62}
              tickLine={false}
              axisLine={false}
              tick={{ fill: theme.axis, fontSize: 11 }}
              tickFormatter={(value: number) => rupeeTick(value)}
            />
            <Tooltip
              cursor={{ fill: 'rgba(124, 92, 230, 0.08)' }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null
                const point = payload[0].payload as SalesOverviewPoint
                const date = String(point.date ?? '')
                return (
                  <ChartTooltipBox
                    title={date && date !== String(label) ? `${String(label)} · ${date}` : String(label)}
                    rows={[
                      { label: 'Orders', value: formatNumber(point.orders), color: ORDERS_COLOR },
                      { label: 'Revenue', value: formatCurrency(point.revenue, { decimals: true }), color: REVENUE_COLOR },
                    ]}
                  />
                )
              }}
            />
            <Bar
              yAxisId="orders"
              dataKey="orders"
              name="Orders"
              fill={ORDERS_COLOR}
              fillOpacity={0.85}
              radius={[4, 4, 0, 0]}
              maxBarSize={26}
            />
            <Line
              yAxisId="revenue"
              type="monotone"
              dataKey="revenue"
              name="Revenue"
              stroke={REVENUE_COLOR}
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 4, fill: REVENUE_COLOR, strokeWidth: 2, stroke: '#fff' }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
