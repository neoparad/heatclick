/**
 * CV定義 — 1スキャン集計 (compute-on-read)
 *
 * docs/cv/CV_DEFINITIONS_DESIGN.md §3 集計ビルダー / §9
 *
 * 全定義を events テーブルの **1スキャン** で同時集計する (定義ごとにクエリを撃たない)。
 *   SELECT uniqExactIf(session_id, (<pred_0>)) AS s0, countIf((<pred_0>)) AS e0, ...
 *   FROM clickinsight.events
 *   WHERE tenant_id={t} AND site_id={s} AND is_agent=0 AND timestamp >= now()-toIntervalDay({d})
 *
 * 集計対象は各定義の **ルール自体** (buildCvPredicate 単独)。
 * 「その定義のルールが期間内で何セッション一致するか」= リスト表示 / 保存前プレビューの数字。
 * cvKey の和集合 (定義述語 OR 生 conversion_type) は消費側 (cv-journey / paths) の C2 結線に属し、
 * ここでは使わない (プレビューでルールをテストする際に、cvKey 共有の過去データで
 * ルール0件を非0に見せて誤認させないため)。
 *
 * base WHERE は paths baseEventQuery (lib/paths/stats-query.ts:113-127) と同一契約。
 * 将来 lib/analytics/ の共通 buildEventBaseFilter に収束 (設計書 §7 seam 2)。
 */

import type { ClickHouseClient } from '@clickhouse/client'

import { buildCvPredicate } from './predicate'
import type { CvScope, CvTrigger } from './types'

/** periodDays 上限 (paths / cv-journey と同じ 365) */
export const CV_STATS_MAX_PERIOD_DAYS = 365
export const CV_STATS_DEFAULT_PERIOD_DAYS = 30

/** 集計対象 (CvDefinition の部分。id は結果の対応付け用、cvKey は表示用) */
export interface CvStatsTarget {
  id: string
  cvKey: string
  trigger: CvTrigger
  scope?: CvScope
}

export interface CvStatRow {
  defId: string
  cvKey: string
  /** ルールが一致したユニークセッション数 (主指標) */
  cvSessions: number
  /** ルールが一致したイベント件数 (副指標) */
  cvEvents: number
  /** false = ルールが未対応/不正 (SQL展開せず0。捏造でなく「計算対象外」) */
  supported: boolean
  reason?: string
}

export interface CvStatsResult {
  /** false = ClickHouse クエリ自体が失敗 (定義は返すが統計未計算)。UI が可視化する */
  statsComputed: boolean
  periodDays: number
  rows: CvStatRow[]
  /** statsComputed=false 時の理由 (CH生エラーは載せない) */
  reason?: string
}

export interface ComputeCvStatsArgs {
  tenantId: string
  siteId: string
  periodDays: number
}

function validateArgs(args: ComputeCvStatsArgs): void {
  if (!args.tenantId || !args.siteId) {
    throw new Error('CV stats require tenant and site scope')
  }
  if (
    !Number.isInteger(args.periodDays) ||
    args.periodDays < 1 ||
    args.periodDays > CV_STATS_MAX_PERIOD_DAYS
  ) {
    throw new Error(`CV stats periodDays must be an integer from 1 through ${CV_STATS_MAX_PERIOD_DAYS}`)
  }
}

function toNonNegativeCount(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 0
}

/**
 * 全定義を1スキャンで集計する。
 * ClickHouse 失敗時は throw せず statsComputed:false を返す (CH生エラーを外に漏らさない)。
 * 未対応の定義は SQL に含めず supported:false で報告する。
 */
export async function computeCvStats(
  client: ClickHouseClient,
  targets: ReadonlyArray<CvStatsTarget>,
  args: ComputeCvStatsArgs,
): Promise<CvStatsResult> {
  validateArgs(args)

  // 各定義の述語を構築。未対応は後で supported:false として素通しする。
  const predicates = targets.map((target, index) => ({
    target,
    index,
    predicate: buildCvPredicate(target, `cv${index}`),
  }))
  const supported = predicates.filter((entry) => entry.predicate.supported)

  const unsupportedRows = (): CvStatRow[] =>
    predicates
      .filter((entry) => !entry.predicate.supported)
      .map((entry) => ({
        defId: entry.target.id,
        cvKey: entry.target.cvKey,
        cvSessions: 0,
        cvEvents: 0,
        supported: false,
        reason: entry.predicate.reason,
      }))

  // 集計対象が1つも無い (全て未対応 / 定義ゼロ) → CH を叩かず即返す。
  if (supported.length === 0) {
    return { statsComputed: true, periodDays: args.periodDays, rows: unsupportedRows() }
  }

  const selectParts: string[] = []
  const queryParams: Record<string, string | number> = {
    tenant_id: args.tenantId,
    site_id: args.siteId,
    period_days: args.periodDays,
  }
  for (let i = 0; i < supported.length; i++) {
    const { predicate } = supported[i]
    selectParts.push(
      `uniqExactIf(session_id, (${predicate.expr})) AS s${i}`,
      `countIf((${predicate.expr})) AS e${i}`,
    )
    Object.assign(queryParams, predicate.params)
  }

  const query = `
    SELECT ${selectParts.join(',\n      ')}
    FROM clickinsight.events
    WHERE tenant_id = {tenant_id:String}
      AND site_id = {site_id:String}
      AND is_agent = 0
      AND timestamp >= now() - toIntervalDay({period_days:UInt16})
  `.trim()

  try {
    const result = await client.query({ query, query_params: queryParams, format: 'JSONEachRow' })
    const rows = await result.json<Record<string, unknown>>()
    const row = rows[0] ?? {}

    const computedRows: CvStatRow[] = supported.map((entry, i) => ({
      defId: entry.target.id,
      cvKey: entry.target.cvKey,
      cvSessions: toNonNegativeCount(row[`s${i}`]),
      cvEvents: toNonNegativeCount(row[`e${i}`]),
      supported: true,
    }))

    // 元の定義順を保つ (supported と unsupported を index 順にマージ)
    const byId = new Map<string, CvStatRow>()
    for (const r of [...computedRows, ...unsupportedRows()]) byId.set(r.defId, r)
    const ordered = targets.map((t) => byId.get(t.id)).filter((r): r is CvStatRow => r !== undefined)

    return { statsComputed: true, periodDays: args.periodDays, rows: ordered }
  } catch {
    // CH生エラーは外に出さない。全定義を「未計算」で返し、UI が statsComputed:false を可視化する。
    return {
      statsComputed: false,
      periodDays: args.periodDays,
      reason: 'clickhouse_error',
      rows: targets.map((t) => ({
        defId: t.id,
        cvKey: t.cvKey,
        cvSessions: 0,
        cvEvents: 0,
        supported: true,
      })),
    }
  }
}
