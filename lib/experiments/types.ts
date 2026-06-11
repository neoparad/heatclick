/**
 * 宝プロジェクト — 標準実験 registry 型 + lock 不変条件
 *
 * Reference:
 *   - handoff/2026-06-10-ugokimap-treasure-ab-pooling-module.md §作る5コンポーネント #1/#2
 *   - decisions.md D-12 (§1.7.1 carve-out)
 *
 * lock 不変条件 (事前登録 = 横断プールの前提):
 *   - draft: taxonomy / url_pattern / salt_version は編集可。
 *   - running 遷移時: locked_at を刻み、上記をロック。以後 stopped/archived まで不変。
 *   - これを破ると「事前登録された比較」の前提が崩れ、横断プールのデータが無価値化。
 */

import { z } from 'zod'

import {
  InterventionTypeSchema,
  PageTypeSchema,
  IndustrySchema,
  DeviceSchema,
  PrimaryMetricSchema,
  ExperimentWindowSchema,
} from './taxonomy'

// ── locked taxonomy (6-tuple、事前登録の心臓) ────────────────────────────────
export const LockedTaxonomySchema = z
  .object({
    intervention_type: InterventionTypeSchema,
    page_type: PageTypeSchema,
    industry: IndustrySchema,
    device: DeviceSchema,
    primary_metric: PrimaryMetricSchema,
    window: ExperimentWindowSchema,
  })
  .strict()
export type LockedTaxonomy = z.infer<typeof LockedTaxonomySchema>

// ── status ────────────────────────────────────────────────────────────────────
export const EXPERIMENT_STATUSES = ['draft', 'running', 'stopped', 'archived'] as const
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number]

/** taxonomy / url_pattern / salt_version を編集してよいのは draft の間だけ。 */
export function isTaxonomyEditable(status: ExperimentStatus): boolean {
  return status === 'draft'
}

// ── consent (k 匿名横断プール参加の同意、handoff: k>=50) ──────────────────────
export const K_ANONYMITY_FLOOR = 50

export const ConsentSchema = z
  .object({
    pool_opt_in: z.boolean().default(false),
    k_anonymity_min: z.number().int().min(K_ANONYMITY_FLOOR).default(K_ANONYMITY_FLOOR),
  })
  .strict()
export type Consent = z.infer<typeof ConsentSchema>

// ── 計測期間 (concrete dates、taxonomy.window から導出) ───────────────────────
export const ExperimentDatesSchema = z
  .object({
    start_at: z.string().datetime().nullable().default(null),
    end_at: z.string().datetime().nullable().default(null),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.start_at || !v.end_at) return
    const s = Date.parse(v.start_at)
    const e = Date.parse(v.end_at)
    if (!Number.isFinite(s) || !Number.isFinite(e) || s >= e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'start_at must be earlier than end_at' })
    }
  })
export type ExperimentDates = z.infer<typeof ExperimentDatesSchema>

// ── url_pattern (ITT 分母: どのページが「実験ページ」か。absolute path prefix) ──
const UrlPatternSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^\/[^\s]*$/, { message: 'url_pattern must be an absolute path starting with /' })

// ── render_config (M6): treatment が顧客サイトで適用する mechanical 操作のパラメータ ──
// 任意 HTML は受けない — CSS selector (自サイト内の既存要素を指す) のみ。
// experiment-runtime.js は selector で見つけた既存要素の移動/クローン/表示切替だけを行う。
const CssSelectorSchema = z.string().min(1).max(256)

export const RenderConfigSchema = z.discriminatedUnion('kind', [
  // cta_placement / sticky_cta_mobile: 対象 CTA (アンカー要素) の selector
  z.object({ kind: z.literal('cta'), cta_selector: CssSelectorSchema }).strict(),
  // form_field_reduction: 非表示にする任意項目 (required を含む要素は runtime 側で skip)
  z
    .object({ kind: z.literal('form_fields'), field_selectors: z.array(CssSelectorSchema).min(1).max(20) })
    .strict(),
])
export type RenderConfig = z.infer<typeof RenderConfigSchema>

