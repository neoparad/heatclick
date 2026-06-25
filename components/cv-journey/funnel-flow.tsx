/**
 * FunnelFlow — 固定列ファネル（データ駆動 SVG/HTML hybrid）
 *
 * 親 SSOT §3.6.5 / docs/cv-journey-implementation-plan.md
 *
 * council 合意: モックの自由 Sankey を直訳せず、読める「固定列ファネル」にする。
 *   - 各ステップ = 高さがセッション数に比例するバー（max を step0 基準に正規化）
 *   - ステップ間の「離脱エリア」を主役にし、クリックでドロワーを開く（Gemini 案）
 *   - 流入メディアは左の step0 列（UGOKY ONLY 訴求）
 */

'use client'

import { ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { CvJourneyData, CvStep } from '@/lib/api/cv-journey'

interface FunnelFlowProps {
  data: CvJourneyData
  selectedStep: number | null
  onSelectStep: (index: number) => void
  className?: string
}

const KIND_ACCENT: Record<CvStep['kind'], string> = {
  source: 'bg-muted',
  page: 'bg-sky-500/70',
  action: 'bg-violet-500/70',
  conversion: 'bg-emerald-500/80',
  dropoff: 'bg-destructive/60',
}

function fmt(n: number): string {
  return n.toLocaleString('ja-JP')
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

export function FunnelFlow({ data, selectedStep, onSelectStep, className }: FunnelFlowProps) {
  const { steps, sources } = data
  const maxReached = steps.length > 0 ? Math.max(...steps.map((s) => s.reached), 1) : 1
  const sourceTotal = sources.reduce((s, x) => s + x.sessions, 0)

  return (
    <div className={cn('overflow-x-auto', className)}>
      <div className="flex min-w-[920px] items-stretch gap-2 py-2">
        {/* step0: 流入メディア */}
        {sources.length > 0 ? (
          <div className="flex w-[200px] shrink-0 flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-brand-1">
                流入メディア
              </span>
              <span className="rounded bg-brand-gradient px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase text-white">
                UGOKY ONLY
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {sources.map((src) => (
                <div
                  key={src.key}
                  className="flex items-center justify-between rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                  title={`${src.label} — ${fmt(src.sessions)} sessions`}
                >
                  <span className="truncate font-mono text-[11px] text-foreground">{src.label}</span>
                  <span className="ml-2 shrink-0 font-mono text-[11px] font-bold text-text-2">
                    {sourceTotal > 0 ? pct(src.sessions / sourceTotal) : '—'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* steps + gaps */}
        {steps.map((step, i) => {
          const heightPct = Math.max(8, (step.reached / maxReached) * 100)
          const isLast = i === steps.length - 1
          const active = selectedStep === step.index
          return (
            <div key={step.index} className="flex items-stretch gap-2">
              {/* step column */}
              <button
                type="button"
                onClick={() => onSelectStep(step.index)}
                aria-pressed={active}
                className={cn(
                  'flex w-[150px] shrink-0 flex-col rounded-md border bg-background p-2 text-left transition',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'border-brand-1 ring-2 ring-brand-1/30' : 'border-border hover:border-brand-1/60',
                )}
                data-testid={`funnel-step-${step.index}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] font-semibold text-foreground">{step.label}</span>
                  <span className="font-mono text-[9px] text-text-3">#{step.index + 1}</span>
                </div>
                <div className="mt-1 font-mono text-base font-bold text-foreground">{fmt(step.reached)}</div>

                {/* proportional bar */}
                <div className="mt-2 flex h-20 items-end">
                  <div className="flex w-full items-end gap-1">
                    <div
                      className={cn('w-full rounded-sm', KIND_ACCENT[step.kind])}
                      style={{ height: `${heightPct}%` }}
                      aria-hidden
                    />
                  </div>
                </div>

                {!isLast ? (
                  <div className="mt-2 flex items-center justify-between border-t border-border pt-1.5 font-mono text-[10px]">
                    <span className="text-success">進 {pct(step.advanceRate)}</span>
                    <span className="text-destructive">離 {pct(step.dropRate)}</span>
                  </div>
                ) : (
                  <div className="mt-2 border-t border-border pt-1.5 font-mono text-[10px] text-emerald-600">
                    CV {fmt(step.reached)}
                  </div>
                )}
              </button>

              {/* gap (離脱エリア) — clickable, 主役 */}
              {!isLast ? (
                <button
                  type="button"
                  onClick={() => onSelectStep(step.index)}
                  className="group flex w-[64px] shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border bg-muted/30 px-1 transition hover:border-destructive/50 hover:bg-destructive/5"
                  title={`${step.label} → 次ステップ: 離脱 ${fmt(step.dropped)} (${pct(step.dropRate)})`}
                  data-testid={`funnel-gap-${step.index}`}
                >
                  <ChevronRight className="h-4 w-4 text-text-3 group-hover:text-destructive" aria-hidden />
                  <span className="font-mono text-[10px] font-bold text-destructive">
                    -{pct(step.dropRate)}
                  </span>
                  {step.friction && step.friction.rageClicks + step.friction.deadClicks > 0 ? (
                    <span className="font-mono text-[8px] text-text-3" title="摩擦シグナル">
                      🔥{step.friction.rageClicks}
                    </span>
                  ) : null}
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
