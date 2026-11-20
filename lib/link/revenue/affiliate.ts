/**
 * UGOKI LINK v2 — 束 4-D (手順 14): アフィリエイト登録簿・5段階売上粒度・オフライン署名許可表・無作為展開ガード
 *
 * 設計書 §6.5 / 意思決定 D-11 (A-15R):
 * 1. **アフィリエイト登録簿**: ホスト＋パラメータ役割から `network:program:product` キーを生成。
 *    CRAWL 出口遮断用 `isRegisteredAffiliateHost()` で登録済みホストへのアクセス 0 を強制。
 * 2. **5 段階売上粒度**:
 *    - Tier 1 (`deterministic_subparam`): A8/afb 等の `id1`–`id5` 確定的帰属 (`observed`)
 *    - Tier 2 (`preset_id_allocation`): 楽天/Amazon 等の事前登録 ID 割当（パスキー承認＋オフライン署名表の自社 ID のみ）
 *    - Tier 3 (`order_line_item`): 注文明細 `(affiliate_id, product_id, date)` 結合
 *    - Tier 4 (`time_window_match`): 時間窓 1 件/按分 — **候補が 1 件単独でも必ず `inferred`**、
 *      売上そのものの観測 (`revenue_observation_evidence`) と帰属根拠 (`attribution_evidence`) を別欄管理 (§6.5 #4)
 *    - Tier 5 (`program_day_proration`): プログラム × 日按分 (`inferred`, `allocated: true`,
 *      `not_slot_metric: true`, `not_training_label: true` — 枠評価・学習正解から完全除外)
 * 3. **オフライン署名許可パラメータ表**:
 *    Ed25519 オフライン署名付き許可表を検証。ランタイムは表に無いパラメータ名と既存パラメータ上書きを拒否。
 *    サイト × NW 有効化はパスキー人承認必須（自律枠除外）。
 * 4. **無作為展開ガード**:
 *    常時 5% ノンパラメータ保持＋初期 10% 以下展開＋日次 `NW報告クリック / 自社クリック` 逸脱で当該 NW のみ自動停止。
 */

import { createHash, webcrypto } from 'node:crypto'

import {
  NotEntitledError,
  requireDecisionEntitled,
  type DecisionEntitlementResult,
} from '@/packages/contract/ledgers'
import type { EvidenceLevel } from '@/packages/contract/response'

const subtle = webcrypto.subtle

// ---------------------------------------------------------------------------
// 1. Affiliate Registry (`network:program:product`) & CRAWL Host Blocker
// ---------------------------------------------------------------------------

export interface AffiliateNetworkSpec {
  readonly network_id: string
  readonly hosts: readonly string[]
  readonly program_param_names: readonly string[]
  readonly product_param_names: readonly string[]
  /** Publisher sub-parameters documented by network (e.g., id1..id5) */
  readonly documented_issuer_params: readonly string[]
  readonly supports_tier: 1 | 2 | 3 | 4 | 5
}

export const DEFAULT_AFFILIATE_REGISTRY: readonly AffiliateNetworkSpec[] = Object.freeze([
  Object.freeze({
    network_id: 'a8',
    hosts: Object.freeze(['px.a8.net', 'hb.afl.a8.net', 'www.a8.net']),
    program_param_names: Object.freeze(['a8mat']),
    product_param_names: Object.freeze(['a8ejpredirect', 'sku']),
    documented_issuer_params: Object.freeze(['id1', 'id2', 'id3', 'id4', 'id5']),
    supports_tier: 1,
  }),
  Object.freeze({
    network_id: 'afb',
    hosts: Object.freeze(['t.afi-b.com', 'track.affiliate-b.com']),
    program_param_names: Object.freeze(['p']),
    product_param_names: Object.freeze(['item', 'pid']),
    documented_issuer_params: Object.freeze(['id1', 'id2', 'id3', 'id4', 'id5']),
    supports_tier: 1,
  }),
  Object.freeze({
    network_id: 'rakuten',
    hosts: Object.freeze(['hb.afl.rakuten.co.jp', 'afl.rakuten.co.jp']),
    program_param_names: Object.freeze(['hgc', 'pc']),
    product_param_names: Object.freeze(['pc', 'm']),
    documented_issuer_params: Object.freeze([]),
    supports_tier: 2,
  }),
  Object.freeze({
    network_id: 'amazon_jp',
    hosts: Object.freeze(['www.amazon.co.jp', 'amzn.to', 'amzn.asia']),
    program_param_names: Object.freeze(['tag']),
    product_param_names: Object.freeze(['asin', 'dp']),
    documented_issuer_params: Object.freeze([]),
    supports_tier: 2,
  }),
  Object.freeze({
    network_id: 'valuecommerce',
    hosts: Object.freeze(['ck.jp.ap.valuecommerce.com']),
    program_param_names: Object.freeze(['sid', 'pid']),
    product_param_names: Object.freeze(['vc_url']),
    documented_issuer_params: Object.freeze(['vsid']),
    supports_tier: 1,
  }),
])

