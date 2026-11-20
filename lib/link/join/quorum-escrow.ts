/**
 * UGOKI LINK v2 — 束 4-D (手順 13): ネットワーク種類別定足数補正 & k-匿名文の預かり (Text Escrow)
 *
 * 設計書 §6.7 / join-final.md M7, G18 / 意思決定 D-08 (D-11R):
 * 1. **ネットワーク種類別定足数補正**:
 *    日本の携帯通信事業者の CGNAT 帯集中を踏まえ、ネットワークを
 *    `mobile_carrier` / `fixed_isp` / `hosting` / `proxy` に分類し、種類別の上限・重みで補正する。
 *    上限超過 PV は**捨てずに減重**し、減重された割合 (`downweighted_pv_share`) を答えに付記する。
 *    アドレスに依らない確認（サーバー署名セッション・CMS 公開フック・サイトマップ・介入台帳）も受理。
 * 2. **文の預かり (k-Anonymous Text Escrow)**:
 *    - `D-08` の法務署名が完了するまで必ず `not_entitled` (fail-closed)。
 *    - テナント既定 OFF (opt-in 必須)、同意目的 `page_content` 必須、匿名公開範囲の URL のみ。
 *    - 個人情報パターンを含む文は受付で拒否。
 *    - 同一 128 ビット要約 (`hash128(normText(text))`) が 30 日以内に 10 PV 以上・3 ネットワーク以上で
 *      報告された時のみ受理し、サーバー側再ハッシュ一致を検証。
 *    - 保存レコードに `pv_id` / `session_id` / `visitor_id` を一切持たない。
 *    - 出どころ `real_visit`・根拠 `inferred`・分析専用（引用・アシスタント回答・自動生成での使用を型＋実行時禁止）。
 */

import {
  NotEntitledError,
  requireDecisionEntitled,
  type DecisionEntitlementResult,
} from '@/packages/contract/ledgers'
import { hash128, normText } from '@/packages/contract/segmenter'

// ---------------------------------------------------------------------------
// 1. Network-Class Weighted Quorum (§6.7)
// ---------------------------------------------------------------------------

export type NetworkClass = 'mobile_carrier' | 'fixed_isp' | 'hosting' | 'proxy'

export interface NetworkClassQuorumPolicy {
  /** Max unweighted PVs per single network key before downweighting kicks in */
  readonly max_full_weight_pvs_per_network: number
  /** Per-PV base weight */
  readonly base_weight: number
  /** How many effective distinct networks a single mobile CGNAT prefix can contribute when backed by server-attested sessions */
  readonly max_effective_network_credit: number
}

export const DEFAULT_NETWORK_CLASS_POLICIES: Readonly<
  Record<NetworkClass, NetworkClassQuorumPolicy>
> = Object.freeze({
  mobile_carrier: Object.freeze({
    max_full_weight_pvs_per_network: 6,
    base_weight: 1.0,
    max_effective_network_credit: 2.0,
  }),
  fixed_isp: Object.freeze({
    max_full_weight_pvs_per_network: 3,
    base_weight: 1.0,
    max_effective_network_credit: 1.0,
  }),
  hosting: Object.freeze({
    max_full_weight_pvs_per_network: 1,
    base_weight: 0.5,
    max_effective_network_credit: 0.5,
  }),
  proxy: Object.freeze({
    max_full_weight_pvs_per_network: 1,
    base_weight: 0.25,
    max_effective_network_credit: 0.25,
  }),
})

export interface QuorumPvSignal {
  readonly network_pseudonym: string
  readonly network_class: NetworkClass
  /** Collector-issued render token present? (§6.7) */
  readonly has_collector_token: boolean
  /** Optional origin-signed session ID (allows mobile CGNAT disambiguation without relying on IP alone) */
  readonly origin_signed_session_key?: string | null
}

export type NonTrafficConfirmationKind =
  | 'cms_publish_hook'
  | 'sitemap'
  | 'intervention_ledger'

export interface NetworkWeightedQuorumResult {
  readonly quorum_met: boolean
  readonly confirmed_via: 'non_traffic' | 'traffic_quorum' | 'budget_exhausted' | 'unmet'
  readonly raw_pv_count: number
  readonly effective_pv_weight: number
  readonly distinct_raw_networks: number
  readonly effective_network_credit: number
  readonly downweighted_pv_count: number
  /** §6.7: Share of PVs that were downweighted (never dropped) due to per-network cap */
  readonly downweighted_pv_share: number
  readonly remaining_daily_budget: number
}

