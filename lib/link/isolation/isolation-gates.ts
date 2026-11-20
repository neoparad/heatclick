/**
 * UGOKI LINK v2 — Automated Isolation 4-Gate Suite (`surf.G1`–`surf.G4`)
 * & Operation × Credential Kind × Foreign Resource ID 404 Matrix
 *
 * Implements `surface-final.md` §8.3 and Master Architecture v2 §11.9.
 */

import { getGate } from '@/packages/contract/ledgers';
import {
  AuthorizationGateway,
  type CredentialKind,
  type RiskClass,
  type Scope,
  type VerifiedPrincipal,
} from '@/lib/link/auth';
import { inspectSqlAst } from './ast-inspector';
import {
  BEHAVIOUR_TABLES,
  perTenantRoUsername,
  type ClickHouseIsolationSimulator,
} from './row-policy';

// =========================================================================
// 1. Standard Fuzzing Payloads & Matrix Dimensions (`surface-final.md` §8.3)
// =========================================================================

export const QUOTE_INJECTION_FUZZ_PAYLOADS: ReadonlyArray<string> = [
  `' OR '1'='1`,
  `' OR 1=1 --`,
  `'; DROP TABLE events; --`,
  `' UNION SELECT tenant_id FROM events --`,
  `tenant_b' SETTINGS additional_table_filters={'events':'1=1'}`,
  `tenant_b"; SET ROLE admin; --`,
  `tenant_a' /* bypass */ OR 'x'='x`,
  `tenant_a\0' OR TRUE`,
  `\${tenant_b}`,
];

export const MATRIX_CREDENTIAL_KINDS: ReadonlyArray<CredentialKind> = [
  'ugk_pub',
  'ugk_sec',
  'ugk_edge',
  'ugk_oem',
  'oem_exchanged',
  'oauth_mcp',
  'session_cookie',
  'federation_assertion',
];

export const MATRIX_FOREIGN_RESOURCE_TYPES: ReadonlyArray<string> = [
  'site',
  'job',
  'snapshot',
  'cursor',
  'evidence_ref',
  'approval',
  'envelope',
  'grant',
  'connection',
  'webhook',
  'child_tenant',
  'export_url',
];

export interface MatrixOperationSpec {
  readonly action: string;
  readonly riskClass: RiskClass;
  readonly requiredScope?: Scope;
}

export const DEFAULT_MATRIX_OPERATIONS: ReadonlyArray<MatrixOperationSpec> = [
  { action: 'analytics.query', riskClass: 'R0', requiredScope: 'analytics:read' },
  { action: 'fusion.read', riskClass: 'R0', requiredScope: 'fusion:read' },
  { action: 'decisions.draft', riskClass: 'R1', requiredScope: 'decisions:write' },
  { action: 'decisions.publish', riskClass: 'R2', requiredScope: 'decisions:publish' },
  { action: 'keys.issue', riskClass: 'R3', requiredScope: 'keys:issue' },
  { action: 'privacy.delete', riskClass: 'R4', requiredScope: 'privacy:delete' },
  { action: 'envelope.create', riskClass: 'R5', requiredScope: 'sites:manage' },
];

// =========================================================================
// 2. Gate Evaluation Results
// =========================================================================

export interface SingleGateCheckResult {
  readonly gateId: 'surf.G1' | 'surf.G2' | 'surf.G3' | 'surf.G4';
  readonly legacyAlias: 'sur.G1' | 'sur.G2' | 'sur.G3' | 'sur.G4';
  readonly ledgerRegistered: boolean;
  readonly passed: boolean;
  readonly failures: ReadonlyArray<string>;
}

export interface IsolationMatrixCellResult {
  readonly operation: string;
  readonly credentialKind: CredentialKind;
  readonly resourceType: string;
  readonly httpStatus: number;
  readonly allowed: boolean;
  readonly auditEntryId: string;
  readonly passed: boolean;
}

export interface IsolationMatrixReport {
  readonly totalCases: number;
  readonly passedCases: number;
  readonly leakedCases: number;
  readonly non404Cases: number;
  readonly missingAuditCases: number;
  readonly auditChainValid: boolean;
  readonly allPassed: boolean;
  readonly failures: ReadonlyArray<IsolationMatrixCellResult>;
}

export interface IsolationGatesSummary {
  readonly g1: SingleGateCheckResult;
  readonly g2: SingleGateCheckResult;
  readonly g3: SingleGateCheckResult;
  readonly g4: SingleGateCheckResult;
  readonly matrix: IsolationMatrixReport;
  readonly allPassed: boolean;
}

// =========================================================================
// 3. Individual Gate Evaluators
// =========================================================================

/**
 * Gate 1 (`surf.G1`): CRAWL ClickHouse user has zero grants on behaviour tables
 * and a negative query from the CRAWL identity reads 0 rows / is denied.
 */
