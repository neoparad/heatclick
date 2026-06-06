/**
 * P-05 — Persona クラスタ別行動プロファイル
 *
 * 親 SSOT §3.6.5 / Part V §5.5.2 P-05 / §5.5.0 / D-07
 * 起票: decisions.md 続 41 §3 / §6.3 Sprint 2 W2 (5/25-29)
 * 改修: 続 73 (Frontend mockup 再現) — (proof)/layout AppShell 統合、
 *       wrapper を `.ug-page-scroll` + `.ug-page-inner` に置換。
 *       既存 PersonaGrid / PersonaDetail / EvidenceBadge の logic は不変。
 *
 * 切替計画 (Step 1-3、続 41):
 *   Step 1 (現在)   : Marketer S2-04 6 ラベル草案を dummy fixture から表示。
 *   Step 2 (5/27 想定): ML S2-03 完了通知後、`/api/personas?site_id` 経由で
 *                     ClickHouse persona_predictions を fetch、Silhouette ≥ 0.4
 *                     の cluster は 'observed' に昇格。
 *   Step 3 (W2 末)  : D-07 整合最終確認。
 */

'use client'

import { useState } from 'react'
import { Info } from 'lucide-react'

import { PersonaDetail } from '@/components/dashboard/persona-detail'
import { PersonaGrid } from '@/components/dashboard/persona-grid'
import { EvidenceBadge } from '@/components/dashboard/evidence-badge'
import { PageMeta } from '@/components/layout/page-meta'
import { getDummyPersonas, type PersonasData } from '@/lib/fixtures/personas'

export default function PersonasPage() {
  const data: PersonasData = getDummyPersonas()
  const [selectedId, setSelectedId] = useState<string>(data.clusters[0]?.id ?? '')

  const selectedCluster =
    data.clusters.find((c) => c.id === selectedId) ?? data.clusters[0]

  return (
    <div className="ug-page-scroll">
      <div className="ug-page-inner space-y-4">
        {/* 続 75 Task A: title は topbar に集約 */}
        <PageMeta title="Persona クラスタ" eyebrow="Personas · 6 cluster" />
        <PersonasHeader data={data} />

        {data.isDummy ? <DummyBanner /> : null}

        <PersonaGrid
          clusters={data.clusters}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />

        {selectedCluster ? <PersonaDetail cluster={selectedCluster} /> : null}
      </div>
    </div>
  )
}

interface PersonasHeaderProps {
  data: PersonasData
}

function PersonasHeader({ data }: PersonasHeaderProps) {
  return (
    <header className="ug-page-head">
      <div className="ug-page-head-row">
        <div className="sub" style={{ flex: 1 }}>
          <span>
            <strong className="font-semibold text-[color:var(--ug-text)]">{data.siteName}</strong>{' '}
            <span className="mono">{data.siteId}</span>
          </span>
          <span className="mono">{data.global.nClusters} clusters</span>
        </div>
        <div className="actions">
          <EvidenceBadge evidence={data.global.evidence} />
        </div>
      </div>
    </header>
  )
}

/**
 * D-07 整合バナー: 現状 dummy + 全 cluster inferred の旨を可視化。
 * Sprint 2 W2 末で実 ML データに切替後は非表示 (data.isDummy=false)。
 */
function DummyBanner() {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-md border border-[color:var(--ug-yellow)]/30 bg-[color:var(--ug-yellow)]/10 px-4 py-3 text-xs text-foreground"
    >
      <Info
        className="mt-0.5 h-4 w-4 flex-shrink-0 text-[color:var(--ug-yellow)]"
        aria-hidden
      />
      <div className="space-y-1">
        <p className="font-semibold">
          Sprint 2 W2 — Persona dummy モード (ML S2-03 学習完了通知待ち)
        </p>
        <p className="text-[color:var(--ug-text-2)]">
          表示中のクラスタは Marketer S2-04 6 ラベル草案 (5/24 完成) ベースの dummy です。
          全 cluster の Evidence Level は <strong className="font-mono">inferred</strong>、断定数値表記は
          抑制 (D-07)。ML S2-03 学習完了 (5/27 想定) 後、Silhouette ≥ 0.4 の cluster は
          <strong className="font-mono"> observed </strong>
          に昇格し実数値表示を解禁します。
        </p>
      </div>
    </div>
  )
}