export function evaluateNetworkWeightedQuorum(params: {
  readonly signals: readonly QuorumPvSignal[]
  readonly min_effective_pvs?: number
  readonly min_effective_networks?: number
  readonly non_traffic_confirmation?: NonTrafficConfirmationKind | null
  readonly remaining_daily_budget: number
  readonly policies?: Readonly<Record<NetworkClass, NetworkClassQuorumPolicy>>
}): NetworkWeightedQuorumResult {
  const policies = params.policies ?? DEFAULT_NETWORK_CLASS_POLICIES
  const minPvs = params.min_effective_pvs ?? 3
  const minNets = params.min_effective_networks ?? 2

  const eligible = params.signals.filter((s) => s.has_collector_token)
  const byNet = new Map<string, QuorumPvSignal[]>()
  for (const s of eligible) {
    const arr = byNet.get(s.network_pseudonym) ?? []
    arr.push(s)
    byNet.set(s.network_pseudonym, arr)
  }

  let effectivePvWeight = 0
  let effectiveNetworkCredit = 0
  let downweightedPvCount = 0

  for (const group of byNet.values()) {
    const netClass = group[0].network_class
    const policy = policies[netClass]
    const n = group.length

    if (n <= policy.max_full_weight_pvs_per_network) {
      effectivePvWeight += n * policy.base_weight
    } else {
      // NEVER drop PVs above cap — smoothly downweight them (§6.7)
      downweightedPvCount += n - policy.max_full_weight_pvs_per_network
      const fullPart = policy.max_full_weight_pvs_per_network * policy.base_weight
      const excessPart =
        Math.log1p(n - policy.max_full_weight_pvs_per_network) * 0.25 * policy.base_weight
      effectivePvWeight += fullPart + excessPart
    }

    // Distinct origin-signed sessions allow mobile carrier CGNAT prefixes to earn up to max_effective_network_credit
    const signedSessions = new Set(
      group.map((g) => g.origin_signed_session_key).filter((k): k is string => Boolean(k)),
    )
    if (netClass === 'mobile_carrier' && signedSessions.size >= 2) {
      effectiveNetworkCredit += Math.min(policy.max_effective_network_credit, signedSessions.size)
    } else {
      effectiveNetworkCredit += Math.min(1, policy.max_effective_network_credit)
    }
  }

  const rawCount = eligible.length
  const downweightedShare = rawCount > 0 ? downweightedPvCount / rawCount : 0

  if (params.remaining_daily_budget <= 0) {
    return Object.freeze({
      quorum_met: false,
      confirmed_via: 'budget_exhausted',
      raw_pv_count: rawCount,
      effective_pv_weight: effectivePvWeight,
      distinct_raw_networks: byNet.size,
      effective_network_credit: effectiveNetworkCredit,
      downweighted_pv_count: downweightedPvCount,
      downweighted_pv_share: downweightedShare,
      remaining_daily_budget: 0,
    })
  }

  if (params.non_traffic_confirmation) {
    return Object.freeze({
      quorum_met: true,
      confirmed_via: 'non_traffic',
      raw_pv_count: rawCount,
      effective_pv_weight: effectivePvWeight,
      distinct_raw_networks: byNet.size,
      effective_network_credit: effectiveNetworkCredit,
      downweighted_pv_count: downweightedPvCount,
      downweighted_pv_share: downweightedShare,
      remaining_daily_budget: params.remaining_daily_budget,
    })
  }

  const met = effectivePvWeight >= minPvs && effectiveNetworkCredit >= minNets
  return Object.freeze({
    quorum_met: met,
    confirmed_via: met ? 'traffic_quorum' : 'unmet',
    raw_pv_count: rawCount,
    effective_pv_weight: effectivePvWeight,
    distinct_raw_networks: byNet.size,
    effective_network_credit: effectiveNetworkCredit,
    downweighted_pv_count: downweightedPvCount,
    downweighted_pv_share: downweightedShare,
    remaining_daily_budget: params.remaining_daily_budget,
  })
}

// ---------------------------------------------------------------------------
// 2. k-Anonymous Text Escrow (§6.7, Gate join.G18, Decision D-08)
// ---------------------------------------------------------------------------

export const TEXT_ESCROW_MIN_PVS = 10
export const TEXT_ESCROW_MIN_NETWORKS = 3
export const TEXT_ESCROW_WINDOW_DAYS = 30

export type EscrowAllowedUse = 'inferred_analysis'
export type EscrowProhibitedUse = 'ai_citation' | 'assistant_answer' | 'auto_generation'
export type EscrowConsumerUse = EscrowAllowedUse | EscrowProhibitedUse

