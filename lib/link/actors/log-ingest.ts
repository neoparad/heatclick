/**
 * UGOKI LINK v2 — 束 3-D (手順 10): サーバーログ取込・5ホスティングアダプタ・静的資産除外・カバレッジ算出
 *
 * 設計書 §7.3, §7.4 / actors-final.md M3, M4, C.M3, C.M4:
 * - 署名付き POST 一括取込 (NDJSON / JSON 配列, HMAC-SHA256 + タイムスタンプ窓)。
 * - 静的資産除外: 文書・`robots.txt`・`llms.txt`・サイトマップ・フィード・SDK 空ファイル/プローブ・
 *   おとり経路・自動操作名乗り/署名あり行のみ受入。`Sec-Purpose: prefetch` は非カウント印を付与。
 * - 5 ホスティングアダプタ:
 *   1. `cloudflare_worker` (P1)
 *   2. `cloudflare_logpush` (P2)
 *   3. `vercel_drain` (P3)
 *   4. `nginx` (P4)
 *   5. `shared_hosting_daily` (P5 — Apache/Combined 形式含む)
 * - URL / Referer を `computeUrlKeyV2` で正規化。
 * - 行為者クラス別カバレッジ算出: 取得経路が無いクラスは必ず `not_collected`（倍率推定禁止）。
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { computeUrlKeyV2, type UrlKeyV2Rules } from '@/packages/contract/urlkey'

import {
  classifyAndMinimizeIpAddress,
  DailySealingKeyVault,
  derivePurposeNetworkPseudonym,
  truncateIpPrefix,
  type IpPrivacyEntitlementOptions,
  type MinimizedIpEvidence,
  type NetworkPseudonymPurpose,
  type PurposePseudonymKeyRing,
} from './ip-privacy'
import {
  lookupPolicyOnlyToken,
  matchDeclaredActorBySignatureAgent,
  matchDeclaredActorByUa,
  reduceStandardBrowserUa,
  UnknownUaQuorumTracker,
  type UnknownUaQuorumEntry,
} from './registry'
import {
  parseSignatureAgentHeader,
  type ActorClass,
  type ActorObservationRecord,
  type IpTrustLevel,
  type Rfc9421ObservationHeaders,
} from './verdict-engine'

// ---------------------------------------------------------------------------
// Capture Paths & Hosting Adapter Types
// ---------------------------------------------------------------------------

/**
 * 設計書 §7.3 取得経路 (P0–P7):
 * - P0: ブラウザ SDK タグのみ
 * - P1: Cloudflare Worker / CDN エッジ関数
 * - P2: Cloudflare Logpush / CloudFront / Fastly リアルタイムログ
 * - P3: Vercel Log Drain / Netlify / Cloud Run ログストリーム
 * - P4: Nginx / Apache / Caddy / Next.js ミドルウェア リアルタイム送信
 * - P5: 共用サーバ（エックスサーバー・さくら・ConoHa等）日次アクセスログ取込
 * - P6: 自社検証計器 (CRAWL) 観測
 * - P7: 外部公式証跡時計 (IP / SAIL / JWKS)
 */
export type CapturePath = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7'

export type HostingAdapterKind =
  | 'cloudflare_worker'
  | 'cloudflare_logpush'
  | 'vercel_drain'
  | 'nginx'
  | 'shared_hosting_daily'

export const ADAPTER_CAPTURE_PATH: Readonly<Record<HostingAdapterKind, CapturePath>> = Object.freeze({
  cloudflare_worker: 'P1',
  cloudflare_logpush: 'P2',
  vercel_drain: 'P3',
  nginx: 'P4',
  shared_hosting_daily: 'P5',
})

export const ADAPTER_DEFAULT_IP_TRUST: Readonly<Record<HostingAdapterKind, IpTrustLevel>> =
  Object.freeze({
    cloudflare_worker: 'direct_socket',
    cloudflare_logpush: 'direct_socket',
    vercel_drain: 'proxy_restored_attested',
    nginx: 'proxy_restored_unattested',
    shared_hosting_daily: 'proxy_restored_unattested',
  })

// ---------------------------------------------------------------------------
// Signed POST Batch Ingest Authentication (HMAC-SHA256)
// ---------------------------------------------------------------------------

export const LOG_INGEST_MAX_SKEW_SECONDS = 300

export function signLogIngestBatch(params: {
  readonly tenant_id: string
  readonly site_id: string
  readonly timestamp_sec: number
  readonly raw_body: string
  readonly secret: string | Buffer
}): string {
  const payload = `${params.tenant_id}|${params.site_id}|${params.timestamp_sec}|${params.raw_body}`
  const hex = createHmac('sha256', params.secret).update(payload, 'utf8').digest('hex')
  return `v1=${hex}`
}

