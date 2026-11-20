/**
 * GET /api/visit-risk — collector の観測からリスクフラグを導出して返す。
 *
 * Wave 0 (束 0-A 止血):
 *   - collector 未接続時のモック返却 (`generateMockVisitRisk`) を完全廃止。
 *   - 未設定時は `status: 'not_collected'`, `source: 'not_collected'` と空データを返す。
 */

import { NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { collectorConfigured, collectorGet, rangeQuery } from '@/lib/aiseo/collector'
import { deriveRisk, type AgentStat, type ObsEvent, type UrlStat } from '@/lib/aiseo/risk'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  let active
  try {
    active = await requireActiveTenantSite(request)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'UNAUTHORIZED'
    const status = msg.startsWith('FORBIDDEN') ? 403 : 401
    return NextResponse.json({ error: msg }, { status })
  }

  const { site } = active
  const days = Number(new URL(request.url).searchParams.get('days')) || 30
  const { from, to, q } = rangeQuery(days)
  const collectorOpts = {
    siteId: site.aireceiptSiteId ?? undefined,
    installId: site.aireceiptInstallId ?? undefined,
  }

  if (!collectorConfigured(collectorOpts)) {
    return NextResponse.json({
      status: 'not_collected',
      reason: 'AIreceipt collector が未設定のためリスク観測データは未収集です (not_collected)',
      updatedAt: new Date().toISOString(),
      site_label: site.siteName,
      source: 'not_collected',
      range: { from, to },
      summary: {
        total_hits: 0,
        unknown_hits: 0,
        spoof_count: 0,
        overcollection_count: 0,
        robots_count: 0,
      },
      flags: [],
      agents: [],
      unknown_events: [],
    })
  }

  try {
    const [urls, agents, events] = await Promise.all([
      collectorGet<{ urls?: UrlStat[] }>('/v0/analytics/urls', q, collectorOpts),
      collectorGet<{ site_label?: string; agents?: AgentStat[] }>(
        '/v0/analytics/agents',
        q,
        collectorOpts,
      ),
      collectorGet<{ events?: ObsEvent[] }>(
        '/v0/analytics/events',
        `${q}&limit=500`,
        collectorOpts,
      ),
    ])
    const { summary, flags } = deriveRisk(agents.agents || [], urls.urls || [])
    const unknown_events = (events.events || []).filter((e) => e.category === 'unknown')
    return NextResponse.json({
      status: 'ok',
      updatedAt: new Date().toISOString(),
      site_label: agents.site_label || site.siteName,
      source: 'live',
      range: { from, to },
      summary,
      flags,
      agents: agents.agents || [],
      unknown_events,
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'collector fetch failed'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
