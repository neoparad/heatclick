/**
 * UGOKI LINK v2 — Natural-Language Read Endpoint Service (`POST /v1/ask`)
 *
 * Implements Master Architecture v2 §11.11 item 11:
 *   - Strictly read-only planner (physical exclusion of write/publish tools)
 *   - Zero raw SQL metric string concatenation (static precompiled SQL lookup only)
 *   - Enforces self-hosted/baseline provider only (external cloud LLMs & Jev banned)
 *   - Wraps question, column names, and table descriptions in `UntrustedValue`
 *   - Isolates conversation & cache strictly by `(tenant_id, site_id, permission_epoch)`
 *   - Runs independent pre-execution privacy/SQL/window-differencing gate BEFORE DB execution
 *   - Enforces primary `< 10` + complementary secondary suppression on `GROUP BY` results
 *   - Grounds every numeric figure exclusively in `VerifiedMetricValue` citations
 *   - Marks every interpretation explicitly as `hypothesis`
 *   - Serializes every output through `buildResponseEnvelope` (`packages/contract/response`)
 */

import {
  buildResponseEnvelope,
  createDataLayerMetric,
  sha256Hex,
  wrapUntrusted,
  type EvidenceRef,
  type MeasureInput,
  type VerifiedNumericLeaf,
} from '@/packages/contract/response';
import {
  ASK_MIN_CELL_K,
  DifferencingGuard,
  assertSelfHostedProviderOnly,
  filterQueryAndRowsBeforeLlm,
  validateAskQueryBeforeExecution,
  verifyAnswerNumericReferences,
} from './pre-llm-filter';
import {
  PUBLIC_AGGREGATE_VIEWS,
  READ_ONLY_ASK_TOOLS,
  type AskDataExecutor,
  type AskExecutionOutcome,
  type AskPlan,
  type AskPlannerContext,
  type AskPlannerProvider,
  type AskRequest,
  type GroundedNumericCitation,
  type HypothesisStatement,
  type PublicAggregateViewName,
} from './types';

// =========================================================================
// 1. Public View Metadata Catalog & Static Precompiled SQL Lookup ([M-06])
// =========================================================================

const PUBLIC_VIEW_SCHEMAS: ReadonlyArray<{
  readonly viewName: PublicAggregateViewName;
  readonly description: string;
  readonly columns: ReadonlyArray<string>;
}> = [
  {
    viewName: 'v_pub_site_daily',
    description: 'Site-level daily aggregate page views, conversions, CVR, and focal dwell time',
    columns: ['day_local', 'page_views', 'conversions', 'cvr', 'avg_focal_dwell_ms'],
  },
  {
    viewName: 'v_pub_page_daily',
    description: 'Page-level daily aggregate page views, bounce proxy, and conversions',
    columns: ['day_local', 'page_id', 'page_views', 'conversions', 'avg_focal_dwell_ms'],
  },
  {
    viewName: 'v_pub_section_daily',
    description: 'Section-level reach rate and focal dwell time (proxy bounded by tel.U1)',
    columns: ['day_local', 'page_id', 'sec_fp', 'reach_rate', 'avg_focal_dwell_ms'],
  },
  {
    viewName: 'v_pub_segment_agg',
    description: 'Registered segment aggregate comparison (k >= 10 enforced)',
    columns: ['day_local', 'segment_id', 'page_views', 'conversions', 'cvr'],
  },
  {
    viewName: 'v_pub_funnel_agg',
    description: 'Ordered conversion funnel aggregates (requires consent >= session)',
    columns: ['day_local', 'funnel_step', 'sessions', 'step_conversion_rate'],
  },
  {
    viewName: 'v_pub_ai_actor_daily',
    description: 'Observed verified crawler and AI actor access aggregates',
    columns: ['day_local', 'actor_class', 'requests'],
  },
];

/**
 * Frozen static precompiled parameterized SQL lookup by `(viewName, metricName)`.
 * Eliminates all template string concatenation of SQL metric identifiers (`[M-06]`).
 */
export const PRECOMPILED_PUBLIC_VIEW_SQL: Readonly<
  Record<PublicAggregateViewName, Readonly<Record<string, string>>>