export interface ParsedAffiliateKey {
  readonly matched: boolean
  readonly network_id: string | null
  readonly program_id: string | null
  readonly product_id: string | null
  /** Canonical key `network:program:product` */
  readonly affiliate_key: string | null
  readonly host: string | null
}

export function isRegisteredAffiliateHost(
  host: string,
  registry: readonly AffiliateNetworkSpec[] = DEFAULT_AFFILIATE_REGISTRY,
): boolean {
  const low = host.trim().toLowerCase()
  return registry.some((net) => net.hosts.some((h) => low === h || low.endsWith(`.${h}`)))
}

export function extractAffiliateKeyFromUrl(
  rawUrl: string,
  registry: readonly AffiliateNetworkSpec[] = DEFAULT_AFFILIATE_REGISTRY,
): ParsedAffiliateKey {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return Object.freeze({
      matched: false,
      network_id: null,
      program_id: null,
      product_id: null,
      affiliate_key: null,
      host: null,
    })
  }

  const host = u.hostname.toLowerCase()
  const spec = registry.find((n) => n.hosts.some((h) => host === h || host.endsWith(`.${h}`)))
  if (!spec) {
    return Object.freeze({
      matched: false,
      network_id: null,
      program_id: null,
      product_id: null,
      affiliate_key: null,
      host,
    })
  }

  const rawQueryPairs = new Map<string, string>()
  const rawSearch = u.search.startsWith('?') ? u.search.slice(1) : u.search
  for (const part of rawSearch.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const k = eq === -1 ? part : part.slice(0, eq)
    const v = eq === -1 ? '' : part.slice(eq + 1)
    try {
      const decK = decodeURIComponent(k)
      const decV = decodeURIComponent(v)
      if (!rawQueryPairs.has(decK) && decV.trim()) {
        rawQueryPairs.set(decK, decV.trim())
      }
    } catch {
      if (!rawQueryPairs.has(k) && v.trim()) {
        rawQueryPairs.set(k, v.trim())
      }
    }
  }

  const pickParam = (names: readonly string[]): string | null => {
    for (const name of names) {
      const val = rawQueryPairs.get(name) ?? u.searchParams.get(name)
      if (val && val.trim()) return val.trim()
    }
    return null
  }

  let programId = pickParam(spec.program_param_names) ?? 'default_prog'
  let productId = pickParam(spec.product_param_names)

  // Amazon /dp/ASIN extraction fallback
  if (!productId && spec.network_id === 'amazon_jp') {
    const dpMatch = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i.exec(u.pathname)
    if (dpMatch) productId = dpMatch[1].toUpperCase()
  }
  if (!productId) {
    productId = createHash('sha256').update(u.pathname).digest('hex').slice(0, 12)
  }

  programId = programId.replace(/:/g, '_')
  productId = productId.replace(/:/g, '_')

  return Object.freeze({
    matched: true,
    network_id: spec.network_id,
    program_id: programId,
    product_id: productId,
    affiliate_key: `${spec.network_id}:${programId}:${productId}`,
    host,
  })
}

// ---------------------------------------------------------------------------
// 2. Five-Tier Revenue Attribution (§6.5)
// ---------------------------------------------------------------------------

export type RevenueAttributionTier = 1 | 2 | 3 | 4 | 5

export type RevenueAttributionMethod =
  | 'tier1_deterministic_subparam'
  | 'tier2_preset_id_allocation'
  | 'tier3_order_line_item'
  | 'tier4_time_window_single_click'
  | 'tier4_time_window_prorated'
  | 'tier5_program_day_proration'

