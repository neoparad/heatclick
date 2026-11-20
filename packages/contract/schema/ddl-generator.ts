/**
 * Generator #3: Deterministic ClickHouse & Postgres DDL Generator
 *
 * Always validates ContractSchema invariants AND verifies 100% deletion-plan
 * coverage for all person-linkable columns before emitting a single line of DDL.
 *
 * Enforces:
 * - ClickHouse: ORDER BY (tenant_id, site_id, ...), PARTITION BY, ttl_only_drop_parts=1,
 *   non_replicated_deduplication_window=10000, permissive + restrictive Row Policies,
 *   ZERO materialized views or projections on tenant tables (STORE M2, M7, A2).
 * - Postgres: PRIMARY KEY, indexes, ENABLE/FORCE ROW LEVEL SECURITY + tenant RLS policies (SUR §5.2).
 */

import {
  assertDeletionPlanCoverage,
  generateDeletionPlan,
} from './deletion-plan-generator';
import { sha256Hex } from './hash';
import { assertValidContractSchema } from './invariants';
import type { ContractSchema, TableSpec } from './types';

function escapeSqlComment(text: string): string {
  return text.replace(/'/g, "''");
}

function renderClickHouseTable(table: TableSpec): string {
  const lines: string[] = [];
  lines.push(`-- Table: ${table.name} (${table.description})`);
  lines.push(
    `-- Retention: ${table.retentionPolicy} | Deletion: ${table.deletionStrategy}`
  );
  lines.push(`CREATE TABLE IF NOT EXISTS ${table.name} (`);

  const colLines = table.columns.map((col) => {
    const chType = col.clickhouseType ?? 'String';
    const metaTag = `pii=${col.piiClass};deletable=${col.deletable}`;
    return `  ${col.name} ${chType} COMMENT '${escapeSqlComment(`${col.comment} [${metaTag}]`)}'`;
  });
  lines.push(colLines.join(',\n'));
  lines.push(')');

  if (table.engine === 'ReplacingMergeTree' && table.versionColumn) {
    lines.push(`ENGINE = ReplacingMergeTree(${table.versionColumn})`);
  } else {
    lines.push(`ENGINE = ${table.engine}()`);
  }

  if (table.partitionBy) {
    lines.push(`PARTITION BY ${table.partitionBy}`);
  }
  lines.push(`ORDER BY (${table.orderBy.join(', ')})`);

  if (table.ttlExpr) {
    lines.push(`TTL ${table.ttlExpr}`);
  }

  const settings: string[] = [
    `index_granularity = ${table.indexGranularity ?? 8192}`,
    'non_replicated_deduplication_window = 10000',
  ];
  if (table.ttlExpr) {
    settings.push('ttl_only_drop_parts = 1');
  }
  lines.push(`SETTINGS ${settings.join(', ')};`);

  if (table.tenantScoped) {
    lines.push('');
    lines.push(`-- Dual-layer ClickHouse tenant isolation row policies for ${table.name} (§5.6 / STORE M7)`);
    lines.push(
      `CREATE ROW POLICY IF NOT EXISTS rp_${table.name}_tenant_permissive ON ${table.name} AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;`
    );
    lines.push(
      `CREATE ROW POLICY IF NOT EXISTS rp_${table.name}_tenant_restrictive ON ${table.name} AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;`
    );
  }

  return lines.join('\n');
}

function renderPostgresTable(table: TableSpec): string {
  const lines: string[] = [];
  lines.push(`-- Table: ${table.name} (${table.description})`);
  lines.push(
    `-- Retention: ${table.retentionPolicy} | Deletion: ${table.deletionStrategy}`
  );
  lines.push(`CREATE TABLE IF NOT EXISTS ${table.name} (`);

  const bodyLines: string[] = table.columns.map((col) => {
    const pgType = col.postgresType ?? 'TEXT';
    return `  ${col.name} ${pgType}`;
  });
  if (table.primaryKey && table.primaryKey.length > 0) {
    bodyLines.push(`  PRIMARY KEY (${table.primaryKey.join(', ')})`);
  }
  lines.push(bodyLines.join(',\n'));
  lines.push(');');

  for (const col of table.columns) {
    const metaTag = `pii=${col.piiClass};deletable=${col.deletable}`;
    lines.push(
      `COMMENT ON COLUMN ${table.name}.${col.name} IS '${escapeSqlComment(`${col.comment} [${metaTag}]`)}';`
    );
  }

  if (table.indexes) {
    for (const idx of table.indexes) {
      const idxCols = table.orderBy.slice(0, 2).join(', ');
      lines.push(`CREATE INDEX IF NOT EXISTS ${idx} ON ${table.name} (${idxCols});`);
    }
  }

  if (table.tenantScoped) {
    lines.push(`ALTER TABLE ${table.name} ENABLE ROW LEVEL SECURITY;`);
    lines.push(`ALTER TABLE ${table.name} FORCE ROW LEVEL SECURITY;`);
    lines.push(`DROP POLICY IF EXISTS rls_${table.name}_tenant ON ${table.name};`);
    lines.push(
      `CREATE POLICY rls_${table.name}_tenant ON ${table.name} AS RESTRICTIVE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);`
    );
  }

  return lines.join('\n');
}

export interface GeneratedDdlArtifact {
  readonly dialect: 'clickhouse' | 'postgres';
  readonly schemaVersion: string;
  readonly tableCount: number;
  readonly sql: string;
  readonly sha256: string;
}

export function generateClickHouseDdl(schema: ContractSchema): GeneratedDdlArtifact {
  assertValidContractSchema(schema);
  const deletionPlan = generateDeletionPlan(schema);
  assertDeletionPlanCoverage(schema, deletionPlan);

  const chTables = schema.tables
    .filter((t) => t.store === 'clickhouse')
    .sort((a, b) => a.name.localeCompare(b.name));

  const header = [
    '-- ============================================================================',
    `-- UGOKI LINK v2 — Generated ClickHouse DDL (schema v${schema.meta.schemaVersion})`,
    `-- Deletion Plan Hash: ${deletionPlan.contentSha256}`,
    '-- DO NOT EDIT MANUALLY. Regenerate from packages/contract/schema/canonical.ts',
    '-- ============================================================================',
    '',
  ].join('\n');

  const body = chTables.map(renderClickHouseTable).join('\n\n');
  const sql = `${header}${body}\n`;

  return {
    dialect: 'clickhouse',
    schemaVersion: schema.meta.schemaVersion,
    tableCount: chTables.length,
    sql,
    sha256: sha256Hex(sql),
  };
}

export function generatePostgresDdl(schema: ContractSchema): GeneratedDdlArtifact {
  assertValidContractSchema(schema);
  const deletionPlan = generateDeletionPlan(schema);
  assertDeletionPlanCoverage(schema, deletionPlan);

  const pgTables = schema.tables
    .filter((t) => t.store === 'postgres')
    .sort((a, b) => a.name.localeCompare(b.name));

  const header = [
    '-- ============================================================================',
    `-- UGOKI LINK v2 — Generated Postgres Control-Plane DDL (schema v${schema.meta.schemaVersion})`,
    `-- Deletion Plan Hash: ${deletionPlan.contentSha256}`,
    '-- DO NOT EDIT MANUALLY. Regenerate from packages/contract/schema/canonical.ts',
    '-- ============================================================================',
    '',
  ].join('\n');

  const body = pgTables.map(renderPostgresTable).join('\n\n');
  const sql = `${header}${body}\n`;

  return {
    dialect: 'postgres',
    schemaVersion: schema.meta.schemaVersion,
    tableCount: pgTables.length,
    sql,
    sha256: sha256Hex(sql),
  };
}
