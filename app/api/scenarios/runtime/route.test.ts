/**
 * /api/scenarios/runtime — 404→200 empty-scenarios regression test (issue①, 2026-08-16)
 *
 * A valid tenant_id/site_id pair with zero active scenarios (unregistered site, all
 * scenarios killed/out-of-schedule, etc.) must return 200 + empty `scenarios: []`, not 404
 * — this was showing up as console/network error noise on every customer pageview with no
 * active scenario. Malformed query params must still return 400.
 */

jest.mock('@/lib/scenarios/repository', () => ({
  createScenarioRepository: jest.fn(() => ({ listScenarios: jest.fn(async () => []) })),
  ScenarioValidationError: class ScenarioValidationError extends Error {},
}))

import { GET } from './route'

function req(qs: string): Request {
  return new Request(`https://app.example.com/api/scenarios/runtime${qs}`)
}

describe('GET /api/scenarios/runtime', () => {
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
})
