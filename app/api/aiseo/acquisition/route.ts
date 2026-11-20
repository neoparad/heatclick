/**
 * GET /api/aiseo/acquisition?site_id=...&url=...
 *
 * Returns a `CrawlerPageAcquisitionReport` backed by tenant-scoped ClickHouse
 * `ai_crawler_logs` and live LINKTH CRAWL audit data.
 * Wave 0 (束 0-A 止血): 認証・テナント検証を必須化し、未収集時は `not_collected` を返す。
 */

import { NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { analyzeCrawlerPageAcquisition } from '@/lib/aiseo/crawler-acquisition'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function normalizeSiteIdRequest(request: Request): Request {
  const url = new URL(request.url)
  if ((url.searchParams.get('site_id') || '').trim().toLowerCase() === 'default') {
    url.searchParams.delete('site_id')
    return new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
    })
  }
  return request
}

export async function GET(request: Request) {
  let active
  try {
    active = await requireActiveTenantSite(normalizeSiteIdRequest(request))
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'UNAUTHORIZED'
    const status = msg.startsWith('FORBIDDEN') ? 403 : 401
    return NextResponse.json({ ok: false, error: msg }, { status })
  }

  const sp = new URL(request.url).searchParams
  const rawUrl = (sp.get('url') || '').trim()
  if (!rawUrl) {
    return NextResponse.json(
      { ok: false, error: 'url query parameter is required' },
      { status: 400 },
    )
  }

  try {
    const report = await analyzeCrawlerPageAcquisition({
      tenantId: active.ctx.tenant_id,
      siteId: active.site.siteId,
      url: rawUrl,
    })
    return NextResponse.json({
      ok: true,
      status: report.status,
      reason: report.reason,
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
