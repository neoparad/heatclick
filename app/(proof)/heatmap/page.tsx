/**
 * P-04 Heatmap page
 *
 * 親 SSOT §3.6.5 / §6.4 Sprint 1 / Part V §5.5.1 P-04 / mockup 01_heatmap_canvas.html
 * Sprint 3 W1 (続 56): `/api/pages?site_id=<id>` で動的取得に切替 (DEMO_PAGES 撤去)。
 * 改修: 続 73 (Frontend mockup 再現) — (proof)/layout AppShell 統合、
 *       wrapper を `.ug-page-scroll` + `.ug-page-inner` に置換。
 *       既存 HeatmapPage component (layer toggle / canvas / hotspot detail) の logic は不変。
 *
 * heatmap.js は SSR で window 未定義になるため dynamic({ ssr: false })。
 * 認証 / tenant 検証は middleware.ts で済んでいる前提。
 */

import type { Metadata } from 'next'
import dynamic from 'next/dynamic'

import { getServerSession } from '@/lib/auth/server-session'
import { fetchPagesCached, type PageOption } from '@/lib/pages/fetch-pages'
import { coldStartInfo, region } from '@/lib/perf/server-timing'
import { PageMeta } from '@/components/layout/page-meta'

const HeatmapPageClient = dynamic(
  () => import('@/components/heatmap/heatmap-page').then((m) => m.HeatmapPage),
  { ssr: false },
)

export const metadata: Metadata = {
  title: 'ヒートマップ — UGOKI MAP',
  robots: { index: false, follow: false },
}

interface HeatmapPageProps {
  searchParams: { site_id?: string; page_url?: string }
}

/** 5 sites (続 39) の既定値 (bihadashop.jp)。 */
const DEFAULT_SITE_ID = 'CIP_EcwUTHEZdIOAUqum'

/**
 * P0 計測 (docs/heatmap/SONNET_PROMPT_P0_instrumentation_2026-07-19.md §3.5)。
 * Server Component はレスポンスヘッダを設定できないため Server-Timing は使わない。
 * 代わりに fetchPages の所要時間を performance.now() で挟み、構造化 1 行 JSON を
 * console.info で出す (Vercel function ログで見る)。`coldStartInfo()`/`region()` は
 * Node/route-handler 専有の API を使わない (performance.now() と process.env のみ) ため
 * lib/perf/server-timing.ts の実装をそのまま import して使う (route 側と同じモジュール
 * スコープ判定ロジックを共有 — Next.js は page/route を別 function bundle にするため、
 * このモジュールの `invoked` フラグはこの bundle 内で独立して機能する)。
 * 計測が失敗してもレスポンス内容・ステータスは変えない (絶対条件1) — try/catch で
 * ログ出力だけを握りつぶす。
 */

/**
 * fetchPagesCached (lib/pages/fetch-pages.ts) は unstable_cache (5 分 revalidate) で
 * ラップされているが、呼び出し側に cache hit/miss を返さない。このファイルだけを編集する
 * スコープでは判別する術がないため、所要時間からの推定に留める
 * (§3.5 「5分cacheにhitしたか判別可能なら」— 確定判定ではなくヒューリスティックである点に注意)。
 */
const CACHE_HIT_HEURISTIC_THRESHOLD_MS = 20

/**
 * 続122: 旧実装は `${NEXT_PUBLIC_APP_URL}/api/pages` への **HTTP 自己 fetch** だった。
 * Vercel 関数 → alias → 自分自身という外回り往復は、デプロイ直後の alias 切替や
 * cookie 転送に弱く、失敗すると catch → [] → 「イベントがまだ集まっていません」の
 * **誤バナー**になる (Owner 報告: API 直叩きは success なのにページ表示が空)。
 * 共有クエリ (lib/pages/fetch-pages) を in-process で直接呼ぶ構成に変更 (往復ゼロ・高速化)。
 * 認可は getServerSession (JWT 検証 + Layer 2 失効照合) + site_ids 包含チェックで同等を維持。
 */
async function fetchPages(siteId: string): Promise<PageOption[]> {
  try {
    const session = await getServerSession()
    if (!session) return [] // middleware が先に弾くが defense-in-depth
    if (!session.user.site_ids.includes(siteId)) return [] // cross-tenant site 指定は空扱い
    return await fetchPagesCached(session.tenant_id, siteId, 20)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown'
    console.error(`[heatmap/page] fetchPages failed: ${msg}`)
    return []
  }
}

export default async function ProofHeatmapPage({ searchParams }: HeatmapPageProps) {
  const siteId = searchParams.site_id ?? DEFAULT_SITE_ID

  // P0 計測: cold は「このモジュールロード後の最初の呼び出しか」で判定 (§3.5 参照)。
  const { cold } = coldStartInfo()

  const ssrPagesStart = performance.now()
  const pages = await fetchPages(siteId)
  const ssrPagesDurMs = performance.now() - ssrPagesStart

  try {
    // eslint-disable-next-line no-console -- perf 計測専用ログ (§3.5)。console.log は禁止だが console.info は許容
    console.info(
      JSON.stringify({
        perf: 'heatmap-ssr',
        span: 'pages',
        durMs: Math.round(ssrPagesDurMs * 100) / 100,
        cold,
        region: region(),
        // ヒューリスティック判定 (正確な cache hit/miss はこのファイル単体からは不明。上の注記参照)
        cacheHit: ssrPagesDurMs < CACHE_HIT_HEURISTIC_THRESHOLD_MS,
      }),
    )
  } catch {
    // 計測ログの失敗はレスポンスに一切影響させない (絶対条件1)
  }

  const initialPageUrl = searchParams.page_url ?? pages[0]?.url ?? ''

  return (
    <div className="ug-page-scroll">
      <div className="ug-page-inner space-y-4">
        {/* 続 75 Task A: title は topbar に集約 */}
        {/* 続 83 §② Owner feedback: 補足説明 paragraph を削除して main canvas の視認性向上 */}
        <PageMeta title="ヒートマップ" eyebrow="Behavior · Heatmap" />

        {pages.length === 0 ? (
          <div className="rounded-md border border-[color:var(--ug-border)] bg-[color:var(--ug-panel)] px-4 py-6 text-sm text-[color:var(--ug-text-2)]">
            このサイトには過去 7 日間のイベントがまだ集まっていません。
            タグ設置を確認するか、別のサイトを選択してください。
          </div>
        ) : (
          <HeatmapPageClient
            siteId={siteId}
            initialPageUrl={initialPageUrl}
            pageOptions={pages}
          />
        )}
      </div>
    </div>
  )
}
