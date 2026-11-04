/**
 * /scenarios — ターゲティングバナー一覧 (M-Director Phase 2.1 multi-tenant 化)
 *
 *   - getServerSession() でログイン中テナントの tenant_id と site_ids を取得
 *   - 各 site_id について repository.listScenarios() を取得し、POC_SCENARIOS とマージ
 *   - 同 id があれば KV 値で上書き (一度 save された scenario は KV 由来になる)
 */

import { ScenariosListView } from '@/components/scenarios/scenarios-list-view'
import { getServerSession } from '@/lib/auth/server-session'
import { CloudflareKvError } from '@/lib/scenarios/kv-storage'
import { getPocScenariosForTenant, POC_SCENARIOS } from '@/lib/scenarios/poc-scenario'
import { ScenarioValidationError, createScenarioRepository } from '@/lib/scenarios/repository'
import type { Scenario } from '@/lib/scenarios/types'

export const dynamic = 'force-dynamic'

const DEFAULT_TENANT = 'linkth_internal'
const DEFAULT_SITE = 'CIP_EcwUTHEZdIOAUqum' // bihadashop.jp (Phase 1 fallback)

async function loadKvScenariosForSites(
  tenantId: string,
  siteIds: ReadonlyArray<string>,
): Promise<Scenario[]> {
  const results: Scenario[] = []
  try {
    const repo = createScenarioRepository()
    for (const siteId of siteIds) {
      try {
        const list = await repo.listScenarios(tenantId, siteId)
        results.push(...list)
      } catch (e) {
        if (e instanceof CloudflareKvError || e instanceof ScenarioValidationError) {
          // eslint-disable-next-line no-console
          console.warn(
            `[scenarios list] KV read failed for ${tenantId}/${siteId}, POC fallback: ${(e as Error).message}`,
          )
        } else {
          throw e
        }
      }
    }
  } catch (e) {
    if (e instanceof CloudflareKvError || e instanceof ScenarioValidationError) {
      // eslint-disable-next-line no-console
      console.warn(`[scenarios list] KV init failed, POC fallback only: ${(e as Error).message}`)
      return []
    }
    throw e
  }
  return results
}

function mergeKvAndPoc(kvList: Scenario[], poc: ReadonlyArray<Scenario>): Scenario[] {
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
  const session = await getServerSession()
  const tenantId = session?.tenant_id ?? DEFAULT_TENANT
  const siteIds =
    session?.user?.site_ids && session.user.site_ids.length > 0
      ? session.user.site_ids
      : [DEFAULT_SITE]

  const kvList = await loadKvScenariosForSites(tenantId, siteIds)

  const pocList: Scenario[] = []
  for (const siteId of siteIds) {
    pocList.push(...getPocScenariosForTenant(tenantId, siteId))
  }
  // デモ・初期状態でも一覧が空にならないよう、POCが0件かつKVも0件ならデフォルトPOCを表示
  const fallbackPoc = pocList.length > 0 ? pocList : POC_SCENARIOS
  const merged = mergeKvAndPoc(kvList, fallbackPoc)

  return <ScenariosListView scenarios={merged} />
}
