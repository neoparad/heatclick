/**
 * UGOKI LINK v2 — 束 6-B (手順 22, §7.6): AI 使いにくさ 4 計器（非混合契約）
 */

import {
  runOperabilityAudit,
  type OperabilityAuditOptions,
  type OperabilityAuditResult,
  type RenderPageResult,
} from '@/lib/link/lab'
import {
  assertNoModelInferredInputFeatures,
  isLocalAiClassifierFeatureMetric,
  type FeatureProvenanceDescriptor,
} from '@/lib/link/heatmap-render'
import type { EvidenceLevel } from '@/packages/contract/response'

export type FrictionInstrumentKind =
  | 'A_operability_audit'
  | 'B_lab_task_run'
  | 'C_http_crawler_friction'
  | 'D_wild_browser_ai'

export interface TaggedInstrumentOutput {
  readonly instrument: FrictionInstrumentKind
}

export function assertNoCrossInstrumentMixing(
  outputs: readonly TaggedInstrumentOutput[],
): FrictionInstrumentKind | null {
  if (outputs.length === 0) return null
  const first = outputs[0].instrument
  for (let i = 1; i < outputs.length; i++) {
    if (outputs[i].instrument !== first) {
      throw new Error(
        `Cross-instrument mixing prohibited (§7.6): cannot combine "${first}" with "${outputs[i].instrument}"`,
      )
    }
  }
  return first
}

export interface InstrumentAOutput extends TaggedInstrumentOutput {
  readonly instrument: 'A_operability_audit'
  readonly evidence: 'observed'
  readonly valid_with_zero_traffic: true
  readonly audit: OperabilityAuditResult
}

export function runInstrumentAOperability(
  render: RenderPageResult,
  options?: OperabilityAuditOptions,
): InstrumentAOutput {
  const audit = runOperabilityAudit(render, options)
  return Object.freeze({
    instrument: 'A_operability_audit',
    evidence: 'observed',
    valid_with_zero_traffic: true,
    audit,
  })
}

export type LabRunExecutionEnvironment = 'controlled_executor' | 'uncontrolled_cloud_or_panel'

export interface LabTaskRunTrial {
  readonly trial_id: string
  readonly arm: 'control' | 'treatment'
  readonly succeeded: boolean
  readonly blocking_el_fp: string | null
  readonly affiliate_requests_observed: number
  readonly human_data_contaminated: boolean
  readonly test_marker_persisted?: boolean
  readonly multi_page_task: boolean
}

export interface InstrumentBOutput extends TaggedInstrumentOutput {
  readonly instrument: 'B_lab_task_run'
  readonly scope: {
    readonly framework: string
    readonly model_version: string
    readonly page_version: string
    readonly task_id: string
  }
  readonly execution_environment: LabRunExecutionEnvironment
  readonly affiliate_sink_replaced: boolean
  readonly zero_guarantee_applicable: boolean
  readonly affiliate_requests_zero_gate_passed: boolean | null
  readonly human_contamination_zero_gate_passed: boolean | null
  readonly marker_persistence_rate: number | null
  readonly control_success_rate: number
  readonly treatment_success_rate: number | null
  readonly lift: number | null
  readonly top_blocking_el_fp: string | null
  readonly randomized_simultaneous_comparison: boolean
  readonly evidence: Extract<EvidenceLevel, 'observed' | 'proven'>
  readonly usable_for_visitor_projection: false
}

