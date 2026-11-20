/**
 * UGOKI LINK v2 — §5.12 3-Tier Customer Storage Self-Diagnostics & 4-State Deletion Proof
 *
 * Implements Master Spec §5.12:
 * - Tier 1 (`tier1_link_managed`): LINK-managed storage
 * - Tier 2 (`tier2_link_plus_export`): LINK-managed primary + continuous customer export
 * - Tier 3 (`tier3_customer_sor`): Customer-hosted System of Record (LINK reads via revocable grant)
 * - Live self-diagnostics covering configuration, runtime liveness, write/read permissions,
 *   storage capacity headroom, and Tier-3 read-grant validity — surfacing unpermitted
 *   capabilities explicitly as `not_entitled`
 * - Strict 4-state deletion proof classifier:
 *   `confirmed_link` | `notified_customer_confirmed` | `notified_unconfirmed` | `outside_control`
 */

import { requireDecisionEntitled } from '../../../packages/contract/ledgers';
import type { DataRegion, StorageTier } from '../../../workers/link-wal';

export const FOUR_STATE_DELETION_PROOFS = [
  'confirmed_link',
  'notified_customer_confirmed',
  'notified_unconfirmed',
  'outside_control',
] as const;
export type FourStateDeletionStatus = (typeof FOUR_STATE_DELETION_PROOFS)[number];

export interface StorageTierDiagnosticInput {
  readonly tenantId: string;
  readonly siteId: string;
  readonly tier: StorageTier;
  readonly storageRegion: DataRegion;
  readonly configValid: boolean;
  readonly runtimeHealthy: boolean;
  readonly writePermissionOk: boolean;
  readonly capacityFreePct: number; // 0..100
  /** Required on Tier 3 for LINK ML training, CRAWL structural join & experiment readouts. */
  readonly linkReadGrantActive: boolean;
  readonly linkReadGrantExpiresAtMs?: number | null;
  readonly nowMs?: number;
  /** Optional test override for Decision 24 (`D-24`) approval. */
  readonly decision24ApprovedOverride?: boolean;
}

export type TierCapabilityStatus = 'available' | 'degraded' | 'not_entitled';

export interface CapabilityEntitlementEntry {
  readonly capability:
    | 'core_collection_and_wal'
    | 'continuous_customer_export'
    | 'ml_training_and_inference'
    | 'crawl_structural_join'
    | 'experiment_verdicts'
    | 'link_14d_deletion_sla_warranty';
  readonly status: TierCapabilityStatus;
  readonly reason: string;
}

export interface StorageTierSelfDiagnosticReport {
  readonly tenantId: string;
  readonly siteId: string;
  readonly tier: StorageTier;
  readonly storageRegion: DataRegion;
  readonly checkedAtMs: number;
  readonly overallHealthy: boolean;
  readonly checks: {
    readonly configValid: boolean;
    readonly runtimeHealthy: boolean;
    readonly writePermissionOk: boolean;
    readonly capacitySufficient: boolean;
    readonly linkReadGrantValid: boolean;
  };
  readonly warrantyScopeNote: string;
  readonly capabilities: readonly CapabilityEntitlementEntry[];
}

export const MIN_CAPACITY_FREE_PCT = 10;

/**
 * Runs §5.12 Tier 1/2/3 self-diagnostics across configuration, runtime liveness,
 * permissions, capacity headroom, and Tier-3 read-grant validity.
 */
