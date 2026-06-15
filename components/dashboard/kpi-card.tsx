/**
 * KPI Card — Dashboard 上部 KPI strip 1 枚
 *
 * 親 SSOT §1.6 / Part V §5.5.1 P-03 / mockups/07_ai_feed.html (KPI strip)
 *
 * - default variant = panel + 細枠 + sparkline
 * - highlight variant = brand gradient (1 アクセント原則: 1 strip につき 1 枚のみ)
 */

import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { KpiCard as KpiCardData } from '@/lib/fixtures/dashboard'
import { EvidenceBadge } from './evidence-badge'

interface KpiCardProps {
  kpi: KpiCardData
}

export function KpiCard({ kpi }: KpiCardProps) {
  const highlight = Boolean(kpi.highlight)
  const deltaSign = kpi.delta == null ? 0 : Math.sign(kpi.delta)
  const DeltaIcon = deltaSign > 0 ? ArrowUpRight : deltaSign < 0 ? ArrowDownRight : Minus
  const deltaColor = highlight
    ? 'text-white/90'
    : deltaSign > 0
      ? 'text-success'
      : deltaSign < 0
        ? 'text-destructive'
        : 'text-text-2'

  return (
    <Card
      className={cn(
        'relative overflow-hidden p-4',
        highlight && 'border-transparent bg-brand-gradient text-white shadow-md',
      )}
      data-testid={`kpi-card-${kpi.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p
          className={cn(
            'font-mono text-[10px] font-semibold uppercase tracking-[0.08em]',
            highlight ? 'text-white/80' : 'text-text-3',
          )}
        >
          {kpi.label}
        </p>
        <EvidenceBadge
          evidence={kpi.evidence}
          compact
          className={highlight ? 'border-white/30 bg-white/10 text-white' : ''}
        />
      </div>

      <div className="mt-2 flex items-baseline gap-1">
        <span
          className={cn(
            'text-2xl font-bold tracking-tight',
            highlight ? 'text-white' : 'text-foreground',
          )}
        >
          {kpi.value}
        </span>
        {kpi.unit ? (
          <span className={cn('text-xs', highlight ? 'text-white/80' : 'text-text-3')}>
            {kpi.unit}
          </span>
        ) : null}
      </div>

      <div
        className={cn(
          'mt-3 flex items-center justify-between border-t pt-2 text-xs',
          highlight ? 'border-white/20' : 'border-border',
        )}
      >
        <span className={cn('inline-flex items-center gap-1 font-mono', deltaColor)}>
          <DeltaIcon className="h-3 w-3" aria-hidden />
          {kpi.delta != null ? (
            <>
              {kpi.delta > 0 ? '+' : ''}
              {kpi.delta}
              {kpi.deltaLabel ? ` ${kpi.deltaLabel}` : ''}
            </>
          ) : (
            <span className="opacity-80">{kpi.deltaLabel ?? '—'}</span>
          )}
        </span>

        {kpi.spark && kpi.spark.length > 1 ? (
          <Sparkline points={kpi.spark} positive={deltaSign >= 0} highlight={highlight} />
        ) : null}
      </div>
    </Card>
  )
}

function Sparkline({
  points,
  positive,
  highlight,
}: {
  points: number[]
  positive: boolean
  highlight: boolean
}) {
  const width = 72
  const height = 22
  const max = Math.max(...points)
  const min = Math.min(...points)
  const range = max - min || 1
  const step = width / (points.length - 1)
  const path = points
    .map((p, i) => {
      const x = i * step
      const y = height - ((p - min) / range) * height
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  const stroke = highlight
    ? 'rgba(255,255,255,0.85)'
    : positive
      ? 'hsl(var(--success))'
      : 'hsl(var(--destructive))'

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
