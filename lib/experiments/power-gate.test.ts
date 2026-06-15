import {
  evaluatePowerGate,
  powerGateFromArmStats,
  allowsObservedNumbers,
  allowsProjectedNumbers,
  SINGLE_SITE_MIN_ARM_SESSIONS,
  POOL_MIN_K,
  type PoolCellSummary,
} from '@/lib/experiments/power-gate'
import type { ArmStatsResult } from '@/lib/experiments/arm-stats'

function pool(over: Partial<PoolCellSummary> = {}): PoolCellSummary {
  return { k_sites: 30, ci_low: 0.05, ci_high: 0.4, meets_k50: false, ...over }
}

describe('experiments/power-gate — insufficient (未確定)', () => {
  it('min arm < 2000・pool なし → insufficient / planned / 未確定', () => {
    const v = evaluatePowerGate({ control_sessions: 1500, treatment_sessions: 1800, pool: null })
    expect(v.state).toBe('insufficient')
    expect(v.evidence_level).toBe('planned')
    expect(v.direction).toBe('none')
    expect(v.headline).toContain('未確定')
    expect(v.min_arm_sessions).toBe(1500)
    expect(v.threshold).toBe(SINGLE_SITE_MIN_ARM_SESSIONS)
  })

  it('片 arm だけ多くても min が閾値未満なら insufficient', () => {
    const v = evaluatePowerGate({ control_sessions: 5000, treatment_sessions: 1000, pool: null })
    expect(v.state).toBe('insufficient')
    expect(v.min_arm_sessions).toBe(1000)
  })
})

describe('experiments/power-gate — observed_single_site', () => {
  it('min arm >= 2000・pool なし → observed / observed', () => {
    const v = evaluatePowerGate({ control_sessions: 2000, treatment_sessions: 3000, pool: null })
    expect(v.state).toBe('observed_single_site')
    expect(v.evidence_level).toBe('observed')
  })

  it('閾値ちょうど 2000 は observed (>=)、1999 は insufficient', () => {
    expect(
      evaluatePowerGate({ control_sessions: 2000, treatment_sessions: 2000, pool: null }).state,
    ).toBe('observed_single_site')
    expect(
      evaluatePowerGate({ control_sessions: 1999, treatment_sessions: 9999, pool: null }).state,
    ).toBe('insufficient')
  })
})

describe('experiments/power-gate — pool_supported', () => {
  it('K>=24 かつ CI下限>0 → pool_supported / inferred / positive (session 数に依らない)', () => {
    const v = evaluatePowerGate({
      control_sessions: 10,
      treatment_sessions: 10,
      pool: pool({ k_sites: 24, ci_low: 0.05 }),
    })
    expect(v.state).toBe('pool_supported')
    expect(v.evidence_level).toBe('inferred')
    expect(v.direction).toBe('positive')
    expect(v.headline).toContain('効く傾向')
  })

  it('K>=24 かつ CI上限<0 → pool_supported / negative (逆効果)', () => {
    const v = evaluatePowerGate({
      control_sessions: 5000,
      treatment_sessions: 5000,
      pool: pool({ k_sites: 30, ci_low: -0.4, ci_high: -0.05 }),
    })
    expect(v.state).toBe('pool_supported')
    expect(v.direction).toBe('negative')
    expect(v.headline).toContain('逆効果')
  })

  it('K>=24 でも CI が 0 をまたぐ → 単一サイト段階にフォールバック', () => {
    const v = evaluatePowerGate({
      control_sessions: 3000,
      treatment_sessions: 3000,
      pool: pool({ k_sites: 30, ci_low: -0.1, ci_high: 0.2 }),
    })
    expect(v.state).toBe('observed_single_site')
  })

  it('K<24 は pool_supported にならない (session 不足なら insufficient)', () => {
    const v = evaluatePowerGate({
      control_sessions: 100,
      treatment_sessions: 100,
      pool: pool({ k_sites: 23, ci_low: 0.1 }),
    })
    expect(v.state).toBe('insufficient')
  })

  it('K=POOL_MIN_K 境界で pool_supported', () => {
    expect(POOL_MIN_K).toBe(24)
    const v = evaluatePowerGate({
      control_sessions: 1,
      treatment_sessions: 1,
      pool: pool({ k_sites: 24, ci_low: 0.01 }),
    })
    expect(v.state).toBe('pool_supported')
  })
})

