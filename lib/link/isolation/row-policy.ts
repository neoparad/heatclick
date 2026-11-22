/**
 * UGOKI LINK v2 — ClickHouse Per-Tenant Read-Only Identity, Paired Permissive + Restrictive
 * Row Policies, CRAWL Zero-Grant Revocation DDL, and Deterministic Policy Simulator
 * (Isolation Layer B / `store-final.md` M7 / `surface-final.md` §8.3 G1 & G2)
 */

import { sha256Hex } from '@/packages/contract/response';
import { CANONICAL_SCHEMA } from '@/packages/contract/schema';
import { TENANT_TABLE_CATALOG } from './ast-inspector';

export const ALL_TENANT_TABLES: ReadonlyArray<string> = Object.keys(TENANT_TABLE_CATALOG);

const NON_BEHAVIOUR_STRUCTURAL_TABLES: ReadonlySet<string> = new Set([
  'dim_pages',
  'dim_sections',
  'fact_structure_asof',
  'snapshot_registry',
]);

export const BEHAVIOUR_TABLES: ReadonlyArray<string> = Array.from(
  new Set([
    ...CANONICAL_SCHEMA.tables
      .filter((t) => t.store === 'clickhouse' && !NON_BEHAVIOUR_STRUCTURAL_TABLES.has(t.name))
      .map((t) => t.name),
    'events',
    'conversion_events',
    'visitor_identity_index',
  ])
);

export interface TenantProfileLimits {
  readonly maxMemoryUsageBytes: number;
  readonly maxExecutionTimeSec: number;
  readonly maxThreads: number;
  readonly maxConcurrentQueriesForUser: number;
}

export const DEFAULT_TENANT_RO_LIMITS: TenantProfileLimits = {
  maxMemoryUsageBytes: 256 * 1024 * 1024, // 256 MiB per query (STORE M6)
  maxExecutionTimeSec: 15,
  maxThreads: 2,
  maxConcurrentQueriesForUser: 4,
};

function assertSafeIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`Unsafe ${label} identifier: ${value}`);
  }
}

function escapeSqlStringLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Deterministic per-tenant read-only ClickHouse username (32 hex chars = 128-bit collision resistance).
 * Matches `ddl-generator.ts` Row Policy predicate:
 * `substring(lower(hex(SHA256(toString(tenant_id)))), 1, 32) = replaceRegexpOne(currentUser(), '^ugk_ro_', '')`
 */
export function perTenantRoUsername(tenantId: string): string {
  assertSafeIdentifier(tenantId, 'tenantId');
  return `ugk_ro_${sha256Hex(tenantId).slice(0, 32)}`;
}

export function perTenantProfileName(tenantId: string): string {
  assertSafeIdentifier(tenantId, 'tenantId');
  return `ugk_prof_${sha256Hex(tenantId).slice(0, 32)}`;
}

/**
 * Exact TypeScript evaluation of the base ClickHouse table-level Row Policy predicate emitted in `001_clickhouse_v2.sql`:
 * `substring(lower(hex(SHA256(toString(tenant_id)))), 1, 32) = replaceRegexpOne(currentUser(), '^ugk_ro_', '')`
 */
export function evaluateBaseDdlRowPolicyPredicate(
  rowTenantId: string,
  currentUsername: string
): boolean {
  const rowHash32 = sha256Hex(String(rowTenantId)).toLowerCase().slice(0, 32);
  const userSuffix = currentUsername.replace(/^ugk_ro_/, '');
  return rowHash32 === userSuffix;
}

export interface GeneratedTenantIsolationDdl {
  readonly tenantId: string;
  readonly username: string;
  readonly profileName: string;
  readonly database: string;
  readonly statements: ReadonlyArray<string>;
  readonly policies: ReadonlyArray<{
    readonly table: string;
    readonly permissiveName: string;
    readonly restrictiveName: string;
  }>;
}

/**
 * Generates ClickHouse DDL for:
 *   1. Locked read-only settings profile (`readonly = 1`, `users_without_row_policies_can_read_rows = 0`,
 *      bounded memory/time/threads, CONST so SQL cannot override `additional_table_filters` or limits)
 *   2. Per-tenant read-only user with SELECT-only grants on tenant tables (zero GRANT OPTION)
 *   3. BOTH a PERMISSIVE and a RESTRICTIVE Row Policy on every tenant table (`store-final.md` M7)
 */
