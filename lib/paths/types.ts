/**
 * lib/paths/types.ts — 経路分析 比較セット (PathSet) DSL types + Zod schema
 *
 * 「1 経路 = 比較セット」(複数パスを横並び比較する 1 ワークフロー単位) を永続化する。
 *
 * 親 SSOT:
 *   - linkscrawl/docs/fusion/mockups/11_path_analysis.html (詳細キャンバスの design SSOT)
 *   - 親 SSOT §3.6.x / §1.7 Anti-Features (セッション録画禁止) / D-07 (Evidence Level)
 *
 * 2 層構造:
 *   - 「定義」    : ユーザーが新規登録フォームで入力する (name / trigger / branches の steps)
 *   - 「分析結果」: 通過/離脱/CV率/PageSpeed/AI Insight。Phase 1 は ClickHouse/ML 未結線のため
 *                  新規登録セットでは空 (= UI で「未分析」表示)。POC seed のみ dummy 数値入り。
 *
 * D-07 整合:
 *   - `evidence_level` を持ち、新規セットは 'planned'。stats が空のノードは数値を捏造せず
 *     「未分析」を表示する (断定数値禁止)。
 *
 * 永続化:
 *   - Cloudflare KV (lib/scenarios/kv-storage.ts の汎用 KvStorage を再利用)
 *   - key prefix `pathsets/{tenant_id}/{site_id}/{id}` (lib/paths/repository.ts)
 */

import { z } from 'zod'

// ── 列挙 ──────────────────────────────────────────────────────────────────────

export const BRANCH_SEVERITIES = ['ok', 'warn', 'crit'] as const
export type BranchSeverity = (typeof BRANCH_SEVERITIES)[number]

export const NODE_BANDS = ['warn', 'win'] as const
export type NodeBand = (typeof NODE_BANDS)[number]

export const EDGE_BANDS = ['warn', 'crit'] as const
export type EdgeBand = (typeof EDGE_BANDS)[number]

export const PERF_BANDS = ['ok', 'warn', 'bad'] as const
export type PerfBand = (typeof PERF_BANDS)[number]

export const INSIGHT_SEVERITIES = ['info', 'warn', 'crit'] as const
export type InsightSeverity = (typeof INSIGHT_SEVERITIES)[number]

export const PATHSET_STATUSES = ['draft', 'monitoring', 'paused', 'archived'] as const
export type PathSetStatus = (typeof PATHSET_STATUSES)[number]

export const EVIDENCE_LEVELS = ['proven', 'observed', 'inferred', 'planned'] as const
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number]

// ── 分析結果（ノード/エッジ/サマリ）──────────────────────────────────────────────

export const PathNodeStatSchema = z.object({
  /** 表示 label (例: '通過'、'離脱'、'CV率') */
  k: z.string().min(1).max(32),
  /** 値 (例: '7,128'、'88%'、'6.1%') */
  v: z.string().min(1).max(32),
  /** 値の severity (pos = 緑強調 / neg = 赤強調 / 未指定 = neutral) */
  tone: z.enum(['pos', 'neg']).optional(),
})
export type PathNodeStat = z.infer<typeof PathNodeStatSchema>

export const PathNodePerfSchema = z.object({
  /** PageSpeed score 0-100 */
  score: z.number().int().min(0).max(100),
  /** LCP 文字列 ('1.8s' 等) */
  lcp: z.string().min(1).max(16),
  band: z.enum(PERF_BANDS),
})
export type PathNodePerf = z.infer<typeof PathNodePerfSchema>

export const PathNodeSchema = z.object({
  id: z.string().min(1).max(64),
  /** ステップ番号 (例: 'A1', 'B2', 'CV') */
  step: z.string().min(1).max(8),
  title: z.string().min(1).max(120),
  url: z.string().min(1).max(2048),
  band: z.enum(NODE_BANDS).optional(),
  stats: z.array(PathNodeStatSchema).max(6).default([]),
  perf: PathNodePerfSchema.optional(),
  /** Compare 用 selected (mockup の A/B 帯) — 詳細では ring 強調のみ */
  selected: z.enum(['A', 'B', 'C']).optional(),
})
export type PathNode = z.infer<typeof PathNodeSchema>

