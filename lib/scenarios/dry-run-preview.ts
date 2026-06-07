/**
 * lib/scenarios/dry-run-preview.ts — Scenario 条件 AST の過去 events 再生 (M-Director Phase 2、2026-06-07)
 *
 * 「この条件で過去 N 日にどれだけ session がマッチしたか」を見せる server-side preview。
 * ClickHouse `events` テーブルを session 単位に集約 → EvaluationContext に詰めて
 * `lib/scenarios/evaluator.ts:evaluate()` で再評価する。
 *
 * §3.8.1: tenant_id / site_id は呼出側で JWT 検証済前提 (resolveScenarioTenantContext)。
 * 本 module は AST と (tenant_id, site_id, days) を受け取り SELECT のみ実行する。
 *
 * 制限 (events 未収録 field):
 *   - scroll_depth_max_pct: events は scroll_y(px)、変換に page_height 必要 → 本 preview では 0 固定
 *   - cart_value: site 固有計測、events に直接列無し → 0 固定
 *   - language: events に列無し → '' 固定
 *   - persona_label / predicted_intent: ML 推論 (events_*_by_dim) で本 preview 経路では未対応 → '' 固定
 *
 * これらに条件をかけた scenario は「マッチ session 0」になる可能性。response の `unsupported_fields`
 * で UI に通知し、誤誘導 (実 traffic では発火するかもしれない) を防ぐ。
 */

import type { ClickHouseClient } from '@clickhouse/client'

import { getClickHouseClient } from '@/lib/clickhouse'
import { evaluate, type EvaluationContext } from './evaluator'
import { ALLOWED_FIELDS, collectFields, type ConditionNode } from './types'

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export interface DryRunPreviewInput {
  tenantId: string
  siteId: string
  conditionAst: ConditionNode
  /** 1..30、既定 7。 */
  days?: number
}

export interface DryRunPreviewResult {
  /** 集計期間 (Asia/Tokyo)。 */
  period: { startDate: string; endDate: string; days: number }
  /** 期間内の全 session 数 (tenant + site で絞ったあとの基数)。 */
  totalSessions: number
  /** 条件 AST にマッチした session 数。 */
  matchedSessions: number
  /** matchedSessions / totalSessions (0..1)、totalSessions=0 のとき 0。 */
  matchRate: number
  /** 日次内訳 (UTC date)。 */
  daily: Array<{ date: string; sessions: number; matched: number; matchRate: number }>
  /** 代表マッチ session のサンプル (匿名化、UI で「こんな session が当たる」表示用)。 */
  sampleMatches: Array<{
    sessionId: string
    deviceType: string
    utmSource: string
    utmMedium: string
    sessionDurationSec: number
    pageViewsInSession: number
    urlPath: string
    isFirstVisit: boolean
  }>
  /** AST が参照しているが本 preview では集計不可な field の一覧 (UI で warning 表示)。 */
  unsupportedFields: ReadonlyArray<string>
  /** 「inferred」固定 (events 再生は過去スナップショット、未来の挙動は保証しない)。 */
  evidenceLevel: 'inferred'
  /** ClickHouse 実行時間 (ms)、デバッグ用。 */
  queryMs: number
}

/** events 列で直接 / 集計で表現できる field の集合。 */
const SUPPORTED_FIELDS = new Set([
  'tenant_id',
  'site_id',
  'visitor_id',
  'session_id',
  'is_first_visit',
  'session_duration_sec',
  'page_views_in_session',
  'url_path',
  'url_query',
  'referrer_host',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'device_type',
  'visited_paths',
  'hour_of_day',
  'is_agent',
])

/** events に存在しない / 本 preview 経路で集計できない field。 */
const UNSUPPORTED_FIELDS = new Set([
  'scroll_depth_max_pct', // px のため page_height 必要、変換省略
  'cart_value', // site 固有
  'language', // 列なし
  'persona_label', // ML 推論、別 MV
  'predicted_intent', // 同上
])

