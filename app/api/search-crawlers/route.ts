/**
 * GET /api/search-crawlers — 検索エンジンのクローラー（Googlebot・Bingbot 系）の取得。
 * 2つの取得経路を別々に返し、合算しない:
 *   cloudflare … Cloudflare 連携（エッジで集計。キャッシュ分も含む。名乗りの UA のみ）
 *   collector  … サーバ側の記録（WordPress プラグイン r2 以降。PHP を通った分のみ）
 */

import { NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { cloudflareConfigured, fetchSearchCrawlers } from '@/lib/aiseo/cloudflare'
import { collectorConfigured, collectorGet, rangeQuery } from '@/lib/aiseo/collector'
import type { AgentStat } from '@/lib/aiseo/risk'

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
  const days = Number(new URL(request.url).searchParams.get('days')) || 7
  const cfOpts = { zoneId: site.cfZoneId ?? undefined }
  const colOpts = {
    siteId: site.aireceiptSiteId ?? undefined,
    installId: site.aireceiptInstallId ?? undefined,
  }

  const [cloudflare, collector] = await Promise.all([
    fromCloudflare(days, cfOpts),
    fromCollector(days, colOpts),
  ])

  return NextResponse.json({
    fetched_at: new Date().toISOString(),
    site_label: site.siteName,
    cloudflare,
    collector,
  })
}

async function fromCloudflare(days: number, cfOpts: { zoneId?: string }) {
  if (!cloudflareConfigured(cfOpts)) return { configured: false }
  try {
    return { configured: true, ...(await fetchSearchCrawlers(days, cfOpts)) }
  } catch (e: unknown) {
    return { configured: true, error: e instanceof Error ? e.message : String(e) }
  }
}

async function fromCollector(
  days: number,
  colOpts: { siteId?: string; installId?: string },
) {
  if (!collectorConfigured(colOpts)) return { configured: false }
  try {
    const { q } = rangeQuery(days)
    const a = await collectorGet<{ agents?: AgentStat[] }>(
      '/v0/analytics/agents',
      q,
      colOpts,
    )
    const agents = (a.agents || []).filter((x) => x.category === 'web_search')
    return { configured: true, agents }
  } catch (e: unknown) {
    return { configured: true, error: e instanceof Error ? e.message : String(e) }
  }
}
