/**
 * /scenarios — ターゲティングバナー一覧 (M-Director 続 M-5 Day 2、2026-05-25)
 *
 * Phase 1: hard-code POC_SCENARIOS を Server Component で読み込み、mockup 19 を
 * 踏襲した UI で表示。新規登録 / CRUD は Phase 2 (disabled)。
 *
 * 親 SSOT:
 *   - linkscrawl/docs/fusion/team/m-director/prd.md §5
 *   - linkscrawl/docs/fusion/mockups/19_scenarios_list.html (デザイン SSOT)
 *   - Main Director 続 83 §4 (Sidebar SSOT 承認、(proof)/layout AppShell に自動 wrap)
 *
 * tenant_id: Phase 1 は POC_SCENARIOS hard-code 内に保持 (`linkth_internal`)、
 * Phase 2 で getTenantContext() ベースの動的読込に切替予定。
 */

import { ScenariosListView } from '@/components/scenarios/scenarios-list-view'
import { POC_SCENARIOS } from '@/lib/scenarios/poc-scenario'

export const dynamic = 'force-dynamic'

export default function ScenariosListPage() {
  // Phase 1: tenant_id 固定で POC を取得 (Phase 2 で getTenantContext 経由化)
  const scenarios = POC_SCENARIOS.filter((s) => s.archived_at === null)

  return <ScenariosListView scenarios={scenarios} />
}
