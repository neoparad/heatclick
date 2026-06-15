/**
 * (proof) route group layout — AppShell 統合 (続 73 Task 1)
 *
 * 親 SSOT: 続 55 sidebar SSOT / 続 66 §3 IA / 続 71 (proof route group)
 *
 * すべての proof page (/dashboard, /heatmap, /personas, /chat 等) を共通の
 * 4 ピラー sidebar + topbar shell で wrap する。各 page は shell 内の
 * `ug-main-body` (= AppShell children) に main content をレンダーする。
 *
 * Sprint 3 W2-A 続 73:
 *   - sidebar pillar = 'behavior' 固定 (Phase 1 = 行動分析のみ active)
 *   - site label/code は固定 (Phase 1 dogfood: bihadashop.jp)
 *   - W2-B で site picker drawer + user dropdown + pillar 経路切替
 */

import type { ReactNode } from 'react'

import { AppShell } from '@/components/layout/app-shell'

interface ProofLayoutProps {
  children: ReactNode
}

export default function ProofLayout({ children }: ProofLayoutProps) {
  return (
    <AppShell
      pillar="behavior"
      siteLabel="bihadashop.jp"
      siteCode="CIP_EcwUTHEZdIOAUqum · 7d"
      userName="hiroki"
      userOrg="linkth_internal"
    >
      {children}
    </AppShell>
  )
}
