/**
 * AISEO 共通ヘッダ + tab nav (Lane 4: Overview / 内部リンク診断 / 内部リンク実装)
 */

'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { Activity, FileEdit, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'

interface AiseoTab {
  id: 'overview' | 'analytics' | 'contents'
  label: string
  href: string
  icon: ReactNode
}

const TABS: ReadonlyArray<AiseoTab> = [
  {
    id: 'overview',
    label: 'GA4 AI流入 & AIO引用差分 & 16項目意味監査',
    href: '/aiseo',
    icon: <Sparkles className="h-4 w-4" aria-hidden />,
  },
  {
    id: 'analytics',
    label: '内部リンク診断 (Analytics)',
    href: '/aiseo/analytics/internal-links',
    icon: <Activity className="h-4 w-4" aria-hidden />,
  },
  {
    id: 'contents',
    label: '内部リンク実装 (Contents)',
    href: '/aiseo/contents/internal-links',
    icon: <FileEdit className="h-4 w-4" aria-hidden />,
  },
]

function resolveActiveTab(pathname: string | null): AiseoTab['id'] {
  if (!pathname) return 'overview'
  if (pathname.startsWith('/aiseo/analytics')) return 'analytics'
  if (pathname.startsWith('/aiseo/contents')) return 'contents'
  return 'overview'
}

interface AiseoPageHeaderProps {
  targetSiteLabel: string
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
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div>
          <h1 className="text-base font-bold text-slate-900">
            AISEO（GA4 AI検索流入 × Google AI Overview 引用差分 × 16項目×7要素AI意味監査）
          </h1>
          <p className="text-xs text-slate-500" data-aiseo-target>
            対象サイト: <span className="font-medium text-slate-700">{targetSiteLabel}</span>
            <span className="mx-1.5 text-slate-300">·</span>
            tenant: <span className="font-mono text-slate-600">{tenantId}</span>
          </p>
        </div>
        <span
          className="text-[11px] font-semibold rounded-full px-2.5 py-0.5 bg-indigo-50 text-indigo-700 border border-indigo-200"
          aria-label="LINKTH CRAWL v1 + GA4"
        >
          LINKTH CRAWL v1 · GA4 AI Attribution
        </span>
      </div>

      <nav
        className="flex flex-wrap items-center gap-1"
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
