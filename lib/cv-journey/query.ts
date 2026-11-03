/**
 * CV経路分析 — ClickHouse クエリ + データ組み立て
 *
 * 親 SSOT §3.6.5 / docs/cv-journey-implementation-plan.md / phase0-spike.sql
 *
 * 設計（council 合意 / 2026-07-14 events 化）:
 *   - 到達数は windowFunnel（セッション単位）→ countIf(reached>=n)。
 *   - 流入メディア(step0)・総数/CV は **events の first-touch / uniqExact 集計**。
 *     旧実装は `clickinsight.sessions` を読んでいたが、sessions は writer が一度も
 *     実装されておらず全件空 (2026-07-14 実CH確定) のため常に 0 になっていた。
 *     referrer_type は events に列が無いため生 referrer から SQL 内で分類導出する
 *     (events-source.ts)。
 *   - 摩擦(rage/dead) は events から path 単位で集計し heatmap handoff の根拠にする。
 *   - tenant_id を必ず binding（§3.8.1、全クエリ）。値は全て query_params で束縛（SQL 注入防止）。
 *   - 品質ゲート: 全クエリ is_agent = 0 (bot 除外、heatmap と同基準) + session_id 非空
 *     (空 session_id が uniqExact / windowFunnel の1セッションに合算されるのを防ぐ)。
 *   - ClickHouse 失敗時は route 側で buildDummyData にフォールバック（heatmap と同思想）。
 */

import type { ClickHouseClient } from '@clickhouse/client'

import { buildCvPredicate } from '@/lib/conversions/predicate'
import type { CvScope, CvTrigger } from '@/lib/conversions/types'
import { buildFirstTouchSessionsSubquery } from './events-source'
import {
  buildStepCondition,
  type CvDefinitionForResolution,
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
  /**
   * C2 (docs/cv/CV_DEFINITIONS_DESIGN.md §7): サイトの有効な CV定義。
   * - conversion ステップの conversionType が定義の cvKey と一致すれば、その定義の述語を
   *   和集合 (定義述語 OR 生conversion_type一致) で解決する (buildStepCondition 経由)。
   * - fetchTotals の CV総数も同様に「いずれかの定義 OR 生conversion_type非空」へ一般化する。
   * 未指定/空配列は完全後方互換 (従来通り生conversion_typeのみで判定)。
   */
  cvDefinitions?: ReadonlyArray<{ cvKey: string; trigger: CvTrigger; scope?: CvScope }>
}

export interface BuildFunnelResult {
  data: CvJourneyData
  warnings: string[]
}

const OBSERVED: EvidenceLevelV2 = 'observed_exact'

