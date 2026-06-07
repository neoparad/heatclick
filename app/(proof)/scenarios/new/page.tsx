/**
 * /scenarios/new — 新規シナリオ作成 Phase 2 partial (M-Director、2026-06-07)
 *
 * 条件 (NL→AST + Visual Builder) は実機能、バリアント + 保存は Phase 2.1 で配備。
 * 旧 ScenarioNewSkeleton は components/scenarios/ に残置 (削除はしない、参照用)。
 *
 * 親 SSOT: linkscrawl/docs/fusion/team/m-director/prd.md §6 (Phase 2 機能要件)
 */

import { ScenarioNewView } from '@/components/scenarios/scenario-new-view'

export const dynamic = 'force-dynamic'

export default function ScenarioNewPage() {
  return <ScenarioNewView />
}
