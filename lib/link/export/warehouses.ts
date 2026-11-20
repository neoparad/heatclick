/**
 * UGOKI LINK v2 — 5 Data Warehouses & Open Parquet Contract Exporter (§5.12 / §11.11 #4)
 *
 * Supports:
 * - 5 warehouse connectors: `bigquery`, `snowflake`, `redshift`, `databricks`, `clickhouse`
 *   plus open columnar `object_parquet` contract derived from `CANONICAL_SCHEMA`
 * - Mandatory per-row compliance & provenance envelope (schema version, consent mode,
 *   allowed purposes, revocation epoch, retention expiry, trust, missing flags, lane)
 * - Strict tenant boundary (0 foreign rows) & zero cross-tenant pooled rows
 * - Recipient-aware suppression (§5.12 / §11.3 / §12.3):
 *   - `customer_own_site` (Tier 2): NO `< 10` suppression (customer is data controller)
 *   - `external_party` (CRAWL / OEM / third party): `< 10` suppression + non-overlapping
 *     calendar window guard + complementary differencing suppression
 * - Batch latency SLA monitoring (target p95 <= 15 min) linked to loss ledger
 */

import { getConstant } from '../../../packages/contract/ledgers';
import {
  CANONICAL_SCHEMA,
  canonicalJsonStringify,
  sha256Hex,
  type ConsentMode,
  type ConsentPurpose,
  type TrustLevel,
} from '../../../packages/contract/schema';
import type { DataRegion } from '../../../workers/link-wal';
import type { TelemetryLane } from '../../../workers/link-live';

export const WAREHOUSE_TARGETS = [
  'bigquery',
  'snowflake',
  'redshift',
  'databricks',
  'clickhouse',
  'object_parquet',
] as const;
export type WarehouseTargetKind = (typeof WAREHOUSE_TARGETS)[number];

export type ExportRecipientClass = 'customer_own_site' | 'external_party';

export const WAREHOUSE_BATCH_P95_SLA_MS = 15 * 60 * 1000; // 15 minutes (§11.11 #4)

export interface ExportableAnalyticsRow {
  readonly rowId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly windowStartIso: string;
  readonly windowEndIso: string;
  readonly collectionGen: 'v3' | 'legacy';
  readonly schemaVersion: string;
  readonly consentMode: ConsentMode;
  readonly purposesAllowed: readonly ConsentPurpose[];
  readonly revocationEpoch: number;
  readonly retentionExpiresAtIso: string;
  readonly trustLevel: TrustLevel;
  readonly missingFlags: readonly string[];
  readonly lane: TelemetryLane;
  readonly evidenceLevel: 'planned' | 'inferred' | 'observed' | 'proven';
  readonly isPooledResult?: boolean;
  /** Subject/visitor cell count when exporting aggregated rows (used for external k=10 suppression). */
  readonly cellUnitCount?: number;
  readonly metrics: Readonly<Record<string, number | null>>;
}

export interface WarehouseExportConfig {
  readonly exportId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly target: WarehouseTargetKind;
  readonly recipientClass: ExportRecipientClass;
  readonly storageRegion: DataRegion;
  readonly destinationRegion: DataRegion;
  /** Required when destinationRegion !== storageRegion (§11.11 #13). */
  readonly crossRegionTransferGrantId?: string | null;
  readonly deletionEpoch: number;
  readonly externalMinCellK?: number;
}

export interface ParquetColumnSpec {
  readonly name: string;
  readonly parquetType: 'BYTE_ARRAY' | 'INT32' | 'INT64' | 'DOUBLE' | 'BOOLEAN' | 'LIST_UTF8';
  readonly nullable: boolean;
  readonly requiredProvenance: boolean;
}

export interface OpenParquetExportArtifact {
  readonly format: 'ugokilink_parquet_contract_v1';
  readonly schemaVersion: string;
  readonly target: WarehouseTargetKind;
  readonly exportId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly deletionEpoch: number;
  readonly columns: readonly ParquetColumnSpec[];
  readonly rowCount: number;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly manifestSha256: string;
}

