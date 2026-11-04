/**
 * Client fetch helpers for AI Agent Heatmap mode & cache-only screenshot prefetch.
 *
 * Task 3.1 & Task 5:
 *   - `fetchAgentHeatmapTiles`: `/api/heatmap` with `actor` ('human' | 'agent' | 'all')
 *   - `fetchAgentHeatmapElements`: `/api/heatmap/elements` with `actor` ('human' | 'agent' | 'all')
 *   - `prefetchHeatmapUnderlayCacheOnly`: `/api/heatmap/screenshot?cache_only=1` (checks L1/R2 cache without triggering a cold capture)
 */

import {
  layerToHeatmapType,
  type HeatmapQuery,
  type HeatmapTile,
  type HeatmapTileMeta,
  type HeatmapTileResponse,
} from '@/lib/api/heatmap'
import type {
  HeatmapElementsData,
  HeatmapElementsQuery,
  HeatmapElementsResponse,
} from '@/lib/api/heatmap-elements'
import type { HeatmapActor, HeatmapDevice } from '@/lib/heatmap/types'

export interface AgentHeatmapElementsData extends HeatmapElementsData {
  actor?: HeatmapActor
  ai_attention_bands?: Array<{
    id: string
    label: string
    headingTag: string
    yStartPct: number
    yEndPct: number
    yPx: number | null
    extractabilityScore: number
    confidence: number
    evidenceLevel: 'observed' | 'inferred'
    note: string
  }>
}

const MAX_AUTO_PAGES = 16

/**
 * Fetches all tile pages for a given actor ('agent' | 'human' | 'all').
 */
export async function fetchAllHeatmapTilesForActor(
  query: HeatmapQuery & { actor: HeatmapActor },
  signal?: AbortSignal,
): Promise<{
  tiles: HeatmapTile[]
  meta: HeatmapTileMeta | null
  error: string | null
}> {
  const accTiles: HeatmapTile[] = []
  let lastMeta: HeatmapTileMeta | null = null
  let cursor: string | null = null
  let pages = 0

  while (pages < MAX_AUTO_PAGES) {
    if (signal?.aborted) break
    const params = new URLSearchParams()
    params.set('site_id', query.site_id)
    params.set('page_url', query.page_url)
    params.set('layer', query.layer)
    params.set('heatmap_type', layerToHeatmapType(query.layer))
    params.set('actor', query.actor)
    if (query.start_date) params.set('start_date', query.start_date)
    if (query.end_date) params.set('end_date', query.end_date)
    if (query.device_type) params.set('device_type', query.device_type)
    if (query.segment && query.segment !== 'all') params.set('segment', query.segment)
    params.set('tile_size', String(Math.max(800, Math.min(6000, query.tile_size ?? 6000))))
    if (cursor) params.set('cursor', cursor)

    try {
      const res = await fetch(`/api/heatmap?${params.toString()}`, {
        method: 'GET',
        credentials: 'include',
        signal,
      })
      if (!res.ok) {
        return {
          tiles: accTiles,
          meta: lastMeta,
          error: `HTTP ${res.status}`,
        }
      }
      const body = (await res.json()) as HeatmapTileResponse
      if (!body.success) {
        return {
          tiles: accTiles,
          meta: lastMeta,
          error: body.error.message,
        }
      }
      accTiles.push(...body.data.tiles)
      lastMeta = body.meta
      cursor = body.data.next_cursor
      pages += 1
      if (!cursor) break
    } catch (err) {
      if (signal?.aborted) break
      return {
        tiles: accTiles,
        meta: lastMeta,
        error: err instanceof Error ? err.message : 'failed to fetch agent heatmap tiles',
      }
    }
  }

  return { tiles: accTiles, meta: lastMeta, error: null }
}

/**
 * Fetches `/api/heatmap/elements` for a given actor ('agent' | 'human' | 'all').
 */
export async function fetchHeatmapElementsForActor(
  query: HeatmapElementsQuery & { actor: HeatmapActor },
  signal?: AbortSignal,
): Promise<AgentHeatmapElementsData | null> {
  const params = new URLSearchParams()
  params.set('site_id', query.site_id)
  params.set('page_url', query.page_url)
  params.set('actor', query.actor)
  if (query.start_date) params.set('start_date', query.start_date)
  if (query.end_date) params.set('end_date', query.end_date)
  if (query.device_type) params.set('device_type', query.device_type)
  if (query.segment && query.segment !== 'all') params.set('segment', query.segment)

  try {
    const res = await fetch(`/api/heatmap/elements?${params.toString()}`, {
      method: 'GET',
      credentials: 'include',
      signal,
    })
    if (!res.ok) return null
    const body = (await res.json()) as HeatmapElementsResponse
    return body.success ? (body.data as AgentHeatmapElementsData) : null
  } catch {
    return null
  }
}

/**
 * Task 3.1: Checks R2/L1 screenshot cache for another device (`cache_only=1`)
 * without triggering a new Cloudflare Browser Rendering capture on cache miss.
 */
export async function prefetchHeatmapUnderlayCacheOnly(input: {
  siteId: string
  pageUrl: string
  device: HeatmapDevice
  signal?: AbortSignal
}): Promise<void> {
  const params = new URLSearchParams({
    site_id: input.siteId,
    page_url: input.pageUrl,
    device: input.device,
    cache_only: '1',
  })
  try {
    await fetch(`/api/heatmap/screenshot?${params.toString()}`, {
      method: 'GET',
      credentials: 'include',
      signal: input.signal,
    })
  } catch {
    // non-fatal background cache check
  }
}
