/**
 * M-Director Sprint M-1 (2026-05-25): Scenario DSL types + Zod schema
 *
 * Reference:
 *   - linkscrawl/docs/fusion/team/m-director/dsl-spec.md §2
 *   - linkscrawl/docs/fusion/team/m-director/data-model.md §2.1
 *
 * Scope:
 *   - Condition AST (leaf comparison + composite AND/OR/NOT)
 *   - Variant payload (popup / banner / inline)
 *   - Scenario row (Phase 1 in-memory, Phase 2 PostgreSQL)
 *   - scenario_match event payload (ClickHouse sink)
 *
 * §1.7.1 line: variant execution = ❌ (Path C measure_only).
 * `status='measure_only'` is the only Phase 1 value; Phase 3 unlocks 'live' after Owner+CFO judgement.
 */

import { z } from 'zod'

import { isSafeHttpsUrl } from './safe-url'

// ────────────────────────────────────────────────────────────────────────────
// Condition AST (dsl-spec §2.1)
// ────────────────────────────────────────────────────────────────────────────

export const LEAF_OPERATORS = [
  'EQ',
  'NEQ',
  'GT',
  'GTE',
  'LT',
  'LTE',
  'IN',
  'NOT_IN',
  'CONTAINS',
  'STARTS_WITH',
  'ENDS_WITH',
  'MATCHES_REGEX',
  'VISITED',
  'NOT_VISITED',
  'EXISTS',
  'NOT_EXISTS',
] as const

export type LeafOperator = (typeof LEAF_OPERATORS)[number]

export const COMPOSITE_OPERATORS = ['AND', 'OR', 'NOT'] as const
export type CompositeOperator = (typeof COMPOSITE_OPERATORS)[number]

const LeafValueSchema = z.union([
  z.string().max(2048),
  z.number(),
  z.boolean(),
  z.array(z.string().max(255)).max(100),
  z.array(z.number()).max(100),
])

export const LeafComparisonSchema = z.object({
  op: z.enum(LEAF_OPERATORS),
  field: z.string().min(1).max(64),
  value: LeafValueSchema.optional(),
})

export type LeafComparison = z.infer<typeof LeafComparisonSchema>

export interface CompositeNode {
  op: CompositeOperator
  children: ReadonlyArray<LeafComparison | CompositeNode>
}

export const CompositeNodeSchema: z.ZodType<CompositeNode> = z.lazy(() =>
  z
    .object({
      op: z.enum(COMPOSITE_OPERATORS),
      children: z.array(z.union([LeafComparisonSchema, CompositeNodeSchema])).min(1).max(30),
    })
    .superRefine((node, ctx) => {
      if (node.op === 'NOT' && node.children.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'NOT must have exactly one child',
        })
      }
    }),
)

export const ConditionNodeSchema: z.ZodType<LeafComparison | CompositeNode> = z.union([
  LeafComparisonSchema,
  CompositeNodeSchema,
])

export type ConditionNode = LeafComparison | CompositeNode

// Depth check (dsl-spec §2.2: depth <= 5)
export function conditionDepth(node: ConditionNode): number {
  if (isLeaf(node)) return 1
  return 1 + Math.max(...node.children.map((c) => conditionDepth(c)))
}

export function isLeaf(node: ConditionNode): node is LeafComparison {
  return LEAF_OPERATORS.includes(node.op as LeafOperator)
}

export function isComposite(node: ConditionNode): node is CompositeNode {
  return COMPOSITE_OPERATORS.includes(node.op as CompositeOperator)
}

// ────────────────────────────────────────────────────────────────────────────
// Allowlist: fields that condition_ast can reference (dsl-spec §3)
// PII (email/phone) intentionally excluded.
// ────────────────────────────────────────────────────────────────────────────

export const ALLOWED_FIELDS = [
  // Phase 1
  'tenant_id',
  'site_id',
  'visitor_id',
  'session_id',
  'is_first_visit',
  'session_duration_sec',
  'page_views_in_session',
  'url_path',
  'url_query',
  'referrer_host',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'device_type',
  // Phase 2
  'visited_paths',
  'scroll_depth_max_pct',
  'cart_value',
  'language',
  'hour_of_day',
  'is_agent',
  // Phase 3 (ML-derived)
  'persona_label',
  'predicted_intent',
] as const

export type AllowedField = (typeof ALLOWED_FIELDS)[number]

export function isAllowedField(field: string): field is AllowedField {
  return (ALLOWED_FIELDS as ReadonlyArray<string>).includes(field)
}

// ────────────────────────────────────────────────────────────────────────────
// Variant — A/B/C, each is EITHER an image OR an HTML fragment
// (Owner feedback 2026-05-25: サイト毎にデザインが異なるため汎用フィールドは不可、
//  「画像 (R2)」または「HTML 直接記述」の 2 択 + A/B/C 最大 3 variants + traffic split)
// ────────────────────────────────────────────────────────────────────────────