export function evaluateGateG1(params: {
  readonly simulator: ClickHouseIsolationSimulator;
  readonly crawlUsername: string;
  readonly behaviourTables?: ReadonlyArray<string>;
}): SingleGateCheckResult {
  const failures: string[] = [];
  const tables = params.behaviourTables ?? BEHAVIOUR_TABLES;
  const user = params.simulator.getUser(params.crawlUsername);

  if (user) {
    for (const tbl of tables) {
      if (user.grantedSelectTables.has(tbl)) {
        failures.push(`CRAWL user "${params.crawlUsername}" still holds SELECT grant on behaviour table "${tbl}"`);
      }
      const res = params.simulator.executeSelect({
        username: params.crawlUsername,
        table: tbl,
      });
      if (res.ok && res.rows.length > 0) {
        failures.push(`CRAWL negative query on "${tbl}" leaked ${res.rows.length} rows`);
      }
    }
  }

  return {
    gateId: 'surf.G1',
    legacyAlias: 'sur.G1',
    ledgerRegistered: Boolean(getGate('surf.G1')),
    passed: failures.length === 0,
    failures,
  };
}

/**
 * Gate 2 (`surf.G2`): Every tenant table has BOTH a permissive AND a restrictive row policy
 * for each tenant RO user, `users_without_row_policies_can_read_rows = 0`, and a policyless
 * canary user reads 0 rows on every table.
 */
export function evaluateGateG2(params: {
  readonly simulator: ClickHouseIsolationSimulator;
  readonly tenantIds: ReadonlyArray<string>;
  readonly tables: ReadonlyArray<string>;
  readonly policylessCanaryUser: string;
}): SingleGateCheckResult {
  const failures: string[] = [];

  for (const tenantId of params.tenantIds) {
    const username = perTenantRoUsername(tenantId);
    const user = params.simulator.getUser(username);
    if (!user) {
      failures.push(`Missing per-tenant RO user "${username}" for tenant "${tenantId}"`);
      continue;
    }
    if (user.readonlyLevel !== 1) {
      failures.push(`User "${username}" does not enforce readonly = 1`);
    }
    if (user.usersWithoutRowPoliciesCanReadRows !== 0) {
      failures.push(`User "${username}" does not enforce users_without_row_policies_can_read_rows = 0`);
    }
    for (const tbl of params.tables) {
      const policies = params.simulator.getPoliciesForTableAndUser(tbl, username);
      const hasPermissive = policies.some((p) => p.mode === 'PERMISSIVE');
      const hasRestrictive = policies.some((p) => p.mode === 'RESTRICTIVE');
      if (!hasPermissive) {
        failures.push(`Table "${tbl}" missing PERMISSIVE row policy for "${username}"`);
      }
      if (!hasRestrictive) {
        failures.push(`Table "${tbl}" missing RESTRICTIVE row policy for "${username}"`);
      }
    }
  }

  for (const tbl of params.tables) {
    const neg = params.simulator.executeSelect({
      username: params.policylessCanaryUser,
      table: tbl,
    });
    if (neg.ok && neg.rows.length > 0) {
      failures.push(`Policyless canary user "${params.policylessCanaryUser}" read ${neg.rows.length} rows on "${tbl}"`);
    }
  }

  return {
    gateId: 'surf.G2',
    legacyAlias: 'sur.G2',
    ledgerRegistered: Boolean(getGate('surf.G2')),
    passed: failures.length === 0,
    failures,
  };
}

/**
 * Gate 3 (`surf.G3`): AST lint over sanctioned SQL templates + quote-payload fuzzing
 * confirming interpolated quote payloads are universally rejected by the AST inspector.
 */
export function evaluateGateG3(params: {
  readonly sanctionedSqlTemplates: ReadonlyArray<string>;
  readonly fuzzPayloads?: ReadonlyArray<string>;
}): SingleGateCheckResult {
  const failures: string[] = [];
  const payloads = params.fuzzPayloads ?? QUOTE_INJECTION_FUZZ_PAYLOADS;

  for (let i = 0; i < params.sanctionedSqlTemplates.length; i++) {
    const sql = params.sanctionedSqlTemplates[i];
    const res = inspectSqlAst(sql);
    if (!res.valid) {
      failures.push(
        `Sanctioned template #${i} failed AST lint: ${res.violations.map((v) => v.code).join(', ')}`
      );
    }
  }

  // Fuzz test: injecting any quote payload directly into SQL MUST be rejected by inspectSqlAst
  for (const payload of payloads) {
    const unsafeSql = `SELECT page_id, count() FROM rollup_page_hourly WHERE tenant_id = '${payload}' AND pv_hour >= {start:DateTime}`;
    const res = inspectSqlAst(unsafeSql);
    if (res.valid) {
      failures.push(`AST inspector FAILED to reject interpolated fuzz payload: ${payload}`);
    }
  }

  return {
    gateId: 'surf.G3',
    legacyAlias: 'sur.G3',
    ledgerRegistered: Boolean(getGate('surf.G3')),
    passed: failures.length === 0,
    failures,
  };
}

