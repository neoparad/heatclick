/**
 * /scenarios/[id] — ターゲティングバナー編集 (M-Director、2026-06-07 Phase 2.1 multi-tenant 化)
 *
 * Phase 2.1 で変更 (Codex T2 dual review 指摘 C + フォローアップ反映):
 *   - 旧: DEFAULT_TENANT = 'linkth_internal' / DEFAULT_SITE = 'CIP_EcwUTHEZdIOAUqum' 固定
 *   - 新: getServerSession() で JWT cookie 由来の tenant + site_ids を取得
 *     (middleware は tenant-protected region で header inject しないため、
 *      headers() 直読では取れない。getServerSession 経由が SSOT)
 *   - searchParams.site_id (JWT site_ids 内のみ許可、省略時は先頭)
 *
 * 親 SSOT:
 *   - lib/auth/server-session.ts (cookie/JWT 由来 session)
 *   - lib/scenarios/repository.ts (tenant 隔離 read)
 */

import { notFound, redirect } from 'next/navigation'

import { ScenarioEditorView } from '@/components/scenarios/scenario-editor-view'
import { getServerSession } from '@/lib/auth/server-session'
import { POC_SCENARIOS } from '@/lib/scenarios/poc-scenario'
import { createScenarioRepository, ScenarioValidationError } from '@/lib/scenarios/repository'
import type { Scenario } from '@/lib/scenarios/types'
import { CloudflareKvError } from '@/lib/scenarios/kv-storage'

interface PageProps {
  params: { id: string }
  searchParams: { site_id?: string }
}

export const dynamic = 'force-dynamic'

const SITE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

async function loadScenarioOrNull(
  tenantId: string,
  siteId: string,
  scenarioId: string,
): Promise<Scenario | null> {
  // 1) KV first (tenant/site で隔離された scenario のみヒット)
  try {
    const repo = createScenarioRepository()
    const found = await repo.getScenario(tenantId, siteId, scenarioId)
    if (found) return found
  } catch (e) {
    if (e instanceof CloudflareKvError || e instanceof ScenarioValidationError) {
      // eslint-disable-next-line no-console
      console.warn(
        `[scenarios/[id]] KV read failed, falling back to POC: ${(e as Error).message}`,
      )
    } else {
      throw e
    }
  }
  // 2) POC fallback は linkth_internal + CIP_EcwUTHEZdIOAUqum 専用 (他 tenant に漏らさない)
  if (tenantId === 'linkth_internal' && siteId === 'CIP_EcwUTHEZdIOAUqum') {
    const fromPoc = POC_SCENARIOS.find((s) => s.id === scenarioId)
    if (fromPoc && fromPoc.archived_at === null) return fromPoc
  }
  return null
}

export default async function ScenarioEditorPage({ params, searchParams }: PageProps) {
  const session = await getServerSession()
  if (!session) {
    redirect('/auth/sign-in?next=/scenarios')
  }

  const tenantId = session.tenant_id
  const siteIds = session.user.site_ids ?? []
  if (siteIds.length === 0) {
    notFound()
  }

  // site_id の解決:
  //   - クエリ指定あり → SITE_ID_PATTERN 通過 + JWT site_ids 内のみ許可、それ以外 404
  //   - 省略 → JWT site_ids の先頭 (Phase 2.1 簡素化、Phase 3 で UI セレクタ化予定)
  let siteId: string
  if (searchParams.site_id) {
    if (!SITE_ID_PATTERN.test(searchParams.site_id) || !siteIds.includes(searchParams.site_id)) {
      notFound()
    }
    siteId = searchParams.site_id
  } else {
    siteId = siteIds[0]
  }

  const scenario = await loadScenarioOrNull(tenantId, siteId, params.id)
  if (!scenario) notFound()

  return <ScenarioEditorView scenario={scenario} />
}
