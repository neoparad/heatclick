/**
 * GET /api/heatmap/page-stats — page-level PV / sessions / CTR / scroll-path-rate 集計
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04 / 続 82 Frontend Sprint 4 W1 handoff §2.2
 *
 * Purpose:
 *   PageStatsBar (heatmap page 上端の URL バー右側 stats) のデータソース。
 *
 * Tenant isolation (§3.8.1):
 *   - middleware が x-tenant-id / x-site-ids を inject 済 (route で再検証)
 *   - cross-tenant site_id 指定は 403 + audit (middleware で `cross_tenant_attempted`)
 *
 * ClickHouse query: events table を直接集約 (Sprint 4 W2 で events_hourly_by_dim 切替予定)。
 *   - PV       = count(event_type = 'page_view')
 *   - sessions = uniqExact(session_id)
 *   - clicks   = count(event_type = 'click')
 *   - CTR      = clicks / page_views (page_views > 0 のときのみ)
 *   - 到達率   = scroll_y > 50% session 数 / 全 session
 *               (scroll event が無い tenant では null 返却、PageStatsBar 側で表示抑止)
 *
 * 続 82 Infra deploy 待ち状態でも本 route は動作する (旧 v1 event のみで PV/sessions/CTR 算出可能)。
 * scroll-path-rate は scroll event が必要だが、無くても null gracefulfallback。
 */

import { createHash } from 'node:crypto'

import { getServerSession } from '@/lib/auth/server-session'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { getClickHouseClient } from '@/lib/clickhouse'
import { canonicalizeHeatmapUrl, canonicalUrlSql } from '@/lib/heatmap/canonical-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const querySchema = z.object({
  site_id: z.string().min(1).max(128),
  page_url: z.string().url().max(2000),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  device_type: z.enum(['desktop', 'mobile', 'tablet', 'unknown', 'all']).optional(),
})

interface PageStatsRow {
  page_views: number
  sessions: number
  clicks: number
  scroll_sessions_over_50pct: number | null
}

interface PageStatsResponse {
  page_views: number
  sessions: number
  ctr: number | null
  scroll_path_rate: number | null
  evidence_level: 'observed_exact' | 'observed_approx'
}

