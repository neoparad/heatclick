/**
 * Static & runtime invariant checker for the single authoritative ContractSchema.
 *
 * Enforces TEL M7 (G15), STORE M2/M7/M8 (G-5, G-9, G-10), and §4.3/§4.7/§5.6/§5.7:
 * - Closed string slot enforcement (default-deny; zero strings in behaviour registers & timelines)
 * - Forbidden v2 field name guard (prevents reintroducing element_text, element_selector, etc.)
 * - Monotone merge proofs for max / maxMap / bitOr
 * - Personal-linkable column deletion reachability invariant (every PII column MUST be deletable <=14d)
 * - Tenant isolation DDL invariant (tenant_id/site_id prefix, zero MVs/projections on tenant tables)
 * - Consent mode invariants (5 modes, off/cookieless/stats_exempt restrictions)
 */

import {
  BEHAVIOUR_REGISTER_DOMAINS,
  CONSENT_MODES,
  MONOTONE_REQUIRED_MERGE_CLASSES,
  RETENTION_GRID_MONTHS,
  isPersonLinkablePii,
  type ContractSchema,
  type RetentionGridMonths,
} from './types';

const VALID_RETENTION_GRID_SET: ReadonlySet<number> = new Set<number>(RETENTION_GRID_MONTHS);

/**
 * Runtime check enforcing that a retention duration belongs strictly to
 * `RETENTION_GRID_MONTHS` (`[1, 2, 3, 6, 9, 12, 13, 18, 24, 30, 36]`).
 */
export function isValidRetentionGridMonths(n: unknown): n is RetentionGridMonths {
  return typeof n === 'number' && Number.isInteger(n) && VALID_RETENTION_GRID_SET.has(n);
}

/**
 * Runtime config validator that throws if `n` is not an allowed value in
 * `RETENTION_GRID_MONTHS` (e.g., rejects off-grid values like `4`).
 */
export function assertValidRetentionGridMonths(n: number): asserts n is RetentionGridMonths {
  if (!isValidRetentionGridMonths(n)) {
    throw new RangeError(
      `Invalid retention_months=${String(n)}: must be one of RETENTION_GRID_MONTHS (${RETENTION_GRID_MONTHS.join(', ')})`
    );
  }
}

export type SchemaViolationCode =
  | 'DUPLICATE_FIELD_TAG'
  | 'DUPLICATE_FIELD_NAME'
  | 'MISSING_MONOTONE_PROOF'
  | 'ARGMAX_SEQ_MISSING_PAIR_FLAG'
  | 'UNREGISTERED_STRING_SLOT'
  | 'STRING_FORBIDDEN_IN_BEHAVIOUR_REGISTER'
  | 'FORBIDDEN_V2_FIELD_NAME'
  | 'STRING_COLUMN_FORBIDDEN_IN_TIMELINE_TABLE'
  | 'PERSONAL_FIELD_NOT_MARKED_DELETABLE'
  | 'PERSONAL_COLUMN_UNREACHABLE_BY_DELETION'
  | 'PERSONAL_COLUMN_MISSING_LOOKUP_PATH'
  | 'PERSONAL_COLUMN_MISSING_FROM_DELETION_PLAN'
  | 'TENANT_ISOLATION_ORDER_BY_VIOLATION'
  | 'TENANT_ISOLATION_MISSING_TENANT_COLUMN'
  | 'FORBIDDEN_MATERIALIZED_VIEW_OR_PROJECTION'
  | 'CONSENT_MODE_INVARIANT_VIOLATION'
  | 'IDENTIFIER_ALLOWED_IN_COOKIELESS_OR_OFF'
  | 'MISSING_DISCLOSURE_LABEL'
  | 'DELETION_DEADLINE_VIOLATION'
  | 'FRAME_BUDGET_VIOLATION'
  | 'DUPLICATE_TABLE_NAME';

export interface SchemaViolation {
  readonly code: SchemaViolationCode;
  readonly path: string;
  readonly message: string;
}

export interface SchemaInvariantResult {
  readonly valid: boolean;
  readonly violations: readonly SchemaViolation[];
}

export class ContractInvariantError extends Error {
  public readonly violations: readonly SchemaViolation[];

