import type { ArmStatsResult } from '@/lib/experiments/arm-stats'
import {
  MIN_POOL_ARM_SESSIONS,
  POOL_PUBLISH_MIN_K,
  dedupePerSite,
  groupByCell,
  toSiteEffect,
  recomputePoolCells,
  type PoolCellUpsert,
  type PoolCellWriteStore,
} from '@/lib/experiments/pool-aggregate'
import type { PrimaryMetric } from '@/lib/experiments/taxonomy'
import type { Experiment } from '@/lib/experiments/types'

let seq = 0
function exp(over: Partial<Experiment> = {}): Experiment {
  seq += 1
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    tenant_id: over.tenant_id ?? `tnt_${seq}`,
    site_id: over.site_id ?? `CIP_${seq}`,
    name: 'x',
    url_pattern: '/products',
    taxonomy: {
      intervention_type: 'cta_placement',
      page_type: 'product',
      industry: 'd2c_ec',
      device: 'mobile',
      primary_metric: 'cvr',
      window: '28d',
      ...(over.taxonomy ?? {}),
    },
    status: 'running',
    dates: { start_at: '2026-06-01T00:00:00.000Z', end_at: '2026-06-29T00:00:00.000Z' },
    salt_version: 1,
    consent: { pool_opt_in: true, k_anonymity_min: 50 },
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    created_by: 'owner@x',
    locked_at: '2026-06-01T00:00:00.000Z',
    stopped_at: null,
    archived_at: null,
    ...over,
  } as Experiment
}

function statsFor(experiment: Experiment, controlCvr = 0.02, treatmentCvr = 0.03): ArmStatsResult {
  const n = 3000
  return {
    experiment_id: experiment.id,
    primary_metric: experiment.taxonomy.primary_metric,
    control: { sessions_n: n, conversions: Math.round(n * controlCvr), cvr: controlCvr },
    treatment: { sessions_n: n, conversions: Math.round(n * treatmentCvr), cvr: treatmentCvr },
    effect: null, // toSiteEffect は computeArmEffect を自前で呼ぶため未使用
    total_sessions: n * 2,
    data_unavailable: false,
  }
}

class MemoryCellStore implements PoolCellWriteStore {
  upserts: PoolCellUpsert[] = []
  removed: Array<{ key: string; metric: PrimaryMetric }> = []
  existing = new Set<string>()
  async upsert(row: PoolCellUpsert): Promise<void> {
    this.upserts.push(row)
    this.existing.add(`${row.cell_key}::${row.primary_metric}`)
  }
  async remove(key: string, metric: PrimaryMetric): Promise<boolean> {
    this.removed.push({ key, metric })
    return this.existing.delete(`${key}::${metric}`)
  }
}

describe('experiments/pool-aggregate — dedupePerSite', () => {
  it('同一 tenant|site は最新 start_at の 1 本に', () => {
    const a = exp({ tenant_id: 't1', site_id: 's1', dates: { start_at: '2026-05-01T00:00:00.000Z', end_at: '2026-05-29T00:00:00.000Z' } })
    const b = exp({ tenant_id: 't1', site_id: 's1', dates: { start_at: '2026-06-01T00:00:00.000Z', end_at: '2026-06-29T00:00:00.000Z' } })
    const c = exp({ tenant_id: 't2', site_id: 's1' }) // 別 tenant は別サイト扱い
    const out = dedupePerSite([a, b, c])
    expect(out).toHaveLength(2)
    expect(out.find((e) => e.tenant_id === 't1')?.id).toBe(b.id)
  })
})

describe('experiments/pool-aggregate — groupByCell', () => {
  it('taxonomy 4次元 + metric でグループ化 (device 違いは別セル)', () => {
    const m1 = exp()
    const m2 = exp()
    const d1 = exp({ taxonomy: { ...m1.taxonomy, device: 'desktop' } })
    const groups = groupByCell([m1, m2, d1])
    expect(groups.size).toBe(2)
  })
})

describe('experiments/pool-aggregate — toSiteEffect (寄与資格)', () => {
  it('正常: logRR/variance/sessions を返す', () => {
    const e = exp()
    const s = toSiteEffect(statsFor(e))
    expect(s).not.toBeNull()
    expect(s!.log_rr).toBeCloseTo(Math.log(0.03 / 0.02), 6)
    expect(s!.sessions).toBe(6000)
  })

  it('衛生 floor 未満 (arm < 100) は寄与不可', () => {
    const e = exp()
    const stats = statsFor(e)
    const small = {
      ...stats,
      control: { ...stats.control, sessions_n: MIN_POOL_ARM_SESSIONS - 1 },
    }
    expect(toSiteEffect(small)).toBeNull()
  })

  it('data_unavailable は寄与不可', () => {
    const e = exp()
    expect(toSiteEffect({ ...statsFor(e), data_unavailable: true })).toBeNull()
  })
})

