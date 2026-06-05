/**
 * lib/llm/analytics-tools.ts — 4 Tools (overview/contributors/drilldown/verify) (続 68 W2-A、続 66 §3 M-1)
 *
 * 親 SSOT §3.8.1 tenant isolation / CLAUDE.md tenant isolation
 * 配備根拠: Codex Round 1+2+3 + 続 66 §2 Layer 2 (4 Tools) + 続 64 §2 (c) IDOR 防御継承
 *
 * 設計 (続 64 hardening 1:1 継承):
 *   1. tool input schema に `siteId` を含めない (declarative defense)
 *   2. caller 規約: `executeAnalyticsTool(name, input, ctx)` で `ctx.requestSiteId` を server-side 固定
 *   3. 各 tool execute で `canAccessSite(ctx, fixedSiteId)` 再認可 (`ToolIDORError` throw)
 *   4. parentQueryId enforcement: `contributors` / `drilldown` / `verify` は必須
 *
 * Tool 規格:
 *   - 各 tool は `{ name, description, inputSchema, execute }` の object
 *   - execute は `(input, execCtx) => Promise<ToolResult>` 形式
 *   - AI SDK v6 `tool()` 互換シェイプ (将来の `ai` package 導入時に `tool({...})` でラップ可)
 *
 * Sprint 3 W2-A での結線:
 *   - `orchestrator.ts` (M-4) が `executeAnalyticsTool()` を tool callback として呼ぶ
 *   - tool 失敗時の error は `ToolIDORError` (403) / `ToolValidationError` (400) / `Error` (500) のいずれか
 *   - 全 tool 結果に `evidenceLevelV2` + `parentQueryId` (overview のみ生成) を含める
 */

import { z } from 'zod'

import { canAccessSite, type TenantContext } from '@/lib/tenant'
import { ToolIDORError, ToolValidationError } from '@/lib/llm/tools'
import {
  ANALYTICS_METRICS,
  METRICS_METRICS,
  METRICS_DIMENSIONS,
  TIMESERIES_METRICS,
  executeAnalyticsQuery,
  executeContributorsQuery,
  executeDrilldownQuery,
  executeVerifyQuery,
  executeTopPagesQuery,
  executeScrollDepthQuery,
  executeAttentionQuery,
  executeDeviceBreakdownQuery,
  executeMetricsQuery,
  executeTimeseriesQuery,
  executeFormAnalysisQuery,
  executeFrustrationQuery,
  executePerformanceQuery,
  executeCtaFunnelQuery,
  getParentQuery,
  MAX_PERIOD_DAYS_ANALYTICS,
  registerParentQuery,
  type AnalyticsQueryResult,
  type ContributorsResult,
  type DrilldownResult,
  type VerifyResult,
  type TopPagesResult,
  type ScrollDepthResult,
  type AttentionResult,
  type DeviceBreakdownResult,
  type MetricsResult,
  type TimeseriesResult,
  type FormAnalysisResult,
  type FrustrationResult,
  type PerformanceResult,
  type CtaFunnelResult,
} from '@/lib/llm/hybrid-query'

// ── Tool 1: analytics.overview ──────────────────────────────────────

/**
 * 期間全体の baseline metric を取得。後続 contributors/drilldown/verify の親 query。
 *
 * Input schema (続 64 §2c 継承: **siteId 含めない**):
 *   - dateRange.start / .end (ISO 8601)
 *   - metrics: AnalyticsMetric の subset
 *   - timezone: default 'Asia/Tokyo' (W2-B で tenant_settings.timezone 連携)
 *
 * Output:
 *   - queryId (後続 tool 必須)
 *   - summary (sessions / conversions / cvr / page_views) — 続 78 Task B: bounce_rate / avg_duration は削除
 *   - tier ('hourly' / 'daily' / 'monthly')
 *   - evidenceLevel 'observed_approx' (uniqCombined64 等の近似集計使用)
 *   - approxErrorPct (誤差目安 %)
 *   - approximation (使った近似関数名、audit 用)
 */
export const overviewInputSchema = z.object({
  dateRange: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  metrics: z.array(z.enum([...ANALYTICS_METRICS])).min(1).max(ANALYTICS_METRICS.length),
  timezone: z.string().default('Asia/Tokyo'),
})
export type OverviewInput = z.infer<typeof overviewInputSchema>

export interface OverviewResult {
  queryId: string
  summary: AnalyticsQueryResult['summary']
  tier: AnalyticsQueryResult['tier']
  evidenceLevel: AnalyticsQueryResult['evidenceLevel']
  approxErrorPct: AnalyticsQueryResult['approxErrorPct']
  approximation: AnalyticsQueryResult['approximation']
}

// ── Tool 2: analytics.contributors ──────────────────────────────────

export const contributorsInputSchema = z.object({
  parentQueryId: z.string().uuid(),
  // 続 80: persona は S2-03 別 table 配備まで unsupported
  // 続 82-ml skeleton: utm_source / visitor_type 追加 (Infra 完了 + MV dim 配備後に実データ返却)
  dimension: z.enum(['page_url', 'device', 'utm_source', 'visitor_type']),
  limit: z.number().int().min(5).max(100).default(20),
  minDenominator: z.number().int().min(1).default(30),
})
export type ContributorsInput = z.infer<typeof contributorsInputSchema>

