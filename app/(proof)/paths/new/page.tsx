/**
 * /paths/new — 新規 経路 (比較セット) 登録 (経路ビルダー)
 *
 * Server component で getServerSession() を呼び、JWT 由来 site_ids を client view に渡す。
 * 親 SSOT: scenarios/new/page.tsx と同方針。
 */

import { redirect } from 'next/navigation'

import { PathNewView } from '@/components/paths/path-new-view'
import { getServerSession } from '@/lib/auth/server-session'

export const dynamic = 'force-dynamic'

export default async function PathNewPage() {
  const session = await getServerSession()
  if (!session) {
    redirect('/auth/sign-in?next=/paths/new')
  }
  const availableSiteIds = session.user.site_ids ?? []
  return <PathNewView availableSiteIds={availableSiteIds} />
}