/** intervention_type ごとに要求される render_config.kind。 */
export const RENDER_KIND_BY_INTERVENTION: Readonly<Record<string, RenderConfig['kind']>> = {
  cta_placement: 'cta',
  sticky_cta_mobile: 'cta',
  form_field_reduction: 'form_fields',
}

// ── experiment row ──────────────────────────────────────────────────────────────
export const ExperimentSchema = z
  .object({
    id: z.string().uuid(),
    tenant_id: z.string().min(1).max(64),
    site_id: z.string().min(1).max(64),
    name: z.string().min(1).max(255),
    url_pattern: UrlPatternSchema,
    taxonomy: LockedTaxonomySchema,
    status: z.enum(EXPERIMENT_STATUSES).default('draft'),
    dates: ExperimentDatesSchema,
    salt_version: z.number().int().min(1).default(1),
    consent: ConsentSchema,
    /** M6: treatment のレンダリング設定。null = レンダリングなし (実質 A/A、計測のみ)。 */
    render_config: RenderConfigSchema.nullable().optional().default(null),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    created_by: z.string().min(1).max(255),
    locked_at: z.string().datetime().nullable().default(null),
    stopped_at: z.string().datetime().nullable().default(null),
    archived_at: z.string().datetime().nullable().default(null),
  })
  .superRefine((row, ctx) => {
    // render_config.kind は intervention_type と整合していること (taxonomy と独立に変えられない)。
    if (!row.render_config) return
    const expected = RENDER_KIND_BY_INTERVENTION[row.taxonomy.intervention_type]
    if (expected && row.render_config.kind !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['render_config', 'kind'],
        message: `render_config.kind must be "${expected}" for ${row.taxonomy.intervention_type}`,
      })
    }
  })
export type Experiment = z.infer<typeof ExperimentSchema>

// ── lock 不変条件の強制 (pure、repository から呼ぶ) ──────────────────────────
// render_config も locked: treatment の定義が実験中に変わると計測が混合され無効化するため
// (M6)。running 以降は taxonomy / url_pattern / salt_version / render_config すべて不変。
export const LOCKED_FIELDS = ['taxonomy', 'url_pattern', 'salt_version', 'render_config'] as const

export class ExperimentLockError extends Error {
  constructor(public readonly field: string) {
    super(`experiment field "${field}" is locked once running (pre-registration immutability)`)
    this.name = 'ExperimentLockError'
  }
}

/**
 * running/stopped/archived の実験で locked field を変更しようとしたら throw。draft では許可。
 * taxonomy / render_config は key 順非依存で比較する (canonical 化 + JSON 文字列比較)。
 */
export function assertLockedFieldsUnchanged(
  existing: Pick<Experiment, 'status' | 'taxonomy' | 'url_pattern' | 'salt_version' | 'render_config'>,
  patch: Partial<Pick<Experiment, 'taxonomy' | 'url_pattern' | 'salt_version' | 'render_config'>>,
): void {
  if (isTaxonomyEditable(existing.status)) return
  if (patch.taxonomy !== undefined && !deepEqualJson(patch.taxonomy, existing.taxonomy)) {
    throw new ExperimentLockError('taxonomy')
  }
  if (patch.url_pattern !== undefined && patch.url_pattern !== existing.url_pattern) {
    throw new ExperimentLockError('url_pattern')
  }
  if (patch.salt_version !== undefined && patch.salt_version !== existing.salt_version) {
    throw new ExperimentLockError('salt_version')
  }
  if (patch.render_config !== undefined && !deepEqualJson(patch.render_config, existing.render_config)) {
    throw new ExperimentLockError('render_config')
  }
}

/** draft → running 遷移: locked_at を刻む。既に running 以降なら no-op で既存を返す。 */
export function lockForRunning(experiment: Experiment, nowIso: string): Experiment {
  if (experiment.status !== 'draft') return experiment
  return { ...experiment, status: 'running', locked_at: nowIso, updated_at: nowIso }
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

// key 順非依存の canonical 化 (taxonomy オブジェクトのキー順揺れ対策)
function canonical(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(canonical)
  const obj = v as Record<string, unknown>
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = canonical(obj[k])
      return acc
    }, {})
}
