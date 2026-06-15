/**
 * components/chat/types.ts — UGOKIMAP AI チャット UI 内部型
 *
 * 親 SSOT §3.6 / Part V P-XX (mockup 10_ai_chat.html) / D-07 / 続 60 §7 [→Frontend]
 *
 * `ChatReply` (API 境界 schema) は `@/types/evidence.ts` に SSOT があるので import で
 * 取得。本ファイルは UI 内部表現 (= スレッド表示用 ChatMessage) を定義する。
 *
 * Sprint 3 W1 (stub) → W2 (SSE streaming) でも shape は維持。streaming 中は
 * `status: 'streaming'` を使い、partial reply を都度書き換える想定。
 */

import type { ChatReply, EvidenceRef, MessagePart } from '@/types/evidence'

export type { MessagePart } from '@/types/evidence'

export type ChatMessageRole = 'user' | 'assistant'

export type ChatMessageStatus = 'pending' | 'streaming' | 'complete' | 'error'

export interface ChatMessageBase {
  /** ローカル一意 ID (`crypto.randomUUID()` を client 側で発行) */
  id: string
  role: ChatMessageRole
  /** 表示用 HH:MM (client 側生成、SSR hydration mismatch 回避のため初回 mount 後に確定) */
  timestamp: string
  status: ChatMessageStatus
  text: string
}

export interface UserMessage extends ChatMessageBase {
  role: 'user'
}

export interface AssistantMessage extends ChatMessageBase {
  role: 'assistant'
  /** stub / W2 本接続いずれも `ChatReply` shape を保持して UI 描画に活用する */
  reply?: ChatReply
  /** D-07 整合: assistant 応答に必ず付与 (空配列は許容、その場合 EvidenceBadge は inferred で警告表記) */
  evidence: EvidenceRef[]
  /**
   * AI SDK v6 stream parts (続 66 §3 F-1).
   *
   * undefined = legacy 1-shot 回答 (W1 stub / 続 63 経路)。`text` をそのまま表示。
   * 配列 = streaming 中 or 完了。`phase: 'partial'` が逐次追加され、`phase: 'final'` が
   * 来た時点で確定回答として render される。partial の表示は subtle (text-text-2)。
   */
  parts?: MessagePart[]
}

export type ChatMessage = UserMessage | AssistantMessage

/** API error display 用に UI 側で握る簡易 shape */
export interface ChatError {
  code: string
  message: string
}

/** Dummy conversation list entry (W2 で `/api/chat/conversations` に置換予定) */
export interface DummyConversationEntry {
  id: string
  title: string
  /** "14:08" / "5/12" のような表示文字列 */
  timeLabel: string
  messageCount: number
  /** "今日" / "昨日" / "今週" を upstream で決定して group 化 */
  group: '今日' | '昨日' | '今週'
  isActive?: boolean
  pinned?: boolean
}
