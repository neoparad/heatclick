/**
 * /scenarios — ターゲティングバナー一覧 (M-Director Stage 2、続 M-9 / 2026-05-28)
 *
 * Phase 2 で変更:
 *   - Server Component で repository.listScenarios() + POC_SCENARIOS を merge
 *   - 同 id があれば KV 値で上書き (一度 save された scenario は KV 由来になる)
 *   - 新規 KV 由来 scenario も一覧に表示
 *
 * 親 SSOT:
 *   - linkscrawl/docs/fusion/team/m-director/prd.md §5
 *   - linkscrawl/docs/fusion/mockups/19_scenarios_list.html (デザイン SSOT)
 *   - 続 M-9 §1 (KV + POC merge、KV 優先)
 *
 * tenant_id: Phase 1 = `linkth_internal` 固定、Phase 3 で multi-tenant 化時に JWT から取得。
 */

import { ScenariosListView } from '@/components/scenarios/scenarios-list-view'
import { CloudflareKvError } from '@/lib/scenarios/kv-storage'
import { POC_SCENARIOS } from '@/lib/scenarios/poc-scenario'
import { ScenarioValidationError, createScenarioRepository } from '@/lib/scenarios/repository'
import type { Scenario } from '@/lib/scenarios/types'

export const dynamic = 'force-dynamic'

const DEFAULT_TENANT = 'linkth_internal'
const DEFAULT_SITE = 'CIP_EcwUTHEZdIOAUqum' // bihadashop.jp (Phase 1 fixed)

async function loadKvScenarios(): Promise<Scenario[]> {
  try {
    const repo = createScenarioRepository()
    return await repo.listScenarios(DEFAULT_TENANT, DEFAULT_SITE)
  } catch (e) {
    if (e instanceof CloudflareKvError || e instanceof ScenarioValidationError) {
      // eslint-disable-next-line no-console
      console.warn(`[scenarios list] KV read failed, POC fallback only: ${(e as Error).message}`)
      return []
    }
    throw e
  }
}

function mergeKvAndPoc(kvList: Scenario[], poc: ReadonlyArray<Scenario>): Scenario[] {
  // KV が同 id を持つ場合は KV 値で上書き (save 済の scenario は KV が source of truth)
  const byId = new Map<string, Scenario>()
  for (const s of poc) {
    if (s.archived_at === null) byId.set(s.id, s)
  }
  for (const s of kvList) {
    if (s.archived_at === null) byId.set(s.id, s)
  }
  return [...byId.values()].sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1))
}

export default async function ScenariosListPage() {
  const kvList = await loadKvScenarios()
  const merged = mergeKvAndPoc(kvList, POC_SCENARIOS)
  return <ScenariosListView scenarios={merged} />
}
