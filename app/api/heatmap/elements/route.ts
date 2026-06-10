/**
 * GET /api/heatmap/elements — 要素単位クリック集計 + 行動シグナル (続123)
 *
 * 親 SSOT §3.6.5 / §3.8.1 / mockup `01_heatmap_canvas.html` (.hs-card / .sig-marker)
 *
 * 目的: 右パネルの「ホットスポット (強度順)」を仮置き (クリック密集 #N / DOM selector 未取得)
 * から **本物の要素カード** (element_selector + element_text + 実クリック数) に置き換える。
 * 併せて rage_click / dead_click をページ単位で集計し、シグナルタブ + キャンバスマーカーを
 * 実データ化する。
 *
 * データ実在確認 (2026-06-10 probe): tirtir ページ 14d で click 649 件全件に element_selector、
 * 71% に element_text。dead_click 561 (333 sessions) / rage_click 10 (selector 付き 99%)。
 *
 * 座標系: x = 1280 正規化 (tile API click と同一)、y = document 絶対 CSS px。
 * tenant isolation: getServerSession (Layer 2 失効照合, REQ-SEC-126) + site_ids 包含 +
 * 全クエリ parameter binding で tenant_id 強制。
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { getServerSession } from '@/lib/auth/server-session'
import { getClickHouseClient } from '@/lib/clickhouse'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const querySchema = z.object({
  site_id: z.string().min(1).max(128),
  page_url: z.string().url().max(2000),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  device_type: z.enum(['desktop', 'mobile', 'tablet', 'unknown']).optional(),
  // 続125: 行動セグメント (tile API と同一定義)
  segment: z.enum(['all', 'deep_read', 'bounce', 'ad']).default('all'),
})

/**
 * 続125: 行動セグメントの session 絞り込み SQL 断片 (app/api/heatmap/route.ts と同一規約:
 * 定数断片 + parameter binding のみ、ユーザー入力の文字列連結なし)。
 */
function segmentFilterSql(segment: 'all' | 'deep_read' | 'bounce' | 'ad'): string {
  if (segment === 'all') return ''
  if (segment === 'ad') {
    return `AND session_id IN (
      SELECT DISTINCT session_id FROM clickinsight.events
      WHERE tenant_id = {tenant_id:String}
        AND site_id = {site_id:String}
        AND url = {page_url:String}
        AND is_agent = 0
        AND ((gclid IS NOT NULL AND gclid != '') OR (fbclid IS NOT NULL AND fbclid != ''))
        AND timestamp >= toDateTime({start:String})
        AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
    )`
  }
  const havingCond =
    segment === 'deep_read' ? 'max(scroll_percentage) >= 70' : 'max(scroll_percentage) <= 20'
  return `AND session_id IN (
    SELECT session_id FROM clickinsight.events
    WHERE tenant_id = {tenant_id:String}
      AND site_id = {site_id:String}
      AND url = {page_url:String}
      AND is_agent = 0
      AND timestamp >= toDateTime({start:String})
      AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
    GROUP BY session_id
    HAVING ${havingCond}
  )`
}

const TOP_ELEMENTS_LIMIT = 6
/** signal selector 上位 (マーカー描画 + whereLabel)。type 毎にこの件数まで。 */
const TOP_SIGNALS_PER_TYPE = 12

interface ElementRow {
  selector: string
  text: string
  tag: string
  href: string
  clicks: number
  sessions: number
  x: number
  y: number
}

