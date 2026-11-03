/**
 * SidebarPillar — 4 ピラー切替コンポーネント (続 73 Task 1 + 融合SaaS P4 AISEO 有効化)
 *
 * 4 ピラー:
 *   - behavior (active)   : 行動分析 / Behavior · CVR
 *   - m-agent (active)    : M Agent / Marketing AI
 *   - aiseo (active)      : AISEO / SEO · AIO · AIアクセス
 *   - custom-bi (coming)  : カスタムBI / Client reports (Phase 3+)
 */

'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { BarChart3, Bot, LineChart, Search } from 'lucide-react'

interface Pillar {
  id: 'behavior' | 'm-agent' | 'aiseo' | 'custom-bi'
  title: string
  sub: string
  icon: ReactNode
  comingSoon: boolean
}

const PILLARS: ReadonlyArray<Pillar> = [
  {
    id: 'behavior',
    title: '行動分析',
    sub: 'Behavior / CVR',
    icon: <LineChart className="h-3 w-3" aria-hidden />,
    comingSoon: false,
  },
  {
    id: 'm-agent',
    title: 'M Agent',
    sub: 'Marketing AI',
    icon: <Bot className="h-3 w-3" aria-hidden />,
    comingSoon: false,
  },
  {
    id: 'aiseo',
    title: 'AISEO',
    sub: 'SEO / AIO',
    icon: <Search className="h-3 w-3" aria-hidden />,
    comingSoon: false,
  },
  {
    id: 'custom-bi',
    title: 'カスタムBI',
    sub: 'Client reports',
    icon: <BarChart3 className="h-3 w-3" aria-hidden />,
    comingSoon: true,
  },
]

interface SidebarPillarProps {
  active?: Pillar['id']
}

const AISEO_PREFIXES = [
  '/fusion',
  '/ai-visits',
  '/visit-risk',
  '/journey',
  '/search-crawlers',
  '/seo',
  '/aiseo',
  '/aio',
  '/llmo',
  '/daily',
  '/aio-check',
  '/exposure',
]

export function isAiseoPath(pathname: string | null): boolean {
  if (!pathname) return false
  return AISEO_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'))
}

function resolveActivePillar(pathname: string | null, fallback: Pillar['id']): Pillar['id'] {
  if (!pathname) return fallback
  if (pathname === '/scenarios' || pathname.startsWith('/scenarios/')) return 'm-agent'
  if (isAiseoPath(pathname)) return 'aiseo'
  return fallback
}

export function SidebarPillar({ active = 'behavior' }: SidebarPillarProps) {
  const pathname = usePathname()
  const resolvedActive = resolveActivePillar(pathname, active)

  return (
    <div className="ug-product-switcher" aria-label="プロダクト切替">
      {PILLARS.map((p) => {
        const isActive = p.id === resolvedActive
        const className = [
          'ug-product-link',
          isActive ? 'active' : '',
          p.comingSoon ? 'coming-soon' : '',
        ]
          .filter(Boolean)
          .join(' ')

        const href =
          p.id === 'm-agent'
            ? '/scenarios'
            : p.id === 'aiseo'
            ? '/fusion'
            : p.id === 'behavior'
            ? '/dashboard'
            : '#'

        return (
          <a
            key={p.id}
            href={href}
            className={className}
            data-product={p.id}
            aria-disabled={p.comingSoon || undefined}
            aria-current={isActive ? 'page' : undefined}
            title={p.comingSoon ? `${p.title} (準備中)` : p.title}
            onClick={(e) => {
              if (p.comingSoon) {
                e.preventDefault()
                return
              }
              if (isActive) {
                e.preventDefault()
              }
            }}
          >
            <span className="ug-ps-icon">{p.icon}</span>
            <span className="ug-ps-meta">
              <span className="ug-ps-title">{p.title}</span>
              <span className="ug-ps-sub">{p.sub}</span>
            </span>
            {p.comingSoon ? <span className="ug-coming-badge">Coming soon</span> : null}
          </a>
        )
      })}
    </div>
  )
}
