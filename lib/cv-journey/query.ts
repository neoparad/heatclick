/**
 * CV経路分析 — ClickHouse クエリ + データ組み立て
 *
 * 親 SSOT §3.6.5 / docs/cv-journey-implementation-plan.md / phase0-spike.sql
 *
 * 設計（council 合意）:
 *   - 到達数は windowFunnel（セッション単位）→ countIf(reached>=n)。
 *   - 流入メディア(step0) は sessions テーブルの first-touch を別集計（dimension）。
 *   - 摩擦(rage/dead) は events から path 単位で集計し heatmap handoff の根拠にする。
 *   - tenant_id を必ず binding（§3.8.1）。値は全て query_params で束縛（SQL 注入防止）。
 *   - ClickHouse 失敗時は route 側で buildDummyData にフォールバック（heatmap と同思想）。
 */

import type { ClickHouseClient } from '@clickhouse/client'

import {
  buildStepCondition,
  type FunnelConfig,
} from './funnel-config'
import { maskUrlForDisplay } from './pii-mask'
import type {
  CvJourneyData,
  CvLink,
  CvNode,
  CvSource,
  CvStep,
  CvTotals,
} from '@/lib/api/cv-journey'
import type { EvidenceLevelV2 } from '@/types/evidence'

export interface BuildFunnelArgs {
  client: ClickHouseClient
  tenantId: string
  siteId: string
  startDate?: string
  endDate?: string
  deviceType?: string
  /** 流入メディア絞り込み（source.key、'all' は無視） */
  source?: string
  config: FunnelConfig
}

export interface BuildFunnelResult {
  data: CvJourneyData
  warnings: string[]
}

const OBSERVED: EvidenceLevelV2 = 'observed_exact'

/** 共通 WHERE 句（tenant / site / 期間 / device）と params を組む */
function baseFilter(args: BuildFunnelArgs): { where: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {
    tenant_id: args.tenantId,
    site_id: args.siteId,
  }
  let where = `tenant_id = {tenant_id:String} AND site_id = {site_id:String}`
  if (args.startDate) {
    where += ` AND timestamp >= toDateTime({start:String})`
    params.start = args.startDate
  }
  if (args.endDate) {
    where += ` AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY`
    params.end = args.endDate
  }
  if (args.deviceType) {
    where += ` AND device_type = {device_type:String}`
    params.device_type = args.deviceType
  }
  return { where, params }
}

/**
 * windowFunnel で各ステップ到達セッション数を取得。
 * 未対応ステップ（selector 等）は除外し warnings に記録、対応ステップのみで集計。
 */
async function fetchReachCounts(
  args: BuildFunnelArgs,
): Promise<{ reached: number[]; supportedSteps: number[]; warnings: string[] }> {
  const warnings: string[] = []
  const conditions: string[] = []
  const supportedSteps: number[] = []
  const { where, params } = baseFilter(args)
  const qp: Record<string, unknown> = { ...params, window_sec: args.config.windowSec }

  args.config.steps.forEach((step, i) => {
    const c = buildStepCondition(step, i)
    if (!c.supported) {
      warnings.push(`step ${i + 1}「${step.label}」: ${c.reason ?? '未対応'}`)
      return
    }
    conditions.push(c.expr)
    supportedSteps.push(i)
    Object.assign(qp, c.params)
  })

  if (conditions.length < 2) {
    throw new Error('windowFunnel には対応ステップが 2 件以上必要です')
  }

  // source 絞り込み: session-level attribution に一致する session_id のみ
  let sourceClause = ''
  if (args.source && args.source !== 'all') {
    sourceClause = ` AND session_id IN (
      SELECT session_id FROM clickinsight.sessions
      WHERE site_id = {site_id:String}
        AND multiIf(utm_source != '' AND utm_medium != '', concat(utm_source, ' / ', utm_medium),
                    referrer_type != '', referrer_type, 'direct / none') = {source:String}
    )`
    qp.source = args.source
  }

  const countExprs = conditions
    .map((_, i) => `countIf(reached >= ${i + 1}) AS s${i + 1}`)
    .join(',\n      ')

  const funnelExpr = conditions.join(',\n        ')

  const sql = `
    SELECT
      ${countExprs}
    FROM (
      SELECT
        session_id,
        windowFunnel({window_sec:UInt32})(
          toDateTime(timestamp),
        ${funnelExpr}
        ) AS reached
      FROM clickinsight.events
      WHERE ${where}${sourceClause}
      GROUP BY session_id
    )
  `

  const result = await args.client.query({
    query: sql,
    query_params: qp,
    format: 'JSONEachRow',
  })
  const rows = (await result.json()) as Record<string, string | number>[]
  const row = rows[0] ?? {}
  const reached = conditions.map((_, i) => Number(row[`s${i + 1}`]) || 0)
  return { reached, supportedSteps, warnings }
}

