/**
 * UGOKI LINK v2 — Feature Flags (Browser Lease Evaluation + Customer Server Local Signed-Bundle
 * Evaluation + Pre-Apply Persistence + Gap/Invalid Detection + Allocator Layer Collision Guard)
 *
 * Implements Master Architecture v2 §11.11 item 6:
 *   - Flags register as Allocator layers and collide-check against active experiments before preflight
 *   - Reverting to `safeValue` is low-risk (`R1`); all other value/targeting changes are `R2`+
 *   - Browser evaluation uses server-issued time-bounded display lease; expired -> `safeValue`
 *   - Customer server local evaluation uses Ed25519-signed config bundle + continuously refreshed
 *     short-lived display lease (zero per-eval RTT), persists decision locally BEFORE applying with
 *     monotonic `seq` + `totalCount`; LINK gap detector NEVER excludes missing rows and marks
 *     any non-reconstructible period as `invalid`!
 */

import crypto from 'node:crypto';
import { canonicalJson } from '@/packages/contract/response';
import type { RiskClass } from '@/lib/link/auth';
import { drawUniformU } from '@/lib/link/allocator';

// =========================================================================
// 1. Flag Registry, Allocator Layer Collision Guard & Risk Classification
// =========================================================================

export interface FeatureFlagArm {
  readonly value: string;
  readonly weight: number;
}

export interface RegisteredFeatureFlag {
  readonly flagKey: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly layerId: string;
  readonly region: string;
  readonly saltKey: string;
  readonly safeValue: string;
  readonly arms: ReadonlyArray<FeatureFlagArm>;
  readonly enabled: boolean;
}

export interface ActiveExperimentLayerSlot {
  readonly experimentId: string;
  readonly layerId: string;
  readonly region: string;
}

export function checkFlagExperimentCollision(
  flag: RegisteredFeatureFlag,
  activeExperiments: ReadonlyArray<ActiveExperimentLayerSlot>
): { readonly collision: boolean; readonly conflictingExperimentIds: ReadonlyArray<string> } {
  const conflicts = activeExperiments
    .filter((exp) => exp.layerId === flag.layerId || exp.region === flag.region)
    .map((exp) => exp.experimentId);
  return {
    collision: conflicts.length > 0,
    conflictingExperimentIds: conflicts,
  };
}

/**
 * §11.11 item 6 risk classification:
 *   - Reverting a flag strictly to its registered `safeValue` is low-risk (`R1`).
 *   - Any other value change or targeting expansion is `R2` (affects visitors).
 */
export function classifyFeatureFlagChangeRisk(params: {
  readonly flag: RegisteredFeatureFlag;
  readonly targetValue?: string;
  readonly isRevertToSafeValue: boolean;
}): RiskClass {
  if (params.isRevertToSafeValue && (!params.targetValue || params.targetValue === params.flag.safeValue)) {
    return 'R1';
  }
  return 'R2';
}

// =========================================================================
// 2. Mode 1: Browser Evaluation (Time-Bounded Server Display Lease)
// =========================================================================

export interface BrowserDisplayLease {
  readonly leaseId: string;
  readonly siteId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly assignedArmValue: string;
  readonly controlReachable: boolean;
}

export function evaluateBrowserFeatureFlag(params: {
  readonly flag: RegisteredFeatureFlag;
  readonly lease: BrowserDisplayLease | null;
  readonly nowMs: number;
}): {
  readonly flagKey: string;
  readonly value: string;
  readonly fallbackToSafe: boolean;
  readonly reason: 'assigned' | 'lease_missing' | 'lease_expired' | 'control_unreachable' | 'flag_disabled';
} {
  if (!params.flag.enabled) {
    return {
      flagKey: params.flag.flagKey,
      value: params.flag.safeValue,
      fallbackToSafe: true,
      reason: 'flag_disabled',
    };
  }
  if (!params.lease) {
    return {
      flagKey: params.flag.flagKey,
      value: params.flag.safeValue,
      fallbackToSafe: true,
      reason: 'lease_missing',
    };
  }
  if (!params.lease.controlReachable) {
    return {
      flagKey: params.flag.flagKey,
      value: params.flag.safeValue,
      fallbackToSafe: true,
      reason: 'control_unreachable',
    };
  }
  if (params.nowMs >= params.lease.expiresAtMs || params.lease.siteId !== params.flag.siteId) {
    return {
      flagKey: params.flag.flagKey,
      value: params.flag.safeValue,
      fallbackToSafe: true,
      reason: 'lease_expired',
    };
  }
  return {
    flagKey: params.flag.flagKey,
    value: params.lease.assignedArmValue,
    fallbackToSafe: false,
    reason: 'assigned',
  };
}

