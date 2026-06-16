import type { ArmStatsResult } from '@/lib/experiments/arm-stats'
import { evaluatePowerGate } from '@/lib/experiments/power-gate'
import {
  buildExperimentResultView,
  observedNumbersVisible,
} from '@/lib/experiments/result-view-model'
import type { Experiment } from '@/lib/experiments/types'

const EXPERIMENT = {
  id: '00000000-0000-4000-8000-000000000001',
  tenant_id: 'tnt_a',
  site_id: 'CIP_a',
  name: 'mobile CTA placement',
  url_pattern: '/products',
  taxonomy: {
    intervention_type: 'cta_placement',
    page_type: 'product',
    industry: 'd2c_ec',
    device: 'mobile',
    primary_metric: 'cvr',
    window: '28d',
  },
  status: 'running',
  dates: { start_at: '2026-06-10T00:00:00.000Z', end_at: '2026-07-08T00:00:00.000Z' },
  salt_version: 1,
  consent: { pool_opt_in: true, k_anonymity_min: 50 },
  created_at: '2026-06-10T00:00:00.000Z',
  updated_at: '2026-06-10T00:00:00.000Z',
  created_by: 'owner@x',
  locked_at: '2026-06-10T00:00:00.000Z',
  stopped_at: null,
  archived_at: null,
} as Experiment

function stats(controlN: number, treatmentN: number): ArmStatsResult {
  return {
    experiment_id: EXPERIMENT.id,
    primary_metric: 'cvr',
    control: { sessions_n: controlN, conversions: Math.round(controlN * 0.02), cvr: 0.02 },
    treatment: { sessions_n: treatmentN, conversions: Math.round(treatmentN * 0.03), cvr: 0.03 },
    effect: { log_rr: 0.405, variance: 0.08, se: 0.283 },
    total_sessions: controlN + treatmentN,
    data_unavailable: false,
  }
}

function verdictFor(s: ArmStatsResult, pool: Parameters<typeof evaluatePowerGate>[0]['pool'] = null) {
  return evaluatePowerGate({
    control_sessions: s.control.sessions_n,
    treatment_sessions: s.treatment.sessions_n,
    pool,
  })
}

describe('experiments/result-view-model — D-07 サーバー側 redaction', () => {
  it('session 不足 (insufficient) → conversions/cvr は null、sessions_n は出す', () => {
    const s = stats(500, 500)
    const view = buildExperimentResultView(EXPERIMENT, s, verdictFor(s))
    expect(view.observed_numbers_visible).toBe(false)
    expect(view.arms.control.sessions_n).toBe(500)
    expect(view.arms.control.conversions).toBeNull()
    expect(view.arms.control.cvr).toBeNull()
    expect(view.arms.treatment.cvr).toBeNull()
    expect(view.verdict.headline).toContain('未確定')
  })

  it('session 充足 (observed) → 観測値を返す', () => {
    const s = stats(3000, 3000)
    const view = buildExperimentResultView(EXPERIMENT, s, verdictFor(s))
    expect(view.observed_numbers_visible).toBe(true)
    expect(view.arms.control.conversions).toBe(60)
    expect(view.arms.control.cvr).toBeCloseTo(0.02)
    expect(view.arms.treatment.cvr).toBeCloseTo(0.03)
  })

  it('pool_supported (inferred) でも自サイト充足なら観測値は出す (描写は D-07 違反でない)', () => {
    const s = stats(3000, 3000)
    const pool = { k_sites: 60, ci_low: 0.05, ci_high: 0.3, meets_k50: true }
    const view = buildExperimentResultView(EXPERIMENT, s, verdictFor(s, pool))
    expect(view.verdict.state).toBe('pool_supported')
    expect(view.observed_numbers_visible).toBe(true)
    expect(view.arms.control.cvr).not.toBeNull()
  })

  it('pool_supported でも自サイト不足なら観測値は null (プール傾向のみ)', () => {
    const s = stats(100, 100)
    const pool = { k_sites: 60, ci_low: 0.05, ci_high: 0.3, meets_k50: true }
    const view = buildExperimentResultView(EXPERIMENT, s, verdictFor(s, pool))
    expect(view.verdict.state).toBe('pool_supported')
    expect(view.observed_numbers_visible).toBe(false)
    expect(view.arms.control.cvr).toBeNull()
  })

  it('effect (logRR/SE) は応答に決して含めない', () => {
    const s = stats(3000, 3000)
    const view = buildExperimentResultView(EXPERIMENT, s, verdictFor(s))
    expect(JSON.stringify(view)).not.toContain('log_rr')
    expect(JSON.stringify(view)).not.toContain('variance')
    expect((view as unknown as Record<string, unknown>).effect).toBeUndefined()
  })

  it('experiment は安全な subset のみ (salt_version / created_by / consent を出さない)', () => {
    const s = stats(3000, 3000)
    const view = buildExperimentResultView(EXPERIMENT, s, verdictFor(s))
    const exp = view.experiment as unknown as Record<string, unknown>
    expect(exp.id).toBe(EXPERIMENT.id)
    expect(exp.salt_version).toBeUndefined()
    expect(exp.created_by).toBeUndefined()
    expect(exp.consent).toBeUndefined()
  })

  it('data_unavailable のとき観測値は強制 null、内部 reason は安定コードへ正規化', () => {
    const s = {
      ...stats(3000, 3000),
      data_unavailable: true,
      data_unavailable_reason: 'clickinsight.events not available (migration 未適用)', // 内部詳細
    }
    const view = buildExperimentResultView(EXPERIMENT, s, verdictFor(s))
    expect(view.observed_numbers_visible).toBe(false)
    expect(view.arms.control.cvr).toBeNull()
    // 内部の運用詳細を顧客へ漏らさない (Codex M4b MEDIUM)
    expect(view.data_unavailable_reason).toBe('measurement_data_unavailable')
    expect(JSON.stringify(view)).not.toContain('migration')
  })
})

describe('experiments/result-view-model — observedNumbersVisible', () => {
  it('min/threshold 基準 (state ではなく)', () => {
    const s = stats(2000, 5000)
    expect(observedNumbersVisible(verdictFor(s))).toBe(true)
    const s2 = stats(1999, 5000)
    expect(observedNumbersVisible(verdictFor(s2))).toBe(false)
  })
})
