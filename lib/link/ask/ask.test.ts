import type { VerifiedPrincipal } from '@/lib/link/auth';
import { validateSerializedEnvelope } from '@/packages/contract/response';
import {
  AskService,
  DifferencingGuard,
  EvalGroundTruthExecutor,
  ForbiddenExternalProviderError,
  PRECOMPILED_PUBLIC_VIEW_SQL,
  PREREGISTERED_EVAL_1000_QUOTAS,
  READ_ONLY_ASK_TOOLS,
  assertSelfHostedProviderOnly,
  filterQueryAndRowsBeforeLlm,
  lookupPrecompiledPublicViewSql,
  runPreregistered1000Eval,
  verifyAnswerNumericReferences,
  verifyPublicViewSqlAndMetrics,
  type AskDataExecutor,
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

  test('[H-03 & M-06] blocks rogue SQL FROM tables, raw metric expressions, consent mismatches, and PII columns BEFORE executing DB queries', () => {
    let executorCalls = 0;
    const spyExecutor: AskDataExecutor = {
      executePublicViewQuery: (p) => {
        executorCalls += 1;
        return new EvalGroundTruthExecutor().executePublicViewQuery(p);
      },
    };

    // 1. Rogue planner declaring v_pub_site_daily while SQL queries raw `events` table
    const rogueTablePlanner: AskPlannerProvider = {
      providerId: 'local_llm',
      modelName: 'gemma-4-local',
      hosting: 'self_hosted_local',
      plan: () => ({
        kind: 'execute_query',
        toolName: 'query_public_site_daily',
        viewName: 'v_pub_site_daily',
        metricName: 'page_views',
        sql: 'SELECT day_local, sum(page_views) AS metric_value FROM events WHERE tenant_id = {tenant_id:String} AND day_local >= {start:Date} GROUP BY day_local',
        requestedColumns: ['day_local', 'page_views'],
        groupByColumns: ['day_local'],
      }),
    };
    const svcTable = new AskService({ planner: rogueTablePlanner, executor: spyExecutor });
    const r1 = svcTable.ask({
      principal: CALLER_A,
      siteId: 'site_eval_a',
      siteTenantId: 'tenant_eval_a',
      siteConsentMode: 'full',
      permissionEpoch: 1,
      question: 'PV合計',
    });
    expect(executorCalls).toBe(0);
    expect(r1.auditCode).toBe('PRE_LLM_BLOCKED:NON_WHITELISTED_VIEW');
    expect(r1.executedSql).toBeNull();

    // 2. Rogue planner injecting raw SQL expression in SELECT (`sum(page_views + 999)`) -> [M-06] blocked before DB
    const rogueExprPlanner: AskPlannerProvider = {
      providerId: 'local_llm',
      modelName: 'gemma-4-local',
      hosting: 'self_hosted_local',
      plan: () => ({
        kind: 'execute_query',
        toolName: 'query_public_site_daily',
        viewName: 'v_pub_site_daily',
        metricName: 'page_views',
        sql: 'SELECT day_local, sum(page_views + 999) AS metric_value FROM v_pub_site_daily WHERE tenant_id = {tenant_id:String} AND day_local >= {start:Date} GROUP BY day_local',
        requestedColumns: ['day_local', 'page_views'],
        groupByColumns: ['day_local'],
      }),
    };
    const svcExpr = new AskService({ planner: rogueExprPlanner, executor: spyExecutor });
    const r2 = svcExpr.ask({
      principal: CALLER_A,
      siteId: 'site_eval_a',
      siteTenantId: 'tenant_eval_a',
      siteConsentMode: 'full',
      permissionEpoch: 1,
      question: 'PV合計',
    });
    expect(executorCalls).toBe(0);
    expect(r2.auditCode).toBe('PRE_LLM_BLOCKED:NON_ALLOWED_METRIC');

    // 3. Funnel view queried under `cookieless` consent -> blocked BEFORE DB execution
    const funnelPlanner: AskPlannerProvider = {
      providerId: 'local_llm',
      modelName: 'gemma-4-local',
      hosting: 'self_hosted_local',
      plan: () => ({
        kind: 'execute_query',
        toolName: 'query_public_funnel_agg',
        viewName: 'v_pub_funnel_agg',
        metricName: 'sessions',
        sql: lookupPrecompiledPublicViewSql('v_pub_funnel_agg', 'sessions')!,
        requestedColumns: ['funnel_step', 'sessions'],
        groupByColumns: ['funnel_step'],
      }),
    };
    const svcFunnel = new AskService({ planner: funnelPlanner, executor: spyExecutor });
    const r3 = svcFunnel.ask({
      principal: CALLER_A,
      siteId: 'site_eval_a',
      siteTenantId: 'tenant_eval_a',
      siteConsentMode: 'cookieless',
      permissionEpoch: 1,
      question: 'ファネル集計',
    });
    expect(executorCalls).toBe(0);
    expect(r3.auditCode).toBe('PRE_LLM_BLOCKED:CONSENT_PURPOSE_MISMATCH');

    // 4. Static precompiled SQL catalog passes verification and blocks prototype keys
    for (const [view, metrics] of Object.entries(PRECOMPILED_PUBLIC_VIEW_SQL)) {
      for (const [metric, sql] of Object.entries(metrics)) {
        expect(
          verifyPublicViewSqlAndMetrics({
            viewName: view as keyof typeof PRECOMPILED_PUBLIC_VIEW_SQL,
            metricName: metric,
            sql,
          }).valid
        ).toBe(true);
      }
    }
    expect(lookupPrecompiledPublicViewSql('v_pub_site_daily', '__proto__')).toBeNull();
    expect(lookupPrecompiledPublicViewSql('v_pub_site_daily', 'page_views; DROP TABLE x')).toBeNull();
  });

  test('[H-03] enforces complementary secondary suppression on GROUP BY results so total subtraction cannot leak a 1-person cell', () => {
    const diffGuard = new DifferencingGuard(10);
    const sql = lookupPrecompiledPublicViewSql('v_pub_segment_agg', 'page_views')!;

    // 3 buckets where ONLY 1 bucket has unitCount < 10 (n=1):
    // Both `seg_vip` (n=1) AND next-smallest sibling `seg_mobile` (n=300) MUST be suppressed!
    const threeGroup = filterQueryAndRowsBeforeLlm({
      viewName: 'v_pub_segment_agg',
      metricName: 'page_views',
      sql,
      requestedColumns: ['segment_id', 'page_views'],
      groupByColumns: ['segment_id'],
      rows: [
        { bucketLabel: 'seg_desktop', unitCount: 500, metricKey: 'page_views', metricValue: 500, unit: 'page_views' },
        { bucketLabel: 'seg_mobile', unitCount: 300, metricKey: 'page_views', metricValue: 300, unit: 'page_views' },
        { bucketLabel: 'seg_vip', unitCount: 1, metricKey: 'page_views', metricValue: 5, unit: 'page_views' },
      ],
      sessionKey: 'comp_s1',
      filterSignature: 'comp_f1',
      differencingGuard: diffGuard,
    });
    expect(threeGroup.allowed).toBe(true);
    expect(threeGroup.suppressedCount).toBe(2);
    expect(threeGroup.secondarySuppressedCount).toBe(1);
    expect(threeGroup.safeRows).toHaveLength(1);
    expect(threeGroup.safeRows[0].bucketLabel).toBe('seg_desktop');

    // 2 buckets where 1 bucket has unitCount < 10 (n=1) and 1 sibling has n=500:
    // Secondary suppression suppresses the sole remaining sibling, leaving 0 safe rows -> blocked!
    const twoGroup = filterQueryAndRowsBeforeLlm({
      viewName: 'v_pub_segment_agg',
      metricName: 'page_views',
      sql,
      requestedColumns: ['segment_id', 'page_views'],
      groupByColumns: ['segment_id'],
      rows: [
        { bucketLabel: 'seg_desktop', unitCount: 500, metricKey: 'page_views', metricValue: 500, unit: 'page_views' },
        { bucketLabel: 'seg_vip', unitCount: 1, metricKey: 'page_views', metricValue: 5, unit: 'page_views' },
      ],
      sessionKey: 'comp_s2',
      filterSignature: 'comp_f2',
      differencingGuard: diffGuard,
    });
    expect(twoGroup.allowed).toBe(false);
    expect(twoGroup.blockedCode).toBe('SMALL_CELL_SUPPRESSED');
    expect(twoGroup.suppressedCount).toBe(2);
  });

  test('[H-03] blocks 1-day window shifting AND 4-query linear combination attacks (both time-window and cohort RREF) BEFORE DB execution', () => {
    let dbExecutions = 0;
    const countingExecutor: AskDataExecutor = {
      executePublicViewQuery: (p) => {
        dbExecutions += 1;
        return new EvalGroundTruthExecutor().executePublicViewQuery(p);
      },
    };
    const svc = new AskService({ executor: countingExecutor });

    // A) 1-day window shift with paraphrased question text -> blocked BEFORE DB execution!
    const w1 = svc.ask({
      principal: CALLER_A,
      siteId: 'site_eval_a',
      siteTenantId: 'tenant_eval_a',
      siteConsentMode: 'full',
      permissionEpoch: 10,
      question: '合計PV数を集計してください',
      windowStart: '2026-11-01T00:00:00Z',
      windowEnd: '2026-11-28T00:00:00Z',
    });
    expect(w1.auditCode).toBe('OK');
    expect(dbExecutions).toBe(1);

    const w2Shift = svc.ask({
      principal: CALLER_A,
      siteId: 'site_eval_a',
      siteTenantId: 'tenant_eval_a',
      siteConsentMode: 'full',
      permissionEpoch: 10,
      question: 'ページビューの合計を教えてください', // paraphrased!
      windowStart: '2026-11-02T00:00:00Z',
      windowEnd: '2026-11-29T00:00:00Z',
    });
    expect(w2Shift.auditCode).toBe('PRE_LLM_BLOCKED:DIFFERENCING_ATTACK_BLOCKED');
    expect(dbExecutions).toBe(1); // NEVER touched ClickHouse!

    // B) 4-query time-window linear combination:
    //    W1=[Nov 1, Nov 21) (20d), W2=[Nov 1, Nov 11) (10d), W3=[Nov 12, Dec 1) (19d), W4=[Nov 21, Dec 1) (10d)
    //    Every 2-query and 3-query combination has >= 9 days support, yet (W1 - W2) - (W3 - W4) = [Nov 11, Nov 12) (1 day)!
    const q1 = svc.ask({
      principal: CALLER_A,
      siteId: 'site_eval_a',
      siteTenantId: 'tenant_eval_a',
      siteConsentMode: 'full',
      permissionEpoch: 20,
      question: '合計PV数を集計 (L1)',
      windowStart: '2026-11-01T00:00:00Z',
      windowEnd: '2026-11-21T00:00:00Z',
    });
    const q2 = svc.ask({
      principal: CALLER_A,
      siteId: 'site_eval_a',
      siteTenantId: 'tenant_eval_a',
      siteConsentMode: 'full',
      permissionEpoch: 20,
      question: '合計PV数を集計 (L2)',
      windowStart: '2026-11-01T00:00:00Z',
      windowEnd: '2026-11-11T00:00:00Z',
    });
    const q3 = svc.ask({
      principal: CALLER_A,
      siteId: 'site_eval_a',
      siteTenantId: 'tenant_eval_a',
      siteConsentMode: 'full',
      permissionEpoch: 20,
      question: '合計PV数を集計 (L3)',
      windowStart: '2026-11-12T00:00:00Z',
      windowEnd: '2026-12-01T00:00:00Z',
    });
    expect(q1.auditCode).toBe('OK');
    expect(q2.auditCode).toBe('OK');
    expect(q3.auditCode).toBe('OK');
    expect(dbExecutions).toBe(4);

    const q4 = svc.ask({
      principal: CALLER_A,
      siteId: 'site_eval_a',
      siteTenantId: 'tenant_eval_a',
      siteConsentMode: 'full',
      permissionEpoch: 20,
      question: '合計PV数を集計 (L4)',
      windowStart: '2026-11-21T00:00:00Z',
      windowEnd: '2026-12-01T00:00:00Z',
    });
    expect(q4.auditCode).toBe('PRE_LLM_BLOCKED:DIFFERENCING_ATTACK_BLOCKED');
    expect(dbExecutions).toBe(4); // Q4 blocked BEFORE DB execution!

    // C) 4-query cohort RREF linear combination:
    //    Q1 = A u B u {target} (21), Q2 = A (10), Q3 = B u C (20), Q4 = C (10)
    //    Every pairwise diff >= 10, yet (Q1 - Q2) - (Q3 - Q4) = {target} (1 individual)!
    const guard = new DifferencingGuard(10);
    const setA = Array.from({ length: 10 }, (_, i) => `a_${i}`);
    const setB = Array.from({ length: 10 }, (_, i) => `b_${i}`);
    const setC = Array.from({ length: 10 }, (_, i) => `c_${i}`);
    expect(guard.checkAndRecord('sess_rref', 'c1', [...setA, ...setB, 'target_vip']).allowed).toBe(true);
    expect(guard.checkAndRecord('sess_rref', 'c2', setA).allowed).toBe(true);
    expect(guard.checkAndRecord('sess_rref', 'c3', [...setB, ...setC]).allowed).toBe(true);
    const c4 = guard.checkAndRecord('sess_rref', 'c4', setC);
    expect(c4.allowed).toBe(false);
    expect(c4.isolatedCount).toBe(1);
  });

  test('[#17] feeds every individually disclosed group row + total into RREF atomically and blocks 1-user group swap/shift sharing the exact same 20-user union', () => {
    const diffGuard = new DifferencingGuard(10);
    const sql = lookupPrecompiledPublicViewSql('v_pub_segment_agg', 'page_views')!;

    // Exact same 20-user union U = {u_0..u_19} across Query 1 and Query 2!
    const users = Array.from({ length: 20 }, (_, i) => `u_${i}`);
    const g1A = users.slice(0, 10); // u_0..u_9 (10)
    const g1B = users.slice(10, 20); // u_10..u_19 (10)

    // Query 1: [10, 10] breakdown -> allowed, commits G1A, G1B, and Total(20) atomically
    const q1 = filterQueryAndRowsBeforeLlm({
      viewName: 'v_pub_segment_agg',
      metricName: 'page_views',
      sql,
      requestedColumns: ['segment_id', 'page_views'],
      groupByColumns: ['segment_id'],
      rows: [
        { bucketLabel: 'grp_a', unitCount: 10, metricKey: 'page_views', metricValue: 100, unit: 'page_views', cohortMemberIds: g1A },
        { bucketLabel: 'grp_b', unitCount: 10, metricKey: 'page_views', metricValue: 120, unit: 'page_views', cohortMemberIds: g1B },
      ],
      sessionKey: 'tenant_a:site_1:ep_17',
      filterSignature: 'cohort:grouped_v1',
      differencingGuard: diffGuard,
    });
    expect(q1.allowed).toBe(true);
    expect(q1.safeRows).toHaveLength(2);

    // Query 2: EXACT SAME union of 20 users, but 1 user swapped across groups ([10, 10]: u_9 <-> u_10)!
    // Previously, feeding only the union (20 users) saw identical union and ALLOWED the leak!
    const g2A = [...users.slice(0, 9), users[10]]; // u_0..u_8, u_10 (10)
    const g2B = [users[9], ...users.slice(11, 20)]; // u_9, u_11..u_19 (10)
    const q2Swap = filterQueryAndRowsBeforeLlm({
      viewName: 'v_pub_segment_agg',
      metricName: 'page_views',
      sql,
      requestedColumns: ['segment_id', 'page_views'],
      groupByColumns: ['segment_id'],
      rows: [
        { bucketLabel: 'grp_a2', unitCount: 10, metricKey: 'page_views', metricValue: 101, unit: 'page_views', cohortMemberIds: g2A },
        { bucketLabel: 'grp_b2', unitCount: 10, metricKey: 'page_views', metricValue: 119, unit: 'page_views', cohortMemberIds: g2B },
      ],
      sessionKey: 'tenant_a:site_1:ep_17',
      filterSignature: 'cohort:grouped_v2_swap',
      differencingGuard: diffGuard,
    });
    expect(q2Swap.allowed).toBe(false);
    expect(q2Swap.blockedCode).toBe('DIFFERENCING_ATTACK_BLOCKED');

    // Also test atomicity: a rejected batch with [safe_disjoint_group_15, leaky_group_10_swap]
    // MUST NOT commit safe_disjoint_group_15 to RREF history!
    const fresh15 = Array.from({ length: 15 }, (_, i) => `fresh_${i}`);
    const q2PartialLeak = filterQueryAndRowsBeforeLlm({
      viewName: 'v_pub_segment_agg',
      metricName: 'page_views',
      sql,
      requestedColumns: ['segment_id', 'page_views'],
      groupByColumns: ['segment_id'],
      rows: [
        { bucketLabel: 'fresh_ok', unitCount: 15, metricKey: 'page_views', metricValue: 150, unit: 'page_views', cohortMemberIds: fresh15 },
        { bucketLabel: 'leaky_swap', unitCount: 10, metricKey: 'page_views', metricValue: 101, unit: 'page_views', cohortMemberIds: g2A },
      ],
      sessionKey: 'tenant_a:site_1:ep_17',
      filterSignature: 'cohort:grouped_v3_partial',
      differencingGuard: diffGuard,
    });
    expect(q2PartialLeak.allowed).toBe(false);
    expect(q2PartialLeak.blockedCode).toBe('DIFFERENCING_ATTACK_BLOCKED');

    // Because fresh15 was NOT partially committed when q2PartialLeak failed, querying fresh15 minus 1
    // (14 completely disjoint fresh users) as a new standalone query MUST succeed!
    const q3AfterRollback = filterQueryAndRowsBeforeLlm({
      viewName: 'v_pub_segment_agg',
      metricName: 'page_views',
      sql,
      requestedColumns: ['segment_id', 'page_views'],
      groupByColumns: ['segment_id'],
      rows: [
        { bucketLabel: 'fresh_14', unitCount: 14, metricKey: 'page_views', metricValue: 140, unit: 'page_views', cohortMemberIds: fresh15.slice(0, 14) },
      ],
      sessionKey: 'tenant_a:site_1:ep_17',
      filterSignature: 'cohort:fresh_14',
      differencingGuard: diffGuard,
    });
    expect(q3AfterRollback.allowed).toBe(true);
  });

  test('[#18] evaluates current siteConsentMode BEFORE Ask cache lookup and isolates cache by consent mode', () => {
    const svc = new AskService({ executor: new EvalGroundTruthExecutor() });
    const now = new Date('2026-11-20T12:00:00Z');
    const sharedParams = {
      principal: CALLER_A,
      siteId: 'site_eval_a',
      siteTenantId: 'tenant_eval_a',
      permissionEpoch: 77,
      question: '直近28日の合計PV数を集計してください',
      windowStart: '2026-10-23T00:00:00Z',
      windowEnd: '2026-11-20T00:00:00Z',
      now,
    };

    // 1. Run under siteConsentMode: 'full' -> succeeds and populates cache
    const fullRes = svc.ask({ ...sharedParams, siteConsentMode: 'full' });
    expect(fullRes.httpStatus).toBe(200);
    expect(fullRes.auditCode).toBe('OK');
    expect(fullRes.citations).toHaveLength(1);
    expect(fullRes.citations[0].value).toBe(1200);
    expect(fullRes.answerText).not.toBeNull();

    // 2. Re-run EXACT SAME question, window, and permissionEpoch with siteConsentMode: 'off'
    //    MUST be refused as not_collected and NEVER return the cached 'full' answer!
    const offRes = svc.ask({ ...sharedParams, siteConsentMode: 'off' });
    expect(offRes.auditCode).toBe('REFUSED:not_collected');
    expect(offRes.answerText).toBeNull();
    expect(offRes.citations).toHaveLength(0);
    expect(offRes.executedSql).toBeNull();
    expect(offRes.envelope?.measures.ask_metric.status).toBe('not_collected');
    expect(offRes.envelope?.measures.ask_metric.value).toBeNull();
  });

  test('[#15] strips raw <10 isolated counts from all Ask rejection reasons and external envelopes (small-cohort & grouped-row RREF)', () => {
    const sql = lookupPrecompiledPublicViewSql('v_pub_segment_agg', 'page_views')!;
    const now = new Date('2026-11-20T12:00:00Z');
    const winStart = '2026-10-20T00:00:00Z';
    const winEnd = '2026-11-20T00:00:00Z';

    // Use IDs/dates/questions free of the digit "7" so we can assert ZERO occurrences of secret count 7!
    const principalNo7: VerifiedPrincipal = {
      ...CALLER_A,
      credentialId: 'key_a_ask_no_s',
      tenantId: 'tenant_eval_a',
    };

    // A) Pre-execution small-cohort rejection (secret cohort size = 7 < 10)
    const secret7 = Array.from({ length: 7 }, (_, i) => `m_${i}`);
    const smallCohortPlanner: AskPlannerProvider = {
      providerId: 'local_llm',
      modelName: 'gemma-4-local',
      hosting: 'self_hosted_local',
      plan: () => ({
        kind: 'execute_query',
        toolName: 'query_public_segment_agg',
        viewName: 'v_pub_segment_agg',
        metricName: 'page_views',
        sql,
        requestedColumns: ['segment_id', 'page_views'],
        groupByColumns: ['segment_id'],
        filterSignature: 'cohort:small_probe',
        cohortMemberIds: secret7,
      }),
    };
    const svcSmall = new AskService({
      planner: smallCohortPlanner,
      executor: new EvalGroundTruthExecutor(),
    });
    const smallRes = svcSmall.ask({
      principal: principalNo7,
      siteId: 'site_eval_a',
      siteTenantId: 'tenant_eval_a',
      siteConsentMode: 'full',
      permissionEpoch: 11,
      question: 'セグメント別PV集計',
      windowStart: winStart,
      windowEnd: winEnd,
      now,
    });
    expect(smallRes.auditCode).toBe('PRE_LLM_BLOCKED:DIFFERENCING_ATTACK_BLOCKED');
    // Strip opaque hex digest tokens (ref_id / params_hash / result_digest / untrusted sha/handle)
    // and verify the entire serialized external response JSON contains ZERO occurrences of secret count "7"
    const stripOpaqueDigests = (obj: unknown): string =>
      JSON.stringify(obj, (k, v) =>
        k === 'ref_id' || k === 'params_hash' || k === 'result_digest' || k === 'sha' || k === 'handle'
          ? '<hash>'
          : v
      );
    const smallJson = stripOpaqueDigests(smallRes.envelope);
    expect(smallJson).not.toContain('7');
    expect(smallRes.envelope?.measures.page_views.reason).toBe('disclosure_blocked_differencing');
    expect(smallRes.envelope?.measures.page_views.reason).not.toMatch(/\d/);
    expect(smallRes.envelope?.measures.page_views.unmet_gates?.[0]?.unlock).toBe(
      'disclosure_blocked_differencing'
    );
    expect((smallRes.envelope?.data as { refusalReason?: string })?.refusalReason).toBe(
      'disclosure_blocked_differencing'
    );

    // B) Post-row grouped RREF rejection isolating exact delta = 7 individuals
    const users27 = Array.from({ length: 27 }, (_, i) => `u_${i}`);
    let callNum = 0;
    const groupedPlanner: AskPlannerProvider = {
      providerId: 'local_llm',
      modelName: 'gemma-4-local',
      hosting: 'self_hosted_local',
      plan: () => {
        callNum += 1;
        return {
          kind: 'execute_query',
          toolName: 'query_public_segment_agg',
          viewName: 'v_pub_segment_agg',
          metricName: 'page_views',
          sql,
          requestedColumns: ['segment_id', 'page_views'],
          groupByColumns: ['segment_id'],
          filterSignature: `cohort:grp_probe_${callNum}`,
        };
      },
    };
    const groupedExecutor: AskDataExecutor = {
      executePublicViewQuery: () => {
        if (callNum === 1) {
          return {
            connected: true,
            rows: [
              { bucketLabel: 'g_a', unitCount: 17, metricKey: 'page_views', metricValue: 170, unit: 'page_views', cohortMemberIds: users27.slice(0, 17) },
              { bucketLabel: 'g_b', unitCount: 10, metricKey: 'page_views', metricValue: 100, unit: 'page_views', cohortMemberIds: users27.slice(17, 27) },
            ],
            queryRefId: 'qref_grp_1',
            paramsHash: 'ph_aaa',
            resultDigest: 'rd_aaa',
          };
        }
        // Shift 7 members (u_10..u_16) from g_a into g_b -> g_a - g_a_shift isolates exact delta = 7 (< 10) via RREF!
        return {
          connected: true,
          rows: [
            { bucketLabel: 'g_a_shift', unitCount: 10, metricKey: 'page_views', metricValue: 100, unit: 'page_views', cohortMemberIds: users27.slice(0, 10) },
            { bucketLabel: 'g_b_shift', unitCount: 17, metricKey: 'page_views', metricValue: 170, unit: 'page_views', cohortMemberIds: users27.slice(10, 27) },
          ],
          queryRefId: 'qref_grp_2',
          paramsHash: 'ph_bbb',
          resultDigest: 'rd_bbb',
        };
      },
    };
    const svcGrouped = new AskService({ planner: groupedPlanner, executor: groupedExecutor });
    const g1 = svcGrouped.ask({
      principal: principalNo7,
      siteId: 'site_eval_a',
      siteTenantId: 'tenant_eval_a',
      siteConsentMode: 'full',
      permissionEpoch: 12,
      question: 'セグメント別PV集計 初回',
      windowStart: winStart,
      windowEnd: winEnd,
      now,
    });
    expect(g1.auditCode).toBe('OK');

    const g2 = svcGrouped.ask({
      principal: principalNo7,
      siteId: 'site_eval_a',
      siteTenantId: 'tenant_eval_a',
      siteConsentMode: 'full',
      permissionEpoch: 12,
      question: 'セグメント別PV集計 再集計',
      windowStart: winStart,
      windowEnd: winEnd,
      now,
    });
    expect(g2.auditCode).toBe('PRE_LLM_BLOCKED:DIFFERENCING_ATTACK_BLOCKED');
    const groupedJson = stripOpaqueDigests(g2.envelope);
    expect(groupedJson).not.toContain('7');
    expect(g2.envelope?.measures.page_views.reason).toBe('disclosure_blocked_differencing');
    expect(g2.envelope?.measures.page_views.reason).not.toMatch(/\d/);
    expect(g2.envelope?.measures.page_views.unmet_gates?.[0]?.unlock).toBe(
      'disclosure_blocked_differencing'
    );
    expect((g2.envelope?.data as { refusalReason?: string })?.refusalReason).toBe(
      'disclosure_blocked_differencing'
    );
  });

  test('[#17] requires cohortMemberIds on grouped rows under RREF protection and commits DifferencingGuard history atomically ONLY after post-row approval', () => {
    const sql = lookupPrecompiledPublicViewSql('v_pub_segment_agg', 'page_views')!;
    const diffGuard = new DifferencingGuard(10);
    const sessionKey = 'tenant_eval_a:site_eval_a:ep88';

    // (a) Grouped rows under RREF protection: a row missing cohortMemberIds MUST NOT be released unchecked!
    const grpA = Array.from({ length: 15 }, (_, i) => `a_${i}`);
    const grpB = Array.from({ length: 15 }, (_, i) => `b_${i}`);
    const mixedVerdict = filterQueryAndRowsBeforeLlm({
      viewName: 'v_pub_segment_agg',
      metricName: 'page_views',
      sql,
      requestedColumns: ['segment_id', 'page_views'],
      groupByColumns: ['segment_id'],
      rows: [
        { bucketLabel: 'has_ids_a', unitCount: 50, metricKey: 'page_views', metricValue: 500, unit: 'page_views', cohortMemberIds: grpA },
        { bucketLabel: 'has_ids_b', unitCount: 30, metricKey: 'page_views', metricValue: 300, unit: 'page_views', cohortMemberIds: grpB },
        { bucketLabel: 'missing_ids_row', unitCount: 20, metricKey: 'page_views', metricValue: 200, unit: 'page_views' },
      ],
      sessionKey,
      filterSignature: 'cohort:mixed_missing',
      differencingGuard: diffGuard,
    });
    // `missing_ids_row` MUST NOT appear in safeRows (suppressed + complementary secondary suppression applied!)
    expect(mixedVerdict.safeRows.some((r) => r.bucketLabel === 'missing_ids_row')).toBe(false);

    // Follow-up grouped query in the same RREF-active session where ALL rows omit cohortMemberIds -> rejected!
    const allMissingVerdict = filterQueryAndRowsBeforeLlm({
      viewName: 'v_pub_segment_agg',
      metricName: 'page_views',
      sql,
      requestedColumns: ['segment_id', 'page_views'],
      groupByColumns: ['segment_id'],
      rows: [
        { bucketLabel: 'unchecked_row', unitCount: 25, metricKey: 'page_views', metricValue: 250, unit: 'page_views' },
      ],
      sessionKey,
      filterSignature: 'cohort:all_missing',
      differencingGuard: diffGuard,
    });
    expect(allMissingVerdict.allowed).toBe(false);
    expect(allMissingVerdict.safeRows).toHaveLength(0);

    // (b) Atomic post-approval commit in AskService:
    //     Query passes pre-execution check (with predeclaredCohortMemberIds + window),
    //     then FAILS at post-row stage -> DifferencingGuard cohort & window history MUST remain completely unchanged!
    const atomicGuard = new DifferencingGuard(10);
    const atomicSessionKey = AskService.buildSessionKey('tenant_eval_a', 'site_eval_a', 99);
    const predeclared20 = Array.from({ length: 20 }, (_, i) => `pre_${i}`);

    const predeclaredPlanner: AskPlannerProvider = {
      providerId: 'local_llm',
      modelName: 'gemma-4-local',
      hosting: 'self_hosted_local',
      plan: () => ({
        kind: 'execute_query',
        toolName: 'query_public_segment_agg',
        viewName: 'v_pub_segment_agg',
        metricName: 'page_views',
        sql,
        requestedColumns: ['segment_id', 'page_views'],
        groupByColumns: ['segment_id'],
        filterSignature: 'cohort:atomic_test',
        cohortMemberIds: predeclared20,
      }),
    };
    const failingPostRowExecutor: AskDataExecutor = {
      executePublicViewQuery: () => ({
        connected: true,
        // Fails at post-row stage (< k cell suppression)
        rows: [
          { bucketLabel: 'tiny_bucket', unitCount: 4, metricKey: 'page_views', metricValue: 40, unit: 'page_views', cohortMemberIds: predeclared20.slice(0, 4) },
        ],
        queryRefId: 'qref_atomic_fail',
        paramsHash: 'ph_atomic',
        resultDigest: 'rd_atomic',
      }),
    };

    const svcAtomic = new AskService({
      planner: predeclaredPlanner,
      executor: failingPostRowExecutor,
      differencingGuard: atomicGuard,
    });
    expect(atomicGuard.getCohortHistoryLength(atomicSessionKey)).toBe(0);
    expect(atomicGuard.getWindowHistoryLength(atomicSessionKey)).toBe(0);

    const rejectedRes = svcAtomic.ask({
      principal: CALLER_A,
      siteId: 'site_eval_a',
      siteTenantId: 'tenant_eval_a',
      siteConsentMode: 'full',
      permissionEpoch: 99,
      question: 'セグメント別PV集計',
      windowStart: '2026-11-01T00:00:00Z',
      windowEnd: '2026-11-28T00:00:00Z',
    });
    expect(rejectedRes.auditCode).toBe('PRE_LLM_BLOCKED:SMALL_CELL_SUPPRESSED');
    // DifferencingGuard history MUST be completely untouched after post-row rejection!
    expect(atomicGuard.getCohortHistoryLength(atomicSessionKey)).toBe(0);
    expect(atomicGuard.getWindowHistoryLength(atomicSessionKey)).toBe(0);
  });
});
