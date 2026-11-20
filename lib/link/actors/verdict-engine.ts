/**
 * UGOKI LINK v2 — 束 3-D (手順 10): 観測レコードと再計算可能判定レコードの分離・多方式検証エンジン
 *
 * 設計書 §7.1, §7.2, §7.3, §7.4 / actors-final.md M1, M2, M3, C.M2, C.M3:
 * 1. 追記専用の観測レコード (`ActorObservationRecord`) と版付き再計算可能判定レコード
 *    (`ActorVerdictRecord`, `verdict_version`) を完全に分離する。
 * 2. 「名乗り (`declared_*`)」と「検証 (`verified_*`)」を絶対に混ぜない。
 *    UA 一致のみでは必ず `identity_assurance = 'declared_only'`, `verified_actor_id = null`。
 * 3. RFC 9421 Web Bot Auth (`Signature-Input` / `Signature` / `Signature-Agent` 2形式両対応) を
 *    WebCrypto (Ed25519 / ECDSA P-256) と `ActorEvidenceClock` の過去時点公開鍵で検証。
 * 4. SAIL 網羅一覧 (`refuted` 含む)・公開 IP 範囲・FCrDNS・おとり経路 (`is_decoy_hit`) を統合判定。
 * 5. `X-Forwarded-For` / `Forwarded` 偽装プローブ失敗サイト (`ip_spoofable`) は
 *    IP 依存検証を禁止し `declared_only` (`unverifiable_ip_untrusted`) に頭打ちする (`act.G5`)。
 * 6. `Google-Extended` / `Applebot-Extended` 等の方針専用トークンは HTTP 行為者として検証しない。
 */

import { createHash, webcrypto } from 'node:crypto'

import {
  ActorEvidenceClock,
  computeJwkThumbprintSha256,
  formatIpv4,
  formatIpv6,
  parseIp,
  type EvidenceVerificationResult,
  type Rfc9421Jwk,
} from '@/lib/link/clocks/actor-evidence-snapshot'

import {
  DailySealingKeyVault,
  KeyDestroyedError,
  type MinimizedIpEvidence,
  type NetworkPseudonymPurpose,
} from './ip-privacy'
import {
  ACTOR_REGISTRY_VERSION,
  findActorById,
  lookupPolicyOnlyToken,
  matchDeclaredActorBySignatureAgent,
  matchDeclaredActorByUa,
  reduceStandardBrowserUa,
  type ActorRegistryEntry,
  type VerificationMethodKind,
} from './registry'

const subtle = webcrypto.subtle

// ---------------------------------------------------------------------------
// Types: Observation (Append-Only) vs Verdict (Versioned & Recomputable)
// ---------------------------------------------------------------------------

export type IpTrustLevel =
  | 'direct_socket'
  | 'proxy_restored_attested'
  | 'proxy_restored_unattested'
  | 'missing'

export interface Rfc9421ObservationHeaders {
  readonly signature_input: string
  readonly signature: string
  readonly signature_agent?: string | null
  /** Optional extra covered header values (lowercase header names) */
  readonly covered_headers?: Readonly<Record<string, string>>
}

/**
 * 追記専用（改変不能）のサーバー観測レコード。
 * 再計算時も一切書き換えず、ここから `ActorVerdictRecord` を何度でも再生成できる。
 */
export interface ActorObservationRecord {
  readonly observation_id: string
  readonly tenant_id: string
  readonly site_id: string
  readonly observed_at: string
  readonly request_id: string | null
  readonly capture_path: string
  readonly method: string
  readonly host: string
  readonly path: string
  readonly query: string | null
  readonly url_key_v2: string | null
  readonly referer_url_key_v2: string | null
  readonly status_code: number
  readonly is_document: boolean
  readonly is_prefetch: boolean
  readonly is_decoy_hit: boolean
  /** 標準ブラウザは系統+版 (例: `Chrome/131`)、自動操作・未知は先頭トークン+版 */
  readonly ua_family_version: string
  /** 生 UA は自動操作証拠あり行のみ保持。通常ブラウザ行は必ず `null` (§7.3) */
  readonly raw_ua: string | null
  readonly ip_trust: IpTrustLevel
  readonly ip_evidence: MinimizedIpEvidence | null
  readonly asn: number | null
  readonly network_pseudonyms?: Readonly<Partial<Record<NetworkPseudonymPurpose, string>>>
  readonly rfc9421_headers: Rfc9421ObservationHeaders | null
  readonly has_js_pv_join: boolean
  readonly sdk_probe_hit: boolean
}

export type ActorClass =
  | 'ai_agent_verified'
  | 'search_crawler_verified'
  | 'automation_declared'
  | 'automation_explicit'
  | 'own_instrument'
  | 'browser_with_js'
  | 'browser_without_js'
  | 'unclassified'

export type IdentityAssurance =
  | 'verified'
  | 'verified_operator'
  | 'crypto_domain'
  | 'declared_only'
  | 'asn_consistent'
  | 'refuted'
  | 'unverified'

export type VerdictVerificationResult =
  | EvidenceVerificationResult
  | 'crypto_domain'
  | 'asn_consistent'
  | 'unverifiable_ip_untrusted'
  | 'signature_invalid'
  | 'signature_expired'
  | 'not_applicable'

export interface VerificationMethodOutcome {
  readonly method: VerificationMethodKind | 'decoy_path'
  readonly attempted: boolean
  readonly result: VerdictVerificationResult
  readonly source_id: string | null
  readonly snapshot_id: string | null
  readonly detail: string
}

/**
 * 版付き再計算可能判定レコード。観測レコードとは別テーブル/別オブジェクトで管理する。
 */
export interface ActorVerdictRecord {
  readonly verdict_id: string
  readonly observation_id: string
  readonly tenant_id: string
  readonly site_id: string
  readonly verdict_version: string
  readonly registry_version: string
  readonly recomputed_at: string
  readonly evidence_snapshot_ids: readonly string[]
  // --- 名乗り (Claim) — 検証結果と完全分離 ---
  readonly declared_actor_id: string | null
  readonly declared_operator: string | null
  readonly declared_basis: 'ua' | 'signature_agent' | 'both' | 'none'
  /** robots.txt 方針専用トークン (`Google-Extended` 等) が UA に混入した場合に記録。HTTP 行為者化しない */
  readonly policy_token_detected: string | null
  // --- 検証 (Proof) — 名乗りとは完全分離 ---
  readonly verified_actor_id: string | null
  readonly verified_operator: string | null
  readonly verified_domain: string | null
  readonly actor_class: ActorClass
  readonly identity_assurance: IdentityAssurance
  readonly verification_result: VerdictVerificationResult
  /** UI・レポート表示用の明示ラベル（名乗り止まりを検証済みと混同しない） */
  readonly reporting_label: string
  readonly replay_suspected: boolean
  readonly is_provisional_30d: boolean
  readonly method_results: readonly VerificationMethodOutcome[]
}

// ---------------------------------------------------------------------------
// RFC 9421 Web Bot Auth: Parsing, Signing & WebCrypto Verification
// ---------------------------------------------------------------------------

export interface ParsedSignatureInput {
  readonly label: string
  readonly covered_components: readonly string[]
  readonly raw_signature_params: string
  readonly created: number | null
  readonly expires: number | null
  readonly keyid: string | null
  readonly tag: string | null
  readonly nonce: string | null
  readonly alg: string | null
}

export interface ParsedSignatureAgent {
  readonly format: 'string' | 'dictionary'
  readonly key: string | null
  readonly uri: string
  readonly origin_host: string | null
}

