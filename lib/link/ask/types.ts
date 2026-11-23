/**
 * UGOKI LINK v2 — Natural-Language Read Endpoint (`POST /v1/ask`) & 1,000-Question Eval Types
 *
 * Implements Master Architecture v2 §11.11 item 11 & gate `surf.ask_accuracy`.
 */

import type {
  MeasureStatus,
  SerializedResponseEnvelope,
  UntrustedValue,
  VerifiedMetricValue,
} from '@/packages/contract/response';
import type { ConsentMode } from '@/packages/contract/schema';
import type { VerifiedPrincipal } from '@/lib/link/auth';

// =========================================================================
// 1. Read-Only Tool Whitelist & Self-Hosted Model Provider Contract
// =========================================================================

/**
 * Physical read-only tool allowlist for the `/v1/ask` planner.
 * Write, publish, delete, and delegation operations are physically absent from this list.
 */
export const READ_ONLY_ASK_TOOLS = [
  'query_public_site_daily',
  'query_public_page_daily',
  'query_public_section_daily',
  'query_public_segment_agg',
  'query_public_funnel_agg',
  'query_public_ai_actor_daily',
] as const;

export type ReadOnlyAskToolName = (typeof READ_ONLY_ASK_TOOLS)[number];

export const PUBLIC_AGGREGATE_VIEWS = [
  'v_pub_site_daily',
  'v_pub_page_daily',
  'v_pub_section_daily',
  'v_pub_segment_agg',
  'v_pub_funnel_agg',
  'v_pub_experiment_summary',
  'v_pub_ai_actor_daily',
] as const;

export type PublicAggregateViewName = (typeof PUBLIC_AGGREGATE_VIEWS)[number];

export type AskModelHosting = 'self_hosted_local' | 'deterministic_baseline' | 'external_cloud' | 'jev';

export interface AskPlan {
  readonly kind: 'execute_query' | 'refuse';
  readonly toolName?: ReadOnlyAskToolName;
  readonly viewName?: PublicAggregateViewName;
  readonly metricName?: string;
  readonly sql?: string;
  readonly requestedColumns?: ReadonlyArray<string>;
  readonly groupByColumns?: ReadonlyArray<string>;
  readonly filterSignature?: string;
  readonly cohortMemberIds?: ReadonlyArray<string>;
  readonly refusalStatus?: Extract<MeasureStatus, 'not_collected' | 'insufficient_data' | 'not_entitled' | 'suppressed' | 'not_applicable'>;
  readonly refusalReason?: string;
  readonly refusalGateId?: string;
  readonly hypothesisTemplate?: string;
}

export interface AskPlannerContext {
  /** Wrapped in UntrustedValue so the planner never treats user input as privileged instructions. */
  readonly untrustedQuestion: UntrustedValue;
  /** Table & column metadata wrapped in UntrustedValue (§11.11.11). */
  readonly untrustedSchemaCatalog: ReadonlyArray<{
    readonly viewName: PublicAggregateViewName;
    readonly description: UntrustedValue;
    readonly columns: ReadonlyArray<UntrustedValue>;
  }>;
  readonly allowedTools: ReadonlyArray<ReadOnlyAskToolName>;
  readonly siteConsentMode: ConsentMode;
  readonly windowStart: string;
  readonly windowEnd: string;
}

/**
 * Thin pluggable interface for Wave 4-G self-hosted LLM (Muse Glimmer 30B / Gemma 4)
 * or the deterministic rule/template baseline.
 */
export interface AskPlannerProvider {
  readonly providerId: string;
  readonly modelName: string;
  readonly hosting: AskModelHosting;
  plan(ctx: AskPlannerContext): AskPlan;
}

// =========================================================================
// 2. Query Result Rows & Pre-LLM Filter Verdict
// =========================================================================

export interface AggregateQueryRow {
  readonly bucketLabel: string;
  readonly unitCount: number;
  readonly metricKey: string;
  readonly metricValue: number;
  readonly unit: string;
  readonly cohortMemberIds?: ReadonlyArray<string>;
  readonly extraColumns?: Readonly<Record<string, unknown>>;
}

export interface AskDataExecutor {
  executePublicViewQuery(params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly viewName: PublicAggregateViewName;
    readonly metricName: string;
    readonly sql: string;
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly filterSignature?: string;
  }): {
    readonly connected: boolean;
    readonly rows: ReadonlyArray<AggregateQueryRow>;
    readonly queryRefId: string;
    readonly paramsHash: string;
    readonly resultDigest: string;
  };
}

export interface PreLlmFilterVerdict {
  readonly allowed: boolean;
  readonly blockedCode?:
    | 'CONSENT_OFF_BLOCKED'
    | 'CONSENT_PURPOSE_MISMATCH'
    | 'NON_READ_ONLY_TOOL'
    | 'NON_WHITELISTED_VIEW'
    | 'NON_ALLOWED_METRIC'
    | 'SQL_AST_VIOLATION'
    | 'IDENTIFIER_COLUMN_BLOCKED'
    | 'FREE_TEXT_COLUMN_BLOCKED'
    | 'PER_PERSON_AGGREGATION_BLOCKED'
    | 'SMALL_CELL_SUPPRESSED'
    | 'DIFFERENCING_ATTACK_BLOCKED';
  readonly reason?: string;
  readonly safeRows: ReadonlyArray<AggregateQueryRow>;
  readonly suppressedCount: number;
  readonly secondarySuppressedCount?: number;
  readonly commitDisclosureHistory?: () => void;
}

// =========================================================================
// 3. Conversation Isolation Key & Ask Request / Response
// =========================================================================

export interface AskConversationKey {
  readonly tenantId: string;
  readonly siteId: string;
  readonly permissionEpoch: number;
}

export interface AskRequest {
  readonly principal: VerifiedPrincipal;
  readonly siteId: string;
  readonly siteTenantId: string;
  readonly siteConsentMode: ConsentMode;
  readonly permissionEpoch: number;
  readonly question: string;
  readonly windowStart?: string;
  readonly windowEnd?: string;
  readonly callerSuppliedTenantId?: string;
  readonly storageRegion?: string;
  readonly processingRegion?: string;
  readonly now?: Date;
}

export interface GroundedNumericCitation {
  readonly citationId: string;
  readonly metricKey: string;
  readonly value: number;
  readonly unit: string;
  readonly provenanceRef: string;
  readonly verifiedMetric: VerifiedMetricValue<number>;
}

export interface HypothesisStatement {
  readonly kind: 'hypothesis';
  readonly label: '仮説 (hypothesis)';
  readonly text: string;
}

export interface AskExecutionOutcome {
  readonly httpStatus: 200 | 400 | 403 | 404;
  readonly allowed: boolean;
  readonly envelope?: SerializedResponseEnvelope;
  readonly executedSql: string | null;
  readonly citations: ReadonlyArray<GroundedNumericCitation>;
  readonly answerText: string | null;
  readonly hypotheses: ReadonlyArray<HypothesisStatement>;
  readonly passedForbiddenDataToModel: boolean;
  readonly returnedUnauthorizedData: boolean;
  readonly auditCode: string;
}
