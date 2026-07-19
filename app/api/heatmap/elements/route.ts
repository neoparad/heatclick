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
import { segmentFilterSql } from '@/lib/heatmap/segment-filter'
import { canonicalizeHeatmapUrl, canonicalUrlSql } from '@/lib/heatmap/canonical-url'
import { createRouteTimer, type RouteTimer } from '@/lib/perf/server-timing'

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
  segment: z.enum(['all', 'deep_read', 'bounce', 'ad', 'returning', 'new']).default('all'),
})

/**
 * ClickHouse エラー文字列を、credentials を含まない安全な分類コードに変換する (続135 P0 可視化)。
 * raw メッセージは password 等を含み得るため UI/response には出さない。
 */
function classifyChError(msg: string): string {
  const m = msg.toLowerCase()
  if (m.includes('not enough privileges') || m.includes('access_denied') || m.includes('grant')) {
    return 'permission'
  }
  if (m.includes('authentication') || m.includes('password')) return 'auth'
  if (m.includes('timeout') || m.includes('timed out') || m.includes('max_execution')) {
    return 'timeout'
  }
  if (m.includes("doesn't exist") || m.includes('unknown table') || m.includes('unknown_table')) {
    return 'missing_table'
  }
  if (m.includes('memory') || m.includes('memory_limit')) return 'memory'
  return 'query_error'
}

const TOP_ELEMENTS_LIMIT = 6
/** signal selector 上位 (マーカー描画 + whereLabel)。type 毎にこの件数まで。 */
const TOP_SIGNALS_PER_TYPE = 12
/** 画像視認率 (続126 ⑤): 上位画像の件数 */
const TOP_IMAGES_LIMIT = 12
/** 構造 issue (続126 ★クロール価値): 上位 issue の件数 */
const TOP_ISSUES_LIMIT = 8

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

// ── P0 計測 (docs/heatmap/SONNET_PROMPT_P0_instrumentation_2026-07-19.md §3) ──
// 挙動変更ゼロ (絶対条件1): 以下 helper は計測専用でレスポンス body/status を変えない。

/** CH query_log 突合用 log_comment。URL・tenant 値は含めない (絶対条件5)。 */
function perfLogComment(route: string, span: string, reqId: string): { log_comment: string } {
  try {
    return { log_comment: JSON.stringify({ app: 'heatmap', route, span, req: reqId }) }
  } catch {
    return { log_comment: '' }
  }
}

/** 既存の NextResponse.json 呼び出しに Server-Timing ヘッダ + 計測ログを足すだけの薄いラッパ。 */
function jsonWithTiming(
  t: RouteTimer,
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): NextResponse {
  // eslint-disable-next-line no-console
  console.info(t.logLine())
  return NextResponse.json(body, {
    ...init,
    headers: { ...(init.headers ?? {}), 'Server-Timing': t.headerValue() },
  })
}