/** Sample maxima (preview UI を重くしない上限)。 */
const SAMPLE_LIMIT = 10
/** 1 回の preview で評価する session 数上限 (CH からの転送と CPU 評価両方を抑える)。 */
const SESSION_HARD_LIMIT = 5000

export async function runDryRunPreview(
  input: DryRunPreviewInput,
  client?: ClickHouseClient,
): Promise<DryRunPreviewResult> {
  const days = clamp(input.days ?? 7, 1, 30)
  const unsupportedFields = listUnsupportedFields(input.conditionAst)

  const ch = client ?? getClickHouseClient('analytics_reader')
  const t0 = Date.now()

  // 期間 (UTC 日付の startDate..endDate=今日まで)。UI 側で JST 表示する場合は UI 側で変換。
  const endDate = utcDateString(Date.now())
  const startDate = utcDateString(Date.now() - (days - 1) * 24 * 60 * 60 * 1000)

  // session 単位集約: tenant + site + 期間で WHERE、SESSION_HARD_LIMIT で打ち切り。
  const sql = `
SELECT
  session_id,
  any(visitor_id) AS visitor_id,
  toDate(min(timestamp)) AS day,
  max(is_first_visit) AS is_first_visit,
  max(session_duration_sec) AS session_duration_sec,
  max(page_views_in_session) AS page_views_in_session,
  any(device_type) AS device_type,
  any(utm_source) AS utm_source,
  any(utm_medium) AS utm_medium,
  any(utm_campaign) AS utm_campaign,
  max(is_agent) AS is_agent,
  toHour(min(timestamp)) AS hour_of_day,
  any(referrer) AS referrer,
  argMax(url, timestamp) AS last_url,
  arrayDistinct(groupArrayIf(path(url), event_type = 'pageview')) AS visited_paths
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String}
  AND site_id = {site_id:String}
  AND timestamp >= toDateTime({start:String}, 'UTC')
  AND timestamp < toDateTime({end:String}, 'UTC') + INTERVAL 1 DAY
GROUP BY session_id
ORDER BY day DESC
LIMIT {hard_limit:UInt32}
SETTINGS max_execution_time = 30
`.trim()

  const params = {
    tenant_id: input.tenantId,
    site_id: input.siteId,
    start: startDate,
    end: endDate,
    hard_limit: SESSION_HARD_LIMIT,
  }

  const resultSet = await ch.query({
    query: sql,
    query_params: params,
    format: 'JSONEachRow',
  })

  interface Row {
    session_id: string
    visitor_id: string
    day: string
    is_first_visit: number
    session_duration_sec: number
    page_views_in_session: number
    device_type: string
    utm_source: string
    utm_medium: string
    utm_campaign: string
    is_agent: number
    hour_of_day: number
    referrer: string
    last_url: string
    visited_paths: string[]
  }
  const rows: Row[] = await resultSet.json<Row>()

  const dailyMap = new Map<string, { sessions: number; matched: number }>()
  const sampleMatches: DryRunPreviewResult['sampleMatches'] = []
  let matchedSessions = 0

  for (const r of rows) {
    const ctx = rowToEvaluationContext(r, input.tenantId, input.siteId)
    const result = evaluate(input.conditionAst, ctx)

    const dayKey = r.day
    const bucket = dailyMap.get(dayKey) ?? { sessions: 0, matched: 0 }
    bucket.sessions++
    if (result.matched) {
      bucket.matched++
      matchedSessions++
      if (sampleMatches.length < SAMPLE_LIMIT) {
        sampleMatches.push({
          sessionId: r.session_id,
          deviceType: r.device_type,
          utmSource: r.utm_source,
          utmMedium: r.utm_medium,
          sessionDurationSec: r.session_duration_sec,
          pageViewsInSession: r.page_views_in_session,
          urlPath: ctx.url_path ?? '',
          isFirstVisit: Boolean(r.is_first_visit),
        })
      }
    }
    dailyMap.set(dayKey, bucket)
  }

  const totalSessions = rows.length
  const matchRate = totalSessions > 0 ? matchedSessions / totalSessions : 0
  const daily = Array.from(dailyMap.entries())
    .map(([date, v]) => ({
      date,
      sessions: v.sessions,
      matched: v.matched,
      matchRate: v.sessions > 0 ? v.matched / v.sessions : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return {
    period: { startDate, endDate, days },
    totalSessions,
    matchedSessions,
    matchRate,
    daily,
    sampleMatches,
    unsupportedFields,
    evidenceLevel: 'inferred',
    queryMs: Date.now() - t0,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// row → EvaluationContext
// ────────────────────────────────────────────────────────────────────────────

function rowToEvaluationContext(
  row: {
    visitor_id: string
    session_id: string
    is_first_visit: number
    session_duration_sec: number
    page_views_in_session: number
    device_type: string
    utm_source: string
    utm_medium: string
    utm_campaign: string
    is_agent: number
    hour_of_day: number
    referrer: string
    last_url: string
    visited_paths: string[]
  },
  tenantId: string,
  siteId: string,
): EvaluationContext {
  const { pathname, search } = parseUrl(row.last_url)
  const referrerHost = parseHost(row.referrer)
  const device = normalizeDevice(row.device_type)

  return {
    tenant_id: tenantId,
    site_id: siteId,
    visitor_id: row.visitor_id || undefined,
    session_id: row.session_id,
    is_first_visit: Boolean(row.is_first_visit),
    session_duration_sec: Number(row.session_duration_sec) || 0,
    page_views_in_session: Number(row.page_views_in_session) || 0,
    url_path: pathname,
    url_query: search,
    referrer_host: referrerHost,
    utm_source: row.utm_source ?? '',
    utm_medium: row.utm_medium ?? '',
    utm_campaign: row.utm_campaign ?? '',
    device_type: device,
    visited_paths: Array.isArray(row.visited_paths) ? row.visited_paths : [],
    scroll_depth_max_pct: 0, // events に列なし、本 preview では 0 固定
    cart_value: 0,
    language: '',
    hour_of_day: Number(row.hour_of_day) || 0,
    is_agent: Boolean(row.is_agent),
    persona_label: '',
    predicted_intent: '',
  }
}

function parseUrl(url: string): { pathname: string; search: string } {
  if (!url) return { pathname: '', search: '' }
  try {
    // events.url は absolute / relative 両方ありうる。base を仮置きしてパース。
    const u = new URL(url, 'https://_dry.invalid')
    return { pathname: u.pathname, search: u.search }
  } catch {
    return { pathname: url, search: '' }
  }
}

function parseHost(url: string): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function normalizeDevice(d: string): EvaluationContext['device_type'] {
  if (d === 'desktop' || d === 'mobile' || d === 'tablet') return d
  return 'unknown'
}

// ────────────────────────────────────────────────────────────────────────────
// utils
// ────────────────────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function utcDateString(epochMs: number): string {
  const d = new Date(epochMs)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 条件 AST が参照しているが本 preview では集計できない field の一覧を返す。
 */
export function listUnsupportedFields(ast: ConditionNode): ReadonlyArray<string> {
  const used = new Set(collectFields(ast))
  const out: string[] = []
  for (const f of used) {
    if (UNSUPPORTED_FIELDS.has(f)) out.push(f)
    else if (!SUPPORTED_FIELDS.has(f) && !(ALLOWED_FIELDS as ReadonlyArray<string>).includes(f)) {
      out.push(f)
    }
  }
  return out
}

// internal export (tests のみ)
export const __test__ = {
  rowToEvaluationContext,
  parseUrl,
  parseHost,
  normalizeDevice,
  utcDateString,
  SESSION_HARD_LIMIT,
  SAMPLE_LIMIT,
}