export interface ContributorsToolResult {
  contributors: ContributorsResult['top']
  other: ContributorsResult['other']
  coveragePct: number
  excludedLowVolume: number
  evidenceLevel: ContributorsResult['evidenceLevel']
}

// ── Tool 3: analytics.drilldown ─────────────────────────────────────

export const drilldownInputSchema = z.object({
  parentQueryId: z.string().uuid(),
  // 続 80: persona は S2-03 別 table 配備まで unsupported
  // 続 82-ml skeleton: utm_source / visitor_type 追加
  dimension: z.enum(['page_url', 'device', 'utm_source', 'visitor_type']),
  value: z.string().min(1),
  // 続 78 Task B: 'bounce_rate' を削除 (続 67 D-1 schema 整合、events table に is_bounce 列なし)
  // 続 82-ml skeleton: drilldown は MV 経由のため bounce_rate 復活には MV revival が必須 → Phase 2 で追加
  metric: z.enum(['cvr', 'sessions']).default('cvr'),
  window: z
    .object({
      start: z.string().min(1),
      end: z.string().min(1),
    })
    .optional(),
  grain: z.enum(['hour', 'day']).default('hour'),
})
export type DrilldownInput = z.infer<typeof drilldownInputSchema>

export interface DrilldownToolResult {
  series: DrilldownResult['series']
  anomalies: DrilldownResult['anomalies']
  grain: DrilldownResult['grain']
  evidenceLevel: DrilldownResult['evidenceLevel']
}

// ── Tool 4: analytics.verify ────────────────────────────────────────

export const verifyInputSchema = z.object({
  parentQueryId: z.string().uuid(),
  claim: z.object({
    // 続 78 Task B: 'bounce_rate' を削除 (続 67 D-1 schema 整合)
    // 続 82-ml Phase 2 (2026-05-25): Infra 続 82 で session_duration_sec / page_views_in_session 列が
    //   events table に追加されたため bounce_rate / avg_session_duration を verify でも raw exact 再計算可能。
    metric: z.enum(['cvr', 'sessions', 'page_views', 'bounce_rate', 'avg_session_duration']),
    value: z.number().finite(),
    filter: z.record(z.string()).default({}),
  }),
  tolerancePct: z.number().min(0.1).max(20).default(2.0),
})
export type VerifyInput = z.infer<typeof verifyInputSchema>

export interface VerifyToolResult {
  claimedValue: number
  exactValue: number
  withinTolerance: boolean
  tolerancePct: number
  evidenceLevel: VerifyResult['evidenceLevel']
}

// ── Tool 5: analytics_top_pages ─────────────────────────────────────

/**
 * Standalone: 指定期間の人気ページ (pageview / session 数) を返す。
 * parentQueryId 不要。siteId / tenantId は server-controlled (execCtx 由来)。
 */
export const topPagesInputSchema = z.object({
  dateRange: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  timezone: z.string().default('Asia/Tokyo'),
  limit: z.number().int().min(5).max(50).default(10),
})
export type TopPagesInput = z.infer<typeof topPagesInputSchema>

export interface TopPagesToolResult {
  rows: TopPagesResult['rows']
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: TopPagesResult['evidenceLevel']
  note: string
}

// ── Tool 6: analytics_scroll_depth ──────────────────────────────────

export const scrollDepthInputSchema = z.object({
  dateRange: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  timezone: z.string().default('Asia/Tokyo'),
  /** フィルタするページ URL (省略時はサイト全体) */
  page_url: z.string().min(1).optional(),
  /** スクロール深度バンド幅 (px) */
  bandPx: z.number().int().min(100).max(2000).default(500),
})
export type ScrollDepthInput = z.infer<typeof scrollDepthInputSchema>

export interface ScrollDepthToolResult {
  bands: ScrollDepthResult['bands']
  total_sessions: number
  page_url: string | null
  band_px: number
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: ScrollDepthResult['evidenceLevel']
  note: string
}

// ── Tool 7: analytics_attention ──────────────────────────────────────

export const attentionInputSchema = z.object({
  dateRange: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  timezone: z.string().default('Asia/Tokyo'),
  page_url: z.string().min(1).optional(),
  bandPx: z.number().int().min(100).max(2000).default(500),
})
export type AttentionInput = z.infer<typeof attentionInputSchema>

export interface AttentionToolResult {
  bands: AttentionResult['bands']
  page_url: string | null
  band_px: number
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: AttentionResult['evidenceLevel']
  note: string
}

// ── Tool 8: analytics_device_breakdown ──────────────────────────────

export const deviceBreakdownInputSchema = z.object({
  dateRange: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  timezone: z.string().default('Asia/Tokyo'),
})
export type DeviceBreakdownInput = z.infer<typeof deviceBreakdownInputSchema>

export interface DeviceBreakdownToolResult {
  rows: DeviceBreakdownResult['rows']
  total_sessions: number
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: DeviceBreakdownResult['evidenceLevel']
  note: string
}

// ── Tool 9: analytics_metrics ───────────────────────────────────────

