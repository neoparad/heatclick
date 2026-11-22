/**
 * UGOKI LINK v2 — 束 4-E (手順 16, §7.7–§7.8): AI 検索探針・適格性台帳・引用挟み込み・無作為化
 *
 * 設計書 §7.7, §7.8 / 意思決定 D-13 (H-11) / ゲート `act.G34`, `act.answer_text`:
 * 1. **段階 0 適格性記録 (`observed`)**:
 *    `robots.txt`・CDN 方針・事業者別方針トークン (`Google-Extended` / `Applebot-Extended` 等) のスナップショット。
 * 2. **AI 検索探針**:
 *    - AI 概要 (SERP 提供元アダプタ抽象) & アシスタント公式 API 抽象（CI 用決定論的スタブ同梱）。
 *    - GSC 表示回数比例サンプリング (`sampleQueriesByGscImpressions`)。
 *    - 探針結果は「その面・その構成について `observed`」。
 *    - 改訂前後プローブ (`evaluateRevisionProbe`) で相手が保有する版を特定。
 *    - 推測不能な専用確認 URL (`mintCanaryConfirmationUrl` + `evaluateCanaryCompliance`) で
 *      実取得元と `robots.txt` 遵守を検証。
 * 3. **回答文保存ガード (`D-13` / H-11)**:
 *    - 既定は構造化抽出（引用 URL・スパン SHA-256 ハッシュ）のみ保存。
 *    - 生回答文の例外保存は `D-13`＋提供者ごとの法務署名ゲートが通るまで `NotEntitledError` で厳格拒否。
 * 4. **引用両側挟み込み & 段階別 AI 台帳**:
 *    - 探針 × サーバーログ突合 (`P(fetched|cited)` / `P(cited|fetched)`) から野生引用数の上下限 (`inferred`)。
 *    - 参照元なし AI 流入の前後 30 分差幅 (`inferred`)。
 *    - 学習クローラー価値は設計上観測不可 (`unknowable_by_design: true`)。
 *    - 4 週間以上の曜日 × 時間帯基準線による取得急増検出 (`act.G34`)。
 * 5. **適格性のディレクトリ対無作為化**:
 *    - オーナーの既存意図なき実験専用変更依頼は `NotEntitledError` で拒否。
 *    - `>= 6 対` かつ計画器必要件数達成時のみ `proven`、未達時は `observed`＋必要対/件数。
 *    - 検索流入・索引ページ数の自動巻戻しガードレール & 主要検索ディレクトリ 2 回目人承認＋リスク予算ゲート。
 */

import { createHash, createHmac } from 'node:crypto'

import {
  NotEntitledError,
  requireDecisionEntitled,
  type DecisionEntitlementResult,
} from '@/packages/contract/ledgers'
import type { EvidenceLevel } from '@/packages/contract/response'
import { computeUrlKeyV2 } from '@/packages/contract/urlkey'
import type { ActorObservationRecord } from '@/lib/link/actors'

import type { StoredGscRow } from './gsc-ga4-ingest'

// ---------------------------------------------------------------------------
// 1. Stage 0 Eligibility Ledger (`observed`)
// ---------------------------------------------------------------------------

export type PolicyRuleState = 'allow' | 'disallow' | 'unspecified'

export interface EligibilitySnapshot {
  readonly snapshot_id: string
  readonly tenant_id: string
  readonly site_id: string
  readonly captured_at: string
  readonly robots_txt_sha256: string
  readonly cdn_policy: {
    readonly ai_crawl_challenge: boolean
    readonly waf_bot_fight_mode: boolean
    readonly note: string | null
  }
  /** Explicit robots.txt / vendor opt-out states (Google-Extended, Applebot-Extended, GPTBot, etc.) */
  readonly token_policies: Readonly<Record<string, PolicyRuleState>>
  readonly evidence: 'observed'
  readonly stage: 0
}

