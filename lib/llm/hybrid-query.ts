/**
 * lib/llm/hybrid-query.ts — Hybrid query engine (raw 2h + MV historical) (続 68 W2-A、続 66 §3 M-2)
 *
 * 親 SSOT §3.6.5 ClickHouse / Infra 続 67 D-1 (AggregatingMergeTree 3-tier)
 * 配備根拠: Codex Round 1+2+3 + 続 66 §2 Layer 2 (AggregatingMergeTree + Hybrid query + parentQueryId)
 *
 * 目的:
 *   - 4 tier (hourly / daily / monthly) を期間長で自動選択
 *   - 直近 2 時間は raw `events` table (新鮮性) + それ以前は MV (集計性能)
 *   - UNION ALL で結合、tenant_id / site_id parameter binding 厳守 (CLAUDE.md tenant isolation)
 *   - parent query registry (in-memory、TTL 5min) で `parentQueryId` enforcement
 *
 * 制約 (続 64 hardening 継承):
 *   - `siteId` / `tenantId` は server-controlled (caller が ctx + body 検証済 site から渡す)
 *   - SQL injection 防御: 全 dynamic value は `query_params` 経由 (文字列連結禁止)
 *   - max_execution_time = 30s (clickhouse.ts `analytics_reader` role 既定)
 *
 * Infra 続 67 D-1 schema 依存 (production 投入後に実 query 実行):
 *   - `clickinsight.events_hourly_by_dim` AggregatingMergeTree (4 dim: page_url/device/persona/all)
 *   - `clickinsight.events_daily_by_dim` (hourly states → daily states)
 *   - `clickinsight.events_monthly_by_dim` (daily states → monthly states)
 *   - 既存 `clickinsight.events` raw (Infra 続 56)
 */

import { randomUUID } from 'node:crypto'

import { getClickHouseClient } from '@/lib/clickhouse'
import type { EvidenceLevelV2 } from '@/types/evidence'

// ── Types ───────────────────────────────────────────────────────────

export type AnalyticsTier = 'hourly' | 'daily' | 'monthly'

/**
 * 続 80 Director hot fix: UI/LLM 概念名 (AnalyticsDim) と DB 物理 dim 値 (StorageDim) の分離。
 * Codex 続 80 review で発覚した schema-code mismatch を adapter で吸収。
 *
 * - AnalyticsDim: UI / API / LLM 向け概念名 (mockup と整合)
 * - StorageDim: clickinsight.events_hourly_by_dim の dim 列実値 (続 67 fix で 'url'/'device_type'/'all' 確定)
 * - persona は S2-03 別 table 配備まで unsupported (続 67 で MV 削除済)
 *
 * 続 82-ml skeleton (2026-05-25):
 *   Infra 続 82 で events_hourly_by_dim に dim ∈ {'utm_source', 'visitor_type'} が追加予定。
 *   本 skeleton では型のみ拡張し、SQL は触らない。Infra 完了 (2026-06-01) 後に SQL revival で
 *   実 query 結果が返るようになる。Infra 未完了の間に utm_source / visitor_type で query しても
 *   events_hourly_by_dim に該当 dim 行が存在しないため空 result が返る (benign)。
 */
export type AnalyticsDim =
  | 'page_url'
  | 'device'
  | 'utm_source' // 続 82-ml skeleton: Infra 完了後 organic/cpc/paid/direct/referral 5 bucket 正規化
  | 'visitor_type' // 続 82-ml skeleton: Infra 完了後 'new' | 'returning'
  | 'all'
type StorageDim = 'url' | 'device_type' | 'utm_source' | 'visitor_type' | 'all'

function toStorageDim(dim: AnalyticsDim): StorageDim {
  if (dim === 'page_url') return 'url'
  if (dim === 'device') return 'device_type'
  if (dim === 'utm_source') return 'utm_source'
  if (dim === 'visitor_type') return 'visitor_type'
  return 'all'
}

/**
 * raw events table の dim filter SQL 式を返す (UNION raw 側 WHERE 用)。'all' / 'unsupported' は null。
 *
 * 続 82-ml Phase 2 (2026-05-25): Infra 続 82 で events table に utm_source / is_first_visit 列追加済。
 * MV 側の dim_value 正規化 (続 82 mv-bounce-revival SQL Step 3d/3e) に揃え:
 *   - utm_source: `if(utm_source = '', '__none__', utm_source)` (空文字は '__none__' 集約)
 *   - visitor_type: `if(is_first_visit, 'new', 'returning')` (Bool → string derive)
 * raw 側 WHERE で同 expr を比較することで MV と raw の集計が dim_value 軸で整合する。
 */