export function generatePerTenantIdentityDdl(params: {
  readonly tenantId: string;
  readonly database?: string;
  readonly tables?: ReadonlyArray<string>;
  readonly limits?: Partial<TenantProfileLimits>;
}): GeneratedTenantIsolationDdl {
  const database = params.database ?? 'ugoki_behavior';
  assertSafeIdentifier(database, 'database');
  assertSafeIdentifier(params.tenantId, 'tenantId');

  const tables = params.tables ?? ALL_TENANT_TABLES;
  const limits: TenantProfileLimits = { ...DEFAULT_TENANT_RO_LIMITS, ...(params.limits ?? {}) };
  const username = perTenantRoUsername(params.tenantId);
  const profileName = perTenantProfileName(params.tenantId);
  const escapedTenant = escapeSqlStringLiteral(params.tenantId);

  const statements: string[] = [];
  const policies: Array<{ table: string; permissiveName: string; restrictiveName: string }> = [];

  // 1. Locked settings profile
  statements.push(
    [
      `CREATE SETTINGS PROFILE IF NOT EXISTS ${profileName} SETTINGS`,
      `  readonly = 1 CONST,`,
      `  users_without_row_policies_can_read_rows = 0 CONST,`,
      `  max_memory_usage = ${limits.maxMemoryUsageBytes} CONST,`,
      `  max_execution_time = ${limits.maxExecutionTimeSec} CONST,`,
      `  max_threads = ${limits.maxThreads} CONST,`,
      `  max_concurrent_queries_for_user = ${limits.maxConcurrentQueriesForUser} CONST;`,
    ].join('\n')
  );

  // 2. Per-tenant read-only user
  statements.push(
    `CREATE USER IF NOT EXISTS ${username} DEFAULT ROLE NONE SETTINGS PROFILE ${profileName};`
  );

  // 3. SELECT grant + Paired PERMISSIVE & RESTRICTIVE Row Policies on EVERY tenant table
  for (const tbl of tables) {
    assertSafeIdentifier(tbl, 'table');
    const fqTable = `${database}.${tbl}`;
    const permissiveName = `rp_allow_${username}_${tbl}`;
    const restrictiveName = `rp_restrict_${username}_${tbl}`;

    statements.push(`GRANT SELECT ON ${fqTable} TO ${username};`);
    statements.push(
      `CREATE ROW POLICY IF NOT EXISTS ${permissiveName} ON ${fqTable} FOR SELECT USING tenant_id = '${escapedTenant}' AS PERMISSIVE TO ${username};`
    );
    statements.push(
      `CREATE ROW POLICY IF NOT EXISTS ${restrictiveName} ON ${fqTable} FOR SELECT USING tenant_id = '${escapedTenant}' AS RESTRICTIVE TO ${username};`
    );

    policies.push({ table: tbl, permissiveName, restrictiveName });
  }

  return {
    tenantId: params.tenantId,
    username,
    profileName,
    database,
    statements,
    policies,
  };
}

/**
 * Generates DDL to enforce Isolation Gate 1 (`surf.G1`):
 * Revokes ALL ClickHouse grants for the CRAWL service user on behaviour tables
 * and confines CRAWL writes to its own separate `ugoki_crawl` database.
 */
export function generateCrawlZeroGrantDdl(params: {
  readonly crawlUsername: string;
  readonly behaviorDatabase?: string;
  readonly crawlDatabase?: string;
}): ReadonlyArray<string> {
  const behaviorDb = params.behaviorDatabase ?? 'ugoki_behavior';
  const crawlDb = params.crawlDatabase ?? 'ugoki_crawl';
  assertSafeIdentifier(params.crawlUsername, 'crawlUsername');
  assertSafeIdentifier(behaviorDb, 'behaviorDatabase');
  assertSafeIdentifier(crawlDb, 'crawlDatabase');

  const stmts: string[] = [
    `REVOKE ALL ON ${behaviorDb}.* FROM ${params.crawlUsername};`,
  ];
  for (const tbl of BEHAVIOUR_TABLES) {
    stmts.push(`REVOKE ALL ON ${behaviorDb}.${tbl} FROM ${params.crawlUsername};`);
  }
  stmts.push(`CREATE DATABASE IF NOT EXISTS ${crawlDb};`);
  stmts.push(`GRANT SELECT, INSERT, CREATE TABLE ON ${crawlDb}.* TO ${params.crawlUsername};`);
  return stmts;
}

// =========================================================================
// Deterministic In-Memory ClickHouse Row-Policy Simulator (CI & Watchdog)
// =========================================================================

export interface SimulatedRow {
  readonly tenant_id: string;
  readonly marker?: string;
  readonly [key: string]: unknown;
}

export interface SimulatedRowPolicy {
  readonly name: string;
  readonly table: string;
  readonly user: string;
  readonly mode: 'PERMISSIVE' | 'RESTRICTIVE';
  readonly predicate: (row: SimulatedRow) => boolean;
}

export interface SimulatedClickHouseUser {
  readonly username: string;
  readonly readonlyLevel: 0 | 1 | 2;
  readonly usersWithoutRowPoliciesCanReadRows: 0 | 1;
  readonly grantedSelectTables: ReadonlySet<string>;
}

export class ClickHouseIsolationSimulator {
  private readonly users = new Map<string, SimulatedClickHouseUser>();
  private readonly policies: SimulatedRowPolicy[] = [];
  private readonly tables = new Map<string, SimulatedRow[]>();

  public registerTable(table: string, rows: ReadonlyArray<SimulatedRow> = []): void {
    this.tables.set(table, [...rows]);
  }

  public insertRows(table: string, rows: ReadonlyArray<SimulatedRow>): void {
    const existing = this.tables.get(table) ?? [];
    existing.push(...rows);
    this.tables.set(table, existing);
  }

  public registerUser(user: SimulatedClickHouseUser): void {
    this.users.set(user.username, user);
  }

