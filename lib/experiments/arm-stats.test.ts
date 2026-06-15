import {
  metricEventType,
  metricNumeratorScope,
  aggregateByArm,
  computeArmEffect,
  buildArmStatsResult,
  type PerVisitorRow,
} from '@/lib/experiments/arm-stats'
import type { Arm } from '@/lib/experiments/assignment'

// 決定論的 armOf: visitor_id 先頭で振り分け (テスト用、computeArm の代わり)
const armByPrefix = (vid: string): Arm => (vid.startsWith('c') ? 'control' : 'treatment')

describe('experiments/arm-stats — metricEventType / numeratorScope', () => {
  it('metric → events.event_type', () => {
    expect(metricEventType('cvr')).toBe('conversion')
    expect(metricEventType('cta_click_rate')).toBe('click')
    expect(metricEventType('form_submit_rate')).toBe('conversion')
  })
  it('numerator scope: cvr/form は cross_page、cta_click は page_local (Codex M3)', () => {
    expect(metricNumeratorScope('cvr')).toBe('cross_page')
    expect(metricNumeratorScope('form_submit_rate')).toBe('cross_page')
    expect(metricNumeratorScope('cta_click_rate')).toBe('page_local')
  })
})

describe('experiments/arm-stats — aggregateByArm', () => {
  it('arm 別に sessions/conversions を畳む (1 visitor の全 session は同 arm)', () => {
    const rows: PerVisitorRow[] = [
      { visitor_id: 'c1', sessions: 3, conversions: 1 },
      { visitor_id: 'c2', sessions: 2, conversions: 0 },
      { visitor_id: 't1', sessions: 5, conversions: 2 },
      { visitor_id: 't2', sessions: 1, conversions: 1 },
    ]
    const out = aggregateByArm(rows, armByPrefix)
    expect(out.control).toEqual({ sessions_n: 5, conversions: 1 })
    expect(out.treatment).toEqual({ sessions_n: 6, conversions: 3 })
  })

  it('空 rows → 全 0', () => {
    const out = aggregateByArm([], armByPrefix)
    expect(out.control).toEqual({ sessions_n: 0, conversions: 0 })
    expect(out.treatment).toEqual({ sessions_n: 0, conversions: 0 })
  })
})

describe('experiments/arm-stats — computeArmEffect (δ法、sim_pooling_power.py と同一式)', () => {
  it('既知の 2% vs 3% で logRR=ln(1.5)・分散一致', () => {
    const e = computeArmEffect({ sessions_n: 1000, conversions: 20 }, { sessions_n: 1000, conversions: 30 })
    expect(e).not.toBeNull()
    expect(e!.log_rr).toBeCloseTo(Math.log(0.03 / 0.02), 6) // ln(1.5) ≈ 0.405465
    // var = (1-0.03)/30 + (1-0.02)/20 = 0.0323333 + 0.049 = 0.0813333
    expect(e!.variance).toBeCloseTo(0.0813333, 5)
    expect(e!.se).toBeCloseTo(Math.sqrt(0.0813333), 5)
  })

  it('ゼロセルは連続性補正で finite (NaN/Inf を出さない)', () => {
    const e = computeArmEffect({ sessions_n: 1000, conversions: 0 }, { sessions_n: 1000, conversions: 10 })
    expect(e).not.toBeNull()
    expect(Number.isFinite(e!.log_rr)).toBe(true)
    expect(Number.isFinite(e!.variance)).toBe(true)
    expect(e!.log_rr).toBeGreaterThan(0) // control x=0→0.5補正 → pc=0.0005 < pt=0.01
  })

  it('どちらかの arm が 0 session → null', () => {
    expect(computeArmEffect({ sessions_n: 0, conversions: 0 }, { sessions_n: 100, conversions: 5 })).toBeNull()
    expect(computeArmEffect({ sessions_n: 100, conversions: 5 }, { sessions_n: 0, conversions: 0 })).toBeNull()
  })
})

describe('experiments/arm-stats — buildArmStatsResult', () => {
  it('per-visitor rows → arm 別結果 + 効果量', () => {
    const rows: PerVisitorRow[] = [
      { visitor_id: 'c1', sessions: 100, conversions: 2 },
      { visitor_id: 't1', sessions: 100, conversions: 3 },
    ]
    const r = buildArmStatsResult('exp-1', 'cvr', rows, armByPrefix)
    expect(r.experiment_id).toBe('exp-1')
    expect(r.primary_metric).toBe('cvr')
    expect(r.control).toEqual({ sessions_n: 100, conversions: 2, cvr: 0.02 })
    expect(r.treatment).toEqual({ sessions_n: 100, conversions: 3, cvr: 0.03 })
    expect(r.total_sessions).toBe(200)
    expect(r.data_unavailable).toBe(false)
    expect(r.effect).not.toBeNull()
    expect(r.effect!.log_rr).toBeCloseTo(Math.log(0.03 / 0.02), 6)
  })

  it('片 arm のみデータ → effect null だが集計は返る', () => {
    const rows: PerVisitorRow[] = [{ visitor_id: 'c1', sessions: 100, conversions: 2 }]
    const r = buildArmStatsResult('exp-2', 'cvr', rows, armByPrefix)
    expect(r.control.sessions_n).toBe(100)
    expect(r.treatment.sessions_n).toBe(0)
    expect(r.effect).toBeNull()
  })
})
