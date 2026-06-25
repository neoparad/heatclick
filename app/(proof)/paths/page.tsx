/**
 * /paths — 経路分析 比較セット登録一覧 (経路分析エージェント)
 *
 * 構造 (scenarios と同型):
 *   /paths           ← 本 file: 登録一覧 (比較セットの一覧 + 新規登録導線)
 *   /paths/[id]      ← 各経路の詳細 (フローキャンバス、旧 /paths のキャンバスを流用)
 *   /paths/new       ← 新規登録 (経路ビルダー)
 *
 * データ:
 *   - KV (lib/paths/repository.ts) から session tenant/site の PathSet を取得
 *   - POC_PATHSETS (商品購入·3経路比較) を merge (同 id は KV 優先)。POC は linkth_internal +
 *     CIP_EcwUTHEZdIOAUqum のみに出す (他テナントに漏らさない)
 *
 * 親 SSOT: mockup 11_path_analysis.html / §3.6.x / §1.7 Anti-Features / D-07
 */

import { redirect } from 'next/navigation'

import { PathsListView } from '@/components/paths/paths-list-view'
import { getServerSession } from '@/lib/auth/server-session'
import { CloudflareKvError } from '@/lib/scenarios/kv-storage'
import { POC_PATHSETS } from '@/lib/paths/poc-pathset'
import { PathSetValidationError, createPathSetRepository } from '@/lib/paths/repository'
import type { PathSet } from '@/lib/paths/types'

export const dynamic = 'force-dynamic'

const POC_TENANT = 'linkth_internal'
const POC_SITE = 'CIP_EcwUTHEZdIOAUqum'

async function loadKvPathSets(tenantId: string, siteId: string): Promise<PathSet[]> {
  try {
    const repo = createPathSetRepository()
    return await repo.listPathSets(tenantId, siteId)
  } catch (e) {
    if (e instanceof CloudflareKvError || e instanceof PathSetValidationError) {
      // eslint-disable-next-line no-console
      console.warn(`[paths list] KV read failed, POC fallback only: ${(e as Error).message}`)
      return []
    }
    throw e
  }
}

function mergeKvAndPoc(
  kvList: ReadonlyArray<PathSet>,
  poc: ReadonlyArray<PathSet>,
  tenantId: string,
  siteId: string,
): PathSet[] {
  const byId = new Map<string, PathSet>()
  // POC は linkth_internal + CIP のみ (他テナント隔離)
  if (tenantId === POC_TENANT && siteId === POC_SITE) {
    for (const p of poc) {
      if (p.archived_at === null) byId.set(p.id, p)
    }
  }
  for (const p of kvList) {
    if (p.archived_at === null) byId.set(p.id, p)
  }
  return [...byId.values()].sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1))
}

export default async function PathsListPage() {
  const session = await getServerSession()
  if (!session) {
    redirect('/auth/sign-in?next=/paths')
  }

  const tenantId = session.tenant_id
  const siteIds = session.user.site_ids ?? []
  const siteId = siteIds[0] ?? POC_SITE

  const kvList = await loadKvPathSets(tenantId, siteId)
  const merged = mergeKvAndPoc(kvList, POC_PATHSETS, tenantId, siteId)

  return <PathsListView pathSets={merged} siteId={siteId} />
}
