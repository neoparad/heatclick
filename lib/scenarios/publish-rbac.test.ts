/**
 * publish-rbac.test.ts — Scenario publish RBAC 単体テスト (Phase 2.1、2026-06-07)
 */

import {
  canDeleteExistingScenario,
  canPatchExistingScenario,
  canTransitionToStatus,
  canWriteScenario,
  isPublishStatus,
  isStatusOnlyDemotePatch,
  listAllowedStatusesForRole,
  normalizeRole,
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

describe('isStatusOnlyDemotePatch', () => {
  it('returns true for { status: <non-publish> } single-key patch', () => {
    expect(isStatusOnlyDemotePatch({ status: 'paused' })).toBe(true)
    expect(isStatusOnlyDemotePatch({ status: 'draft' })).toBe(true)
    expect(isStatusOnlyDemotePatch({ status: 'archived' })).toBe(true)
    expect(isStatusOnlyDemotePatch({ status: 'measure_only' })).toBe(true)
  })

  it('returns false when status target is publish-system', () => {
    expect(isStatusOnlyDemotePatch({ status: 'live' })).toBe(false)
    expect(isStatusOnlyDemotePatch({ status: 'preview' })).toBe(false)
  })

  it('returns false when other fields are present', () => {
    expect(isStatusOnlyDemotePatch({ status: 'paused', name: 'x' })).toBe(false)
    expect(isStatusOnlyDemotePatch({ name: 'x' })).toBe(false)
    expect(isStatusOnlyDemotePatch({})).toBe(false)
  })
})

describe('canPatchExistingScenario', () => {
  it('viewer is blocked regardless of current status / patch', () => {
    const v = canPatchExistingScenario('viewer', 'draft', { name: 'x' })
    expect(v.allowed).toBe(false)
  })

  it('owner / admin can patch anything (status transition checked separately)', () => {
    expect(canPatchExistingScenario('owner', 'live', { name: 'x' }).allowed).toBe(true)
    expect(canPatchExistingScenario('admin', 'live', { name: 'x' }).allowed).toBe(true)
    expect(canPatchExistingScenario('owner', 'draft', { status: 'live' }).allowed).toBe(true)
  })

  it('member can patch non-publish scenario freely', () => {
    expect(canPatchExistingScenario('member', 'draft', { name: 'x' }).allowed).toBe(true)
    expect(canPatchExistingScenario('member', 'paused', { name: 'x', description: 'y' }).allowed).toBe(true)
    expect(canPatchExistingScenario('member', 'archived', { status: 'draft' }).allowed).toBe(true)
  })

  it('member is blocked from content edit on publish-system scenario', () => {
    const v1 = canPatchExistingScenario('member', 'live', { name: 'new name' })
    expect(v1.allowed).toBe(false)
    const v2 = canPatchExistingScenario('member', 'preview', { description: 'x' })
    expect(v2.allowed).toBe(false)
    // status omitted entirely (e.g. UI sends { name }) → blocked
    const v3 = canPatchExistingScenario('member', 'live', { name: 'x', condition_ast: {} as never })
    expect(v3.allowed).toBe(false)
  })

  it('member CAN demote publish-system scenario via single-key status patch', () => {
    expect(canPatchExistingScenario('member', 'live', { status: 'paused' }).allowed).toBe(true)
    expect(canPatchExistingScenario('member', 'live', { status: 'draft' }).allowed).toBe(true)
    expect(canPatchExistingScenario('member', 'preview', { status: 'archived' }).allowed).toBe(true)
  })

  it('member CANNOT promote publish-system scenario to another publish-system', () => {
    // live → preview や preview → live は owner/admin only
    expect(canPatchExistingScenario('member', 'live', { status: 'preview' }).allowed).toBe(false)
    expect(canPatchExistingScenario('member', 'preview', { status: 'live' }).allowed).toBe(false)
  })

  it('member CANNOT mix status demote with content edit', () => {
    const v = canPatchExistingScenario('member', 'live', { status: 'paused', name: 'rename' })
    expect(v.allowed).toBe(false)
  })
})

describe('canDeleteExistingScenario', () => {
  it('viewer is blocked', () => {
    expect(canDeleteExistingScenario('viewer', 'draft').allowed).toBe(false)
  })

  it('owner / admin can delete anything', () => {
    expect(canDeleteExistingScenario('owner', 'live').allowed).toBe(true)
    expect(canDeleteExistingScenario('admin', 'preview').allowed).toBe(true)
    expect(canDeleteExistingScenario('owner', 'draft').allowed).toBe(true)
  })

  it('member can delete non-publish scenario', () => {
    expect(canDeleteExistingScenario('member', 'draft').allowed).toBe(true)
    expect(canDeleteExistingScenario('member', 'paused').allowed).toBe(true)
    expect(canDeleteExistingScenario('member', 'archived').allowed).toBe(true)
  })

  it('member CANNOT delete publish-system scenario (RBAC bypass via delete)', () => {
    expect(canDeleteExistingScenario('member', 'live').allowed).toBe(false)
    expect(canDeleteExistingScenario('member', 'preview').allowed).toBe(false)
  })
})