export function verifyLogIngestSignature(params: {
  readonly tenant_id: string
  readonly site_id: string
  readonly timestamp_sec: number
  readonly signature_header: string | null | undefined
  readonly raw_body: string
  readonly secret: string | Buffer
  readonly now_sec?: number
  readonly max_skew_seconds?: number
}): { readonly valid: boolean; readonly reason: string } {
  if (!params.signature_header || !params.signature_header.startsWith('v1=')) {
    return Object.freeze({ valid: false, reason: 'missing_or_malformed_signature' })
  }
  if (!Number.isFinite(params.timestamp_sec)) {
    return Object.freeze({ valid: false, reason: 'invalid_timestamp' })
  }

  const nowSec = params.now_sec ?? Math.floor(Date.now() / 1000)
  const maxSkew = params.max_skew_seconds ?? LOG_INGEST_MAX_SKEW_SECONDS
  if (Math.abs(nowSec - params.timestamp_sec) > maxSkew) {
    return Object.freeze({ valid: false, reason: 'timestamp_out_of_window' })
  }

  const expected = signLogIngestBatch({
    tenant_id: params.tenant_id,
    site_id: params.site_id,
    timestamp_sec: params.timestamp_sec,
    raw_body: params.raw_body,
    secret: params.secret,
  })

  const actualBuf = Buffer.from(params.signature_header, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    return Object.freeze({ valid: false, reason: 'signature_mismatch' })
  }

  return Object.freeze({ valid: true, reason: 'ok' })
}

// ---------------------------------------------------------------------------
// Normalized Raw Log Row (Intermediate representation from all 5 adapters)
// ---------------------------------------------------------------------------

export interface NormalizedRawLogRow {
  readonly observed_at: string
  readonly request_id: string | null
  readonly method: string
  readonly host: string
  readonly path: string
  readonly query: string | null
  readonly status_code: number
  readonly content_type: string | null
  readonly user_agent: string | null
  readonly referer: string | null
  readonly client_ip: string | null
  readonly asn: number | null
  readonly ip_trust: IpTrustLevel
  readonly sec_purpose: string | null
  readonly rfc9421_headers: Rfc9421ObservationHeaders | null
}

function splitPathAndQuery(rawUri: string): { path: string; query: string | null } {
  const trimmed = rawUri.trim() || '/'
  // Handle full URL if log contains scheme://host/path
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed)
      return { path: u.pathname || '/', query: u.search ? u.search : null }
    } catch {
      // fall through
    }
  }
  const qIdx = trimmed.indexOf('?')
  if (qIdx === -1) return { path: trimmed.startsWith('/') ? trimmed : `/${trimmed}`, query: null }
  const p = trimmed.slice(0, qIdx) || '/'
  return { path: p.startsWith('/') ? p : `/${p}`, query: trimmed.slice(qIdx) }
}

function getCaseInsensitive(
  obj: Readonly<Record<string, unknown>> | null | undefined,
  key: string,
): string | null {
  if (!obj) return null
  const low = key.toLowerCase()
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === low && typeof v === 'string' && v.trim()) {
      return v.trim()
    }
  }
  return null
}

function extractRfc9421FromHeaders(
  headers: Readonly<Record<string, unknown>> | null | undefined,
): Rfc9421ObservationHeaders | null {
  if (!headers) return null
  const sigInput = getCaseInsensitive(headers, 'signature-input')
  const sig = getCaseInsensitive(headers, 'signature')
  const sigAgent = getCaseInsensitive(headers, 'signature-agent')
  if (!sigInput || !sig) return null
  return Object.freeze({
    signature_input: sigInput,
    signature: sig,
    signature_agent: sigAgent,
  })
}

function toIsoTimestamp(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw <= 0) return null
    // Support seconds (including fractional Nginx $msec), ms, or ns (Cloudflare Logpush)
    let ms = raw
    if (raw > 1e15) ms = Math.floor(raw / 1e6) // nanoseconds
    else if (raw < 1e12) ms = Math.round(raw * 1000) // seconds / $msec decimal
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof raw === 'string' && raw.trim()) {
    const s = raw.trim()
    // Numeric epoch seconds / Nginx $msec string (e.g. "1763640000.123") or ms/ns string
    if (/^\d+(?:\.\d{1,9})?$/.test(s)) {
      const num = Number(s)
      if (!Number.isFinite(num) || num <= 0) return null
      let ms = num
      if (num > 1e15) ms = Math.floor(num / 1e6)
      else if (num < 1e12) ms = Math.round(num * 1000)
      const d = new Date(ms)
      return Number.isNaN(d.getTime()) ? null : d.toISOString()
    }
    // Apache Combined Log timestamp: 20/Nov/2026:12:00:00 +0900
    const apacheRe = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}:\d{2}:\d{2})\s*([+-]\d{4})$/
    const m = apacheRe.exec(s)
    if (m) {
      const parsed = Date.parse(`${m[1]} ${m[2]} ${m[3]} ${m[4]} GMT${m[5]}`)
      return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
    }
    const parsed = Date.parse(s)
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
  }
  return null
}

// ---------------------------------------------------------------------------
// 5 Hosting Adapters
// ---------------------------------------------------------------------------

/**
 * 5 ホスティング形式から共通の中間観測行へ変換する。
 */
