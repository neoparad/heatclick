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

import { emitScenarioAudit } from './audit'

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
 * Resolve the tenant context for a scenario request from middleware-injected headers,
 * validating that the caller-supplied `siteId` is one the JWT actually grants.
 *
 * `siteId` is the ONLY caller-controlled input here; tenant comes solely from the verified
 * header. Returns a NextResponse (401/403) on any failure instead of a context.
 */
export function resolveScenarioTenantContext(
  request: NextRequest,
  siteId: string,
): ScenarioTenantContext | NextResponse {
  const tenantId = request.headers.get('x-tenant-id')
  const siteIdsHeader = request.headers.get('x-site-ids')
  const userId = request.headers.get('x-user-id') || 'system'

  if (!tenantId) {
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

  const siteIds = (siteIdsHeader ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  if (!siteIds.includes(siteId)) {
    // §3.8.1: cross-tenant アクセス試行は 403 で拒否 + audit_events に記録 (best-effort)。
    // この層では scenario_id は未確定のため、resource として試行された site_id を記録する。
    void emitScenarioAudit({
      action: 'scenario.access_denied',
      tenant_id: tenantId,
      scenario_id: siteId,
      user_id: userId,
      response_status: 403,
      metadata: {
        reason: 'site_not_in_tenant',
        attempted_site_id: siteId,
        granted_site_ids: siteIds,
      },
    })
    return NextResponse.json(
      { error: 'forbidden', message: 'site_id is not in the authenticated tenant' },
      { status: 403 },
    )
  }

  return { tenantId, siteId, siteIds, userId }
}

export function isTenantContext(
  v: ScenarioTenantContext | NextResponse,
): v is ScenarioTenantContext {
  return !(v instanceof NextResponse)
}