export interface WarehouseBatchLossNotice {
  readonly exportId: string;
  readonly target: WarehouseTargetKind;
  readonly reason: 'sla_15m_breached' | 'foreign_tenant_rejected' | 'pooled_row_excluded' | 'write_failed';
  readonly count: number;
  readonly latencyMs: number;
  readonly recordedAtMs: number;
}

export interface WarehouseExportResult {
  readonly exportId: string;
  readonly target: WarehouseTargetKind;
  readonly recipientClass: ExportRecipientClass;
  readonly status: 'ok' | 'rejected_window_overlap' | 'rejected_cross_region_grant' | 'failed';
  readonly exportedRowCount: number;
  readonly foreignTenantRowsBlocked: number;
  readonly pooledRowsExcluded: number;
  readonly suppressedCellsCount: number;
  readonly complementarySuppressedCount: number;
  readonly batchLatencyMs: number;
  readonly within15mSla: boolean;
  readonly artifact: OpenParquetExportArtifact | null;
  readonly lossNotices: readonly WarehouseBatchLossNotice[];
  readonly reason?: string;
}

export interface WarehouseSinkPort {
  writeBatch(
    config: WarehouseExportConfig,
    artifact: OpenParquetExportArtifact
  ): Promise<{ readonly writtenAtMs: number; readonly receiptId: string }>;
}

/**
 * Generates the mandatory open tabular/Parquet schema contract from `CANONICAL_SCHEMA`
 * guaranteeing every exported row carries provenance, consent, revocation, retention,
 * trust, missing flags, and lane (§5.12).
 */
export function buildOpenParquetSchemaColumns(): readonly ParquetColumnSpec[] {
  return [
    { name: 'row_id', parquetType: 'BYTE_ARRAY', nullable: false, requiredProvenance: true },
    { name: 'tenant_id', parquetType: 'BYTE_ARRAY', nullable: false, requiredProvenance: true },
    { name: 'site_id', parquetType: 'BYTE_ARRAY', nullable: false, requiredProvenance: true },
    { name: 'window_start', parquetType: 'BYTE_ARRAY', nullable: false, requiredProvenance: true },
    { name: 'window_end', parquetType: 'BYTE_ARRAY', nullable: false, requiredProvenance: true },
    { name: 'schema_version', parquetType: 'BYTE_ARRAY', nullable: false, requiredProvenance: true },
    { name: 'collection_gen', parquetType: 'BYTE_ARRAY', nullable: false, requiredProvenance: true },
    { name: 'consent_mode', parquetType: 'BYTE_ARRAY', nullable: false, requiredProvenance: true },
    { name: 'purposes_allowed', parquetType: 'LIST_UTF8', nullable: false, requiredProvenance: true },
    { name: 'revocation_epoch', parquetType: 'INT64', nullable: false, requiredProvenance: true },
    { name: 'retention_expires_at', parquetType: 'BYTE_ARRAY', nullable: false, requiredProvenance: true },
    { name: 'trust_level', parquetType: 'BYTE_ARRAY', nullable: false, requiredProvenance: true },
    { name: 'missing_flags', parquetType: 'LIST_UTF8', nullable: false, requiredProvenance: true },
    { name: 'lane', parquetType: 'BYTE_ARRAY', nullable: false, requiredProvenance: true },
    { name: 'evidence_level', parquetType: 'BYTE_ARRAY', nullable: false, requiredProvenance: true },
    { name: 'deletion_epoch', parquetType: 'INT64', nullable: false, requiredProvenance: true },
    { name: 'suppressed', parquetType: 'BOOLEAN', nullable: false, requiredProvenance: true },
    { name: 'metrics_json', parquetType: 'BYTE_ARRAY', nullable: false, requiredProvenance: false },
  ];
}