export function adaptHostingLogRecord(
  adapter: HostingAdapterKind,
  rawRecord: unknown,
  defaultHost: string,
): NormalizedRawLogRow | null {
  const defaultTrust = ADAPTER_DEFAULT_IP_TRUST[adapter]

  if (adapter === 'shared_hosting_daily' && typeof rawRecord === 'string') {
    return parseCombinedAccessLogLine(rawRecord, defaultHost, defaultTrust)
  }

  if (typeof rawRecord !== 'object' || rawRecord === null || Array.isArray(rawRecord)) {
    return null
  }
  const r = rawRecord as Record<string, unknown>

  switch (adapter) {
    case 'cloudflare_worker': {
      const ts = toIsoTimestamp(r.observed_at ?? r.timestamp ?? r.ts)
      if (!ts) return null
      const { path, query } = splitPathAndQuery(
        String(r.uri ?? r.path ?? '/') + (typeof r.query === 'string' && r.query ? r.query : ''),
      )
      const headers = (r.headers as Record<string, unknown> | undefined) ?? null
      return Object.freeze({
        observed_at: ts,
        request_id: typeof r.request_id === 'string' ? r.request_id : null,
        method: String(r.method ?? 'GET').toUpperCase(),
        host: String(r.host ?? defaultHost).toLowerCase(),
        path,
        query,
        status_code: Number(r.status ?? r.status_code ?? 200),
        content_type:
          typeof r.content_type === 'string'
            ? r.content_type
            : getCaseInsensitive(headers, 'content-type'),
        user_agent:
          typeof r.user_agent === 'string'
            ? r.user_agent
            : getCaseInsensitive(headers, 'user-agent'),
        referer:
          typeof r.referer === 'string' ? r.referer : getCaseInsensitive(headers, 'referer'),
        client_ip: typeof r.client_ip === 'string' ? r.client_ip : null,
        asn: typeof r.asn === 'number' ? r.asn : null,
        ip_trust: (r.ip_trust as IpTrustLevel | undefined) ?? defaultTrust,
        sec_purpose:
          typeof r.sec_purpose === 'string'
            ? r.sec_purpose
            : getCaseInsensitive(headers, 'sec-purpose') ??
              getCaseInsensitive(headers, 'purpose'),
        rfc9421_headers:
          extractRfc9421FromHeaders(headers) ??
          extractRfc9421FromHeaders({
            'signature-input': r.signature_input,
            signature: r.signature,
            'signature-agent': r.signature_agent,
          }),
      })
    }

    case 'cloudflare_logpush': {
      const ts = toIsoTimestamp(r.EdgeStartTimestamp ?? r.timestamp)
      if (!ts) return null
      const { path, query } = splitPathAndQuery(String(r.ClientRequestURI ?? '/'))
      const reqHeaders = (r.ClientRequestHeaders as Record<string, unknown> | undefined) ?? null
      return Object.freeze({
        observed_at: ts,
        request_id: typeof r.RayID === 'string' ? r.RayID : null,
        method: String(r.ClientRequestMethod ?? 'GET').toUpperCase(),
        host: String(r.ClientRequestHost ?? defaultHost).toLowerCase(),
        path,
        query,
        status_code: Number(r.EdgeResponseStatus ?? 200),
        content_type:
          typeof r.EdgeResponseContentType === 'string' ? r.EdgeResponseContentType : null,
        user_agent:
          typeof r.ClientRequestUserAgent === 'string' ? r.ClientRequestUserAgent : null,
        referer: typeof r.ClientRequestReferer === 'string' ? r.ClientRequestReferer : null,
        client_ip: typeof r.ClientIP === 'string' ? r.ClientIP : null,
        asn: typeof r.ClientASN === 'number' ? r.ClientASN : null,
        ip_trust: defaultTrust,
        sec_purpose:
          getCaseInsensitive(reqHeaders, 'sec-purpose') ??
          getCaseInsensitive(reqHeaders, 'purpose'),
        rfc9421_headers: extractRfc9421FromHeaders(reqHeaders),
      })
    }

    case 'vercel_drain': {
      const proxy = (r.proxy as Record<string, unknown> | undefined) ?? r
      const ts = toIsoTimestamp(r.timestamp ?? proxy.timestamp)
      if (!ts) return null
      const { path, query } = splitPathAndQuery(String(proxy.path ?? r.path ?? '/'))
      const headers = (proxy.headers as Record<string, unknown> | undefined) ?? null
      const rawUa = Array.isArray(proxy.userAgent)
        ? String(proxy.userAgent[0] ?? '')
        : typeof proxy.userAgent === 'string'
          ? proxy.userAgent
          : getCaseInsensitive(headers, 'user-agent')
      return Object.freeze({
        observed_at: ts,
        request_id: typeof r.id === 'string' ? r.id : typeof r.requestId === 'string' ? r.requestId : null,
        method: String(proxy.method ?? 'GET').toUpperCase(),
        host: String(proxy.host ?? r.host ?? defaultHost).toLowerCase(),
        path,
        query,
        status_code: Number(proxy.statusCode ?? r.statusCode ?? 200),
        content_type: getCaseInsensitive(headers, 'content-type'),
        user_agent: rawUa || null,
        referer:
          typeof proxy.referer === 'string'
            ? proxy.referer
            : getCaseInsensitive(headers, 'referer'),
        client_ip: typeof proxy.clientIp === 'string' ? proxy.clientIp : null,
        asn: typeof proxy.asn === 'number' ? proxy.asn : null,
        ip_trust: defaultTrust,
        sec_purpose:
          getCaseInsensitive(headers, 'sec-purpose') ?? getCaseInsensitive(headers, 'purpose'),
        rfc9421_headers: extractRfc9421FromHeaders(headers),
      })
    }

    case 'nginx': {
      const ts = toIsoTimestamp(r.time_iso8601 ?? r.msec ?? r.time_local ?? r.timestamp)
      if (!ts) return null
      const { path, query } = splitPathAndQuery(String(r.request_uri ?? r.uri ?? '/'))
      const sigHeaders = extractRfc9421FromHeaders({
        'signature-input': r.http_signature_input,
        signature: r.http_signature,
        'signature-agent': r.http_signature_agent,
      })
      return Object.freeze({
        observed_at: ts,
        request_id: typeof r.request_id === 'string' ? r.request_id : null,
        method: String(r.request_method ?? 'GET').toUpperCase(),
        host: String(r.host ?? defaultHost).toLowerCase(),
        path,
        query,
        status_code: Number(r.status ?? 200),
        content_type:
          typeof r.sent_http_content_type === 'string'
            ? r.sent_http_content_type
            : typeof r.content_type === 'string'
              ? r.content_type
              : null,
        user_agent: typeof r.http_user_agent === 'string' ? r.http_user_agent : null,
        referer:
          typeof r.http_referer === 'string' && r.http_referer !== '-' ? r.http_referer : null,
        client_ip: typeof r.remote_addr === 'string' ? r.remote_addr : null,
        asn: typeof r.asn === 'number' ? r.asn : null,
        ip_trust: (r.ip_trust as IpTrustLevel | undefined) ?? defaultTrust,
        sec_purpose:
          typeof r.http_sec_purpose === 'string' && r.http_sec_purpose !== '-'
            ? r.http_sec_purpose
            : null,
        rfc9421_headers: sigHeaders,
      })
    }

    case 'shared_hosting_daily': {
      if (typeof r.line === 'string') {
        return parseCombinedAccessLogLine(r.line, defaultHost, defaultTrust)
      }
      const ts = toIsoTimestamp(r.time ?? r.timestamp ?? r.observed_at)
      if (!ts) return null
      const { path, query } = splitPathAndQuery(String(r.uri ?? r.path ?? '/'))
      return Object.freeze({
        observed_at: ts,
        request_id: null,
        method: String(r.method ?? 'GET').toUpperCase(),
        host: String(r.host ?? defaultHost).toLowerCase(),
        path,
        query,
        status_code: Number(r.status ?? 200),
        content_type: typeof r.content_type === 'string' ? r.content_type : null,
        user_agent: typeof r.user_agent === 'string' ? r.user_agent : null,
        referer: typeof r.referer === 'string' && r.referer !== '-' ? r.referer : null,
        client_ip: typeof r.ip === 'string' ? r.ip : typeof r.remote_addr === 'string' ? r.remote_addr : null,
        asn: typeof r.asn === 'number' ? r.asn : null,
        ip_trust: defaultTrust,
        sec_purpose: null,
        rfc9421_headers: null,
      })
    }
  }
}

