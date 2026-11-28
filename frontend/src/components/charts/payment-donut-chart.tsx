import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import type { PaymentStatusSegment } from '@/types'
import { compactCurrency } from '@/lib/format'
import { ChartTooltipBox } from './chart-tooltip'
import { DONUT_TRACK, PAYMENT_STATUS_COLORS } from './chart-theme'

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
          {/* Pale track: keeps the ring complete where the reference shows it. */}
          <Pie
            data={[{ value: 1 }]}
            dataKey="value"
            innerRadius={66}
            outerRadius={96}
            fill={DONUT_TRACK}
            strokeWidth={0}
            isAnimationActive={false}
          />
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            innerRadius={66}
            outerRadius={96}
            paddingAngle={4}
            cornerRadius={8}
            strokeWidth={0}
          >
            {data.map((entry) => (
              <Cell key={entry.status} fill={PAYMENT_STATUS_COLORS[entry.status]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <p className="text-[11px] font-medium text-muted-foreground">Total</p>
        <p className="text-[22px] font-bold tabular-nums tracking-tight text-foreground">{compactCurrency(centerTotal)}</p>
      </div>
    </div>
  )
}