function getDefaultExternalMinCellK(): number {
  const entry = getConstant('surf.export_min_cell_k');
  return typeof entry?.value === 'number' ? entry.value : 10;
}

/**
 * Verifies calendar-aligned non-overlapping windows for external-party exports
 * (§11.3 / §12.3: prevents differencing attacks across overlapping sliding windows).
 */
export function hasOverlappingExternalWindow(
  previousWindows: ReadonlyArray<{ readonly startMs: number; readonly endMs: number }>,
  candidate: { readonly startMs: number; readonly endMs: number }
): boolean {
  if (candidate.endMs <= candidate.startMs) return true;
  // Require UTC whole-hour or whole-day calendar alignment
  const hourMs = 3_600_000;
  if (candidate.startMs % hourMs !== 0 || candidate.endMs % hourMs !== 0) {
    return true;
  }
  for (const prev of previousWindows) {
    // Same exact window re-export is idempotent; partial overlap is forbidden!
    const exactSame =
      prev.startMs === candidate.startMs && prev.endMs === candidate.endMs;
    if (exactSame) continue;
    const overlaps =
      candidate.startMs < prev.endMs && candidate.endMs > prev.startMs;
    if (overlaps) {
      return true;
    }
  }
  return false;
}

export class WarehouseBatchExporter {
  private readonly exportedExternalWindows = new Map<
    string,
    Array<{ readonly startMs: number; readonly endMs: number }>
  >();
  private readonly latenciesMs: number[] = [];
  private readonly lossNotices: WarehouseBatchLossNotice[] = [];

  public constructor(
    private readonly sink?: WarehouseSinkPort,
    private readonly onLossNotice?: (notice: WarehouseBatchLossNotice) => void
  ) {}

  private emitLoss(notice: WarehouseBatchLossNotice): void {
    this.lossNotices.push(notice);
    this.onLossNotice?.(notice);
  }

