/**
 * Insight Feed — AI が見つけた気づきのリスト
 *
 * 親 SSOT §1.6 / Part V §5.5.1 P-03 / mockups/07_ai_feed.html (feed-item)
 */

import { AlertTriangle, Sparkles, CheckCircle2, UserRound, Zap } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { InsightCategory, InsightItem } from '@/lib/fixtures/dashboard'
import { cn } from '@/lib/utils'
import { EvidenceBadge } from './evidence-badge'

interface InsightFeedProps {
  items: InsightItem[]
}

const CATEGORY_ICONS: Record<InsightCategory, { Icon: typeof AlertTriangle; toneClass: string }> = {
  alert: {
    Icon: AlertTriangle,
    toneClass: 'border-destructive/30 bg-destructive/10 text-destructive',
  },
  pattern: {
    Icon: Sparkles,
    toneClass: 'border-transparent bg-brand-gradient text-white',
  },
  win: {
    Icon: CheckCircle2,
    toneClass: 'border-success/30 bg-success/10 text-success',
  },
  persona: {
    Icon: UserRound,
    toneClass: 'border-border bg-muted text-text-1',
  },
  speed: {
    Icon: Zap,
    toneClass: 'border-warning/30 bg-warning/10 text-warning',
  },
}

export function InsightFeed({ items }: InsightFeedProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 border-b border-border py-4">
        <div className="flex items-center gap-2">
          <CardTitle>AI が見つけた今日の気づき</CardTitle>
          <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-text-3">
            {items.length} new
          </span>
        </div>
        <button
          type="button"
          className="font-mono text-[11px] text-primary hover:underline"
          aria-label="すべての気づきを表示"
        >
          すべて表示 →
        </button>
      </CardHeader>

      <CardContent className="p-0">
        <ul className="divide-y divide-border" role="list">
          {items.map((item) => (
            <InsightRow key={item.id} item={item} />
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function InsightRow({ item }: { item: InsightItem }) {
  const meta = CATEGORY_ICONS[item.category]
  const Icon = meta.Icon

  return (
    <li className="grid grid-cols-[28px_1fr_auto] items-start gap-3 px-5 py-4 transition-colors hover:bg-muted/30">
      <span
        aria-hidden
        className={cn(
          'inline-flex h-7 w-7 items-center justify-center rounded-md border',
          meta.toneClass,
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>

      <div className="min-w-0">
        <p className="mb-1 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.06em] text-text-3">
          <span>{item.meta}</span>
          <EvidenceBadge evidence={item.evidence} compact />
          {item.proposalRef ? (
            <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-text-2">
              {item.proposalRef}
            </span>
          ) : null}
        </p>
        <p className="text-sm font-semibold leading-snug text-foreground">{item.title}</p>
        <p className="mt-1 text-xs leading-relaxed text-text-2">{item.description}</p>
      </div>

      <time
        className="whitespace-nowrap font-mono text-[10px] text-text-3"
        dateTime={item.timestamp}
      >
        {formatRelative(item.timestamp)}
      </time>
    </li>
  )
}

function formatRelative(iso: string): string {
  const now = Date.now()
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return '—'
  const diffSec = Math.max(0, Math.floor((now - then) / 1000))
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} h ago`
  return `${Math.floor(diffSec / 86400)} d ago`
}
