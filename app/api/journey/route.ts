/**
 * GET /api/journey — collector の個別イベント（時系列）＋エージェント一覧を返す。
 * セッション化はクライアント側（lib/aiseo/journey.ts）で行う。
 */

import { NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { collectorConfigured, collectorGet, rangeQuery } from '@/lib/aiseo/collector'
import { generateMockJourney } from '@/lib/aiseo/mock'
import type { AgentStat, ObsEvent } from '@/lib/aiseo/risk'

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
    return NextResponse.json(generateMockJourney(`${site.siteName} (mock)`))
  }

  try {
    const days = Number(new URL(request.url).searchParams.get('days')) || 30
    const { from, to, q } = rangeQuery(days)
    const [events, agents] = await Promise.all([
      collectorGet<{ total?: number; events?: ObsEvent[] }>(
        '/v0/analytics/events',
        `${q}&limit=500`,
        collectorOpts,
      ),
      collectorGet<{ site_label?: string; agents?: AgentStat[] }>(
        '/v0/analytics/agents',
        q,
        collectorOpts,
      ),
    ])
    const evs = events.events || []
    return NextResponse.json({
      updatedAt: new Date().toISOString(),
      site_label: agents.site_label || site.siteName,
      source: 'live',
      range: { from, to },
      agents: agents.agents || [],
      events: evs,
      truncated: Number(events.total || 0) > evs.length,
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'collector fetch failed'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
