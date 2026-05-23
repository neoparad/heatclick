/**
 * P-04 Heatmap page
 *
 * 親 SSOT §3.6.5 / §6.4 Sprint 1 / Part V §5.5.1 P-04 / mockup 01_heatmap_canvas.html
 *
 * heatmap.js は SSR で window 未定義になるため dynamic({ ssr: false })。
 * 認証 / tenant 検証は middleware.ts で済んでいる前提。
 */

import type { Metadata } from 'next'
import dynamic from 'next/dynamic'

const HeatmapPageClient = dynamic(
  () => import('@/components/heatmap/heatmap-page').then((m) => m.HeatmapPage),
  { ssr: false },
)

export const metadata: Metadata = {
  title: 'ヒートマップ — UGOKI MAP',
  robots: { index: false, follow: false },
}

// Sprint 1 ではページ一覧は固定。Sprint 2 で /api/pages?site_id から動的取得。
const DEMO_PAGES = [
  { url: 'https://bihadashop.jp/', label: 'トップ' },
  { url: 'https://bihadashop.jp/tirtir-cushion-foundation/', label: '商品: TIRTIR クッション' },
  { url: 'https://bihadashop.jp/column/acne/', label: 'コラム: ニキビ治療' },
] as const

interface HeatmapPageProps {
  searchParams: { site_id?: string; page_url?: string }
}

export default function ProofHeatmapPage({ searchParams }: HeatmapPageProps) {
  const siteId = searchParams.site_id ?? 'site_bihada_demo'
  const initialPageUrl = searchParams.page_url ?? DEMO_PAGES[0].url

  return (
    <main className="bg-muted/30 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mx-auto max-w-[1320px] space-y-4">
        <header className="space-y-1">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-3">
            Behavior · Heatmap
          </p>
          <h1 className="text-2xl font-bold tracking-tight">ヒートマップ</h1>
          <p className="text-sm text-text-2">
            クリック / ムーブ / 感情 / 摩擦 の 4 レイヤーで 30,000px 超の長いページにも対応します。
          </p>
        </header>

        <HeatmapPageClient
          siteId={siteId}
          initialPageUrl={initialPageUrl}
          pageOptions={DEMO_PAGES.map((p) => ({ url: p.url, label: p.label }))}
        />
      </div>
    </main>
  )
}
