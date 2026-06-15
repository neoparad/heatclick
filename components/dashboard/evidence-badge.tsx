/**
 * EvidenceBadge — AI / ML 出力に必須の根拠レベル表示
 *
 * 親 SSOT §1.6 原則 2 / §1.8.2 / D-07
 *
 * Sprint 1 は P-03 dashboard 配下のみで使用。Sprint 2 以降の AI ページ
 * (P-04 emotion/friction layer, P-05 persona, P-11/P-12 AISEO, P-15/P-16 etc.)
 * でも同じコンポーネントを再利用 (`components/dashboard/` → `components/evidence/`
 * への昇格は Sprint 2 で検討、本コンポーネントは API 安定維持を優先)。
 *
 * 続 66 §3 F-2 拡張 (Sprint 3 W2-A):
 *   - 5-tier color gradient (proven_exact / observed_exact / observed_approx / inferred / planned)
 *   - tooltip 強化 (description + CI / errorPct)
 *   - 後方互換: 既存 4-tier `EvidenceMeta` をそのまま受けて V2 にマップ表示
 *   - 新規 5-tier: `levelV2` 明示 prop で W2-A ML 出力をネイティブ表示
 *
 * 既存 16 箇所の呼出 (dashboard / persona / heatmap / chat 等) は無変更で
 * 引き続き動作する (`evidence: EvidenceMeta` API を維持)。
 */

import { ShieldCheck, Activity, TrendingUp, Sparkles, Compass } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { EvidenceLevel, EvidenceMeta } from '@/lib/fixtures/dashboard'
import { type EvidenceLevelV2, toEvidenceLevelV2 } from '@/types/evidence'

interface EvidenceBadgeProps {
  /** 既存 4-tier API。`levelV2` 未指定時の primary source。 */
  evidence: EvidenceMeta
  /**
   * 5-tier 明示 override (続 66 §3 F-2)。
   * ML W2-A tools が返す `evidence_level` を直接渡すパスで利用。
   * 未指定時は `evidence.level` を `toEvidenceLevelV2()` で写像。
   */
  levelV2?: EvidenceLevelV2
  /** Confidence Interval (5-tier 表示で tooltip に追記) */
  ci?: { low: number; high: number }
  /** 近似誤差 % (observed_approx の場合に "±X%" 表示) */
  errorPct?: number
  /** compact: アイコン + ラベルのみ (細長いコンテキスト用) */
  compact?: boolean
  className?: string
}

interface TierStyle {
  label: string
  /** Badge variant (既存 shadcn variants にマップ) */
  variant: 'success' | 'warning' | 'secondary' | 'outline' | 'default'
  /** 追加クラス (5-tier color gradient 用、shadcn variant の補完) */
  extraClass: string
  Icon: typeof ShieldCheck
  description: string
}

/**
 * 5-tier visual styling.
 *
 * Color gradient (Tailwind tokens、確実度 高→低):
 *   proven_exact    : emerald (success)        — 強い緑
 *   observed_exact  : sky (info)               — 青
 *   observed_approx : amber (近似だが実測)     — 黄系
 *   inferred        : orange/warning           — 推論注意
 *   planned         : neutral / outline        — 計画 / 仮説
 *
 * shadcn variant が限定的なので `extraClass` で hex に近い色を補完。
 * D-07: `inferred` / `planned` は警告色寄りで「数値断定禁止」を視覚的に伝える。
 */
const TIER_STYLES_V2: Record<EvidenceLevelV2, TierStyle> = {
  proven_exact: {
    label: 'Proven',
    variant: 'success',
    extraClass:
      'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    Icon: ShieldCheck,
    description: '確定 — Raw events で exact 検証済 (proven_exact)',
  },
  observed_exact: {
    label: 'Observed',
    variant: 'default',
    extraClass: 'border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300',
    Icon: Activity,
    description: '観測 — 集計テーブルから exact 取得 (observed_exact)',
  },
  observed_approx: {
    label: 'Observed≈',
    variant: 'warning',
    extraClass: 'border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-300',
    Icon: TrendingUp,
    description: '近似 — HyperLogLog / TDigest 近似 (observed_approx、誤差 〜2%)',
  },
  inferred: {
    label: 'Inferred',
    variant: 'warning',
    extraClass:
      'border-orange-500/40 bg-orange-500/15 text-orange-800 dark:text-orange-300',
    Icon: Sparkles,
    description: '推定 — LLM / ML の推論 (inferred、実測未確定)',
  },
  planned: {
    label: 'Planned',
    variant: 'outline',
    extraClass: 'border-border bg-muted/60 text-text-2',
    Icon: Compass,
    description: '計画 — 予測 / 仮説 (planned、ロードマップ上)',
  },
}

export function EvidenceBadge({
  evidence,
  levelV2,
  ci,
  errorPct,
  compact,
  className,
}: EvidenceBadgeProps) {
  const resolvedV2: EvidenceLevelV2 = levelV2 ?? toEvidenceLevelV2(evidence.level)
  const tier = TIER_STYLES_V2[resolvedV2]
  const Icon = tier.Icon
  const confidencePct = Math.round(evidence.confidence * 100)

  // tooltip 構築 (5-tier description + confidence + CI + errorPct)
  const tooltipParts: string[] = [tier.description]
  if (evidence.confidence > 0) {
    tooltipParts.push(`confidence ${confidencePct}%`)
  }
  if (ci) {
    tooltipParts.push(`CI 95%: [${ci.low.toFixed(2)}, ${ci.high.toFixed(2)}]`)
  }
  if (typeof errorPct === 'number') {
    tooltipParts.push(`±${errorPct.toFixed(1)}%`)
  }
  const tooltip = tooltipParts.join(' · ')

  // legacy V1 label を data attr に残す (E2E / 既存集計 query 互換)
  const legacyV1: EvidenceLevel =
    resolvedV2 === 'proven_exact'
      ? 'proven'
      : resolvedV2 === 'observed_exact' || resolvedV2 === 'observed_approx'
        ? 'observed'
        : resolvedV2

  return (
    <Badge
      variant={tier.variant}
      className={cn('gap-1.5 border', tier.extraClass, className)}
      title={tooltip}
      data-evidence-level={resolvedV2}
      data-evidence-level-v1={legacyV1}
      aria-label={`Evidence ${tier.label} — ${tier.description}`}
    >
      <Icon className="h-3 w-3" aria-hidden />
      <span>{tier.label}</span>
      {!compact && evidence.confidence > 0 ? (
        <span className="font-mono text-[10px] opacity-70">{confidencePct}%</span>
      ) : null}
      {!compact && typeof errorPct === 'number' ? (
        <span className="font-mono text-[10px] opacity-70">±{errorPct.toFixed(1)}%</span>
      ) : null}
    </Badge>
  )
}
