/**
 * /experiments — 統計的仮説検定付き A/B テスト画面 (Lane 4 Task 2)
 *
 * - サイトドック (LINKTH CRAWL 418項目) や M Agent / ページパフォーマンス分析の処方箋から
 *   ワンクリックで仮説 (H0 / H1) を起票
 * - 二標本比率のZ検定 (p値・95%信頼区間・統計的検出力 1-β・必要サンプルサイズ進捗) を即時計算・可視化
 * - 人間 (Organic / SNS) vs AI流入 (ChatGPT / Perplexity / Gemini / Claude) セグメント別リフト比較
 * - 既存の標準 A/B テスト基盤 (ExperimentsView / 横断プール検定) ともシームレスに共存
 */

import { PageMeta } from '@/components/layout/page-meta'
import { ExperimentsView } from '@/components/experiments/experiments-view'
import { HypothesisAbDashboard } from '@/components/experiments/hypothesis-ab-dashboard'
import { PostgresExperimentStore } from '@/lib/experiments/postgres-store'
import { createExperimentRepository } from '@/lib/experiments/repository'
import type { Experiment } from '@/lib/experiments/types'
import { getServerSession } from '@/lib/auth/server-session'

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams?: { site_id?: string }
}

const DEFAULT_SITE_ID = 'CIP_EcwUTHEZdIOAUqum'

export default async function ExperimentsPage({ searchParams }: PageProps) {
  const session = await getServerSession()
  const siteIds = session?.user?.site_ids ?? [DEFAULT_SITE_ID]
  const requested = searchParams?.site_id
  const siteId = requested && siteIds.includes(requested) ? requested : siteIds[0] ?? DEFAULT_SITE_ID

  let experiments: Experiment[] = []
  let registryUnavailable = false
  if (session) {
    try {
      const repo = createExperimentRepository({ store: new PostgresExperimentStore() })
      experiments = await repo.list(session.tenant_id, siteId)
    } catch (e) {
      registryUnavailable = true
      // eslint-disable-next-line no-console
      console.warn(`[experiments page] registry unavailable: ${(e as Error).message}`)
    }
  } else {
    registryUnavailable = true
  }

  return (
    <div className="ug-page-scroll">
      <PageMeta title="仮説検定 A/Bテスト" eyebrow="Experiments · Hypothesis Testing & Power Gate" />
      <div className="mx-auto max-w-6xl space-y-8 p-6">
        <HypothesisAbDashboard siteId={siteId} />
        <div className="border-t border-border pt-6">
          <ExperimentsView
            siteId={siteId}
            experiments={experiments}
            registryUnavailable={registryUnavailable}
          />
        </div>
      </div>
    </div>
  )
}
