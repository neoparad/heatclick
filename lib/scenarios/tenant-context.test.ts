/**
 * REQ-SEC-004 / REQ-SEC-126 — JWT-derived tenant context unit tests.
 *
 * tenant_id / site_ids は getServerSession() (検証済み JWT + Layer 2 失効照合) からのみ取得し、
 * site_id が JWT の site_ids に無ければ 403 (cross-tenant IDOR 防止)。session 不在は 401。
 */

import type { NextRequest } from 'next/server'

jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: jest.fn(),
}))

import { getServerSession } from '@/lib/auth/server-session'
import { isTenantContext, resolveScenarioTenantContext } from './tenant-context'

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>

// resolver は request を tenant 導出に使わない (session 由来) ため、空スタブで十分。
const stubReq = {} as unknown as NextRequest

function sessionWith(opts: {
  tenant_id?: string
  site_ids?: string[]
  user_id?: string
}): Awaited<ReturnType<typeof getServerSession>> {
  const tenant_id = opts.tenant_id ?? 'tenant_a'
  const user_id = opts.user_id ?? 'user_1'
  const site_ids = opts.site_ids ?? []
  return {
    user: {
      sub: user_id,
      email: 'user@example.com',
      name: 'User',
      tenant_id,
      plan: 'free',
      site_ids,
      role: 'owner',
      session_version: 0,
      membership_version: 0,
    },
    tenant_id,
    user_id,
    role: 'owner',
  }
}

describe('resolveScenarioTenantContext (REQ-SEC-004 / REQ-SEC-126)', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset()
  })

  it('derives tenant_id/user_id from the verified session and accepts a granted site', async () => {
    mockGetServerSession.mockResolvedValue(
      sessionWith({ tenant_id: 'tenant_a', site_ids: ['CIP_one', 'CIP_two'], user_id: 'user_1' }),
    )
    const ctx = await resolveScenarioTenantContext(stubReq, 'CIP_one')
    expect(isTenantContext(ctx)).toBe(true)
    if (isTenantContext(ctx)) {
      expect(ctx.tenantId).toBe('tenant_a')
      expect(ctx.siteId).toBe('CIP_one')
      expect(ctx.userId).toBe('user_1')
    }
  })

  it('returns 401 when there is no valid/active session (REQ-SEC-126: revoked/suspended)', async () => {
    mockGetServerSession.mockResolvedValue(null)
    const res = await resolveScenarioTenantContext(stubReq, 'CIP_one')
    expect(isTenantContext(res)).toBe(false)
    if (!isTenantContext(res)) expect(res.status).toBe(401)
  })

  it('returns 403 when site_id is NOT in the session site_ids (cross-tenant IDOR)', async () => {
    mockGetServerSession.mockResolvedValue(
      sessionWith({ site_ids: ['CIP_one', 'CIP_two'] }),
    )
    const res = await resolveScenarioTenantContext(stubReq, 'CIP_victim')
    expect(isTenantContext(res)).toBe(false)
    if (!isTenantContext(res)) expect(res.status).toBe(403)
  })

  it('returns 403 when the session grants no sites', async () => {
    mockGetServerSession.mockResolvedValue(sessionWith({ site_ids: [] }))
    const res = await resolveScenarioTenantContext(stubReq, 'CIP_one')
    expect(isTenantContext(res)).toBe(false)
    if (!isTenantContext(res)) expect(res.status).toBe(403)
  })

  it('returns 400 for a malformed site_id', async () => {
    mockGetServerSession.mockResolvedValue(sessionWith({ site_ids: ['CIP_one'] }))
    const res = await resolveScenarioTenantContext(stubReq, 'bad site id!')
    expect(isTenantContext(res)).toBe(false)
    if (!isTenantContext(res)) expect(res.status).toBe(400)
  })

  it('takes userId from the verified session', async () => {
    mockGetServerSession.mockResolvedValue(
      sessionWith({ site_ids: ['CIP_one'], user_id: 'usr_42' }),
    )
    const ctx = await resolveScenarioTenantContext(stubReq, 'CIP_one')
    if (isTenantContext(ctx)) expect(ctx.userId).toBe('usr_42')
  })
})
