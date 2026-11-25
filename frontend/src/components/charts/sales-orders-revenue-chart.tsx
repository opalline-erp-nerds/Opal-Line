import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { SalesOverviewPoint } from '@/types'
import { formatCurrency, formatNumber } from '@/lib/format'
import { EXPENSE, INCOME, rupeeTick, useChartTheme } from './chart-theme'
import { ChartTooltipBox } from './chart-tooltip'

const ORDERS_COLOR = EXPENSE
const REVENUE_COLOR = INCOME

/**
 * Sales Overview: orders as pale mint columns on the left axis, revenue as a
 * teal gradient area on the right axis. The series passed in are already
 * filtered to the selected platform, so the chart, tooltip and summary cards
 * always agree.
 */
export function SalesOrdersRevenueChart({ data }: { data: SalesOverviewPoint[] }) {
  const theme = useChartTheme()

  return (
    <div className="w-full">
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: ORDERS_COLOR }} />
          Orders
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: REVENUE_COLOR }} />
          Revenue
        </span>
      </div>
      <div className="h-[290px] w-full sm:h-[320px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="salesRevenueFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={REVENUE_COLOR} stopOpacity={0.28} />
                <stop offset="70%" stopColor={REVENUE_COLOR} stopOpacity={0.06} />
                <stop offset="100%" stopColor={REVENUE_COLOR} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="2 6" stroke={theme.grid} vertical={false} />
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
              cursor={{ fill: 'rgba(0, 143, 120, 0.06)' }}
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
              fillOpacity={0.4}
              radius={[6, 6, 0, 0]}
              maxBarSize={20}
            />
            <Area
              yAxisId="revenue"
              type="monotone"
              dataKey="revenue"
              name="Revenue"
              stroke={REVENUE_COLOR}
              strokeWidth={2.5}
              fill="url(#salesRevenueFill)"
              dot={false}
              activeDot={{ r: 4, fill: REVENUE_COLOR, strokeWidth: 2, stroke: '#fff' }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
