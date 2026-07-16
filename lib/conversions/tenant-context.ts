/**
 * lib/conversions/tenant-context.ts — JWT 由来の tenant context (CV定義 API 用)
 *
 * lib/paths/tenant-context.ts と同契約 (REQ-SEC-004 / §3.8.1)。監査アクション名のみ
 * CV定義用 (`cvdef.access_denied`) に差し替えたコピー (docs/cv/CV_DEFINITIONS_DESIGN.md §5)。
 *   - tenant_id / user_id は getServerSession() (JWT 署名検証 + Layer 2 失効照合) 由来のみ
 *   - site_id は唯一の caller-controlled 入力で、JWT の site_ids メンバーでなければ 403
 *   - cross-tenant アクセス試行 (403) は audit_events に best-effort 記録
 */

import { NextResponse, type NextRequest } from 'next/server'

import { getServerSession } from '@/lib/auth/server-session'
import { emitScenarioAudit } from '@/lib/scenarios/audit'

const SITE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export interface CvTenantContext {
  tenantId: string
  siteId: string
  siteIds: ReadonlyArray<string>
  userId: string
}

export async function resolveCvTenantContext(
  _request: NextRequest,
  siteId: string,
): Promise<CvTenantContext | NextResponse> {
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
    void emitScenarioAudit({
      action: 'cvdef.access_denied',
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

  return {
    tenantId: session.tenant_id,
    siteId,
    siteIds,
    userId: session.user_id,
  }
}

export function isCvTenantContext(v: CvTenantContext | NextResponse): v is CvTenantContext {
  return !(v instanceof NextResponse)
}
