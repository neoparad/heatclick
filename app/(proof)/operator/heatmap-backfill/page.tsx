/**
 * Operator 専用: ヒートマップ スクショ事前生成 (バックフィル)
 *
 * docs/heatmap/CAPTURE_STRATEGY_DECISION_2026-08-08.md §5 の実行手段。
 * Workers Paid 化 (2026-08-08 実施済) の browser hours 枠 (月10h) 内で、
 * 既存ページ全件 × 3デバイスを1回ずつ事前撮影し R2 キャッシュを温める。
 *
 * 実装方針: 新しい認証基盤を作らない。既存の `/api/heatmap/screenshot` を
 * ブラウザから (= オペレータの既存ログイン Cookie で) 順次叩くだけ
 * (認証調査の結論: production の JWT_SECRET は Vercel Sensitive 指定で
 * 外部から読めないため、スクリプト用トークンの新規発行はしない)。
 *
 * ナビには載せない (owner/admin のみ、直接 URL アクセス)。
 */

import { redirect } from 'next/navigation'

import { getServerSession } from '@/lib/auth/server-session'
import { fetchPagesUncached, type PageOption } from '@/lib/pages/fetch-pages'
import { PageMeta } from '@/components/layout/page-meta'
import { HeatmapBackfillRunner } from '@/components/operator/heatmap-backfill-runner'

/** 5 sites (続 39) の既定値 (bihadashop.jp)。/heatmap page.tsx と同じ既定。 */
const DEFAULT_SITE_ID = 'CIP_EcwUTHEZdIOAUqum'

/** sitemap 実測 183 URL (docs/heatmap/PLAN_C_FEASIBILITY_VERDICT_2026-08-08.md) に余裕を持たせた上限。 */
const MAX_PAGES = 400

interface OperatorBackfillPageProps {
  searchParams: { site_id?: string }
}

export default async function OperatorHeatmapBackfillPage({
  searchParams,
}: OperatorBackfillPageProps) {
  const session = await getServerSession()
  if (!session) redirect('/auth/sign-in?redirect=/operator/heatmap-backfill')
  // 実撮影を大量発生させる操作のため owner/admin のみ (lib/scenarios/publish-rbac.ts の
  // PUBLISH_ROLES と同じ絞り込み方針)。
  if (session.role !== 'owner' && session.role !== 'admin') redirect('/heatmap')

  const siteId = searchParams.site_id ?? DEFAULT_SITE_ID
  if (!session.user.site_ids.includes(siteId)) redirect('/heatmap')

  let pages: PageOption[] = []
  try {
    pages = await fetchPagesUncached(session.tenant_id, siteId, MAX_PAGES)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown'
    console.error(`[operator/heatmap-backfill] fetchPages failed: ${msg}`)
  }

  return (
    <div className="ug-page-scroll">
      <div className="ug-page-inner space-y-4">
        <PageMeta
          title="ヒートマップ スクショ 事前生成"
          eyebrow="Operator · Heatmap Backfill"
        />
        <div className="rounded-md border border-[color:var(--ug-border)] bg-[color:var(--ug-panel)] px-4 py-3 text-sm text-[color:var(--ug-text-2)]">
          既存の <code>/api/heatmap/screenshot</code>{' '}
          を、このブラウザのログインセッションでページ×デバイスの組み合わせ分だけ順次呼び出します。新しい認証やサーバー側バッチは作りません。タブを閉じると途中で止まります(再開は最初から
          — 既に <code>r2-fresh</code> のものは1秒未満で完了するため実害は小さいです)。
        </div>
        <HeatmapBackfillRunner siteId={siteId} pages={pages} />
      </div>
    </div>
  )
}
