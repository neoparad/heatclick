/**
 * lib/llm/deep-research.ts — Deep Research v1 (オンデマンド非同期分析)
 *
 * 親 SSOT §2.2.6 / docs/ai-chat-deep-research-design.md §B
 *
 * 流れ:
 *   1. チャットの deep_research_propose (read) が readiness と候補プラン・最新結果を返す
 *   2. ユーザーが選択 → deep_research_enqueue (write) が analysis_jobs に pending job を積む
 *   3. cron (/api/cron/deep-research) が runPendingDeepResearchJobs() を呼び、
 *      job を claim → レポート生成 → proposal_tickets に書込 → job を completed に更新
 *   4. チャットは deep_research_propose で最新 job/tickets を読み、対話的に深掘り
 *
 * 制約:
 *   - tenant_id / site_id / user_id は server-controlled (呼び出し側が固定)
 *   - 読取は analytics_reader、書込は chat_writer (Infra が新2テーブルへ grant 要)
 *   - 数値は既存 execute*Query (本番検証済) を再利用し、しきい値ルールでチケット化
 *   - D-07: 各チケットに evidence_level。推定 impact は断定しない
 */

import { randomUUID } from 'node:crypto'

import { getClickHouseClient } from '@/lib/clickhouse'
import type { EvidenceLevelV2 } from '@/types/evidence'
import {
  executeDataReadinessQuery,
  executeDeadZonesQuery,
  executeFrustrationQuery,
  executePerformanceQuery,
  executeCtaFunnelQuery,
  executeFormAnalysisQuery,
  type AnalyticsDateRange,
} from '@/lib/llm/hybrid-query'

export const DEEP_RESEARCH_REPORT_TYPES = [
  'uiux_audit',
  'cta_form_tickets',
  'attention_action_gap',
] as const
export type DeepResearchReportType = (typeof DEEP_RESEARCH_REPORT_TYPES)[number]

export const DEEP_RESEARCH_REPORT_LABELS: Record<DeepResearchReportType, string> = {
  uiux_audit: 'UI/UX課題監査 (デッドゾーン・フラストレーション・速度)',
  cta_form_tickets: 'CTA/フォーム改善チケット (露出×クリック・項目別離脱)',
  attention_action_gap: '注目→行動ギャップ (見られているが押されていない)',
}

export interface ProposalTicketDraft {
  problem: string
  evidence: Record<string, unknown>
  affected_segment: string
  recommended_change: string
  confidence: number
  evidence_level: EvidenceLevelV2
  blocked_claims: string[]
  query_refs: string[]
}

interface GeneratorContext {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
}

interface JobRecord {
  id: string
  tenant_id: string
  site_id: string
  user_id: string
  job_type: string
  report_type: DeepResearchReportType
  input_config: string
  attempt_count: number
  created_at: string
  scheduled_by: string
}

const MAX_ATTEMPTS = 3

function nowIso(): string {
  return new Date().toISOString().slice(0, 19)
}

// ── enqueue (write) ──────────────────────────────────────────────────

export async function enqueueDeepResearchJob(params: {
  tenantId: string
  siteId: string
  userId: string
  reportType: DeepResearchReportType
  dateRange: AnalyticsDateRange
  timezone: string
}): Promise<{ jobId: string }> {
  const jobId = randomUUID()
  const ts = nowIso()
  const client = getClickHouseClient('chat_writer')
  await client.insert({
    table: 'analysis_jobs',
    values: [
      {
        id: jobId,
        tenant_id: params.tenantId,
        site_id: params.siteId,
        user_id: params.userId,
        job_type: 'deep_research',
        report_type: params.reportType,
        status: 'pending',
        input_config: JSON.stringify({ dateRange: params.dateRange, timezone: params.timezone }),
        output_results: null,
        error_message: null,
        attempt_count: 0,
        locked_by: '',
        locked_at: null,
        scheduled_by: 'user_request',
        model_id: '',
        cost_usd: 0,
        created_at: ts,
        started_at: null,
        completed_at: null,
        updated_at: ts,
        duration_seconds: null,
      },
    ],
    format: 'JSONEachRow',
  })
  return { jobId }
}

/** job 行を全カラムで再 INSERT (ReplacingMergeTree: 同 id を新 updated_at で置換)。 */
async function upsertJob(row: Record<string, unknown>): Promise<void> {
  const client = getClickHouseClient('chat_writer')
  await client.insert({ table: 'analysis_jobs', values: [{ ...row, updated_at: nowIso() }], format: 'JSONEachRow' })
}

