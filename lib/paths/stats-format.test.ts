import {
  PATHS_UNANALYZED_VALUE,
  formatPathCount,
  formatPathPercent,
  rollupBranchSeverity,
} from './stats-format'

describe('paths stats formatting', () => {
  it('formats non-negative integer counts for the canvas', () => {
    expect(formatPathCount(7_128)).toBe('7,128')
    expect(formatPathCount(0)).toBe('0')
    expect(formatPathCount(null)).toBe(PATHS_UNANALYZED_VALUE)
    expect(formatPathCount(-1)).toBe(PATHS_UNANALYZED_VALUE)
  })

  it('formats bounded rates without fabricating invalid percentages', () => {
    expect(formatPathPercent(0.88)).toBe('88%')
    expect(formatPathPercent(0.061, 1)).toBe('6.1%')
    expect(formatPathPercent(null)).toBe(PATHS_UNANALYZED_VALUE)
    expect(formatPathPercent(1.1)).toBe(PATHS_UNANALYZED_VALUE)
  })

  it('rolls up the worst observed drop into a branch severity', () => {
    expect(rollupBranchSeverity([])).toBe('ok')
    expect(rollupBranchSeverity([0.12, 0.49])).toBe('ok')
    expect(rollupBranchSeverity([0.5])).toBe('warn')
    expect(rollupBranchSeverity([0.8, 0.4])).toBe('crit')
  })
})
