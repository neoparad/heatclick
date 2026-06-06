/**
 * ChatInput — composer (textarea + 送信ボタン + コンテキスト chip)
 *
 * 親 SSOT Part V P-AI / mockup 10_ai_chat.html `.ai-comp` / `.ai-comp-bar`
 * 配備: 続 63 (Frontend Sprint 3 W1)
 *
 * Sprint 3 W1:
 *   - 制御コンポーネント (value / onChange / onSend)
 *   - 送信 = Ctrl/Cmd + Enter で trigger、ボタン click でも可
 *   - 「サイト · N日」chip (現在の siteId / periodDays を表示、編集は disabled = W2)
 *
 * Sprint 3 W2+:
 *   - chip クリックで site picker / period picker drawer 表示
 *   - 添付ファイル (drag-and-drop)
 *   - スレッド固定 system prompt 設定モーダル
 */

'use client'

import { useCallback, useRef } from 'react'
import { Globe2, Paperclip, Send } from 'lucide-react'

import { cn } from '@/lib/utils'

interface ChatInputProps {
  value: string
  onChange: (next: string) => void
  onSend: () => void
  siteId: string
  periodDays: number
  isSending?: boolean
  /** 送信不可 (auth エラー / endpoint 501 等) */
  disabled?: boolean
  /** placeholder override (W2 で system prompt 連動) */
  placeholder?: string
}

const DEFAULT_PLACEHOLDER = 'UGOKI MAP のデータを見ながら何でも聞いてください'

export function ChatInput({
  value,
  onChange,
  onSend,
  siteId,
  periodDays,
  isSending = false,
  disabled = false,
  placeholder = DEFAULT_PLACEHOLDER,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const isCmdEnter = (e.metaKey || e.ctrlKey) && e.key === 'Enter'
      if (isCmdEnter) {
        e.preventDefault()
        if (!disabled && value.trim().length > 0) {
          onSend()
        }
      }
    },
    [disabled, value, onSend],
  )

  const canSend = !disabled && !isSending && value.trim().length > 0

  return (
    // 続 73: mockup `.ai-comp-wrap` に近い構造 (gradient 背景 + 中央寄せ + composer)
    <div className="flex-shrink-0 bg-gradient-to-b from-transparent to-[color:var(--ug-panel)] px-4 pb-5 pt-3 sm:px-6">
      <div className="mx-auto max-w-3xl space-y-2">
        <div
          className={cn(
            // mockup `.ai-comp`: rounded-[14px] + shadow-sm + focus-within glow
            'flex flex-col gap-1.5 rounded-[14px] border bg-[color:var(--ug-panel)] p-3 transition-colors',
            'border-[color:var(--ug-border-strong)] shadow-[0_1px_2px_rgba(15,17,23,.04),0_0_0_1px_rgba(15,17,23,.02)]',
            'focus-within:border-[color:var(--ug-accent)] focus-within:shadow-[0_0_0_3px_var(--ug-accent-bg),0_1px_2px_rgba(15,17,23,.04)]',
            disabled && 'opacity-60',
          )}
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={2}
            disabled={disabled}
            maxLength={4000}
            aria-label="チャット入力"
            className="w-full resize-none border-0 bg-transparent px-1 py-1 text-sm leading-[1.55] text-[color:var(--ug-text)] outline-none placeholder:text-[color:var(--ug-text-3)] disabled:cursor-not-allowed"
          />
          {/* mockup `.ai-comp-bar` */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled
              className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--ug-border-2)] bg-[color:var(--ug-bg-2)] px-2 py-1 font-mono text-[10.5px] text-[color:var(--ug-text-3)]"
              title="サイト / 期間 (W2 で picker 連動)"
            >
              <Globe2 className="h-3 w-3" aria-hidden />
              {siteId} · {periodDays}d
            </button>
            <button
              type="button"
              disabled
              className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--ug-border-2)] bg-[color:var(--ug-panel)] px-2 py-1 text-[10.5px] text-[color:var(--ug-text-3)] disabled:cursor-not-allowed disabled:opacity-70"
              title="添付 (W2)"
            >
              <Paperclip className="h-3 w-3" aria-hidden />
              添付
            </button>
            <div className="flex-1" />
            <span className="hidden font-mono text-[10px] text-[color:var(--ug-text-3)] sm:inline">
              {value.length}/4000
            </span>
            <button
              type="button"
              onClick={onSend}
              disabled={!canSend}
              aria-label="送信 (Ctrl+Enter)"
              title="送信 (Ctrl+Enter)"
              className={cn(
                'inline-flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border-0 text-white shadow-[0_1px_2px_rgba(15,17,23,.08),0_0_0_1px_rgba(94,106,210,.35)_inset] transition-[filter]',
                canSend
                  ? 'bg-gradient-to-b from-[#7079e0] to-[color:var(--ug-accent)] hover:brightness-110'
                  : 'cursor-not-allowed bg-[color:var(--ug-bg-2)] text-[color:var(--ug-text-3)] shadow-none',
              )}
            >
              <Send className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </div>
        <p className="text-center font-mono text-[10.5px] text-[color:var(--ug-text-3)]">
          UGOKIMAP AI は分析の補助です。重要な意思決定の前に根拠データを確認してください。
        </p>
      </div>
    </div>
  )
}