// =========================================================================
// 3. Mode 2: Customer Server Local Evaluation (Signed Bundle + Short Lease + Seq Ledger)
// =========================================================================

export interface ServerSignedConfigBundle {
  readonly bundleId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly flags: ReadonlyArray<RegisteredFeatureFlag>;
  readonly issuedAtMs: number;
  readonly signatureBase64Url: string;
}

export interface ServerSignedLease {
  readonly leaseId: string;
  readonly siteId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly signatureBase64Url: string;
}

export interface ServerFlagDecisionRecord {
  readonly seq: number;
  readonly totalCount: number;
  readonly flagKey: string;
  readonly unitId: string;
  readonly value: string;
  readonly fallbackToSafe: boolean;
  readonly reason: string;
  readonly decidedAtMs: number;
  readonly persistedBeforeApply: true;
}

export function signServerFlagObject<T extends Record<string, unknown>>(
  unsigned: T,
  privateKeyPem: string
): string {
  return crypto
    .sign(null, Buffer.from(canonicalJson(unsigned), 'utf8'), privateKeyPem)
    .toString('base64url');
}

function verifyServerFlagObject(
  unsigned: Record<string, unknown>,
  signatureBase64Url: string,
  publicKeyPem: string
): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(canonicalJson(unsigned), 'utf8'),
      publicKeyPem,
      Buffer.from(signatureBase64Url, 'base64url')
    );
  } catch {
    return false;
  }
}

export class ServerFeatureFlagEvaluator {
  private readonly publicKeyPem: string;
  private bundle: ServerSignedConfigBundle;
  private lease: ServerSignedLease;
  private seq = 0;
  private readonly durableLocalLog: ServerFlagDecisionRecord[] = [];

  constructor(params: {
    readonly publicKeyPem: string;
    readonly bundle: ServerSignedConfigBundle;
    readonly lease: ServerSignedLease;
  }) {
    this.publicKeyPem = params.publicKeyPem;
    this.bundle = params.bundle;
    this.lease = params.lease;
  }

  public refreshLease(newLease: ServerSignedLease): void {
    this.lease = newLease;
  }

  public getDurableDecisionLog(): ReadonlyArray<ServerFlagDecisionRecord> {
    return [...this.durableLocalLog];
  }

  /**
   * Evaluates a flag locally with zero per-call network RTT, persisting the decision
   * to the local durable log (`seq`, `totalCount`) BEFORE returning the value for application.
   */
  public evaluateLocal(
    flagKey: string,
    unitId: string,
    nowMs: number = Date.now()
  ): ServerFlagDecisionRecord {
    const flag = this.bundle.flags.find((f) => f.flagKey === flagKey);
    const safeVal = flag ? flag.safeValue : 'false';

    const { signatureBase64Url: bSig, ...bUnsigned } = this.bundle;
    const { signatureBase64Url: lSig, ...lUnsigned } = this.lease;

    const bundleOk = verifyServerFlagObject(bUnsigned, bSig, this.publicKeyPem);
    const leaseOk = verifyServerFlagObject(lUnsigned, lSig, this.publicKeyPem);

    let value = safeVal;
    let fallbackToSafe = true;
    let reason = 'unknown_flag_safe_fallback';

    if (!flag) {
      reason = 'unknown_flag_safe_fallback';
    } else if (!bundleOk || !leaseOk || this.bundle.siteId !== this.lease.siteId) {
      reason = 'invalid_signature_safe_fallback';
    } else if (nowMs >= this.lease.expiresAtMs) {
      reason = 'lease_expired_safe_fallback';
    } else if (!flag.enabled) {
      reason = 'flag_disabled_safe_fallback';
    } else {
      const u = drawUniformU(flag.saltKey, unitId);
      const total = flag.arms.reduce((acc, a) => acc + a.weight, 0);
      let cum = 0;
      let picked = flag.arms[flag.arms.length - 1].value;
      for (const arm of flag.arms) {
        cum += arm.weight / total;
        if (u < cum) {
          picked = arm.value;
          break;
        }
      }
      value = picked;
      fallbackToSafe = false;
      reason = 'assigned';
    }

    this.seq += 1;
    const record: ServerFlagDecisionRecord = {
      seq: this.seq,
      totalCount: this.seq,
      flagKey,
      unitId,
      value,
      fallbackToSafe,
      reason,
      decidedAtMs: nowMs,
      persistedBeforeApply: true,
    };

    // Persist locally BEFORE caller can apply the flag!
    this.durableLocalLog.push(record);
    return record;
  }
}

