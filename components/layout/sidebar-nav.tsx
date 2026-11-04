/**
 * SidebarNav — ログイン直後 14メニュー統合左サイドバー (Lane 4 オーナー決定仕様)
 *
 * 上部ピラー切替を廃止し、ログイン直後から全14メニューがこの順序で常時一望・クリック可能:
 *  1. AIチャット (/chat) — 最上段メイン配置
 *  2. サマリーボード (/dashboard)
 *  3. ヒートマップ (/heatmap)
 *  4. AISEO (/aiseo)
 *  5. AIアクセス分析 (/ai-visits)
 *  6. サーチコンソール分析 (/seo/access)
 *  7. ページパフォーマンス分析 (/fusion)
 *  8. 経路分析 (/paths)
 *  9. CV分析 (/cv-journey)
 * 10. 内部リンク提案 (/seo/internal-links) — CV分析の直下に独立配置
 * 11. サイトドック (/site-doc)
 * 12. ページ速度分析 (/performance)
 * 13. M Agent (/scenarios)
 * 14. A/Bテスト (/experiments) — M Agentの直下に配置
 */

'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import {
  Activity,
  Bot,
  Camera,
  CheckCircle2,
  FlaskConical,
  Gauge,
  GitBranch,
  LayoutDashboard,
  LayoutGrid,
  Link2,
  LogOut,
  MessageCircle,
  Network,
  Search,
  Settings,
  Sparkles,
  TrendingUp,
} from 'lucide-react'
import type { ReactNode } from 'react'

export interface NavItem {
  order: number
  navKey: string
  href: string
  /** アクティブ判定に含める関連パス prefix */
  matchPrefixes?: ReadonlyArray<string>
  label: string
  badge?: string
  highlight?: boolean
  icon: ReactNode
}

export const UNIFIED_14_MENUS: ReadonlyArray<NavItem> = [
  {
    order: 1,
    navKey: 'ai-chat',
    href: '/chat',
    label: 'AIチャット',
    badge: 'AI Analyst',
    highlight: true,
    icon: <MessageCircle className="h-4 w-4" aria-hidden />,
  },
  {
    order: 2,
    navKey: 'summary-board',
    href: '/dashboard',
    label: 'サマリーボード',
    icon: <LayoutDashboard className="h-4 w-4" aria-hidden />,
  },
  {
    order: 3,
    navKey: 'heatmap',
    href: '/heatmap',
    label: 'ヒートマップ',
    icon: <Activity className="h-4 w-4" aria-hidden />,
  },
  {
    order: 4,
    navKey: 'aiseo',
    href: '/aiseo',
    matchPrefixes: ['/aiseo', '/aio', '/llmo', '/exposure'],
    label: 'AISEO',
    badge: 'GA4×AIO',
    icon: <TrendingUp className="h-4 w-4" aria-hidden />,
  },
  {
    order: 5,
    navKey: 'ai-visits',
    href: '/ai-visits',
    matchPrefixes: ['/ai-visits', '/visit-risk', '/journey', '/search-crawlers'],
    label: 'AIアクセス分析',
    icon: <Bot className="h-4 w-4" aria-hidden />,
  },
  {
    order: 6,
    navKey: 'gsc-analysis',
    href: '/seo/access',
    matchPrefixes: ['/seo/access', '/seo/sitemap'],
    label: 'サーチコンソール分析',
    icon: <Search className="h-4 w-4" aria-hidden />,
  },
  {
    order: 7,
    navKey: 'page-performance',
    href: '/fusion',
    label: 'ページパフォーマンス分析',
    icon: <Sparkles className="h-4 w-4" aria-hidden />,
  },
  {
    order: 8,
    navKey: 'path-analysis',
    href: '/paths',
    matchPrefixes: ['/paths', '/personas'],
    label: '経路分析',
    icon: <Network className="h-4 w-4" aria-hidden />,
  },
  {
    order: 9,
    navKey: 'cv-analysis',
    href: '/cv-journey',
    label: 'CV分析',
    icon: <GitBranch className="h-4 w-4" aria-hidden />,
  },
  {
    order: 10,
    navKey: 'internal-link-proposals',
    href: '/seo/internal-links',
    matchPrefixes: ['/seo/internal-links', '/aiseo/analytics/internal-links', '/aiseo/contents/internal-links'],
    label: '内部リンク提案',
    icon: <Link2 className="h-4 w-4" aria-hidden />,
  },
  {
    order: 11,
    navKey: 'site-doc',
    href: '/site-doc',
    label: 'サイトドック',
    badge: '418項目',
    icon: <CheckCircle2 className="h-4 w-4" aria-hidden />,
  },
  {
    order: 12,
    navKey: 'page-speed',
    href: '/performance',
    label: 'ページ速度分析',
    badge: '90ルール',
    icon: <Gauge className="h-4 w-4" aria-hidden />,
  },
  {
    order: 13,
    navKey: 'm-agent',
    href: '/scenarios',
    label: 'M Agent',
    icon: <LayoutGrid className="h-4 w-4" aria-hidden />,
  },
  {
    order: 14,
    navKey: 'ab-experiments',
    href: '/experiments',
    label: 'A/Bテスト',
    badge: '仮説検定',
    icon: <FlaskConical className="h-4 w-4" aria-hidden />,
  },
]

interface AccountNavItem {
  navKey: string
  href: string
  label: string
  icon: ReactNode
}