const COMBINED_LOG_RE =
  /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([A-Z]+)\s+(\S+)(?:\s+HTTP\/[0-9.]+)?"\s+(\d{3})\s+(?:\d+|-)(?:\s+"([^"]*)"\s+"([^"]*)")?/

export function parseCombinedAccessLogLine(
  line: string,
  defaultHost: string,
  ipTrust: IpTrustLevel = 'proxy_restored_unattested',
): NormalizedRawLogRow | null {
  const m = COMBINED_LOG_RE.exec(line.trim())
  if (!m) return null
  const ts = toIsoTimestamp(m[2])
  if (!ts) return null
  const { path, query } = splitPathAndQuery(m[4])
  const referer = m[6] && m[6] !== '-' ? m[6] : null
  const ua = m[7] && m[7] !== '-' ? m[7] : null
  return Object.freeze({
    observed_at: ts,
    request_id: null,
    method: m[3].toUpperCase(),
    host: defaultHost.toLowerCase(),
    path,
    query,
    status_code: Number(m[5]),
    content_type: null,
    user_agent: ua,
    referer,
    client_ip: m[1] !== '-' ? m[1] : null,
    asn: null,
    ip_trust: ipTrust,
    sec_purpose: null,
    rfc9421_headers: null,
  })
}

// ---------------------------------------------------------------------------
// Static Asset Filter & Request Classification (§7.3)
// ---------------------------------------------------------------------------

const STATIC_ASSET_EXTENSIONS = new Set([
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.map',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.ico',
  '.bmp',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp4',
  '.webm',
  '.mp3',
  '.ogg',
  '.wav',
])

const SPECIAL_CRAWL_PATHS = new Set([
  '/robots.txt',
  '/llms.txt',
  '/llms-full.txt',
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/feed',
  '/feed/',
  '/rss',
  '/rss.xml',
  '/atom.xml',
])

export interface LogRowFilterOptions {
  readonly decoy_paths?: readonly string[]
  readonly sdk_paths?: readonly string[]
}

export interface LogRowFilterDecision {
  readonly accept: boolean
  readonly reason:
    | 'document'
    | 'special_crawl_file'
    | 'sdk_probe'
    | 'decoy_path'
    | 'declared_or_signed_actor'
    | 'dropped_static_asset'
  readonly is_document: boolean
  readonly is_decoy_hit: boolean
  readonly is_sdk_probe: boolean
  readonly is_prefetch: boolean
  readonly has_request_time_automation_evidence: boolean
}

function getPathExtension(path: string): string | null {
  const lastSegment = path.split('/').pop() ?? ''
  const dotIdx = lastSegment.lastIndexOf('.')
  if (dotIdx <= 0) return null
  return lastSegment.slice(dotIdx).toLowerCase()
}