export function createEligibilitySnapshot(params: {
  readonly tenant_id: string
  readonly site_id: string
  readonly captured_at: string
  readonly robots_txt_body: string
  readonly cdn_policy: EligibilitySnapshot['cdn_policy']
  readonly token_policies: Readonly<Record<string, PolicyRuleState>>
}): EligibilitySnapshot {
  const sha = createHash('sha256').update(params.robots_txt_body, 'utf8').digest('hex')
  return Object.freeze({
    snapshot_id: `elig_${params.site_id}_${sha.slice(0, 12)}`,
    tenant_id: params.tenant_id,
    site_id: params.site_id,
    captured_at: params.captured_at,
    robots_txt_sha256: sha,
    cdn_policy: Object.freeze({ ...params.cdn_policy }),
    token_policies: Object.freeze({ ...params.token_policies }),
    evidence: 'observed',
    stage: 0,
  })
}

// ---------------------------------------------------------------------------
// 2. GSC Impression-Proportional Query Sampling
// ---------------------------------------------------------------------------

export interface WeightedQueryCandidate {
  readonly query: string
  readonly impressions: number
}

/**
 * GSC 表示回数に比例した決定的サンプリング（重複なし、seed で再現可能 — §7.8）。
 */
export function sampleQueriesByGscImpressions(params: {
  readonly gsc_rows: readonly Pick<StoredGscRow, 'query' | 'impressions'>[]
  readonly sample_size: number
  readonly seed: string
}): readonly WeightedQueryCandidate[] {
  const byQuery = new Map<string, number>()
  for (const r of params.gsc_rows) {
    const imp = Math.max(0, r.impressions ?? 0)
    if (imp <= 0) continue
    byQuery.set(r.query, (byQuery.get(r.query) ?? 0) + imp)
  }

  const pool: WeightedQueryCandidate[] = [...byQuery.entries()].map(([query, impressions]) =>
    Object.freeze({ query, impressions }),
  )
  if (pool.length <= params.sample_size) {
    return Object.freeze(pool.sort((a, b) => b.impressions - a.impressions))
  }

  // Deterministic weighted reservoir sampling (A-Res: key = u^(1/w))
  const scored = pool.map((item) => {
    const digest = createHash('sha256').update(`${params.seed}|${item.query}`).digest()
    const u = Math.max(1e-12, digest.readUInt32BE(0) / 0x100000000)
    const key = Math.pow(u, 1 / item.impressions)
    return { item, key }
  })

  scored.sort((a, b) => b.key - a.key)
  return Object.freeze(scored.slice(0, params.sample_size).map((s) => s.item))
}

// ---------------------------------------------------------------------------
// 3. AI Search Probe Adapters (AI Overview SERP + Official Assistant API) & D-13 Answer Guard
// ---------------------------------------------------------------------------

export type AiProbeSurfaceKind = 'google_ai_overview' | 'chatgpt_api' | 'claude_api' | 'perplexity_api'

export interface RawProbeResponse {
  readonly surface: AiProbeSurfaceKind
  readonly provider: string
  readonly configuration_id: string
  readonly query: string
  readonly probed_at: string
  readonly cited_urls: readonly string[]
  readonly answer_text: string
  readonly answer_spans: readonly string[]
}

export interface AiOverviewSerpAdapter {
  readonly provider_name: string
  probeAiOverview(query: string, configId: string, probedAt: string): Promise<RawProbeResponse>
}

export interface OfficialAssistantApiAdapter {
  readonly provider_name: string
  readonly surface: Exclude<AiProbeSurfaceKind, 'google_ai_overview'>
  probeAssistant(query: string, configId: string, probedAt: string): Promise<RawProbeResponse>
}

/** CI 用決定論的 SERP AI 概要スタブ */
export class DeterministicSerpProbeStub implements AiOverviewSerpAdapter {
  public readonly provider_name = 'serp_stub_provider'
  constructor(
    private readonly fixtures: Readonly<
      Record<string, { readonly cited_urls: readonly string[]; readonly answer_text: string }>
    >,
  ) {}

