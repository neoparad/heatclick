/**
 * Ingest freshness monitoring — サイト別「最終 event 受信」の集計。
 *
 * 続137 P0-α1 (2026-07-12): event-ingest Worker (Cloudflare Worker、tracking.js の送信先) が
 * B1 (ClickHouse `default` パスワードローテーション) に追従せず、CH書き込み用 secret が stale の
 * まま 10日間 HTTP 401 で全 INSERT が無言で失敗し続けた。実績4サイトの計測が10日間ゼロになるまで
 * 誰も気づけなかった (過去にも同型の無 event 期間が複数回あった疑いあり)。
 *
 * この module は再発防止策: 「どこかのサイトの event 受信が止まっている」を短時間で検知できる
 * ようにする。/api/health (middleware.ts の API_PUBLIC_PATHS = 無認証公開route) から呼ばれる前提。
 *
 * ⚠ セキュリティ / D-07 整合:
 *   - /api/health は無認証の公開route。site_id / tracking_id / tenant_id / 個別トラフィック量は
 *     絶対に返さない (事業機密の漏洩。既存の screenshot health セクションと同じく boolean/件数のみ)。
 *   - 本 module が返すのは「件数の集計」のみ。呼び出し側 (route handler) でも個別サイト情報を
 *     レスポンスに混ぜないこと。
 *
 * 設計注意:
 *   - `clickinsight.sites` に app 層の site_id (`CIP_xxxx`) を格納する列は `tracking_id` であり
 *     `site_id` という列は存在しない (workers/event-ingest/src/worker.ts の実装コメント参照。
 *     過去にこの取り違えで本番障害が起きた実績がある)。`clickinsight.events.site_id` と
 *     `clickinsight.sites.tracking_id` を突き合わせること。
 *   - 閾値比較は ClickHouse 側 SQL (`now() - max(timestamp) > threshold_hours*3600`) で行い、
 *     JS 側でタイムゾーン付き DateTime 文字列をパースしない (誤変換によるサイレントバグを避ける)。
 */

import type { ClickHouseClient } from '@clickhouse/client'

import { redis } from '@/lib/redis'

export interface FreshnessSummary {
  /** sites registry (clickinsight.sites.tracking_id) に登録されている総サイト数 */
  totalSites: number
  /** 閾値以内に real event (is_agent=0) を受信しているサイト数 */
  activeSites: number
  /** 過去に event 実績があるが、閾値を超えて event が届いていないサイト数 (= 要調査) */
  staleSites: number
  /** registry にはあるが一度も event を受信していないサイト数 (未設置 or 壊れた snippet の可能性) */
  neverActiveSites: number
  /** 判定に使った閾値 (時間) */
  thresholdHours: number
  /** staleSites === 0 なら true */
  ok: boolean
}

const DEFAULT_THRESHOLD_HOURS = 6
/** ClickHouse UInt32 の範囲 (query_params の {threshold_hours:UInt32} に束縛するため)。 */
const MAX_UINT32 = 0xffffffff
/**
 * events クエリの走査範囲 (日数)。thresholdHours より十分大きく取り、staleSites の誤分類
 * (neverActiveSites 側への繰り込み) を実務上起きないレンジに抑えつつ、無制限フルスキャンを防ぐ。
 */
const FRESHNESS_LOOKBACK_DAYS = 90

function resolveThresholdHours(): number {
  const raw = Number(process.env.INGEST_FRESHNESS_THRESHOLD_HOURS)
  // 整数かつ UInt32 範囲内のみ採用。小数/範囲外/NaN は既定値にフォールバック
  // (Codex review MEDIUM: 6.5 等の小数が {threshold_hours:UInt32} に不適合で
  //  正常な CH に対しても health を誤って degraded にしうる)。
  if (Number.isInteger(raw) && raw >= 1 && raw <= MAX_UINT32) {
    return raw
  }
  return DEFAULT_THRESHOLD_HOURS
}

/**
 * /api/health は無認証の公開route (Codex review HIGH): 毎回全テナント・全期間の
 * `events` を GROUP BY site_id する集計を素通しで実行すると、通常監視の高頻度 polling や
 * 悪意ある連打で ClickHouse の実行時間予算 (analytics_reader max_execution_time=30s) を
 * 食い潰しうる。2層キャッシュで防ぐ:
 *   - L1 (in-memory Map): 同一 serverless instance 内、最速、instance 横断では効かない。
 *   - L2 (Redis, lib/redis.ts の既存 singleton): instance/region 横断で共有。
 *     cold start や多数の instance からの同時アクセスでも、cluster 全体で実クエリは
 *     60秒に高々1回に収まる (Codex review HIGH 再指摘: L1 のみでは cold start / 複数
 *     instance を跨ぐ攻撃的アクセスで負荷が残ると判定されたための追加)。
 *     Redis 不達時は fail-open (r2-screenshot-cache.ts の dedupe lock と同じ方針:
 *     `Redis 不達 → fail-open`)。health check 自体の可用性を Redis に依存させない。
 */