describe('experiments/power-gate — number gating (D-07)', () => {
  it('allowsObservedNumbers: observed/proven → true、inferred/planned → false', () => {
    expect(allowsObservedNumbers('proven')).toBe(true)
    expect(allowsObservedNumbers('observed')).toBe(true)
    expect(allowsObservedNumbers('inferred')).toBe(false)
    expect(allowsObservedNumbers('planned')).toBe(false)
  })
  it('allowsProjectedNumbers: proven のみ true (推定 CV/月 等の断定投影)', () => {
    expect(allowsProjectedNumbers('proven')).toBe(true)
    expect(allowsProjectedNumbers('observed')).toBe(false)
    expect(allowsProjectedNumbers('inferred')).toBe(false)
    expect(allowsProjectedNumbers('planned')).toBe(false)
  })
})

describe('experiments/power-gate — fail-closed (Codex HIGH)', () => {
  it('反転 CI 区間 (ci_low>ci_high) は verdict にせず pool を無視', () => {
    const v = evaluatePowerGate({
      control_sessions: 5000,
      treatment_sessions: 5000,
      pool: { k_sites: 24, ci_low: 0.1, ci_high: -0.1, meets_k50: false },
    })
    expect(v.state).not.toBe('pool_supported')
    expect(v.pool).toBeNull()
  })

  it('NaN / Infinity の CI は verdict にしない', () => {
    expect(
      evaluatePowerGate({
        control_sessions: 5000,
        treatment_sessions: 5000,
        pool: { k_sites: 30, ci_low: NaN, ci_high: 1, meets_k50: false },
      }).state,
    ).not.toBe('pool_supported')
    expect(
      evaluatePowerGate({
        control_sessions: 5000,
        treatment_sessions: 5000,
        pool: { k_sites: 30, ci_low: 0.1, ci_high: Infinity, meets_k50: false },
      }).state,
    ).not.toBe('pool_supported')
  })

  it('非整数 / 負 の k_sites は verdict にしない', () => {
    expect(
      evaluatePowerGate({
        control_sessions: 1,
        treatment_sessions: 1,
        pool: { k_sites: 24.5, ci_low: 0.1, ci_high: 0.3, meets_k50: false },
      }).state,
    ).not.toBe('pool_supported')
  })

  it('session が NaN / 負 → 未確定 (fail-closed、min_arm=0)', () => {
    expect(evaluatePowerGate({ control_sessions: NaN, treatment_sessions: 9999, pool: null }).state).toBe(
      'insufficient',
    )
    expect(evaluatePowerGate({ control_sessions: -5, treatment_sessions: 9999, pool: null }).state).toBe(
      'insufficient',
    )
    expect(
      evaluatePowerGate({ control_sessions: NaN, treatment_sessions: 9999, pool: null }).min_arm_sessions,
    ).toBe(0)
  })
})

describe('experiments/power-gate — powerGateFromArmStats', () => {
  it('ArmStatsResult の sessions を使う', () => {
    const stats = {
      experiment_id: 'e1',
      primary_metric: 'cvr',
      control: { sessions_n: 1000, conversions: 20, cvr: 0.02 },
      treatment: { sessions_n: 1000, conversions: 30, cvr: 0.03 },
      effect: { log_rr: 0.4, variance: 0.08, se: 0.28 },
      total_sessions: 2000,
      data_unavailable: false,
    } as ArmStatsResult
    const v = powerGateFromArmStats(stats, null)
    expect(v.state).toBe('insufficient') // min 1000 < 2000
    expect(v.min_arm_sessions).toBe(1000)
  })
})