/**
 * Generates and runs the full `operation × credentialKind × foreignResourceType` matrix
 * through `AuthorizationGateway`, asserting 0 leaks, 100% HTTP 404, and 100% audit rows.
 */
export function runForeignTenantIsolationMatrix(params: {
  readonly gateway: AuthorizationGateway;
  readonly callerTenantId: string;
  readonly foreignTenantId: string;
  readonly callerOrgId?: string;
  readonly operations?: ReadonlyArray<MatrixOperationSpec>;
  readonly credentialKinds?: ReadonlyArray<CredentialKind>;
  readonly resourceTypes?: ReadonlyArray<string>;
}): IsolationMatrixReport {
  const operations = params.operations ?? DEFAULT_MATRIX_OPERATIONS;
  const credKinds = params.credentialKinds ?? MATRIX_CREDENTIAL_KINDS;
  const resourceTypes = params.resourceTypes ?? MATRIX_FOREIGN_RESOURCE_TYPES;
  const orgId = params.callerOrgId ?? 'org_canary_a';

  const failures: IsolationMatrixCellResult[] = [];
  let totalCases = 0;
  let passedCases = 0;
  let leakedCases = 0;
  let non404Cases = 0;
  let missingAuditCases = 0;

  for (const op of operations) {
    for (const credentialKind of credKinds) {
      const principal: VerifiedPrincipal = {
        credentialKind,
        credentialId: `cred_${credentialKind}_${params.callerTenantId}`,
        tenantId: params.callerTenantId,
        orgId,
        allowedSiteIds: credentialKind === 'ugk_pub' ? ['site_a_1'] : null,
        principalKind: credentialKind === 'session_cookie' ? 'human' : 'service',
        principalId: `principal_${credentialKind}`,
        role: 'owner',
        effectiveScopes: new Set<Scope>(op.requiredScope ? [op.requiredScope] : ['analytics:read']),
        senderConstrained: true,
        passkeyVerified: credentialKind === 'session_cookie',
      };

      for (const resourceType of resourceTypes) {
        totalCases += 1;
        const decision = params.gateway.authorize({
          principal,
          action: op.action,
          riskClass: op.riskClass,
          requiredScope: op.requiredScope,
          resource: {
            type: resourceType,
            id: `foreign_${resourceType}_${params.foreignTenantId}`,
            tenantId: params.foreignTenantId,
            siteId: `site_${params.foreignTenantId}`,
          },
          idempotencyKey: 'idem_matrix_probe_001',
        });

        const hasAudit = Boolean(decision.auditEntryId);
        const isLeak = decision.allowed;
        const is404 = decision.httpStatus === 404;

        if (isLeak) leakedCases += 1;
        if (!is404) non404Cases += 1;
        if (!hasAudit) missingAuditCases += 1;

        const passed = !isLeak && is404 && hasAudit;
        if (passed) {
          passedCases += 1;
        } else {
          failures.push({
            operation: op.action,
            credentialKind,
            resourceType,
            httpStatus: decision.httpStatus,
            allowed: decision.allowed,
            auditEntryId: decision.auditEntryId,
            passed: false,
          });
        }
      }
    }
  }

  const chainCheck = params.gateway.auditLog.verifyChain();
  const allPassed =
    leakedCases === 0 &&
    non404Cases === 0 &&
    missingAuditCases === 0 &&
    chainCheck.valid;

  return {
    totalCases,
    passedCases,
    leakedCases,
    non404Cases,
    missingAuditCases,
    auditChainValid: chainCheck.valid,
    allPassed,
    failures,
  };
}

/**
 * Gate 4 (`surf.G4`): CRAWL federation non-bypass role confirmed + full foreign-tenant 404 matrix passes.
 */
export function evaluateGateG4(params: {
  readonly federationUsesNonBypassRole: boolean;
  readonly operatorPathIsolatedFromFederation: boolean;
  readonly matrixReport: IsolationMatrixReport;
}): SingleGateCheckResult {
  const failures: string[] = [];
  if (!params.federationUsesNonBypassRole) {
    failures.push('CRAWL federation endpoints do not execute under a non-bypass DB role');
  }
  if (!params.operatorPathIsolatedFromFederation) {
    failures.push('Operator path is not isolated from federation endpoints');
  }
  if (!params.matrixReport.allPassed) {
    failures.push(
      `Isolation matrix failed: leaks=${params.matrixReport.leakedCases}, non404=${params.matrixReport.non404Cases}, missingAudit=${params.matrixReport.missingAuditCases}, chainValid=${params.matrixReport.auditChainValid}`
    );
  }

  return {
    gateId: 'surf.G4',
    legacyAlias: 'sur.G4',
    ledgerRegistered: Boolean(getGate('surf.G4')),
    passed: failures.length === 0,
    failures,
  };
}
