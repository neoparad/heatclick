/**
 * SidebarNav — 行動分析配下の nav + M Agent + AISEO / AIアクセス + アカウント
 */

'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import {
  Activity,
  Bot,
  Camera,
  CheckCircle2,
  ChevronRight,
  Compass,
  FileText,
  GitBranch,
  Globe,
  Layers,
  LayoutGrid,
  Link2,
  LogOut,
  MessageCircle,
  Network,
  Play,
  Radar,
  Search,
  Settings,
  ShieldAlert,
  Sparkles,
  Users,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { isAiseoPath } from './sidebar-pillar'

interface NavItem {
  navKey: string
  href: string
  label: string
  icon: ReactNode
  disabled?: boolean
}

const PRIMARY_NAV: ReadonlyArray<NavItem> = [
  {
    navKey: 'ai-chat',
    href: '/chat',
    label: 'AIチャット',
    icon: <MessageCircle className="h-4 w-4" aria-hidden />,
  },
  {
    navKey: 'heatmap',
    href: '/heatmap',
    label: 'ヒートマップ',
    icon: <Activity className="h-4 w-4" aria-hidden />,
  },
  {
    navKey: 'fusion-cross',
    href: '/fusion',
    label: '行動 × 構造 統合診断',
    icon: <Sparkles className="h-4 w-4" aria-hidden />,
  },
  {
    navKey: 'session-replay',
    href: '/sessions',
    label: 'セッションリプレイ',
    icon: <Play className="h-4 w-4" aria-hidden />,
    disabled: true,
  },
  {
    navKey: 'cv-journey',
    href: '/cv-journey',
    label: 'CV経路分析',
    icon: <GitBranch className="h-4 w-4" aria-hidden />,
  },
  {
    navKey: 'path-analysis',
    href: '/paths',
    label: '経路分析エージェント',
    icon: <Network className="h-4 w-4" aria-hidden />,
  },
  {
    navKey: 'action-tickets',
    href: '/action-tickets',
    label: 'AI提案チケット',
    icon: <Bot className="h-4 w-4" aria-hidden />,
    disabled: true,
  },
  {
    navKey: 'site-doc',
    href: '/site-doc',
    label: 'サイトドック',
    icon: <CheckCircle2 className="h-4 w-4" aria-hidden />,
    disabled: true,
  },
]

const ANALYSIS_SUB_NAV: ReadonlyArray<NavItem> = [
  {
    navKey: 'performance-behavior',
    href: '/fusion',
    label: 'パフォーマンス × 行動',
    icon: <Activity className="h-3 w-3" aria-hidden />,
  },
  {
    navKey: 'personas',
    href: '/personas',
    label: 'ペルソナ',
    icon: <Users className="h-3 w-3" aria-hidden />,
  },
  {
    navKey: 'pages',
    href: '/pages',
    label: 'ページ一覧',
    icon: <FileText className="h-3 w-3" aria-hidden />,
    disabled: true,
  },
]

const M_AGENT_NAV: ReadonlyArray<NavItem> = [
  {
    navKey: 'targeting-banner',
    href: '/scenarios',
    label: 'ターゲティングバナー',
    icon: <LayoutGrid className="h-4 w-4" aria-hidden />,
  },
  {
    navKey: 'form-intervention',
    href: '/scenarios/form',
    label: 'フォーム最適化',
    icon: <FileText className="h-4 w-4" aria-hidden />,
    disabled: true,
  },
]

const AISEO_FUSION_NAV: ReadonlyArray<NavItem> = [
  {
    navKey: 'fusion-url-summary',
    href: '/fusion',
    label: '行動×構造×AI 4平面統合',
    icon: <Sparkles className="h-4 w-4" aria-hidden />,
  },
]

const AISEO_AI_VISITS_NAV: ReadonlyArray<NavItem> = [
  {
    navKey: 'ai-visits',
    href: '/ai-visits',
    label: 'AI訪問状況',
    icon: <Bot className="h-4 w-4" aria-hidden />,
  },
  {
    navKey: 'visit-risk',
    href: '/visit-risk',
    label: 'AI訪問リスク・宣言監査',
    icon: <ShieldAlert className="h-4 w-4" aria-hidden />,
  },
  {
    navKey: 'journey',
    href: '/journey',
    label: 'AIの巡回ルート',
    icon: <Compass className="h-4 w-4" aria-hidden />,
  },
  {
    navKey: 'search-crawlers',
    href: '/search-crawlers',
    label: '検索エンジン巡回',
    icon: <Radar className="h-4 w-4" aria-hidden />,
  },
]

const AISEO_SEO_NAV: ReadonlyArray<NavItem> = [
  {
    navKey: 'seo-access',
    href: '/seo/access',
    label: 'GSC アクセス数分析',
    icon: <Search className="h-4 w-4" aria-hidden />,
  },
  {
    navKey: 'seo-sitemap',
    href: '/seo/sitemap',
    label: 'サイトマップ・Index状況',
    icon: <Globe className="h-4 w-4" aria-hidden />,
  },
  {
    navKey: 'seo-internal-links',
    href: '/seo/internal-links',
    label: '内部リンク構造',
    icon: <Network className="h-4 w-4" aria-hidden />,
  },
  {
    navKey: 'aiseo-internal-link-proposals',
    href: '/aiseo/analytics/internal-links',
    label: '内部リンク改善提案',
    icon: <Link2 className="h-4 w-4" aria-hidden />,
  },
]

