/**
 * /scenarios/new — 新規シナリオ作成 (Phase 2.1 完成版、M-Director、2026-06-07)
 *
 * Server component で getServerSession() を呼び、JWT 由来の site_ids を client view に渡す。
 * middleware は tenant-protected region で header inject しないため、headers() 直読不可。
 * getServerSession() (cookie/JWT) が SSOT (Codex T2 dual review フォローアップ反映)。
 *
 * 親 SSOT: linkscrawl/docs/fusion/team/m-director/prd.md §6 (Phase 2 機能要件)
 */

import { redirect } from 'next/navigation'

import { ScenarioNewView } from '@/components/scenarios/scenario-new-view'
import { getServerSession } from '@/lib/auth/server-session'

export const dynamic = 'force-dynamic'

export default async function ScenarioNewPage() {
  const session = await getServerSession()
  if (!session) {
    redirect('/auth/sign-in?next=/scenarios/new')
  }
  const availableSiteIds = session.user.site_ids ?? []
  return <ScenarioNewView availableSiteIds={availableSiteIds} />
}
