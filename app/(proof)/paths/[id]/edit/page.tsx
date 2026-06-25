/**
 * /paths/[id]/edit — 既存 経路 (比較セット) の編集
 *
 * KV に永続化された PathSet のみ編集可能 (POC seed は read-only ショーケースのため対象外 → 404)。
 * REQ-SEC-004: tenant は JWT 由来、site_id は JWT site_ids 内のみ。
 */

import { notFound, redirect } from 'next/navigation'

import { PathEditView } from '@/components/paths/path-edit-view'
import { getServerSession } from '@/lib/auth/server-session'
import { CloudflareKvError } from '@/lib/scenarios/kv-storage'
import { PathSetValidationError, createPathSetRepository } from '@/lib/paths/repository'
import type { PathSet } from '@/lib/paths/types'

export const dynamic = 'force-dynamic'

const SITE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

interface PageProps {
  params: { id: string }
  searchParams: { site_id?: string }
}

async function loadKvPathSetOrNull(
  tenantId: string,
  siteId: string,
  id: string,
): Promise<PathSet | null> {
  try {
    const repo = createPathSetRepository()
    return await repo.getPathSet(tenantId, siteId, id)
  } catch (e) {
    if (e instanceof CloudflareKvError || e instanceof PathSetValidationError) {
      // eslint-disable-next-line no-console
      console.warn(`[paths/[id]/edit] KV read failed: ${(e as Error).message}`)
      return null
    }
    throw e
  }
}

export default async function PathEditPage({ params, searchParams }: PageProps) {
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

  const pset = await loadKvPathSetOrNull(tenantId, siteId, params.id)
  if (!pset) notFound()

  return <PathEditView pathSet={pset} />
}
