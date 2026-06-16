/**
 * ChatActionButtons — assistant メッセージ末尾のアクション群
 *
 * 親 SSOT Part V P-AI / mockup 10_ai_chat.html `.ai-actions`
 * 配備: 続 63 (Frontend Sprint 3 W1)
 *
 * Sprint 3 W1: クリック → onAction(actionKey) コールバックのみ (toast 表示は W2)。
 * 「施策作成 / Notion / Linear / コピー」の 4 つを SSOT 順序で配置。
 *
 * Sprint 3 W2+:
 *   - 施策作成 → POST /api/proposals (linkscrawl apply_proposals 配下 SSOT 流用)
 *   - Notion / Linear → 個別 integration (Owner 承認後)
 *   - コピー → clipboard.writeText(message.text)
 */

'use client'

import { Clipboard, Lightbulb } from 'lucide-react'

import { cn } from '@/lib/utils'

export type ChatActionKey = 'create-proposal' | 'copy-quote'

interface ChatActionButtonsProps {
  onAction: (action: ChatActionKey) => void
  /** 引用コピーで使う本文 (UI から hooks 側でアクセス、デフォルト no-op) */
  quotedText?: string
}

const ACTIONS: ReadonlyArray<{
  key: ChatActionKey
  label: string
  Icon: typeof Lightbulb
  variant: 'default' | 'secondary'
}> = [
  { key: 'create-proposal', label: '施策を作成', Icon: Lightbulb, variant: 'default' },
  { key: 'copy-quote', label: '引用コピー', Icon: Clipboard, variant: 'secondary' },
]

export function ChatActionButtons({ onAction, quotedText }: ChatActionButtonsProps) {
  const handleClick = async (key: ChatActionKey) => {
    if (key === 'copy-quote' && quotedText && typeof navigator !== 'undefined') {
      try {
        await navigator.clipboard.writeText(quotedText)
      } catch {
        /* 権限拒否時は親に通知 (toast は W2) */
      }
    }
    onAction(key)
  }

  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="提案アクション">
      {ACTIONS.map(({ key, label, Icon, variant }) => (
        <button
          key={key}
          type="button"
          onClick={() => void handleClick(key)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            variant === 'default'
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'border border-border bg-background hover:bg-accent',
          )}
        >
          <Icon className="h-3 w-3" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  )
}