export function evaluateInstrumentBLabTaskRun(params: {
  readonly framework: string
  readonly model_version: string
  readonly page_version: string
  readonly task_id: string
  readonly execution_environment: LabRunExecutionEnvironment
  readonly affiliate_sink_replaced: boolean
  readonly has_server_side_sink_route: boolean
  readonly page_has_affiliate_slots: boolean
  readonly randomized_simultaneous_comparison: boolean
  readonly statistical_test_passed: boolean
  readonly trials: readonly LabTaskRunTrial[]
}): InstrumentBOutput {
  if (
    params.execution_environment === 'uncontrolled_cloud_or_panel' &&
    !params.has_server_side_sink_route &&
    params.page_has_affiliate_slots
  ) {
    throw new Error(
      'Uncontrolled agent/panel runs on pages with affiliate slots require a server-side sink replacement route (§7.6)',
    )
  }

  const statelessViolation =
    params.execution_environment === 'uncontrolled_cloud_or_panel' &&
    params.trials.some((t) => t.multi_page_task && t.test_marker_persisted === false)
  if (statelessViolation) {
    throw new Error(
      'Uncontrolled agents that cannot persist test markers must be restricted to landing-page-only tasks (§7.6)',
    )
  }

  const controls = params.trials.filter((t) => t.arm === 'control')
  const treats = params.trials.filter((t) => t.arm === 'treatment')

  const ctrlRate =
    controls.length > 0 ? controls.filter((t) => t.succeeded).length / controls.length : 0
  const treatRate =
    treats.length > 0 ? treats.filter((t) => t.succeeded).length / treats.length : null
  const lift = treatRate !== null ? treatRate - ctrlRate : null

  const blockCounts = new Map<string, number>()
  for (const t of params.trials) {
    if (!t.succeeded && t.blocking_el_fp) {
      blockCounts.set(t.blocking_el_fp, (blockCounts.get(t.blocking_el_fp) ?? 0) + 1)
    }
  }
  let topBlocking: string | null = null
  let maxBlock = 0
  for (const [el, cnt] of blockCounts.entries()) {
    if (cnt > maxBlock) {
      maxBlock = cnt
      topBlocking = el
    }
  }

  const isControlled = params.execution_environment === 'controlled_executor'
  const totalAffReqs = params.trials.reduce((s, t) => s + t.affiliate_requests_observed, 0)
  const anyContam = params.trials.some((t) => t.human_data_contaminated)

  const markerTracked = params.trials.filter((t) => typeof t.test_marker_persisted === 'boolean')
  const markerPersistenceRate =
    !isControlled && markerTracked.length > 0
      ? markerTracked.filter((t) => t.test_marker_persisted).length / markerTracked.length
      : null

  const provenValid =
    params.randomized_simultaneous_comparison &&
    params.statistical_test_passed &&
    controls.length > 0 &&
    treats.length > 0 &&
    (!isControlled || (totalAffReqs === 0 && !anyContam))

  return Object.freeze({
    instrument: 'B_lab_task_run',
    scope: Object.freeze({
      framework: params.framework,
      model_version: params.model_version,
      page_version: params.page_version,
      task_id: params.task_id,
    }),
    execution_environment: params.execution_environment,
    affiliate_sink_replaced: params.affiliate_sink_replaced,
    zero_guarantee_applicable: isControlled,
    affiliate_requests_zero_gate_passed: isControlled ? totalAffReqs === 0 : null,
    human_contamination_zero_gate_passed: isControlled ? !anyContam : null,
    marker_persistence_rate: markerPersistenceRate,
    control_success_rate: ctrlRate,
    treatment_success_rate: treatRate,
    lift,
    top_blocking_el_fp: topBlocking,
    randomized_simultaneous_comparison: params.randomized_simultaneous_comparison,
    evidence: provenValid ? 'proven' : 'observed',
    usable_for_visitor_projection: false,
  })
}

export interface InstrumentCOutput extends TaggedInstrumentOutput {
  readonly instrument: 'C_http_crawler_friction'
  readonly actor_id: string
  readonly has_screen: false
  readonly evidence: 'observed'
  readonly total_requests: number
  readonly status_distribution: Readonly<Record<string, number>>
  readonly redirect_count: number
  readonly disallowed_robots_requests: number
  readonly blocked_403_429_count: number
  readonly truncated_response_count: number
  readonly raw_html_missing_section_count: number
}