/** 共通 WHERE 句（tenant / site / 期間 / device / bot 除外 / session 非空）と params を組む */
function baseFilter(args: BuildFunnelArgs): { where: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {
    tenant_id: args.tenantId,
    site_id: args.siteId,
  }
  let where =
    `tenant_id = {tenant_id:String} AND site_id = {site_id:String}` +
    ` AND is_agent = 0 AND session_id != ''`
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
 * args.source 指定時の session 絞り込み句 (events first-touch attribution)。
 * funnel(分子)・totals(分母)・friction の全てに同じ絞り込みを適用し、
 * 「分子だけフィルタされ CVR 分母が全体のまま」という指標不一致を防ぐ。
 */
function sourceFilter(
  args: BuildFunnelArgs,
  where: string,
): { clause: string; params: Record<string, unknown> } {
  if (!args.source || args.source === 'all') return { clause: '', params: {} }
  return {
    clause: ` AND session_id IN (
      SELECT session_id FROM (${buildFirstTouchSessionsSubquery(where)})
      WHERE source_medium = {source:String}
    )`,
    params: { source: args.source },
  }
}

/** args.cvDefinitions を cvKey→{trigger,scope} の Map に射影する (buildStepCondition の解決用) */
function buildCvDefinitionsByKey(
  cvDefinitions: BuildFunnelArgs['cvDefinitions'],
): ReadonlyMap<string, CvDefinitionForResolution> | undefined {
  if (!cvDefinitions || cvDefinitions.length === 0) return undefined
  return new Map(cvDefinitions.map((d) => [d.cvKey, { trigger: d.trigger, scope: d.scope }]))
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
  const cvDefinitionsByKey = buildCvDefinitionsByKey(args.cvDefinitions)

  args.config.steps.forEach((step, i) => {
    const c = buildStepCondition(step, i, cvDefinitionsByKey)
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

  // source 絞り込み: events first-touch の session-level attribution に一致する session_id のみ
  const src = sourceFilter(args, where)
  Object.assign(qp, src.params)

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
      WHERE ${where}${src.clause}
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

/** 流入メディア（step0）— events の first-touch (session 最初のイベント) を分類・集計 */
async function fetchSources(args: BuildFunnelArgs): Promise<CvSource[]> {
  const { where, params } = baseFilter(args)
  const sql = `
    SELECT source_medium, count() AS sessions
    FROM (${buildFirstTouchSessionsSubquery(where)})
    GROUP BY source_medium
    ORDER BY sessions DESC, source_medium ASC
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

/**
 * 総セッション / CV セッション（CVR 分母確定用）— events の uniqExact 集計。
 * conversion_type は Nullable のため ifNull で NULL-safe に判定する。
 * 旧実装と異なり deviceType / source 絞り込みも適用する (画面のフィルタと分母を一致させ、
 * 分子だけフィルタされて CVR が崩れるのを防ぐ)。
 *
 * C2: args.cvDefinitions が指定されていれば、CV判定を「いずれかの有効な定義に一致 OR
 * 生conversion_type非空」の和集合へ一般化する。これにより click 型定義 (例: 楽天アフィリの
 * outbound クリック) が捕捉する「ラベルの無い過去クリック」も CV総数に遡って反映される
 * (docs/cv/CV_DEFINITIONS_DESIGN.md §7 C2)。未指定/全定義unsupportedなら完全後方互換。
 */
async function fetchTotals(
  args: BuildFunnelArgs,
): Promise<{ totalSessions: number; cvSessions: number }> {
  const { where, params } = baseFilter(args)
  const src = sourceFilter(args, where)

  let cvExpr = `ifNull(conversion_type, '') != ''`
  const cvParams: Record<string, string> = {}
  if (args.cvDefinitions && args.cvDefinitions.length > 0) {
    const parts: string[] = []
    args.cvDefinitions.forEach((def, i) => {
      const predicate = buildCvPredicate(def, `cvt${i}`)
      if (!predicate.supported) return
      parts.push(`(${predicate.expr})`)
      Object.assign(cvParams, predicate.params)
    })
    if (parts.length > 0) {
      cvExpr = `((${parts.join(' OR ')}) OR ifNull(conversion_type, '') != '')`
    }
  }

  const sql = `
    SELECT
      uniqExact(session_id) AS total_sessions,
      uniqExactIf(session_id, ${cvExpr}) AS cv_sessions
    FROM clickinsight.events
    WHERE ${where}${src.clause}
  `
  const result = await args.client.query({
    query: sql,
    query_params: { ...params, ...src.params, ...cvParams },
    format: 'JSONEachRow',
  })
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
  const src = sourceFilter(args, where)
  const qp = { ...params, ...src.params, path: pathContains }
  const sql = `
    SELECT
      countIf(event_type = 'rage_click') AS rage_clicks,
      countIf(event_type = 'dead_click') AS dead_clicks
    FROM clickinsight.events
    WHERE ${where}${src.clause}
      AND event_type IN ('rage_click', 'dead_click')
      AND position(ifNull(url, ''), {path:String}) > 0
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
  const [{ reached, supportedSteps, warnings }, sources, totalsRaw] = await Promise.all([
    fetchReachCounts(args),
    fetchSources(args),
    fetchTotals(args),
  ])

  // reached[i] は「対応ステップのみ」の windowFunnel 結果。config.steps の先頭 N 個ではなく
  // supportedSteps (元インデックス) で整列させないと、非対応ステップが中間にある構成で
  // ラベルと到達数がズレる (code-review 指摘)。
  const effectiveConfig: FunnelConfig = {
    ...args.config,
    steps: supportedSteps.map((i) => args.config.steps[i]),
  }

  // 摩擦: pathContains を持つステップのみ取得（並列、N+1 ではなく定数本数）
  const frictions = await Promise.all(
    effectiveConfig.steps.slice(0, reached.length).map(async (step) => {
      if (!step.match.pathContains) return null
      try {
        return await fetchFrictionForPath(args, step.match.pathContains)
      } catch {
        return null
      }
    }),
  )

  const steps = stepsFromReached(effectiveConfig, reached, frictions)
  const data = assembleFunnel(steps, sources, totalsRaw)
  return { data, warnings }
}