function toRawColumn(dim: AnalyticsDim): string | null {
  if (dim === 'page_url') return 'url'
  if (dim === 'device') return 'device_type'
  // 続 82-ml Phase 2: events.utm_source 列追加済 (Infra 続 82 Step 1 SQL)。
  // MV の dim_value 正規化と整合させるため if() で空文字を '__none__' に変換。
  if (dim === 'utm_source') return "if(utm_source = '', '__none__', utm_source)"
  // 続 82-ml Phase 2: events.is_first_visit Bool 列追加済 (Infra 続 82 Step 1 SQL)。
  // MV (mv_events_hourly_visitor_type_v2) と同じ derive で 'new'/'returning' の dim_value を再現。
  if (dim === 'visitor_type') return "if(is_first_visit, 'new', 'returning')"
  return null
}

/**
 * 続 78 Task B: bounce_rate / session_duration を削除 (続 67 D-1 schema 整合)。
 *
 * 経緯:
 *   - 続 67 §1 で `events_hourly_by_dim` から `bounce_sessions` / `session_duration_td` を削除
 *     (raw `events` table に `is_bounce` / `session_duration_sec` 列が存在しないため
 *      AggregatingMergeTree state を作れない)。
 *   - 続 68 ML で hybrid query を実装した時点で旧 schema 想定の SELECT が残り、
 *     production で `Unknown expression or function identifier 'bounce_sessions'`
 *     (ClickHouse Code 47) が発生。
 *   - MVP に bounce metric 必須ではないため、本続 78 で metric 自体を unsupported 化し
 *     code から SELECT 削除する (本続 78 §Task B Approach A、Frontend 判断)。
 *
 * 続 82-ml skeleton (2026-05-25): metric 復活、ただし SQL は Infra 完了待ち。
 *   - Infra 続 82 で sessions_hourly intermediate + events_hourly_by_dim 再 attach 予定
 *     (`bounce_sessions` uniqCombined64IfState + `session_duration_td` quantileTDigestState)
 *   - raw events table に `session_duration_sec` UInt32 + `page_views_in_session` UInt16 列追加予定
 *   - 本 skeleton で enum と summary 型のみ復活、SQL revival は Phase 2 (Infra 完了報告後) で実施。
 *   - Infra 未完了の間に bounce_rate / avg_session_duration を request しても summary は null を返す
 *     (executeAnalyticsQuery の SELECT は現状 cvr/sessions/page_views のみ生成)。
 */
export const ANALYTICS_METRICS = [
  'cvr',
  'page_views',
  'sessions',
  // 続 82-ml skeleton: Infra 完了待ち。Phase 2 で SQL revival 後に実値返却に切替。
  'bounce_rate',
  'avg_session_duration',
] as const
export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number]

export const MAX_PERIOD_DAYS_ANALYTICS = 365 // monthly tier の上限

export interface AnalyticsDateRange {
  /** ISO 8601 (e.g., '2026-05-16T00:00:00') — timezone-naive、`timezone` パラメータで解釈 */
  start: string
  end: string
}

export interface AnalyticsQueryInput {
  siteId: string // server-controlled (caller 責務)
  tenantId: string // server-controlled (caller 責務)
  dim: AnalyticsDim
  dimValue: string // 'all' の場合は '__all__'
  dateRange: AnalyticsDateRange
  metrics: ReadonlyArray<AnalyticsMetric>
  timezone: string // e.g., 'Asia/Tokyo'
}

export interface BucketRow {
  bucket_start: string
  sessions: number
  conversions: number
  page_views: number
  /**
   * 続 82-ml Phase 2 (2026-05-25): bounce sessions 数。
   * - MV 側: uniqCombined64IfMerge(bounce_sessions) — 続 82 mv-bounce-revival で _v2 MV が populate
   * - Raw 側: uniqExactIf(session_id, event_type='session_end' AND page_views_in_session<=1 AND session_duration_sec<10)
   * - caveat: session_end イベント未到達 session は除外 (bounce 判定不能)
   */
  bounce_sessions: number
  /**
   * 続 82-ml Phase 2 (2026-05-25): p50 セッション継続時間 (秒)。
   * - MV 側: quantileTDigestMerge(0.5)(session_duration_td)
   * - Raw 側: quantileTDigestIf(0.5)(session_duration_sec, event_type='session_end')
   */
  p50_duration: number
  /**
   * 続 81 Director hot fix: row source flag
   * - 'mv': events_*_by_dim (uniqCombined64Merge、〜2% 誤差)
   * - 'raw': events table 直接 (uniqExact、誤差ゼロ)
   * 全 row が 'raw' の場合 evidenceLevel='observed_exact' に格上げ、UI で "実測 X%" と表記可能。
   */
  source: 'mv' | 'raw'
}