/**
 * `Signature-Agent` ヘッダの 2 形式両対応パーサー (facts/web-ai-agents.md §2, §5, §8):
 * 1. OpenAI 形式 (RFC 8941 String): `"https://chatgpt.com"`
 * 2. IETF draft-01 形式 (RFC 8941 Dictionary): `g="https://agent.bot.goog"` または `sig1="https://chatgpt.com"`
 */
export function parseSignatureAgentHeader(headerValue: string | null | undefined): ParsedSignatureAgent | null {
  if (!headerValue || !headerValue.trim()) return null
  const trimmed = headerValue.trim()

  // Form 1: Bare RFC 8941 quoted string `"https://chatgpt.com"`
  const bareMatch = /^"([^"]+)"$/.exec(trimmed)
  if (bareMatch) {
    const uri = bareMatch[1].trim()
    return Object.freeze({
      format: 'string',
      key: null,
      uri,
      origin_host: extractUriHost(uri),
    })
  }

  // Form 2: RFC 8941 dictionary `g="https://agent.bot.goog"` (take first member with string value)
  const dictMatch = /(?:^|,\s*)([a-z*][a-z0-9_.*-]*)\s*=\s*"([^"]+)"/i.exec(trimmed)
  if (dictMatch) {
    const uri = dictMatch[2].trim()
    return Object.freeze({
      format: 'dictionary',
      key: dictMatch[1],
      uri,
      origin_host: extractUriHost(uri),
    })
  }

  return null
}

function extractUriHost(uri: string): string | null {
  try {
    const u = new URL(uri)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return u.hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * `Signature-Input` ヘッダを解析する (RFC 9421 §4.1)。
 * 複数ラベルがある場合は `tag="web-bot-auth"` を優先選択する。
 */
export function parseSignatureInputHeader(headerValue: string): ParsedSignatureInput | null {
  if (!headerValue || !headerValue.trim()) return null

  const entries: ParsedSignatureInput[] = []
  // Match `<label>=(<components>)<params>` entries separated by top-level commas
  const entryRe = /([a-z*][a-z0-9_.*-]*)\s*=\s*(\(([^)]*)\)(?:;[^,]*)?)/gi
  let match: RegExpExecArray | null
  while ((match = entryRe.exec(headerValue)) !== null) {
    const label = match[1]
    const rawParams = match[2].trim()
    const compBody = match[3]

    const components: string[] = []
    const compRe = /"([^"]+)"/g
    let cm: RegExpExecArray | null
    while ((cm = compRe.exec(compBody)) !== null) {
      components.push(cm[1].toLowerCase())
    }

    const createdMatch = /;created=(\d+)/i.exec(rawParams)
    const expiresMatch = /;expires=(\d+)/i.exec(rawParams)
    const keyidMatch = /;keyid="([^"]+)"/i.exec(rawParams)
    const tagMatch = /;tag="([^"]+)"/i.exec(rawParams)
    const nonceMatch = /;nonce="([^"]+)"/i.exec(rawParams)
    const algMatch = /;alg="([^"]+)"/i.exec(rawParams)

    entries.push(
      Object.freeze({
        label,
        covered_components: Object.freeze(components),
        raw_signature_params: rawParams,
        created: createdMatch ? Number(createdMatch[1]) : null,
        expires: expiresMatch ? Number(expiresMatch[1]) : null,
        keyid: keyidMatch ? keyidMatch[1] : null,
        tag: tagMatch ? tagMatch[1] : null,
        nonce: nonceMatch ? nonceMatch[1] : null,
        alg: algMatch ? algMatch[1] : null,
      }),
    )
  }

  if (entries.length === 0) return null
  return entries.find((e) => e.tag === 'web-bot-auth') ?? entries[0]
}

/**
 * `Signature` ヘッダから指定ラベルのバイト列 (`label=:base64:`) を取り出す。
 */
export function parseSignatureHeader(headerValue: string, label: string): Uint8Array | null {
  if (!headerValue || !label) return null
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:^|,\\s*)${escaped}\\s*=\\s*:([A-Za-z0-9+/=]+):`, 'i')
  const m = re.exec(headerValue.trim())
  if (!m) return null
  return new Uint8Array(Buffer.from(m[1], 'base64'))
}

export interface Rfc9421SignatureBaseInput {
  readonly covered_components: readonly string[]
  readonly raw_signature_params: string
  readonly method: string
  readonly authority: string
  readonly path: string
  readonly query?: string | null
  readonly signature_agent?: string | null
  readonly covered_headers?: Readonly<Record<string, string>>
}

/**
 * RFC 9421 §2.5 に準拠した署名ベース文字列を生成する。
 */
export function buildRfc9421SignatureBase(input: Rfc9421SignatureBaseInput): string {
  const lines: string[] = []
  const authority = input.authority.trim().toLowerCase()
  const path = input.path || '/'
  const normalizedQuery =
    input.query && input.query.length > 0
      ? input.query.startsWith('?')
        ? input.query
        : `?${input.query}`
      : '?'

  const lowerHeaders = new Map<string, string>()
  if (input.covered_headers) {
    for (const [k, v] of Object.entries(input.covered_headers)) {
      lowerHeaders.set(k.toLowerCase(), v)
    }
  }
  if (input.signature_agent) {
    lowerHeaders.set('signature-agent', input.signature_agent)
  }

  for (const comp of input.covered_components) {
    let val: string
    switch (comp) {
      case '@method':
        val = input.method.toUpperCase()
        break
      case '@authority':
        val = authority
        break
      case '@path':
        val = path
        break
      case '@query':
        val = normalizedQuery
        break
      case '@target-uri':
        val = `https://${authority}${path}${normalizedQuery === '?' ? '' : normalizedQuery}`
        break
      default: {
        const hv = lowerHeaders.get(comp)
        if (hv === undefined) {
          throw new Error(`Missing covered header component "${comp}" for RFC 9421 signature base`)
        }
        val = hv
      }
    }
    lines.push(`"${comp}": ${val}`)
  }

  lines.push(`"@signature-params": ${input.raw_signature_params}`)
  return lines.join('\n')
}

export type SupportedRfc9421Algorithm = 'Ed25519' | 'ES256'

export interface SignRfc9421RequestParams {
  readonly label?: string
  readonly algorithm: SupportedRfc9421Algorithm
  readonly privateKey: webcrypto.CryptoKey
  readonly publicJwk: Omit<Rfc9421Jwk, 'thumbprint_sha256'> & { readonly thumbprint_sha256?: string }
  readonly method: string
  readonly authority: string
  readonly path: string
  readonly query?: string | null
  readonly signature_agent: string
  readonly created: number
  readonly expires: number
  readonly nonce?: string
  readonly covered_components?: readonly string[]
  readonly covered_headers?: Readonly<Record<string, string>>
}

/**
 * テストおよび自社検証計器向けの RFC 9421 Web Bot Auth 署名生成ヘルパ (Ed25519 / ECDSA P-256)。
 */