interface SignalRow {
  event_type: 'rage_click' | 'dead_click'
  selector: string
  text: string
  count: number
  sessions: number
  x: number
  y: number
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const parsed = querySchema.safeParse({
    site_id: url.searchParams.get('site_id') ?? undefined,
    page_url: url.searchParams.get('page_url') ?? undefined,
    start_date: url.searchParams.get('start_date') ?? undefined,
    end_date: url.searchParams.get('end_date') ?? undefined,
    device_type: url.searchParams.get('device_type') ?? undefined,
    segment: url.searchParams.get('segment') ?? undefined,
  })
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'invalid request' },
      },
      { status: 400 },
    )
  }
  const params = parsed.data

  // tenant 検証 — REQ-SEC-126: getServerSession 経由で Layer 2 失効照合を通す
  const session = await getServerSession()
  if (!session) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAUTHORIZED', message: 'tenant context missing' } },
      { status: 401 },
    )
  }
  if (!session.user.site_ids.includes(params.site_id)) {
    return NextResponse.json(
      { success: false, error: { code: 'TENANT_FORBIDDEN', message: 'site not in tenant' } },
      { status: 403 },
    )
  }

  const deviceFilter = params.device_type ? `AND device_type = {device_type:String}` : ''
  const segmentFilter = segmentFilterSql(params.segment)
  const queryParams: Record<string, string> = {
    tenant_id: session.tenant_id,
    site_id: params.site_id,
    page_url: params.page_url,
    start: params.start_date ?? '1970-01-01',
    end: params.end_date ?? '2099-12-31',
  }
  if (params.device_type) queryParams.device_type = params.device_type

  try {
    const ch = getClickHouseClient('analytics_reader')

    // 1) 要素単位 click 集計 (上位 N)。x は 1280 正規化 / y は document 絶対 CSS px。
    const elementsRs = await ch.query({
      query: `
        SELECT
          element_selector AS selector,
          anyLast(element_text) AS text,
          anyLast(element_tag_name) AS tag,
          anyLast(element_href) AS href,
          count() AS clicks,
          uniqExact(session_id) AS sessions,
          toUInt16(least(1280, greatest(0, round(avg(if(viewport_width > 0, click_x * 1280 / viewport_width, click_x)))))) AS x,
          toUInt32(round(avg(click_y))) AS y
        FROM clickinsight.events
        WHERE tenant_id = {tenant_id:String}
          AND site_id = {site_id:String}
          AND url = {page_url:String}
          AND event_type = 'click'
          AND is_agent = 0
          AND element_selector != ''
          AND timestamp >= toDateTime({start:String})
          AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
          ${deviceFilter}
          ${segmentFilter}
        GROUP BY selector
        ORDER BY clicks DESC
        LIMIT ${TOP_ELEMENTS_LIMIT}
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    })
    const elementRows = (await elementsRs.json()) as ElementRow[]

    // 2) シグナル (rage_click / dead_click) selector 別上位
    const signalsRs = await ch.query({
      query: `
        SELECT
          event_type,
          element_selector AS selector,
          anyLast(element_text) AS text,
          count() AS count,
          uniqExact(session_id) AS sessions,
          toUInt16(least(1280, greatest(0, round(avg(if(viewport_width > 0, click_x * 1280 / viewport_width, click_x)))))) AS x,
          toUInt32(round(avg(click_y))) AS y
        FROM clickinsight.events
        WHERE tenant_id = {tenant_id:String}
          AND site_id = {site_id:String}
          AND url = {page_url:String}
          AND event_type IN ('rage_click', 'dead_click')
          AND is_agent = 0
          AND timestamp >= toDateTime({start:String})
          AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
          ${deviceFilter}
          ${segmentFilter}
        GROUP BY event_type, selector
        ORDER BY count DESC
        LIMIT 100
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    })
    const signalRows = (await signalsRs.json()) as SignalRow[]

    const signals = (['rage_click', 'dead_click'] as const).map((et) => {
      const rows = signalRows.filter((r) => r.event_type === et)
      return {
        type: et === 'rage_click' ? ('rage' as const) : ('dead' as const),
        count: rows.reduce((s, r) => s + Number(r.count), 0),
        sessions: rows.reduce((s, r) => s + Number(r.sessions), 0),
        top: rows.slice(0, TOP_SIGNALS_PER_TYPE).map((r) => ({
          selector: r.selector,
          text: r.text,
          count: Number(r.count),
          x: Number(r.x),
          y: Number(r.y),
        })),
      }
    })

    return NextResponse.json(
      {
        success: true,
        data: {
          elements: elementRows.map((r) => ({
            selector: r.selector,
            text: r.text,
            tag: r.tag,
            href: r.href,
            clicks: Number(r.clicks),
            sessions: Number(r.sessions),
            x: Number(r.x),
            y: Number(r.y),
          })),
          signals,
        },
      },
      // 集計はリアルタイム性不要。ブラウザ private cache 2 分で再ナビを軽くする。
      { headers: { 'Cache-Control': 'private, max-age=120' } },
    )
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown'
    // ClickHouse error 詳細は client に漏らさない (credentials を含む経路を遮断)
    console.error(`[heatmap/elements] query failed: ${msg}`)
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL', message: 'elements query failed' } },
      { status: 502 },
    )
  }
}
