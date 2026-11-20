/**
 * UGOKI LINK v2 — Unified Lab Marker Verification & Zero-Leakage Exclusion Gate (Bundle 3-C)
 *
 * Implements §12.1 #4, §12.2, D-22:
 * - Single unified Lab Marker covering all 6 canonical purposes:
 *   `render | install_probe | canary_visit | preflight | agent_run | panel`
 * - `render` purpose blocks collector ingestion completely (`block_ingest: true`).
 * - ALL 6 purposes exclude the PV by field from ALL 6 human/commercial pipelines:
 *   1. human_rollups
 *   2. quorums
 *   3. experiments
 *   4. ml_training
 *   5. loss_ledger
 *   6. billing
 * - Provides `filterForHumanPipeline` and `assertZeroLabLeakage` (hard gate: 0 leaked lab PVs).
 */

import { hmacSha256Hex } from '../../lib/link/allocator';
import { LAB_MARKER_PURPOSES, type LabMarkerToken } from '../../packages/sdk-browser';
import type { LabPipelineExclusionFlags } from './types';

export type ProtectedHumanPipeline =
  | 'human_rollups'
  | 'quorums'
  | 'experiments'
  | 'ml_training'
  | 'loss_ledger'
  | 'billing';

export const PROTECTED_HUMAN_PIPELINES: readonly ProtectedHumanPipeline[] = [
  'human_rollups',
  'quorums',
  'experiments',
  'ml_training',
  'loss_ledger',
  'billing',
] as const;

function canonicalMarkerMessage(
  marker: Pick<LabMarkerToken, 'lab_run_id' | 'purpose' | 'site_id' | 'issued_at' | 'expires_at'>
): string {
  return `ugk-lab-marker/1|${marker.site_id}|${marker.purpose}|${marker.lab_run_id}|${marker.issued_at}|${marker.expires_at}`;
}

/**
 * Signs a unified Lab Marker token with HMAC-SHA256.
 */
export function signLabMarker(
  payload: Omit<LabMarkerToken, 'signature_b64'>,
  secret: string
): LabMarkerToken {
  const sigHex = hmacSha256Hex(secret, canonicalMarkerMessage(payload));
  return {
    ...payload,
    signature_b64: sigHex,
  };
}

export interface LabMarkerVerificationResult {
  readonly valid: boolean;
  readonly marker: LabMarkerToken | null;
  readonly reason: string | null;
}

/**
 * Cryptographically verifies a Lab Marker token (purpose enum, site match, time window, MAC).
 */
export function verifyLabMarker(
  marker: LabMarkerToken | null | undefined,
  expectedSiteId: string,
  secret: string,
  nowMs: number
): LabMarkerVerificationResult {
  if (!marker) {
    return { valid: false, marker: null, reason: 'absent' };
  }
  if (!(LAB_MARKER_PURPOSES as readonly string[]).includes(marker.purpose)) {
    return { valid: false, marker: null, reason: 'invalid_purpose' };
  }
  if (marker.site_id !== expectedSiteId) {
    return { valid: false, marker: null, reason: 'site_mismatch' };
  }
  const issuedMs = Date.parse(marker.issued_at);
  const expiresMs = Date.parse(marker.expires_at);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || nowMs < issuedMs || nowMs > expiresMs) {
    return { valid: false, marker: null, reason: 'expired_or_not_yet_valid' };
  }
  const expectedSig = hmacSha256Hex(secret, canonicalMarkerMessage(marker));
  if (marker.signature_b64 !== expectedSig) {
    return { valid: false, marker: null, reason: 'invalid_signature' };
  }
  return { valid: true, marker, reason: null };
}

/**
 * Computes mandatory exclusion flags for every record entering the Collector (§12.1 #4 / §12.2).
 * Also treats any frame carrying a non-empty `lab_run_id` as fail-closed lab traffic so
 * even a missing/expired marker header can NEVER leak a lab PV into human metrics or billing!
 */