export function classifyLogRowAcceptance(
  row: NormalizedRawLogRow,
  options?: LogRowFilterOptions,
): LogRowFilterDecision {
  const lowerPath = row.path.toLowerCase()
  const isPrefetch =
    row.sec_purpose !== null &&
    /\b(?:prefetch|prerender)\b/i.test(row.sec_purpose)

  const decoyPaths = options?.decoy_paths ?? ['/_ugk-decoy/']
  const isDecoy = decoyPaths.some((dp) => {
    const norm = dp.toLowerCase()
    return lowerPath === norm || lowerPath.startsWith(norm.endsWith('/') ? norm : `${norm}/`)
  })

  const sdkPaths = options?.sdk_paths ?? ['/_ugk/', '/ugk.js', '/ugk-probe']
  const isSdkProbe = sdkPaths.some((sp) => {
    const norm = sp.toLowerCase()
    return lowerPath === norm || lowerPath.startsWith(norm)
  })

  const declaredUa = matchDeclaredActorByUa(row.user_agent)
  const parsedAgent = row.rfc9421_headers?.signature_agent
    ? parseSignatureAgentHeader(row.rfc9421_headers.signature_agent)
    : null
  const declaredAgent = parsedAgent
    ? matchDeclaredActorBySignatureAgent(parsedAgent.uri)
    : null
  const hasPolicyToken = row.user_agent ? lookupPolicyOnlyToken(row.user_agent) !== null : false
  const hasSignatureHeaders = row.rfc9421_headers !== null
  const hasAutomationEvidence =
    isDecoy || declaredUa !== null || declaredAgent !== null || hasSignatureHeaders || hasPolicyToken

  // 1. Decoy path (robots.txt Disallow-only) -> ALWAYS accept
  if (isDecoy) {
    return Object.freeze({
      accept: true,
      reason: 'decoy_path',
      is_document: false,
      is_decoy_hit: true,
      is_sdk_probe: false,
      is_prefetch: isPrefetch,
      has_request_time_automation_evidence: true,
    })
  }

  // 2. SDK empty/probe file fetch -> ALWAYS accept (§7.3)
  if (isSdkProbe) {
    return Object.freeze({
      accept: true,
      reason: 'sdk_probe',
      is_document: false,
      is_decoy_hit: false,
      is_sdk_probe: true,
      is_prefetch: isPrefetch,
      has_request_time_automation_evidence: hasAutomationEvidence,
    })
  }

  // 3. Special crawl/discovery files: robots.txt, llms.txt, sitemaps, RSS/Atom feeds
  const isSpecialCrawl =
    SPECIAL_CRAWL_PATHS.has(lowerPath) ||
    /^\/sitemap[^/]*\.xml$/i.test(lowerPath) ||
    /\.(?:rss|atom)$/i.test(lowerPath)
  if (isSpecialCrawl) {
    return Object.freeze({
      accept: true,
      reason: 'special_crawl_file',
      is_document: false,
      is_decoy_hit: false,
      is_sdk_probe: false,
      is_prefetch: isPrefetch,
      has_request_time_automation_evidence: hasAutomationEvidence,
    })
  }

  // 4. Static asset check
  const ext = getPathExtension(lowerPath)
  const isStaticExt = ext !== null && STATIC_ASSET_EXTENSIONS.has(ext)
  const isNonHtmlContentType =
    row.content_type !== null &&
    !/text\/html|application\/xhtml\+xml/i.test(row.content_type) &&
    /text\/css|javascript|image\/|font\/|video\/|audio\//i.test(row.content_type)

  if (isStaticExt || isNonHtmlContentType) {
    // Keep ONLY if declared/signed actor (e.g., to observe JS download rate of bots!)
    if (hasAutomationEvidence) {
      return Object.freeze({
        accept: true,
        reason: 'declared_or_signed_actor',
        is_document: false,
        is_decoy_hit: false,
        is_sdk_probe: false,
        is_prefetch: isPrefetch,
        has_request_time_automation_evidence: true,
      })
    }
    return Object.freeze({
      accept: false,
      reason: 'dropped_static_asset',
      is_document: false,
      is_decoy_hit: false,
      is_sdk_probe: false,
      is_prefetch: isPrefetch,
      has_request_time_automation_evidence: false,
    })
  }

  // 5. Document request
  return Object.freeze({
    accept: true,
    reason: 'document',
    is_document: true,
    is_decoy_hit: false,
    is_sdk_probe: false,
    is_prefetch: isPrefetch,
    has_request_time_automation_evidence: hasAutomationEvidence,
  })
}

// ---------------------------------------------------------------------------
// Signed Batch Ingest Pipeline
// ---------------------------------------------------------------------------

export interface LogIngestBatchRequest {
  readonly tenant_id: string
  readonly site_id: string
  readonly default_host: string
  readonly adapter: HostingAdapterKind
  readonly content_type: 'application/x-ndjson' | 'application/json' | 'text/plain'
  readonly raw_body: string
  readonly timestamp_sec: number
  readonly signature_header: string | null | undefined
}

export interface LogIngestPipelineOptions {
  readonly ingest_secret: string | Buffer
  readonly now_sec?: number
  readonly max_skew_seconds?: number
  readonly url_key_rules?: Partial<UrlKeyV2Rules>
  readonly filter_options?: LogRowFilterOptions
  readonly sealing_vault?: DailySealingKeyVault
  readonly ip_privacy_entitlement?: IpPrivacyEntitlementOptions
  readonly pseudonym_key_ring?: PurposePseudonymKeyRing
  readonly unknown_ua_quorum?: UnknownUaQuorumTracker
  readonly request_class_p?: boolean
}