> = Object.freeze({
  v_pub_site_daily: Object.freeze({
    page_views:
      'SELECT day_local, sum(page_views) AS metric_value FROM v_pub_site_daily WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND day_local >= {start:Date} AND day_local <= {end:Date} GROUP BY day_local',
    conversions:
      'SELECT day_local, sum(conversions) AS metric_value FROM v_pub_site_daily WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND day_local >= {start:Date} AND day_local <= {end:Date} GROUP BY day_local',
    cvr:
      'SELECT day_local, avg(cvr) AS metric_value FROM v_pub_site_daily WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND day_local >= {start:Date} AND day_local <= {end:Date} GROUP BY day_local',
    avg_focal_dwell_ms:
      'SELECT day_local, avg(avg_focal_dwell_ms) AS metric_value FROM v_pub_site_daily WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND day_local >= {start:Date} AND day_local <= {end:Date} GROUP BY day_local',
  }),
  v_pub_page_daily: Object.freeze({
    page_views:
      'SELECT page_id, sum(page_views) AS metric_value FROM v_pub_page_daily WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND day_local >= {start:Date} AND day_local <= {end:Date} GROUP BY page_id',
    conversions:
      'SELECT page_id, sum(conversions) AS metric_value FROM v_pub_page_daily WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND day_local >= {start:Date} AND day_local <= {end:Date} GROUP BY page_id',
    avg_focal_dwell_ms:
      'SELECT page_id, avg(avg_focal_dwell_ms) AS metric_value FROM v_pub_page_daily WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND day_local >= {start:Date} AND day_local <= {end:Date} GROUP BY page_id',
  }),
  v_pub_section_daily: Object.freeze({
    reach_rate:
      'SELECT sec_fp, avg(reach_rate) AS metric_value FROM v_pub_section_daily WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND day_local >= {start:Date} AND day_local <= {end:Date} GROUP BY sec_fp',
    avg_focal_dwell_ms:
      'SELECT sec_fp, avg(avg_focal_dwell_ms) AS metric_value FROM v_pub_section_daily WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND day_local >= {start:Date} AND day_local <= {end:Date} GROUP BY sec_fp',
  }),
  v_pub_segment_agg: Object.freeze({
    page_views:
      'SELECT segment_id, sum(page_views) AS metric_value FROM v_pub_segment_agg WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND day_local >= {start:Date} AND day_local <= {end:Date} GROUP BY segment_id',
    conversions:
      'SELECT segment_id, sum(conversions) AS metric_value FROM v_pub_segment_agg WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND day_local >= {start:Date} AND day_local <= {end:Date} GROUP BY segment_id',
    cvr:
      'SELECT segment_id, avg(cvr) AS metric_value FROM v_pub_segment_agg WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND day_local >= {start:Date} AND day_local <= {end:Date} GROUP BY segment_id',
  }),
  v_pub_funnel_agg: Object.freeze({
    sessions:
      'SELECT funnel_step, sum(sessions) AS metric_value FROM v_pub_funnel_agg WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND day_local >= {start:Date} AND day_local <= {end:Date} GROUP BY funnel_step',
    step_conversion_rate:
      'SELECT funnel_step, avg(step_conversion_rate) AS metric_value FROM v_pub_funnel_agg WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND day_local >= {start:Date} AND day_local <= {end:Date} GROUP BY funnel_step',
  }),
  v_pub_experiment_summary: Object.freeze({
    lift_estimate:
      'SELECT experiment_id, avg(lift_estimate) AS metric_value FROM v_pub_experiment_summary WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND day_local >= {start:Date} AND day_local <= {end:Date} GROUP BY experiment_id',
  }),
  v_pub_ai_actor_daily: Object.freeze({
    requests:
      'SELECT actor_class, sum(requests) AS metric_value FROM v_pub_ai_actor_daily WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND day_local >= {start:Date} AND day_local <= {end:Date} GROUP BY actor_class',
  }),
});

export function lookupPrecompiledPublicViewSql(
  viewName: PublicAggregateViewName,
  metricName: string
): string | null {
  if (!Object.prototype.hasOwnProperty.call(PRECOMPILED_PUBLIC_VIEW_SQL, viewName)) {
    return null;
  }
  const byMetric = PRECOMPILED_PUBLIC_VIEW_SQL[viewName];
  if (!Object.prototype.hasOwnProperty.call(byMetric, metricName)) {
    return null;
  }
  return byMetric[metricName];
}

// =========================================================================
// 2. Deterministic Read-Only Baseline Planner (Pluggable for 4-G Self-Hosted LLM)
// =========================================================================

const PROMPT_INJECTION_RE =
  /(ignore previous|system prompt|drop table|delete from|publish|apply_patch|apply patch|override tenant|tenant_id\s*=|grant all|set role|settings\s+additional_table_filters|execute write|変更を反映|公開して|権限を無視|他テナント|別のテナント)/i;

const PII_OR_FREE_TEXT_RE =
  /(visitor_id|user_id|email|メールアドレス|個人情報|氏名|住所|電話番号|raw click text|入力した文字|フォーム入力値|生の文字列|ipアドレス|ip_hash|cookie_id|ga_client_id|session_id|1人ごと|個人別|特定のユーザー)/i;

const UNKNOWABLE_QUESTION_RE =
  /(視線|本当に読んだ|理解度|読了率を確定|訪問ごとの検索クエリ|ユーザー別の自然検索語|クロスデバイスで同一人物|aiである確率|野生aiの目的|前後比較から原因を断定|別オリジンiframeの中身|gaze|comprehension|per-visit organic query|exact ai probability|wild agent goal)/i;

