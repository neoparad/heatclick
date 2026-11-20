/**
 * Client & BFF helpers for Browser-Operating AI Agent Hybrid Heatmap (`lib/heatmap/agent-heatmap-client.ts`)
 *
 * Wave 0 (束 0-A 止血):
 *   - ClickHouse クエリ (`fetchAgentHeatmapPoints`, `fetchAgentBehaviorSummary`) に
 *     `tenant_id = {tenant_id:String}` を無条件で必須適用（`tenantId` 未指定時は fail-closed）。
 *   - 実測データが無い場合の決定論的フォールバック合成 (`deterministic_hybrid`) を完全除去し、
 *     `status: 'not_collected'` + 空データで返す。
 */

import {
  layerToHeatmapType,
  type HeatmapPoint,
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
import { canonicalizeHeatmapUrl } from '@/lib/heatmap/canonical-url'
import type { HeatmapActor, HeatmapDevice } from '@/lib/heatmap/types'
import type { CollectionStatus } from '@/lib/linkscrawl/types'

export type AgentSubtype =
  | 'all'
  | 'webdriver'
  | 'headless'
  | 'ai_user_agent'
  | 'heuristic_multi'

export const AGENT_SUBTYPE_OPTIONS: ReadonlyArray<{
  key: AgentSubtype
  label: string
  shortLabel: string
}> = [
  { key: 'all', label: 'すべて (全AIエージェント)', shortLabel: 'すべて' },
  { key: 'webdriver', label: 'Playwright/WebDriver', shortLabel: 'Playwright/WebDriver' },
  { key: 'headless', label: 'HeadlessChrome', shortLabel: 'HeadlessChrome' },
  { key: 'ai_user_agent', label: 'ChatGPT/AI検索エージェント', shortLabel: 'ChatGPT/AI検索エージェント' },
  { key: 'heuristic_multi', label: '複合ヒューリスティック検知', shortLabel: '複合検知' },
]

export interface AgentFrictionHotspot {
  selector: string
  label: string
  x: number
  y: number
  deadClickCount: number
  rageClickCount: number
  agentTypes: string[]
  failureReason: string
  fixRecommendation: string
}

export interface HttpCrawlerSectionOverlay {
  sectionSelector: string
  headingText: string
  yStartPx: number
  yEndPx: number
  httpCrawlerStatus: 'extracted' | 'csr_blind_spot' | 'chunk_corrupted'
  crawlHits: number
  botNames: string[]
  note: string
}

export interface AgentBehaviorSummary {
  totalAgentSessions: number
  totalAgentClicks: number
  totalDeadClicks: number
  totalRageClicks: number
  avgScrollDepthPct: number
  topAgentTypes: Array<{ name: string; subtype: AgentSubtype; sessions: number; sharePct: number }>
  targetedCtas: Array<{ selector: string; label: string; clicks: number; successRatePct: number }>
  dataSource: 'clickhouse_live' | 'not_collected'
}

export interface AgentHybridInsightsPayload {
  status: CollectionStatus
  reason?: string
  siteId: string
  pageUrl: string
  agentSubtype: AgentSubtype
  summary: AgentBehaviorSummary
  frictionHotspots: AgentFrictionHotspot[]
  crawlerSectionOverlays: HttpCrawlerSectionOverlay[]
  subtypeCounts: Record<AgentSubtype, number>
}

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
 * Normalizes an incoming `agent_subtype` string to a valid `AgentSubtype`.
 */
export function parseAgentSubtype(raw?: string | null): AgentSubtype {
  const cleaned = (raw || '').trim()
  switch (cleaned) {
    case 'webdriver':
    case 'headless':
    case 'ai_user_agent':
    case 'heuristic_multi':
      return cleaned
    default:
      return 'all'
  }
}

/**
 * Fetches all tile pages for a given actor ('agent' | 'human' | 'all') and optional `agentSubtype`.
 */
export async function fetchAllHeatmapTilesForActor(
  query: HeatmapQuery & { actor: HeatmapActor; agentSubtype?: AgentSubtype },
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
    if (query.agentSubtype && query.agentSubtype !== 'all') {
      params.set('agent_subtype', query.agentSubtype)
    }
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
  query: HeatmapElementsQuery & { actor: HeatmapActor; agentSubtype?: AgentSubtype },
  signal?: AbortSignal,
): Promise<AgentHeatmapElementsData | null> {
  const params = new URLSearchParams()
  params.set('site_id', query.site_id)
  params.set('page_url', query.page_url)
  params.set('actor', query.actor)
  if (query.agentSubtype && query.agentSubtype !== 'all') {
    params.set('agent_subtype', query.agentSubtype)
  }
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
 * Client helper to fetch `/api/heatmap/agent-insights` for the Browser-Operating Agent Hybrid Heatmap panel.
 */
export async function fetchAgentHybridInsightsClient(
  input: {
    siteId: string
    pageUrl: string
    device?: string
    agentSubtype?: AgentSubtype
    signal?: AbortSignal
  },
): Promise<AgentHybridInsightsPayload | null> {
  const params = new URLSearchParams({
    site_id: input.siteId,
    url: input.pageUrl,
    device: input.device || 'desktop',
    agent_subtype: input.agentSubtype || 'all',
  })
  try {
    const res = await fetch(`/api/heatmap/agent-insights?${params.toString()}`, {
      method: 'GET',
      credentials: 'include',
      signal: input.signal,
    })
    if (!res.ok) return null
    const body = (await res.json()) as {
      ok: boolean
      status?: CollectionStatus
      reason?: string
      data?: Omit<AgentHybridInsightsPayload, 'status' | 'reason' | 'siteId' | 'pageUrl' | 'agentSubtype'> & {
        status?: CollectionStatus
        reason?: string
        siteId?: string
        pageUrl?: string
        agentSubtype?: AgentSubtype
      }
    }
    if (!body.ok || !body.data) return null
    return {
      status: body.data.status ?? body.status ?? (body.data.summary?.dataSource === 'clickhouse_live' ? 'ok' : 'not_collected'),
      reason: body.data.reason ?? body.reason,
      siteId: body.data.siteId ?? input.siteId,
      pageUrl: body.data.pageUrl ?? input.pageUrl,
      agentSubtype: body.data.agentSubtype ?? input.agentSubtype ?? 'all',
      summary: body.data.summary,
      frictionHotspots: body.data.frictionHotspots ?? [],
      crawlerSectionOverlays: body.data.crawlerSectionOverlays ?? [],
      subtypeCounts: body.data.subtypeCounts ?? {
        all: 0,
        webdriver: 0,
        headless: 0,
        ai_user_agent: 0,
        heuristic_multi: 0,
      },
    }
  } catch {
    return null
  }
}

/**
 * Checks R2/L1 screenshot cache for another device (`cache_only=1`)
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

/**
 * Builds Browser-Operating AI Agent hybrid insights strictly from observed ClickHouse telemetry.
 * Wave 0 (束 0-A 止血): 実測データが無い場合は作り物を合成せず `status: 'not_collected'` + 空配列を返す。
 */
export function buildAgentHybridInsights(input: {
  siteId: string
  pageUrl: string
  agentSubtype?: AgentSubtype
  rawPoints?: Array<HeatmapPoint & { selector?: string; eventType?: string }>
  rawSummary?: Partial<AgentBehaviorSummary> | null
}): AgentHybridInsightsPayload {
  const siteId = (input.siteId || '').trim()
  const subtype = parseAgentSubtype(input.agentSubtype)

  let normalizedUrl = input.pageUrl || ''
  if (normalizedUrl) {
    try {
      const candidate = normalizedUrl.startsWith('/')
        ? `https://bihadashop.jp${normalizedUrl}`
        : normalizedUrl
      const parsed = new URL(canonicalizeHeatmapUrl(candidate))
      parsed.hostname = parsed.hostname.toLowerCase()
      const cleanPath = parsed.pathname.replace(/\/+$/, '') || '/'
      normalizedUrl = `${parsed.protocol}//${parsed.hostname}${cleanPath}`
    } catch {
      // Keep original URL string if non-standard
    }
  }

  const livePoints = Array.isArray(input.rawPoints) ? input.rawPoints : []
  const hasLiveSummary =
    Boolean(input.rawSummary) &&
    (Number(input.rawSummary?.totalAgentSessions ?? 0) > 0 ||
      Number(input.rawSummary?.totalAgentClicks ?? 0) > 0)
  const hasLivePoints = livePoints.length > 0

  const zeroSubtypeCounts: Record<AgentSubtype, number> = {
    all: 0,
    webdriver: 0,
    headless: 0,
    ai_user_agent: 0,
    heuristic_multi: 0,
  }

  if (!hasLiveSummary && !hasLivePoints) {
    return {
      status: 'not_collected',
      reason:
        'ClickHouse にブラウザ操作型AIエージェント (is_agent=1) の実測データが未収集です (not_collected)',
      siteId,
      pageUrl: normalizedUrl,
      agentSubtype: subtype,
      summary: {
        totalAgentSessions: 0,
        totalAgentClicks: 0,
        totalDeadClicks: 0,
        totalRageClicks: 0,
        avgScrollDepthPct: 0,
        topAgentTypes: [],
        targetedCtas: [],
        dataSource: 'not_collected',
      },
      frictionHotspots: [],
      crawlerSectionOverlays: [],
      subtypeCounts: zeroSubtypeCounts,
    }
  }

  const frictionHotspots: AgentFrictionHotspot[] = livePoints
    .filter((p) => (p.eventType === 'dead_click' || p.eventType === 'rage_click') && p.selector)
    .map((p) => {
      const isRage = p.eventType === 'rage_click'
      return {
        selector: p.selector!,
        label: p.selector!,
        x: Number(p.x) || 0,
        y: Number(p.y) || 0,
        deadClickCount: isRage ? 0 : Number(p.count) || 0,
        rageClickCount: isRage ? Number(p.count) || 0 : 0,
        agentTypes: subtype === 'all' ? ['observed_agent'] : [subtype],
        failureReason: isRage
          ? 'ClickHouse で AIエージェントの rage_click が観測されました'
          : 'ClickHouse で AIエージェントの dead_click が観測されました',
        fixRecommendation:
          '該当セレクタのインタラクティブ要素・ARIAロール・重なり順を確認してください。',
      }
    })

  const totalSessions =
    Number(input.rawSummary?.totalAgentSessions ?? 0) ||
    livePoints.reduce((max, p) => Math.max(max, Number(p.sessions) || 0), 0)
  const totalClicks =
    Number(input.rawSummary?.totalAgentClicks ?? 0) ||
    livePoints
      .filter((p) => p.eventType === 'click')
      .reduce((s, p) => s + (Number(p.count) || 0), 0)
  const totalDead =
    Number(input.rawSummary?.totalDeadClicks ?? 0) ||
    frictionHotspots.reduce((s, h) => s + h.deadClickCount, 0)
  const totalRage =
    Number(input.rawSummary?.totalRageClicks ?? 0) ||
    frictionHotspots.reduce((s, h) => s + h.rageClickCount, 0)

  const subtypeCounts: Record<AgentSubtype, number> = {
    ...zeroSubtypeCounts,
    all: totalSessions,
  }
  if (subtype !== 'all') {
    subtypeCounts[subtype] = totalSessions
  }

  return {
    status: 'ok',
    siteId,
    pageUrl: normalizedUrl,
    agentSubtype: subtype,
    summary: {
      totalAgentSessions: totalSessions,
      totalAgentClicks: totalClicks,
      totalDeadClicks: totalDead,
      totalRageClicks: totalRage,
      avgScrollDepthPct: Number(input.rawSummary?.avgScrollDepthPct ?? 0),
      topAgentTypes: input.rawSummary?.topAgentTypes ?? [],
      targetedCtas: input.rawSummary?.targetedCtas ?? [],
      dataSource: 'clickhouse_live',
    },
    frictionHotspots,
    crawlerSectionOverlays: [],
    subtypeCounts,
  }
}
