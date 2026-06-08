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
  //   - countIf(event_type='pageview') は元から exact (LowCardinality カウント)
  const rawQuery = `
SELECT
  formatDateTime(${tierBucketFn}(timestamp, {tz:String}), '%Y-%m-%dT%H:%M:%S') AS bucket_label,
  uniqExact(session_id) AS sessions,
  uniqExactIf(session_id, conversion_type IS NOT NULL AND conversion_type != '') AS conversions,
  countIf(event_type = 'pageview') AS page_views,
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

// ── Standalone insight queries (top_pages / scroll_depth / attention / device_breakdown) ──

/**
 * analytics_top_pages: 人気ページ (pageview 数 + session 数)
 *
 * 設計:
 *   - event_type='pageview', is_agent=0 で絞り込み
 *   - url 別 uniqExact(session_id) + count() を period 全体で集計
 *   - tenant_id / site_id は query_params で parameter binding (SQL injection 防止)
 *   - timestamp range は hybrid-query.ts 確立済の Code 386 fix を流用:
 *     toDateTime(toDateTime({start:String}, {tz:String})) で tz tag を剥がし plain DateTime に統一
 */
export interface TopPageRow {
  url: string
  sessions: number
  pageviews: number
}

export interface TopPagesResult {
  rows: TopPageRow[]
  periodStart: string
  periodEnd: string
  timezone: string
  /** D-07 準拠: uniqExact は正確だが period-cap 近似の観点から observed_approx とする */
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeTopPagesQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  limit: number
}): Promise<TopPagesResult> {
  const sql = `
SELECT
  url,
  uniqExact(session_id) AS sessions,
  count() AS pageviews
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND event_type = 'pageview'
  AND is_agent = 0
  -- 続 83 Code 386 fix: toDateTime(toDateTime({start:String}, {tz:String})) で
  --   tz tag を剥がして plain DateTime に統一 (instant 不変、比較 operand の supertype を解消)
  AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
GROUP BY url
ORDER BY sessions DESC
LIMIT {limit:UInt32}
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
      limit: String(params.limit),
    },
    format: 'JSONEachRow',
  })

  const rows = await rs.json<TopPageRow>()

  return {
    rows,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: 'uniqExact はセッション単位の正確な集計ですが、期間フィルタは近似タイムゾーン変換を含むため observed_approx とします。',
  }
}

// ── analytics_scroll_depth ───────────────────────────────────────────

/**
 * Scroll reach バンド分布: per-session max scroll_y を bandPx 幅でバケット化し、
 * 各バンドに到達したセッション数 + 全体に対する累積 reach% を返す。
 *
 * SQL 設計:
 *   1. CTE ps: session ごとの max scroll_y (event_type='scroll', is_agent=0)
 *   2. outer: バンド別 count() でセッション数、全体 total_sessions も含む
 *
 * Code 386 fix: timestamp 比較は toDateTime(toDateTime(...)) パターンを使う。
 * session_end の scroll_y=0 は除外しない (WHERE event_type='scroll' で自動除外)。
 */
export interface ScrollDepthBand {
  depth_px: number
  sessions: number
  /** このバンド以上にスクロールしたセッションの割合 (cumulative reach %) */
  reach_pct: number
}

export interface ScrollDepthResult {
  bands: ScrollDepthBand[]
  total_sessions: number
  page_url: string | null
  band_px: number
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeScrollDepthQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  pageUrl?: string
  bandPx: number
}): Promise<ScrollDepthResult> {
  const pageUrlFilter = params.pageUrl ? 'AND url = {page_url:String}' : ''

  // CTE で per-session max を取り、バンド別に集計
  // total_sessions は subquery で全バンド合計として算出
  const sql = `
WITH ps AS (
  SELECT session_id, max(scroll_y) AS m
  FROM clickinsight.events
  WHERE tenant_id = {tenant_id:String}
    AND site_id = {site_id:String}
    AND event_type = 'scroll'
    AND is_agent = 0
    ${pageUrlFilter}
    AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
    AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
  GROUP BY session_id
),
total AS (
  SELECT count() AS total_sessions FROM ps
)
SELECT
  toUInt32(intDiv(m, {band:UInt32}) * {band:UInt32}) AS depth_px,
  count() AS sessions,
  (SELECT total_sessions FROM total) AS total_sessions
FROM ps
GROUP BY depth_px
ORDER BY depth_px
SETTINGS max_execution_time = 30
`.trim()

  const queryParams: Record<string, string> = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
    band: String(params.bandPx),
  }
  if (params.pageUrl) {
    queryParams.page_url = params.pageUrl
  }

  const client = getClickHouseClient('analytics_reader')
  const rs = await client.query({
    query: sql,
    query_params: queryParams,
    format: 'JSONEachRow',
  })

  const rawRows = await rs.json<{ depth_px: number; sessions: number; total_sessions: number }>()

  const totalSessions = rawRows[0]?.total_sessions ?? 0

  // cumulative reach: セッション数が depth_px 以上のバンドの合計 / total
  // rawRows は depth_px 昇順なので suffix sum で計算する
  const suffixSums: number[] = new Array<number>(rawRows.length).fill(0)
  let running = 0
  for (let i = rawRows.length - 1; i >= 0; i--) {
    running += rawRows[i].sessions
    suffixSums[i] = running
  }

  const bands: ScrollDepthBand[] = rawRows.map((r, i) => ({
    depth_px: r.depth_px,
    sessions: r.sessions,
    reach_pct: totalSessions > 0 ? (suffixSums[i] / totalSessions) * 100 : 0,
  }))

  return {
    bands,
    total_sessions: totalSessions,
    page_url: params.pageUrl ?? null,
    band_px: params.bandPx,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: 'per-session max scroll_y をバンド化した近似集計です。uniqExact は使用していません。',
  }
}

// ── analytics_attention ──────────────────────────────────────────────

/**
 * Read/dwell 密度: event_type='read_area' の read_y をバンド幅で集計し、
 * どの深度が最も読まれたかを返す。
 *
 * Code 386 fix: timestamp 比較は toDateTime(toDateTime(...)) パターンを使う。
 */
export interface AttentionBand {
  depth_px: number
  read_events: number
  sessions: number
}

export interface AttentionResult {
  bands: AttentionBand[]
  page_url: string | null
  band_px: number
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeAttentionQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  pageUrl?: string
  bandPx: number
}): Promise<AttentionResult> {
  const pageUrlFilter = params.pageUrl ? 'AND url = {page_url:String}' : ''

  const sql = `
SELECT
  toUInt32(intDiv(read_y, {band:UInt32}) * {band:UInt32}) AS depth_px,
  count() AS read_events,
  uniqExact(session_id) AS sessions
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND event_type = 'read_area'
  AND is_agent = 0
  ${pageUrlFilter}
  AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
GROUP BY depth_px
ORDER BY depth_px
LIMIT 500
SETTINGS max_execution_time = 30
`.trim()

  const queryParams: Record<string, string> = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
    band: String(params.bandPx),
  }
  if (params.pageUrl) {
    queryParams.page_url = params.pageUrl
  }

  const client = getClickHouseClient('analytics_reader')
  const rs = await client.query({
    query: sql,
    query_params: queryParams,
    format: 'JSONEachRow',
  })

  const rawRows = await rs.json<AttentionBand>()

  return {
    bands: rawRows,
    page_url: params.pageUrl ?? null,
    band_px: params.bandPx,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: 'read_area イベントの read_y 密度集計です。uniqExact(session_id) 使用。',
  }
}

// ── analytics_device_breakdown ───────────────────────────────────────

/**
 * Device type 別 session + pageview 分布。share_pct は in-process 計算。
 *
 * Code 386 fix: timestamp 比較は toDateTime(toDateTime(...)) パターンを使う。
 */
export interface DeviceRow {
  device_type: string
  sessions: number
  pageviews: number
  share_pct: number
}

export interface DeviceBreakdownResult {
  rows: DeviceRow[]
  total_sessions: number
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeDeviceBreakdownQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
}): Promise<DeviceBreakdownResult> {
  const sql = `
SELECT
  device_type,
  uniqExact(session_id) AS sessions,
  count() AS pageviews
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND event_type = 'pageview'
  AND is_agent = 0
  AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
GROUP BY device_type
ORDER BY sessions DESC
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
    },
    format: 'JSONEachRow',
  })

  const rawRows = await rs.json<{ device_type: string; sessions: number; pageviews: number }>()

  const totalSessions = rawRows.reduce((s, r) => s + r.sessions, 0)

  const rows: DeviceRow[] = rawRows.map((r) => ({
    device_type: r.device_type,
    sessions: r.sessions,
    pageviews: r.pageviews,
    share_pct: totalSessions > 0 ? (r.sessions / totalSessions) * 100 : 0,
  }))

  return {
    rows,
    total_sessions: totalSessions,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: 'uniqExact(session_id) によるデバイス別セッション集計。',
  }
}

// ── analytics_metrics (汎用 metric × dimension × filter) ─────────────

/**
 * 汎用メトリクス: metric × dimension × filter × date-range。
 *
 * 設計:
 *   - raw events table を直接集計 (近似 MV は使わない → observed_approx だが single-table)
 *   - dimension='none' のとき GROUP BY なしで 1 行のみ返す
 *   - dimension 指定時は GROUP BY dim ORDER BY metric DESC LIMIT
 *   - is_agent=0 で bot 除外 / tenant_id・site_id は server 固定 / query_params binding
 *   - Code 386 fix: toDateTime(toDateTime({start:String}, {tz:String})) pattern
 *   - SETTINGS max_execution_time=30
 *   - bounce_rate / avg_session_duration は session_duration_sec / page_views_in_session 列依存
 *   - cvr / revenue / conversions は bihadashop で 0 が正しい (conversion イベント未計測)
 */

export type MetricsMetric =
  | 'sessions'
  | 'pageviews'
  | 'visitors'
  | 'new_visitors'
  | 'returning_visitors'
  | 'clicks'
  | 'dead_clicks'
  | 'rage_clicks'
  | 'conversions'
  | 'cvr'
  | 'revenue'
  | 'avg_scroll_depth'
  | 'bounce_rate'
  | 'avg_session_duration'

export const METRICS_METRICS: MetricsMetric[] = [
  'sessions',
  'pageviews',
  'visitors',
  'new_visitors',
  'returning_visitors',
  'clicks',
  'dead_clicks',
  'rage_clicks',
  'conversions',
  'cvr',
  'revenue',
  'avg_scroll_depth',
  'bounce_rate',
  'avg_session_duration',
]

export type MetricsDimension =
  | 'none'
  | 'page_url'
  | 'device_type'
  | 'referrer_type'
  | 'utm_source'
  | 'utm_medium'
  | 'utm_campaign'
  | 'visitor_type'
  | 'conversion_type'
  | 'hour'
  | 'day_of_week'
  | 'day'
  | 'month'

export const METRICS_DIMENSIONS: MetricsDimension[] = [
  'none',
  'page_url',
  'device_type',
  'referrer_type',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'visitor_type',
  'conversion_type',
  'hour',
  'day_of_week',
  'day',
  'month',
]

export interface MetricsRow {
  /** dimension 値 (dimension='none' の場合は '__total__') */
  dimension_value: string
  value: number
}

export interface MetricsResult {
  metric: MetricsMetric
  dimension: MetricsDimension
  rows: MetricsRow[]
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

/**
 * SQL metric 式を返す。
 *
 * bounce_rate / avg_session_duration は session_duration_sec / page_views_in_session 列が
 * events table に必要 (Infra 続 82 Step 1 配備済)。
 *
 * revenue は conversion_value 列が必要 (bihadashop では 0 が正しい)。
 * visitor_id は events table に必要 (Infra 続 82 続 __ugk_vid cookie + visitor_id 配備済)。
 * is_first_visit Bool 列も必要 (同上)。
 */
function buildMetricExpr(metric: MetricsMetric): string {
  switch (metric) {
    case 'sessions':
      return 'toFloat64(uniqExact(session_id))'
    case 'pageviews':
      return "toFloat64(countIf(event_type = 'pageview'))"
    case 'visitors':
      return 'toFloat64(uniqExact(visitor_id))'
    case 'new_visitors':
      return 'toFloat64(uniqExactIf(visitor_id, is_first_visit = 1))'
    case 'returning_visitors':
      return '(toFloat64(uniqExact(visitor_id)) - toFloat64(uniqExactIf(visitor_id, is_first_visit = 1)))'
    case 'clicks':
      return "toFloat64(countIf(event_type = 'click'))"
    case 'dead_clicks':
      return "toFloat64(countIf(event_type = 'dead_click'))"
    case 'rage_clicks':
      return "toFloat64(countIf(event_type = 'rage_click'))"
    // 2026-06-06 修正: event_type='conversion' は本番に存在せず常に0だった。
    //   コンバージョンは conversion_type 列 (非NULL/非空) で記録されるため、そちらで session を数える。
    case 'conversions':
      return "toFloat64(uniqExactIf(session_id, conversion_type IS NOT NULL AND conversion_type != ''))"
    case 'cvr':
      return "if(uniqExact(session_id) > 0, toFloat64(uniqExactIf(session_id, conversion_type IS NOT NULL AND conversion_type != '')) / toFloat64(uniqExact(session_id)), 0)"
    case 'revenue':
      return 'toFloat64(sumIf(conversion_value, conversion_value > 0))'
    case 'avg_scroll_depth':
      return "avgIf(scroll_percentage, event_type = 'scroll')"
    case 'bounce_rate':
      return (
        'if(uniqExact(session_id) > 0,' +
        " toFloat64(uniqExactIf(session_id, event_type = 'session_end' AND page_views_in_session <= 1 AND session_duration_sec < 10))" +
        ' / toFloat64(uniqExact(session_id)), 0)'
      )
    case 'avg_session_duration':
      return "toFloat64(avgIf(session_duration_sec, event_type = 'session_end'))"
  }
}

/**
 * SQL dimension 式を返す。
 *
 * 'none' の場合は null を返す (GROUP BY 不要)。
 * time 系 (hour/day_of_week/day/month) は Asia/Tokyo タイムゾーン関数を使う。
 * utm_source/utm_medium/utm_campaign は events table の対応列から直接取得。
 * referrer_type / visitor_type / conversion_type は derive 式。
 */
function buildDimensionExpr(dimension: MetricsDimension): string | null {
  switch (dimension) {
    case 'none':
      return null
    case 'page_url':
      return 'url'
    case 'device_type':
      return 'device_type'
    case 'referrer_type':
      // referrer が空なら 'direct'、同ドメインなら 'internal'、それ以外は 'referral'
      return "if(referrer = '', 'direct', if(referrer LIKE concat('%', domain(url), '%'), 'internal', 'referral'))"
    case 'utm_source':
      return "if(utm_source = '', '__none__', utm_source)"
    case 'utm_medium':
      return "if(utm_medium = '', '__none__', utm_medium)"
    case 'utm_campaign':
      return "if(utm_campaign = '', '__none__', utm_campaign)"
    case 'visitor_type':
      return "if(is_first_visit = 1, 'new', 'returning')"
    case 'conversion_type':
      // 2026-06-06 修正: conversion_type 列 (非NULL/非空) で実際の CV 種別を分類。
      return "if(conversion_type IS NOT NULL AND conversion_type != '', conversion_type, '__non_conversion__')"
    case 'hour':
      return 'toHour(toDateTime(timestamp, {tz:String}))'
    case 'day_of_week':
      // ClickHouse toDayOfWeek: 1=Monday...7=Sunday
      return 'toDayOfWeek(toDateTime(timestamp, {tz:String}))'
    case 'day':
      return "toString(toDate(toDateTime(timestamp, {tz:String})))"
    case 'month':
      return "toString(toStartOfMonth(toDateTime(timestamp, {tz:String})))"
  }
}

export async function executeMetricsQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  metric: MetricsMetric
  dimension: MetricsDimension
  pageUrl?: string
  deviceType?: string
  limit: number
}): Promise<MetricsResult> {
  const metricExpr = buildMetricExpr(params.metric)
  const dimExpr = buildDimensionExpr(params.dimension)

  const queryParams: Record<string, string> = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
  }

  // Optional filters
  const filterClauses: string[] = []
  if (params.pageUrl) {
    filterClauses.push('AND url = {filter_page_url:String}')
    queryParams.filter_page_url = params.pageUrl
  }
  if (params.deviceType) {
    filterClauses.push('AND device_type = {filter_device_type:String}')
    queryParams.filter_device_type = params.deviceType
  }

  let sql: string
  if (dimExpr === null) {
    // dimension='none': single total row
    sql = `
SELECT
  '__total__' AS dimension_value,
  ${metricExpr} AS value
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND is_agent = 0
  AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
  ${filterClauses.join(' ')}
SETTINGS max_execution_time = 30
`.trim()
  } else {
    // dimension specified: GROUP BY dim ORDER BY metric DESC LIMIT
    sql = `
SELECT
  toString(${dimExpr}) AS dimension_value,
  ${metricExpr} AS value
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND is_agent = 0
  AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
  ${filterClauses.join(' ')}
GROUP BY dimension_value
ORDER BY value DESC
LIMIT {limit:UInt32}
SETTINGS max_execution_time = 30
`.trim()
    queryParams.limit = String(params.limit)
  }

  const client = getClickHouseClient('analytics_reader')
  const rs = await client.query({
    query: sql,
    query_params: queryParams,
    format: 'JSONEachRow',
  })

  const rows = await rs.json<MetricsRow>()

  return {
    metric: params.metric,
    dimension: params.dimension,
    rows,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: '直接 events table を uniqExact / countIf で集計。D-07 observed_approx。cvr/conversions は conversion_type 列ベース (CV 未設定サイトは 0)。revenue は conversion_value>0 ベース (金額未計装サイトは 0)。',
  }
}

// ── analytics_timeseries (1 metric の時系列) ─────────────────────────

/**
 * 指定 metric の時系列 (day または hour grain)。
 *
 * CVR 時系列推移、セッション推移等に使う。
 * 全体 (site 全体) のみ、page_url 等のフィルタは不可 (→ analytics_metrics + dimension=day/hour で代替)。
 * grain=day → toStartOfDay(timestamp, tz) / grain=hour → toStartOfHour(timestamp, tz)
 *
 * Code 386 fix: timestamp 比較は toDateTime(toDateTime(...)) パターン。
 */

export type TimeseriesMetric = 'sessions' | 'pageviews' | 'conversions' | 'cvr' | 'clicks'
export type TimeseriesGrain = 'day' | 'hour'

export const TIMESERIES_METRICS: TimeseriesMetric[] = [
  'sessions',
  'pageviews',
  'conversions',
  'cvr',
  'clicks',
]

export interface TimeseriesPoint {
  bucket: string
  value: number
}

export interface TimeseriesResult {
  metric: TimeseriesMetric
  grain: TimeseriesGrain
  points: TimeseriesPoint[]
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

function buildTimeseriesMetricExpr(metric: TimeseriesMetric): string {
  switch (metric) {
    case 'sessions':
      return 'toFloat64(uniqExact(session_id))'
    case 'pageviews':
      return "toFloat64(countIf(event_type = 'pageview'))"
    // 2026-06-06 修正: event_type='conversion' は本番に存在せず常に0。conversion_type 列ベースへ。
    case 'conversions':
      return "toFloat64(uniqExactIf(session_id, conversion_type IS NOT NULL AND conversion_type != ''))"
    case 'cvr':
      return "if(uniqExact(session_id) > 0, toFloat64(uniqExactIf(session_id, conversion_type IS NOT NULL AND conversion_type != '')) / toFloat64(uniqExact(session_id)), 0)"
    case 'clicks':
      return "toFloat64(countIf(event_type = 'click'))"
  }
}

export async function executeTimeseriesQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  metric: TimeseriesMetric
  grain: TimeseriesGrain
}): Promise<TimeseriesResult> {
  const metricExpr = buildTimeseriesMetricExpr(params.metric)
  const bucketFn = params.grain === 'day'
    ? 'toStartOfDay(timestamp, {tz:String})'
    : 'toStartOfHour(timestamp, {tz:String})'

  const sql = `
SELECT
  toString(${bucketFn}) AS bucket,
  ${metricExpr} AS value
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND is_agent = 0
  AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
GROUP BY bucket
ORDER BY bucket
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
    },
    format: 'JSONEachRow',
  })

  const points = await rs.json<TimeseriesPoint>()

  return {
    metric: params.metric,
    grain: params.grain,
    points,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: `${params.metric} の時系列 (grain=${params.grain}) を直接 events table から集計。D-07 observed_approx。`,
  }
}