export class DeterministicReadOnlyPlanner implements AskPlannerProvider {
  public readonly providerId = 'ugokilink_deterministic_baseline';
  public readonly modelName = 'rule-template-ro-v1';
  public readonly hosting = 'deterministic_baseline' as const;

  public plan(ctx: AskPlannerContext): AskPlan {
    const q = (ctx.untrustedQuestion.value ?? '').trim();
    const qLower = q.toLowerCase();

    // 1. Refuse prompt injection & write/escalation attempts immediately
    if (PROMPT_INJECTION_RE.test(q)) {
      return {
        kind: 'refuse',
        refusalStatus: 'not_entitled',
        refusalReason:
          'POST /v1/ask is strictly read-only and tenant-isolated; write, publish, SQL override, and cross-tenant instructions are refused',
        refusalGateId: 'surf.ask_accuracy',
      };
    }

    // 2. Refuse direct PII / identifier / free-text extraction probes
    if (PII_OR_FREE_TEXT_RE.test(q)) {
      return {
        kind: 'refuse',
        refusalStatus: 'not_entitled',
        refusalReason:
          'Individual identifiers, personal attributes, and free-text strings cannot be queried or passed to /v1/ask',
        refusalGateId: 'surf.ask_accuracy',
      };
    }

    // 3. Refuse unknowable topics (`UNKNOWABLES_LEDGER`) honestly as `not_collected`
    if (UNKNOWABLE_QUESTION_RE.test(q)) {
      return {
        kind: 'refuse',
        refusalStatus: 'not_collected',
        refusalReason:
          'Requested quantity is unobservable by design (see UNKNOWABLES_LEDGER tel.U1/tel.U4/act.U3/ev.U1); no fabricated estimate is returned',
        refusalGateId: 'tel.M9',
      };
    }

    // 4. Site consent mode `off` -> behaviour data not collected
    if (ctx.siteConsentMode === 'off') {
      return {
        kind: 'refuse',
        refusalStatus: 'not_collected',
        refusalReason: 'Site consent mode is "off"; human behaviour aggregates are not collected',
        refusalGateId: 'tel.G10',
      };
    }

    // 5. Explicit uncollected/missing feature mentions
    if (/(未収集|not_collected|uncollected|音声|オフライン店舗|テレビcm|revenue_missing|未接続)/i.test(q)) {
      return {
        kind: 'refuse',
        refusalStatus: 'not_collected',
        refusalReason: 'Requested metric source is not collected for this site',
        refusalGateId: 'store.G-7',
      };
    }

    // Extract optional filter tag for differencing tests (e.g. `[cohort:xxx]`)
    const cohortTagMatch = /\[cohort:([^\]]+)\]/i.exec(q);
    const filterSignature = cohortTagMatch ? `cohort:${cohortTagMatch[1]}` : `q:${sha256Hex(qLower).slice(0, 12)}`;

    // 6. Segment / device / period comparison
    if (/(比較|compare|セグメント|segment|対比|vs\b|デバイス別)/i.test(q)) {
      const metric = /(cvr|成約率|コンバージョン率)/i.test(q) ? 'cvr' : 'page_views';
      const sql = lookupPrecompiledPublicViewSql('v_pub_segment_agg', metric);
      if (!sql) {
        return { kind: 'refuse', refusalStatus: 'not_collected', refusalReason: 'Unsupported metric' };
      }
      return {
        kind: 'execute_query',
        toolName: 'query_public_segment_agg',
        viewName: 'v_pub_segment_agg',
        metricName: metric,
        sql,
        requestedColumns: ['segment_id', metric],
        groupByColumns: ['segment_id'],
        filterSignature,
        hypothesisTemplate:
          'Observed differences between segments may reflect traffic mix or seasonality rather than causal effects; a randomised experiment is required to establish causality.',
      };
    }

    // 7. Time-series trend
    if (/(推移|トレンド|日別|週別|時系列|trend|daily|weekly|time series)/i.test(q)) {
      const metric = /(cv|成果|コンバージョン|conversion)/i.test(q) ? 'conversions' : 'page_views';
      const sql = lookupPrecompiledPublicViewSql('v_pub_site_daily', metric);
      if (!sql) {
        return { kind: 'refuse', refusalStatus: 'not_collected', refusalReason: 'Unsupported metric' };
      }
      return {
        kind: 'execute_query',
        toolName: 'query_public_site_daily',
        viewName: 'v_pub_site_daily',
        metricName: metric,
        sql,
        requestedColumns: ['day_local', metric],
        groupByColumns: ['day_local'],
        filterSignature,
        hypothesisTemplate:
          'Observed day-over-day movement may be driven by weekday cycles or acquisition shifts.',
      };
    }