function tenantHasSite(headerSiteIds: string | null, siteId: string): boolean {
  if (!headerSiteIds) return false
  return headerSiteIds.split(',').map((s) => s.trim()).includes(siteId)
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const parsed = querySchema.safeParse({
    site_id: url.searchParams.get('site_id') ?? undefined,
    page_url: url.searchParams.get('page_url') ?? undefined,
    start_date: url.searchParams.get('start_date') ?? undefined,
    end_date: url.searchParams.get('end_date') ?? undefined,
    device_type: url.searchParams.get('device_type') ?? undefined,
  })

  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'BAD_REQUEST',
          message: parsed.error.issues[0]?.message ?? 'invalid request',
        },
      },
      { status: 400 },
    )
  }
  const params = parsed.data
  // 続135: URL を canonical 化 (query/fragment 除去)。PV/CTR/到達率の variant 分散を防ぐ。
  params.page_url = canonicalizeHeatmapUrl(params.page_url)

  // tenant 検証 — REQ-SEC-126 (§13.7): getServerSession 経由で Layer 2 失効照合を通す
  const session = await getServerSession()
  const tenantId = session?.tenant_id ?? null
  const siteIds = session ? session.user.site_ids.join(',') : null
  if (!tenantId) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAUTHORIZED', message: 'tenant context missing' } },
      { status: 401 },
    )
  }
  if (!tenantHasSite(siteIds, params.site_id)) {
    return NextResponse.json(
      { success: false, error: { code: 'TENANT_FORBIDDEN', message: 'site not in tenant' } },
      { status: 403 },
    )
  }

  // URL hash for log correlation (PII 縮小、生 URL は log に流さない)
  const queryHash = createHash('sha256')
    .update(`${tenantId}|${params.site_id}|${params.page_url}|${params.start_date}|${params.end_date}|${params.device_type ?? ''}`)
    .digest('hex')
    .slice(0, 16)

  try {
    const ch = getClickHouseClient('analytics_reader')
    const deviceFilter =
      params.device_type && params.device_type !== 'all'
        ? `AND device_type = {device_type:String}`
        : ''

    // 2026-05-29 Director hot fix:
    //   - 'page_view' → 'pageview' (events.event_type 実値、tracking.js v2 仕様)
    //   - scroll_y_pct → scroll_percentage (events 列名、UInt8 0-100)
    //   - SETTINGS max_execution_time 削除: analytics_reader は READONLY ユーザーで
    //     SETTINGS 修正不可 (code 164 READONLY)、CH default timeout で十分
    const sql = `
      SELECT
        countIf(event_type = 'pageview') AS page_views,
        uniqExact(session_id) AS sessions,
        countIf(event_type = 'click') AS clicks,
        nullIf(uniqExactIf(session_id, event_type = 'scroll' AND scroll_percentage >= 50), 0) AS scroll_sessions_over_50pct
      FROM clickinsight.events
      WHERE tenant_id = {tenant_id:String}
        AND site_id = {site_id:String}
        AND ${canonicalUrlSql('url')} = {page_url:String}
        AND timestamp >= toDateTime({start:String})
        AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
        ${deviceFilter}
    `

    const queryParams: Record<string, string> = {
      tenant_id: tenantId,
      site_id: params.site_id,
      page_url: params.page_url,
      start: params.start_date,
      end: params.end_date,
    }
    if (deviceFilter && params.device_type) {
      queryParams.device_type = params.device_type
    }

    const rs = await ch.query({
      query: sql,
      query_params: queryParams,
      format: 'JSONEachRow',
    })
    const rows = (await rs.json()) as PageStatsRow[]
    const row = rows[0] ?? { page_views: 0, sessions: 0, clicks: 0, scroll_sessions_over_50pct: null }

    const ctr = row.page_views > 0 ? row.clicks / row.page_views : null
    const scrollPathRate =
      row.scroll_sessions_over_50pct !== null && row.sessions > 0
        ? row.scroll_sessions_over_50pct / row.sessions
        : null

    const body: PageStatsResponse = {
      page_views: row.page_views,
      sessions: row.sessions,
      ctr,
      scroll_path_rate: scrollPathRate,
      evidence_level: 'observed_exact',
    }

    return NextResponse.json({ success: true, data: body, meta: { query_hash: queryHash } })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown error'
    // events table に `scroll_y_pct` 列が無いケース等 (Infra 続 82 deploy 前) — 縮退 query で再試行
    const isMissingColumn = message.includes('UNKNOWN_IDENTIFIER') || message.includes('not found')
    if (isMissingColumn) {
      try {
        const ch = getClickHouseClient('analytics_reader')
        // 2026-05-29 Director hot fix: 'page_view' → 'pageview' + SETTINGS 削除 (READONLY user)
        const fallbackSql = `
          SELECT
            countIf(event_type = 'pageview') AS page_views,
            uniqExact(session_id) AS sessions,
            countIf(event_type = 'click') AS clicks,
            NULL AS scroll_sessions_over_50pct
          FROM clickinsight.events
          WHERE tenant_id = {tenant_id:String}
            AND site_id = {site_id:String}
            AND ${canonicalUrlSql('url')} = {page_url:String}
            AND timestamp >= toDateTime({start:String})
            AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
        `
        const rs = await ch.query({
          query: fallbackSql,
          query_params: {
            tenant_id: tenantId,
            site_id: params.site_id,
            page_url: params.page_url,
            start: params.start_date,
            end: params.end_date,
          },
          format: 'JSONEachRow',
        })
        const rows = (await rs.json()) as Array<Omit<PageStatsRow, 'scroll_sessions_over_50pct'>>
        const row = rows[0] ?? { page_views: 0, sessions: 0, clicks: 0 }
        const ctr = row.page_views > 0 ? row.clicks / row.page_views : null
        const body: PageStatsResponse = {
          page_views: row.page_views,
          sessions: row.sessions,
          ctr,
          scroll_path_rate: null,
          evidence_level: 'observed_approx',
        }
        return NextResponse.json({
          success: true,
          data: body,
          meta: { query_hash: queryHash, fallback: 'scroll_columns_missing' },
        })
      } catch (fallbackError) {
        const fmsg = fallbackError instanceof Error ? fallbackError.message : 'unknown'
        console.error(`[page-stats] fallback also failed query_hash=${queryHash}: ${fmsg}`)
        return NextResponse.json(
          { success: false, error: { code: 'INTERNAL', message: 'page stats query failed' } },
          { status: 500 },
        )
      }
    }
    console.error(`[page-stats] query failed query_hash=${queryHash}: ${message}`)
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL', message: 'page stats query failed' } },
      { status: 500 },
    )
  }
}
