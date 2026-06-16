/**
 * Scenarios CRUD route boundary tests for publish RBAC (REQ-SEC-010、2026-06-07)
 *
 * 検証:
 *   - session 不在 → 401
 *   - viewer → 403 (CREATE / UPDATE / DELETE)
 *   - member → CREATE OK (draft 固定)、UPDATE で status='live' → 403
 *   - owner / admin → UPDATE status='live' OK
 *   - role 無し (旧 JWT) → member 扱いで status='live' は 403
 *
 * REQ-SEC-004 と publish RBAC を分離して検証。tenant 越境 (site_id JWT 範囲外) は
 * 既存 tenant-context test で別途カバー済前提。
 */

import { NextRequest } from 'next/server'

// ── mocks ────────────────────────────────────────────────────────────────

const mockGetServerSession = jest.fn()
jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: () => mockGetServerSession(),
}))

const mockCreateScenario = jest.fn()
const mockUpdateScenario = jest.fn()
const mockDeleteScenario = jest.fn()
const mockGetScenario = jest.fn()
jest.mock('@/lib/scenarios/repository', () => {
  return {
    createScenarioRepository: () => ({
      createScenario: mockCreateScenario,
      updateScenario: mockUpdateScenario,
      deleteScenario: mockDeleteScenario,
      getScenario: mockGetScenario,
      listScenarios: jest.fn(),
    }),
    ScenarioValidationError: class extends Error {
      issues: unknown
      constructor(msg: string) { super(msg); this.issues = [] }
    },
    ScenarioNotFoundError: class extends Error {
      constructor(msg: string) { super(msg) }
    },
    ScenarioForbiddenError: class extends Error {
      constructor(msg: string) { super(msg); this.name = 'ScenarioForbiddenError' }
    },
    HtmlSanitizationError: class extends Error {
      reason: string
      constructor(msg: string) { super(msg); this.reason = 'mock' }
    },
  }
})

import { POST as PostScenarios } from '../route'
import { PUT as PutScenario, DELETE as DeleteScenario } from '../[id]/route'

// ── helpers ──────────────────────────────────────────────────────────────

const URL_POST = 'https://app.example.com/api/scenarios'
const URL_PUT = 'https://app.example.com/api/scenarios/00000000-0000-4000-8000-000000000001?site_id=CIP_site_a'
const URL_DELETE = URL_PUT

const VALID_HEADERS = {
  'content-type': 'application/json',
  'x-tenant-id': 'tenant_a',
  'x-site-ids': 'CIP_site_a',
  'x-user-id': 'user_1',
}

function makeRequest(url: string, method: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: VALID_HEADERS,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

function validCreateBody() {
  return {
    site_id: 'CIP_site_a',
    name: 'test',
    condition_ast: { op: 'AND', children: [{ op: 'EQ', field: 'utm_source', value: 'google' }] },
    variants: [
      {
        id: 'A',
        content_type: 'image',
        image_url: 'https://cdn.example.com/x.png',
        image_alt: '',
        position: 'center',
        traffic_split: 100,
      },
    ],
  }
}

function makeSession(role: string | undefined) {
  return {
    user: { sub: 'user_1', email: 'x@x.x', name: 'x', tenant_id: 'tenant_a', plan: 'starter', site_ids: ['CIP_site_a'], role },
    tenant_id: 'tenant_a',
    user_id: 'user_1',
  }
}

// ── tests ────────────────────────────────────────────────────────────────

describe('POST /api/scenarios — publish RBAC', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateScenario.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000001' })
  })

  it('returns 401 when session is missing', async () => {
    mockGetServerSession.mockResolvedValue(null)
    const res = await PostScenarios(makeRequest(URL_POST, 'POST', validCreateBody()))
    expect(res.status).toBe(401)
    expect(mockCreateScenario).not.toHaveBeenCalled()
  })

  it('returns 403 when role=viewer', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('viewer'))
    const res = await PostScenarios(makeRequest(URL_POST, 'POST', validCreateBody()))
    expect(res.status).toBe(403)
    expect(mockCreateScenario).not.toHaveBeenCalled()
  })

  it('returns 201 when role=member (CREATE is always draft, RBAC allows)', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('member'))
    const res = await PostScenarios(makeRequest(URL_POST, 'POST', validCreateBody()))
    expect(res.status).toBe(201)
    expect(mockCreateScenario).toHaveBeenCalledTimes(1)
  })

  it('treats role=undefined as member (writable, draft create OK)', async () => {
    mockGetServerSession.mockResolvedValue(makeSession(undefined))
    const res = await PostScenarios(makeRequest(URL_POST, 'POST', validCreateBody()))
    expect(res.status).toBe(201)
  })
})

