import type { VerifiedPrincipal } from '@/lib/link/auth';
import { validateSerializedEnvelope } from '@/packages/contract/response';
import {
  AskService,
  DifferencingGuard,
  EvalGroundTruthExecutor,
  ForbiddenExternalProviderError,
  PREREGISTERED_EVAL_1000_QUOTAS,
  READ_ONLY_ASK_TOOLS,
  assertSelfHostedProviderOnly,
  filterQueryAndRowsBeforeLlm,
  runPreregistered1000Eval,
  verifyAnswerNumericReferences,
  type AskPlannerProvider,
} from './index';

const CALLER_A: VerifiedPrincipal = {
  credentialKind: 'ugk_sec',
  credentialId: 'key_a_ask',
  tenantId: 'tenant_eval_a',
  orgId: 'org_eval',
  allowedSiteIds: null,
  principalKind: 'service',
  principalId: 'svc_a',
  role: 'viewer',
  effectiveScopes: new Set(['analytics:read']),
  senderConstrained: true,
  passkeyVerified: false,
};

describe('lib/link/ask — POST /v1/ask Read-Only Planner, Pre-LLM Privacy Filter, External/Jev Ban & 1,000-Question Eval', () => {
  test('strictly bans external cloud LLMs and Jev providers at construction and runtime', () => {
    const badExternal: AskPlannerProvider = {
      providerId: 'openai_gpt',
      modelName: 'gpt-4o',
      hosting: 'external_cloud',
      plan: () => ({ kind: 'refuse' }),
    };
    const badJev: AskPlannerProvider = {
      providerId: 'jev_runner',
      modelName: 'jev-v2',
      hosting: 'jev',
      plan: () => ({ kind: 'refuse' }),
    };
    const disguisedJev: AskPlannerProvider = {
      providerId: 'local_proxy',
      modelName: 'jev-relay',
      hosting: 'self_hosted_local',
      plan: () => ({ kind: 'refuse' }),
    };

    expect(() => assertSelfHostedProviderOnly(badExternal)).toThrow(ForbiddenExternalProviderError);
    expect(() => assertSelfHostedProviderOnly(badJev)).toThrow(ForbiddenExternalProviderError);
    expect(() => assertSelfHostedProviderOnly(disguisedJev)).toThrow(ForbiddenExternalProviderError);
    expect(() => new AskService({ planner: badJev, executor: new EvalGroundTruthExecutor() })).toThrow(
      ForbiddenExternalProviderError
    );

    // Self-hosted Muse Glimmer 30B / Gemma 4 provider passes guard cleanly
    const selfHostedMuse: AskPlannerProvider = {
      providerId: 'ugoki_gpu_cluster',
      modelName: 'muse-glimmer-30b-q4',
      hosting: 'self_hosted_local',
      plan: () => ({ kind: 'refuse' }),
    };
    expect(() => assertSelfHostedProviderOnly(selfHostedMuse)).not.toThrow();

    // Physical read-only tool allowlist contains zero write/publish/delete tools
    expect(READ_ONLY_ASK_TOOLS.every((t) => t.startsWith('query_public_'))).toBe(true);
  });

  test('pre-LLM filter blocks non-whitelisted views, identifiers, free text, <k cells, per-person agg, SQL AST violations, and differencing attacks', () => {
    const diffGuard = new DifferencingGuard(10);
    const goodSql = `SELECT segment_id, sum(page_views) FROM v_pub_segment_agg WHERE tenant_id = {tenant_id:String} AND day_local >= {start:Date} GROUP BY segment_id`;

    // 1. Non-whitelisted raw table rejected
    expect(
      filterQueryAndRowsBeforeLlm({
        viewName: 'events',
        sql: `SELECT page_id FROM events WHERE tenant_id = {tenant_id:String} AND timestamp >= {start:DateTime}`,
        requestedColumns: ['page_id'],
        groupByColumns: [],
        rows: [],
        sessionKey: 's1',
        filterSignature: 'f1',
        differencingGuard: diffGuard,
      }).blockedCode
    ).toBe('NON_WHITELISTED_VIEW');

    // 2. Identifier column blocked
    expect(
      filterQueryAndRowsBeforeLlm({
        viewName: 'v_pub_site_daily',
        sql: goodSql,
        requestedColumns: ['visitor_id', 'page_views'],
        groupByColumns: [],
        rows: [],
        sessionKey: 's1',
        filterSignature: 'f2',
        differencingGuard: diffGuard,
      }).blockedCode
    ).toBe('IDENTIFIER_COLUMN_BLOCKED');

    // 3. Free-text column blocked
    expect(
      filterQueryAndRowsBeforeLlm({
        viewName: 'v_pub_site_daily',
        sql: goodSql,
        requestedColumns: ['click_text', 'page_views'],
        groupByColumns: [],
        rows: [],
        sessionKey: 's1',
        filterSignature: 'f3',
        differencingGuard: diffGuard,
      }).blockedCode
    ).toBe('FREE_TEXT_COLUMN_BLOCKED');

    // 4. Single-person aggregation blocked
    expect(
      filterQueryAndRowsBeforeLlm({
        viewName: 'v_pub_segment_agg',
        sql: goodSql,
        requestedColumns: ['segment_id', 'page_views'],
        groupByColumns: ['segment_id'],
        rows: [{ bucketLabel: 'only_me', unitCount: 1, metricKey: 'page_views', metricValue: 12, unit: 'page_views' }],
        sessionKey: 's1',
        filterSignature: 'f4',
        differencingGuard: diffGuard,
      }).blockedCode
    ).toBe('PER_PERSON_AGGREGATION_BLOCKED');

    // 5. Differencing attack: Q1 returns cohort of 20 users; Q2 returns 19 of those 20 (diff = 1) -> BLOCKED!
    const all20 = Array.from({ length: 20 }, (_, i) => `u_${i}`);
    const first = filterQueryAndRowsBeforeLlm({
      viewName: 'v_pub_segment_agg',
      sql: goodSql,
      requestedColumns: ['segment_id', 'page_views'],
      groupByColumns: ['segment_id'],
      rows: [{ bucketLabel: 'all', unitCount: 20, metricKey: 'page_views', metricValue: 200, unit: 'page_views', cohortMemberIds: all20 }],
      sessionKey: 'tenant_a:site_1:ep1',
      filterSignature: 'cohort_all',
      differencingGuard: diffGuard,
    });
    expect(first.allowed).toBe(true);

    const secondAttack = filterQueryAndRowsBeforeLlm({
      viewName: 'v_pub_segment_agg',
      sql: goodSql,
      requestedColumns: ['segment_id', 'page_views'],
      groupByColumns: ['segment_id'],
      rows: [{ bucketLabel: 'minus1', unitCount: 19, metricKey: 'page_views', metricValue: 190, unit: 'page_views', cohortMemberIds: all20.slice(0, 19) }],
      sessionKey: 'tenant_a:site_1:ep1',
      filterSignature: 'cohort_minus_1',
      differencingGuard: diffGuard,
    });
    expect(secondAttack.allowed).toBe(false);
    expect(secondAttack.blockedCode).toBe('DIFFERENCING_ATTACK_BLOCKED');
  });

  test('AskService isolates conversations by (tenant_id, site_id, permission_epoch), grounds numbers in VerifiedMetricValue, tags hypotheses, and passes I1–I7 envelope validation', () => {
    const svc = new AskService({ executor: new EvalGroundTruthExecutor() });
    const now = new Date('2026-11-20T12:00:00Z');

    const res = svc.ask({
      principal: CALLER_A,
      siteId: 'site_eval_a',
      siteTenantId: 'tenant_eval_a',
      siteConsentMode: 'full',
      permissionEpoch: 1,
      question: '直近28日の合計PV数を集計してください',
      now,
    });
    expect(res.httpStatus).toBe(200);
    expect(res.allowed).toBe(true);
    expect(res.citations).toHaveLength(1);
    expect(res.citations[0].value).toBe(1200);
    expect(res.hypotheses[0]?.kind).toBe('hypothesis');
    expect(validateSerializedEnvelope(res.envelope).valid).toBe(true);

    // Numeric grounding guard catches ungrounded invented numbers
    expect(verifyAnswerNumericReferences(res.answerText!, res.citations).valid).toBe(true);
    expect(verifyAnswerNumericReferences('PV jumped by 999999 today!', res.citations).valid).toBe(false);

    // Conversation cache isolated by permissionEpoch
    expect(svc.getCachedTurnCount('tenant_eval_a', 'site_eval_a', 1)).toBe(1);
    expect(svc.getCachedTurnCount('tenant_eval_a', 'site_eval_a', 2)).toBe(0);
  });

  test('Pre-registered 1,000-question evaluation harness passes surf.ask_accuracy Wilson 95% bounds with 0 unauthorized/forbidden leaks', () => {
    const quotaSum = Object.values(PREREGISTERED_EVAL_1000_QUOTAS).reduce((a, b) => a + b, 0);
    expect(quotaSum).toBe(1000);

    const report = runPreregistered1000Eval();
    expect(report.gateId).toBe('surf.ask_accuracy');
    expect(report.ledgerRegistered).toBe(true);
    expect(report.totalQuestions).toBe(1000);
    expect(report.numericErrors).toBe(0);
    expect(report.numericErrorRateInterval95.upper95).toBeLessThanOrEqual(0.01);
    expect(report.refusalRateInterval95.lower95).toBeGreaterThanOrEqual(0.95);
    expect(report.unauthorizedDataLeaks).toBe(0);
    expect(report.forbiddenDataPassedToModelCount).toBe(0);
    expect(report.passed).toBe(true);
  });
});
