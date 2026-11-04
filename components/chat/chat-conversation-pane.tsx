/**
 * ChatConversationPane — UGOKIMAP AI chat の Client Component orchestrator
 *
 * 親 SSOT Part V P-AI / mockup 10_ai_chat.html / D-07 / 続 60 §7 [→Frontend]
 * 配備: 続 63 (Frontend Sprint 3 W1)
 * 拡張: Lane 4 (5平面横断AIアナリスト: LINKTH CRAWL 18ツールAnswer Engine × 行動 × GSC × GA4 AI流入 × AIreceipt)
 */

'use client'

import Link from 'next/link'
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
  '速度遅延による描画前離脱と推定CV損失数（/performance）',
  'デッドクリック集中箇所と<h>装飾乱用パッチ（/site-doc）',
  '主要LPのTeacher Verdict 7本柱とKaplan-Meier生存曲線（/fusion）',
  'ChatGPT/Perplexity流入とAIO引用差分（/aiseo）',
  '稼働中A/Bテストの仮説検定p値・検出力ゲート判定（/experiments）',
]

const FIVE_PLANE_NAV_PILLS = [
  { label: '① 構造・418監査 (サイトドック)', href: '/site-doc' },
  { label: '② 人間・AIヒートマップ', href: '/heatmap' },
  { label: '③ URLカルテ・7本柱 (Fusion)', href: '/fusion' },
  { label: '④ 90速度ルール×CV損失', href: '/performance' },
  { label: '⑤ AISEO (GA4 AI流入・AIO)', href: '/aiseo' },
  { label: '⑥ 内部リンク提案', href: '/seo/internal-links' },
  { label: '⑦ M Agent 介入', href: '/scenarios' },
  { label: '⑧ 仮説検定 A/Bテスト', href: '/experiments' },
] as const

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
        setDraft('')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'network error'
        setMessages((prev) =>
          prev.map((m): ChatMessage => {
            if (m.id !== pendingAssistant.id || m.role !== 'assistant') return m
            return { ...m, text: `[NETWORK] ${msg}`, status: 'error' }
          }),
        )
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
    setActiveConversationId(id)
  }, [])

  const handleAction = useCallback(
    (action: ChatActionKey, message: AssistantMessage) => {
      void action
      void message
    },
    [],
  )

  return (
    <div
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
        <header className="flex flex-col gap-2 border-b border-border bg-background px-4 py-2.5 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="truncate text-sm font-semibold">
                {messages.length === 0
                  ? '5平面横断AIアナリスト（クロール構造418項目 × 行動ヒートマップ × GSC × GA4 AI流入 × AIreceipt）'
                  : (messages.find((m) => m.role === 'user')?.text ?? '会話').slice(0, 60)}
              </p>
              <p className="font-mono text-[10px] text-text-3">
                {activeConversationId.slice(0, 12)} · {messages.length} messages · site={siteId} · 18-Tool Autonomous Answer Engine + HMAC verify_citation
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-text-2">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
              5-Plane Fusion Engine · {apiMode}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <span className="text-[11px] font-semibold text-text-3 mr-1">横断分析メニュー直通:</span>
            {FIVE_PLANE_NAV_PILLS.map((pill) => (
              <Link
                key={pill.href}
                href={pill.href}
                className="inline-flex items-center rounded-md border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-text-2 hover:bg-primary/10 hover:text-primary transition-colors"
              >
                {pill.label}
              </Link>
            ))}
          </div>
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