export async function signRfc9421Request(
  params: SignRfc9421RequestParams,
): Promise<{
  readonly signature_input: string
  readonly signature: string
  readonly signature_agent: string
  readonly keyid: string
  readonly signature_base: string
}> {
  const label = params.label ?? 'sig1'
  const keyid = params.publicJwk.thumbprint_sha256 ?? computeJwkThumbprintSha256(params.publicJwk)
  const covered = params.covered_components ?? ['@authority', 'signature-agent']
  const compList = covered.map((c) => `"${c.toLowerCase()}"`).join(' ')
  const noncePart = params.nonce ? `;nonce="${params.nonce}"` : ''
  const algPart = params.algorithm === 'Ed25519' ? ';alg="ed25519"' : ';alg="ecdsa-p256-sha256"'
  const rawParams = `(${compList});created=${params.created};expires=${params.expires};keyid="${keyid}"${noncePart}${algPart};tag="web-bot-auth"`

  const signatureBase = buildRfc9421SignatureBase({
    covered_components: covered.map((c) => c.toLowerCase()),
    raw_signature_params: rawParams,
    method: params.method,
    authority: params.authority,
    path: params.path,
    query: params.query,
    signature_agent: params.signature_agent,
    covered_headers: params.covered_headers,
  })

  const data = new TextEncoder().encode(signatureBase)
  let rawSig: ArrayBuffer
  if (params.algorithm === 'Ed25519') {
    rawSig = await subtle.sign({ name: 'Ed25519' }, params.privateKey, data)
  } else {
    rawSig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, params.privateKey, data)
  }

  const sigB64 = Buffer.from(rawSig).toString('base64')
  return Object.freeze({
    signature_input: `${label}=${rawParams}`,
    signature: `${label}=:${sigB64}:`,
    signature_agent: params.signature_agent,
    keyid,
    signature_base: signatureBase,
  })
}

async function verifySignatureWithJwk(
  jwk: Rfc9421Jwk,
  signatureBase: string,
  signatureBytes: Uint8Array,
): Promise<boolean> {
  const data = new TextEncoder().encode(signatureBase)

  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && jwk.x) {
    const key = await subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: jwk.x, ext: true },
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    return subtle.verify({ name: 'Ed25519' }, key, signatureBytes, data)
  }

  if (jwk.kty === 'EC' && jwk.crv === 'P-256' && jwk.x && jwk.y) {
    const key = await subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signatureBytes, data)
  }

  return false
}

// ---------------------------------------------------------------------------
// Replay Cache (Flags `replay_suspected` without auto-refuting — C.M2)
// ---------------------------------------------------------------------------

export class Rfc9421ReplayCache {
  private readonly seen = new Map<string, number>()

  /**
   * 同一 `(keyid, nonce or sigHash)` が有効期限内に再出現した場合に `true` を返す。
   */
  checkAndRecord(params: {
    readonly keyid: string
    readonly nonce: string | null
    readonly signatureBytes: Uint8Array
    readonly nowSec: number
    readonly expiresSec: number
  }): boolean {
    // Opportunistic prune
    for (const [k, exp] of this.seen.entries()) {
      if (exp < params.nowSec) this.seen.delete(k)
    }

    const token =
      params.nonce ??
      createHash('sha256').update(params.signatureBytes).digest('hex').slice(0, 32)
    const cacheKey = `${params.keyid}|${token}`

    const existingExp = this.seen.get(cacheKey)
    if (existingExp !== undefined && existingExp >= params.nowSec) {
      return true
    }
    this.seen.set(cacheKey, params.expiresSec)
    return false
  }
}

export interface Rfc9421VerificationResult {
  readonly valid: boolean
  readonly result: VerdictVerificationResult
  readonly identity_assurance: IdentityAssurance
  readonly verified_actor_id: string | null
  readonly verified_operator: string | null
  readonly verified_domain: string | null
  readonly keyid: string | null
  readonly snapshot_id: string | null
  readonly source_id: string | null
  readonly replay_suspected: boolean
  readonly reason: string
}

