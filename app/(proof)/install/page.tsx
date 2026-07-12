/**
 * Install / Account settings page — mockup `15_install_settings.html` の Server entry (続 75 Task D)
 *
 * 親 SSOT §3.6.5 / §1.7 Anti-Features (個人情報マスク必須) / Part V §5.5.x
 * 配備履歴:
 *   - 続 74 Task D dispatch (Owner 2026-05-24 09:34 JST、sidebar `/install` active 受け)
 *   - 続 75 (本続) Task D 実装 — Server Component + InstallSettingsPane Client orchestrator
 *
 * Server 責務 (本 file):
 *   1. PageMeta (topbar title 流し込み)
 *   2. Phase 1 dogfood 5 sites (`CIP_*`) を seed として宣言
 *   3. 各 site で `/api/pages?site_id=<id>` を server-side fetch → initial SiteStatus 配列を構築
 *      (Client から fetch でもよいが、初回 render を高速にするため SSR で先行取得)
 *   4. InstallSettingsPane に props を渡す
 *
 * Client 責務 (`components/install/install-settings-pane.tsx`):
 *   - tab 切替 / accordion / 動作確認 button (再 probe) を担当
 *   - 5 sites status カードを表示
 *   - tracking_id snippet + clipboard copy
 *
 * D-07 整合:
 *   - 受信件数は ClickHouse events から /api/pages 経由で実取得 (Infra 続 56)、
 *     observed_exact 相当。dummy fixture は使わない (Phase 1 dogfood は実 events)。
 *   - events 流入が 0 件の site は banner で warn 表示 (誤って「正常」と表記しない)。
 */

import type { Metadata } from 'next'
import { cookies, headers } from 'next/headers'

import { getServerSession } from '@/lib/auth/server-session'
import { PageMeta } from '@/components/layout/page-meta'
import {
  InstallSettingsPane,
  type SiteStatus,
} from '@/components/install/install-settings-pane'

export const metadata: Metadata = {
  title: '設定 / タグ設置 — UGOKI MAP',
  robots: { index: false, follow: false },
}

/**
 * Phase 1 dogfood 5 sites (続 39 / `lib/auth/dogfood-users.ts` と整合)。
 * Sprint 3 W2-B で sites table (Infra 続 56 配備済 `clickinsight.sites`) から動的取得に切替予定。
 */
const PHASE1_SITES: ReadonlyArray<{ siteId: string; siteName: string }> = [
  { siteId: 'CIP_EcwUTHEZdIOAUqum', siteName: 'bihadashop.jp' },
  { siteId: 'CIP_xginf3nVacnkn62o', siteName: 'site-2 (linkth internal)' },
  { siteId: 'CIP_6r2WofQDSKrOwxmM', siteName: 'site-3 (linkth internal)' },
  { siteId: 'CIP_8eN7xgfBtDAnzE26', siteName: 'site-4 (linkth internal)' },
  { siteId: 'CIP_QWaPiks5krukJ6NM', siteName: 'site-5 (linkth internal)' },
]

const DEFAULT_ACTIVE_SITE = PHASE1_SITES[0]

interface InstallPageProps {
  searchParams: { site_id?: string }
}

export default async function InstallPage({ searchParams }: InstallPageProps) {
  const activeSite =
    PHASE1_SITES.find((s) => s.siteId === searchParams.site_id) ?? DEFAULT_ACTIVE_SITE

  // P0-2 fix (independent review 2026-07-11): tracking snippet に tenant_id を必ず含める。
  // tracking.js は data-tenant-id / window.CLICKINSIGHT_TENANT_ID のいずれも無いと
  // sendBeacon を無言で抑止する (public/v2/tracking.js:136)。middleware が本ページを
  // 認証必須にしているため session は通常存在するが、防御的に空文字 fallback する
  // (空文字なら tracking.js 側が同様に抑止し、少なくとも「データが来ない」より安全な
  // 「明示的に抑止される」状態になる)。
  const session = await getServerSession()
  const tenantId = session?.tenant_id ?? ''

  // tracking script origin (env 経由、未設定時は host ヘッダから組立)
  const h = await headers()
  const host = h.get('host')
  const proto = h.get('x-forwarded-proto') ?? 'http'
  const trackingOrigin =
    process.env.NEXT_PUBLIC_APP_URL ?? (host ? `${proto}://${host}` : 'http://localhost:3000')

  // Phase 1 5 sites の initial status を server で /api/pages 経由 fetch
  // (Client 初回 render で空状態にならないよう SSR で先行取得)
  const initialSiteStats = await fetchInitialSiteStats(PHASE1_SITES, trackingOrigin)

  return (
    <>
      <PageMeta title="設定 / タグ設置" eyebrow="Settings · タグ設置 / プライバシー" />
      <InstallSettingsPane
        activeSiteId={activeSite.siteId}
        activeSiteName={activeSite.siteName}
        tenantId={tenantId}
        trackingOrigin={trackingOrigin}
        initialSiteStats={initialSiteStats}
      />
    </>
  )
}

/**
 * 各 site で /api/pages?site_id= を 1 回ずつ叩いて初期 status を作る。
 * 1 件以上返れば events 流入あり (hasEvents=true)。
 *
 * 失敗時 (auth / network) は errorMessage を保持し UI 側で warn 表示。
 * /api/pages は middleware で JWT が必要なので cookie を forward する。
 */
async function fetchInitialSiteStats(
  sites: ReadonlyArray<{ siteId: string; siteName: string }>,
  trackingOrigin: string,
): Promise<ReadonlyArray<SiteStatus>> {
  const cookieJar = await cookies()
  const cookieHeader = cookieJar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')

  const results: SiteStatus[] = []
  for (const s of sites) {
    try {
      const res = await fetch(
        `${trackingOrigin}/api/pages?site_id=${encodeURIComponent(s.siteId)}`,
        {
          cache: 'no-store',
          headers: cookieHeader ? { cookie: cookieHeader } : {},
        },
      )
      if (!res.ok) {
        results.push({
          siteId: s.siteId,
          siteName: s.siteName,
          hasEvents: false,
          pagesCount: 0,
          errorMessage: `HTTP_${res.status}`,
        })
        continue
      }
      const json = (await res.json()) as {
        success: boolean
        data?: Array<{ url: string; label: string }>
      }
      if (!json.success || !Array.isArray(json.data)) {
        results.push({
          siteId: s.siteId,
          siteName: s.siteName,
          hasEvents: false,
          pagesCount: 0,
          errorMessage: 'invalid_response',
        })
        continue
      }
      results.push({
        siteId: s.siteId,
        siteName: s.siteName,
        hasEvents: json.data.length > 0,
        pagesCount: json.data.length,
        errorMessage: null,
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'network'
      console.error(`[install/page] /api/pages probe failed site=${s.siteId}: ${msg}`)
      results.push({
        siteId: s.siteId,
        siteName: s.siteName,
        hasEvents: false,
        pagesCount: 0,
        errorMessage: msg,
      })
    }
  }
  return results
}
