import type { ReactNode } from 'react'
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
import type { ExpenseCategorySlice, FinancialAgingBand, FinancialPoint } from '@/types'
import { AGING_COLORS, DONUT_TRACK, EXPENSE, INCOME, LOSS, PROFIT, SLICE_COLORS, useChartTheme, inr, rupeeTick } from './chart-theme'
import { ChartTooltipBox } from './chart-tooltip'

/**
 * Chart primitives for the Financial Analytics section.
 *
 * Every chart accepts an optional `fixedSize`; when present the chart renders
 * itself at an explicit width/height instead of through recharts'
 * ResponsiveContainer. The donuts use it to sit at a stable 210px inside the
 * card's flex row; the bar charts let their container fill the card.
 */

type FixedSize = { width: number; height: number }

interface ChartShellProps {
  fixedSize?: FixedSize
  /** Height of the responsive wrapper when no fixed size is given. */
  height: number
  /** Shown centred over the (flat, zero-line) chart when every value is 0. */
  emptyMessage?: string
  children: ReactNode
}

function ChartShell({ fixedSize, height, emptyMessage, children }: ChartShellProps) {
  const body = fixedSize ? (
    children
  ) : (
    <ResponsiveContainer width="100%" height="100%">
      {children}
    </ResponsiveContainer>
  )
  return (
    <div className="relative w-full" style={fixedSize ? { width: fixedSize.width, height: fixedSize.height } : { height }}>
      {body}
      {emptyMessage ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-md bg-background/80 px-2 py-1 text-[11px] text-muted-foreground">{emptyMessage}</p>
        </div>
      ) : null}
    </div>
  )
}

/** Grouped income-vs-expense bars, one pair per bucket. */
export function IncomeExpenseChart({
  points,
  fixedSize,
  emptyMessage,
}: {
  points: FinancialPoint[]
  fixedSize?: FixedSize
  emptyMessage?: string
}) {
  const theme = useChartTheme()
  return (
    <ChartShell fixedSize={fixedSize} height={240} emptyMessage={emptyMessage}>
      <BarChart data={points} width={fixedSize?.width} height={fixedSize?.height} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tick={{ fill: theme.axis, fontSize: 11 }}
          dy={6}
          interval="preserveStartEnd"
          minTickGap={14}
        />
        <YAxis tickLine={false} axisLine={false} width={58} tick={{ fill: theme.axis, fontSize: 11 }} tickFormatter={rupeeTick} />
        <Tooltip
          cursor={{ fillOpacity: 0.06 }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null
            const p = payload[0].payload as FinancialPoint
            return (
              <ChartTooltipBox
                title={String(label)}
                rows={[
                  { label: 'Income', value: inr(p.income), color: INCOME },
                  { label: 'Expense', value: inr(p.expense), color: EXPENSE },
                ]}
              />
            )
          }}
        />
        <Bar dataKey="income" name="Income" fill={INCOME} radius={[8, 8, 0, 0]} maxBarSize={20} />
        <Bar dataKey="expense" name="Expense" fill={EXPENSE} radius={[8, 8, 0, 0]} maxBarSize={20} />
      </BarChart>
    </ChartShell>
  )
}

/** Net result per bucket (income − expense): green above zero, red below. */
export function NetProfitChart({
  points,
  fixedSize,
  emptyMessage,
}: {
  points: FinancialPoint[]
  fixedSize?: FixedSize
  emptyMessage?: string
}) {
  const theme = useChartTheme()
  const data = points.map((p) => ({ ...p, net: Math.round((p.income - p.expense) * 100) / 100 }))
  return (
    <ChartShell fixedSize={fixedSize} height={240} emptyMessage={emptyMessage}>
      <BarChart data={data} width={fixedSize?.width} height={fixedSize?.height} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tick={{ fill: theme.axis, fontSize: 11 }}
          dy={6}
          interval="preserveStartEnd"
          minTickGap={14}
        />
        <YAxis tickLine={false} axisLine={false} width={58} tick={{ fill: theme.axis, fontSize: 11 }} tickFormatter={rupeeTick} />
        <Tooltip
          cursor={{ fillOpacity: 0.06 }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null
            const p = payload[0].payload as FinancialPoint & { net: number }
            return (
              <ChartTooltipBox
                title={String(label)}
                rows={[
                  { label: 'Net', value: inr(p.net), color: p.net < 0 ? LOSS : PROFIT },
                  { label: 'Income', value: inr(p.income), color: INCOME },
                  { label: 'Expense', value: inr(p.expense), color: EXPENSE },
                ]}
              />
            )
          }}
        />
        <Bar dataKey="net" name="Net" maxBarSize={26}>
          {data.map((d) => (
            <Cell key={d.key} fill={d.net < 0 ? LOSS : PROFIT} />
          ))}
        </Bar>
      </BarChart>
    </ChartShell>
  )
}