export async function verifyRfc9421Signature(params: {
  readonly headers: Rfc9421ObservationHeaders
  readonly method: string
  readonly authority: string
  readonly path: string
  readonly query?: string | null
  readonly observed_at: string
  readonly clock: ActorEvidenceClock
  readonly replayCache?: Rfc9421ReplayCache
  /** Optional JWKS for an uncatalogued signer domain -> yields `crypto_domain` */
  readonly unknownDomainJwks?: readonly {
    readonly domain: string
    readonly jwks: readonly Rfc9421Jwk[]
  }[]
}): Promise<Rfc9421VerificationResult> {
  const parsedInput = parseSignatureInputHeader(params.headers.signature_input)
  if (!parsedInput) {
    return Object.freeze({
      valid: false,
      result: 'signature_invalid',
      identity_assurance: 'unverified',
      verified_actor_id: null,
      verified_operator: null,
      verified_domain: null,
      keyid: null,
      snapshot_id: null,
      source_id: null,
      replay_suspected: false,
      reason: 'malformed_signature_input',
    })
  }

  if (parsedInput.tag !== 'web-bot-auth') {
    return Object.freeze({
      valid: false,
      result: 'signature_invalid',
      identity_assurance: 'unverified',
      verified_actor_id: null,
      verified_operator: null,
      verified_domain: null,
      keyid: parsedInput.keyid,
      snapshot_id: null,
      source_id: null,
      replay_suspected: false,
      reason: `unexpected_tag_${parsedInput.tag ?? 'missing'}`,
    })
  }

  const sigBytes = parseSignatureHeader(params.headers.signature, parsedInput.label)
  if (!sigBytes || !parsedInput.keyid) {
    return Object.freeze({
      valid: false,
      result: 'signature_invalid',
      identity_assurance: 'unverified',
      verified_actor_id: null,
      verified_operator: null,
      verified_domain: null,
      keyid: parsedInput.keyid,
      snapshot_id: null,
      source_id: null,
      replay_suspected: false,
      reason: 'missing_signature_bytes_or_keyid',
    })
  }

  // Mandatory covered components: @authority (or @target-uri)
  const hasAuthority =
    parsedInput.covered_components.includes('@authority') ||
    parsedInput.covered_components.includes('@target-uri')
  if (!hasAuthority) {
    return Object.freeze({
      valid: false,
      result: 'signature_invalid',
      identity_assurance: 'unverified',
      verified_actor_id: null,
      verified_operator: null,
      verified_domain: null,
      keyid: parsedInput.keyid,
      snapshot_id: null,
      source_id: null,
      replay_suspected: false,
      reason: 'authority_not_covered',
    })
  }

  // Time window validation (C.M2): created <= T + 60s, T <= expires, expires - created <= 86400s
  const obsSec = Math.floor(Date.parse(params.observed_at) / 1000)
  if (
    parsedInput.created === null ||
    parsedInput.expires === null ||
    parsedInput.created > obsSec + 60 ||
    obsSec > parsedInput.expires ||
    parsedInput.expires - parsedInput.created > 86400
  ) {
    return Object.freeze({
      valid: false,
      result: 'signature_expired',
      identity_assurance: 'unverified',
      verified_actor_id: null,
      verified_operator: null,
      verified_domain: null,
      keyid: parsedInput.keyid,
      snapshot_id: null,
      source_id: null,
      replay_suspected: false,
      reason: 'signature_time_window_invalid',
    })
  }

  const parsedAgent = parseSignatureAgentHeader(params.headers.signature_agent)
  if (parsedAgent && !parsedInput.covered_components.includes('signature-agent')) {
    return Object.freeze({
      valid: false,
      result: 'signature_invalid',
      identity_assurance: 'unverified',
      verified_actor_id: null,
      verified_operator: null,
      verified_domain: null,
      keyid: parsedInput.keyid,
      snapshot_id: null,
      source_id: null,
      replay_suspected: false,
      reason: 'signature_agent_not_covered',
    })
  }

  let signatureBase: string
  try {
    signatureBase = buildRfc9421SignatureBase({
      covered_components: parsedInput.covered_components,
      raw_signature_params: parsedInput.raw_signature_params,
      method: params.method,
      authority: params.authority,
      path: params.path,
      query: params.query,
      signature_agent: params.headers.signature_agent,
      covered_headers: params.headers.covered_headers,
    })
  } catch (err) {
    return Object.freeze({
      valid: false,
      result: 'signature_invalid',
      identity_assurance: 'unverified',
      verified_actor_id: null,
      verified_operator: null,
      verified_domain: null,
      keyid: parsedInput.keyid,
      snapshot_id: null,
      source_id: null,
      replay_suspected: false,
      reason: err instanceof Error ? err.message : 'signature_base_error',
    })
  }

  // 1. Lookup public key in ActorEvidenceClock at observed_at
  const declaredByAgent = parsedAgent
    ? matchDeclaredActorBySignatureAgent(parsedAgent.uri)
    : null
  const preferredSourceId = declaredByAgent?.verification_methods.find(
    (m) => m.method === 'http_sig',
  )?.source_id

  const keyLookup = await params.clock.lookupKeyAtTime({
    thumbprint_or_kid: parsedInput.keyid,
    at: params.observed_at,
    source_id: preferredSourceId,
  })

  if (keyLookup.found && keyLookup.key) {
    if (!keyLookup.valid_at_time) {
      return Object.freeze({
        valid: false,
        result:
          keyLookup.reason === 'stale_snapshot'
            ? 'unverifiable_stale_evidence'
            : 'signature_expired',
        identity_assurance: 'unverified',
        verified_actor_id: null,
        verified_operator: null,
        verified_domain: parsedAgent?.origin_host ?? null,
        keyid: parsedInput.keyid,
        snapshot_id: keyLookup.snapshot_id,
        source_id: keyLookup.source_id,
        replay_suspected: false,
        reason: `clock_key_${keyLookup.reason}`,
      })
    }

    const cryptoOk = await verifySignatureWithJwk(keyLookup.key, signatureBase, sigBytes)
    if (!cryptoOk) {
      return Object.freeze({
        valid: false,
        result: 'signature_invalid',
        identity_assurance: 'unverified',
        verified_actor_id: null,
        verified_operator: null,
        verified_domain: parsedAgent?.origin_host ?? null,
        keyid: parsedInput.keyid,
        snapshot_id: keyLookup.snapshot_id,
        source_id: keyLookup.source_id,
        replay_suspected: false,
        reason: 'cryptographic_verification_failed',
      })
    }

    const replaySuspected = params.replayCache
      ? params.replayCache.checkAndRecord({
          keyid: parsedInput.keyid,
          nonce: parsedInput.nonce,
          signatureBytes: sigBytes,
          nowSec: obsSec,
          expiresSec: parsedInput.expires,
        })
      : false

    // Resolve actor entry from source_id or Signature-Agent URI
    const matchedEntry =
      declaredByAgent ??
      matchActorByHttpSigSourceId(keyLookup.source_id) ??
      (keyLookup.key.signature_agent
        ? matchDeclaredActorBySignatureAgent(keyLookup.key.signature_agent)
        : null)

    const resultCode: VerdictVerificationResult =
      keyLookup.relation === 'retro' ? 'verified_retro' : 'verified'

    return Object.freeze({
      valid: true,
      result: resultCode,
      identity_assurance: 'verified',
      verified_actor_id: matchedEntry?.actor_id ?? null,
      verified_operator: matchedEntry?.operator ?? keyLookup.provider,
      verified_domain: parsedAgent?.origin_host ?? null,
      keyid: parsedInput.keyid,
      snapshot_id: keyLookup.snapshot_id,
      source_id: keyLookup.source_id,
      replay_suspected: replaySuspected,
      reason: 'rfc9421_verified',
    })
  }

  // 2. Unknown signer domain fallback (proves domain possession -> `crypto_domain`, NOT registry verified)
  if (parsedAgent?.origin_host && params.unknownDomainJwks) {
    const domainEntry = params.unknownDomainJwks.find(
      (d) => d.domain.toLowerCase() === parsedAgent.origin_host,
    )
    const jwk = domainEntry?.jwks.find(
      (k) => k.thumbprint_sha256 === parsedInput.keyid || k.kid === parsedInput.keyid,
    )
    if (jwk) {
      const ok = await verifySignatureWithJwk(jwk, signatureBase, sigBytes)
      if (ok) {
        const replaySuspected = params.replayCache
          ? params.replayCache.checkAndRecord({
              keyid: parsedInput.keyid,
              nonce: parsedInput.nonce,
              signatureBytes: sigBytes,
              nowSec: obsSec,
              expiresSec: parsedInput.expires,
            })
          : false
        return Object.freeze({
          valid: true,
          result: 'crypto_domain',
          identity_assurance: 'crypto_domain',
          verified_actor_id: null,
          verified_operator: null,
          verified_domain: parsedAgent.origin_host,
          keyid: parsedInput.keyid,
          snapshot_id: null,
          source_id: `domain:${parsedAgent.origin_host}`,
          replay_suspected: replaySuspected,
          reason: 'unknown_signer_crypto_domain_verified',
        })
      }
      return Object.freeze({
        valid: false,
        result: 'signature_invalid',
        identity_assurance: 'unverified',
        verified_actor_id: null,
        verified_operator: null,
        verified_domain: parsedAgent.origin_host,
        keyid: parsedInput.keyid,
        snapshot_id: null,
        source_id: `domain:${parsedAgent.origin_host}`,
        replay_suspected: false,
        reason: 'unknown_domain_cryptographic_verification_failed',
      })
    }
  }

  return Object.freeze({
    valid: false,
    result:
      keyLookup.reason === 'no_snapshot' || keyLookup.reason === 'stale_snapshot'
        ? 'unverifiable_stale_evidence'
        : 'signature_invalid',
    identity_assurance: 'unverified',
    verified_actor_id: null,
    verified_operator: null,
    verified_domain: parsedAgent?.origin_host ?? null,
    keyid: parsedInput.keyid,
    snapshot_id: keyLookup.snapshot_id,
    source_id: keyLookup.source_id,
    replay_suspected: false,
    reason: `key_lookup_${keyLookup.reason}`,
  })
}

function matchActorByHttpSigSourceId(sourceId: string | null): ActorRegistryEntry | null {
  if (!sourceId) return null
  if (sourceId === 'openai:chatgpt-cloud-browser-jwks') {
    return findActorById('openai:chatgpt-cloud-browser')
  }
  if (sourceId === 'google:google-agent-jwks') {
    return findActorById('google:google-agent')
  }
  if (sourceId === 'you:youbot-jwks') {
    return findActorById('you:youbot')
  }
  return null
}

// ---------------------------------------------------------------------------
// FCrDNS Abstraction (Forward-Confirmed Reverse DNS)
// ---------------------------------------------------------------------------

export interface FcrdnsResolver {
  reversePtr(ip: string): Promise<readonly string[]>
  resolveForward(hostname: string): Promise<readonly string[]>
}

export interface FcrdnsCheckResult {
  readonly matched: boolean
  readonly ptr_hostname: string | null
  readonly detail: string
}

function canonicalizeIp(ip: string): string | null {
  const parsed = parseIp(ip)
  if (!parsed) return null
  return parsed.family === 4 ? formatIpv4(parsed.value) : formatIpv6(parsed.value)
}

