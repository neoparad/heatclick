/**
 * Proof UI Dashboard (mockup 07_ai_feed.html を React 化)
 *
 * 親 SSOT §3.6.2 / §6.4 Sprint 1 / Part V §5.5.1 P-03 / §1.6 Evidence
 * 改修: 続 73 (Frontend mockup 再現) — (proof)/layout AppShell 統合、
 *       page-level wrapper を `.ug-page-scroll` + `.ug-page-inner` に置換、
 *       header を mockup `.pi-head` 相当の `.ug-page-head` に置換。
 *       既存 dashboard component (KpiCard / InsightFeed / AlertList) の logic は不変。
 *
 * Sprint 1 = dummy data fallback。Sprint 2 (S2-01) で `/api/v1/insights/[site_id]`
 * に切替予定。dummy 状態は <DummyBanner> で常時可視化。
 */

import type { Metadata } from 'next'
import { Info } from 'lucide-react'

import { AlertList } from '@/components/dashboard/alert-list'
import { InsightFeed } from '@/components/dashboard/insight-feed'
import { KpiCard } from '@/components/dashboard/kpi-card'
import { PageMeta } from '@/components/layout/page-meta'
import { getDummyDashboard } from '@/lib/fixtures/dashboard'

export const metadata: Metadata = {
  title: 'ダッシュボード — UGOKI MAP',
  robots: { index: false, follow: false },
}

export default function ProofDashboardPage() {
  const data = getDummyDashboard()

  return (
    <div className="ug-page-scroll">
      <div className="ug-page-inner space-y-4">
        {/* 続 75 Task A: title は topbar に集約、in-body header は sub 行のみ残す */}
        <PageMeta title="おはようございます、hiroki さん" eyebrow="Dashboard · 行動分析" />
        <header className="ug-page-head">
          <div className="sub">
            <span>
              <strong className="font-semibold text-[color:var(--ug-text)]">{data.siteName}</strong>{' '}
              <span className="mono">{data.siteId}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--ug-green)]" aria-hidden />
              tracking active
            </span>
          </div>
        </header>

        {data.isDummy ? <DummyBanner /> : null}

        <section
          aria-label="KPI"
          className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5"
        >
          {data.kpis.map((kpi) => (
            <KpiCard key={kpi.id} kpi={kpi} />
          ))}
        </section>

        <section className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
          <InsightFeed items={data.insights} />
          <AlertList items={data.alerts} />
        </section>
      </div>
    </div>
  )
}

function DummyBanner() {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-md border border-[color:var(--ug-yellow)]/30 bg-[color:var(--ug-yellow)]/10 px-4 py-3 text-xs text-foreground"
    >
      <Info
        className="mt-0.5 h-4 w-4 flex-shrink-0 text-[color:var(--ug-yellow)]"
        aria-hidden
      />
      <div className="space-y-1">
        <p className="font-semibold">Sprint 1 — Dummy data モード</p>
        <p className="text-[color:var(--ug-text-2)]">
          tracking.js が本番流入を始める Sprint 2 (S2-01) 以降は実 ML データに切り替わります。
          現在表示中の KPI / Insight は固定ダミー値で、施策判断には使えません。
        </p>
      </div>
    </div>
  )
}