  public addPolicy(policy: SimulatedRowPolicy): void {
    this.policies.push(policy);
  }

  /**
   * Provisions a tenant with BOTH:
   *   1. The base `001_clickhouse_v2.sql` `SHA256(toString(tenant_id))` paired PERMISSIVE + RESTRICTIVE policies
   *   2. The per-tenant `generatePerTenantIdentityDdl` `tenant_id = '<tenantId>'` paired PERMISSIVE + RESTRICTIVE policies
   * Proves zero lockout when both RESTRICTIVE policies are active simultaneously (C-14).
   */
  public provisionTenantRoIdentity(
    tenantId: string,
    tables: ReadonlyArray<string> = [...this.tables.keys()]
  ): string {
    const username = perTenantRoUsername(tenantId);
    this.registerUser({
      username,
      readonlyLevel: 1,
      usersWithoutRowPoliciesCanReadRows: 0,
      grantedSelectTables: new Set(tables),
    });
    for (const tbl of tables) {
      // Base table-level DDL row policies (`001_clickhouse_v2.sql`)
      this.addPolicy({
        name: `rp_${tbl}_tenant_permissive`,
        table: tbl,
        user: username,
        mode: 'PERMISSIVE',
        predicate: (r) => evaluateBaseDdlRowPolicyPredicate(r.tenant_id, username),
      });
      this.addPolicy({
        name: `rp_${tbl}_tenant_restrictive`,
        table: tbl,
        user: username,
        mode: 'RESTRICTIVE',
        predicate: (r) => evaluateBaseDdlRowPolicyPredicate(r.tenant_id, username),
      });

      // Per-tenant identity DDL row policies (`generatePerTenantIdentityDdl`)
      this.addPolicy({
        name: `rp_allow_${username}_${tbl}`,
        table: tbl,
        user: username,
        mode: 'PERMISSIVE',
        predicate: (r) => r.tenant_id === tenantId,
      });
      this.addPolicy({
        name: `rp_restrict_${username}_${tbl}`,
        table: tbl,
        user: username,
        mode: 'RESTRICTIVE',
        predicate: (r) => r.tenant_id === tenantId,
      });
    }
    return username;
  }

  public getPoliciesForTableAndUser(table: string, user: string): ReadonlyArray<SimulatedRowPolicy> {
    return this.policies.filter((p) => p.table === table && p.user === user);
  }

  public getUser(username: string): SimulatedClickHouseUser | undefined {
    return this.users.get(username);
  }

  public listTables(): ReadonlyArray<string> {
    return [...this.tables.keys()];
  }

  /**
   * Simulates ClickHouse SELECT execution with row-policy evaluation and `readonly = 1` guards.
   */
  public executeSelect(params: {
    readonly username: string;
    readonly table: string;
    readonly sql?: string;
    readonly filter?: (row: SimulatedRow) => boolean;
  }): { readonly ok: true; readonly rows: ReadonlyArray<SimulatedRow> } | { readonly ok: false; readonly error: string } {
    const user = this.users.get(params.username);
    if (!user) {
      return { ok: false, error: `UNKNOWN_USER:${params.username}` };
    }

    // `readonly = 1` rejects SETTINGS overrides, additional_table_filters, and SET ROLE
    if (params.sql && user.readonlyLevel === 1) {
      if (
        /\bSETTINGS\b/i.test(params.sql) ||
        /\badditional_table_filters\b/i.test(params.sql) ||
        /\bSET\s+ROLE\b/i.test(params.sql)
      ) {
        return {
          ok: false,
          error: 'READONLY_PROFILE_REJECTS_SETTINGS_OR_ROLE_MUTATION',
        };
      }
    }

    if (!user.grantedSelectTables.has(params.table)) {
      return { ok: false, error: `ACCESS_DENIED_TABLE:${params.table}` };
    }

    const allRows = this.tables.get(params.table) ?? [];
    const tablePolicies = this.getPoliciesForTableAndUser(params.table, params.username);

    // ClickHouse `users_without_row_policies_can_read_rows = 0`:
    if (tablePolicies.length === 0) {
      if (user.usersWithoutRowPoliciesCanReadRows === 0) {
        return { ok: true, rows: [] };
      }
      const rows = params.filter ? allRows.filter(params.filter) : allRows;
      return { ok: true, rows };
    }

    const permissive = tablePolicies.filter((p) => p.mode === 'PERMISSIVE');
    const restrictive = tablePolicies.filter((p) => p.mode === 'RESTRICTIVE');

    // ClickHouse semantics: row visible iff (any permissive matches OR no permissive exists) AND (ALL restrictive match).
    // With our defense-in-depth, if a stray permissive (`USING 1`) is added, restrictive STILL intersects it out!
    const visible = allRows.filter((row) => {
      const passesPermissive =
        permissive.length === 0 ? true : permissive.some((p) => p.predicate(row));
      const passesRestrictive = restrictive.every((p) => p.predicate(row));
      if (!passesPermissive || !passesRestrictive) return false;
      return params.filter ? params.filter(row) : true;
    });

    return { ok: true, rows: visible };
  }
}
