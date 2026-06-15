/**
 * 宝プロジェクト — 標準実験 taxonomy (最重要 / これが死ぬと横断プールが無価値化)
 *
 * Reference:
 *   - linkscrawl/docs/fusion/team/handoff/2026-06-10-ugokimap-treasure-ab-pooling-module.md
 *     §作る5コンポーネント #2 (施策 taxonomy)
 *   - linkscrawl/docs/fusion/team/decisions.md D-12 (§1.7.1 carve-out: mechanical 標準実験のみ自前実行)
 *   - .claude/plans/sim_pooling_power.py (プール検証: 密なセル内・低異質性が前提)
 *
 * 鉄則 (壊すと資産が無価値):
 *   - intervention_type は **mechanical のみ**。コピー・訴求・価格は転移しないため永久に対象外。
 *   - 横断プールのセル = intervention_type × page_type × industry × device。
 *     同一 primary_metric のセル内でのみ logRR をプールする (混ぜると異質性で死ぬ)。
 *   - enum への追加 = 新しいプール分断。strategy 承認なしに足さない (taxonomy governance)。
 *   - taxonomy は実験 running 遷移時にロックし以後不変 (事前登録)。lib/experiments/types.ts で強制。
 */

import { z } from 'zod'

// ── intervention_type: mechanical 施策のみ ───────────────────────────────────
// mechanical = レイアウト/構造の変更で、サイト横断で転移する種類。
// コピー・価格・訴求 (転移しない) は **意図的に除外**。追加は strategy 承認必須。
export const INTERVENTION_TYPES = [
  'cta_placement', // 主要 CTA を first view 内へ移動
  'sticky_cta_mobile', // モバイルで固定スティッキー CTA バー
  'form_field_reduction', // フォームの任意項目を削減
] as const
export type InterventionType = (typeof INTERVENTION_TYPES)[number]

// mechanical 保証のための forbidden トークン (test と runtime の二重ガード)。
// これらの語が intervention_type に現れたら「非 mechanical 混入」= 即停止。
export const NON_MECHANICAL_TOKENS = [
  'copy',
  'price',
  'pricing',
  'headline',
  'discount',
  'offer',
  'wording',
  'message',
] as const

// 起動時ガード (Codex MEDIUM): test だけに頼らず import 時にも mechanical-only を強制。
// enum に非 mechanical トークンが混入したら即 throw = fail-fast (横断プールの心臓を守る)。
for (const interventionType of INTERVENTION_TYPES) {
  for (const forbidden of NON_MECHANICAL_TOKENS) {
    if (interventionType.includes(forbidden)) {
      throw new Error(
        `INTERVENTION_TYPES contains non-mechanical token "${forbidden}" in "${interventionType}" — mechanical 施策のみ許可`,
      )
    }
  }
}

// ── page_type ────────────────────────────────────────────────────────────────
export const PAGE_TYPES = ['product', 'lp', 'form', 'category', 'article', 'checkout'] as const
export type PageType = (typeof PAGE_TYPES)[number]

// ── industry ─────────────────────────────────────────────────────────────────
export const INDUSTRIES = ['d2c_ec', 'saas', 'lead_gen', 'media', 'local_service'] as const
export type Industry = (typeof INDUSTRIES)[number]

// ── device ───────────────────────────────────────────────────────────────────
// 'unknown' は **含めない**。device 不明セッションは横断プールに混ぜない (異質性管理)。
export const DEVICES = ['mobile', 'desktop', 'tablet'] as const
export type Device = (typeof DEVICES)[number]

// ── primary_metric: arm 比較の主要指標 (ratio: numerator/denominator over sessions) ──
export const PRIMARY_METRICS = ['cvr', 'cta_click_rate', 'form_submit_rate'] as const
export type PrimaryMetric = (typeof PRIMARY_METRICS)[number]

// ── window: 標準化された計測期間長 (横断比較の可比性のため) ────────────────────
export const EXPERIMENT_WINDOWS = ['14d', '28d', '56d'] as const
export type ExperimentWindow = (typeof EXPERIMENT_WINDOWS)[number]

export const WINDOW_DAYS: Readonly<Record<ExperimentWindow, number>> = {
  '14d': 14,
  '28d': 28,
  '56d': 56,
}

// ── Zod enum schemas (API 境界 / registry で再利用) ───────────────────────────
export const InterventionTypeSchema = z.enum(INTERVENTION_TYPES)
export const PageTypeSchema = z.enum(PAGE_TYPES)
export const IndustrySchema = z.enum(INDUSTRIES)
export const DeviceSchema = z.enum(DEVICES)
export const PrimaryMetricSchema = z.enum(PRIMARY_METRICS)
export const ExperimentWindowSchema = z.enum(EXPERIMENT_WINDOWS)

// ── pooling cell (handoff: type × page_type × industry × device) ──────────────
export interface CellDimensions {
  intervention_type: InterventionType
  page_type: PageType
  industry: Industry
  device: Device
}

// enum 値は [a-z0-9_] のみ → '|' は安全な区切り。
export const CELL_KEY_SEPARATOR = '|'

export function cellKey(dims: CellDimensions): string {
  return [dims.intervention_type, dims.page_type, dims.industry, dims.device].join(CELL_KEY_SEPARATOR)
}

export function parseCellKey(key: string): CellDimensions | null {
  const parts = key.split(CELL_KEY_SEPARATOR)
  if (parts.length !== 4) return null
  const parsed = z
    .object({
      intervention_type: InterventionTypeSchema,
      page_type: PageTypeSchema,
      industry: IndustrySchema,
      device: DeviceSchema,
    })
    .safeParse({
      intervention_type: parts[0],
      page_type: parts[1],
      industry: parts[2],
      device: parts[3],
    })
  return parsed.success ? parsed.data : null
}