export interface AnalyticsQueryResult {
  tier: AnalyticsTier
  rows: BucketRow[]
  /** weakest evidence level among data sources (raw=observed_exact, MV approx=observed_approx) */
  evidenceLevel: EvidenceLevelV2
  /** uniqCombined64 等の近似集計を使った場合の論理的目安誤差 (%) */
  approxErrorPct: number | null
  /** SQL 内で使った approximation 関数名 (audit 用) */
  approximation: string[]
  summary: {
    sessions: number
    conversions: number
    cvr: number | null
    pageViews: number
    /**
     * 続 82-ml Phase 2 (2026-05-25): bounce session 比率 (0.0〜1.0)。
     * `sum(bounce_sessions) / sum(sessions)`、bucket 横断で算出。
     * session_end イベント未到達 session は分子から除外 (caveat、answerSkeleton に注釈)。
     * sessions = 0 の場合は null。
     */
    bounceRate: number | null
    /**
     * 続 82-ml Phase 2 (2026-05-25): 平均セッション継続時間 (秒)。
     * 各 bucket の p50_duration を session 数加重平均。bounceRate と同じく session_end 限定。
     * 全 bucket の p50 が 0 / data 不足の場合は null。
     */
    avgSessionDurationSec: number | null
  }
}

// ── Tier selection (Codex Round 2) ──────────────────────────────────

/**
 * Period length に基づき tier 選択。
 *   - <= 2 days → hourly (新鮮性 + 詳細)
 *   - <= 120 days → daily (バランス)
 *   - > 120 days → monthly (長期トレンド)
 */
export function pickTier(dateRange: AnalyticsDateRange): AnalyticsTier {
  const startMs = Date.parse(dateRange.start)
  const endMs = Date.parse(dateRange.end)
  const periodDays = Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000))
  if (periodDays <= 2) return 'hourly'
  if (periodDays <= 120) return 'daily'
  return 'monthly'
}

// ── Parent query registry (queryId enforcement) ─────────────────────

/**
 * Parent query registry — `analytics.overview` 結果を保管し、
 * `contributors` / `drilldown` / `verify` から `parentQueryId` で参照可能にする。
 *
 * In-memory (per-process) 実装、TTL 5 分:
 *   - serverless 環境 (Vercel) では cold start で消失するが、conversation 内の
 *     即時 follow-up (orchestrator が同 process 内で chain) は確実に解決可能
 *   - W2-B で Redis 永続化を検討 (続 66 §3 W2-B M-9 In-memory conversation cache と統合)
 *
 * tenant_id 分離:
 *   - key = `${tenant_id}:${queryId}`
 *   - cross-tenant 取得は登録された tenant_id と一致しないと不可
 */
const PARENT_QUERY_TTL_MS = 5 * 60 * 1000
const _parentRegistry = new Map<string, { tenantId: string; createdAt: number; input: AnalyticsQueryInput; result: AnalyticsQueryResult }>()

export function registerParentQuery(
  tenantId: string,
  input: AnalyticsQueryInput,
  result: AnalyticsQueryResult,
): string {
  const queryId = randomUUID()
  _parentRegistry.set(`${tenantId}:${queryId}`, {
    tenantId,
    createdAt: Date.now(),
    input,
    result,
  })
  // 簡易 TTL: register 時に古い entry を掃除 (registry size 上限 1000)
  cleanupParentRegistry()
  return queryId
}

export function getParentQuery(
  tenantId: string,
  queryId: string,
): { input: AnalyticsQueryInput; result: AnalyticsQueryResult } | null {
  const entry = _parentRegistry.get(`${tenantId}:${queryId}`)
  if (!entry) return null
  if (Date.now() - entry.createdAt > PARENT_QUERY_TTL_MS) {
    _parentRegistry.delete(`${tenantId}:${queryId}`)
    return null
  }
  return { input: entry.input, result: entry.result }
}

function cleanupParentRegistry(): void {
  if (_parentRegistry.size < 1000) return
  const now = Date.now()
  for (const [k, v] of _parentRegistry.entries()) {
    if (now - v.createdAt > PARENT_QUERY_TTL_MS) {
      _parentRegistry.delete(k)
    }
  }
}

/**
 * Test 用: registry リセット
 */
export function resetParentRegistry(): void {
  _parentRegistry.clear()
}

// ── Query execution (Hybrid: raw 2h + MV historical) ────────────────

