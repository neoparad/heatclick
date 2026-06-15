/**
 * AppShell — 4 ピラー + nav + topbar + main の shell layout (続 73 Task 1)
 *
 * mockup `linkscrawl/docs/fusion/mockups/10_ai_chat.html L627-705` (`.app` shell)
 * 親 SSOT: 続 66 §3 IA SSOT (sidebar + main 2-col、agency + proof 双方が使う)
 *
 * 責務:
 *   1. sidebar (gradient brand) + main (topbar + body) の grid layout
 *   2. sidebar 3 state toggle (expanded / collapsed / hidden) を localStorage で永続化
 *   3. mobile (< 768px) は default hidden + hamburger toggle で overlay 表示
 *   4. children には main body (= 各 page の content) を受ける
 *
 * Sprint 3 W2-A (本続 73) 範囲:
 *   - sidebar の SidebarPillar (4 pillar) + SidebarNav (行動分析/分析/アカウント) を統合
 *   - topbar は固定 brand + tracking active pill のみ (page-meta は children 側でカスタム可)
 *   - SiteSwitcher は本続 73 範囲外、固定 chip 表示のみ (W2-B で実 site picker drawer)
 */

'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Menu, PanelLeftClose } from 'lucide-react'

import { usePageMeta } from '@/lib/page-meta-store'

import { SidebarNav } from './sidebar-nav'
import { SidebarPillar } from './sidebar-pillar'

interface AppShellProps {
  children: ReactNode
  /**
   * 続 75 Task A: page 側は `<PageMeta title=... eyebrow=... />` (page-meta.tsx)
   * を render することで topbar に title を流し込める。下記 props は
   * 旧 layout (続 73) との後方互換用、新規 page では使わない。
   */
  pageEyebrow?: string
  pageTitle?: string
  /** 現在の active site (sidebar の固定 chip 表示用、Phase 1 = bihadashop.jp 固定) */
  siteLabel?: string
  siteCode?: string
  /** Phase 1 dogfood ユーザー表示 (sidebar 下部) */
  userName?: string
  userOrg?: string
  /** active pillar (続 73 範囲は behavior 固定) */
  pillar?: 'behavior' | 'm-agent' | 'aiseo' | 'custom-bi'
}

type SidebarState = 'expanded' | 'collapsed' | 'hidden'
const STATE_KEY = 'ugokimap_sidebar_state'

function readState(): SidebarState {
  if (typeof window === 'undefined') return 'expanded'
  const raw = window.localStorage.getItem(STATE_KEY)
  if (raw === 'collapsed' || raw === 'hidden') return raw
  return 'expanded'
}