export interface AttributedRevenueRecord {
  readonly attribution_id: string
  readonly tenant_id: string
  readonly site_id: string
  readonly network_id: string
  readonly affiliate_key: string
  readonly tier: RevenueAttributionTier
  readonly method: RevenueAttributionMethod
  readonly slot_id: string | null
  readonly click_id: string | null
  readonly amount_jpy: number
  /** §6.5 #4: Separate field for observing the revenue itself vs attributing it to a slot/visit */
  readonly revenue_observation_evidence: Extract<EvidenceLevel, 'observed' | 'inferred'>
  readonly attribution_evidence: Extract<EvidenceLevel, 'observed' | 'inferred'>
  readonly allocated: boolean
  readonly not_slot_metric: boolean
  readonly not_training_label: boolean
  readonly covered_click_share?: number | null
  readonly candidate_click_count: number
}

export function buildAttributedRevenueRecord(params: {
  readonly attribution_id: string
  readonly tenant_id: string
  readonly site_id: string
  readonly network_id: string
  readonly affiliate_key: string
  readonly tier: RevenueAttributionTier
  readonly slot_id: string | null
  readonly click_id: string | null
  readonly amount_jpy: number
  readonly candidate_click_count: number
  readonly covered_click_share?: number | null
  readonly revenue_settled: boolean
}): AttributedRevenueRecord {
  const revObsEvidence: Extract<EvidenceLevel, 'observed' | 'inferred'> = params.revenue_settled
    ? 'observed'
    : 'inferred'

  switch (params.tier) {
    case 1:
      return Object.freeze({
        attribution_id: params.attribution_id,
        tenant_id: params.tenant_id,
        site_id: params.site_id,
        network_id: params.network_id,
        affiliate_key: params.affiliate_key,
        tier: 1,
        method: 'tier1_deterministic_subparam',
        slot_id: params.slot_id,
        click_id: params.click_id,
        amount_jpy: params.amount_jpy,
        revenue_observation_evidence: revObsEvidence,
        attribution_evidence: 'observed',
        allocated: false,
        not_slot_metric: false,
        not_training_label: false,
        candidate_click_count: 1,
      })

    case 2:
      return Object.freeze({
        attribution_id: params.attribution_id,
        tenant_id: params.tenant_id,
        site_id: params.site_id,
        network_id: params.network_id,
        affiliate_key: params.affiliate_key,
        tier: 2,
        method: 'tier2_preset_id_allocation',
        slot_id: params.slot_id,
        click_id: null,
        amount_jpy: params.amount_jpy,
        revenue_observation_evidence: revObsEvidence,
        attribution_evidence: 'observed',
        allocated: false,
        not_slot_metric: false,
        not_training_label: false,
        covered_click_share: params.covered_click_share ?? null,
        candidate_click_count: Math.max(1, params.candidate_click_count),
      })

    case 3:
      return Object.freeze({
        attribution_id: params.attribution_id,
        tenant_id: params.tenant_id,
        site_id: params.site_id,
        network_id: params.network_id,
        affiliate_key: params.affiliate_key,
        tier: 3,
        method: 'tier3_order_line_item',
        slot_id: params.slot_id,
        click_id: params.click_id,
        amount_jpy: params.amount_jpy,
        revenue_observation_evidence: revObsEvidence,
        attribution_evidence: params.candidate_click_count === 1 ? 'observed' : 'inferred',
        allocated: params.candidate_click_count > 1,
        not_slot_metric: false,
        not_training_label: false,
        candidate_click_count: Math.max(1, params.candidate_click_count),
      })

    case 4:
      // §6.5 #4: EVEN WHEN candidate_click_count === 1, time-window attribution MUST be `inferred`!
      return Object.freeze({
        attribution_id: params.attribution_id,
        tenant_id: params.tenant_id,
        site_id: params.site_id,
        network_id: params.network_id,
        affiliate_key: params.affiliate_key,
        tier: 4,
        method:
          params.candidate_click_count <= 1
            ? 'tier4_time_window_single_click'
            : 'tier4_time_window_prorated',
        slot_id: params.slot_id,
        click_id: params.click_id,
        amount_jpy: params.amount_jpy,
        revenue_observation_evidence: revObsEvidence,
        attribution_evidence: 'inferred',
        allocated: params.candidate_click_count > 1,
        not_slot_metric: false,
        not_training_label: false,
        candidate_click_count: Math.max(1, params.candidate_click_count),
      })

    case 5:
      // §6.5 #5: Program x Day proration is strictly excluded from slot evaluation & ML training!
      return Object.freeze({
        attribution_id: params.attribution_id,
        tenant_id: params.tenant_id,
        site_id: params.site_id,
        network_id: params.network_id,
        affiliate_key: params.affiliate_key,
        tier: 5,
        method: 'tier5_program_day_proration',
        slot_id: params.slot_id,
        click_id: null,
        amount_jpy: params.amount_jpy,
        revenue_observation_evidence: revObsEvidence,
        attribution_evidence: 'inferred',
        allocated: true,
        not_slot_metric: true,
        not_training_label: true,
        candidate_click_count: Math.max(1, params.candidate_click_count),
      })
  }
}

