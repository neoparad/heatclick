/**
 * 宝プロジェクト — arm 別計測 (M3, T1, requirement C)
 *
 * Reference:
 *   - handoff §作る5コンポーネント #4 (arm 別計測)
 *   - .claude/plans/sim_pooling_power.py L27-31 (δ法 logRR + 分散。本実装と同一式)
 *   - lib/scenarios/stats-query.ts (ClickHouse 読み出し作法 / graceful empty)
 *
 * 設計の核心:
 *   - events に arm カラムは無い。per-visitor で `clickinsight.events` を集計し、Node 側で
 *     **computeArm を再計算**して arm 別に畳む (client 申告 arm は使わない = 信頼境界)。
 *   - salt は **ClickHouse に渡さない** (CH は log_queries=1。salt がクエリログに残るのを回避)。
 *     arm 計算は Node 内のみ。クエリには secret を一切含めない。
 *   - is_agent=0 で bot 除外 (層別防御の一段)。
 *   - visitor_id は本関数内 (テナント内処理) でのみ扱い、返り値は **per-arm 集計のみ** (visitor_id を
 *     外に出さない = k匿名境界。M5 pool へはこの集計だけ渡す)。
 *   - 単一サイトの logRR + δ法分散を返すが、有意性/因果は **ここでは判定しない** (M4 power-gate /
 *     M5 pool の仕事)。鉄則「単一サイトで因果断定しない」。
 */

import { getClickHouseClient } from '@/lib/clickhouse'

import { computeArm, type Arm } from './assignment'
import type { PrimaryMetric } from './taxonomy'
import type { Experiment } from './types'

export interface PerVisitorRow {
  visitor_id: string
  sessions: number
  conversions: number
}

export interface ArmAggregate {
  sessions_n: number
  conversions: number
  cvr: number // conversions / sessions_n (raw, 表示用)
}

/** 単一サイトの効果量 (δ法)。pool (M5) の入力。 */
export interface ArmEffect {
  log_rr: number
  variance: number
  se: number
}

export interface ArmStatsResult {
  experiment_id: string
  primary_metric: PrimaryMetric
  control: ArmAggregate
  treatment: ArmAggregate
  /** どちらかの arm が 0 session なら null (効果量を出せない)。 */
  effect: ArmEffect | null
  total_sessions: number
  data_unavailable: boolean
  data_unavailable_reason?: string
}

// primary_metric → events.event_type 分子
const METRIC_EVENT_TYPE: Readonly<Record<PrimaryMetric, string>> = {
  cvr: 'conversion',
  cta_click_rate: 'click',
  form_submit_rate: 'conversion', // MVP: フォーム送信は conversion として記録 (lead-gen)
}

export function metricEventType(metric: PrimaryMetric): string {
  return METRIC_EVENT_TYPE[metric]
}

// numerator の URL スコープ (Codex M3 MEDIUM):
//   - page_local = 実験ページ上の event のみ (例: CTA click は実験ページで発火)
//   - cross_page = exposed session 内ならどの URL の event でも可 (例: cvr の conversion は
//     checkout / thanks ページで発火するため、実験ページ url で絞ると過少計上になる → プール汚染)
const METRIC_NUMERATOR_SCOPE: Readonly<Record<PrimaryMetric, 'page_local' | 'cross_page'>> = {
  cvr: 'cross_page',
  cta_click_rate: 'page_local',
  form_submit_rate: 'cross_page',
}

export function metricNumeratorScope(metric: PrimaryMetric): 'page_local' | 'cross_page' {
  return METRIC_NUMERATOR_SCOPE[metric]
}

// ゼロセル連続性補正 (sim_pooling_power.py L27-28): x を [0.5, n-0.5] に収める。
function clampCell(x: number, n: number): number {
  if (x <= 0) return 0.5
  if (x >= n) return n - 0.5
  return x
}

/**
 * per-visitor rows を arm 別に畳む。armOf は visitor_id → arm (computeArm を注入してテスト可能化)。
 * 1 visitor の全 session は同 arm (arm は visitor 単位で決まるため)。
 */
