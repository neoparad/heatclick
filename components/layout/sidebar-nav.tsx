/**
 * SidebarNav — 行動分析配下の nav + 分析セクション + アカウント (続 73 Task 1)
 *
 * mockup `linkscrawl/docs/fusion/mockups/10_ai_chat.html L660-688`
 * 親 SSOT: 続 55 sidebar SSOT (data-nav 値の継承)
 *
 * 行動分析 (7 items、すべて proof route):
 *   ai-chat → /chat
 *   heatmap → /heatmap
 *   session-replay → /sessions  (Phase 1+ で配備予定、Sprint 3 = stub なし)
 *   cv-journey → /cv-journey   (同上)
 *   path-analysis → /path-analysis (同上)
 *   action-tickets → /action-tickets (同上)
 *   site-doc → /site-doc       (同上)
 *
 * 分析セクション (3 items):
 *   performance-behavior → /performance (stub なし)
 *   personas → /personas
 *   pages → /pages
 *
 * アカウント (2 items):
 *   install-settings → /account (settings)
 *   logout → /auth/sign-out
 *
 * usePathname() で active 判定。未配備 page は disabled (cursor-not-allowed) で残す。
 */

'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronRight,
  FileText,
  GitBranch,
  Layers,
  LayoutGrid,
  LogOut,
  MessageCircle,
  Network,
  Play,
  Settings,
  Users,
} from 'lucide-react'
import type { ReactNode } from 'react'

interface NavItem {
  /** data-nav SSOT (続 55 継承) */
  navKey: string
  href: string
  label: string
  icon: ReactNode
  /** Phase 1 未配備 = disabled 表示 (link 無効化、tooltip 表示) */
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
    navKey: 'session-replay',
    href: '/sessions',
    label: 'セッションリプレイ',
    icon: <Play className="h-4 w-4" aria-hidden />,
    disabled: true,
  },
  {
    // CV経路分析 Phase 1 配備で enabled 化 (docs/cv-journey-implementation-plan.md)
    navKey: 'cv-journey',
    href: '/cv-journey',
    label: 'CV経路分析',
    icon: <GitBranch className="h-4 w-4" aria-hidden />,
  },
  {
    // 続 75 Task B: paths/page.tsx 配備で enabled 化、href は /paths (user-specified)
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
    href: '/performance',
    label: 'パフォーマンス × 行動',
    icon: <Activity className="h-3 w-3" aria-hidden />,
    disabled: true,
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

/**
 * 続 83 §4 Day 2 (2026-05-25 M-Director): M Agent pillar 配下 nav。
 * pathname `/scenarios*` のとき PRIMARY_NAV の代わりにこの配列を render する。
 * 既存 behavior pillar 配下 (PRIMARY_NAV) と排他。
 */
const M_AGENT_NAV: ReadonlyArray<NavItem> = [
  {
    navKey: 'targeting-banner',
    href: '/scenarios',
    label: 'ターゲティングバナー',
    icon: <LayoutGrid className="h-4 w-4" aria-hidden />,
  },
  {
    // 2026-06-04 (Owner REQ): CV Bridge / form-tweak scenario type のメニュー枠のみ先行追加。
    //   本実装(form-intervention scenario type の DSL/runtime/計測)は別チケット (banner MVP 後)。
    //   現状は disabled の「準備中」表示 = クリック不可のメニューテキストのみ。
    navKey: 'form-intervention',
    href: '/scenarios/form',
    label: 'フォーム最適化',
    icon: <FileText className="h-4 w-4" aria-hidden />,
    disabled: true,
  },
]

const ACCOUNT_NAV: ReadonlyArray<NavItem> = [
  {
    // 続 75 Task D: app/(proof)/install/page.tsx 配備で enabled 化、href を /install に統一
    navKey: 'install-settings',
    href: '/install',
    label: '設定 / タグ設置',
    icon: <Settings className="h-4 w-4" aria-hidden />,
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

  // 続 119: ログアウトは「状態を変える操作」。GET リンクだと Next.js の自動
  // プリフェッチ (先読み GET) で sign-out が走り「ページ表示だけでログアウト →
  // 次の soft navigation が no_token で弾かれる」事故になる。フォーム POST は
  // プリフェッチ対象外なので、この事故を構造的に封じる (ルート側にもガード有=多層防御)。
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
      // 続 119: 副作用を持つ GET ルート (/auth/sign-out = cookie 削除) を自動
      // プリフェッチさせない。プリフェッチで sign-out が走り「ページ表示だけで
      // ログアウト → 次の soft navigation が no_token で弾かれる」のを防ぐ。
      // ルート側でも prefetch をガード済 (多層防御)。
      prefetch={item.href === '/auth/sign-out' ? false : undefined}
    >
      {item.icon}
      <span>{item.label}</span>
    </Link>
  )
}

/**
 * 続 83 §4 Day 2 (2026-05-25): pathname `/scenarios*` で M Agent pillar 配下表示に切替、
 * それ以外は既存 behavior pillar 配下 (PRIMARY_NAV + ANALYSIS_SUB_NAV) を表示。
 */
function isMAgentPath(pathname: string): boolean {
  return pathname === '/scenarios' || pathname.startsWith('/scenarios/')
}

export function SidebarNav() {
  const pathname = usePathname() ?? '/'
  const mAgentActive = isMAgentPath(pathname)

  return (
    <>
      {mAgentActive ? (
        /* 続 83 §4: M Agent pillar 配下 nav */
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
      ) : (
        <>
          {/* 行動分析配下 7 items */}
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

          {/* 分析セクション label */}
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

      {/* spacer */}
      <div className="ug-side-flex" />

      {/* アカウント section (両 pillar で共通) */}
      <div className="ug-section-label">アカウント</div>
      <nav className="ug-side-nav" aria-label="アカウントナビゲーション">
        {ACCOUNT_NAV.map((it) => (
          <NavLink key={it.navKey} item={it} pathname={pathname} />
        ))}
      </nav>
    </>
  )
}
