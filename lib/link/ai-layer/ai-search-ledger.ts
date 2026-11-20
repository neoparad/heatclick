/**
 * UGOKI LINK v2 — 束 6-B (手順 22, §7.7): AI 検索 8 段階統合台帳
 */

import {
  computeReferrerlessAiTrafficLift,
  detectCrawlerTrafficSpike,
  evaluateTrainingCrawlerValue,
  type CitationBracketingResult,
  type EligibilitySnapshot,
} from '@/lib/link/search'
import type { EvidenceLevel } from '@/packages/contract/response'

export interface SurfaceFetchMetricsInput {
  readonly surface_id: string
  readonly operator: string
  readonly shared_search_and_ai_crawler: boolean
  readonly training_fetches: number
  readonly indexing_fetches: number
  readonly user_triggered_fetches: number
  readonly total_transfer_bytes: number
  readonly estimated_bandwidth_cost_jpy: number
  readonly current_hour_requests: number
  readonly historical_same_slot_weeks: readonly number[]
}

export interface SurfaceCitationInput {
  readonly probe_cited_queries: number
  readonly probe_total_queries: number
  readonly probe_configuration_id: string
  readonly wild_citation_bracket: CitationBracketingResult | null
}

export interface SurfaceTrafficAndOutcomeInput {
  readonly attributed_referrer_sessions: number
  readonly visits_in_30m_after_fetch: number
  readonly visits_in_matched_control_30m: number
  readonly fetch_event_count_for_30m_window: number
  readonly serp_ai_click_three_estimates?: readonly [number, number, number] | null
  readonly engaged_section_sessions: number
  readonly attributed_conversions: number
  readonly observed_revenue_jpy: number
  readonly value_per_session_jpy: number
}

export interface AiSearchSurfaceLedger {
  readonly surface_id: string
  readonly operator: string
  readonly shared_search_and_ai_crawler: boolean
  readonly stages_separable: boolean
  readonly shared_crawler_caveat: string | null
  readonly stages: {
    readonly stage_0_eligibility: {
      readonly evidence: 'observed'
      readonly snapshot_id: string
      readonly token_policies: EligibilitySnapshot['token_policies']
    }
    readonly stage_1_training_fetch: {
      readonly evidence: 'observed'
      readonly purpose_basis: 'vendor_declared'
      readonly fetches: number
      readonly economic_value: ReturnType<typeof evaluateTrainingCrawlerValue>
    }
    readonly stage_2_indexing_fetch: {
      readonly evidence: 'observed'
      readonly purpose_basis: 'vendor_declared'
      readonly fetches: number
    }
    readonly stage_3_user_triggered_fetch: {
      readonly evidence: 'observed'
      readonly purpose_basis: 'vendor_declared'
      readonly fetches: number
    }
    readonly stage_4_citation: {
      readonly probe_config: {
        readonly evidence: 'observed'
        readonly scope: 'surface_and_configuration_only'
        readonly configuration_id: string
        readonly cited_queries: number
        readonly total_queries: number
      }
      readonly wild_estimate: {
        readonly evidence: 'inferred'
        readonly lower: number | null
        readonly upper: number | null
      }
    }
    readonly stage_5_ai_traffic: {
      readonly attributed_referrer_lower_bound: {
        readonly evidence: 'observed'
        readonly sessions: number
      }
      readonly referrerless_30m_lift: {
        readonly evidence: 'inferred'
        readonly point: number
        readonly lower_95: number
        readonly upper_95: number
      }
      readonly serp_ai_clicks_three_estimator_band: {
        readonly evidence: 'inferred'
        readonly low: number | null
        readonly mid: number | null
        readonly high: number | null
      }
    }
    readonly stage_6_engagement: {
      readonly evidence: 'observed'
      readonly unit: 'section_level'
      readonly engaged_sessions: number
    }
    readonly stage_7_conversions: {
      readonly evidence: 'observed'
      readonly unit: 'section_level'
      readonly conversions: number
      readonly observed_revenue_jpy: number
    }
  }
  readonly economics: {
    readonly total_fetches: number
    readonly traffic_bytes_per_attributed_session: number | null
    readonly visits_per_fetch_lower_observed: number | null
    readonly visits_per_fetch_upper_inferred: number | null
    readonly value_vs_cost_range: {
      readonly lower_observed_value_jpy: number
      readonly mid_inferred_value_jpy: number
      readonly upper_inferred_value_jpy: number
      readonly bandwidth_cost_jpy: number
      readonly lower_evidence: Extract<EvidenceLevel, 'observed'>
      readonly mid_upper_evidence: Extract<EvidenceLevel, 'inferred'>
    }
  }
  readonly spike_alert: ReturnType<typeof detectCrawlerTrafficSpike>
}

export interface AiSearchIntegratedLedger {
  readonly tenant_id: string
  readonly site_id: string
  readonly generated_at: string
  readonly surfaces: readonly AiSearchSurfaceLedger[]
}

