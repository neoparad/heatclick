/**
 * UGOKI LINK v2 — 束 4-E (§8.7): 日本語公開埋め込みモデル選定ハーネス
 *
 * 設計書 §8.7:
 * - 商用利用可能な日本語公開埋め込み候補（`multilingual-e5-large`, `bge-m3`, `ruri-v3-310m`,
 *   `plamo-embedding-1b` 等）を、ライセンス確認ゲート＋統一プロバイダ抽象層の上で
 *   自前の日本語 3 タスク評価束にて定量比較する:
 *   1. クエリ → 答えの区画検索 (`recall_at_1`, `mrr`)
 *   2. 同義区画クラスタ分離 (`cluster_separation_margin`: クラスタ内類似度 − クラスタ間類似度)
 *   3. ページ種別判別 (`page_type_accuracy`: 記事・比較表・商品・FAQ 等の最近傍プロトタイプ精度)
 * - 商用ライセンス未確認・非商用候補は自動失格とし、適格候補から最高総合スコアのモデルを選定して
 *   内容ハッシュ付き成果物レコード (`SelectedEmbeddingArtifactRecord`) を発行する。
 */

import { createHash } from 'node:crypto'

import { cosineSimilarity, extractJapaneseNgrams } from './query-section-mapper'

// ---------------------------------------------------------------------------
// Candidate Registry & Provider Abstraction
// ---------------------------------------------------------------------------

export interface JapaneseEmbeddingCandidateSpec {
  readonly model_id: string
  readonly family: string
  readonly dimensions: number
  readonly license_spdx: string
  readonly commercial_use_allowed: boolean
  readonly license_verified: boolean
  readonly release_ref: string
}

export const DEFAULT_JP_EMBEDDING_CANDIDATES: readonly JapaneseEmbeddingCandidateSpec[] =
  Object.freeze([
    Object.freeze({
      model_id: 'intfloat/multilingual-e5-large',
      family: 'e5',
      dimensions: 1024,
      license_spdx: 'MIT',
      commercial_use_allowed: true,
      license_verified: true,
      release_ref: 'hf:intfloat/multilingual-e5-large',
    }),
    Object.freeze({
      model_id: 'BAAI/bge-m3',
      family: 'bge',
      dimensions: 1024,
      license_spdx: 'MIT',
      commercial_use_allowed: true,
      license_verified: true,
      release_ref: 'hf:BAAI/bge-m3',
    }),
    Object.freeze({
      model_id: 'cl-nagoya/ruri-v3-310m',
      family: 'ruri',
      dimensions: 768,
      license_spdx: 'Apache-2.0',
      commercial_use_allowed: true,
      license_verified: true,
      release_ref: 'hf:cl-nagoya/ruri-v3-310m',
    }),
    Object.freeze({
      model_id: 'pfnet/plamo-embedding-1b',
      family: 'plamo',
      dimensions: 2048,
      license_spdx: 'Apache-2.0',
      commercial_use_allowed: true,
      license_verified: true,
      release_ref: 'hf:pfnet/plamo-embedding-1b',
    }),
  ])

export interface JapaneseEmbeddingProvider {
  readonly spec: JapaneseEmbeddingCandidateSpec
  embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]>
}

// ---------------------------------------------------------------------------
// Deterministic Offline CI Embedder (Character N-Gram + Semantic Concept Hashing)
// ---------------------------------------------------------------------------

const DEFAULT_JP_CONCEPT_GROUPS: readonly (readonly string[])[] = Object.freeze([
  ['料金', '価格', '費用', '月額', '円', 'プラン', 'コスト', '税込'],
  ['解約', '退会', 'キャンセル', '停止', '違約金', '手続き'],
  ['比較', '違い', 'おすすめ', 'ランキング', 'スペック', '一覧'],
  ['口コミ', '評判', 'レビュー', '体験談', 'メリット', 'デメリット'],
  ['在庫', '発送', '送料', 'お届け', '注文', '購入', 'カート'],
  ['よくある質問', 'FAQ', '疑問', '問い合わせ', 'サポート'],
])

/**
 * CI・オフラインベンチマーク用の決定的日本語疑似エンベッダ。
 * `semantic_weight` / `noise_level` によりモデル間の品質差を再現しつつ外部通信 0 で動作する。
 */
export class DeterministicJapaneseTestEmbedder implements JapaneseEmbeddingProvider {
  constructor(
    public readonly spec: JapaneseEmbeddingCandidateSpec,
    private readonly options?: {
      readonly dim?: number
      /** Higher value strengthens Japanese synonym/concept alignment */
      readonly semantic_weight?: number
      /** Deterministic noise amplitude to distinguish stronger vs weaker candidates in tests */
      readonly noise_level?: number
    },
  ) {}