export interface LogIngestBatchResult {
  readonly ok: boolean
  readonly error?: string
  readonly tenant_id: string
  readonly site_id: string
  readonly capture_path: CapturePath
  readonly total_records_received: number
  readonly accepted_observations: readonly ActorObservationRecord[]
  /** Request-time ephemeral IPs mapped by observation_id (kept in RAM for live verdict only; NEVER persisted!) */
  readonly ephemeral_ips: Readonly<Record<string, string>>
  readonly dropped_static_count: number
  readonly prefetch_flagged_count: number
  readonly parse_error_count: number
  readonly quorum_updates: readonly UnknownUaQuorumEntry[]
}

function parseRawBatchPayload(
  contentType: LogIngestBatchRequest['content_type'],
  rawBody: string,
  adapter: HostingAdapterKind,
): { records: unknown[]; parseErrors: number } {
  const trimmed = rawBody.trim()
  if (!trimmed) return { records: [], parseErrors: 0 }

  if (contentType === 'text/plain' || (adapter === 'shared_hosting_daily' && !trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0)
    return { records: lines, parseErrors: 0 }
  }

  if (contentType === 'application/json' || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return { records: parsed, parseErrors: 0 }
      return { records: [parsed], parseErrors: 0 }
    } catch {
      return { records: [], parseErrors: 1 }
    }
  }

  // NDJSON (application/x-ndjson)
  const records: unknown[] = []
  let parseErrors = 0
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim()
    if (!l) continue
    try {
      records.push(JSON.parse(l))
    } catch {
      parseErrors++
    }
  }
  return { records, parseErrors }
}

/**
 * 署名付き POST 一括ログ取込パイプライン。
 */
