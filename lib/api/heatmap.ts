/**
 * Heatmap API client (Infrastructure Engineer `heatmap-pagination.md` §6 統合)
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04 / Infra heatmap-pagination.md §2.2 / §2.3
 */

/**
 * Data layers:
 *   click      — クリック密集 (実 ClickHouse query)
 *   read       — 熟読 / attention (read_area events, real query)
 *   scroll     — スクロール到達率 (scroll events reach curve, real query)
 *   exit       — 終了 / 離脱 (session_end events dropoff, real query)
 *   move       — マウス移動 (未収集 — UI で disabled/greyed)
 *   emotion    — 感情推論 (ML 未実装 — UI で disabled/greyed)
 *   friction   — フリクション (旧名称 → exit に統合、型互換のため残存)
 */
export type HeatmapLayer = 'click' | 'read' | 'scroll' | 'exit' | 'move' | 'emotion' | 'friction'

/**
 * API が受け付ける heatmap_type 値。layer → heatmap_type のマッピングは
 * layerToHeatmapType() で一元管理する。
 */
export type HeatmapApiType = 'click' | 'scroll' | 'read' | 'exit'

/**
 * layer 識別子 → API の heatmap_type パラメータへの正規変換。
 * 未収集 / 未実装レイヤー (move / emotion / friction) は click にフォールバック。
 */
export function layerToHeatmapType(layer: HeatmapLayer): HeatmapApiType {
  switch (layer) {
    case 'click':
      return 'click'
    case 'read':
      return 'read'
    case 'scroll':
      return 'scroll'
    case 'exit':
      return 'exit'
    case 'move':
    case 'emotion':
    case 'friction':
      // 未収集 / 未実装 — click にフォールバック (UI で disabled にすべきだが念のため)
      return 'click'
  }
}

export interface HeatmapQuery {
  site_id: string
  page_url: string
  start_date?: string // YYYY-MM-DD
  end_date?: string
  layer: HeatmapLayer
  device_type?: 'desktop' | 'mobile' | 'tablet' | 'unknown'
  tile_size?: number // 800 - 6000, default 2400
}

export interface HeatmapPoint {
  x: number
  y: number
  count: number
  sessions: number
}

export interface HeatmapTile {
  y_start: number
  y_end: number
  points: HeatmapPoint[]
  truncated: boolean
}

export interface HeatmapTileMeta {
  tile_size: number
  page_height_estimate: number
  cached: boolean
  cache_ttl_sec: number
  query_hash: string
  /**
   * 続 82 Sprint 4 W1: dummy / real query 切替判定。
   *   - 'dummy_lcg' : Sprint 1 deterministic LCG dummy points (Infra 続 82 deploy 前)
   *   - 'clickhouse_events' : 実 ClickHouse `clickinsight.events` 集約 (Infra 続 82 完了後)
   * UI 側はこの値で Sprint 1 banner / Sprint 4 W1 banner を切替表示する。
   * 未定義 (旧 deploy) の場合は 'dummy_lcg' 互換扱い。
   */
  data_source?: 'dummy_lcg' | 'clickhouse_events'
  /**
   * 取得した heatmap_type (click | read | scroll | exit)。
   * view-model builder がレイヤーごとに正しい描画モードを選択するために使う。
   * 未定義 (旧 deploy) は 'click' 互換扱い。
   */
  heatmap_type?: HeatmapApiType
}

export interface HeatmapTileSuccess {
  success: true
  data: {
    tiles: HeatmapTile[]
    next_cursor: string | null
  }
  meta: HeatmapTileMeta
}

export interface HeatmapTileError {
  success: false
  error: {
    code: 'TENANT_FORBIDDEN' | 'BAD_REQUEST' | 'CURSOR_INVALID' | 'INTERNAL' | 'UNAUTHORIZED'
    message: string
  }
}

export type HeatmapTileResponse = HeatmapTileSuccess | HeatmapTileError

const TILE_MIN = 800
const TILE_MAX = 6000
const TILE_DEFAULT = 2400

/**
 * tile を 1 つ (または max_tiles) 取得する。cursor は server 返却値をそのまま使う
 * (Frontend で生成 / 改変禁止、改ざんは API 側で CURSOR_INVALID 返却)。
 */
export async function fetchHeatmapTile(
  query: HeatmapQuery,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<HeatmapTileResponse> {
  const params = new URLSearchParams()
  params.set('site_id', query.site_id)
  params.set('page_url', query.page_url)
  params.set('layer', query.layer)
  // heatmap_type: layer ごとに正しい event_type + 座標列を使う query を server が選択する。
  // layerToHeatmapType() で一元管理 (move/emotion/friction は click にフォールバック)。
  params.set('heatmap_type', layerToHeatmapType(query.layer))
  if (query.start_date) params.set('start_date', query.start_date)
  if (query.end_date) params.set('end_date', query.end_date)
  if (query.device_type) params.set('device_type', query.device_type)
  const tileSize = clamp(query.tile_size ?? TILE_DEFAULT, TILE_MIN, TILE_MAX)
  params.set('tile_size', String(tileSize))
  if (cursor) params.set('cursor', cursor)

  const res = await fetch(`/api/heatmap?${params.toString()}`, {
    method: 'GET',
    credentials: 'include',
    signal,
  })

  // 失敗時もエンベロープに従う想定。fetch 自体の network error はここで wrap。
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}))
    if (typeof body === 'object' && body !== null && 'error' in body) {
      return body as HeatmapTileError
    }
    return {
      success: false,
      error: {
        code: res.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL',
        message: `HTTP ${res.status}`,
      },
    }
  }

  return (await res.json()) as HeatmapTileResponse
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}
