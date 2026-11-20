/**
 * UGOKI LINK v2 — 束 0-D: 取り戻せない時計 (Irrecoverable Clock)
 *
 * AI事業者・検索エンジンの公開IP範囲一覧 (JSON / SAIL TOML) および
 * RFC 9421 Web Bot Auth 公開鍵ディレクトリ (JWKS) を定期取得し、
 * 改変不能なタイムスタンプ付きスナップショットとして追記保存・過去時点照会する。
 *
 * 設計根拠:
 * - マスター設計書 v2 §7.1, §7.2, §13.1
 * - actors-final.md M1, M2, C.M1, C.M2, C.S
 * - facts/web-ai-agents.md §1–§8, §16
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

export type EvidenceSourceKind = 'ip_json' | 'sail_toml' | 'rfc9421_jwks'

export type ExhaustiveBasis = 'sail_flag' | 'vendor_statement' | 'none'

export type ExclusiveScope = 'token' | 'operator' | 'none'

/**
 * §13.1: 手順 0 では毎晩 1 回 (`nightly_wave0`) から開始し、
 * 手順 10 までに本番ポーリング周期 (`production_poll`: IP 8時間、SAIL 20分、JWKS Cache-Control) へ移行する。
 * `nightly_wave0` の間は網羅一覧でも `refuted` を出さず `feed_miss` として扱う。
 */
export type ClockCadenceMode = 'nightly_wave0' | 'production_poll'

export type EvidenceVerificationResult =
  | 'verified'
  | 'verified_operator'
  | 'verified_retro'
  | 'refuted'
  | 'feed_miss'
  | 'late_published'
  | 'unverifiable_no_method'
  | 'unverifiable_stale_evidence'

export interface EvidenceSourceDefinition {
  readonly source_id: string
  readonly provider: string
  readonly actor_tokens: readonly string[]
  readonly source_url: string
  readonly source_kind: EvidenceSourceKind
  /** ソース仕様上の網羅性宣言 (SAIL はペイロード内のフラグも優先評価) */
  readonly is_exhaustive: boolean
  readonly exhaustive_basis: ExhaustiveBasis
  readonly exclusive_scope: ExclusiveScope
  /** 本番ポーリング間隔（秒）: IP=28800(8h), SAIL=1200(20m), JWKS=Cache-Control(300..86400) */
  readonly poll_interval_seconds: number
  /** デフォルト有効期限（秒）: Cache-Control / SAIL expires が無い場合の基準 */
  readonly default_ttl_seconds: number
  /** SAIL ファイル内で対象エージェント節を絞る場合のキー名 (例: "Claude-Agent") */
  readonly sail_agent_name?: string
}

export interface Rfc9421Jwk {
  readonly kty: string
  readonly crv?: string
  readonly x?: string
  readonly y?: string
  readonly n?: string
  readonly e?: string
  readonly kid?: string
  readonly alg?: string
  readonly use?: string
  readonly nbf?: number
  readonly exp?: number
  readonly signature_agent?: string
  readonly purpose?: string
  /** RFC 7638 SHA-256 JWK Thumbprint (base64url) */
  readonly thumbprint_sha256: string
}

export interface ActorEvidenceSnapshot {
  readonly snapshot_id: string
  readonly source_id: string
  readonly provider: string
  readonly actor_tokens: readonly string[]
  readonly source_url: string
  readonly source_kind: EvidenceSourceKind
  /** UTC ISO-8601 */
  readonly fetched_at: string
  /** UTC ISO-8601 (Cache-Control / SAIL expires / default_ttl_seconds から算出) */
  readonly valid_until: string
  readonly cadence_mode: ClockCadenceMode
  readonly is_exhaustive: boolean
  readonly exhaustive_basis: ExhaustiveBasis
  readonly exclusive_scope: ExclusiveScope
  readonly http_status: number
  readonly etag: string | null
  readonly cache_control: string | null
  readonly creation_time: string | null
  /** 生レスポンスバイト列の SHA-256 (64 hex) */
  readonly sha256: string
  readonly raw_bytes_length: number
  /** 正規化・ソート済み一意 CIDR 一覧 (IPv4 / IPv6) */
  readonly cidrs: readonly string[]
  /** RFC 9421 公開鍵一覧 */
  readonly jwks: readonly Rfc9421Jwk[]
}

export interface SnapshotDiff {
  readonly source_id: string
  readonly previous_snapshot_id: string | null
  readonly current_snapshot_id: string
  readonly content_changed: boolean
  readonly added_cidrs: readonly string[]
  readonly removed_cidrs: readonly string[]
  /** (added + removed) / max(prevCount, nextCount, 1) */
  readonly cidr_churn_ratio: number
  readonly added_key_thumbprints: readonly string[]
  readonly removed_key_thumbprints: readonly string[]
}

export type ClockAlertKind =
  | 'prefix_churn_exceeded'
  | 'key_expiring_soon'
  | 'key_expired'
  | 'fetch_failed'
  | 'source_stale'

export interface ClockAlert {
  readonly kind: ClockAlertKind
  readonly severity: 'warn' | 'critical'
  readonly source_id: string
  readonly provider: string
  readonly detected_at: string
  readonly message: string
  readonly details: Readonly<Record<string, string | number | boolean>>
}

export interface EvidenceFetchResponse {
  readonly status: number
  readonly body: Uint8Array | string
  readonly headers?: Readonly<Record<string, string | undefined>>
  readonly redirected?: boolean
}

export type EvidenceFetcher = (
  url: string,
  options: { readonly redirect: 'error' | 'follow'; readonly maxBytes: number },
) => Promise<EvidenceFetchResponse>

export interface CaptureSourceResult {
  readonly ok: boolean
  readonly source_id: string
  readonly snapshot: ActorEvidenceSnapshot | null
  readonly diff: SnapshotDiff | null
  readonly alerts: readonly ClockAlert[]
  readonly error?: string
}

export interface AsOfSnapshotLookup {
  readonly snapshot: ActorEvidenceSnapshot
  /** `at_or_before`: 対象時刻以前の最新 / `retro`: アーカイブ開始前なので最古を遡及参照 */
  readonly relation: 'at_or_before' | 'retro'
  readonly snapshot_distance_days: number
  readonly is_stale: boolean
}

export interface HistoricalIpLookupQuery {
  readonly ip: string
  /** UTC ISO-8601 */
  readonly at: string
  readonly source_id?: string
  readonly provider?: string
  readonly actor_token?: string
}

export interface HistoricalIpLookupResult {
  readonly ip: string
  readonly at: string
  readonly matched: boolean
  readonly verification_result: EvidenceVerificationResult
  readonly matched_cidr: string | null
  readonly prefix_length: number | null
  readonly provider: string | null
  readonly source_id: string | null
  readonly actor_tokens: readonly string[]
  readonly snapshot_id: string | null
  readonly snapshot_fetched_at: string | null
  readonly snapshot_sha256: string | null
  readonly is_exhaustive: boolean
  readonly exclusive_scope: ExclusiveScope
  readonly snapshot_distance_days: number | null
  readonly checked_sources: readonly string[]
  readonly consecutive_misses: number
}

export interface HistoricalKeyLookupQuery {
  readonly thumbprint_or_kid: string
  /** UTC ISO-8601 */
  readonly at: string
  readonly source_id?: string
  readonly provider?: string
}

export interface HistoricalKeyLookupResult {
  readonly found: boolean
  readonly valid_at_time: boolean
  readonly key: Rfc9421Jwk | null
  readonly provider: string | null
  readonly source_id: string | null
  readonly snapshot_id: string | null
  readonly snapshot_fetched_at: string | null
  readonly snapshot_sha256: string | null
  readonly relation: 'at_or_before' | 'retro' | null
  readonly snapshot_distance_days: number | null
  readonly reason: 'valid' | 'not_found' | 'not_yet_valid' | 'expired' | 'stale_snapshot' | 'no_snapshot'
}

export class SnapshotImmutabilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotImmutabilityError'
  }
}

export class EvidenceParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvidenceParseError'
  }
}

/**
 * robots.txt 専用の方針トークン（HTTP リクエストには一切出現しない）。
 * actors-final.md M1 / master-architecture-v2.md §7.1 準拠。
 */
export const POLICY_ONLY_TOKENS = Object.freeze([
  'Google-Extended',
  'Applebot-Extended',
  '__usage_ai-training',
] as const)