export async function verifyFcrdns(
  ip: string,
  allowedSuffixes: readonly string[],
  resolver: FcrdnsResolver,
): Promise<FcrdnsCheckResult> {
  const normIp = canonicalizeIp(ip)
  if (!normIp || allowedSuffixes.length === 0) {
    return Object.freeze({ matched: false, ptr_hostname: null, detail: 'invalid_ip_or_no_suffixes' })
  }

  const ptrHosts = await resolver.reversePtr(normIp)
  for (const rawHost of ptrHosts) {
    const host = rawHost.trim().replace(/\.$/, '').toLowerCase()
    const suffixMatch = allowedSuffixes.some((s) => {
      const normSuffix = s.trim().replace(/\.$/, '').toLowerCase()
      return host.endsWith(normSuffix) && host.length > normSuffix.length
    })
    if (!suffixMatch) continue

    const forwardIps = await resolver.resolveForward(host)
    const forwardConfirmed = forwardIps.some((fip) => canonicalizeIp(fip) === normIp)
    if (forwardConfirmed) {
      return Object.freeze({
        matched: true,
        ptr_hostname: host,
        detail: `fcrdns_confirmed:${host}`,
      })
    }
  }

  return Object.freeze({
    matched: false,
    ptr_hostname: ptrHosts[0] ?? null,
    detail: 'fcrdns_mismatch',
  })
}

// ---------------------------------------------------------------------------
// Origin-Forgery Probe (X-Forwarded-For / Forwarded Spoofing Check — §7.2, act.G5)
// ---------------------------------------------------------------------------

export const ORIGIN_ATTESTATION_TTL_DAYS = 31

export interface OriginForgeryProbeInput {
  readonly tenant_id: string
  readonly site_id: string
  readonly host: string
  readonly probed_at: string
  /** 偽装ヘッダ (`X-Forwarded-For` / `Forwarded`) に載せたおとり IP */
  readonly forged_header_ip: string
  /** プローブ送信元（CRAWL）の実際の発信 IP */
  readonly probe_source_real_ip: string
  /** オリジン直結プローブがブロック/拒否されたか (403/timeout/TLS reject) */
  readonly direct_to_origin_blocked: boolean
  /** 直結プローブが通った場合にオリジンログへ記録された client IP */
  readonly direct_probe_logged_ip: string | null
  /** 正規プロキシ経由プローブでオリジンログへ記録された client IP */
  readonly proxied_probe_logged_ip: string | null
}

export interface OriginForgeryProbeResult {
  readonly tenant_id: string
  readonly site_id: string
  readonly host: string
  readonly probed_at: string
  readonly attested: boolean
  readonly ip_spoofable: boolean
  readonly effective_ip_trust: IpTrustLevel
  readonly valid_until: string | null
  readonly reason:
    | 'attested_proxy_only'
    | 'forged_xff_accepted_direct'
    | 'forged_xff_accepted_proxied'
    | 'direct_origin_exposed'
    | 'proxied_ip_mismatch'
}

/**
 * オリジン偽装接続プローブを評価する (`act.G5`, §7.2)。
 * 偽装した `X-Forwarded-For` / `Forwarded` がオリジンログにそのまま記録された場合、
 * `ip_spoofable = true` / `effective_ip_trust = 'proxy_restored_unattested'` へ降格する。
 */
export function evaluateOriginForgeryProbe(
  input: OriginForgeryProbeInput,
): OriginForgeryProbeResult {
  const forgedNorm = canonicalizeIp(input.forged_header_ip)
  const realNorm = canonicalizeIp(input.probe_source_real_ip)
  const directLogged = input.direct_probe_logged_ip ? canonicalizeIp(input.direct_probe_logged_ip) : null
  const proxiedLogged = input.proxied_probe_logged_ip ? canonicalizeIp(input.proxied_probe_logged_ip) : null

  if (!input.direct_to_origin_blocked && directLogged !== null && directLogged === forgedNorm) {
    return Object.freeze({
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      host: input.host.toLowerCase(),
      probed_at: input.probed_at,
      attested: false,
      ip_spoofable: true,
      effective_ip_trust: 'proxy_restored_unattested',
      valid_until: null,
      reason: 'forged_xff_accepted_direct',
    })
  }

  if (proxiedLogged !== null && proxiedLogged === forgedNorm) {
    return Object.freeze({
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      host: input.host.toLowerCase(),
      probed_at: input.probed_at,
      attested: false,
      ip_spoofable: true,
      effective_ip_trust: 'proxy_restored_unattested',
      valid_until: null,
      reason: 'forged_xff_accepted_proxied',
    })
  }

  if (!input.direct_to_origin_blocked) {
    return Object.freeze({
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      host: input.host.toLowerCase(),
      probed_at: input.probed_at,
      attested: false,
      ip_spoofable: true,
      effective_ip_trust: 'proxy_restored_unattested',
      valid_until: null,
      reason: 'direct_origin_exposed',
    })
  }

  if (proxiedLogged !== realNorm || realNorm === null) {
    return Object.freeze({
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      host: input.host.toLowerCase(),
      probed_at: input.probed_at,
      attested: false,
      ip_spoofable: true,
      effective_ip_trust: 'proxy_restored_unattested',
      valid_until: null,
      reason: 'proxied_ip_mismatch',
    })
  }

  const validUntil = new Date(
    Date.parse(input.probed_at) + ORIGIN_ATTESTATION_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  return Object.freeze({
    tenant_id: input.tenant_id,
    site_id: input.site_id,
    host: input.host.toLowerCase(),
    probed_at: input.probed_at,
    attested: true,
    ip_spoofable: false,
    effective_ip_trust: 'proxy_restored_attested',
    valid_until: validUntil,
    reason: 'attested_proxy_only',
  })
}

export class OriginIpTrustRegistry {
  private readonly records = new Map<string, OriginForgeryProbeResult>()

  private makeKey(tenantId: string, siteId: string, host: string): string {
    return `${tenantId}|${siteId}|${host.toLowerCase()}`
  }

  recordProbe(result: OriginForgeryProbeResult): void {
    this.records.set(this.makeKey(result.tenant_id, result.site_id, result.host), result)
  }

  resolveEffectiveIpTrust(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly host: string
    readonly observed_at: string
    readonly reported_ip_trust: IpTrustLevel
  }): { readonly effective_ip_trust: IpTrustLevel; readonly ip_spoofable: boolean } {
    if (params.reported_ip_trust === 'missing' || params.reported_ip_trust === 'proxy_restored_unattested') {
      return { effective_ip_trust: params.reported_ip_trust, ip_spoofable: true }
    }

    const probe = this.records.get(this.makeKey(params.tenant_id, params.site_id, params.host))
    if (!probe) {
      return { effective_ip_trust: params.reported_ip_trust, ip_spoofable: false }
    }

    if (probe.ip_spoofable) {
      return { effective_ip_trust: 'proxy_restored_unattested', ip_spoofable: true }
    }

    // Attestation expired (> 31 days)? Downgrade proxy_restored_attested to unattested
    if (
      params.reported_ip_trust === 'proxy_restored_attested' &&
      probe.valid_until !== null &&
      Date.parse(params.observed_at) > Date.parse(probe.valid_until)
    ) {
      return { effective_ip_trust: 'proxy_restored_unattested', ip_spoofable: true }
    }

    return { effective_ip_trust: params.reported_ip_trust, ip_spoofable: false }
  }
}

// ---------------------------------------------------------------------------
// Actor Verdict Engine (Recomputable, Versioned, Multi-Method)
// ---------------------------------------------------------------------------

export interface VerdictEngineDependencies {
  readonly clock: ActorEvidenceClock
  readonly fcrdns?: FcrdnsResolver
  readonly originTrustRegistry?: OriginIpTrustRegistry
  readonly replayCache?: Rfc9421ReplayCache
  readonly sealingVault?: DailySealingKeyVault
}

