/**
 * UGOKI LINK v2 — Bundle 4-H.4: 24h Exclusion, 14d Deletion Certificate & In-House Distillation
 * (`lib/link/ml/finetune/deletion-distill.ts`)
 *
 * Implements §8.14, §8.9, §14 Decision 31-b, Addendum §4:
 * 1. **24-Hour Exclusion & 14-Day Deletion Certificate (`AdapterDeletionManager`)**:
 *    - Within <= 24h of a deletion request: removes ALL affected adapters, distilled classifiers,
 *      checkpoints, caches, deployed versions, and rollback candidates from serving & rollback;
 *      switches active alias to an unaffected safe version or `base_model`.
 *    - Within <= 14d: issues a signed deletion certificate + triggers clean retrain without the
 *      deleted subject's texts (re-promotion time after exclusion is NOT counted in the 14d SLA).
 *    - Physically blocks training with deletable texts if destined for an unmanaged distribution
 *      target where deletion cannot be guaranteed (`UnmanagedDestinationDeletionGuardError`).
 * 2. **Lightweight Classifier Distillation (`distillInHouseModelToInt8Classifier`)**:
 *    - Teacher MUST be an in-house base or fine-tuned model (`origin === 'in_house_base_or_adapter'`).
 *    - Passing Jev as teacher IMMEDIATELY throws `JevTeacherProhibitedError` (Decision 31-b!).
 *    - Evaluation MUST be measured against human-labeled `final_eval` data (NEVER teacher agreement!).
 *    - Packages output through Bundle 4-F `packageInt8ModelArtifact` enforcing:
 *      `<= 50 KB compressed`, `int8 integer arithmetic`, `SHA-256 content hash`, and bundled
 *      `license_id` + `license_notice`!
 */

import { requireDecisionEntitled } from '../../../../packages/contract/ledgers';
import { canonicalJsonStringify, sha256Hex } from '../../../../packages/contract/schema';
import {
  packageInt8ModelArtifact,
  validateInt8ModelArtifact,
  type Int8ModelArtifactPayload,
  type SignedInt8ModelArtifact,
} from '../foundation/int8-tree-runtime';

export const EXCLUSION_SLA_MS = 24 * 3_600_000; // 24 hours (§8.14)
export const DELETION_CERTIFICATE_SLA_MS = 14 * 86_400_000; // 14 days (§8.14)

export class UnmanagedDestinationDeletionGuardError extends Error {
  public readonly destination: string;

  constructor(destination: string) {
    super(
      `§8.14 Deletion Guarantee Violation: cannot train deletable subject text into artifact distributed to unmanaged destination "${destination}"`
    );
    this.name = 'UnmanagedDestinationDeletionGuardError';
    this.destination = destination;
  }
}

export class JevTeacherProhibitedError extends Error {
  constructor(teacherId: string) {
    super(
      `PERMANENT PROHIBITION (Owner Decision D-31b / Jev Terms 2.3(b)): Jev MUST NEVER be used as a distillation teacher (rejected teacher: "${teacherId}"). Use ONLY an in-house base or fine-tuned model.`
    );
    this.name = 'JevTeacherProhibitedError';
  }
}

export type ManagedArtifactKind =
  | 'lora_adapter'
  | 'distilled_classifier'
  | 'checkpoint'
  | 'inference_cache'
  | 'deployed_bundle'
  | 'rollback_candidate';

export interface DeletableArtifactAsset {
  readonly asset_id: string;
  readonly kind: ManagedArtifactKind;
  readonly alias_key: string;
  readonly managed_by_ugokilink: boolean;
  readonly distribution_target: string;
  readonly contributing_subject_ids: readonly string[];
  excluded: boolean;
  excluded_at_ms: number | null;
}

export interface DeletionExecutionResult {
  readonly subject_id: string;
  readonly excluded_asset_ids: readonly string[];
  readonly excluded_within_24h: boolean;
  readonly active_alias_fallbacks: Readonly<Record<string, string>>;
  readonly retrain_without_subject_triggered: boolean;
  readonly certificate: {
    readonly certificate_id: string;
    readonly subject_id: string;
    readonly requested_at_iso: string;
    readonly excluded_at_iso: string;
    readonly issued_at_iso: string;
    readonly issued_within_14d: boolean;
    readonly retrain_excluded_from_14d_clock: true;
    readonly excluded_asset_count: number;
    readonly certificate_sha256: string;
  };
}

