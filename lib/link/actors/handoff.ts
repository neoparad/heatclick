/**
 * UGOKI LINK v2 — 束 3-D (手順 10): `Server-Timing` 橋渡し・1対1確定的結合・クライアント非漏洩 ACK
 *
 * 設計書 §7.4 / actors-final.md M5, C.M5 / ゲート `act.G6`, `act.G7`:
 * 1. エッジ/オリジンが文書レスポンスへ `Server-Timing: ugk;desc="1.<rid>.<t>[.<mac>]"` を付与。
 * 2. SDK の `pv_id` とサーバー観測レコードを `(tenant_id, site_id, request_id, host, path)`
 *    かつ `±120秒` 以内で 1 対 1 に確定的結合する。
 * 3. `back_forward` (bfcache) / `soft` (SPA遷移) / `resume` は非JS分母から自動除外する (`act.G6`)。
 * 4. 共有フロントキャッシュにより同一 `request_id` が別クライアントから返送された場合は
 *    `shared_cache` として自動検知し 1対N 誤結合を防ぐ。
 * 5. クライアント側 ACK レスポンスには行為者判定 (`actor_class` / `verified_actor_id` /
 *    `identity_assurance` / `verification_result` 等) を 1 フィールドも返さない (`act.G7`)。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

import type { ActorObservationRecord } from './verdict-engine'

// ---------------------------------------------------------------------------
// Constants & Types
// ---------------------------------------------------------------------------

export const SERVER_TIMING_HANDOFF_METRIC_NAME = 'ugk'
export const SERVER_TIMING_PROTOCOL_VERSION = '1'
export const HANDOFF_JOIN_WINDOW_SECONDS = 120

export type ClientNavigationType = 'navigate' | 'reload' | 'back_forward' | 'soft' | 'resume'

export type HandoffJoinState =
  | 'fresh'
  | 'reused'
  | 'inherited'
  | 'shared_cache'
  | 'missing'
  | 'invalid_mac'
  | 'unmatched_server_obs'
  | 'host_path_mismatch'
  | 'window_expired'

export interface ParsedServerTimingHandoff {
  readonly version: string
  readonly request_id: string
  readonly issued_at_sec: number
  readonly issued_at_ms: number
  readonly issued_at_raw: string
  readonly mac_hex: string | null
  readonly raw_desc: string
}

/**
 * Nginx `$msec` (`"1763640000.123"`) または整数秒 (`"1763640000"`) をミリ秒整数へ厳密変換する。
 */
export function parseNginxMsecToMs(raw: string | number): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 100_000_000 || raw > 99_999_999_999) return null
    return Math.round(raw * 1000)
  }
  const trimmed = raw.trim()
  if (!/^\d{9,11}(?:\.\d{1,6})?$/.test(trimmed)) return null
  const val = Number(trimmed)
  if (!Number.isFinite(val) || val < 100_000_000 || val > 99_999_999_999) return null
  return Math.round(val * 1000)
}

export interface MintServerTimingParams {
  readonly request_id: string
  readonly issued_at_sec: number
  readonly host?: string
  readonly path?: string
  /** Optional shared edge secret to append 64-bit truncated HMAC-SHA256 */
  readonly edge_secret?: string | Buffer
}

export interface MintedServerTimingHeader {
  readonly header_name: 'Server-Timing'
  readonly header_value: string
  readonly desc: string
  readonly request_id: string
  readonly issued_at_sec: number
  readonly mac_hex: string | null
}

// ---------------------------------------------------------------------------
// Minting, Parsing & Verification of `Server-Timing` Handoff Header
// ---------------------------------------------------------------------------

function computeHandoffMac16(params: {
  readonly version: string
  readonly request_id: string
  readonly issued_at_sec: number
  readonly host: string
  readonly path: string
  readonly edge_secret: string | Buffer
}): string {
  const payload = [
    params.version,
    params.request_id,
    String(params.issued_at_sec),
    params.host.trim().toLowerCase(),
    params.path || '/',
  ].join('|')
  return createHmac('sha256', params.edge_secret).update(payload, 'utf8').digest('hex').slice(0, 16)
}

