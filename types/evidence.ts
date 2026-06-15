/**
 * Evidence Schema — UGOKI MAP / LINKTH 統合 SaaS 全 AI/ML 出力の根拠表記
 *
 * 親 SSOT §1.6 原則 2 / §1.8.2 / D-07
 * 配備: 続 54 §2.2 (AIチャット D-07 整合) / 続 57 (Sprint 3 W1 chat stub)
 *
 * 設計方針:
 *   - `EvidenceLevel` / `EvidenceMeta` は `lib/fixtures/dashboard.ts` で先行定義済 (Sprint 1)。
 *     重複を避けるため本ファイルは re-export で SSOT 化し、AIチャット 等の新規 API/ML 経路は
 *     `@/types/evidence` を canonical import path として参照する。
 *   - `EvidenceRef` (新規) は 1 件の根拠データへの参照を表す。chat / agent 等で
 *     LLM 応答に添付する。session_id / event_id / metric_query 等の指す先を抽象化。
 *   - `ChatReply` (新規) は `/api/chat` の Response schema。Sprint 3 W2 で SSE streaming
 *     対応時も末尾の `done` frame で同 shape を返却する想定。
 *
 * D-07 整合 (重要):
 *   - `inferred` / `planned` レベルの reply 内では断定数値表記禁止。
 *   - 数値を出す場合は「推定 X」prefix or range 表記 (例: 「推定 +¥0.8M〜1.5M」)。
 *   - UI 側は `<EvidenceBadge>` (components/dashboard/evidence-badge.tsx) でレベル可視化。
 */

export type { EvidenceLevel, EvidenceMeta } from '@/lib/fixtures/dashboard'

import type { EvidenceLevel } from '@/lib/fixtures/dashboard'

/**
 * 5-tier Evidence Level (続 66 §3 F-2 で導入、ML W2-A tools 出力規格).
 *
 * V1 4-tier (`EvidenceLevel`) との関係:
 *   - proven   → proven_exact   (raw events で exact 検証済)
 *   - observed → observed_exact (集計テーブル) / observed_approx (HLL / TDigest 近似)
 *   - inferred → inferred (LLM 推論)
 *   - planned  → planned (予測/仮説)
 *
 * 既存 4-tier 経路は破壊しない (lossy 拡張): `toEvidenceLevelV2()` で常に
 * 5-tier 表記へ写像可能。新規経路は 5-tier をそのまま流す。
 */
export type EvidenceLevelV2 =
  | 'proven_exact'
  | 'observed_exact'
  | 'observed_approx'
  | 'inferred'
  | 'planned'

/** EvidenceLevelV2 を含む union (UI 入力許容用) */
export type EvidenceLevelAny = EvidenceLevel | EvidenceLevelV2

const V1_TO_V2: Record<EvidenceLevel, EvidenceLevelV2> = {
  proven: 'proven_exact',
  observed: 'observed_exact',
  inferred: 'inferred',
  planned: 'planned',
}

const V2_TO_V1: Record<EvidenceLevelV2, EvidenceLevel> = {
  proven_exact: 'proven',
  observed_exact: 'observed',
  observed_approx: 'observed',
  inferred: 'inferred',
  planned: 'planned',
}

/** Any → V2 (V1 / V2 両方を受けて V2 を返す。UI badge で利用) */
export function toEvidenceLevelV2(level: EvidenceLevelAny): EvidenceLevelV2 {
  if (level === 'proven' || level === 'observed' || level === 'inferred' || level === 'planned') {
    return V1_TO_V2[level]
  }
  return level
}

/** Any → V1 (V2 を V1 に lossy 写像。既存 4-tier 経路向け) */
export function toEvidenceLevelV1(level: EvidenceLevelAny): EvidenceLevel {
  if (
    level === 'proven_exact' ||
    level === 'observed_exact' ||
    level === 'observed_approx' ||
    level === 'inferred' ||
    level === 'planned'
  ) {
    return V2_TO_V1[level]
  }
  return level
}

/**
 * 1 件の根拠データへの参照。LLM 応答や agent 出力に添付する。
 *
 * `kind` で参照先の種類を切り分ける:
 *   - `session`     : ClickHouse `events` の session_id 参照 (Sprint 3 W2 リプレイ連携)
 *   - `event`       : 単一 event 行 (session_id + event_id)
 *   - `metric`      : 集計クエリ結果 (例: cvr by device for last 7 days)
 *   - `proposal`    : 施策チケット ID (PROP-XXX) への back-link
 *   - `external`    : 外部リソース (GA4 report URL 等)
 *
 * `confidence` は 0-1 の数値 (proven=1.0 既定、observed=0.7-0.9、inferred=0.3-0.6)。
 */
export type EvidenceRefKind = 'session' | 'event' | 'metric' | 'proposal' | 'external'

export interface EvidenceRef {
  /** Stable ID for de-duplication in UI render */
  id: string
  kind: EvidenceRefKind
  level: EvidenceLevel
  /** Human-readable label (例: "セッション abc123 / モバイル"). PII を含めない */
  label: string
  /** Reference target. Shape varies by `kind` */
  target:
    | { kind: 'session'; session_id: string; site_id: string }
    | { kind: 'event'; session_id: string; event_id: string; site_id: string }
    | {
        kind: 'metric'
        metric: string
        dimension?: string
        site_id: string
        period_days: number
      }
    | { kind: 'proposal'; proposal_id: string }
    | { kind: 'external'; url: string; source: string }
  /** 0-1。inferred の場合は <0.7、proven は 1.0 を推奨 */
  confidence: number
}