/**
 * 汎用メトリクス: metric × dimension × filter × date-range。
 * siteId/tenantId は server 固定 (続 64 §2c 継承)。
 * Standalone — parentQueryId 不要。
 *
 * 使いどころ:
 *   - "X by Y" (例: "ページ別 CVR") → analytics_metrics(metric=cvr, dimension=page_url)
 *   - 単一合計 → dimension=none
 *   - セグメント比較 → dimension=device_type / utm_source など
 */
export const metricsInputSchema = z.object({
  dateRange: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  timezone: z.string().default('Asia/Tokyo'),
  metric: z.enum([...METRICS_METRICS] as [string, ...string[]]).transform((v) => v as (typeof METRICS_METRICS)[number]),
  dimension: z.enum([...METRICS_DIMENSIONS] as [string, ...string[]]).default('none').transform((v) => v as (typeof METRICS_DIMENSIONS)[number]),
  /** ページ URL フィルタ (省略時はサイト全体) */
  page_url: z.string().min(1).optional(),
  /** デバイスタイプフィルタ (例: 'mobile', 'desktop') */
  device_type: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(20),
})
export type MetricsInput = z.infer<typeof metricsInputSchema>

export interface MetricsToolResult {
  metric: MetricsResult['metric']
  dimension: MetricsResult['dimension']
  rows: MetricsResult['rows']
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: MetricsResult['evidenceLevel']
  note: string
}

// ── Tool 10: analytics_timeseries ────────────────────────────────────

/**
 * 1 metric の時系列。CVR 時系列推移 / セッション推移など「X の時系列」質問に使う。
 * Standalone — parentQueryId 不要。siteId は server 固定。
 */
export const timeseriesInputSchema = z.object({
  dateRange: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  timezone: z.string().default('Asia/Tokyo'),
  metric: z.enum([...TIMESERIES_METRICS] as [string, ...string[]]).transform((v) => v as (typeof TIMESERIES_METRICS)[number]),
  grain: z.enum(['day', 'hour']).default('day'),
})
export type TimeseriesInput = z.infer<typeof timeseriesInputSchema>

export interface TimeseriesToolResult {
  metric: TimeseriesResult['metric']
  grain: TimeseriesResult['grain']
  points: TimeseriesResult['points']
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: TimeseriesResult['evidenceLevel']
  note: string
}

// ── Tool 11: analytics_form_analysis ─────────────────────────────────

/**
 * フォーム分析: form_interactions テーブルから per-form / per-field の
 * 開始数・完了数・完了率・離脱率・最終フィールド分布・平均フィールド滞在時間を返す。
 * Standalone — parentQueryId 不要。siteId は server 固定。
 */
export const formAnalysisInputSchema = z.object({
  dateRange: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  timezone: z.string().default('Asia/Tokyo'),
  /** フィルタする form_id (省略時は全フォーム) */
  form_id: z.string().min(1).optional(),
  /** フィルタするページ URL (省略時は全ページ) */
  page_url: z.string().min(1).optional(),
})
export type FormAnalysisInput = z.infer<typeof formAnalysisInputSchema>

export interface FormAnalysisToolResult {
  forms: FormAnalysisResult['forms']
  fields: FormAnalysisResult['fields']
  last_field_distribution: FormAnalysisResult['last_field_distribution']
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: FormAnalysisResult['evidenceLevel']
  note: string
}

// ── Tool 12: analytics_frustration ───────────────────────────────────

/**
 * 欲求不満シグナル合成スコア: events (dead_click/rage_click) + behavior_signals を合成。
 * per-page または全体の frustration_score を返す。
 * Standalone — parentQueryId 不要。siteId は server 固定。
 */
export const frustrationInputSchema = z.object({
  dateRange: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  timezone: z.string().default('Asia/Tokyo'),
  /** フィルタするページ URL (省略時は全ページ) */
  page_url: z.string().min(1).optional(),
})
export type FrustrationInput = z.infer<typeof frustrationInputSchema>

export interface FrustrationToolResult {
  rows: FrustrationResult['rows']
  total: FrustrationResult['total']
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: FrustrationResult['evidenceLevel']
  note: string
}

// ── Tool 13: analytics_performance ───────────────────────────────────

/**
 * Web Vitals p75 パフォーマンス分析: LCP/INP/CLS/TTFB/FCP の p75 + Core Web Vitals 評価。
 * page_url または device_type でフィルタ・グループ化可能。
 * Standalone — parentQueryId 不要。siteId は server 固定。
 */
export const performanceInputSchema = z.object({
  dateRange: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  timezone: z.string().default('Asia/Tokyo'),
  /** フィルタするページ URL (省略時はサイト全体) */
  page_url: z.string().min(1).optional(),
  /** フィルタするデバイスタイプ (例: 'mobile', 'desktop') */
  device: z.string().min(1).optional(),
})
export type PerformanceInput = z.infer<typeof performanceInputSchema>

export interface PerformanceToolResult {
  rows: PerformanceResult['rows']
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: PerformanceResult['evidenceLevel']
  note: string
}

// ── Tool 14: analytics_cta_funnel ────────────────────────────────────