export function AppShell({
  children,
  pageEyebrow,
  pageTitle,
  siteLabel = 'bihadashop.jp',
  siteCode = 'CIP_EcwUTHEZdIOAUqum · 7d',
  userName = 'hiroki',
  userOrg = 'linkth_internal',
  pillar = 'behavior',
}: AppShellProps) {
  const [sbState, setSbState] = useState<SidebarState>('expanded')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setSbState(readState())
    setHydrated(true)
  }, [])

  const persistState = useCallback((next: SidebarState) => {
    setSbState(next)
    try {
      window.localStorage.setItem(STATE_KEY, next)
    } catch {
      // localStorage 不可な環境は session のみ
    }
  }, [])

  const cycleSidebar = useCallback(() => {
    // expanded → collapsed → hidden → expanded
    persistState(
      sbState === 'expanded' ? 'collapsed' : sbState === 'collapsed' ? 'hidden' : 'expanded',
    )
  }, [sbState, persistState])

  // Ctrl/Cmd + B でトグル
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        cycleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cycleSidebar])

  const userInitial = (userName || 'U').slice(0, 1).toUpperCase()
  const siteInitial = (siteLabel || 'S').slice(0, 1).toUpperCase()

  // 続 75 Task A: PageMeta から差し込まれた title を優先、なければ続 73 互換の props を使う
  const liveMeta = usePageMeta()
  const effectiveTitle = liveMeta.title ?? pageTitle
  const effectiveEyebrow = liveMeta.eyebrow ?? pageEyebrow

  // SSR でも一貫した class を出力 (hydration mismatch 回避)
  const appClass = `ug-app${hydrated && sbState !== 'expanded' ? ` ${sbState}` : ''}${mobileOpen ? ' mobile-open' : ''}`

  return (
    <div className={appClass} id="ug-app">
      <aside className="ug-sidebar" aria-label="主要ナビゲーション">
        <div className="ug-sidebar-brand">
          <div className="ug-brand-mark">U</div>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15, minWidth: 0 }}>
            <span style={{ color: '#fff', fontWeight: 700, fontSize: 14.5, letterSpacing: '-0.015em' }}>
              UGOKI MAP
            </span>
            <span
              style={{
                color: 'rgba(255,255,255,.72)',
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 10.5,
                fontWeight: 500,
                textTransform: 'lowercase',
                marginTop: 1,
              }}
            >
              behavior · v0.1
            </span>
          </div>
        </div>

        {/* 固定の site chip (W2-B で picker drawer 化) */}
        <div
          className="ug-product-link"
          style={{
            margin: '4px 12px 14px',
            padding: '9px 10px',
            border: '1px solid rgba(255,255,255,.14)',
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            background: 'rgba(255,255,255,.08)',
            cursor: 'default',
            fontSize: 12.5,
          }}
          title="Phase 1: site picker は W2-B で配備予定"
        >
          <span
            className="ug-ps-icon"
            style={{
              width: 20,
              height: 20,
              borderRadius: 5,
              background: 'linear-gradient(135deg, #4cb782, #2c8f5f)',
              fontSize: 10.5,
              fontWeight: 700,
            }}
          >
            {siteInitial}
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1, minWidth: 0, flex: 1 }}>
            <b style={{ fontWeight: 600, fontSize: 12.5, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {siteLabel}
            </b>
            <span
              style={{
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 10,
                color: 'rgba(255,255,255,.7)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {siteCode}
            </span>
          </div>
        </div>

        <SidebarPillar active={pillar} />
        <SidebarNav />

        <div className="ug-footer-user">
          <div className="ug-avatar-chip">{userInitial}</div>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontSize: 12.5, color: '#fff', fontWeight: 600, lineHeight: 1.2 }}>
              {userName}
            </span>
            <span
              style={{
                fontSize: 10.5,
                color: 'rgba(255,255,255,.7)',
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                marginTop: 1,
              }}
            >
              {userOrg}
            </span>
          </div>
          <span className="ug-kbd">⌘K</span>
        </div>
      </aside>

      {/* mobile overlay 背景 (sidebar open 時のみ) */}
      {mobileOpen ? (
        <button
          type="button"
          aria-label="サイドバーを閉じる"
          onClick={() => setMobileOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 40,
            background: 'rgba(15,17,23,.32)',
            border: 0,
            display: 'block',
          }}
          className="md:hidden"
        />
      ) : null}

      <main className="ug-main">
        <div className="ug-topbar">
          {/* desktop: cycle sidebar / mobile: hamburger */}
          <button
            type="button"
            className="ug-sb-toggle hidden md:inline-flex"
            onClick={cycleSidebar}
            title="サイドバー切替 (Ctrl+B)"
            aria-label="サイドバー切替"
          >
            <PanelLeftClose className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            className="ug-sb-toggle md:hidden"
            onClick={() => setMobileOpen((v) => !v)}
            title="メニュー"
            aria-label="メニュー切替"
            aria-expanded={mobileOpen}
          >
            <Menu className="h-3.5 w-3.5" aria-hidden />
          </button>

          {effectiveTitle ? (
            <div className="ug-page-meta">
              {effectiveEyebrow ? (
                <div className="ug-page-meta-eyebrow">{effectiveEyebrow}</div>
              ) : null}
              <div className="ug-page-meta-title">{effectiveTitle}</div>
            </div>
          ) : null}

          <div style={{ flex: 1 }} />
          <span className="ug-pill">
            <span className="ug-pill-pulse" />
            tracking active
          </span>
        </div>

        <div className="ug-main-body">{children}</div>
      </main>
    </div>
  )
}
