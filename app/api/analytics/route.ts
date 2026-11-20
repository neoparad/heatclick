/**
 * GET /api/analytics — AIreceipt collector read API のプロキシ（AIアクセス解析用）。
 *
 * Wave 0 (束 0-A 止血):
 *   - collector 未設定時のモック返却 (`generateMockAnalytics`) を完全廃止。
 *   - 未設定時は `status: 'not_collected'`, `source: 'not_collected'` と空配列を返す。
 */

import { NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { collectorConfigured, collectorGet, rangeQuery } from '@/lib/aiseo/collector'
import type { AgentStat, UrlStat } from '@/lib/aiseo/risk'

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
    return NextResponse.json({
      status: 'not_collected',
      reason: 'AIreceipt collector が未設定のため AI アクセス解析データは未収集です (not_collected)',
      source: 'not_collected',
      site_label: site.siteName,
      urls: { period: { dates: [] }, ruleset_version: '', total: 0, urls: [] as UrlStat[] },
      agents: { period: { dates: [] }, ruleset_version: '', total: 0, agents: [] as AgentStat[] },
      fetched_at: new Date().toISOString(),
    })
  }

  try {
    const days = Number(new URL(request.url).searchParams.get('days')) || 30
    const { q } = rangeQuery(days)
    const [urls, agents] = await Promise.all([
      collectorGet<{ period: { dates: string[] }; ruleset_version: string; total: number; urls: UrlStat[] }>(
        '/v0/analytics/urls',
        q,
        collectorOpts,
      ),
      collectorGet<{ period: { dates: string[] }; ruleset_version: string; total: number; agents: AgentStat[] }>(
        '/v0/analytics/agents',
        q,
        collectorOpts,
      ),
    ])
    return NextResponse.json({
      status: 'ok',
      source: 'live',
      site_label: site.siteName,
      urls,
      agents,
      fetched_at: new Date().toISOString(),
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'collector fetch failed'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
