/**
 * GET /api/seo/internal-links — LINKTH CRAWL 内部リンク構造
 *
 * Wave 0 (束 0-A 止血):
 *   - LINKTH CRAWL 未接続・エラー時のモック返却 (`generateInternalLinksMock`) および `?mock=1` を完全廃止。
 *   - 未収集時は `status: 'not_collected'`, `source: 'not_collected'` + 空の構造オブジェクトを返す。
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'

export const dynamic = 'force-dynamic'

function buildNotCollectedInternalLinks(jobId: string, reason: string) {
  return {
    status: 'not_collected' as const,
    reason,
    source: 'not_collected' as const,
    jobId,
    structure: {
      total_pages: 0,
      max_depth: 0,
      orphan_count: 0,
      hub_pages: [],
      depth_distribution: {},
      directory_stats: [],
    },
    orphans: [],
  }
}

export async function GET(req: NextRequest) {
  let active
  try {
    active = await requireActiveTenantSite(req)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'UNAUTHORIZED'
    const status = msg.startsWith('FORBIDDEN') ? 403 : 401
    return NextResponse.json({ error: msg }, { status })
  }
  const { site } = active

  const sp = req.nextUrl.searchParams
  const jobId =
    sp.get('job_id') ||
    site.linkscrawlJobId ||
    process.env.LINKSCRAWL_DEFAULT_JOB_ID ||
    ''
  const baseUrl = (process.env.LINKSCRAWL_API_URL || '').replace(/\/+$/, '')

  if (!baseUrl || !jobId) {
    return NextResponse.json(
      buildNotCollectedInternalLinks(
        jobId,
        'LINKTH CRAWL API URL または対象サイトの crawl job_id が未設定のため内部リンク構造は未収集です (not_collected)',
      ),
    )
  }

  try {
    const headers: Record<string, string> = {}
    if (process.env.LINKSCRAWL_API_KEY) {
      headers['X-API-Key'] = process.env.LINKSCRAWL_API_KEY
    }
    const [structRes, issuesRes] = await Promise.all([
      fetch(`${baseUrl}/v1/jobs/${encodeURIComponent(jobId)}/structure`, {
        headers,
        cache: 'no-store',
      }),
      fetch(
        `${baseUrl}/v1/internal-links/issues/${encodeURIComponent(jobId)}?issue_type=orphan_page&limit=200`,
        {
          headers,
          cache: 'no-store',
        },
      ),
    ])

    if (!structRes.ok) {
      throw new Error(`linkscrawl structure ${structRes.status}: ${await structRes.text()}`)
    }
    const structure = await structRes.json()
    const issues = issuesRes.ok ? await issuesRes.json() : { issues: [] }

    return NextResponse.json({
      status: 'ok',
      source: 'linkscrawl',
      jobId,
      structure,
      orphans: issues.issues || [],
    })
  } catch (err) {
    const errMsg = (err as Error)?.message || String(err)
    return NextResponse.json({
      ...buildNotCollectedInternalLinks(
        jobId,
        `LINKTH CRAWL 内部リンク取得失敗のため未収集です (not_collected): ${errMsg}`,
      ),
      error: errMsg,
    })
  }
}
