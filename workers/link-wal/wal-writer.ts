/**
 * UGOKI LINK v2 — Write-Ahead Log Consumer, Recursive Bisect Quarantine & Post-Ack Loss Detector
 *
 * Implements:
 * - Immutable content-addressed WAL objects (`wal/{region}/{shard}/{minute}/{sha256}.json`)
 * - Recursive binary-search (bisect) quarantine for poison/corrupted batches
 *   with 7-day retention, re-ingestion support, and PV-scoped deletion coverage
 * - Post-ack loss detection via `ack_echo_seq` (missing > 10 minutes after echo/ack)
 * - Decision 29 (D-29) data residency enforcement & §5.12 Tier 1/2/3 storage adapters
 */

import { getConstant } from '../../packages/contract/ledgers';
import {
  CANONICAL_SCHEMA,
  canonicalJsonStringify,
  createIngestValidator,
  sha256Hex,
  type GeneratedIngestValidator,
  type IngestValidationResult,
  type TelemetryFrame,
} from '../../packages/contract/schema';
import {
  assertRegionPinned,
  formatQuarantineObjectKey,
  formatUtcDayBucket,
  formatUtcMinuteBucket,
  formatWalObjectKey,
  LinkManagedStorageAdapter,
  type ExportNotificationReceipt,
  type StorageTierAdapter,
} from './storage-adapter';
import type {
  DataRegion,
  PostAckLossReport,
  PostAckMissingFrame,
  QuarantineObject,
  QueueBatchLike,
  R2BucketLike,
  StorageTier,
  WalObject,
  WalQueuePayload,
  WalRecord,
} from './types';

export const DEFAULT_QUARANTINE_RETENTION_DAYS = 7;
export const DEFAULT_POST_ACK_GRACE_MS = 10 * 60 * 1000; // 10 minutes (§4.5 / tel.G1)
export const DEFAULT_RETENTION_DAYS = 395; // ~13 months default grid

const DAY_MS = 86_400_000;

export interface WalWriterOptions {
  readonly region: DataRegion;
  readonly adapter?: StorageTierAdapter;
  readonly bucket?: R2BucketLike;
  readonly defaultRetentionDays?: number;
  readonly quarantineRetentionDays?: number;
  readonly deletionEpoch?: number;
  readonly postAckDetector?: PostAckLossDetector;
  readonly validator?: GeneratedIngestValidator;
}

export interface WalConsumeResult {
  readonly acceptedCount: number;
  readonly partialAcceptedCount: number;
  readonly quarantinedCount: number;
  readonly dedupedObjectsCount: number;
  readonly bisectSplits: number;
  readonly walKeys: readonly string[];
  readonly quarantineKeys: readonly string[];
  readonly exportReceipts: readonly ExportNotificationReceipt[];
  readonly writtenRecords: readonly WalRecord[];
}

export interface ReingestQuarantineOptions {
  readonly tenantId?: string;
  readonly siteId?: string;
  readonly nowMs?: number;
  readonly repair: (entry: QuarantineObject) => WalQueuePayload | null;
}

export interface ReingestQuarantineResult {
  readonly scannedCount: number;
  readonly skippedExpiredCount: number;
  readonly skippedUnrepairedCount: number;
  readonly reingestedCount: number;
  readonly stillQuarantinedCount: number;
  readonly deletedQuarantineKeys: readonly string[];
  readonly newWalKeys: readonly string[];
}

interface TrackedAckEntry {
  readonly tenantId: string;
  readonly siteId: string;
  readonly pvId: string;
  readonly seq: number;
  readonly proofSource: 'ack_echo_seq' | 'edge_ack';
  readonly firstObservedAtMs: number;
  readonly observedFromSeq: number | null;
}

function makeFrameLookupKey(
  tenantId: string,
  siteId: string,
  pvId: string,
  seq: number
): string {
  return `${tenantId}\u0000${siteId}\u0000${pvId}\u0000${seq}`;
}

/**
 * Tracks browser `ack_echo_seq` proofs and server-emitted ACKs against committed
 * WAL / `frame_log` keys. Any frame acknowledged yet absent after `graceWindowMs`
 * (default 10 minutes) is reported as confirmed post-ack loss (`tel.G1` / `store.G-2`).
 */
