/**
 * UGOKI LINK v2 — Object-Storage-Only Replay Store, Per-Tenant AES-256-GCM Encryption,
 * Lazy Loader Sampling, >=50-PV K-Anon Selection & 14-Day Deletion (§11.11 item 8)
 *
 * Invariants:
 *   - Stored EXCLUSIVELY in object storage (R2/S3 interface); NEVER loaded into ClickHouse 8 GiB RAM.
 *   - Default retention = 30 days.
 *   - Separate billing meter (`replay_sessions`); never mixed into billable PVs.
 *   - Lazy recorder loader activates ONLY when entitled AND sampled-in.
 *   - Selection requires filter match >= 50 PVs (`MIN_REPLAY_FILTER_PVS = 50`) and emits
 *     per-answer disposable opaque handles.
 *   - Registered in 14-day deletion plan with immediate logical hide + physical object purge.
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { canonicalJson, sha256Hex } from '@/packages/contract/response';
import { drawUniformU } from '@/lib/link/allocator';
import { REPLAY_LANE, evaluateReplayEntitlement, type ReplaySitePolicy, type ReplayVisitContext } from './entitlement';
import type { MaskedReplaySnapshot } from './masker';

export const DEFAULT_REPLAY_RETENTION_DAYS = 30;
export const MIN_REPLAY_FILTER_PVS = 50;

// =========================================================================
// 1. Authenticated Wire Encryption (Gzip + AES-256-GCM)
// =========================================================================

export interface EncryptedReplayEnvelope {
  readonly algorithm: 'gzip+aes-256-gcm';
  readonly keyVersion: string;
  readonly ivHex: string;
  readonly authTagHex: string;
  readonly ciphertextBase64: string;
}

export function encryptReplayPayload(
  payload: unknown,
  tenantKey32Bytes: Buffer,
  keyVersion: string
): EncryptedReplayEnvelope {
  if (tenantKey32Bytes.length !== 32) {
    throw new Error('AES-256-GCM requires a 32-byte key');
  }
  const jsonBytes = Buffer.from(canonicalJson(payload), 'utf8');
  const compressed = zlib.gzipSync(jsonBytes, { level: 6 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tenantKey32Bytes, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    algorithm: 'gzip+aes-256-gcm',
    keyVersion,
    ivHex: iv.toString('hex'),
    authTagHex: authTag.toString('hex'),
    ciphertextBase64: ciphertext.toString('base64'),
  };
}

export function decryptReplayPayload<T = unknown>(
  envelope: EncryptedReplayEnvelope,
  tenantKey32Bytes: Buffer
): { readonly rawDecodedText: string; readonly parsed: T } {
  const iv = Buffer.from(envelope.ivHex, 'hex');
  const authTag = Buffer.from(envelope.authTagHex, 'hex');
  const ciphertext = Buffer.from(envelope.ciphertextBase64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', tenantKey32Bytes, iv);
  decipher.setAuthTag(authTag);
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const decompressed = zlib.gunzipSync(compressed);
  const rawDecodedText = decompressed.toString('utf8');
  return {
    rawDecodedText,
    parsed: JSON.parse(rawDecodedText) as T,
  };
}

// =========================================================================
// 2. Lazy Loader Sampling Decision (Zero Cost on Non-Sampled Visits)
// =========================================================================

export function shouldLazyLoadReplayRecorder(params: {
  readonly site: ReplaySitePolicy;
  readonly visit: ReplayVisitContext;
  readonly pvId: string;
  readonly samplingSalt: string;
}): { readonly loadRecorder: boolean; readonly reason: string; readonly drawU?: number } {
  const ent = evaluateReplayEntitlement(params.site, params.visit);
  if (!ent.allowed) {
    return { loadRecorder: false, reason: ent.code };
  }
  const rate = Math.min(Math.max(0, params.site.sampleRate), 1);
  if (rate <= 0) {
    return { loadRecorder: false, reason: 'SAMPLE_RATE_ZERO' };
  }
  const u = drawUniformU(`${params.samplingSalt}:replay:${params.site.siteId}`, params.pvId);
  if (u >= rate) {
    return { loadRecorder: false, reason: 'NOT_SAMPLED', drawU: u };
  }
  return { loadRecorder: true, reason: 'SAMPLED_IN', drawU: u };
}

// =========================================================================
// 3. Object-Storage-Only Store & Deletion Plan Registry
// =========================================================================

export interface ReplayObjectMetadata {
  readonly replayId: string;
  readonly objectKey: string;
  readonly lane: typeof REPLAY_LANE;
  readonly storageBackend: 'object_storage_r2';
  readonly usesClickHouseMemory: false;
  readonly tenantId: string;
  readonly siteId: string;
  readonly subjectKeyHash: string;
  readonly keyVersion: string;
  readonly purpose: 'screen_replay';
  readonly deletionGeneration: number;
  readonly encoding: 'delta' | 'full_masked_snapshot';
  readonly recordedAt: string;
  readonly retentionExpiresAt: string;
  readonly unreproducibleRegionCount: number;
  deleted: boolean;
}

export interface DisposableReplayHandle {
  readonly handle: string;
  readonly expiresAt: string;
  readonly recordedAt: string;
  readonly encoding: 'delta' | 'full_masked_snapshot';
  readonly unreproducibleRegionCount: number;
}

interface StoredHandleBinding {
  readonly replayId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly expiresAtMs: number;
}

export class ReplayObjectStore {
  private readonly objects = new Map<string, EncryptedReplayEnvelope>();
  private readonly metadata = new Map<string, ReplayObjectMetadata>();
  private readonly handles = new Map<string, StoredHandleBinding>();
  private readonly handleSecret: string;

  constructor(handleSecret = crypto.randomBytes(32).toString('hex')) {
    this.handleSecret = handleSecret;
  }

  public putReplay(params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly subjectKeyHash: string;
    readonly snapshot: MaskedReplaySnapshot;
    readonly encoding: 'delta' | 'full_masked_snapshot';
    readonly tenantKey32Bytes: Buffer;
    readonly keyVersion: string;
    readonly retentionDays?: number;
    readonly deletionGeneration?: number;
    readonly now?: Date;
  }): ReplayObjectMetadata {
    const now = params.now ?? new Date();
    const retentionDays = params.retentionDays ?? DEFAULT_REPLAY_RETENTION_DAYS;
    const replayId = `rpl_${crypto.randomBytes(10).toString('hex')}`;
    const objectKey = `replays/v1/${params.tenantId}/${params.siteId}/${now.toISOString().slice(0, 10)}/${replayId}.enc.gz`;

    const encrypted = encryptReplayPayload(params.snapshot, params.tenantKey32Bytes, params.keyVersion);
    const meta: ReplayObjectMetadata = {
      replayId,
      objectKey,
      lane: REPLAY_LANE,
      storageBackend: 'object_storage_r2',
      usesClickHouseMemory: false,
      tenantId: params.tenantId,
      siteId: params.siteId,
      subjectKeyHash: params.subjectKeyHash,
      keyVersion: params.keyVersion,
      purpose: 'screen_replay',
      deletionGeneration: params.deletionGeneration ?? 1,
      encoding: params.encoding,
      recordedAt: now.toISOString(),
      retentionExpiresAt: new Date(now.getTime() + retentionDays * 86_400_000).toISOString(),
      unreproducibleRegionCount: params.snapshot.unreproducibleRegions.length,
      deleted: false,
    };

    this.objects.set(objectKey, encrypted);
    this.metadata.set(replayId, meta);
    return meta;
  }

  /**
   * Lists replay handles ONLY when the matching filter cohort has >= 50 PVs (§11.11.8).
   * Issues per-answer disposable opaque handles bound to `(tenantId, siteId, answerNonce)`.
   */
  public selectReplaysForFilter(params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly matchedFilterPvCount: number;
    readonly handleTtlMs?: number;
    readonly now?: Date;
  }):
    | { readonly ok: true; readonly handles: ReadonlyArray<DisposableReplayHandle> }
    | { readonly ok: false; readonly status: 'suppressed'; readonly code: 'FILTER_BELOW_50_PV_FLOOR'; readonly reason: string } {
    const now = params.now ?? new Date();
    if (params.matchedFilterPvCount < MIN_REPLAY_FILTER_PVS) {
      return {
        ok: false,
        status: 'suppressed',
        code: 'FILTER_BELOW_50_PV_FLOOR',
        reason: `Replay filter matched ${params.matchedFilterPvCount} PVs (< ${MIN_REPLAY_FILTER_PVS} k-anonymity floor)`,
      };
    }

    const ttlMs = params.handleTtlMs ?? 15 * 60 * 1000;
    const answerNonce = crypto.randomBytes(12).toString('hex');
    const expiresAtMs = now.getTime() + ttlMs;
    const expiresAt = new Date(expiresAtMs).toISOString();

    const handles: DisposableReplayHandle[] = [];
    for (const meta of this.metadata.values()) {
      if (meta.tenantId !== params.tenantId || meta.siteId !== params.siteId) continue;
      if (meta.deleted) continue;
      if (new Date(meta.retentionExpiresAt).getTime() <= now.getTime()) continue;

      const handle = `rph_${crypto
        .createHmac('sha256', this.handleSecret)
        .update(`${params.tenantId}:${params.siteId}:${meta.replayId}:${answerNonce}`)
        .digest('hex')
        .slice(0, 24)}`;

      this.handles.set(handle, {
        replayId: meta.replayId,
        tenantId: meta.tenantId,
        siteId: meta.siteId,
        expiresAtMs,
      });

      handles.push({
        handle,
        expiresAt,
        recordedAt: meta.recordedAt,
        encoding: meta.encoding,
        unreproducibleRegionCount: meta.unreproducibleRegionCount,
      });
    }

    return { ok: true, handles };
  }

  public fetchByHandle(params: {
    readonly handle: string;
    readonly tenantId: string;
    readonly siteId: string;
    readonly tenantKey32Bytes: Buffer;
    readonly now?: Date;
  }):
    | { readonly ok: true; readonly metadata: ReplayObjectMetadata; readonly snapshot: MaskedReplaySnapshot }
    | { readonly ok: false; readonly httpStatus: 404 | 410; readonly code: string } {
    const now = params.now ?? new Date();
    const binding = this.handles.get(params.handle);
    if (!binding || binding.tenantId !== params.tenantId || binding.siteId !== params.siteId) {
      return { ok: false, httpStatus: 404, code: 'HANDLE_NOT_FOUND' };
    }
    if (now.getTime() > binding.expiresAtMs) {
      return { ok: false, httpStatus: 410, code: 'HANDLE_EXPIRED' };
    }
    const meta = this.metadata.get(binding.replayId);
    if (!meta || meta.deleted) {
      return { ok: false, httpStatus: 404, code: 'REPLAY_ERASED_OR_MISSING' };
    }
    if (new Date(meta.retentionExpiresAt).getTime() <= now.getTime()) {
      return { ok: false, httpStatus: 410, code: 'REPLAY_RETENTION_EXPIRED' };
    }
    const enc = this.objects.get(meta.objectKey);
    if (!enc) {
      return { ok: false, httpStatus: 404, code: 'OBJECT_PURGED' };
    }
    const { parsed } = decryptReplayPayload<MaskedReplaySnapshot>(enc, params.tenantKey32Bytes);
    return { ok: true, metadata: meta, snapshot: parsed };
  }

  /**
   * 14-day deletion plan purge: immediately marks metadata deleted, physically wipes encrypted object,
   * invalidates active handles, and emits a verifiable deletion receipt.
   */
  public purgeSubjectReplays(
    tenantId: string,
    subjectKeyHash: string,
    now: Date = new Date()
  ): {
    readonly purgedReplayIds: ReadonlyArray<string>;
    readonly residualObjects: number;
    readonly receiptSha256: string;
  } {
    const purged: string[] = [];
    for (const meta of this.metadata.values()) {
      if (meta.tenantId === tenantId && meta.subjectKeyHash === subjectKeyHash && !meta.deleted) {
        meta.deleted = true;
        this.objects.delete(meta.objectKey);
        purged.push(meta.replayId);
      }
    }
    for (const [h, b] of this.handles.entries()) {
      if (b.tenantId === tenantId && purged.includes(b.replayId)) {
        this.handles.delete(h);
      }
    }

    let residual = 0;
    for (const meta of this.metadata.values()) {
      if (meta.tenantId === tenantId && meta.subjectKeyHash === subjectKeyHash && this.objects.has(meta.objectKey)) {
        residual += 1;
      }
    }

    return {
      purgedReplayIds: purged,
      residualObjects: residual,
      receiptSha256: sha256Hex(canonicalJson({ tenantId, subjectKeyHash, purged, purgedAt: now.toISOString() })),
    };
  }

  public countBillableReplaySessions(tenantId: string, siteId: string): number {
    let count = 0;
    for (const meta of this.metadata.values()) {
      if (meta.tenantId === tenantId && meta.siteId === siteId && !meta.deleted) {
        count += 1;
      }
    }
    return count;
  }
}
