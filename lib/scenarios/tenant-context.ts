/**
 * M-Director security (REQ-SEC-004) — JWT-derived tenant context for scenario APIs.
 *
 * STRIDE threat model finding: the scenario CRUD + sign-url routes read `tenant_id` from the
 * request body/query (defaulting to `linkth_internal`) and `site_id` from body/query. The
 * middleware only cross-checks `site_id` when it is a QUERY param, so a body-supplied tenant
 * or site bypassed isolation entirely (cross-tenant IDOR write+read).
 *
 * Fix: derive tenant_id and site_id ONLY from the middleware-injected, JWT-verified headers
 * `x-tenant-id` / `x-site-ids` (mirrors app/api/heatmap/screenshot/route.ts). Body/query
 * tenant_id & site_id are ignored. `site_id` MUST be a member of the JWT's site_ids or the
 * request is rejected 403. There is no `linkth_internal` default.
 *
 * §3.8.1 multi-tenant isolation: tenant_id / site_id ALWAYS from JWT, never from body/query/LLM.
 */

import { NextResponse, type NextRequest } from 'next/server'

import { getServerSession } from '@/lib/auth/server-session'

const SITE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export interface ScenarioTenantContext {
  /** JWT-verified tenant id (from x-tenant-id, injected by middleware). */
  tenantId: string
  /** Requested site id, validated to be a member of the JWT's site_ids. */
  siteId: string
  /** All site ids the JWT grants access to. */
  siteIds: ReadonlyArray<string>
  /** JWT-verified user id (from x-user-id), or 'system' if absent. */
  userId: string
}

/**
 * Resolve the tenant context for a scenario request, validating that the caller-supplied
 * `siteId` is one the JWT actually grants.
 *
 * REQ-SEC-126 (Codex T1 / §13.7): tenant / site_ids は **`getServerSession()` 経由**で取得し、
 * Layer 2 失効照合 (session/membership version + tenant.status) を通す。これにより revoked /
 * suspended なセッションでは scenario CRUD も 401 になる (header 直読みでは効かなかった)。
 * `siteId` は唯一の caller-controlled 入力で、JWT の site_ids に含まれること必須 (REQ-SEC-004 維持)。
 * `_request` は署名互換のため残置 (tenant は header ではなく session から取るため未使用)。
 */
export async function resolveScenarioTenantContext(
  _request: NextRequest,
  siteId: string,
): Promise<ScenarioTenantContext | NextResponse> {
  const session = await getServerSession()

  if (!session) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'tenant context missing' },
      { status: 401 },
    )
  }

  if (!SITE_ID_PATTERN.test(siteId)) {
    return NextResponse.json(
      { error: 'invalid_site_id', message: 'site_id must match ^[A-Za-z0-9_-]{1,64}$' },
      { status: 400 },
    )
  }

  const siteIds = session.user.site_ids

  if (!siteIds.includes(siteId)) {
    return NextResponse.json(
      { error: 'forbidden', message: 'site_id is not in the authenticated tenant' },
      { status: 403 },
    )
  }

  return { tenantId: session.tenant_id, siteId, siteIds, userId: session.user_id }
}

export function isTenantContext(
  v: ScenarioTenantContext | NextResponse,
): v is ScenarioTenantContext {
  return !(v instanceof NextResponse)
}
