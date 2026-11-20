/**
 * GET /api/aiseo/overview
 *
 * Returns integrated AISEO Overview:
 *   1. GA4 / ClickHouse AI Search Inflow Analytics (ChatGPT, Perplexity, Gemini, Claude, Copilot, Google AIO/SGE)
 *   2. Organic vs AI CVR multiplier & Top AI landing URL ranking
 *   3. LINKTH CRAWL SERP AI Overview (`aio_citation_diff`) competitor citation gap
 *   4. Page-type adaptive 16-item x 7-pillar Semantic AI Audit (`semanticAudit`)
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { getAiseoOverview } from '@/lib/aiseo/ga4-ai-traffic'
import { getClickHouseClient } from '@/lib/clickhouse'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  let active
  try {
    active = await requireActiveTenantSite(req)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'UNAUTHORIZED'
    const status = msg.startsWith('FORBIDDEN') ? 403 : 401
    return NextResponse.json({ error: msg }, { status })
  }
  const { ctx, site } = active
  const sp = req.nextUrl.searchParams
  const defaultHost = site.canonicalHost || 'link-th.com'
  const rawUrl =
    sp.get('url') || `https://${defaultHost}/entry/internal-link-optimization`
  const days = Math.min(90, Math.max(7, Number(sp.get('days') || 30)))

  const ch =
    process.env.CLICKHOUSE_URL && process.env.CLICKHOUSE_PASSWORD
      ? getClickHouseClient('analytics_reader')
      : null

  const overview = await getAiseoOverview({
    tenantId: ctx.tenant_id,
    siteId: site.siteId,
    url: rawUrl,
    host: defaultHost,
    days,
    clickhouse: ch,
  })

  return NextResponse.json({
    ok: true,
    tenantId: ctx.tenant_id,
    site: {
      siteId: site.siteId,
      canonicalHost: site.canonicalHost,
      gscProperty: site.gscProperty,
      linkscrawlJobId: site.linkscrawlJobId,
      aireceiptSiteId: site.aireceiptSiteId,
    },
    ...overview,
  })
}
