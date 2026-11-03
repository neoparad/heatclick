/**
 * GET /api/visit-risk — collector の観測からリスクフラグを導出して返す。
 * 未接続時は 200 (source: "mock") を返し、フロント側で一貫して表示可能にする。
 */

import { NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { collectorConfigured, collectorGet, rangeQuery } from '@/lib/aiseo/collector'
import { deriveRisk, type AgentStat, type ObsEvent, type UrlStat } from '@/lib/aiseo/risk'
import { generateMockVisitRisk } from '@/lib/aiseo/mock'

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
  const collectorOpts = {
    siteId: site.aireceiptSiteId ?? undefined,
    installId: site.aireceiptInstallId ?? undefined,
  }

  if (!collectorConfigured(collectorOpts)) {
    return NextResponse.json(generateMockVisitRisk(`${site.siteName} (mock)`))
  }

  try {
    const days = Number(new URL(request.url).searchParams.get('days')) || 30
    const { from, to, q } = rangeQuery(days)
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
