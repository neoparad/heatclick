/**
 * P-02 Onboarding / Install
 *
 * 親 SSOT §3.6.5 / §6.4 Sprint 1 S1-02 / Part V §5.5.1 P-02 / mockup 15_install_settings.html
 *
 * 構成:
 *   - Tabs (install のみ active、general/team/billing は Sprint 3 で有効化)
 *   - Step 1: tracking.js snippet 表示 + copy
 *   - Step 2: GTM 設定ガイド (動画 + 静止画 9 枚 + 手順テキスト)
 *   - Step 3: F-58 顧客自己診断 Step 1 (URL → LLM 自動分類、UI のみ。Sprint 3 で ML 接続)
 */

import type { Metadata } from 'next'
import { CodeXml, Film, ClipboardCheck } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { GtmGuide } from './gtm-guide'
import { SiteClassifierStep } from './site-classifier-step'
import { TrackingSnippet } from './tracking-snippet'

export const metadata: Metadata = {
  title: '設置ガイド — UGOKI MAP',
  robots: { index: false, follow: false },
}

// Sprint 1 dummy. Sprint 2 (S1-02 完了直後) で `/api/account/site/[site_id]/install-token` に切替
const FAKE_INSTALL_TOKEN = 'inst_demo_DEMO_TOKEN_xxxxxxxx'
const FAKE_SITE_ID = 'site_bihada_demo'
// B-1 (decisions.md L275 続 14 / L162 続 15 §4.4 BR1): multi-tenant 化に伴い data-tenant-id 必須化。
// Sprint 1 dogfood は LINKTH 関係者のみのため 'linkth_internal' で固定。Sprint 2 (S1-02 完了直後) で
// 認証 session から動的に解決 (JWT claim → tenant_id) に切替。
const FAKE_TENANT_ID = 'linkth_internal'
// H-2 fix (Reviewer T1 dual 続 10): tracking.js host を環境変数化、production 既定は ugokimap.com。
// Vercel env `NEXT_PUBLIC_TRACKING_ORIGIN` で override 可 (Owner B-3 deploy 時に投入)。
const TRACKING_ORIGIN =
  process.env.NEXT_PUBLIC_TRACKING_ORIGIN ?? 'https://ugokimap.com'

// H-3 TODO (Reviewer T1 dual 続 10): /onboarding/install は Sprint 1 では未認証 public route
// (middleware.ts PUBLIC_PAGE_PATHS) として配信中。Sprint 1 dummy install token のため impact 低だが、
// Sprint 3 で実 install_token を `/api/account/site/[site_id]/install-token` から fetch するように
// 切替える際に middleware gate (JWT 必須 + site_id 所有検証) を追加すること。
// Sprint 2 計画書 (`docs/fusion/strategy/19_grand_v1.md` §6.5 S3-XX) で gate 設計を確定する。

export default function OnboardingInstallPage() {
  return (
    <main className="bg-muted/30 px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="space-y-2">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-3">
            Onboarding
          </p>
          <h1 className="text-3xl font-bold tracking-tight">tracking.js を設置する</h1>
          <p className="text-sm text-text-2">
            3 ステップで完了します。GTM をお使いの場合は動画ガイドをご利用ください。
          </p>
        </header>

        <Tabs defaultValue="install" className="space-y-4">
          <TabsList className="w-full justify-start">
            <TabsTrigger value="install">設置 (Install)</TabsTrigger>
            <TabsTrigger value="general" disabled>
              一般 (Sprint 3)
            </TabsTrigger>
            <TabsTrigger value="team" disabled>
              チーム (Sprint 3)
            </TabsTrigger>
            <TabsTrigger value="billing" disabled>
              請求 (Sprint 3)
            </TabsTrigger>
          </TabsList>

          <TabsContent value="install" className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CodeXml className="h-4 w-4 text-primary" aria-hidden />
                  Step 1. tracking.js snippet
                </CardTitle>
                <CardDescription>
                  下記コードを <code className="font-mono">&lt;head&gt;</code> 直下に貼り付けてください。
                  GTM 経由でも構いません (Step 2 参照)。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TrackingSnippet
                  siteId={FAKE_SITE_ID}
                  tenantId={FAKE_TENANT_ID}
                  installToken={FAKE_INSTALL_TOKEN}
                  origin={TRACKING_ORIGIN}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Film className="h-4 w-4 text-primary" aria-hidden />
                  Step 2. GTM 設定ガイド
                </CardTitle>
                <CardDescription>
                  Google Tag Manager をお使いの方向けの動画ガイドと、各ステップのスクリーンショットです。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <GtmGuide />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ClipboardCheck className="h-4 w-4 text-primary" aria-hidden />
                  Step 3. サイト業種を自動診断 (β)
                </CardTitle>
                <CardDescription>
                  AI がサイトの業態を推定します。確定はオンボーディング完了後にプロフィール画面から行えます。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <SiteClassifierStep siteId={FAKE_SITE_ID} />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </main>
  )
}