// ── analytics_form_analysis ──────────────────────────────────────────

/**
 * フォーム分析: form_interactions テーブルから per-form / per-field の
 * 開始数・完了数・完了率・離脱率・最終フィールド分布・平均フィールド滞在時間を返す。
 *
 * 日付列: created_at (NOT timestamp) — Code 386 fix: toDateTime(toDateTime({start:String},{tz:String})) パターン。
 * テーブル: clickinsight.form_interactions。
 * is_agent 列は form_interactions に存在しないため使用しない。
 * tenant_id / site_id は query_params で parameter binding。
 */

export interface FormAnalysisFormRow {
  form_id: string
  page_url: string
  starts: number
  submits: number
  completion_rate: number | null
  abandonment_rate: number | null
  sample_count: number
}

export interface FormAnalysisFieldRow {
  form_id: string
  page_url: string
  field_name: string
  field_type: string
  /** form_field_focus 件数 (フィールドにフォーカスした回数) */
  touches: number
  avg_field_duration_ms: number | null
}

export interface FormAnalysisLastFieldRow {
  form_id: string
  page_url: string
  last_field: string
  abandon_count: number
}

export interface FormAnalysisResult {
  forms: FormAnalysisFormRow[]
  fields: FormAnalysisFieldRow[]
  last_field_distribution: FormAnalysisLastFieldRow[]
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeFormAnalysisQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  formId?: string
  pageUrl?: string
}): Promise<FormAnalysisResult> {
  const client = getClickHouseClient('analytics_reader')

  // Optional filters
  const filterClauses: string[] = []
  const queryParams: Record<string, string> = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
  }
  if (params.formId) {
    filterClauses.push('AND form_id = {form_id:String}')
    queryParams.form_id = params.formId
  }
  if (params.pageUrl) {
    filterClauses.push('AND page_url = {page_url:String}')
    queryParams.page_url = params.pageUrl
  }

  const baseWhere = `
    tenant_id = {tenant_id:String}
    AND site_id = {site_id:String}
    AND created_at >= toDateTime(toDateTime({start:String}, {tz:String}))
    AND created_at < toDateTime(toDateTime({end:String}, {tz:String}))
    ${filterClauses.join(' ')}
  `.trim()

  // Query 1: per-form starts / submits / completion_rate
  const formSql = `
SELECT
  form_id,
  page_url,
  countIf(event_type = 'form_view') AS starts,
  countIf(event_type = 'form_submit') AS submits,
  count() AS sample_count
FROM clickinsight.form_interactions
WHERE ${baseWhere}
GROUP BY form_id, page_url
ORDER BY starts DESC
LIMIT 100
SETTINGS max_execution_time = 30
`.trim()

  const formRs = await client.query({
    query: formSql,
    query_params: queryParams,
    format: 'JSONEachRow',
  })
  const rawForms = await formRs.json<{ form_id: string; page_url: string; starts: number; submits: number; sample_count: number }>()
  const forms: FormAnalysisFormRow[] = rawForms.map((r) => ({
    form_id: r.form_id,
    page_url: r.page_url,
    starts: r.starts,
    submits: r.submits,
    completion_rate: r.starts > 0 ? r.submits / r.starts : null,
    abandonment_rate: r.starts > 0 ? (r.starts - r.submits) / r.starts : null,
    sample_count: r.sample_count,
  }))

  // Query 2: per-field touches + avg field_duration_ms (from form_field_focus events with field_duration_ms)
  const fieldSql = `
SELECT
  form_id,
  page_url,
  field_name,
  field_type,
  countIf(event_type = 'form_field_focus') AS touches,
  avgIf(field_duration_ms, event_type = 'form_field_focus' AND field_duration_ms > 0) AS avg_field_duration_ms
FROM clickinsight.form_interactions
WHERE ${baseWhere}
GROUP BY form_id, page_url, field_name, field_type
ORDER BY form_id, page_url, touches DESC
LIMIT 500
SETTINGS max_execution_time = 30
`.trim()

  const fieldRs = await client.query({
    query: fieldSql,
    query_params: queryParams,
    format: 'JSONEachRow',
  })
  const rawFields = await fieldRs.json<{ form_id: string; page_url: string; field_name: string; field_type: string; touches: number; avg_field_duration_ms: number | null }>()
  const fields: FormAnalysisFieldRow[] = rawFields.map((r) => ({
    form_id: r.form_id,
    page_url: r.page_url,
    field_name: r.field_name,
    field_type: r.field_type,
    touches: r.touches,
    avg_field_duration_ms: r.avg_field_duration_ms ?? null,
  }))

  // Query 3: last_field distribution (from form_abandon events using last_field column)
  const lastFieldSql = `
SELECT
  form_id,
  page_url,
  last_field,
  count() AS abandon_count
FROM clickinsight.form_interactions
WHERE ${baseWhere}
  AND event_type = 'form_abandon'
  AND last_field != ''
GROUP BY form_id, page_url, last_field
ORDER BY abandon_count DESC
LIMIT 200
SETTINGS max_execution_time = 30
`.trim()

  const lastFieldRs = await client.query({
    query: lastFieldSql,
    query_params: queryParams,
    format: 'JSONEachRow',
  })
  const lastFieldRows = await lastFieldRs.json<FormAnalysisLastFieldRow>()

  return {
    forms,
    fields,
    last_field_distribution: lastFieldRows,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: 'form_interactions テーブルから集計。日付列: created_at。is_agent 除外なし（form_interactions に is_agent 列なし）。completion_rate / abandonment_rate は TS で計算。',
  }
}

// ── analytics_frustration ────────────────────────────────────────────

/**
 * 欲求不満シグナル合成スコア: events テーブルの dead_click / rage_click +
 * behavior_signals テーブルの reversal_count / tab_switch_count / pinch_zoom_count / away_duration_ms / hover_clicked=0 を
 * per-page または全体で集計し、合成 frustration score を返す。
 *
 * frustration_score 算出方法 (TS 側で計算):
 *   score = dead_clicks * 1 + rage_clicks * 3 + reversals * 1 + tab_switches * 0.5
 *           + pinch_zooms * 0.5 + hover_no_clicks * 0.5 + avg_away_duration_factor
 *   away_duration_factor = min(1, avg_away_duration_ms / 30000) (30秒以上で上限 1 に正規化)
 *   正規化: score / (sessions + 1) で per-session スコアを計算
 *
 * 日付列:
 *   - events: timestamp (既存の Code 386 fix パターンを流用)
 *   - behavior_signals: created_at (NOT timestamp)
 * テーブル: clickinsight.events + clickinsight.behavior_signals (2 クエリ、TS で結合)
 */

export interface FrustrationPageRow {
  page_url: string
  sessions: number
  dead_clicks: number
  rage_clicks: number
  reversals: number
  tab_switches: number
  pinch_zooms: number
  hover_no_clicks: number
  avg_away_duration_ms: number
  /** 合成 frustration score (TS 計算、per-session 正規化済) */
  frustration_score: number
}

export interface FrustrationResult {
  rows: FrustrationPageRow[]
  total: FrustrationPageRow | null
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeFrustrationQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  pageUrl?: string
}): Promise<FrustrationResult> {
  const client = getClickHouseClient('analytics_reader')

  const eventsQueryParams: Record<string, string> = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
  }
  if (params.pageUrl) {
    eventsQueryParams.page_url = params.pageUrl
  }

  const pageUrlEventsFilter = params.pageUrl ? 'AND url = {page_url:String}' : ''
  const pageUrlBsFilter = params.pageUrl ? 'AND page_url = {page_url:String}' : ''

  // Query 1: events テーブルから dead_click / rage_click + sessions per page
  // timestamp 列使用 (events テーブル)、is_agent=0 で bot 除外
  const eventsGroupBy = params.pageUrl ? '' : 'GROUP BY url'
  const eventsSelectUrl = params.pageUrl ? `'${params.pageUrl}' AS page_url` : 'url AS page_url'

  const eventsSql = `
SELECT
  ${eventsSelectUrl},
  uniqExact(session_id) AS sessions,
  countIf(event_type = 'dead_click') AS dead_clicks,
  countIf(event_type = 'rage_click') AS rage_clicks
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND is_agent = 0
  AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
  ${pageUrlEventsFilter}
${eventsGroupBy}
ORDER BY sessions DESC
LIMIT 200
SETTINGS max_execution_time = 30
`.trim()

  // Query 2: behavior_signals テーブルから frustration signals per page
  // created_at 列使用 (behavior_signals テーブル、NOT timestamp)
  const bsGroupBy = params.pageUrl ? '' : 'GROUP BY page_url'
  const bsSelectUrl = params.pageUrl ? `'${params.pageUrl}' AS page_url` : 'page_url'

  const bsQueryParams: Record<string, string> = { ...eventsQueryParams }

  const bsSql = `
SELECT
  ${bsSelectUrl},
  sumIf(reversal_count, event_type = 'scroll_reversal') AS reversals,
  countIf(event_type = 'tab_return') AS tab_switches,
  countIf(event_type = 'pinch_zoom') AS pinch_zooms,
  countIf(event_type = 'cta_hover' AND hover_clicked = 0) AS hover_no_clicks,
  avgIf(away_duration_ms, event_type = 'tab_return' AND away_duration_ms > 0) AS avg_away_duration_ms
FROM clickinsight.behavior_signals
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND created_at >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND created_at < toDateTime(toDateTime({end:String}, {tz:String}))
  ${pageUrlBsFilter}
${bsGroupBy}
LIMIT 200
SETTINGS max_execution_time = 30
`.trim()

  const [eventsRs, bsRs] = await Promise.all([
    client.query({ query: eventsSql, query_params: eventsQueryParams, format: 'JSONEachRow' }),
    client.query({ query: bsSql, query_params: bsQueryParams, format: 'JSONEachRow' }),
  ])

  const eventsRows = await eventsRs.json<{ page_url: string; sessions: number; dead_clicks: number; rage_clicks: number }>()
  const bsRows = await bsRs.json<{ page_url: string; reversals: number; tab_switches: number; pinch_zooms: number; hover_no_clicks: number; avg_away_duration_ms: number }>()

  // TS 結合: page_url をキーに events + behavior_signals を merge
  const bsMap = new Map<string, typeof bsRows[number]>()
  for (const r of bsRows) {
    bsMap.set(r.page_url, r)
  }

  const rows: FrustrationPageRow[] = eventsRows.map((ev) => {
    const bs = bsMap.get(ev.page_url)
    const reversals = bs?.reversals ?? 0
    const tabSwitches = bs?.tab_switches ?? 0
    const pinchZooms = bs?.pinch_zooms ?? 0
    const hoverNoClicks = bs?.hover_no_clicks ?? 0
    const avgAwayMs = bs?.avg_away_duration_ms ?? 0

    const awayFactor = Math.min(1, avgAwayMs / 30000)
    const rawScore = ev.dead_clicks * 1
      + ev.rage_clicks * 3
      + reversals * 1
      + tabSwitches * 0.5
      + pinchZooms * 0.5
      + hoverNoClicks * 0.5
      + awayFactor

    return {
      page_url: ev.page_url,
      sessions: ev.sessions,
      dead_clicks: ev.dead_clicks,
      rage_clicks: ev.rage_clicks,
      reversals,
      tab_switches: tabSwitches,
      pinch_zooms: pinchZooms,
      hover_no_clicks: hoverNoClicks,
      avg_away_duration_ms: avgAwayMs,
      frustration_score: ev.sessions > 0 ? rawScore / ev.sessions : rawScore,
    }
  })

  // Sort by frustration_score DESC
  rows.sort((a, b) => b.frustration_score - a.frustration_score)

  // Total (site-wide aggregate, only when page_url filter is absent)
  let total: FrustrationPageRow | null = null
  if (!params.pageUrl && rows.length > 0) {
    const totalSessions = rows.reduce((s, r) => s + r.sessions, 0)
    const totalDeadClicks = rows.reduce((s, r) => s + r.dead_clicks, 0)
    const totalRageClicks = rows.reduce((s, r) => s + r.rage_clicks, 0)
    const totalReversals = rows.reduce((s, r) => s + r.reversals, 0)
    const totalTabSwitches = rows.reduce((s, r) => s + r.tab_switches, 0)
    const totalPinchZooms = rows.reduce((s, r) => s + r.pinch_zooms, 0)
    const totalHoverNoClicks = rows.reduce((s, r) => s + r.hover_no_clicks, 0)
    const avgAway = rows.length > 0 ? rows.reduce((s, r) => s + r.avg_away_duration_ms, 0) / rows.length : 0
    const awayFactor = Math.min(1, avgAway / 30000)
    const rawScore = totalDeadClicks * 1 + totalRageClicks * 3 + totalReversals * 1
      + totalTabSwitches * 0.5 + totalPinchZooms * 0.5 + totalHoverNoClicks * 0.5 + awayFactor

    total = {
      page_url: '__all__',
      sessions: totalSessions,
      dead_clicks: totalDeadClicks,
      rage_clicks: totalRageClicks,
      reversals: totalReversals,
      tab_switches: totalTabSwitches,
      pinch_zooms: totalPinchZooms,
      hover_no_clicks: totalHoverNoClicks,
      avg_away_duration_ms: avgAway,
      frustration_score: totalSessions > 0 ? rawScore / totalSessions : rawScore,
    }
  }

  return {
    rows,
    total,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: '日付列: events=timestamp, behavior_signals=created_at。2テーブルをTSで結合。frustration_score = (dead*1+rage*3+reversal*1+tab*0.5+pinch*0.5+hover_no_click*0.5+away_factor) / sessions。away_factor = min(1, avg_away_ms/30000)。',
  }
}