export const VARIANT_CONTENT_TYPES = ['image', 'html'] as const
export type VariantContentType = (typeof VARIANT_CONTENT_TYPES)[number]

export const VARIANT_POSITIONS = [
  'center',
  'top',
  'bottom',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'inline',
] as const
export type VariantPosition = (typeof VARIANT_POSITIONS)[number]

// REQ-SEC-003: variant URLs are assigned to img.src / href / location at runtime, so they
// must be HTTPS-only absolute URLs. `z.string().url()` alone accepts javascript:/data:/blob:
// and relative URLs, which become click-to-XSS / data-exfil vectors. Enforce https: here at
// the write boundary; scenario-runtime.js mirrors the same check before any DOM assignment.
const SafeHttpsUrlSchema = z
  .string()
  .max(2048)
  .refine(isSafeHttpsUrl, { message: 'must be an absolute https:// URL (no javascript:/data:/blob:/relative)' })

const ImageVariantSchema = z.object({
  id: z.string().min(1).max(8), // 'A' | 'B' | 'C'
  content_type: z.literal('image'),
  image_url: SafeHttpsUrlSchema,
  image_alt: z.string().max(255).default(''),
  image_width: z.number().int().min(1).max(4096).optional(),
  image_height: z.number().int().min(1).max(4096).optional(),
  cta_url: SafeHttpsUrlSchema.optional(),
  position: z.enum(VARIANT_POSITIONS).default('center'),
  traffic_split: z.number().int().min(0).max(100), // 0-100, sum across variants must be 100
})

const HtmlVariantSchema = z.object({
  id: z.string().min(1).max(8),
  content_type: z.literal('html'),
  html: z.string().max(8192), // sanitized at server boundary (lib/scenarios/html-sanitizer.ts)
  cta_url: SafeHttpsUrlSchema.optional(),
  position: z.enum(VARIANT_POSITIONS).default('center'),
  traffic_split: z.number().int().min(0).max(100),
})

export const VariantSchema = z.discriminatedUnion('content_type', [ImageVariantSchema, HtmlVariantSchema])
export type Variant = z.infer<typeof VariantSchema>

// 1〜3 variants per scenario (A only / A+B / A+B+C)
export const VariantsSchema = z
  .array(VariantSchema)
  .min(1)
  .max(3)
  .superRefine((variants, ctx) => {
    const sum = variants.reduce((acc, v) => acc + v.traffic_split, 0)
    if (sum !== 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `traffic_split sum must equal 100 (got ${sum})`,
      })
    }
    const ids = variants.map((v) => v.id)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'variant ids must be unique' })
    }
  })

export type Variants = z.infer<typeof VariantsSchema>

// ────────────────────────────────────────────────────────────────────────────
// Frequency cap & Schedule (Phase 2.1、2026-06-07)
// ────────────────────────────────────────────────────────────────────────────
//
// Frequency cap: 同じ visitor に何回まで表示するかを制限。
//   - 'session' = 1 session 内で max_impressions 回まで (既存の per-session dedup と整合)
//   - 'day'     = 1 UTC 日内で max_impressions 回まで
//   - 'week'    = 1 ISO 週 (Mon 始まり) で max_impressions 回まで
//   未設定時は per-session dedup のみ (既存挙動)。
//
// Schedule: scenario の配信期間 (開始 / 終了)。
//   - start_at: この時刻より前は配信しない (null/省略 = 即時開始)
//   - end_at:   この時刻以降は配信しない (null/省略 = 終了なし)
//   server が現在時刻外の scenario を payload から落とす + scenario-runtime.js が
//   ±5min clock skew 内で再チェック (端末時計ずれ耐性)。

export const FREQUENCY_CAP_PERIODS = ['session', 'day', 'week'] as const
export type FrequencyCapPeriod = (typeof FREQUENCY_CAP_PERIODS)[number]

export const FrequencyCapSchema = z
  .object({
    per_period: z.enum(FREQUENCY_CAP_PERIODS),
    max_impressions: z.number().int().min(1).max(100),
  })
  .strict()

export type FrequencyCap = z.infer<typeof FrequencyCapSchema>

export const ScheduleSchema = z
  .object({
    start_at: z.string().datetime().nullable().optional(),
    end_at: z.string().datetime().nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.start_at || !v.end_at) return
    // 文字列比較は fractional seconds 等で順序がズレる (例: '...00.500Z' < '...00Z')。
    // ms 数値比較で順序を確定する (Codex T2 dual review 指摘 A 反映)。
    const startMs = Date.parse(v.start_at)
    const endMs = Date.parse(v.end_at)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'start_at must be earlier than end_at',
      })
    }
  })

export type Schedule = z.infer<typeof ScheduleSchema>

// ────────────────────────────────────────────────────────────────────────────
// Scenario row (Phase 1 in-memory, Phase 2 PostgreSQL row)
// ────────────────────────────────────────────────────────────────────────────