export function buildAiSearchSurfaceLedger(params: {
  readonly eligibility: EligibilitySnapshot
  readonly fetches: SurfaceFetchMetricsInput
  readonly citations: SurfaceCitationInput
  readonly traffic: SurfaceTrafficAndOutcomeInput
}): AiSearchSurfaceLedger {
  const f = params.fetches
  const c = params.citations
  const t = params.traffic

  const totalFetches = f.training_fetches + f.indexing_fetches + f.user_triggered_fetches
  const refLift = computeReferrerlessAiTrafficLift({
    visits_in_30m_after_fetch: t.visits_in_30m_after_fetch,
    visits_in_matched_control_30m: t.visits_in_matched_control_30m,
    event_count: t.fetch_event_count_for_30m_window,
  })

  const serpBand = t.serp_ai_click_three_estimates
    ? [...t.serp_ai_click_three_estimates].sort((a, b) => a - b)
    : null

  const lowerVisits = t.attributed_referrer_sessions
  const midVisits =
    t.attributed_referrer_sessions + refLift.point_lift_visits + (serpBand ? serpBand[1] : 0)
  const upperVisits =
    t.attributed_referrer_sessions + refLift.upper_95 + (serpBand ? serpBand[2] : 0)

  const lowerObservedVal = t.observed_revenue_jpy
  const midInferredVal = Math.max(lowerObservedVal, midVisits * t.value_per_session_jpy)
  const upperInferredVal = Math.max(midInferredVal, upperVisits * t.value_per_session_jpy)

  const spikeAlert = detectCrawlerTrafficSpike({
    current_hour_requests: f.current_hour_requests,
    historical_same_slot_weeks: f.historical_same_slot_weeks,
  })

  return Object.freeze({
    surface_id: f.surface_id,
    operator: f.operator,
    shared_search_and_ai_crawler: f.shared_search_and_ai_crawler,
    stages_separable: !f.shared_search_and_ai_crawler,
    shared_crawler_caveat: f.shared_search_and_ai_crawler
      ? 'Shared search+AI crawler (e.g., Googlebot): search indexing and AI stages cannot be separated from HTTP fetch logs (§7.7)'
      : null,
    stages: Object.freeze({
      stage_0_eligibility: Object.freeze({
        evidence: 'observed',
        snapshot_id: params.eligibility.snapshot_id,
        token_policies: params.eligibility.token_policies,
      }),
      stage_1_training_fetch: Object.freeze({
        evidence: 'observed',
        purpose_basis: 'vendor_declared',
        fetches: f.training_fetches,
        economic_value: evaluateTrainingCrawlerValue(),
      }),
      stage_2_indexing_fetch: Object.freeze({
        evidence: 'observed',
        purpose_basis: 'vendor_declared',
        fetches: f.indexing_fetches,
      }),
      stage_3_user_triggered_fetch: Object.freeze({
        evidence: 'observed',
        purpose_basis: 'vendor_declared',
        fetches: f.user_triggered_fetches,
      }),
      stage_4_citation: Object.freeze({
        probe_config: Object.freeze({
          evidence: 'observed',
          scope: 'surface_and_configuration_only',
          configuration_id: c.probe_configuration_id,
          cited_queries: c.probe_cited_queries,
          total_queries: c.probe_total_queries,
        }),
        wild_estimate: Object.freeze({
          evidence: 'inferred',
          lower: c.wild_citation_bracket?.wild_citations_lower ?? null,
          upper: c.wild_citation_bracket?.wild_citations_upper ?? null,
        }),
      }),
      stage_5_ai_traffic: Object.freeze({
        attributed_referrer_lower_bound: Object.freeze({
          evidence: 'observed',
          sessions: t.attributed_referrer_sessions,
        }),
        referrerless_30m_lift: Object.freeze({
          evidence: 'inferred',
          point: refLift.point_lift_visits,
          lower_95: refLift.lower_95,
          upper_95: refLift.upper_95,
        }),
        serp_ai_clicks_three_estimator_band: Object.freeze({
          evidence: 'inferred',
          low: serpBand ? serpBand[0] : null,
          mid: serpBand ? serpBand[1] : null,
          high: serpBand ? serpBand[2] : null,
        }),
      }),
      stage_6_engagement: Object.freeze({
        evidence: 'observed',
        unit: 'section_level',
        engaged_sessions: t.engaged_section_sessions,
      }),
      stage_7_conversions: Object.freeze({
        evidence: 'observed',
        unit: 'section_level',
        conversions: t.attributed_conversions,
        observed_revenue_jpy: t.observed_revenue_jpy,
      }),
    }),
    economics: Object.freeze({
      total_fetches: totalFetches,
      traffic_bytes_per_attributed_session:
        t.attributed_referrer_sessions > 0
          ? f.total_transfer_bytes / t.attributed_referrer_sessions
          : null,
      visits_per_fetch_lower_observed: totalFetches > 0 ? lowerVisits / totalFetches : null,
      visits_per_fetch_upper_inferred: totalFetches > 0 ? upperVisits / totalFetches : null,
      value_vs_cost_range: Object.freeze({
        lower_observed_value_jpy: lowerObservedVal,
        mid_inferred_value_jpy: midInferredVal,
        upper_inferred_value_jpy: upperInferredVal,
        bandwidth_cost_jpy: f.estimated_bandwidth_cost_jpy,
        lower_evidence: 'observed',
        mid_upper_evidence: 'inferred',
      }),
    }),
    spike_alert: spikeAlert,
  })
}

export function buildAiSearchLedger(params: {
  readonly tenant_id: string
  readonly site_id: string
  readonly generated_at: string
  readonly entries: readonly {
    readonly eligibility: EligibilitySnapshot
    readonly fetches: SurfaceFetchMetricsInput
    readonly citations: SurfaceCitationInput
    readonly traffic: SurfaceTrafficAndOutcomeInput
  }[]
}): AiSearchIntegratedLedger {
  return Object.freeze({
    tenant_id: params.tenant_id,
    site_id: params.site_id,
    generated_at: params.generated_at,
    surfaces: Object.freeze(params.entries.map((e) => buildAiSearchSurfaceLedger(e))),
  })
}