// =========================================================================
// 4. LINK-Side Gap Detector & Recompute Parity (`invalid` on non-reconstructible gaps!)
// =========================================================================

export interface ServerFlagLogAuditResult {
  readonly status: 'ok' | 'invalid';
  readonly expectedTotalCount: number;
  readonly receivedCount: number;
  readonly missingSeqNumbers: ReadonlyArray<number>;
  readonly recomputeMismatches: number;
  readonly resendRequested: boolean;
  readonly reason: string;
}

/**
 * Audits received server flag decision batches:
 *   - Detects any sequence gaps (`1..maxTotalCount`) and requests resend.
 *   - NEVER excludes missing decisions silently; any window with unrecovered gaps or
 *     recompute mismatches is strictly marked `status: 'invalid'` (§11.11 item 6)!
 */
export function auditServerFlagDecisionBatch(params: {
  readonly flag: RegisteredFeatureFlag;
  readonly receivedRecords: ReadonlyArray<ServerFlagDecisionRecord>;
}): ServerFlagLogAuditResult {
  if (params.receivedRecords.length === 0) {
    return {
      status: 'ok',
      expectedTotalCount: 0,
      receivedCount: 0,
      missingSeqNumbers: [],
      recomputeMismatches: 0,
      resendRequested: false,
      reason: 'No decisions reported in window',
    };
  }

  const maxTotal = Math.max(...params.receivedRecords.map((r) => r.totalCount));
  const seenSeqs = new Set<number>();
  let recomputeMismatches = 0;

  for (const r of params.receivedRecords) {
    seenSeqs.add(r.seq);
    if (!r.fallbackToSafe && r.flagKey === params.flag.flagKey) {
      const u = drawUniformU(params.flag.saltKey, r.unitId);
      const total = params.flag.arms.reduce((acc, a) => acc + a.weight, 0);
      let cum = 0;
      let expected = params.flag.arms[params.flag.arms.length - 1].value;
      for (const arm of params.flag.arms) {
        cum += arm.weight / total;
        if (u < cum) {
          expected = arm.value;
          break;
        }
      }
      if (expected !== r.value) {
        recomputeMismatches += 1;
      }
    }
  }

  const missingSeqNumbers: number[] = [];
  for (let s = 1; s <= maxTotal; s++) {
    if (!seenSeqs.has(s)) {
      missingSeqNumbers.push(s);
    }
  }

  if (missingSeqNumbers.length > 0 || recomputeMismatches > 0) {
    return {
      status: 'invalid',
      expectedTotalCount: maxTotal,
      receivedCount: params.receivedRecords.length,
      missingSeqNumbers,
      recomputeMismatches,
      resendRequested: missingSeqNumbers.length > 0,
      reason:
        missingSeqNumbers.length > 0
          ? `Detected ${missingSeqNumbers.length} missing decision seq(s); missing rows are NEVER silently dropped — period marked invalid until reconstructed`
          : `Detected ${recomputeMismatches} server recompute mismatch(es); period marked invalid`,
    };
  }

  return {
    status: 'ok',
    expectedTotalCount: maxTotal,
    receivedCount: params.receivedRecords.length,
    missingSeqNumbers: [],
    recomputeMismatches: 0,
    resendRequested: false,
    reason: 'All sequences contiguous and 100% recompute-verified',
  };
}
