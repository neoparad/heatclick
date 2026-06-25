/**
 * P-? CV経路分析 page (Phase 1)
 *
 * 親 SSOT §3.6.5 / docs/cv-journey-implementation-plan.md / mockup 04_cv_journey.html
 *
 * heatmap page (app/(proof)/heatmap/page.tsx) と同構成:
 *   - Server Component で site 検証（getServerSession + site_ids 包含）
 *   - client は dynamic({ ssr:false })（フロー描画が window 依存のため安全側）
 *   - 認証 / tenant 検証は middleware.ts + getServerSession で担保
 */

import type { Metadata } from 'next'
import dynamic from 'next/dynamic'

import { getServerSession } from '@/lib/auth/server-session'
import { PageMeta } from '@/components/layout/page-meta'

const CvJourneyPageClient = dynamic(
  () => import('@/components/cv-journey/cv-journey-page').then((m) => m.CvJourneyPage),
  { ssr: false },
)

export const metadata: Metadata = {
  title: 'CV経路分析 — UGOKI MAP',
  robots: { index: false, follow: false },
}

interface CvJourneyRouteProps {
  searchParams: { site_id?: string }
}

/** heatmap と同じ既定サイト (bihadashop.jp) */
const DEFAULT_SITE_ID = 'CIP_EcwUTHEZdIOAUqum'

export default async function ProofCvJourneyPage({ searchParams }: CvJourneyRouteProps) {
  const session = await getServerSession()
  const requestedSite = searchParams.site_id ?? DEFAULT_SITE_ID

  // cross-tenant site 指定は既定サイトにフォールバック（middleware が先に弾く前提の多層防御）
  const siteId =
    session && session.user.site_ids.includes(requestedSite)
      ? requestedSite
      : session?.user.site_ids[0] ?? DEFAULT_SITE_ID

  return (
    <div className="ug-page-scroll">
      <div className="ug-page-inner space-y-4">
        <PageMeta title="CV経路分析" eyebrow="Behavior · CV Journey" />
        <CvJourneyPageClient siteId={siteId} />
      </div>
    </div>
  )
}
