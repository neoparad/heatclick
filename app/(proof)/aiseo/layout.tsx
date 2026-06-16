/**
 * AISEO route group layout (Phase 1)
 *
 * AISEO-Director SSOT: decisions.md 続 AISEO-1 §4 (AISEO-2)
 *
 * - 上位 (proof)/layout.tsx の AppShell (4 ピラー sidebar + topbar) で wrap されている
 *   状態を前提に、AISEO 共通ヘッダ (タブ切替 + 対象サイト表示) を追加。
 * - Phase 1 dogfood: tenant_id=linkth_internal、targetSite=wakegai.jp 固定。
 *   Phase 3 で getTenantContext() ベースに動的読込予定。
 */

import type { ReactNode } from 'react'

import { AiseoPageHeader } from '@/components/aiseo/aiseo-page-header'

interface AiseoLayoutProps {
  children: ReactNode
}

export default function AiseoLayout({ children }: AiseoLayoutProps) {
  return (
    <div className="flex h-full flex-col" data-aiseo-shell>
      <AiseoPageHeader targetSiteLabel="wakegai.jp" tenantId="linkth_internal" />
      <main className="flex-1 overflow-auto bg-slate-50" data-aiseo-main>
        <div className="mx-auto max-w-6xl px-5 py-5">{children}</div>
      </main>
    </div>
  )
}