async function insertTickets(
  job: JobRecord,
  week: string,
  drafts: ProposalTicketDraft[],
): Promise<void> {
  if (drafts.length === 0) return
  const client = getClickHouseClient('chat_writer')
  const ts = nowIso()
  const values = drafts.map((d) => ({
    id: randomUUID(),
    tenant_id: job.tenant_id,
    site_id: job.site_id,
    job_id: job.id,
    report_type: job.report_type,
    week,
    version: 1,
    problem: d.problem,
    evidence: JSON.stringify(d.evidence),
    affected_segment: d.affected_segment,
    recommended_change: d.recommended_change,
    confidence: d.confidence,
    evidence_level: d.evidence_level,
    blocked_claims: d.blocked_claims,
    query_refs: d.query_refs,
    status: 'open',
    created_at: ts,
    updated_at: ts,
  }))
  await client.insert({ table: 'proposal_tickets', values, format: 'JSONEachRow' })
}

// ── report generators ────────────────────────────────────────────────

async function generateUiuxAudit(ctx: GeneratorContext): Promise<{ tickets: ProposalTicketDraft[]; summary: string }> {
  const tickets: ProposalTicketDraft[] = []
  const [dead, frustration, performance] = await Promise.all([
    executeDeadZonesQuery({ ...ctx, binPx: 100, limit: 5 }).catch(() => null),
    executeFrustrationQuery({ ...ctx }).catch(() => null),
    executePerformanceQuery({ ...ctx }).catch(() => null),
  ])

  const topDead = dead?.rows?.[0]
  if (topDead && topDead.total >= 10) {
    tickets.push({
      problem: `デッドゾーン: ${topDead.url} の座標(x ${topDead.x_start}-${topDead.x_end}, y ${topDead.y_start}-${topDead.y_end}) で反応しないクリックが ${topDead.total}件 (dead ${topDead.dead_clicks}/rage ${topDead.rage_clicks})。`,
      evidence: { top_bins: dead?.rows?.slice(0, 3) ?? [] },
      affected_segment: topDead.url,
      recommended_change: '当該領域の要素がクリック可能に見えて反応しない/リンク切れの可能性。リンク化・誘導の見直し、またはクリック不可なら視覚的にボタンらしさを除去。',
      confidence: topDead.total >= 30 ? 0.75 : 0.55,
      evidence_level: dead?.evidenceLevel ?? 'observed_approx',
      blocked_claims: [],
      query_refs: ['analytics_dead_zones'],
    })
  }

  const topFr = frustration?.rows?.[0]
  if (topFr && topFr.dead_clicks + topFr.rage_clicks >= 20) {
    tickets.push({
      problem: `フラストレーション高: ${topFr.page_url} (dead ${topFr.dead_clicks}/rage ${topFr.rage_clicks}/巻き戻し ${topFr.reversals}/hover-no-click ${topFr.hover_no_clicks}, sessions ${topFr.sessions})。`,
      evidence: { top_pages: frustration?.rows?.slice(0, 3) ?? [] },
      affected_segment: topFr.page_url,
      recommended_change: 'デッド/レイジクリック箇所と巻き戻しの多い区間を起点に、誤タップ要素・期待外の挙動・読み込み遅延を点検。',
      confidence: 0.6,
      evidence_level: frustration?.evidenceLevel ?? 'observed_approx',
      blocked_claims: [],
      query_refs: ['analytics_frustration'],
    })
  }

  const perf = performance?.rows?.[0]
  if (perf && (perf.lcp.rating === 'poor' || perf.lcp.rating === 'needs_improvement') && perf.lcp.p75 !== null) {
    tickets.push({
      problem: `表示速度: ${perf.dimension_value} の LCP p75=${perf.lcp.p75}ms (${perf.lcp.rating}, sample ${perf.sample_count})。`,
      evidence: { lcp: perf.lcp, inp: perf.inp, cls: perf.cls, sample_count: perf.sample_count },
      affected_segment: perf.dimension_value,
      recommended_change: '主要画像の最適化/遅延読み込み調整、サーバ応答(TTFB)とレンダリングブロッキング資源の削減で LCP 改善。',
      confidence: perf.lcp.rating === 'poor' ? 0.7 : 0.5,
      evidence_level: performance?.evidenceLevel ?? 'observed_approx',
      blocked_claims: ['CV未計測サイトでは速度→CVの定量影響は不可 (直帰/滞在 proxy で代替)'],
      query_refs: ['analytics_performance'],
    })
  }

  const summary =
    tickets.length > 0
      ? `UI/UX課題 ${tickets.length}件を検出 (デッドゾーン/フラストレーション/速度)。`
      : '現在のしきい値では明確な UI/UX 課題は検出されませんでした。'
  return { tickets, summary }
}

