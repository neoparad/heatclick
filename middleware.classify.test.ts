/**
 * Unit tests for middleware.ts classify() — verifies that the public allowlist change
 * (Stage 2 banner delivery) is correct and does not over-expose other scenario routes.
 *
 * Contract asserted:
 *   /api/scenarios/runtime  → 'api-public'  (anonymous visitors; JWT NOT required)
 *   /api/scenarios          → 'api-tenant'  (authenticated authoring; JWT REQUIRED)
 *   /api/scenarios/[id]     → 'api-tenant'  (authenticated authoring; JWT REQUIRED)
 *   /api/scenarios/[id]/stats → 'api-tenant' (authenticated stats; JWT REQUIRED)
 *
 * If any of these regress (e.g. runtime becomes api-tenant again, or list becomes
 * api-public) the delivery pipeline OR the security posture breaks. Both are CRITICAL.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'

import { classify, classifyPath, middleware } from './middleware'

describe('middleware classify() — Vercel Cron の経路 (定期ジョブが JWT の関所で止まらないこと)', () => {
  // Vercel Cron は JWT を持たず `Authorization: Bearer <CRON_SECRET>` を送る。api-tenant のままだと
  // middleware がそれを JWT として検証して 401 を返し、route まで届かない (= 黙って動かない)。
  const cronPaths: string[] = (
    JSON.parse(readFileSync(join(__dirname, 'vercel.json'), 'utf-8')) as {
      crons: Array<{ path: string }>
    }
  ).crons.map((c) => c.path)

  it('vercel.json に定期ジョブが登録されている (テストが空振りしていないこと)', () => {
    expect(cronPaths.length).toBeGreaterThan(0)
  })

  it.each(cronPaths)('%s は api-public (認証は route 自身が行う)', (path) => {
    expect(classify(path)).toBe('api-public')
  })

  it('定期ジョブの一覧が想定どおり (追加時は route 側の認証テストも足すこと)', () => {
    expect([...cronPaths].sort()).toEqual([
      '/api/cron/daily-site-summary',
      '/api/cron/deep-research',
      '/api/cron/fusion-ingest',
      '/api/experiments/pool',
    ])
  })

  // ── 公開は登録済みの 3 本だけ。/api/cron 配下を丸ごと公開しない (fail-closed) ──
  it('/api/cron (直下) は api-tenant のまま', () => {
    expect(classify('/api/cron')).toBe('api-tenant')
  })

  it('/api/cron/未登録の経路 は api-tenant のまま (新しい経路は明示的に足すまで閉じる)', () => {
    expect(classify('/api/cron/something-new')).toBe('api-tenant')
  })

  // ── cron は完全一致のみ公開。子経路・似た名前・末尾スラッシュは公開しない ──
  it.each([
    '/api/cron/daily-site-summary/extra',
    '/api/cron/deep-research/extra',
    '/api/cron/fusion-ingest/extra',
    '/api/cron/deep-research-extra',
    '/api/cron/fusion-ingest/',
    '/API/cron/fusion-ingest',
  ])('%s は api-public にならない', (path) => {
    expect(classify(path)).not.toBe('api-public')
  })
})

describe('middleware classify() — scenario route access control (Stage 2)', () => {
  // ── The ONE public route ────────────────────────────────────────────────────
  it('classifies /api/scenarios/runtime as api-public (no JWT, anon visitors)', () => {
    expect(classify('/api/scenarios/runtime')).toBe('api-public')
  })

  it('classifies /api/scenarios/runtime?tenant_id=x&site_id=y as api-public (query params irrelevant for classify)', () => {
    // classify() receives the pathname only (query is stripped by NextRequest.nextUrl.pathname)
    expect(classify('/api/scenarios/runtime')).toBe('api-public')
  })

  // ── ALL OTHER scenario routes must stay tenant-guarded ───────────────────
  it('classifies /api/scenarios (list) as api-tenant', () => {
    expect(classify('/api/scenarios')).toBe('api-tenant')
  })

  it('classifies /api/scenarios/ (trailing slash) as api-tenant', () => {
    expect(classify('/api/scenarios/')).toBe('api-tenant')
  })

  it('classifies /api/scenarios/[id] (GET/PUT/DELETE by id) as api-tenant', () => {
    expect(classify('/api/scenarios/00000000-0000-4000-8000-000000000001')).toBe('api-tenant')
  })

  it('classifies /api/scenarios/[id]/stats as api-tenant', () => {
    expect(classify('/api/scenarios/00000000-0000-4000-8000-000000000001/stats')).toBe('api-tenant')
  })

  it('classifies /api/scenarios/runtime/something (deeper path) as api-public — inherits prefix', () => {
    expect(classify('/api/scenarios/runtime/extra')).toBe('api-public')
  })

  // ── Sanity: other public API routes still work ───────────────────────────
  it('classifies /api/track as api-public', () => {
    expect(classify('/api/track')).toBe('api-public')
  })

  it('classifies /api/health as api-public', () => {
    expect(classify('/api/health')).toBe('api-public')
  })

  // ── Sanity: auth routes stay auth-public ────────────────────────────────
  it('classifies /api/auth/verify as auth-public', () => {
    expect(classify('/api/auth/verify')).toBe('auth-public')
  })

  // ── Sanity: unrelated tenant routes stay api-tenant ──────────────────────
  it('classifies /api/heatmap/page-stats as api-tenant', () => {
    expect(classify('/api/heatmap/page-stats')).toBe('api-tenant')
  })
})

describe('middleware classify() — experiments assign access control (宝 M2b)', () => {
  // ── The ONE public experiments route ────────────────────────────────────
  it('classifies /api/experiments/assign as api-public (anon visitors, server-arm 配信)', () => {
    expect(classify('/api/experiments/assign')).toBe('api-public')
  })

  // ── ALL OTHER experiments routes must stay tenant-guarded (CRUD は JWT 必須) ──
  it('classifies /api/experiments (future list) as api-tenant', () => {
    expect(classify('/api/experiments')).toBe('api-tenant')
  })

  it('classifies /api/experiments/[id] as api-tenant', () => {
    expect(classify('/api/experiments/00000000-0000-4000-8000-000000000001')).toBe('api-tenant')
  })

  it('classifies /api/experiments/[id]/result as api-tenant (顧客結果は JWT 必須、M4b)', () => {
    expect(classify('/api/experiments/00000000-0000-4000-8000-000000000001/result')).toBe('api-tenant')
  })

  it('classifies /api/experiments/assign/extra (deeper) as api-public — inherits prefix (no subroute today)', () => {
    expect(classify('/api/experiments/assign/extra')).toBe('api-public')
  })

  // ── pool recompute (残タスク④ cron 化): 公開だが route 内で cron/operator 認証 ──
  it('classifies /api/experiments/pool as api-public (Vercel Cron は JWT を持たない)', () => {
    expect(classify('/api/experiments/pool')).toBe('api-public')
  })

  it('classifies /api/experiments/[id]/result as api-tenant (JWT 必須のまま)', () => {
    expect(classify('/api/experiments/00000000-0000-4000-8000-000000000001/result')).toBe('api-tenant')
  })
})

describe('Wave 8 C-01 — /api/v1/** UGOKI LINK v2 surface routing & spoofing header purge', () => {
  it('classifies /api/v1/** (including .json/.yaml schema endpoints) as api-v1-link instead of static or api-tenant', () => {
    expect(classifyPath('/api/v1')).toBe('api-v1-link')
    expect(classifyPath('/api/v1/analytics/overview')).toBe('api-v1-link')
    expect(classifyPath('/api/v1/openapi.json')).toBe('api-v1-link')
    expect(classifyPath('/api/v1/mcp/tools.json')).toBe('api-v1-link')
    // Non-v1 routes remain api-tenant
    expect(classifyPath('/api/v2/analytics')).toBe('api-tenant')
  })

  it('lets ugk_sec_* / ugk_oem_* / MCP OAuth Bearer requests reach /api/v1/** without legacy JWT 401 while stripping spoofed x-ugk-* headers', async () => {
    const req = new NextRequest('https://app.example.com/api/v1/analytics/overview', {
      headers: {
        authorization: 'Bearer ugk_sec_live_1234567890abcdef',
        'x-ugk-tenant-id': 'spoofed_foreign_tenant',
        'x-ugk-principal-id': 'spoofed_root',
        'x-ugk-scopes': 'privacy:delete,sites:manage',
        'x-ugk-allowed-sites': '*',
        'x-user-id': 'spoofed_user',
        'x-site-ids': 'spoofed_site',
      },
    })

    const res = await middleware(req)
    expect(res.status).toBe(200)
    // NextResponse.next({ request: { headers } }) encodes stripped headers in x-middleware-override-headers
    const overrideList = res.headers.get('x-middleware-override-headers') ?? ''
    expect(overrideList).not.toContain('x-ugk-tenant-id')
    expect(overrideList).not.toContain('x-ugk-principal-id')
    expect(overrideList).not.toContain('x-ugk-scopes')
    expect(res.headers.get('x-middleware-request-x-ugk-tenant-id')).toBeNull()
    expect(res.headers.get('x-middleware-request-x-ugk-principal-id')).toBeNull()
    expect(res.headers.get('x-middleware-request-x-user-id')).toBeNull()
    // Original Bearer credential must pass through intact for AuthorizationGateway verification
    expect(res.headers.get('x-middleware-request-authorization')).toBe(
      'Bearer ugk_sec_live_1234567890abcdef',
    )
  })
})
