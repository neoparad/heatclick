/**
 * ChatConversationPane — UGOKIMAP AI chat の Client Component orchestrator
 *
 * 親 SSOT Part V P-AI / mockup 10_ai_chat.html / D-07 / 続 60 §7 [→Frontend]
 * 配備: 続 63 (Frontend Sprint 3 W1)
 *
 * 責務:
 *   1. メッセージスレッド state を保持 (useState<ChatMessage[]>)
 *   2. POST /api/chat (続 58 stub) を呼出し、応答を AssistantMessage に変換
 *   3. 子 component (Sidebar / MessageList / Suggestions / Input) を組み立てる
 *
 * Sprint 3 W1 範囲:
 *   - JSON POST のみ (SSE streaming は W2)
 *   - 会話履歴 sidebar は dummy fixture、選択 / 新規だけ動作
 *   - エラー時は assistant message に error status で挿入 (toast は W2)
 *
 * Sprint 3 W2:
 *   - SSE streaming (fetch + ReadableStream で incremental reply)
 *   - 会話履歴 sidebar を `/api/chat/conversations` 結線
 *   - `evidence_level=inferred` 時の数値強調禁止を AI 応答 markdown render で検証
 */

'use client'

import { useCallback, useMemo, useState } from 'react'

import type { ChatReply, EvidenceRef } from '@/types/evidence'

import {
  ChatConversationSidebar,
  getDummyConversations,
} from './chat-conversation-sidebar'
import { ChatInput } from './chat-input'
import { ChatMessageList } from './chat-message-list'
import { ChatSuggestionChips } from './chat-suggestion-chips'
import type { ChatActionKey } from './chat-action-buttons'
import type {
  AssistantMessage,
  ChatMessage,
  UserMessage,
} from './types'

interface ChatConversationPaneProps {
  siteId: string
  initialPeriodDays?: number
  /** 開発時 banner 表示用 (Sprint 3 W1 = stub 既定) */
  apiMode?: 'stub' | 'live'
}

interface ApiSuccess {
  success: true
  data: ChatReply
}

interface ApiError {
  success: false
  error: { code: string; message: string }
}

type ApiResponseBody = ApiSuccess | ApiError

const INITIAL_SUGGESTIONS: ReadonlyArray<string> = [
  '同期間の他ページも比較',
  'CVR の時系列推移',
  'デバイス別の離脱差分',
]