export interface EvaluateObservationOptions {
  readonly verdict_version?: string
  readonly recomputed_at?: string
  /** Optional ephemeral live IP available only at request ingestion time (never stored in observation!) */
  readonly ephemeral_raw_ip?: string | null
  /** Optional JWKS for uncatalogued domains */
  readonly unknownDomainJwks?: readonly {
    readonly domain: string
    readonly jwks: readonly Rfc9421Jwk[]
  }[]
  /** Mark verdicts as provisional during initial 30d period */
  readonly is_provisional_30d?: boolean
}

export class ActorVerdictEngine {
  constructor(private readonly deps: VerdictEngineDependencies) {}

  async evaluateObservation(
    observation: ActorObservationRecord,
    options?: EvaluateObservationOptions,
  ): Promise<ActorVerdictRecord> {
    const verdictVersion = options?.verdict_version ?? 'verdict/1'
    const recomputedAt = options?.recomputed_at ?? observation.observed_at
    const isProvisional = options?.is_provisional_30d ?? false

    // 1. Identify Claim (名乗り) — strictly separated from Proof
    const policyOnlyHit = observation.raw_ua ? lookupPolicyOnlyToken(observation.raw_ua) : null
    const declaredByUa = matchDeclaredActorByUa(observation.raw_ua)
    const parsedSigAgent = observation.rfc9421_headers?.signature_agent
      ? parseSignatureAgentHeader(observation.rfc9421_headers.signature_agent)
      : null
    const declaredByAgent = parsedSigAgent
      ? matchDeclaredActorBySignatureAgent(parsedSigAgent.uri)
      : null

    const declaredEntry = declaredByAgent ?? declaredByUa
    const declaredBasis: ActorVerdictRecord['declared_basis'] =
      declaredByUa && declaredByAgent
        ? 'both'
        : declaredByAgent
          ? 'signature_agent'
          : declaredByUa
            ? 'ua'
            : 'none'

    const methodResults: VerificationMethodOutcome[] = []
    const snapshotIds = new Set<string>()
    let replaySuspected = false

    // 2. Method A: RFC 9421 Web Bot Auth HTTP Signature (independent of IP trust!)
    let sigVerdict: Rfc9421VerificationResult | null = null
    if (observation.rfc9421_headers) {
      sigVerdict = await verifyRfc9421Signature({
        headers: observation.rfc9421_headers,
        method: observation.method,
        authority: observation.host,
        path: observation.path,
        query: observation.query,
        observed_at: observation.observed_at,
        clock: this.deps.clock,
        replayCache: this.deps.replayCache,
        unknownDomainJwks: options?.unknownDomainJwks,
      })
      if (sigVerdict.snapshot_id) snapshotIds.add(sigVerdict.snapshot_id)
      replaySuspected = sigVerdict.replay_suspected
      methodResults.push(
        Object.freeze({
          method: 'http_sig',
          attempted: true,
          result: sigVerdict.result,
          source_id: sigVerdict.source_id,
          snapshot_id: sigVerdict.snapshot_id,
          detail: sigVerdict.reason,
        }),
      )
    }

    // If RFC 9421 signature verified a known actor or domain, check own_instrument vs verified
    if (sigVerdict?.valid) {
      const verifiedEntry = sigVerdict.verified_actor_id
        ? findActorById(sigVerdict.verified_actor_id)
        : null
      const actorClass = resolveVerifiedActorClass(verifiedEntry, sigVerdict.identity_assurance)
      return buildVerdictRecord({
        observation,
        verdictVersion,
        recomputedAt,
        snapshotIds,
        declaredEntry,
        declaredBasis,
        policyToken: policyOnlyHit?.token ?? null,
        verifiedActorId: sigVerdict.verified_actor_id,
        verifiedOperator: sigVerdict.verified_operator,
        verifiedDomain: sigVerdict.verified_domain,
        actorClass,
        identityAssurance: sigVerdict.identity_assurance,
        verificationResult: sigVerdict.result,
        reportingLabel:
          sigVerdict.identity_assurance === 'crypto_domain'
            ? 'verified_crypto_domain'
            : 'verified_http_signature',
        replaySuspected,
        isProvisional,
        methodResults,
      })
    }

    // 3. Check IP trust & Origin-Forgery Probe (act.G5) before running ANY IP-dependent method!
    const trustCheck = this.deps.originTrustRegistry
      ? this.deps.originTrustRegistry.resolveEffectiveIpTrust({
          tenant_id: observation.tenant_id,
          site_id: observation.site_id,
          host: observation.host,
          observed_at: observation.observed_at,
          reported_ip_trust: observation.ip_trust,
        })
      : {
          effective_ip_trust: observation.ip_trust,
          ip_spoofable:
            observation.ip_trust === 'proxy_restored_unattested' ||
            observation.ip_trust === 'missing',
        }

    // Resolve usable IP (live ephemeral IP OR unseal Class E/P envelope during 30d recomputation)
    let resolvedIp: string | null = options?.ephemeral_raw_ip ?? null
    let keyDestroyedDuringRecompute = false
    if (!resolvedIp && observation.ip_evidence?.sealed_ip && this.deps.sealingVault) {
      try {
        resolvedIp = this.deps.sealingVault.unsealIpAddress({
          tenant_id: observation.tenant_id,
          site_id: observation.site_id,
          envelope: observation.ip_evidence.sealed_ip,
        })
      } catch (err) {
        if (err instanceof KeyDestroyedError) {
          keyDestroyedDuringRecompute = true
        } else {
          throw err
        }
      }
    }

    if (trustCheck.ip_spoofable) {
      // Forged X-Forwarded-For / unattested proxy -> NEVER run IP/SAIL/FCrDNS verification!
      methodResults.push(
        Object.freeze({
          method: 'ip_feed',
          attempted: false,
          result: 'unverifiable_ip_untrusted',
          source_id: null,
          snapshot_id: null,
          detail: `blocked_by_ip_trust:${trustCheck.effective_ip_trust}`,
        }),
      )

      if (observation.is_decoy_hit) {
        methodResults.push(
          Object.freeze({
            method: 'decoy_path',
            attempted: true,
            result: 'not_applicable',
            source_id: null,
            snapshot_id: null,
            detail: 'robots_disallow_decoy_hit',
          }),
        )
      }

      return buildVerdictRecord({
        observation,
        verdictVersion,
        recomputedAt,
        snapshotIds,
        declaredEntry,
        declaredBasis,
        policyToken: policyOnlyHit?.token ?? null,
        verifiedActorId: null,
        verifiedOperator: null,
        verifiedDomain: null,
        actorClass: observation.is_decoy_hit
          ? 'automation_explicit'
          : declaredEntry
            ? 'automation_declared'
            : inferFallbackBrowserClass(observation),
        identityAssurance: declaredEntry ? 'declared_only' : 'unverified',
        verificationResult: 'unverifiable_ip_untrusted',
        reportingLabel: declaredEntry
          ? 'claimed_by_ua_only_ip_untrusted'
          : policyOnlyHit
            ? 'policy_token_not_http_actor'
            : 'unverified_ip_untrusted',
        replaySuspected,
        isProvisional,
        methodResults,
      })
    }

    // 4. Network-based methods (SAIL, IP Feed, FCrDNS, ASN) — evaluate ALL applicable methods
    if (declaredEntry && resolvedIp) {
      let bestProof: {
        verifiedActorId: string | null
        verifiedOperator: string | null
        assurance: IdentityAssurance
        result: VerdictVerificationResult
        reportingLabel: string
        priority: number
      } | null = null

      let refutedResult: VerificationMethodOutcome | null = null
      let lastNonMatchResult: VerdictVerificationResult | null = null

      for (const spec of declaredEntry.verification_methods) {
        if (spec.method === 'http_sig') continue // already checked above

        if (spec.method === 'sail_exclusive' || spec.method === 'ip_feed') {
          const lookup = await this.deps.clock.lookupIpAtTime({
            ip: resolvedIp,
            at: observation.observed_at,
            source_id: spec.source_id,
            actor_token: declaredEntry.ua_tokens[0],
          })
          if (lookup.snapshot_id) snapshotIds.add(lookup.snapshot_id)

          const outcome: VerificationMethodOutcome = Object.freeze({
            method: spec.method,
            attempted: true,
            result: lookup.verification_result,
            source_id: lookup.source_id,
            snapshot_id: lookup.snapshot_id,
            detail: lookup.matched
              ? `matched_cidr:${lookup.matched_cidr}`
              : `no_match:misses=${lookup.consecutive_misses}`,
          })
          methodResults.push(outcome)

          if (lookup.matched) {
            const isOpOnly = lookup.verification_result === 'verified_operator'
            const priority = spec.method === 'sail_exclusive' ? 90 : isOpOnly ? 70 : 80
            if (!bestProof || priority > bestProof.priority) {
              bestProof = {
                verifiedActorId: isOpOnly ? null : declaredEntry.actor_id,
                verifiedOperator: declaredEntry.operator,
                assurance: isOpOnly ? 'verified_operator' : 'verified',
                result: lookup.verification_result,
                reportingLabel: isOpOnly ? 'verified_operator' : 'verified',
                priority,
              }
            }
          } else if (lookup.verification_result === 'refuted') {
            refutedResult = outcome
          } else {
            lastNonMatchResult = lookup.verification_result
          }
        } else if (spec.method === 'fcrdns' && spec.fcrdns_suffixes && this.deps.fcrdns) {
          const fc = await verifyFcrdns(resolvedIp, spec.fcrdns_suffixes, this.deps.fcrdns)
          const fcResult: VerdictVerificationResult = fc.matched
            ? spec.exclusive_scope === 'token'
              ? 'verified'
              : 'verified_operator'
            : 'feed_miss'

          methodResults.push(
            Object.freeze({
              method: 'fcrdns',
              attempted: true,
              result: fcResult,
              source_id: 'fcrdns',
              snapshot_id: null,
              detail: fc.detail,
            }),
          )

          if (fc.matched) {
            const isOpOnly = spec.exclusive_scope !== 'token'
            const priority = isOpOnly ? 65 : 75
            if (!bestProof || priority > bestProof.priority) {
              bestProof = {
                verifiedActorId: isOpOnly ? null : declaredEntry.actor_id,
                verifiedOperator: declaredEntry.operator,
                assurance: isOpOnly ? 'verified_operator' : 'verified',
                result: fcResult,
                reportingLabel: isOpOnly ? 'verified_operator_fcrdns' : 'verified_fcrdns',
                priority,
              }
            }
          } else if (!lastNonMatchResult) {
            lastNonMatchResult = 'feed_miss'
          }
        } else if (spec.method === 'asn' && spec.asns && observation.asn !== null) {
          const asnHit = spec.asns.includes(observation.asn)
          methodResults.push(
            Object.freeze({
              method: 'asn',
              attempted: true,
              result: asnHit ? 'asn_consistent' : 'feed_miss',
              source_id: `asn:${observation.asn}`,
              snapshot_id: null,
              detail: asnHit ? `asn_matched:${observation.asn}` : `asn_mismatch:${observation.asn}`,
            }),
          )
          if (asnHit && (!bestProof || bestProof.priority < 30)) {
            bestProof = {
              verifiedActorId: null,
              verifiedOperator: null,
              assurance: 'asn_consistent',
              result: 'asn_consistent',
              reportingLabel: 'asn_consistent_not_verified',
              priority: 30,
            }
          }
        }
      }

      if (bestProof) {
        const actorClass =
          bestProof.assurance === 'asn_consistent'
            ? 'automation_declared'
            : resolveVerifiedActorClass(declaredEntry, bestProof.assurance)
        return buildVerdictRecord({
          observation,
          verdictVersion,
          recomputedAt,
          snapshotIds,
          declaredEntry,
          declaredBasis,
          policyToken: policyOnlyHit?.token ?? null,
          verifiedActorId: bestProof.verifiedActorId,
          verifiedOperator: bestProof.verifiedOperator,
          verifiedDomain: null,
          actorClass,
          identityAssurance: bestProof.assurance,
          verificationResult: bestProof.result,
          reportingLabel: bestProof.reportingLabel,
          replaySuspected,
          isProvisional,
          methodResults,
        })
      }

      if (refutedResult) {
        return buildVerdictRecord({
          observation,
          verdictVersion,
          recomputedAt,
          snapshotIds,
          declaredEntry,
          declaredBasis,
          policyToken: policyOnlyHit?.token ?? null,
          verifiedActorId: null,
          verifiedOperator: null,
          verifiedDomain: null,
          actorClass: observation.is_decoy_hit ? 'automation_explicit' : 'automation_declared',
          identityAssurance: 'refuted',
          verificationResult: 'refuted',
          reportingLabel: 'refuted_exhaustive_list',
          replaySuspected,
          isProvisional,
          methodResults,
        })
      }

      // Declared actor had methods but did not match (feed_miss / late_published / stale / no_method)
      return buildVerdictRecord({
        observation,
        verdictVersion,
        recomputedAt,
        snapshotIds,
        declaredEntry,
        declaredBasis,
        policyToken: policyOnlyHit?.token ?? null,
        verifiedActorId: null,
        verifiedOperator: null,
        verifiedDomain: null,
        actorClass: observation.is_decoy_hit ? 'automation_explicit' : 'automation_declared',
        identityAssurance: 'declared_only',
        verificationResult: lastNonMatchResult ?? 'unverifiable_no_method',
        reportingLabel: 'claimed_by_ua_only',
        replaySuspected,
        isProvisional,
        methodResults,
      })
    }

    // 5. No declared actor, OR resolvedIp unavailable (e.g., 30d key destroyed)
    // Check if an undeclared request actually came from an official IP feed / SAIL (silent crawler/agent!)
    if (!declaredEntry && resolvedIp) {
      const anyIpLookup = await this.deps.clock.lookupIpAtTime({
        ip: resolvedIp,
        at: observation.observed_at,
      })
      if (anyIpLookup.matched && anyIpLookup.source_id) {
        if (anyIpLookup.snapshot_id) snapshotIds.add(anyIpLookup.snapshot_id)
        methodResults.push(
          Object.freeze({
            method: anyIpLookup.is_exhaustive ? 'sail_exclusive' : 'ip_feed',
            attempted: true,
            result: anyIpLookup.verification_result,
            source_id: anyIpLookup.source_id,
            snapshot_id: anyIpLookup.snapshot_id,
            detail: `undeclared_ip_match:${anyIpLookup.matched_cidr}`,
          }),
        )
        const matchedEntry =
          anyIpLookup.actor_tokens.length === 1
            ? matchDeclaredActorByUa(anyIpLookup.actor_tokens[0])
            : null
        const isOpOnly = matchedEntry === null || anyIpLookup.verification_result === 'verified_operator'
        return buildVerdictRecord({
          observation,
          verdictVersion,
          recomputedAt,
          snapshotIds,
          declaredEntry: null,
          declaredBasis: 'none',
          policyToken: policyOnlyHit?.token ?? null,
          verifiedActorId: isOpOnly ? null : matchedEntry.actor_id,
          verifiedOperator: anyIpLookup.provider,
          verifiedDomain: null,
          actorClass: resolveVerifiedActorClass(matchedEntry, isOpOnly ? 'verified_operator' : 'verified'),
          identityAssurance: isOpOnly ? 'verified_operator' : 'verified',
          verificationResult: isOpOnly ? 'verified_operator' : anyIpLookup.verification_result,
          reportingLabel: isOpOnly ? 'verified_operator_silent' : 'verified_silent',
          replaySuspected,
          isProvisional,
          methodResults,
        })
      }
    }

    // 6. Decoy path (robots.txt Disallow-only) -> automation_explicit
    if (observation.is_decoy_hit) {
      methodResults.push(
        Object.freeze({
          method: 'decoy_path',
          attempted: true,
          result: 'not_applicable',
          source_id: null,
          snapshot_id: null,
          detail: 'robots_disallow_decoy_hit',
        }),
      )
      return buildVerdictRecord({
        observation,
        verdictVersion,
        recomputedAt,
        snapshotIds,
        declaredEntry,
        declaredBasis,
        policyToken: policyOnlyHit?.token ?? null,
        verifiedActorId: null,
        verifiedOperator: null,
        verifiedDomain: null,
        actorClass: 'automation_explicit',
        identityAssurance: declaredEntry ? 'declared_only' : 'unverified',
        verificationResult: keyDestroyedDuringRecompute
          ? 'unverifiable_stale_evidence'
          : 'not_applicable',
        reportingLabel: 'decoy_automation_explicit',
        replaySuspected,
        isProvisional,
        methodResults,
      })
    }

    // 7. Policy-only token spoofed in UA (e.g. `Google-Extended` / `Applebot-Extended`)
    if (policyOnlyHit && !declaredEntry) {
      return buildVerdictRecord({
        observation,
        verdictVersion,
        recomputedAt,
        snapshotIds,
        declaredEntry: null,
        declaredBasis: 'none',
        policyToken: policyOnlyHit.token,
        verifiedActorId: null,
        verifiedOperator: null,
        verifiedDomain: null,
        actorClass: 'unclassified',
        identityAssurance: 'unverified',
        verificationResult: 'unverifiable_no_method',
        reportingLabel: 'policy_token_not_http_actor',
        replaySuspected,
        isProvisional,
        methodResults,
      })
    }

    // 8. Declared actor without resolvable IP (e.g. UA-only / key expired)
    if (declaredEntry) {
      const ownInstrument = declaredEntry.is_own_instrument === true
      return buildVerdictRecord({
        observation,
        verdictVersion,
        recomputedAt,
        snapshotIds,
        declaredEntry,
        declaredBasis,
        policyToken: policyOnlyHit?.token ?? null,
        verifiedActorId: null,
        verifiedOperator: null,
        verifiedDomain: null,
        actorClass: ownInstrument ? 'own_instrument' : 'automation_declared',
        identityAssurance: 'declared_only',
        verificationResult: keyDestroyedDuringRecompute
          ? 'unverifiable_stale_evidence'
          : sigVerdict
            ? sigVerdict.result
            : 'unverifiable_no_method',
        reportingLabel: 'claimed_by_ua_only',
        replaySuspected,
        isProvisional,
        methodResults,
      })
    }

    // 9. Browser with JS / without JS / unclassified
    const fallbackClass = inferFallbackBrowserClass(observation)
    return buildVerdictRecord({
      observation,
      verdictVersion,
      recomputedAt,
      snapshotIds,
      declaredEntry: null,
      declaredBasis: 'none',
      policyToken: null,
      verifiedActorId: null,
      verifiedOperator: null,
      verifiedDomain: null,
      actorClass: fallbackClass,
      identityAssurance: 'unverified',
      verificationResult: sigVerdict ? sigVerdict.result : 'not_applicable',
      reportingLabel: fallbackClass,
      replaySuspected,
      isProvisional,
      methodResults,
    })
  }

