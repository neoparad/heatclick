/**
 * Experiments CRUD/lifecycle route boundary tests (宝プロジェクト 残タスク①)
 *
 * 検証 (scenarios __tests__/rbac-routes.test.ts と同様式):
 *   - session 不在 → 401
 *   - viewer → 403 (CREATE / UPDATE / status)
 *   - member → CREATE/UPDATE/stop OK、**start は 403** (running 昇格 = publish 相当)
 *   - owner / admin → start OK
 *   - 不正 taxonomy enum → 400 (repo 未呼出)
 *   - ExperimentLockError → 409 / ExperimentStateError → 409
 */

import { NextRequest } from 'next/server'

// ── mocks ────────────────────────────────────────────────────────────────

const mockGetServerSession = jest.fn()
jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: () => mockGetServerSession(),
}))

const mockCreate = jest.fn()
const mockUpdate = jest.fn()
const mockGet = jest.fn()
const mockList = jest.fn()
const mockStart = jest.fn()
const mockStop = jest.fn()
const mockArchive = jest.fn()
jest.mock('@/lib/experiments/repository', () => ({
  createExperimentRepository: () => ({
    create: mockCreate,
    update: mockUpdate,
    get: mockGet,
    list: mockList,
    listActiveForAssignment: jest.fn(),
    start: mockStart,
    stop: mockStop,
    archive: mockArchive,
  }),
  ExperimentValidationError: class extends Error {
    issues: unknown[] = []
  },
  ExperimentNotFoundError: class extends Error {},
  ExperimentStateError: class extends Error {},
  ExperimentLockError: class extends Error {},
}))
// pg Pool を実体化させない (route が PostgresExperimentStore を import するため)
jest.mock('@/lib/experiments/postgres-store', () => ({
  PostgresExperimentStore: class {},
}))

import { GET as ListExperiments, POST as CreateExperiment } from '../route'
import { PUT as UpdateExperiment } from '../[id]/route'
import { POST as TransitionStatus } from '../[id]/status/route'
import {
  ExperimentLockError,
  ExperimentStateError,
} from '@/lib/experiments/repository'

// ── helpers ──────────────────────────────────────────────────────────────

const EXP_ID = '00000000-0000-4000-8000-000000000001'
const URL_LIST = 'https://app.example.com/api/experiments?site_id=CIP_site_a'
const URL_POST = 'https://app.example.com/api/experiments'
const URL_ITEM = `https://app.example.com/api/experiments/${EXP_ID}?site_id=CIP_site_a`
const URL_STATUS = `https://app.example.com/api/experiments/${EXP_ID}/status?site_id=CIP_site_a`

function makeRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

function validTaxonomy() {
  return {
    intervention_type: 'cta_placement',
    page_type: 'product',
    industry: 'd2c_ec',
    device: 'mobile',
    primary_metric: 'cvr',
    window: '28d',
  }
}

function validCreateBody() {
  return {
    site_id: 'CIP_site_a',
    name: 'mobile CTA test',
    url_pattern: '/products',
    taxonomy: validTaxonomy(),
    pool_opt_in: true,
  }
}

function makeSession(role: string | undefined) {
  return {
    user: {
      sub: 'user_1',
      email: 'x@x.x',
      name: 'x',
      tenant_id: 'tenant_a',
      plan: 'starter',
      site_ids: ['CIP_site_a'],
      role,
    },
    tenant_id: 'tenant_a',
    user_id: 'user_1',
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockCreate.mockResolvedValue({ id: EXP_ID })
  mockUpdate.mockResolvedValue({ id: EXP_ID })
  mockStart.mockResolvedValue({ id: EXP_ID, status: 'running' })
  mockStop.mockResolvedValue({ id: EXP_ID, status: 'stopped' })
  mockArchive.mockResolvedValue({ id: EXP_ID, status: 'archived' })
  mockList.mockResolvedValue([])
})

// ── tests ────────────────────────────────────────────────────────────────

describe('GET /api/experiments', () => {
  it('session 不在 → 401', async () => {
    mockGetServerSession.mockResolvedValue(null)
    const res = await ListExperiments(makeRequest(URL_LIST, 'GET'))
    expect(res.status).toBe(401)
  })

  it('JWT site_ids 外の site_id → 403', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('owner'))
    const res = await ListExperiments(
      makeRequest('https://app.example.com/api/experiments?site_id=CIP_other', 'GET'),
    )
    expect(res.status).toBe(403)
    expect(mockList).not.toHaveBeenCalled()
  })

  it('正常 → 200 + tenant scoped list', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('viewer')) // read は viewer 可
    const res = await ListExperiments(makeRequest(URL_LIST, 'GET'))
    expect(res.status).toBe(200)
    expect(mockList).toHaveBeenCalledWith('tenant_a', 'CIP_site_a')
  })
})

