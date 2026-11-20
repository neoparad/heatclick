/**
 * GET /api/heatmap/agent-insights?site_id=...&url=...&device=...&agent_subtype=...
 *
 * Wave 0 (束 0-A 止血):
 *   - 認証・テナント検証 (`requireActiveTenantSite`) を必須化。
 *   - ClickHouse 未接続 / 実測データ 0 件時は `status: 'not_collected'` + 空データを返す。
 */

import { NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import {
  buildAgentHybridInsights,
  parseAgentSubtype,
} from '@/lib/heatmap/agent-heatmap-client'
import {
  fetchAgentBehaviorSummary,
  fetchAgentHeatmapPoints,
} from '@/lib/heatmap/agent-heatmap-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function normalizeSiteIdRequest(request: Request): Request {
  const url = new URL(request.url)
  if ((url.searchParams.get('site_id') || '').trim().toLowerCase() === 'default') {
    url.searchParams.delete('site_id')
    return new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
    })
  }
  return request
}

export async function GET(request: Request) {
  let active
  try {
    active = await requireActiveTenantSite(normalizeSiteIdRequest(request))
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'UNAUTHORIZED'
    const status = msg.startsWith('FORBIDDEN') ? 403 : 401
    return NextResponse.json({ ok: false, error: msg }, { status })
  }

  const sp = new URL(request.url).searchParams
  const tenantId = active.ctx.tenant_id
  const siteId = active.site.siteId
  const defaultHost = active.site.canonicalHost || 'bihadashop.jp'
  const pageUrl = (sp.get('url') || sp.get('page_url') || `https://${defaultHost}/`).trim()
  const device = (sp.get('device') || sp.get('device_type') || 'desktop').trim()
  const agentSubtype = parseAgentSubtype(sp.get('agent_subtype'))

  try {
    const [rawPoints, rawSummary] = await Promise.all([
      fetchAgentHeatmapPoints({
        tenantId,
        siteId,
        pageUrl,
        deviceType: device,
        agentSubtype,
      }),
      fetchAgentBehaviorSummary({
        tenantId,
        siteId,
        pageUrl,
        deviceType: device,
        agentSubtype,
      }),
    ])

    const insights = buildAgentHybridInsights({
      siteId,
      pageUrl,
      agentSubtype,
      rawPoints,
      rawSummary,
    })

    return NextResponse.json({
      ok: true,
      status: insights.status,
      reason: insights.reason,
      data: {
        status: insights.status,
        reason: insights.reason,
        siteId: insights.siteId,
        pageUrl: insights.pageUrl,
        agentSubtype: insights.agentSubtype,
        summary: insights.summary,
        frictionHotspots: insights.frictionHotspots,
        crawlerSectionOverlays: insights.crawlerSectionOverlays,
        subtypeCounts: insights.subtypeCounts,
      },
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'failed to build agent hybrid insights'
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    )
  }
}
