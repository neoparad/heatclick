/**
 * /aiseo/contents/internal-links — 内部リンク実装 (Phase 1 skeleton、approve disabled)
 *
 * AISEO-Director SSOT:
 *   - prd.md §1.1 Contents > 内部リンク実装
 *   - integration-map.md §2 Phase 1 (file 直読み) / Phase 2 (approve flow)
 *   - decisions.md 続 AISEO-1 §4 (AISEO-5)
 *
 * Phase 2 で:
 *   - approve button → app/api/aiseo/proposals/[id]/approve POST
 *   - apply button → linkscrawl/scripts/apply_proposals 連動 (WordPress API)
 */

import { loadInternalLinkProposals } from '@/lib/aiseo/internal-link-loader'
import { InternalLinkImplementationSkeleton } from '@/components/aiseo/internal-link-implementation-skeleton'

export const dynamic = 'force-dynamic'

export default async function AiseoInternalLinkContentsPage() {
  const batch = await loadInternalLinkProposals({
    tenantId: 'linkth_internal',
    siteId: 'wakegai',
  })

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-sm font-semibold text-slate-900">
          内部リンク実装 (Contents)
        </h2>
        <p className="text-xs text-slate-500">
          Analytics で確認した提案を承認 / 拒否し、WordPress へ反映する画面。
          Phase 1 は skeleton (approve / reject ボタンは disabled)。
        </p>
      </header>
      <InternalLinkImplementationSkeleton batch={batch} />
    </section>
  )
}