export interface EscrowPiiFinding {
  readonly kind: 'email' | 'phone_jp_or_intl' | 'credit_card' | 'my_number_like' | 'bearer_token'
  readonly masked_sample: string
}

const PII_PATTERNS: ReadonlyArray<{ readonly kind: EscrowPiiFinding['kind']; readonly re: RegExp }> = [
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  {
    kind: 'phone_jp_or_intl',
    re: /(?:\+81[-\s]?\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}|\b0[789]0[-\s]?\d{4}[-\s]?\d{4}\b|\b0\d{1,3}-\d{2,4}-\d{4}\b)/,
  },
  { kind: 'credit_card', re: /\b(?:\d[ -]*?){13,19}\b/ },
  { kind: 'my_number_like', re: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/ },
  { kind: 'bearer_token', re: /\b(?:Bearer\s+[A-Za-z0-9._-]{16,}|sk-[A-Za-z0-9]{20,})\b/ },
]

export function detectPiiInEscrowText(text: string): readonly EscrowPiiFinding[] {
  const findings: EscrowPiiFinding[] = []
  for (const p of PII_PATTERNS) {
    if (p.re.test(text)) {
      findings.push(Object.freeze({ kind: p.kind, masked_sample: `<redacted:${p.kind}>` }))
    }
  }
  return Object.freeze(findings)
}

export interface TextEscrowRecord {
  readonly escrow_id: string
  readonly tenant_id: string
  readonly site_id: string
  readonly page_id: string
  readonly sec_fp: string
  readonly body_digest_128: string
  readonly normalized_text: string
  readonly quorum_pv_count: number
  readonly quorum_network_count: number
  readonly stored_at: string
  readonly provenance: 'real_visit'
  readonly evidence_level: 'inferred'
  readonly allowed_uses: readonly ['inferred_analysis']
  readonly prohibited_uses: readonly ['ai_citation', 'assistant_answer', 'auto_generation']
  // NOTE: Intentionally ZERO pv_id, session_id, or visitor_id fields (§6.7)!
}

export interface TextEscrowSightingInput {
  readonly tenant_id: string
  readonly site_id: string
  readonly page_id: string
  readonly sec_fp: string
  readonly body_digest_128: string
  readonly network_pseudonym: string
  readonly observed_at: string
}

export interface SubmitEscrowTextInput {
  readonly tenant_id: string
  readonly site_id: string
  readonly page_id: string
  readonly sec_fp: string
  readonly claimed_body_digest_128: string
  readonly raw_section_text: string
  readonly submitted_at: string
  readonly is_anonymous_public_scope: boolean
  readonly tenant_escrow_opt_in: boolean
  readonly consent_page_content_granted: boolean
  readonly decisionCheckOverride?: () => DecisionEntitlementResult
}

export interface SubmitEscrowTextResult {
  readonly accepted: boolean
  readonly record: TextEscrowRecord | null
  readonly rejection_reason?:
    | 'tenant_opt_in_disabled'
    | 'consent_page_content_missing'
    | 'outside_anonymous_public_scope'
    | 'pii_detected'
    | 'quorum_not_reached'
    | 'digest_mismatch'
  readonly pii_findings?: readonly EscrowPiiFinding[]
}

export class TextEscrowVault {
  private readonly sightings = new Map<
    string,
    Array<{ readonly network: string; readonly observed_at_ms: number }>
  >()
  private readonly records = new Map<string, TextEscrowRecord>()

  private makeKey(tenantId: string, siteId: string, pageId: string, secFp: string, digest128: string): string {
    return `${tenantId}|${siteId}|${pageId}|${secFp}|${digest128}`
  }

  recordDigestSighting(input: TextEscrowSightingInput): {
    readonly pv_count_30d: number
    readonly distinct_networks_30d: number
    readonly quorum_reached: boolean
  } {
    const key = this.makeKey(
      input.tenant_id,
      input.site_id,
      input.page_id,
      input.sec_fp,
      input.body_digest_128,
    )
    const nowMs = Date.parse(input.observed_at)
    const cutoffMs = nowMs - TEXT_ESCROW_WINDOW_DAYS * 24 * 60 * 60 * 1000

    const prev = this.sightings.get(key) ?? []
    const active = prev.filter((s) => s.observed_at_ms >= cutoffMs)
    active.push({ network: input.network_pseudonym, observed_at_ms: nowMs })
    this.sightings.set(key, active)

    const nets = new Set(active.map((s) => s.network))
    return Object.freeze({
      pv_count_30d: active.length,
      distinct_networks_30d: nets.size,
      quorum_reached:
        active.length >= TEXT_ESCROW_MIN_PVS && nets.size >= TEXT_ESCROW_MIN_NETWORKS,
    })
  }

