/**
 * Generator #6: 14-Day Deletion Plan Generator & Coverage Verifier
 *
 * Pure deterministic generator producing the complete table, column, and
 * external-store erasure plan from the single authoritative ContractSchema
 * (§5.7 / STORE M8, A8 / D-26 / SUR §5.9).
 */

import { canonicalJsonStringify, sha256Hex } from './hash';
import {
  assertValidContractSchema,
  ContractInvariantError,
  type SchemaViolation,
} from './invariants';
import {
  isPersonLinkablePii,
  type ContractSchema,
  type DeletionDeadlineSpec,
  type DeletionStrategy,
  type ExternalStoreDeletionSpec,
  type PiiClass,
  type RetentionPolicy,
} from './types';

export interface DeletionTableEntry {
  readonly tableName: string;
  readonly store: 'clickhouse' | 'postgres';
  readonly executionOrder: number;
  readonly deletionStrategy: DeletionStrategy;
  readonly lookupPath: string;
  readonly retentionPolicy: RetentionPolicy;
  readonly columns: readonly {
    readonly name: string;
    readonly piiClass: PiiClass;
  }[];
  readonly requiresRollupRebuild: boolean;
  readonly requiresCachePurge: boolean;
}

export interface DeletionPlan {
  readonly schemaVersion: string;
  readonly deadlines: DeletionDeadlineSpec;
  readonly acceptedSubjects: readonly ('visitor_id' | 'member_hash' | 'external_id' | 'ga_client_id')[];
  readonly keyRotationRule: string;
  readonly tableEntries: readonly DeletionTableEntry[];
  readonly externalStoreEntries: readonly ExternalStoreDeletionSpec[];
  readonly unreachableClasses: readonly {
    readonly code: string;
    readonly labelJa: string;
    readonly reasonJa: string;
  }[];
  readonly contentSha256: string;
}

const STRATEGY_EXECUTION_ORDER: Readonly<Record<DeletionStrategy, number>> = {
  by_subject_row: 10,
  by_visitor_key: 20,
  by_session_key: 30,
  by_pv_key: 40,
  by_unit_key: 50,
  by_req_uid: 60,
  quarantine_7d_delete: 70,
  not_applicable_aggregate: 999,
  not_applicable_non_personal: 999,
};

export function generateDeletionPlan(schema: ContractSchema): DeletionPlan {
  assertValidContractSchema(schema);

  const tableEntries: DeletionTableEntry[] = [];

  for (const table of schema.tables) {
    const deletableCols = table.columns
      .filter((col) => col.deletable || isPersonLinkablePii(col.piiClass))
      .map((col) => ({ name: col.name, piiClass: col.piiClass }))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (deletableCols.length === 0) {
      continue;
    }

    tableEntries.push({
      tableName: table.name,
      store: table.store,
      executionOrder: STRATEGY_EXECUTION_ORDER[table.deletionStrategy],
      deletionStrategy: table.deletionStrategy,
      lookupPath: table.deletionLookupPath ?? '',
      retentionPolicy: table.retentionPolicy,
      columns: deletableCols,
      requiresRollupRebuild: table.requiresRollupRebuild,
      requiresCachePurge: table.requiresCachePurge,
    });
  }

  tableEntries.sort((a, b) => {
    if (a.executionOrder !== b.executionOrder) {
      return a.executionOrder - b.executionOrder;
    }
    return a.tableName.localeCompare(b.tableName);
  });

  const externalStoreEntries = [...schema.externalStores].sort(
    (a, b) => a.priorityOrder - b.priorityOrder || a.id.localeCompare(b.id)
  );

  const planBody = {
    schemaVersion: schema.meta.schemaVersion,
    deadlines: schema.deletionDeadlines,
    acceptedSubjects: ['visitor_id', 'member_hash', 'external_id', 'ga_client_id'] as const,
    keyRotationRule:
      'Every tenant HMAC pseudonym carries key_version; erasure looks up all active key versions with >0 rows, and a key version is destroyed only after 0 rows remain.',
    tableEntries,
    externalStoreEntries,
    unreachableClasses: schema.unreachableDeletionClasses,
  };

  const contentSha256 = sha256Hex(canonicalJsonStringify(planBody));

  const plan: DeletionPlan = {
    ...planBody,
    contentSha256,
  };

  // Self-verify coverage invariant before returning
  assertDeletionPlanCoverage(schema, plan);

  return plan;
}

export interface DeletionCoverageResult {
  readonly valid: boolean;
  readonly violations: readonly SchemaViolation[];
}

/**
 * Verifies that EVERY person-linkable column across ALL tables in `schema`
 * is explicitly listed in `plan.tableEntries` with a valid deletion lookup path.
 */
export function verifyDeletionPlanCoverage(
  schema: ContractSchema,
  plan: DeletionPlan
): DeletionCoverageResult {
  const violations: SchemaViolation[] = [];
  const planByTable = new Map(plan.tableEntries.map((entry) => [entry.tableName, entry]));

  for (const table of schema.tables) {
    for (const col of table.columns) {
      if (!isPersonLinkablePii(col.piiClass)) {
        continue;
      }
      const entry = planByTable.get(table.name);
      if (!entry) {
        violations.push({
          code: 'PERSONAL_COLUMN_MISSING_FROM_DELETION_PLAN',
          path: `deletionPlan.${table.name}.${col.name}`,
          message: `Table "${table.name}" contains person-linkable column "${col.name}" (${col.piiClass}) but is missing from the deletion plan`,
        });
        continue;
      }
      const coveredCol = entry.columns.find((c) => c.name === col.name);
      if (!coveredCol) {
        violations.push({
          code: 'PERSONAL_COLUMN_MISSING_FROM_DELETION_PLAN',
          path: `deletionPlan.${table.name}.${col.name}`,
          message: `Person-linkable column "${table.name}.${col.name}" (${col.piiClass}) is omitted from deletion plan columns`,
        });
      }
      if (!entry.lookupPath || entry.lookupPath.trim().length === 0) {
        violations.push({
          code: 'PERSONAL_COLUMN_MISSING_LOOKUP_PATH',
          path: `deletionPlan.${table.name}`,
          message: `Deletion plan entry for "${table.name}" is missing lookupPath`,
        });
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

export function assertDeletionPlanCoverage(schema: ContractSchema, plan: DeletionPlan): void {
  const result = verifyDeletionPlanCoverage(schema, plan);
  if (!result.valid) {
    throw new ContractInvariantError(result.violations, 'Deletion plan coverage invariant failed');
  }
}
