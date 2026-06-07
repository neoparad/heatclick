/**
 * /scenarios/new — 新規シナリオ作成 Phase 2 partial (M-Director、2026-06-07)
 *
 * Server component で middleware 注入 `x-site-ids` を読み、client view に渡す。
 * 条件 (NL→AST + Visual Builder + dry-run preview) は実機能、バリアント + 保存は Phase 2.1。
 *
 * 親 SSOT: linkscrawl/docs/fusion/team/m-director/prd.md §6 (Phase 2 機能要件)
 */

import { headers } from 'next/headers'

import { ScenarioNewView } from '@/components/scenarios/scenario-new-view'

export const dynamic = 'force-dynamic'

export default async function ScenarioNewPage() {
  const h = await headers()
  const raw = h.get('x-site-ids') ?? ''
  const availableSiteIds = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  return <ScenarioNewView availableSiteIds={availableSiteIds} />
}