async function generateCtaFormTickets(ctx: GeneratorContext): Promise<{ tickets: ProposalTicketDraft[]; summary: string }> {
  const tickets: ProposalTicketDraft[] = []
  const [cta, form] = await Promise.all([
    executeCtaFunnelQuery({ ...ctx }).catch(() => null),
    executeFormAnalysisQuery({ ...ctx }).catch(() => null),
  ])

  const lowCtr = (cta?.rows ?? [])
    .filter((r) => r.impressions >= 50 && (r.ctr ?? 0) < 0.02)
    .slice(0, 3)
  for (const r of lowCtr) {
    tickets.push({
      problem: `高露出・低クリック CTA: ${r.element_selector} (${r.page_url}) impressions ${r.impressions} / clicks ${r.clicks} / CTR ${((r.ctr ?? 0) * 100).toFixed(2)}%。`,
      evidence: { cta: r },
      affected_segment: r.page_url,
      recommended_change: '見られているのに押されていない。文言/色/配置/視認性を見直し、価値訴求を CTA 近傍に。A/B はバナー機能(M Agent)で検証。',
      confidence: r.impressions >= 200 ? 0.7 : 0.55,
      evidence_level: cta?.evidenceLevel ?? 'observed_approx',
      blocked_claims: ['CTR は element_selector 結合の近似 (厳密な session 順序結合ではない)'],
      query_refs: ['analytics_cta_funnel'],
    })
  }

  const badForms = (form?.forms ?? [])
    .filter((f) => f.starts >= 20 && (f.abandonment_rate ?? 0) >= 0.7)
    .slice(0, 2)
  for (const f of badForms) {
    const topAbandon = (form?.last_field_distribution ?? [])
      .filter((x) => x.form_id === f.form_id)
      .sort((a, b) => b.abandon_count - a.abandon_count)[0]
    tickets.push({
      problem: `フォーム離脱: ${f.form_id} (${f.page_url}) 開始 ${f.starts} / 送信 ${f.submits} / 離脱率 ${((f.abandonment_rate ?? 0) * 100).toFixed(1)}%${topAbandon ? ` / 最多離脱フィールド「${topAbandon.last_field}」(${topAbandon.abandon_count}件)` : ''}。`,
      evidence: { form: f, top_abandon_field: topAbandon ?? null },
      affected_segment: f.page_url,
      recommended_change: topAbandon
        ? `「${topAbandon.last_field}」での離脱が最多。入力負荷の軽減(任意化・分割・補助表示)を優先。`
        : '入力項目の削減・段階化・エラー表示改善で完了率を改善。',
      confidence: f.starts >= 100 ? 0.75 : 0.6,
      evidence_level: form?.evidenceLevel ?? 'observed_approx',
      blocked_claims: [],
      query_refs: ['analytics_form_analysis'],
    })
  }

  const summary =
    tickets.length > 0
      ? `CTA/フォーム改善候補 ${tickets.length}件 (低CTR ${lowCtr.length} / 高離脱フォーム ${badForms.length})。`
      : '現在のしきい値では CTA/フォームの明確な改善候補は検出されませんでした (露出/開始数が閾値未満の可能性)。'
  return { tickets, summary }
}

async function generateAttentionActionGap(ctx: GeneratorContext): Promise<{ tickets: ProposalTicketDraft[]; summary: string }> {
  const tickets: ProposalTicketDraft[] = []
  const cta = await executeCtaFunnelQuery({ ...ctx }).catch(() => null)

  // 高露出(見られている) かつ 低クリック(行動していない) の要素 = 注目→行動ギャップ
  const gaps = (cta?.rows ?? [])
    .filter((r) => r.impressions >= 100 && (r.ctr ?? 0) < 0.03)
    .slice(0, 5)
  for (const r of gaps) {
    tickets.push({
      problem: `注目→行動ギャップ: ${r.element_selector} (${r.page_url}) は ${r.impressions} 回露出されているがクリックは ${r.clicks} (CTR ${((r.ctr ?? 0) * 100).toFixed(2)}%)。`,
      evidence: { element: r },
      affected_segment: r.page_url,
      recommended_change: '見られているのに行動に繋がっていない。CTA の言い換え・近接配置・期待値の明確化で「見る→押す」を橋渡し。',
      confidence: r.impressions >= 300 ? 0.65 : 0.5,
      evidence_level: cta?.evidenceLevel ?? 'observed_approx',
      blocked_claims: ['露出は element_visibility 由来、クリックは events 由来の近似結合'],
      query_refs: ['analytics_cta_funnel'],
    })
  }

  const summary =
    tickets.length > 0
      ? `注目→行動ギャップを ${tickets.length}件検出。`
      : '現在のしきい値では明確な注目→行動ギャップは検出されませんでした。'
  return { tickets, summary }
}