export const PathEdgeSchema = z.object({
  /** edge label (例: '通過 18%'、'迷い時間 +75%')。未分析時は空文字 */
  label: z.string().max(48).default(''),
  band: z.enum(EDGE_BANDS).optional(),
})
export type PathEdge = z.infer<typeof PathEdgeSchema>

export const PathBranchSummarySchema = z.object({
  /** 最終 CV 率 (例: '6.1%')。未分析時は '—' */
  cvRate: z.string().max(16).default('—'),
  /** 前週比 (例: '▲ +0.3pt 前週比')。未分析時は '' */
  delta: z.string().max(48).default(''),
  deltaTone: z.enum(['pos', 'neg']).default('pos'),
})
export type PathBranchSummary = z.infer<typeof PathBranchSummarySchema>

export const PathBranchSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(280).default(''),
  severity: z.enum(BRANCH_SEVERITIES).default('ok'),
  /** nodes は順序通り、edges は nodes.length - 1 個 (各 node 間に 1 つ) */
  nodes: z.array(PathNodeSchema).min(1).max(12),
  edges: z.array(PathEdgeSchema).max(12).default([]),
  summary: PathBranchSummarySchema.default({
    cvRate: '—',
    delta: '',
    deltaTone: 'pos',
  }),
})
export type PathBranch = z.infer<typeof PathBranchSchema>

export const PathAiInsightSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  body: z.string().min(1).max(2000),
  severity: z.enum(INSIGHT_SEVERITIES),
})
export type PathAiInsight = z.infer<typeof PathAiInsightSchema>

// ── トリガー ──────────────────────────────────────────────────────────────────

export const PathTriggerSchema = z.object({
  title: z.string().min(1).max(120),
  url: z.string().min(1).max(2048),
  /** 計測期間 (日)。新規既定 30。 */
  periodDays: z.number().int().min(1).max(365).default(30),
  /** 期間内セッション数 (分析結果)。未分析時は '—' */
  sessions: z.string().max(16).default('—'),
})
export type PathTrigger = z.infer<typeof PathTriggerSchema>

// ── PathSet（永続化エンティティ）────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f-]{36}$/i
const TENANT_ID_PATTERN = /^[a-z0-9_-]{1,64}$/
const SITE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export const PathSetSchema = z.object({
  id: z.string().regex(UUID_PATTERN, 'must be UUID'),
  tenant_id: z.string().regex(TENANT_ID_PATTERN),
  site_id: z.string().regex(SITE_ID_PATTERN),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).default(''),
  status: z.enum(PATHSET_STATUSES).default('draft'),
  trigger: PathTriggerSchema,
  branches: z.array(PathBranchSchema).min(1).max(8),
  insights: z.array(PathAiInsightSchema).max(20).default([]),
  /** true = POC dummy 数値入り (D-07: INFERRED バッジ)、false = 実 data / 未分析 */
  isDummy: z.boolean().default(false),
  evidence_level: z.enum(EVIDENCE_LEVELS).default('planned'),
  evidence_data: z.record(z.unknown()).default({}),
  /** セット全体の平均 CV 率 (分析結果)。未分析時は '—' */
  averageCvRate: z.string().max(16).default('—'),
  created_at: z.string().regex(ISO_DATETIME),
  updated_at: z.string().regex(ISO_DATETIME),
  created_by: z.string().min(1).max(255),
  archived_at: z.string().regex(ISO_DATETIME).nullable().default(null),
})
export type PathSet = z.infer<typeof PathSetSchema>

// ── 詳細キャンバス用の射影 (PathAnalysisData) ────────────────────────────────────
//
// 既存の <PathAnalysisCanvas> は PathAnalysisData を受け取る。PathSet からこの形へ射影する。