    // 8. Section reach / focal dwell
    if (/(区画|セクション|到達|滞在|dwell|reach|section)/i.test(q)) {
      const metric = /(滞在|dwell)/i.test(q) ? 'avg_focal_dwell_ms' : 'reach_rate';
      const sql = lookupPrecompiledPublicViewSql('v_pub_section_daily', metric);
      if (!sql) {
        return { kind: 'refuse', refusalStatus: 'not_collected', refusalReason: 'Unsupported metric' };
      }
      return {
        kind: 'execute_query',
        toolName: 'query_public_section_daily',
        viewName: 'v_pub_section_daily',
        metricName: metric,
        sql,
        requestedColumns: ['sec_fp', metric],
        groupByColumns: ['sec_fp'],
        filterSignature,
        hypothesisTemplate:
          'Higher focal dwell time in the central 40% band is an observed proxy and does not confirm reader comprehension (tel.U1).',
      };
    }

    // 9. Standard site aggregation (PV, conversions, CVR)
    if (/(pv|ページビュー|閲覧|コンバージョン|成果|cv|cvr|合計|集計|total|count|average|平均)/i.test(q)) {
      const metric = /(cvr|成約率|コンバージョン率)/i.test(q)
        ? 'cvr'
        : /(cv|成果|コンバージョン|conversion)/i.test(q)
          ? 'conversions'
          : 'page_views';
      const sql = lookupPrecompiledPublicViewSql('v_pub_site_daily', metric);
      if (!sql) {
        return { kind: 'refuse', refusalStatus: 'not_collected', refusalReason: 'Unsupported metric' };
      }
      return {
        kind: 'execute_query',
        toolName: 'query_public_site_daily',
        viewName: 'v_pub_site_daily',
        metricName: metric,
        sql,
        requestedColumns: ['day_local', metric],
        groupByColumns: ['day_local'],
        filterSignature,
        hypothesisTemplate:
          'Observed site totals reflect saved human page views inside the selected window.',
      };
    }

    // Default fail-closed refusal for unrecognized/unsupported questions
    return {
      kind: 'refuse',
      refusalStatus: 'not_collected',
      refusalReason: 'Question does not map to a verified public aggregate view or collected metric',
      refusalGateId: 'surf.ask_accuracy',
    };
  }
}

// =========================================================================
// 3. AskService (Conversation Isolation + Pre-Execution & Pre-LLM Filter + Grounded Response)
// =========================================================================

function toFixedExternalAskRejectionReason(
  blockedCode?: string
): string {
  switch (blockedCode) {
    case 'DIFFERENCING_ATTACK_BLOCKED':
      return 'disclosure_blocked_differencing';
    case 'SMALL_CELL_SUPPRESSED':
    case 'PER_PERSON_AGGREGATION_BLOCKED':
      return 'disclosure_suppressed_k_anonymity';
    case 'CONSENT_OFF_BLOCKED':
    case 'CONSENT_PURPOSE_MISMATCH':
      return 'disclosure_blocked_consent';
    case 'IDENTIFIER_COLUMN_BLOCKED':
    case 'FREE_TEXT_COLUMN_BLOCKED':
      return 'disclosure_blocked_restricted_column';
    case 'NON_WHITELISTED_VIEW':
    case 'NON_ALLOWED_METRIC':
    case 'NON_READ_ONLY_TOOL':
    case 'SQL_AST_VIOLATION':
    default:
      return 'disclosure_blocked_policy';
  }
}

export class AskService {
  private readonly planner: AskPlannerProvider;
  private readonly executor: AskDataExecutor;
  private readonly differencingGuard: DifferencingGuard;
  /** Conversation / response cache keyed strictly by `(tenantId, siteId, permissionEpoch)`. */
  private readonly sessionCache = new Map<string, Map<string, AskExecutionOutcome>>();

  constructor(options: {
    readonly planner?: AskPlannerProvider;
    readonly executor: AskDataExecutor;
    readonly differencingGuard?: DifferencingGuard;
  }) {
    const planner = options.planner ?? new DeterministicReadOnlyPlanner();
    // Enforce self-hosted / baseline only at construction time!
    assertSelfHostedProviderOnly(planner);
    this.planner = planner;
    this.executor = options.executor;
    this.differencingGuard = options.differencingGuard ?? new DifferencingGuard(ASK_MIN_CELL_K);
  }

  public static buildSessionKey(tenantId: string, siteId: string, permissionEpoch: number): string {
    return `${tenantId}:${siteId}:ep${permissionEpoch}`;
  }

  public getCachedTurnCount(tenantId: string, siteId: string, permissionEpoch: number): number {
    return this.sessionCache.get(AskService.buildSessionKey(tenantId, siteId, permissionEpoch))?.size ?? 0;
  }