const CACHE_TTL_MS = 60_000
const CACHE_TTL_SEC = Math.ceil(CACHE_TTL_MS / 1000)
const REDIS_KEY_PREFIX = 'ingest-freshness:v1'

// thresholdHours 別に keying (呼び出し側が異なる閾値を渡すケースを正しく扱うため)。
const cache = new Map<number, { value: FreshnessSummary; expiresAt: number }>()
const inFlightByThreshold = new Map<number, Promise<FreshnessSummary>>()

/** Test-only: モジュールキャッシュをリセットする (screenshot-provider.ts の
 *  _resetScreenshotMemoryCache と同型の hook)。 */
export function _resetIngestFreshnessCache(): void {
  cache.clear()
  inFlightByThreshold.clear()
}

async function defaultRedisGet(key: string): Promise<string | null> {
  try {
    return await redis().get(key)
  } catch {
    return null // fail-open: L2 miss 扱いで実クエリにフォールバック
  }
}

async function defaultRedisSet(key: string, value: string, ttlSec: number): Promise<void> {
  try {
    await redis().set(key, value, 'EX', ttlSec)
  } catch {
    // best-effort: 書き込み失敗は許容 (次回また実クエリで計算するだけ)
  }
}

/**
 * cluster-wide dedupe lock (Redis SET NX EX、r2-screenshot-cache.ts の defaultAcquireLock と
 * 同型)。L1/L2 両方 miss の同時アクセスで複数 instance が同時に実クエリを実行するのを防ぐ
 * (Codex review HIGH 3周目: L2 GET/SET だけでは排他にならず cold start 集中時に stampede しうる)。
 * Redis 不達時は fail-open (true=取得成功扱い、余分な 1 回の実クエリを許容)。
 */
async function defaultAcquireLock(lockKey: string, ttlSec: number): Promise<boolean> {
  try {
    const res = await redis().set(lockKey, '1', 'EX', ttlSec, 'NX')
    return res === 'OK'
  } catch {
    return true
  }
}

