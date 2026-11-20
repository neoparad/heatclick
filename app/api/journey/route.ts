/**
 * GET /api/journey — collector の個別イベント（時系列）＋エージェント一覧を返す。
 *
 * Wave 0 (束 0-A 止血):
 *   - collector 未接続時のモック返却 (`generateMockJourney`) を完全廃止。
 *   - 未設定時は `status: 'not_collected'`, `source: 'not_collected'` と空配列を返す。
 */

import { NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { collectorConfigured, collectorGet, rangeQuery } from '@/lib/aiseo/collector'
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
  const days = Number(new URL(request.url).searchParams.get('days')) || 30
  const { from, to, q } = rangeQuery(days)
  const collectorOpts = {
    siteId: site.aireceiptSiteId ?? undefined,
    installId: site.aireceiptInstallId ?? undefined,
  }

  if (!collectorConfigured(collectorOpts)) {
    return NextResponse.json({
      status: 'not_collected',
      reason: 'AIreceipt collector が未設定のためエージェント・ジャーニーは未収集です (not_collected)',
      updatedAt: new Date().toISOString(),
      site_label: site.siteName,
      source: 'not_collected',
      range: { from, to },
      agents: [],
      events: [],
      truncated: false,
    })
  }

  try {
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
      status: 'ok',
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
