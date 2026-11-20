/**
 * UGOKI LINK v2 — Jev Public-Page-Text-Only Client (`lib/link/ml/llm/jev-client.ts`)
 *
 * Implements §8.12, §8.14, §14 Decision 31-b, Addendum §4:
 * - ABSOLUTE PAYLOAD GUARD: Accepts ONLY approved public page text (and public title/link copy
 *   vs section alignment). Physically throws `JevProhibitedPayloadError` if ANY visitor data,
 *   search query, or aggregate/metric statistics are present!
 * - NEVER usable as training label, weight, or distillation teacher (Owner Decision 31-b).
 * - Pinned versioned model names ONLY (rejects mutable aliases like `latest` / `default`).
 * - Deterministic option-order shuffle (cancels Jev's known first-option bias) + reverse mapping.
 * - Full raw response persistence & deterministic replay (`replayRecordedResponse`).
 * - Real external calls stay CLOSED (`not_entitled`) until contract retention/deletion terms,
 *   cross-border US processing region gate, and >=300 JP human label evaluation pass!
 */

import { isUntrustedValue, type UntrustedValue } from '../../../../packages/contract/response';
import { canonicalJsonStringify, sha256Hex } from '../../../../packages/contract/schema';
import type { LlmCostBudgetGuard } from './provider';

export class JevProhibitedPayloadError extends Error {
  public readonly violationCategory: 'visitor_data' | 'search_query' | 'aggregate_stats';
  public readonly forbiddenKeys: readonly string[];

  constructor(
    category: 'visitor_data' | 'search_query' | 'aggregate_stats',
    forbiddenKeys: readonly string[]
  ) {
    super(
      `§8.12 / §8.14 Jev Payload Prohibition Violation (${category}): Jev accepts approved PUBLIC PAGE TEXT ONLY. Forbidden keys detected: ${forbiddenKeys.join(', ')}`
    );
    this.name = 'JevProhibitedPayloadError';
    this.violationCategory = category;
    this.forbiddenKeys = forbiddenKeys;
  }
}

const VISITOR_KEYS = new Set([
  'visitor_id',
  'visitorId',
  'pv_id',
  'pvId',
  'session_id',
  'sessionId',
  'member_hash',
  'user_id',
  'cookie',
  'ip',
]);

const SEARCH_QUERY_KEYS = new Set([
  'search_query',
  'searchQuery',
  'query',
  'gsc_query',
  'organic_query',
  'keyword',
  'site_search_term',
]);

const AGGREGATE_STATS_KEYS = new Set([
  'aggregate_stats',
  'aggregates',
  'metrics',
  'conversion_rate',
  'cvr',
  'pv_count',
  'exit_rate',
  'dwell_ms',
  'revenue',
  'click_count',
  'cluster_stats',
]);

function inspectJevPayload(obj: unknown, depth = 0): void {
  if (depth > 6 || obj === null || obj === undefined || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) inspectJevPayload(item, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v !== undefined && v !== null) {
      if (VISITOR_KEYS.has(k)) {
        throw new JevProhibitedPayloadError('visitor_data', [k]);
      }
      if (SEARCH_QUERY_KEYS.has(k)) {
        throw new JevProhibitedPayloadError('search_query', [k]);
      }
      if (AGGREGATE_STATS_KEYS.has(k)) {
        throw new JevProhibitedPayloadError('aggregate_stats', [k]);
      }
    }
    if (typeof v === 'object' && v !== null) {
      inspectJevPayload(v, depth + 1);
    }
  }
}

const PINNED_VERSION_RE = /^[a-z0-9._-]+-20\d{2}-\d{2}-\d{2}(?:-[a-z0-9]+)?$/i;

export function assertPinnedJevModelVersion(modelVersion: string): void {
  if (
    !PINNED_VERSION_RE.test(modelVersion) ||
    /(?:latest|default|stable|auto)/i.test(modelVersion)
  ) {
    throw new Error(
      `§8.14 Jev calls MUST pin a dated model version (e.g. "jev-judge-2026-10-01"); alias "${modelVersion}" is rejected.`
    );
  }
}