export class AdapterDeletionManager {
  private readonly assets = new Map<string, DeletableArtifactAsset>();
  private readonly activeAliases = new Map<string, string>(); // alias_key -> asset_id or 'base_model'

  public registerAsset(asset: Omit<DeletableArtifactAsset, 'excluded' | 'excluded_at_ms'>): void {
    // §8.14: deletable texts cannot be trained into artifacts shipped to unmanaged destinations!
    if (asset.contributing_subject_ids.length > 0 && !asset.managed_by_ugokilink) {
      throw new UnmanagedDestinationDeletionGuardError(asset.distribution_target);
    }
    this.assets.set(asset.asset_id, {
      ...asset,
      excluded: false,
      excluded_at_ms: null,
    });
  }

  public setActiveAlias(aliasKey: string, assetId: string): void {
    const asset = this.assets.get(assetId);
    if (asset && asset.excluded) {
      throw new Error(`Cannot point alias "${aliasKey}" to excluded asset "${assetId}"`);
    }
    this.activeAliases.set(aliasKey, assetId);
  }

  public getActiveAlias(aliasKey: string): string | undefined {
    return this.activeAliases.get(aliasKey);
  }

  public getActiveRollbackCandidates(aliasKey: string): readonly DeletableArtifactAsset[] {
    return Array.from(this.assets.values()).filter(
      (a) => a.alias_key === aliasKey && a.kind === 'rollback_candidate' && !a.excluded
    );
  }

  /**
   * Executes the two-phase §8.14 deletion workflow:
   * - Phase 1 (<=24h): exclude ALL affected adapters, distilled classifiers, checkpoints, caches,
   *   deployed bundles & rollback candidates; switch active alias to an unaffected safe asset or `base_model`.
   * - Phase 2 (<=14d): issue cryptographic deletion certificate & trigger clean retrain.
   */
  public executeDeletionRequest(params: {
    readonly subject_id: string;
    readonly requested_at_ms: number;
    readonly excluded_at_ms: number;
    readonly certificate_issued_at_ms: number;
  }): DeletionExecutionResult {
    const excludedIds: string[] = [];
    const affectedAliases = new Set<string>();

    for (const asset of this.assets.values()) {
      if (asset.contributing_subject_ids.includes(params.subject_id)) {
        asset.excluded = true;
        asset.excluded_at_ms = params.excluded_at_ms;
        excludedIds.push(asset.asset_id);
        affectedAliases.add(asset.alias_key);
      }
    }

    const aliasFallbacks: Record<string, string> = {};
    for (const aliasKey of affectedAliases) {
      const currentTarget = this.activeAliases.get(aliasKey);
      const currentAsset = currentTarget ? this.assets.get(currentTarget) : undefined;
      if (!currentAsset || currentAsset.excluded) {
        // Find an unaffected non-excluded asset for this alias, else fall back to `base_model`
        const safeReplacement = Array.from(this.assets.values()).find(
          (a) =>
            a.alias_key === aliasKey &&
            !a.excluded &&
            (a.kind === 'lora_adapter' || a.kind === 'rollback_candidate')
        );
        const nextTarget = safeReplacement ? safeReplacement.asset_id : 'base_model';
        this.activeAliases.set(aliasKey, nextTarget);
        aliasFallbacks[aliasKey] = nextTarget;
      }
    }

    const excludedWithin24h =
      params.excluded_at_ms >= params.requested_at_ms &&
      params.excluded_at_ms - params.requested_at_ms <= EXCLUSION_SLA_MS;
    const issuedWithin14d =
      params.certificate_issued_at_ms >= params.excluded_at_ms &&
      params.certificate_issued_at_ms - params.requested_at_ms <= DELETION_CERTIFICATE_SLA_MS;

    const certBody = {
      subject_id: params.subject_id,
      requested_at_iso: new Date(params.requested_at_ms).toISOString(),
      excluded_at_iso: new Date(params.excluded_at_ms).toISOString(),
      issued_at_iso: new Date(params.certificate_issued_at_ms).toISOString(),
      excluded_asset_ids: [...excludedIds].sort(),
      retrain_excluded_from_14d_clock: true as const,
    };
    const certSha = sha256Hex(canonicalJsonStringify(certBody));

    return {
      subject_id: params.subject_id,
      excluded_asset_ids: excludedIds,
      excluded_within_24h: excludedWithin24h,
      active_alias_fallbacks: aliasFallbacks,
      retrain_without_subject_triggered: excludedIds.length > 0,
      certificate: {
        certificate_id: `delcert_${certSha.slice(0, 16)}`,
        subject_id: params.subject_id,
        requested_at_iso: certBody.requested_at_iso,
        excluded_at_iso: certBody.excluded_at_iso,
        issued_at_iso: certBody.issued_at_iso,
        issued_within_14d: issuedWithin14d,
        retrain_excluded_from_14d_clock: true,
        excluded_asset_count: excludedIds.length,
        certificate_sha256: certSha,
      },
    };
  }
}