export function mintServerTimingHandoffHeader(
  params: MintServerTimingParams,
): MintedServerTimingHeader {
  const rid = params.request_id.trim()
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(rid)) {
    throw new Error(`Invalid request_id for Server-Timing handoff: "${params.request_id}"`)
  }
  const issuedSec = Math.floor(params.issued_at_sec)
  let macHex: string | null = null
  if (params.edge_secret !== undefined) {
    if (!params.host || !params.path) {
      throw new Error('host and path are required when minting MAC-authenticated Server-Timing')
    }
    macHex = computeHandoffMac16({
      version: SERVER_TIMING_PROTOCOL_VERSION,
      request_id: rid,
      issued_at_sec: issuedSec,
      host: params.host,
      path: params.path,
      edge_secret: params.edge_secret,
    })
  }

  const desc = macHex
    ? `${SERVER_TIMING_PROTOCOL_VERSION}.${rid}.${issuedSec}.${macHex}`
    : `${SERVER_TIMING_PROTOCOL_VERSION}.${rid}.${issuedSec}`

  return Object.freeze({
    header_name: 'Server-Timing',
    header_value: `${SERVER_TIMING_HANDOFF_METRIC_NAME};desc="${desc}"`,
    desc,
    request_id: rid,
    issued_at_sec: issuedSec,
    mac_hex: macHex,
  })
}

const DESC_TOKEN_RE = /^1\.([A-Za-z0-9_-]{4,64})\.(\d{9,11}(?:\.\d{1,6})?)(?:\.([0-9a-f]{16}))?$/i

/**
 * `Server-Timing` ヘッダ全文または `desc` 値単体から UGOKI 橋渡しトークンを抽出する。
 * Nginx `$msec` の小数秒 (`1.<rid>.1763640000.123[.<mac16>]`) と整数秒の両方に対応。
 */
export function parseServerTimingHandoffHeader(
  rawHeaderOrDesc: string | null | undefined,
): ParsedServerTimingHandoff | null {
  if (!rawHeaderOrDesc || !rawHeaderOrDesc.trim()) return null
  const input = rawHeaderOrDesc.trim()

  let desc: string | null = null
  // Full Server-Timing header form: `..., ugk;desc="1.rid.12345[.123][.mac]", ...`
  const headerRe = /(?:^|,\s*)ugk\s*;\s*desc\s*=\s*(?:"([^"]+)"|([^,;\s]+))/i
  const hm = headerRe.exec(input)
  if (hm) {
    desc = (hm[1] ?? hm[2] ?? '').trim()
  } else if (DESC_TOKEN_RE.test(input)) {
    // Direct desc value from `performance.getEntriesByType('navigation')[0].serverTiming`
    desc = input
  }

  if (!desc) return null
  const m = DESC_TOKEN_RE.exec(desc)
  if (!m) return null
  const [, requestId, issuedRaw, macHex] = m
  const issuedAtMs = parseNginxMsecToMs(issuedRaw)
  if (issuedAtMs === null) return null
  const issuedSec = Math.floor(issuedAtMs / 1000)

  return Object.freeze({
    version: SERVER_TIMING_PROTOCOL_VERSION,
    request_id: requestId,
    issued_at_sec: issuedSec,
    issued_at_ms: issuedAtMs,
    issued_at_raw: issuedRaw,
    mac_hex: macHex ? macHex.toLowerCase() : null,
    raw_desc: desc,
  })
}