export async function GET(request: Request) {
  // P0 計測: レスポンス内容・ステータスには影響しない (絶対条件1)。
  const t = createRouteTimer('heatmap-elements')
  const reqId = t.reqId()
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
    return jsonWithTiming(
      t,
      {
        success: false,
        error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'invalid request' },
      },
      { status: 400 },
    )
  }
  const params = parsed.data
  // 続135: URL を canonical 化 (query/fragment 除去)。variant 分散で要素/画像視認率が空になるのを防ぐ。
  params.page_url = canonicalizeHeatmapUrl(params.page_url)

  // tenant 検証 — REQ-SEC-126: getServerSession 経由で Layer 2 失効照合を通す
  const session = await t.span('auth', async () => getServerSession())
  if (!session) {
    return jsonWithTiming(
      t,
      { success: false, error: { code: 'UNAUTHORIZED', message: 'tenant context missing' } },
      { status: 401 },
    )
  }
  if (!session.user.site_ids.includes(params.site_id)) {
    return jsonWithTiming(
      t,
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
    const elementRows = await t.span('ch-elements', async () => {
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
          AND ${canonicalUrlSql('url')} = {page_url:String}
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
        clickhouse_settings: perfLogComment('heatmap-elements', 'ch-elements', reqId),
      })
      return (await elementsRs.json()) as ElementRow[]
    })

    // 2) シグナル (rage_click / dead_click) selector 別上位
    const signalRows = await t.span('ch-signals', async () => {
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
          AND ${canonicalUrlSql('url')} = {page_url:String}
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
        clickhouse_settings: perfLogComment('heatmap-elements', 'ch-signals', reqId),
      })
      return (await signalsRs.json()) as SignalRow[]
    })

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

    // 3) ページ全体セッション数 (続126 ★: 要素クリック率の分母)
    const pageSessions = await t.span('ch-sessions', async () => {
      const pageSessionsRs = await ch.query({
        query: `
        SELECT uniqExact(session_id) AS sessions
        FROM clickinsight.events
        WHERE tenant_id = {tenant_id:String}
          AND site_id = {site_id:String}
          AND ${canonicalUrlSql('url')} = {page_url:String}
          AND is_agent = 0
          AND timestamp >= toDateTime({start:String})
          AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
          ${deviceFilter}
          ${segmentFilter}
      `,
        query_params: queryParams,
        format: 'JSONEachRow',
        clickhouse_settings: perfLogComment('heatmap-elements', 'ch-sessions', reqId),
      })
      return Number(((await pageSessionsRs.json()) as Array<{ sessions: number }>)[0]?.sessions ?? 0)
    })

    // 4) 画像視認率 (続126 ⑤): image_visibility 専用テーブル。
    //    座標は median (混在 viewport の外れ値に強い)。duration は median (累積計測のため
    //    avg は跳ねる)。segment は session 単位サブクエリがそのまま適用可能。
    //
    // 続130: enhancement 系 (images / issues) は **個別 try/catch で [] に degrade**。
    //    本番 analytics_reader に image_visibility の SELECT grant が無く 497 が出ると
    //    route 全体が 502 になり、要素カード/ネガティブ/構造タブまで巻き添え全滅していた
    //    (query_log 実証)。core (elements/signals) は enhancement の欠落で死なない。
    type ImageRow = {
      src: string
      alt: string
      sessions: number
      views: number
      avg_ratio: number
      median_ms: number
      y: number
      w: number
      h: number
    }
    let imageRows: ImageRow[] = []
    let imagesError: string | null = null
    try {
      imageRows = await t.span('ch-images', async () => {
        const imagesRs = await ch.query({
          query: `
          SELECT
            image_src AS src,
            anyLast(image_alt) AS alt,
            uniqExact(session_id) AS sessions,
            count() AS views,
            round(avg(max_visible_ratio), 3) AS avg_ratio,
            toUInt32(round(quantile(0.5)(visible_duration_ms))) AS median_ms,
            toUInt32(round(quantile(0.5)(image_y))) AS y,
            toUInt16(round(quantile(0.5)(image_width))) AS w,
            toUInt16(round(quantile(0.5)(image_height))) AS h
          FROM clickinsight.image_visibility
          WHERE tenant_id = {tenant_id:String}
            AND site_id = {site_id:String}
            AND ${canonicalUrlSql('page_url')} = {page_url:String}
            AND created_at >= toDateTime({start:String})
            AND created_at < toDateTime({end:String}) + INTERVAL 1 DAY
            ${params.device_type ? 'AND device_type = {device_type:String}' : ''}
            ${segmentFilter}
          GROUP BY src
          ORDER BY sessions DESC
          LIMIT ${TOP_IMAGES_LIMIT}
        `,
          query_params: queryParams,
          format: 'JSONEachRow',
          clickhouse_settings: perfLogComment('heatmap-elements', 'ch-images', reqId),
        })
        return (await imagesRs.json()) as ImageRow[]
      })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message.split('\n')[0] : 'unknown'
      // 続135 (P0 可視化): 失敗を silent [] にせず分類コードで surface する。
      //   「画像が出ない」が image_visibility クエリ失敗 (overlay) なのか、本当にデータ0 なのかを
      //   実機 Network で切り分け可能にする。raw msg は credentials 流出経路になり得るため出さない。
      imagesError = classifyChError(msg)
      console.error(`[heatmap/elements] image_visibility degraded to []: ${msg}`)
    }

    // 5) 構造 issue (続126 ★クロール価値): UGOKI Crawl が取り込んだ page_issues。
    //    クロール未取込ページは 0 行 = UI は「クロール未取込」を表示 (graceful)。
    //    続130: images と同様、grant 欠落等は [] に degrade (core を巻き込まない)。
    type IssueRow = {
      issue_category: string
      issue_type: string
      severity: string | number
      n: number
      recommendation: string
    }
    let issueRows: IssueRow[] = []
    try {
      issueRows = await t.span('ch-issues', async () => {
        const issuesRs = await ch.query({
          query: `
          SELECT
            issue_category,
            issue_type,
            severity,
            count() AS n,
            anyLast(substring(recommendation, 1, 200)) AS recommendation
          FROM clickinsight.page_issues
          WHERE tenant_id = {tenant_id:String}
            AND site_id = {site_id:String}
            AND ${canonicalUrlSql('page_url')} = {page_url:String}
          GROUP BY issue_category, issue_type, severity
          ORDER BY severity DESC, n DESC
          LIMIT ${TOP_ISSUES_LIMIT}
        `,
          query_params: queryParams,
          format: 'JSONEachRow',
          clickhouse_settings: perfLogComment('heatmap-elements', 'ch-issues', reqId),
        })
        return (await issuesRs.json()) as IssueRow[]
      })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message.split('\n')[0] : 'unknown'
      console.error(`[heatmap/elements] page_issues degraded to []: ${msg}`)
    }

    return jsonWithTiming(
      t,
      {
        success: true,
        data: {
          page_sessions: pageSessions,
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
          images: imageRows.map((r) => ({
            src: r.src,
            alt: r.alt,
            sessions: Number(r.sessions),
            views: Number(r.views),
            avg_ratio: Number(r.avg_ratio),
            median_ms: Number(r.median_ms),
            y: Number(r.y),
            w: Number(r.w),
            h: Number(r.h),
          })),
          issues: issueRows.map((r) => ({
            category: r.issue_category,
            type: r.issue_type,
            severity: String(r.severity),
            count: Number(r.n),
            recommendation: r.recommendation,
          })),
          // 続135 (P0 可視化): enhancement の失敗/空を UI と実機 Network で区別可能にする診断。
          //   imagesError != null = image_visibility クエリ自体が失敗 (overlay 欠落の真因)。
          //   imagesError == null かつ images=[] = 当該条件で実データ 0 件 (正常な空)。
          diagnostics: {
            imagesError,
            imagesCount: imageRows.length,
          },
        },
      },
      // 集計はリアルタイム性不要。ブラウザ private cache 2 分で再ナビを軽くする。
      { headers: { 'Cache-Control': 'private, max-age=120' } },
    )
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown'
    // ClickHouse error 詳細は client に漏らさない (credentials を含む経路を遮断)
    console.error(`[heatmap/elements] query failed: ${msg}`)
    return jsonWithTiming(
      t,
      { success: false, error: { code: 'INTERNAL', message: 'elements query failed' } },
      { status: 502 },
    )
  }
}