/** Donut of the six receivable aging bands; centre shows the outstanding total. */
export function ReceivableAgingChart({
  aging,
  centerValue,
  centerLabel,
  fixedSize,
}: {
  aging: FinancialAgingBand[]
  centerValue: string
  centerLabel: string
  fixedSize?: FixedSize
}) {
  const data = aging.filter((b) => b.value > 0)
  const colorFor = (key: FinancialAgingBand['key']) => {
    const idx = aging.findIndex((a) => a.key === key)
    return AGING_COLORS[idx] ?? AGING_COLORS[AGING_COLORS.length - 1]
  }
  return (
    <ChartShell fixedSize={fixedSize} height={210}>
      <PieChart width={fixedSize?.width} height={fixedSize?.height}>
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null
            const p = payload[0].payload as FinancialAgingBand
            return (
              <ChartTooltipBox
                title={p.label}
                rows={[
                  { label: 'Outstanding', value: inr(p.value), color: colorFor(p.key) },
                  { label: 'Invoices', value: p.count, color: colorFor(p.key) },
                ]}
              />
            )
          }}
        />
        <Pie
          data={[{ label: 'track', key: 'track', value: 1, count: 0 }]}
          dataKey="value"
          nameKey="label"
          innerRadius={56}
          outerRadius={82}
          fill={DONUT_TRACK}
          strokeWidth={0}
          isAnimationActive={false}
        />
        <Pie
          data={data}
          dataKey="value"
          nameKey="label"
          innerRadius={56}
          outerRadius={82}
          paddingAngle={4}
          cornerRadius={8}
          strokeWidth={0}
        >
          {data.map((b) => (
            <Cell key={b.key} fill={colorFor(b.key)} />
          ))}
        </Pie>
      </PieChart>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{centerLabel}</p>
        <p className="text-lg font-bold tabular-nums text-foreground">{centerValue}</p>
      </div>
    </ChartShell>
  )
}

/** Donut of expense categories for the window; centre shows the total spent. */
export function ExpenseDonutChart({
  slices,
  centerValue,
  centerLabel,
  fixedSize,
}: {
  slices: ExpenseCategorySlice[]
  centerValue: string
  centerLabel: string
  fixedSize?: FixedSize
}) {
  const colorFor = (index: number) => SLICE_COLORS[index % SLICE_COLORS.length]
  return (
    <ChartShell fixedSize={fixedSize} height={210}>
      <PieChart width={fixedSize?.width} height={fixedSize?.height}>
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null
            const p = payload[0].payload as ExpenseCategorySlice
            const idx = slices.findIndex((s) => s.category === p.category)
            return (
              <ChartTooltipBox
                title={p.category}
                rows={[
                  { label: 'Amount', value: inr(p.amount), color: colorFor(idx < 0 ? 0 : idx) },
                  { label: 'Share', value: `${p.share}%`, color: colorFor(idx < 0 ? 0 : idx) },
                ]}
              />
            )
          }}
        />
        <Pie
          data={[{ category: 'track', amount: 1, share: 0 }]}
          dataKey="amount"
          nameKey="category"
          innerRadius={56}
          outerRadius={82}
          fill={DONUT_TRACK}
          strokeWidth={0}
          isAnimationActive={false}
        />
        <Pie
          data={slices}
          dataKey="amount"
          nameKey="category"
          innerRadius={56}
          outerRadius={82}
          paddingAngle={4}
          cornerRadius={8}
          strokeWidth={0}
        >
          {slices.map((s, i) => (
            <Cell key={s.category} fill={colorFor(i)} />
          ))}
        </Pie>
      </PieChart>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{centerLabel}</p>
        <p className="text-lg font-bold tabular-nums text-foreground">{centerValue}</p>
      </div>
    </ChartShell>
  )
}