/**
 * Hybrid query SQL を組み立てて実行。
 *
 * SQL 構造:
 *   WITH now() - INTERVAL 2 HOUR AS raw_boundary
 *   <MV query: bucket_start < raw_boundary、tier 別 events_hourly/daily/monthly_by_dim>
 *   UNION ALL
 *   <Raw query: timestamp >= raw_boundary、events table を直接 group>
 *
 * 近似集計使用箇所:
 *   - sessions: uniqCombined64 (誤差 ~1-2%)
 *   - conversions: uniqCombined64If (同上)
 * → evidenceLevel = 'observed_approx'
 *
 * 続 78 Task B: bounce_sessions / session_duration_td は events table に
 * 必要列が無いため metric 自体を unsupported 化 (続 67 D-1 schema 整合)。
 *
 * Exact 集計のみ使用時 (Infra 続 67 D-1 に exact aggregator が追加された場合):
 *   - countState (page_views) は exact
 *   - sums は exact
 * → evidenceLevel = 'observed_exact'
 *
 * 本実装は **近似 + exact 混合** = `observed_approx` を返す。
 * `analytics.verify` tool が raw events で claim 値を再計算 → `proven_exact` に格上げ。
 */
export async function executeAnalyticsQuery(input: AnalyticsQueryInput): Promise<AnalyticsQueryResult> {
  const tier = pickTier(input.dateRange)
  const storageDim = toStorageDim(input.dim)
  const dimColumn = toRawColumn(input.dim)
  // 続 82-ml Phase 2: dimFilter は dead code として削除 (続 78 から未使用、tsc noUnusedLocals 抵触)
  const tierTable = `events_${tier}_by_dim`
  const tierBucketFn = tier === 'hourly' ? 'toStartOfHour' : tier === 'daily' ? 'toStartOfDay' : 'toStartOfMonth'

  // MV 側 (bucket_start < raw_boundary) — 近似集計を merge
  // 続 82-ml Phase 2 (2026-05-25): bounce_sessions / session_duration_td state を復活。
  //   Infra 続 82 で events_hourly_by_dim 同 ORDER BY key に 2 MV (続 67 + _v2) が並走 INSERT、
  //   AggregatingMergeTree が merge するため、単一 SELECT で sessions+conversions+page_views
  //   (続 67 MV) と bounce_sessions+session_duration_td (_v2 MV) が両方 merge される。
  //   url dim の bounce は entry_url 列追加待ち (続 83 候補) で本続 skip → bounce_sessions=0 が返る。
  // 続 81 Director hot fix: 'mv' source flag を付与 (uniqCombined64 のみ、〜2% 誤差)
  //
  // 続 83 ClickHouse Code 386 fix (no supertype for String, DateTime('Asia/Tokyo')):
  //   原因: `bucket_start`(DateTime, tz なし = server tz) を `toDateTime(str, tz)`
  //     (= DateTime('Asia/Tokyo')) や `least(DateTime('Asia/Tokyo'), now()-INTERVAL)`
  //     と比較すると、ClickHouse 25.x の supertype 解決で
  //     `String` / `DateTime('Asia/Tokyo')` の混在が解消できず Code 386 で fail する。
  //   修正: `toDateTime(str, tz)` を **更に外側の引数なし `toDateTime(...)` で包む**。
  //     `toDateTime(DateTime('Asia/Tokyo'))` は **瞬間 (絶対 UTC instant) を一切変えず**、
  //     型から tz tag だけを剥がして plain `DateTime` (= server tz) に揃える no-op cast。
  //     - 内側 `toDateTime(str, 'Asia/Tokyo')`: naive 文字列を Asia/Tokyo 壁時計として解釈 →
  //       正しい絶対 instant を得る (tz semantics 維持、ここは従来通り)。
  //     - 外側 `toDateTime(...)`: その instant の型を `bucket_start` / `now()` と同じ
  //       tz なし `DateTime` に統一するだけ。値 (UTC 秒) は不変なので比較結果は変わらない。
  //   → これで `least()` / 比較の両 operand が plain `DateTime` になり supertype 解決が成立。
  const mvQuery = `
SELECT
  formatDateTime(bucket_start, '%Y-%m-%dT%H:%M:%S') AS bucket_label,
  uniqCombined64Merge(sessions) AS sessions,
  uniqCombined64IfMerge(conversions) AS conversions,
  countIfMerge(page_views) AS page_views,
  uniqCombined64IfMerge(bounce_sessions) AS bounce_sessions,
  quantileTDigestMerge(0.5)(session_duration_td) AS p50_duration,
  'mv' AS source
FROM clickinsight.${tierTable}
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND dim = {dim:String}
  ${input.dimValue === '__all__' ? '' : 'AND dim_value = {dim_value:String}'}
  AND bucket_start >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND bucket_start < least(toDateTime(toDateTime({end:String}, {tz:String})), now() - INTERVAL 2 HOUR)
GROUP BY bucket_label
`.trim()

  // Raw 側 (timestamp >= raw_boundary) — events table 直接
  // 続 82-ml Phase 2 (2026-05-25): bounce_sessions / p50_duration を session_end イベント基準で算出。
  //   Infra 続 82 Step 1 で events table に session_duration_sec UInt32 / page_views_in_session UInt16 列追加済。
  //   - bounce 判定: 続 82 mv-bounce-revival Step 2 MV と整合
  //     (`page_views_in_session <= 1 AND session_duration_sec < 10`、conversion 除外は session-level join で別途)
  //   - p50 duration: session_end 限定で quantileTDigestIf 計算 (raw exact)
  //   - caveat: session_end イベント未到達 session は除外 (analytics-tools 経由の reply caveat に注釈)
  // 続 81 Director hot fix (Owner approved Option A):
  //   uniqCombined64 → uniqExact / uniqExactIf に置換 (raw 直接 query、HLL 不要)。
  //   - tenant + site + timestamp range で絞った後の cardinality は十分小さい (典型 < 100k session_id)
  //   - uniqExact は HashSet 実装、誤差ゼロ
  //   - 'raw' source flag を付与し、全 row 'raw' なら evidenceLevel='observed_exact' に格上げ
  //   - countIf(event_type='page_view') は元から exact (LowCardinality カウント)
  const rawQuery = `
SELECT
  formatDateTime(${tierBucketFn}(timestamp, {tz:String}), '%Y-%m-%dT%H:%M:%S') AS bucket_label,
  uniqExact(session_id) AS sessions,
  uniqExactIf(session_id, event_type = 'conversion') AS conversions,
  countIf(event_type = 'page_view') AS page_views,
  uniqExactIf(
    session_id,
    event_type = 'session_end'
      AND page_views_in_session <= 1
      AND session_duration_sec < 10
  ) AS bounce_sessions,
  quantileTDigestIf(0.5)(session_duration_sec, event_type = 'session_end') AS p50_duration,
  'raw' AS source
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  ${dimColumn ? `AND ${dimColumn} = {dim_value:String}` : ''}
  AND timestamp >= greatest(toDateTime(toDateTime({start:String}, {tz:String})), now() - INTERVAL 2 HOUR)
  AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
GROUP BY bucket_label
`.trim()

  const sql = `SELECT bucket_label AS bucket_start, sessions, conversions, page_views, bounce_sessions, p50_duration, source FROM (\n${mvQuery}\nUNION ALL\n${rawQuery}\n) ORDER BY bucket_start\nSETTINGS max_execution_time = 30`

  const queryParams: Record<string, string> = {
    tenant_id: input.tenantId,
    site_id: input.siteId,
    dim: storageDim, // 続 80: UI 概念名 → DB 物理 dim 値 (page_url → url 等)
    start: input.dateRange.start,
    end: input.dateRange.end,
    tz: input.timezone,
  }
  if (input.dimValue !== '__all__') {
    queryParams.dim_value = input.dimValue
  }

  const client = getClickHouseClient('analytics_reader')
  const resultSet = await client.query({
    query: sql,
    query_params: queryParams,
    format: 'JSONEachRow',
  })
  const rawRows = await resultSet.json<{
    bucket_start: string
    sessions: number
    conversions: number
    page_views: number
    bounce_sessions: number
    p50_duration: number
    source: 'mv' | 'raw'
  }>()

  // 続 81 Director hot fix: row source 別に evidenceLevel を動的決定
  //   - 全 row が 'raw' → uniqExact のみ使用 = observed_exact (誤差ゼロ)
  //   - 1 row でも 'mv' があれば uniqCombined64 経由 = observed_approx (〜2% 誤差)
  //   - rows 空 → observed_approx (デフォルト、データ不足を意味、UI は "データなし" 表示)
  const hasMvRows = rawRows.some((r) => r.source === 'mv')
  const hasRawRows = rawRows.some((r) => r.source === 'raw')
  const evidenceLevel: EvidenceLevelV2 = !hasMvRows && hasRawRows ? 'observed_exact' : 'observed_approx'
  const approximation = !hasMvRows && hasRawRows
    ? ['uniqExact', 'uniqExactIf'] // raw exclusive: 全 exact
    : ['uniqCombined64', 'uniqCombined64If', 'uniqExact', 'uniqExactIf'] // mixed: 近似 + exact

  // Summary aggregation
  const summary = aggregateSummary(rawRows)

  return {
    tier,
    rows: rawRows,
    evidenceLevel,
    approxErrorPct: evidenceLevel === 'observed_exact' ? 0 : 2.0,
    approximation,
    summary,
  }
}

