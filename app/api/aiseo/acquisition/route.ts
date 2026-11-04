/**
 * GET /api/aiseo/acquisition?site_id=...&url=...
 *
 * Returns a `CrawlerPageAcquisitionReport` explaining what HTTP AI crawlers
 * (`GPTBot`, `ClaudeBot`, `PerplexityBot`, `OAI-SearchBot`, `Google-Extended`)
 * actually extracted on the target URL vs what was missed due to CSR / DOM issues,
 * along with copyable HTML / JSON-LD remediation patches.
 */

import { NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { analyzeCrawlerPageAcquisition } from '@/lib/aiseo/crawler-acquisition'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams
  const rawUrl = (sp.get('url') || '').trim()
  if (!rawUrl) {
    return NextResponse.json(
      { ok: false, error: 'url query parameter is required' },
      { status: 400 },
    )
  }

  let siteId = (sp.get('site_id') || '').trim()
  if (!siteId) {
    try {
      const active = await requireActiveTenantSite(request)
      siteId = active.site.siteId
    } catch {
      siteId = 'default'
    }
  }

  try {
    const report = await analyzeCrawlerPageAcquisition({
      siteId: siteId || 'default',
      url: rawUrl,
    })
    return NextResponse.json({
      ok: true,
      data: report,
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'failed to analyze crawler page acquisition'
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    )
  }
}
