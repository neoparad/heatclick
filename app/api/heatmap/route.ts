/**
 * GET /api/heatmap — tile pagination cursor 規約 + dummy/real query 切替
 *
 * 親 SSOT §3.6.5 / Infra heatmap-pagination.md §2 / §3
 *
 * 続 82 Sprint 4 W1 Phase 2 (Frontend, Infra 続 82 配備完了 unblock):
 *   - default: 実 ClickHouse query (`fetchRealHeatmapPoints`)
 *   - ClickHouse 接続不可 / column 不在 / timeout 時は dummy LCG に自動 fallback
 *   - 緊急 rollback: env `HEATMAP_DUMMY_ONLY='1'` で常時 dummy mode
 *   - meta.data_source ('clickhouse_events' | 'dummy_lcg') を UI 側が banner 表示判定に使用
 *   - cursor / HMAC 契約は不変、Frontend hook / UI は無変更
 *
 * Failure modes (production verification は GTM 上流解消後、続 82 Infra §6 root cause):
 *   - GTM が v1 tracking.js を fire していると events 行は流入するが tenant_id='__legacy__'
 *     で来るため、本 query (tenant_id binding 必須) は空 row を返す → UI は empty state 表示
 *   - 空 row は **dummy fallback しない** (本物の「データなし」表示が必要)、error 時のみ fallback
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { getServerSession } from '@/lib/auth/server-session'

import { getClickHouseClient } from '@/lib/clickhouse'
import type { HeatmapSegment } from '@/lib/api/heatmap'
import { segmentFilterSql } from '@/lib/heatmap/segment-filter'
import { canonicalizeHeatmapUrl, canonicalUrlSql } from '@/lib/heatmap/canonical-url'
import { createRouteTimer, type RouteTimer } from '@/lib/perf/server-timing'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * B-4 fix (Reviewer T1 dual 続 10):
 * cursor query_hash は **HMAC-SHA256 with server secret (env HEATMAP_CURSOR_SECRET)** で署名する。
 */
function getCursorSecret(): string {
  const v = process.env.HEATMAP_CURSOR_SECRET
  if (!v || v.length < 16) {
    throw new Error(
      'HEATMAP_CURSOR_SECRET must be set (>=16 chars). See decisions.md B-4 fix (続 10).',
    )
  }
  return v
}

const querySchema = z.object({
  site_id: z.string().min(1).max(128),
  page_url: z.string().url().max(2000),
  heatmap_type: z.enum(['click', 'scroll', 'read', 'exit']).default('click'),
  device_type: z.enum(['desktop', 'mobile', 'tablet', 'unknown']).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tile_size: z.coerce.number().int().min(800).max(6000).default(2400),
  cursor: z.string().max(2000).optional(),
  // 続125/132 (Owner ①): 行動セグメント (ルールベースのクラスタ分け、観測データ直結)
  segment: z.enum(['all', 'deep_read', 'bounce', 'ad', 'returning', 'new']).default('all'),
})

// 続120: 旧 30_000 は縦長記事で深部クリックを取りこぼしていた (click_y は UInt16 で
// max 65535、実測 max ~50k)。UInt16 上限に合わせ 66_000 まで tile を辿れるよう拡張し、
// 30000px より下の click/scroll/read が捨てられないようにする。
const PAGE_HEIGHT_ESTIMATE = 66_000

interface CursorPayload {
  y_start: number
  query_hash: string
  exp: number
}

function buildQueryHash(params: {
  site_id: string
  page_url: string
  heatmap_type: string
  tile_size: number
  device_type?: string
  start_date?: string
  end_date?: string
  segment?: string
}): string {
  // 続125: segment も hash に含める (segment 切替を跨いだ cursor 再利用を CURSOR_INVALID に)
  const raw = `${params.site_id}|${params.page_url}|${params.heatmap_type}|${params.device_type ?? ''}|${params.start_date ?? ''}|${params.end_date ?? ''}|${params.tile_size}|${params.segment ?? 'all'}`
  const hmac = createHmac('sha256', getCursorSecret()).update(raw).digest('hex')
  return hmac.slice(0, 32)
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'))
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf-8')
    const parsed = JSON.parse(json)
    if (
      typeof parsed !== 'object' ||
      parsed == null ||
      typeof parsed.y_start !== 'number' ||
      typeof parsed.query_hash !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return null
    }
    return parsed as CursorPayload
  } catch {
    return null
  }
}

