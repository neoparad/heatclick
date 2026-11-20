/**
 * UGOKI LINK v2 — Data Residency Path Catalog & Automated Location Auditor (§11.11 #13 / D-29)
 *
 * Inventories and verifies EVERY storage, relay, processing, and export path
 * against a tenant's pinned storage region (`jp` default; `eu` / `us` separate stacks):
 * - `link_managed_storage` (including R2 WAL, 30-min DO, Queue, abuse_hold/quarantine,
 *   temp spill, ClickHouse, backups, visual replays, ML extracts, GPU temp files/logs
 *   registered separately from processing, and heatmap render queue):
 *   MUST match tenant region with `contractualGuarantee === 'contractual_region_pin'`
 *   (`location_hint_only` or `'unknown'` => FAIL!)
 * - `edge_relay`: overseas relays permitted ONLY with `zeroPersistenceVerified === true`
 * - `external_processing`: GPU / LLM inference MUST match approved regions, purposes & retention contract
 * - `customer_export`: Tier 2 customer-designated sinks MUST match an explicit customer grant
 * - Any single mismatch or `'unknown'` location immediately blocks release (`passed: false`)!
 */

import type { ResidencyBlock } from '../../../packages/contract/response';
import type { DataRegion } from '../../../workers/link-wal';

export const LINK_MANAGED_STORAGE_ROLES = [
  'r2_wal',
  'live_do_30m',
  'ingest_queue',
  'abuse_hold_and_quarantine',
  'temp_spill_storage',
  'clickhouse_primary',
  'backups',
  'visual_replay_store',
  'ml_training_extracts',
  'gpu_temp_files_and_logs', // Registered explicitly as storage separate from processing (§11.11 #13)
  'heatmap_render_queue',
] as const;

export type LinkManagedStorageRole = (typeof LINK_MANAGED_STORAGE_ROLES)[number];

export type ResidencyPathClass =
  | 'link_managed_storage'
  | 'edge_relay'
  | 'external_processing'
  | 'customer_export';

export type ObservedRegionValue = DataRegion | 'global_edge' | 'unknown';

export type LocationGuaranteeStrength =
  | 'contractual_region_pin'
  | 'location_hint_only'
  | 'none';

export interface DataPathCatalogEntry {
  readonly pathId: string;
  readonly pathClass: ResidencyPathClass;
  readonly storageRole?: LinkManagedStorageRole;
  readonly providerName: string;
  readonly observedRegion: ObservedRegionValue;
  readonly verifiedViaProviderApi: boolean;
  readonly contractualGuarantee: LocationGuaranteeStrength;
  /** For `edge_relay`: MUST be true (zero bytes written to disk/KV at overseas edge PoP). */
  readonly zeroPersistenceVerified?: boolean;
  readonly approvedRelay?: boolean;
  /** For `external_processing`: approved regions, purposes & deletion/retention contract. */
  readonly approvedProcessingRegions?: readonly DataRegion[];
  readonly purpose?: string;
  readonly approvedPurposes?: readonly string[];
  readonly retentionDeletionContractVerified?: boolean;
  /** For `customer_export`: separate explicit customer grant for cross-region / external sink. */
  readonly customerExportGrantId?: string | null;
  readonly grantedExportRegion?: DataRegion | null;
}

export interface ResidencyPathViolation {
  readonly pathId: string;
  readonly pathClass: ResidencyPathClass;
  readonly code:
    | 'UNKNOWN_LOCATION'
    | 'LOCATION_HINT_NOT_CONTRACTUAL'
    | 'REGION_MISMATCH'
    | 'MISSING_REQUIRED_STORAGE_ROLE'
    | 'RELAY_PERSISTENCE_UNVERIFIED'
    | 'UNAPPROVED_EDGE_RELAY'
    | 'EXTERNAL_PROCESSING_REGION_DISALLOWED'
    | 'EXTERNAL_PROCESSING_PURPOSE_OR_RETENTION_UNVERIFIED'
    | 'CUSTOMER_EXPORT_GRANT_MISSING_OR_MISMATCH';
  readonly message: string;
}