describe('POST /api/experiments — create RBAC', () => {
  it('session 不在 → 401', async () => {
    mockGetServerSession.mockResolvedValue(null)
    const res = await CreateExperiment(makeRequest(URL_POST, 'POST', validCreateBody()))
    expect(res.status).toBe(401)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('viewer → 403', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('viewer'))
    const res = await CreateExperiment(makeRequest(URL_POST, 'POST', validCreateBody()))
    expect(res.status).toBe(403)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('member → 201、tenant は JWT 由来 (body の tenant は存在しない)', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('member'))
    const res = await CreateExperiment(makeRequest(URL_POST, 'POST', validCreateBody()))
    expect(res.status).toBe(201)
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant_a',
        site_id: 'CIP_site_a',
        consent: { pool_opt_in: true, k_anonymity_min: 50 },
        created_by: 'user_1',
      }),
    )
  })

  it('taxonomy が固定 enum 外 (自由記述) → 400・repo 未呼出', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('owner'))
    const body = {
      ...validCreateBody(),
      taxonomy: { ...validTaxonomy(), intervention_type: 'hero_copy_change' },
    }
    const res = await CreateExperiment(makeRequest(URL_POST, 'POST', body))
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe('PUT /api/experiments/[id] — update RBAC + lock', () => {
  it('viewer → 403', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('viewer'))
    const res = await UpdateExperiment(makeRequest(URL_ITEM, 'PUT', { name: 'renamed' }), {
      params: { id: EXP_ID },
    })
    expect(res.status).toBe(403)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('member → 200', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('member'))
    const res = await UpdateExperiment(makeRequest(URL_ITEM, 'PUT', { name: 'renamed' }), {
      params: { id: EXP_ID },
    })
    expect(res.status).toBe(200)
    expect(mockUpdate).toHaveBeenCalledWith('tenant_a', 'CIP_site_a', EXP_ID, { name: 'renamed' })
  })

  it('running 後の locked field 変更 (ExperimentLockError) → 409', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('owner'))
    mockUpdate.mockRejectedValue(new ExperimentLockError('taxonomy'))
    const res = await UpdateExperiment(
      makeRequest(URL_ITEM, 'PUT', { taxonomy: validTaxonomy() }),
      { params: { id: EXP_ID } },
    )
    expect(res.status).toBe(409)
  })

  it('遅延 opt-in (running で false→true) → 409 consent_locked・update 未呼出 (Codex MEDIUM)', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('owner'))
    mockGet.mockResolvedValue({
      id: EXP_ID,
      status: 'running',
      consent: { pool_opt_in: false, k_anonymity_min: 50 },
    })
    const res = await UpdateExperiment(makeRequest(URL_ITEM, 'PUT', { pool_opt_in: true }), {
      params: { id: EXP_ID },
    })
    expect(res.status).toBe(409)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('draft での opt-in (false→true) → 200', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('owner'))
    mockGet.mockResolvedValue({
      id: EXP_ID,
      status: 'draft',
      consent: { pool_opt_in: false, k_anonymity_min: 50 },
    })
    const res = await UpdateExperiment(makeRequest(URL_ITEM, 'PUT', { pool_opt_in: true }), {
      params: { id: EXP_ID },
    })
    expect(res.status).toBe(200)
    expect(mockUpdate).toHaveBeenCalledWith('tenant_a', 'CIP_site_a', EXP_ID, {
      consent: { pool_opt_in: true, k_anonymity_min: 50 },
    })
  })

  it('撤回 (true→false) は running でも 200 (existing fetch 不要)', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('member'))
    const res = await UpdateExperiment(makeRequest(URL_ITEM, 'PUT', { pool_opt_in: false }), {
      params: { id: EXP_ID },
    })
    expect(res.status).toBe(200)
    expect(mockUpdate).toHaveBeenCalledWith('tenant_a', 'CIP_site_a', EXP_ID, {
      consent: { pool_opt_in: false, k_anonymity_min: 50 },
    })
  })
})

describe('POST /api/experiments/[id]/status — lifecycle RBAC', () => {
  it('start: member → 403 (running 昇格は publish 相当)', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('member'))
    const res = await TransitionStatus(makeRequest(URL_STATUS, 'POST', { action: 'start' }), {
      params: { id: EXP_ID },
    })
    expect(res.status).toBe(403)
    expect(mockStart).not.toHaveBeenCalled()
  })

  it('start: admin → 200・start_at はサーバー時刻 (ISO)', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('admin'))
    const res = await TransitionStatus(makeRequest(URL_STATUS, 'POST', { action: 'start' }), {
      params: { id: EXP_ID },
    })
    expect(res.status).toBe(200)
    expect(mockStart).toHaveBeenCalledWith(
      'tenant_a',
      'CIP_site_a',
      EXP_ID,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    )
  })

  it('stop: member → 200 (公開停止は member 可)', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('member'))
    const res = await TransitionStatus(makeRequest(URL_STATUS, 'POST', { action: 'stop' }), {
      params: { id: EXP_ID },
    })
    expect(res.status).toBe(200)
    expect(mockStop).toHaveBeenCalled()
  })

  it('viewer → 403 (全 action)', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('viewer'))
    const res = await TransitionStatus(makeRequest(URL_STATUS, 'POST', { action: 'archive' }), {
      params: { id: EXP_ID },
    })
    expect(res.status).toBe(403)
  })

  it('不正 action → 400', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('owner'))
    const res = await TransitionStatus(makeRequest(URL_STATUS, 'POST', { action: 'publish' }), {
      params: { id: EXP_ID },
    })
    expect(res.status).toBe(400)
  })

  it('状態違反 (running の archive 等、ExperimentStateError) → 409', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('owner'))
    mockArchive.mockRejectedValue(new ExperimentStateError('stop first'))
    const res = await TransitionStatus(makeRequest(URL_STATUS, 'POST', { action: 'archive' }), {
      params: { id: EXP_ID },
    })
    expect(res.status).toBe(409)
  })
})