  public async exportBatch(args: {
    readonly config: WarehouseExportConfig;
    readonly rows: readonly ExportableAnalyticsRow[];
    readonly sourceEventCutoffMs: number;
    readonly nowMs?: number;
  }): Promise<WarehouseExportResult> {
    const nowMs = args.nowMs ?? Date.now();
    const { config } = args;

    // Decision 29 / §11.11 #13: cross-region customer export requires explicit grant
    if (
      config.destinationRegion !== config.storageRegion &&
      (!config.crossRegionTransferGrantId ||
        config.crossRegionTransferGrantId.trim().length === 0)
    ) {
      return {
        exportId: config.exportId,
        target: config.target,
        recipientClass: config.recipientClass,
        status: 'rejected_cross_region_grant',
        exportedRowCount: 0,
        foreignTenantRowsBlocked: 0,
        pooledRowsExcluded: 0,
        suppressedCellsCount: 0,
        complementarySuppressedCount: 0,
        batchLatencyMs: 0,
        within15mSla: true,
        artifact: null,
        lossNotices: [],
        reason: `Cross-region export (${config.storageRegion} -> ${config.destinationRegion}) requires explicit crossRegionTransferGrantId`,
      };
    }

    const batchNotices: WarehouseBatchLossNotice[] = [];
    let foreignTenantRowsBlocked = 0;
    let pooledRowsExcluded = 0;

    // 1. Strict tenant isolation (0 foreign rows) & zero pooled rows
    const isolatedRows: ExportableAnalyticsRow[] = [];
    for (const row of args.rows) {
      if (row.tenantId !== config.tenantId || row.siteId !== config.siteId) {
        foreignTenantRowsBlocked += 1;
        continue;
      }
      if (row.isPooledResult) {
        pooledRowsExcluded += 1;
        continue;
      }
      isolatedRows.push(row);
    }

    if (foreignTenantRowsBlocked > 0) {
      const n: WarehouseBatchLossNotice = {
        exportId: config.exportId,
        target: config.target,
        reason: 'foreign_tenant_rejected',
        count: foreignTenantRowsBlocked,
        latencyMs: 0,
        recordedAtMs: nowMs,
      };
      batchNotices.push(n);
      this.emitLoss(n);
    }

    if (pooledRowsExcluded > 0) {
      const n: WarehouseBatchLossNotice = {
        exportId: config.exportId,
        target: config.target,
        reason: 'pooled_row_excluded',
        count: pooledRowsExcluded,
        latencyMs: 0,
        recordedAtMs: nowMs,
      };
      batchNotices.push(n);
      this.emitLoss(n);
    }

    // 2. External-party recipient rules: non-overlapping calendar windows + k=10 + complementary suppression
    let suppressedCellsCount = 0;
    let complementarySuppressedCount = 0;
    const suppressedRowIds = new Set<string>();

    if (config.recipientClass === 'external_party') {
      const winKey = `${config.tenantId}\u0000${config.siteId}\u0000${config.target}`;
      const history = this.exportedExternalWindows.get(winKey) ?? [];

      const uniqueWindows = new Map<string, { startMs: number; endMs: number }>();
      for (const row of isolatedRows) {
        const startMs = Date.parse(row.windowStartIso);
        const endMs = Date.parse(row.windowEndIso);
        const wk = `${startMs}:${endMs}`;
        if (!uniqueWindows.has(wk)) {
          uniqueWindows.set(wk, { startMs, endMs });
        }
      }

      for (const win of uniqueWindows.values()) {
        if (hasOverlappingExternalWindow(history, win)) {
          return {
            exportId: config.exportId,
            target: config.target,
            recipientClass: config.recipientClass,
            status: 'rejected_window_overlap',
            exportedRowCount: 0,
            foreignTenantRowsBlocked,
            pooledRowsExcluded,
            suppressedCellsCount: 0,
            complementarySuppressedCount: 0,
            batchLatencyMs: 0,
            within15mSla: true,
            artifact: null,
            lossNotices: batchNotices,
            reason:
              'External-party export requires calendar-aligned, non-overlapping windows (§11.3 / §12.3)',
          };
        }
      }

      for (const win of uniqueWindows.values()) {
        history.push(win);
      }
      this.exportedExternalWindows.set(winKey, history);

      const minK = config.externalMinCellK ?? getDefaultExternalMinCellK();
      const eligibleIndices: Array<{ readonly rowId: string; readonly count: number }> = [];

      for (const row of isolatedRows) {
        const unitCount = row.cellUnitCount ?? 0;
        if (unitCount < minK) {
          suppressedRowIds.add(row.rowId);
          suppressedCellsCount += 1;
        } else {
          eligibleIndices.push({ rowId: row.rowId, count: unitCount });
        }
      }

      // Complementary suppression against differencing: if exactly 1 cell was suppressed,
      // also suppress the next-smallest cell so (total - visible) cannot reconstruct the suppressed cell!
      if (suppressedCellsCount === 1 && eligibleIndices.length > 0) {
        eligibleIndices.sort((a, b) => a.count - b.count);
        suppressedRowIds.add(eligibleIndices[0]!.rowId);
        complementarySuppressedCount = 1;
      }
    }

    // 3. Serialize rows into open Parquet contract carrying mandatory provenance columns
    const serializedRows = isolatedRows.map((row) => {
      const isSuppressed = suppressedRowIds.has(row.rowId);
      const maskedMetrics: Record<string, number | null> = {};
      for (const [k, v] of Object.entries(row.metrics)) {
        maskedMetrics[k] = isSuppressed ? null : v;
      }
      return {
        row_id: row.rowId,
        tenant_id: row.tenantId,
        site_id: row.siteId,
        window_start: row.windowStartIso,
        window_end: row.windowEndIso,
        schema_version: row.schemaVersion || CANONICAL_SCHEMA.meta.schemaVersion,
        collection_gen: row.collectionGen,
        consent_mode: row.consentMode,
        purposes_allowed: [...row.purposesAllowed].sort(),
        revocation_epoch: row.revocationEpoch,
        retention_expires_at: row.retentionExpiresAtIso,
        trust_level: row.trustLevel,
        missing_flags: [...row.missingFlags].sort(),
        lane: row.lane,
        evidence_level: row.evidenceLevel,
        deletion_epoch: config.deletionEpoch,
        suppressed: isSuppressed,
        metrics_json: canonicalJsonStringify(maskedMetrics),
      };
    });

    const columns = buildOpenParquetSchemaColumns();
    const manifestSha256 = sha256Hex(
      canonicalJsonStringify({
        exportId: config.exportId,
        target: config.target,
        tenantId: config.tenantId,
        siteId: config.siteId,
        deletionEpoch: config.deletionEpoch,
        rows: serializedRows,
      })
    );

    const artifact: OpenParquetExportArtifact = {
      format: 'ugokilink_parquet_contract_v1',
      schemaVersion: CANONICAL_SCHEMA.meta.schemaVersion,
      target: config.target,
      exportId: config.exportId,
      tenantId: config.tenantId,
      siteId: config.siteId,
      deletionEpoch: config.deletionEpoch,
      columns,
      rowCount: serializedRows.length,
      rows: serializedRows,
      manifestSha256,
    };

    let finishedAtMs = nowMs;
    if (this.sink) {
      try {
        const res = await this.sink.writeBatch(config, artifact);
        finishedAtMs = res.writtenAtMs;
      } catch (err) {
        const failNotice: WarehouseBatchLossNotice = {
          exportId: config.exportId,
          target: config.target,
          reason: 'write_failed',
          count: serializedRows.length,
          latencyMs: Math.max(0, nowMs - args.sourceEventCutoffMs),
          recordedAtMs: nowMs,
        };
        batchNotices.push(failNotice);
        this.emitLoss(failNotice);
        return {
          exportId: config.exportId,
          target: config.target,
          recipientClass: config.recipientClass,
          status: 'failed',
          exportedRowCount: 0,
          foreignTenantRowsBlocked,
          pooledRowsExcluded,
          suppressedCellsCount,
          complementarySuppressedCount,
          batchLatencyMs: failNotice.latencyMs,
          within15mSla: false,
          artifact: null,
          lossNotices: batchNotices,
          reason: err instanceof Error ? err.message : 'warehouse_write_failed',
        };
      }
    }

    const batchLatencyMs = Math.max(0, finishedAtMs - args.sourceEventCutoffMs);
    this.latenciesMs.push(batchLatencyMs);
    const within15mSla = batchLatencyMs <= WAREHOUSE_BATCH_P95_SLA_MS;

    if (!within15mSla) {
      const slaNotice: WarehouseBatchLossNotice = {
        exportId: config.exportId,
        target: config.target,
        reason: 'sla_15m_breached',
        count: serializedRows.length,
        latencyMs: batchLatencyMs,
        recordedAtMs: finishedAtMs,
      };
      batchNotices.push(slaNotice);
      this.emitLoss(slaNotice);
    }

    return {
      exportId: config.exportId,
      target: config.target,
      recipientClass: config.recipientClass,
      status: 'ok',
      exportedRowCount: serializedRows.length,
      foreignTenantRowsBlocked,
      pooledRowsExcluded,
      suppressedCellsCount,
      complementarySuppressedCount,
      batchLatencyMs,
      within15mSla,
      artifact,
      lossNotices: batchNotices,
    };
  }

  public getObservedBatchP95Ms(): number {
    if (this.latenciesMs.length === 0) return 0;
    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    return sorted[idx] ?? 0;
  }

  public getAllLossNotices(): readonly WarehouseBatchLossNotice[] {
    return [...this.lossNotices];
  }
}