describe('PUT /api/scenarios/[id] — publish RBAC', () => {
  const id = '00000000-0000-4000-8000-000000000001'
  beforeEach(() => {
    jest.clearAllMocks()
    mockUpdateScenario.mockResolvedValue({ id })
  })

  it('returns 401 when session is missing', async () => {
    mockGetServerSession.mockResolvedValue(null)
    const res = await PutScenario(
      makeRequest(URL_PUT, 'PUT', { name: 'new name' }),
      { params: { id } },
    )
    expect(res.status).toBe(401)
    expect(mockUpdateScenario).not.toHaveBeenCalled()
  })

  it('returns 403 when role=viewer (any patch)', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('viewer'))
    const res = await PutScenario(
      makeRequest(URL_PUT, 'PUT', { name: 'new name' }),
      { params: { id } },
    )
    expect(res.status).toBe(403)
    expect(mockUpdateScenario).not.toHaveBeenCalled()
  })

  it('returns 403 when role=member tries status=live', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('member'))
    const res = await PutScenario(
      makeRequest(URL_PUT, 'PUT', { status: 'live' }),
      { params: { id } },
    )
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.message).toMatch(/live/)
    expect(json.message).toMatch(/member/)
    expect(mockUpdateScenario).not.toHaveBeenCalled()
  })

  it('returns 403 when role=member tries status=preview', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('member'))
    const res = await PutScenario(
      makeRequest(URL_PUT, 'PUT', { status: 'preview' }),
      { params: { id } },
    )
    expect(res.status).toBe(403)
    expect(mockUpdateScenario).not.toHaveBeenCalled()
  })

  it('returns 200 when role=member tries status=paused (non-publish)', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('member'))
    const res = await PutScenario(
      makeRequest(URL_PUT, 'PUT', { status: 'paused' }),
      { params: { id } },
    )
    expect(res.status).toBe(200)
  })

  it('returns 200 when role=owner tries status=live', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('owner'))
    const res = await PutScenario(
      makeRequest(URL_PUT, 'PUT', { status: 'live' }),
      { params: { id } },
    )
    expect(res.status).toBe(200)
  })

  it('returns 200 when role=admin tries status=live', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('admin'))
    const res = await PutScenario(
      makeRequest(URL_PUT, 'PUT', { status: 'live' }),
      { params: { id } },
    )
    expect(res.status).toBe(200)
  })

  it('returns 403 when role=undefined (old JWT) tries status=live', async () => {
    mockGetServerSession.mockResolvedValue(makeSession(undefined))
    const res = await PutScenario(
      makeRequest(URL_PUT, 'PUT', { status: 'live' }),
      { params: { id } },
    )
    expect(res.status).toBe(403)
    expect(mockUpdateScenario).not.toHaveBeenCalled()
  })

  // REQ-SEC-010 (HIGH, Codex dual review): 配信中 (live/preview) コンテンツ改変ガード
  const liveVariants = [
    {
      id: 'A',
      content_type: 'image',
      image_url: 'https://cdn.example.com/x.png',
      image_alt: '',
      position: 'center',
      traffic_split: 100,
    },
  ]

  it('returns 403 when role=member mutates variants of a LIVE scenario (no status field)', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('member'))
    mockGetScenario.mockResolvedValue({ status: 'live' })
    const res = await PutScenario(
      makeRequest(URL_PUT, 'PUT', { variants: liveVariants }),
      { params: { id } },
    )
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.message).toMatch(/配信中/)
    expect(mockUpdateScenario).not.toHaveBeenCalled()
  })

  it('returns 200 when role=member mutates variants of a DRAFT scenario (not yet delivered)', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('member'))
    mockGetScenario.mockResolvedValue({ status: 'draft' })
    const res = await PutScenario(
      makeRequest(URL_PUT, 'PUT', { variants: liveVariants }),
      { params: { id } },
    )
    expect(res.status).toBe(200)
    expect(mockUpdateScenario).toHaveBeenCalledTimes(1)
  })

  it('returns 200 when role=owner mutates variants of a LIVE scenario (publisher)', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('owner'))
    mockGetScenario.mockResolvedValue({ status: 'live' })
    const res = await PutScenario(
      makeRequest(URL_PUT, 'PUT', { variants: liveVariants }),
      { params: { id } },
    )
    expect(res.status).toBe(200)
    expect(mockUpdateScenario).toHaveBeenCalledTimes(1)
  })

  it('returns 200 when role=member edits only name of a LIVE scenario (name is not delivery-impacting)', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('member'))
    mockGetScenario.mockResolvedValue({ status: 'live' })
    const res = await PutScenario(
      makeRequest(URL_PUT, 'PUT', { name: 'typo fix only' }),
      { params: { id } },
    )
    expect(res.status).toBe(200)
    // name-only patch は delivery guard を通らない → getScenario は呼ばれない
    expect(mockGetScenario).not.toHaveBeenCalled()
    expect(mockUpdateScenario).toHaveBeenCalledTimes(1)
  })

  it('returns 403 when updateScenario authorize rejects a now-live row (TOCTOU close, route maps ScenarioForbiddenError→403)', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('member'))
    // preflight は draft を見て通過する
    mockGetScenario.mockResolvedValue({ status: 'draft' })
    // updateScenario の authoritative read 時点では owner が publish 済 (live) になっていた状況を再現
    mockUpdateScenario.mockImplementation(
      async (
        _t: string,
        _s: string,
        _id: string,
        patch: unknown,
        opts?: { authorize?: (existing: { status: string }, patch: unknown) => void },
      ) => {
        opts?.authorize?.({ status: 'live' }, patch)
        return { id }
      },
    )
    const res = await PutScenario(
      makeRequest(URL_PUT, 'PUT', { variants: liveVariants }),
      { params: { id } },
    )
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.message).toMatch(/配信中/)
  })
})