  async embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    const dim = this.options?.dim ?? 64
    const semW = this.options?.semantic_weight ?? 2.0
    const noise = this.options?.noise_level ?? 0

    return Object.freeze(
      texts.map((text) => {
        const vec = new Float64Array(dim)
        const grams = extractJapaneseNgrams(text)
        for (const [g, count] of grams.entries()) {
          const h = createHash('sha256').update(`${this.spec.model_id}|${g}`).digest()
          const bucket = h.readUInt16BE(0) % dim
          const sign = (h[2] & 1) === 0 ? 1 : -1
          vec[bucket] += sign * Math.log1p(count)
        }

        // Concept group projection (captures Japanese synonym equivalence)
        for (let ci = 0; ci < DEFAULT_JP_CONCEPT_GROUPS.length; ci++) {
          const group = DEFAULT_JP_CONCEPT_GROUPS[ci]
          const hits = group.filter((kw) => text.includes(kw)).length
          if (hits > 0) {
            const slot = ci % dim
            vec[slot] += semW * Math.log1p(hits)
          }
        }

        if (noise > 0) {
          const nh = createHash('sha256').update(`noise|${this.spec.model_id}|${text}`).digest()
          for (let i = 0; i < dim; i++) {
            const b = nh[i % nh.length]
            vec[i] += noise * ((b / 255) * 2 - 1)
          }
        }

        let norm = 0
        for (let i = 0; i < dim; i++) norm += vec[i] * vec[i]
        norm = Math.sqrt(norm) || 1
        return Object.freeze(Array.from(vec, (v) => v / norm))
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// 3-Task Japanese Evaluation Suite & Selection Artifact
// ---------------------------------------------------------------------------

export interface RetrievalEvalCase {
  readonly query: string
  readonly relevant_section_id: string
  readonly sections: readonly { readonly id: string; readonly text: string }[]
}

export interface ClusterEvalCase {
  readonly cluster_id: string
  readonly texts: readonly string[]
}

export interface PageTypeEvalCase {
  readonly page_type: string
  readonly text: string
}

export interface JapaneseEmbeddingEvalSuite {
  readonly suite_version: string
  readonly retrieval_cases: readonly RetrievalEvalCase[]
  readonly synonym_clusters: readonly ClusterEvalCase[]
  readonly page_type_prototypes: readonly PageTypeEvalCase[]
  readonly page_type_test_cases: readonly PageTypeEvalCase[]
}

export interface CandidateBenchmarkMetrics {
  readonly model_id: string
  readonly license_spdx: string
  readonly eligible: boolean
  readonly disqualification_reason: string | null
  readonly retrieval_recall_at_1: number
  readonly retrieval_mrr: number
  readonly cluster_separation_margin: number
  readonly page_type_accuracy: number
  readonly composite_score: number
}

export interface SelectedEmbeddingArtifactRecord {
  readonly artifact_id: string
  readonly suite_version: string
  readonly evaluated_at: string
  readonly selected_model_id: string
  readonly selected_license_spdx: string
  readonly selected_release_ref: string
  readonly selected_composite_score: number
  readonly content_sha256: string
  readonly candidates: readonly CandidateBenchmarkMetrics[]
}

export async function runJapaneseEmbeddingSelectionBenchmark(params: {
  readonly providers: readonly JapaneseEmbeddingProvider[]
  readonly suite: JapaneseEmbeddingEvalSuite
  readonly evaluated_at: string
}): Promise<SelectedEmbeddingArtifactRecord> {
  const results: CandidateBenchmarkMetrics[] = []

  for (const provider of params.providers) {
    const spec = provider.spec
    if (!spec.commercial_use_allowed || !spec.license_verified) {
      results.push(
        Object.freeze({
          model_id: spec.model_id,
          license_spdx: spec.license_spdx,
          eligible: false,
          disqualification_reason: !spec.commercial_use_allowed
            ? 'non_commercial_license'
            : 'license_unverified',
          retrieval_recall_at_1: 0,
          retrieval_mrr: 0,
          cluster_separation_margin: 0,
          page_type_accuracy: 0,
          composite_score: -Infinity,
        }),
      )
      continue
    }

    // Task 1: Query -> Section Retrieval (Recall@1 & MRR)
    let recall1Hits = 0
    let rrSum = 0
    for (const tc of params.suite.retrieval_cases) {
      const texts = [tc.query, ...tc.sections.map((s) => s.text)]
      const vecs = await provider.embedBatch(texts)
      const qVec = vecs[0]
      const scored = tc.sections
        .map((s, idx) => ({ id: s.id, sim: cosineSimilarity(qVec, vecs[idx + 1]) }))
        .sort((a, b) => b.sim - a.sim)
      const rank = scored.findIndex((s) => s.id === tc.relevant_section_id) + 1
      if (rank === 1) recall1Hits++
      if (rank > 0) rrSum += 1 / rank
    }
    const recall1 =
      params.suite.retrieval_cases.length > 0
        ? recall1Hits / params.suite.retrieval_cases.length
        : 0
    const mrr =
      params.suite.retrieval_cases.length > 0 ? rrSum / params.suite.retrieval_cases.length : 0

    // Task 2: Synonymous Section Cluster Separation (mean intra - mean inter cosine)
    const clusterVecs: Array<{ clusterId: string; vecs: readonly (readonly number[])[] }> = []
    for (const cl of params.suite.synonym_clusters) {
      clusterVecs.push({
        clusterId: cl.cluster_id,
        vecs: await provider.embedBatch(cl.texts),
      })
    }
    let intraSum = 0
    let intraCount = 0
    let interSum = 0
    let interCount = 0
    for (let i = 0; i < clusterVecs.length; i++) {
      const a = clusterVecs[i]
      for (let p = 0; p < a.vecs.length; p++) {
        for (let q = p + 1; q < a.vecs.length; q++) {
          intraSum += cosineSimilarity(a.vecs[p], a.vecs[q])
          intraCount++
        }
      }
      for (let j = i + 1; j < clusterVecs.length; j++) {
        const b = clusterVecs[j]
        for (const va of a.vecs) {
          for (const vb of b.vecs) {
            interSum += cosineSimilarity(va, vb)
            interCount++
          }
        }
      }
    }
    const intraMean = intraCount > 0 ? intraSum / intraCount : 0
    const interMean = interCount > 0 ? interSum / interCount : 0
    const separationMargin = Math.max(-1, Math.min(1, intraMean - interMean))

    // Task 3: Japanese Page-Type Nearest-Prototype Classification Accuracy
    const protoVecs = await provider.embedBatch(
      params.suite.page_type_prototypes.map((p) => p.text),
    )
    const testVecs = await provider.embedBatch(
      params.suite.page_type_test_cases.map((p) => p.text),
    )
    let pageTypeHits = 0
    for (let i = 0; i < params.suite.page_type_test_cases.length; i++) {
      let bestSim = -Infinity
      let bestType = ''
      for (let j = 0; j < params.suite.page_type_prototypes.length; j++) {
        const sim = cosineSimilarity(testVecs[i], protoVecs[j])
        if (sim > bestSim) {
          bestSim = sim
          bestType = params.suite.page_type_prototypes[j].page_type
        }
      }
      if (bestType === params.suite.page_type_test_cases[i].page_type) pageTypeHits++
    }
    const pageTypeAcc =
      params.suite.page_type_test_cases.length > 0
        ? pageTypeHits / params.suite.page_type_test_cases.length
        : 0

    // Composite weighted score (retrieval 50%, cluster separation 25%, page-type 25%)
    const normSep = (separationMargin + 1) / 2
    const composite = 0.25 * recall1 + 0.25 * mrr + 0.25 * normSep + 0.25 * pageTypeAcc

    results.push(
      Object.freeze({
        model_id: spec.model_id,
        license_spdx: spec.license_spdx,
        eligible: true,
        disqualification_reason: null,
        retrieval_recall_at_1: recall1,
        retrieval_mrr: mrr,
        cluster_separation_margin: separationMargin,
        page_type_accuracy: pageTypeAcc,
        composite_score: composite,
      }),
    )
  }

  const eligibleResults = results
    .filter((r) => r.eligible)
    .sort((a, b) => b.composite_score - a.composite_score)

  if (eligibleResults.length === 0) {
    throw new Error('No commercially licensed, verified Japanese embedding candidate is eligible (§8.7)')
  }

  const winner = eligibleResults[0]
  const winnerSpec = params.providers.find((p) => p.spec.model_id === winner.model_id)!.spec
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        suite_version: params.suite.suite_version,
        selected_model_id: winner.model_id,
        candidates: results,
      }),
    )
    .digest('hex')

  return Object.freeze({
    artifact_id: `emb_sel_${digest.slice(0, 16)}`,
    suite_version: params.suite.suite_version,
    evaluated_at: params.evaluated_at,
    selected_model_id: winner.model_id,
    selected_license_spdx: winnerSpec.license_spdx,
    selected_release_ref: winnerSpec.release_ref,
    selected_composite_score: winner.composite_score,
    content_sha256: digest,
    candidates: Object.freeze(results),
  })
}