function aggregateSummary(rows: BucketRow[]): AnalyticsQueryResult['summary'] {
  const totalSessions = rows.reduce((s, r) => s + r.sessions, 0)
  const totalConv = rows.reduce((s, r) => s + r.conversions, 0)
  const totalPv = rows.reduce((s, r) => s + r.page_views, 0)

  // 続 82-ml Phase 2 (2026-05-25): bounce_sessions / p50_duration を bucket 横断で集計。
  //   - bounceRate = sum(bounce_sessions) / sum(sessions)
  //     caveat: bounce_sessions は session_end 受信した session のみ算入。session_end 未到達は除外。
  //   - avgSessionDurationSec = bucket の p50_duration を session 数加重平均
  //     (各 bucket の中央値を merge する厳密集計は TDigest state 再生成が必要、MVP では加重平均で代替)
  //   - bucket に session_end イベントが無い場合は p50_duration=0 で row が返るため、
  //     bounce_sessions=0 かつ p50_duration=0 の row を分母から除外して duration を加重。
  const totalBounce = rows.reduce((s, r) => s + r.bounce_sessions, 0)
  const bounceRate = totalSessions > 0 ? totalBounce / totalSessions : null

  // 加重平均 (weight = sessions per bucket)
  let durationNumerator = 0
  let durationDenominator = 0
  for (const r of rows) {
    if (r.sessions > 0 && r.p50_duration > 0) {
      durationNumerator += r.p50_duration * r.sessions
      durationDenominator += r.sessions
    }
  }
  const avgSessionDurationSec = durationDenominator > 0 ? durationNumerator / durationDenominator : null

  return {
    sessions: totalSessions,
    conversions: totalConv,
    cvr: totalSessions > 0 ? totalConv / totalSessions : null,
    pageViews: totalPv,
    bounceRate,
    avgSessionDurationSec,
  }
}