export function verifyServerTimingHandoffMac(
  parsed: ParsedServerTimingHandoff,
  params: {
    readonly host: string
    readonly path: string
    readonly edge_secret: string | Buffer
  },
): boolean {
  if (!parsed.mac_hex) return false
  const actualBuf = Buffer.from(parsed.mac_hex, 'utf8')
  if (actualBuf.length !== 16) return false

  // Support MAC over exact issued_at_raw (e.g. Nginx $msec) as well as integer issued_at_sec
  const candidates = new Set<string>([
    computeHandoffMac16({
      version: parsed.version,
      request_id: parsed.request_id,
      issued_at_sec: parsed.issued_at_sec,
      host: params.host,
      path: params.path,
      edge_secret: params.edge_secret,
    }),
  ])
  if (parsed.issued_at_raw !== String(parsed.issued_at_sec)) {
    const rawPayload = [
      parsed.version,
      parsed.request_id,
      parsed.issued_at_raw,
      params.host.trim().toLowerCase(),
      params.path || '/',
    ].join('|')
    candidates.add(
      createHmac('sha256', params.edge_secret).update(rawPayload, 'utf8').digest('hex').slice(0, 16),
    )
  }

  for (const expected of candidates) {
    const expectedBuf = Buffer.from(expected, 'utf8')
    if (actualBuf.length === expectedBuf.length && timingSafeEqual(actualBuf, expectedBuf)) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// 1-to-1 Deterministic Handoff Joiner (Tenant-Isolated)
// ---------------------------------------------------------------------------

export interface RegisteredServerDocumentObservation {
  readonly observation_id: string
  readonly tenant_id: string
  readonly site_id: string
  readonly request_id: string
  readonly host: string
  readonly path: string
  readonly observed_at: string
  readonly is_prefetch: boolean
}

export interface SdkPageViewHandoffEvent {
  readonly tenant_id: string
  readonly site_id: string
  readonly pv_id: string
  /** Session/tab/client key used ONLY to distinguish same-client reuse vs cross-client shared cache */
  readonly client_key: string
  readonly nav_type: ClientNavigationType
  readonly host: string
  readonly path: string
  readonly observed_at: string
  readonly server_timing_raw?: string | null
}

export interface HandoffJoinResult {
  readonly matched: boolean
  readonly handoff_state: HandoffJoinState
  readonly tenant_id: string
  readonly site_id: string
  readonly pv_id: string
  readonly request_id: string | null
  readonly observation_id: string | null
  readonly time_delta_ms: number | null
  /** `true` when bfcache (`back_forward`), SPA (`soft`), `resume`, or `shared_cache` must be excluded from no-script denominator */
  readonly exclude_from_no_script_denominator: boolean
  readonly shared_cache_detected: boolean
  readonly reason: string
}

interface IndexedServerObs {
  readonly record: RegisteredServerDocumentObservation
  firstJoinedClientKey: string | null
  firstJoinedPvId: string | null
  sharedCacheDetected: boolean
}

export class ServerTimingHandoffJoiner {
  private readonly observations = new Map<string, IndexedServerObs>()

  constructor(
    private readonly options?: {
      readonly window_seconds?: number
      readonly edge_secret?: string | Buffer
    },
  ) {}

  private makeKey(tenantId: string, siteId: string, requestId: string): string {
    return `${tenantId}|${siteId}|${requestId}`
  }

  registerServerObservation(
    obs: Pick<
      ActorObservationRecord,
      | 'observation_id'
      | 'tenant_id'
      | 'site_id'
      | 'request_id'
      | 'host'
      | 'path'
      | 'observed_at'
      | 'is_prefetch'
    >,
  ): boolean {
    if (!obs.tenant_id.trim() || !obs.site_id.trim() || !obs.request_id) {
      return false
    }
    const key = this.makeKey(obs.tenant_id, obs.site_id, obs.request_id)
    if (this.observations.has(key)) return false

    this.observations.set(key, {
      record: Object.freeze({
        observation_id: obs.observation_id,
        tenant_id: obs.tenant_id,
        site_id: obs.site_id,
        request_id: obs.request_id,
        host: obs.host.trim().toLowerCase(),
        path: obs.path || '/',
        observed_at: obs.observed_at,
        is_prefetch: obs.is_prefetch,
      }),
      firstJoinedClientKey: null,
      firstJoinedPvId: null,
      sharedCacheDetected: false,
    })
    return true
  }

  joinPageView(event: SdkPageViewHandoffEvent): HandoffJoinResult {
    // 1. bfcache (`back_forward`), SPA (`soft`), `resume` NEVER hit server with fresh HTML
    //    -> automatically excluded from the no-script denominator (§7.4, act.G6)
    if (
      event.nav_type === 'back_forward' ||
      event.nav_type === 'soft' ||
      event.nav_type === 'resume'
    ) {
      const parsed = parseServerTimingHandoffHeader(event.server_timing_raw)
      return Object.freeze({
        matched: false,
        handoff_state: event.nav_type === 'soft' ? 'inherited' : 'reused',
        tenant_id: event.tenant_id,
        site_id: event.site_id,
        pv_id: event.pv_id,
        request_id: parsed?.request_id ?? null,
        observation_id: null,
        time_delta_ms: null,
        exclude_from_no_script_denominator: true,
        shared_cache_detected: false,
        reason: `excluded_non_document_navigation:${event.nav_type}`,
      })
    }

    const parsed = parseServerTimingHandoffHeader(event.server_timing_raw)
    if (!parsed) {
      return Object.freeze({
        matched: false,
        handoff_state: 'missing',
        tenant_id: event.tenant_id,
        site_id: event.site_id,
        pv_id: event.pv_id,
        request_id: null,
        observation_id: null,
        time_delta_ms: null,
        exclude_from_no_script_denominator: false,
        shared_cache_detected: false,
        reason: 'missing_or_malformed_server_timing',
      })
    }

    // 2. Optional edge HMAC check
    if (this.options?.edge_secret !== undefined) {
      const macOk = verifyServerTimingHandoffMac(parsed, {
        host: event.host,
        path: event.path,
        edge_secret: this.options.edge_secret,
      })
      if (!macOk) {
        return Object.freeze({
          matched: false,
          handoff_state: 'invalid_mac',
          tenant_id: event.tenant_id,
          site_id: event.site_id,
          pv_id: event.pv_id,
          request_id: parsed.request_id,
          observation_id: null,
          time_delta_ms: null,
          exclude_from_no_script_denominator: false,
          shared_cache_detected: false,
          reason: 'handoff_mac_verification_failed',
        })
      }
    }

    // 3. Lookup tenant/site/request_id
    const key = this.makeKey(event.tenant_id, event.site_id, parsed.request_id)
    const entry = this.observations.get(key)
    if (!entry) {
      return Object.freeze({
        matched: false,
        handoff_state: 'unmatched_server_obs',
        tenant_id: event.tenant_id,
        site_id: event.site_id,
        pv_id: event.pv_id,
        request_id: parsed.request_id,
        observation_id: null,
        time_delta_ms: null,
        exclude_from_no_script_denominator: false,
        shared_cache_detected: false,
        reason: 'server_observation_not_found',
      })
    }

    // 4. Exact host & path match
    const normHost = event.host.trim().toLowerCase()
    const normPath = event.path || '/'
    if (entry.record.host !== normHost || entry.record.path !== normPath) {
      return Object.freeze({
        matched: false,
        handoff_state: 'host_path_mismatch',
        tenant_id: event.tenant_id,
        site_id: event.site_id,
        pv_id: event.pv_id,
        request_id: parsed.request_id,
        observation_id: null,
        time_delta_ms: null,
        exclude_from_no_script_denominator: false,
        shared_cache_detected: false,
        reason: 'host_or_path_mismatch',
      })
    }

    // 5. ±120s window check
    const windowMs = (this.options?.window_seconds ?? HANDOFF_JOIN_WINDOW_SECONDS) * 1000
    const pvMs = Date.parse(event.observed_at)
    const obsMs = Date.parse(entry.record.observed_at)
    const deltaMs = pvMs - obsMs
    if (Number.isNaN(deltaMs) || Math.abs(deltaMs) > windowMs) {
      return Object.freeze({
        matched: false,
        handoff_state: 'window_expired',
        tenant_id: event.tenant_id,
        site_id: event.site_id,
        pv_id: event.pv_id,
        request_id: parsed.request_id,
        observation_id: null,
        time_delta_ms: Number.isNaN(deltaMs) ? null : deltaMs,
        exclude_from_no_script_denominator: false,
        shared_cache_detected: false,
        reason: `time_delta_exceeded_window:${deltaMs}ms`,
      })
    }

    // 6. Duplicate request_id detection (shared front-cache vs same-client reuse)
    if (entry.firstJoinedClientKey !== null) {
      if (entry.firstJoinedClientKey !== event.client_key) {
        entry.sharedCacheDetected = true
        return Object.freeze({
          matched: false,
          handoff_state: 'shared_cache',
          tenant_id: event.tenant_id,
          site_id: event.site_id,
          pv_id: event.pv_id,
          request_id: parsed.request_id,
          observation_id: null,
          time_delta_ms: deltaMs,
          exclude_from_no_script_denominator: true,
          shared_cache_detected: true,
          reason: 'duplicate_request_id_across_distinct_clients_shared_cache',
        })
      }

      return Object.freeze({
        matched: false,
        handoff_state: 'reused',
        tenant_id: event.tenant_id,
        site_id: event.site_id,
        pv_id: event.pv_id,
        request_id: parsed.request_id,
        observation_id: entry.record.observation_id,
        time_delta_ms: deltaMs,
        exclude_from_no_script_denominator: true,
        shared_cache_detected: entry.sharedCacheDetected,
        reason: 'same_client_reused_request_id',
      })
    }

    // 7. 1-to-1 deterministic join succeeds!
    entry.firstJoinedClientKey = event.client_key
    entry.firstJoinedPvId = event.pv_id
    return Object.freeze({
      matched: true,
      handoff_state: 'fresh',
      tenant_id: event.tenant_id,
      site_id: event.site_id,
      pv_id: event.pv_id,
      request_id: parsed.request_id,
      observation_id: entry.record.observation_id,
      time_delta_ms: deltaMs,
      exclude_from_no_script_denominator: false,
      shared_cache_detected: false,
      reason: 'joined_1to1',
    })
  }
}

// ---------------------------------------------------------------------------
// Zero-Verdict Client ACK Guard (§7.4, Gate `act.G7`)
// ---------------------------------------------------------------------------

/**
 * ブラウザ SDK へ返却してよい最小 ACK ペイロード。
 * 行為者判定・ボット判定・検証結果・観測IDは一切含めない (`act.G7`)。
 */
export interface SafeClientHandoffAck {
  readonly ok: true
  readonly pv_id: string
  readonly accepted_at: string
  readonly handoff_received: boolean
}

const FORBIDDEN_CLIENT_ACK_KEYS = new Set([
  'actor_class',
  'verified_actor_id',
  'verified_operator',
  'declared_actor_id',
  'declared_operator',
  'identity_assurance',
  'verification_result',
  'verdict',
  'verdict_id',
  'verdict_version',
  'is_agent',
  'is_bot',
  'is_human',
  'bot_score',
  'ip_trust',
  'ip_spoofable',
  'shared_cache_detected',
  'observation_id',
  'reporting_label',
])

export function buildSafeClientAck(
  joinResult: HandoffJoinResult,
  acceptedAt: string,
): SafeClientHandoffAck {
  const ack: SafeClientHandoffAck = Object.freeze({
    ok: true,
    pv_id: joinResult.pv_id,
    accepted_at: acceptedAt,
    handoff_received: joinResult.request_id !== null,
  })
  assertNoVerdictInClientAck(ack)
  return ack
}

/**
 * 任意のクライアント返却ペイロードに行為者判定・検証結果フィールドが 1 つでも含まれていないことを検証する。
 */
export function assertNoVerdictInClientAck(payload: unknown): void {
  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], `${path}[${i}]`)
      return
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const low = key.toLowerCase()
      if (FORBIDDEN_CLIENT_ACK_KEYS.has(low)) {
        throw new Error(
          `Client ACK verdict-leak violation (act.G7): forbidden field "${key}" found at ${path}.${key}`,
        )
      }
      walk(value, `${path}.${key}`)
    }
  }
  walk(payload, '$')
}