// ── analytics_performance ────────────────────────────────────────────

/**
 * Web Vitals p75 パフォーマンス分析。
 * web_vitals テーブルから LCP/INP/CLS/TTFB/FCP の p75 を返し、Core Web Vitals 評価を付与。
 *
 * 評価基準 (Google CWV 2024):
 *   LCP: <=2500ms Good / <=4000ms NeedsImprovement / >4000ms Poor
 *   INP: <=200ms Good / <=500ms NeedsImprovement / >500ms Poor
 *   CLS: <=0.1 Good / <=0.25 NeedsImprovement / >0.25 Poor
 *   TTFB: <=800ms Good / <=1800ms NeedsImprovement / >1800ms Poor
 *   FCP: <=1800ms Good / <=3000ms NeedsImprovement / >3000ms Poor
 *
 * 日付列: created_at (NOT timestamp) — Code 386 fix: toDateTime(toDateTime(...)) パターン。
 * テーブル: clickinsight.web_vitals。
 */

export type CwvRating = 'good' | 'needs_improvement' | 'poor' | 'no_data'

export interface CwvMetric {
  p75: number | null
  rating: CwvRating
}

export interface PerformanceRow {
  dimension_value: string
  sample_count: number
  lcp: CwvMetric
  inp: CwvMetric
  cls: CwvMetric
  ttfb: CwvMetric
  fcp: CwvMetric
}

export interface PerformanceResult {
  rows: PerformanceRow[]
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

function rateLcp(p75: number | null): CwvRating {
  if (p75 === null) return 'no_data'
  if (p75 <= 2500) return 'good'
  if (p75 <= 4000) return 'needs_improvement'
  return 'poor'
}

function rateInp(p75: number | null): CwvRating {
  if (p75 === null) return 'no_data'
  if (p75 <= 200) return 'good'
  if (p75 <= 500) return 'needs_improvement'
  return 'poor'
}

function rateCls(p75: number | null): CwvRating {
  if (p75 === null) return 'no_data'
  if (p75 <= 0.1) return 'good'
  if (p75 <= 0.25) return 'needs_improvement'
  return 'poor'
}

function rateTtfb(p75: number | null): CwvRating {
  if (p75 === null) return 'no_data'
  if (p75 <= 800) return 'good'
  if (p75 <= 1800) return 'needs_improvement'
  return 'poor'
}

function rateFcp(p75: number | null): CwvRating {
  if (p75 === null) return 'no_data'
  if (p75 <= 1800) return 'good'
  if (p75 <= 3000) return 'needs_improvement'
  return 'poor'
}

export async function executePerformanceQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  pageUrl?: string
  deviceType?: string
}): Promise<PerformanceResult> {
  const client = getClickHouseClient('analytics_reader')

  const queryParams: Record<string, string> = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
  }

  const filterClauses: string[] = []
  if (params.pageUrl) {
    filterClauses.push('AND page_url = {perf_page_url:String}')
    queryParams.perf_page_url = params.pageUrl
  }
  if (params.deviceType) {
    filterClauses.push('AND device_type = {perf_device_type:String}')
    queryParams.perf_device_type = params.deviceType
  }

  // Determine grouping dimension
  const hasGrouping = !params.pageUrl && !params.deviceType
  const groupByExpr = hasGrouping ? null
    : params.pageUrl && params.deviceType ? 'concat(page_url, \'|\', device_type)'
    : params.pageUrl ? 'page_url'
    : 'device_type'

  let sql: string
  if (groupByExpr === null) {
    // No filters: overall site total
    sql = `
SELECT
  '__total__' AS dimension_value,
  count() AS sample_count,
  quantile(0.75)(lcp_ms) AS lcp_p75,
  quantile(0.75)(inp_ms) AS inp_p75,
  quantile(0.75)(cls_score) AS cls_p75,
  quantile(0.75)(ttfb_ms) AS ttfb_p75,
  quantile(0.75)(fcp_ms) AS fcp_p75
FROM clickinsight.web_vitals
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND created_at >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND created_at < toDateTime(toDateTime({end:String}, {tz:String}))
  ${filterClauses.join(' ')}
SETTINGS max_execution_time = 30
`.trim()
  } else {
    sql = `
SELECT
  toString(${groupByExpr}) AS dimension_value,
  count() AS sample_count,
  quantile(0.75)(lcp_ms) AS lcp_p75,
  quantile(0.75)(inp_ms) AS inp_p75,
  quantile(0.75)(cls_score) AS cls_p75,
  quantile(0.75)(ttfb_ms) AS ttfb_p75,
  quantile(0.75)(fcp_ms) AS fcp_p75
FROM clickinsight.web_vitals
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND created_at >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND created_at < toDateTime(toDateTime({end:String}, {tz:String}))
  ${filterClauses.join(' ')}
GROUP BY dimension_value
ORDER BY sample_count DESC
LIMIT 100
SETTINGS max_execution_time = 30
`.trim()
  }

  const rs = await client.query({
    query: sql,
    query_params: queryParams,
    format: 'JSONEachRow',
  })

  const rawRows = await rs.json<{
    dimension_value: string
    sample_count: number
    lcp_p75: number | null
    inp_p75: number | null
    cls_p75: number | null
    ttfb_p75: number | null
    fcp_p75: number | null
  }>()

  const rows: PerformanceRow[] = rawRows.map((r) => ({
    dimension_value: r.dimension_value,
    sample_count: r.sample_count,
    lcp: { p75: r.lcp_p75, rating: rateLcp(r.lcp_p75) },
    inp: { p75: r.inp_p75, rating: rateInp(r.inp_p75) },
    cls: { p75: r.cls_p75, rating: rateCls(r.cls_p75) },
    ttfb: { p75: r.ttfb_p75, rating: rateTtfb(r.ttfb_p75) },
    fcp: { p75: r.fcp_p75, rating: rateFcp(r.fcp_p75) },
  }))

  return {
    rows,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: 'web_vitals テーブルから集計。日付列: created_at。p75 = quantile(0.75)。評価基準: LCP<=2500 Good/<=4000 NI; INP<=200/<=500; CLS<=0.1/<=0.25; TTFB<=800/<=1800; FCP<=1800/<=3000。',
  }
}

// ── analytics_cta_funnel ─────────────────────────────────────────────

/**
 * CTA ファネル: element_visibility_v2 の露出 + events の click を element_selector キーで結合し
 * per-CTA の impressions / clicks / CTR を返す。
 *
 * 結合方法: element_selector (+page_url) を key に 2 クエリを TS で結合 (近似結合)。
 * session 単位の厳密な順序結合 (先に見た → クリック) は実装しない。
 * 代わりに「同期間内の同 selector の露出数 vs クリック数」で近似 CTR を算出する。
 * この近似は 1 セッション内に複数回露出 + クリックが含まれ得るため、
 * true CTR (一意セッションベース) より大きくなる可能性がある。
 *
 * コンバージョンレグ: bihadashop には conversion イベントが存在しないため実装しない。
 *
 * 日付列:
 *   - element_visibility_v2: created_at (NOT timestamp)
 *   - events: timestamp (既存の Code 386 fix パターンを流用)
 * テーブル: clickinsight.element_visibility_v2 + clickinsight.events。
 */

export interface CtaFunnelRow {
  element_selector: string
  page_url: string
  impressions: number
  clicks: number
  ctr: number | null
}

export interface CtaFunnelResult {
  rows: CtaFunnelRow[]
  approximation_note: string
  conversion_note: string
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeCtaFunnelQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  pageUrl?: string
}): Promise<CtaFunnelResult> {
  const client = getClickHouseClient('analytics_reader')

  const baseQueryParams: Record<string, string> = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
  }

  const pageUrlVisFilter = params.pageUrl ? 'AND page_url = {cta_page_url:String}' : ''
  const pageUrlEvFilter = params.pageUrl ? 'AND url = {cta_page_url:String}' : ''
  if (params.pageUrl) {
    baseQueryParams.cta_page_url = params.pageUrl
  }

  // Query 1: element_visibility_v2 impressions per (element_selector, page_url)
  // created_at 列使用 (element_visibility_v2 テーブル)
  const visGroupBy = params.pageUrl ? 'element_selector' : 'element_selector, page_url'
  const visSelectUrl = params.pageUrl
    ? `'${params.pageUrl}' AS page_url, element_selector`
    : 'page_url, element_selector'

  const visSql = `
SELECT
  ${visSelectUrl},
  count() AS impressions
FROM clickinsight.element_visibility_v2
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND created_at >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND created_at < toDateTime(toDateTime({end:String}, {tz:String}))
  ${pageUrlVisFilter}
GROUP BY ${visGroupBy}
ORDER BY impressions DESC
LIMIT 500
SETTINGS max_execution_time = 30
`.trim()

  // Query 2: events click counts per (element_selector, url)
  // timestamp 列使用 (events テーブル)、is_agent=0 で bot 除外
  // element_selector 列は events テーブルに存在 (ALTER TABLE で追加済)
  const evGroupBy = params.pageUrl ? 'element_selector' : 'element_selector, url'
  const evSelectUrl = params.pageUrl
    ? `'${params.pageUrl}' AS page_url, element_selector`
    : 'url AS page_url, element_selector'

  const evSql = `
SELECT
  ${evSelectUrl},
  count() AS clicks
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND is_agent = 0
  AND event_type = 'click'
  AND element_selector != ''
  AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
  ${pageUrlEvFilter}
GROUP BY ${evGroupBy}
ORDER BY clicks DESC
LIMIT 500
SETTINGS max_execution_time = 30
`.trim()

  const [visRs, evRs] = await Promise.all([
    client.query({ query: visSql, query_params: baseQueryParams, format: 'JSONEachRow' }),
    client.query({ query: evSql, query_params: baseQueryParams, format: 'JSONEachRow' }),
  ])

  const visRows = await visRs.json<{ page_url: string; element_selector: string; impressions: number }>()
  const evRows = await evRs.json<{ page_url: string; element_selector: string; clicks: number }>()

  // TS 結合: (element_selector + page_url) をキーに結合
  const evMap = new Map<string, number>()
  for (const r of evRows) {
    evMap.set(`${r.element_selector}|${r.page_url}`, r.clicks)
  }

  const rows: CtaFunnelRow[] = visRows.map((vis) => {
    const key = `${vis.element_selector}|${vis.page_url}`
    const clicks = evMap.get(key) ?? 0
    return {
      element_selector: vis.element_selector,
      page_url: vis.page_url,
      impressions: vis.impressions,
      clicks,
      ctr: vis.impressions > 0 ? clicks / vis.impressions : null,
    }
  })

  // Sort by impressions DESC
  rows.sort((a, b) => b.impressions - a.impressions)

  return {
    rows,
    approximation_note: '露出数と clicks 数を element_selector + page_url キーで近似結合。厳密な session 単位の先後順序結合は未実施。同一 session 内の複数露出/クリックが含まれ得るため、true CTR (一意セッションベース) より大きくなる可能性あり。',
    conversion_note: 'bihadashop には conversion イベントが存在しないため、コンバージョンレグ (click→conversion) は実装していません。',
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: '日付列: element_visibility_v2=created_at, events=timestamp。2テーブルをTSで近似結合。CTR = clicks / impressions (近似)。',
  }
}

// ── analytics_path ───────────────────────────────────────────────────

/**
 * ユーザー経路分析: events テーブルの previous_url / url (event_type='pageview') を使い
 * 指定ページへの流入元 or 離脱先を返す。
 *
 * direction='next': rows where previous_url = {page_url} → group by url (次ページ)
 * direction='prev': rows where url = {page_url} → group by previous_url (前ページ)
 * page_url 省略時: previous_url → url 遷移全体 top N
 *
 * 追加:
 *   - top entry pages: per-session min(sequence_id) を持つ url (最初に見られたページ)
 *   - top exit pages: per-session max(sequence_id) を持つ url (最後に見られたページ)
 *
 * SQL injection 防御:
 *   - page_url は query_params binding
 *   - is_agent=0, tenant/site server-fixed
 *   - Code 386 fix: toDateTime(toDateTime({start:String}, {tz:String}))
 */

export interface PathTransitionRow {
  from_url: string
  to_url: string
  sessions: number
  share_pct: number
}

export interface PathEntryExitRow {
  url: string
  sessions: number
  share_pct: number
}