// ── Contributors query (top + __other__ + coverage、Codex Round 2) ──

export interface ContributorRow {
  dim_value: string
  sessions: number
  conversions: number
  cvr: number | null
  share_pct: number
}

export interface ContributorsResult {
  top: ContributorRow[]
  other: ContributorRow | null
  coveragePct: number
  excludedLowVolumeCount: number
  evidenceLevel: EvidenceLevelV2
}

/**
 * 指定 dimension の top N 寄与 + `__other__` bucket + coverage %。
 * - `minDenominator` 未満の dim_value は除外 (CVR 計算の信頼性確保、1 CV ページの噪音排除)
 * - top + other で全 sessions の coverage % を計算
 */
export async function executeContributorsQuery(params: {
  parent: AnalyticsQueryInput
  /**
   * 続 82-ml skeleton: utm_source / visitor_type を許可。
   * Infra 完了前に呼ぶと events_hourly_by_dim の該当 dim 行が存在せず空 result が返る (benign)。
   */
  dimension: Exclude<AnalyticsDim, 'all'>
  limit: number
  minDenominator: number
}): Promise<ContributorsResult> {
  const tier = pickTier(params.parent.dateRange)
  const tierTable = `events_${tier}_by_dim`

  // 続 78 Task B: bounce_sessions / bounce_rate を contributors query から削除
  // (続 67 D-1 schema 整合、events_hourly_by_dim に bounce_sessions 列なし)
  const sql = `
WITH per_dim_value AS (
  SELECT
    dim_value,
    uniqCombined64Merge(sessions) AS sessions,
    uniqCombined64IfMerge(conversions) AS conversions
  FROM clickinsight.${tierTable}
  WHERE tenant_id = {tenant_id:String}
    AND site_id = {site_id:String}
    AND dim = {dim:String}
    -- 続 83 Code 386 fix: 外側引数なし toDateTime() で tz tag を剥がし plain DateTime に統一
    --   (instant 不変、bucket_start (tz なし DateTime) との supertype 解決を成立させる)。
    AND bucket_start >= toDateTime(toDateTime({start:String}, {tz:String}))
    AND bucket_start < toDateTime(toDateTime({end:String}, {tz:String}))
  GROUP BY dim_value
)
SELECT
  dim_value,
  sessions,
  conversions,
  if(sessions > 0, conversions / sessions, NULL) AS cvr,
  sessions / (SELECT sum(sessions) FROM per_dim_value WHERE sessions >= {min_denom:UInt32}) AS share_pct
FROM per_dim_value
WHERE sessions >= {min_denom:UInt32}
ORDER BY sessions DESC
LIMIT {top_limit:UInt32}
SETTINGS max_execution_time = 30
`.trim()

  const client = getClickHouseClient('analytics_reader')
  const rs = await client.query({
    query: sql,
    query_params: {
      tenant_id: params.parent.tenantId,
      site_id: params.parent.siteId,
      dim: toStorageDim(params.dimension), // 続 80: UI 概念名 → DB 物理 dim 値
      start: params.parent.dateRange.start,
      end: params.parent.dateRange.end,
      tz: params.parent.timezone,
      min_denom: String(params.minDenominator),
      top_limit: String(params.limit),
    },
    format: 'JSONEachRow',
  })

  const top = await rs.json<ContributorRow>()

  // __other__ bucket と coverage は top 以外を別 query で集計するのが正攻法だが、
  // MVP では top の share_pct 合計で coverage を近似 + W2-B で精緻化
  const coveragePct = top.reduce((s, r) => s + r.share_pct, 0)

  return {
    top,
    other: null, // W2-B で投入 (window function or extra query)
    coveragePct,
    excludedLowVolumeCount: 0, // W2-B で MV から計算
    evidenceLevel: 'observed_approx',
  }
}