/**
 * CTA ファネル: element_visibility_v2 露出 × events click を element_selector キーで近似結合し
 * per-CTA の impressions / clicks / CTR を返す。
 * Standalone — parentQueryId 不要。siteId は server 固定。
 */
export const ctaFunnelInputSchema = z.object({
  dateRange: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  timezone: z.string().default('Asia/Tokyo'),
  /** フィルタするページ URL (省略時は全ページ) */
  page_url: z.string().min(1).optional(),
})
export type CtaFunnelInput = z.infer<typeof ctaFunnelInputSchema>

export interface CtaFunnelToolResult {
  rows: CtaFunnelResult['rows']
  approximation_note: string
  conversion_note: string
  periodStart: string
  periodEnd: string
  timezone: string
  evidenceLevel: CtaFunnelResult['evidenceLevel']
  note: string
}

// ── Tool registry (declarative + executor) ──────────────────────────

export interface AnalyticsToolExecuteContext {
  ctx: TenantContext
  /** request body 由来の検証済 siteId (LLM 入力から採用しない、続 64 §2c 継承) */
  requestSiteId: string
}

export type AnalyticsToolName =
  | 'analytics.overview'
  | 'analytics.contributors'
  | 'analytics.drilldown'
  | 'analytics.verify'
  | 'analytics_top_pages'
  | 'analytics_scroll_depth'
  | 'analytics_attention'
  | 'analytics_device_breakdown'
  | 'analytics_metrics'
  | 'analytics_timeseries'
  | 'analytics_form_analysis'
  | 'analytics_frustration'
  | 'analytics_performance'
  | 'analytics_cta_funnel'

export type AnalyticsToolResult =
  | { tool: 'analytics.overview'; result: OverviewResult }
  | { tool: 'analytics.contributors'; result: ContributorsToolResult }
  | { tool: 'analytics.drilldown'; result: DrilldownToolResult }
  | { tool: 'analytics.verify'; result: VerifyToolResult }
  | { tool: 'analytics_top_pages'; result: TopPagesToolResult }
  | { tool: 'analytics_scroll_depth'; result: ScrollDepthToolResult }
  | { tool: 'analytics_attention'; result: AttentionToolResult }
  | { tool: 'analytics_device_breakdown'; result: DeviceBreakdownToolResult }
  | { tool: 'analytics_metrics'; result: MetricsToolResult }
  | { tool: 'analytics_timeseries'; result: TimeseriesToolResult }
  | { tool: 'analytics_form_analysis'; result: FormAnalysisToolResult }
  | { tool: 'analytics_frustration'; result: FrustrationToolResult }
  | { tool: 'analytics_performance'; result: PerformanceToolResult }
  | { tool: 'analytics_cta_funnel'; result: CtaFunnelToolResult }

/**
 * 公開 tool schema list (AI SDK v6 `tool()` 互換シェイプ)。
 *
 * **重要**: `inputSchema` に `siteId` を含めない (続 64 §2c declarative defense)。
 * LLM が余計な `siteId` を出してきても executor が破棄 + server-side `requestSiteId` で上書き。
 */
