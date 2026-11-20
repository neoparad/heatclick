/**
 * GET /api/ml/insights
 *
 * Wave 0 (束 0-A 止血):
 *   - 認証・テナント検証 (`requireActiveTenantSite`) を必須化。
 *   - `status` / `source` / `reason` を常に明示し、実測データ未収集時は作り物を返さず
 *     `status: 'not_collected'`, `source: 'not_collected'` + null/空配列で返す。
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { buildPragmaticMlInsightsForUrl } from '@/lib/ml/pragmatic-ml-server'

export const dynamic = 'force-dynamic'

function normalizeSiteIdRequest(req: NextRequest): Request {
  const url = new URL(req.url)
  if ((url.searchParams.get('site_id') || '').trim().toLowerCase() === 'default') {
    url.searchParams.delete('site_id')
    return new Request(url.toString(), {
      method: req.method,
      headers: req.headers,
    })
  }
  return req
}

export async function GET(req: NextRequest) {
  let active
  try {
    active = await requireActiveTenantSite(normalizeSiteIdRequest(req))
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'UNAUTHORIZED'
    const status = msg.startsWith('FORBIDDEN') ? 403 : 401
    return NextResponse.json({ ok: false, error: msg }, { status })
  }

  const sp = req.nextUrl.searchParams
  const defaultHost = active.site.canonicalHost || 'link-th.com'
  const url =
    sp.get('url') || `https://${defaultHost}/entry/internal-link-optimization`

  const insights = await buildPragmaticMlInsightsForUrl({
    tenantId: active.ctx.tenant_id,
    siteId: active.site.siteId,
    url,
  })

  return NextResponse.json({
    ok: true,
    status: insights.status,
    source: insights.source,
    reason: insights.reason,
    tenantId: active.ctx.tenant_id,
    siteId: active.site.siteId,
    data: {
      bottleneckAttribution: insights.bottleneckAttribution,
      scrollSurvival: insights.scrollSurvival,
      upliftPresets: insights.upliftPresets,
      semanticLinks: insights.semanticLinks,
      methodologyNote: insights.methodologyNote,
    },
  })
}