export function buildInstrumentCHttpCrawlerFriction(params: {
  readonly actor_id: string
  readonly status_distribution: Readonly<Record<string, number>>
  readonly redirect_count: number
  readonly disallowed_robots_requests: number
  readonly blocked_403_429_count: number
  readonly truncated_response_count: number
  readonly raw_html_missing_section_count: number
}): InstrumentCOutput {
  const total = Object.values(params.status_distribution).reduce((s, n) => s + Math.max(0, n), 0)
  return Object.freeze({
    instrument: 'C_http_crawler_friction',
    actor_id: params.actor_id,
    has_screen: false,
    evidence: 'observed',
    total_requests: total,
    status_distribution: Object.freeze({ ...params.status_distribution }),
    redirect_count: params.redirect_count,
    disallowed_robots_requests: params.disallowed_robots_requests,
    blocked_403_429_count: params.blocked_403_429_count,
    truncated_response_count: params.truncated_response_count,
    raw_html_missing_section_count: params.raw_html_missing_section_count,
  })
}

export type WildBrowserAiSubTier =
  | 'verified_hosted_agent'
  | 'explicit_evidence'
  | 'model_inferred'

export interface WildAgentActionStep {
  readonly el_fp: string | null
  readonly sec_fp: string | null
  readonly action_kind: 'click' | 'scroll' | 'focus' | 'navigate' | 'submit'
  readonly duration_ms: number
  readonly outcome: 'navigated' | 'dom_changed' | 'no_effect' | 'error'
  readonly input_value?: never
}

const FORBIDDEN_INPUT_VALUE_KEYS = new Set([
  'input_value',
  'typed_text',
  'form_value',
  'field_value',
  'raw_input',
])

const FORBIDDEN_WILD_STUCK_TERMS = ['詰まった', '詰まり', 'stuck', 'failed_goal', 'abandoned_task']

export interface InstrumentDOutput extends TaggedInstrumentOutput {
  readonly instrument: 'D_wild_browser_ai'
  readonly sub_tier: WildBrowserAiSubTier
  readonly evidence: Extract<EvidenceLevel, 'observed' | 'inferred'>
  readonly action_trace: readonly WildAgentActionStep[] | null
  readonly behavioral_metrics: Readonly<Record<string, number>>
  readonly behavioral_summary_note: string
  readonly intent_known: false
}

export function buildInstrumentDWildBrowserAi(params: {
  readonly sub_tier: WildBrowserAiSubTier
  readonly action_trace?: readonly WildAgentActionStep[]
  readonly behavioral_metrics: Readonly<Record<string, number>>
  readonly behavioral_summary_note: string
  readonly input_feature_provenances?:
    | readonly FeatureProvenanceDescriptor[]
    | Readonly<Record<string, string>>
}): InstrumentDOutput {
  assertNoModelInferredInputFeatures(params.input_feature_provenances)
  const lowNote = params.behavioral_summary_note.toLowerCase()
  for (const term of FORBIDDEN_WILD_STUCK_TERMS) {
    if (lowNote.includes(term.toLowerCase())) {
      throw new Error(
        `Prohibited wild-intent wording "${term}" in Instrument D summary (§7.6: wild goal is unknown; report behavior only)`,
      )
    }
  }

  if (params.action_trace) {
    for (const step of params.action_trace) {
      for (const k of Object.keys(step as unknown as Record<string, unknown>)) {
        if (FORBIDDEN_INPUT_VALUE_KEYS.has(k.toLowerCase())) {
          throw new Error(`Input value field "${k}" is strictly prohibited in Instrument D trace (§7.6)`)
        }
      }
    }
  }

  if (params.sub_tier === 'model_inferred') {
    const leaked = Object.keys(params.behavioral_metrics).filter((k) =>
      isLocalAiClassifierFeatureMetric(k),
    )
    if (leaked.length > 0) {
      throw new Error(
        `Classifier feature metric(s) [${leaked.join(', ')}] prohibited for Instrument D model_inferred (§7.6)`,
      )
    }
  }

  return Object.freeze({
    instrument: 'D_wild_browser_ai',
    sub_tier: params.sub_tier,
    evidence: params.sub_tier === 'model_inferred' ? 'inferred' : 'observed',
    action_trace:
      params.sub_tier === 'verified_hosted_agent'
        ? Object.freeze([...(params.action_trace ?? [])])
        : null,
    behavioral_metrics: Object.freeze({ ...params.behavioral_metrics }),
    behavioral_summary_note: params.behavioral_summary_note,
    intent_known: false,
  })
}
