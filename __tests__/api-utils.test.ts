import { NextRequest } from 'next/server'
import {
  getAuthContext,
  verifySiteAccess,
  buildCorsHeaders,
  buildTrackingCorsHeaders,
  apiError,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
} from '@/lib/api-utils'
import { analysisAxes, executeAxis, executeAllAxes } from '@/lib/analysis-axes'
import {
  InvalidInternalLinkIdentifierError,
  loadInternalLinkProposals,
} from '@/lib/aiseo/internal-link-loader'
import { GET as getPoolCron } from '@/app/api/experiments/pool/route'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// NextRequest ヘルパー
function createRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/test', { headers })
}

describe('getAuthContext & verifySiteAccess (Wave 8 H-23)', () => {
  it('should return auth context when x-user-id header present', () => {
    const request = createRequest({
      'x-user-id': 'user-123',
      'x-tenant-id': 'tenant-abc',
      'x-user-email': 'test@example.com',
      'x-user-plan': 'professional',
    })
    const auth = getAuthContext(request)

    expect(auth).not.toBeNull()
    expect(auth!.userId).toBe('user-123')
    expect(auth!.tenantId).toBe('tenant-abc')
    expect(auth!.email).toBe('test@example.com')
    expect(auth!.plan).toBe('professional')
  })

  it('should return null when x-user-id header missing', () => {
    const request = createRequest({ 'x-user-email': 'test@example.com' })
    expect(getAuthContext(request)).toBeNull()
  })

  it('should default plan to free and email to empty string', () => {
    const request = createRequest({ 'x-user-id': 'user-123' })
    const auth = getAuthContext(request)
    expect(auth!.plan).toBe('free')
    expect(auth!.email).toBe('')
  })

  it('verifySiteAccess fails closed when x-tenant-id is missing and binds tenant_id in ClickHouse query when present', async () => {
    const queries: Array<{ query: string; query_params?: Record<string, unknown> }> = []
    const mockCh = {
      query: jest.fn(async (q: { query: string; query_params?: Record<string, unknown> }) => {
        queries.push(q)
        return { json: async () => [{ count: 1 }] }
      }),
    } as any

    // Missing x-tenant-id -> fail closed without querying ClickHouse!
    const noTenantReq = createRequest({ 'x-user-id': 'user-123' })
    const denied = await verifySiteAccess(noTenantReq, 'CIP_001', mockCh)
    expect(denied.authorized).toBe(false)
    expect(queries).toHaveLength(0)

    // Present x-tenant-id -> binds tenant_id = {tenant_id:String}
    const okReq = createRequest({ 'x-user-id': 'user-123', 'x-tenant-id': 'ten-001' })
    const allowed = await verifySiteAccess(okReq, 'CIP_001', mockCh)
    expect(allowed.authorized).toBe(true)
    expect(queries).toHaveLength(1)
    expect(queries[0]!.query).toContain('tenant_id = {tenant_id:String}')
    expect(queries[0]!.query_params).toEqual({
      tenant_id: 'ten-001',
      site_id: 'CIP_001',
      user_id: 'user-123',
    })
  })
})

describe('CORS headers & Error responses', () => {
  it('buildCorsHeaders should restrict origin for management APIs', () => {
    const request = createRequest({ origin: 'https://evil.com' })
    const headers = buildCorsHeaders(request) as Record<string, string>
    expect(headers['Access-Control-Allow-Origin']).toBe('')
  })

  it('buildCorsHeaders should allow localhost in dev', () => {
    const request = createRequest({ origin: 'http://localhost:3000' })
    const headers = buildCorsHeaders(request) as Record<string, string>
    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
  })

  it('buildTrackingCorsHeaders should allow any origin', () => {
    const request = createRequest({ origin: 'https://any-site.com' })
    const headers = buildTrackingCorsHeaders(request) as Record<string, string>
    expect(headers['Access-Control-Allow-Origin']).toBe('https://any-site.com')
  })

  it('error helpers return expected status codes and error code body', async () => {
    expect(unauthorized().status).toBe(401)
    expect(forbidden().status).toBe(403)
    expect(badRequest('Invalid input').status).toBe(400)
    expect(notFound().status).toBe(404)
    const res = apiError('Something failed', 500)
    const body = await res.json()
    expect(body.error).toBe('Something failed')
    expect(body.code).toBe('INTERNAL_ERROR')
  })
})

