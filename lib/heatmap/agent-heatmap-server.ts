/**
 * Server-only ClickHouse helpers for Browser-Operating AI Agent Hybrid Heatmap (`lib/heatmap/agent-heatmap-server.ts`)
 *
 * Separated from `agent-heatmap-client.ts` so browser client bundles never pull in
 * `@clickhouse/client` (`node:os`) or `node:crypto`.
 *
 * Wave 0 (束 0-A 止血):
 *   - ClickHouse クエリ (`fetchAgentHeatmapPoints`, `fetchAgentBehaviorSummary`) に
 *     `tenant_id = {tenant_id:String}` を無条件で必須適用（`tenantId` 未指定時は fail-closed）。
 */

import type { ClickHouseClient } from '@clickhouse/client'
import type { HeatmapPoint } from '@/lib/api/heatmap'
import { getClickHouseClient } from '@/lib/clickhouse'
import { canonicalizeHeatmapUrl, canonicalUrlSql } from '@/lib/heatmap/canonical-url'
import { agentSubtypeFilterSql } from '@/lib/heatmap/segment-filter'
import {
  parseAgentSubtype,
  type AgentBehaviorSummary,
  type AgentSubtype,
} from '@/lib/heatmap/agent-heatmap-client'

/**
 * Server/BFF helper: Queries ClickHouse `events` (`is_agent = 1`) for raw agent click/dead/rage points.
 * Fail-closed when `tenantId` is absent or `'default'`; gracefully returns `[]` if ClickHouse is offline.
 */
export async function fetchAgentHeatmapPoints(params: {
  tenantId?: string
  siteId: string
  pageUrl: string
  deviceType?: string
  agentSubtype?: AgentSubtype
  clickhouse?: ClickHouseClient | null
}): Promise<Array<HeatmapPoint & { selector?: string; eventType?: string }>> {
  const cleanTenantId = (params.tenantId || '').trim()
  if (!cleanTenantId || cleanTenantId === 'default') {
    return []
  }

  let ch: ClickHouseClient
  if (params.clickhouse !== undefined) {
    if (!params.clickhouse) return []
    ch = params.clickhouse
  } else {
    if (!process.env.CLICKHOUSE_URL || !process.env.CLICKHOUSE_PASSWORD) {
      return []
    }
    if (process.env.NODE_ENV === 'test' && process.env.CLICKHOUSE_LIVE_TEST !== '1') {
      return []
    }
    ch = getClickHouseClient('analytics_reader')
  }

  try {
    const canonUrl = canonicalizeHeatmapUrl(params.pageUrl)
    const subFilter = agentSubtypeFilterSql(parseAgentSubtype(params.agentSubtype))
    const rs = await ch.query({
      query: `
        SELECT
          toUInt16(least(1280, greatest(0, round(avg(if(viewport_width > 0, click_x * 1280 / viewport_width, click_x)))))) AS x,
          toUInt32(round(avg(click_y))) AS y,
          count() AS count,
          uniqExact(session_id) AS sessions,
          anyLast(element_selector) AS selector,
          anyLast(event_type) AS eventType
        FROM clickinsight.events
        WHERE tenant_id = {tenant_id:String}
          AND site_id = {site_id:String}
          AND ${canonicalUrlSql('url')} = {page_url:String}
          AND is_agent = 1
          ${subFilter}
          AND event_type IN ('click', 'dead_click', 'rage_click')
        GROUP BY element_selector, event_type
        ORDER BY count DESC
        LIMIT 25
      `,
      query_params: {
        tenant_id: cleanTenantId,
        site_id: params.siteId,
        page_url: canonUrl,
      },
      format: 'JSONEachRow',
    })
    const rows = (await rs.json()) as Array<{
      x: number
      y: number
      count: number
      sessions: number
      selector?: string
      eventType?: string
    }>
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/**
 * Server/BFF helper: Queries ClickHouse `events` (`is_agent = 1`) for overall agent session/scroll summary.
 * Fail-closed when `tenantId` is absent or `'default'`; gracefully returns `null` if ClickHouse is offline.
 */
export async function fetchAgentBehaviorSummary(params: {
  tenantId?: string
  siteId: string
  pageUrl: string
  deviceType?: string
  agentSubtype?: AgentSubtype
  clickhouse?: ClickHouseClient | null
}): Promise<Partial<AgentBehaviorSummary> | null> {
  const cleanTenantId = (params.tenantId || '').trim()
  if (!cleanTenantId || cleanTenantId === 'default') {
    return null
  }

  let ch: ClickHouseClient
  if (params.clickhouse !== undefined) {
    if (!params.clickhouse) return null
    ch = params.clickhouse
  } else {
    if (!process.env.CLICKHOUSE_URL || !process.env.CLICKHOUSE_PASSWORD) {
      return null
    }
    if (process.env.NODE_ENV === 'test' && process.env.CLICKHOUSE_LIVE_TEST !== '1') {
      return null
    }
    ch = getClickHouseClient('analytics_reader')
  }

  try {
    const canonUrl = canonicalizeHeatmapUrl(params.pageUrl)
    const subFilter = agentSubtypeFilterSql(parseAgentSubtype(params.agentSubtype))
    const rs = await ch.query({
      query: `
        SELECT
          uniqExact(session_id) AS sessions,
          countIf(event_type = 'click') AS clicks,
          countIf(event_type = 'dead_click') AS dead_clicks,
          countIf(event_type = 'rage_click') AS rage_clicks,
          round(avgIf(scroll_percentage, scroll_percentage > 0)) AS avg_scroll
        FROM clickinsight.events
        WHERE tenant_id = {tenant_id:String}
          AND site_id = {site_id:String}
          AND ${canonicalUrlSql('url')} = {page_url:String}
          AND is_agent = 1
          ${subFilter}
      `,
      query_params: {
        tenant_id: cleanTenantId,
        site_id: params.siteId,
        page_url: canonUrl,
      },
      format: 'JSONEachRow',
    })
    const rows = (await rs.json()) as Array<{
      sessions: number
      clicks: number
      dead_clicks: number
      rage_clicks: number
      avg_scroll: number
    }>
    const row = rows[0]
    if (!row || Number(row.sessions) <= 0) return null
    return {
      totalAgentSessions: Number(row.sessions),
      totalAgentClicks: Number(row.clicks),
      totalDeadClicks: Number(row.dead_clicks),
      totalRageClicks: Number(row.rage_clicks),
      avgScrollDepthPct: Number(row.avg_scroll) || 0,
      dataSource: 'clickhouse_live',
    }
  } catch {
    return null
  }
}
