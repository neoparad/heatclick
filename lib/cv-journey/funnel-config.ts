/**
 * CV経路分析 — ファネルステップ定義層（Zod allowlist）
 *
 * 親 SSOT §3.6.5 / docs/cv-journey-implementation-plan.md
 * council 合意: 「自由 SQL 禁止。ステップは Zod で宣言し、サーバ側 allowlist でのみ
 *               windowFunnel 条件に展開する」。値は query_params で束縛し SQL 注入を防ぐ。
 *
 * モックの GA4 風イベント名 (view_item / add_to_cart / purchase) は実スキーマに無いため、
 * 実 `event_type`('pageview'|'conversion') + URL path / conversion_type で表現する。
 * セレクタ/click ベース判定は実列の確認待ち (Phase 1.5)。本 MVP では pageview/conversion のみ
 * SQL 展開対象とし、未対応 match は API 側で警告に降格する。
 */

import { z } from 'zod'

/** allowlist された match 種別（構造のみ。値は別途 param 束縛） */
export const funnelMatchSchema = z.object({
  /** events.event_type の判定軸 */
  type: z.enum(['pageview', 'conversion', 'click']),
  /** url に含まれる path 断片（pageview / click 用）。例: '/p/' '/cart' */
  pathContains: z.string().min(1).max(200).optional(),
  /** events.conversion_type の完全一致（conversion 用）。例: 'add_to_cart' 'purchase' */
  conversionType: z.string().min(1).max(100).optional(),
  /** CSS セレクタ（click 用、Phase 1.5）。MVP では SQL 展開しない */
  selector: z.string().min(1).max(300).optional(),
})

export const funnelStepSchema = z.object({
  /** UI 表示名（日本語可） */
  label: z.string().min(1).max(60),
  /** ノードの種別（描画色・アイコン分岐） */
  kind: z.enum(['source', 'page', 'action', 'conversion']),
  match: funnelMatchSchema,
})

export const funnelConfigSchema = z.object({
  /** 2〜8 ステップ（GA4 同等の上限感） */
  steps: z.array(funnelStepSchema).min(2).max(8),
  /** windowFunnel の窓（秒）。既定 30 分 */
  windowSec: z.number().int().min(60).max(86_400).default(1_800),
})

export type FunnelMatch = z.infer<typeof funnelMatchSchema>
export type FunnelStep = z.infer<typeof funnelStepSchema>
export type FunnelConfig = z.infer<typeof funnelConfigSchema>

/**
 * MVP 標準 EC ファネル。Phase 0 spike [Q1b] の結果で conversion_type を実値に合わせる。
 * 流入メディア(step0)は windowFunnel に含めず attribution dimension として別集計する
 * (council/Codex 合意) ため、ここには含めない。
 */
export const DEFAULT_FUNNEL: FunnelConfig = {
  windowSec: 1_800,
  steps: [
    { label: 'ランディング', kind: 'page', match: { type: 'pageview' } },
    { label: '商品閲覧', kind: 'page', match: { type: 'pageview', pathContains: '/p/' } },
    { label: 'カート追加', kind: 'action', match: { type: 'conversion', conversionType: 'add_to_cart' } },
    { label: '購入完了', kind: 'conversion', match: { type: 'conversion', conversionType: 'purchase' } },
  ],
}

/** 1 ステップ条件の SQL 展開結果 */
export interface StepCondition {
  /** windowFunnel に渡す条件式（query_params 参照のみ。リテラル値を含めない） */
  expr: string
  /** expr が参照する query_params */
  params: Record<string, string>
  /** false の場合 MVP では未対応（API が警告に降格し、該当ステップを除外） */
  supported: boolean
  /** 未対応理由（supported=false 時） */
  reason?: string
}

/**
 * ステップを windowFunnel 条件式へ展開する（**allowlist**）。
 * ユーザー由来の値（pathContains / conversionType）は全て `{sN_*:String}` で束縛し、
 * 式に直接埋め込まない（SQL 注入防止）。
 */
export function buildStepCondition(step: FunnelStep, index: number): StepCondition {
  const { type, pathContains, conversionType, selector } = step.match

  if (type === 'pageview') {
    if (pathContains) {
      const key = `s${index}_path`
      return {
        expr: `event_type = 'pageview' AND position(url, {${key}:String}) > 0`,
        params: { [key]: pathContains },
        supported: true,
      }
    }
    return { expr: `event_type = 'pageview'`, params: {}, supported: true }
  }

  if (type === 'conversion') {
    if (!conversionType) {
      return {
        expr: '',
        params: {},
        supported: false,
        reason: 'conversion ステップには conversionType が必須です',
      }
    }
    const key = `s${index}_cv`
    return {
      expr: `event_type = 'conversion' AND conversion_type = {${key}:String}`,
      params: { [key]: conversionType },
      supported: true,
    }
  }

  // type === 'click'（selector ベース）は実列確認待ちのため MVP 非対応
  return {
    expr: '',
    params: {},
    supported: false,
    reason: `click/selector マッチは MVP 未対応 (Phase 1.5)。selector=${selector ?? ''}`,
  }
}