// ---------------------------------------------------------------------------
// 3. Offline-Signed Parameter Allowlist & Passkey Activation Gate (§6.5, D-11)
// ---------------------------------------------------------------------------

export interface OfflineAffiliateAllowlistPayload {
  readonly release_version: string
  readonly issued_at: string
  readonly expires_at: string
  /** Network -> allowed issuer parameter names (cannot be modified online!) */
  readonly allowed_params_by_network: Readonly<Record<string, readonly string[]>>
  /** `${tenant_id}|${site_id}|${network_id}` -> passkey-approved own preset IDs (Tier 2) */
  readonly approved_preset_ids: Readonly<Record<string, readonly string[]>>
}

export interface SignedOfflineAffiliateAllowlist {
  readonly payload: OfflineAffiliateAllowlistPayload
  readonly signature_b64: string
  readonly public_key_spki_b64: string
}

export interface SiteNetworkPasskeyApproval {
  readonly tenant_id: string
  readonly site_id: string
  readonly network_id: string
  readonly approved_by_passkey: boolean
  readonly passkey_assertion_id: string
  readonly approved_at: string
  /** §6.5: Activation is NEVER allowed inside autonomous publishing envelope */
  readonly via_autonomous_envelope: false
}

function canonicalAllowlistBytes(payload: OfflineAffiliateAllowlistPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload))
}

export async function signOfflineAffiliateAllowlist(
  payload: OfflineAffiliateAllowlistPayload,
  privateKey: webcrypto.CryptoKey,
  publicKey: webcrypto.CryptoKey,
): Promise<SignedOfflineAffiliateAllowlist> {
  const sig = await subtle.sign({ name: 'Ed25519' }, privateKey, canonicalAllowlistBytes(payload))
  const spki = await subtle.exportKey('spki', publicKey)
  return Object.freeze({
    payload,
    signature_b64: Buffer.from(sig).toString('base64'),
    public_key_spki_b64: Buffer.from(spki).toString('base64'),
  })
}

export async function verifyOfflineAffiliateAllowlist(
  signed: SignedOfflineAffiliateAllowlist,
  pinnedPublicKeySpkiB64: string,
  nowIso: string,
): Promise<{ readonly valid: boolean; readonly reason: string }> {
  if (signed.public_key_spki_b64 !== pinnedPublicKeySpkiB64) {
    return Object.freeze({ valid: false, reason: 'public_key_pin_mismatch' })
  }
  if (Date.parse(nowIso) > Date.parse(signed.payload.expires_at)) {
    return Object.freeze({ valid: false, reason: 'allowlist_expired' })
  }
  const spkiBytes = Buffer.from(pinnedPublicKeySpkiB64, 'base64')
  const pubKey = await subtle.importKey('spki', spkiBytes, { name: 'Ed25519' }, false, ['verify'])
  const sigBytes = Buffer.from(signed.signature_b64, 'base64')
  const ok = await subtle.verify(
    { name: 'Ed25519' },
    pubKey,
    sigBytes,
    canonicalAllowlistBytes(signed.payload),
  )
  return Object.freeze({ valid: ok, reason: ok ? 'ok' : 'invalid_ed25519_signature' })
}

export interface DecorateAffiliateUrlResult {
  readonly decorated: boolean
  readonly url: string
  readonly rejection_reason?:
    | 'passkey_approval_required'
    | 'autonomous_activation_prohibited'
    | 'allowlist_invalid'
    | 'param_not_in_offline_allowlist'
    | 'existing_param_overwrite_prohibited'
    | 'preset_id_not_approved'
    | 'invalid_url'
}

/**
 * クリック時の発行者パラメータ付与ランタイム (§6.5, D-11 / A-15R)。
 * - D-11 承認＋パスキー人承認が必須（自律枠除外）。
 * - オフライン署名許可表に無いパラメータ名および既存パラメータの上書きを厳格拒否。
 * - 行き先ホスト・パス・ネットワーク既存パラメータを 1 バイトも変更しない。
 */
