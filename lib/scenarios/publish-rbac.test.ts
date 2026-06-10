/**
 * publish-rbac.test.ts — Scenario publish RBAC 単体テスト (Phase 2.1、2026-06-07)
 */

import {
  canPublish,
  canTransitionToStatus,
  canWriteScenario,
  isPublishStatus,
  listAllowedStatusesForRole,
  normalizeRole,
  patchMutatesDelivery,
} from './publish-rbac'

describe('normalizeRole', () => {
  it('passes through known roles', () => {
    expect(normalizeRole('owner')).toBe('owner')
    expect(normalizeRole('admin')).toBe('admin')
    expect(normalizeRole('member')).toBe('member')
    expect(normalizeRole('viewer')).toBe('viewer')
  })

  it('defaults to "member" for undefined / unknown (fail-safe)', () => {
    expect(normalizeRole(undefined)).toBe('member')
    expect(normalizeRole('superuser' as never)).toBe('member')
  })
})

describe('canWriteScenario', () => {
  it('owner / admin / member can write', () => {
    expect(canWriteScenario('owner')).toBe(true)
    expect(canWriteScenario('admin')).toBe(true)
    expect(canWriteScenario('member')).toBe(true)
  })

  it('viewer cannot write', () => {
    expect(canWriteScenario('viewer')).toBe(false)
  })
})

describe('canTransitionToStatus', () => {
  it('owner can transition to anything', () => {
    for (const s of ['draft', 'measure_only', 'preview', 'live', 'paused', 'archived'] as const) {
      expect(canTransitionToStatus('owner', s)).toBe(true)
    }
  })

  it('admin can transition to anything', () => {
    for (const s of ['draft', 'measure_only', 'preview', 'live', 'paused', 'archived'] as const) {
      expect(canTransitionToStatus('admin', s)).toBe(true)
    }
  })

  it('member can transition to non-publish statuses only', () => {
    expect(canTransitionToStatus('member', 'draft')).toBe(true)
    expect(canTransitionToStatus('member', 'measure_only')).toBe(true)
    expect(canTransitionToStatus('member', 'paused')).toBe(true)
    expect(canTransitionToStatus('member', 'archived')).toBe(true)
    expect(canTransitionToStatus('member', 'live')).toBe(false)
    expect(canTransitionToStatus('member', 'preview')).toBe(false)
  })

  it('viewer cannot transition to anything', () => {
    for (const s of ['draft', 'measure_only', 'preview', 'live', 'paused', 'archived'] as const) {
      expect(canTransitionToStatus('viewer', s)).toBe(false)
    }
  })
})

describe('listAllowedStatusesForRole', () => {
  it('owner gets all six', () => {
    expect(listAllowedStatusesForRole('owner').sort()).toEqual(
      ['archived', 'draft', 'live', 'measure_only', 'paused', 'preview'].sort(),
    )
  })

  it('member gets four non-publish', () => {
    expect(listAllowedStatusesForRole('member').sort()).toEqual(
      ['archived', 'draft', 'measure_only', 'paused'].sort(),
    )
  })

  it('viewer gets none', () => {
    expect(listAllowedStatusesForRole('viewer')).toEqual([])
  })
})

describe('isPublishStatus', () => {
  it('live and preview are publish statuses', () => {
    expect(isPublishStatus('live')).toBe(true)
    expect(isPublishStatus('preview')).toBe(true)
  })

  it('non-publish statuses', () => {
    for (const s of ['draft', 'measure_only', 'paused', 'archived'] as const) {
      expect(isPublishStatus(s)).toBe(false)
    }
  })
})

describe('canPublish', () => {
  it('owner / admin can publish', () => {
    expect(canPublish('owner')).toBe(true)
    expect(canPublish('admin')).toBe(true)
  })

  it('member / viewer cannot publish', () => {
    expect(canPublish('member')).toBe(false)
    expect(canPublish('viewer')).toBe(false)
  })
})

describe('patchMutatesDelivery', () => {
  it('true when a delivery-impacting field is present', () => {
    expect(patchMutatesDelivery({ variants: [] })).toBe(true)
    expect(patchMutatesDelivery({ condition_ast: { op: 'AND', children: [] } })).toBe(true)
    expect(patchMutatesDelivery({ frequency_cap: { per_period: 'day', max_impressions: 1 } })).toBe(true)
    expect(patchMutatesDelivery({ schedule: { start_at: null, end_at: null } })).toBe(true)
  })

  it('treats explicit null (clear) as a delivery change', () => {
    expect(patchMutatesDelivery({ frequency_cap: null })).toBe(true)
    expect(patchMutatesDelivery({ schedule: null })).toBe(true)
  })

  it('false for admin-only metadata (name / description / status / evidence)', () => {
    expect(patchMutatesDelivery({ name: 'x' })).toBe(false)
    expect(patchMutatesDelivery({ description: 'y' })).toBe(false)
    expect(patchMutatesDelivery({ status: 'paused' })).toBe(false)
    expect(patchMutatesDelivery({ evidence_level: 'observed', evidence_data: {} })).toBe(false)
    expect(patchMutatesDelivery({})).toBe(false)
  })
})
