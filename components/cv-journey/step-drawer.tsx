/**
 * StepDrawer — ステップ別詳細（右スライドオーバー）
 *
 * 親 SSOT §3.6.5 / docs/cv-journey-implementation-plan.md
 *
 * MVP（Phase 1）方針:
 *   - **observed metrics 限定**（到達/進行/離脱の実数 + 摩擦 rage/dead）。
 *   - 感情内訳・離脱主因（inferred）と AI 施策提案は Phase 3（D-07 準拠で後日）。
 *   - 「この離脱エリアのヒートマップを見る」で既存 /heatmap へ handoff（Gemini 案の中核）。
 */

'use client'

import Link from 'next/link'
import { X, Flame, MousePointerClick, ArrowRight } from 'lucide-react'

import { cn } from '@/lib/utils'
import { EvidenceBadge } from '@/components/dashboard/evidence-badge'
import type { CvStep } from '@/lib/api/cv-journey'

interface StepDrawerProps {
  step: CvStep | null
  siteId: string
  open: boolean
  onClose: () => void
}

function fmt(n: number): string {
  return n.toLocaleString('ja-JP')
}
function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

export function StepDrawer({ step, siteId, open, onClose }: StepDrawerProps) {
  const heatmapHref = `/heatmap?site_id=${encodeURIComponent(siteId)}`

  return (
    <div
      className={cn('fixed inset-0 z-50', open ? 'pointer-events-auto' : 'pointer-events-none')}
      aria-hidden={!open}
    >
      {/* backdrop */}
      <div
        className={cn(
          'absolute inset-0 bg-foreground/10 transition-opacity',
          open ? 'opacity-100' : 'opacity-0',
        )}
        onClick={onClose}
      />
      {/* panel */}
      <aside
        className={cn(
          'absolute right-0 top-0 bottom-0 flex w-[440px] max-w-[95vw] flex-col border-l border-border bg-background shadow-xl transition-transform duration-200',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
        role="dialog"
        aria-label="ステップ詳細"
      >
        {step ? (
          <>
            <header className="border-b border-border bg-muted/30 px-5 py-4">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-text-3">
                  step {step.index + 1} / {step.label}
                </span>
                <button
                  type="button"
                  onClick={onClose}
                  className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-text-2 hover:bg-muted"
                  aria-label="閉じる"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <h3 className="font-mono text-base font-bold text-foreground">{step.label}</h3>
                <EvidenceBadge
                  evidence={{ level: 'observed', confidence: 1, references: [] }}
                  levelV2={step.evidenceLevel}
                  compact
                />
              </div>
              <div className="mt-2 flex gap-4 font-mono text-[11px] text-text-3">
                <span>
                  到達 <b className="text-text-1">{fmt(step.reached)}</b>
                </span>
                <span>
                  進行 <b className="text-success">{fmt(step.advanced)}</b>
                </span>
                <span>
                  離脱 <b className="text-destructive">{fmt(step.dropped)} ({pct(step.dropRate)})</b>
                </span>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {/* 離脱（observed） */}
              <section className="mb-6">
                <div className="mb-2 flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-text-3">
                  <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
                  ここで離脱した {pct(step.dropRate)}
                </div>
                <div className="flex items-baseline gap-3">
                  <span className="text-2xl font-bold tracking-tight text-destructive">
                    {fmt(step.dropped)}
                  </span>
                  <span className="font-mono text-[11px] text-text-3">
                    / {fmt(step.reached)} 到達セッション
                  </span>
                </div>
              </section>

              {/* 摩擦シグナル（observed = heatmap handoff の根拠） */}
              <section className="mb-6">
                <div className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-text-3">
                  観測された摩擦シグナル
                </div>
                {step.friction ? (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-md border border-border bg-muted/20 p-3">
                      <div className="flex items-center gap-1.5 font-mono text-[10px] text-text-3">
                        <Flame className="h-3 w-3 text-destructive" /> rage_click
                      </div>
                      <div className="mt-1 font-mono text-lg font-bold text-foreground">
                        {fmt(step.friction.rageClicks)}
                      </div>
                    </div>
                    <div className="rounded-md border border-border bg-muted/20 p-3">
                      <div className="flex items-center gap-1.5 font-mono text-[10px] text-text-3">
                        <MousePointerClick className="h-3 w-3 text-amber-600" /> dead_click
                      </div>
                      <div className="mt-1 font-mono text-lg font-bold text-foreground">
                        {fmt(step.friction.deadClicks)}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="font-mono text-[11px] text-text-3">
                    このステップは path 指定が無いため摩擦集計対象外です。
                  </p>
                )}
              </section>

              {/* Phase 3 予告（D-07: inferred は MVP では出さない） */}
              <section className="rounded-md border border-dashed border-border bg-muted/20 p-3">
                <p className="font-mono text-[11px] text-text-3">
                  感情内訳・離脱主因の推定（inferred）と AI 施策提案は Phase 3 で追加予定です。
                  MVP は誤誘導を避けるため観測値のみ表示しています（D-07）。
                </p>
              </section>
            </div>

            <footer className="border-t border-border bg-muted/30 px-5 py-3">
              <Link
                href={heatmapHref}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-brand-gradient px-4 py-2 text-sm font-medium text-white shadow-sm"
              >
                この離脱エリアのヒートマップを見る
                <ArrowRight className="h-4 w-4" />
              </Link>
            </footer>
          </>
        ) : null}
      </aside>
    </div>
  )
}
