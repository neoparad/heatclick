/**
 * REQ-SEC-004 — JWT-derived tenant context unit tests.
 *
 * Validates that tenant_id comes ONLY from x-tenant-id and that a site_id not present in
 * x-site-ids is rejected 403 (cross-tenant IDOR prevention).
 */

import type { NextRequest } from 'next/server'

// §3.8.1: cross-tenant 403 で audit_events に記録することを検証するため audit を mock。
jest.mock('./audit', () => ({ emitScenarioAudit: jest.fn() }))

import { isTenantContext, resolveScenarioTenantContext } from './tenant-context'
import { emitScenarioAudit } from './audit'

const mockEmit = emitScenarioAudit as jest.Mock

function reqWithHeaders(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest
}

describe('resolveScenarioTenantContext (REQ-SEC-004)', () => {
  it('derives tenant_id from x-tenant-id header and accepts a granted site', () => {
    const req = reqWithHeaders({
      'x-tenant-id': 'tenant_a',
      'x-site-ids': 'CIP_one,CIP_two',
      'x-user-id': 'user_1',
    })
    const ctx = resolveScenarioTenantContext(req, 'CIP_one')
    expect(isTenantContext(ctx)).toBe(true)
    if (isTenantContext(ctx)) {
      expect(ctx.tenantId).toBe('tenant_a')
      expect(ctx.siteId).toBe('CIP_one')
      expect(ctx.userId).toBe('user_1')
    }
  })

  it('returns 401 when x-tenant-id is missing', () => {
    const req = reqWithHeaders({ 'x-site-ids': 'CIP_one' })
    const res = resolveScenarioTenantContext(req, 'CIP_one')
    expect(isTenantContext(res)).toBe(false)
    if (!isTenantContext(res)) expect(res.status).toBe(401)
  })

  it('returns 403 when site_id is NOT in the JWT site_ids (cross-tenant IDOR)', () => {
    const req = reqWithHeaders({
      'x-tenant-id': 'tenant_a',
      'x-site-ids': 'CIP_one,CIP_two',
    })
    const res = resolveScenarioTenantContext(req, 'CIP_victim')
    expect(isTenantContext(res)).toBe(false)
    if (!isTenantContext(res)) expect(res.status).toBe(403)
  })

  it('returns 403 when x-site-ids is empty', () => {
    const req = reqWithHeaders({ 'x-tenant-id': 'tenant_a', 'x-site-ids': '' })
    const res = resolveScenarioTenantContext(req, 'CIP_one')
    expect(isTenantContext(res)).toBe(false)
    if (!isTenantContext(res)) expect(res.status).toBe(403)
  })

  it('returns 400 for a malformed site_id', () => {
    const req = reqWithHeaders({ 'x-tenant-id': 'tenant_a', 'x-site-ids': 'CIP_one' })
    const res = resolveScenarioTenantContext(req, 'bad site id!')
    expect(isTenantContext(res)).toBe(false)
    if (!isTenantContext(res)) expect(res.status).toBe(400)
  })

  it('defaults userId to "system" when x-user-id absent', () => {
    const req = reqWithHeaders({ 'x-tenant-id': 'tenant_a', 'x-site-ids': 'CIP_one' })
    const ctx = resolveScenarioTenantContext(req, 'CIP_one')
    if (isTenantContext(ctx)) expect(ctx.userId).toBe('system')
  })
})

describe('resolveScenarioTenantContext audit on cross-tenant 403 (§3.8.1)', () => {
  beforeEach(() => mockEmit.mockClear())

  it('emits a scenario.access_denied audit event on a cross-tenant 403', () => {
    const req = reqWithHeaders({
      'x-tenant-id': 'tenant_a',
      'x-site-ids': 'CIP_one,CIP_two',
      'x-user-id': 'user_9',
    })
    const res = resolveScenarioTenantContext(req, 'CIP_victim')
    expect(isTenantContext(res)).toBe(false)
    if (!isTenantContext(res)) expect(res.status).toBe(403)

    expect(mockEmit).toHaveBeenCalledTimes(1)
    const arg = mockEmit.mock.calls[0][0]
    expect(arg.action).toBe('scenario.access_denied')
    expect(arg.tenant_id).toBe('tenant_a')
    expect(arg.user_id).toBe('user_9')
    expect(arg.response_status).toBe(403)
    expect(arg.metadata.attempted_site_id).toBe('CIP_victim')
    expect(arg.metadata.granted_site_ids).toEqual(['CIP_one', 'CIP_two'])
  })

  it('does NOT emit on a successful resolve', () => {
    const req = reqWithHeaders({ 'x-tenant-id': 'tenant_a', 'x-site-ids': 'CIP_one', 'x-user-id': 'u1' })
    resolveScenarioTenantContext(req, 'CIP_one')
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('does NOT emit on 401 (missing tenant — not a cross-tenant attempt)', () => {
    const req = reqWithHeaders({ 'x-site-ids': 'CIP_one' })
    resolveScenarioTenantContext(req, 'CIP_one')
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('does NOT emit on 400 (malformed site_id, before the tenant check)', () => {
    const req = reqWithHeaders({ 'x-tenant-id': 'tenant_a', 'x-site-ids': 'CIP_one' })
    resolveScenarioTenantContext(req, 'bad site id!')
    expect(mockEmit).not.toHaveBeenCalled()
  })
})
