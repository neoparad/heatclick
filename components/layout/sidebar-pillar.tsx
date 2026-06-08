/**
 * SidebarPillar — 4 ピラー切替コンポーネント (続 73 Task 1)
 *
 * mockup `linkscrawl/docs/fusion/mockups/_partials` (10_ai_chat.html L637-657 抜粋)
 * 親 SSOT: 続 55 sidebar SSOT / 続 66 §3 4 ピラー IA
 *
 * 4 ピラー:
 *   - behavior (active)   : 行動分析 / Behavior · CVR  ← 現在 active
 *   - m-agent (coming)    : M Agent / Marketing AI    (Phase 2)
 *   - aiseo (coming)      : AISEO / SEO · AIO          (Phase 3)
 *   - custom-bi (coming)  : カスタムBI / Client reports (Phase 3+)
 *
 * 全 (proof) page で「behavior」が active 固定 (Phase 1 = 行動分析のみ)。
 * Coming soon ピラーは aria-disabled で click 無効化。
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
    // 続 83 §4 (Main Director approval、2026-05-25): M-Director Phase 1 mockup deploy で
    // m-agent を coming-soon → active 暫定化。href は mockup index (/mockups/) を指す。
    // Day 2 frontend (/scenarios route) 配備完了で href を /scenarios に切替予定。
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
    comingSoon: true,
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
  /** active ピラー — Phase 1 = behavior default、ただし pathname `/scenarios*` 等で自動上書きされる */
  active?: Pillar['id']
}

/**
 * 続 83 §4 Day 2 (2026-05-25): pathname に応じて active pillar を自動判定。
 * - `/scenarios*` → 'm-agent'
 * - それ以外 → props.active (= AppShell 渡しの 'behavior')
 *
 * これにより (proof)/layout.tsx の `pillar="behavior"` 固定 prop を破壊せず、
 * URL 経路だけで pillar の active 状態が同期する (Main Director 管轄 layout.tsx 不変)。
 */
function resolveActivePillar(pathname: string | null, fallback: Pillar['id']): Pillar['id'] {
  if (!pathname) return fallback
  if (pathname === '/scenarios' || pathname.startsWith('/scenarios/')) return 'm-agent'
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

        // 続 117 fix (Owner 報告: /scenarios で「行動分析」pillar を押すと URL が
        //   /scenarios# になるだけで dashboard に戻れず stuck):
        //   各 pillar は自分の home へ link する。
        //   - behavior  → /dashboard (行動分析の home、= sign-in 既定の着地先)
        //   - m-agent   → /scenarios (ターゲティングバナー一覧)
        //   - aiseo / custom-bi → '#' (coming-soon、onClick で完全 no-op)
        // 旧実装は behavior の href を '#' 固定にしていたため、別 pillar (/scenarios) に
        //   居るときに behavior を押しても navigation せず hash だけ付いて行き止まりになっていた。
        const href =
          p.id === 'm-agent' ? '/scenarios' : p.id === 'behavior' ? '/dashboard' : '#'
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
              // coming-soon は完全 no-op。
              if (p.comingSoon) {
                e.preventDefault()
                return
              }
              // 既に active な pillar 自身を押した場合は遷移不要 (no-op)。
              // それ以外 (behavior ⇄ m-agent の切替) は通常 navigation を許可し、
              // 各 pillar の home (/dashboard or /scenarios) へ確実に遷移させる。
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
            {p.comingSoon ? (
              <span className="ug-coming-badge">Coming soon</span>
            ) : null}
          </a>
        )
      })}
    </div>
  )
}