export interface PathResult {
  transitions: PathTransitionRow[]
  entry_pages: PathEntryExitRow[]
  exit_pages: PathEntryExitRow[]
  page_url: string | null
  direction: 'next' | 'prev'
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executePathQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  pageUrl?: string
  direction: 'next' | 'prev'
  limit: number
}): Promise<PathResult> {
  const client = getClickHouseClient('analytics_reader')

  const baseParams: Record<string, string> = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
    limit: String(params.limit),
  }
  if (params.pageUrl) {
    baseParams.page_url = params.pageUrl
  }

  const baseWhere = `
    tenant_id = {tenant_id:String}
    AND site_id = {site_id:String}
    AND event_type = 'pageview'
    AND is_agent = 0
    AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
    AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
  `.trim()

  // ── Transition query ──
  let transitionSql: string
  if (!params.pageUrl) {
    // No page_url: top previous_url → url transitions overall
    transitionSql = `
WITH seq AS (
  SELECT
    url AS from_url,
    leadInFrame(url) OVER (PARTITION BY session_id ORDER BY timestamp ASC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS to_url,
    session_id
  FROM clickinsight.events
  WHERE ${baseWhere}
),
trans AS (
  SELECT from_url, to_url, uniqExact(session_id) AS sessions
  FROM seq
  WHERE to_url != '' AND to_url != from_url
  GROUP BY from_url, to_url
  ORDER BY sessions DESC
  LIMIT {limit:UInt32}
),
total AS (SELECT sum(sessions) AS t FROM trans)
SELECT
  from_url,
  to_url,
  sessions,
  if((SELECT t FROM total) > 0, sessions / (SELECT t FROM total), 0) AS share_pct
FROM trans
ORDER BY sessions DESC
SETTINGS max_execution_time = 30
`.trim()
  } else if (params.direction === 'next') {
    // Sessions that viewed page_url → next page (rows where previous_url = page_url)
    transitionSql = `
WITH seq AS (
  SELECT
    url,
    leadInFrame(url) OVER (PARTITION BY session_id ORDER BY timestamp ASC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS next_url,
    session_id
  FROM clickinsight.events
  WHERE ${baseWhere}
),
trans AS (
  SELECT
    {page_url:String} AS from_url,
    next_url AS to_url,
    uniqExact(session_id) AS sessions
  FROM seq
  WHERE url = {page_url:String} AND next_url != '' AND next_url != url
  GROUP BY to_url
  ORDER BY sessions DESC
  LIMIT {limit:UInt32}
),
total AS (SELECT sum(sessions) AS t FROM trans)
SELECT
  from_url,
  to_url,
  sessions,
  if((SELECT t FROM total) > 0, sessions / (SELECT t FROM total), 0) AS share_pct
FROM trans
ORDER BY sessions DESC
SETTINGS max_execution_time = 30
`.trim()
  } else {
    // direction='prev': most common previous_url for page_url
    transitionSql = `
WITH seq AS (
  SELECT
    url,
    lagInFrame(url) OVER (PARTITION BY session_id ORDER BY timestamp ASC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS prev_url,
    session_id
  FROM clickinsight.events
  WHERE ${baseWhere}
),
trans AS (
  SELECT
    if(prev_url = '', '(direct)', prev_url) AS from_url,
    {page_url:String} AS to_url,
    uniqExact(session_id) AS sessions
  FROM seq
  WHERE url = {page_url:String}
  GROUP BY from_url
  ORDER BY sessions DESC
  LIMIT {limit:UInt32}
),
total AS (SELECT sum(sessions) AS t FROM trans)
SELECT
  from_url,
  to_url,
  sessions,
  if((SELECT t FROM total) > 0, sessions / (SELECT t FROM total), 0) AS share_pct
FROM trans
ORDER BY sessions DESC
SETTINGS max_execution_time = 30
`.trim()
  }

  // ── Entry pages query ──
  const entrySql = `
WITH first_pv AS (
  SELECT session_id, argMin(url, timestamp) AS entry_url
  FROM clickinsight.events
  WHERE ${baseWhere}
  GROUP BY session_id
)
SELECT
  entry_url AS url,
  count() AS sessions
FROM first_pv
GROUP BY url
ORDER BY sessions DESC
LIMIT {limit:UInt32}
SETTINGS max_execution_time = 30
`.trim()

  // ── Exit pages query ──
  const exitSql = `
WITH last_pv AS (
  SELECT session_id, argMax(url, timestamp) AS exit_url
  FROM clickinsight.events
  WHERE ${baseWhere}
  GROUP BY session_id
)
SELECT
  exit_url AS url,
  count() AS sessions
FROM last_pv
GROUP BY url
ORDER BY sessions DESC
LIMIT {limit:UInt32}
SETTINGS max_execution_time = 30
`.trim()

  const [transRs, entryRs, exitRs] = await Promise.all([
    client.query({ query: transitionSql, query_params: baseParams, format: 'JSONEachRow' }),
    client.query({ query: entrySql, query_params: baseParams, format: 'JSONEachRow' }),
    client.query({ query: exitSql, query_params: baseParams, format: 'JSONEachRow' }),
  ])

  const rawTrans = await transRs.json<PathTransitionRow>()
  const rawEntry = await entryRs.json<{ url: string; sessions: number }>()
  const rawExit = await exitRs.json<{ url: string; sessions: number }>()

  // Share pct for entry/exit
  const entryTotal = rawEntry.reduce((s, r) => s + r.sessions, 0)
  const exitTotal = rawExit.reduce((s, r) => s + r.sessions, 0)

  const entry_pages: PathEntryExitRow[] = rawEntry.map((r) => ({
    url: r.url,
    sessions: r.sessions,
    share_pct: entryTotal > 0 ? r.sessions / entryTotal : 0,
  }))
  const exit_pages: PathEntryExitRow[] = rawExit.map((r) => ({
    url: r.url,
    sessions: r.sessions,
    share_pct: exitTotal > 0 ? r.sessions / exitTotal : 0,
  }))

  return {
    transitions: rawTrans,
    entry_pages,
    exit_pages,
    page_url: params.pageUrl ?? null,
    direction: params.direction,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: 'session 内の閲覧順(timestamp)を window で辿った経路分析(next=leadInFrame / prev=lagInFrame、event_type=pageview / is_agent=0)。previous_url 列は本番未投入のため timestamp 順に切替。share_pct は上位 N 件内の相対比率。entry/exit は session 内 min/max(timestamp)。1ページ完結が多いサイトでは遷移は少数。D-07 observed_approx。',
  }
}

// ── analytics_funnel ─────────────────────────────────────────────────

/**
 * ClickHouse windowFunnel による順序付きファネル分析。
 *
 * steps: 2〜5 ステップの順序付き条件配列。
 *   各 step は { kind: 'page' | 'event', value: string } の形式。
 *   - kind='page': event_type='pageview' AND url = value
 *   - kind='event': event_type = value
 *
 * SQL injection 防御:
 *   - step の value は query_params binding ({step0_val:String} 等)
 *   - kind は TS で 'page' | 'event' に enum 強制 (SQL に kind を流さない)
 *   - is_agent=0, tenant/site server-fixed, max_execution_time=30
 *
 * windowFunnel(86400) = 86400 秒 (24 時間) ウィンドウ内の最大 step 進行を計算。
 * per session の max reached level を集計し、各 step の reached count と
 * 次 step への conversion_rate を返す。
 */

export interface FunnelStep {
  kind: 'page' | 'event'
  value: string
}

export interface FunnelStepResult {
  step_index: number
  /** step 定義 */
  step_kind: 'page' | 'event'
  step_value: string
  /** このステップ以上に到達したセッション数 */
  reached_sessions: number
  /** 前ステップからの conversion rate (step 0 は null) */
  conversion_rate: number | null
}

export interface FunnelResult {
  steps: FunnelStepResult[]
  total_sessions: number
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

/** event type allowlist (SQL injection 防止: kind='event' の value をバインドで渡すが念のため) */
const ALLOWED_EVENT_TYPES = new Set([
  'pageview',
  'click',
  'conversion',
  'session_end',
  'dead_click',
  'rage_click',
  'scroll',
  'read_area',
  'scroll_depth',
  'active_time',
  'form_submit',
  'form_view',
  'form_abandon',
  'scroll_anchor_hit',
  'alt_read_signal',
  'text_node_dwell',
])

export async function executeFunnelQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  steps: FunnelStep[]
}): Promise<FunnelResult> {
  if (params.steps.length < 2 || params.steps.length > 5) {
    throw new Error('funnel: steps must be 2-5')
  }

  // Validate event type values (SQL injection 防御)
  for (const step of params.steps) {
    if (step.kind === 'event' && !ALLOWED_EVENT_TYPES.has(step.value)) {
      throw new Error(`funnel: event type '${step.value}' is not in the allowed list`)
    }
    // page URLs are bound via query_params (no interpolation)
  }

  // Build windowFunnel conditions: each step is a bound parameter
  // step value は query_params binding ({step0_val:String} etc.) - 絶対に SQL 文字列に直接埋め込まない
  const stepConditions = params.steps.map((step, i) => {
    if (step.kind === 'page') {
      return `(event_type = 'pageview' AND url = {step${i}_val:String})`
    } else {
      return `(event_type = {step${i}_val:String})`
    }
  })
  const windowFunnelArgs = stepConditions.join(', ')

  const sql = `
WITH funnel_levels AS (
  SELECT
    session_id,
    windowFunnel(86400)(toUInt32(toUnixTimestamp(timestamp)), ${windowFunnelArgs}) AS level
  FROM clickinsight.events
  WHERE tenant_id = {tenant_id:String}
    AND site_id = {site_id:String}
    AND is_agent = 0
    AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
    AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
  GROUP BY session_id
)
SELECT level, count() AS cnt
FROM funnel_levels
GROUP BY level
ORDER BY level
SETTINGS max_execution_time = 30
`.trim()

  const queryParams: Record<string, string> = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
  }
  // Bind each step value
  for (let i = 0; i < params.steps.length; i++) {
    queryParams[`step${i}_val`] = params.steps[i].value
  }

  const client = getClickHouseClient('analytics_reader')
  const rs = await client.query({
    query: sql,
    query_params: queryParams,
    format: 'JSONEachRow',
  })

  const rawRows = await rs.json<{ level: number; cnt: number }>()

  // level=0 means no step reached; level=k means steps 0..k-1 reached
  // Build level → count map
  const levelMap = new Map<number, number>()
  for (const r of rawRows) {
    levelMap.set(r.level, (levelMap.get(r.level) ?? 0) + r.cnt)
  }
  const totalSessions = Array.from(levelMap.values()).reduce((s, v) => s + v, 0)

  // reached_sessions[k] = sessions that reached at least step k (level >= k+1)
  const steps: FunnelStepResult[] = params.steps.map((step, i) => {
    // sessions with level >= i+1 (reached step i, 0-indexed)
    let reached = 0
    for (const [level, cnt] of levelMap.entries()) {
      if (level >= i + 1) reached += cnt
    }
    const prevReached = i === 0 ? totalSessions : (() => {
      let p = 0
      for (const [level, cnt] of levelMap.entries()) {
        if (level >= i) p += cnt
      }
      return p
    })()
    return {
      step_index: i,
      step_kind: step.kind,
      step_value: step.value,
      reached_sessions: reached,
      conversion_rate: i === 0 ? null : (prevReached > 0 ? reached / prevReached : 0),
    }
  })

  return {
    steps,
    total_sessions: totalSessions,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: `windowFunnel(86400秒) でセッション内の最大ステップ到達を集計。ステップ値は query_params でバインド (SQL injection 防御)。is_agent=0。bihadashop では conversion イベント未計測のため conversion ステップは CVR=0 になります。D-07 observed_approx。`,
  }
}

// ── analytics_correlation ────────────────────────────────────────────

/**
 * 2 指標の相関分析 (per-dimension-value、例: per page_url)。
 *
 * 設計:
 *   - per dimension value (page_url または device_type) で metricA と metricB を集計
 *   - sessions >= minSample の dimension value のみ対象
 *   - corr(a, b) over the paired (dim_value, a, b) rows を ClickHouse の corr() で計算
 *   - cross-table join (web_vitals 等) は行わず、events 単一テーブルのみ
 *     (future: web_vitals の LCP と CVR の相関は別途 executeFutureCorrelationQuery で実装)
 *   - is_agent=0, tenant/site server-fixed, Code 386 fix
 *
 * 対応指標 (buildCorrelationMetricExpr):
 *   sessions, pageviews, cvr, avg_scroll_depth, dead_click_rate, rage_click_rate, bounce_rate
 *
 * SQL injection 防御:
 *   - metricA / metricB はホワイトリストで enum 強制 → SQL expression は TS で構築
 *   - by (dimension) も enum 強制
 */

export type CorrelationMetric =
  | 'sessions'
  | 'pageviews'
  | 'cvr'
  | 'avg_scroll_depth'
  | 'dead_click_rate'
  | 'rage_click_rate'
  | 'bounce_rate'

export const CORRELATION_METRICS: CorrelationMetric[] = [
  'sessions',
  'pageviews',
  'cvr',
  'avg_scroll_depth',
  'dead_click_rate',
  'rage_click_rate',
  'bounce_rate',
]

export type CorrelationBy = 'page_url' | 'device_type'
export const CORRELATION_BY: CorrelationBy[] = ['page_url', 'device_type']

export interface CorrelationPairRow {
  dimension_value: string
  metric_a: number
  metric_b: number
  sessions: number
}