export const SCENARIO_STATUSES = ['draft', 'measure_only', 'preview', 'live', 'paused', 'archived'] as const
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number]

export const EVIDENCE_LEVELS = ['proven', 'observed', 'inferred', 'planned'] as const
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number]

export const ScenarioSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().min(1).max(64),
  site_id: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).default(''),
  condition_ast: ConditionNodeSchema,
  variants: VariantsSchema,
  status: z.enum(SCENARIO_STATUSES).default('live'),
  evidence_level: z.enum(EVIDENCE_LEVELS).default('planned'),
  evidence_data: z.record(z.unknown()).default({}),
  // Phase 2.1 additions (additive、既存 row は省略可で読込)
  frequency_cap: FrequencyCapSchema.nullable().optional(),
  schedule: ScheduleSchema.nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  created_by: z.string().min(1).max(255),
  archived_at: z.string().datetime().nullable().default(null),
})

export type Scenario = z.infer<typeof ScenarioSchema>

// Runtime payload served to scenario_runtime.js (subset of Scenario, no audit columns)
// frequency_cap / schedule は browser side 二重チェックのため runtime payload に含める。
export const ScenarioRuntimeSchema = z.object({
  id: z.string().uuid(),
  condition_ast: ConditionNodeSchema,
  variants: VariantsSchema,
  status: z.enum(SCENARIO_STATUSES),
  matched_condition_hash: z.string().length(64).optional(),
  frequency_cap: FrequencyCapSchema.nullable().optional(),
  schedule: ScheduleSchema.nullable().optional(),
})

export type ScenarioRuntime = z.infer<typeof ScenarioRuntimeSchema>

export const ScenarioRuntimePayloadSchema = z.object({
  generated_at: z.string().datetime(),
  tenant_id: z.string(),
  site_id: z.string(),
  scenarios: z.array(ScenarioRuntimeSchema),
})

export type ScenarioRuntimePayload = z.infer<typeof ScenarioRuntimePayloadSchema>

// ────────────────────────────────────────────────────────────────────────────
// scenario_match ClickHouse sink payload
// ────────────────────────────────────────────────────────────────────────────

export const MATCH_TYPES = ['match', 'impression', 'click', 'conversion', 'dismiss'] as const
export type MatchType = (typeof MATCH_TYPES)[number]

export const DISPATCH_PATHS = ['measure_only', 'preview', 'live', 'vwo'] as const
export type DispatchPath = (typeof DISPATCH_PATHS)[number]

export const ScenarioMatchEventSchema = z.object({
  tenant_id: z.string().min(1),
  site_id: z.string().min(1),
  visitor_id: z.string().min(1),
  session_id: z.string().min(1),
  event_type: z.literal('scenario_match'),
  url: z.string().url().max(2048),
  timestamp: z.string().datetime(),
  device_type: z.enum(['desktop', 'mobile', 'tablet', 'unknown']).default('unknown'),
  utm_source: z.string().max(255).default(''),
  utm_medium: z.string().max(255).default(''),
  utm_campaign: z.string().max(255).default(''),

  scenario_id: z.string().uuid(),
  match_type: z.enum(MATCH_TYPES),
  dispatch_path: z.enum(DISPATCH_PATHS).default('measure_only'),
  ab_variant_id: z.string().max(64).default(''),
  matched_condition_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  evaluation_ms: z.number().int().min(0).max(60000).default(0),
})

export type ScenarioMatchEvent = z.infer<typeof ScenarioMatchEventSchema>

// ────────────────────────────────────────────────────────────────────────────
// AST validation helpers (server-side, before persist)
// ────────────────────────────────────────────────────────────────────────────

export const MAX_DEPTH = 5
export const MAX_LEAVES = 30

export function collectFields(node: ConditionNode): string[] {
  if (isLeaf(node)) return [node.field]
  return node.children.flatMap((c) => collectFields(c))
}

export function countLeaves(node: ConditionNode): number {
  if (isLeaf(node)) return 1
  return node.children.reduce((acc, c) => acc + countLeaves(c), 0)
}

export interface AstValidationError {
  code: 'depth_exceeded' | 'leaf_count_exceeded' | 'unsupported_field' | 'invalid_not_arity'
  message: string
  field?: string
}

export function validateConditionAst(node: ConditionNode): AstValidationError[] {
  const errors: AstValidationError[] = []
  if (conditionDepth(node) > MAX_DEPTH) {
    errors.push({ code: 'depth_exceeded', message: `AST depth must be <= ${MAX_DEPTH}` })
  }
  if (countLeaves(node) > MAX_LEAVES) {
    errors.push({ code: 'leaf_count_exceeded', message: `AST leaf count must be <= ${MAX_LEAVES}` })
  }
  for (const field of collectFields(node)) {
    if (!isAllowedField(field)) {
      errors.push({ code: 'unsupported_field', message: `field "${field}" is not allowed`, field })
    }
  }
  return errors
}