export function runStorageTierSelfDiagnostic(
  input: StorageTierDiagnosticInput
): StorageTierSelfDiagnosticReport {
  const nowMs = input.nowMs ?? Date.now();
  const capacitySufficient = input.capacityFreePct >= MIN_CAPACITY_FREE_PCT;

  const grantNotExpired =
    input.linkReadGrantExpiresAtMs === undefined ||
    input.linkReadGrantExpiresAtMs === null ||
    input.linkReadGrantExpiresAtMs > nowMs;
  const linkReadGrantValid =
    input.tier !== 'tier3_customer_sor'
      ? true
      : input.linkReadGrantActive && grantNotExpired;

  const infraHealthy =
    input.configValid &&
    input.runtimeHealthy &&
    input.writePermissionOk &&
    capacitySufficient;

  const d24Status =
    input.decision24ApprovedOverride !== undefined
      ? input.decision24ApprovedOverride
      : requireDecisionEntitled('D-24', { enforceLegalSignOff: true }).entitled;

  const tier3ReadyForLinkReads =
    input.tier !== 'tier3_customer_sor'
      ? true
      : infraHealthy && linkReadGrantValid && d24Status;

  const capabilities: CapabilityEntitlementEntry[] = [
    {
      capability: 'core_collection_and_wal',
      status:
        input.tier === 'tier3_customer_sor' && !d24Status
          ? 'not_entitled'
          : infraHealthy
            ? 'available'
            : 'degraded',
      reason:
        input.tier === 'tier3_customer_sor' && !d24Status
          ? 'decision_24_and_legal_signoff_required_for_tier3'
          : infraHealthy
            ? 'healthy'
            : 'storage_tier_diagnostic_failed',
    },
    {
      capability: 'continuous_customer_export',
      status:
        input.tier === 'tier1_link_managed'
          ? 'not_entitled'
          : infraHealthy
            ? 'available'
            : 'degraded',
      reason:
        input.tier === 'tier1_link_managed'
          ? 'tier1_does_not_enable_continuous_export_upgrade_to_tier2'
          : infraHealthy
            ? 'continuous_export_active'
            : 'export_target_unhealthy',
    },
    {
      capability: 'ml_training_and_inference',
      status: tier3ReadyForLinkReads ? 'available' : 'not_entitled',
      reason: tier3ReadyForLinkReads
        ? 'read_access_verified'
        : !d24Status && input.tier === 'tier3_customer_sor'
          ? 'decision_24_pending'
          : !linkReadGrantValid
            ? 'tier3_read_grant_missing_or_expired'
            : 'tier3_customer_environment_unhealthy',
    },
    {
      capability: 'crawl_structural_join',
      status: tier3ReadyForLinkReads ? 'available' : 'not_entitled',
      reason: tier3ReadyForLinkReads
        ? 'read_access_verified'
        : !linkReadGrantValid
          ? 'tier3_read_grant_missing_or_expired'
          : 'tier3_customer_environment_unhealthy_or_unentitled',
    },
    {
      capability: 'experiment_verdicts',
      status: tier3ReadyForLinkReads ? 'available' : 'not_entitled',
      reason: tier3ReadyForLinkReads
        ? 'read_access_verified'
        : !linkReadGrantValid
          ? 'tier3_read_grant_missing_or_expired'
          : 'tier3_customer_environment_unhealthy_or_unentitled',
    },
    {
      capability: 'link_14d_deletion_sla_warranty',
      status:
        input.tier === 'tier1_link_managed'
          ? 'available'
          : input.tier === 'tier2_link_plus_export'
            ? 'degraded'
            : infraHealthy
              ? 'degraded'
              : 'not_entitled',
      reason:
        input.tier === 'tier1_link_managed'
          ? 'full_link_managed_14d_erasure_warranty'
          : input.tier === 'tier2_link_plus_export'
            ? 'link_copies_guaranteed_14d_customer_export_copies_owned_by_customer'
            : 'tier3_warranty_conditioned_on_customer_config_runtime_permissions_and_capacity',
    },
  ];

  const warrantyScopeNote =
    input.tier === 'tier1_link_managed'
      ? 'Tier 1: LINK guarantees 14-day erasure, isolation, and loss bounds across all LINK-managed stores.'
      : input.tier === 'tier2_link_plus_export'
        ? 'Tier 2: LINK guarantees 14-day erasure on LINK-managed copies and dispatches retried deletion notices to customer export targets; deletion of customer-owned copies is customer-controlled.'
        : 'Tier 3: LINK guarantees apply ONLY while LINK-distributed components are properly configured, running, permitted, and within capacity in the customer environment (§5.12).';

  return {
    tenantId: input.tenantId,
    siteId: input.siteId,
    tier: input.tier,
    storageRegion: input.storageRegion,
    checkedAtMs: nowMs,
    overallHealthy: infraHealthy && (input.tier !== 'tier3_customer_sor' || linkReadGrantValid),
    checks: {
      configValid: input.configValid,
      runtimeHealthy: input.runtimeHealthy,
      writePermissionOk: input.writePermissionOk,
      capacitySufficient,
      linkReadGrantValid,
    },
    warrantyScopeNote,
    capabilities,
  };
}