export interface JevGateConfig {
  /** Signed contract defining retention period & deletion terms for US Jev processing (§8.14). */
  readonly contractRetentionDeletionSigned: boolean;
  /** Cross-border region gate (§11.11 #13) approved for US Jev processing. */
  readonly crossBorderRegionApproved: boolean;
  /** >= 300 Japanese human-label evaluation passed for this question category (§8.14). */
  readonly japaneseHumanEvalPassed300: boolean;
}

export interface JevJudgmentOption {
  readonly option_id: string;
  readonly label_ja: string;
}

export interface JevPublicPageRequest {
  readonly request_id: string;
  readonly pinned_model_version: string;
  readonly question_category: string;
  /** Approved public page section text (MUST be wrapped in UntrustedValue). */
  readonly public_section_text: UntrustedValue;
  /** Optional public title or anchor copy for title-vs-section alignment (NEVER a search query!). */
  readonly public_title_or_link_text?: UntrustedValue;
  readonly options: readonly JevJudgmentOption[];
  readonly estimated_cost_usd?: number;

  // Compile-time poison guards
  readonly visitor_id?: never;
  readonly pv_id?: never;
  readonly search_query?: never;
  readonly query?: never;
  readonly aggregate_stats?: never;
  readonly metrics?: never;
}

export interface JevRawRecordedResponse {
  readonly request_id: string;
  readonly pinned_model_version: string;
  readonly request_digest: string;
  readonly shuffled_option_order: readonly string[];
  readonly raw_chosen_shuffled_index: number;
  readonly mapped_option_id: string;
  readonly probability: number;
  readonly recorded_at_iso: string;
  /** Permanent provenance stamp so training dataset validators ALWAYS reject Jev outputs (D-31b). */
  readonly origin_source: 'jev_external_service';
  readonly prohibited_for_training: true;
}

export type JevCallResult =
  | {
      readonly status: 'ok';
      readonly from_replay_cache: boolean;
      readonly chosen_option_id: string;
      readonly probability: number;
      readonly recorded: JevRawRecordedResponse;
    }
  | {
      readonly status: 'not_entitled' | 'not_collected';
      readonly reason: string;
      readonly unmet_gates: readonly string[];
      readonly chosen_option_id: null;
      readonly probability: null;
      readonly recorded: null;
    };

/**
 * Deterministically shuffles options using request_id SHA-256 to neutralize Jev's
 * documented first-position bias (§8.14).
 */