export async function decorateAffiliateUrl(params: {
  readonly tenant_id: string
  readonly site_id: string
  readonly network_id: string
  readonly original_url: string
  readonly param_name: string
  readonly param_value: string
  readonly is_tier2_preset_id?: boolean
  readonly signed_allowlist: SignedOfflineAffiliateAllowlist
  readonly pinned_public_key_spki_b64: string
  readonly approval: SiteNetworkPasskeyApproval | null
  readonly now_iso: string
  readonly decisionCheckOverride?: () => DecisionEntitlementResult
}): Promise<DecorateAffiliateUrlResult> {
  const d11 = params.decisionCheckOverride
    ? params.decisionCheckOverride()
    : requireDecisionEntitled('D-11', { enforceLegalSignOff: true })
  if (!d11.entitled) {
    throw new NotEntitledError(d11)
  }

  if (
    !params.approval ||
    !params.approval.approved_by_passkey ||
    params.approval.tenant_id !== params.tenant_id ||
    params.approval.site_id !== params.site_id ||
    params.approval.network_id !== params.network_id
  ) {
    return Object.freeze({
      decorated: false,
      url: params.original_url,
      rejection_reason: 'passkey_approval_required',
    })
  }

  const verify = await verifyOfflineAffiliateAllowlist(
    params.signed_allowlist,
    params.pinned_public_key_spki_b64,
    params.now_iso,
  )
  if (!verify.valid) {
    return Object.freeze({
      decorated: false,
      url: params.original_url,
      rejection_reason: 'allowlist_invalid',
    })
  }

  let parsed: URL
  try {
    parsed = new URL(params.original_url)
  } catch {
    return Object.freeze({
      decorated: false,
      url: params.original_url,
      rejection_reason: 'invalid_url',
    })
  }

  if (params.is_tier2_preset_id) {
    const scopeKey = `${params.tenant_id}|${params.site_id}|${params.network_id}`
    const approvedIds = params.signed_allowlist.payload.approved_preset_ids[scopeKey] ?? []
    if (!approvedIds.includes(params.param_value)) {
      return Object.freeze({
        decorated: false,
        url: params.original_url,
        rejection_reason: 'preset_id_not_approved',
      })
    }
  } else {
    const allowedParams =
      params.signed_allowlist.payload.allowed_params_by_network[params.network_id] ?? []
    if (!allowedParams.includes(params.param_name)) {
      return Object.freeze({
        decorated: false,
        url: params.original_url,
        rejection_reason: 'param_not_in_offline_allowlist',
      })
    }
  }

  // Strictly refuse to overwrite any existing query parameter (§6.5)
  if (parsed.searchParams.has(params.param_name)) {
    return Object.freeze({
      decorated: false,
      url: params.original_url,
      rejection_reason: 'existing_param_overwrite_prohibited',
    })
  }

  parsed.searchParams.append(params.param_name, params.param_value)
  return Object.freeze({
    decorated: true,
    url: parsed.toString(),
  })
}

// ---------------------------------------------------------------------------
// 4. Randomized Rollout Guard (5% Holdout, <=10% Initial, Daily Auto-Halt)
// ---------------------------------------------------------------------------

export const AFFILIATE_PERMANENT_HOLDOUT_MIN_SHARE = 0.05
export const AFFILIATE_INITIAL_ROLLOUT_MAX_SHARE = 0.1
export const AFFILIATE_DAILY_RATIO_MIN = 0.85
export const AFFILIATE_DAILY_RATIO_MAX = 1.15

export interface AffiliateRolloutState {
  readonly tenant_id: string
  readonly site_id: string
  readonly network_id: string
  readonly phase: 'initial' | 'expanded' | 'auto_halted'
  readonly rollout_share: number
  readonly permanent_holdout_share: number
  readonly halted_reason: string | null
}

export class AffiliateRolloutGuard {
  private readonly states = new Map<string, AffiliateRolloutState>()

  private key(tenantId: string, siteId: string, networkId: string): string {
    return `${tenantId}|${siteId}|${networkId}`
  }

