/**
 * /scenarios/[id] — ターゲティングバナー編集 (M-Director 続 M-5 Day 2、2026-05-25)
 *
 * Phase 1: read-only 表示 + Visual Builder / A/B/C tab / 画像/HTML editor の skeleton。
 * Save は disabled (CRUD は Phase 2)。
 *
 * 親 SSOT:
 *   - linkscrawl/docs/fusion/team/m-director/dsl-spec.md (条件 AST + Visual Builder)
 *   - linkscrawl/docs/fusion/mockups/20_scenarios_editor.html (デザイン SSOT)
 *
 * tenant_id: Phase 1 = hard-code POC で固定。
 * id mismatch (URL の [id] が POC 内に存在しない) は notFound() で 404 を返す。
 */

import { notFound } from 'next/navigation'

import { ScenarioEditorView } from '@/components/scenarios/scenario-editor-view'
import { POC_SCENARIOS } from '@/lib/scenarios/poc-scenario'

interface PageProps {
  params: { id: string }
}

export const dynamic = 'force-dynamic'

export default function ScenarioEditorPage({ params }: PageProps) {
  const scenario = POC_SCENARIOS.find((s) => s.id === params.id)
  if (!scenario || scenario.archived_at !== null) {
    notFound()
  }

  return <ScenarioEditorView scenario={scenario} />
}