  async probeAiOverview(
    query: string,
    configId: string,
    probedAt: string,
  ): Promise<RawProbeResponse> {
    const f = this.fixtures[query] ?? { cited_urls: [], answer_text: '' }
    const spans = f.answer_text
      .split(/[。\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    return Object.freeze({
      surface: 'google_ai_overview',
      provider: this.provider_name,
      configuration_id: configId,
      query,
      probed_at: probedAt,
      cited_urls: Object.freeze([...f.cited_urls]),
      answer_text: f.answer_text,
      answer_spans: Object.freeze(spans),
    })
  }
}

/** CI 用決定論的アシスタント公式 API スタブ */
export class DeterministicAssistantApiStub implements OfficialAssistantApiAdapter {
  constructor(
    public readonly provider_name: string,
    public readonly surface: Exclude<AiProbeSurfaceKind, 'google_ai_overview'>,
    private readonly fixtures: Readonly<
      Record<string, { readonly cited_urls: readonly string[]; readonly answer_text: string }>
    >,
  ) {}

  async probeAssistant(
    query: string,
    configId: string,
    probedAt: string,
  ): Promise<RawProbeResponse> {
    const f = this.fixtures[query] ?? { cited_urls: [], answer_text: '' }
    const spans = f.answer_text
      .split(/[。\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    return Object.freeze({
      surface: this.surface,
      provider: this.provider_name,
      configuration_id: configId,
      query,
      probed_at: probedAt,
      cited_urls: Object.freeze([...f.cited_urls]),
      answer_text: f.answer_text,
      answer_spans: Object.freeze(spans),
    })
  }
}

export interface StoredProbeAnswerRecord {
  readonly probe_id: string
  readonly tenant_id: string
  readonly site_id: string
  readonly surface: AiProbeSurfaceKind
  readonly provider: string
  readonly configuration_id: string
  readonly query: string
  readonly probed_at: string
  readonly cited_url_keys_v2: readonly string[]
  readonly span_sha256_hashes: readonly string[]
  readonly answer_sha256: string
  readonly raw_answer_stored: boolean
  /** Populated ONLY when D-13 + per-provider legal sign-off pass (encrypted/TTL-bounded) */
  readonly encrypted_raw_answer_envelope: {
    readonly cipher_placeholder_b64: string
    readonly expires_at: string
  } | null
  readonly evidence: 'observed'
  readonly scope: 'surface_and_configuration_only'
}

/**
 * 探針回答の保存処理 (`D-13` / H-11 ガード):
 * - 既定 (`request_raw_text_retention !== true`): 構造化抽出 (引用 URL + スパンハッシュ) のみ保存し、生文を廃棄。
 * - 生文保存要求時: `D-13` と提供者ごとの法務署名 (`provider_legal_signoffs[provider]`) が無い限り `NotEntitledError`。
 */
export function storeProbeAnswerRecord(params: {
  readonly tenant_id: string
  readonly site_id: string
  readonly raw: RawProbeResponse
  readonly request_raw_text_retention?: boolean
  readonly provider_legal_signoffs?: Readonly<Record<string, boolean>>
  readonly raw_retention_ttl_days?: number
  readonly decisionCheckOverride?: () => DecisionEntitlementResult
}): StoredProbeAnswerRecord {
  const citedKeys = params.raw.cited_urls.map((u) => computeUrlKeyV2(u).url_key_v2)
  const spanHashes = params.raw.answer_spans.map((sp) =>
    createHash('sha256').update(sp, 'utf8').digest('hex'),
  )
  const answerHash = createHash('sha256').update(params.raw.answer_text, 'utf8').digest('hex')

  let encryptedEnvelope: StoredProbeAnswerRecord['encrypted_raw_answer_envelope'] = null

  if (params.request_raw_text_retention) {
    const d13 = params.decisionCheckOverride
      ? params.decisionCheckOverride()
      : requireDecisionEntitled('D-13', { enforceLegalSignOff: true })
    if (!d13.entitled) {
      throw new NotEntitledError(d13)
    }

    const providerSigned = params.provider_legal_signoffs?.[params.raw.provider] === true
    if (!providerSigned) {
      throw new NotEntitledError({
        entitled: false,
        status: 'not_entitled',
        decisionId: 'D-13',
        reason: 'legal_signoff_pending',
        message: `Raw answer retention for provider "${params.raw.provider}" requires per-provider legal sign-off (D-13 / H-11)`,
        unlockRequirement: `Review ToS and record legal sign-off for provider "${params.raw.provider}"`,
      })
    }

    const ttlDays = Math.min(90, Math.max(1, params.raw_retention_ttl_days ?? 30))
    const expiresAt = new Date(
      Date.parse(params.raw.probed_at) + ttlDays * 24 * 60 * 60 * 1000,
    ).toISOString()
    encryptedEnvelope = Object.freeze({
      cipher_placeholder_b64: Buffer.from(params.raw.answer_text, 'utf8').toString('base64'),
      expires_at: expiresAt,
    })
  }

  const probeId = `prb_${createHash('sha256')
    .update(`${params.tenant_id}|${params.site_id}|${params.raw.surface}|${params.raw.query}|${params.raw.probed_at}`)
    .digest('hex')
    .slice(0, 16)}`

  return Object.freeze({
    probe_id: probeId,
    tenant_id: params.tenant_id,
    site_id: params.site_id,
    surface: params.raw.surface,
    provider: params.raw.provider,
    configuration_id: params.raw.configuration_id,
    query: params.raw.query,
    probed_at: params.raw.probed_at,
    cited_url_keys_v2: Object.freeze(citedKeys),
    span_sha256_hashes: Object.freeze(spanHashes),
    answer_sha256: answerHash,
    raw_answer_stored: encryptedEnvelope !== null,
    encrypted_raw_answer_envelope: encryptedEnvelope,
    evidence: 'observed',
    scope: 'surface_and_configuration_only',
  })
}

// ---------------------------------------------------------------------------
// 4. Revision Probe & Canary Confirmation URL (§7.8)
// ---------------------------------------------------------------------------

export function evaluateRevisionProbe(params: {
  readonly answer_text: string
  readonly pre_revision_marker: string
  readonly post_revision_marker: string
}): {
  readonly detected_version: 'pre_revision' | 'post_revision' | 'mixed' | 'unknown'
  readonly evidence: 'observed'
  readonly scope: 'surface_and_configuration_only'
} {
  const hasPre = params.answer_text.includes(params.pre_revision_marker)
  const hasPost = params.answer_text.includes(params.post_revision_marker)
  const detected =
    hasPost && !hasPre
      ? 'post_revision'
      : hasPre && !hasPost
        ? 'pre_revision'
        : hasPre && hasPost
          ? 'mixed'
          : 'unknown'
  return Object.freeze({
    detected_version: detected,
    evidence: 'observed',
    scope: 'surface_and_configuration_only',
  })
}

export interface CanaryConfirmationUrl {
  readonly canary_id: string
  readonly url: string
  readonly path: string
  readonly robots_disallowed: boolean
}

export function mintCanaryConfirmationUrl(params: {
  readonly host: string
  readonly tenant_id: string
  readonly site_id: string
  readonly surface: AiProbeSurfaceKind
  readonly nonce: string
  readonly secret: string | Buffer
  readonly robots_disallowed: boolean
}): CanaryConfirmationUrl {
  const token = createHmac('sha256', params.secret)
    .update(`${params.tenant_id}|${params.site_id}|${params.surface}|${params.nonce}`)
    .digest('hex')
    .slice(0, 32)
  const prefix = params.robots_disallowed ? '/_ugk-canary-disallowed' : '/_ugk-canary'
  const path = `${prefix}/${token}`
  return Object.freeze({
    canary_id: `cnr_${token.slice(0, 12)}`,
    url: `https://${params.host.toLowerCase()}${path}`,
    path,
    robots_disallowed: params.robots_disallowed,
  })
}

export function evaluateCanaryCompliance(params: {
  readonly canary: CanaryConfirmationUrl
  readonly server_observations: readonly Pick<
    ActorObservationRecord,
    'path' | 'raw_ua' | 'ua_family_version' | 'observed_at'
  >[]
}): {
  readonly fetched: boolean
  readonly hit_count: number
  readonly observed_uas: readonly string[]
  readonly robots_violated: boolean
  readonly evidence: 'observed'
} {
  const hits = params.server_observations.filter((o) => o.path === params.canary.path)
  const uas = [...new Set(hits.map((h) => h.raw_ua ?? h.ua_family_version))]
  return Object.freeze({
    fetched: hits.length > 0,
    hit_count: hits.length,
    observed_uas: Object.freeze(uas),
    robots_violated: params.canary.robots_disallowed && hits.length > 0,
    evidence: 'observed',
  })
}

// ---------------------------------------------------------------------------
// 5. Two-Sided Citation Bracketing, Referrerless Traffic Lift, Training Unknowable & Spike Detector
// ---------------------------------------------------------------------------

/** Simultaneous 95% Bonferroni normal critical value z_{1 - 0.05 / (2 * 2)} = Phi^{-1}(0.9875) */
const Z_CITATION_SIMULTANEOUS_95 = 2.241402727604947

function wilsonCitationBounds(
  successes: number,
  trials: number,
  z = Z_CITATION_SIMULTANEOUS_95,
): { readonly lower: number; readonly upper: number } {
  if (!Number.isFinite(trials) || trials <= 0) {
    return { lower: 0, upper: 1 }
  }
  const k = Math.min(trials, Math.max(0, successes))
  const z2 = z * z
  if (k === 0) {
    return { lower: 0, upper: Math.min(1, z2 / (trials + z2)) }
  }
  const p = k / trials
  const denom = 1 + z2 / trials
  const center = p + z2 / (2 * trials)
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)
  return {
    lower: Math.max(0, (center - half) / denom),
    upper: Math.min(1, (center + half) / denom),
  }
}

export interface CitationBracketingResult {
  readonly wild_server_fetches: number
  readonly p_fetched_given_cited: number | null
  readonly p_cited_given_fetched: number | null
  readonly p_fetched_given_cited_ci: { readonly lower: number; readonly upper: number }
  readonly p_cited_given_fetched_ci: { readonly lower: number; readonly upper: number }
  readonly wild_citations_lower: number
  readonly wild_citations_upper: number | null
  readonly point_wild_citations_lower: number
  readonly point_wild_citations_upper: number | null
  readonly upper_identifiable: boolean
  readonly gate_act_g25_passed: boolean
  readonly unidentifiable_reason: string | null
  readonly evidence: 'inferred'
}

/**
 * 探針 × サーバーログ突合による「野生引用数」の両側挟み込み (§7.8):
 * - 同時 95% Wilson 信頼区間 `[p_cf_L, p_cf_U]` と `[p_fc_L, p_fc_U]` を使用。
 * - 下限: `N_fetch * p_cf_L`（取得を伴う引用の保守下界）
 * - 上限: `p_fc_L > 0` かつ `act.G25` 充足時のみ `(N_fetch * p_cf_U) / p_fc_L`。
 *   分母下限 `p_fc_L <= 0`（または `probe_cited_count === 0` / `act.G25` 未達）のときは
 *   恣意的な `0.05` 床や点推定での除算を厳禁し、`wild_citations_upper: null`, `upper_identifiable: false` を返す！
 */
export function computeCitationBracketing(params: {
  readonly wild_server_fetches: number
  readonly probe_cited_count: number
  readonly probe_cited_and_fetched_count: number
  readonly probe_fetched_count: number
  readonly probe_fetched_and_cited_count: number
  readonly gate_act_g25_passed?: boolean
}): CitationBracketingResult {
  const g25Passed = params.gate_act_g25_passed !== false
  const fetches = Math.max(0, params.wild_server_fetches)

  const pFcPoint =
    params.probe_cited_count > 0
      ? Math.min(1, Math.max(0, params.probe_cited_and_fetched_count / params.probe_cited_count))
      : null
  const pCfPoint =
    params.probe_fetched_count > 0
      ? Math.min(1, Math.max(0, params.probe_fetched_and_cited_count / params.probe_fetched_count))
      : null

  const pFcCi = wilsonCitationBounds(params.probe_cited_and_fetched_count, params.probe_cited_count)
  const pCfCi = wilsonCitationBounds(
    params.probe_fetched_and_cited_count,
    params.probe_fetched_count,
  )

  const pointLower = pCfPoint !== null ? fetches * pCfPoint : 0
  const pointUpper =
    pCfPoint !== null && pFcPoint !== null && pFcPoint > 0 ? pointLower / pFcPoint : null

  if (!g25Passed) {
    return Object.freeze({
      wild_server_fetches: fetches,
      p_fetched_given_cited: pFcPoint,
      p_cited_given_fetched: pCfPoint,
      p_fetched_given_cited_ci: Object.freeze(pFcCi),
      p_cited_given_fetched_ci: Object.freeze(pCfCi),
      wild_citations_lower: 0,
      wild_citations_upper: null,
      point_wild_citations_lower: pointLower,
      point_wild_citations_upper: pointUpper,
      upper_identifiable: false,
      gate_act_g25_passed: false,
      unidentifiable_reason: 'act.G25_unmet',
      evidence: 'inferred',
    })
  }

  const lower = params.probe_fetched_count > 0 ? fetches * pCfCi.lower : 0
  if (params.probe_cited_count <= 0 || params.probe_fetched_count <= 0 || pFcCi.lower <= 0) {
    return Object.freeze({
      wild_server_fetches: fetches,
      p_fetched_given_cited: pFcPoint,
      p_cited_given_fetched: pCfPoint,
      p_fetched_given_cited_ci: Object.freeze(pFcCi),
      p_cited_given_fetched_ci: Object.freeze(pCfCi),
      wild_citations_lower: lower,
      wild_citations_upper: null,
      point_wild_citations_lower: pointLower,
      point_wild_citations_upper: pointUpper,
      upper_identifiable: false,
      gate_act_g25_passed: true,
      unidentifiable_reason:
        params.probe_cited_count <= 0
          ? 'zero_probe_citations'
          : params.probe_fetched_count <= 0
            ? 'zero_probe_fetches'
            : 'p_fetched_given_cited_ci_lower_includes_zero',
      evidence: 'inferred',
    })
  }

  const upper = Math.max(lower, (fetches * pCfCi.upper) / pFcCi.lower)
  return Object.freeze({
    wild_server_fetches: fetches,
    p_fetched_given_cited: pFcPoint,
    p_cited_given_fetched: pCfPoint,
    p_fetched_given_cited_ci: Object.freeze(pFcCi),
    p_cited_given_fetched_ci: Object.freeze(pCfCi),
    wild_citations_lower: lower,
    wild_citations_upper: upper,
    point_wild_citations_lower: pointLower,
    point_wild_citations_upper: pointUpper,
    upper_identifiable: true,
    gate_act_g25_passed: true,
    unidentifiable_reason: null,
    evidence: 'inferred',
  })
}

/**
 * 参照元なし AI 流入の前後 30 分差幅推定 (§7.7 段階 5)。
 */
export function computeReferrerlessAiTrafficLift(params: {
  readonly visits_in_30m_after_fetch: number
  readonly visits_in_matched_control_30m: number
  readonly event_count: number
}): {
  readonly point_lift_visits: number
  readonly lower_95: number
  readonly upper_95: number
  readonly evidence: 'inferred'
} {
  const diff = params.visits_in_30m_after_fetch - params.visits_in_matched_control_30m
  const se = Math.sqrt(
    Math.max(1, params.visits_in_30m_after_fetch + params.visits_in_matched_control_30m),
  )
  const margin = 1.959963984540054 * se
  return Object.freeze({
    point_lift_visits: Math.max(0, diff),
    lower_95: Math.max(0, diff - margin),
    upper_95: Math.max(0, diff + margin),
    evidence: 'inferred',
  })
}

/**
 * 学習用クローラーの経済価値は設計上観測不可 (`unknowable_by_design`, §7.7)。
 */
export function evaluateTrainingCrawlerValue(): {
  readonly status: 'not_applicable'
  readonly unknowable_by_design: true
  readonly value_jpy: null
  readonly reason: string
} {
  return Object.freeze({
    status: 'not_applicable',
    unknowable_by_design: true,
    value_jpy: null,
    reason: 'Training crawler economic value is unknowable by design (§7.7)',
  })
}

/**
 * 4 週間以上の曜日 × 時間帯基準線による事業者別取得急増検出 (`act.G34`, §7.7)。
 */
export function detectCrawlerTrafficSpike(params: {
  readonly current_hour_requests: number
  /** Same day-of-week & hour counts over >= 4 prior weeks */
  readonly historical_same_slot_weeks: readonly number[]
  readonly spike_ratio_threshold?: number
  readonly min_absolute_delta?: number
}): {
  readonly baseline_ready: boolean
  readonly baseline_median: number | null
  readonly ratio: number | null
  readonly spike_detected: boolean
} {
  if (params.historical_same_slot_weeks.length < 4) {
    return Object.freeze({
      baseline_ready: false,
      baseline_median: null,
      ratio: null,
      spike_detected: false,
    })
  }
  const sorted = [...params.historical_same_slot_weeks].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  const ratio = params.current_hour_requests / Math.max(1, median)
  const threshold = params.spike_ratio_threshold ?? 3.0
  const minDelta = params.min_absolute_delta ?? 50
  const spike = ratio >= threshold && params.current_hour_requests - median >= minDelta

  return Object.freeze({
    baseline_ready: true,
    baseline_median: median,
    ratio,
    spike_detected: spike,
  })
}

// ---------------------------------------------------------------------------
// 6. Eligibility Directory-Pair Randomization (§7.8)
// ---------------------------------------------------------------------------

export const ELIGIBILITY_MIN_DIRECTORY_PAIRS = 6

export interface DirectoryPairInput {
  readonly pair_id: string
  readonly dir_a: string
  readonly dir_b: string
  readonly is_major_search_directory: boolean
  readonly baseline_weekly_search_visits: number
}

export interface DirectoryPairAssignment {
  readonly pair_id: string
  readonly now_dir: string
  readonly later_dir: string
  readonly is_major_search_directory: boolean
  readonly wave: 1 | 2
  readonly requires_second_human_approval: boolean
}

export interface EligibilityRandomizationPlan {
  readonly experiment_id: string
  readonly tenant_id: string
  readonly site_id: string
  readonly assignments: readonly DirectoryPairAssignment[]
  readonly total_pairs: number
  readonly total_search_visits_at_risk: number
  readonly search_traffic_risk_budget: number
  readonly within_risk_budget: boolean
}

/**
 * 適格性変更のディレクトリ対無作為化計画器 (§7.8):
 * - オーナーの既存意図なき実験専用変更依頼は `NotEntitledError` で拒否。
 * - 主要検索ディレクトリは Wave 2（2 回目人承認必須）へ分離し、検索流入リスク予算を検査。
 */
export function planEligibilityDirectoryRandomization(params: {
  readonly experiment_id: string
  readonly tenant_id: string
  readonly site_id: string
  readonly owner_intended_change_independently: boolean
  readonly human_initial_approval: boolean
  readonly pairs: readonly DirectoryPairInput[]
  readonly search_traffic_risk_budget: number
  readonly seed: string
}): EligibilityRandomizationPlan {
  if (!params.owner_intended_change_independently) {
    throw new NotEntitledError({
      entitled: false,
      status: 'not_entitled',
      decisionId: 'ELIGIBILITY_OWNER_INTENT',
      reason: 'decision_pending',
      message:
        'Robots/eligibility changes solely for experimentation without independent owner intent are not_entitled (§7.8)',
      unlockRequirement: 'Owner must independently decide to make the eligibility change first',
    })
  }
  if (!params.human_initial_approval) {
    throw new NotEntitledError({
      entitled: false,
      status: 'not_entitled',
      decisionId: 'ELIGIBILITY_HUMAN_APPROVAL',
      reason: 'decision_pending',
      message: 'Human approval is required before rolling out eligibility changes (§7.8)',
      unlockRequirement: 'Obtain explicit human approval before wave 1 rollout',
    })
  }

  const assignments: DirectoryPairAssignment[] = params.pairs.map((p) => {
    const h = createHash('sha256').update(`${params.seed}|${p.pair_id}`).digest()
    const flip = (h[0] & 1) === 1
    return Object.freeze({
      pair_id: p.pair_id,
      now_dir: flip ? p.dir_b : p.dir_a,
      later_dir: flip ? p.dir_a : p.dir_b,
      is_major_search_directory: p.is_major_search_directory,
      wave: p.is_major_search_directory ? 2 : 1,
      requires_second_human_approval: p.is_major_search_directory,
    })
  })

  const totalRisk = params.pairs.reduce(
    (s, p) => s + Math.max(0, p.baseline_weekly_search_visits) / 2,
    0,
  )

  return Object.freeze({
    experiment_id: params.experiment_id,
    tenant_id: params.tenant_id,
    site_id: params.site_id,
    assignments: Object.freeze(assignments),
    total_pairs: assignments.length,
    total_search_visits_at_risk: totalRisk,
    search_traffic_risk_budget: params.search_traffic_risk_budget,
    within_risk_budget: totalRisk <= params.search_traffic_risk_budget,
  })
}

export function authorizeMajorDirectoryWave2(params: {
  readonly plan: EligibilityRandomizationPlan
  readonly second_human_approval: boolean
}): { readonly authorized: boolean; readonly reason: string } {
  if (!params.plan.within_risk_budget) {
    return Object.freeze({ authorized: false, reason: 'exceeds_search_traffic_risk_budget' })
  }
  if (!params.second_human_approval) {
    return Object.freeze({
      authorized: false,
      reason: 'second_human_approval_required_for_major_search_directories',
    })
  }
  return Object.freeze({ authorized: true, reason: 'authorized_wave2' })
}

export function evaluateEligibilityRandomizationOutcome(params: {
  readonly paired_directories: number
  readonly observed_units: number
  readonly planner_required_units: number
  readonly search_traffic_change_ratio: number
  readonly indexed_pages_change_ratio: number
  /** Guardrail drop limit (default -0.10 = -10% drop triggers auto-rollback) */
  readonly max_search_drop_ratio?: number
  readonly max_indexed_drop_ratio?: number
  readonly gate_act_g25_passed?: boolean
}): {
  readonly evidence_level: Extract<EvidenceLevel, 'proven' | 'observed'>
  readonly auto_rollback_triggered: boolean
  readonly rollback_reasons: readonly string[]
  readonly additional_pairs_needed: number
  readonly additional_units_needed: number
  readonly gate_act_g25_passed: boolean
} {
  const maxSearchDrop = params.max_search_drop_ratio ?? -0.1
  const maxIndexDrop = params.max_indexed_drop_ratio ?? -0.1
  const g25Passed = params.gate_act_g25_passed !== false
  const rollbackReasons: string[] = []

  if (params.search_traffic_change_ratio < maxSearchDrop) {
    rollbackReasons.push(
      `search_traffic_guardrail_breached:${params.search_traffic_change_ratio.toFixed(4)}`,
    )
  }
  if (params.indexed_pages_change_ratio < maxIndexDrop) {
    rollbackReasons.push(
      `indexed_pages_guardrail_breached:${params.indexed_pages_change_ratio.toFixed(4)}`,
    )
  }

  const rollback = rollbackReasons.length > 0
  const pairsShortfall = Math.max(0, ELIGIBILITY_MIN_DIRECTORY_PAIRS - params.paired_directories)
  const requiredUnits = Math.max(1, params.planner_required_units)
  const unitsShortfall = Math.max(0, requiredUnits - Math.max(0, params.observed_units))

  const isProven =
    g25Passed &&
    !rollback &&
    pairsShortfall === 0 &&
    unitsShortfall === 0 &&
    params.observed_units > 0 &&
    params.planner_required_units > 0

  return Object.freeze({
    evidence_level: isProven ? 'proven' : 'observed',
    auto_rollback_triggered: rollback,
    rollback_reasons: Object.freeze(rollbackReasons),
    additional_pairs_needed: pairsShortfall,
    additional_units_needed: unitsShortfall,
    gate_act_g25_passed: g25Passed,
  })
}
