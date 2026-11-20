/**
 * UGOKI LINK v2 — Single Tenant-Scoped ClickHouse Query Builder (Isolation Layer A)
 *
 * `tenant_id` and `site_id` are derived EXCLUSIVELY from the verified server-side
 * principal (`VerifiedPrincipal`). Any attempt to override `tenant_id` via caller
 * parameters fails closed. Every SQL template passes `inspectSqlAst()` before execution.
 */

import type { VerifiedPrincipal } from '@/lib/link/auth';
import { inspectSqlAst, type SqlAstViolation } from './ast-inspector';
import { perTenantRoUsername } from './row-policy';

export class SqlAstViolationError extends Error {
  public readonly violations: ReadonlyArray<SqlAstViolation>;
  constructor(violations: ReadonlyArray<SqlAstViolation>) {
    const summary = violations.map((v) => `[${v.code}] ${v.message}`).join('; ');
    super(`ClickHouse SQL AST inspection failed: ${summary}`);
    this.name = 'SqlAstViolationError';
    this.violations = violations;
  }
}

export class TenantScopeViolationError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TenantScopeViolationError';
    this.code = code;
  }
}

export interface QueryBuildSpec {
  readonly sql: string;
  /** User-supplied typed parameters (NEVER allowed to override `tenant_id`). */
  readonly params?: Readonly<Record<string, string | number | boolean | ReadonlyArray<string | number>>>;
  /** Target siteId when the query binds `{site_id:String}`. */
  readonly siteId?: string;
}

export interface SanctionedClickHouseQuery {
  readonly sql: string;
  readonly query_params: Readonly<Record<string, string | number | boolean | ReadonlyArray<string | number>>>;
  readonly clickhouseUser: string;
  readonly tenantId: string;
  readonly siteId?: string;
  readonly tables: ReadonlyArray<string>;
  readonly enforcedSettings: Readonly<{
    readonly readonly: 1;
    readonly users_without_row_policies_can_read_rows: 0;
  }>;
}

export class TenantScopedQueryBuilder {
  private readonly heldTables = new Set<string>();

  /** Marks a table as `isolation_hold` (HTTP 503) when the 5-min watchdog fires F-01. */
  public setTableIsolationHold(table: string, held: boolean): void {
    const normalized = table.trim().toLowerCase();
    if (held) {
      this.heldTables.add(normalized);
    } else {
      this.heldTables.delete(normalized);
    }
  }

  public isTableHeld(table: string): boolean {
    return this.heldTables.has(table.trim().toLowerCase());
  }

  public getHeldTables(): ReadonlyArray<string> {
    return [...this.heldTables];
  }

  /**
   * Builds a strictly validated, parameter-bound ClickHouse query bound to the
   * principal's server-verified `tenantId` and per-tenant read-only ClickHouse identity.
   */
  public build(principal: VerifiedPrincipal, spec: QueryBuildSpec): SanctionedClickHouseQuery {
    // 1. Refuse any caller-supplied `tenant_id` parameter that attempts to override principal.tenantId
    if (spec.params && 'tenant_id' in spec.params && spec.params.tenant_id !== principal.tenantId) {
      throw new TenantScopeViolationError(
        'TENANT_PARAM_OVERRIDE_FORBIDDEN',
        'tenant_id parameter is derived exclusively from the verified credential and cannot be overridden'
      );
    }

    // 2. Validate siteId against principal's allowedSiteIds constraint if present
    if (spec.siteId && principal.allowedSiteIds !== null) {
      if (!principal.allowedSiteIds.includes(spec.siteId)) {
        throw new TenantScopeViolationError(
          'SITE_SCOPE_VIOLATION',
          `Credential is not authorized for site "${spec.siteId}"`
        );
      }
    }
    if (
      spec.params &&
      typeof spec.params.site_id === 'string' &&
      principal.allowedSiteIds !== null &&
      !principal.allowedSiteIds.includes(spec.params.site_id)
    ) {
      throw new TenantScopeViolationError(
        'SITE_SCOPE_VIOLATION',
        `Parameter site_id "${spec.params.site_id}" is outside credential allowlist`
      );
    }

    // 3. Run strict SQL AST inspection
    const inspection = inspectSqlAst(spec.sql, {
      requireTenantFilter: true,
      requireTimeBound: true,
    });
    if (!inspection.valid) {
      throw new SqlAstViolationError(inspection.violations);
    }

    // 4. Reject if any referenced table is currently in `isolation_hold` (503)
    for (const tbl of inspection.tables) {
      if (this.heldTables.has(tbl)) {
        throw new TenantScopeViolationError(
          'TABLE_ISOLATION_HOLD_503',
          `Table "${tbl}" is currently under isolation_hold due to watchdog incident F-01`
        );
      }
    }

    // 5. Assemble typed query_params, ALWAYS stamping server-side `tenant_id`
    const queryParams: Record<string, string | number | boolean | ReadonlyArray<string | number>> = {
      ...(spec.params ?? {}),
      tenant_id: principal.tenantId,
    };
    if (spec.siteId !== undefined) {
      queryParams.site_id = spec.siteId;
    }

    // 6. Verify every declared typed bind `{name:Type}` has a supplied value
    for (const bind of inspection.typedBinds) {
      if (!(bind.name in queryParams) || queryParams[bind.name] === undefined) {
        throw new TenantScopeViolationError(
          'MISSING_TYPED_BIND_PARAM',
          `Missing parameter value for typed bind {${bind.name}:${bind.type}}`
        );
      }
    }

    return {
      sql: spec.sql.trim(),
      query_params: queryParams,
      clickhouseUser: perTenantRoUsername(principal.tenantId),
      tenantId: principal.tenantId,
      siteId: spec.siteId,
      tables: inspection.tables,
      enforcedSettings: {
        readonly: 1,
        users_without_row_policies_can_read_rows: 0,
      },
    };
  }
}