async function runGenerator(
  reportType: DeepResearchReportType,
  ctx: GeneratorContext,
): Promise<{ tickets: ProposalTicketDraft[]; summary: string }> {
  switch (reportType) {
    case 'uiux_audit':
      return generateUiuxAudit(ctx)
    case 'cta_form_tickets':
      return generateCtaFormTickets(ctx)
    case 'attention_action_gap':
      return generateAttentionActionGap(ctx)
  }
}

// ── worker ───────────────────────────────────────────────────────────

function isoWeekMonday(): string {
  const d = new Date()
  const day = (d.getUTCDay() + 6) % 7 // Mon=0
  d.setUTCDate(d.getUTCDate() - day)
  return d.toISOString().slice(0, 10)
}

export async function runPendingDeepResearchJobs(options?: {
  limit?: number
}): Promise<{ processed: number; failed: number }> {
  const limit = options?.limit ?? 5
  const reader = getClickHouseClient('analytics_reader')
  const rs = await reader.query({
    query: `
SELECT id, tenant_id, site_id, user_id, job_type, report_type, input_config, attempt_count,
       toString(created_at) AS created_at, scheduled_by
FROM clickinsight.analysis_jobs FINAL
WHERE status = 'pending' AND attempt_count < {max:UInt8}
ORDER BY created_at ASC
LIMIT {limit:UInt32}
SETTINGS max_execution_time = 30`.trim(),
    query_params: { max: String(MAX_ATTEMPTS), limit: String(limit) },
    format: 'JSONEachRow',
  })
  const jobs = await rs.json<JobRecord>()

  let processed = 0
  let failed = 0
  const week = isoWeekMonday()

  for (const job of jobs) {
    const base = {
      id: job.id,
      tenant_id: job.tenant_id,
      site_id: job.site_id,
      user_id: job.user_id,
      job_type: job.job_type,
      report_type: job.report_type,
      input_config: job.input_config,
      scheduled_by: job.scheduled_by,
      created_at: job.created_at,
      model_id: '',
      cost_usd: 0,
    }
    const startedAt = nowIso()
    const t0 = Date.now()

    // claim (running)
    await upsertJob({
      ...base,
      status: 'running',
      output_results: null,
      error_message: null,
      attempt_count: job.attempt_count + 1,
      locked_by: 'cron',
      locked_at: startedAt,
      started_at: startedAt,
      completed_at: null,
      duration_seconds: null,
    })

    try {
      const cfg = JSON.parse(job.input_config) as { dateRange: AnalyticsDateRange; timezone: string }
      const ctx: GeneratorContext = {
        tenantId: job.tenant_id,
        siteId: job.site_id,
        dateRange: cfg.dateRange,
        timezone: cfg.timezone ?? 'Asia/Tokyo',
      }
      const { tickets, summary } = await runGenerator(job.report_type, ctx)
      await insertTickets(job, week, tickets)

      const durationSec = Math.round((Date.now() - t0) / 1000)
      await upsertJob({
        ...base,
        status: 'completed',
        output_results: JSON.stringify({ summary, ticket_count: tickets.length, week }),
        error_message: null,
        attempt_count: job.attempt_count + 1,
        locked_by: '',
        locked_at: null,
        started_at: startedAt,
        completed_at: nowIso(),
        duration_seconds: durationSec,
      })
      processed += 1
    } catch (err: unknown) {
      failed += 1
      const msg = err instanceof Error ? err.message : 'unknown'
      const durationSec = Math.round((Date.now() - t0) / 1000)
      await upsertJob({
        ...base,
        status: 'failed',
        output_results: null,
        error_message: msg.slice(0, 500),
        attempt_count: job.attempt_count + 1,
        locked_by: '',
        locked_at: null,
        started_at: startedAt,
        completed_at: nowIso(),
        duration_seconds: durationSec,
      })
      console.error(`[deep-research] job ${job.id} failed: ${msg}`)
    }
  }

  return { processed, failed }
}

// ── overview (read, propose tool 用) ─────────────────────────────────

