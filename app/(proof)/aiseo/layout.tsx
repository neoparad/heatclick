/**
 * AISEO route group layout (Lane 4: GA4 AI検索流入 × AIO引用差分 × AI意味監査 × 内部リンク)
 */

import type { ReactNode } from 'react'

import { AiseoPageHeader } from '@/components/aiseo/aiseo-page-header'

interface AiseoLayoutProps {
  children: ReactNode
}

export default function AiseoLayout({ children }: AiseoLayoutProps) {
  return (
    <div className="flex h-full flex-col" data-aiseo-shell>
      <AiseoPageHeader targetSiteLabel="bihadashop.jp / wakegai.jp" tenantId="linkth_internal" />
      <main className="flex-1 overflow-auto bg-slate-50" data-aiseo-main>
        <div className="mx-auto max-w-7xl px-5 py-5">{children}</div>
      </main>
    </div>
  )
}
