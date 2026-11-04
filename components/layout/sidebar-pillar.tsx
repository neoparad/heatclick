/**
 * SidebarPillar — 旧4ピラー上部切替コンポーネントの廃止ラッパー (Lane 4: 14メニュー統合左サイドバー化)
 *
 * オーナー決定仕様:
 *   上部でピラー（行動分析 / M Agent / AISEO）を切り替えないとメニューが見えない方式を廃止し、
 *   ログイン直後から左サイドバーに全14メニューが一望できる統合ナビゲーションへ刷新。
 *   AppShell との互換性のためコンポーネント自体は null を返し、ヘルパー関数を維持する。
 */

'use client'

export interface SidebarPillarProps {
  active?: 'behavior' | 'm-agent' | 'aiseo' | 'custom-bi'
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
  '/site-doc',
  '/performance',
]

export function isAiseoPath(pathname: string | null): boolean {
  if (!pathname) return false
  return AISEO_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'))
}

export function SidebarPillar(_props: SidebarPillarProps): null {
  return null
}