export function ingestSignedLogBatch(
  req: LogIngestBatchRequest,
  options: LogIngestPipelineOptions,
): LogIngestBatchResult {
  const capturePath = ADAPTER_CAPTURE_PATH[req.adapter]

  if (!req.tenant_id.trim() || !req.site_id.trim()) {
    return Object.freeze({
      ok: false,
      error: 'tenant_id_and_site_id_required',
      tenant_id: req.tenant_id,
      site_id: req.site_id,
      capture_path: capturePath,
      total_records_received: 0,
      accepted_observations: Object.freeze([]),
      ephemeral_ips: Object.freeze({}),
      dropped_static_count: 0,
      prefetch_flagged_count: 0,
      parse_error_count: 0,
      quorum_updates: Object.freeze([]),
    })
  }

  const sigCheck = verifyLogIngestSignature({
    tenant_id: req.tenant_id,
    site_id: req.site_id,
    timestamp_sec: req.timestamp_sec,
    signature_header: req.signature_header,
    raw_body: req.raw_body,
    secret: options.ingest_secret,
    now_sec: options.now_sec,
    max_skew_seconds: options.max_skew_seconds,
  })

  if (!sigCheck.valid) {
    return Object.freeze({
      ok: false,
      error: sigCheck.reason,
      tenant_id: req.tenant_id,
      site_id: req.site_id,
      capture_path: capturePath,
      total_records_received: 0,
      accepted_observations: Object.freeze([]),
      ephemeral_ips: Object.freeze({}),
      dropped_static_count: 0,
      prefetch_flagged_count: 0,
      parse_error_count: 0,
      quorum_updates: Object.freeze([]),
    })
  }

  const { records, parseErrors: initialParseErrors } = parseRawBatchPayload(
    req.content_type,
    req.raw_body,
    req.adapter,
  )

  const accepted: ActorObservationRecord[] = []
  const ephemeralIps: Record<string, string> = {}
  const quorumUpdates: UnknownUaQuorumEntry[] = []
  let droppedStatic = 0
  let prefetchFlagged = 0
  let parseErrors = initialParseErrors

  for (let i = 0; i < records.length; i++) {
    const row = adaptHostingLogRecord(req.adapter, records[i], req.default_host)
    if (!row) {
      parseErrors++
      continue
    }

    const decision = classifyLogRowAcceptance(row, options.filter_options)
    if (!decision.accept) {
      droppedStatic++
      continue
    }
    if (decision.is_prefetch) {
      prefetchFlagged++
    }

    // URL & Referer normalization via url_key_v2
    const fullUrl = `https://${row.host}${row.path}${row.query ?? ''}`
    const urlKey = computeUrlKeyV2(fullUrl, options.url_key_rules).url_key_v2
    const refererKey = row.referer
      ? computeUrlKeyV2(row.referer, options.url_key_rules).url_key_v2
      : null

    // UA reduction (§7.3): retain raw_ua ONLY when request-time automation evidence exists
    const reducedUa = reduceStandardBrowserUa(row.user_agent)
    const retainRawUa = decision.has_request_time_automation_evidence

    // IP minimization (E/T/P class) + 4 purpose pseudonyms
    let ipEvidence: MinimizedIpEvidence | null = null
    const pseudonyms: Partial<Record<NetworkPseudonymPurpose, string>> = {}
    const prefix = row.client_ip ? truncateIpPrefix(row.client_ip) : null

    if (row.client_ip && options.sealing_vault) {
      ipEvidence = classifyAndMinimizeIpAddress(
        {
          tenant_id: req.tenant_id,
          site_id: req.site_id,
          raw_ip: row.client_ip,
          asn: row.asn,
          observed_at: row.observed_at,
          has_request_time_automation_evidence: decision.has_request_time_automation_evidence,
          request_class_p: options.request_class_p,
        },
        options.sealing_vault,
        options.ip_privacy_entitlement,
      )
    }

    if (prefix && options.pseudonym_key_ring) {
      const utcDay = row.observed_at.slice(0, 10)
      pseudonyms.daily_cap = derivePurposeNetworkPseudonym(
        {
          purpose: 'daily_cap',
          tenant_id: req.tenant_id,
          site_id: req.site_id,
          network_prefix: prefix,
          asn: row.asn,
          scope_id: utcDay,
        },
        options.pseudonym_key_ring,
      )
      pseudonyms.quorum = derivePurposeNetworkPseudonym(
        {
          purpose: 'quorum',
          tenant_id: req.tenant_id,
          site_id: req.site_id,
          network_prefix: prefix,
          asn: row.asn,
          scope_id: utcDay.slice(0, 7),
        },
        options.pseudonym_key_ring,
      )
    }

    // Unknown non-browser UA quorum tracking (10 req AND 3 distinct networks within same salt epoch — §7.3)
    if (
      options.unknown_ua_quorum &&
      row.user_agent &&
      !reducedUa.is_standard_browser &&
      !decision.has_request_time_automation_evidence
    ) {
      const networkKey = pseudonyms.quorum ?? prefix ?? 'unknown_net'
      const quorumEpoch = row.observed_at.slice(0, 7)
      const qEntry = options.unknown_ua_quorum.record({
        raw_ua: row.user_agent,
        network_key: networkKey,
        observed_at: row.observed_at,
        quorum_epoch: quorumEpoch,
      })
      quorumUpdates.push(qEntry)
    }

    const obsHash = createHash('sha256')
      .update(
        `${req.tenant_id}|${req.site_id}|${capturePath}|${row.observed_at}|${row.request_id ?? i}|${row.host}${row.path}`,
      )
      .digest('hex')
      .slice(0, 16)
    const obsId = `obs_${obsHash}`

    if (row.client_ip) {
      ephemeralIps[obsId] = row.client_ip
    }

    const obs: ActorObservationRecord = Object.freeze({
      observation_id: obsId,
      tenant_id: req.tenant_id,
      site_id: req.site_id,
      observed_at: row.observed_at,
      request_id: row.request_id,
      capture_path: capturePath,
      method: row.method,
      host: row.host,
      path: row.path,
      query: row.query,
      url_key_v2: urlKey,
      referer_url_key_v2: refererKey,
      status_code: row.status_code,
      is_document: decision.is_document,
      is_prefetch: decision.is_prefetch,
      is_decoy_hit: decision.is_decoy_hit,
      ua_family_version: reducedUa.reduced_label,
      raw_ua: retainRawUa ? row.user_agent : null,
      ip_trust: row.ip_trust,
      ip_evidence: ipEvidence,
      asn: row.asn,
      network_pseudonyms:
        Object.keys(pseudonyms).length > 0 ? Object.freeze(pseudonyms) : undefined,
      rfc9421_headers: row.rfc9421_headers,
      has_js_pv_join: false,
      sdk_probe_hit: decision.is_sdk_probe,
    })

    accepted.push(obs)
  }

  return Object.freeze({
    ok: true,
    tenant_id: req.tenant_id,
    site_id: req.site_id,
    capture_path: capturePath,
    total_records_received: records.length,
    accepted_observations: Object.freeze(accepted),
    ephemeral_ips: Object.freeze(ephemeralIps),
    dropped_static_count: droppedStatic,
    prefetch_flagged_count: prefetchFlagged,
    parse_error_count: parseErrors,
    quorum_updates: Object.freeze(quorumUpdates),
  })
}

// ---------------------------------------------------------------------------
// Per-Actor-Class Capture Coverage Calculator (§7.3, act.G13, act.G14)
// ---------------------------------------------------------------------------

export type CoverageStatus = 'observed' | 'partial' | 'not_collected'

export interface ActorClassCoverageEntry {
  readonly actor_class: ActorClass
  readonly status: CoverageStatus
  readonly active_supporting_paths: readonly CapturePath[]
  readonly unlocking_paths: readonly CapturePath[]
  readonly blind_spot_note: string | null
}

export interface SiteActorCaptureCoverage {
  readonly active_paths: readonly CapturePath[]
  /** 観測できた人数から未取得クラスを倍率推定しない契約フラグ (§7.3) */
  readonly never_scale_from_observed: true
  readonly classes: Readonly<Record<ActorClass, ActorClassCoverageEntry>>
}

const SERVER_REALTIME_PATHS: readonly CapturePath[] = ['P1', 'P2', 'P3', 'P4']
const ALL_SERVER_PATHS: readonly CapturePath[] = ['P1', 'P2', 'P3', 'P4', 'P5']

/**
 * サイトの有効な取得経路 (`P0`–`P7`) から行為者クラスごとのカバレッジを算出する (§7.3)。
 * タグのみ (`P0`) のサイトでは JS を動かさないボット・非JSブラウザ等を必ず `not_collected` と明示する。
 */