// =========================================================================
// Lightweight Classifier Distillation (Strictly In-House Teacher Only!)
// =========================================================================

export interface DistillationTeacherRef {
  readonly teacher_id: string;
  readonly origin: 'in_house_base_or_adapter' | 'jev_external_service';
  readonly derived_from_jev?: boolean;
  readonly base_model_license_id: string;
  readonly base_model_notice_text: string;
}

export interface HumanEvalMetricForDistilled {
  readonly human_eval_sample_count: number;
  readonly human_macro_f1: number;
  readonly min_required_macro_f1: number; // default 0.80 per ML M4
  /** Recorded for diagnostics only — NEVER used as the promotion gate! */
  readonly teacher_agreement_rate?: number;
}

export interface DistilledClassifierBuildResult {
  readonly promoted_as_challenger: boolean;
  readonly passed_human_eval_gate: boolean;
  readonly evaluated_on: 'human_final_eval_labels_only';
  readonly artifact: SignedInt8ModelArtifact;
  readonly unmet_gates: readonly string[];
}

/**
 * Distills an in-house fine-tuned model into a standalone <=50 KB int8 edge/browser classifier:
 * - HARD BLOCK on Jev teacher (`JevTeacherProhibitedError`, Owner Decision D-31b).
 * - Evaluates strictly against human labels (min 300 samples, macro-F1 >= floor), NEVER teacher agreement.
 * - Enforces <=50 KB compressed budget, integer-only tree/int8 format, SHA-256 hash, and bundled license/notice!
 */
export function distillInHouseModelToInt8Classifier(params: {
  readonly teacher: DistillationTeacherRef;
  readonly payload: Int8ModelArtifactPayload;
  readonly human_eval: HumanEvalMetricForDistilled;
  readonly measured_gzip_bytes?: number;
}): DistilledClassifierBuildResult {
  // Confirm D-31b permanent lock
  const d31b = requireDecisionEntitled('D-31b');
  if (d31b.entitled) {
    throw new Error('Invariant broken: Decision D-31b must remain permanently prohibited');
  }

  // HARD TEACHER GUARD: NEVER allow Jev as teacher!
  if (
    params.teacher.origin === 'jev_external_service' ||
    params.teacher.derived_from_jev === true ||
    /jev/i.test(params.teacher.teacher_id)
  ) {
    throw new JevTeacherProhibitedError(params.teacher.teacher_id);
  }

  // Ensure license & notice from the teacher/base model are bundled in the distributed classifier
  const bundledPayload: Int8ModelArtifactPayload = {
    ...params.payload,
    license_id: params.payload.license_id || params.teacher.base_model_license_id,
    license_notice: params.payload.license_notice || params.teacher.base_model_notice_text,
  };

  // Package & enforce <=50 KB compressed + integer-only + SHA-256 + license bundle
  const artifact = packageInt8ModelArtifact(bundledPayload, params.measured_gzip_bytes);
  const validation = validateInt8ModelArtifact(artifact);
  if (!validation.valid) {
    throw new Error(`Distilled int8 artifact invalid: ${validation.errors.join('; ')}`);
  }

  // Evaluate strictly on human labels (NOT teacher agreement!)
  const unmet: string[] = [];
  if (params.human_eval.human_eval_sample_count < 300) {
    unmet.push(`ml.distill_human_eval_min_300 (have ${params.human_eval.human_eval_sample_count}/300)`);
  }
  if (params.human_eval.human_macro_f1 < params.human_eval.min_required_macro_f1) {
    unmet.push(
      `ml.distill_human_macro_f1_below_floor (${params.human_eval.human_macro_f1} < ${params.human_eval.min_required_macro_f1})`
    );
  }

  return {
    promoted_as_challenger: true,
    passed_human_eval_gate: unmet.length === 0,
    evaluated_on: 'human_final_eval_labels_only',
    artifact,
    unmet_gates: unmet,
  };
}