describe('DELETE /api/scenarios/[id] — publish RBAC', () => {
  const id = '00000000-0000-4000-8000-000000000001'
  beforeEach(() => {
    jest.clearAllMocks()
    mockDeleteScenario.mockResolvedValue(true)
  })

  it('returns 401 when session is missing', async () => {
    mockGetServerSession.mockResolvedValue(null)
    const res = await DeleteScenario(
      makeRequest(URL_DELETE, 'DELETE', undefined),
      { params: { id } },
    )
    expect(res.status).toBe(401)
    expect(mockDeleteScenario).not.toHaveBeenCalled()
  })

  it('returns 403 when role=viewer', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('viewer'))
    const res = await DeleteScenario(
      makeRequest(URL_DELETE, 'DELETE', undefined),
      { params: { id } },
    )
    expect(res.status).toBe(403)
    expect(mockDeleteScenario).not.toHaveBeenCalled()
  })

  it('returns 204 when role=member', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('member'))
    const res = await DeleteScenario(
      makeRequest(URL_DELETE, 'DELETE', undefined),
      { params: { id } },
    )
    expect(res.status).toBe(204)
    expect(mockDeleteScenario).toHaveBeenCalledTimes(1)
  })

  it('returns 204 when role=owner', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('owner'))
    const res = await DeleteScenario(
      makeRequest(URL_DELETE, 'DELETE', undefined),
      { params: { id } },
    )
    expect(res.status).toBe(204)
  })
})