export function aggregateByArm(
  rows: ReadonlyArray<PerVisitorRow>,
  armOf: (visitorId: string) => Arm,
): Record<Arm, { sessions_n: number; conversions: number }> {
  const acc: Record<Arm, { sessions_n: number; conversions: number }> = {
    control: { sessions_n: 0, conversions: 0 },
    treatment: { sessions_n: 0, conversions: 0 },
  }
  for (const r of rows) {
    const bucket = acc[armOf(r.visitor_id)]
    bucket.sessions_n += r.sessions
    bucket.conversions += r.conversions
  }
  return acc
}

/**
 * 単一サイトの logRR + δ法分散 (sim_pooling_power.py L27-31 と同一)。
 *   pc = xc/nc, pt = xt/nt (連続性補正後)、logRR = log(pt/pc)、
 *   Var(logRR) = (1-pt)/xt + (1-pc)/xc。
 * どちらかの arm が 0 session なら null。
 */
export function computeArmEffect(
  control: { sessions_n: number; conversions: number },
  treatment: { sessions_n: number; conversions: number },
): ArmEffect | null {
  const nc = control.sessions_n
  const nt = treatment.sessions_n
  if (nc <= 0 || nt <= 0) return null
  const xc = clampCell(control.conversions, nc)
  const xt = clampCell(treatment.conversions, nt)
  const pc = xc / nc
  const pt = xt / nt
  const logRR = Math.log(pt / pc)
  const variance = (1 - pt) / xt + (1 - pc) / xc
  return { log_rr: logRR, variance, se: Math.sqrt(variance) }
}

function toAggregate(a: { sessions_n: number; conversions: number }): ArmAggregate {
  return {
    sessions_n: a.sessions_n,
    conversions: a.conversions,
    cvr: a.sessions_n > 0 ? a.conversions / a.sessions_n : 0,
  }
}

/** per-visitor rows から arm 別結果を組み立てる (pure、computeArm を armOf で注入)。 */
export function buildArmStatsResult(
  experimentId: string,
  primaryMetric: PrimaryMetric,
  rows: ReadonlyArray<PerVisitorRow>,
  armOf: (visitorId: string) => Arm,
): ArmStatsResult {
  const byArm = aggregateByArm(rows, armOf)
  const control = toAggregate(byArm.control)
  const treatment = toAggregate(byArm.treatment)
  return {
    experiment_id: experimentId,
    primary_metric: primaryMetric,
    control,
    treatment,
    effect: computeArmEffect(byArm.control, byArm.treatment),
    total_sessions: control.sessions_n + treatment.sessions_n,
    data_unavailable: false,
  }
}

// ── ClickHouse 読み出し ──────────────────────────────────────────────────────
// salt は **含めない** (Node で arm 再計算、CH log_queries=1 のため secret を渡さない)。
//
// ITT (exposed session cohort) モデル:
//   - path_norm: full URL / bare path どちらでも path を正規抽出 ('://' 無ければ dummy host を前置)。
//   - on_page: url_pattern と path が一致 or その subtree ('/products' は '/products-old' に誤マッチしない)。
//   - exposed session = 実験ページに触れた session (= 分母)。
//   - converted: page_local なら実験ページ上の metric event、cross_page なら exposed session 内の
//     metric event をどの URL でも (cvr の conversion は別ページ発火のため)。
const PER_VISITOR_QUERY = `
  SELECT
    visitor_id,
    uniqExact(session_id) AS sessions,
    uniqExactIf(session_id, converted = 1) AS conversions
  FROM (
    SELECT
      visitor_id,
      session_id,
      max(on_page) AS exposed,
      max(if({page_local:UInt8} = 1, on_page AND is_metric, is_metric)) AS converted
    FROM (
      SELECT
        visitor_id,
        session_id,
        (
          {url_pattern:String} = '/'
          OR path_norm = {url_pattern:String}
          OR startsWith(path_norm, concat({url_pattern:String}, '/'))
        ) AS on_page,
        (event_type = {metric_event:String}) AS is_metric
      FROM (
        SELECT
          visitor_id,
          session_id,
          event_type,
          path(if(position(url, '://') > 0, url, concat('http://x', url))) AS path_norm
        FROM clickinsight.events
        WHERE tenant_id = {tenant_id:String}
          AND site_id = {site_id:String}
          AND is_agent = 0
          AND device_type = {device_type:String}
          AND timestamp >= {from:DateTime}
          AND timestamp < {to:DateTime}
          AND visitor_id != ''
      )
    )
    GROUP BY visitor_id, session_id
    HAVING exposed = 1
  )
  GROUP BY visitor_id
`