export interface StorageCopyDeletionInput {
  readonly copyId: string;
  readonly copyLabel: string;
  readonly managedBy: 'link' | 'customer_sink' | 'external_manual_export';
  readonly linkDeletionVerified?: boolean;
  readonly notificationSent?: boolean;
  readonly customerAckReceived?: boolean;
  readonly ackedAtMs?: number | null;
}

export interface ClassifiedCopyDeletionProof {
  readonly copyId: string;
  readonly copyLabel: string;
  readonly status: FourStateDeletionStatus;
  readonly ackedAtMs: number | null;
  readonly detail: string;
}

export interface FourStateDeletionCertificateSummary {
  readonly requestId: string;
  readonly tenantId: string;
  readonly deletionEpoch: number;
  readonly generatedAtMs: number;
  readonly countsByState: Readonly<Record<FourStateDeletionStatus, number>>;
  readonly copies: readonly ClassifiedCopyDeletionProof[];
  readonly allLinkCopiesConfirmed: boolean;
}

/**
 * Strictly classifies every storage & export copy into the exact 4 §5.12 states:
 * `confirmed_link` | `notified_customer_confirmed` | `notified_unconfirmed` | `outside_control`.
 */
export function buildFourStateDeletionProof(args: {
  readonly requestId: string;
  readonly tenantId: string;
  readonly deletionEpoch: number;
  readonly copies: readonly StorageCopyDeletionInput[];
  readonly nowMs?: number;
}): FourStateDeletionCertificateSummary {
  const counts: Record<FourStateDeletionStatus, number> = {
    confirmed_link: 0,
    notified_customer_confirmed: 0,
    notified_unconfirmed: 0,
    outside_control: 0,
  };

  let allLinkCopiesConfirmed = true;
  const classified: ClassifiedCopyDeletionProof[] = args.copies.map((c) => {
    if (c.managedBy === 'link') {
      if (c.linkDeletionVerified) {
        counts.confirmed_link += 1;
        return {
          copyId: c.copyId,
          copyLabel: c.copyLabel,
          status: 'confirmed_link',
          ackedAtMs: c.ackedAtMs ?? args.nowMs ?? Date.now(),
          detail: 'LINK-managed store physically purged and verified',
        };
      }
      allLinkCopiesConfirmed = false;
      counts.notified_unconfirmed += 1;
      return {
        copyId: c.copyId,
        copyLabel: c.copyLabel,
        status: 'notified_unconfirmed',
        ackedAtMs: null,
        detail: 'LINK-managed store purge still pending verification',
      };
    }

    if (c.managedBy === 'external_manual_export') {
      counts.outside_control += 1;
      return {
        copyId: c.copyId,
        copyLabel: c.copyLabel,
        status: 'outside_control',
        ackedAtMs: null,
        detail: 'Copy resides outside LINK lifecycle management (§5.12)',
      };
    }

    // customer_sink (Tier 2 export or Tier 3 customer-hosted SoR)
    if (c.notificationSent && c.customerAckReceived) {
      counts.notified_customer_confirmed += 1;
      return {
        copyId: c.copyId,
        copyLabel: c.copyLabel,
        status: 'notified_customer_confirmed',
        ackedAtMs: c.ackedAtMs ?? args.nowMs ?? Date.now(),
        detail: 'Deletion notification delivered and confirmed by customer sink',
      };
    }

    counts.notified_unconfirmed += 1;
    return {
      copyId: c.copyId,
      copyLabel: c.copyLabel,
      status: 'notified_unconfirmed',
      ackedAtMs: null,
      detail: c.notificationSent
        ? 'Deletion notification delivered; awaiting customer confirmation'
        : 'Deletion notification queued for retry; not yet confirmed',
    };
  });

  return {
    requestId: args.requestId,
    tenantId: args.tenantId,
    deletionEpoch: args.deletionEpoch,
    generatedAtMs: args.nowMs ?? Date.now(),
    countsByState: counts,
    copies: classified,
    allLinkCopiesConfirmed,
  };
}