describe('Wave 8 Legacy Hardening Regressions (H-23, M-08, L-02)', () => {
  it('H-23: every axis in lib/analysis-axes.ts requires tenant_id and binds {tenant_id:String}, and executeAxis/executeAllAxes fail closed on blank tenant_id', async () => {
    expect(analysisAxes.size).toBeGreaterThanOrEqual(26)
    for (const [id, axis] of analysisAxes.entries()) {
      expect(axis.requiredParams).toContain('tenant_id')
      expect(axis.query).toContain('{tenant_id:String}')
      const tableMatches = axis.query.match(/clickinsight\.\w+/g) ?? []
      expect(tableMatches.length).toBeGreaterThan(0)
      const tenantBinds = axis.query.match(/\{tenant_id:String\}/g) ?? []
      expect(tenantBinds.length).toBeGreaterThanOrEqual(tableMatches.length)
      expect(id).toBeTruthy()
    }

    const dummyCh = { query: jest.fn() } as any
    await expect(
      executeAxis(dummyCh, 'cv_behavior_diff', { site_id: 's1' })
    ).rejects.toThrow(/tenant_id/)
    await expect(
      executeAxis(dummyCh, 'cv_behavior_diff', { tenant_id: '   ', site_id: 's1' })
    ).rejects.toThrow(/tenant_id/)
    await expect(
      executeAllAxes(dummyCh, { tenant_id: '', site_id: 's1' })
    ).rejects.toThrow(/tenant_id/)
    expect(dummyCh.query).not.toHaveBeenCalled()
  })

  it('L-02: loadInternalLinkProposals blocks path traversal siteId/tenantId before touching filesystem', async () => {
    await expect(
      loadInternalLinkProposals({ tenantId: 'ten_1', siteId: '../../etc' })
    ).rejects.toThrow(InvalidInternalLinkIdentifierError)
    await expect(
      loadInternalLinkProposals({ tenantId: '../bad', siteId: 'site_1' })
    ).rejects.toThrow(InvalidInternalLinkIdentifierError)
  })

  it('M-08: /api/experiments/pool GET rejects missing or wrong cron secrets using constant-time SHA-256 comparison', async () => {
    const prevSecret = process.env.CRON_SECRET
    const prevVercel = process.env.VERCEL
    process.env.CRON_SECRET = 'super-secret-cron-token-m08'
    delete process.env.VERCEL
    try {
      const unauthRes = await getPoolCron(
        new Request('https://app.example.com/api/experiments/pool', {
          headers: { 'x-cron-secret': 'wrong-token' },
        })
      )
      expect(unauthRes.status).toBe(401)

      const spoofedVercelHeader = await getPoolCron(
        new Request('https://app.example.com/api/experiments/pool', {
          headers: { 'x-vercel-cron': '1' },
        })
      )
      expect(spoofedVercelHeader.status).toBe(401)
    } finally {
      if (prevSecret === undefined) delete process.env.CRON_SECRET
      else process.env.CRON_SECRET = prevSecret
      if (prevVercel === undefined) delete process.env.VERCEL
      else process.env.VERCEL = prevVercel
    }
  })

  it('H-23 & M-07: verifies seo/internal-links, seo/access, heatmap/screenshot, hybrid-query, and hypothesis-ab-dashboard remove cross-tenant/hardcoded fallbacks', () => {
    const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    const internalLinksSrc = stripComments(
      readFileSync(
        join(process.cwd(), 'app', 'api', 'seo', 'internal-links', 'route.ts'),
        'utf-8'
      )
    )
    expect(internalLinksSrc).not.toContain('LINKSCRAWL_DEFAULT_JOB_ID')
    expect(internalLinksSrc).toContain('requestedJobId !== siteJobId')

    const seoAccessSrc = stripComments(
      readFileSync(
        join(process.cwd(), 'app', 'api', 'seo', 'access', 'route.ts'),
        'utf-8'
      )
    )
    expect(seoAccessSrc).not.toContain('GSC_SITE_URL')
    expect(seoAccessSrc).not.toContain('link-th.com')

    const screenshotSrc = readFileSync(
      join(process.cwd(), 'app', 'api', 'heatmap', 'screenshot', 'route.ts'),
      'utf-8'
    )
    expect(screenshotSrc).toContain(
      'WHERE tenant_id = {tenant_id:String} AND tracking_id = {site_id:String}'
    )

    const hybridQuerySrc = readFileSync(
      join(process.cwd(), 'lib', 'llm', 'hybrid-query.ts'),
      'utf-8'
    )
    expect(hybridQuerySrc).toContain(
      'SELECT count() AS c FROM clickinsight.gsc_data\r\nWHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String}'
    )

    const hypDashboardSrc = readFileSync(
      join(process.cwd(), 'components', 'experiments', 'hypothesis-ab-dashboard.tsx'),
      'utf-8'
    )
    expect(hypDashboardSrc).not.toContain('INITIAL_EXPERIMENTS')
    expect(hypDashboardSrc).not.toContain('link-th.com')
    expect(hypDashboardSrc).toContain('not_collected')
  })
})