export class PostAckLossDetector {
  private readonly committedFrames = new Set<string>();
  private readonly trackedAcks = new Map<string, TrackedAckEntry>();
  private readonly graceWindowMs: number;
  private readonly maxAllowedRate: number;

  public constructor(options?: {
    readonly graceWindowMs?: number;
    readonly maxAllowedRate?: number;
  }) {
    this.graceWindowMs = options?.graceWindowMs ?? DEFAULT_POST_ACK_GRACE_MS;
    const ledgerEntry = getConstant('tel.post_ack_loss_max_rate');
    const ledgerRate =
      typeof ledgerEntry?.value === 'number' ? ledgerEntry.value : 0.0001;
    this.maxAllowedRate = options?.maxAllowedRate ?? ledgerRate;
  }

  public recordCommittedFrame(
    tenantId: string,
    siteId: string,
    pvId: string,
    seq: number
  ): void {
    this.committedFrames.add(makeFrameLookupKey(tenantId, siteId, pvId, seq));
  }

  public recordAckEcho(
    tenantId: string,
    siteId: string,
    pvId: string,
    ackEchoSeq: number,
    observedAtMs: number,
    observedFromSeq: number | null = null
  ): void {
    if (!Number.isInteger(ackEchoSeq) || ackEchoSeq < 0) {
      return;
    }
    const key = makeFrameLookupKey(tenantId, siteId, pvId, ackEchoSeq);
    const existing = this.trackedAcks.get(key);
    if (!existing || observedAtMs < existing.firstObservedAtMs) {
      this.trackedAcks.set(key, {
        tenantId,
        siteId,
        pvId,
        seq: ackEchoSeq,
        proofSource: 'ack_echo_seq',
        firstObservedAtMs: observedAtMs,
        observedFromSeq,
      });
    }
  }

  public recordEdgeAck(
    tenantId: string,
    siteId: string,
    pvId: string,
    seq: number,
    ackedAtMs: number
  ): void {
    if (!Number.isInteger(seq) || seq < 0) {
      return;
    }
    const key = makeFrameLookupKey(tenantId, siteId, pvId, seq);
    const existing = this.trackedAcks.get(key);
    if (!existing || ackedAtMs < existing.firstObservedAtMs) {
      this.trackedAcks.set(key, {
        tenantId,
        siteId,
        pvId,
        seq,
        proofSource: 'edge_ack',
        firstObservedAtMs: ackedAtMs,
        observedFromSeq: null,
      });
    }
  }

  public isCommitted(
    tenantId: string,
    siteId: string,
    pvId: string,
    seq: number
  ): boolean {
    return this.committedFrames.has(makeFrameLookupKey(tenantId, siteId, pvId, seq));
  }

  public evaluate(nowMs: number): PostAckLossReport {
    let confirmedPresentCount = 0;
    let pendingWithinGraceCount = 0;
    const confirmedMissing: PostAckMissingFrame[] = [];

    for (const [key, entry] of this.trackedAcks.entries()) {
      if (this.committedFrames.has(key)) {
        confirmedPresentCount += 1;
        continue;
      }
      const ageMs = nowMs - entry.firstObservedAtMs;
      if (ageMs >= this.graceWindowMs) {
        confirmedMissing.push({
          tenantId: entry.tenantId,
          siteId: entry.siteId,
          pvId: entry.pvId,
          seq: entry.seq,
          proofSource: entry.proofSource,
          firstObservedAtMs: entry.firstObservedAtMs,
          observedFromSeq: entry.observedFromSeq,
          ageSinceObservationMs: ageMs,
        });
      } else {
        pendingWithinGraceCount += 1;
      }
    }

    confirmedMissing.sort((a, b) => {
      if (a.tenantId !== b.tenantId) return a.tenantId.localeCompare(b.tenantId);
      if (a.siteId !== b.siteId) return a.siteId.localeCompare(b.siteId);
      if (a.pvId !== b.pvId) return a.pvId.localeCompare(b.pvId);
      return a.seq - b.seq;
    });

    const totalTrackedFrames = this.trackedAcks.size;
    const denominator = confirmedPresentCount + confirmedMissing.length;
    const postAckLossRate =
      denominator === 0 ? 0 : confirmedMissing.length / denominator;

    return {
      evaluatedAtMs: nowMs,
      graceWindowMs: this.graceWindowMs,
      totalTrackedFrames,
      confirmedPresentCount,
      pendingWithinGraceCount,
      confirmedMissingCount: confirmedMissing.length,
      confirmedMissing,
      postAckLossRate,
      maxAllowedRate: this.maxAllowedRate,
      gatePassed: postAckLossRate <= this.maxAllowedRate,
    };
  }
}