export interface ResidencyAuditReport {
  readonly tenantId: string;
  readonly tenantContractRegion: DataRegion;
  readonly evaluatedAtMs: number;
  readonly passed: boolean;
  readonly releaseBlocked: boolean;
  readonly totalPathsAudited: number;
  readonly missingRequiredStorageRoles: readonly LinkManagedStorageRole[];
  readonly violations: readonly ResidencyPathViolation[];
  readonly processingRegionsObserved: readonly string[];
  readonly envelopeResidency: ResidencyBlock & {
    readonly processing_regions: readonly string[];
  };
}

/**
 * Audits all catalogued storage, relay, processing, and export paths for a tenant
 * against §11.11 #13 (`surf.residency_audit`).
 * Fails closed (`passed: false`, `releaseBlocked: true`) on ANY mismatch, hint-only
 * location, unknown location, unverified relay persistence, or missing required storage role.
 */
export function auditTenantResidencyPaths(args: {
  readonly tenantId: string;
  readonly tenantContractRegion: DataRegion;
  readonly paths: readonly DataPathCatalogEntry[];
  readonly requireAllLinkStorageRoles?: boolean;
  readonly nowMs?: number;
}): ResidencyAuditReport {
  const violations: ResidencyPathViolation[] = [];
  const seenStorageRoles = new Set<LinkManagedStorageRole>();
  const processingRegions = new Set<string>([args.tenantContractRegion]);

  for (const entry of args.paths) {
    if (entry.observedRegion === 'unknown') {
      violations.push({
        pathId: entry.pathId,
        pathClass: entry.pathClass,
        code: 'UNKNOWN_LOCATION',
        message: `Path "${entry.pathId}" (${entry.providerName}) has unknown physical region; fail-closed`,
      });
      continue;
    }

    if (entry.pathClass === 'link_managed_storage') {
      if (entry.storageRole) {
        seenStorageRoles.add(entry.storageRole);
      }

      if (entry.contractualGuarantee !== 'contractual_region_pin') {
        violations.push({
          pathId: entry.pathId,
          pathClass: entry.pathClass,
          code: 'LOCATION_HINT_NOT_CONTRACTUAL',
          message: `Storage path "${entry.pathId}" uses "${entry.contractualGuarantee}" (location hints are NOT contractual residency guarantees under D-29 / §11.11 #13)`,
        });
      }

      if (entry.observedRegion !== args.tenantContractRegion) {
        violations.push({
          pathId: entry.pathId,
          pathClass: entry.pathClass,
          code: 'REGION_MISMATCH',
          message: `LINK-managed storage "${entry.pathId}" resides in "${entry.observedRegion}", violating tenant contract region "${args.tenantContractRegion}"`,
        });
      }
      continue;
    }

    if (entry.pathClass === 'edge_relay') {
      processingRegions.add(entry.observedRegion);
      if (!entry.approvedRelay) {
        violations.push({
          pathId: entry.pathId,
          pathClass: entry.pathClass,
          code: 'UNAPPROVED_EDGE_RELAY',
          message: `Edge relay "${entry.pathId}" is not in the approved relay catalog`,
        });
      }
      if (entry.zeroPersistenceVerified !== true) {
        violations.push({
          pathId: entry.pathId,
          pathClass: entry.pathClass,
          code: 'RELAY_PERSISTENCE_UNVERIFIED',
          message: `Edge relay "${entry.pathId}" (${entry.observedRegion}) lacks zeroPersistenceVerified=true (overseas relays MUST NOT write to storage)`,
        });
      }
      continue;
    }

    if (entry.pathClass === 'external_processing') {
      processingRegions.add(entry.observedRegion);
      const allowedRegs = entry.approvedProcessingRegions ?? [];
      if (
        entry.observedRegion === 'global_edge' ||
        !allowedRegs.includes(entry.observedRegion)
      ) {
        violations.push({
          pathId: entry.pathId,
          pathClass: entry.pathClass,
          code: 'EXTERNAL_PROCESSING_REGION_DISALLOWED',
          message: `External processing "${entry.pathId}" runs in "${entry.observedRegion}", outside approved regions [${allowedRegs.join(', ')}]`,
        });
      }
      const purposeApproved =
        Boolean(entry.purpose) &&
        Boolean(entry.approvedPurposes?.includes(entry.purpose!));
      if (!purposeApproved || entry.retentionDeletionContractVerified !== true) {
        violations.push({
          pathId: entry.pathId,
          pathClass: entry.pathClass,
          code: 'EXTERNAL_PROCESSING_PURPOSE_OR_RETENTION_UNVERIFIED',
          message: `External processing "${entry.pathId}" missing approved purpose or retention/deletion contract verification`,
        });
      }
      continue;
    }

    // customer_export
    if (
      !entry.customerExportGrantId ||
      entry.customerExportGrantId.trim().length === 0 ||
      entry.grantedExportRegion !== entry.observedRegion ||
      entry.retentionDeletionContractVerified !== true
    ) {
      violations.push({
        pathId: entry.pathId,
        pathClass: entry.pathClass,
        code: 'CUSTOMER_EXPORT_GRANT_MISSING_OR_MISMATCH',
        message: `Customer export "${entry.pathId}" (${entry.observedRegion}) lacks matching customerExportGrantId or retention contract`,
      });
    }
  }

  const missingRequiredStorageRoles: LinkManagedStorageRole[] = [];
  if (args.requireAllLinkStorageRoles !== false) {
    for (const role of LINK_MANAGED_STORAGE_ROLES) {
      if (!seenStorageRoles.has(role)) {
        missingRequiredStorageRoles.push(role);
        violations.push({
          pathId: `missing:${role}`,
          pathClass: 'link_managed_storage',
          code: 'MISSING_REQUIRED_STORAGE_ROLE',
          message: `Required LINK-managed storage path role "${role}" is absent from the residency catalog`,
        });
      }
    }
  }

  const sortedProcRegions = Array.from(processingRegions).sort();
  const passed = violations.length === 0;

  return {
    tenantId: args.tenantId,
    tenantContractRegion: args.tenantContractRegion,
    evaluatedAtMs: args.nowMs ?? Date.now(),
    passed,
    releaseBlocked: !passed,
    totalPathsAudited: args.paths.length,
    missingRequiredStorageRoles,
    violations,
    processingRegionsObserved: sortedProcRegions,
    envelopeResidency: {
      storage_region: args.tenantContractRegion,
      processing_region: sortedProcRegions.join(','),
      processing_regions: sortedProcRegions,
    },
  };
}