export interface CorrelationResult {
  metric_a: CorrelationMetric
  metric_b: CorrelationMetric
  by: CorrelationBy
  pearson_r: number | null
  sample_size: number
  min_sample_filter: number
  pairs: CorrelationPairRow[]
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

function buildCorrelationMetricExpr(metric: CorrelationMetric): string {
  switch (metric) {
    case 'sessions':
      return 'toFloat64(uniqExact(session_id))'
    case 'pageviews':
      return "toFloat64(countIf(event_type = 'pageview'))"
    case 'cvr':
      return "if(uniqExact(session_id) > 0, toFloat64(uniqExactIf(session_id, conversion_type IS NOT NULL AND conversion_type != '')) / toFloat64(uniqExact(session_id)), 0)"
    case 'avg_scroll_depth':
      return "toFloat64(avgIf(scroll_percentage, event_type = 'scroll'))"
    case 'dead_click_rate':
      return "if(countIf(event_type = 'click') + countIf(event_type = 'dead_click') > 0, toFloat64(countIf(event_type = 'dead_click')) / toFloat64(countIf(event_type = 'click') + countIf(event_type = 'dead_click')), 0)"
    case 'rage_click_rate':
      return "if(countIf(event_type = 'click') + countIf(event_type = 'rage_click') > 0, toFloat64(countIf(event_type = 'rage_click')) / toFloat64(countIf(event_type = 'click') + countIf(event_type = 'rage_click')), 0)"
    case 'bounce_rate':
      return (
        'if(uniqExact(session_id) > 0,' +
        " toFloat64(uniqExactIf(session_id, event_type = 'session_end' AND page_views_in_session <= 1 AND session_duration_sec < 10))" +
        ' / toFloat64(uniqExact(session_id)), 0)'
      )
  }
}

export async function executeCorrelationQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  metricA: CorrelationMetric
  metricB: CorrelationMetric
  by: CorrelationBy
  minSample: number
}): Promise<CorrelationResult> {
  const dimExpr = params.by === 'page_url' ? 'url' : 'device_type'
  const exprA = buildCorrelationMetricExpr(params.metricA)
  const exprB = buildCorrelationMetricExpr(params.metricB)

  // Per-dimension pairs query + in-query Pearson corr()
  const sql = `
WITH pairs AS (
  SELECT
    toString(${dimExpr}) AS dimension_value,
    ${exprA} AS metric_a,
    ${exprB} AS metric_b,
    toFloat64(uniqExact(session_id)) AS sessions
  FROM clickinsight.events
  WHERE tenant_id = {tenant_id:String}
    AND site_id = {site_id:String}
    AND is_agent = 0
    AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
    AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
  GROUP BY dimension_value
  HAVING sessions >= {min_sample:UInt32}
)
SELECT
  dimension_value,
  metric_a,
  metric_b,
  sessions
FROM pairs
ORDER BY sessions DESC
LIMIT 500
SETTINGS max_execution_time = 30
`.trim()

  // Pearson correlation query (computed over all qualifying pairs)
  const corrSql = `
WITH pairs AS (
  SELECT
    toString(${dimExpr}) AS dimension_value,
    ${exprA} AS metric_a,
    ${exprB} AS metric_b,
    toFloat64(uniqExact(session_id)) AS sessions
  FROM clickinsight.events
  WHERE tenant_id = {tenant_id:String}
    AND site_id = {site_id:String}
    AND is_agent = 0
    AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
    AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
  GROUP BY dimension_value
  HAVING sessions >= {min_sample:UInt32}
)
SELECT
  corr(metric_a, metric_b) AS pearson_r,
  count() AS sample_size
FROM pairs
SETTINGS max_execution_time = 30
`.trim()

  const queryParams: Record<string, string> = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
    min_sample: String(params.minSample),
  }

  const client = getClickHouseClient('analytics_reader')
  const [pairsRs, corrRs] = await Promise.all([
    client.query({ query: sql, query_params: queryParams, format: 'JSONEachRow' }),
    client.query({ query: corrSql, query_params: queryParams, format: 'JSONEachRow' }),
  ])

  const rawPairs = await pairsRs.json<CorrelationPairRow>()
  const rawCorr = await corrRs.json<{ pearson_r: number | null; sample_size: number }>()

  const pearsonR = rawCorr[0]?.pearson_r ?? null
  const sampleSize = rawCorr[0]?.sample_size ?? 0

  // Handle NaN from ClickHouse (corr returns NaN if variance=0)
  const safePearsonR = pearsonR !== null && Number.isFinite(pearsonR) ? pearsonR : null

  return {
    metric_a: params.metricA,
    metric_b: params.metricB,
    by: params.by,
    pearson_r: safePearsonR,
    sample_size: sampleSize,
    min_sample_filter: params.minSample,
    pairs: rawPairs,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: `events 単一テーブル per-${params.by} の ${params.metricA} × ${params.metricB} Pearson 相関。sessions >= ${params.minSample} の dimension 値のみ対象。cross-table (web_vitals 等) の join は今後の拡張。D-07 observed_approx。bihadashop はコンバージョン未計測のため cvr=0。`,
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
  // Step 3 拡張: utm_source / visitor_type / conversion_type / referrer_type を追加
  //   - utm_source: events.utm_source 列 (続 82 Infra 追加済、空文字も許容)
  //   - visitor_type: 直接 is_first_visit Bool 列ではなく derived expr は bind で使えないため
  //     visitor_type は events table に列として存在しないが、is_first_visit Bool → 'new'/'returning' derive
  //     → カラム名ではなく derived expression (if expr) での比較が必要。
  //     セキュリティ上問題ないので visitor_type キーに対しては is_first_visit を使う特別扱いを実装。
  //   - conversion_type: events.conversion_type 列
  //   - referrer_type: events.referrer 列 (空='direct'、同ドメイン='internal'、他='referral') を
  //     filter value 'direct'/'internal'/'referral' と比較するには CASE/if 式が必要。
  //     セキュリティ上 filter value を enum で強制し SQL 式を構築する。
  //
  // 実装方針:
  //   - 単純列 map (page_url, device, utm_source, conversion_type): physicalColumn = {colName} = {param}
  //   - 特別 expr map (visitor_type, referrer_type): filter_expr を直接組み立て (value は param binding)
  //     visitor_type: if(is_first_visit, 'new', 'returning') = {param}
  //     referrer_type value allowlist: 'direct', 'internal', 'referral' のみ許可 (LLM が自由な値を渡せない)
  const FILTER_COLUMN: Record<string, string | null> = {
    page_url: 'url',
    device: 'device_type',
    // Step 3 additions
    utm_source: 'utm_source',
    conversion_type: 'conversion_type',
    // special expr (null = not a simple column comparison)
    visitor_type: null,
    referrer_type: null,
  }
  // Allowlist for derived-expr filter values (injection 防御)
  const VISITOR_TYPE_VALUES = new Set(['new', 'returning'])
  const REFERRER_TYPE_VALUES = new Set(['direct', 'internal', 'referral'])

  const filterClauses: string[] = []
  const filterParams: Record<string, string> = {}
  for (const [k, v] of Object.entries(params.filter)) {
    if (!(k in FILTER_COLUMN)) {
      throw new Error(`verify: filter key '${k}' is not allowed`)
    }
    if (k === 'visitor_type') {
      if (!VISITOR_TYPE_VALUES.has(v)) {
        throw new Error(`verify: visitor_type value '${v}' is not allowed (must be 'new' or 'returning')`)
      }
      // is_first_visit Bool → 'new' / 'returning' derived expression
      filterClauses.push(`AND if(is_first_visit, 'new', 'returning') = {filter_visitor_type:String}`)
      filterParams['filter_visitor_type'] = v
    } else if (k === 'referrer_type') {
      if (!REFERRER_TYPE_VALUES.has(v)) {
        throw new Error(`verify: referrer_type value '${v}' is not allowed (must be 'direct', 'internal', or 'referral')`)
      }
      // referrer 列から referrer_type を derive して比較
      // 'direct' = referrer = ''
      // 'internal' = referrer LIKE concat('%', domain(url), '%')
      // 'referral' = otherwise
      // バインドでは derive 式に if() を使い、{param} と比較
      filterClauses.push(`AND if(referrer = '', 'direct', if(referrer LIKE concat('%', domain(url), '%'), 'internal', 'referral')) = {filter_referrer_type:String}`)
      filterParams['filter_referrer_type'] = v
    } else {
      const physicalColumn = FILTER_COLUMN[k]
      filterClauses.push(`AND ${physicalColumn} = {filter_${k}:String}`)
      filterParams[`filter_${k}`] = v
    }
  }

  // 続 82-ml Phase 2 (2026-05-25): bounce_rate / avg_session_duration を raw exact 再計算で復活。
  //   - bounce_rate: bounce_sessions / sessions (session_end 受信した session 限定)
  //   - avg_session_duration: quantileTDigestIf(0.5)(session_duration_sec, event_type='session_end')
  const metricExpr = (() => {
    switch (params.metric) {
      case 'sessions':
        return 'toFloat64(uniqExact(session_id))'
      case 'page_views':
        return 'toFloat64(countIf(event_type = \'pageview\'))'
      case 'cvr':
        return "if(uniqExact(session_id) > 0, uniqExactIf(session_id, conversion_type IS NOT NULL AND conversion_type != '') / uniqExact(session_id), 0)"
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

// ════════════════════════════════════════════════════════════════════
// Phase 1 単発ツール拡張 (2026-06-06): 既存17ツールと重複しない穴を埋める6ツール。
//   全て本番 ClickHouse で schema/population 検証済 (read-only)。
//   tenant_id/site_id は引数で server 固定。is_agent=0 (events のみ持つ列)。
//   日付は Code 386 fix: toDateTime(toDateTime({str},{tz})) で tz tag を剥がす。
// ════════════════════════════════════════════════════════════════════

// ── analytics_data_readiness ─────────────────────────────────────────

/**
 * サイトの「何が分かるか」在庫 (D-07 防波堤 + Deep Research scoping の頭脳)。
 * events + 各専用テーブルの実測 count を返し、capabilities / blocked を導出する。
 * 検証済の現実: element_visibility_v2 の is_above_fold/is_cta/element_clicked は tracker 未投入で全0、
 *   conversion_value(売上金額) は全サイト0、gsc_data は tenant_id 列なし & 空。
 */
export interface DataReadinessSignal {
  area: string
  available: boolean
  detail: string
}
export interface DataReadinessResult {
  signals: DataReadinessSignal[]
  capabilities: string[]
  blocked: string[]
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeDataReadinessQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
}): Promise<DataReadinessResult> {
  const client = getClickHouseClient('analytics_reader')
  const baseParams = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
  }
  const tRange = `timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))`
  const cRange = `created_at >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND created_at < toDateTime(toDateTime({end:String}, {tz:String}))`

  const eventsSql = `
SELECT
  countIf(event_type = 'pageview') AS pageviews,
  uniqExactIf(session_id, event_type = 'pageview') AS sessions,
  uniqExact(visitor_id) AS visitors,
  countIf(conversion_type IS NOT NULL AND conversion_type != '') AS conversions,
  countIf(conversion_value > 0) AS conv_value_events,
  countIf(page_views_in_session > 1) AS multipage_rows,
  countIf(event_type IN ('click', 'dead_click', 'rage_click') AND click_x > 0) AS clicks_with_coords,
  countIf(event_type = 'dead_click') AS dead_clicks,
  countIf(event_type = 'rage_click') AS rage_clicks
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND is_agent = 0
  AND ${tRange}
SETTINGS max_execution_time = 30`.trim()

  const sideCount = (table: string) => `
SELECT count() AS c FROM clickinsight.${table}
WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND ${cRange}
SETTINGS max_execution_time = 30`.trim()

  const gscSql = `
SELECT count() AS c FROM clickinsight.gsc_data
WHERE site_id = {site_id:String}
  AND date >= toDate(toDateTime({start:String}, {tz:String}))
  AND date < toDate(toDateTime({end:String}, {tz:String}))
SETTINGS max_execution_time = 30`.trim()

  const run = async <T>(sql: string): Promise<T> => {
    const rs = await client.query({ query: sql, query_params: baseParams, format: 'JSONEachRow' })
    const rows = await rs.json<T>()
    return rows[0] ?? ({} as T)
  }

  const [ev, forms, vitals, elements, images, videos, signalsTbl, gsc] = await Promise.all([
    run<{
      pageviews: number
      sessions: number
      visitors: number
      conversions: number
      conv_value_events: number
      multipage_rows: number
      clicks_with_coords: number
      dead_clicks: number
      rage_clicks: number
    }>(eventsSql),
    run<{ c: number }>(sideCount('form_interactions')),
    run<{ c: number }>(sideCount('web_vitals')),
    run<{ c: number }>(sideCount('element_visibility_v2')),
    run<{ c: number }>(sideCount('image_visibility')),
    run<{ c: number }>(sideCount('video_events')),
    run<{ c: number }>(sideCount('behavior_signals')),
    run<{ c: number }>(gscSql),
  ])

  const n = (v: number | undefined): number => Number(v ?? 0)
  const signals: DataReadinessSignal[] = [
    { area: 'pageviews', available: n(ev.pageviews) > 0, detail: `pageviews=${n(ev.pageviews)} / sessions=${n(ev.sessions)} / visitors=${n(ev.visitors)}` },
    { area: 'conversions', available: n(ev.conversions) > 0, detail: `conversion events=${n(ev.conversions)} (売上金額 conversion_value>0=${n(ev.conv_value_events)})` },
    { area: 'multipage_journeys', available: n(ev.multipage_rows) > 0, detail: `multipage rows=${n(ev.multipage_rows)}` },
    { area: 'clicks_dead_zones', available: n(ev.clicks_with_coords) > 0, detail: `clicks(coords)=${n(ev.clicks_with_coords)} / dead=${n(ev.dead_clicks)} / rage=${n(ev.rage_clicks)}` },
    { area: 'forms', available: n(forms.c) > 0, detail: `form_interactions=${n(forms.c)}` },
    { area: 'web_vitals', available: n(vitals.c) > 0, detail: `web_vitals=${n(vitals.c)}` },
    { area: 'element_visibility', available: n(elements.c) > 0, detail: `element_visibility_v2=${n(elements.c)} (注: is_above_fold/is_cta/element_clicked は未計装=全0、可視位置 element_y で代替)` },
    { area: 'images', available: n(images.c) > 0, detail: `image_visibility=${n(images.c)}` },
    { area: 'video', available: n(videos.c) > 0, detail: `video_events=${n(videos.c)}` },
    { area: 'frustration_signals', available: n(signalsTbl.c) > 0, detail: `behavior_signals=${n(signalsTbl.c)}` },
    { area: 'search_console', available: n(gsc.c) > 0, detail: `gsc_data rows=${n(gsc.c)} (SEO検索データ)` },
  ]

  const capMap: Record<string, string> = {
    pageviews: 'ページ/セッション/訪問者 (top_pages, metrics, timeseries, scroll_depth, attention, time_to_interaction)',
    conversions: 'CV率・CVファネル (metrics cvr/conversions, funnel, contributors)',
    multipage_journeys: '経路・次/前ページ・入口出口 (path, funnel)',
    clicks_dead_zones: 'デッドゾーン/フラストレーション (dead_zones, frustration)',
    forms: 'フォーム離脱分析 (form_analysis)',
    web_vitals: 'Core Web Vitals (performance)',
    element_visibility: 'CTA露出・ファーストビュー滞在 (cta_funnel, above_fold)',
    images: '画像エンゲージメント (media_engagement)',
    video: '動画エンゲージメント (media_engagement)',
    frustration_signals: 'リバーサル/タブ離脱/ピンチズーム (frustration)',
    search_console: 'SEO検索クエリ分析',
  }
  const capabilities = signals.filter((s) => s.available).map((s) => capMap[s.area] ?? s.area)
  const blocked = signals.filter((s) => !s.available).map((s) => `${capMap[s.area] ?? s.area} — 未計測 (${s.detail})`)
  if (n(ev.conversions) > 0 && n(ev.conv_value_events) === 0) {
    blocked.push('売上"金額"分析 — conversion_value 未投入 (CVの有無は取れるが金額は不可)')
  }

  return {
    signals,
    capabilities,
    blocked,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_exact',
    note: 'このサイトで回答可能/不可能な領域の実測在庫です。blocked の項目は「未計測」と正直に伝え、断定数値を作らないこと。',
  }
}

// ── analytics_time_to_interaction (TTFI) ─────────────────────────────

/**
 * 初回操作までの時間: per-session で pageview の最初の timestamp と
 * 最初の click/dead_click/rage_click の timestamp 差 (秒)。1ページ流入でも有効な興味の proxy。
 * timestamp は秒精度のため granularity は粗い (note 付与)。
 */
export interface TimeToInteractionResult {
  sessions: number
  sessions_with_entry: number
  sessions_with_interaction: number
  interaction_rate: number
  median_sec: number
  p25_sec: number
  p75_sec: number
  page_url: string | null
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeTimeToInteractionQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  pageUrl?: string
}): Promise<TimeToInteractionResult> {
  const urlFilter = params.pageUrl ? 'AND url = {page_url:String}' : ''
  const sql = `
WITH per_session AS (
  SELECT
    session_id,
    minIf(timestamp, event_type = 'pageview') AS t_entry,
    minIf(timestamp, event_type IN ('click', 'dead_click', 'rage_click')) AS t_click
  FROM clickinsight.events
  WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND is_agent = 0
    ${urlFilter}
    AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
    AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
  GROUP BY session_id
)
SELECT
  count() AS sessions,
  countIf(toUInt32(t_entry) > 0) AS sessions_with_entry,
  countIf(toUInt32(t_entry) > 0 AND toUInt32(t_click) > 0 AND t_click >= t_entry) AS sessions_with_interaction,
  round(quantileIf(0.5)(dateDiff('second', t_entry, t_click), toUInt32(t_entry) > 0 AND toUInt32(t_click) > 0 AND t_click >= t_entry), 1) AS median_sec,
  round(quantileIf(0.25)(dateDiff('second', t_entry, t_click), toUInt32(t_entry) > 0 AND toUInt32(t_click) > 0 AND t_click >= t_entry), 1) AS p25_sec,
  round(quantileIf(0.75)(dateDiff('second', t_entry, t_click), toUInt32(t_entry) > 0 AND toUInt32(t_click) > 0 AND t_click >= t_entry), 1) AS p75_sec
FROM per_session
SETTINGS max_execution_time = 30`.trim()

  const client = getClickHouseClient('analytics_reader')
  const rs = await client.query({
    query: sql,
    query_params: {
      tenant_id: params.tenantId,
      site_id: params.siteId,
      start: params.dateRange.start,
      end: params.dateRange.end,
      tz: params.timezone,
      ...(params.pageUrl ? { page_url: params.pageUrl } : {}),
    },
    format: 'JSONEachRow',
  })
  const row = (await rs.json<{
    sessions: number
    sessions_with_entry: number
    sessions_with_interaction: number
    median_sec: number
    p25_sec: number
    p75_sec: number
  }>())[0]

  const withEntry = Number(row?.sessions_with_entry ?? 0)
  const withInteraction = Number(row?.sessions_with_interaction ?? 0)
  return {
    sessions: Number(row?.sessions ?? 0),
    sessions_with_entry: withEntry,
    sessions_with_interaction: withInteraction,
    interaction_rate: withEntry > 0 ? Number((withInteraction / withEntry).toFixed(4)) : 0,
    median_sec: Number(row?.median_sec ?? 0),
    p25_sec: Number(row?.p25_sec ?? 0),
    p75_sec: Number(row?.p75_sec ?? 0),
    page_url: params.pageUrl ?? null,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: '初回 click/dead_click/rage_click までの秒数 (timestamp は秒精度のため近似)。interaction_rate は操作有セッション/pageview有セッション。',
  }
}

// ── analytics_dead_zones ─────────────────────────────────────────────

/**
 * 座標ビン別 dead_click + rage_click 密度。押せない/反応しない箇所の特定。
 * click_x/click_y は本番で ~100% populated 確認済。座標は絶対pxのため viewport 差の caveat あり
 * (device filter で緩和可能)。
 */
export interface DeadZoneRow {
  url: string
  x_start: number
  x_end: number
  y_start: number
  y_end: number
  dead_clicks: number
  rage_clicks: number
  total: number
  sessions: number
}
export interface DeadZonesResult {
  rows: DeadZoneRow[]
  bin_px: number
  page_url: string | null
  device: string | null
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeDeadZonesQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  binPx: number
  limit: number
  pageUrl?: string
  device?: string
}): Promise<DeadZonesResult> {
  const urlFilter = params.pageUrl ? 'AND url = {page_url:String}' : ''
  const deviceFilter = params.device ? 'AND device_type = {device:String}' : ''
  const sql = `
SELECT
  url,
  intDiv(click_x, {bin:UInt32}) * {bin:UInt32} AS x_start,
  intDiv(click_y, {bin:UInt32}) * {bin:UInt32} AS y_start,
  countIf(event_type = 'dead_click') AS dead_clicks,
  countIf(event_type = 'rage_click') AS rage_clicks,
  count() AS total,
  uniqExact(session_id) AS sessions
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND is_agent = 0
  AND event_type IN ('dead_click', 'rage_click')
  AND click_x > 0 AND click_y > 0
  ${urlFilter}
  ${deviceFilter}
  AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
GROUP BY url, x_start, y_start
ORDER BY total DESC
LIMIT {limit:UInt32}
SETTINGS max_execution_time = 30`.trim()

  const client = getClickHouseClient('analytics_reader')
  const rs = await client.query({
    query: sql,
    query_params: {
      tenant_id: params.tenantId,
      site_id: params.siteId,
      start: params.dateRange.start,
      end: params.dateRange.end,
      tz: params.timezone,
      bin: String(params.binPx),
      limit: String(params.limit),
      ...(params.pageUrl ? { page_url: params.pageUrl } : {}),
      ...(params.device ? { device: params.device } : {}),
    },
    format: 'JSONEachRow',
  })
  const raw = await rs.json<{
    url: string
    x_start: number
    y_start: number
    dead_clicks: number
    rage_clicks: number
    total: number
    sessions: number
  }>()
  const rows: DeadZoneRow[] = raw.map((r) => ({
    url: r.url,
    x_start: Number(r.x_start),
    x_end: Number(r.x_start) + params.binPx,
    y_start: Number(r.y_start),
    y_end: Number(r.y_start) + params.binPx,
    dead_clicks: Number(r.dead_clicks),
    rage_clicks: Number(r.rage_clicks),
    total: Number(r.total),
    sessions: Number(r.sessions),
  }))

  return {
    rows,
    bin_px: params.binPx,
    page_url: params.pageUrl ?? null,
    device: params.device ?? null,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: '座標は絶対px (viewport 幅でズレうるため device 指定で精度向上)。x_start..x_end / y_start..y_end が密集ビン。',
  }
}