function sanitizeUnknownForQuarantine(input: unknown, depth = 0): unknown {
  if (depth > 4) return { type: 'truncated_depth' };
  if (input === null || input === undefined) return null;
  if (typeof input === 'string') {
    return { type: 'string', length: input.length };
  }
  if (typeof input === 'number' || typeof input === 'boolean') {
    return input;
  }
  if (Array.isArray(input)) {
    return input.slice(0, 16).map((v) => sanitizeUnknownForQuarantine(v, depth + 1));
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = sanitizeUnknownForQuarantine(v, depth + 1);
    }
    return out;
  }
  return { type: typeof input };
}

function safeExtractPvId(rawFrame: unknown): string | null {
  if (rawFrame && typeof rawFrame === 'object' && !Array.isArray(rawFrame)) {
    const candidate = (rawFrame as Record<string, unknown>).pv_id;
    if (typeof candidate === 'string' && /^[0-9a-f]{32}$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function safeExtractSeq(rawFrame: unknown): number | null {
  if (rawFrame && typeof rawFrame === 'object' && !Array.isArray(rawFrame)) {
    const candidate = (rawFrame as Record<string, unknown>).seq;
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return null;
}

function computeFrameHash(frame: TelemetryFrame): string {
  return sha256Hex(canonicalJsonStringify(frame)).slice(0, 16);
}

interface ValidatedItem {
  readonly payload: WalQueuePayload;
  readonly record: WalRecord;
}

interface FailedItem {
  readonly payload: WalQueuePayload;
  readonly reason: string;
  readonly validationResult: IngestValidationResult | null;
}

export class WalWriter {
  public readonly region: DataRegion;
  public readonly adapter: StorageTierAdapter;
  public readonly postAckDetector: PostAckLossDetector;
  private readonly validator: GeneratedIngestValidator;
  private readonly defaultRetentionDays: number;
  private readonly quarantineRetentionDays: number;
  private deletionEpoch: number;

  public constructor(options: WalWriterOptions) {
    this.region = options.region;
    if (options.adapter) {
      assertRegionPinned(options.region, options.adapter.descriptor.region);
      this.adapter = options.adapter;
    } else if (options.bucket) {
      this.adapter = new LinkManagedStorageAdapter(options.bucket, options.region);
    } else {
      throw new Error('WalWriter requires either `adapter` or `bucket`');
    }

    this.validator = options.validator ?? createIngestValidator(CANONICAL_SCHEMA);
    this.defaultRetentionDays = options.defaultRetentionDays ?? DEFAULT_RETENTION_DAYS;
    this.quarantineRetentionDays =
      options.quarantineRetentionDays ?? DEFAULT_QUARANTINE_RETENTION_DAYS;
    this.deletionEpoch = options.deletionEpoch ?? 1;
    this.postAckDetector = options.postAckDetector ?? new PostAckLossDetector();
  }

  public setDeletionEpoch(epoch: number): void {
    if (!Number.isInteger(epoch) || epoch < 1) {
      throw new Error(`Invalid deletionEpoch: ${String(epoch)}`);
    }
    this.deletionEpoch = epoch;
  }

  public getDeletionEpoch(): number {
    return this.deletionEpoch;
  }

  /**
   * Consumes a queue batch of raw frames, writing validated sub-batches to
   * immutable content-addressed WAL objects and isolating poison/corrupted items
   * via recursive binary-search (bisect) quarantine.
   */
  public async consumeBatch(
    items: readonly WalQueuePayload[],
    nowMs = Date.now()
  ): Promise<WalConsumeResult> {
    if (items.length === 0) {
      return {
        acceptedCount: 0,
        partialAcceptedCount: 0,
        quarantinedCount: 0,
        dedupedObjectsCount: 0,
        bisectSplits: 0,
        walKeys: [],
        quarantineKeys: [],
        exportReceipts: [],
        writtenRecords: [],
      };
    }

    const state = {
      acceptedCount: 0,
      partialAcceptedCount: 0,
      quarantinedCount: 0,
      dedupedObjectsCount: 0,
      bisectSplits: 0,
      walKeys: [] as string[],
      quarantineKeys: [] as string[],
      exportReceipts: [] as ExportNotificationReceipt[],
      writtenRecords: [] as WalRecord[],
    };

    await this.processSlice(items, nowMs, state);

    return state;
  }

  private validateSingleItem(
    item: WalQueuePayload,
    nowMs: number
  ): { ok: true; validated: ValidatedItem } | { ok: false; failed: FailedItem } {
    try {
      if (!item || typeof item !== 'object') {
        return {
          ok: false,
          failed: {
            payload: item,
            reason: 'invalid_queue_envelope',
            validationResult: null,
          },
        };
      }

      if (typeof item.tenant_id !== 'string' || item.tenant_id.trim().length === 0) {
        return {
          ok: false,
          failed: {
            payload: item,
            reason: 'missing_tenant_id',
            validationResult: null,
          },
        };
      }

      if (typeof item.site_id !== 'string' || item.site_id.trim().length === 0) {
        return {
          ok: false,
          failed: {
            payload: item,
            reason: 'missing_site_id',
            validationResult: null,
          },
        };
      }

      // Enforce Decision 29 region residency boundary
      try {
        assertRegionPinned(this.region, item.storage_region);
      } catch (err) {
        return {
          ok: false,
          failed: {
            payload: item,
            reason: err instanceof Error ? `region_mismatch:${err.message}` : 'region_mismatch',
            validationResult: null,
          },
        };
      }

      if (!Number.isInteger(item.shard_id) || item.shard_id < 0) {
        return {
          ok: false,
          failed: {
            payload: item,
            reason: 'invalid_shard_id',
            validationResult: null,
          },
        };
      }

      if (typeof item.received_at_ms !== 'number' || !Number.isFinite(item.received_at_ms)) {
        return {
          ok: false,
          failed: {
            payload: item,
            reason: 'invalid_received_at_ms',
            validationResult: null,
          },
        };
      }

      const rawPayload =
        typeof item.raw_frame === 'string'
          ? (JSON.parse(item.raw_frame) as unknown)
          : item.raw_frame;

      const validation = this.validator.validateIngestFrame(rawPayload, {
        serverNowMs: item.received_at_ms || nowMs,
      });

      if (!validation.accepted || !validation.sanitizedFrame) {
        return {
          ok: false,
          failed: {
            payload: item,
            reason: validation.quarantineRecord?.reason ?? 'frame_validation_rejected',
            validationResult: validation,
          },
        };
      }

      const frame = validation.sanitizedFrame;
      const frameHash = computeFrameHash(frame);
      const record: WalRecord = {
        tenant_id: item.tenant_id,
        site_id: item.site_id,
        storage_region: this.region,
        shard_id: item.shard_id,
        received_at_ms: item.received_at_ms,
        age_ms: Math.max(0, Math.floor(item.age_ms ?? 0)),
        retention_days: item.retention_days ?? this.defaultRetentionDays,
        frame,
        frame_hash: frameHash,
        partial: validation.partial,
        state_incomplete: validation.stateIncomplete,
        rej: [...validation.rej],
      };

      return { ok: true, validated: { payload: item, record } };
    } catch (err) {
      return {
        ok: false,
        failed: {
          payload: item,
          reason: err instanceof Error ? `parse_exception:${err.message}` : 'parse_exception',
          validationResult: null,
        },
      };
    }
  }

  private async processSlice(
    slice: readonly WalQueuePayload[],
    nowMs: number,
    state: {
      acceptedCount: number;
      partialAcceptedCount: number;
      quarantinedCount: number;
      dedupedObjectsCount: number;
      bisectSplits: number;
      walKeys: string[];
      quarantineKeys: string[];
      exportReceipts: ExportNotificationReceipt[];
      writtenRecords: WalRecord[];
    }
  ): Promise<void> {
    if (slice.length === 0) return;

    // Attempt full-slice validation first (fast path when batch has zero poison items)
    const validated: ValidatedItem[] = [];
    let firstFailure: FailedItem | null = null;

    for (const item of slice) {
      const check = this.validateSingleItem(item, nowMs);
      if (check.ok) {
        validated.push(check.validated);
      } else {
        firstFailure = check.failed;
        break;
      }
    }

    if (firstFailure === null) {
      // Whole slice is valid: flush grouped by (shard_id, minute_utc)
      await this.flushValidatedSlice(validated, nowMs, state);
      return;
    }

    // Binary search (bisect) to isolate poison item(s) without blocking valid neighbours
    if (slice.length > 1) {
      state.bisectSplits += 1;
      const mid = Math.floor(slice.length / 2);
      await this.processSlice(slice.slice(0, mid), nowMs, state);
      await this.processSlice(slice.slice(mid), nowMs, state);
      return;
    }

    // Leaf length === 1: quarantine the isolated poison item
    const quarantineKey = await this.writeQuarantineItem(firstFailure, nowMs);
    state.quarantinedCount += 1;
    state.quarantineKeys.push(quarantineKey);
  }

  private async flushValidatedSlice(
    validated: readonly ValidatedItem[],
    nowMs: number,
    state: {
      acceptedCount: number;
      partialAcceptedCount: number;
      dedupedObjectsCount: number;
      walKeys: string[];
      exportReceipts: ExportNotificationReceipt[];
      writtenRecords: WalRecord[];
    }
  ): Promise<void> {
    // Group by (shard_id, minute_utc) so each WAL object strictly follows wal/{region}/{shard}/{minute}/{sha256}.json
    const groups = new Map<
      string,
      { shardId: number; minuteUtc: string; items: ValidatedItem[] }
    >();

    for (const v of validated) {
      const minuteUtc = formatUtcMinuteBucket(v.record.received_at_ms);
      const groupKey = `${v.record.shard_id}\u0000${minuteUtc}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = { shardId: v.record.shard_id, minuteUtc, items: [] };
        groups.set(groupKey, group);
      }
      group.items.push(v);
    }

    for (const group of groups.values()) {
      const records = group.items.map((i) => i.record);
      const canonicalRecords = canonicalJsonStringify(records);
      const sha256 = sha256Hex(canonicalRecords);
      const walKey = formatWalObjectKey(
        this.region,
        group.shardId,
        group.minuteUtc,
        sha256
      );
      const walObject: WalObject = {
        wal_version: 1,
        region: this.region,
        shard_id: group.shardId,
        minute_utc: group.minuteUtc,
        sha256,
        created_at_ms: nowMs,
        record_count: records.length,
        records,
      };
      const body = canonicalJsonStringify(walObject);
      const tenantIds = Array.from(new Set(records.map((r) => r.tenant_id))).sort();

      const putOutcome = await this.adapter.putWalImmutable({
        key: walKey,
        body,
        tenantIds,
        deletionEpoch: this.deletionEpoch,
        nowMs,
        customMetadata: {
          shard_id: String(group.shardId),
          minute_utc: group.minuteUtc,
          record_count: String(records.length),
          wal_sha256: sha256,
        },
      });

      state.walKeys.push(walKey);
      if (putOutcome.deduped) {
        state.dedupedObjectsCount += 1;
      }
      if (putOutcome.exportReceipt) {
        state.exportReceipts.push(putOutcome.exportReceipt);
      }

      for (const item of group.items) {
        const rec = item.record;
        state.acceptedCount += 1;
        if (rec.partial) {
          state.partialAcceptedCount += 1;
        }
        state.writtenRecords.push(rec);

        // Update post-ack loss detector for committed frame and browser ack_echo_seq
        this.postAckDetector.recordCommittedFrame(
          rec.tenant_id,
          rec.site_id,
          rec.frame.pv_id,
          rec.frame.seq
        );
        if (rec.frame.ack_echo_seq >= 0) {
          this.postAckDetector.recordAckEcho(
            rec.tenant_id,
            rec.site_id,
            rec.frame.pv_id,
            rec.frame.ack_echo_seq,
            rec.received_at_ms,
            rec.frame.seq
          );
        }
        if (item.payload.edge_acked) {
          this.postAckDetector.recordEdgeAck(
            rec.tenant_id,
            rec.site_id,
            rec.frame.pv_id,
            rec.frame.seq,
            rec.received_at_ms
          );
        }
      }
    }
  }

  private async writeQuarantineItem(
    failed: FailedItem,
    nowMs: number
  ): Promise<string> {
    const payload = failed.payload;
    const tenantId =
      payload && typeof payload.tenant_id === 'string' && payload.tenant_id.trim().length > 0
        ? payload.tenant_id
        : '_unknown_tenant';
    const siteId =
      payload && typeof payload.site_id === 'string' && payload.site_id.trim().length > 0
        ? payload.site_id
        : '_unknown_site';
    const receivedAtMs =
      payload && typeof payload.received_at_ms === 'number' && Number.isFinite(payload.received_at_ms)
        ? payload.received_at_ms
        : nowMs;
    const shardId =
      payload && Number.isInteger(payload.shard_id) && payload.shard_id >= 0
        ? payload.shard_id
        : 0;

    const qr = failed.validationResult?.quarantineRecord ?? null;
    const pvId = qr?.pvId ?? safeExtractPvId(payload?.raw_frame);
    const seq = qr?.seq ?? safeExtractSeq(payload?.raw_frame);
    const sanitizedFields: Record<string, unknown> = qr
      ? { ...qr.sanitizedFields }
      : {
          raw_frame: sanitizeUnknownForQuarantine(payload?.raw_frame),
        };
    const payloadSha =
      qr?.payloadSha256 ??
      sha256Hex(
        canonicalJsonStringify({
          tenantId,
          siteId,
          reason: failed.reason,
          sanitizedFields,
          receivedAtMs,
        })
      );

    const storageTier: StorageTier =
      payload?.storage_tier ?? this.adapter.descriptor.tier;

    const quarantineObj: QuarantineObject = {
      quarantine_version: 1,
      region: this.region,
      tenant_id: tenantId,
      site_id: siteId,
      pv_id: pvId,
      seq,
      shard_id: shardId,
      received_at_ms: receivedAtMs,
      expires_at_ms: receivedAtMs + this.quarantineRetentionDays * DAY_MS,
      reason: failed.reason,
      payload_sha256: payloadSha,
      sanitized_fields: sanitizedFields,
      reingest_hint: {
        retention_days: payload?.retention_days ?? this.defaultRetentionDays,
        age_ms: Math.max(0, Math.floor(payload?.age_ms ?? 0)),
        storage_tier: storageTier,
      },
    };

    const dayUtc = formatUtcDayBucket(receivedAtMs);
    const key = formatQuarantineObjectKey(
      this.region,
      tenantId,
      siteId,
      dayUtc,
      payloadSha
    );
    await this.adapter.putQuarantineObject(key, canonicalJsonStringify(quarantineObj), {
      tenant_id: tenantId,
      site_id: siteId,
      pv_id: pvId ?? '',
      expires_at_ms: String(quarantineObj.expires_at_ms),
      reason: failed.reason.slice(0, 128),
    });

    return key;
  }

  /**
   * Re-ingests non-expired quarantine entries after a parser/schema bug fix.
   * Successfully re-ingested quarantine objects are deleted upon WAL commit.
   */
  public async reingestQuarantine(
    options: ReingestQuarantineOptions
  ): Promise<ReingestQuarantineResult> {
    const nowMs = options.nowMs ?? Date.now();
    let prefix = `quarantine/${this.region}/`;
    if (options.tenantId) {
      prefix += `${options.tenantId}/`;
      if (options.siteId) {
        prefix += `${options.siteId}/`;
      }
    }

    const listed = await this.adapter.listObjects(prefix, 1000);
    let scannedCount = 0;
    let skippedExpiredCount = 0;
    let skippedUnrepairedCount = 0;
    let reingestedCount = 0;
    let stillQuarantinedCount = 0;
    const deletedQuarantineKeys: string[] = [];
    const newWalKeys: string[] = [];

    for (const meta of listed.objects) {
      scannedCount += 1;
      const obj = await this.adapter.getObject(meta.key);
      if (!obj) continue;
      const parsed = JSON.parse(await obj.text()) as QuarantineObject;
      if (parsed.expires_at_ms <= nowMs) {
        skippedExpiredCount += 1;
        continue;
      }

      const repaired = options.repair(parsed);
      if (!repaired) {
        skippedUnrepairedCount += 1;
        continue;
      }

      const res = await this.consumeBatch([repaired], nowMs);
      if (res.acceptedCount > 0) {
        reingestedCount += 1;
        newWalKeys.push(...res.walKeys);
        await this.adapter.deleteObjects(meta.key);
        deletedQuarantineKeys.push(meta.key);
      } else {
        stillQuarantinedCount += 1;
      }
    }

    return {
      scannedCount,
      skippedExpiredCount,
      skippedUnrepairedCount,
      reingestedCount,
      stillQuarantinedCount,
      deletedQuarantineKeys,
      newWalKeys,
    };
  }

  /**
   * Deletion-coverage hook for 14-day subject erasure (`store.M5` / `store.G-8`):
   * deletes every quarantine object matching any of the subject's `pv_id`s.
   */
  public async deleteQuarantineByPvIds(
    tenantId: string,
    siteId: string,
    pvIds: ReadonlySet<string> | readonly string[]
  ): Promise<{ readonly scannedCount: number; readonly deletedKeys: readonly string[] }> {
    const pvSet = pvIds instanceof Set ? pvIds : new Set(pvIds);
    const prefix = `quarantine/${this.region}/${tenantId}/${siteId}/`;
    const listed = await this.adapter.listObjects(prefix, 1000);
    const toDelete: string[] = [];

    for (const meta of listed.objects) {
      const metaPvId = meta.customMetadata?.pv_id;
      if (metaPvId && pvSet.has(metaPvId)) {
        toDelete.push(meta.key);
        continue;
      }
      const obj = await this.adapter.getObject(meta.key);
      if (!obj) continue;
      const parsed = JSON.parse(await obj.text()) as QuarantineObject;
      if (parsed.pv_id && pvSet.has(parsed.pv_id)) {
        toDelete.push(meta.key);
      }
    }

    if (toDelete.length > 0) {
      await this.adapter.deleteObjects(toDelete);
    }

    return {
      scannedCount: listed.objects.length,
      deletedKeys: toDelete,
    };
  }

  /**
   * Enforces the 7-day retention ceiling on `decode_quarantine` objects.
   */
  public async purgeExpiredQuarantine(
    nowMs = Date.now()
  ): Promise<{ readonly scannedCount: number; readonly purgedKeys: readonly string[] }> {
    const prefix = `quarantine/${this.region}/`;
    const listed = await this.adapter.listObjects(prefix, 1000);
    const expired: string[] = [];

    for (const meta of listed.objects) {
      const obj = await this.adapter.getObject(meta.key);
      if (!obj) continue;
      const parsed = JSON.parse(await obj.text()) as QuarantineObject;
      if (parsed.expires_at_ms <= nowMs) {
        expired.push(meta.key);
      }
    }

    if (expired.length > 0) {
      await this.adapter.deleteObjects(expired);
    }

    return {
      scannedCount: listed.objects.length,
      purgedKeys: expired,
    };
  }
}

/**
 * Cloudflare Queue consumer entry point wrapping `WalWriter`.
 * Acks every message once durably written to either immutable WAL or 7-day quarantine.
 */
export async function handleWalQueueBatch(
  batch: QueueBatchLike<WalQueuePayload>,
  writer: WalWriter,
  nowMs = Date.now()
): Promise<WalConsumeResult> {
  const payloads = batch.messages.map((m) => m.body);
  const result = await writer.consumeBatch(payloads, nowMs);
  for (const msg of batch.messages) {
    msg.ack();
  }
  return result;
}
