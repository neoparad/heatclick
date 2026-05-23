/**
 * Proof UI Dashboard (mockup 07_ai_feed.html を React 化)
 *
 * 親 SSOT §3.6.2 / §6.4 Sprint 1 / Part V §5.5.1 P-03 / §1.6 Evidence
 *
 * Sprint 1 = dummy data fallback。Sprint 2 (S2-01) で `/api/v1/insights/[site_id]`
 * に切替予定。dummy 状態は <DummyBanner> で常時可視化。
 */

import type { Metadata } from 'next'
import { Info } from 'lucide-react'

import { AlertList } from '@/components/dashboard/alert-list'
import { InsightFeed } from '@/components/dashboard/insight-feed'
import { KpiCard } from '@/components/dashboard/kpi-card'
import { getDummyDashboard } from '@/lib/fixtures/dashboard'

export const metadata: Metadata = {
  title: 'ダッシュボード — UGOKI MAP',
  robots: { index: false, follow: false },
}

// M-2 TODO (Reviewer T1 dual 続 10):
// Sprint 2 S2-01 着工時に searchParams で ?start_date&end_date&site_id を受信し、
// SSR で `/api/v1/insights/[site_id]` を fetch する経路に切替。Sprint 1 は全期間 dummy で OK。
export default function ProofDashboardPage() {
  const data = getDummyDashboard()

  return (
    <main className="bg-muted/30 px-6 py-6 lg:px-8 lg:py-8">
      <div className="mx-auto max-w-[1320px] space-y-5">
        <header className="space-y-2">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-3">Dashboard</p>
          <div className="flex flex-wrap items-end gap-4">
            <h1 className="text-2xl font-bold tracking-tight">
              おはようございます、hiroki さん
            </h1>
            <div className="flex items-center gap-3 text-xs text-text-2">
              <span>
                <strong className="font-semibold text-foreground">{data.siteName}</strong>{' '}
                <span className="font-mono text-text-3">{data.siteId}</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" aria-hidden />
                tracking active
              </span>
            </div>
          </div>
        </header>

        {data.isDummy ? <DummyBanner /> : null}

        <section aria-label="KPI" className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          {data.kpis.map((kpi) => (
            <KpiCard key={kpi.id} kpi={kpi} />
          ))}
        </section>

        <section className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
          <InsightFeed items={data.insights} />
          <AlertList items={data.alerts} />
        </section>
      </div>
    </main>
  )
}

function DummyBanner() {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-xs text-foreground"
    >
      <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" aria-hidden />
      <div className="space-y-1">
        <p className="font-semibold">Sprint 1 — Dummy data モード</p>
        <p className="text-text-2">
          tracking.js が本番流入を始める Sprint 2 (S2-01) 以降は実 ML データに切り替わります。
          現在表示中の KPI / Insight は固定ダミー値で、施策判断には使えません。
        </p>
      </div>
    </div>
  )
}
