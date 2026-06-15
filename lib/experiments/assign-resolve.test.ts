import { isWithinWindow, resolveActiveAssignments } from '@/lib/experiments/assign-resolve'
import { computeArm } from '@/lib/experiments/assignment'
import type { Experiment } from '@/lib/experiments/types'

const SALT = 'test_salt_v1_0123456789abcdefghijABC'
const NOW = Date.parse('2026-06-15T00:00:00.000Z')

function exp(over: Partial<Experiment> & { id: string; status: Experiment['status'] }): Experiment {
  return {
    id: over.id,
    status: over.status,
    salt_version: over.salt_version ?? 1,
    url_pattern: over.url_pattern ?? '/products',
    dates: over.dates ?? { start_at: null, end_at: null },
    tenant_id: 'tnt_a',
    site_id: 'CIP_a',
    name: 'x',
    taxonomy: {
      intervention_type: 'cta_placement',
      page_type: 'product',
      industry: 'd2c_ec',
      device: 'mobile',
      primary_metric: 'cvr',
      window: '28d',
    },
    consent: { pool_opt_in: false, k_anonymity_min: 50 },
    created_at: '2026-06-10T00:00:00.000Z',
    updated_at: '2026-06-10T00:00:00.000Z',
    created_by: 'owner@x',
    locked_at: null,
    stopped_at: null,
    archived_at: null,
  } as Experiment
}

describe('experiments/assign-resolve — isWithinWindow', () => {
  it('null 端は無制限', () => {
    expect(isWithinWindow({ dates: { start_at: null, end_at: null } } as Experiment, NOW)).toBe(true)
  })
  it('start 前は false', () => {
    expect(
      isWithinWindow({ dates: { start_at: '2026-06-20T00:00:00.000Z', end_at: null } } as Experiment, NOW),
    ).toBe(false)
  })
  it('end 以降は false', () => {
    expect(
      isWithinWindow({ dates: { start_at: null, end_at: '2026-06-10T00:00:00.000Z' } } as Experiment, NOW),
    ).toBe(false)
  })
  it('window 内は true', () => {
    expect(
      isWithinWindow(
        { dates: { start_at: '2026-06-10T00:00:00.000Z', end_at: '2026-07-08T00:00:00.000Z' } } as Experiment,
        NOW,
      ),
    ).toBe(true)
  })
})

describe('experiments/assign-resolve — resolveActiveAssignments', () => {
  const running = exp({
    id: '00000000-0000-4000-8000-00000000000a',
    status: 'running',
    dates: { start_at: '2026-06-10T00:00:00.000Z', end_at: '2026-07-08T00:00:00.000Z' },
  })

  it('running + window 内のみ含む (draft/stopped/archived/window外は除外)', () => {
    const list = [
      running,
      exp({ id: '00000000-0000-4000-8000-00000000000b', status: 'draft' }),
      exp({
        id: '00000000-0000-4000-8000-00000000000c',
        status: 'stopped',
        dates: { start_at: '2026-06-10T00:00:00.000Z', end_at: '2026-07-08T00:00:00.000Z' },
      }),
      exp({ id: '00000000-0000-4000-8000-00000000000d', status: 'archived' }),
      exp({
        id: '00000000-0000-4000-8000-00000000000e',
        status: 'running',
        dates: { start_at: '2026-07-01T00:00:00.000Z', end_at: '2026-08-01T00:00:00.000Z' }, // window 前
      }),
    ]
    const out = resolveActiveAssignments(list, 'visitor-1', NOW, SALT)
    expect(out).toHaveLength(1)
    expect(out[0].experiment_id).toBe(running.id)
    expect(out[0].url_pattern).toBe('/products')
  })

  it('arm は computeArm と一致 (割付と計測の単一真実)', () => {
    const out = resolveActiveAssignments([running], 'visitor-42', NOW, SALT)
    const expected = computeArm({
      experimentId: running.id,
      visitorId: 'visitor-42',
      salt: SALT,
      saltVersion: running.salt_version,
    })
    expect(out[0].arm).toBe(expected)
  })

  it('salt_version を実験から使う', () => {
    const v2 = exp({ id: running.id, status: 'running', salt_version: 2, dates: running.dates })
    const out = resolveActiveAssignments([v2], 'visitor-42', NOW, SALT)
    const expected = computeArm({ experimentId: v2.id, visitorId: 'visitor-42', salt: SALT, saltVersion: 2 })
    expect(out[0].arm).toBe(expected)
  })

  it('active なし → 空配列', () => {
    const drafts = [exp({ id: '00000000-0000-4000-8000-00000000000f', status: 'draft' })]
    expect(resolveActiveAssignments(drafts, 'visitor-1', NOW, SALT)).toEqual([])
  })

  it('running でも null 日付は割付しない (fail-closed、Codex M2b)', () => {
    const nullDates = exp({
      id: '00000000-0000-4000-8000-00000000001a',
      status: 'running',
      dates: { start_at: null, end_at: null },
    })
    expect(resolveActiveAssignments([nullDates], 'visitor-1', NOW, SALT)).toEqual([])
  })

  it('render は treatment のみに付与 (M6、control へは露出しない)', () => {
    const withRender = {
      ...running,
      render_config: { kind: 'cta', cta_selector: '#buy' },
    } as Experiment
    // 多数 visitor を回して両 arm を観測
    let sawTreatmentRender = false
    for (let i = 0; i < 200; i++) {
      const out = resolveActiveAssignments([withRender], `v-${i}`, NOW, SALT)
      const a = out[0]
      if (a.arm === 'treatment') {
        expect(a.render).toEqual({
          intervention_type: 'cta_placement',
          config: { kind: 'cta', cta_selector: '#buy' },
        })
        sawTreatmentRender = true
      } else {
        expect(a.render).toBeUndefined()
      }
    }
    expect(sawTreatmentRender).toBe(true)
  })

  it('render_config なし (A/A) は treatment でも render を付けない', () => {
    for (let i = 0; i < 50; i++) {
      const out = resolveActiveAssignments([running], `v-${i}`, NOW, SALT)
      expect(out[0].render).toBeUndefined()
    }
  })
})
