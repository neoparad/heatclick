/**
 * AISEO Phase 1: ページ共通ヘッダ + tab nav
 *
 * AISEO-Director SSOT: decisions.md 続 AISEO-1 §7 (site label 切替の Phase 1 扱い)
 *
 * - (proof)/layout.tsx の AppShell が `siteLabel="bihadashop.jp"` 固定で wrap している期間、
 *   AISEO product 側は wakegai.jp を dogfood site としているため、本 component で
 *   「現在 AISEO 対象サイト: wakegai.jp」を明示。Phase 2 で AppShell の site picker
 *   drawer 拡張を別 handoff で打診予定。
 * - tab nav (Analytics / Contents) は M-Director scenarios と同じく Client Component で
 *   usePathname() ベースに active 判定。
 */

'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { Activity, FileEdit } from 'lucide-react'
import type { ReactNode } from 'react'

interface AiseoTab {
  id: 'analytics' | 'contents'
  label: string
  /** tab の代表 page。AISEO Phase 1 では各 tab に 1 child page のみ */
  href: string
  icon: ReactNode
}

const TABS: ReadonlyArray<AiseoTab> = [
  {
    id: 'analytics',
    label: 'Analytics',
    href: '/aiseo/analytics/internal-links',
    icon: <Activity className="h-4 w-4" aria-hidden />,
  },
  {
    id: 'contents',
    label: 'Contents',
    href: '/aiseo/contents/internal-links',
    icon: <FileEdit className="h-4 w-4" aria-hidden />,
  },
]

function resolveActiveTab(pathname: string | null): AiseoTab['id'] | null {
  if (!pathname) return null
  if (pathname.startsWith('/aiseo/analytics')) return 'analytics'
  if (pathname.startsWith('/aiseo/contents')) return 'contents'
  return null
}

interface AiseoPageHeaderProps {
  /** Phase 1 = wakegai.jp 固定、Phase 2 で site picker 連動 */
  targetSiteLabel: string
  /** Phase 1 = linkth_internal、Phase 3 で tenant context 経由化 */
  tenantId: string
}

export function AiseoPageHeader({ targetSiteLabel, tenantId }: AiseoPageHeaderProps) {
  const pathname = usePathname()
  const activeTab = resolveActiveTab(pathname)

  return (
    <header
      className="border-b border-slate-200 bg-white"
      data-aiseo-header
      style={{ padding: '12px 20px' }}
    >
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-base font-semibold text-slate-900">AISEO</h1>
          <p className="text-xs text-slate-500" data-aiseo-target>
            対象サイト: <span className="font-medium text-slate-700">{targetSiteLabel}</span>
            <span className="mx-1.5 text-slate-300">·</span>
            tenant: <span className="font-mono text-slate-600">{tenantId}</span>
          </p>
        </div>
        <span
          className="text-[10px] uppercase tracking-wider rounded px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-200"
          aria-label="Phase 1 skeleton"
        >
          Phase 1 · skeleton
        </span>
      </div>

      <nav
        className="flex items-center gap-1"
        aria-label="AISEO タブ"
        data-aiseo-tabs
      >
        {TABS.map((t) => {
          const isActive = activeTab === t.id
          const className = [
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium',
            isActive
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100',
          ].join(' ')
          return (
            <Link
              key={t.id}
              href={t.href}
              className={className}
              data-aiseo-tab={t.id}
              aria-current={isActive ? 'page' : undefined}
            >
              {t.icon}
              <span>{t.label}</span>
            </Link>
          )
        })}
      </nav>
    </header>
  )
}
