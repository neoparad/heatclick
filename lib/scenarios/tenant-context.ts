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
import { emitScenarioAudit } from './audit'

const SITE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export interface ScenarioTenantContext {
  /** 検証済みセッション由来の tenant id (REQ-SEC-126: Layer 2 失効照合済み)。 */
  tenantId: string
  /** Requested site id, validated to be a member of the session's site_ids. */
  siteId: string
  /** All site ids the session grants access to. */
  siteIds: ReadonlyArray<string>
  /** 検証済みセッション由来の user id。 */
  userId: string
}

/**
 * Resolve the tenant context for a scenario request, validating that the caller-supplied
 * `siteId` is one the session actually grants.
 *
 * REQ-SEC-126 (Codex T1 / 続123 merge 再適用): tenant / site_ids は **`getServerSession()`
 * 経由**で取得し、JWT 署名検証 + Layer 2 失効照合 (session/membership version +
 * tenant.status) を通す。header 直読みは失効済みトークンを素通しするため使わない。
 * `siteId` は唯一の caller-controlled 入力 (REQ-SEC-004 維持)。
 *
 * §3.8.1 (banner session / 続 M-x): cross-tenant アクセス試行 (403) は audit_events に
 * best-effort 記録する。
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
    // §3.8.1: cross-tenant アクセス試行は 403 で拒否 + audit_events に記録 (best-effort)。
    // この層では scenario_id は未確定のため、resource として試行された site_id を記録する。
    void emitScenarioAudit({
      action: 'scenario.access_denied',
      tenant_id: session.tenant_id,
      scenario_id: siteId,
      user_id: session.user_id,
      response_status: 403,
      metadata: {
        reason: 'site_not_in_tenant',
        attempted_site_id: siteId,
        granted_site_ids: [...siteIds],
      },
    })
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
