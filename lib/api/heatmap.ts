/**
 * Heatmap API client (Infrastructure Engineer `heatmap-pagination.md` §6 統合)
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04 / Infra heatmap-pagination.md §2.2 / §2.3
 */

export type HeatmapLayer = 'click' | 'move' | 'emotion' | 'friction'

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
  // heatmap_type は API 仕様 §2.2: click / scroll / read。layer=click は heatmap_type=click。
  // emotion / friction / move は Sprint 1 では click を tile pagination で返し、UI 側の
  // shading で別表現する (Infra spec §2.2 注記: scroll/read は Phase 2 後ろ倒し)。
  params.set('heatmap_type', query.layer === 'click' ? 'click' : 'click')
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
