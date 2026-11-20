/**
 * UGOKI LINK v2 — ML Foundation: Model Registry, Deletion Propagation & Container Compute Contract
 *
 * Implements §8.10, §5.7, ML M10:
 * - Content-addressed Model Registry (`artifact_sha256`, `feature_set_version`, `label_contract_version`,
 *   `dataset_id`, `deletion_generation`, `code_version`, `runtime_env`, `seed`, `license_notice`).
 * - Training data extraction & deletion propagation (8-day expiry OR re-encrypt/rewrite with key
 *   tracking to feed the 14-day deletion certificate).
 * - Inngest-orchestrated Container GPU/CPU job contract with a HARD guard blocking training or
 *   heavy recomputation on CRAWL's small VPS or on production ClickHouse (§8.10).
 */

import { canonicalJsonStringify, sha256Hex } from '../../../../packages/contract/schema';

export type ComputeExecutionTarget =
  | 'cloud_run_cpu_job'
  | 'external_gpu_container'
  | 'crawl_vps'
  | 'clickhouse_prod';

export interface ModelArtifactLicenseBundle {
  readonly license_id: string; // e.g. 'Apache-2.0', 'Gemma-4-Terms'
  readonly notice_text: string;
  readonly distribution_scope: 'server_only' | 'edge_and_browser_classifier';
}

export interface ModelRegistryEntry {
  readonly model_version_id: string;
  readonly model_family: string;
  readonly tenant_scope: string; // tenant_id or 'shared_own_sites' or 'shared_opted_in'
  readonly artifact_sha256: string;
  readonly abi_version: number;
  readonly feature_set_version: string;
  readonly label_contract_version: string;
  readonly dataset_id: string;
  readonly deletion_generation: number;
  readonly code_version: string;
  readonly runtime_env: string;
  readonly seed: number;
  readonly license_bundle: ModelArtifactLicenseBundle;
  readonly created_at_iso: string;
  readonly status: 'challenger' | 'champion' | 'rolled_back' | 'excluded_for_deletion';
  readonly contributing_subject_ids: readonly string[];
}

export interface TrainingExtractionRecord {
  readonly extraction_id: string;
  readonly tenant_id: string;
  readonly dataset_id: string;
  readonly deletion_generation: number;
  readonly created_at_ms: number;
  /** §8.10: training extracts expire in <= 8 days OR carry a re-writable key version. */
  readonly expires_at_ms: number;
  readonly encryption_key_version: string | null;
  readonly subject_ids: readonly string[];
  deleted: boolean;
  rewritten_for_deletion_gen: number | null;
}

export class ProhibitedComputeTargetError extends Error {
  public readonly target: ComputeExecutionTarget;

  constructor(target: ComputeExecutionTarget) {
    super(
      `§8.10 Compute Isolation Violation: ML training / heavy recomputation is FORBIDDEN on "${target}". Use "cloud_run_cpu_job" or "external_gpu_container" orchestrated by Inngest.`
    );
    this.name = 'ProhibitedComputeTargetError';
    this.target = target;
  }
}

export interface InngestTrainingJobSpec {
  readonly job_id: string;
  readonly inngest_event_name: 'ml/train.requested' | 'ml/recompute.requested';
  readonly tenant_concurrency_key: string;
  readonly compute_target: ComputeExecutionTarget;
  readonly dataset_id: string;
  readonly feature_set_version: string;
  readonly label_contract_version: string;
  readonly deletion_generation: number;
  readonly seed: number;
  readonly max_cost_usd: number;
  readonly challenger_only: true;
  readonly region: string;
}

export const MAX_TRAINING_EXTRACT_TTL_MS = 8 * 86_400_000; // 8 days (§5.7 / §8.10)

/**
 * Validates an Inngest container training/recompute job contract (§8.10):
 * - Physically forbids `crawl_vps` and `clickhouse_prod`.
 * - Enforces `challenger_only: true` and positive cost cap.
 */
export function validateTrainingJobContract(spec: InngestTrainingJobSpec): {
  readonly valid: true;
  readonly contract_hash: string;
} {
  if (spec.compute_target === 'crawl_vps' || spec.compute_target === 'clickhouse_prod') {
    throw new ProhibitedComputeTargetError(spec.compute_target);
  }
  if (!spec.challenger_only) {
    throw new Error('ML training jobs MUST run as challenger_only: true (cannot overwrite alias directly)');
  }
  if (!Number.isFinite(spec.max_cost_usd) || spec.max_cost_usd <= 0) {
    throw new Error('Training job requires a positive max_cost_usd budget cap');
  }
  if (!spec.tenant_concurrency_key || !spec.region) {
    throw new Error('Training job requires tenant_concurrency_key and pinned region');
  }

  return {
    valid: true,
    contract_hash: sha256Hex(canonicalJsonStringify(spec)),
  };
}