export const ANALYTICS_TOOL_SCHEMAS = [
  {
    name: 'analytics.overview' as const,
    description:
      'Aggregate metric for active site within a date range. Returns queryId which subsequent ' +
      'analytics.contributors / drilldown / verify tools require. siteId is server-controlled (do NOT include in tool input).',
    inputSchema: overviewInputSchema,
  },
  {
    name: 'analytics.contributors' as const,
    description:
      'Top contributing dim_values for the parent query, with __other__ bucket and coverage %. ' +
      'parentQueryId from analytics.overview is required.',
    inputSchema: contributorsInputSchema,
  },
  {
    name: 'analytics.drilldown' as const,
    description:
      'Time-series + anomaly detection for a specific dim_value (e.g. /pricing). ' +
      'parentQueryId from analytics.overview is required.',
    inputSchema: drilldownInputSchema,
  },
  {
    name: 'analytics.verify' as const,
    description:
      'Re-compute a claim with raw events (proven_exact). Use when downstream consumers need ' +
      'audit-grade certainty. parentQueryId is required.',
    inputSchema: verifyInputSchema,
  },
  {
    name: 'analytics_top_pages' as const,
    description:
      'Popular pages ranked by unique sessions and pageviews for the active site within a date range. ' +
      'Standalone — no parentQueryId required. siteId is server-controlled (do NOT include in tool input).',
    inputSchema: topPagesInputSchema,
  },
  {
    name: 'analytics_scroll_depth' as const,
    description:
      'Per-session max scroll depth distribution in pixel bands. Returns cumulative reach% per band so you can say ' +
      '"X% of sessions scrolled past N px". Optional page_url to filter to a single page. ' +
      'Standalone — no parentQueryId required. siteId is server-controlled.',
    inputSchema: scrollDepthInputSchema,
  },
  {
    name: 'analytics_attention' as const,
    description:
      'Read/dwell density by page depth (read_area events). Shows which vertical segments of a page are actually read. ' +
      'Optional page_url filter. Standalone — no parentQueryId required. siteId is server-controlled.',
    inputSchema: attentionInputSchema,
  },
  {
    name: 'analytics_device_breakdown' as const,
    description:
      'Device type split (mobile/desktop/tablet/unknown) by sessions and pageviews with share_pct per device. ' +
      'Standalone — no parentQueryId required. siteId is server-controlled.',
    inputSchema: deviceBreakdownInputSchema,
  },
  {
    name: 'analytics_metrics' as const,
    description:
      'Generic metric × dimension workhorse. Use this for "X by Y" questions (e.g. CVR by page, sessions by device). ' +
      'Supports metrics: sessions, pageviews, visitors, new_visitors, returning_visitors, clicks, dead_clicks, rage_clicks, conversions, cvr, revenue, avg_scroll_depth, bounce_rate, avg_session_duration. ' +
      'Dimensions: none (single total), page_url, device_type, referrer_type, utm_source, utm_medium, utm_campaign, visitor_type, conversion_type, hour, day_of_week, day, month. ' +
      'Optional filters: page_url (filter to one page), device_type. ' +
      'Standalone — no parentQueryId required. siteId is server-controlled.',
    inputSchema: metricsInputSchema,
  },
  {
    name: 'analytics_timeseries' as const,
    description:
      'Time series for one metric over the whole site. Use for trend questions like "CVRの時系列推移", "セッション推移", "コンバージョン推移". ' +
      'Metrics: sessions, pageviews, conversions, cvr, clicks. Grain: day (default) or hour. ' +
      'Returns ordered time-bucketed points in Asia/Tokyo timezone. ' +
      'Standalone — no parentQueryId required. siteId is server-controlled.',
    inputSchema: timeseriesInputSchema,
  },
  {
    name: 'analytics_form_analysis' as const,
    description:
      'Form completion funnel analysis from form_interactions table. ' +
      'Returns per-form starts/submits/completion_rate/abandonment_rate, per-field touches and avg_field_duration_ms, ' +
      'and last_field abandonment distribution (which field users abandon on). ' +
      'Use for questions like "フォーム完了率", "どのフィールドで離脱しているか", "フォームの入力摩擦". ' +
      'Optional filters: form_id (specific form), page_url (specific page). ' +
      'Standalone — no parentQueryId required. siteId is server-controlled.',
    inputSchema: formAnalysisInputSchema,
  },
  {
    name: 'analytics_frustration' as const,
    description:
      'Frustration signal composite score per page. Combines dead_click and rage_click counts from events table ' +
      'with reversal_count, tab_switch_count, pinch_zoom_count, away_duration_ms, hover_no_click from behavior_signals table. ' +
      'Returns per-page frustration_score (normalized by sessions) and a site-wide total. ' +
      'Use for questions like "フラストレーションが高いページ", "ユーザーが不満を感じているページ", "デッドクリック/レイジクリック分析". ' +
      'Optional filter: page_url (specific page). ' +
      'Standalone — no parentQueryId required. siteId is server-controlled.',
    inputSchema: frustrationInputSchema,
  },
  {
    name: 'analytics_performance' as const,
    description:
      'Core Web Vitals p75 analysis from web_vitals table. ' +
      'Returns p75 for LCP, INP, CLS, TTFB, FCP with Good/NeedsImprovement/Poor ratings per Google CWV standards. ' +
      'Optional filters: page_url (specific page), device (specific device type e.g. "mobile"/"desktop"). ' +
      'Use for questions like "ページ速度", "LCP遅延", "Core Web Vitals", "パフォーマンス改善". ' +
      'Standalone — no parentQueryId required. siteId is server-controlled.',
    inputSchema: performanceInputSchema,
  },
  {
    name: 'analytics_cta_funnel' as const,
    description:
      'CTA exposure-to-click funnel from element_visibility_v2 (impressions) and events (clicks). ' +
      'Returns per-CTA impressions, clicks, and approximate CTR keyed by element_selector (+page_url). ' +
      'Approximation: exposure and click counts are joined by element_selector key (not strict session-order join), ' +
      'so CTR may be slightly overestimated. Conversion leg not included (bihadashop has no conversion events). ' +
      'Use for questions like "CTAのクリック率", "どのCTAが見られているが押されていないか", "ボタン効果測定". ' +
      'Optional filter: page_url (specific page). ' +
      'Standalone — no parentQueryId required. siteId is server-controlled.',
    inputSchema: ctaFunnelInputSchema,
  },
] as const

// ── Authorization gate (続 64 §2c continuation) ─────────────────────

/**
 * tool execute 前に必ず呼ぶ authorization gate。
 * - `fixedSiteId` (server-controlled) が tenant の site_ids に含まれるか再確認
 * - 違反時は `ToolIDORError` (status 403) を throw
 */
function authorize(execCtx: AnalyticsToolExecuteContext, toolName: AnalyticsToolName): void {
  if (!canAccessSite(execCtx.ctx, execCtx.requestSiteId)) {
    throw new ToolIDORError(execCtx.ctx.tenant_id, execCtx.requestSiteId, toolName)
  }
}

// ── Executor (dispatcher、IDOR + Zod + parentQueryId enforcement) ───

