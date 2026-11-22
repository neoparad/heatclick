/**
 * UGOKI LINK v2 — 束 4-E (手順 15, §6.6): クエリ→「答えの区画」順位づけ & 仮定なし上下限 (Fréchet/Manski)
 *
 * 設計書 §6.6 / join-final.md M6 / Unknowables Ledger (`tel.U4`):
 * 1. **ハイブリッド順位づけ**:
 *    埋め込みコサイン類似度 ＋ 日本語対応語彙一致 (文字 bi-gram / tri-gram BM25 相当) を
 *    Reciprocal Rank Fusion (RRF)＋正規化スコアで統合。
 *    1 位得点または 1 位−2 位マージンが閾値未満なら `no_clear_answer_section` を返す。
 * 2. **3 出力の厳密分離**:
 *    - (a) `page_google_reach`: Google 流入全体のページ区画到達率 (`observed`)
 *    - (b) `assumption_free_bounds`: クエリ `q` の仮定なし Fréchet / Manski 上下限 (`inferred`)
 *          `lower = max(0, (R - (1 - s_q)) / s_q)`, `upper = min(1, R / s_q)`
 *          （`q` が着地の大半を占める時だけ幅が狭くなる）
 *    - (c) `statistical_model_estimate`: 無情報事前分布での幅が狭い時 (`width <= 0.30`) のみ返却、
 *          それ以外は `insufficient_data` として伏せる
 * 3. **知りえないこと台帳 (`tel.U4`) 連動拒否**:
 *    訪問ごとの自然検索クエリ・クエリ別直帰率・クエリ別 CVR は原理的に観測不可として必ず拒否する。
 */

import { UNKNOWABLES_LEDGER } from '@/packages/contract/ledgers'
import { normText } from '@/packages/contract/segmenter'

// ---------------------------------------------------------------------------
// 1. Hybrid Query -> Answer Section Mapper (§6.6)
// ---------------------------------------------------------------------------

export interface SectionCandidateForQuery {
  readonly section_uid: string
  readonly sec_fp: string
  readonly body_fp: string
  readonly heading_text: string
  readonly body_text: string
  readonly embedding: readonly number[]
}

export interface RankedSectionCandidate {
  readonly section_uid: string
  readonly sec_fp: string
  readonly cosine_similarity: number
  readonly lexical_score: number
  readonly rrf_score: number
  readonly combined_score: number
}

/** Simultaneous 95% Bonferroni normal critical value z_{1 - 0.05 / (2 * 2)} = Phi^{-1}(0.9875) */
const Z_SIMULTANEOUS_2_95 = 2.241402727604947

function wilsonBounds(
  successes: number,
  trials: number,
  z = Z_SIMULTANEOUS_2_95,
): { readonly lower: number; readonly upper: number } {
  if (!Number.isFinite(trials) || trials <= 0) {
    return { lower: 0, upper: 1 }
  }
  const k = Math.min(trials, Math.max(0, successes))
  if (k === 0) {
    const z2 = z * z
    return { lower: 0, upper: Math.min(1, z2 / (trials + z2)) }
  }
  const p = k / trials
  const z2 = z * z
  const denom = 1 + z2 / trials
  const center = p + z2 / (2 * trials)
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)
  return {
    lower: Math.max(0, (center - half) / denom),
    upper: Math.min(1, (center + half) / denom),
  }
}

export interface QuerySectionMappingResult {
  readonly query: string
  readonly status: 'matched' | 'no_clear_answer_section'
  readonly best_section_uid: string | null
  readonly best_sec_fp: string | null
  readonly top1_score: number | null
  readonly top2_score: number | null
  readonly margin: number | null
  readonly min_score_threshold: number
  readonly min_margin_threshold: number
  readonly gate_blocked_reason?: string | null
  readonly rankings: readonly RankedSectionCandidate[]
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length)
  if (len === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom > 0 ? dot / denom : 0
}

/**
 * 日本語対応の文字 n-gram (2-gram + 3-gram) 抽出。スペース区切りの無い日本語でも安定一致する。
 */