  /**
   * 追記専用の観測レコード列を改変せず、新しい `verdict_version` の判定レコード列を一括再計算する。
   */
  async recomputeBatch(
    observations: readonly ActorObservationRecord[],
    options: {
      readonly verdict_version: string
      readonly recomputed_at: string
      readonly is_provisional_30d?: boolean
    },
  ): Promise<readonly ActorVerdictRecord[]> {
    const verdicts: ActorVerdictRecord[] = []
    for (const obs of observations) {
      verdicts.push(
        await this.evaluateObservation(obs, {
          verdict_version: options.verdict_version,
          recomputed_at: options.recomputed_at,
          is_provisional_30d: options.is_provisional_30d,
        }),
      )
    }
    return Object.freeze(verdicts)
  }
}

function resolveVerifiedActorClass(
  entry: ActorRegistryEntry | null,
  assurance: IdentityAssurance,
): ActorClass {
  if (entry?.is_own_instrument) return 'own_instrument'
  if (assurance === 'crypto_domain') return 'ai_agent_verified'
  if (!entry) return 'ai_agent_verified'
  if (entry.purpose === 'web_search') return 'search_crawler_verified'
  return 'ai_agent_verified'
}

function inferFallbackBrowserClass(observation: ActorObservationRecord): ActorClass {
  if (observation.has_js_pv_join) return 'browser_with_js'
  const isBrowserFamily =
    /^(Chrome|Safari|Firefox|Edge|LINE_InApp|YahooJP_InApp|GoogleApp_InApp|Instagram_InApp|FB_InApp)\/\d+/i.test(
      observation.ua_family_version,
    ) ||
    (observation.raw_ua !== null && reduceStandardBrowserUa(observation.raw_ua).is_standard_browser)

  if (observation.is_document && isBrowserFamily) {
    return 'browser_without_js'
  }
  return 'unclassified'
}