export function evaluateLabPipelineExclusion(params: {
  readonly verifiedMarker: LabMarkerToken | null;
  readonly frameLabRunId?: string | null;
}): LabPipelineExclusionFlags {
  const { verifiedMarker, frameLabRunId } = params;

  if (verifiedMarker) {
    return {
      is_lab_traffic: true,
      lab_run_id: verifiedMarker.lab_run_id,
      lab_purpose: verifiedMarker.purpose,
      block_ingest: verifiedMarker.purpose === 'render',
      exclude_human_rollups: true,
      exclude_quorums: true,
      exclude_experiments: true,
      exclude_ml_training: true,
      exclude_loss_ledger: true,
      exclude_billing: true,
    };
  }

  // Fail-closed: if the frame itself declares a `lab_run_id` without a valid header marker,
  // still exclude from ALL 6 human/commercial pipelines!
  if (frameLabRunId && frameLabRunId.length > 0) {
    return {
      is_lab_traffic: true,
      lab_run_id: frameLabRunId,
      lab_purpose: null,
      block_ingest: false,
      exclude_human_rollups: true,
      exclude_quorums: true,
      exclude_experiments: true,
      exclude_ml_training: true,
      exclude_loss_ledger: true,
      exclude_billing: true,
    };
  }

  return {
    is_lab_traffic: false,
    lab_run_id: null,
    lab_purpose: null,
    block_ingest: false,
    exclude_human_rollups: false,
    exclude_quorums: false,
    exclude_experiments: false,
    exclude_ml_training: false,
    exclude_loss_ledger: false,
    exclude_billing: false,
  };
}

export interface LabExcludableRecord {
  readonly lab_exclusion: LabPipelineExclusionFlags;
  readonly frame?: { readonly lab_run_id?: string | null };
  readonly billable?: boolean;
}

function isExcludedFromPipeline(
  rec: LabExcludableRecord,
  pipeline: ProtectedHumanPipeline
): boolean {
  if (rec.lab_exclusion.is_lab_traffic || (rec.frame?.lab_run_id ?? null) !== null) {
    return true;
  }
  switch (pipeline) {
    case 'human_rollups':
      return rec.lab_exclusion.exclude_human_rollups;
    case 'quorums':
      return rec.lab_exclusion.exclude_quorums;
    case 'experiments':
      return rec.lab_exclusion.exclude_experiments;
    case 'ml_training':
      return rec.lab_exclusion.exclude_ml_training;
    case 'loss_ledger':
      return rec.lab_exclusion.exclude_loss_ledger;
    case 'billing':
      return rec.lab_exclusion.exclude_billing || rec.billable === false;
  }
}

/**
 * Filters records for any of the 6 human/commercial downstream pipelines, guaranteeing
 * 100% exclusion of every lab-marked PV (§12.1 #4).
 */
export function filterForHumanPipeline<T extends LabExcludableRecord>(
  records: readonly T[],
  pipeline: ProtectedHumanPipeline
): T[] {
  return records.filter((r) => !isExcludedFromPipeline(r, pipeline));
}

export interface LabLeakageAuditResult {
  readonly passed: boolean;
  readonly leakedCount: number;
  readonly leakedByPipeline: Readonly<Record<ProtectedHumanPipeline, number>>;
}

/**
 * Hard CI/runtime gate proving ZERO lab-marked PVs leaked into any protected human pipeline (§12.1 #4).
 */
export function auditZeroLabLeakage<T extends LabExcludableRecord>(
  pipelineOutputs: Readonly<Record<ProtectedHumanPipeline, readonly T[]>>
): LabLeakageAuditResult {
  const leakedByPipeline: Record<ProtectedHumanPipeline, number> = {
    human_rollups: 0,
    quorums: 0,
    experiments: 0,
    ml_training: 0,
    loss_ledger: 0,
    billing: 0,
  };

  let totalLeaked = 0;
  for (const pipeline of PROTECTED_HUMAN_PIPELINES) {
    const rows = pipelineOutputs[pipeline] ?? [];
    for (const row of rows) {
      if (row.lab_exclusion.is_lab_traffic || (row.frame?.lab_run_id ?? null) !== null) {
        leakedByPipeline[pipeline] += 1;
        totalLeaked += 1;
      }
    }
  }

  return {
    passed: totalLeaked === 0,
    leakedCount: totalLeaked,
    leakedByPipeline,
  };
}
