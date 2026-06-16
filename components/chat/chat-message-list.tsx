/**
 * ChatMessageList — User / Assistant 交互のメッセージスレッド
 *
 * 親 SSOT Part V P-AI / mockup 10_ai_chat.html `.ai-msgs` / D-07
 * 配備: 続 63 (Frontend Sprint 3 W1)
 *
 * Sprint 3 W1 スコープ:
 *   - 各 message を bubble 表示 (user = primary tint / assistant = surface)
 *   - assistant 応答に `<EvidenceBadge>` (`components/dashboard/evidence-badge.tsx`)
 *     `EvidenceMeta` shape に変換して埋め込み
 *   - D-07: `evidenceLevel` が `inferred` / `planned` の場合、bubble 上部に
 *     "AI 推定モード" ハイライトを表示 (UI 側で断定数値を強調しない指針)
 *   - error status の message は赤系で表示
 *
 * Sprint 3 W2:
 *   - reply markdown-lite (太字 / リスト / inline 引用 cite chip) を render
 *   - SSE streaming で `status: 'streaming'` 時に typing indicator
 *   - 各 EvidenceRef を chip 化、クリックで session_id ドリルダウン
 */

'use client'

import { useEffect, useRef } from 'react'
import { AlertCircle, Bot, User } from 'lucide-react'

import { EvidenceBadge } from '@/components/dashboard/evidence-badge'
import { cn } from '@/lib/utils'
import type { EvidenceLevel, EvidenceMeta } from '@/lib/fixtures/dashboard'

import { ChatActionButtons, type ChatActionKey } from './chat-action-buttons'
import { ChatModelMeta } from './chat-model-meta'
import type { AssistantMessage, ChatMessage, MessagePart } from './types'

interface ChatMessageListProps {
  messages: ReadonlyArray<ChatMessage>
  /** チャット末尾までスクロールするためのトリガー (state 更新ごと) */
  scrollKey?: string | number
  onAction: (action: ChatActionKey, message: AssistantMessage) => void
}

/** EvidenceRef[] と evidenceLevel から `EvidenceMeta` (UI badge 用) を組み立てる */
function buildBadgeMeta(message: AssistantMessage): EvidenceMeta {
  const level: EvidenceLevel = message.reply?.evidenceLevel ?? 'inferred'
  const confidence = message.reply?.confidence ?? 0
  const references = message.evidence.map((e) => e.id)
  return { level, confidence, references }
}

/** D-07 整合: inferred / planned の場合、bubble 上部に推定モード警告を表示 */
function isWeakEvidence(level: EvidenceLevel): boolean {
  return level === 'inferred' || level === 'planned'
}

export function ChatMessageList({ messages, scrollKey, onAction }: ChatMessageListProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [scrollKey])

  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-12 text-sm text-text-2">
        <div className="max-w-md space-y-2 text-center">
          <Bot className="mx-auto h-8 w-8 text-text-3" aria-hidden />
          <p className="font-medium">UGOKIMAP AI へようこそ</p>
          <p className="text-xs text-text-3">
            データを見ながら CVR / 離脱 / ペルソナ を質問してください。
            <br />
            Sprint 3 W1 stub: 応答は固定 (Evidence Level: planned)。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto" data-testid="chat-message-list">
      <div className="mx-auto max-w-3xl space-y-5 px-4 py-6 sm:px-6">
        {messages.map((m) => (
          <MessageRow key={m.id} message={m} onAction={onAction} />
        ))}
        <div ref={bottomRef} aria-hidden />
      </div>
    </div>
  )
}

interface MessageRowProps {
  message: ChatMessage
  onAction: (action: ChatActionKey, message: AssistantMessage) => void
}

function MessageRow({ message, onAction }: MessageRowProps) {
  if (message.role === 'user') {
    return (
      <div className="flex items-start gap-3" data-testid="chat-msg-user">
        <Avatar role="user" />
        <div className="flex-1">
          <header className="flex items-center gap-2 text-xs text-text-2">
            <span className="font-medium text-foreground">hiroki</span>
            <span className="font-mono text-text-3">{message.timestamp}</span>
          </header>
          <p className="mt-1 whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-sm leading-relaxed">
            {message.text}
          </p>
        </div>
      </div>
    )
  }

  return <AssistantRow message={message} onAction={onAction} />
}

