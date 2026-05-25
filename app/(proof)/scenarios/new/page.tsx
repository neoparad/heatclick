/**
 * /scenarios/new — 新規シナリオ作成 skeleton (M-Director 続 M-6 §C、2026-05-25)
 *
 * Phase 1 は CRUD なしのため、本 page は Phase 2 disclaimer + form skeleton のみ。
 * 「新規バナー」ボタン経由で到達。Phase 2 で react-hook-form + Zod + /api/scenarios POST 統合予定。
 *
 * 親 SSOT: linkscrawl/docs/fusion/team/m-director/prd.md §6 (Phase 2 機能要件)
 */

import { ScenarioNewSkeleton } from '@/components/scenarios/scenario-new-skeleton'

export const dynamic = 'force-dynamic'

export default function ScenarioNewPage() {
  return <ScenarioNewSkeleton />
}