// 公開 measurement の作業量上限 (Codex M3 HIGH)。実験は本質的に低トラフィック slice (検出力不足が
// プールの前提) だが、病的ケースで OOM しないよう result 行 (= visitor 数) を上限・超過は fail-closed。
const MAX_VISITOR_ROWS = 500_000

interface RawVisitorRow {
  visitor_id: string
  sessions: string | number
  conversions: string | number
}

/**
 * 実験の slice (tenant/site/url_pattern/device/window) を events から arm 別に集計。
 * salt は Node 内 computeArm のみで使用 (CH に渡さない)。table 不在等は graceful empty。
 */
export async function queryArmStats(args: { experiment: Experiment; salt: string }): Promise<ArmStatsResult> {
  const { experiment, salt } = args
  const { id, tenant_id, site_id, url_pattern, salt_version } = experiment
  const { device, primary_metric } = experiment.taxonomy
  const { start_at, end_at } = experiment.dates

  if (!start_at || !end_at) {
    return emptyResult(id, primary_metric, 'experiment has no measurement window (start_at/end_at null)')
  }

  let ch
  try {
    ch = getClickHouseClient('analytics_reader')
  } catch (e) {
    return emptyResult(id, primary_metric, `clickhouse_role_unavailable: ${(e as Error).message}`)
  }

  const params = {
    tenant_id,
    site_id,
    device_type: device,
    url_pattern,
    metric_event: metricEventType(primary_metric),
    page_local: metricNumeratorScope(primary_metric) === 'page_local' ? 1 : 0,
    from: chDateTime(start_at),
    to: chDateTime(end_at),
  }

  try {
    const rs = await ch.query({
      query: PER_VISITOR_QUERY,
      query_params: params,
      format: 'JSONEachRow',
      clickhouse_settings: { max_result_rows: String(MAX_VISITOR_ROWS), result_overflow_mode: 'throw' },
    })
    const raw = (await rs.json()) as RawVisitorRow[]
    const rows: PerVisitorRow[] = []
    for (const r of raw) {
      const sessions = Number(r.sessions)
      const conversions = Number(r.conversions)
      // Codex M3 LOW: CH からの異常値 (NaN / 負 / 非整数 / unsafe int / conversions>sessions) は fail-closed。
      if (
        !Number.isSafeInteger(sessions) ||
        !Number.isSafeInteger(conversions) ||
        sessions < 0 ||
        conversions < 0 ||
        conversions > sessions
      ) {
        return emptyResult(id, primary_metric, 'clickhouse returned invalid aggregate values')
      }
      rows.push({ visitor_id: String(r.visitor_id), sessions, conversions })
    }
    return buildArmStatsResult(id, primary_metric, rows, (visitorId) =>
      computeArm({ experimentId: id, visitorId, salt, saltVersion: salt_version }),
    )
  } catch (e) {
    const msg = (e as Error).message
    if (/UNKNOWN_TABLE|doesn't exist|does not exist/i.test(msg)) {
      return emptyResult(id, primary_metric, 'clickinsight.events not available (migration 未適用)')
    }
    if (/TOO_MANY_ROWS|overflow|max_result_rows/i.test(msg)) {
      return emptyResult(id, primary_metric, 'too many visitor rows (high-traffic slice; streaming は follow-up)')
    }
    throw e
  }
}

function chDateTime(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19)
}

function emptyResult(experimentId: string, primaryMetric: PrimaryMetric, reason: string): ArmStatsResult {
  const zero: ArmAggregate = { sessions_n: 0, conversions: 0, cvr: 0 }
  return {
    experiment_id: experimentId,
    primary_metric: primaryMetric,
    control: zero,
    treatment: { ...zero },
    effect: null,
    total_sessions: 0,
    data_unavailable: true,
    data_unavailable_reason: reason,
  }
}
