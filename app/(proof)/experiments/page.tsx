/**
 * /experiments — 標準 A/B テスト一覧・作成 (宝プロジェクト 残タスク②)
 *
 * Server Component:
 *   - tenant/site は **session (JWT) 由来のみ** (scenarios page の Phase1 固定 tenant とは
 *     異なり、最初から multi-tenant)。?site_id= は JWT site_ids 内のみ許可、外なら先頭へ fallback。
 *   - registry (Postgres) 不通は registryUnavailable で graceful 表示 (DDL/env 未投入の dev 耐性)。
 *   - 一覧 + 作成 + lifecycle + 結果表示は ExperimentsView (client) が API 経由で操作。
 */

import { ExperimentsView } from '@/components/experiments/experiments-view'
import { PostgresExperimentStore } from '@/lib/experiments/postgres-store'
import { createExperimentRepository } from '@/lib/experiments/repository'
import type { Experiment } from '@/lib/experiments/types'
import { getServerSession } from '@/lib/auth/server-session'

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams?: { site_id?: string }
}

export default async function ExperimentsPage({ searchParams }: PageProps) {
  const session = await getServerSession()
  if (!session) {
    // middleware が sign-in へ redirect する前提の防御 (直接到達時)。
    return (
      <div className="mx-auto max-w-4xl p-6 text-sm text-text-3">サインインが必要です。</div>
    )
  }

  const siteIds = session.user.site_ids
  if (!siteIds || siteIds.length === 0) {
    return (
      <div className="mx-auto max-w-4xl p-6 text-sm text-text-3">
        利用可能なサイトがありません。サイト設定後にご利用ください。
      </div>
    )
  }

  const requested = searchParams?.site_id
  // ?site_id= が JWT の site_ids 外なら黙って fallback せず明示エラー (Codex LOW:
  // URL と実効サイトの不一致は誤操作を誘発する)。
  if (requested && !siteIds.includes(requested)) {
    return (
      <div className="mx-auto max-w-4xl p-6 text-sm text-text-3">
        指定されたサイト ({requested}) にはアクセスできません。
      </div>
    )
  }
  const siteId = requested ?? siteIds[0]

  let experiments: Experiment[] = []
  let registryUnavailable = false
  try {
    const repo = createExperimentRepository({ store: new PostgresExperimentStore() })
    experiments = await repo.list(session.tenant_id, siteId)
  } catch (e) {
    registryUnavailable = true
    // eslint-disable-next-line no-console
    console.warn(`[experiments page] registry unavailable: ${(e as Error).message}`)
  }

  return (
    <ExperimentsView siteId={siteId} experiments={experiments} registryUnavailable={registryUnavailable} />
  )
}
