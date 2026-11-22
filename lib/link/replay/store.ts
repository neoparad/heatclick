/**
 * UGOKI LINK v2 — Object-Storage-Only Replay Store, Per-Tenant AES-256-GCM Encryption with AAD,
 * Sensitive-Page Hard Reject, Lazy Loader Sampling, >=50-PV K-Anon Selection & Single-Use Handles (§11.11 item 8)
 *
 * Invariants:
 *   - Stored EXCLUSIVELY in object storage (R2/S3 interface); NEVER loaded into ClickHouse 8 GiB RAM.
 *   - Hard-rejects (`status: 'blocked_sensitive_page'`) any snapshot where `detectedSensitiveFieldOnPage === true`
 *     and zeroes any caller-supplied buffer ([H-13]).
 *   - Binds `(tenantId, siteId, pvId, chunkSeq)` into AES-256-GCM `additionalData` (`aad`) on both
 *     encrypt and decrypt so ciphertext chunks can never be transplanted across tenants, sites, PVs, or chunk sequences ([H-13]).
 *   - Playback handles are strictly single-use (`consumed: true` on first redeem; second attempt returns 403 / `snapshot: null`) ([H-13]).
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { canonicalJson, sha256Hex } from '@/packages/contract/response';
import { drawUniformU } from '@/lib/link/allocator';
import {
  REPLAY_LANE,
  evaluateReplayEntitlement,
  type ReplaySitePolicy,
  type ReplayVisitContext,
} from './entitlement';
import type { MaskedReplaySnapshot } from './masker';

export const DEFAULT_REPLAY_RETENTION_DAYS = 30;
export const MIN_REPLAY_FILTER_PVS = 50;

// =========================================================================
// 1. Authenticated Wire Encryption (Gzip + AES-256-GCM + Mandatory AAD)
// =========================================================================

export interface ReplayAadContext {
  readonly tenantId: string;
  readonly siteId: string;
  readonly pvId: string;
  readonly chunkSeq: number;
}

export interface EncryptedReplayEnvelope {
  readonly algorithm: 'gzip+aes-256-gcm';
  readonly keyVersion: string;
  readonly ivHex: string;
  readonly authTagHex: string;
  readonly ciphertextBase64: string;
}

export function buildReplayAadBytes(aad: ReplayAadContext): Buffer {
  if (
    !aad ||
    typeof aad.tenantId !== 'string' ||
    aad.tenantId.trim().length === 0 ||
    typeof aad.siteId !== 'string' ||
    aad.siteId.trim().length === 0 ||
    typeof aad.pvId !== 'string' ||
    aad.pvId.trim().length === 0 ||
    typeof aad.chunkSeq !== 'number' ||
    !Number.isInteger(aad.chunkSeq) ||
    aad.chunkSeq < 0
  ) {
    throw new Error(
      'AES-256-GCM replay AAD requires non-empty (tenantId, siteId, pvId) and non-negative integer chunkSeq'
    );
  }
  return Buffer.from(
    `ugk-replay-aad/1|${aad.tenantId}|${aad.siteId}|${aad.pvId}|${aad.chunkSeq}`,
    'utf8'
  );
}

export function encryptReplayPayload(
  payload: unknown,
  tenantKey32Bytes: Buffer,
  keyVersion: string,
  aadContext: ReplayAadContext
): EncryptedReplayEnvelope {
  if (tenantKey32Bytes.length !== 32) {
    throw new Error('AES-256-GCM requires a 32-byte key');
  }
  const aadBytes = buildReplayAadBytes(aadContext);
  const jsonBytes = Buffer.from(canonicalJson(payload), 'utf8');
  const compressed = zlib.gzipSync(jsonBytes, { level: 6 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tenantKey32Bytes, iv);
  cipher.setAAD(aadBytes);
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
  tenantKey32Bytes: Buffer,
  expectedAadContext: ReplayAadContext
): { readonly rawDecodedText: string; readonly parsed: T } {
  if (tenantKey32Bytes.length !== 32) {
    throw new Error('AES-256-GCM requires a 32-byte key');
  }
  const aadBytes = buildReplayAadBytes(expectedAadContext);
  const iv = Buffer.from(envelope.ivHex, 'hex');
  const authTag = Buffer.from(envelope.authTagHex, 'hex');
  const ciphertext = Buffer.from(envelope.ciphertextBase64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', tenantKey32Bytes, iv);
  decipher.setAAD(aadBytes);
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
  readonly ok: true;
  readonly status: 'stored';
  readonly stored: true;
  readonly replayId: string;
  readonly objectKey: string;
  readonly lane: typeof REPLAY_LANE;
  readonly storageBackend: 'object_storage_r2';
  readonly usesClickHouseMemory: false;
  readonly tenantId: string;
  readonly siteId: string;
  readonly pvId: string;
  readonly chunkSeq: number;
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

export interface BlockedSensitiveReplayResult {
  readonly ok: false;
  readonly status: 'blocked_sensitive_page';
  readonly stored: false;
  readonly reason: string;
  readonly bufferZeroed: boolean;
}

export type PutReplayResult = ReplayObjectMetadata | BlockedSensitiveReplayResult;

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
  consumed: boolean;
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
    readonly pvId?: string;
    readonly chunkSeq?: number;
    readonly subjectKeyHash: string;
    readonly snapshot: MaskedReplaySnapshot;
    readonly encoding: 'delta' | 'full_masked_snapshot';
    readonly tenantKey32Bytes: Buffer;
    readonly keyVersion: string;
    readonly rawBufferToZero?: Uint8Array | Buffer;
    readonly retentionDays?: number;
    readonly deletionGeneration?: number;
    readonly now?: Date;
  }): PutReplayResult {
    // [H-13] Hard-reject storing any replay from a page containing payment/card/password/SSN/health fields!
    if (params.snapshot.detectedSensitiveFieldOnPage) {
      if (params.rawBufferToZero) {
        params.rawBufferToZero.fill(0);
      }
      if (params.pvId) {
        for (const existing of this.metadata.values()) {
          if (
            existing.tenantId === params.tenantId &&
            existing.siteId === params.siteId &&
            existing.pvId === params.pvId &&
            !existing.deleted
          ) {
            existing.deleted = true;
            this.objects.delete(existing.objectKey);
          }
        }
      }
      return {
        ok: false,
        status: 'blocked_sensitive_page',
        stored: false,
        reason:
          'Sensitive payment, card, password, SSN, or health field detected on page; replay rejected and buffer zeroed',
        bufferZeroed: Boolean(params.rawBufferToZero),
      };
    }

    const now = params.now ?? new Date();
    const retentionDays = params.retentionDays ?? DEFAULT_REPLAY_RETENTION_DAYS;
    const replayId = `rpl_${crypto.randomBytes(10).toString('hex')}`;
    const pvId = params.pvId ?? replayId;
    const chunkSeq = params.chunkSeq ?? 0;
    const objectKey = `replays/v1/${params.tenantId}/${params.siteId}/${now.toISOString().slice(0, 10)}/${replayId}.enc.gz`;

    const encrypted = encryptReplayPayload(
      params.snapshot,
      params.tenantKey32Bytes,
      params.keyVersion,
      {
        tenantId: params.tenantId,
        siteId: params.siteId,
        pvId,
        chunkSeq,
      }
    );

    const meta: ReplayObjectMetadata = {
      ok: true,
      status: 'stored',
      stored: true,
      replayId,
      objectKey,
      lane: REPLAY_LANE,
      storageBackend: 'object_storage_r2',
      usesClickHouseMemory: false,
      tenantId: params.tenantId,
      siteId: params.siteId,
      pvId,
      chunkSeq,
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
   * Issues per-answer single-use disposable opaque handles bound to `(tenantId, siteId, answerNonce)`.
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
        consumed: false,
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
    | { readonly ok: false; readonly httpStatus: 403 | 404 | 410; readonly snapshot: null; readonly code: string } {
    const now = params.now ?? new Date();
    const binding = this.handles.get(params.handle);
    if (!binding || binding.tenantId !== params.tenantId || binding.siteId !== params.siteId) {
      return { ok: false, httpStatus: 404, snapshot: null, code: 'HANDLE_NOT_FOUND' };
    }
    if (binding.consumed) {
      return { ok: false, httpStatus: 403, snapshot: null, code: 'HANDLE_ALREADY_CONSUMED' };
    }
    if (now.getTime() > binding.expiresAtMs) {
      return { ok: false, httpStatus: 410, snapshot: null, code: 'HANDLE_EXPIRED' };
    }
    const meta = this.metadata.get(binding.replayId);
    if (!meta || meta.deleted) {
      return { ok: false, httpStatus: 404, snapshot: null, code: 'REPLAY_ERASED_OR_MISSING' };
    }
    if (new Date(meta.retentionExpiresAt).getTime() <= now.getTime()) {
      return { ok: false, httpStatus: 410, snapshot: null, code: 'REPLAY_RETENTION_EXPIRED' };
    }
    const enc = this.objects.get(meta.objectKey);
    if (!enc) {
      return { ok: false, httpStatus: 404, snapshot: null, code: 'OBJECT_PURGED' };
    }

    try {
      const { parsed } = decryptReplayPayload<MaskedReplaySnapshot>(enc, params.tenantKey32Bytes, {
        tenantId: params.tenantId,
        siteId: params.siteId,
        pvId: meta.pvId,
        chunkSeq: meta.chunkSeq,
      });
      // Mark single-use handle consumed strictly on first redeem ([H-13])
      binding.consumed = true;
      return { ok: true, metadata: meta, snapshot: parsed };
    } catch {
      return { ok: false, httpStatus: 403, snapshot: null, code: 'AAD_AUTH_TAG_MISMATCH' };
    }
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
      if (tenantId === meta.tenantId && meta.subjectKeyHash === subjectKeyHash && this.objects.has(meta.objectKey)) {
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
