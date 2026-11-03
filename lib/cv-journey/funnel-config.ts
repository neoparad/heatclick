/**
 * CV経路分析 — ファネルステップ定義層（Zod allowlist）
 *
 * 親 SSOT §3.6.5 / docs/cv-journey-implementation-plan.md
 * council 合意: 「自由 SQL 禁止。ステップは Zod で宣言し、サーバ側 allowlist でのみ
 *               windowFunnel 条件に展開する」。値は query_params で束縛し SQL 注入を防ぐ。
 *
 * モックの GA4 風イベント名 (view_item / add_to_cart / purchase) は実スキーマに無いため、
 * 実 `event_type`('pageview') + URL path / conversion_type で表現する。
 * セレクタ/click ベース判定は実列の確認待ち (Phase 1.5)。本 MVP では pageview/conversion のみ
 * SQL 展開対象とし、未対応 match は API 側で警告に降格する。
 *
 * 実データ契約 (paths Sprint 4-B 実CH検証 2026-07 で確定):
 *   - conversion_type は event_type='click' 行に載る (event_type='conversion' は本番0件)。
 *     event_type を固定すると構造的に0件になるため、conversion 判定は conversion_type 単独一致。
 *   - events の文字列列 (event_type / url / conversion_type) は Nullable。windowFunnel は
 *     条件に NULL が1つでも混ざると reached=NULL でセッション全体が脱落するため、
 *     全条件式を ifNull(..., '') で NULL-safe にする。
 */

import { z } from 'zod'

import { buildCvKeyResolutionPredicate } from '@/lib/conversions/predicate'
import type { CvScope, CvTrigger } from '@/lib/conversions/types'

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
 *
 * ⚠ 実サイト (bihadashop) の実 conversion_type は affiliate_rakuten/amazon/qoo10/other で、
 *   add_to_cart / purchase は実データに存在しない (EC でなくアフィリエイトサイトのため)。
 *   既定ファネルの見直しは CV 計測復旧後の別タスク (docs/heatmap/IMPLEMENTATION_PLAN.md 参照)。
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

/** buildStepCondition が cvKey 解決に使う定義の最小形 (lib/conversions/repository.ts の CvDefinition から射影) */
export interface CvDefinitionForResolution {
  trigger: CvTrigger
  scope?: CvScope
}

/**
 * ステップを windowFunnel 条件式へ展開する（**allowlist**）。
 * ユーザー由来の値（pathContains / conversionType）は全て `{sN_*:String}` で束縛し、
 * 式に直接埋め込まない（SQL 注入防止）。
 *
 * C2 (docs/cv/CV_DEFINITIONS_DESIGN.md §7): conversion ステップの conversionType が
 * サイトの CV定義 cvKey と一致すれば、その定義の述語を **和集合** (定義述語 OR 生
 * conversion_type一致) で解決する。cvDefinitionsByKey 未指定/該当なしは完全後方互換
 * (従来通り生 conversion_type 単独一致)。
 */
export function buildStepCondition(
  step: FunnelStep,
  index: number,
  cvDefinitionsByKey?: ReadonlyMap<string, CvDefinitionForResolution>,
): StepCondition {
  const { type, pathContains, conversionType, selector } = step.match

  if (type === 'pageview') {
    if (pathContains) {
      const key = `s${index}_path`
      return {
        expr: `ifNull(event_type, '') = 'pageview' AND position(ifNull(url, ''), {${key}:String}) > 0`,
        params: { [key]: pathContains },
        supported: true,
      }
    }
    return { expr: `ifNull(event_type, '') = 'pageview'`, params: {}, supported: true }
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

    const definition = cvDefinitionsByKey?.get(conversionType)
    if (definition) {
      const resolved = buildCvKeyResolutionPredicate(
        { trigger: definition.trigger, scope: definition.scope, cvKey: conversionType },
        key,
      )
      return { expr: resolved.expr, params: resolved.params, supported: true }
    }

    // conversion_type 単独一致 (event_type を固定しない)。実データでは conversion_type は
    // click 行に載っており、event_type='conversion' を AND すると構造的に必ず0件になる
    // (paths Sprint 4-B と同じ罠)。将来 trackConversion 経由の行 (event_type='conversion')
    // が来てもこの条件に一致する。
    return {
      expr: `ifNull(conversion_type, '') = {${key}:String}`,
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
