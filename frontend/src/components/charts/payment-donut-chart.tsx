import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import type { PaymentStatusSegment } from '@/types'
import { compactCurrency } from '@/lib/format'
import { ChartTooltipBox } from './chart-tooltip'
import { PAYMENT_STATUS_COLORS } from './chart-theme'

export function PaymentDonutChart({
  data,
  centerTotal,
  height = 210,
}: {
  data: PaymentStatusSegment[]
  centerTotal: number
  height?: number
}) {
  return (
    <div className="relative w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload as PaymentStatusSegment
              return (
                <ChartTooltipBox
                  title={p.label}
                  rows={[{ label: 'Value', value: compactCurrency(p.value), color: PAYMENT_STATUS_COLORS[p.status] }]}
                />
              )
            }}
          />
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            innerRadius={68}
            outerRadius={94}
            paddingAngle={3}
            cornerRadius={4}
            strokeWidth={0}
          >
            {data.map((entry) => (
              <Cell key={entry.status} fill={PAYMENT_STATUS_COLORS[entry.status]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Total</p>
        <p className="text-lg font-bold tabular-nums text-foreground">{compactCurrency(centerTotal)}</p>
      </div>
    </div>
  )
}