function AssistantRow({
  message,
  onAction,
}: {
  message: AssistantMessage
  onAction: (action: ChatActionKey, message: AssistantMessage) => void
}) {
  const meta = buildBadgeMeta(message)
  const provider = message.reply?.modelMeta.provider ?? 'stub'
  const isError = message.status === 'error'
  const isStreaming = message.status === 'streaming' || message.status === 'pending'

  // 続 66 §3 F-1: stream parts (partial / final) を解析
  const parts: MessagePart[] = message.parts ?? []
  const finalPart = parts.find((p) => p.phase === 'final')
  const partialParts = parts.filter((p) => p.phase === 'partial')
  const hasParts = parts.length > 0

  return (
    <div className="flex items-start gap-3" data-testid="chat-msg-assistant">
      <Avatar role="assistant" error={isError} />
      <div className="flex-1 space-y-2">
        <header className="flex flex-wrap items-center gap-2 text-xs text-text-2">
          <span className="font-medium text-foreground">UGOKIMAP AI</span>
          <span className="font-mono text-text-3">{message.timestamp}</span>
          {message.reply ? <ChatModelMeta meta={message.reply.modelMeta} /> : null}
          <span
            className="ml-auto font-mono text-[10px] uppercase tracking-wider text-text-3"
            title="LLM provider"
          >
            {provider}
          </span>
        </header>

        {isError ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
            <p className="whitespace-pre-wrap">{message.text}</p>
          </div>
        ) : hasParts ? (
          <StreamingPartsBlock
            partials={partialParts}
            finalPart={finalPart}
            isStreaming={isStreaming}
            weakEvidence={isWeakEvidence(meta.level)}
            fallbackText={message.text}
          />
        ) : (
          <div
            className={cn(
              'rounded-md border border-border bg-background px-4 py-3',
              isStreaming && 'opacity-80',
            )}
          >
            {isWeakEvidence(meta.level) ? (
              <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-warning">
                AI 推定モード — 数値は実測ではありません (D-07)
              </p>
            ) : null}
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {message.text}
              {isStreaming ? (
                <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-foreground/60 align-baseline" />
              ) : null}
            </p>
          </div>
        )}

        {!isError && !isStreaming ? (
          <div className="flex flex-wrap items-center gap-2">
            <EvidenceBadge evidence={meta} />
            {message.evidence.length > 0 ? (
              <span className="font-mono text-[10px] text-text-3">
                根拠 {message.evidence.length} 件 (W2 で chip 化予定)
              </span>
            ) : null}
          </div>
        ) : null}

        {!isError && !isStreaming ? (
          <ChatActionButtons
            onAction={(key) => onAction(key, message)}
            quotedText={finalPart?.content ?? message.text}
          />
        ) : null}
      </div>
    </div>
  )
}

/**
 * 続 66 §3 F-1 — stream parts (partial / final) 区別表示。
 *
 * partial: subtle gray + 縦罫線インデント + "分析中..." 注記
 * final  : 通常 bubble。partial が残っていても final があれば final が canonical。
 *
 * `isStreaming` 中で final 未到達 = 全て partial 表示 + cursor。
 * `isStreaming` 終了 + final あり = final のみ render (partial は折りたたみ表示)。
 */
function StreamingPartsBlock({
  partials,
  finalPart,
  isStreaming,
  weakEvidence,
  fallbackText,
}: {
  partials: ReadonlyArray<MessagePart>
  finalPart: MessagePart | undefined
  isStreaming: boolean
  weakEvidence: boolean
  fallbackText: string
}) {
  if (!finalPart) {
    // streaming 途中 (final 未到達)
    return (
      <div className="space-y-2" data-testid="chat-stream-partial-block">
        {partials.length === 0 ? (
          <p className="text-xs text-text-3">分析を準備中…</p>
        ) : (
          partials.map((p, i) => (
            <div
              key={p.queryId ?? `partial-${i}`}
              className="border-l-2 border-brand-1/20 pl-2 text-sm text-text-2"
              data-testid="chat-stream-partial"
            >
              <span className="font-mono text-[10px] uppercase tracking-wider text-text-3">
                分析中… {p.queryId ? `· q=${p.queryId.slice(0, 8)}` : ''}
              </span>
              <p className="whitespace-pre-wrap leading-relaxed">{p.content}</p>
            </div>
          ))
        )}
        {isStreaming ? (
          <span
            aria-hidden
            className="inline-block h-3 w-1.5 animate-pulse bg-foreground/60 align-baseline"
          />
        ) : null}
      </div>
    )
  }

  // final 到達済 (canonical 表示)
  return (
    <div
      className="rounded-md border border-border bg-background px-4 py-3"
      data-testid="chat-stream-final-block"
    >
      {weakEvidence ? (
        <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-warning">
          AI 推定モード — 数値は実測ではありません (D-07)
        </p>
      ) : null}
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {finalPart.content || fallbackText}
      </p>
      {partials.length > 0 ? (
        <details className="mt-2 text-xs text-text-3" data-testid="chat-stream-partial-trace">
          <summary className="cursor-pointer select-none font-mono uppercase tracking-wider">
            分析過程 ({partials.length} step)
          </summary>
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            {partials.map((p, i) => (
              <li key={p.queryId ?? `trace-${i}`} className="whitespace-pre-wrap">
                {p.content}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  )
}

function Avatar({ role, error }: { role: ChatMessage['role']; error?: boolean }) {
  if (role === 'user') {
    return (
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">
        <User className="h-4 w-4" aria-hidden />
      </div>
    )
  }
  return (
    <div
      className={cn(
        'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold',
        error
          ? 'bg-destructive/15 text-destructive'
          : 'bg-success/15 text-success',
      )}
    >
      <Bot className="h-4 w-4" aria-hidden />
    </div>
  )
}