const ACCOUNT_NAV: ReadonlyArray<AccountNavItem> = [
  {
    navKey: 'install-settings',
    href: '/install',
    label: '設定 / タグ設置',
    icon: <Settings className="h-4 w-4" aria-hidden />,
  },
  {
    navKey: 'heatmap-backfill',
    href: '/operator/heatmap-backfill',
    label: 'スクショ事前生成',
    icon: <Camera className="h-4 w-4" aria-hidden />,
  },
  {
    navKey: 'logout',
    href: '/auth/sign-out',
    label: 'ログアウト',
    icon: <LogOut className="h-4 w-4" aria-hidden />,
  },
]

function isActiveMenu(pathname: string, item: NavItem): boolean {
  // /aiseo/analytics/internal-links は #10 内部リンク提案 を優先アクティブにする
  if (
    item.navKey === 'aiseo' &&
    (pathname.startsWith('/aiseo/analytics/internal-links') ||
      pathname.startsWith('/aiseo/contents/internal-links'))
  ) {
    return false
  }
  const prefixes = item.matchPrefixes ?? [item.href]
  return prefixes.some((p) => (p === '/' ? pathname === '/' : pathname === p || pathname.startsWith(p + '/')))
}

function UnifiedMenuLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const isActive = isActiveMenu(pathname, item)
  const className = `ug-nav-link ${isActive ? 'active' : ''}`.trim()

  return (
    <Link
      href={item.href}
      className={className}
      data-nav={item.navKey}
      data-menu-order={item.order}
      aria-current={isActive ? 'page' : undefined}
      style={
        item.highlight && !isActive
          ? {
              background: 'rgba(255, 255, 255, 0.10)',
              border: '1px solid rgba(255, 255, 255, 0.18)',
              fontWeight: 600,
            }
          : undefined
      }
    >
      {item.icon}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.label}
      </span>
      {item.badge ? (
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            padding: '1px 5px',
            borderRadius: 999,
            background: isActive ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.12)',
            color: 'rgba(255,255,255,0.9)',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            letterSpacing: '-0.01em',
          }}
        >
          {item.badge}
        </span>
      ) : null}
    </Link>
  )
}

export function SidebarNav() {
  const pathname = usePathname() ?? '/'

  const topMenus = UNIFIED_14_MENUS.slice(0, 3) // 1..3: AIチャット, サマリーボード, ヒートマップ
  const aiSearchMenus = UNIFIED_14_MENUS.slice(3, 7) // 4..7: AISEO, AIアクセス分析, サーチコンソール分析, ページパフォーマンス分析
  const journeyLinkMenus = UNIFIED_14_MENUS.slice(7, 10) // 8..10: 経路分析, CV分析, 内部リンク提案
  const auditSpeedMenus = UNIFIED_14_MENUS.slice(10, 12) // 11..12: サイトドック, ページ速度分析
  const actionTestMenus = UNIFIED_14_MENUS.slice(12, 14) // 13..14: M Agent, A/Bテスト

  return (
    <>
      <div className="ug-section-label">AI アナリスト & 全体俯瞰</div>
      <nav
        className="ug-side-nav"
        aria-label="メイン統合ナビゲーション"
        data-pillar-nav="unified-14"
      >
        {topMenus.map((it) => (
          <UnifiedMenuLink key={it.navKey} item={it} pathname={pathname} />
        ))}
      </nav>

      <div className="ug-section-label">AI検索・SEO・URLカルテ</div>
      <nav className="ug-side-nav" aria-label="AI検索・SEOナビゲーション">
        {aiSearchMenus.map((it) => (
          <UnifiedMenuLink key={it.navKey} item={it} pathname={pathname} />
        ))}
      </nav>

      <div className="ug-section-label">回遊・CV・内部リンク</div>
      <nav className="ug-side-nav" aria-label="回遊・CV・内部リンクナビゲーション">
        {journeyLinkMenus.map((it) => (
          <UnifiedMenuLink key={it.navKey} item={it} pathname={pathname} />
        ))}
      </nav>

      <div className="ug-section-label">技術・意味監査 & 速度</div>
      <nav className="ug-side-nav" aria-label="技術・意味監査・速度ナビゲーション">
        {auditSpeedMenus.map((it) => (
          <UnifiedMenuLink key={it.navKey} item={it} pathname={pathname} />
        ))}
      </nav>

      <div className="ug-section-label">施策実行 & 仮説検定</div>
      <nav className="ug-side-nav" aria-label="施策実行・A/Bテストナビゲーション">
        {actionTestMenus.map((it) => (
          <UnifiedMenuLink key={it.navKey} item={it} pathname={pathname} />
        ))}
      </nav>

      <div className="ug-side-flex" />

      <div className="ug-section-label">アカウント</div>
      <nav className="ug-side-nav" aria-label="アカウントナビゲーション">
        {ACCOUNT_NAV.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
          const className = `ug-nav-link ${isActive ? 'active' : ''}`.trim()
          if (item.navKey === 'logout') {
            return (
              <form key={item.navKey} action={item.href} method="post" style={{ display: 'contents' }}>
                <button type="submit" className={className} data-nav={item.navKey}>
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              </form>
            )
          }
          return (
            <Link
              key={item.navKey}
              href={item.href}
              className={className}
              data-nav={item.navKey}
              aria-current={isActive ? 'page' : undefined}
            >
              {item.icon}
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>
    </>
  )
}
