/**
 * ChatSuggestionChips — composer 直上のサジェスト chip 群
 *
 * 親 SSOT Part V P-AI / mockup 10_ai_chat.html `.ai-suggest`
 * 配備: 続 63 (Frontend Sprint 3 W1)
 *
 * Sprint 3 W1: stub の `ChatReply.suggestions` を chip 化、クリックで composer に注入。
 * Sprint 3 W2: 本接続 LLM が動的に提案する suggestions を同じ shape で受領。
 */

'use client'

import { Activity, Clock, Sparkles, Users } from 'lucide-react'

import { cn } from '@/lib/utils'

interface ChatSuggestionChipsProps {
  suggestions: ReadonlyArray<string>
  onPickSuggestion: (text: string) => void
  disabled?: boolean
}

const ICONS = [Clock, Activity, Users, Sparkles] as const

export function ChatSuggestionChips({
  suggestions,
  onPickSuggestion,
  disabled,
}: ChatSuggestionChipsProps) {
  if (suggestions.length === 0) return null

  return (
    <div
      className="flex flex-wrap gap-1.5"
      role="group"
      aria-label="次の質問サジェスト"
    >
      {suggestions.map((s, i) => {
        const Icon = ICONS[i % ICONS.length]
        return (
          <button
            key={`${i}-${s}`}
            type="button"
            onClick={() => onPickSuggestion(s)}
            disabled={disabled}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs text-text-2 hover:bg-accent hover:text-accent-foreground',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            <Icon className="h-3 w-3" aria-hidden />
            {s}
          </button>
        )
      })}
    </div>
  )
}