// ── analytics_retention ──────────────────────────────────────────────

/**
 * 再訪率・訪問回数分布。visitor_id (pageview) 単位で active_days / sessions を集計。
 * visitor_id 安定性に依存する caveat あり。
 */
export interface RetentionResult {
  visitors: number
  returning_visitors: number
  returning_rate: number
  multi_session_visitors: number
  avg_sessions_per_visitor: number
  visitors_1: number
  visitors_2: number
  visitors_3: number
  visitors_4plus: number
  median_span_days: number
  page_url: string | null
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeRetentionQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  pageUrl?: string
}): Promise<RetentionResult> {
  const urlFilter = params.pageUrl ? 'AND url = {page_url:String}' : ''
  const sql = `
WITH per_visitor AS (
  SELECT
    visitor_id,
    uniqExact(session_id) AS sessions,
    uniqExact(toDate(timestamp)) AS active_days,
    min(timestamp) AS first_seen,
    max(timestamp) AS last_seen
  FROM clickinsight.events
  WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND is_agent = 0
    AND event_type = 'pageview'
    ${urlFilter}
    AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
    AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
  GROUP BY visitor_id
)
SELECT
  count() AS visitors,
  countIf(active_days > 1) AS returning_visitors,
  countIf(sessions > 1) AS multi_session_visitors,
  round(avg(sessions), 2) AS avg_sessions_per_visitor,
  countIf(sessions = 1) AS visitors_1,
  countIf(sessions = 2) AS visitors_2,
  countIf(sessions = 3) AS visitors_3,
  countIf(sessions >= 4) AS visitors_4plus,
  round(quantile(0.5)(dateDiff('day', first_seen, last_seen)), 1) AS median_span_days
FROM per_visitor
SETTINGS max_execution_time = 30`.trim()

  const client = getClickHouseClient('analytics_reader')
  const rs = await client.query({
    query: sql,
    query_params: {
      tenant_id: params.tenantId,
      site_id: params.siteId,
      start: params.dateRange.start,
      end: params.dateRange.end,
      tz: params.timezone,
      ...(params.pageUrl ? { page_url: params.pageUrl } : {}),
    },
    format: 'JSONEachRow',
  })
  const row = (await rs.json<Record<string, number>>())[0] ?? {}
  const visitors = Number(row.visitors ?? 0)
  const returning = Number(row.returning_visitors ?? 0)
  return {
    visitors,
    returning_visitors: returning,
    returning_rate: visitors > 0 ? Number((returning / visitors).toFixed(4)) : 0,
    multi_session_visitors: Number(row.multi_session_visitors ?? 0),
    avg_sessions_per_visitor: Number(row.avg_sessions_per_visitor ?? 0),
    visitors_1: Number(row.visitors_1 ?? 0),
    visitors_2: Number(row.visitors_2 ?? 0),
    visitors_3: Number(row.visitors_3 ?? 0),
    visitors_4plus: Number(row.visitors_4plus ?? 0),
    median_span_days: Number(row.median_span_days ?? 0),
    page_url: params.pageUrl ?? null,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: 're-visit は visitor_id の active_days>1 で判定。visitor_id 安定性 (cookie 等) に依存。',
  }
}

// ── analytics_media_engagement ───────────────────────────────────────

/**
 * 動画 (video_events) + 画像 (image_visibility) のエンゲージメント。各テーブルに is_agent 列なし。
 * 日付は created_at。video event_type: video_play/video_pause/video_milestone/video_complete/video_summary。
 */
export interface MediaTopVideo {
  video_src: string
  events: number
  sessions: number
}
export interface MediaTopImage {
  image_src: string
  views: number
  avg_visible_sec: number
  avg_max_visible_ratio: number
}
export interface MediaEngagementResult {
  video: {
    sessions_with_video: number
    plays: number
    milestone_events: number
    pauses: number
    completes: number
    completion_rate: number
    top: MediaTopVideo[]
  }
  images: {
    image_views: number
    sessions_with_image: number
    avg_max_visible_ratio: number
    avg_visible_sec: number
    top: MediaTopImage[]
  }
  page_url: string | null
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeMediaEngagementQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  limit: number
  pageUrl?: string
}): Promise<MediaEngagementResult> {
  const client = getClickHouseClient('analytics_reader')
  const qp = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
    limit: String(params.limit),
    ...(params.pageUrl ? { page_url: params.pageUrl } : {}),
  }
  const urlV = params.pageUrl ? 'AND page_url = {page_url:String}' : ''
  const cRange = `created_at >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND created_at < toDateTime(toDateTime({end:String}, {tz:String}))`

  // 検証済 (2026-06-06): video_events の video_milestone/video_played_ms/video_completed 列は
  //   ほぼ未投入のため、エンゲージは event_type 件数 (play/milestone/pause/complete) で測る。
  const videoSql = `
SELECT
  uniqExact(session_id) AS sessions_with_video,
  countIf(event_type = 'video_play') AS plays,
  countIf(event_type = 'video_milestone') AS milestone_events,
  countIf(event_type = 'video_pause') AS pauses,
  countIf(event_type = 'video_complete') AS completes
FROM clickinsight.video_events
WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} ${urlV} AND ${cRange}
SETTINGS max_execution_time = 30`.trim()
  const videoTopSql = `
SELECT video_src, count() AS events, uniqExact(session_id) AS sessions
FROM clickinsight.video_events
WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} ${urlV} AND ${cRange}
GROUP BY video_src ORDER BY sessions DESC LIMIT {limit:UInt32}
SETTINGS max_execution_time = 30`.trim()
  const imageSql = `
SELECT
  count() AS image_views,
  uniqExact(session_id) AS sessions_with_image,
  round(avg(max_visible_ratio), 2) AS avg_max_visible_ratio,
  round(avg(visible_duration_ms) / 1000, 1) AS avg_visible_sec
FROM clickinsight.image_visibility
WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} ${urlV} AND ${cRange}
SETTINGS max_execution_time = 30`.trim()
  const imageTopSql = `
SELECT image_src, count() AS views,
  round(avg(visible_duration_ms) / 1000, 1) AS avg_visible_sec,
  round(avg(max_visible_ratio), 2) AS avg_max_visible_ratio
FROM clickinsight.image_visibility
WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} ${urlV} AND ${cRange}
GROUP BY image_src ORDER BY views DESC LIMIT {limit:UInt32}
SETTINGS max_execution_time = 30`.trim()

  const j = async <T>(sql: string): Promise<T[]> => {
    const rs = await client.query({ query: sql, query_params: qp, format: 'JSONEachRow' })
    return rs.json<T>()
  }
  const [videoAgg, videoTop, imageAgg, imageTop] = await Promise.all([
    j<Record<string, number>>(videoSql),
    j<MediaTopVideo>(videoTopSql),
    j<Record<string, number>>(imageSql),
    j<MediaTopImage>(imageTopSql),
  ])
  const v = videoAgg[0] ?? {}
  const im = imageAgg[0] ?? {}
  const vPlays = Number(v.plays ?? 0)
  const vCompletes = Number(v.completes ?? 0)

  return {
    video: {
      sessions_with_video: Number(v.sessions_with_video ?? 0),
      plays: vPlays,
      milestone_events: Number(v.milestone_events ?? 0),
      pauses: Number(v.pauses ?? 0),
      completes: vCompletes,
      completion_rate: vPlays > 0 ? Number((vCompletes / vPlays).toFixed(4)) : 0,
      top: videoTop.map((r) => ({
        video_src: r.video_src,
        events: Number(r.events),
        sessions: Number(r.sessions),
      })),
    },
    images: {
      image_views: Number(im.image_views ?? 0),
      sessions_with_image: Number(im.sessions_with_image ?? 0),
      avg_max_visible_ratio: Number(im.avg_max_visible_ratio ?? 0),
      avg_visible_sec: Number(im.avg_visible_sec ?? 0),
      top: imageTop.map((r) => ({
        image_src: r.image_src,
        views: Number(r.views),
        avg_visible_sec: Number(r.avg_visible_sec),
        avg_max_visible_ratio: Number(r.avg_max_visible_ratio),
      })),
    },
    page_url: params.pageUrl ?? null,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: '動画は video_events の event_type 件数 (play/milestone/pause/complete)、画像は image_visibility 由来 (bot 除外列なし)。completion_rate=complete/play。',
  }
}

// ── analytics_above_fold ─────────────────────────────────────────────

/**
 * ファーストビュー (画面上部) 要素の露出 vs 滞在。
 * 検証済: is_above_fold/is_cta/element_clicked は未計装(全0)のため、
 *   above-fold は element_y <= viewport_height で代替導出し、エンゲージは visible_duration_ms / max_visible_ratio で測る
 *   (クリックは cta_funnel が担当)。
 */
export interface AboveFoldBucket {
  fold: string
  exposures: number
  sessions: number
  median_visible_sec: number
}
export interface AboveFoldElement {
  element_selector: string
  exposures: number
  sessions: number
  median_visible_sec: number
}
export interface AboveFoldResult {
  folds: AboveFoldBucket[]
  top_above_fold_elements: AboveFoldElement[]
  page_url: string | null
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeAboveFoldQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  limit: number
  pageUrl?: string
}): Promise<AboveFoldResult> {
  const client = getClickHouseClient('analytics_reader')
  const qp = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
    limit: String(params.limit),
    ...(params.pageUrl ? { page_url: params.pageUrl } : {}),
  }
  const urlV = params.pageUrl ? 'AND page_url = {page_url:String}' : ''
  const cRange = `created_at >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND created_at < toDateTime(toDateTime({end:String}, {tz:String}))`

  // 検証済 (2026-06-06): element_visibility_v2.max_visible_ratio は全0 (未投入) のため使わない。
  //   visible_duration_ms は populated だが外れ値で平均が歪むため median を使う。
  const foldSql = `
SELECT
  multiIf(viewport_height > 0 AND element_y <= viewport_height, 'above_fold',
          viewport_height > 0, 'below_fold', 'unknown') AS fold,
  count() AS exposures,
  uniqExact(session_id) AS sessions,
  round(quantile(0.5)(visible_duration_ms) / 1000, 1) AS median_visible_sec
FROM clickinsight.element_visibility_v2
WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} ${urlV} AND ${cRange}
GROUP BY fold ORDER BY exposures DESC
SETTINGS max_execution_time = 30`.trim()
  const topSql = `
SELECT element_selector,
  count() AS exposures,
  uniqExact(session_id) AS sessions,
  round(quantile(0.5)(visible_duration_ms) / 1000, 1) AS median_visible_sec
FROM clickinsight.element_visibility_v2
WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} ${urlV}
  AND viewport_height > 0 AND element_y <= viewport_height AND element_selector != ''
  AND ${cRange}
GROUP BY element_selector ORDER BY exposures DESC LIMIT {limit:UInt32}
SETTINGS max_execution_time = 30`.trim()

  const j = async <T>(sql: string): Promise<T[]> => {
    const rs = await client.query({ query: sql, query_params: qp, format: 'JSONEachRow' })
    return rs.json<T>()
  }
  const [foldRows, topRows] = await Promise.all([j<AboveFoldBucket>(foldSql), j<AboveFoldElement>(topSql)])

  return {
    folds: foldRows.map((r) => ({
      fold: r.fold,
      exposures: Number(r.exposures),
      sessions: Number(r.sessions),
      median_visible_sec: Number(r.median_visible_sec),
    })),
    top_above_fold_elements: topRows.map((r) => ({
      element_selector: r.element_selector,
      exposures: Number(r.exposures),
      sessions: Number(r.sessions),
      median_visible_sec: Number(r.median_visible_sec),
    })),
    page_url: params.pageUrl ?? null,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: 'above-fold は element_y<=viewport_height で導出 (is_above_fold/is_cta/element_clicked/max_visible_ratio は未計装=全0)。median_visible_sec が短く露出が多い要素は「見えてるが素通り」の候補。クリックは analytics_cta_funnel 参照。',
  }
}

// ════════════════════════════════════════════════════════════════════
// Phase 1b 拡張 (2026-06-06): クロス分析 / 多段ジャーニー / セグメント比較(有意差)。
//   metrics の buildMetricExpr / buildDimensionExpr を再利用 (cvr バグ修正済)。
// ════════════════════════════════════════════════════════════════════

// ── analytics_crosstab (指標 × 2 軸ピボット) ─────────────────────────

/** crosstab で使える軸 (metrics の dimension から 'none' を除いたもの)。 */
export const CROSSTAB_DIMENSIONS = METRICS_DIMENSIONS.filter(
  (d): d is Exclude<MetricsDimension, 'none'> => d !== 'none',
)
export type CrosstabDimension = Exclude<MetricsDimension, 'none'>