/** 20% 超のプレフィックス変動でアラート (actors-final.md C.M1) */
export const PREFIX_CHURN_ALERT_THRESHOLD = 0.2
/** 鍵有効期限 7 日以内でアラート (actors-final.md C.M1) */
export const KEY_EXPIRY_ALERT_WINDOW_SECONDS = 7 * 24 * 60 * 60
/** JWKS ディレクトリのレスポンスサイズ上限 64 KiB (actors-final.md C.M2) */
export const JWKS_MAX_BYTES = 64 * 1024
/** IP フィードのレスポンスサイズ上限 2 MiB */
export const IP_FEED_MAX_BYTES = 2 * 1024 * 1024
/** JWKS キャッシュ TTL 下限 5 分 / 上限 24 時間 (actors-final.md C.S) */
export const JWKS_MIN_TTL_SECONDS = 5 * 60
export const JWKS_MAX_TTL_SECONDS = 24 * 60 * 60

// ---------------------------------------------------------------------------
// Default Official Evidence Sources Registry (facts/web-ai-agents.md)
// ---------------------------------------------------------------------------

export const DEFAULT_EVIDENCE_SOURCES: readonly EvidenceSourceDefinition[] = Object.freeze([
  // OpenAI
  Object.freeze({
    source_id: 'openai:oai-searchbot',
    provider: 'openai',
    actor_tokens: Object.freeze(['OAI-SearchBot']),
    source_url: 'https://openai.com/searchbot.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'none',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),
  Object.freeze({
    source_id: 'openai:gptbot',
    provider: 'openai',
    actor_tokens: Object.freeze(['GPTBot']),
    source_url: 'https://openai.com/gptbot.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'none',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),
  Object.freeze({
    source_id: 'openai:chatgpt-user',
    provider: 'openai',
    actor_tokens: Object.freeze(['ChatGPT-User']),
    source_url: 'https://openai.com/chatgpt-user.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'none',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),
  Object.freeze({
    source_id: 'openai:oai-adsbot',
    provider: 'openai',
    actor_tokens: Object.freeze(['OAI-AdsBot']),
    source_url: 'https://openai.com/adsbot.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'none',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),
  Object.freeze({
    source_id: 'openai:chatgpt-cloud-browser-jwks',
    provider: 'openai',
    actor_tokens: Object.freeze(['ChatGPT-Agent']),
    source_url: 'https://chatgpt.com/.well-known/http-message-signatures-directory',
    source_kind: 'rfc9421_jwks',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'token',
    poll_interval_seconds: 3600,
    default_ttl_seconds: 24 * 3600,
  }),

  // Anthropic
  Object.freeze({
    source_id: 'anthropic:bots',
    provider: 'anthropic',
    actor_tokens: Object.freeze(['ClaudeBot', 'Claude-User', 'Claude-SearchBot']),
    source_url: 'https://claude.com/crawling/bots.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'operator',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),
  Object.freeze({
    source_id: 'anthropic:claude-agent-sail',
    provider: 'anthropic',
    actor_tokens: Object.freeze(['Claude-Agent']),
    source_url: 'https://claude.com/.well-known/sail',
    source_kind: 'sail_toml',
    is_exhaustive: true,
    exhaustive_basis: 'sail_flag',
    exclusive_scope: 'token',
    poll_interval_seconds: 20 * 60,
    default_ttl_seconds: 3600,
    sail_agent_name: 'Claude-Agent',
  }),

  // Perplexity
  Object.freeze({
    source_id: 'perplexity:perplexitybot',
    provider: 'perplexity',
    actor_tokens: Object.freeze(['PerplexityBot']),
    source_url: 'https://www.perplexity.ai/perplexitybot.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'none',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),
  Object.freeze({
    source_id: 'perplexity:perplexity-user',
    provider: 'perplexity',
    actor_tokens: Object.freeze(['Perplexity-User']),
    source_url: 'https://www.perplexity.ai/perplexity-user.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'none',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),

  // Google
  Object.freeze({
    source_id: 'google:common-crawlers',
    provider: 'google',
    actor_tokens: Object.freeze(['Googlebot', 'GoogleOther']),
    source_url: 'https://developers.google.com/static/crawling/ipranges/common-crawlers.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'operator',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),
  Object.freeze({
    source_id: 'google:special-crawlers',
    provider: 'google',
    actor_tokens: Object.freeze(['AdsBot-Google', 'Google-CloudVertexBot']),
    source_url: 'https://developers.google.com/static/crawling/ipranges/special-crawlers.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'operator',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),
  Object.freeze({
    source_id: 'google:user-triggered-fetchers',
    provider: 'google',
    actor_tokens: Object.freeze(['Google-GeminiNotebook', 'Google-Read-Aloud', 'Google-Pinpoint']),
    source_url: 'https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'operator',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),
  Object.freeze({
    source_id: 'google:user-triggered-fetchers-google',
    provider: 'google',
    actor_tokens: Object.freeze(['Google-UserTriggeredFetcher']),
    source_url: 'https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'operator',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),
  Object.freeze({
    source_id: 'google:user-triggered-agents',
    provider: 'google',
    actor_tokens: Object.freeze(['Google-Agent']),
    source_url: 'https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'operator',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),
  Object.freeze({
    source_id: 'google:google-agent-jwks',
    provider: 'google',
    actor_tokens: Object.freeze(['Google-Agent']),
    source_url: 'https://agent.bot.goog/.well-known/http-message-signatures-directory',
    source_kind: 'rfc9421_jwks',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'token',
    poll_interval_seconds: 3600,
    default_ttl_seconds: 24 * 3600,
  }),

  // Apple
  Object.freeze({
    source_id: 'apple:applebot',
    provider: 'apple',
    actor_tokens: Object.freeze(['Applebot']),
    source_url: 'https://search.developer.apple.com/applebot.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'operator',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),

  // Bing / Microsoft
  Object.freeze({
    source_id: 'bing:bingbot',
    provider: 'bing',
    actor_tokens: Object.freeze(['bingbot', 'adidxbot', 'MicrosoftPreview']),
    source_url: 'https://www.bing.com/toolbox/bingbot.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'operator',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),

  // Amazon
  Object.freeze({
    source_id: 'amazon:amazonbot',
    provider: 'amazon',
    actor_tokens: Object.freeze(['Amazonbot', 'Amzn-SearchBot', 'Amzn-User']),
    source_url: 'https://developer.amazon.com/amazonbot/ip-addresses/amazonbot.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'operator',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),

  // Common Crawl, Mistral, DuckDuckGo, You.com
  Object.freeze({
    source_id: 'commoncrawl:ccbot',
    provider: 'commoncrawl',
    actor_tokens: Object.freeze(['CCBot']),
    source_url: 'https://index.commoncrawl.org/ccbot.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'operator',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),
  Object.freeze({
    source_id: 'mistral:user',
    provider: 'mistral',
    actor_tokens: Object.freeze(['MistralAI-User']),
    source_url: 'https://mistral.ai/mistralai-user-ips.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'none',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),
  Object.freeze({
    source_id: 'mistral:index',
    provider: 'mistral',
    actor_tokens: Object.freeze(['MistralAI-Index']),
    source_url: 'https://mistral.ai/mistralai-index-ips.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'none',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),
  Object.freeze({
    source_id: 'duckduckgo:duckassistbot',
    provider: 'duckduckgo',
    actor_tokens: Object.freeze(['DuckAssistBot']),
    source_url: 'https://duckduckgo.com/duckassistbot.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'none',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),
  Object.freeze({
    source_id: 'duckduckgo:duckduckbot',
    provider: 'duckduckgo',
    actor_tokens: Object.freeze(['DuckDuckBot']),
    source_url: 'https://duckduckgo.com/duckduckbot.json',
    source_kind: 'ip_json',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'none',
    poll_interval_seconds: 8 * 3600,
    default_ttl_seconds: 24 * 3600,
  }),
  Object.freeze({
    source_id: 'you:youbot-jwks',
    provider: 'you',
    actor_tokens: Object.freeze(['YouBot']),
    source_url: 'https://you.com/.well-known/http-message-signatures-directory',
    source_kind: 'rfc9421_jwks',
    is_exhaustive: false,
    exhaustive_basis: 'none',
    exclusive_scope: 'token',
    poll_interval_seconds: 3600,
    default_ttl_seconds: 24 * 3600,
  }),
])

// ---------------------------------------------------------------------------
// IPv4 / IPv6 & CIDR Parsing + Longest-Prefix Match
// ---------------------------------------------------------------------------

export interface ParsedIp {
  readonly family: 4 | 6
  readonly value: bigint
}

export interface ParsedCidr {
  readonly family: 4 | 6
  readonly network: bigint
  readonly prefixLength: number
  readonly canonical: string
}

const IPV4_MAX = (1n << 32n) - 1n
const IPV6_MAX = (1n << 128n) - 1n

export function parseIpv4(input: string): bigint | null {
  const parts = input.split('.')
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null
    const num = Number(part)
    if (num < 0 || num > 255) return null
    value = (value << 8n) | BigInt(num)
  }
  return value
}

export function formatIpv4(value: bigint): string {
  const clamped = value & IPV4_MAX
  const a = Number((clamped >> 24n) & 0xffn)
  const b = Number((clamped >> 16n) & 0xffn)
  const c = Number((clamped >> 8n) & 0xffn)
  const d = Number(clamped & 0xffn)
  return `${a}.${b}.${c}.${d}`
}

export function parseIpv6(input: string): bigint | null {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed || trimmed.includes('%')) return null
  const doubleColonParts = trimmed.split('::')
  if (doubleColonParts.length > 2) return null

  const parseGroups = (section: string): number[] | null => {
    if (section === '') return []
    const tokens = section.split(':')
    const out: number[] = []
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]
      if (tok.includes('.')) {
        // IPv4-embedded suffix must be the final token
        if (i !== tokens.length - 1) return null
        const v4 = parseIpv4(tok)
        if (v4 === null) return null
        out.push(Number((v4 >> 16n) & 0xffffn))
        out.push(Number(v4 & 0xffffn))
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null
        out.push(parseInt(tok, 16))
      }
    }
    return out
  }

  let groups: number[]
  if (doubleColonParts.length === 1) {
    const parsed = parseGroups(doubleColonParts[0])
    if (!parsed || parsed.length !== 8) return null
    groups = parsed
  } else {
    const left = parseGroups(doubleColonParts[0])
    const right = parseGroups(doubleColonParts[1])
    if (!left || !right) return null
    const missing = 8 - (left.length + right.length)
    if (missing < 1) return null
    groups = [...left, ...new Array<number>(missing).fill(0), ...right]
  }

  let value = 0n
  for (const g of groups) {
    value = (value << 16n) | BigInt(g)
  }
  return value
}

export function formatIpv6(value: bigint): string {
  const clamped = value & IPV6_MAX
  const groups: number[] = []
  for (let i = 7; i >= 0; i--) {
    groups.push(Number((clamped >> BigInt(i * 16)) & 0xffffn))
  }

  // RFC 5952 longest run of >= 2 zero groups
  let bestStart = -1
  let bestLen = 0
  let curStart = -1
  let curLen = 0
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curStart === -1) curStart = i
      curLen++
      if (curLen > bestLen) {
        bestStart = curStart
        bestLen = curLen
      }
    } else {
      curStart = -1
      curLen = 0
    }
  }

  if (bestLen < 2) {
    return groups.map((g) => g.toString(16)).join(':')
  }
  const left = groups
    .slice(0, bestStart)
    .map((g) => g.toString(16))
    .join(':')
  const right = groups
    .slice(bestStart + bestLen)
    .map((g) => g.toString(16))
    .join(':')
  return `${left}::${right}`
}

export function parseIp(input: string): ParsedIp | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (trimmed.includes(':')) {
    const v6 = parseIpv6(trimmed)
    return v6 === null ? null : { family: 6, value: v6 }
  }
  const v4 = parseIpv4(trimmed)
  return v4 === null ? null : { family: 4, value: v4 }
}

export function parseCidr(input: string): ParsedCidr | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const slashIdx = trimmed.indexOf('/')
  const ipPart = slashIdx >= 0 ? trimmed.slice(0, slashIdx) : trimmed
  const prefixPart = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : null

  const ip = parseIp(ipPart)
  if (!ip) return null

  const maxBits = ip.family === 4 ? 32 : 128
  let prefixLength = maxBits
  if (prefixPart !== null) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(prefixPart)) return null
    prefixLength = Number(prefixPart)
    if (prefixLength < 0 || prefixLength > maxBits) return null
  }

  const hostBits = BigInt(maxBits - prefixLength)
  const mask = prefixLength === 0 ? 0n : ((1n << BigInt(maxBits)) - 1n) ^ ((1n << hostBits) - 1n)
  const network = ip.value & mask
  const formattedIp = ip.family === 4 ? formatIpv4(network) : formatIpv6(network)
  return {
    family: ip.family,
    network,
    prefixLength,
    canonical: `${formattedIp}/${prefixLength}`,
  }
}

export function ipMatchesCidr(ip: ParsedIp, cidr: ParsedCidr): boolean {
  if (ip.family !== cidr.family) return false
  if (cidr.prefixLength === 0) return true
  const totalBits = ip.family === 4 ? 32 : 128
  const shift = BigInt(totalBits - cidr.prefixLength)
  return (ip.value >> shift) === (cidr.network >> shift)
}

export function matchIpInCidrs(
  ipStr: string,
  cidrs: readonly string[],
): { readonly matched: boolean; readonly matchedCidr: string | null; readonly prefixLength: number | null } {
  const ip = parseIp(ipStr)
  if (!ip) {
    return { matched: false, matchedCidr: null, prefixLength: null }
  }
  let bestCidr: string | null = null
  let bestPrefix = -1
  for (const raw of cidrs) {
    const parsed = parseCidr(raw)
    if (!parsed) continue
    if (ipMatchesCidr(ip, parsed) && parsed.prefixLength > bestPrefix) {
      bestPrefix = parsed.prefixLength
      bestCidr = parsed.canonical
    }
  }
  if (bestCidr === null) {
    return { matched: false, matchedCidr: null, prefixLength: null }
  }
  return { matched: true, matchedCidr: bestCidr, prefixLength: bestPrefix }
}

// ---------------------------------------------------------------------------
// Feed Parsers (IP JSON / SAIL TOML / RFC 9421 JWKS)
// ---------------------------------------------------------------------------

export interface ParsedFeedPayload {
  readonly cidrs: readonly string[]
  readonly jwks: readonly Rfc9421Jwk[]
  readonly creation_time: string | null
  readonly is_exhaustive_override: boolean | null
  readonly exclusive_scope_override: ExclusiveScope | null
  readonly expires_iso: string | null
  readonly ttl_seconds_override: number | null
}

function normalizeUniqueCidrs(rawList: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  for (const item of rawList) {
    const parsed = parseCidr(item)
    if (parsed) {
      seen.add(parsed.canonical)
    }
  }
  return Object.freeze(Array.from(seen).sort())
}

/**
 * Google / OpenAI / Anthropic / Perplexity / Apple / Bing / Amazon 等の
 * `draft-illyes-webbotauth-jafar-01` 形式および汎用 JSON IP フィードを解析する。
 */
export function parseIpJsonFeed(text: string): ParsedFeedPayload {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    throw new EvidenceParseError(`Invalid IP JSON feed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const rawCidrs: string[] = []
  let creationTime: string | null = null

  if (Array.isArray(doc)) {
    for (const item of doc) {
      if (typeof item === 'string') rawCidrs.push(item)
    }
  } else if (doc && typeof doc === 'object') {
    const obj = doc as Record<string, unknown>
    if (typeof obj.creationTime === 'string') {
      creationTime = obj.creationTime
    } else if (typeof obj.creation_time === 'string') {
      creationTime = obj.creation_time
    } else if (typeof obj.updated === 'string') {
      creationTime = obj.updated
    }

    const prefixes = obj.prefixes
    if (Array.isArray(prefixes)) {
      for (const entry of prefixes) {
        if (typeof entry === 'string') {
          rawCidrs.push(entry)
        } else if (entry && typeof entry === 'object') {
          const rec = entry as Record<string, unknown>
          if (typeof rec.ipv4Prefix === 'string') rawCidrs.push(rec.ipv4Prefix)
          if (typeof rec.ipv6Prefix === 'string') rawCidrs.push(rec.ipv6Prefix)
          if (typeof rec.cidr === 'string') rawCidrs.push(rec.cidr)
          if (typeof rec.ip_prefix === 'string') rawCidrs.push(rec.ip_prefix)
          if (typeof rec.ipv6_prefix === 'string') rawCidrs.push(rec.ipv6_prefix)
        }
      }
    }

    for (const key of ['cidrs', 'ips', 'ipv4', 'ipv6', 'addresses']) {
      const arr = obj[key]
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === 'string') rawCidrs.push(item)
        }
      }
    }
  } else {
    throw new EvidenceParseError('IP JSON feed root must be an object or array')
  }

  return {
    cidrs: normalizeUniqueCidrs(rawCidrs),
    jwks: Object.freeze([]),
    creation_time: creationTime,
    is_exhaustive_override: null,
    exclusive_scope_override: null,
    expires_iso: null,
    ttl_seconds_override: null,
  }
}

function stripTomlComment(line: string): string {
  let inDouble = false
  let inSingle = false
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\' && inDouble) {
      escaped = true
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (ch === '#' && !inDouble && !inSingle) {
      return line.slice(0, i)
    }
  }
  return line
}

function unquoteTomlString(raw: string): string {
  const t = raw.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

function parseTomlStringArray(rawValue: string): string[] {
  const out: string[] = []
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'/g
  let match: RegExpExecArray | null
  while ((match = re.exec(rawValue)) !== null) {
    out.push(match[1] ?? match[2] ?? '')
  }
  return out
}

/**
 * `draft-kelley-webbotauth-sail-00` (Source Address Identity List) TOML パーサー。
 * 外部依存なしでトップレベルおよび `[agents."<name>"]` / `[<name>]` セクションを解析する。
 */
export function parseSailTomlFeed(text: string, targetAgentName?: string): ParsedFeedPayload {
  const rawLines = text.split(/\r?\n/)
  const sections = new Map<string, Record<string, string>>()
  let currentSection = '__root__'
  sections.set(currentSection, {})

  let pendingKey: string | null = null
  let pendingValue = ''
  let bracketDepth = 0

  const commitKeyValue = (secName: string, key: string, val: string): void => {
    let rec = sections.get(secName)
    if (!rec) {
      rec = {}
      sections.set(secName, rec)
    }
    rec[key.trim().toLowerCase()] = val.trim()
  }

  for (const rawLine of rawLines) {
    const cleaned = stripTomlComment(rawLine).trim()
    if (!cleaned) continue

    if (pendingKey !== null) {
      pendingValue += ' ' + cleaned
      for (const ch of cleaned) {
        if (ch === '[') bracketDepth++
        else if (ch === ']') bracketDepth--
      }
      if (bracketDepth <= 0) {
        commitKeyValue(currentSection, pendingKey, pendingValue)
        pendingKey = null
        pendingValue = ''
        bracketDepth = 0
      }
      continue
    }

    if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
      const header = cleaned.slice(1, -1).trim()
      currentSection = header
      if (!sections.has(currentSection)) {
        sections.set(currentSection, {})
      }
      continue
    }

    const eqIdx = cleaned.indexOf('=')
    if (eqIdx <= 0) continue
    const key = cleaned.slice(0, eqIdx).trim()
    const val = cleaned.slice(eqIdx + 1).trim()

    if (val.startsWith('[')) {
      let depth = 0
      for (const ch of val) {
        if (ch === '[') depth++
        else if (ch === ']') depth--
      }
      if (depth > 0) {
        pendingKey = key
        pendingValue = val
        bracketDepth = depth
        continue
      }
    }
    commitKeyValue(currentSection, key, val)
  }

  const root = sections.get('__root__') ?? {}

  // 対象セクションの選択
  const selectedSections: Array<Record<string, string>> = []
  if (targetAgentName) {
    const targetLower = targetAgentName.toLowerCase()
    for (const [secHeader, kv] of sections.entries()) {
      if (secHeader === '__root__') continue
      const normalizedHeader = secHeader
        .split('.')
        .map((part) => unquoteTomlString(part).toLowerCase())
      if (
        normalizedHeader.includes(targetLower) ||
        unquoteTomlString(secHeader).toLowerCase() === targetLower
      ) {
        selectedSections.push(kv)
      }
    }
  }
  if (selectedSections.length === 0) {
    // ターゲット未指定またはトップレベル配列の場合、全セクションを統合
    for (const kv of sections.values()) {
      selectedSections.push(kv)
    }
  }

  const rawCidrs: string[] = []
  let exhaustiveFlag: boolean | null = null
  let exclusiveFlag: boolean | null = null
  let expiresIso: string | null = null
  let ttlOverride: number | null = null

  const applyMeta = (kv: Record<string, string>): void => {
    if (kv.exhaustive === 'true') exhaustiveFlag = true
    else if (kv.exhaustive === 'false') exhaustiveFlag = false

    if (kv.exclusive === 'true') exclusiveFlag = true
    else if (kv.exclusive === 'false') exclusiveFlag = false

    const rawExp = kv.expires ?? kv.valid_until
    if (rawExp) {
      const unq = unquoteTomlString(rawExp)
      const parsedMs = Date.parse(unq)
      if (!Number.isNaN(parsedMs)) {
        expiresIso = new Date(parsedMs).toISOString()
      }
    }

    const rawTtl = kv.ttl ?? kv.ttl_seconds ?? kv.max_age
    if (rawTtl && /^\d+$/.test(rawTtl)) {
      ttlOverride = Number(rawTtl)
    }
  }

  applyMeta(root)
  for (const kv of selectedSections) {
    applyMeta(kv)
    for (const field of ['ipv4', 'ipv6', 'cidrs', 'prefixes', 'addresses', 'ips']) {
      if (kv[field]) {
        rawCidrs.push(...parseTomlStringArray(kv[field]))
      }
    }
  }

  return {
    cidrs: normalizeUniqueCidrs(rawCidrs),
    jwks: Object.freeze([]),
    creation_time: root.modified ? unquoteTomlString(root.modified) : null,
    is_exhaustive_override: exhaustiveFlag,
    exclusive_scope_override:
      exclusiveFlag === true ? (targetAgentName ? 'token' : 'operator') : exclusiveFlag === false ? 'none' : null,
    expires_iso: expiresIso,
    ttl_seconds_override: ttlOverride,
  }
}

/**
 * RFC 7638 JWK SHA-256 Thumbprint (base64url) を計算する。
 */
export function computeJwkThumbprintSha256(jwk: Record<string, unknown>): string {
  const kty = typeof jwk.kty === 'string' ? jwk.kty : ''
  let canonical: string
  if (kty === 'OKP') {
    canonical = JSON.stringify({ crv: jwk.crv, kty: 'OKP', x: jwk.x })
  } else if (kty === 'EC') {
    canonical = JSON.stringify({ crv: jwk.crv, kty: 'EC', x: jwk.x, y: jwk.y })
  } else if (kty === 'RSA') {
    canonical = JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n })
  } else {
    // 未知の鍵型でも決定的キーソート JSON でフォールバック計算
    const sortedKeys = Object.keys(jwk).sort()
    const ordered: Record<string, unknown> = {}
    for (const k of sortedKeys) ordered[k] = jwk[k]
    canonical = JSON.stringify(ordered)
  }
  return createHash('sha256').update(canonical, 'utf8').digest('base64url')
}

/**
 * RFC 9421 Web Bot Auth HTTP Message Signatures Directory (`/.well-known/http-message-signatures-directory`)
 * の JWKS ペイロードを解析する。
 */
export function parseRfc9421Jwks(text: string): ParsedFeedPayload {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    throw new EvidenceParseError(`Invalid RFC 9421 JWKS JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!doc || typeof doc !== 'object' || !Array.isArray((doc as Record<string, unknown>).keys)) {
    throw new EvidenceParseError('RFC 9421 JWKS payload must contain a "keys" array')
  }

  const rawKeys = (doc as { keys: unknown[] }).keys
  const jwks: Rfc9421Jwk[] = []

  for (const item of rawKeys) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (typeof rec.kty !== 'string') continue
    const thumbprint = computeJwkThumbprintSha256(rec)
    const entry: Rfc9421Jwk = Object.freeze({
      kty: rec.kty,
      ...(typeof rec.crv === 'string' ? { crv: rec.crv } : {}),
      ...(typeof rec.x === 'string' ? { x: rec.x } : {}),
      ...(typeof rec.y === 'string' ? { y: rec.y } : {}),
      ...(typeof rec.n === 'string' ? { n: rec.n } : {}),
      ...(typeof rec.e === 'string' ? { e: rec.e } : {}),
      ...(typeof rec.kid === 'string' ? { kid: rec.kid } : {}),
      ...(typeof rec.alg === 'string' ? { alg: rec.alg } : {}),
      ...(typeof rec.use === 'string' ? { use: rec.use } : {}),
      ...(typeof rec.nbf === 'number' && Number.isFinite(rec.nbf) ? { nbf: rec.nbf } : {}),
      ...(typeof rec.exp === 'number' && Number.isFinite(rec.exp) ? { exp: rec.exp } : {}),
      ...(typeof rec.signature_agent === 'string' ? { signature_agent: rec.signature_agent } : {}),
      ...(typeof rec.purpose === 'string' ? { purpose: rec.purpose } : {}),
      thumbprint_sha256: thumbprint,
    })
    jwks.push(entry)
  }

  jwks.sort((a, b) => a.thumbprint_sha256.localeCompare(b.thumbprint_sha256))

  return {
    cidrs: Object.freeze([]),
    jwks: Object.freeze(jwks),
    creation_time: null,
    is_exhaustive_override: null,
    exclusive_scope_override: null,
    expires_iso: null,
    ttl_seconds_override: null,
  }
}

// ---------------------------------------------------------------------------
// Diff & Alert Helpers
// ---------------------------------------------------------------------------

export function diffSnapshots(
  previous: ActorEvidenceSnapshot | null,
  current: ActorEvidenceSnapshot,
): SnapshotDiff {
  const prevCidrs = new Set(previous?.cidrs ?? [])
  const currCidrs = new Set(current.cidrs)
  const addedCidrs: string[] = []
  const removedCidrs: string[] = []

  for (const c of currCidrs) {
    if (!prevCidrs.has(c)) addedCidrs.push(c)
  }
  for (const c of prevCidrs) {
    if (!currCidrs.has(c)) removedCidrs.push(c)
  }
  addedCidrs.sort()
  removedCidrs.sort()

  const denom = Math.max(prevCidrs.size, currCidrs.size, 1)
  const cidrChurnRatio = previous === null ? 0 : (addedCidrs.length + removedCidrs.length) / denom

  const prevKeys = new Set((previous?.jwks ?? []).map((k) => k.thumbprint_sha256))
  const currKeys = new Set(current.jwks.map((k) => k.thumbprint_sha256))
  const addedKeys: string[] = []
  const removedKeys: string[] = []

  for (const k of currKeys) {
    if (!prevKeys.has(k)) addedKeys.push(k)
  }
  for (const k of prevKeys) {
    if (!currKeys.has(k)) removedKeys.push(k)
  }
  addedKeys.sort()
  removedKeys.sort()

  return Object.freeze({
    source_id: current.source_id,
    previous_snapshot_id: previous?.snapshot_id ?? null,
    current_snapshot_id: current.snapshot_id,
    content_changed: previous === null ? true : previous.sha256 !== current.sha256,
    added_cidrs: Object.freeze(addedCidrs),
    removed_cidrs: Object.freeze(removedCidrs),
    cidr_churn_ratio: cidrChurnRatio,
    added_key_thumbprints: Object.freeze(addedKeys),
    removed_key_thumbprints: Object.freeze(removedKeys),
  })
}

export function evaluateSnapshotAlerts(
  snapshot: ActorEvidenceSnapshot,
  diff: SnapshotDiff,
): readonly ClockAlert[] {
  const alerts: ClockAlert[] = []
  const nowSec = Math.floor(Date.parse(snapshot.fetched_at) / 1000)

  if (diff.previous_snapshot_id !== null && diff.cidr_churn_ratio > PREFIX_CHURN_ALERT_THRESHOLD) {
    alerts.push(
      Object.freeze({
        kind: 'prefix_churn_exceeded',
        severity: 'warn',
        source_id: snapshot.source_id,
        provider: snapshot.provider,
        detected_at: snapshot.fetched_at,
        message: `CIDR churn ${(diff.cidr_churn_ratio * 100).toFixed(1)}% exceeded 20% threshold`,
        details: Object.freeze({
          churn_ratio: diff.cidr_churn_ratio,
          added_count: diff.added_cidrs.length,
          removed_count: diff.removed_cidrs.length,
        }),
      }),
    )
  }

  for (const key of snapshot.jwks) {
    if (typeof key.exp !== 'number') continue
    const remaining = key.exp - nowSec
    if (remaining <= 0) {
      alerts.push(
        Object.freeze({
          kind: 'key_expired',
          severity: 'critical',
          source_id: snapshot.source_id,
          provider: snapshot.provider,
          detected_at: snapshot.fetched_at,
          message: `RFC 9421 key ${key.thumbprint_sha256} is already expired`,
          details: Object.freeze({
            thumbprint: key.thumbprint_sha256,
            exp: key.exp,
            expired_seconds_ago: Math.abs(remaining),
          }),
        }),
      )
    } else if (remaining <= KEY_EXPIRY_ALERT_WINDOW_SECONDS) {
      alerts.push(
        Object.freeze({
          kind: 'key_expiring_soon',
          severity: 'warn',
          source_id: snapshot.source_id,
          provider: snapshot.provider,
          detected_at: snapshot.fetched_at,
          message: `RFC 9421 key ${key.thumbprint_sha256} expires within 7 days`,
          details: Object.freeze({
            thumbprint: key.thumbprint_sha256,
            exp: key.exp,
            remaining_seconds: remaining,
          }),
        }),
      )
    }
  }

  return Object.freeze(alerts)
}

// ---------------------------------------------------------------------------
// Immutable Append-Only Snapshot Store
// ---------------------------------------------------------------------------

export interface EvidenceSnapshotStore {
  append(snapshot: ActorEvidenceSnapshot): Promise<void>
  getById(snapshotId: string): Promise<ActorEvidenceSnapshot | null>
  listBySource(sourceId: string): Promise<readonly ActorEvidenceSnapshot[]>
  listSources(): Promise<readonly string[]>
  getAsOf(sourceId: string, atIso: string): Promise<AsOfSnapshotLookup | null>
  getNextSnapshotsAfter(
    sourceId: string,
    afterIso: string,
    count: number,
  ): Promise<readonly ActorEvidenceSnapshot[]>
}

function freezeSnapshot(s: ActorEvidenceSnapshot): ActorEvidenceSnapshot {
  return Object.freeze({
    ...s,
    actor_tokens: Object.freeze([...s.actor_tokens]),
    cidrs: Object.freeze([...s.cidrs]),
    jwks: Object.freeze(s.jwks.map((k) => Object.freeze({ ...k }))),
  })
}

function computeAsOf(
  orderedAsc: readonly ActorEvidenceSnapshot[],
  atIso: string,
): AsOfSnapshotLookup | null {
  if (orderedAsc.length === 0) return null
  const atMs = Date.parse(atIso)
  if (Number.isNaN(atMs)) {
    throw new Error(`Invalid UTC timestamp: ${atIso}`)
  }

  let candidate: ActorEvidenceSnapshot | null = null
  for (const snap of orderedAsc) {
    const snapMs = Date.parse(snap.fetched_at)
    if (snapMs <= atMs) {
      candidate = snap
    } else {
      break
    }
  }

  if (candidate !== null) {
    const validUntilMs = Date.parse(candidate.valid_until)
    const isStale = !Number.isNaN(validUntilMs) && atMs > validUntilMs
    return Object.freeze({
      snapshot: candidate,
      relation: 'at_or_before',
      snapshot_distance_days: 0,
      is_stale: isStale,
    })
  }

  // アーカイブ開始より前の時刻: 最古のスナップショットを retro 参照
  const earliest = orderedAsc[0]
  const earliestMs = Date.parse(earliest.fetched_at)
  const distanceDays = Math.max(0, (earliestMs - atMs) / (24 * 60 * 60 * 1000))
  return Object.freeze({
    snapshot: earliest,
    relation: 'retro',
    snapshot_distance_days: Number(distanceDays.toFixed(4)),
    is_stale: false,
  })
}

export class InMemoryEvidenceSnapshotStore implements EvidenceSnapshotStore {
  private readonly byId = new Map<string, ActorEvidenceSnapshot>()
  private readonly bySource = new Map<string, ActorEvidenceSnapshot[]>()

  async append(snapshot: ActorEvidenceSnapshot): Promise<void> {
    const frozen = freezeSnapshot(snapshot)
    const existing = this.byId.get(frozen.snapshot_id)
    if (existing) {
      if (existing.sha256 === frozen.sha256 && existing.fetched_at === frozen.fetched_at) {
        return
      }
      throw new SnapshotImmutabilityError(
        `Snapshot ${frozen.snapshot_id} already exists and is immutable`,
      )
    }

    this.byId.set(frozen.snapshot_id, frozen)
    const list = this.bySource.get(frozen.source_id) ?? []
    list.push(frozen)
    list.sort((a, b) => Date.parse(a.fetched_at) - Date.parse(b.fetched_at))
    this.bySource.set(frozen.source_id, list)
  }

  async getById(snapshotId: string): Promise<ActorEvidenceSnapshot | null> {
    return this.byId.get(snapshotId) ?? null
  }

  async listBySource(sourceId: string): Promise<readonly ActorEvidenceSnapshot[]> {
    const list = this.bySource.get(sourceId)
    return list ? Object.freeze([...list]) : Object.freeze([])
  }

  async listSources(): Promise<readonly string[]> {
    return Object.freeze(Array.from(this.bySource.keys()).sort())
  }

  async getAsOf(sourceId: string, atIso: string): Promise<AsOfSnapshotLookup | null> {
    const list = this.bySource.get(sourceId)
    if (!list || list.length === 0) return null
    return computeAsOf(list, atIso)
  }

  async getNextSnapshotsAfter(
    sourceId: string,
    afterIso: string,
    count: number,
  ): Promise<readonly ActorEvidenceSnapshot[]> {
    const list = this.bySource.get(sourceId)
    if (!list || list.length === 0 || count <= 0) return Object.freeze([])
    const afterMs = Date.parse(afterIso)
    const result: ActorEvidenceSnapshot[] = []
    for (const snap of list) {
      if (Date.parse(snap.fetched_at) > afterMs) {
        result.push(snap)
        if (result.length >= count) break
      }
    }
    return Object.freeze(result)
  }
}

/**
 * ローカルファイルシステム永続化ストア（追記専用・`wx` 排他作成で既存スナップショット改変不可）。
 */
export class FileSystemEvidenceSnapshotStore implements EvidenceSnapshotStore {
  constructor(private readonly baseDir: string) {}

  private sanitizeSegment(seg: string): string {
    return seg.replace(/[^a-zA-Z0-9._-]/g, '_')
  }

  private sourceDir(sourceId: string): string {
    return path.join(this.baseDir, this.sanitizeSegment(sourceId))
  }

  private snapshotFilePath(snapshot: ActorEvidenceSnapshot): string {
    const tsSafe = snapshot.fetched_at.replace(/[:.]/g, '-')
    const fileName = `${tsSafe}_${snapshot.sha256.slice(0, 16)}.json`
    return path.join(this.sourceDir(snapshot.source_id), fileName)
  }

  async append(snapshot: ActorEvidenceSnapshot): Promise<void> {
    const frozen = freezeSnapshot(snapshot)
    const dir = this.sourceDir(frozen.source_id)
    await fs.mkdir(dir, { recursive: true })
    const filePath = this.snapshotFilePath(frozen)
    const serialized = JSON.stringify(frozen, null, 2) + '\n'
    try {
      await fs.writeFile(filePath, serialized, { encoding: 'utf8', flag: 'wx' })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        const existingRaw = await fs.readFile(filePath, 'utf8')
        const existing = JSON.parse(existingRaw) as ActorEvidenceSnapshot
        if (
          existing.snapshot_id === frozen.snapshot_id &&
          existing.sha256 === frozen.sha256 &&
          existing.fetched_at === frozen.fetched_at
        ) {
          return
        }
        throw new SnapshotImmutabilityError(`Immutable snapshot already exists at ${filePath}`)
      }
      throw err
    }
  }

  async listSources(): Promise<readonly string[]> {
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true })
      const sourceIds = new Set<string>()
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const dirPath = path.join(this.baseDir, entry.name)
        const files = await fs.readdir(dirPath)
        for (const f of files) {
          if (!f.endsWith('.json')) continue
          const raw = await fs.readFile(path.join(dirPath, f), 'utf8')
          const snap = JSON.parse(raw) as ActorEvidenceSnapshot
          sourceIds.add(snap.source_id)
          break
        }
      }
      return Object.freeze(Array.from(sourceIds).sort())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([])
      throw err
    }
  }

  async listBySource(sourceId: string): Promise<readonly ActorEvidenceSnapshot[]> {
    const dir = this.sourceDir(sourceId)
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([])
      throw err
    }

    const snapshots: ActorEvidenceSnapshot[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const raw = await fs.readFile(path.join(dir, f), 'utf8')
      const parsed = JSON.parse(raw) as ActorEvidenceSnapshot
      if (parsed.source_id === sourceId) {
        snapshots.push(freezeSnapshot(parsed))
      }
    }
    snapshots.sort((a, b) => Date.parse(a.fetched_at) - Date.parse(b.fetched_at))
    return Object.freeze(snapshots)
  }

  async getById(snapshotId: string): Promise<ActorEvidenceSnapshot | null> {
    const sources = await this.listSources()
    for (const src of sources) {
      const list = await this.listBySource(src)
      const found = list.find((s) => s.snapshot_id === snapshotId)
      if (found) return found
    }
    return null
  }

  async getAsOf(sourceId: string, atIso: string): Promise<AsOfSnapshotLookup | null> {
    const list = await this.listBySource(sourceId)
    if (list.length === 0) return null
    return computeAsOf(list, atIso)
  }

  async getNextSnapshotsAfter(
    sourceId: string,
    afterIso: string,
    count: number,
  ): Promise<readonly ActorEvidenceSnapshot[]> {
    const list = await this.listBySource(sourceId)
    if (list.length === 0 || count <= 0) return Object.freeze([])
    const afterMs = Date.parse(afterIso)
    const out: ActorEvidenceSnapshot[] = []
    for (const snap of list) {
      if (Date.parse(snap.fetched_at) > afterMs) {
        out.push(snap)
        if (out.length >= count) break
      }
    }
    return Object.freeze(out)
  }
}

// ---------------------------------------------------------------------------
// Snapshot Clock Collector & Historical Query Engine
// ---------------------------------------------------------------------------

function parseCacheControlMaxAge(cacheControl: string | null): number | null {
  if (!cacheControl) return null
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cacheControl)
  if (!match) return null
  const val = Number(match[1])
  return Number.isFinite(val) ? val : null
}

function getHeaderCaseInsensitive(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  name: string,
): string | null {
  if (!headers) return null
  const target = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target && typeof v === 'string') {
      return v
    }
  }
  return null
}

function createDefaultHttpFetcher(): EvidenceFetcher {
  return async (url, options) => {
    const res = await fetch(url, { redirect: options.redirect })
    const arrayBuf = await res.arrayBuffer()
    const bytes = new Uint8Array(arrayBuf)
    if (bytes.byteLength > options.maxBytes) {
      throw new Error(`Response exceeded maxBytes (${bytes.byteLength} > ${options.maxBytes})`)
    }
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      headers[k] = v
    })
    return {
      status: res.status,
      body: bytes,
      headers,
      redirected: res.redirected,
    }
  }
}

export interface ActorEvidenceClockOptions {
  readonly store: EvidenceSnapshotStore
  readonly sources?: readonly EvidenceSourceDefinition[]
  readonly fetcher?: EvidenceFetcher
  readonly now?: () => Date
  readonly cadenceMode?: ClockCadenceMode
}

export class ActorEvidenceClock {
  private readonly store: EvidenceSnapshotStore
  private readonly sources: readonly EvidenceSourceDefinition[]
  private readonly fetcher: EvidenceFetcher
  private readonly now: () => Date
  private readonly cadenceMode: ClockCadenceMode

  constructor(options: ActorEvidenceClockOptions) {
    this.store = options.store
    this.sources = Object.freeze([...(options.sources ?? DEFAULT_EVIDENCE_SOURCES)])
    this.fetcher = options.fetcher ?? createDefaultHttpFetcher()
    this.now = options.now ?? (() => new Date())
    this.cadenceMode = options.cadenceMode ?? 'nightly_wave0'
  }

  getSources(): readonly EvidenceSourceDefinition[] {
    return this.sources
  }

  getStore(): EvidenceSnapshotStore {
    return this.store
  }

  async captureSource(
    source: EvidenceSourceDefinition,
    overrideCadence?: ClockCadenceMode,
  ): Promise<CaptureSourceResult> {
    const fetchedDate = this.now()
    const fetchedAt = fetchedDate.toISOString()
    const cadence = overrideCadence ?? this.cadenceMode

    try {
      const parsedUrl = new URL(source.source_url)
      if (parsedUrl.protocol !== 'https:') {
        throw new Error(`Evidence source URL must use HTTPS: ${source.source_url}`)
      }

      const maxBytes = source.source_kind === 'rfc9421_jwks' ? JWKS_MAX_BYTES : IP_FEED_MAX_BYTES
      const redirectPolicy = source.source_kind === 'rfc9421_jwks' ? 'error' : 'follow'
      const res = await this.fetcher(source.source_url, {
        redirect: redirectPolicy,
        maxBytes,
      })

      if (source.source_kind === 'rfc9421_jwks' && res.redirected) {
        throw new Error('RFC 9421 key directory fetch must not follow redirects')
      }
      if (res.status !== 200) {
        throw new Error(`Unexpected HTTP status ${res.status}`)
      }

      const rawBytes =
        typeof res.body === 'string' ? new TextEncoder().encode(res.body) : res.body
      if (rawBytes.byteLength > maxBytes) {
        throw new Error(`Response body exceeded cap (${rawBytes.byteLength} > ${maxBytes})`)
      }

      const sha256 = createHash('sha256').update(rawBytes).digest('hex')
      const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(rawBytes)

      let parsed: ParsedFeedPayload
      if (source.source_kind === 'ip_json') {
        parsed = parseIpJsonFeed(bodyText)
      } else if (source.source_kind === 'sail_toml') {
        parsed = parseSailTomlFeed(bodyText, source.sail_agent_name)
      } else {
        parsed = parseRfc9421Jwks(bodyText)
      }

      const cacheControl = getHeaderCaseInsensitive(res.headers, 'cache-control')
      const etag = getHeaderCaseInsensitive(res.headers, 'etag')
      const ccMaxAge = parseCacheControlMaxAge(cacheControl)

      let validUntilIso: string
      if (parsed.expires_iso) {
        validUntilIso = parsed.expires_iso
      } else {
        let ttlSeconds = parsed.ttl_seconds_override ?? ccMaxAge ?? source.default_ttl_seconds
        if (source.source_kind === 'rfc9421_jwks') {
          ttlSeconds = Math.max(JWKS_MIN_TTL_SECONDS, Math.min(JWKS_MAX_TTL_SECONDS, ttlSeconds))
        }
        validUntilIso = new Date(fetchedDate.getTime() + ttlSeconds * 1000).toISOString()
      }

      const isExhaustive = parsed.is_exhaustive_override ?? source.is_exhaustive
      const exclusiveScope = parsed.exclusive_scope_override ?? source.exclusive_scope
      const exhaustiveBasis: ExhaustiveBasis =
        isExhaustive && source.source_kind === 'sail_toml'
          ? 'sail_flag'
          : isExhaustive
            ? source.exhaustive_basis === 'none'
              ? 'vendor_statement'
              : source.exhaustive_basis
            : 'none'

      const snapshotId = `${source.source_id}@${fetchedAt}#${sha256.slice(0, 16)}`
      const snapshot: ActorEvidenceSnapshot = freezeSnapshot({
        snapshot_id: snapshotId,
        source_id: source.source_id,
        provider: source.provider,
        actor_tokens: source.actor_tokens,
        source_url: source.source_url,
        source_kind: source.source_kind,
        fetched_at: fetchedAt,
        valid_until: validUntilIso,
        cadence_mode: cadence,
        is_exhaustive: isExhaustive,
        exhaustive_basis: exhaustiveBasis,
        exclusive_scope: exclusiveScope,
        http_status: res.status,
        etag,
        cache_control: cacheControl,
        creation_time: parsed.creation_time,
        sha256,
        raw_bytes_length: rawBytes.byteLength,
        cidrs: parsed.cidrs,
        jwks: parsed.jwks,
      })

      const prevList = await this.store.listBySource(source.source_id)
      const previous = prevList.length > 0 ? prevList[prevList.length - 1] : null
      const diff = diffSnapshots(previous, snapshot)
      const alerts = evaluateSnapshotAlerts(snapshot, diff)

      await this.store.append(snapshot)

      return Object.freeze({
        ok: true,
        source_id: source.source_id,
        snapshot,
        diff,
        alerts,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const failAlert: ClockAlert = Object.freeze({
        kind: 'fetch_failed',
        severity: 'critical',
        source_id: source.source_id,
        provider: source.provider,
        detected_at: fetchedAt,
        message: `Failed to capture snapshot for ${source.source_id}: ${msg}`,
        details: Object.freeze({
          source_url: source.source_url,
          error: msg,
        }),
      })
      return Object.freeze({
        ok: false,
        source_id: source.source_id,
        snapshot: null,
        diff: null,
        alerts: Object.freeze([failAlert]),
        error: msg,
      })
    }
  }

  async captureAll(
    sourcesOverride?: readonly EvidenceSourceDefinition[],
    overrideCadence?: ClockCadenceMode,
  ): Promise<readonly CaptureSourceResult[]> {
    const targets = sourcesOverride ?? this.sources
    const results: CaptureSourceResult[] = []
    for (const src of targets) {
      results.push(await this.captureSource(src, overrideCadence))
    }
    return Object.freeze(results)
  }

  /**
   * 過去時点 `at` において有効だったスナップショットに対して IP の最長プレフィックス照合を行う。
   * - 対象スナップショットに一致 → `verified` (アーカイブ開始前なら `verified_retro`)
   * - 対象スナップショットに不一致でも直後 2 スナップショットに一致 → `late_published`
   * - 3 連続スナップショットで不一致 かつ `is_exhaustive && cadence_mode === 'production_poll'` → `refuted`
   * - それ以外の不一致 → `feed_miss` (§13.1: nightly_wave0 では refuted を出さない)
   * - スナップショットが `valid_until` を超過して期限切れ → `unverifiable_stale_evidence`
   */
  async lookupIpAtTime(query: HistoricalIpLookupQuery): Promise<HistoricalIpLookupResult> {
    const parsedIp = parseIp(query.ip)
    const candidateSources = this.sources.filter((s) => {
      if (s.source_kind === 'rfc9421_jwks') return false
      if (query.source_id && s.source_id !== query.source_id) return false
      if (query.provider && s.provider !== query.provider) return false
      if (
        query.actor_token &&
        !s.actor_tokens.some((t) => t.toLowerCase() === query.actor_token?.toLowerCase())
      ) {
        return false
      }
      return true
    })

    const checkedSources = candidateSources.map((s) => s.source_id)

    if (!parsedIp || candidateSources.length === 0) {
      return Object.freeze({
        ip: query.ip,
        at: query.at,
        matched: false,
        verification_result: 'unverifiable_no_method',
        matched_cidr: null,
        prefix_length: null,
        provider: query.provider ?? null,
        source_id: query.source_id ?? null,
        actor_tokens: Object.freeze([]),
        snapshot_id: null,
        snapshot_fetched_at: null,
        snapshot_sha256: null,
        is_exhaustive: false,
        exclusive_scope: 'none',
        snapshot_distance_days: null,
        checked_sources: Object.freeze(checkedSources),
        consecutive_misses: 0,
      })
    }

    let bestMatch: {
      snapshot: ActorEvidenceSnapshot
      lookup: AsOfSnapshotLookup
      matchedCidr: string
      prefixLength: number
    } | null = null

    let anySnapshotFound = false
    let anyFreshSnapshot = false
    let primaryMissSnapshot: {
      snapshot: ActorEvidenceSnapshot
      lookup: AsOfSnapshotLookup
      nextTwo: readonly ActorEvidenceSnapshot[]
    } | null = null

    for (const src of candidateSources) {
      const asOf = await this.store.getAsOf(src.source_id, query.at)
      if (!asOf) continue
      anySnapshotFound = true

      if (asOf.is_stale) {
        if (!primaryMissSnapshot) {
          primaryMissSnapshot = { snapshot: asOf.snapshot, lookup: asOf, nextTwo: [] }
        }
        continue
      }
      anyFreshSnapshot = true

      const hit = matchIpInCidrs(query.ip, asOf.snapshot.cidrs)
      if (hit.matched && hit.matchedCidr !== null && hit.prefixLength !== null) {
        if (bestMatch === null || hit.prefixLength > bestMatch.prefixLength) {
          bestMatch = {
            snapshot: asOf.snapshot,
            lookup: asOf,
            matchedCidr: hit.matchedCidr,
            prefixLength: hit.prefixLength,
          }
        }
      } else {
        const nextTwo = await this.store.getNextSnapshotsAfter(
          src.source_id,
          asOf.snapshot.fetched_at,
          2,
        )
        // 網羅ソースのミスを優先保持
        if (
          !primaryMissSnapshot ||
          (asOf.snapshot.is_exhaustive && !primaryMissSnapshot.snapshot.is_exhaustive)
        ) {
          primaryMissSnapshot = { snapshot: asOf.snapshot, lookup: asOf, nextTwo }
        }
      }
    }

    if (bestMatch !== null) {
      const snap = bestMatch.snapshot
      const isOperatorOnly =
        query.actor_token !== undefined &&
        snap.exclusive_scope === 'operator' &&
        snap.actor_tokens.length > 1
      const resultStatus: EvidenceVerificationResult =
        bestMatch.lookup.relation === 'retro'
          ? 'verified_retro'
          : isOperatorOnly
            ? 'verified_operator'
            : 'verified'

      return Object.freeze({
        ip: query.ip,
        at: query.at,
        matched: true,
        verification_result: resultStatus,
        matched_cidr: bestMatch.matchedCidr,
        prefix_length: bestMatch.prefixLength,
        provider: snap.provider,
        source_id: snap.source_id,
        actor_tokens: snap.actor_tokens,
        snapshot_id: snap.snapshot_id,
        snapshot_fetched_at: snap.fetched_at,
        snapshot_sha256: snap.sha256,
        is_exhaustive: snap.is_exhaustive,
        exclusive_scope: snap.exclusive_scope,
        snapshot_distance_days: bestMatch.lookup.snapshot_distance_days,
        checked_sources: Object.freeze(checkedSources),
        consecutive_misses: 0,
      })
    }

    if (!anySnapshotFound) {
      return Object.freeze({
        ip: query.ip,
        at: query.at,
        matched: false,
        verification_result: 'unverifiable_stale_evidence',
        matched_cidr: null,
        prefix_length: null,
        provider: query.provider ?? null,
        source_id: query.source_id ?? null,
        actor_tokens: Object.freeze([]),
        snapshot_id: null,
        snapshot_fetched_at: null,
        snapshot_sha256: null,
        is_exhaustive: false,
        exclusive_scope: 'none',
        snapshot_distance_days: null,
        checked_sources: Object.freeze(checkedSources),
        consecutive_misses: 0,
      })
    }

    if (!anyFreshSnapshot && primaryMissSnapshot) {
      const snap = primaryMissSnapshot.snapshot
      return Object.freeze({
        ip: query.ip,
        at: query.at,
        matched: false,
        verification_result: 'unverifiable_stale_evidence',
        matched_cidr: null,
        prefix_length: null,
        provider: snap.provider,
        source_id: snap.source_id,
        actor_tokens: snap.actor_tokens,
        snapshot_id: snap.snapshot_id,
        snapshot_fetched_at: snap.fetched_at,
        snapshot_sha256: snap.sha256,
        is_exhaustive: snap.is_exhaustive,
        exclusive_scope: snap.exclusive_scope,
        snapshot_distance_days: primaryMissSnapshot.lookup.snapshot_distance_days,
        checked_sources: Object.freeze(checkedSources),
        consecutive_misses: 0,
      })
    }

    // 不一致の場合: 直後2スナップショットで late_published / 3連続ミス refuted / feed_miss を判定
    const miss = primaryMissSnapshot!
    for (const laterSnap of miss.nextTwo) {
      const laterHit = matchIpInCidrs(query.ip, laterSnap.cidrs)
      if (laterHit.matched) {
        return Object.freeze({
          ip: query.ip,
          at: query.at,
          matched: false,
          verification_result: 'late_published',
          matched_cidr: laterHit.matchedCidr,
          prefix_length: laterHit.prefixLength,
          provider: laterSnap.provider,
          source_id: laterSnap.source_id,
          actor_tokens: laterSnap.actor_tokens,
          snapshot_id: laterSnap.snapshot_id,
          snapshot_fetched_at: laterSnap.fetched_at,
          snapshot_sha256: laterSnap.sha256,
          is_exhaustive: laterSnap.is_exhaustive,
          exclusive_scope: laterSnap.exclusive_scope,
          snapshot_distance_days: miss.lookup.snapshot_distance_days,
          checked_sources: Object.freeze(checkedSources),
          consecutive_misses: 1,
        })
      }
    }

    const consecutiveMisses = 1 + miss.nextTwo.length
    const allExhaustiveAndProduction =
      miss.snapshot.is_exhaustive &&
      miss.snapshot.cadence_mode === 'production_poll' &&
      miss.nextTwo.length >= 2 &&
      miss.nextTwo.every((s) => s.is_exhaustive && s.cadence_mode === 'production_poll')

    const verificationResult: EvidenceVerificationResult =
      allExhaustiveAndProduction && consecutiveMisses >= 3 ? 'refuted' : 'feed_miss'

    return Object.freeze({
      ip: query.ip,
      at: query.at,
      matched: false,
      verification_result: verificationResult,
      matched_cidr: null,
      prefix_length: null,
      provider: miss.snapshot.provider,
      source_id: miss.snapshot.source_id,
      actor_tokens: miss.snapshot.actor_tokens,
      snapshot_id: miss.snapshot.snapshot_id,
      snapshot_fetched_at: miss.snapshot.fetched_at,
      snapshot_sha256: miss.snapshot.sha256,
      is_exhaustive: miss.snapshot.is_exhaustive,
      exclusive_scope: miss.snapshot.exclusive_scope,
      snapshot_distance_days: miss.lookup.snapshot_distance_days,
      checked_sources: Object.freeze(checkedSources),
      consecutive_misses: consecutiveMisses,
    })
  }

  /**
   * 過去時点 `at` において有効だった RFC 9421 公開鍵ディレクトリから鍵を照会する。
   */
  async lookupKeyAtTime(query: HistoricalKeyLookupQuery): Promise<HistoricalKeyLookupResult> {
    const atSec = Math.floor(Date.parse(query.at) / 1000)
    const candidateSources = this.sources.filter((s) => {
      if (s.source_kind !== 'rfc9421_jwks') return false
      if (query.source_id && s.source_id !== query.source_id) return false
      if (query.provider && s.provider !== query.provider) return false
      return true
    })

    let hadSnapshot = false
    let hadStaleSnapshot = false

    for (const src of candidateSources) {
      const asOf = await this.store.getAsOf(src.source_id, query.at)
      if (!asOf) continue
      hadSnapshot = true

      if (asOf.is_stale) {
        hadStaleSnapshot = true
        continue
      }

      const key = asOf.snapshot.jwks.find(
        (k) =>
          k.thumbprint_sha256 === query.thumbprint_or_kid ||
          (k.kid !== undefined && k.kid === query.thumbprint_or_kid),
      )

      if (key) {
        if (typeof key.nbf === 'number' && atSec < key.nbf) {
          return Object.freeze({
            found: true,
            valid_at_time: false,
            key,
            provider: asOf.snapshot.provider,
            source_id: asOf.snapshot.source_id,
            snapshot_id: asOf.snapshot.snapshot_id,
            snapshot_fetched_at: asOf.snapshot.fetched_at,
            snapshot_sha256: asOf.snapshot.sha256,
            relation: asOf.relation,
            snapshot_distance_days: asOf.snapshot_distance_days,
            reason: 'not_yet_valid',
          })
        }
        if (typeof key.exp === 'number' && atSec > key.exp) {
          return Object.freeze({
            found: true,
            valid_at_time: false,
            key,
            provider: asOf.snapshot.provider,
            source_id: asOf.snapshot.source_id,
            snapshot_id: asOf.snapshot.snapshot_id,
            snapshot_fetched_at: asOf.snapshot.fetched_at,
            snapshot_sha256: asOf.snapshot.sha256,
            relation: asOf.relation,
            snapshot_distance_days: asOf.snapshot_distance_days,
            reason: 'expired',
          })
        }
        return Object.freeze({
          found: true,
          valid_at_time: true,
          key,
          provider: asOf.snapshot.provider,
          source_id: asOf.snapshot.source_id,
          snapshot_id: asOf.snapshot.snapshot_id,
          snapshot_fetched_at: asOf.snapshot.fetched_at,
          snapshot_sha256: asOf.snapshot.sha256,
          relation: asOf.relation,
          snapshot_distance_days: asOf.snapshot_distance_days,
          reason: 'valid',
        })
      }
    }

    return Object.freeze({
      found: false,
      valid_at_time: false,
      key: null,
      provider: query.provider ?? null,
      source_id: query.source_id ?? null,
      snapshot_id: null,
      snapshot_fetched_at: null,
      snapshot_sha256: null,
      relation: null,
      snapshot_distance_days: null,
      reason: !hadSnapshot ? 'no_snapshot' : hadStaleSnapshot ? 'stale_snapshot' : 'not_found',
    })
  }
}