function nowHHMM(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function makeId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now()}`
}

export function ChatConversationPane({
  siteId,
  initialPeriodDays = 7,
  apiMode = 'stub',
}: ChatConversationPaneProps) {
  const [activeConversationId, setActiveConversationId] = useState<string>(() =>
    makeId('conv'),
  )
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [suggestions, setSuggestions] =
    useState<ReadonlyArray<string>>(INITIAL_SUGGESTIONS)
  const [conversationId, setConversationId] = useState<string | null>(null)

  const conversations = useMemo(
    () => getDummyConversations(activeConversationId),
    [activeConversationId],
  )

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (trimmed.length === 0 || isSending) return

      const userMsg: UserMessage = {
        id: makeId('user'),
        role: 'user',
        text: trimmed,
        timestamp: nowHHMM(),
        status: 'complete',
      }
      const pendingAssistant: AssistantMessage = {
        id: makeId('asst'),
        role: 'assistant',
        text: '…',
        timestamp: nowHHMM(),
        status: 'pending',
        evidence: [],
      }

      setMessages((prev) => [...prev, userMsg, pendingAssistant])
      // 続 72 (B-3 fix): draft の optimistic clear は success まで遅延。
      // 旧 = 即 setDraft('') → error 時 user は同じ質問を打ち直す必要があった (UX 退化)
      // 新 = success 確認後にのみ clear、error/network 時は draft を保持して即 retry 可能
      setIsSending(true)

      try {
        const resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            conversationId: conversationId ?? undefined,
            message: trimmed,
            siteId,
            periodDays: initialPeriodDays,
          }),
        })
        const body = (await resp.json()) as ApiResponseBody

        if (!resp.ok || !body.success) {
          const errMessage =
            body.success === false
              ? `[${body.error.code}] ${body.error.message}`
              : `[HTTP_${resp.status}] 応答取得に失敗しました`
          setMessages((prev) =>
            prev.map((m): ChatMessage => {
              if (m.id !== pendingAssistant.id || m.role !== 'assistant') return m
              return { ...m, text: errMessage, status: 'error' }
            }),
          )
          // 続 72 (B-3 fix): error 時は draft 保持 (retry 可能化)、return で early-out
          return
        }

        const reply = body.data
        const evidence: EvidenceRef[] = reply.evidence
        if (conversationId === null) {
          setConversationId(reply.conversationId)
        }
        if (reply.suggestions.length > 0) {
          setSuggestions(reply.suggestions)
        }
        setMessages((prev) =>
          prev.map((m): ChatMessage => {
            if (m.id !== pendingAssistant.id || m.role !== 'assistant') return m
            const updated: AssistantMessage = {
              ...m,
              text: reply.reply,
              status: 'complete',
              reply,
              evidence,
            }
            return updated
          }),
        )
        // success が確定したので draft クリア (続 72 B-3 fix)
        setDraft('')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'network error'
        setMessages((prev) =>
          prev.map((m): ChatMessage => {
            if (m.id !== pendingAssistant.id || m.role !== 'assistant') return m
            return { ...m, text: `[NETWORK] ${msg}`, status: 'error' }
          }),
        )
        // network 例外時も draft 保持 (続 72 B-3 fix)
      } finally {
        setIsSending(false)
      }
    },
    [conversationId, initialPeriodDays, isSending, siteId],
  )

  const handleSendClick = useCallback(() => {
    void sendMessage(draft)
  }, [draft, sendMessage])

  const handleNewConversation = useCallback(() => {
    setActiveConversationId(makeId('conv'))
    setConversationId(null)
    setMessages([])
    setDraft('')
    setSuggestions(INITIAL_SUGGESTIONS)
  }, [])

  const handleSelectConversation = useCallback((id: string) => {
    // Sprint 3 W1: 履歴 fetch は W2 で本接続。今は選択状態だけ更新。
    setActiveConversationId(id)
  }, [])

  const handleAction = useCallback(
    (action: ChatActionKey, message: AssistantMessage) => {
      // Sprint 3 W2 で toast / Notion / Linear / Proposal API に結線。
      // 副作用 (clipboard) は ChatActionButtons 内で完了済。ここではログ目的のみ。
      void action
      void message
    },
    [],
  )

  return (
    <div
      // 続 72 (B-3 fix): 旧 `h-[calc(100vh-3.5rem)]` は親 <main> の header + DummyBanner
      // (合計約 120px) を過小評価しており、pane の底辺 (ChatInput) が viewport 外に
      // 押し出されて「入力欄が消える」現象を引き起こしていた。
      // 親 <main> が flex-col なので `flex-1 min-h-0` で残余高を正しく充填。
      className="grid flex-1 min-h-0 grid-cols-1 overflow-hidden border-t border-border bg-background lg:grid-cols-[260px_1fr]"
      data-testid="chat-pane"
      data-api-mode={apiMode}
    >
      <div className="hidden lg:block">
        <ChatConversationSidebar
          conversations={conversations}
          activeConversationId={activeConversationId}
          onSelectConversation={handleSelectConversation}
          onNewConversation={handleNewConversation}
          isDummy
        />
      </div>

      <section className="flex min-h-0 flex-col" aria-label="UGOKIMAP AI 会話">
        <header className="flex items-center gap-3 border-b border-border bg-background px-4 py-2 sm:px-6">
          <div className="flex-1 min-w-0">
            <p className="truncate text-sm font-medium">
              {messages.length === 0
                ? '新しい会話'
                : (messages.find((m) => m.role === 'user')?.text ?? '会話').slice(0, 60)}
            </p>
            <p className="font-mono text-[10px] text-text-3">
              {activeConversationId.slice(0, 12)} · {messages.length} messages · site={siteId}
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-text-2">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
            UGOKI Engine · {apiMode}
          </span>
        </header>

        <ChatMessageList
          messages={messages}
          scrollKey={`${messages.length}-${isSending ? '1' : '0'}`}
          onAction={handleAction}
        />

        <div className="border-t border-border bg-background px-4 pt-2 sm:px-6">
          <ChatSuggestionChips
            suggestions={suggestions}
            onPickSuggestion={(s) => setDraft((cur) => (cur.length > 0 ? `${cur} ${s}` : s))}
            disabled={isSending}
          />
        </div>

        <ChatInput
          value={draft}
          onChange={setDraft}
          onSend={handleSendClick}
          siteId={siteId}
          periodDays={initialPeriodDays}
          isSending={isSending}
        />
      </section>
    </div>
  )
}