async function defaultReleaseLock(lockKey: string): Promise<void> {
  try {
    await redis().del(lockKey)
  } catch {
    // best-effort: lock は TTL で自然解放される
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 純粋関数: registry (tracking_id 一覧) + サイト別 stale flag (SQL 側で計算済み) から集計を作る。
 * CH 呼び出しから分離してユニットテスト可能にする (時刻をモックする必要がない = SQL 側で
 * 閾値判定を完結させた設計の利点)。
 */
export function computeFreshnessSummary(
  trackingIds: readonly string[],
  staleFlagBySite: ReadonlyMap<string, boolean>,
  thresholdHours: number,
): FreshnessSummary {
  let activeSites = 0
  let staleSites = 0
  let neverActiveSites = 0

  for (const trackingId of trackingIds) {
    const isStale = staleFlagBySite.get(trackingId)
    if (isStale === undefined) {
      neverActiveSites += 1
    } else if (isStale) {
      staleSites += 1
    } else {
      activeSites += 1
    }
  }

  return {
    totalSites: trackingIds.length,
    activeSites,
    staleSites,
    neverActiveSites,
    thresholdHours,
    ok: staleSites === 0,
  }
}

/**
 * sites registry (tracking_id 一覧) と、events の site 別 stale flag を CH から取得し、
 * computeFreshnessSummary で集計する (実クエリ本体、キャッシュ層から呼ばれる)。
 *
 * 2 クエリに分ける理由 (JOIN でなく):
 *   - lib/pages/fetch-pages.ts 等の既存規約 (単純 SELECT+GROUP BY、query_params 束縛) に沿う。
 *   - sites 側が空でも events 側クエリだけで動作継続できる (fail-soft)。
 *   - ClickHouse JOIN の右外部/NULL 挙動に依存しない (デバッグしやすい)。
 */
async function fetchFreshnessSummary(
  client: ClickHouseClient,
  thresholdHours: number,
): Promise<FreshnessSummary> {
  const [sitesResult, eventsResult] = await Promise.all([
    client.query({
      query: `SELECT DISTINCT tracking_id FROM clickinsight.sites WHERE tracking_id != ''`,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
        SELECT
          site_id,
          (now() - max(timestamp)) > ({threshold_hours:UInt32} * 3600) AS is_stale
        FROM clickinsight.events
        WHERE is_agent = 0 AND site_id != ''
          AND timestamp >= now() - INTERVAL {lookback_days:UInt32} DAY
        GROUP BY site_id
      `,
      // Codex review 3周目: WHERE に時間範囲が無いと events 全履歴 (数百万〜1100万行超/site) を
      // 毎回スキャンしてしまう。lookback を thresholdHours より十分大きく (既定90日) 取ることで
      // 「thresholdHours を超えて stale」なサイトは正しく staleSites に残しつつ、走査範囲を抑える。
      // ⚠ lookback を超えて stale なサイトは neverActiveSites 側に倒れる (ok 判定には影響しないが
      // カテゴリが変わる) — 90日以上放置されたサイトは既にアラート済である前提の許容トレードオフ。
      query_params: { threshold_hours: thresholdHours, lookback_days: FRESHNESS_LOOKBACK_DAYS },
      format: 'JSONEachRow',
    }),
  ])

  const sitesRows = await sitesResult.json<{ tracking_id: string }>()
  const eventsRows = await eventsResult.json<{ site_id: string; is_stale: number | boolean }>()

  const trackingIds = sitesRows.map((r) => r.tracking_id).filter((id) => id !== '')
  const staleFlagBySite = new Map<string, boolean>()
  for (const row of eventsRows) {
    staleFlagBySite.set(row.site_id, row.is_stale === 1 || row.is_stale === true)
  }

  return computeFreshnessSummary(trackingIds, staleFlagBySite, thresholdHours)
}

/** テスト用 DI hook。既定は lib/redis.ts の実 Redis (fail-open ラッパー付き)。 */
export interface IngestFreshnessCacheHooks {
  redisGet?: (key: string) => Promise<string | null>
  redisSet?: (key: string, value: string, ttlSec: number) => Promise<void>
  acquireLock?: (lockKey: string, ttlSec: number) => Promise<boolean>
  releaseLock?: (lockKey: string) => Promise<void>
}

/** analytics_reader の max_execution_time (30s) を超える余裕を持たせた lock TTL。 */
const LOCK_TTL_SEC = 35
/**
 * lock 非取得側が L2 の完成を待つ最大試行回数・間隔 (合計 ~4秒)。
 * Codex review HIGH 4周目 issue#1: 旧設定(合計1秒)は実クエリの現実的な所要時間
 * (軽量集計だが CH 負荷次第で数秒かかりうる) に対して短すぎ、poll 側がほぼ確実に
 * fail-open して重複実行していた。lock TTL(35秒)よりは十分短く保ちつつ、health check
 * 応答性 (Vercel function timeout) を損なわない範囲で待機を伸ばす。
 */
const LOCK_POLL_ATTEMPTS = 8
const LOCK_POLL_INTERVAL_MS = 500

/** L2 (Redis) から読んだ値が期待する shape かを検証する (Codex review MEDIUM: JSON.parse だけでは
 *  `{}` や型不正値をそのまま信用してしまう)。不正なら null を返し、実クエリへフォールバックさせる。 */
function parseValidatedSummary(raw: string): FreshnessSummary | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const numFields = ['totalSites', 'activeSites', 'staleSites', 'neverActiveSites', 'thresholdHours']
  if (!numFields.every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]))) return null
  if (typeof v.ok !== 'boolean') return null
  return v as unknown as FreshnessSummary
}

/**
 * 公開 API: sites registry + events の site 別 stale flag を集計して返す。
 *
 * 呼び出し元 (route handler) は try-catch で包み、失敗時は健全性を「未確認 (unhealthy 扱い)」
 * として扱うこと。本関数自体は throw しうる (CH 接続断・権限不足等、L1/L2 両方 miss 時のみ)。
 *
 * Codex review HIGH (2026-07-12、2周目で再指摘): `/api/health` は無認証公開route。
 * L1 (in-memory) だけでは cold start / 複数 serverless instance を跨ぐアクセスで
 * cluster 全体としての実クエリ回数を抑えられないため、L2 (Redis, instance/region 横断で
 * 共有) を追加。L1→L2→実クエリの順で確認し、実クエリ成功時は両方に書き込む。
 * Redis 書き込みは **await する** (Next 14.2 に after() が無く、response 返却後の
 * detached promise は Vercel serverless で freeze されうる — r2-screenshot-cache.ts の
 * scheduleBackgroundTask のコメントで既に確立された制約と同じ)。
 */
export async function getIngestFreshnessSummary(
  client: ClickHouseClient,
  options: { thresholdHours?: number } & IngestFreshnessCacheHooks = {},
): Promise<FreshnessSummary> {
  const thresholdHours = options.thresholdHours ?? resolveThresholdHours()
  const redisGet = options.redisGet ?? defaultRedisGet
  const redisSet = options.redisSet ?? defaultRedisSet
  const acquireLock = options.acquireLock ?? defaultAcquireLock
  const releaseLock = options.releaseLock ?? defaultReleaseLock
  const redisKey = `${REDIS_KEY_PREFIX}:${thresholdHours}`
  const lockKey = `${REDIS_KEY_PREFIX}:lock:${thresholdHours}`

  // L1 (in-memory, 同一 instance のみ)
  const hit = cache.get(thresholdHours)
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value
  }

  // single-flight (同一 instance 内の同時呼び出しを1本化)
  const existingInFlight = inFlightByThreshold.get(thresholdHours)
  if (existingInFlight) {
    return existingInFlight
  }

  const promise = (async (): Promise<FreshnessSummary> => {
    // L2 (Redis、instance/region 横断で共有)
    const cachedRaw = await redisGet(redisKey)
    if (cachedRaw != null) {
      const parsed = parseValidatedSummary(cachedRaw)
      if (parsed) {
        cache.set(thresholdHours, { value: parsed, expiresAt: Date.now() + CACHE_TTL_MS })
        return parsed
      }
      // 壊れた/不正な shape の cache 値は無視して下へフォールスルー (throw しない)
    }

    // cluster-wide dedupe lock (Codex review HIGH 3周目): L1/L2 両方 miss の同時アクセスで
    // 複数 instance が同時に実クエリを実行する stampede を防ぐ。
    const acquired = await acquireLock(lockKey, LOCK_TTL_SEC)
    if (!acquired) {
      // 別 instance が計算中。L2 の完成を短時間だけ待つ (待機上限を必ず設け、health check を
      // 無期限にブロックしない)。待っても埋まらなければ「未確認」として throw し、
      // 呼び出し元 (route.ts) の catch → INGEST_UNCHECKED フォールバックに委ねる
      // (Codex review HIGH 5周目: ここで自分も実クエリを実行すると owner の集計が
      //  poll 予算より長引いた場合に確実に重複するため、dedupe の目的を優先し実行しない)。
      for (let attempt = 0; attempt < LOCK_POLL_ATTEMPTS; attempt += 1) {
        await sleep(LOCK_POLL_INTERVAL_MS)
        const polledRaw = await redisGet(redisKey)
        if (polledRaw != null) {
          const polled = parseValidatedSummary(polledRaw)
          if (polled) {
            cache.set(thresholdHours, { value: polled, expiresAt: Date.now() + CACHE_TTL_MS })
            return polled
          }
        }
      }
      // poll 上限到達 (Codex review HIGH 5周目): ここで fail-open して自分で実クエリを
      // 実行すると、owner 側の集計が poll 予算 (数秒) より長く (〜30秒) かかった場合に
      // 確実に重複実行してしまい、lock の目的 (cluster-wide dedupe) を満たせない。
      // 「未確認」として throw し、呼び出し元 (route.ts) の既存 catch → INGEST_UNCHECKED
      // フォールバックに委ねる方が誠実 (嘘の healthy を返さず、かつ CH に追加負荷もかけない)。
      throw new Error(
        'ingest-freshness: lock contention timeout (another instance is computing, gave up waiting)',
      )
    }

    // lock 取得後の再確認 (Codex review HIGH 4周目 issue#2): L2-miss 判定〜lock 取得の間に
    // 別 instance が計算・書込・解放を終えている可能性があるため、実クエリ前にもう一度だけ見る。
    // 安価 (Redis 1往復) だが取りこぼしを大きく減らせる。
    const recheckRaw = await redisGet(redisKey)
    if (recheckRaw != null) {
      const rechecked = parseValidatedSummary(recheckRaw)
      if (rechecked) {
        await releaseLock(lockKey)
        cache.set(thresholdHours, { value: rechecked, expiresAt: Date.now() + CACHE_TTL_MS })
        return rechecked
      }
    }

    try {
      const value = await fetchFreshnessSummary(client, thresholdHours)
      cache.set(thresholdHours, { value, expiresAt: Date.now() + CACHE_TTL_MS })
      await redisSet(redisKey, JSON.stringify(value), CACHE_TTL_SEC)
      return value
    } finally {
      await releaseLock(lockKey)
    }
  })().finally(() => {
    inFlightByThreshold.delete(thresholdHours)
  })

  inFlightByThreshold.set(thresholdHours, promise)
  return promise
}
