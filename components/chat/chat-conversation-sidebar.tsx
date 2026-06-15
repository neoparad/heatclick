/**
 * ChatConversationSidebar — 会話履歴サイドバー (mockup 10_ai_chat.html `aside.ai-hist`)
 *
 * 親 SSOT Part V P-AI / D-07 / 続 60 §7 [→Frontend] (b)
 * 配備: 続 63 (Frontend Sprint 3 W1)
 *
 * Sprint 3 W1 スコープ:
 *   - dummy 会話履歴 (今日 / 昨日 / 今週 セクション) を fixture から render
 *   - 「新しい会話」ボタン: クリックで親に `onNewConversation()` 通知 (state リセット)
 *   - 検索 input は UI 配置のみ (filter ロジックは W2 で本接続後に追加)
 *
 * Sprint 3 W2 (続 62 Infra `chat_conversations` migration 完了後):
 *   - props から fetch 結果を受け取り、real conversations を描画
 *   - 検索 input を `useDebounce` + ClickHouse query で結線
 *   - 各 item クリックで `onSelectConversation(conversationId)` を発火
 */

'use client'

import { Pin, Plus, Search } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { DummyConversationEntry } from './types'

interface ChatConversationSidebarProps {
  conversations: ReadonlyArray<DummyConversationEntry>
  activeConversationId: string | null
  onSelectConversation: (id: string) => void
  onNewConversation: () => void
  /** Sprint 3 W2 で onSearch を追加予定 (W1 は disabled) */
  isDummy?: boolean
}

function groupConversations(
  conversations: ReadonlyArray<DummyConversationEntry>,
): Map<DummyConversationEntry['group'], DummyConversationEntry[]> {
  const order: DummyConversationEntry['group'][] = ['今日', '昨日', '今週']
  const map = new Map<DummyConversationEntry['group'], DummyConversationEntry[]>()
  for (const g of order) map.set(g, [])
  for (const c of conversations) {
    map.get(c.group)?.push(c)
  }
  return map
}

export function ChatConversationSidebar({
  conversations,
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  isDummy = true,
}: ChatConversationSidebarProps) {
  const grouped = groupConversations(conversations)

  return (
    <aside
      className="flex h-full flex-col border-r border-border bg-muted/40"
      aria-label="会話履歴"
    >
      <div className="space-y-2 p-3">
        <button
          type="button"
          onClick={onNewConversation}
          className="inline-flex w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-accent"
        >
          <Plus className="h-4 w-4" aria-hidden />
          新しい会話
        </button>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3"
            aria-hidden
          />
          <input
            type="search"
            placeholder="会話を検索..."
            disabled={isDummy}
            className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-2 text-xs placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="会話を検索"
          />
        </div>
        {isDummy ? (
          <p className="font-mono text-[10px] uppercase tracking-wider text-text-3">
            W1 stub — 検索は W2 で本接続
          </p>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-1 pb-3">
        {Array.from(grouped.entries()).map(([group, items]) => {
          if (items.length === 0) return null
          return (
            <section key={group} className="mb-2">
              <div className="px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-text-3">
                {group}
              </div>
              <ul className="space-y-0.5">
                {items.map((conv) => {
                  const isActive = conv.id === activeConversationId
                  return (
                    <li key={conv.id}>
                      <button
                        type="button"
                        onClick={() => onSelectConversation(conv.id)}
                        aria-current={isActive ? 'true' : undefined}
                        className={cn(
                          'flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent',
                          isActive && 'bg-accent text-accent-foreground',
                        )}
                      >
                        <span className="flex items-center gap-1 text-xs font-medium leading-snug">
                          {conv.pinned ? (
                            <Pin className="h-3 w-3 flex-shrink-0 text-warning" aria-hidden />
                          ) : null}
                          <span className="line-clamp-1">{conv.title}</span>
                        </span>
                        <span className="font-mono text-[10px] text-text-3">
                          {conv.timeLabel} · {conv.messageCount} messages
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>

      <footer className="flex items-center gap-2 border-t border-border bg-background/60 px-3 py-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">
          H
        </div>
        <div className="flex flex-col text-xs">
          <span className="font-medium">hiroki</span>
          <span className="font-mono text-[10px] text-text-3">org_ugoki_internal</span>
        </div>
      </footer>
    </aside>
  )
}

/** Sprint 3 W1 用の dummy fixture (W2 で `/api/chat/conversations` 結果に置換) */
export function getDummyConversations(activeId: string): DummyConversationEntry[] {
  return [
    { id: activeId, title: 'トップFVのCV影響を知りたい', timeLabel: '2 min', messageCount: 4, group: '今日', isActive: true, pinned: true },
    { id: 'dummy-today-1', title: 'tirtir記事の離脱要因', timeLabel: '14:08', messageCount: 7, group: '今日' },
    { id: 'dummy-today-2', title: 'SP モバイルだけCVR下がってる', timeLabel: '11:32', messageCount: 12, group: '今日' },
    { id: 'dummy-yesterday-1', title: '比較検討ペルソナ分析', timeLabel: '5/12', messageCount: 9, group: '昨日' },
    { id: 'dummy-yesterday-2', title: 'PageSpeed × bounceの相関', timeLabel: '5/12', messageCount: 6, group: '昨日' },
    { id: 'dummy-week-1', title: 'フッター施策の効果検証', timeLabel: '5/10', messageCount: 4, group: '今週' },
    { id: 'dummy-week-2', title: 'CTAボタンの色を変えたら？', timeLabel: '5/09', messageCount: 11, group: '今週' },
    { id: 'dummy-week-3', title: 'サイト全体の健康診断お願い', timeLabel: '5/08', messageCount: 18, group: '今週' },
  ]
}