const ACCOUNT_NAV: ReadonlyArray<NavItem> = [
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

function isActiveLink(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
}

function NavLink({
  item,
  pathname,
  variant = 'primary',
}: {
  item: NavItem
  pathname: string
  variant?: 'primary' | 'sub'
}) {
  const baseClass = variant === 'sub' ? 'ug-sub-link' : 'ug-nav-link'
  const isActive = !item.disabled && isActiveLink(pathname, item.href)
  const className = `${baseClass} ${isActive ? 'active' : ''}`.trim()

  if (item.disabled) {
    return (
      <span
        className={className}
        data-nav={item.navKey}
        aria-disabled="true"
        title={`${item.label} (準備中)`}
        style={{ opacity: 0.55, cursor: 'not-allowed' }}
      >
        {item.icon}
        <span>{item.label}</span>
      </span>
    )
  }

  if (item.navKey === 'logout') {
    return (
      <form action={item.href} method="post" style={{ display: 'contents' }}>
        <button type="submit" className={className} data-nav={item.navKey}>
          {item.icon}
          <span>{item.label}</span>
        </button>
      </form>
    )
  }

  return (
    <Link
      href={item.href}
      className={className}
      data-nav={item.navKey}
      aria-current={isActive ? 'page' : undefined}
      prefetch={item.href === '/auth/sign-out' ? false : undefined}
    >
      {item.icon}
      <span>{item.label}</span>
    </Link>
  )
}

function isMAgentPath(pathname: string): boolean {
  return pathname === '/scenarios' || pathname.startsWith('/scenarios/')
}

export function SidebarNav() {
  const pathname = usePathname() ?? '/'
  const mAgentActive = isMAgentPath(pathname)
  const aiseoActive = isAiseoPath(pathname)

  return (
    <>
      {mAgentActive ? (
        <nav
          className="ug-side-nav"
          style={{ paddingTop: 8 }}
          aria-label="M Agent ナビゲーション"
          data-pillar-nav="m-agent"
        >
          {M_AGENT_NAV.map((it) => (
            <NavLink key={it.navKey} item={it} pathname={pathname} />
          ))}
        </nav>
      ) : aiseoActive ? (
        <>
          <div className="ug-section-label">融合インサイト</div>
          <nav
            className="ug-side-nav"
            aria-label="融合インサイトナビゲーション"
            data-pillar-nav="aiseo"
          >
            {AISEO_FUSION_NAV.map((it) => (
              <NavLink key={it.navKey} item={it} pathname={pathname} />
            ))}
          </nav>

          <div className="ug-section-label">AIアクセス観測 (AIreceipt)</div>
          <nav className="ug-side-nav" aria-label="AIアクセスナビゲーション">
            {AISEO_AI_VISITS_NAV.map((it) => (
              <NavLink key={it.navKey} item={it} pathname={pathname} />
            ))}
          </nav>

          <div className="ug-section-label">SEO・構造分析 (GSC / linkscrawl)</div>
          <nav className="ug-side-nav" aria-label="SEO構造分析ナビゲーション">
            {AISEO_SEO_NAV.map((it) => (
              <NavLink key={it.navKey} item={it} pathname={pathname} />
            ))}
          </nav>
        </>
      ) : (
        <>
          <nav
            className="ug-side-nav"
            style={{ paddingTop: 8 }}
            aria-label="行動分析ナビゲーション"
            data-pillar-nav="behavior"
          >
            {PRIMARY_NAV.map((it) => (
              <NavLink key={it.navKey} item={it} pathname={pathname} />
            ))}
          </nav>

          <div className="ug-section-label">分析</div>
          <nav className="ug-side-nav" aria-label="分析ナビゲーション">
            <div className="ug-nav-link" aria-hidden style={{ cursor: 'default' }}>
              <Layers className="h-4 w-4" aria-hidden />
              <span>分析</span>
              <ChevronRight
                className="h-3 w-3 ml-auto opacity-60"
                style={{ transform: 'rotate(90deg)' }}
                aria-hidden
              />
            </div>
            <div className="ug-side-sub">
              {ANALYSIS_SUB_NAV.map((it) => (
                <NavLink key={it.navKey} item={it} pathname={pathname} variant="sub" />
              ))}
            </div>
          </nav>
        </>
      )}

      <div className="ug-side-flex" />

      <div className="ug-section-label">アカウント</div>
      <nav className="ug-side-nav" aria-label="アカウントナビゲーション">
        {ACCOUNT_NAV.map((it) => (
          <NavLink key={it.navKey} item={it} pathname={pathname} />
        ))}
      </nav>
    </>
  )
}
