/**
 * 続134 CRITICAL fix の回帰テスト: scenarios stats の cross-tenant IDOR を塞いだことを固定する。
 *
 * 不変条件:
 *   - session 無し → 401
 *   - site_id 省略 → 400 (旧実装は既定値に落ちて他テナント漏洩していた)
 *   - クエリ tenant_id は **無視** され、tenant は session 由来のみ
 *   - JWT に無い site_id → 403
 */

import type { NextRequest } from 'next/server'

jest.mock('@/lib/auth/server-session', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/scenarios/audit', () => ({ emitScenarioAudit: jest.fn() }))
jest.mock('@/lib/scenarios/repository', () => {
  const actual = jest.requireActual('@/lib/scenarios/repository')
  return { ...actual, createScenarioRepository: jest.fn() }
})
jest.mock('@/lib/scenarios/stats-query', () => ({
  buildPresetRange: jest.fn(() => ({ from: new Date(0), to: new Date(1000), bucket: 'hour' })),
  queryScenarioStats: jest.fn(),
}))

import { getServerSession } from '@/lib/auth/server-session'
import { createScenarioRepository } from '@/lib/scenarios/repository'
import { queryScenarioStats } from '@/lib/scenarios/stats-query'
import { GET } from './route'

const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>
const mockRepo = createScenarioRepository as jest.Mock
const mockStats = queryScenarioStats as jest.Mock

const SCENARIO_ID = '00000000-0000-4000-8000-000000000001'

function sessionWith(tenant: string, siteIds: string[]) {
  return {
    user: {
      sub: 'u1',
      email: 'u@example.com',
      name: 'U',
      tenant_id: tenant,
      plan: 'free',
      site_ids: siteIds,
      role: 'owner',
      session_version: 0,
      membership_version: 0,
    },
    tenant_id: tenant,
    user_id: 'u1',
    role: 'owner',
  } as Awaited<ReturnType<typeof getServerSession>>
}

function req(query: string): NextRequest {
  return { url: `https://x.test/api/scenarios/${SCENARIO_ID}/stats${query}` } as unknown as NextRequest
}

beforeEach(() => {
  mockSession.mockReset()
  mockRepo.mockReset()
  mockStats.mockReset()
  mockRepo.mockReturnValue({ getScenario: jest.fn().mockResolvedValue({ id: SCENARIO_ID }) })
  mockStats.mockResolvedValue({ scenario_id: SCENARIO_ID, tenant_id: 'x', totals: {}, series: [] })
})

const params = { params: { id: SCENARIO_ID } }

it('session 無し → 401 (旧: クエリ tenant で他テナント読取できた)', async () => {
  mockSession.mockResolvedValue(null)
  const res = await GET(req('?site_id=CIP_one'), params)
  expect(res.status).toBe(401)
  expect(mockStats).not.toHaveBeenCalled()
})

it('site_id 省略 → 400 (旧: 既定 site にフォールバックして漏洩)', async () => {
  mockSession.mockResolvedValue(sessionWith('tenant_a', ['CIP_one']))
  const res = await GET(req('?range=24h'), params)
  expect(res.status).toBe(400)
  expect(mockStats).not.toHaveBeenCalled()
})

it('JWT に無い site_id → 403', async () => {
  mockSession.mockResolvedValue(sessionWith('tenant_a', ['CIP_one']))
  const res = await GET(req('?site_id=CIP_victim'), params)
  expect(res.status).toBe(403)
  expect(mockStats).not.toHaveBeenCalled()
})

it('クエリ tenant_id は無視され、session の tenant で集計する (IDOR 封鎖の核心)', async () => {
  mockSession.mockResolvedValue(sessionWith('tenant_a', ['CIP_one']))
  // 攻撃: 他テナントを指定しても session の tenant_a が使われる
  const res = await GET(req('?site_id=CIP_one&tenant_id=tenant_victim&range=24h'), params)
  expect(res.status).toBe(200)
  expect(mockStats).toHaveBeenCalledTimes(1)
  expect(mockStats.mock.calls[0][0].tenantId).toBe('tenant_a')
  expect(mockStats.mock.calls[0][0].tenantId).not.toBe('tenant_victim')
})
