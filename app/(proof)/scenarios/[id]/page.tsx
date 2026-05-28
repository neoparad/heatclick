/**
 * /scenarios/[id] — ターゲティングバナー編集 (M-Director Stage 2、続 M-9 / 2026-05-28)
 *
 * Phase 2 で変更:
 *   - Server Component で repository.getScenario() を呼び KV から読み込み
 *   - KV に存在しない場合は POC_SCENARIOS (in-memory hard-code) を fallback として使用
 *   - 編集 + 保存は ScenarioEditorView (Client Component) + useScenarioEditor hook で実装
 *   - 初回 save 時に PUT API が KV にも書込、以降は KV が source of truth に
 *
 * 親 SSOT:
 *   - linkscrawl/docs/fusion/team/m-director/dsl-spec.md (条件 AST + Visual Builder)
 *   - linkscrawl/docs/fusion/mockups/20_scenarios_editor.html (デザイン SSOT)
 *   - 続 M-9 §1 (KV-first read + POC fallback)
 *
 * tenant_id: Phase 1 = hard-code POC で固定 (`linkth_internal`)、
 *            Phase 3 で multi-tenant 化時に JWT から取得。
 */

import { notFound } from 'next/navigation'

import { ScenarioEditorView } from '@/components/scenarios/scenario-editor-view'
import { POC_SCENARIOS } from '@/lib/scenarios/poc-scenario'
import { createScenarioRepository, ScenarioValidationError } from '@/lib/scenarios/repository'
import type { Scenario } from '@/lib/scenarios/types'
import { CloudflareKvError } from '@/lib/scenarios/kv-storage'

interface PageProps {
  params: { id: string }
}

export const dynamic = 'force-dynamic'

const DEFAULT_TENANT = 'linkth_internal'
const DEFAULT_SITE = 'CIP_EcwUTHEZdIOAUqum' // bihadashop.jp (Phase 1 fixed)

async function loadScenarioOrNull(scenarioId: string): Promise<Scenario | null> {
  // 1) KV first
  try {
    const repo = createScenarioRepository()
    const found = await repo.getScenario(DEFAULT_TENANT, DEFAULT_SITE, scenarioId)
    if (found) return found
  } catch (e) {
    // KV unavailable (env missing in local dev / API token expired)
    // → log + fall through to POC fallback so the editor still opens
    if (e instanceof CloudflareKvError || e instanceof ScenarioValidationError) {
      // eslint-disable-next-line no-console
      console.warn(`[scenarios/[id]] KV read failed, falling back to POC: ${(e as Error).message}`)
    } else {
      throw e
    }
  }
  // 2) POC fallback (legacy hard-code、Phase 3 で deprecation)
  const fromPoc = POC_SCENARIOS.find((s) => s.id === scenarioId)
  if (!fromPoc || fromPoc.archived_at !== null) return null
  return fromPoc
}

export default async function ScenarioEditorPage({ params }: PageProps) {
  const scenario = await loadScenarioOrNull(params.id)
  if (!scenario) notFound()

  return <ScenarioEditorView scenario={scenario} />
}