export function computeActorCaptureCoverage(
  activePaths: readonly CapturePath[],
): SiteActorCaptureCoverage {
  const activeSet = new Set<CapturePath>(activePaths)
  const hasP0 = activeSet.has('P0')
  const activeRealtimeServer = SERVER_REALTIME_PATHS.filter((p) => activeSet.has(p))
  const activeAnyServer = ALL_SERVER_PATHS.filter((p) => activeSet.has(p))
  const hasRealtimeServer = activeRealtimeServer.length > 0
  const hasDailyServerOnly = !hasRealtimeServer && activeSet.has('P5')

  const freezePaths = (paths: readonly CapturePath[]): readonly CapturePath[] =>
    Object.freeze([...paths])

  const classes: Record<ActorClass, ActorClassCoverageEntry> = {
    browser_with_js: Object.freeze({
      actor_class: 'browser_with_js',
      status: hasP0 ? 'observed' : 'not_collected',
      active_supporting_paths: freezePaths(hasP0 ? ['P0', ...activeAnyServer] : []),
      unlocking_paths: freezePaths(['P0']),
      blind_spot_note: hasP0 ? null : 'Browser JS SDK (P0) not installed',
    }),
    browser_without_js: Object.freeze({
      actor_class: 'browser_without_js',
      status:
        hasRealtimeServer && hasP0
          ? 'observed'
          : hasDailyServerOnly && hasP0
            ? 'partial'
            : 'not_collected',
      active_supporting_paths: freezePaths(hasP0 ? activeAnyServer : []),
      unlocking_paths: freezePaths(['P1', 'P2', 'P3', 'P4']),
      blind_spot_note:
        !hasP0 || activeAnyServer.length === 0
          ? 'Requires both server document log (P1-P4) and browser SDK (P0) Server-Timing handoff'
          : hasDailyServerOnly
            ? 'Shared hosting daily log (P5) lacks Server-Timing handoff; join is aggregate-only'
            : null,
    }),
    ai_agent_verified: Object.freeze({
      actor_class: 'ai_agent_verified',
      status: hasRealtimeServer
        ? 'observed'
        : hasDailyServerOnly
          ? 'partial'
          : 'not_collected',
      active_supporting_paths: freezePaths(activeAnyServer),
      unlocking_paths: freezePaths(['P1', 'P2', 'P3', 'P4', 'P5']),
      blind_spot_note:
        activeAnyServer.length === 0
          ? 'Tag-only (P0) is blind to non-JS AI agents and HTTP signatures; add P1-P5'
          : hasDailyServerOnly
            ? 'P5 shared hosting logs omit RFC 9421 signature headers (IP/SAIL verification only)'
            : null,
    }),
    search_crawler_verified: Object.freeze({
      actor_class: 'search_crawler_verified',
      status: activeAnyServer.length > 0 ? 'observed' : 'not_collected',
      active_supporting_paths: freezePaths(activeAnyServer),
      unlocking_paths: freezePaths(['P1', 'P2', 'P3', 'P4', 'P5']),
      blind_spot_note:
        activeAnyServer.length === 0
          ? 'Tag-only (P0) cannot verify search crawler IPs or FCrDNS; add P1-P5'
          : null,
    }),
    automation_declared: Object.freeze({
      actor_class: 'automation_declared',
      status: activeAnyServer.length > 0 ? 'observed' : 'not_collected',
      active_supporting_paths: freezePaths(activeAnyServer),
      unlocking_paths: freezePaths(['P1', 'P2', 'P3', 'P4', 'P5']),
      blind_spot_note:
        activeAnyServer.length === 0
          ? 'Non-JS declared bots are invisible to tag-only (P0)'
          : null,
    }),
    automation_explicit: Object.freeze({
      actor_class: 'automation_explicit',
      status: activeAnyServer.length > 0 ? 'observed' : 'not_collected',
      active_supporting_paths: freezePaths(activeAnyServer),
      unlocking_paths: freezePaths(['P1', 'P2', 'P3', 'P4', 'P5']),
      blind_spot_note:
        activeAnyServer.length === 0
          ? 'Decoy path hits (robots.txt Disallow) require server logs (P1-P5)'
          : null,
    }),
    own_instrument: Object.freeze({
      actor_class: 'own_instrument',
      status:
        activeSet.has('P6') || activeAnyServer.length > 0 ? 'observed' : 'not_collected',
      active_supporting_paths: freezePaths([
        ...(activeSet.has('P6') ? (['P6'] as CapturePath[]) : []),
        ...activeAnyServer,
      ]),
      unlocking_paths: freezePaths(['P6', 'P1']),
      blind_spot_note: null,
    }),
    unclassified: Object.freeze({
      actor_class: 'unclassified',
      status: activeAnyServer.length > 0 ? 'observed' : 'not_collected',
      active_supporting_paths: freezePaths(activeAnyServer),
      unlocking_paths: freezePaths(['P1', 'P2', 'P3', 'P4', 'P5']),
      blind_spot_note:
        activeAnyServer.length === 0
          ? 'Server-side document log (P1-P5) required to observe unclassified fetches'
          : null,
    }),
  }

  return Object.freeze({
    active_paths: Object.freeze([...activeSet]),
    never_scale_from_observed: true,
    classes: Object.freeze(classes),
  })
}
