/**
 * /paths/[id] — 経路分析 比較セット詳細 (フローキャンバス)
 *
 * 旧 /paths のキャンバスをそのまま流用。PathSet を KV (+ POC fallback) から取得し、
 * pathSetToAnalysisData() で <PathAnalysisCanvas> 用の PathAnalysisData に射影する。
 *
 * REQ-SEC-004: tenant は JWT 由来、site_id は JWT site_ids 内のみ。POC fallback は
 * linkth_internal + CIP_EcwUTHEZdIOAUqum 専用 (他テナントに漏らさない)。
 */

import { notFound, redirect } from 'next/navigation'

import { PageMeta } from '@/components/layout/page-meta'
import { PathAnalysisCanvas } from '@/components/paths/path-analysis-canvas'
import { getServerSession } from '@/lib/auth/server-session'
import { CloudflareKvError } from '@/lib/scenarios/kv-storage'
import { POC_PATHSETS } from '@/lib/paths/poc-pathset'
import { PathSetValidationError, createPathSetRepository } from '@/lib/paths/repository'
import { pathSetToAnalysisData, type PathSet } from '@/lib/paths/types'

export const dynamic = 'force-dynamic'

const POC_TENANT = 'linkth_internal'
const POC_SITE = 'CIP_EcwUTHEZdIOAUqum'
const SITE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

interface PageProps {
  params: { id: string }
  searchParams: { site_id?: string }
}

async function loadPathSetOrNull(
  tenantId: string,
  siteId: string,
  id: string,
): Promise<PathSet | null> {
  try {
    const repo = createPathSetRepository()
    const found = await repo.getPathSet(tenantId, siteId, id)
    if (found) return found
  } catch (e) {
    if (e instanceof CloudflareKvError || e instanceof PathSetValidationError) {
      // eslint-disable-next-line no-console
      console.warn(`[paths/[id]] KV read failed, falling back to POC: ${(e as Error).message}`)
    } else {
      throw e
    }
  }
  if (tenantId === POC_TENANT && siteId === POC_SITE) {
    const fromPoc = POC_PATHSETS.find((p) => p.id === id)
    if (fromPoc && fromPoc.archived_at === null) return fromPoc
  }
  return null
}

export default async function PathDetailPage({ params, searchParams }: PageProps) {
  const session = await getServerSession()
  if (!session) {
    redirect('/auth/sign-in?next=/paths')
  }

  const tenantId = session.tenant_id
  const siteIds = session.user.site_ids ?? []
  if (siteIds.length === 0) notFound()

  let siteId: string
  if (searchParams.site_id) {
    if (!SITE_ID_PATTERN.test(searchParams.site_id) || !siteIds.includes(searchParams.site_id)) {
      notFound()
    }
    siteId = searchParams.site_id
  } else {
    siteId = siteIds[0]
  }

  const pset = await loadPathSetOrNull(tenantId, siteId, params.id)
  if (!pset) notFound()

  const data = pathSetToAnalysisData(pset)
  // POC seed (isDummy) は KV に無く編集不可 → editHref を渡さない (ボタン disabled)。
  const editHref = pset.isDummy
    ? undefined
    : `/paths/${pset.id}/edit?site_id=${encodeURIComponent(siteId)}`

  return (
    <>
      <PageMeta title={pset.name} eyebrow="行動分析 · Path Analysis" />
      <PathAnalysisCanvas data={data} editHref={editHref} />
    </>
  )
}
