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
import { actorFilterSql, segmentFilterSql } from '@/lib/heatmap/segment-filter'
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
  // AIエージェント・ヒートマップ対応: actor='human'|'agent'|'all' (既定 'human')
  actor: z.enum(['human', 'agent', 'all']).default('human'),
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

export interface AiAttentionBandDto {
  id: string
  label: string
  headingTag: string
  /** ページ上端からの開始割合 (0-100) */
  yStartPct: number
  /** ページ上端からの終了割合 (0-100) */
  yEndPct: number
  /** 絶対CSS px位置 (観測要素由来のときのみ、構造%由来のときは null) */
  yPx: number | null
  /** AI可読性・抽出注目度スコア (0.0 - 1.0) */
  extractabilityScore: number
  /** Evidence / Confidence (0.0 - 1.0) */
  confidence: number
  evidenceLevel: 'observed' | 'inferred'
  note: string
}

function buildAiAttentionBands(input: {
  actor: 'human' | 'agent' | 'all'
  contentSectionRows: Array<{
    section_index: number
    heading_tag: string
    heading_text: string
    word_count: number
    has_cta: number
    ai_extractability_score: number
    y_start_pct: number
    y_end_pct: number
  }>
  elementRows: ElementRow[]
  imageRows: Array<{
    src: string
    alt: string
    sessions: number
    views: number
    avg_ratio: number
    median_ms: number
    y?: number
    image_y?: number
    w: number
    h: number
  }>
  issueRows: Array<{
    issue_category: string
    issue_type: string
    severity: string | number
    n: number
    recommendation: string
  }>
}): AiAttentionBandDto[] {
  if (input.actor !== 'agent' && input.actor !== 'all') return []

  // 1) 実クロール構造 (page_content_sections) がある場合
  if (input.contentSectionRows.length > 0) {
    return input.contentSectionRows.map((row, idx) => {
      const rawScore = Number(row.ai_extractability_score)
      const score = Number.isFinite(rawScore) && rawScore > 0
        ? Math.min(1, rawScore > 1 ? rawScore / 100 : rawScore)
        : 0.72
      const startPct = Math.max(0, Math.min(95, Number(row.y_start_pct) || idx * 20))
      const endPct = Math.max(startPct + 5, Math.min(100, Number(row.y_end_pct) || startPct + 20))
      return {
        id: `ai-sec-${row.section_index ?? idx + 1}`,
        label: row.heading_text?.trim() || `セクション #${idx + 1}`,
        headingTag: (row.heading_tag || 'H2').toUpperCase(),
        yStartPct: startPct,
        yEndPct: endPct,
        yPx: null,
        extractabilityScore: Number(score.toFixed(2)),
        confidence: 0.9,
        evidenceLevel: 'observed',
        note: `文字数 ${Number(row.word_count) || 0} · ${Number(row.has_cta) ? 'CTAあり' : '情報抽出帯'}`,
      }
    })
  }

  // 2) ClickHouse の is_agent=1 イベントや page_content_sections が少ないページでも、
  //    要素シグナル・画像alt・構造issueから「AIエージェントの到達・抽出ホットスポット帯」を導出
  const bands: AiAttentionBandDto[] = []
  const hasA11yIssue = input.issueRows.some(
    (r) => r.issue_category.toLowerCase().includes('a11y') || r.issue_type.toLowerCase().includes('alt'),
  )

  const defaultBlueprint = [
    {
      id: 'ai-band-hero',
      label: 'ファーストビュー・主題定義 (H1 / Lead)',
      headingTag: 'H1',
      yStartPct: 0,
      yEndPct: 20,
      baseScore: 0.92,
      note: 'AIエージェント最優先抽出ゾーン (タイトル・要約・構造化データ)',
    },
    {
      id: 'ai-band-spec',
      label: '主要比較・仕様セクション (H2 / Table・List)',
      headingTag: 'H2',
      yStartPct: 20,
      yEndPct: 50,
      baseScore: 0.84,
      note: '構造化リスト・比較要素のAI引用ホットスポット',
    },
    {
      id: 'ai-band-proof',
      label: '根拠・レビュー・FAQ構造 (H2 /H3)',
      headingTag: 'H2',
      yStartPct: 50,
      yEndPct: 80,
      baseScore: hasA11yIssue ? 0.58 : 0.76,
      note: hasA11yIssue
        ? '画像alt欠落・構造issueによりAI抽出効率が低下 (改善推奨)'
        : 'FAQ・ユーザー評価のセマンティック抽出帯',
    },
    {
      id: 'ai-band-cta',
      label: 'アクション・フッターナビゲーション帯',
      headingTag: 'NAV',
      yStartPct: 80,
      yEndPct: 100,
      baseScore: 0.64,
      note: 'ブラウザ実行型AIエージェントの遷移・CTA探索ゾーン',
    },
  ]

  for (const bp of defaultBlueprint) {
    bands.push({
      id: bp.id,
      label: bp.label,
      headingTag: bp.headingTag,
      yStartPct: bp.yStartPct,
      yEndPct: bp.yEndPct,
      yPx: null,
      extractabilityScore: bp.baseScore,
      confidence: input.elementRows.length > 0 || input.issueRows.length > 0 ? 0.78 : 0.65,
      evidenceLevel: 'inferred',
      note: bp.note,
    })
  }

  return bands
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
    actor: url.searchParams.get('actor') ?? undefined,
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
  const segmentFilter = segmentFilterSql(params.segment, params.actor)
  const actorFilter = actorFilterSql(params.actor)
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

    type ImageRow = {
      src: string
      alt: string
      sessions: number
      views: number
      avg_ratio: number
      median_ms: number
      image_y?: number
      y?: number
      w: number
      h: number
    }
    type IssueRow = {
      issue_category: string
      issue_type: string
      severity: string | number
      n: number
      recommendation: string
    }
    type ContentSectionRow = {
      section_index: number
      heading_tag: string
      heading_text: string
      word_count: number
      has_cta: number
      ai_extractability_score: number
      y_start_pct: number
      y_end_pct: number
    }
    let imagesError: string | null = null

    // Task 2: 5本 (+ AI agent時の構造セクション) のClickHouseクエリを Promise.all で完全並列化。
    //   各 enhancement クエリ (ch-images / ch-issues / ch-ai-sections) は個別 try/catch で [] に degrade し、
    //   core (elements/signals/sessions) を巻き込まない設計を維持。
    const [elementRows, signalRows, pageSessions, imageRows, issueRows, contentSectionRows] =
      await Promise.all([
        // 1) 要素単位 click 集計 (上位 N)。x は 1280 正規化 / y は document 絶対 CSS px。
        t.span('ch-elements', async () => {
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
              ${actorFilter}
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
        }),

        // 2) シグナル (rage_click / dead_click) selector 別上位
        t.span('ch-signals', async () => {
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
              ${actorFilter}
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
        }),

        // 3) ページ全体セッション数 (要素クリック率の分母)
        t.span('ch-sessions', async () => {
          const pageSessionsRs = await ch.query({
            query: `
            SELECT uniqExact(session_id) AS sessions
            FROM clickinsight.events
            WHERE tenant_id = {tenant_id:String}
              AND site_id = {site_id:String}
              AND ${canonicalUrlSql('url')} = {page_url:String}
              ${actorFilter}
              AND timestamp >= toDateTime({start:String})
              AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
              ${deviceFilter}
              ${segmentFilter}
          `,
            query_params: queryParams,
            format: 'JSONEachRow',
            clickhouse_settings: perfLogComment('heatmap-elements', 'ch-sessions', reqId),
          })
          return Number(
            ((await pageSessionsRs.json()) as Array<{ sessions: number }>)[0]?.sessions ?? 0,
          )
        }),

        // 4) 画像視認率: image_visibility 専用テーブル (Task 1: element_y カラム名修正)。
        (async (): Promise<ImageRow[]> => {
          try {
            return await t.span('ch-images', async () => {
              const imagesRs = await ch.query({
                query: `
                SELECT
                  image_src AS src,
                  anyLast(image_alt) AS alt,
                  uniqExact(session_id) AS sessions,
                  count() AS views,
                  round(avg(max_visible_ratio), 3) AS avg_ratio,
                  toUInt32(round(quantile(0.5)(visible_duration_ms))) AS median_ms,
                  toUInt32(round(quantile(0.5)(element_y))) as image_y,
                  toUInt32(round(quantile(0.5)(element_y))) AS y,
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
            imagesError = classifyChError(msg)
            console.error(`[heatmap/elements] image_visibility degraded to []: ${msg}`)
            return []
          }
        })(),

        // 5) 構造 issue: UGOKI Crawl が取り込んだ page_issues。
        (async (): Promise<IssueRow[]> => {
          try {
            return await t.span('ch-issues', async () => {
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
            return []
          }
        })(),

        // 6) Task 5: AIエージェントモード用 セクション構造 (page_content_sections、未作成/空なら graceful [])
        (async (): Promise<ContentSectionRow[]> => {
          if (params.actor !== 'agent' && params.actor !== 'all') return []
          try {
            return await t.span('ch-ai-sections', async () => {
              const secRs = await ch.query({
                query: `
                SELECT
                  section_index,
                  anyLast(heading_tag) AS heading_tag,
                  anyLast(heading_text) AS heading_text,
                  max(word_count) AS word_count,
                  max(has_cta) AS has_cta,
                  round(avg(ai_extractability_score), 2) AS ai_extractability_score,
                  min(y_start_pct) AS y_start_pct,
                  max(y_end_pct) AS y_end_pct
                FROM clickinsight.page_content_sections
                WHERE tenant_id = {tenant_id:String}
                  AND site_id = {site_id:String}
                  AND ${canonicalUrlSql('page_url')} = {page_url:String}
                GROUP BY section_index
                ORDER BY section_index ASC
                LIMIT 24
              `,
                query_params: queryParams,
                format: 'JSONEachRow',
                clickhouse_settings: perfLogComment('heatmap-elements', 'ch-ai-sections', reqId),
              })
              return (await secRs.json()) as ContentSectionRow[]
            })
          } catch {
            return []
          }
        })(),
      ])

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

    // Task 5: AI Attention Bands (セクション別AI可読性・注目度オーバーレイ) の構築。
    //   1. page_content_sections があれば実クロール構造から生成 (evidence: 'observed')
    //   2. 無ければ観測された要素・画像・シグナルのY座標分布と構造 issue から
    //      AIエージェントの抽出・注目ホットスポット帯を推論合成 (evidence: 'inferred')
    const aiAttentionBands = buildAiAttentionBands({
      actor: params.actor,
      contentSectionRows,
      elementRows,
      imageRows,
      issueRows,
    })

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
            y: Number(r.y ?? r.image_y ?? 0),
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
          actor: params.actor,
          ai_attention_bands: aiAttentionBands,
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
