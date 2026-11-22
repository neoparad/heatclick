/**
 * /api/scenarios/runtime — 404→200 empty-scenarios + Wave 8 M-07 pause/KV-failure regression test
 */

const mockListScenarios = jest.fn<Promise<unknown[]>, [string, string]>(async () => [])
const mockGetPocScenariosForTenant = jest.fn<unknown[], [string, string]>(() => [])

jest.mock('@/lib/scenarios/repository', () => ({
  createScenarioRepository: jest.fn(() => ({ listScenarios: mockListScenarios })),
  ScenarioValidationError: class ScenarioValidationError extends Error {},
}))

jest.mock('@/lib/scenarios/poc-scenario', () => ({
  getPocScenariosForTenant: (...args: [string, string]) => mockGetPocScenariosForTenant(...args),
}))

import { CloudflareKvError } from '@/lib/scenarios/kv-storage'
import { GET } from './route'

function req(qs: string): Request {
  return new Request(`https://app.example.com/api/scenarios/runtime${qs}`)
}

function makeScenario(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000099',
    tenant_id: 'tenant_poc',
    site_id: 'site_poc',
    name: 'POC Banner',
    status: 'live',
    condition_ast: { op: 'all', rules: [] },
    variants: [
      {
        id: 'v1',
        weight: 100,
        action: {
          type: 'banner',
          position: 'bottom',
          html: '<div>Live</div>',
        },
      },
    ],
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    archived_at: null,
    ...overrides,
  }
}

describe('GET /api/scenarios/runtime', () => {
  beforeEach(() => {
    mockListScenarios.mockReset()
    mockListScenarios.mockResolvedValue([])
    mockGetPocScenariosForTenant.mockReset()
    mockGetPocScenariosForTenant.mockReturnValue([])
  })

  it('returns 400 invalid_query for malformed params', async () => {
    const res = await GET(req('?tenant_id=&site_id=bad'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_query')
  })

  it('returns 200 with empty scenarios for a valid but unregistered tenant/site (no 404 noise)', async () => {
    const res = await GET(req('?tenant_id=tenant_nope&site_id=site_nope'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.scenarios).toEqual([])
    expect(json.tenant_id).toBe('tenant_nope')
    expect(json.site_id).toBe('site_nope')
  })

  it('Wave 8 M-07: pausing or archiving a POC scenario in KV suppresses the POC live fallback instead of resurrecting it', async () => {
    const pocLive = makeScenario({ status: 'live' })
    const kvPaused = makeScenario({
      status: 'paused',
      updated_at: '2026-11-20T00:00:00.000Z',
    })
    mockGetPocScenariosForTenant.mockReturnValue([pocLive])
    mockListScenarios.mockResolvedValue([kvPaused])

    const res = await GET(req('?tenant_id=tenant_poc&site_id=site_poc'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.scenarios).toEqual([])
  })

  it('Wave 8 M-07: KV read failure fails closed with empty scenarios rather than resurrecting paused POC scenarios', async () => {
    mockGetPocScenariosForTenant.mockReturnValue([makeScenario({ status: 'live' })])
    mockListScenarios.mockRejectedValue(new CloudflareKvError('KV timeout', 503))

    const res = await GET(req('?tenant_id=tenant_poc&site_id=site_poc'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.scenarios).toEqual([])
  })
})
