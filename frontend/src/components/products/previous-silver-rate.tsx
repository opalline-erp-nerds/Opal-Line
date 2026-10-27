import { useContext } from 'react'
import { SilverRateContext } from '@/lib/silver-rate-context'

export interface PreviousSilverRateProps {
  previousRate?: number | null
  value?: number | null
  rate?: number | null
}

export function PreviousSilverRate({ previousRate, value, rate }: PreviousSilverRateProps = {}) {
  const contextRate = useContext(SilverRateContext)?.rate ?? null

  const resolved =
    previousRate !== undefined
      ? previousRate
      : value !== undefined
        ? value
        : rate !== undefined
          ? rate
          : contextRate?.previousRate ?? null

  if (resolved == null || !Number.isFinite(resolved)) {
    return <span className="tabular-nums text-muted-foreground" title="Previous silver rate">—</span>
  }

  return (
    <span className="tabular-nums text-muted-foreground" title={`Previous silver rate: ₹${resolved.toFixed(2)}/g`}>
      ₹{resolved.toFixed(2)}/g
    </span>
  )
}

export default PreviousSilverRate
// oxlint-disable-next-line react/only-export-components
export { formatPreviousSilverRate } from '@/lib/previous-silver-rate'