export interface PathAnalysisMeta {
  siteName: string
  siteId: string
  periodDays: number
  averageCvRate: string
}

export interface PathAnalysisData {
  isDummy: boolean
  /** breadcrumb / h1 表示用の workflow 名 (= PathSet.name) */
  workflowName: string
  /** D-07: 'planned' / 'inferred' は断定数値禁止の UI ガード対象 */
  evidenceLevel: EvidenceLevel
  trigger: {
    title: string
    url: string
    sessions: string
    periodLabel: string
  }
  branches: ReadonlyArray<PathBranch>
  insights: ReadonlyArray<PathAiInsight>
  meta: PathAnalysisMeta
}

/**
 * PathSet → PathAnalysisData 射影。`siteName` は呼び出し側が tenant 解決して渡す
 * (KV には site_id しか持たないため)。省略時は site_id を流用。
 */
export function pathSetToAnalysisData(
  pset: PathSet,
  opts: { siteName?: string } = {},
): PathAnalysisData {
  return {
    isDummy: pset.isDummy,
    workflowName: pset.name,
    evidenceLevel: pset.evidence_level,
    trigger: {
      title: pset.trigger.title,
      url: pset.trigger.url,
      sessions: pset.trigger.sessions,
      periodLabel: `${pset.trigger.periodDays} 日`,
    },
    branches: pset.branches,
    insights: pset.insights,
    meta: {
      siteName: opts.siteName ?? pset.site_id,
      siteId: pset.site_id,
      periodDays: pset.trigger.periodDays,
      averageCvRate: pset.averageCvRate,
    },
  }
}

// ── 新規作成フォーム用の input shape (定義のみ) ─────────────────────────────────
//
// 数値 (stats/perf/summary/insights/sessions) は分析結果なので作成時には受け取らない。
// server (repository.createPathSet) が空の stats / '—' summary を埋める。

export const PathStepInputSchema = z.object({
  title: z.string().min(1).max(120),
  url: z.string().min(1).max(2048),
})
export type PathStepInput = z.infer<typeof PathStepInputSchema>

export const PathBranchInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(280).default(''),
  steps: z.array(PathStepInputSchema).min(1).max(12),
})
export type PathBranchInput = z.infer<typeof PathBranchInputSchema>

export const CreatePathSetBodySchema = z.object({
  site_id: z.string().regex(SITE_ID_PATTERN),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  trigger: z.object({
    title: z.string().min(1).max(120),
    url: z.string().min(1).max(2048),
    periodDays: z.number().int().min(1).max(365).optional(),
  }),
  branches: z.array(PathBranchInputSchema).min(1).max(8),
})
export type CreatePathSetBody = z.infer<typeof CreatePathSetBodySchema>

/**
 * 作成 input (定義) → 永続化前の branches (空 stats / 未分析 summary)。
 * step index から step ラベル (A1, A2, ... / 最終ステップは CV) を機械生成する。
 */
export function buildBranchesFromInput(branchInputs: ReadonlyArray<PathBranchInput>): PathBranch[] {
  return branchInputs.map((bi, bIdx) => {
    const letter = String.fromCharCode(65 + bIdx) // A, B, C...
    const nodes: PathNode[] = bi.steps.map((step, sIdx) => {
      const isLast = sIdx === bi.steps.length - 1
      return {
        id: `${letter}${sIdx + 1}`,
        step: isLast ? 'CV' : `${letter}${sIdx + 1}`,
        title: step.title,
        url: step.url,
        stats: [],
      }
    })
    const edges: PathEdge[] = bi.steps.slice(1).map(() => ({ label: '' }))
    return {
      id: letter,
      name: bi.name,
      description: bi.description ?? '',
      severity: 'ok' as const,
      nodes,
      edges,
      summary: { cvRate: '—', delta: '', deltaTone: 'pos' as const },
    }
  })
}
