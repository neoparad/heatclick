/**
 * /aiseo/analytics/internal-links — 内部リンク診断 (Phase 1 read-only viewer)
 *
 * AISEO-Director SSOT:
 *   - prd.md §1.1 Analytics > 内部リンク診断
 *   - integration-map.md §2 Phase 1 (file 直読み)
 *   - decisions.md 続 AISEO-1 §4 (AISEO-4) / §5 (fixture mode 判断)
 *
 * Phase 1 dogfood: tenant_id=linkth_internal、site_id=wakegai。
 * LINKSCRAWL_DATA_ROOT 設定 + proposals_*.json 存在で実 data、それ以外は fixture stub。
 */

import { loadInternalLinkProposals } from '@/lib/aiseo/internal-link-loader'
import { InternalLinkAnalyticsTable } from '@/components/aiseo/internal-link-analytics-table'

export const dynamic = 'force-dynamic'

export default async function AiseoInternalLinkAnalyticsPage() {
  const batch = await loadInternalLinkProposals({
    tenantId: 'linkth_internal',
    siteId: 'wakegai',
  })

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-sm font-semibold text-slate-900">
          内部リンク診断 (Analytics)
        </h2>
        <p className="text-xs text-slate-500">
          linkscrawl <code className="font-mono">internal_link_agent.py</code> の最新提案を表示
          (read-only)。anchor / target / confidence の妥当性を確認したら Contents タブで
          実装フローへ。
        </p>
      </header>
      <InternalLinkAnalyticsTable batch={batch} />
    </section>
  )
}