/** 流入メディア（step0）— sessions テーブルの first-touch を集計 */
async function fetchSources(args: BuildFunnelArgs): Promise<CvSource[]> {
  const params: Record<string, unknown> = { site_id: args.siteId }
  let where = `site_id = {site_id:String}`
  if (args.startDate) {
    where += ` AND start_time >= toDateTime({start:String})`
    params.start = args.startDate
  }
  if (args.endDate) {
    where += ` AND start_time < toDateTime({end:String}) + INTERVAL 1 DAY`
    params.end = args.endDate
  }
  if (args.deviceType) {
    where += ` AND device_type = {device_type:String}`
    params.device_type = args.deviceType
  }

  const sql = `
    SELECT
      multiIf(utm_source != '' AND utm_medium != '', concat(utm_source, ' / ', utm_medium),
              referrer_type != '', referrer_type, 'direct / none') AS source_medium,
      count() AS sessions
    FROM clickinsight.sessions
    WHERE ${where}
    GROUP BY source_medium
    ORDER BY sessions DESC
    LIMIT 8
  `
  const result = await args.client.query({ query: sql, query_params: params, format: 'JSONEachRow' })
  const rows = (await result.json()) as { source_medium: string; sessions: string | number }[]
  return rows.map((r) => ({
    key: r.source_medium,
    label: r.source_medium,
    sessions: Number(r.sessions) || 0,
  }))
}

/** 総セッション / CV セッション（CVR 分母確定用） */
async function fetchTotals(
  args: BuildFunnelArgs,
): Promise<{ totalSessions: number; cvSessions: number }> {
  const params: Record<string, unknown> = { site_id: args.siteId }
  let where = `site_id = {site_id:String}`
  if (args.startDate) {
    where += ` AND start_time >= toDateTime({start:String})`
    params.start = args.startDate
  }
  if (args.endDate) {
    where += ` AND start_time < toDateTime({end:String}) + INTERVAL 1 DAY`
    params.end = args.endDate
  }
  const sql = `
    SELECT
      uniqExact(session_id) AS total_sessions,
      uniqExactIf(session_id, conversion_type != '') AS cv_sessions
    FROM clickinsight.sessions
    WHERE ${where}
  `
  const result = await args.client.query({ query: sql, query_params: params, format: 'JSONEachRow' })
  const rows = (await result.json()) as { total_sessions: string | number; cv_sessions: string | number }[]
  const row = rows[0] ?? { total_sessions: 0, cv_sessions: 0 }
  return {
    totalSessions: Number(row.total_sessions) || 0,
    cvSessions: Number(row.cv_sessions) || 0,
  }
}

/** ステップ path 上の摩擦（rage/dead click）— heatmap handoff の根拠 */
async function fetchFrictionForPath(
  args: BuildFunnelArgs,
  pathContains: string,
): Promise<{ rageClicks: number; deadClicks: number }> {
  const { where, params } = baseFilter(args)
  const qp = { ...params, path: pathContains }
  const sql = `
    SELECT
      countIf(event_type = 'rage_click') AS rage_clicks,
      countIf(event_type = 'dead_click') AS dead_clicks
    FROM clickinsight.events
    WHERE ${where}
      AND event_type IN ('rage_click', 'dead_click')
      AND position(url, {path:String}) > 0
  `
  const result = await args.client.query({ query: sql, query_params: qp, format: 'JSONEachRow' })
  const rows = (await result.json()) as { rage_clicks: string | number; dead_clicks: string | number }[]
  const row = rows[0] ?? {}
  return { rageClicks: Number(row.rage_clicks) || 0, deadClicks: Number(row.dead_clicks) || 0 }
}