export interface DeepResearchPlanOption {
  report_type: DeepResearchReportType
  label: string
  available: boolean
  reason: string
}
export interface DeepResearchJobStatus {
  id: string
  report_type: string
  status: string
  created_at: string
  completed_at: string | null
  summary: string | null
  ticket_count: number | null
}
export interface DeepResearchTicketView {
  report_type: string
  problem: string
  affected_segment: string
  recommended_change: string
  confidence: number
  evidence_level: string
}
export interface DeepResearchOverview {
  plans: DeepResearchPlanOption[]
  recent_jobs: DeepResearchJobStatus[]
  latest_tickets: DeepResearchTicketView[]
  periodStart: string
  periodEnd: string
  timezone: string
  note: string
}

function planAvailability(signalMap: Map<string, boolean>): DeepResearchPlanOption[] {
  const has = (k: string): boolean => signalMap.get(k) === true
  return [
    {
      report_type: 'uiux_audit',
      label: DEEP_RESEARCH_REPORT_LABELS.uiux_audit,
      available: has('clicks_dead_zones') || has('frustration_signals') || has('web_vitals'),
      reason: 'クリック/フラストレーション信号 or web_vitals が必要',
    },
    {
      report_type: 'cta_form_tickets',
      label: DEEP_RESEARCH_REPORT_LABELS.cta_form_tickets,
      available: has('element_visibility') || has('forms'),
      reason: 'element_visibility(CTA露出) or forms が必要',
    },
    {
      report_type: 'attention_action_gap',
      label: DEEP_RESEARCH_REPORT_LABELS.attention_action_gap,
      available: has('element_visibility'),
      reason: 'element_visibility(露出) が必要',
    },
  ]
}

export async function getDeepResearchOverview(params: {
  tenantId: string
  siteId: string
  dateRange: AnalyticsDateRange
  timezone: string
}): Promise<DeepResearchOverview> {
  const readiness = await executeDataReadinessQuery({ ...params })
  const signalMap = new Map<string, boolean>(readiness.signals.map((s) => [s.area, s.available]))
  const plans = planAvailability(signalMap)

  const reader = getClickHouseClient('analytics_reader')
  const jobsRs = await reader.query({
    query: `
SELECT id, report_type, status, toString(created_at) AS created_at,
       toString(completed_at) AS completed_at, output_results
FROM clickinsight.analysis_jobs FINAL
WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String}
ORDER BY created_at DESC
LIMIT 8
SETTINGS max_execution_time = 30`.trim(),
    query_params: { tenant_id: params.tenantId, site_id: params.siteId },
    format: 'JSONEachRow',
  })
  const jobRows = await jobsRs.json<{
    id: string
    report_type: string
    status: string
    created_at: string
    completed_at: string
    output_results: string | null
  }>()
  const recent_jobs: DeepResearchJobStatus[] = jobRows.map((j) => {
    let summary: string | null = null
    let ticketCount: number | null = null
    if (j.output_results) {
      try {
        const o = JSON.parse(j.output_results) as { summary?: string; ticket_count?: number }
        summary = o.summary ?? null
        ticketCount = typeof o.ticket_count === 'number' ? o.ticket_count : null
      } catch {
        // ignore malformed
      }
    }
    return {
      id: j.id,
      report_type: j.report_type,
      status: j.status,
      created_at: j.created_at,
      completed_at: j.completed_at && j.completed_at !== '1970-01-01 00:00:00' ? j.completed_at : null,
      summary,
      ticket_count: ticketCount,
    }
  })

  const latestCompleted = recent_jobs.find((j) => j.status === 'completed')
  let latest_tickets: DeepResearchTicketView[] = []
  if (latestCompleted) {
    const tRs = await reader.query({
      query: `
SELECT report_type, problem, affected_segment, recommended_change, confidence, evidence_level
FROM clickinsight.proposal_tickets FINAL
WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND job_id = {job_id:String}
ORDER BY confidence DESC
LIMIT 10
SETTINGS max_execution_time = 30`.trim(),
      query_params: { tenant_id: params.tenantId, site_id: params.siteId, job_id: latestCompleted.id },
      format: 'JSONEachRow',
    })
    latest_tickets = await tRs.json<DeepResearchTicketView>()
  }

  return {
    plans,
    recent_jobs,
    latest_tickets,
    periodStart: params.dateRange.start,
    periodEnd: params.dateRange.end,
    timezone: params.timezone,
    note: 'available=true のレポートを deep_research_enqueue で起動できます。recent_jobs に進行状況、latest_tickets に直近完了レポートのチケットが入ります。',
  }
}