  public ask(req: AskRequest): AskExecutionOutcome {
    // Runtime re-assertion against external cloud / Jev models
    assertSelfHostedProviderOnly(this.planner);

    const now = req.now ?? new Date();
    const nowIso = now.toISOString();
    const windowEnd = req.windowEnd ?? nowIso;
    const windowStart =
      req.windowStart ?? new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString();
    const residency = {
      storage_region: req.storageRegion ?? 'ap-northeast-1',
      processing_region: req.processingRegion ?? 'ap-northeast-1',
    };

    // 1. Authorization & tenant isolation (NEVER trust callerSuppliedTenantId!)
    if (
      req.siteTenantId !== req.principal.tenantId ||
      (req.callerSuppliedTenantId !== undefined && req.callerSuppliedTenantId !== req.principal.tenantId)
    ) {
      return {
        httpStatus: 404,
        allowed: false,
        executedSql: null,
        citations: [],
        answerText: null,
        hypotheses: [],
        passedForbiddenDataToModel: false,
        returnedUnauthorizedData: false,
        auditCode: 'FOREIGN_TENANT_404',
      };
    }

    if (!req.principal.effectiveScopes.has('analytics:read')) {
      return {
        httpStatus: 403,
        allowed: false,
        executedSql: null,
        citations: [],
        answerText: null,
        hypotheses: [],
        passedForbiddenDataToModel: false,
        returnedUnauthorizedData: false,
        auditCode: 'MISSING_ANALYTICS_READ_SCOPE',
      };
    }

    if (req.principal.allowedSiteIds !== null && !req.principal.allowedSiteIds.includes(req.siteId)) {
      return {
        httpStatus: 403,
        allowed: false,
        executedSql: null,
        citations: [],
        answerText: null,
        hypotheses: [],
        passedForbiddenDataToModel: false,
        returnedUnauthorizedData: false,
        auditCode: 'SITE_OUT_OF_CREDENTIAL_SCOPE',
      };
    }

    const sessionKey = AskService.buildSessionKey(
      req.principal.tenantId,
      req.siteId,
      req.permissionEpoch
    );
    const scopePolicyKey = Array.from(req.principal.effectiveScopes).sort().join(',');
    const cacheKey = sha256Hex(
      `${req.question}|${windowStart}|${windowEnd}|consent:${req.siteConsentMode}|role:${req.principal.role}|scopes:${scopePolicyKey}`
    );

    const refBase = (seed: string): EvidenceRef => ({
      ref_id: `ask_${sha256Hex(`${sessionKey}:${seed}`).slice(0, 16)}`,
      kind: 'query',
      params_hash: sha256Hex(`${req.siteId}:${windowStart}:${windowEnd}`),
      watermarks: { as_of: nowIso },
      result_digest: sha256Hex(seed),
      issued_at: nowIso,
      valid_until: new Date(now.getTime() + 24 * 3600_000).toISOString(),
      kid: 'ask_v1',
    });

    // 2. Wrap question & schema metadata in `UntrustedValue` before handing to planner
    const untrustedQuestion = wrapUntrusted(req.question, 'external_query');

    // Enforce current site consent & disclosure eligibility STRICTLY BEFORE cache lookup!
    if (req.siteConsentMode === 'off') {
      const status = 'not_collected' as const;
      const reason = 'Site consent mode is "off"; human behaviour aggregates are not collected';
      const ref = refBase(`consent_off:${cacheKey}`);
      const envelope = buildResponseEnvelope({
        window: { start: windowStart, end: windowEnd },
        freshness: { data_through: nowIso, lag_s: 0, sources: {}, stale: false },
        coverage: { ratio: 0, denominator_n: 0 },
        lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
        residency,
        measures: {
          ask_metric: {
            value: null,
            unit: 'none',
            status,
            reason,
            evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${req.siteId}` },
            sample: null,
            interval: null,
            unmet_gates: [{ id: 'tel.G10', required: 1, observed: 0, unlock: reason }],
          },
        },
        data: {
          question: untrustedQuestion,
          executedSql: null,
          citations: [],
          hypotheses: [],
          refusalStatus: status,
          refusalReason: reason,
        },
      });
      const outcome: AskExecutionOutcome = {
        httpStatus: 200,
        allowed: true,
        envelope,
        executedSql: null,
        citations: [],
        answerText: null,
        hypotheses: [],
        passedForbiddenDataToModel: false,
        returnedUnauthorizedData: false,
        auditCode: `REFUSED:${status}`,
      };
      return outcome;
    }

    const existingCache = this.sessionCache.get(sessionKey)?.get(cacheKey);
    if (existingCache) {
      return existingCache;
    }

    const untrustedSchemaCatalog = PUBLIC_VIEW_SCHEMAS.map((v) => ({
      viewName: v.viewName,
      description: wrapUntrusted(v.description, 'customer_event_string'),
      columns: v.columns.map((c) => wrapUntrusted(c, 'customer_event_string')),
    }));

    const plan = this.planner.plan({
      untrustedQuestion,
      untrustedSchemaCatalog,
      allowedTools: READ_ONLY_ASK_TOOLS,
      siteConsentMode: req.siteConsentMode,
      windowStart,
      windowEnd,
    });

    // 3. Refusal path -> honest non-ok envelope with null value & unmet gate
    if (plan.kind === 'refuse' || !plan.viewName || !plan.sql || !plan.metricName) {
      const status = plan.refusalStatus ?? 'not_collected';
      const reason = plan.refusalReason ?? 'Unable to answer question with verified aggregate data';
      const gateId = plan.refusalGateId ?? 'surf.ask_accuracy';
      const ref = refBase(`refuse:${cacheKey}`);

      const envelope = buildResponseEnvelope({
        window: { start: windowStart, end: windowEnd },
        freshness: { data_through: nowIso, lag_s: 0, sources: {}, stale: false },
        coverage: { ratio: 0, denominator_n: 0 },
        lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
        residency,
        measures: {
          ask_metric: {
            value: null,
            unit: 'none',
            status,
            reason,
            evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${req.siteId}` },
            sample: null,
            interval: null,
            unmet_gates: [{ id: gateId, required: 1, observed: 0, unlock: reason }],
          },
        },
        data: {
          question: untrustedQuestion,
          executedSql: null,
          citations: [],
          hypotheses: [],
          refusalStatus: status,
          refusalReason: reason,
        },
      });

      const outcome: AskExecutionOutcome = {
        httpStatus: 200,
        allowed: true,
        envelope,
        executedSql: null,
        citations: [],
        answerText: null,
        hypotheses: [],
        passedForbiddenDataToModel: false,
        returnedUnauthorizedData: false,
        auditCode: `REFUSED:${status}`,
      };
      this.storeCache(sessionKey, cacheKey, outcome);
      return outcome;
    }

