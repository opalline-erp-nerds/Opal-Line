import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { StockRunningProduct } from '@/pages/StockRunning'
import { ChartTooltipBox } from './chart-tooltip'
import { INCOME } from './chart-theme'

const DEMAND_COLORS: Record<StockRunningProduct['demandLevel'], string> = {
  high: '#16a34a',
  medium: '#f59e0b',
  low: '#71717a',
  none: '#cbd5e1',
}

const DEMAND_LABELS: Record<StockRunningProduct['demandLevel'], string> = {
  high: 'High Demand',
  medium: 'Medium Demand',
  low: 'Low Demand',
  none: 'No Sales',
}

export function StockDemandBarChart({ products }: { products: StockRunningProduct[] }) {
  const data = [...products]
    .sort((a, b) => b.avgDailySales - a.avgDailySales)
    .slice(0, 10)
    .map((p) => ({
      name: p.name.length > 16 ? `${p.name.slice(0, 15)}…` : p.name,
      avgDailySales: p.avgDailySales,
      stock: p.currentStock,
      days: p.daysOfStock,
    }))

  return (
    <div className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
          <XAxis
            type="number"
            tickLine={false}
            axisLine={false}
            tick={{ fill: '#71717a', fontSize: 11 }}
            tickFormatter={(v: number) => `${v}/d`}
          />
          <YAxis
            type="category"
            dataKey="name"
            tickLine={false}
            axisLine={false}
            width={120}
            tick={{ fill: '#52525b', fontSize: 11 }}
          />
          <Tooltip
            cursor={{ fill: 'rgba(0,143,120,0.06)' }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload as (typeof data)[number]
              return (
                <ChartTooltipBox
                  title={p.name}
                  rows={[
                    { label: 'Avg Daily Sales', value: `${p.avgDailySales}/day`, color: INCOME },
                    { label: 'Current Stock', value: p.stock, color: '#71717a' },
                    { label: 'Days of Stock', value: p.days >= 999 ? '—' : `${p.days}d`, color: '#16a34a' },
                  ]}
                />
              )
            }}
          />
          <Bar dataKey="avgDailySales" fill={INCOME} radius={[0, 4, 4, 0]} barSize={14} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export function StockDemandDonut({ products }: { products: StockRunningProduct[] }) {
  const counts: Record<StockRunningProduct['demandLevel'], number> = {
    high: 0,
    medium: 0,
    low: 0,
    none: 0,
  }
  for (const p of products) counts[p.demandLevel] += 1

  const data = (Object.keys(counts) as StockRunningProduct['demandLevel'][]).map((level) => ({
    level,
    name: DEMAND_LABELS[level],
    value: counts[level],
  }))

  return (
    <div className="flex items-center gap-4">
      <div className="h-[200px] w-[200px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={56}
              outerRadius={88}
              paddingAngle={2}
              stroke="none"
            >
              {data.map((d) => (
                <Cell key={d.level} fill={DEMAND_COLORS[d.level]} />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const p = payload[0].payload as (typeof data)[number]
                return (
                  <ChartTooltipBox
                    title={p.name}
                    rows={[{ label: 'Products', value: p.value, color: DEMAND_COLORS[p.level] }]}
                  />
                )
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="flex-1 space-y-2">
        {data.map((d) => (
          <div key={d.level} className="flex items-center gap-2 text-[12px]">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: DEMAND_COLORS[d.level] }} />
            <span className="text-muted-foreground">{d.name}</span>
            <span className="ml-auto font-semibold tabular-nums text-foreground">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