/**
 * Tool 実行 entrypoint。
 *
 * 順序 (続 64 §2c の defense in depth):
 *   1. authorize (canAccessSite で 403 即弾き)
 *   2. Zod parse (input shape 強制、不正 metric/dimension は 400)
 *   3. parentQueryId 検証 (overview 以外、tenant 越え試行は ToolIDORError)
 *   4. ClickHouse query 実行
 *   5. 結果を server-controlled な構造で返却
 *
 * @throws ToolIDORError cross-tenant access のとき (403)
 * @throws ToolValidationError tool input が不正 / parentQueryId 不在のとき (400)
 */
export async function executeAnalyticsTool(
  toolName: AnalyticsToolName,
  rawLlmInput: unknown,
  execCtx: AnalyticsToolExecuteContext,
): Promise<AnalyticsToolResult> {
  authorize(execCtx, toolName)

  switch (toolName) {
    case 'analytics.overview': {
      const input = parseToolInput(overviewInputSchema, rawLlmInput, toolName)
      enforcePeriodDays(input.dateRange, toolName)

      const queryInput = {
        siteId: execCtx.requestSiteId, // server-controlled
        tenantId: execCtx.ctx.tenant_id, // server-controlled (LLM から採用しない)
        dim: 'all' as const,
        dimValue: '__all__',
        dateRange: input.dateRange,
        metrics: input.metrics,
        timezone: input.timezone,
      }
      const queryResult = await executeAnalyticsQuery(queryInput)
      const queryId = registerParentQuery(execCtx.ctx.tenant_id, queryInput, queryResult)

      return {
        tool: 'analytics.overview',
        result: {
          queryId,
          summary: queryResult.summary,
          tier: queryResult.tier,
          evidenceLevel: queryResult.evidenceLevel,
          approxErrorPct: queryResult.approxErrorPct,
          approximation: queryResult.approximation,
        },
      }
    }

    case 'analytics.contributors': {
      const input = parseToolInput(contributorsInputSchema, rawLlmInput, toolName)
      const parent = requireParent(execCtx.ctx, input.parentQueryId, toolName)

      // tenant_id / site_id は parent に登録済の server-controlled 値を使う
      // (LLM が今 turn で違う siteId を持っていた場合でも parent が正規)
      const contribResult = await executeContributorsQuery({
        parent: parent.input,
        dimension: input.dimension,
        limit: input.limit,
        minDenominator: input.minDenominator,
      })

      return {
        tool: 'analytics.contributors',
        result: {
          contributors: contribResult.top,
          other: contribResult.other,
          coveragePct: contribResult.coveragePct,
          excludedLowVolume: contribResult.excludedLowVolumeCount,
          evidenceLevel: contribResult.evidenceLevel,
        },
      }
    }

    case 'analytics.drilldown': {
      const input = parseToolInput(drilldownInputSchema, rawLlmInput, toolName)
      const parent = requireParent(execCtx.ctx, input.parentQueryId, toolName)

      const drillResult = await executeDrilldownQuery({
        parent: parent.input,
        dimension: input.dimension,
        value: input.value,
        window: input.window,
        grain: input.grain,
        metric: input.metric,
      })

      return {
        tool: 'analytics.drilldown',
        result: {
          series: drillResult.series,
          anomalies: drillResult.anomalies,
          grain: drillResult.grain,
          evidenceLevel: drillResult.evidenceLevel,
        },
      }
    }

    case 'analytics.verify': {
      const input = parseToolInput(verifyInputSchema, rawLlmInput, toolName)
      const parent = requireParent(execCtx.ctx, input.parentQueryId, toolName)

      // 続 82-ml Codex T1 fix #2 (isolation): verify は execCtx.requestSiteId を exec site として
      //   raw events を再計算するが、parent (overview) が登録された siteId と異なると、
      //   同一 tenant 内の cross-site 混在 (例: site_A の overview を親に site_B の verify) を
      //   silently 許してしまう。parent.input.siteId と requestSiteId の不一致を明示的に拒否する。
      //   authorize() と同じ ToolIDORError (403) を throw (同一 tenant でも別 site への越境は IDOR)。
      if (parent.input.siteId !== execCtx.requestSiteId) {
        throw new ToolIDORError(execCtx.ctx.tenant_id, execCtx.requestSiteId, toolName)
      }

      const verifyResult = await executeVerifyQuery({
        tenantId: execCtx.ctx.tenant_id, // server-controlled
        siteId: execCtx.requestSiteId,   // server-controlled (parent.siteId と一致を上で検証済)
        metric: input.claim.metric,
        filter: input.claim.filter,
        claimedValue: input.claim.value,
        dateRange: parent.input.dateRange,
        timezone: parent.input.timezone,
        tolerancePct: input.tolerancePct,
      })

      return {
        tool: 'analytics.verify',
        result: {
          claimedValue: verifyResult.claimedValue,
          exactValue: verifyResult.exactValue,
          withinTolerance: verifyResult.withinTolerance,
          tolerancePct: verifyResult.tolerancePct,
          evidenceLevel: verifyResult.evidenceLevel,
        },
      }
    }

    case 'analytics_top_pages': {
      const input = parseToolInput(topPagesInputSchema, rawLlmInput, toolName)
      enforcePeriodDays(input.dateRange, toolName)

      const queryResult = await executeTopPagesQuery({
        tenantId: execCtx.ctx.tenant_id,   // server-controlled
        siteId: execCtx.requestSiteId,      // server-controlled
        dateRange: input.dateRange,
        timezone: input.timezone,
        limit: input.limit,
      })

      return {
        tool: 'analytics_top_pages',
        result: {
          rows: queryResult.rows,
          periodStart: queryResult.periodStart,
          periodEnd: queryResult.periodEnd,
          timezone: queryResult.timezone,
          evidenceLevel: queryResult.evidenceLevel,
          note: queryResult.note,
        },
      }
    }

    case 'analytics_scroll_depth': {
      const input = parseToolInput(scrollDepthInputSchema, rawLlmInput, toolName)
      enforcePeriodDays(input.dateRange, toolName)

      const queryResult = await executeScrollDepthQuery({
        tenantId: execCtx.ctx.tenant_id,
        siteId: execCtx.requestSiteId,
        dateRange: input.dateRange,
        timezone: input.timezone,
        pageUrl: input.page_url,
        bandPx: input.bandPx,
      })

      return {
        tool: 'analytics_scroll_depth',
        result: {
          bands: queryResult.bands,
          total_sessions: queryResult.total_sessions,
          page_url: queryResult.page_url,
          band_px: queryResult.band_px,
          periodStart: queryResult.periodStart,
          periodEnd: queryResult.periodEnd,
          timezone: queryResult.timezone,
          evidenceLevel: queryResult.evidenceLevel,
          note: queryResult.note,
        },
      }
    }

    case 'analytics_attention': {
      const input = parseToolInput(attentionInputSchema, rawLlmInput, toolName)
      enforcePeriodDays(input.dateRange, toolName)

      const queryResult = await executeAttentionQuery({
        tenantId: execCtx.ctx.tenant_id,
        siteId: execCtx.requestSiteId,
        dateRange: input.dateRange,
        timezone: input.timezone,
        pageUrl: input.page_url,
        bandPx: input.bandPx,
      })

      return {
        tool: 'analytics_attention',
        result: {
          bands: queryResult.bands,
          page_url: queryResult.page_url,
          band_px: queryResult.band_px,
          periodStart: queryResult.periodStart,
          periodEnd: queryResult.periodEnd,
          timezone: queryResult.timezone,
          evidenceLevel: queryResult.evidenceLevel,
          note: queryResult.note,
        },
      }
    }

    case 'analytics_device_breakdown': {
      const input = parseToolInput(deviceBreakdownInputSchema, rawLlmInput, toolName)
      enforcePeriodDays(input.dateRange, toolName)

      const queryResult = await executeDeviceBreakdownQuery({
        tenantId: execCtx.ctx.tenant_id,
        siteId: execCtx.requestSiteId,
        dateRange: input.dateRange,
        timezone: input.timezone,
      })

      return {
        tool: 'analytics_device_breakdown',
        result: {
          rows: queryResult.rows,
          total_sessions: queryResult.total_sessions,
          periodStart: queryResult.periodStart,
          periodEnd: queryResult.periodEnd,
          timezone: queryResult.timezone,
          evidenceLevel: queryResult.evidenceLevel,
          note: queryResult.note,
        },
      }
    }

    case 'analytics_metrics': {
      const input = parseToolInput(metricsInputSchema, rawLlmInput, toolName)
      enforcePeriodDays(input.dateRange, toolName)

      const queryResult = await executeMetricsQuery({
        tenantId: execCtx.ctx.tenant_id,   // server-controlled
        siteId: execCtx.requestSiteId,      // server-controlled
        dateRange: input.dateRange,
        timezone: input.timezone,
        metric: input.metric,
        dimension: input.dimension,
        pageUrl: input.page_url,
        deviceType: input.device_type,
        limit: input.limit,
      })

      return {
        tool: 'analytics_metrics',
        result: {
          metric: queryResult.metric,
          dimension: queryResult.dimension,
          rows: queryResult.rows,
          periodStart: queryResult.periodStart,
          periodEnd: queryResult.periodEnd,
          timezone: queryResult.timezone,
          evidenceLevel: queryResult.evidenceLevel,
          note: queryResult.note,
        },
      }
    }

    case 'analytics_timeseries': {
      const input = parseToolInput(timeseriesInputSchema, rawLlmInput, toolName)
      enforcePeriodDays(input.dateRange, toolName)

      const queryResult = await executeTimeseriesQuery({
        tenantId: execCtx.ctx.tenant_id,   // server-controlled
        siteId: execCtx.requestSiteId,      // server-controlled
        dateRange: input.dateRange,
        timezone: input.timezone,
        metric: input.metric,
        grain: input.grain,
      })

      return {
        tool: 'analytics_timeseries',
        result: {
          metric: queryResult.metric,
          grain: queryResult.grain,
          points: queryResult.points,
          periodStart: queryResult.periodStart,
          periodEnd: queryResult.periodEnd,
          timezone: queryResult.timezone,
          evidenceLevel: queryResult.evidenceLevel,
          note: queryResult.note,
        },
      }
    }

    case 'analytics_form_analysis': {
      const input = parseToolInput(formAnalysisInputSchema, rawLlmInput, toolName)
      enforcePeriodDays(input.dateRange, toolName)

      const queryResult = await executeFormAnalysisQuery({
        tenantId: execCtx.ctx.tenant_id,   // server-controlled
        siteId: execCtx.requestSiteId,      // server-controlled
        dateRange: input.dateRange,
        timezone: input.timezone,
        formId: input.form_id,
        pageUrl: input.page_url,
      })

      return {
        tool: 'analytics_form_analysis',
        result: {
          forms: queryResult.forms,
          fields: queryResult.fields,
          last_field_distribution: queryResult.last_field_distribution,
          periodStart: queryResult.periodStart,
          periodEnd: queryResult.periodEnd,
          timezone: queryResult.timezone,
          evidenceLevel: queryResult.evidenceLevel,
          note: queryResult.note,
        },
      }
    }

    case 'analytics_frustration': {
      const input = parseToolInput(frustrationInputSchema, rawLlmInput, toolName)
      enforcePeriodDays(input.dateRange, toolName)

      const queryResult = await executeFrustrationQuery({
        tenantId: execCtx.ctx.tenant_id,   // server-controlled
        siteId: execCtx.requestSiteId,      // server-controlled
        dateRange: input.dateRange,
        timezone: input.timezone,
        pageUrl: input.page_url,
      })

      return {
        tool: 'analytics_frustration',
        result: {
          rows: queryResult.rows,
          total: queryResult.total,
          periodStart: queryResult.periodStart,
          periodEnd: queryResult.periodEnd,
          timezone: queryResult.timezone,
          evidenceLevel: queryResult.evidenceLevel,
          note: queryResult.note,
        },
      }
    }

    case 'analytics_performance': {
      const input = parseToolInput(performanceInputSchema, rawLlmInput, toolName)
      enforcePeriodDays(input.dateRange, toolName)

      const queryResult = await executePerformanceQuery({
        tenantId: execCtx.ctx.tenant_id,   // server-controlled
        siteId: execCtx.requestSiteId,      // server-controlled
        dateRange: input.dateRange,
        timezone: input.timezone,
        pageUrl: input.page_url,
        deviceType: input.device,
      })

      return {
        tool: 'analytics_performance',
        result: {
          rows: queryResult.rows,
          periodStart: queryResult.periodStart,
          periodEnd: queryResult.periodEnd,
          timezone: queryResult.timezone,
          evidenceLevel: queryResult.evidenceLevel,
          note: queryResult.note,
        },
      }
    }

    case 'analytics_cta_funnel': {
      const input = parseToolInput(ctaFunnelInputSchema, rawLlmInput, toolName)
      enforcePeriodDays(input.dateRange, toolName)

      const queryResult = await executeCtaFunnelQuery({
        tenantId: execCtx.ctx.tenant_id,   // server-controlled
        siteId: execCtx.requestSiteId,      // server-controlled
        dateRange: input.dateRange,
        timezone: input.timezone,
        pageUrl: input.page_url,
      })

      return {
        tool: 'analytics_cta_funnel',
        result: {
          rows: queryResult.rows,
          approximation_note: queryResult.approximation_note,
          conversion_note: queryResult.conversion_note,
          periodStart: queryResult.periodStart,
          periodEnd: queryResult.periodEnd,
          timezone: queryResult.timezone,
          evidenceLevel: queryResult.evidenceLevel,
          note: queryResult.note,
        },
      }
    }

    default: {
      // exhaustiveness
      const _exhaustive: never = toolName
      throw new ToolValidationError(`unknown analytics tool: ${String(_exhaustive)}`)
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseToolInput<T extends z.ZodTypeAny>(
  schema: T,
  raw: unknown,
  toolName: string,
): z.infer<T> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new ToolValidationError(
      `tool '${toolName}' input invalid: [${first?.path.join('.') || '$root'}] ${first?.message ?? 'unknown'}`,
    )
  }
  return parsed.data
}

function requireParent(
  ctx: TenantContext,
  parentQueryId: string,
  toolName: AnalyticsToolName,
): { input: ReturnType<typeof getParentQuery> extends null ? never : NonNullable<ReturnType<typeof getParentQuery>>['input']; result: AnalyticsQueryResult } {
  const parent = getParentQuery(ctx.tenant_id, parentQueryId)
  if (!parent) {
    throw new ToolValidationError(
      `tool '${toolName}': parentQueryId not found or expired (5 min TTL). Run analytics.overview first.`,
    )
  }
  return parent
}

function enforcePeriodDays(dateRange: { start: string; end: string }, toolName: string): void {
  const startMs = Date.parse(dateRange.start)
  const endMs = Date.parse(dateRange.end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new ToolValidationError(`tool '${toolName}': invalid dateRange (start < end required, ISO 8601)`)
  }
  const periodDays = Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000))
  if (periodDays > MAX_PERIOD_DAYS_ANALYTICS) {
    throw new ToolValidationError(
      `tool '${toolName}': periodDays=${periodDays} exceeds MAX=${MAX_PERIOD_DAYS_ANALYTICS}`,
    )
  }
}