export interface CrosstabCell {
  dim1_value: string
  dim2_value: string
  value: number
}
export interface CrosstabResult {
  metric: MetricsMetric
  dim1: CrosstabDimension
  dim2: CrosstabDimension
  rows: CrosstabCell[]
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeCrosstabQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  metric: MetricsMetric
  dim1: CrosstabDimension
  dim2: CrosstabDimension
  pageUrl?: string
  deviceType?: string
  limit: number
}): Promise<CrosstabResult> {
  const metricExpr = buildMetricExpr(params.metric)
  const dim1Expr = buildDimensionExpr(params.dim1)
  const dim2Expr = buildDimensionExpr(params.dim2)
  if (!dim1Expr || !dim2Expr) {
    throw new Error('crosstab requires two non-none dimensions')
  }

  const queryParams: Record<string, string> = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
    limit: String(params.limit),
  }
  const filterClauses: string[] = []
  if (params.pageUrl) {
    filterClauses.push('AND url = {filter_page_url:String}')
    queryParams.filter_page_url = params.pageUrl
  }
  if (params.deviceType) {
    filterClauses.push('AND device_type = {filter_device_type:String}')
    queryParams.filter_device_type = params.deviceType
  }

  const sql = `
SELECT
  toString(${dim1Expr}) AS dim1_value,
  toString(${dim2Expr}) AS dim2_value,
  ${metricExpr} AS value
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND is_agent = 0
  AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
  ${filterClauses.join(' ')}
GROUP BY dim1_value, dim2_value
ORDER BY value DESC
LIMIT {limit:UInt32}
SETTINGS max_execution_time = 30`.trim()

  const client = getClickHouseClient('analytics_reader')
  const rs = await client.query({ query: sql, query_params: queryParams, format: 'JSONEachRow' })
  const rows = await rs.json<CrosstabCell>()

  return {
    metric: params.metric,
    dim1: params.dim1,
    dim2: params.dim2,
    rows: rows.map((r) => ({ dim1_value: r.dim1_value, dim2_value: r.dim2_value, value: Number(r.value) })),
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: `${params.metric} を ${params.dim1} × ${params.dim2} の2軸で集計したピボット。各セルは2軸の組合せに対する値。`,
  }
}

// ── analytics_journeys (多段ジャーニー全経路) ────────────────────────

/**
 * セッション単位の pageview を時系列順に連結した「経路文字列」を集計し、頻出経路 top N を返す。
 * sequence_id / previous_url が空でも timestamp 順で再構築。連続重複 URL は折りたたむ。
 */
export interface JourneyRow {
  path: string
  sessions: number
  steps: number
}
export interface JourneysResult {
  rows: JourneyRow[]
  min_steps: number
  start_url: string | null
  contains_url: string | null
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeJourneysQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  minSteps: number
  limit: number
  startUrl?: string
  containsUrl?: string
}): Promise<JourneysResult> {
  const queryParams: Record<string, string> = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
    min_steps: String(params.minSteps),
    limit: String(params.limit),
  }
  const outerFilters: string[] = ['steps >= {min_steps:UInt32}']
  if (params.startUrl) {
    outerFilters.push('dedup[1] = {start_url:String}')
    queryParams.start_url = params.startUrl
  }
  if (params.containsUrl) {
    outerFilters.push('has(dedup, {contains_url:String})')
    queryParams.contains_url = params.containsUrl
  }

  // 1) per-session: (timestamp,url) を集めて時系列ソート → url 配列
  // 2) 連続重複を折りたたむ (A>A>B → A>B)
  // 3) 経路文字列で GROUP BY、頻出順 top N
  const sql = `
SELECT
  path,
  count() AS sessions,
  any(steps) AS steps
FROM (
  SELECT
    arrayFilter((x, i) -> i = 1 OR x != arr[i - 1], arr, arrayEnumerate(arr)) AS dedup,
    arrayStringConcat(dedup, ' > ') AS path,
    length(dedup) AS steps
  FROM (
    SELECT
      session_id,
      arrayMap(t -> t.2, arraySort(t -> t.1, groupArray((timestamp, url)))) AS arr
    FROM clickinsight.events
    WHERE tenant_id = {tenant_id:String}
      AND site_id = {site_id:String}
      AND is_agent = 0
      AND event_type = 'pageview'
      AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
      AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
    GROUP BY session_id
  )
  WHERE ${outerFilters.join(' AND ')}
)
GROUP BY path
ORDER BY sessions DESC
LIMIT {limit:UInt32}
SETTINGS max_execution_time = 30`.trim()

  const client = getClickHouseClient('analytics_reader')
  const rs = await client.query({ query: sql, query_params: queryParams, format: 'JSONEachRow' })
  const rows = await rs.json<{ path: string; sessions: number; steps: number }>()

  return {
    rows: rows.map((r) => ({ path: r.path, sessions: Number(r.sessions), steps: Number(r.steps) })),
    min_steps: params.minSteps,
    start_url: params.startUrl ?? null,
    contains_url: params.containsUrl ?? null,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: 'pageview を timestamp 順に連結した経路。連続重複は折りたたみ済。steps=経路のページ数。previous_url/sequence_id 非依存。',
  }
}

// ── analytics_segment_compare (2 セグメント比率の有意差検定) ──────────

/** 2 比率検定の対象にできる rate metric (session 単位の成功/試行が明確なもの)。 */
export const SEGMENT_COMPARE_METRICS = ['cvr', 'bounce_rate'] as const
export type SegmentCompareMetric = (typeof SEGMENT_COMPARE_METRICS)[number]

export interface SegmentStat {
  value: string
  n: number
  k: number
  rate: number
}
export interface SegmentCompareResult {
  metric: SegmentCompareMetric
  dimension: CrosstabDimension
  segmentA: SegmentStat
  segmentB: SegmentStat
  difference: number
  z: number | null
  pValue: number | null
  significant: boolean
  ciLow: number | null
  ciHigh: number | null
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

/** Abramowitz-Stegun 7.1.26 erf 近似 → 標準正規 CDF。 */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x)
  return 0.5 * (1 + sign * y)
}

function segmentSuccessCond(metric: SegmentCompareMetric): string {
  if (metric === 'cvr') return "conversion_type IS NOT NULL AND conversion_type != ''"
  // bounce_rate
  return "event_type = 'session_end' AND page_views_in_session <= 1 AND session_duration_sec < 10"
}

export async function executeSegmentCompareQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  metric: SegmentCompareMetric
  dimension: CrosstabDimension
  valueA: string
  valueB: string
}): Promise<SegmentCompareResult> {
  const dimExpr = buildDimensionExpr(params.dimension)
  if (!dimExpr) throw new Error('segment_compare requires a non-none dimension')
  const cond = segmentSuccessCond(params.metric)

  const sql = `
SELECT
  toString(${dimExpr}) AS seg,
  uniqExact(session_id) AS n,
  uniqExactIf(session_id, ${cond}) AS k
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND is_agent = 0
  AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
GROUP BY seg
SETTINGS max_execution_time = 30`.trim()

  const client = getClickHouseClient('analytics_reader')
  const rs = await client.query({
    query: sql,
    query_params: {
      tenant_id: params.tenantId,
      site_id: params.siteId,
      start: params.dateRange.start,
      end: params.dateRange.end,
      tz: params.timezone,
    },
    format: 'JSONEachRow',
  })
  const rows = await rs.json<{ seg: string; n: number; k: number }>()
  const find = (val: string): SegmentStat => {
    const r = rows.find((x) => x.seg === val)
    const n = Number(r?.n ?? 0)
    const k = Number(r?.k ?? 0)
    return { value: val, n, k, rate: n > 0 ? Number((k / n).toFixed(6)) : 0 }
  }
  const a = find(params.valueA)
  const b = find(params.valueB)

  let z: number | null = null
  let pValue: number | null = null
  let ciLow: number | null = null
  let ciHigh: number | null = null
  let significant = false
  if (a.n > 0 && b.n > 0) {
    const p1 = a.k / a.n
    const p2 = b.k / b.n
    const pPool = (a.k + b.k) / (a.n + b.n)
    const se = Math.sqrt(pPool * (1 - pPool) * (1 / a.n + 1 / b.n))
    if (se > 0) {
      z = (p1 - p2) / se
      pValue = Number((2 * (1 - normalCdf(Math.abs(z))).valueOf()).toFixed(6))
      significant = pValue < 0.05
    }
    const seDiff = Math.sqrt((p1 * (1 - p1)) / a.n + (p2 * (1 - p2)) / b.n)
    ciLow = Number((p1 - p2 - 1.96 * seDiff).toFixed(6))
    ciHigh = Number((p1 - p2 + 1.96 * seDiff).toFixed(6))
  }

  return {
    metric: params.metric,
    dimension: params.dimension,
    segmentA: a,
    segmentB: b,
    difference: Number((a.rate - b.rate).toFixed(6)),
    z: z !== null ? Number(z.toFixed(4)) : null,
    pValue,
    significant,
    ciLow,
    ciHigh,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: '2 比率の差を two-sided z 検定。significant=p<0.05。counts は observed_exact だが有意性は統計的推定。サンプルが小さいと検定力不足に注意。',
  }
}

// ── analytics_anomaly (異常検知・変化点: 移動平均 + z-score) ──────────

/**
 * 日次メトリクスの異常検知。各日について「直前 window 日」の移動平均・標準偏差を取り、
 * z=(value-mean)/std が閾値を超えた日を spike/drop として検出する。
 * Deep Research / ML 不要の単発統計ツール (既存 events を日次集計するだけ)。
 */
export interface AnomalyPoint {
  bucket: string
  value: number
  rolling_mean: number | null
  z: number | null
  is_anomaly: boolean
  direction: 'spike' | 'drop' | 'normal'
}
export interface AnomalyResult {
  metric: MetricsMetric
  window: number
  zThreshold: number
  series: AnomalyPoint[]
  anomalies: AnomalyPoint[]
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeAnomalyQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  metric: MetricsMetric
  window: number
  zThreshold: number
}): Promise<AnomalyResult> {
  const metricExpr = buildMetricExpr(params.metric)
  const sql = `
SELECT
  toString(toStartOfDay(timestamp, {tz:String})) AS bucket,
  ${metricExpr} AS value
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND is_agent = 0
  AND timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
  AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))
GROUP BY bucket
ORDER BY bucket
SETTINGS max_execution_time = 30`.trim()

  const client = getClickHouseClient('analytics_reader')
  const rs = await client.query({
    query: sql,
    query_params: {
      tenant_id: params.tenantId,
      site_id: params.siteId,
      start: params.dateRange.start,
      end: params.dateRange.end,
      tz: params.timezone,
    },
    format: 'JSONEachRow',
  })
  const raw = await rs.json<{ bucket: string; value: number }>()
  const values = raw.map((r) => ({ bucket: r.bucket, value: Number(r.value) }))

  const MIN_PRIOR = 3
  const series: AnomalyPoint[] = values.map((p, i) => {
    const start = Math.max(0, i - params.window)
    const prior = values.slice(start, i).map((x) => x.value)
    if (prior.length < MIN_PRIOR) {
      return { bucket: p.bucket, value: p.value, rolling_mean: null, z: null, is_anomaly: false, direction: 'normal' }
    }
    const mean = prior.reduce((a, b) => a + b, 0) / prior.length
    const variance = prior.reduce((a, b) => a + (b - mean) ** 2, 0) / prior.length
    const std = Math.sqrt(variance)
    if (std <= 0) {
      // 直前が全て同値: 値が変われば変化点
      const changed = p.value !== mean
      return {
        bucket: p.bucket,
        value: p.value,
        rolling_mean: Number(mean.toFixed(4)),
        z: changed ? null : 0,
        is_anomaly: changed,
        direction: changed ? (p.value > mean ? 'spike' : 'drop') : 'normal',
      }
    }
    const z = (p.value - mean) / std
    const isAnomaly = Math.abs(z) >= params.zThreshold
    return {
      bucket: p.bucket,
      value: p.value,
      rolling_mean: Number(mean.toFixed(4)),
      z: Number(z.toFixed(3)),
      is_anomaly: isAnomaly,
      direction: isAnomaly ? (z > 0 ? 'spike' : 'drop') : 'normal',
    }
  })

  return {
    metric: params.metric,
    window: params.window,
    zThreshold: params.zThreshold,
    series,
    anomalies: series.filter((p) => p.is_anomaly),
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: '日次値に対し直前 window 日の移動平均・標準偏差で z-score を計算。|z|>=zThreshold を異常(spike/drop)として検出。値は observed_exact だが異常判定は統計的推定。最初の数日は履歴不足で判定なし。',
  }
}

// ════════════════════════════════════════════════════════════════════
// Phase 1d 拡張 (2026-06-06): 行動コホート / 要素タイプ別比較。
//   「特定の行動をした人に絞った指標」「img vs table 等の要素種別比較」= 深堀りの核。
// ════════════════════════════════════════════════════════════════════

// ── analytics_action_cohort (行動コホート: 〜した人 vs しなかった人) ──

/**
 * 指定アクション (event_type + 任意 href/selector/url) を行ったセッション群 (cohort) と、
 * それ以外 (rest) で、セッション指標 (滞在秒・PV数・最大スクロール) を比較する。
 * 例: 「Amazonアフィリエイトをクリックした人の滞在時間」= eventType='click', hrefContains='amzn'。
 *
 * session_duration_sec / page_views_in_session は session_end 行にのみ入るため、
 * 滞在系は dur>0 (=session_end 受信) のセッションに限定して集計し、coverage も返す。
 */
export interface ActionCohortSegment {
  segment: 'cohort' | 'rest'
  sessions: number
  sessions_with_duration: number
  avg_dur_sec: number
  median_dur_sec: number
  p25_dur_sec: number
  p75_dur_sec: number
  avg_pageviews: number
  avg_max_scroll_pct: number
}
export interface ActionCohortResult {
  action: { event_type: string; href_contains: string | null; selector_contains: string | null; url: string | null }
  segments: ActionCohortSegment[]
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeActionCohortQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  eventType: string
  hrefContains?: string
  selectorContains?: string
  actionUrl?: string
}): Promise<ActionCohortResult> {
  const qp: Record<string, string> = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
    event_type: params.eventType,
  }
  const cohortFilters: string[] = ['event_type = {event_type:String}']
  if (params.hrefContains) {
    cohortFilters.push('element_href ILIKE {href_pat:String}')
    qp.href_pat = `%${params.hrefContains}%`
  }
  if (params.selectorContains) {
    cohortFilters.push('element_selector ILIKE {sel_pat:String}')
    qp.sel_pat = `%${params.selectorContains}%`
  }
  if (params.actionUrl) {
    cohortFilters.push('url = {action_url:String}')
    qp.action_url = params.actionUrl
  }
  const range = `timestamp >= toDateTime(toDateTime({start:String}, {tz:String}))
    AND timestamp < toDateTime(toDateTime({end:String}, {tz:String}))`

  const sql = `
WITH cohort AS (
  SELECT DISTINCT session_id
  FROM clickinsight.events
  WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND is_agent = 0
    AND ${cohortFilters.join(' AND ')}
    AND ${range}
),
ss AS (
  SELECT
    session_id,
    max(session_duration_sec) AS dur,
    max(page_views_in_session) AS pvs,
    max(scroll_percentage) AS max_scroll
  FROM clickinsight.events
  WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND is_agent = 0
    AND ${range}
  GROUP BY session_id
)
SELECT
  if(session_id IN (SELECT session_id FROM cohort), 'cohort', 'rest') AS segment,
  count() AS sessions,
  countIf(dur > 0) AS sessions_with_duration,
  round(avgIf(dur, dur > 0), 1) AS avg_dur_sec,
  round(quantileIf(0.5)(dur, dur > 0), 1) AS median_dur_sec,
  round(quantileIf(0.25)(dur, dur > 0), 1) AS p25_dur_sec,
  round(quantileIf(0.75)(dur, dur > 0), 1) AS p75_dur_sec,
  round(avg(pvs), 2) AS avg_pageviews,
  round(avg(max_scroll), 1) AS avg_max_scroll_pct
FROM ss
GROUP BY segment
ORDER BY segment
SETTINGS max_execution_time = 30`.trim()

  const client = getClickHouseClient('analytics_reader')
  const rs = await client.query({ query: sql, query_params: qp, format: 'JSONEachRow' })
  const raw = await rs.json<Record<string, number | string>>()
  const segments: ActionCohortSegment[] = raw.map((r) => ({
    segment: String(r.segment) === 'cohort' ? 'cohort' : 'rest',
    sessions: Number(r.sessions),
    sessions_with_duration: Number(r.sessions_with_duration),
    avg_dur_sec: Number(r.avg_dur_sec),
    median_dur_sec: Number(r.median_dur_sec),
    p25_dur_sec: Number(r.p25_dur_sec),
    p75_dur_sec: Number(r.p75_dur_sec),
    avg_pageviews: Number(r.avg_pageviews),
    avg_max_scroll_pct: Number(r.avg_max_scroll_pct),
  }))

  return {
    action: {
      event_type: params.eventType,
      href_contains: params.hrefContains ?? null,
      selector_contains: params.selectorContains ?? null,
      url: params.actionUrl ?? null,
    },
    segments,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: '滞在秒/PV数は session_end 受信セッションにのみ記録されるため、滞在系は dur>0 (sessions_with_duration) に限定集計。cohort=アクション実行セッション、rest=それ以外。',
  }
}

