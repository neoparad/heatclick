/**
 * GET /api/heatmap/agent-insights?site_id=...&url=...&device=...&agent_subtype=...
 *
 * Returns hybrid insights for the Browser-Operating AI Agent Heatmap:
 *   1. `summary`: Agent session counts, top agent subtypes, average scroll depth, targeted CTAs
 *   2. `frictionHotspots`: DOM elements where browser-operating AI agents (Playwright / Operator / HeadlessChrome)
 *      experienced dead-click or rage-click friction, with ARIA / semantic HTML remediation.
 *   3. `crawlerSectionOverlays`: Vertical Y-coordinate bands showing HTTP AI crawler (`GPTBot` / `ClaudeBot`)
 *      section extractability (`extracted` | `csr_blind_spot` | `chunk_corrupted`).
 *   4. `subtypeCounts`: Per-subtype session breakdown.
 */

import { NextResponse } from 'next/server'
import {
  buildAgentHybridInsights,
  fetchAgentBehaviorSummary,
  fetchAgentHeatmapPoints,
  parseAgentSubtype,
} from '@/lib/heatmap/agent-heatmap-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams
  const siteId = (sp.get('site_id') || 'default').trim() || 'default'
  const pageUrl = (sp.get('url') || sp.get('page_url') || 'https://bihadashop.jp/').trim()
  const device = (sp.get('device') || sp.get('device_type') || 'desktop').trim()
  const agentSubtype = parseAgentSubtype(sp.get('agent_subtype'))

  try {
    const [rawPoints, rawSummary] = await Promise.all([
      fetchAgentHeatmapPoints({
        siteId,
        pageUrl,
        deviceType: device,
        agentSubtype,
      }),
      fetchAgentBehaviorSummary({
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
      data: {
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