    const effectiveFilterSig = plan.filterSignature ?? cacheKey;

    // 4. Independent Pre-Execution Gate ([H-03] & [M-06]):
    //    Validates consent, purpose, read-only tool allowlist, public view & SQL FROM table match,
    //    allowlisted metric identifiers, PII/free-text columns, and time-window / cohort differencing
    //    STRICTLY BEFORE calling `executor.executePublicViewQuery`!
    const preExecVerdict = validateAskQueryBeforeExecution({
      siteConsentMode: req.siteConsentMode,
      toolName: plan.toolName,
      viewName: plan.viewName,
      metricName: plan.metricName,
      sql: plan.sql,
      requestedColumns: plan.requestedColumns ?? [],
      groupByColumns: plan.groupByColumns ?? [],
      sessionKey,
      filterSignature: effectiveFilterSig,
      windowStart,
      windowEnd,
      predeclaredCohortMemberIds: plan.cohortMemberIds,
      differencingGuard: this.differencingGuard,
    });

    if (!preExecVerdict.allowed) {
      const status =
        preExecVerdict.blockedCode === 'CONSENT_OFF_BLOCKED' ||
        preExecVerdict.blockedCode === 'CONSENT_PURPOSE_MISMATCH'
          ? 'not_collected'
          : preExecVerdict.blockedCode === 'SMALL_CELL_SUPPRESSED' ||
              preExecVerdict.blockedCode === 'DIFFERENCING_ATTACK_BLOCKED' ||
              preExecVerdict.blockedCode === 'PER_PERSON_AGGREGATION_BLOCKED'
            ? 'suppressed'
            : 'not_entitled';
      const externalReason = toFixedExternalAskRejectionReason(preExecVerdict.blockedCode);
      const ref = refBase(`preexec_blocked:${cacheKey}`);
      const safeMeasureKey = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(plan.metricName)
        ? plan.metricName
        : 'ask_metric';
      const envelope = buildResponseEnvelope({
        window: { start: windowStart, end: windowEnd },
        freshness: { data_through: nowIso, lag_s: 0, sources: {}, stale: false },
        coverage: { ratio: 0, denominator_n: 0 },
        lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
        residency,
        measures: {
          [safeMeasureKey]: {
            value: null,
            unit: 'count',
            status,
            reason: externalReason,
            evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${req.siteId}` },
            sample: null,
            interval: null,
            unmet_gates: [
              {
                id: 'surf.ask_accuracy',
                required: ASK_MIN_CELL_K,
                observed: 0,
                unlock: externalReason,
              },
            ],
          },
        },
        data: {
          question: untrustedQuestion,
          executedSql: null,
          citations: [],
          hypotheses: [],
          refusalStatus: status,
          refusalReason: externalReason,
          blockedCode: preExecVerdict.blockedCode,
        },
      });
      return {
        httpStatus: 200,
        allowed: true,
        envelope,
        executedSql: null,
        citations: [],
        answerText: null,
        hypotheses: [],
        passedForbiddenDataToModel: false,
        returnedUnauthorizedData: false,
        auditCode: `PRE_LLM_BLOCKED:${preExecVerdict.blockedCode}`,
      };
    }

    // 5. Execute read-only query under server-bound tenant/site (ONLY after pre-execution gate passed!)
    const rawResult = this.executor.executePublicViewQuery({
      tenantId: req.principal.tenantId,
      siteId: req.siteId,
      viewName: plan.viewName,
      metricName: plan.metricName,
      sql: plan.sql,
      windowStart,
      windowEnd,
      filterSignature: plan.filterSignature,
    });

    if (!rawResult.connected || rawResult.rows.length === 0) {
      const status = !rawResult.connected ? 'not_collected' : 'insufficient_data';
      const reason = !rawResult.connected
        ? 'Public aggregate store not connected for this site'
        : 'Zero aggregate rows matched requested window';
      const ref = refBase(`empty:${cacheKey}`);
      const envelope = buildResponseEnvelope({
        window: { start: windowStart, end: windowEnd },
        freshness: { data_through: nowIso, lag_s: 0, sources: {}, stale: false },
        coverage: { ratio: 0, denominator_n: 0 },
        lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
        residency,
        measures: {
          [plan.metricName]: {
            value: null,
            unit: 'count',
            status,
            reason,
            evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${req.siteId}` },
            sample: null,
            interval: null,
            unmet_gates: [{ id: 'store.G-7', required: 1, observed: 0, unlock: reason }],
          },
        },
        data: {
          question: untrustedQuestion,
          executedSql: plan.sql,
          citations: [],
          hypotheses: [],
          refusalStatus: status,
          refusalReason: reason,
        },
      });
      const outcome: AskExecutionOutcome = {
        httpStatus: 200,
        allowed: true,
        envelope,
        executedSql: plan.sql,
        citations: [],
        answerText: null,
        hypotheses: [],
        passedForbiddenDataToModel: false,
        returnedUnauthorizedData: false,
        auditCode: `REFUSED:${status}`,
      };
      this.storeCache(sessionKey, cacheKey, outcome);
      return outcome;
    }

    // 6. Independent Post-Execution / Pre-LLM Row Filter:
    //    Enforces row-level PII/free-text check, mandatory row membership evidence under RREF,
    //    primary `< k` suppression, complementary secondary suppression on GROUP BY results,
    //    and atomic post-approval commit of window + pre-declared cohort + disclosed row + total equations!
    const filterVerdict = filterQueryAndRowsBeforeLlm({
      viewName: plan.viewName,
      metricName: plan.metricName,
      sql: plan.sql,
      requestedColumns: plan.requestedColumns ?? [],
      groupByColumns: plan.groupByColumns ?? [],
      rows: rawResult.rows,
      sessionKey,
      filterSignature: effectiveFilterSig,
      windowStart,
      windowEnd,
      skipWindowCheck: false,
      predeclaredCohortMemberIds: plan.cohortMemberIds,
      deferCommit: true,
      differencingGuard: this.differencingGuard,
    });

    if (!filterVerdict.allowed) {
      const status =
        filterVerdict.blockedCode === 'SMALL_CELL_SUPPRESSED' ||
        filterVerdict.blockedCode === 'DIFFERENCING_ATTACK_BLOCKED' ||
        filterVerdict.blockedCode === 'PER_PERSON_AGGREGATION_BLOCKED'
          ? 'suppressed'
          : 'not_entitled';
      const externalReason = toFixedExternalAskRejectionReason(filterVerdict.blockedCode);
      const ref = refBase(`blocked:${cacheKey}`);
      const envelope = buildResponseEnvelope({
        window: { start: windowStart, end: windowEnd },
        freshness: { data_through: nowIso, lag_s: 0, sources: {}, stale: false },
        coverage: { ratio: 0, denominator_n: 0 },
        lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
        residency,
        measures: {
          [plan.metricName]: {
            value: null,
            unit: 'count',
            status,
            reason: externalReason,
            evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${req.siteId}` },
            sample: null,
            interval: null,
            unmet_gates: [
              {
                id: 'surf.ask_accuracy',
                required: ASK_MIN_CELL_K,
                observed: 0,
                unlock: externalReason,
              },
            ],
          },
        },
        data: {
          question: untrustedQuestion,
          executedSql: null,
          citations: [],
          hypotheses: [],
          refusalStatus: status,
          refusalReason: externalReason,
          blockedCode: filterVerdict.blockedCode,
        },
      });
      return {
        httpStatus: 200,
        allowed: true,
        envelope,
        executedSql: null,
        citations: [],
        answerText: null,
        hypotheses: [],
        passedForbiddenDataToModel: false,
        returnedUnauthorizedData: false,
        auditCode: `PRE_LLM_BLOCKED:${filterVerdict.blockedCode}`,
      };
    }

    // 7. Construct VerifiedMetricValue citations & strictly grounded answer text
    const queryRef: EvidenceRef = {
      ref_id: rawResult.queryRefId,
      kind: 'query',
      params_hash: rawResult.paramsHash,
      watermarks: { as_of: nowIso },
      result_digest: rawResult.resultDigest,
      issued_at: nowIso,
      valid_until: new Date(now.getTime() + 24 * 3600_000).toISOString(),
      kid: 'ask_v1',
    };

    const citations: GroundedNumericCitation[] = [];
    const measures: Record<string, MeasureInput<VerifiedNumericLeaf>> = {};
    const answerParts: string[] = [];

    for (let i = 0; i < filterVerdict.safeRows.length; i++) {
      const row = filterVerdict.safeRows[i];
      const citId = `c${i + 1}`;
      const measureKey = `${row.metricKey}_${i}`;
      const verified = createDataLayerMetric(row.metricValue, `${rawResult.queryRefId}:${citId}`, {
        authority: 'sealed_rollup',
        createdAt: nowIso,
      });

      citations.push({
        citationId: citId,
        metricKey: row.metricKey,
        value: row.metricValue,
        unit: row.unit,
        provenanceRef: verified.provenanceRef,
        verifiedMetric: verified,
      });

      measures[measureKey] = {
        value: verified,
        unit: row.unit,
        status: 'ok',
        evidence: {
          level: 'observed',
          exactness: 'exact',
          criteria: [],
          refs: [queryRef],
          scope: `${plan.viewName}:${row.bucketLabel}`,
        },
        sample: { n: row.unitCount, unit_kind: 'page_view' },
        interval: null,
      };

      answerParts.push(`${row.bucketLabel}: ${row.metricValue} ${row.unit} [ref:${citId}]`);
    }

    const answerText = answerParts.join('; ');
    const groundingCheck = verifyAnswerNumericReferences(answerText, citations);
    if (!groundingCheck.valid) {
      throw new Error(
        `Numeric grounding invariant failed: ungrounded numbers ${groundingCheck.ungroundedNumbers.join(', ')}`
      );
    }

    const hypotheses: HypothesisStatement[] = plan.hypothesisTemplate
      ? [
          {
            kind: 'hypothesis',
            label: '仮説 (hypothesis)',
            text: plan.hypothesisTemplate,
          },
        ]
      : [];

    const totalSampleN = filterVerdict.safeRows.reduce((acc, r) => acc + r.unitCount, 0);
    const warnings: string[] = [];
    if (filterVerdict.suppressedCount > 0) {
      warnings.push(
        `${filterVerdict.suppressedCount} cell(s) suppressed (primary < k=${ASK_MIN_CELL_K} plus ${filterVerdict.secondarySuppressedCount ?? 0} complementary secondary) before model synthesis`
      );
    }

    const envelope = buildResponseEnvelope({
      window: { start: windowStart, end: windowEnd },
      freshness: { data_through: nowIso, lag_s: 0, sources: { [plan.viewName]: nowIso }, stale: false },
      coverage: { ratio: 1, denominator_n: totalSampleN },
      lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
      residency,
      warnings,
      measures,
      data: {
        question: untrustedQuestion,
        executedSql: plan.sql,
        publicView: plan.viewName,
        answerText,
        citations: citations.map((c) => ({
          citationId: c.citationId,
          metricKey: c.metricKey,
          value: c.verifiedMetric,
          unit: c.unit,
          provenanceRef: c.provenanceRef,
        })),
        hypotheses,
        plannerProvider: {
          providerId: this.planner.providerId,
          modelName: this.planner.modelName,
          hosting: this.planner.hosting,
        },
      },
    });

    const outcome: AskExecutionOutcome = {
      httpStatus: 200,
      allowed: true,
      envelope,
      executedSql: plan.sql,
      citations,
      answerText,
      hypotheses,
      passedForbiddenDataToModel: false,
      returnedUnauthorizedData: false,
      auditCode: 'OK',
    };
    // Commit differencing history ONLY after final answer numeric grounding & envelope construction succeed!
    filterVerdict.commitDisclosureHistory?.();
    this.storeCache(sessionKey, cacheKey, outcome);
    return outcome;
  }

  private storeCache(sessionKey: string, cacheKey: string, outcome: AskExecutionOutcome): void {
    let inner = this.sessionCache.get(sessionKey);
    if (!inner) {
      inner = new Map<string, AskExecutionOutcome>();
      this.sessionCache.set(sessionKey, inner);
    }
    inner.set(cacheKey, outcome);
  }
}

export { PUBLIC_AGGREGATE_VIEWS };
