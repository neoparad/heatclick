/**
 * P-AI Chat page — UGOKIMAP AI チャット (mockup 10_ai_chat.html を React 化)
 *
 * 親 SSOT §3.6.2 / §6.4 Sprint 3 W1 / Part V P-AI / D-07
 * 配備: 続 60 §7 / 続 63 (Sprint 3 W1 base) / 続 72 (middleware + draft fix)
 * 改修: 続 73 (Frontend mockup 再現) — (proof)/layout の AppShell に統合、
 *       重複していた `<main>` + page header を撤去、stub 注記は ConversationPane
 *       内のヘッダーに移管 (mockup の `.ai-conv-top` に同等)。
 *
 * Server Component スコープ (本ファイル):
 *   - metadata (title / robots)
 *   - searchParams.site_id 既定値の選定
 *   - Client orchestrator `<ChatConversationPane>` への props 受け渡し
 */

import type { Metadata } from 'next'

import { ChatConversationPane } from '@/components/chat'
import { PageMeta } from '@/components/layout/page-meta'

export const metadata: Metadata = {
  title: 'UGOKIMAP AI — UGOKI MAP',
  robots: { index: false, follow: false },
}

interface ChatPageProps {
  searchParams: { site_id?: string; period_days?: string }
}

/** Sprint 3 W1 default: bihadashop.jp (続 56 heatmap 既定と同一)。 */
const DEFAULT_SITE_ID = 'CIP_EcwUTHEZdIOAUqum'

function parsePeriodDays(raw: string | undefined): number {
  if (!raw) return 7
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n)) return 7
  return Math.min(Math.max(n, 1), 90)
}

export default function ChatPage({ searchParams }: ChatPageProps) {
  const siteId = searchParams.site_id ?? DEFAULT_SITE_ID
  const periodDays = parsePeriodDays(searchParams.period_days)

  return (
    <>
      <PageMeta title="UGOKIMAP AI" eyebrow="AI Chat · 行動分析" />
      <ChatConversationPane
        siteId={siteId}
        initialPeriodDays={periodDays}
        apiMode="stub"
      />
    </>
  )
}
