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
}): string {
  const raw = `${params.site_id}|${params.page_url}|${params.heatmap_type}|${params.device_type ?? ''}|${params.start_date ?? ''}|${params.end_date ?? ''}|${params.tile_size}`
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

export async function GET(request: Request) {
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

  // tenant 検証 — REQ-SEC-126 (§13.7): header 直読みをやめ getServerSession 経由で
  // Layer 2 失効照合 (session/membership version + tenant.status) を通す。失効済みは null。
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

  const queryHash = buildQueryHash(params)

  // cursor 検証
  let yStart = 0
  if (params.cursor) {
    const cur = decodeCursor(params.cursor)
    if (!cur) {
      return NextResponse.json(
        { success: false, error: { code: 'CURSOR_INVALID', message: 'cursor decode failed' } },
        { status: 400 },
      )
    }
    if (!constantTimeEqual(cur.query_hash, queryHash)) {
      return NextResponse.json(
        { success: false, error: { code: 'CURSOR_INVALID', message: 'query condition changed' } },
        { status: 400 },
      )
    }
    if (cur.exp < Date.now() / 1000) {
      return NextResponse.json(
        { success: false, error: { code: 'CURSOR_INVALID', message: 'cursor expired' } },
        { status: 400 },
      )
    }
    yStart = cur.y_start
  }

  const tileEnd = Math.min(yStart + params.tile_size, PAGE_HEIGHT_ESTIMATE + params.tile_size)
  const isLast = tileEnd >= PAGE_HEIGHT_ESTIMATE

  // 続 82 Phase 2: default = 実 ClickHouse query。失敗時のみ dummy fallback。
  // 緊急 rollback は HEATMAP_DUMMY_ONLY=1 で常時 dummy mode。
  let points: Array<{ x: number; y: number; count: number; sessions: number }>
  let dataSource: 'dummy_lcg' | 'clickhouse_events'

  if (isDummyOnly()) {
    points = generateDummyPoints(params.site_id, params.page_url, yStart, tileEnd, params.heatmap_type)
    dataSource = 'dummy_lcg'
  } else {
    try {
      points = await fetchRealHeatmapPoints({
        tenantId,
        siteId: params.site_id,
        pageUrl: params.page_url,
        heatmapType: params.heatmap_type,
        deviceType: params.device_type,
        yStart,
        yEnd: tileEnd,
        startDate: params.start_date,
        endDate: params.end_date,
      })
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

  return NextResponse.json({
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
  yStart: number
  yEnd: number
  startDate?: string
  endDate?: string
}): Promise<Array<{ x: number; y: number; count: number; sessions: number }>> {
  const client = getClickHouseClient('analytics_reader')

  const deviceFilter = input.deviceType ? `AND device_type = {device_type:String}` : ''
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

  let sql: string

  if (input.heatmapType === 'click') {
    // ── CLICK ────────────────────────────────────────────────────────────
    // click_x を 1280 基準に正規化、[0,1280] に clamp。
    // click_y = document 絶対 CSS px (UInt32 で wrap を避ける)。
    // viewport_width <= 0 の malformed row は生 click_x をそのまま使う (worst-case)。
    sql = `
      SELECT
        toUInt16(least(1280, greatest(0, if(viewport_width > 0, click_x * 1280 / viewport_width, click_x)))) AS x,
        toUInt32(click_y) AS y,
        count() AS count,
        uniqExact(session_id) AS sessions
      FROM clickinsight.events
      WHERE tenant_id = {tenant_id:String}
        AND site_id = {site_id:String}
        AND url = {page_url:String}
        AND event_type = 'click'
        AND is_agent = 0
        AND click_y >= {y_start:UInt32}
        AND click_y < {y_end:UInt32}
        AND timestamp >= toDateTime({start:String})
        AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
        ${deviceFilter}
      GROUP BY x, y
      HAVING count >= 1
      ORDER BY count DESC
      LIMIT 500
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
        AND url = {page_url:String}
        AND event_type = 'read_area'
        AND is_agent = 0
        AND read_y >= {y_start:UInt32}
        AND read_y < {y_end:UInt32}
        AND timestamp >= toDateTime({start:String})
        AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
        ${deviceFilter}
      GROUP BY y
      HAVING count >= 1
      ORDER BY y ASC
      LIMIT 500
    `
  } else if (input.heatmapType === 'scroll') {
    // ── SCROLL (スクロール到達率) ────────────────────────────────────────
    // scroll events: session ごとの max(scroll_y) を求め、各 200px band に
    // 「その深度まで到達した」セッション数を集計する (reach curve)。
    // count = そのバンドへ到達したセッション数 (y 座標以上に到達した session 数)。
    // 実装: per-session max_scroll を先に集計し、band ごとにカウントする。
    // tile y_start..y_end はスクロール深度の窓 (scroll_y フィルタ)。
    sql = `
      WITH per_session AS (
        SELECT
          session_id,
          max(scroll_y) AS max_scroll_y
        FROM clickinsight.events
        WHERE tenant_id = {tenant_id:String}
          AND site_id = {site_id:String}
          AND url = {page_url:String}
          AND event_type = 'scroll'
          AND is_agent = 0
          AND timestamp >= toDateTime({start:String})
          AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
          ${deviceFilter}
        GROUP BY session_id
      )
      SELECT
        0 AS x,
        toUInt32(intDiv(max_scroll_y, 200) * 200) AS y,
        count() AS count,
        count() AS sessions
      FROM per_session
      WHERE max_scroll_y >= {y_start:UInt32}
        AND max_scroll_y < {y_end:UInt32}
      GROUP BY y
      HAVING count >= 1
      ORDER BY y ASC
      LIMIT 500
    `
  } else {
    // ── EXIT (終了 / 離脱) ────────────────────────────────────────────────
    // 続120 fix: 本番検証で session_end events は scroll_y を一切持たない (全行 0) ことが
    // 判明した。そのため「離脱深度 = そのセッションが到達した最深部 (max scroll_y)」と定義し、
    // scroll events の per-session max(scroll_y) を 200px band に集計する (scroll 層と同じ
    // proven データ源)。各 band の count = その深度で離脱した (それ以上進まなかった) セッション数。
    // view-model は scroll(到達率=累積) とは別に、本 band 単位の dropoff として描画する。
    sql = `
      WITH per_session AS (
        SELECT
          session_id,
          max(scroll_y) AS max_scroll_y
        FROM clickinsight.events
        WHERE tenant_id = {tenant_id:String}
          AND site_id = {site_id:String}
          AND url = {page_url:String}
          AND event_type = 'scroll'
          AND is_agent = 0
          AND timestamp >= toDateTime({start:String})
          AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
          ${deviceFilter}
        GROUP BY session_id
      )
      SELECT
        0 AS x,
        toUInt32(intDiv(max_scroll_y, 200) * 200) AS y,
        count() AS count,
        count() AS sessions
      FROM per_session
      WHERE max_scroll_y >= {y_start:UInt32}
        AND max_scroll_y < {y_end:UInt32}
      GROUP BY y
      HAVING count >= 1
      ORDER BY y ASC
      LIMIT 500
    `
  }

  const rs = await client.query({
    query: sql,
    query_params: queryParams,
    format: 'JSONEachRow',
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
