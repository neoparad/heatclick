import type { BranchSeverity } from './types'

export const PATHS_UNANALYZED_VALUE = '—'

const WARNING_DROP_RATE = 0.5
const CRITICAL_DROP_RATE = 0.8

export function formatPathCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return PATHS_UNANALYZED_VALUE
  }
  return new Intl.NumberFormat('en-US').format(value)
}

export function formatPathPercent(
  value: number | null | undefined,
  fractionDigits = 0,
): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0 || value > 1) {
    return PATHS_UNANALYZED_VALUE
  }

  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

export function rollupBranchSeverity(dropRates: ReadonlyArray<number>): BranchSeverity {
  const worstDropRate = Math.max(0, ...dropRates.filter((rate) => Number.isFinite(rate)))
  if (worstDropRate >= CRITICAL_DROP_RATE) return 'crit'
  if (worstDropRate >= WARNING_DROP_RATE) return 'warn'
  return 'ok'
}

export function edgeBandForDropRate(dropRate: number): 'warn' | 'crit' | undefined {
  if (dropRate >= CRITICAL_DROP_RATE) return 'crit'
  if (dropRate >= WARNING_DROP_RATE) return 'warn'
  return undefined
}