// ── analytics_element_breakdown (要素タイプ/セレクタ別の閲覧比較) ─────

/**
 * element_visibility_v2 を element_tag または element_selector で集計し、露出/セッション/中央値滞在を返す。
 * groupBy='element_tag' のときは image_visibility を 'img' 行として合成 (画像は別テーブルのため)。
 * 例: 「画像と表どちらがよく見られているか」= groupBy='element_tag' → 'img' と 'table' を比較。
 */
export interface ElementBreakdownRow {
  key: string
  exposures: number
  sessions: number
  median_visible_sec: number
  source: 'element_visibility_v2' | 'image_visibility'
}
export interface ElementBreakdownResult {
  group_by: 'element_tag' | 'element_selector'
  rows: ElementBreakdownRow[]
  page_url: string | null
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeElementBreakdownQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  groupBy: 'element_tag' | 'element_selector'
  limit: number
  pageUrl?: string
  includeImages: boolean
}): Promise<ElementBreakdownResult> {
  const client = getClickHouseClient('analytics_reader')
  const qp: Record<string, string> = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
    limit: String(params.limit),
  }
  const urlV = params.pageUrl ? 'AND page_url = {page_url:String}' : ''
  if (params.pageUrl) qp.page_url = params.pageUrl
  const cRange = `created_at >= toDateTime(toDateTime({start:String}, {tz:String}))
    AND created_at < toDateTime(toDateTime({end:String}, {tz:String}))`
  const groupExpr = params.groupBy === 'element_selector' ? 'element_selector' : 'element_tag'

  const elemSql = `
SELECT
  ${groupExpr} AS key,
  count() AS exposures,
  uniqExact(session_id) AS sessions,
  round(quantile(0.5)(visible_duration_ms) / 1000, 1) AS median_visible_sec
FROM clickinsight.element_visibility_v2
WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} ${urlV}
  AND ${groupExpr} != ''
  AND ${cRange}
GROUP BY key
ORDER BY exposures DESC
LIMIT {limit:UInt32}
SETTINGS max_execution_time = 30`.trim()

  const elemRs = await client.query({ query: elemSql, query_params: qp, format: 'JSONEachRow' })
  const elemRows = await elemRs.json<{ key: string; exposures: number; sessions: number; median_visible_sec: number }>()

  const rows: ElementBreakdownRow[] = elemRows.map((r) => ({
    key: r.key,
    exposures: Number(r.exposures),
    sessions: Number(r.sessions),
    median_visible_sec: Number(r.median_visible_sec),
    source: 'element_visibility_v2',
  }))

  // groupBy=element_tag のときは画像を image_visibility から 'img' 行として合成
  if (params.groupBy === 'element_tag' && params.includeImages) {
    const imgSql = `
SELECT
  count() AS exposures,
  uniqExact(session_id) AS sessions,
  round(quantile(0.5)(visible_duration_ms) / 1000, 1) AS median_visible_sec
FROM clickinsight.image_visibility
WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} ${urlV}
  AND ${cRange}
SETTINGS max_execution_time = 30`.trim()
    const imgRs = await client.query({ query: imgSql, query_params: qp, format: 'JSONEachRow' })
    const img = (await imgRs.json<{ exposures: number; sessions: number; median_visible_sec: number }>())[0]
    if (img && Number(img.exposures) > 0) {
      rows.push({
        key: 'img',
        exposures: Number(img.exposures),
        sessions: Number(img.sessions),
        median_visible_sec: Number(img.median_visible_sec),
        source: 'image_visibility',
      })
    }
    rows.sort((a, b) => b.exposures - a.exposures)
  }

  return {
    group_by: params.groupBy,
    rows,
    page_url: params.pageUrl ?? null,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: '要素の露出回数・到達セッション・可視滞在の中央値。img は image_visibility テーブル由来 (element_visibility_v2 に img タグは無いため合成)。max_visible_ratio は未計装のため割合は出さない。',
  }
}

// ════════════════════════════════════════════════════════════════════
// UGOKI Crawl × UGOKI MAP 融合 v1 (2026-06-06):
//   クロール由来テーブル(page_issues/page_content_sections/section_behavior_summary/crawl_runs)を
//   行動と突合して「行動で裏取りした直す順」と「区間摩擦の説明」を返す。
//   ※ これらのテーブルは Infra が DDL 適用 + ETL 投入後に有効。未投入時は available:false で graceful。
// ════════════════════════════════════════════════════════════════════

/** クロール融合テーブル未投入 (UNKNOWN_TABLE 等) を graceful に扱う。 */
function isCrawlDataUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNKNOWN_TABLE|doesn't exist|does not exist|Table .* doesn't/i.test(msg)
}

// ── rank_behavior_validated_fixes ────────────────────────────────────

export interface BehaviorValidatedFix {
  page_url: string
  issue_category: string
  issue_type: string
  severity: string
  section_heading: string
  reached_sessions: number
  rage_clicks: number
  dead_clicks: number
  exits: number
  friction_score: number
  match_confidence: number
  behavioral_cost: number
  recommendation: string
}
export interface RankBehaviorValidatedFixesResult {
  available: boolean
  rows: BehaviorValidatedFix[]
  crawl_id: string | null
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeRankBehaviorValidatedFixesQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  pageUrl?: string
  minConfidence: number
  limit: number
}): Promise<RankBehaviorValidatedFixesResult> {
  const client = getClickHouseClient('analytics_reader')
  const qp: Record<string, string> = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
    min_conf: String(params.minConfidence),
    limit: String(params.limit),
  }
  const urlFilter = params.pageUrl ? 'AND i.page_url = {page_url:String}' : ''
  if (params.pageUrl) qp.page_url = params.pageUrl

  // 最新 completed crawl の issues を、ページ単位の行動集計(page_url)と突合し、
  // behavioral_cost = severity重み × (1+friction) × log(1+到達) でランク。
  // クローラ issues はページ単位(section_selector_hash 無し)なので section ではなく page_url で結合する。
  const sql = `
SELECT
  i.page_url AS page_url,
  i.issue_category AS issue_category,
  i.issue_type AS issue_type,
  i.severity AS severity,
  s.section_heading AS section_heading,
  toUInt32(ifNull(b.reached_sessions, 0)) AS reached_sessions,
  toUInt32(ifNull(b.rage_clicks, 0)) AS rage_clicks,
  toUInt32(ifNull(b.dead_clicks, 0)) AS dead_clicks,
  toUInt32(ifNull(b.exits, 0)) AS exits,
  round(ifNull(b.friction_score, 0), 3) AS friction_score,
  round(ifNull(b.match_confidence, 0), 2) AS match_confidence,
  round(multiIf(i.severity = 'critical', 4, i.severity = 'high', 3, i.severity = 'medium', 2, 1)
    * (1 + ifNull(b.friction_score, 0))
    * log(1 + ifNull(b.reached_sessions, 0)), 3) AS behavioral_cost,
  i.recommendation AS recommendation
FROM clickinsight.page_issues i
LEFT JOIN clickinsight.page_content_sections s
  ON s.tenant_id = i.tenant_id AND s.site_id = i.site_id AND s.page_url = i.page_url
  AND s.crawl_id = i.crawl_id AND s.section_selector_hash = i.section_selector_hash
LEFT JOIN (
  SELECT page_url,
    sum(reached_sessions) AS reached_sessions, sum(rage_clicks) AS rage_clicks,
    sum(dead_clicks) AS dead_clicks, sum(exits) AS exits,
    avg(friction_score) AS friction_score, avg(match_confidence) AS match_confidence
  FROM clickinsight.section_behavior_summary FINAL
  WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String}
    AND window_start >= toDate(toDateTime({start:String}, {tz:String}))
    AND window_start <= toDate(toDateTime({end:String}, {tz:String}))
  GROUP BY page_url
) b ON b.page_url = i.page_url
WHERE i.tenant_id = {tenant_id:String} AND i.site_id = {site_id:String}
  AND i.crawl_id IN (
    SELECT argMax(crawl_id, crawled_at) FROM clickinsight.crawl_runs
    WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND status = 'completed'
  )
  AND ifNull(b.match_confidence, 0) >= toFloat64({min_conf:String})
  ${urlFilter}
ORDER BY behavioral_cost DESC
LIMIT {limit:UInt32}
SETTINGS max_execution_time = 30`.trim()

  try {
    const rs = await client.query({ query: sql, query_params: qp, format: 'JSONEachRow' })
    const rows = await rs.json<BehaviorValidatedFix>()
    return {
      available: true,
      rows: rows.map((r) => ({ ...r, behavioral_cost: Number(r.behavioral_cost) })),
      crawl_id: rows.length > 0 ? null : null,
      periodStart: params.dateRange.start,
      periodEnd: params.dateRange.end,
      timezone: params.timezone,
      evidenceLevel: 'observed_approx',
      note: 'クロール由来の問題(SEO/a11y/perf/content)を、同ページの実ユーザー行動(到達/rage/dead/離脱/摩擦)で裏取りし behavioral_cost 順に提示。match_confidence>=閾値のページのみ。相関であり因果ではない。',
    }
  } catch (err: unknown) {
    if (isCrawlDataUnavailable(err)) {
      return {
        available: false,
        rows: [],
        crawl_id: null,
        periodStart: params.dateRange.start,
        periodEnd: params.dateRange.end,
        timezone: params.timezone,
        evidenceLevel: 'planned',
        note: 'このサイトはまだクロール(UGOKI Crawl)が取り込まれていません。クロール定期化+ETL投入後に「行動で裏取りした直す順」を返せます。',
      }
    }
    throw err
  }
}

// ── explain_section_friction ─────────────────────────────────────────

export interface SectionFrictionExplanation {
  available: boolean
  page_url: string
  section_selector_hash: string | null
  section_heading: string
  has_cta: number
  has_price: number
  visible_text_snippet: string
  behavior: {
    reached_sessions: number
    clicks: number
    dead_clicks: number
    rage_clicks: number
    avg_dwell_ms: number
    exits: number
    conversions: number
    friction_score: number
    match_confidence: number
  } | null
  issues: Array<{ issue_category: string; issue_type: string; severity: string; recommendation: string }>
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: EvidenceLevelV2
  note: string
}

export async function executeExplainSectionFrictionQuery(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
  pageUrl: string
  sectionSelectorHash: string
}): Promise<SectionFrictionExplanation> {
  const client = getClickHouseClient('analytics_reader')
  const qp = {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    start: params.dateRange.start,
    end: params.dateRange.end,
    tz: params.timezone,
    page_url: params.pageUrl,
    sh: params.sectionSelectorHash,
  }
  const base: Omit<SectionFrictionExplanation, 'available' | 'section_heading' | 'has_cta' | 'has_price' | 'visible_text_snippet' | 'behavior' | 'issues'> = {
    page_url: params.pageUrl,
    section_selector_hash: params.sectionSelectorHash,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    evidenceLevel: 'observed_approx',
    note: '1区間の 内容(クロール) × 行動(集計) × 問題(issues) を統合。',
  }
  try {
    const j = async <T>(sql: string): Promise<T[]> => {
      const rs = await client.query({ query: sql, query_params: qp, format: 'JSONEachRow' })
      return rs.json<T>()
    }
    const content = (await j<{ section_heading: string; has_cta: number; has_price: number; snip: string }>(`
SELECT any(section_heading) AS section_heading, max(has_cta) AS has_cta, max(has_price) AS has_price,
  substring(any(visible_text), 1, 300) AS snip
FROM clickinsight.page_content_sections
WHERE tenant_id={tenant_id:String} AND site_id={site_id:String} AND page_url={page_url:String}
  AND section_selector_hash={sh:String}
SETTINGS max_execution_time=30`.trim()))[0]

    const beh = (await j<Record<string, number>>(`
SELECT sum(reached_sessions) reached_sessions, sum(clicks) clicks, sum(dead_clicks) dead_clicks,
  sum(rage_clicks) rage_clicks, round(avg(avg_dwell_ms),0) avg_dwell_ms, sum(exits) exits,
  sum(conversions) conversions, round(avg(friction_score),3) friction_score, round(avg(match_confidence),2) match_confidence
FROM clickinsight.section_behavior_summary FINAL
WHERE tenant_id={tenant_id:String} AND site_id={site_id:String} AND page_url={page_url:String}
  AND section_selector_hash={sh:String}
  AND window_start >= toDate(toDateTime({start:String},{tz:String}))
  AND window_start < toDate(toDateTime({end:String},{tz:String}))
SETTINGS max_execution_time=30`.trim()))[0]

    const issues = await j<{ issue_category: string; issue_type: string; severity: string; recommendation: string }>(`
SELECT issue_category, issue_type, severity, any(recommendation) AS recommendation
FROM clickinsight.page_issues
WHERE tenant_id={tenant_id:String} AND site_id={site_id:String} AND page_url={page_url:String}
  AND section_selector_hash={sh:String}
GROUP BY issue_category, issue_type, severity
ORDER BY severity LIMIT 20
SETTINGS max_execution_time=30`.trim())

    return {
      available: true,
      ...base,
      section_heading: content?.section_heading ?? '',
      has_cta: Number(content?.has_cta ?? 0),
      has_price: Number(content?.has_price ?? 0),
      visible_text_snippet: content?.snip ?? '',
      behavior: beh
        ? {
            reached_sessions: Number(beh.reached_sessions ?? 0),
            clicks: Number(beh.clicks ?? 0),
            dead_clicks: Number(beh.dead_clicks ?? 0),
            rage_clicks: Number(beh.rage_clicks ?? 0),
            avg_dwell_ms: Number(beh.avg_dwell_ms ?? 0),
            exits: Number(beh.exits ?? 0),
            conversions: Number(beh.conversions ?? 0),
            friction_score: Number(beh.friction_score ?? 0),
            match_confidence: Number(beh.match_confidence ?? 0),
          }
        : null,
      issues,
    }
  } catch (err: unknown) {
    if (isCrawlDataUnavailable(err)) {
      return {
        available: false,
        ...base,
        section_heading: '',
        has_cta: 0,
        has_price: 0,
        visible_text_snippet: '',
        behavior: null,
        issues: [],
        evidenceLevel: 'planned',
        note: 'このサイトはまだクロールが取り込まれていません (区間説明はクロール投入後)。',
      }
    }
    throw err
  }
}