export function shuffleJevOptionsDeterministically(
  options: readonly JevJudgmentOption[],
  seedKey: string
): readonly JevJudgmentOption[] {
  const arr = [...options];
  for (let i = arr.length - 1; i > 0; i--) {
    const h = sha256Hex(`${seedKey}:shuffle:${i}`).slice(0, 8);
    const j = parseInt(h, 16) % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

export type JevTransportFn = (params: {
  readonly pinned_model_version: string;
  readonly public_text: string;
  readonly shuffled_options: readonly JevJudgmentOption[];
}) => Promise<{ readonly chosen_shuffled_index: number; readonly probability: number }>;

export class JevPublicPageClient {
  private readonly gates: JevGateConfig;
  private readonly costGuard: LlmCostBudgetGuard;
  private readonly transport: JevTransportFn | null;
  private readonly recordedStore = new Map<string, JevRawRecordedResponse>();
  private readonly nowIso: () => string;

  constructor(options: {
    readonly gates: JevGateConfig;
    readonly costGuard: LlmCostBudgetGuard;
    /** Optional CI stub transport; null keeps live network calls strictly disabled. */
    readonly transport?: JevTransportFn | null;
    readonly nowIso?: () => string;
  }) {
    this.gates = { ...options.gates };
    this.costGuard = options.costGuard;
    this.transport = options.transport ?? null;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  public getRecordedResponse(requestDigest: string): JevRawRecordedResponse | undefined {
    return this.recordedStore.get(requestDigest);
  }

  public async judgePublicPageText(request: JevPublicPageRequest): Promise<JevCallResult> {
    // 1. Hard payload firewall: reject visitor data, search queries, or aggregates IMMEDIATELY!
    inspectJevPayload(request);

    if (!isUntrustedValue(request.public_section_text)) {
      throw new TypeError('public_section_text MUST be wrapped in UntrustedValue');
    }
    if (request.options.length < 2) {
      throw new Error('Jev judgment requires at least 2 options');
    }

    // 2. Enforce pinned dated model version (no mutable aliases!)
    assertPinnedJevModelVersion(request.pinned_model_version);

    // 3. Enforce contract + cross-border region + 300-label JP eval gates (§8.14)
    const unmet: string[] = [];
    if (!this.gates.contractRetentionDeletionSigned) {
      unmet.push('jev.contract_retention_deletion_signed');
    }
    if (!this.gates.crossBorderRegionApproved) {
      unmet.push('jev.cross_border_us_region_approved');
    }
    if (!this.gates.japaneseHumanEvalPassed300) {
      unmet.push('jev.jp_human_eval_300_passed');
    }
    if (unmet.length > 0) {
      return {
        status: 'not_entitled',
        reason: 'jev_external_gates_unmet',
        unmet_gates: unmet,
        chosen_option_id: null,
        probability: null,
        recorded: null,
      };
    }

    // 4. Deterministic replay cache lookup (guarantees reproducibility without seed param)
    const digest = sha256Hex(
      canonicalJsonStringify({
        pinned_model_version: request.pinned_model_version,
        question_category: request.question_category,
        text_sha: request.public_section_text.sha,
        title_sha: request.public_title_or_link_text?.sha ?? null,
        option_ids: request.options.map((o) => o.option_id),
      })
    );
    const cached = this.recordedStore.get(digest);
    if (cached) {
      return {
        status: 'ok',
        from_replay_cache: true,
        chosen_option_id: cached.mapped_option_id,
        probability: cached.probability,
        recorded: cached,
      };
    }

    if (!this.transport) {
      return {
        status: 'not_entitled',
        reason: 'jev_live_transport_disabled',
        unmet_gates: ['jev.live_transport_configured'],
        chosen_option_id: null,
        probability: null,
        recorded: null,
      };
    }

    // 5. Cost cap enforcement
    const costUsd = request.estimated_cost_usd ?? 0.005;
    if (!this.costGuard.recordSpend('jev', costUsd)) {
      return {
        status: 'not_collected',
        reason: 'cost_cap_exceeded:jev',
        unmet_gates: ['jev.cost_budget'],
        chosen_option_id: null,
        probability: null,
        recorded: null,
      };
    }

    // 6. Shuffle options to neutralize position bias, call transport, map back & persist raw response
    const shuffled = shuffleJevOptionsDeterministically(
      request.options,
      `${request.request_id}:${digest}`
    );
    const rawText = [
      request.public_title_or_link_text?.value ?? '',
      request.public_section_text.value ?? '',
    ]
      .filter(Boolean)
      .join('\n---\n');

    const rawRes = await this.transport({
      pinned_model_version: request.pinned_model_version,
      public_text: rawText,
      shuffled_options: shuffled,
    });

    const boundedIdx = Math.max(0, Math.min(shuffled.length - 1, Math.trunc(rawRes.chosen_shuffled_index)));
    const mapped = shuffled[boundedIdx];

    const recorded: JevRawRecordedResponse = {
      request_id: request.request_id,
      pinned_model_version: request.pinned_model_version,
      request_digest: digest,
      shuffled_option_order: shuffled.map((o) => o.option_id),
      raw_chosen_shuffled_index: boundedIdx,
      mapped_option_id: mapped.option_id,
      probability: Math.max(0, Math.min(1, rawRes.probability)),
      recorded_at_iso: this.nowIso(),
      origin_source: 'jev_external_service',
      prohibited_for_training: true,
    };

    this.recordedStore.set(digest, recorded);

    return {
      status: 'ok',
      from_replay_cache: false,
      chosen_option_id: mapped.option_id,
      probability: recorded.probability,
      recorded,
    };
  }
}
