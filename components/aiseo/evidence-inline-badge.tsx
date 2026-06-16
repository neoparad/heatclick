/**
 * AISEO Phase 1: Evidence Level inline badge (軽量版)
 *
 * AISEO-Director SSOT: decisions.md 続 AISEO-1 / CLAUDE.md §4
 *
 * 既存 `components/dashboard/evidence-badge.tsx` は heatmap/personas 用 (icon + tooltip)、
 * 本 component は AISEO table cell 内に inline 配置できる軽量版。Phase 1 では
 * Analytics/Contents の全 row が `inferred` 固定だが、Phase 2 で per-proposal に変動するため
 * 個別 cell で表示できる粒度にしておく。
 *
 * 親 SSOT §1.8.2 / D-07: `inferred` / `planned` の場合は断定数値表示禁止 (本 component は
 * level 表示のみ、数値表示は呼出側で制御する責務)。
 */

import type { EvidenceLevel } from '@/lib/aiseo/types'

interface EvidenceInlineBadgeProps {
  level: EvidenceLevel
}

const LEVEL_STYLE: Record<EvidenceLevel, { label: string; className: string }> = {
  proven: {
    label: 'proven',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  observed: {
    label: 'observed',
    className: 'bg-sky-50 text-sky-700 border-sky-200',
  },
  inferred: {
    label: 'inferred',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  planned: {
    label: 'planned',
    className: 'bg-slate-100 text-slate-600 border-slate-200',
  },
}

export function EvidenceInlineBadge({ level }: EvidenceInlineBadgeProps) {
  const { label, className } = LEVEL_STYLE[level]
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${className}`}
      data-evidence-level={level}
      aria-label={`Evidence Level: ${label}`}
    >
      {label}
    </span>
  )
}