/** steps + sources + totals から nodes / links / totals を組み立てる（純関数・テスト可能） */
export function assembleFunnel(
  steps: CvStep[],
  sources: CvSource[],
  totalsRaw: { totalSessions: number; cvSessions: number },
): CvJourneyData {
  const nodes: CvNode[] = []
  const links: CvLink[] = []

  // source ノード（step0 列）
  const sourceTotal = sources.reduce((s, x) => s + x.sessions, 0)
  for (const src of sources) {
    nodes.push({
      id: `src-${src.key}`,
      label: src.label,
      stepIndex: -1,
      kind: 'source',
      sessions: src.sessions,
      evidenceLevel: OBSERVED,
    })
  }

  // step ノード + dropoff ノード + links
  steps.forEach((step, i) => {
    nodes.push({
      id: `step-${i}`,
      label: step.label,
      stepIndex: i,
      kind: step.kind,
      sessions: step.reached,
      evidenceLevel: OBSERVED,
    })

    // source → 最初のステップ（按分）
    if (i === 0 && sourceTotal > 0) {
      for (const src of sources) {
        links.push({
          source: `src-${src.key}`,
          target: 'step-0',
          sessions: src.sessions,
          rate: src.sessions / sourceTotal,
          kind: 'advance',
        })
      }
    }

    // 進行リンク
    if (i < steps.length - 1 && step.advanced > 0) {
      links.push({
        source: `step-${i}`,
        target: `step-${i + 1}`,
        sessions: step.advanced,
        rate: step.advanceRate,
        kind: 'advance',
      })
    }
    // 離脱リンク + dropoff ノード
    if (i < steps.length - 1 && step.dropped > 0) {
      nodes.push({
        id: `drop-${i}`,
        label: '離脱',
        stepIndex: i,
        kind: 'dropoff',
        sessions: step.dropped,
        evidenceLevel: OBSERVED,
      })
      links.push({
        source: `step-${i}`,
        target: `drop-${i}`,
        sessions: step.dropped,
        rate: step.dropRate,
        kind: 'dropoff',
      })
    }
  })

  // 最大ボトルネック（最終ステップを除く最大離脱率）
  let bottleneck: CvTotals['biggestBottleneck'] = null
  steps.slice(0, -1).forEach((step) => {
    if (step.reached > 0 && (!bottleneck || step.dropRate > bottleneck.dropRate)) {
      bottleneck = { stepIndex: step.index, label: step.label, dropRate: step.dropRate }
    }
  })

  const cvSessions = steps.length > 0 ? steps[steps.length - 1].reached : totalsRaw.cvSessions
  const cvrPct =
    totalsRaw.totalSessions > 0
      ? Math.round((cvSessions / totalsRaw.totalSessions) * 10000) / 100
      : 0

  const totals: CvTotals = {
    totalSessions: totalsRaw.totalSessions,
    cvSessions,
    cvrPct,
    cvrDenominator: 'all_sessions',
    biggestBottleneck: bottleneck,
  }

  return { steps, sources, nodes, links, totals }
}

/** reached[] からステップ配列を構築（進行/離脱率の算出） */
export function stepsFromReached(config: FunnelConfig, reached: number[], frictions: Array<{ rageClicks: number; deadClicks: number } | null>): CvStep[] {
  return config.steps.slice(0, reached.length).map((step, i) => {
    const reachedN = reached[i] ?? 0
    const advanced = i < reached.length - 1 ? reached[i + 1] ?? 0 : reachedN
    const dropped = Math.max(0, reachedN - (i < reached.length - 1 ? advanced : reachedN))
    const fr = frictions[i]
    return {
      index: i,
      label: step.label,
      kind: step.kind,
      reached: reachedN,
      advanced: i < reached.length - 1 ? advanced : reachedN,
      dropped: i < reached.length - 1 ? dropped : 0,
      advanceRate: reachedN > 0 ? advanced / reachedN : 0,
      dropRate: reachedN > 0 && i < reached.length - 1 ? dropped / reachedN : 0,
      evidenceLevel: OBSERVED,
      friction: fr
        ? { ...fr, path: maskUrlForDisplay(step.match.pathContains ?? '/') }
        : undefined,
    }
  })
}

/** メイン: 実 ClickHouse からファネルデータを構築 */
export async function buildFunnelData(args: BuildFunnelArgs): Promise<BuildFunnelResult> {
  const [{ reached, warnings }, sources, totalsRaw] = await Promise.all([
    fetchReachCounts(args),
    fetchSources(args),
    fetchTotals(args),
  ])

  // 摩擦: pathContains を持つステップのみ取得（並列、N+1 ではなく定数本数）
  const frictions = await Promise.all(
    args.config.steps.slice(0, reached.length).map(async (step) => {
      if (!step.match.pathContains) return null
      try {
        return await fetchFrictionForPath(args, step.match.pathContains)
      } catch {
        return null
      }
    }),
  )

  const steps = stepsFromReached(args.config, reached, frictions)
  const data = assembleFunnel(steps, sources, totalsRaw)
  return { data, warnings }
}
