/**
 * period.ts のユニットテスト。
 * 「日付未指定時に全履歴を集計しながら periodDays=7 を返す」旧不一致の再発を防ぐ:
 * どの入力でも startDate/endDate が確定し、days がその両端から算出されることを固定する。
 */

import { resolvePeriod } from './period'

const NOW = new Date('2026-07-14T10:00:00Z')

describe('resolvePeriod', () => {
  it('両方未指定 → 今日までの 7 日間ウィンドウ', () => {
    const p = resolvePeriod(undefined, undefined, NOW)
    expect(p.endDate).toBe('2026-07-14')
    expect(p.startDate).toBe('2026-07-08')
    expect(p.days).toBe(7)
  })

  it('両方指定 → そのまま、days は両端含む', () => {
    const p = resolvePeriod('2026-07-01', '2026-07-14', NOW)
    expect(p.startDate).toBe('2026-07-01')
    expect(p.endDate).toBe('2026-07-14')
    expect(p.days).toBe(14)
  })

  it('start のみ → end は今日', () => {
    const p = resolvePeriod('2026-07-10', undefined, NOW)
    expect(p.startDate).toBe('2026-07-10')
    expect(p.endDate).toBe('2026-07-14')
    expect(p.days).toBe(5)
  })

  it('end のみ → 7 日間ウィンドウ (end-6日 〜 end)', () => {
    const p = resolvePeriod(undefined, '2026-06-30', NOW)
    expect(p.startDate).toBe('2026-06-24')
    expect(p.endDate).toBe('2026-06-30')
    expect(p.days).toBe(7)
  })

  it('同日指定は 1 日', () => {
    const p = resolvePeriod('2026-07-14', '2026-07-14', NOW)
    expect(p.days).toBe(1)
  })

  it('逆転 (end < start) でも days は 1 未満にならない', () => {
    const p = resolvePeriod('2026-07-14', '2026-07-01', NOW)
    expect(p.days).toBe(1)
  })

  it('期間上限 365 日: 超過時は start を切り詰め、days は切り詰め後を返す', () => {
    const p = resolvePeriod('2000-01-01', '2026-07-14', NOW)
    expect(p.days).toBe(365)
    expect(p.endDate).toBe('2026-07-14')
    expect(p.startDate).toBe('2025-07-15') // end-364日 (両端含み365日)
  })
})
