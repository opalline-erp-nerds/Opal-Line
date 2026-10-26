export function formatPreviousSilverRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `₹${value.toFixed(2)}/g`
}
