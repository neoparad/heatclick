/**
 * Path Analysis Agent page — Server entry (続 75 Task B)
 *
 * mockup `linkscrawl/docs/fusion/mockups/11_path_analysis.html`
 * 親 SSOT §3.6.x / §1.7 Anti-Features (セッション録画禁止) / Part V §5.5.x / D-07
 *
 * 配備履歴:
 *   - 続 74 Task B dispatch (Owner 2026-05-24 09:34 JST、sidebar `/paths` active 受け)
 *   - 続 75 (本続) Task B 実装 — Server Component + PathAnalysisCanvas Client orchestrator
 *
 * Server 責務 (本 file):
 *   1. PageMeta (topbar title 流し込み)
 *   2. Phase 1 dogfood dummy fixture (`getDummyPathAnalysis`) を生成
 *   3. PathAnalysisCanvas に data props で渡す
 *
 * Client 責務 (`components/paths/path-analysis-canvas.tsx`):
 *   - sub-tab 切替 (フローキャンバス active のみ、他は disabled)
 *   - trigger + 3 branches の horizontal grid 描画
 *   - 右 pane: AI Insight + chat input (disabled、続 73 /chat に統合)
 *
 * D-07 整合:
 *   - data.isDummy=true / data.branches[].nodes[].stats は全て dummy
 *   - Sprint 4 で events MV 由来の observed_approx に置換 (本 file は変更不要、fixture 差替のみ)
 *
 * §1.7 Anti-Features 整合:
 *   - sequence は events table 由来の集計のみ。セッション録画は本ページで使わない。
 */

import type { Metadata } from 'next'

import { PageMeta } from '@/components/layout/page-meta'
import { PathAnalysisCanvas } from '@/components/paths/path-analysis-canvas'
import { getDummyPathAnalysis } from '@/lib/fixtures/path-analysis'

export const metadata: Metadata = {
  title: '経路分析エージェント — UGOKI MAP',
  robots: { index: false, follow: false },
}

export default function PathsPage() {
  const data = getDummyPathAnalysis()

  return (
    <>
      {/*
        続 78 Task B: 「Path Analysis · 商品購入 3 経路比較」を eyebrow に集約。
        workflow 名は本 page 内 HeadStrip の compact pulldown でも同時提示 (mockup 11 準拠)。
      */}
      <PageMeta title="経路分析エージェント" eyebrow="行動分析 · Path Analysis" />
      <PathAnalysisCanvas data={data} />
    </>
  )
}