function buildVerdictRecord(params: {
  readonly observation: ActorObservationRecord
  readonly verdictVersion: string
  readonly recomputedAt: string
  readonly snapshotIds: Set<string>
  readonly declaredEntry: ActorRegistryEntry | null
  readonly declaredBasis: ActorVerdictRecord['declared_basis']
  readonly policyToken: string | null
  readonly verifiedActorId: string | null
  readonly verifiedOperator: string | null
  readonly verifiedDomain: string | null
  readonly actorClass: ActorClass
  readonly identityAssurance: IdentityAssurance
  readonly verificationResult: VerdictVerificationResult
  readonly reportingLabel: string
  readonly replaySuspected: boolean
  readonly isProvisional: boolean
  readonly methodResults: readonly VerificationMethodOutcome[]
}): ActorVerdictRecord {
  const verdictId = `vrd_${params.observation.observation_id}_${params.verdictVersion}`
  return Object.freeze({
    verdict_id: verdictId,
    observation_id: params.observation.observation_id,
    tenant_id: params.observation.tenant_id,
    site_id: params.observation.site_id,
    verdict_version: params.verdictVersion,
    registry_version: ACTOR_REGISTRY_VERSION,
    recomputed_at: params.recomputedAt,
    evidence_snapshot_ids: Object.freeze([...params.snapshotIds].sort()),
    declared_actor_id: params.declaredEntry?.actor_id ?? null,
    declared_operator: params.declaredEntry?.operator ?? null,
    declared_basis: params.declaredBasis,
    policy_token_detected: params.policyToken,
    verified_actor_id: params.verifiedActorId,
    verified_operator: params.verifiedOperator,
    verified_domain: params.verifiedDomain,
    actor_class: params.actorClass,
    identity_assurance: params.identityAssurance,
    verification_result: params.verificationResult,
    reporting_label: params.reportingLabel,
    replay_suspected: params.replaySuspected,
    is_provisional_30d: params.isProvisional,
    method_results: Object.freeze([...params.methodResults]),
  })
}
