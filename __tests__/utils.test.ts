import { normalizeEndDate } from '@/lib/utils'

describe('normalizeEndDate', () => {
  it('should append 23:59:59 to date-only string', () => {
    expect(normalizeEndDate('2026-03-20')).toBe('2026-03-20 23:59:59')
  })

  it('should not modify datetime string', () => {
    expect(normalizeEndDate('2026-03-20 15:30:00')).toBe('2026-03-20 15:30:00')
  })

  it('should not modify ISO datetime', () => {
    expect(normalizeEndDate('2026-03-20T15:30:00Z')).toBe('2026-03-20T15:30:00Z')
  })

  it('should handle empty string', () => {
    expect(normalizeEndDate('')).toBe('')
  })
})
