/**
 * EvidenceBadge — AI / ML 出力に必須の根拠レベル表示
 *
 * 親 SSOT §1.6 原則 2 / §1.8.2 / D-07
 *
 * Sprint 1 では P-03 dashboard 配下のみで使用。Sprint 2 以降の AI ページ
 * (P-04 emotion/friction layer, P-05 persona, P-11/P-12 AISEO, P-15/P-16 etc.)
 * でも同じコンポーネントを再利用する想定 (`components/dashboard/` から
 * `components/evidence/` に Sprint 2 で昇格してもよい)。
 */

import { ShieldCheck, Activity, Sparkles, Compass } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import type { EvidenceLevel, EvidenceMeta } from '@/lib/fixtures/dashboard'

interface EvidenceBadgeProps {
  evidence: EvidenceMeta
  /** compact: アイコン + ラベルのみ (細長いコンテキスト用) */
  compact?: boolean
  className?: string
}

const META: Record<EvidenceLevel, { label: string; variant: 'success' | 'warning' | 'secondary' | 'outline'; Icon: typeof ShieldCheck; description: string }> = {
  proven: {
    label: 'Proven',
    variant: 'success',
    Icon: ShieldCheck,
    description: 'A/B + 統計有意 (p<0.05) で実証済み',
  },
  observed: {
    label: 'Observed',
    variant: 'success',
    Icon: Activity,
    description: '実流入データから集計で観測',
  },
  inferred: {
    label: 'Inferred',
    variant: 'warning',
    Icon: Sparkles,
    description: 'LLM / ML の推論 — 実測未確定',
  },
  planned: {
    label: 'Planned',
    variant: 'secondary',
    Icon: Compass,
    description: 'ロードマップ上の予測 — Sprint 2 で実流入切替',
  },
}

export function EvidenceBadge({ evidence, compact, className }: EvidenceBadgeProps) {
  const meta = META[evidence.level]
  const Icon = meta.Icon
  const confidencePct = Math.round(evidence.confidence * 100)

  return (
    <Badge
      variant={meta.variant}
      className={`gap-1.5 ${className ?? ''}`}
      title={`${meta.description}${evidence.confidence > 0 ? ` · confidence ${confidencePct}%` : ''}`}
    >
      <Icon className="h-3 w-3" aria-hidden />
      <span>{meta.label}</span>
      {!compact && evidence.confidence > 0 ? (
        <span className="font-mono text-[10px] opacity-70">{confidencePct}%</span>
      ) : null}
    </Badge>
  )
}