  submitEscrowText(input: SubmitEscrowTextInput): SubmitEscrowTextResult {
    // 1. Decision D-08 (D-11R) + legal sign-off MUST pass (fail-closed `not_entitled`, §6.7)
    const d08 = input.decisionCheckOverride
      ? input.decisionCheckOverride()
      : requireDecisionEntitled('D-08', { enforceLegalSignOff: true })
    if (!d08.entitled) {
      throw new NotEntitledError(d08)
    }

    // 2. Tenant opt-in (off by default) & consent purpose `page_content`
    if (!input.tenant_escrow_opt_in) {
      return Object.freeze({
        accepted: false,
        record: null,
        rejection_reason: 'tenant_opt_in_disabled',
      })
    }
    if (!input.consent_page_content_granted) {
      return Object.freeze({
        accepted: false,
        record: null,
        rejection_reason: 'consent_page_content_missing',
      })
    }

    // 3. Anonymous public indexable scope ONLY
    if (!input.is_anonymous_public_scope) {
      return Object.freeze({
        accepted: false,
        record: null,
        rejection_reason: 'outside_anonymous_public_scope',
      })
    }

    // 4. Reject PII-shaped strings at ingest
    const pii = detectPiiInEscrowText(input.raw_section_text)
    if (pii.length > 0) {
      return Object.freeze({
        accepted: false,
        record: null,
        rejection_reason: 'pii_detected',
        pii_findings: pii,
      })
    }

    // 5. Server-side re-hash equality check on normalized text (128-bit digest)
    const normalized = normText(input.raw_section_text)
    const recomputedDigest128 = hash128(normalized)
    if (recomputedDigest128 !== input.claimed_body_digest_128) {
      return Object.freeze({
        accepted: false,
        record: null,
        rejection_reason: 'digest_mismatch',
      })
    }

    // 6. Quorum check: >= 10 PVs AND >= 3 distinct networks within 30 days
    const key = this.makeKey(
      input.tenant_id,
      input.site_id,
      input.page_id,
      input.sec_fp,
      recomputedDigest128,
    )
    const nowMs = Date.parse(input.submitted_at)
    const cutoffMs = nowMs - TEXT_ESCROW_WINDOW_DAYS * 24 * 60 * 60 * 1000
    const active = (this.sightings.get(key) ?? []).filter((s) => s.observed_at_ms >= cutoffMs)
    const distinctNets = new Set(active.map((s) => s.network))

    if (active.length < TEXT_ESCROW_MIN_PVS || distinctNets.size < TEXT_ESCROW_MIN_NETWORKS) {
      return Object.freeze({
        accepted: false,
        record: null,
        rejection_reason: 'quorum_not_reached',
      })
    }

    const record: TextEscrowRecord = Object.freeze({
      escrow_id: `esc_${recomputedDigest128.slice(0, 16)}`,
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      page_id: input.page_id,
      sec_fp: input.sec_fp,
      body_digest_128: recomputedDigest128,
      normalized_text: normalized,
      quorum_pv_count: active.length,
      quorum_network_count: distinctNets.size,
      stored_at: input.submitted_at,
      provenance: 'real_visit',
      evidence_level: 'inferred',
      allowed_uses: Object.freeze(['inferred_analysis'] as const),
      prohibited_uses: Object.freeze([
        'ai_citation',
        'assistant_answer',
        'auto_generation',
      ] as const),
    })

    this.records.set(key, record)
    return Object.freeze({ accepted: true, record })
  }

  getRecord(
    tenantId: string,
    siteId: string,
    pageId: string,
    secFp: string,
    digest128: string,
  ): TextEscrowRecord | null {
    return this.records.get(this.makeKey(tenantId, siteId, pageId, secFp, digest128)) ?? null
  }
}

/**
 * 預かり文の利用先ガード (§6.7): 引用・アシスタント回答・自動生成への投入を禁止する。
 */
export function assertEscrowUseAllowed(record: TextEscrowRecord, intendedUse: EscrowConsumerUse): void {
  if (intendedUse !== 'inferred_analysis') {
    throw new Error(
      `Escrowed text "${record.escrow_id}" (provenance=real_visit, evidence=inferred) is prohibited for "${intendedUse}" (§6.7)`,
    )
  }
}
