/**
 * POST /api/chat/fusion
 *
 * Accepts `{ message, site_id, url }` and invokes the LINKTH CRAWL 18-Tool Autonomous Answer Engine
 * with strict citation verification (`[1]`, `[2]`, ... + HMAC-style `evidenceRef`), bridging:
 *   - LINKTH CRAWL 418-item Audit & Semantic AI Cascade
 *   - UGOKI MAP Behavior & ML 13-Tool Survival / CVR Prediction
 *   - GSC Search Analytics
 *   - GA4 AI Search Inflow & SERP AI Overview Citation Diff
 *   - AIreceipt Bot / Agent Observations
 *
 * Returns `{ ok, answer, citations, usedTools, suggestedActions, confidence, ... }`.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { queryClickHouseAiTraffic } from '@/lib/aiseo/ga4-ai-traffic'
import { getClickHouseClient } from '@/lib/clickhouse'
import { runFusionAnswerEngine } from '@/lib/linkscrawl/client'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let body: {
    message?: string
    site_id?: string
    siteId?: string
    url?: string
  } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    body = {}
  }

  // Allow `site_id` in JSON body or query string for `requireActiveTenantSite`
  const reqUrl = new URL(req.url)
  const bodySiteId = (body.site_id || body.siteId || '').trim()
  if (bodySiteId && !reqUrl.searchParams.get('site_id')) {
    reqUrl.searchParams.set('site_id', bodySiteId)
  }
  const syntheticReq = new Request(reqUrl.toString(), {
    method: req.method,
    headers: req.headers,
  })

  let active
  try {
    active = await requireActiveTenantSite(syntheticReq)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'UNAUTHORIZED'
    const status = msg.startsWith('FORBIDDEN') ? 403 : 401
    return NextResponse.json({ error: msg }, { status })
  }
  const { ctx, site } = active

  const defaultHost = site.canonicalHost || 'link-th.com'
  const targetUrl =
    (body.url || reqUrl.searchParams.get('url') || '').trim() ||
    `https://${defaultHost}/entry/internal-link-optimization`
  const message =
    (body.message || '').trim() ||
    'このページのCVRとAI検索流入（AIO引用）を最大化する最優先アクションを教えてください。'

  const ch =
    process.env.CLICKHOUSE_URL && process.env.CLICKHOUSE_PASSWORD
      ? getClickHouseClient('analytics_reader')
      : null

  const aiTrafficResult = await queryClickHouseAiTraffic({
    clickhouse: ch,
    siteId: site.siteId,
    host: defaultHost,
    days: 30,
  })
  const topAiRow = aiTrafficResult.report.bySource[0]

  const engineResult = await runFusionAnswerEngine({
    siteId: site.siteId,
    url: targetUrl,
    message,
    aiTrafficContext: {
      totalAiSessions: aiTrafficResult.report.totalAiSessions,
      totalAiConversions: aiTrafficResult.report.totalAiConversions,
      aiCvr: aiTrafficResult.report.aiCvr,
      organicCvrMultiplier: aiTrafficResult.report.aiVsOrganicCvrMultiplier,
      topSource: topAiRow?.source || 'ChatGPT',
    },
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
    ...engineResult,
  })
}