// ── Drilldown query (時系列 + anomalies) ────────────────────────────

export interface DrilldownPoint {
  bucket_start: string
  value: number
  zscore: number
}

export interface DrilldownResult {
  series: DrilldownPoint[]
  anomalies: DrilldownPoint[]
  grain: 'hour' | 'day'
  evidenceLevel: EvidenceLevelV2
}

/**
 * 特定 dim_value (例: '/pricing') の時系列詳細 + anomalies (z-score > 2.5)。
 * `parent.dateRange` を default window として、明示 window があれば override。
 */
export async function executeDrilldownQuery(params: {
  parent: AnalyticsQueryInput
  /**
   * 続 82-ml skeleton: utm_source / visitor_type を許可。
   * Infra 完了前は MV 該当 dim 行なしで series 空 (anomalies も空)。
   */
  dimension: Exclude<AnalyticsDim, 'all'>
  value: string
  window?: AnalyticsDateRange
  grain: 'hour' | 'day'
  metric: 'cvr' | 'sessions'
}): Promise<DrilldownResult> {
  const range = params.window ?? params.parent.dateRange
  const tier = params.grain === 'hour' ? 'hourly' : 'daily'
  const tierTable = `events_${tier}_by_dim`

  // 続 78 Task B: 'bounce_rate' metric を削除 (bounce_sessions 列が schema に無い)
  const metricExpr = (() => {
    switch (params.metric) {
      case 'sessions':
        return 'toFloat64(uniqCombined64Merge(sessions))'
      case 'cvr':
        return 'if(uniqCombined64Merge(sessions) > 0, uniqCombined64IfMerge(conversions) / uniqCombined64Merge(sessions), 0)'
    }
  })()

  const sql = `
SELECT
  toString(bucket_start) AS bucket_start,
  ${metricExpr} AS value
FROM clickinsight.${tierTable}
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND dim = {dim:String}
  AND dim_value = {dim_value:String}
  -- 続 83 Code 386 fix: 外側引数なし toDateTime() で tz tag を剥がし plain DateTime に統一
  --   (instant 不変、bucket_start (tz なし DateTime) との supertype 解決を成立させる)。
  AND bucket_start >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND bucket_start < toDateTime(toDateTime({end:String}, {tz:String}))
GROUP BY bucket_start
ORDER BY bucket_start
SETTINGS max_execution_time = 30
`.trim()

  const client = getClickHouseClient('analytics_reader')
  const rs = await client.query({
    query: sql,
    query_params: {
      tenant_id: params.parent.tenantId,
      site_id: params.parent.siteId,
      dim: toStorageDim(params.dimension), // 続 80: UI 概念名 → DB 物理 dim 値
      dim_value: params.value,
      start: range.start,
      end: range.end,
      tz: params.parent.timezone,
    },
    format: 'JSONEachRow',
  })

  const rows = await rs.json<{ bucket_start: string; value: number }>()

  // Z-score 計算 (in-process、Codex Round 2 案: anomaly 閾値 2.5)
  const values = rows.map((r) => r.value)
  const mean = values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0
  const variance =
    values.length > 1
      ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1)
      : 0
  const stddev = Math.sqrt(variance)

  const series: DrilldownPoint[] = rows.map((r) => ({
    bucket_start: r.bucket_start,
    value: r.value,
    zscore: stddev > 0 ? (r.value - mean) / stddev : 0,
  }))

  const anomalies = series.filter((p) => Math.abs(p.zscore) > 2.5)

  return {
    series,
    anomalies,
    grain: params.grain,
    evidenceLevel: 'observed_approx',
  }
}

// ── Verify query (raw events で exact 再計算 → proven_exact) ─────────