export function extractJapaneseNgrams(text: string): Map<string, number> {
  const cleaned = normText(text).replace(/\s+/g, '')
  const counts = new Map<string, number>()
  if (!cleaned) return counts

  const chars = Array.from(cleaned)
  if (chars.length === 1) {
    counts.set(chars[0], 1)
    return counts
  }

  for (const n of [2, 3]) {
    for (let i = 0; i <= chars.length - n; i++) {
      const gram = chars.slice(i, i + n).join('')
      counts.set(gram, (counts.get(gram) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * BM25 風の日本語文字 n-gram 語彙一致スコア ([0, 1] 正規化)。
 */
function computeLexicalBm25Scores(
  query: string,
  candidates: readonly SectionCandidateForQuery[],
): number[] {
  const qGrams = extractJapaneseNgrams(query)
  if (qGrams.size === 0 || candidates.length === 0) {
    return candidates.map(() => 0)
  }

  const docGrams = candidates.map((c) =>
    extractJapaneseNgrams(`${c.heading_text} ${c.heading_text} ${c.body_text}`),
  )
  const docLengths = docGrams.map((m) => {
    let sum = 0
    for (const v of m.values()) sum += v
    return sum
  })
  const avgDl = Math.max(1, docLengths.reduce((s, l) => s + l, 0) / docLengths.length)
  const N = candidates.length

  // Document frequency per query n-gram
  const df = new Map<string, number>()
  for (const gram of qGrams.keys()) {
    let count = 0
    for (const dm of docGrams) {
      if (dm.has(gram)) count++
    }
    df.set(gram, count)
  }

  const k1 = 1.2
  const b = 0.75
  const rawScores = docGrams.map((dm, idx) => {
    const dl = docLengths[idx]
    let score = 0
    for (const gram of qGrams.keys()) {
      const tf = dm.get(gram) ?? 0
      if (tf === 0) continue
      const dfVal = df.get(gram) ?? 0
      const idf = Math.log(1 + (N - dfVal + 0.5) / (dfVal + 0.5))
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgDl)))
    }
    return score
  })

  const maxRaw = Math.max(...rawScores, 0)
  if (maxRaw <= 0) return rawScores.map(() => 0)
  return rawScores.map((s) => s / maxRaw)
}

export function mapQueryToAnswerSection(params: {
  readonly query: string
  readonly query_embedding: readonly number[]
  readonly candidates: readonly SectionCandidateForQuery[]
  readonly min_score_threshold?: number
  readonly min_margin_threshold?: number
  readonly rrf_k?: number
  readonly gate_join_g14_passed?: boolean
}): QuerySectionMappingResult {
  const minScore = params.min_score_threshold ?? 0.35
  const minMargin = params.min_margin_threshold ?? 0.08
  const rrfK = params.rrf_k ?? 10

  if (params.gate_join_g14_passed === false) {
    return Object.freeze({
      query: params.query,
      status: 'no_clear_answer_section',
      best_section_uid: null,
      best_sec_fp: null,
      top1_score: null,
      top2_score: null,
      margin: null,
      min_score_threshold: minScore,
      min_margin_threshold: minMargin,
      gate_blocked_reason: 'join.G14_unmet',
      rankings: Object.freeze([]),
    })
  }

  if (params.candidates.length === 0) {
    return Object.freeze({
      query: params.query,
      status: 'no_clear_answer_section',
      best_section_uid: null,
      best_sec_fp: null,
      top1_score: null,
      top2_score: null,
      margin: null,
      min_score_threshold: minScore,
      min_margin_threshold: minMargin,
      gate_blocked_reason: null,
      rankings: Object.freeze([]),
    })
  }

  const cosines = params.candidates.map((c) =>
    Math.max(0, cosineSimilarity(params.query_embedding, c.embedding)),
  )
  const lexicals = computeLexicalBm25Scores(params.query, params.candidates)

  const denseOrder = params.candidates
    .map((_, idx) => idx)
    .sort((a, b) => cosines[b] - cosines[a])
  const lexOrder = params.candidates
    .map((_, idx) => idx)
    .sort((a, b) => lexicals[b] - lexicals[a])

  const denseRank = new Map<number, number>()
  denseOrder.forEach((idx, r) => denseRank.set(idx, r + 1))
  const lexRank = new Map<number, number>()
  lexOrder.forEach((idx, r) => lexRank.set(idx, r + 1))

  const rankings: RankedSectionCandidate[] = params.candidates
    .map((c, idx) => {
      const rrf = 1 / (rrfK + (denseRank.get(idx) ?? 100)) + 1 / (rrfK + (lexRank.get(idx) ?? 100))
      const combined = 0.6 * cosines[idx] + 0.4 * lexicals[idx]
      return Object.freeze({
        section_uid: c.section_uid,
        sec_fp: c.sec_fp,
        cosine_similarity: cosines[idx],
        lexical_score: lexicals[idx],
        rrf_score: rrf,
        combined_score: combined,
      })
    })
    .sort((a, b) => b.combined_score - a.combined_score || b.rrf_score - a.rrf_score)

  const top1 = rankings[0]
  const top2 = rankings[1] ?? null
  const margin = top2 ? top1.combined_score - top2.combined_score : top1.combined_score

  const clearMatch = top1.combined_score >= minScore && margin >= minMargin

  return Object.freeze({
    query: params.query,
    status: clearMatch ? 'matched' : 'no_clear_answer_section',
    best_section_uid: clearMatch ? top1.section_uid : null,
    best_sec_fp: clearMatch ? top1.sec_fp : null,
    top1_score: top1.combined_score,
    top2_score: top2 ? top2.combined_score : null,
    margin,
    min_score_threshold: minScore,
    min_margin_threshold: minMargin,
    gate_blocked_reason: null,
    rankings: Object.freeze(rankings),
  })
}

// ---------------------------------------------------------------------------
// 2. Three Strictly Separated Reach Outputs (a, b: Fréchet/Manski, c: Model)
// ---------------------------------------------------------------------------

export const MAX_INFORMATIVE_QUERY_BOUND_WIDTH = 0.3

export interface QueryReachAnalysisResult {
  readonly query: string
  readonly section_uid: string
  readonly gate_join_g14_passed: boolean
  /** (a) Overall Google landing reach rate on this page (`observed`) */
  readonly page_google_reach: {
    readonly rate: number
    readonly google_landing_pvs: number
    readonly evidence: 'observed'
  }
  /** (b) Finite-sample valid outer Fréchet / Manski bounds for query q (`inferred`) */
  readonly assumption_free_bounds: {
    readonly query_landing_share: number
    readonly lower: number
    readonly upper: number
    readonly point_lower: number
    readonly point_upper: number
    readonly width: number
    readonly is_narrow: boolean
    readonly evidence: 'inferred'
    readonly method: 'frechet_manski_no_assumptions'
  }
  /** (c) Statistical model estimate — emitted ONLY when join.G14 passes AND uninformative-prior width <= 0.30 */
  readonly statistical_model_estimate: {
    readonly status: 'ok' | 'insufficient_data'
    readonly estimate: number | null
    readonly uninformative_prior_lower: number | null
    readonly uninformative_prior_upper: number | null
    readonly width: number | null
    readonly evidence: 'inferred'
    readonly suppression_reason: string | null
  }
}

export function computeQueryReachOutputs(params: {
  readonly query: string
  readonly section_uid: string
  readonly page_google_reach_rate: number
  readonly page_google_landing_pvs: number
  readonly query_gsc_clicks: number
  readonly total_page_gsc_clicks: number
  readonly model_estimate?: {
    readonly point: number
    readonly uninformative_prior_lower: number
    readonly uninformative_prior_upper: number
  } | null
  readonly max_width?: number
  readonly gate_join_g14_passed?: boolean
}): QueryReachAnalysisResult {
  const maxWidth = params.max_width ?? MAX_INFORMATIVE_QUERY_BOUND_WIDTH
  const g14Passed = params.gate_join_g14_passed !== false
  const R = Math.min(1, Math.max(0, params.page_google_reach_rate))
  const sQ =
    params.total_page_gsc_clicks > 0
      ? Math.min(1, Math.max(0, params.query_gsc_clicks / params.total_page_gsc_clicks))
      : 0

  // Infinite-sample plug-in Fréchet / Manski bounds (reported for reference only)
  const pointLower = sQ > 0 ? Math.max(0, (R - (1 - sQ)) / sQ) : 0
  const pointUpper = sQ > 0 ? Math.min(1, R / sQ) : 1

  // Finite-sample valid outer Fréchet / Manski bounds over simultaneous 95% Wilson rectangle [R_L, R_U] x [s_L, s_U]:
  //   min_{(r,s)} max(0, (r - (1 - s)) / s) is achieved at (R_L, s_L)
  //   max_{(r,s)} min(1, r / s)             is achieved at (R_U, s_L)
  const nPv = Math.max(0, Math.floor(params.page_google_landing_pvs))
  const nGsc = Math.max(0, Math.floor(params.total_page_gsc_clicks))
  const reachCi = wilsonBounds(R * nPv, nPv)
  const shareCi = wilsonBounds(params.query_gsc_clicks, nGsc)

  const lower =
    !g14Passed || nPv <= 0 || nGsc <= 0 || shareCi.lower <= 0
      ? 0
      : Math.max(0, (reachCi.lower - (1 - shareCi.lower)) / shareCi.lower)
  const upper =
    !g14Passed || nPv <= 0 || nGsc <= 0 || shareCi.lower <= 0
      ? 1
      : Math.min(1, reachCi.upper / shareCi.lower)
  const width = Math.max(0, upper - lower)

  let modelBlock: QueryReachAnalysisResult['statistical_model_estimate']
  if (!g14Passed) {
    modelBlock = Object.freeze({
      status: 'insufficient_data',
      estimate: null,
      uninformative_prior_lower: null,
      uninformative_prior_upper: null,
      width: null,
      evidence: 'inferred',
      suppression_reason: 'join.G14_unmet',
    })
  } else if (!params.model_estimate || nPv < 30 || nGsc < 30) {
    modelBlock = Object.freeze({
      status: 'insufficient_data',
      estimate: null,
      uninformative_prior_lower: null,
      uninformative_prior_upper: null,
      width: null,
      evidence: 'inferred',
      suppression_reason: !params.model_estimate
        ? 'no_model_fit_available'
        : 'sample_size_below_minimum_30',
    })
  } else {
    const mWidth = Math.max(
      0,
      params.model_estimate.uninformative_prior_upper -
        params.model_estimate.uninformative_prior_lower,
    )
    if (mWidth > maxWidth) {
      modelBlock = Object.freeze({
        status: 'insufficient_data',
        estimate: null,
        uninformative_prior_lower: null,
        uninformative_prior_upper: null,
        width: mWidth,
        evidence: 'inferred',
        suppression_reason: `uninformative_prior_width_exceeds_${maxWidth}`,
      })
    } else {
      modelBlock = Object.freeze({
        status: 'ok',
        estimate: params.model_estimate.point,
        uninformative_prior_lower: params.model_estimate.uninformative_prior_lower,
        uninformative_prior_upper: params.model_estimate.uninformative_prior_upper,
        width: mWidth,
        evidence: 'inferred',
        suppression_reason: null,
      })
    }
  }

  return Object.freeze({
    query: params.query,
    section_uid: params.section_uid,
    gate_join_g14_passed: g14Passed,
    page_google_reach: Object.freeze({
      rate: R,
      google_landing_pvs: params.page_google_landing_pvs,
      evidence: 'observed',
    }),
    assumption_free_bounds: Object.freeze({
      query_landing_share: sQ,
      lower,
      upper,
      point_lower: pointLower,
      point_upper: pointUpper,
      width,
      is_narrow: g14Passed && width <= maxWidth,
      evidence: 'inferred',
      method: 'frechet_manski_no_assumptions',
    }),
    statistical_model_estimate: modelBlock,
  })
}

// ---------------------------------------------------------------------------
// 3. Unknowables Ledger (`tel.U4`) Enforcement for Forbidden Per-Visit Query Metrics
// ---------------------------------------------------------------------------

export type ForbiddenPerVisitQueryMetric =
  | 'per_visit_search_query'
  | 'query_bounce_rate'
  | 'query_cvr'

export interface UnknowableQueryMetricRefusal {
  readonly status: 'not_collected'
  readonly unknowable_by_design: true
  readonly requested_metric: ForbiddenPerVisitQueryMetric
  readonly limit_id: 'tel.U4'
  readonly limitation: string
  readonly strongest_proxy: string
  readonly value: null
}

/**
 * 訪問ごとの自然検索クエリ・クエリ別直帰率・クエリ別 CVR は「知りえないこと台帳 (`tel.U4`)」に従い
 * 常に観測不可 (`not_collected` + `unknowable_by_design: true`) として拒否する (§6.6)。
 */
export function rejectUnknowablePerVisitQueryMetric(
  requestedMetric: ForbiddenPerVisitQueryMetric,
): UnknowableQueryMetricRefusal {
  const entry = UNKNOWABLES_LEDGER.find((e) => e.id === 'tel.U4')
  return Object.freeze({
    status: 'not_collected',
    unknowable_by_design: true,
    requested_metric: requestedMetric,
    limit_id: 'tel.U4',
    limitation:
      entry?.limitation ??
      'Per-visit organic search query, query-level bounce rate, and query-level CVR cannot be observed from browsers.',
    strongest_proxy:
      entry?.strongestProxy ??
      'GSC landing page × query distribution and assumption-free Fréchet/Manski bounds',
    value: null,
  })
}
