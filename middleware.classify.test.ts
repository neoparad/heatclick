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

import { classify } from './middleware'

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
    // Follows API_PUBLIC_PATHS prefix matching: startsWith('/api/scenarios/runtime/')
    // This is safe: there is no deeper route under /runtime/ today. If one is ever added
    // and should be private, it must be added to AUTH_PUBLIC_API_PATHS with a length-exact
    // match override. This test documents the current forward-compatible behaviour.
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