  constructor(violations: readonly SchemaViolation[], context = 'ContractSchema invariant check failed') {
    const summary = violations.map((v) => `[${v.code}] ${v.path}: ${v.message}`).join('; ');
    super(`${context}: ${summary}`);
    this.name = 'ContractInvariantError';
    this.violations = violations;
  }
}

function isClickHouseStringType(chType: string | undefined): boolean {
  if (!chType) return false;
  return /\b(String|FixedString)\b/i.test(chType);
}

function isPostgresStringType(pgType: string | undefined): boolean {
  if (!pgType) return false;
  return /\b(TEXT|VARCHAR|CHAR|CHARACTER)\b/i.test(pgType);
}

export function validateContractSchema(schema: ContractSchema): SchemaInvariantResult {
  const violations: SchemaViolation[] = [];

  // 1. Frame budget checks (§4.1 / TEL M1)
  if (schema.frameLimits.hiddenMaxBytes > 16384 || schema.frameLimits.hiddenMaxBytes <= 0) {
    violations.push({
      code: 'FRAME_BUDGET_VIOLATION',
      path: 'frameLimits.hiddenMaxBytes',
      message: `hiddenMaxBytes must be in (0, 16384], got ${schema.frameLimits.hiddenMaxBytes}`,
    });
  }
  if (schema.frameLimits.visibleMaxBytes > 49152 || schema.frameLimits.visibleMaxBytes <= 0) {
    violations.push({
      code: 'FRAME_BUDGET_VIOLATION',
      path: 'frameLimits.visibleMaxBytes',
      message: `visibleMaxBytes must be in (0, 49152], got ${schema.frameLimits.visibleMaxBytes}`,
    });
  }

  // 2. Deletion deadline arithmetic (§5.7 / D-26)
  const d = schema.deletionDeadlines;
  if (
    d.maskedWithinHours > 24 ||
    d.purgedWithinDays > 5 ||
    d.purgedWithinDays + d.backupExpiryDays > d.certifiedWithinDays ||
    d.certifiedWithinDays > 14 ||
    d.undoWindowDays >= d.certifiedWithinDays
  ) {
    violations.push({
      code: 'DELETION_DEADLINE_VIOLATION',
      path: 'deletionDeadlines',
      message:
        'Deletion deadlines must satisfy masked<=24h, purged<=5d, purged+backup<=certified<=14d, undo<certified',
    });
  }

  // 3. Consent modes completeness & strict bounds (§4.5 / D-13)
  const modeMap = new Map(schema.consentModes.map((m) => [m.mode, m]));
  for (const requiredMode of CONSENT_MODES) {
    if (!modeMap.has(requiredMode)) {
      violations.push({
        code: 'CONSENT_MODE_INVARIANT_VIOLATION',
        path: `consentModes.${requiredMode}`,
        message: `Missing mandatory consent mode: ${requiredMode}`,
      });
    }
  }
  const offSpec = modeMap.get('off');
  if (offSpec && (offSpec.allowsBrowserStorage || offSpec.allowsTelemetryFrames)) {
    violations.push({
      code: 'CONSENT_MODE_INVARIANT_VIOLATION',
      path: 'consentModes.off',
      message: 'Consent mode "off" must disallow browser storage and telemetry frames',
    });
  }
  const cookielessSpec = modeMap.get('cookieless');
  if (cookielessSpec && cookielessSpec.allowsBrowserStorage) {
    violations.push({
      code: 'CONSENT_MODE_INVARIANT_VIOLATION',
      path: 'consentModes.cookieless',
      message: 'Consent mode "cookieless" must disallow browser storage',
    });
  }
  const statsExemptSpec = modeMap.get('stats_exempt');
  if (statsExemptSpec) {
    for (const forbiddenPurpose of ['personalise', 'pool', 'ads', 'screen_replay', 'member_link'] as const) {
      if (!statsExemptSpec.disallowedPurposes.includes(forbiddenPurpose)) {
        violations.push({
          code: 'CONSENT_MODE_INVARIANT_VIOLATION',
          path: `consentModes.stats_exempt.disallowedPurposes`,
          message: `stats_exempt must disallow purpose "${forbiddenPurpose}"`,
        });
      }
    }
  }

  // 4. Field-level checks
  const allowedSlots = new Set(schema.stringSlots.map((s) => s.id));
  const forbiddenNames = new Set(schema.forbiddenBehaviourFieldNames.map((n) => n.toLowerCase()));
  const seenTagPerDomain = new Set<string>();
  const seenNamePerDomain = new Set<string>();

  for (const field of schema.fields) {
    const fieldPath = `fields.${field.domain}.${field.name}`;

    // Unique add-only tag & name per domain
    const tagKey = `${field.domain}:${field.tag}`;
    if (seenTagPerDomain.has(tagKey)) {
      violations.push({
        code: 'DUPLICATE_FIELD_TAG',
        path: fieldPath,
        message: `Duplicate wire tag ${field.tag} in domain ${field.domain}`,
      });
    }
    seenTagPerDomain.add(tagKey);

    const nameKey = `${field.domain}:${field.name}`;
    if (seenNamePerDomain.has(nameKey)) {
      violations.push({
        code: 'DUPLICATE_FIELD_NAME',
        path: fieldPath,
        message: `Duplicate field name ${field.name} in domain ${field.domain}`,
      });
    }
    seenNamePerDomain.add(nameKey);

    // Forbidden v2 string/DOM-mutation field names (TEL A7)
    if (forbiddenNames.has(field.name.toLowerCase())) {
      violations.push({
        code: 'FORBIDDEN_V2_FIELD_NAME',
        path: fieldPath,
        message: `Field name "${field.name}" is explicitly forbidden by contract (TEL A7 / G7)`,
      });
    }

    // Closed string slot rule (TEL M7 / A3 / G7)
    if (field.type === 'string_closed') {
      if (BEHAVIOUR_REGISTER_DOMAINS.has(field.domain)) {
        violations.push({
          code: 'STRING_FORBIDDEN_IN_BEHAVIOUR_REGISTER',
          path: fieldPath,
          message: `String fields are strictly forbidden in behaviour register domain "${field.domain}"`,
        });
      }
      if (!field.stringSlot || !allowedSlots.has(field.stringSlot)) {
        violations.push({
          code: 'UNREGISTERED_STRING_SLOT',
          path: fieldPath,
          message: `String field "${field.name}" must reference a registered slot in schema.stringSlots (got "${String(field.stringSlot)}")`,
        });
      }
    }

    // Monotone proof requirement for max/maxMap/bitOr (TEL M7)
    if (MONOTONE_REQUIRED_MERGE_CLASSES.has(field.merge)) {
      if (!field.monotoneProof || field.monotoneProof.trim().length < 10) {
        violations.push({
          code: 'MISSING_MONOTONE_PROOF',
          path: fieldPath,
          message: `Merge class "${field.merge}" requires a non-empty monotoneProof`,
        });
      }
    }

    // (value, seq) pairing for argMax_seq
    if (field.merge === 'argMax_seq' && !field.carriesSeqPair) {
      violations.push({
        code: 'ARGMAX_SEQ_MISSING_PAIR_FLAG',
        path: fieldPath,
        message: `Merge class "argMax_seq" requires carriesSeqPair: true`,
      });
    }

    // Personal-linkable PII field must be deletable
    if (isPersonLinkablePii(field.piiClass) && !field.deletable) {
      violations.push({
        code: 'PERSONAL_FIELD_NOT_MARKED_DELETABLE',
        path: fieldPath,
        message: `Person-linkable field (piiClass="${field.piiClass}") must have deletable: true`,
      });
    }

    // Visitor/session identifiers cannot be allowed in off or cookieless
    if (
      (field.piiClass === 'visitor_id' || field.piiClass === 'session_id') &&
      (field.consentMin === 'off' || field.consentMin === 'cookieless')
    ) {
      violations.push({
        code: 'IDENTIFIER_ALLOWED_IN_COOKIELESS_OR_OFF',
        path: fieldPath,
        message: `Identifier field "${field.name}" (${field.piiClass}) cannot have consentMin="${field.consentMin}"`,
      });
    }

    // Disclosure label completeness for browser-transmitted fields (JP external transmission rule)
    if (field.disclosure.transmittedFromBrowser) {
      if (!field.disclosure.jaLabel.trim() || !field.disclosure.purposeJa.trim()) {
        violations.push({
          code: 'MISSING_DISCLOSURE_LABEL',
          path: fieldPath,
          message: `Browser-transmitted field "${field.name}" must provide jaLabel and purposeJa for JP external transmission disclosure`,
        });
      }
    }
  }

  // 5. Table-level checks (STORE M2/M7/M8, D-11R, D-26)
  const seenTables = new Set<string>();
  for (const table of schema.tables) {
    const tablePath = `tables.${table.name}`;
    if (seenTables.has(table.name)) {
      violations.push({
        code: 'DUPLICATE_TABLE_NAME',
        path: tablePath,
        message: `Duplicate table definition "${table.name}"`,
      });
    }
    seenTables.add(table.name);

    const colNames = new Set(table.columns.map((c) => c.name));

    // Tenant isolation checks
    if (table.tenantScoped) {
      if (!colNames.has('tenant_id')) {
        violations.push({
          code: 'TENANT_ISOLATION_MISSING_TENANT_COLUMN',
          path: tablePath,
          message: `Tenant-scoped table "${table.name}" is missing tenant_id column`,
        });
      }
      if (table.store === 'clickhouse') {
        if (table.orderBy[0] !== 'tenant_id') {
          violations.push({
            code: 'TENANT_ISOLATION_ORDER_BY_VIOLATION',
            path: `${tablePath}.orderBy`,
            message: `ClickHouse tenant-scoped table "${table.name}" must start ORDER BY with tenant_id`,
          });
        }
        if (table.siteScoped && table.orderBy[1] !== 'site_id') {
          violations.push({
            code: 'TENANT_ISOLATION_ORDER_BY_VIOLATION',
            path: `${tablePath}.orderBy`,
            message: `ClickHouse site-scoped table "${table.name}" must have ORDER BY (tenant_id, site_id, ...)`,
          });
        }
        if (table.hasMaterializedView || table.hasProjection) {
          violations.push({
            code: 'FORBIDDEN_MATERIALIZED_VIEW_OR_PROJECTION',
            path: tablePath,
            message: `ClickHouse tenant table "${table.name}" must not declare MATERIALIZED VIEW or PROJECTION (STORE A2)`,
          });
        }
      }
    }

    // Column-level checks
    for (const col of table.columns) {
      const colPath = `${tablePath}.columns.${col.name}`;

      if (forbiddenNames.has(col.name.toLowerCase())) {
        violations.push({
          code: 'FORBIDDEN_V2_FIELD_NAME',
          path: colPath,
          message: `Column name "${col.name}" is forbidden by contract (TEL A7)`,
        });
      }

      // Timeline tables MUST contain ZERO non-boundary string columns (D-11R / tel.G14)
      if (table.isTimelineTable && col.name !== 'tenant_id' && col.name !== 'site_id') {
        if (isClickHouseStringType(col.clickhouseType) || isPostgresStringType(col.postgresType)) {
          violations.push({
            code: 'STRING_COLUMN_FORBIDDEN_IN_TIMELINE_TABLE',
            path: colPath,
            message: `Timeline table "${table.name}" must be integer/UUID-only; string column "${col.name}" (${col.clickhouseType ?? col.postgresType}) is strictly forbidden (D-11R / tel.G14)`,
          });
        }
      }

      // Person-linkable column MUST be reachable by 14-day deletion plan (§5.7 / STORE M8)
      if (isPersonLinkablePii(col.piiClass)) {
        const isUnreachableStrategy =
          table.deletionStrategy === 'not_applicable_aggregate' ||
          table.deletionStrategy === 'not_applicable_non_personal';

        if (!col.deletable || isUnreachableStrategy) {
          violations.push({
            code: 'PERSONAL_COLUMN_UNREACHABLE_BY_DELETION',
            path: colPath,
            message: `Person-linkable column "${table.name}.${col.name}" (piiClass="${col.piiClass}") is not covered by a valid deletion strategy (deletable=${col.deletable}, strategy="${table.deletionStrategy}")`,
          });
        }
        if (!table.deletionLookupPath || table.deletionLookupPath.trim().length === 0) {
          violations.push({
            code: 'PERSONAL_COLUMN_MISSING_LOOKUP_PATH',
            path: colPath,
            message: `Table "${table.name}" holds person-linkable column "${col.name}" but lacks deletionLookupPath`,
          });
        }
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

export function assertValidContractSchema(schema: ContractSchema): void {
  const result = validateContractSchema(schema);
  if (!result.valid) {
    throw new ContractInvariantError(result.violations);
  }
}