describe('experiments/pool-aggregate — recomputePoolCells', () => {
  it('K>=24 でセル公開、K>=50 で meets_k50、τ²/I² 保存', async () => {
    const experiments = Array.from({ length: 30 }, () => exp())
    const store = new MemoryCellStore()
    const summary = await recomputePoolCells({
      source: { listPoolable: async () => experiments },
      measure: async (e) => statsFor(e, 0.02, 0.02 * (1.4 + 0.1 * Math.sin(seq + e.id.length))),
      store,
    })
    expect(summary.cells_published).toBe(1)
    expect(summary.experiments_contributed).toBe(30)
    const row = store.upserts[0]
    expect(row.k_sites).toBe(30)
    expect(row.meets_k50).toBe(false) // 30 < 50
    expect(Number.isFinite(row.tau2)).toBe(true)
    expect(Number.isFinite(row.i2)).toBe(true)
    expect(row.total_sessions).toBe(30 * 6000)
    expect(row.cell_key).toBe('cta_placement|product|d2c_ec|mobile')
  })

  it('K=50 で meets_k50=true', async () => {
    const experiments = Array.from({ length: 50 }, () => exp())
    const store = new MemoryCellStore()
    await recomputePoolCells({
      source: { listPoolable: async () => experiments },
      measure: async (e) => statsFor(e),
      store,
    })
    expect(store.upserts[0].meets_k50).toBe(true)
  })

  it(`K<${POOL_PUBLISH_MIN_K} は公開せず既存行を削除 (stale verdict 防止)`, async () => {
    const experiments = Array.from({ length: 5 }, () => exp())
    const store = new MemoryCellStore()
    store.existing.add('cta_placement|product|d2c_ec|mobile::cvr') // 過去に公開済みと仮定
    const summary = await recomputePoolCells({
      source: { listPoolable: async () => experiments },
      measure: async (e) => statsFor(e),
      store,
    })
    expect(summary.cells_published).toBe(0)
    expect(summary.cells_removed).toBe(1)
    expect(store.upserts).toHaveLength(0)
  })

  it('少数の計測失敗 (<10%) は寄与だけ落としセルは継続', async () => {
    const experiments = Array.from({ length: 26 }, () => exp())
    const failing = new Set([experiments[0].id, experiments[1].id]) // 2/26 ≈ 7.7% < 10%
    const store = new MemoryCellStore()
    const summary = await recomputePoolCells({
      source: { listPoolable: async () => experiments },
      measure: async (e) => {
        if (failing.has(e.id)) throw new Error('CH timeout')
        return statsFor(e)
      },
      store,
    })
    expect(summary.aborted).toBe(false)
    expect(summary.measure_failures).toBe(2)
    expect(summary.experiments_contributed).toBe(24)
    expect(summary.cells_published).toBe(1) // 24 >= floor
    expect(store.upserts[0].k_sites).toBe(24)
  })

  it('systemic 失敗 (>10%) は corpus 不変で abort (Codex M5 HIGH)', async () => {
    const experiments = Array.from({ length: 30 }, () => exp())
    const store = new MemoryCellStore()
    store.existing.add('cta_placement|product|d2c_ec|mobile::cvr')
    const summary = await recomputePoolCells({
      source: { listPoolable: async () => experiments },
      measure: async () => {
        throw new Error('ClickHouse down')
      },
      store,
    })
    expect(summary.aborted).toBe(true)
    expect(summary.measure_failures).toBe(30)
    expect(store.upserts).toHaveLength(0)
    expect(store.removed).toHaveLength(0) // 既存行を消していない (churn 防止)
    expect(store.existing.size).toBe(1)
  })

  it('data_unavailable は失敗として数える (>10% なら abort)', async () => {
    const experiments = Array.from({ length: 10 }, () => exp())
    const store = new MemoryCellStore()
    const summary = await recomputePoolCells({
      source: { listPoolable: async () => experiments },
      measure: async (e) => ({ ...statsFor(e), data_unavailable: true }),
      store,
    })
    expect(summary.aborted).toBe(true)
    expect(summary.measure_failures).toBe(10)
    expect(store.upserts).toHaveLength(0)
  })

  it('失敗を含むセルは K<24 でも既存行を削除しない (測れなかった≠消えた)', async () => {
    const experiments = Array.from({ length: 25 }, () => exp())
    // 2/25 = 8% < 10% → run は健全。だがこのセルは失敗 2 で K=23 < 24。
    const failing = new Set([experiments[0].id, experiments[1].id])
    const store = new MemoryCellStore()
    store.existing.add('cta_placement|product|d2c_ec|mobile::cvr')
    const summary = await recomputePoolCells({
      source: { listPoolable: async () => experiments },
      measure: async (e) => {
        if (failing.has(e.id)) throw new Error('CH timeout')
        return statsFor(e)
      },
      store,
    })
    expect(summary.aborted).toBe(false)
    expect(summary.cells_published).toBe(0) // K=23 < 24
    expect(summary.cells_removed).toBe(0) // 失敗込みセルの行は保持
    expect(store.existing.size).toBe(1)
  })

  it('同一サイト複数実験は dedupe されてから集計 (K は site 数)', async () => {
    const sameSite = Array.from({ length: 3 }, () => exp({ tenant_id: 't_dup', site_id: 's_dup' }))
    const others = Array.from({ length: 23 }, () => exp())
    const store = new MemoryCellStore()
    const summary = await recomputePoolCells({
      source: { listPoolable: async () => [...sameSite, ...others] },
      measure: async (e) => statsFor(e),
      store,
    })
    expect(summary.experiments_considered).toBe(24) // 26 → dedupe 後 24 site
    expect(store.upserts[0]?.k_sites).toBe(24)
  })
})
