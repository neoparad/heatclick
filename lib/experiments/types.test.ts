import {
  ExperimentSchema,
  LockedTaxonomySchema,
  ConsentSchema,
  K_ANONYMITY_FLOOR,
  isTaxonomyEditable,
  assertLockedFieldsUnchanged,
  ExperimentLockError,
  lockForRunning,
  type Experiment,
  type LockedTaxonomy,
} from '@/lib/experiments/types'

const TAXONOMY: LockedTaxonomy = {
  intervention_type: 'cta_placement',
  page_type: 'product',
  industry: 'd2c_ec',
  device: 'mobile',
  primary_metric: 'cvr',
  window: '28d',
}

function baseExperiment(overrides: Partial<Experiment> = {}): Experiment {
  return ExperimentSchema.parse({
    id: '00000000-0000-4000-8000-000000000001',
    tenant_id: 'linkth_internal',
    site_id: 'CIP_test',
    name: 'mobile CTA placement test',
    url_pattern: '/products',
    taxonomy: TAXONOMY,
    status: 'draft',
    dates: { start_at: null, end_at: null },
    salt_version: 1,
    consent: { pool_opt_in: false, k_anonymity_min: 50 },
    created_at: '2026-06-10T00:00:00.000Z',
    updated_at: '2026-06-10T00:00:00.000Z',
    created_by: 'owner@ugokimap.com',
    locked_at: null,
    stopped_at: null,
    archived_at: null,
    ...overrides,
  })
}

describe('experiments/types — LockedTaxonomy strict', () => {
  it('valid 6-tuple を受理', () => {
    expect(LockedTaxonomySchema.safeParse(TAXONOMY).success).toBe(true)
  })
  it('未知キーを拒否 (strict)', () => {
    expect(LockedTaxonomySchema.safeParse({ ...TAXONOMY, extra: 1 }).success).toBe(false)
  })
  it('非 enum 値を拒否', () => {
    expect(LockedTaxonomySchema.safeParse({ ...TAXONOMY, intervention_type: 'price_drop' }).success).toBe(false)
  })
})

describe('experiments/types — consent (k>=50)', () => {
  it('k_anonymity_min < 50 を拒否', () => {
    expect(ConsentSchema.safeParse({ pool_opt_in: true, k_anonymity_min: 49 }).success).toBe(false)
  })
  it('floor は 50', () => {
    expect(K_ANONYMITY_FLOOR).toBe(50)
  })
})

describe('experiments/types — 計測期間 (start < end)', () => {
  it('start_at >= end_at を拒否', () => {
    const exp = ExperimentSchema.safeParse({
      ...baseExperiment(),
      dates: { start_at: '2026-06-20T00:00:00.000Z', end_at: '2026-06-10T00:00:00.000Z' },
    })
    expect(exp.success).toBe(false)
  })
})

describe('experiments/types — lock 不変条件 (事前登録)', () => {
  it('draft では taxonomy 編集可', () => {
    expect(isTaxonomyEditable('draft')).toBe(true)
    const exp = baseExperiment({ status: 'draft' })
    expect(() =>
      assertLockedFieldsUnchanged(exp, { taxonomy: { ...TAXONOMY, device: 'desktop' } }),
    ).not.toThrow()
  })

  it('running では taxonomy 変更を拒否', () => {
    expect(isTaxonomyEditable('running')).toBe(false)
    const exp = baseExperiment({ status: 'running', locked_at: '2026-06-10T00:00:00.000Z' })
    expect(() =>
      assertLockedFieldsUnchanged(exp, { taxonomy: { ...TAXONOMY, device: 'desktop' } }),
    ).toThrow(ExperimentLockError)
  })

  it('running でも同一 taxonomy (キー順違い) は許可', () => {
    const exp = baseExperiment({ status: 'running' })
    const reordered: LockedTaxonomy = {
      window: TAXONOMY.window,
      primary_metric: TAXONOMY.primary_metric,
      device: TAXONOMY.device,
      industry: TAXONOMY.industry,
      page_type: TAXONOMY.page_type,
      intervention_type: TAXONOMY.intervention_type,
    }
    expect(() => assertLockedFieldsUnchanged(exp, { taxonomy: reordered })).not.toThrow()
  })

  it('running では url_pattern / salt_version 変更を拒否', () => {
    const exp = baseExperiment({ status: 'running' })
    expect(() => assertLockedFieldsUnchanged(exp, { url_pattern: '/other' })).toThrow(ExperimentLockError)
    expect(() => assertLockedFieldsUnchanged(exp, { salt_version: 2 })).toThrow(ExperimentLockError)
  })
})

describe('experiments/types — lockForRunning', () => {
  it('draft → running で locked_at を刻む', () => {
    const exp = baseExperiment({ status: 'draft' })
    const locked = lockForRunning(exp, '2026-06-11T00:00:00.000Z')
    expect(locked.status).toBe('running')
    expect(locked.locked_at).toBe('2026-06-11T00:00:00.000Z')
  })
  it('既に running なら no-op', () => {
    const exp = baseExperiment({ status: 'running', locked_at: '2026-06-10T00:00:00.000Z' })
    const again = lockForRunning(exp, '2026-06-12T00:00:00.000Z')
    expect(again.locked_at).toBe('2026-06-10T00:00:00.000Z')
  })
})