export interface DeletionPropagationSummary {
  readonly subject_id: string;
  readonly new_deletion_generation: number;
  readonly expired_or_purged_extractions: readonly string[];
  readonly rewritten_extractions: readonly string[];
  readonly excluded_model_versions: readonly string[];
  readonly certificate_deadline_iso: string;
}

export class MlModelRegistry {
  private readonly entries = new Map<string, ModelRegistryEntry>();
  private readonly aliases = new Map<string, string>(); // alias_key -> model_version_id
  private readonly extractions = new Map<string, TrainingExtractionRecord>();
  private deletionGeneration = 1;

  public getDeletionGeneration(): number {
    return this.deletionGeneration;
  }

  public registerModelVersion(entry: ModelRegistryEntry): ModelRegistryEntry {
    if (!/^[0-9a-f]{64}$/i.test(entry.artifact_sha256)) {
      throw new Error(`Invalid artifact_sha256 "${entry.artifact_sha256}"`);
    }
    if (!entry.license_bundle.license_id || !entry.license_bundle.notice_text) {
      throw new Error('Model registry entry MUST bundle license_id and notice_text (§8.14)');
    }
    this.entries.set(entry.model_version_id, { ...entry });
    return entry;
  }

  public getModelVersion(modelVersionId: string): ModelRegistryEntry | undefined {
    return this.entries.get(modelVersionId);
  }

  public setAlias(aliasKey: string, modelVersionId: string): void {
    const entry = this.entries.get(modelVersionId);
    if (!entry) {
      throw new Error(`Cannot point alias "${aliasKey}" to unknown model "${modelVersionId}"`);
    }
    if (entry.status === 'excluded_for_deletion') {
      throw new Error(
        `Cannot point alias "${aliasKey}" to model "${modelVersionId}" excluded for deletion`
      );
    }
    this.aliases.set(aliasKey, modelVersionId);
    this.entries.set(modelVersionId, { ...entry, status: 'champion' });
  }

  public resolveAlias(aliasKey: string): ModelRegistryEntry | undefined {
    const id = this.aliases.get(aliasKey);
    return id ? this.entries.get(id) : undefined;
  }

  public registerExtraction(params: {
    readonly extraction_id: string;
    readonly tenant_id: string;
    readonly dataset_id: string;
    readonly created_at_ms: number;
    readonly ttl_ms?: number;
    readonly encryption_key_version?: string | null;
    readonly subject_ids: readonly string[];
  }): TrainingExtractionRecord {
    const ttl = Math.min(params.ttl_ms ?? MAX_TRAINING_EXTRACT_TTL_MS, MAX_TRAINING_EXTRACT_TTL_MS);
    const rec: TrainingExtractionRecord = {
      extraction_id: params.extraction_id,
      tenant_id: params.tenant_id,
      dataset_id: params.dataset_id,
      deletion_generation: this.deletionGeneration,
      created_at_ms: params.created_at_ms,
      expires_at_ms: params.created_at_ms + ttl,
      encryption_key_version: params.encryption_key_version ?? null,
      subject_ids: [...params.subject_ids],
      deleted: false,
      rewritten_for_deletion_gen: null,
    };
    this.extractions.set(rec.extraction_id, rec);
    return rec;
  }

  /**
   * Propagates a deletion request across training extractions & registered models (§5.7 / §8.10):
   * - Bumps `deletion_generation`
   * - Purges expired (>8d) extractions or marks keyed extractions rewritten at new generation
   * - Marks any model version trained on `subjectId` as `excluded_for_deletion` and clears aliases.
   */
  public propagateDeletion(subjectId: string, nowMs: number): DeletionPropagationSummary {
    this.deletionGeneration += 1;
    const expiredOrPurged: string[] = [];
    const rewritten: string[] = [];
    const excludedModels: string[] = [];

    for (const ext of this.extractions.values()) {
      if (ext.deleted) continue;
      const isExpired = nowMs >= ext.expires_at_ms;
      const containsSubject = ext.subject_ids.includes(subjectId);
      if (isExpired || (containsSubject && !ext.encryption_key_version)) {
        ext.deleted = true;
        expiredOrPurged.push(ext.extraction_id);
      } else if (containsSubject && ext.encryption_key_version) {
        ext.rewritten_for_deletion_gen = this.deletionGeneration;
        rewritten.push(ext.extraction_id);
      }
    }

    for (const [id, entry] of this.entries.entries()) {
      if (entry.contributing_subject_ids.includes(subjectId)) {
        this.entries.set(id, { ...entry, status: 'excluded_for_deletion' });
        excludedModels.push(id);
        for (const [aliasKey, targetId] of this.aliases.entries()) {
          if (targetId === id) {
            this.aliases.delete(aliasKey);
          }
        }
      }
    }

    return {
      subject_id: subjectId,
      new_deletion_generation: this.deletionGeneration,
      expired_or_purged_extractions: expiredOrPurged,
      rewritten_extractions: rewritten,
      excluded_model_versions: excludedModels,
      certificate_deadline_iso: new Date(nowMs + 14 * 86_400_000).toISOString(),
    };
  }
}
