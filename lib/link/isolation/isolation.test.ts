import { AuthorizationGateway, type VerifiedPrincipal } from '@/lib/link/auth';
import {
  ALL_TENANT_TABLES,
  BEHAVIOUR_TABLES,
  ClickHouseIsolationSimulator,
  IsolationWatchdog,
  SqlAstViolationError,
  TenantScopeViolationError,
  TenantScopedQueryBuilder,
  evaluateGateG1,
  evaluateGateG2,
  evaluateGateG3,
  evaluateGateG4,
  generateCrawlZeroGrantDdl,
  generatePerTenantIdentityDdl,
  inspectSqlAst,
  perTenantRoUsername,
  runForeignTenantIsolationMatrix,
} from './index';

const PRINCIPAL_A: VerifiedPrincipal = {
  credentialKind: 'ugk_sec',
  credentialId: 'key_a_001',
  tenantId: 'tenant_a',
  orgId: 'org_a',
  allowedSiteIds: ['site_a1'],
  principalKind: 'service',
  principalId: 'svc_a',
  role: 'admin',
  effectiveScopes: new Set(['analytics:read', 'fusion:read']),
  senderConstrained: true,
  passkeyVerified: false,
};

describe('lib/link/isolation — Layer A AST Inspector & Query Builder, Layer B Row Policies, Watchdog & G1–G4', () => {
  test('Layer A SQL AST inspector accepts valid tenant-bound queries and rejects every forbidden pattern', () => {
    const goodSql = `
      SELECT page_id, sum(pv_count) AS pvs
      FROM rollup_page_hourly
      WHERE tenant_id = {tenant_id:String}
        AND site_id = {site_id:String}
        AND pv_hour >= {start:DateTime}
        AND pv_hour < {end:DateTime}
      GROUP BY page_id
    `;
    const ok = inspectSqlAst(goodSql);
    expect(ok.valid).toBe(true);
    expect(ok.tables).toEqual(['rollup_page_hourly']);

    // 1. Missing tenant_id typed bind
    expect(
      inspectSqlAst(
        `SELECT page_id FROM rollup_page_hourly WHERE site_id = {site_id:String} AND pv_hour >= {start:DateTime}`
      ).violations.some((v) => v.code === 'MISSING_TENANT_BIND_PREDICATE')
    ).toBe(true);

    // 2. Inline string literal on tenant_id / quote injection
    expect(
      inspectSqlAst(
        `SELECT page_id FROM rollup_page_hourly WHERE tenant_id = 'tenant_a' AND pv_hour >= {start:DateTime}`
      ).violations.some((v) => v.code === 'INLINE_TENANT_OR_ID_LITERAL')
    ).toBe(true);

    // 3. SELECT *
    expect(
      inspectSqlAst(
        `SELECT * FROM rollup_page_hourly WHERE tenant_id = {tenant_id:String} AND pv_hour >= {start:DateTime}`
      ).violations.some((v) => v.code === 'FORBIDDEN_SELECT_STAR')
    ).toBe(true);

    // 4. Unbounded time query
    expect(
      inspectSqlAst(
        `SELECT page_id FROM rollup_page_hourly WHERE tenant_id = {tenant_id:String}`
      ).violations.some((v) => v.code === 'MISSING_TIME_BOUND_FILTER')
    ).toBe(true);

    // 5. Raw base table on RIGHT side of JOIN
    expect(
      inspectSqlAst(
        `SELECT r.page_id FROM rollup_page_hourly r INNER JOIN events e ON r.page_id = e.page_id WHERE r.tenant_id = {tenant_id:String} AND r.pv_hour >= {start:DateTime}`
      ).violations.some((v) => v.code === 'BASE_TABLE_ON_JOIN_RIGHT')
    ).toBe(true);

    // 6. GROUP BY unindexed identity column on rollup_page_hourly (OOM guard)
    expect(
      inspectSqlAst(
        `SELECT visitor_id, count() FROM rollup_page_hourly WHERE tenant_id = {tenant_id:String} AND pv_hour >= {start:DateTime} GROUP BY visitor_id`
      ).violations.some((v) => v.code === 'UNINDEXED_IDENTITY_GROUP_BY')
    ).toBe(true);

    // 7. GROUP BY indexed visitor_id on visitor_identity_index IS permitted
    expect(
      inspectSqlAst(
        `SELECT visitor_id, count() FROM visitor_identity_index WHERE tenant_id = {tenant_id:String} AND day_local >= {start:Date} GROUP BY visitor_id`
      ).valid
    ).toBe(true);

    // 8. SETTINGS / additional_table_filters / DDL / multi-statement
    expect(
      inspectSqlAst(
        `SELECT page_id FROM rollup_page_hourly WHERE tenant_id = {tenant_id:String} AND pv_hour >= {start:DateTime} SETTINGS additional_table_filters={'rollup_page_hourly':'1=1'}`
      ).violations.some((v) => v.code === 'FORBIDDEN_SETTINGS_OR_FILTER_OVERRIDE')
    ).toBe(true);

    expect(
      inspectSqlAst(
        `SELECT page_id FROM rollup_page_hourly WHERE tenant_id = {tenant_id:String} AND pv_hour >= {start:DateTime}; DROP TABLE events`
      ).violations.some((v) => v.code === 'MULTI_STATEMENT')
    ).toBe(true);
  });

  test('TenantScopedQueryBuilder binds tenant_id exclusively from verified principal and blocks overrides & held tables', () => {
    const qb = new TenantScopedQueryBuilder();
    const sql = `
      SELECT page_id, sum(pv_count)
      FROM rollup_page_hourly
      WHERE tenant_id = {tenant_id:String}
        AND site_id = {site_id:String}
        AND pv_hour >= {start:DateTime}
      GROUP BY page_id
    `;

    const built = qb.build(PRINCIPAL_A, {
      sql,
      siteId: 'site_a1',
      params: { start: '2026-11-01 00:00:00' },
    });
    expect(built.query_params.tenant_id).toBe('tenant_a');
    expect(built.query_params.site_id).toBe('site_a1');
    expect(built.clickhouseUser).toBe(perTenantRoUsername('tenant_a'));
    expect(built.enforcedSettings.readonly).toBe(1);
    expect(built.enforcedSettings.users_without_row_policies_can_read_rows).toBe(0);

    // Attempting to override tenant_id via params throws TenantScopeViolationError
    expect(() =>
      qb.build(PRINCIPAL_A, {
        sql,
        siteId: 'site_a1',
        params: { tenant_id: 'tenant_b', start: '2026-11-01 00:00:00' },
      })
    ).toThrow(TenantScopeViolationError);

    // Site outside principal allowlist throws
    expect(() =>
      qb.build(PRINCIPAL_A, {
        sql,
        siteId: 'site_a2',
        params: { start: '2026-11-01 00:00:00' },
      })
    ).toThrow(TenantScopeViolationError);

    // Invalid AST throws SqlAstViolationError
    expect(() =>
      qb.build(PRINCIPAL_A, {
        sql: `SELECT * FROM rollup_page_hourly WHERE tenant_id = {tenant_id:String} AND pv_hour >= {start:DateTime}`,
        params: { start: '2026-11-01 00:00:00' },
      })
    ).toThrow(SqlAstViolationError);

    // Table on isolation_hold -> fails closed with 503 error code
    qb.setTableIsolationHold('rollup_page_hourly', true);
    expect(() =>
      qb.build(PRINCIPAL_A, {
        sql,
        siteId: 'site_a1',
        params: { start: '2026-11-01 00:00:00' },
      })
    ).toThrow(/TABLE_ISOLATION_HOLD_503|isolation_hold/);
  });

  test('Layer B DDL generator emits paired PERMISSIVE + RESTRICTIVE policies & locked readonly profile; simulator blocks stray permissive bypass', () => {
    const ddl = generatePerTenantIdentityDdl({
      tenantId: 'tenant_a',
      tables: ['rollup_page_hourly', 'page_view_state'],
    });
    expect(ddl.policies).toHaveLength(2);
    const fullDdl = ddl.statements.join('\n');
    expect(fullDdl).toContain('readonly = 1 CONST');
    expect(fullDdl).toContain('users_without_row_policies_can_read_rows = 0 CONST');
    expect(fullDdl).toContain('AS PERMISSIVE');
    expect(fullDdl).toContain('AS RESTRICTIVE');

    const crawlDdl = generateCrawlZeroGrantDdl({ crawlUsername: 'crawl_worker' }).join('\n');
    expect(crawlDdl).toContain('REVOKE ALL ON ugoki_behavior.* FROM crawl_worker');
    expect(crawlDdl).toContain('GRANT SELECT, INSERT, CREATE TABLE ON ugoki_crawl.* TO crawl_worker');

    // Simulate defense-in-depth: adding a buggy permissive `USING 1` policy STILL cannot leak tenant_b rows!
    const sim = new ClickHouseIsolationSimulator();
    sim.registerTable('rollup_page_hourly', [
      { tenant_id: 'tenant_a', marker: 'a1' },
      { tenant_id: 'tenant_a', marker: 'a2' },
      { tenant_id: 'tenant_b', marker: 'b1' },
    ]);
    const userA = sim.provisionTenantRoIdentity('tenant_a', ['rollup_page_hourly']);

    // Inject stray permissive policy allowing everything
    sim.addPolicy({
      name: 'stray_buggy_permissive',
      table: 'rollup_page_hourly',
      user: userA,
      mode: 'PERMISSIVE',
      predicate: () => true,
    });

    const res = sim.executeSelect({ username: userA, table: 'rollup_page_hourly' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rows).toHaveLength(2);
      expect(res.rows.every((r) => r.tenant_id === 'tenant_a')).toBe(true);
    }
  });

  test('5-minute watchdog passes clean cycle and trips isolation_hold (503) + F-01 incident alert on leak', () => {
    const tables = ['rollup_page_hourly', 'page_view_state'];
    const sim = new ClickHouseIsolationSimulator();
    for (const t of tables) {
      sim.registerTable(t, [
        { tenant_id: 'canary_a', marker: 'm1' },
        { tenant_id: 'canary_a', marker: 'm2' },
        { tenant_id: 'canary_b', marker: 'mb1' },
      ]);
    }
    const canaryUserA = sim.provisionTenantRoIdentity('canary_a', tables);
    sim.registerUser({
      username: 'canary_no_policy',
      readonlyLevel: 1,
      usersWithoutRowPoliciesCanReadRows: 0,
      grantedSelectTables: new Set(tables),
    });

    const qb = new TenantScopedQueryBuilder();
    const watchdog = new IsolationWatchdog();

    const cleanReport = watchdog.runCycle({
      simulator: sim,
      queryBuilder: qb,
      config: {
        canaryTenantA: 'canary_a',
        canaryUserA,
        expectedMarkersA: 2,
        canaryTenantB: 'canary_b',
        policylessCanaryUser: 'canary_no_policy',
        tables,
      },
    });
    expect(cleanReport.allPassed).toBe(true);
    expect(cleanReport.alerts).toHaveLength(0);
    expect(qb.getHeldTables()).toHaveLength(0);
    expect(watchdog.getConsecutiveCleanRuns()).toBe(1);

    // Simulate broken user config: policyless user allowed to read rows -> watchdog MUST trigger F-01 + hold!
    sim.registerUser({
      username: 'canary_no_policy',
      readonlyLevel: 1,
      usersWithoutRowPoliciesCanReadRows: 1,
      grantedSelectTables: new Set(['rollup_page_hourly']),
    });

    const failReport = watchdog.runCycle({
      simulator: sim,
      queryBuilder: qb,
      config: {
        canaryTenantA: 'canary_a',
        canaryUserA,
        expectedMarkersA: 2,
        canaryTenantB: 'canary_b',
        policylessCanaryUser: 'canary_no_policy',
        tables,
      },
    });
    expect(failReport.allPassed).toBe(false);
    expect(failReport.alerts.some((a) => a.incidentCode === 'F-01' && a.table === 'rollup_page_hourly')).toBe(
      true
    );
    expect(qb.isTableHeld('rollup_page_hourly')).toBe(true);
    expect(watchdog.getConsecutiveCleanRuns()).toBe(0);
  });

  test('Isolation 4-Gate Suite (surf.G1–surf.G4) & full operation × credential × foreign-ID 404 matrix pass with 0 leaks', () => {
    const sim = new ClickHouseIsolationSimulator();
    for (const tbl of ALL_TENANT_TABLES) {
      sim.registerTable(tbl, [
        { tenant_id: 'tenant_a', marker: 'a' },
        { tenant_id: 'tenant_b', marker: 'b' },
      ]);
    }
    sim.provisionTenantRoIdentity('tenant_a', ALL_TENANT_TABLES);
    sim.provisionTenantRoIdentity('tenant_b', ALL_TENANT_TABLES);

    // CRAWL user has ZERO grants on behaviour tables
    sim.registerUser({
      username: 'crawl_service',
      readonlyLevel: 1,
      usersWithoutRowPoliciesCanReadRows: 0,
      grantedSelectTables: new Set(['dim_pages']), // non-behaviour only
    });
    sim.registerUser({
      username: 'policyless_canary',
      readonlyLevel: 1,
      usersWithoutRowPoliciesCanReadRows: 0,
      grantedSelectTables: new Set(ALL_TENANT_TABLES),
    });

    const g1 = evaluateGateG1({
      simulator: sim,
      crawlUsername: 'crawl_service',
      behaviourTables: BEHAVIOUR_TABLES,
    });
    expect(g1.passed).toBe(true);
    expect(g1.ledgerRegistered).toBe(true);

    const g2 = evaluateGateG2({
      simulator: sim,
      tenantIds: ['tenant_a', 'tenant_b'],
      tables: ALL_TENANT_TABLES,
      policylessCanaryUser: 'policyless_canary',
    });
    expect(g2.passed).toBe(true);
    expect(g2.ledgerRegistered).toBe(true);

    const g3 = evaluateGateG3({
      sanctionedSqlTemplates: [
        `SELECT page_id, sum(pv_count) FROM rollup_page_hourly WHERE tenant_id = {tenant_id:String} AND pv_hour >= {start:DateTime} GROUP BY page_id`,
        `SELECT page_id, sec_fp FROM dim_sections WHERE tenant_id = {tenant_id:String} AND observed_at >= {start:DateTime}`,
      ],
    });
    expect(g3.passed).toBe(true);
    expect(g3.ledgerRegistered).toBe(true);

    // Full matrix: 7 operations × 8 credential kinds × 12 foreign resource types = 672 cases!
    const gateway = new AuthorizationGateway();
    const matrix = runForeignTenantIsolationMatrix({
      gateway,
      callerTenantId: 'tenant_a',
      foreignTenantId: 'tenant_b',
    });
    expect(matrix.totalCases).toBe(7 * 8 * 12);
    expect(matrix.leakedCases).toBe(0);
    expect(matrix.non404Cases).toBe(0);
    expect(matrix.missingAuditCases).toBe(0);
    expect(matrix.auditChainValid).toBe(true);
    expect(matrix.allPassed).toBe(true);

    const g4 = evaluateGateG4({
      federationUsesNonBypassRole: true,
      operatorPathIsolatedFromFederation: true,
      matrixReport: matrix,
    });
    expect(g4.passed).toBe(true);
    expect(g4.ledgerRegistered).toBe(true);
  });
});