  configureNetwork(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly network_id: string
    readonly phase: 'initial' | 'expanded'
    readonly rollout_share: number
    readonly permanent_holdout_share?: number
  }): AffiliateRolloutState {
    const holdout = params.permanent_holdout_share ?? AFFILIATE_PERMANENT_HOLDOUT_MIN_SHARE
    if (holdout < AFFILIATE_PERMANENT_HOLDOUT_MIN_SHARE) {
      throw new Error(
        `Permanent unparameterized holdout must be >= ${AFFILIATE_PERMANENT_HOLDOUT_MIN_SHARE} (§6.5)`,
      )
    }
    if (params.phase === 'initial' && params.rollout_share > AFFILIATE_INITIAL_ROLLOUT_MAX_SHARE) {
      throw new Error(
        `Initial affiliate parameter rollout must be <= ${AFFILIATE_INITIAL_ROLLOUT_MAX_SHARE} (§6.5)`,
      )
    }
    if (params.rollout_share + holdout > 1 + 1e-9) {
      throw new Error('rollout_share + permanent_holdout_share cannot exceed 1.0')
    }

    const state: AffiliateRolloutState = Object.freeze({
      tenant_id: params.tenant_id,
      site_id: params.site_id,
      network_id: params.network_id,
      phase: params.phase,
      rollout_share: params.rollout_share,
      permanent_holdout_share: holdout,
      halted_reason: null,
    })
    this.states.set(this.key(params.tenant_id, params.site_id, params.network_id), state)
    return state
  }

  /**
   * クリック単位の決定的無作為割当（常時 ≥5% ノンパラメータ保持を保証）。
   */
  assignClickArm(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly network_id: string
    readonly click_id: string
  }): { readonly arm: 'decorated' | 'holdout_unparameterized' | 'halted'; readonly ratio_applied: number } {
    const state = this.states.get(this.key(params.tenant_id, params.site_id, params.network_id))
    if (!state || state.phase === 'auto_halted') {
      return Object.freeze({ arm: 'halted', ratio_applied: 0 })
    }

    // Deterministic uniform bucket in [0, 1)
    const digest = createHash('sha256')
      .update(`${params.tenant_id}|${params.site_id}|${params.network_id}|${params.click_id}`)
      .digest()
    const u = digest.readUInt32BE(0) / 0x100000000

    // Reserve [0, permanent_holdout_share) ALWAYS as unparameterized holdout
    if (u < state.permanent_holdout_share) {
      return Object.freeze({ arm: 'holdout_unparameterized', ratio_applied: 0 })
    }
    if (u < state.permanent_holdout_share + state.rollout_share) {
      return Object.freeze({ arm: 'decorated', ratio_applied: state.rollout_share })
    }
    return Object.freeze({ arm: 'holdout_unparameterized', ratio_applied: 0 })
  }

  /**
   * 日次 `NW報告クリック / 自社クリック` 監視: 逸脱時に当該ネットワークのみ自動停止する (§6.5)。
   */
  evaluateDailyClickRatio(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly network_id: string
    readonly own_counted_clicks: number
    readonly network_reported_clicks: number
    readonly min_clicks_to_trigger?: number
  }): { readonly ratio: number | null; readonly auto_halted: boolean; readonly state: AffiliateRolloutState | null } {
    const k = this.key(params.tenant_id, params.site_id, params.network_id)
    const state = this.states.get(k) ?? null
    const minClicks = params.min_clicks_to_trigger ?? 20

    if (params.own_counted_clicks < minClicks) {
      return Object.freeze({
        ratio:
          params.own_counted_clicks > 0
            ? params.network_reported_clicks / params.own_counted_clicks
            : null,
        auto_halted: false,
        state,
      })
    }

    const ratio = params.network_reported_clicks / params.own_counted_clicks
    const outOfBounds = ratio < AFFILIATE_DAILY_RATIO_MIN || ratio > AFFILIATE_DAILY_RATIO_MAX

    if (outOfBounds && state && state.phase !== 'auto_halted') {
      const halted: AffiliateRolloutState = Object.freeze({
        ...state,
        phase: 'auto_halted',
        rollout_share: 0,
        halted_reason: `daily_click_ratio_out_of_bounds:${ratio.toFixed(4)}`,
      })
      this.states.set(k, halted)
      return Object.freeze({ ratio, auto_halted: true, state: halted })
    }

    return Object.freeze({
      ratio,
      auto_halted: state?.phase === 'auto_halted',
      state,
    })
  }

  getState(tenantId: string, siteId: string, networkId: string): AffiliateRolloutState | null {
    return this.states.get(this.key(tenantId, siteId, networkId)) ?? null
  }
}