// ---------------------------------------------------------------------------
// No-Script Rate Calculation (Excluding bfcache / SPA / Prefetch)
// ---------------------------------------------------------------------------

export interface NoScriptRateResult {
  readonly denominator_document_requests: number
  readonly joined_with_js_count: number
  readonly unjoined_without_js_count: number
  readonly no_script_rate: number | null
  readonly excluded_prefetch_count: number
  readonly excluded_non_fresh_nav_count: number
}

export function computeNoScriptRate(params: {
  readonly server_document_count: number
  readonly joined_fresh_count: number
  readonly server_prefetch_count: number
  readonly excluded_bfcache_or_spa_count: number
  readonly shared_cache_collisions?: number
}): NoScriptRateResult {
  const excludedNonFresh =
    params.excluded_bfcache_or_spa_count + (params.shared_cache_collisions ?? 0)
  const denominator = Math.max(
    0,
    params.server_document_count - params.server_prefetch_count - (params.shared_cache_collisions ?? 0),
  )
  const joined = Math.min(params.joined_fresh_count, denominator)
  const unjoined = Math.max(0, denominator - joined)
  const rate = denominator > 0 ? unjoined / denominator : null

  return Object.freeze({
    denominator_document_requests: denominator,
    joined_with_js_count: joined,
    unjoined_without_js_count: unjoined,
    no_script_rate: rate,
    excluded_prefetch_count: params.server_prefetch_count,
    excluded_non_fresh_nav_count: excludedNonFresh,
  })
}