/**
 * `/api/chat` の Response shape (Sprint 3 W1 stub + W2 本接続共通)。
 *
 * W2 streaming 時の `done` frame でも同 shape を返却する。
 * `reply` は markdown-lite (UI 側で hex color / 番号付きリスト等を render)。
 */
export interface ChatReply {
  /** 会話 ID。client が次 turn で `conversationId` として echo back する */
  conversationId: string
  /** AI 応答本文 (markdown-lite、D-07: inferred の数値は「推定」prefix) */
  reply: string
  /**
   * 全体としての根拠レベル。複数 EvidenceRef を持つ場合は最も弱いレベルを採用
   * (proven < observed < inferred < planned 順、weakest-wins)。
   */
  evidenceLevel: EvidenceLevel
  /** 個別根拠参照。UI で chip 表示 + クリックでドリルダウン */
  evidence: EvidenceRef[]
  /** 0-1 (evidence の confidence の最小値 or 単独 evidence の confidence) */
  confidence: number
  /** 次のアクション候補 (UI suggest chip) */
  suggestions: string[]
  modelMeta: {
    /** 'stub' (W1) / 'anthropic-direct' (W2 直接) / 'ai-gateway' (W2 Gateway 経由) */
    provider: 'stub' | 'anthropic-direct' | 'ai-gateway'
    /** モデル ID。Director + Reviewer 合議で確定 (続 54 §3.1 B) */
    model: string
    /** ms (end-to-end、parsing + transport 込み) */
    latencyMs: number
    /** input + output token (stub では 0) */
    tokens: number
    /**
     * 続 66 §3 F-3 で追加 (Token / Latency 表示 debug toggle 用 optional 拡張)。
     * ML W2-A orchestrator (M-4) 配備時に populate される。stub / 既存 4-tier 経路は undefined。
     */
    /** Time to first token / first byte (ms). ai-gateway stream の first chunk 受信時刻 - send 時刻 */
    ttftMs?: number
    /** input token 内訳 (cache hit / miss 合算でも可) */
    inputTokens?: number
    /** output token 内訳 (`tokens` = `inputTokens + outputTokens` を満たすこと) */
    outputTokens?: number
    /** 推論コスト USD (gateway billing 由来、orchestrator が `inputTokens × inputRate + outputTokens × outputRate` で算出) */
    costUsd?: number
  }
}

/**
 * AI SDK v6 stream parts に対応した assistant メッセージ分割 (続 66 §3 F-1).
 *
 * ML M-4 orchestrator は次のような stream parts を emit する:
 *   { type: 'data', data: { phase: 'partial', queryId, evidence, content } }
 *   { type: 'data', data: { phase: 'final', queryId, evidence, content } }
 *
 * `phase: 'partial'`:
 *   - tool 呼び出し途中で逐次出てくる暫定回答 (Haiku classifier や intermediate tool 結果)
 *   - UI は subtle 表示 (text-text-2 + 縦罫線インデント + "分析中..." 注記)
 *
 * `phase: 'final'`:
 *   - tool chain 完了後の確定回答 (Sonnet 最終合成 + evidence_level reduce 済)
 *   - UI は通常 bubble + EvidenceBadges (5-tier) + ChatActionButtons
 *
 * 後方互換: `parts` が undefined の場合は legacy `text` を render する。
 * W1 stub / 既存 chat path は parts なしのまま動作 (続 63 配備物の挙動維持)。
 */
export type StreamPhase = 'partial' | 'final'

export interface MessagePart {
  phase: StreamPhase
  /** ML M-1 4 Tools が発番した queryId (UI ではドリルダウンキーとして利用) */
  queryId?: string
  /** part 単位の evidence 参照。final part が canonical (UI badge は final を使う) */
  evidence?: EvidenceRef[]
  /** 表示テキスト (partial では tool 途中、final では完成回答) */
  content: string
}

/**
 * 複数 EvidenceRef から全体の `evidenceLevel` を decide する helper。
 * weakest-wins (最も弱い root を返す)。空配列の場合は引数 `fallback` を返す。
 */
const LEVEL_RANK: Record<EvidenceLevel, number> = {
  proven: 4,
  observed: 3,
  inferred: 2,
  planned: 1,
}

export function reduceEvidenceLevel(
  refs: ReadonlyArray<{ level: EvidenceLevel }>,
  fallback: EvidenceLevel = 'inferred',
): EvidenceLevel {
  if (refs.length === 0) return fallback
  let weakest: EvidenceLevel = refs[0].level
  for (const r of refs) {
    if (LEVEL_RANK[r.level] < LEVEL_RANK[weakest]) weakest = r.level
  }
  return weakest
}

/**
 * 5-tier ranking (続 66 §4 T7 / 続 68 W2-A、analytics tools 内部用)。
 * ChatReply 構築時は `toEvidenceLevelV1()` で 4-tier に lossy 写像する。
 */
const LEVEL_RANK_V2: Record<EvidenceLevelV2, number> = {
  proven_exact: 5,
  observed_exact: 4,
  observed_approx: 3,
  inferred: 2,
  planned: 1,
}

/**
 * 5-tier weakest-wins reducer (analytics tools 出力統合用、続 68 W2-A)。
 * 空配列時は `fallback` 返却 (既定 'inferred')。
 */
export function reduceEvidenceLevelV2(
  refs: ReadonlyArray<{ level: EvidenceLevelV2 }>,
  fallback: EvidenceLevelV2 = 'inferred',
): EvidenceLevelV2 {
  if (refs.length === 0) return fallback
  let weakest: EvidenceLevelV2 = refs[0].level
  for (const r of refs) {
    if (LEVEL_RANK_V2[r.level] < LEVEL_RANK_V2[weakest]) weakest = r.level
  }
  return weakest
}
