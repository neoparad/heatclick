/**
 * Alert List — Dashboard 右側の「今日のアラート」
 *
 * 親 SSOT Part V §5.5.1 P-03 / mockups/07_ai_feed.html (alert-list)
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { AlertItem } from '@/lib/fixtures/dashboard'

interface AlertListProps {
  items: AlertItem[]
}

const SEVERITY_BAR: Record<AlertItem['severity'], string> = {
  warn: 'bg-destructive',
  info: 'bg-primary',
  good: 'bg-success',
}

export function AlertList({ items }: AlertListProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between border-b border-border py-4">
        <div className="flex items-center gap-2">
          <CardTitle>今日のアラート</CardTitle>
          <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-text-3">
            {items.length}
          </span>
        </div>
        <button
          type="button"
          className="font-mono text-[11px] text-primary hover:underline"
        >
          通知設定 →
        </button>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-border" role="list">
          {items.map((alert) => (
            <li
              key={alert.id}
              className="grid grid-cols-[6px_1fr_auto] items-center gap-3 px-5 py-3"
            >
              <span
                aria-hidden
                className={cn('h-7 w-1 rounded-full', SEVERITY_BAR[alert.severity])}
              />
              <div className="min-w-0">
                <p className="text-xs font-medium leading-snug text-foreground">{alert.title}</p>
                <p className="mt-0.5 font-mono text-[10px] text-text-3">{alert.detail}</p>
              </div>
              <span className="whitespace-nowrap font-mono text-[10px] text-text-3">
                {alert.timestamp}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
