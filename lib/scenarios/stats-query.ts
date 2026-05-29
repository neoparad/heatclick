/**
 * M-Director Stage 7 (続 M-12) — Scenario stats query (ClickHouse)
 *
 * Queries `clickinsight.scenario_match` for impression / click / CVR aggregates.
 *
 * Reference:
 *   - data-model.md §3 (scenario_match table schema)
 *   - lib/clickhouse.ts (analytics_reader role)
 *   - 続 M-9 §6 Stage 7 配備計画
 *
 * Resilience:
 *   - scenario_match table が未作成 (migration 未適用) でも graceful empty 返却
 *   - tenant_id 注入は呼出側で必須、本 module は scenario_id + tenant_id を受け取る
 *
 * Phase 2 scope:
 *   - 24h / 7d / 30d の totals + 時系列 (1h buckets for 24h、1d buckets for 7d/30d)
 *   - Phase 3 で per-variant 分割 + CVR funnel + cohort 比較
 */

import { getClickHouseClient } from '@/lib/clickhouse'

export interface StatsRange {
  from: Date
  to: Date
  bucket: 'hour' | 'day'
}

export interface ScenarioStatsTotals {
  match_count: number
  impression_count: number
  click_count: number
  conversion_count: number
  dismiss_count: number
  click_through_rate: number // click_count / impression_count
  conversion_rate: number // conversion_count / impression_count
}

export interface ScenarioStatsBucket {
  ts: string // ISO datetime (bucket start)
  match_count: number
  impression_count: number
  click_count: number
  conversion_count: number
}

export interface ScenarioStats {
  scenario_id: string
  tenant_id: string
  range_from: string
  range_to: string
  bucket: 'hour' | 'day'
  totals: ScenarioStatsTotals
  series: ScenarioStatsBucket[]
  /** true if scenario_match table not present (graceful empty) */
  data_unavailable: boolean
  data_unavailable_reason?: string
}

const VALID_BUCKET = new Set<'hour' | 'day'>(['hour', 'day'])

export async function queryScenarioStats(args: {
  tenantId: string
  scenarioId: string
  range: StatsRange
}): Promise<ScenarioStats> {
  const { tenantId, scenarioId, range } = args
  if (!VALID_BUCKET.has(range.bucket)) {
    throw new Error(`invalid bucket: ${range.bucket}`)
  }
  if (range.from >= range.to) {
    throw new Error('from must be < to')
  }

  // analytics_reader role (SELECT only)
  let ch
  try {
    ch = getClickHouseClient('analytics_reader')
  } catch (e) {
    // production で role credential 未投入 → graceful empty
    return emptyStats(args, `clickhouse_role_unavailable: ${(e as Error).message}`)
  }

  // Build queries with parameter binding (tenant_id WHERE は必ず注入)
  const totalsQuery = `
    SELECT
      countIf(match_type = 'match') AS match_count,
      countIf(match_type = 'impression') AS impression_count,
      countIf(match_type = 'click') AS click_count,
      countIf(match_type = 'conversion') AS conversion_count,
      countIf(match_type = 'dismiss') AS dismiss_count
    FROM clickinsight.scenario_match
    WHERE tenant_id = {tenant_id:String}
      AND scenario_id = {scenario_id:String}
      AND timestamp >= {from:DateTime}
      AND timestamp < {to:DateTime}
  `

  const bucketExpr =
    range.bucket === 'hour' ? 'toStartOfHour(timestamp)' : 'toStartOfDay(timestamp)'

  const seriesQuery = `
    SELECT
      ${bucketExpr} AS ts,
      countIf(match_type = 'match') AS match_count,
      countIf(match_type = 'impression') AS impression_count,
      countIf(match_type = 'click') AS click_count,
      countIf(match_type = 'conversion') AS conversion_count
    FROM clickinsight.scenario_match
    WHERE tenant_id = {tenant_id:String}
      AND scenario_id = {scenario_id:String}
      AND timestamp >= {from:DateTime}
      AND timestamp < {to:DateTime}
    GROUP BY ts
    ORDER BY ts ASC
  `

  const params = {
    tenant_id: tenantId,
    scenario_id: scenarioId,
    from: range.from.toISOString().replace('T', ' ').slice(0, 19),
    to: range.to.toISOString().replace('T', ' ').slice(0, 19),
  }

  try {
    const [totalsResult, seriesResult] = await Promise.all([
      ch.query({ query: totalsQuery, query_params: params, format: 'JSONEachRow' }),
      ch.query({ query: seriesQuery, query_params: params, format: 'JSONEachRow' }),
    ])
    const totalsRows = (await totalsResult.json()) as Array<{
      match_count: string | number
      impression_count: string | number
      click_count: string | number
      conversion_count: string | number
      dismiss_count: string | number
    }>
    const seriesRows = (await seriesResult.json()) as Array<{
      ts: string
      match_count: string | number
      impression_count: string | number
      click_count: string | number
      conversion_count: string | number
    }>

    const t = totalsRows[0] ?? {
      match_count: 0,
      impression_count: 0,
      click_count: 0,
      conversion_count: 0,
      dismiss_count: 0,
    }
    const impressionCount = Number(t.impression_count)
    const clickCount = Number(t.click_count)
    const conversionCount = Number(t.conversion_count)

    return {
      scenario_id: scenarioId,
      tenant_id: tenantId,
      range_from: range.from.toISOString(),
      range_to: range.to.toISOString(),
      bucket: range.bucket,
      totals: {
        match_count: Number(t.match_count),
        impression_count: impressionCount,
        click_count: clickCount,
        conversion_count: conversionCount,
        dismiss_count: Number(t.dismiss_count),
        click_through_rate: impressionCount > 0 ? clickCount / impressionCount : 0,
        conversion_rate: impressionCount > 0 ? conversionCount / impressionCount : 0,
      },
      series: seriesRows.map((r) => ({
        ts: r.ts,
        match_count: Number(r.match_count),
        impression_count: Number(r.impression_count),
        click_count: Number(r.click_count),
        conversion_count: Number(r.conversion_count),
      })),
      data_unavailable: false,
    }
  } catch (e) {
    const message = (e as Error).message
    // scenario_match table 未作成 (migration 未適用) を graceful 扱い
    if (/UNKNOWN_TABLE|doesn't exist|does not exist/i.test(message)) {
      return emptyStats(
        args,
        'scenario_match table not yet created (migrations/2026-05-25-m1-scenario-match-ch.sql 未適用)',
      )
    }
    throw e
  }
}

function emptyStats(
  args: { tenantId: string; scenarioId: string; range: StatsRange },
  reason: string,
): ScenarioStats {
  return {
    scenario_id: args.scenarioId,
    tenant_id: args.tenantId,
    range_from: args.range.from.toISOString(),
    range_to: args.range.to.toISOString(),
    bucket: args.range.bucket,
    totals: {
      match_count: 0,
      impression_count: 0,
      click_count: 0,
      conversion_count: 0,
      dismiss_count: 0,
      click_through_rate: 0,
      conversion_rate: 0,
    },
    series: [],
    data_unavailable: true,
    data_unavailable_reason: reason,
  }
}

// ── Preset ranges ────────────────────────────────────────────────────────

export function buildPresetRange(preset: '24h' | '7d' | '30d', now: Date = new Date()): StatsRange {
  const to = now
  const ms = preset === '24h' ? 24 * 3600 * 1000 : preset === '7d' ? 7 * 86400 * 1000 : 30 * 86400 * 1000
  return {
    from: new Date(to.getTime() - ms),
    to,
    bucket: preset === '24h' ? 'hour' : 'day',
  }
}