/** decisions.md tenant 越境テスト用: site_id allowlist */
function tenantHasSite(headerSiteIds: string | null, siteId: string): boolean {
  if (!headerSiteIds) return false
  return headerSiteIds.split(',').map((s) => s.trim()).includes(siteId)
}

/**
 * 続 82 Phase 2: 実 query が default。緊急 rollback (Hetzner CH 障害 / 全 query 崩壊時)
 * のためだけに `HEATMAP_DUMMY_ONLY=1` で常時 dummy mode に強制切替可能。
 */
function isDummyOnly(): boolean {
  return process.env.HEATMAP_DUMMY_ONLY === '1'
}

// ── P0 計測 (docs/heatmap/SONNET_PROMPT_P0_instrumentation_2026-07-19.md §3) ──
// 挙動変更ゼロ (絶対条件1): 以下 3 helper は計測専用で、レスポンス body/status を
// 一切変えない。t.headerValue()/t.logLine() は server-timing.ts 側で自壊しない
// ことが保証されているため、ここでは追加の try/catch を重ねていない。

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
  const t = createRouteTimer('heatmap')
  const reqId = t.reqId()
  const url = new URL(request.url)
  const parsed = querySchema.safeParse({
    site_id: url.searchParams.get('site_id') ?? undefined,
    page_url: url.searchParams.get('page_url') ?? undefined,
    heatmap_type: url.searchParams.get('heatmap_type') ?? undefined,
    device_type: url.searchParams.get('device_type') ?? undefined,
    start_date: url.searchParams.get('start_date') ?? undefined,
    end_date: url.searchParams.get('end_date') ?? undefined,
    tile_size: url.searchParams.get('tile_size') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
    segment: url.searchParams.get('segment') ?? undefined,
  })

  if (!parsed.success) {
    return jsonWithTiming(
      t,
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
  // 続135: URL を canonical 化 (query/fragment 除去)。variant 分散による「クリック0」誤表示を防ぐ。
  //   cursor hash / queryParams / SQL の page_url を全て canonical で揃える (一貫性が崩れると 0 件)。
  params.page_url = canonicalizeHeatmapUrl(params.page_url)

  // tenant 検証 — REQ-SEC-126 (§13.7): header 直読みをやめ getServerSession 経由で
  // Layer 2 失効照合 (session/membership version + tenant.status) を通す。失効済みは null。
  const session = await t.span('auth', async () => getServerSession())
  const tenantId = session?.tenant_id ?? null
  const siteIds = session ? session.user.site_ids.join(',') : null
  if (!tenantId) {
    return jsonWithTiming(
      t,
      { success: false, error: { code: 'UNAUTHORIZED', message: 'tenant context missing' } },
      { status: 401 },
    )
  }
  if (!tenantHasSite(siteIds, params.site_id)) {
    return jsonWithTiming(
      t,
      { success: false, error: { code: 'TENANT_FORBIDDEN', message: 'site not in tenant' } },
      { status: 403 },
    )
  }

  const queryHash = buildQueryHash(params)

  // cursor 検証
  let yStart = 0
  if (params.cursor) {
    const cur = decodeCursor(params.cursor)
    if (!cur) {
      return jsonWithTiming(
        t,
        { success: false, error: { code: 'CURSOR_INVALID', message: 'cursor decode failed' } },
        { status: 400 },
      )
    }
    if (!constantTimeEqual(cur.query_hash, queryHash)) {
      return jsonWithTiming(
        t,
        { success: false, error: { code: 'CURSOR_INVALID', message: 'query condition changed' } },
        { status: 400 },
      )
    }
    if (cur.exp < Date.now() / 1000) {
      return jsonWithTiming(
        t,
        { success: false, error: { code: 'CURSOR_INVALID', message: 'cursor expired' } },
        { status: 400 },
      )
    }
    yStart = cur.y_start
  }

  // scroll / exit は scroll_percentage(0-100) ベースの band 集計 = ページ全体を1タイルで返す
  // (px window 不要、PAGE_HEIGHT_ESTIMATE まで一括)。click / read は従来の px window 分割。
  const isSingleTileLayer = params.heatmap_type === 'scroll' || params.heatmap_type === 'exit'
  const isPxLayer = params.heatmap_type === 'click' || params.heatmap_type === 'read'

  // ── 続131 (実走査監査 perf): px 層は初回 (cursor 無し) に**全帯域を 1 クエリで一括取得**する。
  //    旧: 1 band/リクエスト × 最大 11 回の直列 CH クエリ (実測 1批 2-5s) = 初回表示が分単位。
  //    新: per-band top-500 を LIMIT BY で 1 クエリに集約 → tiles[] を全 band 分返し
  //    next_cursor=null (hook の eager loop は 1 周で完了)。失敗時は従来の per-band 経路へ
  //    fall-through (dummy fallback 含む契約は不変)。cursor 継続リクエストも従来経路のまま。
  if (isPxLayer && yStart === 0 && !isDummyOnly()) {
    try {
      const allPoints = await t.span('ch', async () =>
        fetchRealHeatmapPoints({
          tenantId,
          siteId: params.site_id,
          pageUrl: params.page_url,
          heatmapType: params.heatmap_type,
          deviceType: params.device_type,
          segment: params.segment,
          yStart: 0,
          yEnd: PAGE_HEIGHT_ESTIMATE,
          startDate: params.start_date,
          endDate: params.end_date,
          allBands: true,
          tileSize: params.tile_size,
          perfRoute: 'heatmap',
          perfSpan: 'ch',
          perfReqId: reqId,
        }),
      )
      const tiles = partitionIntoTiles(allPoints, params.tile_size)
      t.mark('bands', String(tiles.length))
      t.mark('points', String(allPoints.length))
      return jsonWithTiming(t, {
        success: true,
        data: {
          tiles,
          next_cursor: null,
        },
        meta: {
          tile_size: params.tile_size,
          page_height_estimate: PAGE_HEIGHT_ESTIMATE,
          cached: false,
          cache_ttl_sec: 7200,
          query_hash: queryHash,
          data_source: 'clickhouse_events' as const,
          heatmap_type: params.heatmap_type,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown'
      console.error(
        `[heatmap] all-bands query failed query_hash=${queryHash.slice(0, 8)}, falling back to per-band path: ${message}`,
      )
      // fall through: 従来の per-band (dummy fallback 含む) 経路
    }
  }

  const tileEnd = isSingleTileLayer
    ? PAGE_HEIGHT_ESTIMATE
    : Math.min(yStart + params.tile_size, PAGE_HEIGHT_ESTIMATE + params.tile_size)
  const isLast = isSingleTileLayer || tileEnd >= PAGE_HEIGHT_ESTIMATE

  // 続 82 Phase 2: default = 実 ClickHouse query。失敗時のみ dummy fallback。
  // 緊急 rollback は HEATMAP_DUMMY_ONLY=1 で常時 dummy mode。
  let points: Array<{ x: number; y: number; count: number; sessions: number }>
  let dataSource: 'dummy_lcg' | 'clickhouse_events'

  if (isDummyOnly()) {
    points = generateDummyPoints(params.site_id, params.page_url, yStart, tileEnd, params.heatmap_type)
    dataSource = 'dummy_lcg'
  } else {
    try {
      points = await t.span('ch-fallback', async () =>
        fetchRealHeatmapPoints({
          tenantId,
          siteId: params.site_id,
          pageUrl: params.page_url,
          heatmapType: params.heatmap_type,
          deviceType: params.device_type,
          segment: params.segment,
          yStart,
          yEnd: tileEnd,
          startDate: params.start_date,
          endDate: params.end_date,
          perfRoute: 'heatmap',
          perfSpan: 'ch-fallback',
          perfReqId: reqId,
        }),
      )
      dataSource = 'clickhouse_events'
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown'
      console.error(
        `[heatmap] real query failed query_hash=${queryHash.slice(0, 8)}, fallback to dummy: ${message}`,
      )
      points = generateDummyPoints(params.site_id, params.page_url, yStart, tileEnd, params.heatmap_type)
      dataSource = 'dummy_lcg'
    }
  }

  const tile = {
    y_start: yStart,
    y_end: tileEnd,
    points,
    truncated: false,
  }

  const next_cursor = isLast
    ? null
    : encodeCursor({
        y_start: tileEnd,
        query_hash: queryHash,
        exp: Math.floor(Date.now() / 1000) + 600,
      })

  return jsonWithTiming(t, {
    success: true,
    data: {
      tiles: [tile],
      next_cursor,
    },
    meta: {
      tile_size: params.tile_size,
      page_height_estimate: PAGE_HEIGHT_ESTIMATE,
      cached: false,
      cache_ttl_sec: 7200,
      query_hash: queryHash,
      data_source: dataSource,
      heatmap_type: params.heatmap_type,
    },
  })
}

/**
 * 続131: 全帯域 points を tile_size ごとの band に分割して tiles[] にする。
 * 空 band は省略 (hook は y_start で dedupe するだけなので欠番可)。全 0 件のときは
 * 従来挙動 (空 points の band 0) を返し、UI の real-empty 判定を変えない。
 */
function partitionIntoTiles(
  points: Array<{ x: number; y: number; count: number; sessions: number }>,
  tileSize: number,
): Array<{
  y_start: number
  y_end: number
  points: Array<{ x: number; y: number; count: number; sessions: number }>
  truncated: boolean
}> {
  const byBand = new Map<number, Array<{ x: number; y: number; count: number; sessions: number }>>()
  for (const p of points) {
    const start = Math.floor(p.y / tileSize) * tileSize
    const arr = byBand.get(start)
    if (arr) arr.push(p)
    else byBand.set(start, [p])
  }
  if (byBand.size === 0) {
    return [{ y_start: 0, y_end: tileSize, points: [], truncated: false }]
  }
  return [...byBand.entries()]
    .sort(([a], [b]) => a - b)
    .map(([y_start, pts]) => ({
      y_start,
      y_end: y_start + tileSize,
      points: pts,
      truncated: false,
    }))
}

/**
 * ClickHouse `clickinsight.events` から heatmap_type に応じた集約を返す。
 *
 * layer → event_type → coordinate 列のマッピング:
 *   click  → event_type='click'      → x = normalize(click_x), y = click_y
 *   read   → event_type='read_area'  → x = 0 (full-width band), y = read_y
 *   scroll → event_type='scroll'     → x = 0, y = scroll_y (reach curve)
 *   exit   → event_type='scroll' (per-session max) → x = 0, y = 離脱深度 (続120 fix: session_end は scroll_y を持たない)
 *
 * scroll / exit は到達率曲線として view-model 側で解釈するため、
 * count = そのバンドに到達した (または終了した) セッション数を返す。
 *
 * tile 単位の y_start..y_end range で絞り込む (scroll/exit は depth 範囲)。
 * is_agent = 0 (bot 除外) は全 query で必須。
 */
async function fetchRealHeatmapPoints(input: {
  tenantId: string
  siteId: string
  pageUrl: string
  heatmapType: 'click' | 'scroll' | 'read' | 'exit'
  deviceType?: 'desktop' | 'mobile' | 'tablet' | 'unknown'
  segment?: HeatmapSegment
  yStart: number
  yEnd: number
  startDate?: string
  endDate?: string
  /** 続131: true なら px 層を全帯域 1 クエリ (per-band top を LIMIT BY) で返す */
  allBands?: boolean
  /** allBands 時の band 幅 (LIMIT BY の band 式に使用) */
  tileSize?: number
  /** P0 計測: CH query_log 突合用 log_comment (route/span/reqId が揃った時のみ付与) */
  perfRoute?: string
  perfSpan?: string
  perfReqId?: string
}): Promise<Array<{ x: number; y: number; count: number; sessions: number }>> {
  const client = getClickHouseClient('analytics_reader')

  const deviceFilter = input.deviceType ? `AND device_type = {device_type:String}` : ''
  // 続125: 行動セグメント絞り込み (定数 SQL 断片 + parameter binding のみ)
  const segmentFilter = segmentFilterSql(input.segment ?? 'all')
  const dateStart = input.startDate ?? '1970-01-01'
  const dateEnd = input.endDate ?? '2099-12-31'

  const queryParams: Record<string, string> = {
    tenant_id: input.tenantId,
    site_id: input.siteId,
    page_url: input.pageUrl,
    y_start: String(input.yStart),
    y_end: String(input.yEnd),
    start: dateStart,
    end: dateEnd,
  }
  if (deviceFilter && input.deviceType) {
    queryParams.device_type = input.deviceType
  }
  if (input.allBands) {
    queryParams.tile_px = String(input.tileSize ?? 6000)
  }

  let sql: string

  if (input.heatmapType === 'click') {
    // ── CLICK ────────────────────────────────────────────────────────────
    // click_x を 1280 基準に正規化、[0,1280] に clamp。
    // click_y = document 絶対 CSS px (UInt32 で wrap を避ける)。
    // viewport_width <= 0 の malformed row は生 click_x をそのまま使う (worst-case)。
    //
    // 続129 (本番障害 fix): 旧実装は GROUP BY が「生 px (x 1280 × y tile全域)」+
    //   uniqExact (厳密セット) で、再タグ後のデータ量 (3倍) で server の総メモリ上限
    //   (6.81GiB) を超過し MEMORY_LIMIT_EXCEEDED → heatmap 全滅していた。
    //   実測の学び: 8px ビン化 + uniq(HLL) でも最大 ~133万 bin × HLL 状態 ~2.5KB ≈ 5GB で
    //   依然超過する (live 検証済)。よって **2パス方式**:
    //     pass1 (subquery): count のみで上位 500 bin を選抜 — counter だけなので ~数十MB。
    //     pass2 (outer)   : その 500 bin に該当する行だけ uniq(session_id) — HLL 500 個 ≈ 1MB。
    //   座標 8px グリッド (bin 中心 +4) は view-model の 48px クラスタ半径より十分細かく視覚差ゼロ。
    //   sessions の uniq() 誤差 ~1% は blob 強度/tooltip 用途で無影響 (observed であることは不変)。
    const binnedX = `toUInt16(least(1280, greatest(0, floor(if(viewport_width > 0, click_x * 1280 / viewport_width, click_x) / 8) * 8 + 4)))`
    const binnedY = `toUInt32(intDiv(click_y, 8) * 8 + 4)`
    // 続134 (1-4 fix): viewport_width<=0 の malformed 行で click_x>1280 のものは正規化不能で
    //   右端 (1280) に clamp され device 混同を起こす。**out-of-range な malformed のみ除外**し、
    //   well-formed 行と「malformed でも x が範囲内 (clamp 無害)」な行は残す (データを失わない安全側)。
    const clickWhere = `
        tenant_id = {tenant_id:String}
        AND site_id = {site_id:String}
        AND ${canonicalUrlSql('url')} = {page_url:String}
        AND event_type = 'click'
        AND is_agent = 0
        AND (viewport_width > 0 OR click_x <= 1280)
        AND click_y >= {y_start:UInt32}
        AND click_y < {y_end:UInt32}
        AND timestamp >= toDateTime({start:String})
        AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
        ${deviceFilter}
        ${segmentFilter}`
    // 続131 (allBands): per-band top-500 を LIMIT BY で 1 クエリに集約 (band = intDiv(y, tile_px))。
    //   pass1 は counter のみ (~数十MB)、pass2 は選抜 bin の uniq のみ。
    // 続134 (1-1 fix): 旧実装は `LIMIT 500 BY band` の後に **グローバル LIMIT 6000** を掛けており、
    //   band 数 × 500 が 6000 を超える縦長ページ (66000px / 2400px tile = 28 band × 500 = 14000)
    //   で、pass1 が band 昇順ソートのため**深いバンドの hotspot が落ちていた**。
    //   per-band 上限 (500) が既に1バンドあたりを縛るので、グローバル上限は既定 tile_size の
    //   実バンド数 (66000/2400≒28 band × 500 = 14000) を余裕で超える 20000 まで引き上げる
    //   (旧 6000 では深部バンドが落ちていた)。応答サイズ/描画の暴走防止として 20000 は維持。
    //   pass2 の uniq は ≤ 20000 個 HLL で max_memory_usage=2GB ガード内 (実測 数十MB)。
    const ALLBANDS_HARD_CAP = 20000
    const pass1Limit = input.allBands
      ? `ORDER BY intDiv(y, {tile_px:UInt32}) ASC, c DESC
          LIMIT 500 BY intDiv(y, {tile_px:UInt32})
          LIMIT ${ALLBANDS_HARD_CAP}`
      : `ORDER BY c DESC
          LIMIT 500`
    const outerLimit = input.allBands ? ALLBANDS_HARD_CAP : 500
    sql = `
      SELECT x, y, count() AS count, uniq(session_id) AS sessions
      FROM (
        SELECT ${binnedX} AS x, ${binnedY} AS y, session_id
        FROM clickinsight.events
        WHERE ${clickWhere}
      )
      WHERE (x, y) IN (
        SELECT x, y FROM (
          SELECT ${binnedX} AS x, ${binnedY} AS y, count() AS c
          FROM clickinsight.events
          WHERE ${clickWhere}
          GROUP BY x, y
          ${pass1Limit}
        )
      )
      GROUP BY x, y
      HAVING count >= 1
      ORDER BY count DESC
      LIMIT ${outerLimit}
    `
  } else if (input.heatmapType === 'read') {
    // ── READ (熟読 / attention) ──────────────────────────────────────────
    // read_area events の read_y を 200px bin に丸めて密度集計。
    // x = 0 (full-width band、view-model が幅全体に帯として描画)。
    // read_y は document 絶対 CSS px (UInt32 にキャスト)。
    sql = `
      SELECT
        0 AS x,
        toUInt32(intDiv(read_y, 200) * 200) AS y,
        count() AS count,
        uniqExact(session_id) AS sessions
      FROM clickinsight.events
      WHERE tenant_id = {tenant_id:String}
        AND site_id = {site_id:String}
        AND ${canonicalUrlSql('url')} = {page_url:String}
        AND event_type = 'read_area'
        AND is_agent = 0
        AND read_y >= {y_start:UInt32}
        AND read_y < {y_end:UInt32}
        AND timestamp >= toDateTime({start:String})
        AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
        ${deviceFilter}
        ${segmentFilter}
      GROUP BY y
      HAVING count >= 1
      ORDER BY y ASC
      LIMIT ${input.allBands ? 2000 : 500}
    `
  } else if (input.heatmapType === 'scroll') {
    // ── SCROLL (スクロール到達率) ────────────────────────────────────────
    // 続121 fix: 生 scroll_y(px) は visitor の viewport 幅依存で、固定幅 screenshot に重ねると
    // 下方が画面外に落ちて「途中で途切れる」。viewport 非依存の scroll_percentage(0-100) を使う。
    // session ごとの max(scroll_percentage) を 5% bin に集計。y = 深度%(0-100)。
    // count/sessions = その最深%バケットのセッション数。view-model が累積到達率に変換する。
    sql = `
      WITH per_session AS (
        SELECT
          session_id,
          max(scroll_percentage) AS max_pct
        FROM clickinsight.events
        WHERE tenant_id = {tenant_id:String}
          AND site_id = {site_id:String}
          AND ${canonicalUrlSql('url')} = {page_url:String}
          AND is_agent = 0
          AND timestamp >= toDateTime({start:String})
          AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
          ${deviceFilter}
          ${segmentFilter}
        GROUP BY session_id
      )
      SELECT
        0 AS x,
        toUInt32(least(95, intDiv(max_pct, 5) * 5)) AS y,
        count() AS count,
        count() AS sessions
      FROM per_session
      GROUP BY y
      HAVING count >= 1
      ORDER BY y ASC
      LIMIT 100
    `
  } else {
    // ── EXIT (終了 / 離脱) ────────────────────────────────────────────────
    // 続121 fix: scroll と同じく scroll_percentage(0-100) ベース (viewport 非依存)。
    // 「離脱深度 = そのセッションが到達した最深%」。各 % バケットの count = その深度で
    // 離脱した (それ以上進まなかった) セッション数。view-model は band 単位の dropoff として描画。
    // 分母はページに来た全セッション (event_type 不問 = scroll を吐かず離脱した bouncer も 0% に計上)。
    sql = `
      WITH per_session AS (
        SELECT
          session_id,
          max(scroll_percentage) AS max_pct
        FROM clickinsight.events
        WHERE tenant_id = {tenant_id:String}
          AND site_id = {site_id:String}
          AND ${canonicalUrlSql('url')} = {page_url:String}
          AND is_agent = 0
          AND timestamp >= toDateTime({start:String})
          AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
          ${deviceFilter}
          ${segmentFilter}
        GROUP BY session_id
      )
      SELECT
        0 AS x,
        toUInt32(least(95, intDiv(max_pct, 5) * 5)) AS y,
        count() AS count,
        count() AS sessions
      FROM per_session
      GROUP BY y
      HAVING count >= 1
      ORDER BY y ASC
      LIMIT 100
    `
  }

  // 続130 (本番 dummy 退避の根本原因): per-query max_memory_usage は analytics_reader が
  // readonly=1 のため **設定変更=禁止操作として HTTP 層で即拒否**され、tile クエリが
  // ClickHouse に一切届かず全レイヤー dummy 退避していた (query_log で実証。
  // max_execution_time は changeable_in_readonly のため通る — 同列に考えたのが誤り)。
  // メモリ防御は (a) 2パスクエリ形状 (実証 3s/数十MB) + (b) server 側 user-level
  // 設定 (scripts/operator-grant-analytics-reader.mjs で Owner が適用) の 2 層で担う。
  const rs = await client.query({
    query: sql,
    query_params: queryParams,
    format: 'JSONEachRow',
    ...(input.perfRoute && input.perfSpan && input.perfReqId
      ? { clickhouse_settings: perfLogComment(input.perfRoute, input.perfSpan, input.perfReqId) }
      : {}),
  })
  const rows = (await rs.json()) as Array<{
    x: number
    y: number
    count: number
    sessions: number
  }>
  return rows
}

function generateDummyPoints(
  siteId: string,
  pageUrl: string,
  yStart: number,
  yEnd: number,
  layer: string,
): Array<{ x: number; y: number; count: number; sessions: number }> {
  let seed = 0
  for (const s of [siteId, pageUrl, layer, String(yStart)].join('|')) {
    seed = (seed * 31 + s.charCodeAt(0)) | 0
  }
  function rand(): number {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }

  const tileHeight = yEnd - yStart
  // 20 - 40 hotspots per tile
  const count = 20 + Math.floor(rand() * 20)
  const points: Array<{ x: number; y: number; count: number; sessions: number }> = []
  for (let i = 0; i < count; i++) {
    const x = Math.floor(rand() * 1280)
    const y = yStart + Math.floor(rand() * tileHeight)
    const c = 3 + Math.floor(rand() * 60)
    points.push({ x, y, count: c, sessions: Math.max(1, Math.floor(c * 0.6)) })
  }
  return points
}