/**
 * Helper constructing a compliant baseline catalog covering all 11 mandatory
 * LINK-managed storage roles pinned to `region` (useful for staging/CI checks).
 */
export function buildCompliantBaselineResidencyCatalog(
  region: DataRegion = 'jp'
): DataPathCatalogEntry[] {
  const storageEntries: DataPathCatalogEntry[] = LINK_MANAGED_STORAGE_ROLES.map(
    (role) => ({
      pathId: `storage_${role}_${region}`,
      pathClass: 'link_managed_storage',
      storageRole: role,
      providerName:
        role === 'clickhouse_primary' || role === 'backups'
          ? `clickhouse_dedicated_${region}`
          : role === 'gpu_temp_files_and_logs'
            ? `gpu_host_storage_${region}`
            : `cloudflare_jurisdiction_${region}`,
      observedRegion: region,
      verifiedViaProviderApi: true,
      contractualGuarantee: 'contractual_region_pin',
    })
  );

  return [
    ...storageEntries,
    {
      pathId: 'edge_relay_global_zero_persist',
      pathClass: 'edge_relay',
      providerName: 'cloudflare_edge_transit',
      observedRegion: 'global_edge',
      verifiedViaProviderApi: true,
      contractualGuarantee: 'contractual_region_pin',
      approvedRelay: true,
      zeroPersistenceVerified: true,
    },
  ];
}