export interface VerifyResult {
  claimedValue: number
  exactValue: number
  withinTolerance: boolean
  tolerancePct: number
  evidenceLevel: EvidenceLevelV2
}

/**
 * Claim 値を raw `events` table で exact 再計算 → tolerance ±2% で照合。
 * tolerance 内 = `proven_exact` 格上げ、超過 = `observed_approx` 維持 + UI で警告。
 *
 * Codex Round 2 案:
 *   - verify は 1 metric 1 filter 限定 (複雑な claim は分解して複数 verify)
 *   - raw events scan は重い → tenantId + siteId + timestamp range で必ず絞る
 */
export async function executeVerifyQuery(params: {
  tenantId: string
  siteId: string
  // 続 82-ml Phase 2 (2026-05-25): Infra 続 82 で events table に session_duration_sec /
  //   page_views_in_session 列追加済 → bounce_rate / avg_session_duration を raw exact 再計算可能。
  metric: 'cvr' | 'sessions' | 'page_views' | 'bounce_rate' | 'avg_session_duration'
  filter: Record<string, string> // e.g., { page_url: '/pricing' }
  claimedValue: number
  dateRange: AnalyticsDateRange
  timezone: string
  tolerancePct?: number
}): Promise<VerifyResult> {
  const tol = params.tolerancePct ?? 2.0

  // filter を WHERE 句に展開 (key は whitelist で enum 強制、value は parameter binding)
  // 続 80: UI 概念名 → DB 物理列名 mapping (page_url → url, device → device_type)、persona は unsupported
  const FILTER_COLUMN = { page_url: 'url', device: 'device_type' } as const
  const filterClauses: string[] = []
  const filterParams: Record<string, string> = {}
  for (const [k, v] of Object.entries(params.filter)) {
    if (!(k in FILTER_COLUMN)) {
      throw new Error(`verify: filter key '${k}' is not allowed`)
    }
    const physicalColumn = FILTER_COLUMN[k as keyof typeof FILTER_COLUMN]
    filterClauses.push(`AND ${physicalColumn} = {filter_${k}:String}`)
    filterParams[`filter_${k}`] = v
  }

  // 続 82-ml Phase 2 (2026-05-25): bounce_rate / avg_session_duration を raw exact 再計算で復活。
  //   - bounce_rate: bounce_sessions / sessions (session_end 受信した session 限定)
  //   - avg_session_duration: quantileTDigestIf(0.5)(session_duration_sec, event_type='session_end')
  const metricExpr = (() => {
    switch (params.metric) {
      case 'sessions':
        return 'toFloat64(uniqExact(session_id))'
      case 'page_views':
        return 'toFloat64(countIf(event_type = \'page_view\'))'
      case 'cvr':
        return 'if(uniqExact(session_id) > 0, uniqExactIf(session_id, event_type = \'conversion\') / uniqExact(session_id), 0)'
      case 'bounce_rate':
        return (
          'if(uniqExact(session_id) > 0,' +
          ' toFloat64(uniqExactIf(' +
          'session_id,' +
          ' event_type = \'session_end\'' +
          ' AND page_views_in_session <= 1' +
          ' AND session_duration_sec < 10' +
          ')) / uniqExact(session_id),' +
          ' 0)'
        )
      case 'avg_session_duration':
        return 'toFloat64(quantileTDigestIf(0.5)(session_duration_sec, event_type = \'session_end\'))'
    }
  })()

  const sql = `
SELECT ${metricExpr} AS value
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  -- 続 83 Code 386 fix: 外側引数なし toDateTime() で tz tag を剥がし plain DateTime に統一
  --   (instant 不変、events.timestamp (tz なし DateTime) との supertype 解決を成立させる)。
  AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
  ${filterClauses.join(' ')}
SETTINGS max_execution_time = 30
`.trim()

  const client = getClickHouseClient('analytics_reader')
  const rs = await client.query({
    query: sql,
    query_params: {
      tenant_id: params.tenantId,
      site_id: params.siteId,
      start: params.dateRange.start,
      end: params.dateRange.end,
      tz: params.timezone,
      ...filterParams,
    },
    format: 'JSONEachRow',
  })

  const rows = await rs.json<{ value: number }>()
  const exactValue = rows[0]?.value ?? 0

  const denom = Math.max(Math.abs(params.claimedValue), 1e-9)
  const errorPct = (Math.abs(exactValue - params.claimedValue) / denom) * 100
  const withinTolerance = errorPct < tol

  return {
    claimedValue: params.claimedValue,
    exactValue,
    withinTolerance,
    tolerancePct: tol,
    evidenceLevel: withinTolerance ? 'proven_exact' : 'observed_approx',
  }
}
