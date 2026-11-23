/**
 * UGOKI LINK v2 — Single-Writer Shard Loader & Full R2 WAL Replay Engine
 *
 * Guarantees:
 * - Once-per-PV placement (`url_id`, `pv_start_srv`, `pv_hour`, `retention_days`, `exp_week`)
 *   enforced via `pv_index` (`pv_hour_min === pv_hour_max` => 0 double placements)
 * - Totally ordered atomic manifest commits (`manifest/{region}/{shard}/{seq}.json`)
 *   via R2 conditional put (`onlyIf: { etagDoesNotMatch: '*' }`) so zombie/racing
 *   writers abort cleanly without mutating state
 * - Idempotent writes across `frame_log`, `pv_index`, `page_view_state`,
 *   `events_v2`, `decision_log`, `access_obs`, and `dirty_cell`
 * - Full R2 WAL replay (`replayAllFromWal`) for `store.G-4` re-derivation
 */

import {
  canonicalJsonStringify,
  type TelemetryFrame,
} from '../../packages/contract/schema';
import {
  InMemoryR2Bucket,
  type DataRegion,
  type R2BucketLike,
  type WalObject,
  type WalRecord,
} from '../link-wal';
import {
  computeFastFrameHash,
  computeInitialPlacement,
  estimatePvStartSrvMs,
  mergeFrameIntoPvState,
  mergeFramesBatchIntoPvState,
} from './merger';
import type {
  AccessObsRecord,
  DecisionRecord,
  DeletionTombstoneSpec,
  DirtyCell,
  FrameLogRow,
  LoadControlTotals,
  LoadManifest,
  MergedEventRow,
  MergedPvState,
  PersistedShardTombstones,
  PvIndexRow,
  PvPlacement,
} from './types';

export class MissingManifestWalError extends Error {
  public readonly walKey: string;
  public readonly manifestSeq: number;

  public constructor(walKey: string, manifestSeq: number) {
    super(
      `Manifest seq=${manifestSeq} references missing WAL object "${walKey}" that is not marked as intentionally purged/expired`
    );
    this.name = 'MissingManifestWalError';
    this.walKey = walKey;
    this.manifestSeq = manifestSeq;
  }
}

export interface ShardLoaderOptions {
  readonly region: DataRegion;
  readonly shardId: number;
  readonly bucket: R2BucketLike;
  /**
   * Optional separate bucket for manifests (useful during offline WAL replay
   * so replay runs do not collide with live shard manifests).
   */
  readonly manifestBucket?: R2BucketLike;
}

export interface LoadBatchOutcome {
  readonly committed: boolean;
  readonly abortedDueToRace: boolean;
  readonly manifestKey: string | null;
  readonly manifestSeq: number | null;
  readonly walKeysLoaded: readonly string[];
  readonly recordsProcessed: number;
  readonly newlyPlacedPvs: number;
  readonly doublePlacementCount: number;
}

export interface ReplayOutcome {
  readonly loader: ShardLoader;
  readonly walObjectsReplayed: number;
  readonly totalRecordsReplayed: number;
  readonly controlTotals: LoadControlTotals;
  readonly doublePlacementCount: number;
}

export function makePvCompositeKey(
  tenantId: string,
  siteId: string,
  pvId: string
): string {
  return `${tenantId}\u0000${siteId}\u0000${pvId}`;
}

export function makeCellCompositeKey(
  tenantId: string,
  siteId: string,
  pvHourMs: number
): string {
  return `${tenantId}\u0000${siteId}\u0000${pvHourMs}`;
}

export function makeFrameLogCompositeKey(
  tenantId: string,
  siteId: string,
  pvId: string,
  seq: number,
  frameHash: string
): string {
  return `${tenantId}\u0000${siteId}\u0000${pvId}\u0000${seq}\u0000${frameHash}`;
}

export function formatManifestObjectKey(
  region: DataRegion,
  shardId: number,
  manifestSeq: number
): string {
  const shardPadded = Math.max(0, Math.floor(shardId)).toString().padStart(4, '0');
  const seqPadded = Math.max(0, Math.floor(manifestSeq)).toString().padStart(12, '0');
  return `manifest/${region}/${shardPadded}/${seqPadded}.json`;
}

export function formatWalShardPrefix(region: DataRegion, shardId: number): string {
  const shardPadded = Math.max(0, Math.floor(shardId)).toString().padStart(4, '0');
  return `wal/${region}/${shardPadded}/`;
}

export function formatTombstonesObjectKey(region: DataRegion, shardId: number): string {
  const shardPadded = Math.max(0, Math.floor(shardId)).toString().padStart(4, '0');
  return `tombstones/${region}/${shardPadded}/tombstones.json`;
}

export async function listAllKeysWithPrefix(
  bucket: R2BucketLike,
  prefix: string
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined = undefined;
  let hasMore = true;

  while (hasMore) {
    const page = await bucket.list({ prefix, limit: 1000, cursor });
    for (const obj of page.objects) {
      keys.push(obj.key);
    }
    hasMore = page.truncated && page.cursor !== undefined;
    cursor = page.cursor;
  }

  return keys;
}

export class ShardLoader {
  public readonly region: DataRegion;
  public readonly shardId: number;
  private readonly bucket: R2BucketLike;
  private readonly manifestBucket: R2BucketLike;

  private nextManifestSeq = 1;
  private readonly processedWalKeys = new Set<string>();
  private readonly appliedManifestSeqs = new Set<number>();
  private readonly committedManifests: LoadManifest[] = [];

  // Authoritative base tables (in-memory representation matching ClickHouse schema)
  private readonly pvIndex = new Map<string, PvIndexRow>();
  private readonly pvStates = new Map<string, MergedPvState>();
  private readonly frameLog = new Map<string, FrameLogRow>();
  private readonly events = new Map<string, MergedEventRow>();
  private readonly decisions = new Map<string, DecisionRecord>();
  private readonly accessObs = new Map<string, AccessObsRecord>();
  private readonly dirtyCells = new Map<string, DirtyCell>();
  private readonly deletedPvKeys = new Set<string>();
  private readonly deletedVisitorKeys = new Set<string>();
  private readonly deletedMemberHashes = new Set<string>();
  private readonly purgedWalKeys = new Set<string>();

  public constructor(options: ShardLoaderOptions) {
    this.region = options.region;
    this.shardId = options.shardId;
    this.bucket = options.bucket;
    this.manifestBucket = options.manifestBucket ?? options.bucket;
  }

  /**
   * Registers subject deletion tombstones AND persists them to
   * `tombstones/{region}/{shard}/tombstones.json` so neither late-arriving frames
   * nor failover/handover manifest replay can resurrect erased subjects (H-19 / Codex R2 #10).
   */
  public async registerDeletionTombstones(spec: DeletionTombstoneSpec): Promise<void> {
    for (const pvId of spec.pvIds ?? []) {
      this.deletedPvKeys.add(makePvCompositeKey(spec.tenantId, spec.siteId, pvId));
    }
    for (const vk of spec.visitorKeys ?? []) {
      this.deletedVisitorKeys.add(makePvCompositeKey(spec.tenantId, spec.siteId, vk));
    }
    for (const mh of spec.memberHashes ?? []) {
      this.deletedMemberHashes.add(makePvCompositeKey(spec.tenantId, spec.siteId, mh));
    }
    await this.persistTombstonesToBucket();
  }

  /** Singular alias for `registerDeletionTombstones`. */
  public async registerDeletionTombstone(spec: DeletionTombstoneSpec): Promise<void> {
    await this.registerDeletionTombstones(spec);
  }

  /**
   * Marks WAL keys as intentionally purged/expired so subsequent manifest syncs
   * distinguish expected retention/erasure purges from unexplained WAL loss (Codex R2 #10).
   */
  public async markWalKeysPurged(walKeys: readonly string[]): Promise<void> {
    for (const wk of walKeys) {
      this.purgedWalKeys.add(wk);
    }
    await this.persistTombstonesToBucket();
  }

  private async persistTombstonesToBucket(): Promise<void> {
    const key = formatTombstonesObjectKey(this.region, this.shardId);
    const maxCasAttempts = 8;

    // Codex R3 #10: CAS read-merge-write retry loop using `onlyIf: { etagMatches }`
    // (or `etagDoesNotMatch: '*'` on initial create) so concurrent writers NEVER overwrite
    // or drop each other's tombstones.
    for (let attempt = 0; attempt < maxCasAttempts; attempt += 1) {
      const existing = await this.manifestBucket.get(key);
      let expectedEtag: string | null = null;

      if (existing !== null) {
        expectedEtag = existing.etag;
        const parsed = JSON.parse(await existing.text()) as Partial<PersistedShardTombstones>;
        for (const pvKey of parsed.deleted_pv_keys ?? []) {
          this.deletedPvKeys.add(pvKey);
        }
        for (const visitorKey of parsed.deleted_visitor_keys ?? []) {
          this.deletedVisitorKeys.add(visitorKey);
        }
        for (const memberHash of parsed.deleted_member_hashes ?? []) {
          this.deletedMemberHashes.add(memberHash);
        }
        for (const purgedWalKey of parsed.purged_wal_keys ?? []) {
          this.purgedWalKeys.add(purgedWalKey);
        }
      }

      const payload: PersistedShardTombstones = {
        version: 1,
        region: this.region,
        shard_id: this.shardId,
        deleted_pv_keys: Array.from(this.deletedPvKeys).sort(),
        deleted_visitor_keys: Array.from(this.deletedVisitorKeys).sort(),
        deleted_member_hashes: Array.from(this.deletedMemberHashes).sort(),
        purged_wal_keys: Array.from(this.purgedWalKeys).sort(),
      };

      const putResult = await this.manifestBucket.put(key, canonicalJsonStringify(payload), {
        onlyIf:
          expectedEtag !== null
            ? { etagMatches: expectedEtag }
            : { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json' },
        customMetadata: {
          region: this.region,
          shard_id: String(this.shardId),
        },
      });

      if (putResult !== null) {
        return;
      }
    }

    throw new Error(
      `Failed to persist tombstones for ${this.region}/shard-${this.shardId} after ${maxCasAttempts} CAS attempts`
    );
  }

  /**
   * Loads persisted deletion tombstones (and intentionally purged WAL keys) from bucket.
   */
  public async loadPersistedTombstonesFromBucket(sourceBucket?: R2BucketLike): Promise<void> {
    const key = formatTombstonesObjectKey(this.region, this.shardId);
    const bucketsToRead: R2BucketLike[] = sourceBucket
      ? [sourceBucket]
      : this.manifestBucket === this.bucket
        ? [this.manifestBucket]
        : [this.manifestBucket, this.bucket];

    for (const b of bucketsToRead) {
      const raw = await b.get(key);
      if (!raw) continue;
      const parsed = JSON.parse(await raw.text()) as Partial<PersistedShardTombstones>;
      for (const pvKey of parsed.deleted_pv_keys ?? []) {
        this.deletedPvKeys.add(pvKey);
      }
      for (const visitorKey of parsed.deleted_visitor_keys ?? []) {
        this.deletedVisitorKeys.add(visitorKey);
      }
      for (const memberHash of parsed.deleted_member_hashes ?? []) {
        this.deletedMemberHashes.add(memberHash);
      }
      for (const purgedWalKey of parsed.purged_wal_keys ?? []) {
        this.purgedWalKeys.add(purgedWalKey);
      }
    }
  }

  private isRecordTombstoned(record: WalRecord): boolean {
    const pvKey = makePvCompositeKey(record.tenant_id, record.site_id, record.frame.pv_id);
    if (this.deletedPvKeys.has(pvKey)) return true;
    if (
      record.frame.visitor_id &&
      this.deletedVisitorKeys.has(
        makePvCompositeKey(record.tenant_id, record.site_id, record.frame.visitor_id)
      )
    ) {
      return true;
    }
    if (
      record.frame.member_hash &&
      this.deletedMemberHashes.has(
        makePvCompositeKey(record.tenant_id, record.site_id, record.frame.member_hash)
      )
    ) {
      return true;
    }
    return false;
  }

  /**
   * Synchronizes committed manifests from R2 on startup/failover:
   * 1. Loads persisted deletion tombstones FIRST before replaying any WAL keys so
   *    deleted subjects can NEVER be resurrected (Codex R2 #10).
   * 2. Replays every newly discovered manifest's WAL keys in manifest order.
   * 3. Throws `MissingManifestWalError` without advancing `appliedManifestSeqs` or
   *    `nextManifestSeq` if any referenced `wal_key` is missing and not marked purged/expired.
   */
  public async syncManifestsFromBucket(options?: {
    readonly allowedMissingWalKeys?: ReadonlySet<string>;
  }): Promise<number> {
    // Codex R2 #10: Restore persisted deletion tombstones FIRST before replaying any manifest WAL!
    await this.loadPersistedTombstonesFromBucket();

    const prefix = `manifest/${this.region}/${this.shardId.toString().padStart(4, '0')}/`;
    const keys = await listAllKeysWithPrefix(this.manifestBucket, prefix);
    let appliedMaxSeq = 0;
    for (const seq of this.appliedManifestSeqs) {
      if (seq > appliedMaxSeq) appliedMaxSeq = seq;
    }
    const newlyDiscovered: LoadManifest[] = [];

    for (const key of keys) {
      const obj = await this.manifestBucket.get(key);
      if (!obj) continue;
      const manifest = JSON.parse(await obj.text()) as LoadManifest;
      if (!this.appliedManifestSeqs.has(manifest.manifest_seq)) {
        newlyDiscovered.push(manifest);
      } else if (manifest.manifest_seq > appliedMaxSeq) {
        appliedMaxSeq = manifest.manifest_seq;
      }
    }

    newlyDiscovered.sort((a, b) => a.manifest_seq - b.manifest_seq);

    // Replay WAL objects in committed manifest order to restore PV state & control totals
    for (const manifest of newlyDiscovered) {
      const replayItems: Array<{ readonly walKey: string; readonly record: WalRecord }> = [];
      for (const walKey of manifest.wal_keys) {
        if (this.processedWalKeys.has(walKey)) continue;
        const walObjRaw = await this.bucket.get(walKey);
        if (!walObjRaw) {
          const isIntentionallyPurged =
            this.purgedWalKeys.has(walKey) ||
            (manifest.purged_wal_keys?.includes(walKey) ?? false) ||
            (options?.allowedMissingWalKeys?.has(walKey) ?? false);
          if (!isIntentionallyPurged) {
            throw new MissingManifestWalError(walKey, manifest.manifest_seq);
          }
          continue;
        }
        const walObj = JSON.parse(await walObjRaw.text()) as WalObject;
        for (const record of walObj.records) {
          replayItems.push({ walKey, record });
        }
      }

      if (replayItems.length > 0) {
        const staged = this.stageBatchItems(replayItems, manifest.committed_at_ms);
        this.applyStagedMutations(staged);
      }

      for (const wk of manifest.wal_keys) {
        this.processedWalKeys.add(wk);
      }
      if (!this.committedManifests.some((m) => m.manifest_seq === manifest.manifest_seq)) {
        this.committedManifests.push(manifest);
        this.committedManifests.sort((a, b) => a.manifest_seq - b.manifest_seq);
      }
      this.appliedManifestSeqs.add(manifest.manifest_seq);
      if (manifest.manifest_seq > appliedMaxSeq) {
        appliedMaxSeq = manifest.manifest_seq;
      }
      this.nextManifestSeq = Math.max(this.nextManifestSeq, manifest.manifest_seq + 1);
    }

    return appliedMaxSeq;
  }

  /**
   * Reads all pending WAL objects for this `(region, shardId)`, commits a
   * totally-ordered conditional manifest in R2, and applies idempotent updates
   * to `pv_index`, `page_view_state`, `events_v2`, `frame_log`, and `dirty_cell`.
   */
  public async loadPendingWalObjects(
    nowMs = Date.now(),
    options?: {
      readonly maxObjects?: number;
      readonly sealedHours?: ReadonlySet<string>;
    }
  ): Promise<LoadBatchOutcome> {
    const prefix = formatWalShardPrefix(this.region, this.shardId);
    const allWalKeys = await listAllKeysWithPrefix(this.bucket, prefix);
    const pendingKeys = allWalKeys.filter((k) => !this.processedWalKeys.has(k));
    const batchKeys =
      options?.maxObjects !== undefined
        ? pendingKeys.slice(0, Math.max(1, options.maxObjects))
        : pendingKeys;

    if (batchKeys.length === 0) {
      return {
        committed: true,
        abortedDueToRace: false,
        manifestKey: null,
        manifestSeq: null,
        walKeysLoaded: [],
        recordsProcessed: 0,
        newlyPlacedPvs: 0,
        doublePlacementCount: this.getDoublePlacementCount(),
      };
    }

    const batchItems: Array<{ readonly walKey: string; readonly record: WalRecord }> = [];
    for (const walKey of batchKeys) {
      const obj = await this.bucket.get(walKey);
      if (!obj) continue;
      const walObj = JSON.parse(await obj.text()) as WalObject;
      if (walObj.region !== this.region || walObj.shard_id !== this.shardId) {
        throw new Error(
          `WAL object ${walKey} region/shard (${walObj.region}/${walObj.shard_id}) mismatches loader (${this.region}/${this.shardId})`
        );
      }
      for (const rec of walObj.records) {
        batchItems.push({ walKey, record: rec });
      }
    }

    return this.commitBatchItems(batchKeys, batchItems, nowMs, options?.sealedHours);
  }

  /**
   * Directly loads an in-memory batch of `WalRecord`s under conditional
   * manifest fencing (used for race-condition testing & direct streaming).
   */
  public async loadRecordsWithManifest(
    walKey: string,
    records: readonly WalRecord[],
    nowMs = Date.now(),
    sealedHours?: ReadonlySet<string>
  ): Promise<LoadBatchOutcome> {
    if (this.processedWalKeys.has(walKey) || records.length === 0) {
      return {
        committed: true,
        abortedDueToRace: false,
        manifestKey: null,
        manifestSeq: null,
        walKeysLoaded: [],
        recordsProcessed: 0,
        newlyPlacedPvs: 0,
        doublePlacementCount: this.getDoublePlacementCount(),
      };
    }
    const items = records.map((record) => ({ walKey, record }));
    return this.commitBatchItems([walKey], items, nowMs, sealedHours);
  }

  private stageBatchItems(
    items: ReadonlyArray<{ readonly walKey: string; readonly record: WalRecord }>,
    nowMs: number,
    sealedHours?: ReadonlySet<string>
  ): {
    readonly stagedPvIndex: Map<string, PvIndexRow>;
    readonly stagedPvStates: Map<string, MergedPvState>;
    readonly stagedFrameLog: Map<string, FrameLogRow>;
    readonly stagedEvents: Map<string, MergedEventRow>;
    readonly stagedDirty: Map<string, DirtyCell>;
    readonly manifestFrameKeys: Set<string>;
    readonly newlyPlacedPvs: number;
  } {
    // Stage placements & state mutations first so a failed conditional manifest
    // put leaves the live tables completely untouched (zero partial commits!).
    const stagedPvIndex = new Map<string, PvIndexRow>();
    const stagedPvStates = new Map<string, MergedPvState>();
    const stagedFrameLog = new Map<string, FrameLogRow>();
    const stagedEvents = new Map<string, MergedEventRow>();
    const stagedDirty = new Map<string, DirtyCell>();
    const manifestFrameKeys = new Set<string>();
    let newlyPlacedPvs = 0;

    for (const { walKey, record } of items) {
      if (this.isRecordTombstoned(record)) {
        continue;
      }
      const frame = record.frame;
      const pvKey = makePvCompositeKey(record.tenant_id, record.site_id, frame.pv_id);
      const frameHash = record.frame_hash || computeFastFrameHash(frame);
      const isLabTraffic =
        Boolean(frame.lab_run_id) ||
        record.lab_exclusion?.is_lab_traffic === true ||
        record.lab_exclusion?.exclude_human_rollups === true;

      let indexRow = stagedPvIndex.get(pvKey) ?? this.pvIndex.get(pvKey);
      let placement: PvPlacement;

      if (!indexRow) {
        newlyPlacedPvs += 1;
        placement = computeInitialPlacement({
          tenantId: record.tenant_id,
          siteId: record.site_id,
          pvId: frame.pv_id,
          urlId: frame.url_id,
          keyVer: frame.key_ver,
          profileRev: frame.profile_rev,
          receivedAtMs: record.received_at_ms,
          tMonoMs: frame.t_mono,
          ageMs: record.age_ms,
          retentionDays: record.retention_days,
        });
        indexRow = {
          tenantId: placement.tenantId,
          siteId: placement.siteId,
          pvId: placement.pvId,
          urlId: placement.urlId,
          keyVer: placement.keyVer,
          profileRev: placement.profileRev,
          pvStartSrvMs: placement.pvStartSrvMs,
          pvHourMinMs: placement.pvHourMs,
          pvHourMaxMs: placement.pvHourMs,
          expWeek: placement.expWeek,
          retentionDays: placement.retentionDays,
          minEstimateStartMs: placement.pvStartSrvMs,
          placementBiasMs: 0,
          visitorKey: frame.visitor_id ?? null,
          sessionKey: frame.session_id ?? null,
          consentMode: frame.consent_mode,
          skelFp: frame.state.skel_fp,
          variantKey: frame.state.variant_key,
          firstFrameReceivedAtMs: record.received_at_ms,
          excludeFromHumanRollups: isLabTraffic,
        };
        stagedPvIndex.set(pvKey, indexRow);
      } else {
        // Reuse existing immutable placement! Only update diagnostic placementBiasMs.
        const currentEstimate = estimatePvStartSrvMs(
          record.received_at_ms,
          frame.t_mono,
          record.age_ms
        );
        const minEstimateStartMs = Math.min(indexRow.minEstimateStartMs, currentEstimate);
        const placementBiasMs = indexRow.pvStartSrvMs - minEstimateStartMs;
        indexRow = {
          ...indexRow,
          minEstimateStartMs,
          placementBiasMs,
          visitorKey: indexRow.visitorKey ?? frame.visitor_id ?? null,
          sessionKey: indexRow.sessionKey ?? frame.session_id ?? null,
          excludeFromHumanRollups: Boolean(indexRow.excludeFromHumanRollups) || isLabTraffic,
        };
        stagedPvIndex.set(pvKey, indexRow);

        placement = {
          tenantId: indexRow.tenantId,
          siteId: indexRow.siteId,
          pvId: indexRow.pvId,
          urlId: indexRow.urlId,
          keyVer: indexRow.keyVer,
          profileRev: indexRow.profileRev,
          pvStartSrvMs: indexRow.pvStartSrvMs,
          pvHourMs: indexRow.pvHourMinMs,
          pvHourIso: new Date(indexRow.pvHourMinMs).toISOString(),
          retentionDays: indexRow.retentionDays,
          expWeek: indexRow.expWeek,
          placementBiasMs,
        };
      }

      const existingState = stagedPvStates.get(pvKey) ?? this.pvStates.get(pvKey) ?? null;
      const mergedBase = mergeFrameIntoPvState(
        existingState,
        frame,
        frameHash,
        placement,
        record.state_incomplete
      );
      const mergedState: MergedPvState =
        Boolean(existingState?.excludeFromHumanRollups) || isLabTraffic
          ? { ...mergedBase, excludeFromHumanRollups: true }
          : mergedBase;
      stagedPvStates.set(pvKey, mergedState);

      const frameKey = makeFrameLogCompositeKey(
        record.tenant_id,
        record.site_id,
        frame.pv_id,
        frame.seq,
        frameHash
      );
      manifestFrameKeys.add(frameKey);
      if (!this.frameLog.has(frameKey) && !stagedFrameLog.has(frameKey)) {
        stagedFrameLog.set(frameKey, {
          tenantId: record.tenant_id,
          siteId: record.site_id,
          expWeek: placement.expWeek,
          pvHourMs: placement.pvHourMs,
          urlId: placement.urlId,
          pvId: frame.pv_id,
          seq: frame.seq,
          frameHash,
          ackEchoSeq: frame.ack_echo_seq,
          liveWord: frame.live_word >>> 0,
          receivedAtMs: record.received_at_ms,
          walKey,
        });
      }

      for (const [logI, evRow] of mergedState.events.entries()) {
        const evKey = `${pvKey}\u0000${logI}`;
        stagedEvents.set(evKey, evRow);
      }

      const cellKey = makeCellCompositeKey(
        record.tenant_id,
        record.site_id,
        placement.pvHourMs
      );
      const isLate = sealedHours?.has(cellKey) ?? false;
      const prevDirty = stagedDirty.get(cellKey) ?? this.dirtyCells.get(cellKey);
      stagedDirty.set(cellKey, {
        tenantId: record.tenant_id,
        siteId: record.site_id,
        pvHourMs: placement.pvHourMs,
        reason: isLate ? 'late_frame' : prevDirty?.reason ?? 'initial_load',
        markedAtMs: nowMs,
        dirtyCount: (prevDirty?.dirtyCount ?? 0) + 1,
      });
    }

    return {
      stagedPvIndex,
      stagedPvStates,
      stagedFrameLog,
      stagedEvents,
      stagedDirty,
      manifestFrameKeys,
      newlyPlacedPvs,
    };
  }

  private applyStagedMutations(staged: {
    readonly stagedPvIndex: Map<string, PvIndexRow>;
    readonly stagedPvStates: Map<string, MergedPvState>;
    readonly stagedFrameLog: Map<string, FrameLogRow>;
    readonly stagedEvents: Map<string, MergedEventRow>;
    readonly stagedDirty: Map<string, DirtyCell>;
  }): void {
    for (const [k, v] of staged.stagedPvIndex.entries()) this.pvIndex.set(k, v);
    for (const [k, v] of staged.stagedPvStates.entries()) this.pvStates.set(k, v);
    for (const [k, v] of staged.stagedFrameLog.entries()) this.frameLog.set(k, v);
    for (const [k, v] of staged.stagedEvents.entries()) this.events.set(k, v);
    for (const [k, v] of staged.stagedDirty.entries()) this.dirtyCells.set(k, v);
  }

  private async commitBatchItems(
    walKeys: readonly string[],
    items: ReadonlyArray<{ readonly walKey: string; readonly record: WalRecord }>,
    nowMs: number,
    sealedHours?: ReadonlySet<string>
  ): Promise<LoadBatchOutcome> {
    const staged = this.stageBatchItems(items, nowMs, sealedHours);
    const { stagedPvStates, manifestFrameKeys, newlyPlacedPvs } = staged;

    // Build manifest control totals for this batch
    let batchEvents = 0;
    let batchScrollSum = 0;
    let batchVisSum = 0;
    for (const st of stagedPvStates.values()) {
      batchEvents += st.events.size;
      batchScrollSum += st.scrollMaxPx;
      batchVisSum += st.visMs;
    }

    const manifestSeq = this.nextManifestSeq;
    const manifestKey = formatManifestObjectKey(this.region, this.shardId, manifestSeq);
    const manifest: LoadManifest = {
      manifest_version: 1,
      region: this.region,
      shard_id: this.shardId,
      manifest_seq: manifestSeq,
      wal_keys: [...walKeys],
      committed_at_ms: nowMs,
      frame_keys: Array.from(manifestFrameKeys).sort(),
      control_totals: {
        frames: manifestFrameKeys.size,
        uniquePvs: stagedPvStates.size,
        events: batchEvents,
        sumScrollMaxPx: batchScrollSum,
        sumVisMs: batchVisSum,
      },
    };

    // Atomic conditional put — fences zombie / racing loaders!
    const putResult = await this.manifestBucket.put(
      manifestKey,
      canonicalJsonStringify(manifest),
      {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json' },
        customMetadata: {
          region: this.region,
          shard_id: String(this.shardId),
          manifest_seq: String(manifestSeq),
        },
      }
    );

    if (putResult === null) {
      // Another active loader already committed this manifest_seq -> abort cleanly
      return {
        committed: false,
        abortedDueToRace: true,
        manifestKey,
        manifestSeq,
        walKeysLoaded: [],
        recordsProcessed: 0,
        newlyPlacedPvs: 0,
        doublePlacementCount: this.getDoublePlacementCount(),
      };
    }

    // Manifest committed! Apply staged state mutations atomically.
    this.applyStagedMutations(staged);
    for (const wk of walKeys) this.processedWalKeys.add(wk);
    this.appliedManifestSeqs.add(manifestSeq);
    this.committedManifests.push(manifest);
    this.nextManifestSeq = manifestSeq + 1;

    return {
      committed: true,
      abortedDueToRace: false,
      manifestKey,
      manifestSeq,
      walKeysLoaded: [...walKeys],
      recordsProcessed: items.length,
      newlyPlacedPvs,
      doublePlacementCount: this.getDoublePlacementCount(),
    };
  }

  /**
   * Idempotently ingests decision_log records keyed by `(tenant, site, layer, decisionId)`.
   */
  public ingestDecisions(records: readonly DecisionRecord[]): number {
    let inserted = 0;
    for (const rec of records) {
      const key = `${rec.tenantId}\u0000${rec.siteId}\u0000${rec.layerId}\u0000${rec.decisionId}`;
      if (!this.decisions.has(key)) {
        inserted += 1;
      }
      this.decisions.set(key, rec);
    }
    return inserted;
  }

  /**
   * Idempotently ingests access_obs records keyed by `(tenant, site, capturePath, reqUid, sub)`.
   */
  public ingestAccessObs(records: readonly AccessObsRecord[]): number {
    let inserted = 0;
    for (const rec of records) {
      const key = `${rec.tenantId}\u0000${rec.siteId}\u0000${rec.capturePath}\u0000${rec.reqUid}\u0000${rec.sub}`;
      if (!this.accessObs.has(key)) {
        inserted += 1;
      }
      this.accessObs.set(key, rec);
    }
    return inserted;
  }

  /**
   * Removes subject PVs from all base tables, marks affected `(tenant, site, pv_hour)`
   * cells dirty with reason `'deletion'` so the rollup builder re-seals them, AND
   * durably persists deletion tombstones via CAS so handover NEVER resurrects deleted PVs (Codex R3 #10).
   */
  public async deletePvs(
    tenantId: string,
    siteId: string,
    pvIds: ReadonlySet<string> | readonly string[],
    nowMs = Date.now()
  ): Promise<{
    readonly deletedPvs: number;
    readonly deletedFrames: number;
    readonly deletedEvents: number;
    readonly affectedCellKeys: readonly string[];
  }> {
    const pvSet = pvIds instanceof Set ? pvIds : new Set(pvIds);
    let deletedPvs = 0;
    let deletedFrames = 0;
    let deletedEvents = 0;
    const affectedCells = new Set<string>();

    for (const pvId of pvSet) {
      const pvKey = makePvCompositeKey(tenantId, siteId, pvId);
      this.deletedPvKeys.add(pvKey);
      const st = this.pvStates.get(pvKey);
      const idx = this.pvIndex.get(pvKey);
      const pvHourMs = st?.placement.pvHourMs ?? idx?.pvHourMinMs;

      if (st || idx) {
        deletedPvs += 1;
        this.pvStates.delete(pvKey);
        this.pvIndex.delete(pvKey);
      }

      if (pvHourMs !== undefined) {
        const cellKey = makeCellCompositeKey(tenantId, siteId, pvHourMs);
        affectedCells.add(cellKey);
        const prev = this.dirtyCells.get(cellKey);
        this.dirtyCells.set(cellKey, {
          tenantId,
          siteId,
          pvHourMs,
          reason: 'deletion',
          markedAtMs: nowMs,
          dirtyCount: (prev?.dirtyCount ?? 0) + 1,
        });
      }
    }

    for (const [fk, row] of this.frameLog.entries()) {
      if (row.tenantId === tenantId && row.siteId === siteId && pvSet.has(row.pvId)) {
        this.frameLog.delete(fk);
        deletedFrames += 1;
      }
    }

    for (const [ek, row] of this.events.entries()) {
      if (row.tenantId === tenantId && row.siteId === siteId && pvSet.has(row.pvId)) {
        this.events.delete(ek);
        deletedEvents += 1;
      }
    }

    if (pvSet.size > 0) {
      await this.persistTombstonesToBucket();
    }

    return {
      deletedPvs,
      deletedFrames,
      deletedEvents,
      affectedCellKeys: Array.from(affectedCells).sort(),
    };
  }

  public markCellDirty(
    tenantId: string,
    siteId: string,
    pvHourMs: number,
    reason: DirtyCell['reason'],
    nowMs = Date.now()
  ): void {
    const cellKey = makeCellCompositeKey(tenantId, siteId, pvHourMs);
    const prev = this.dirtyCells.get(cellKey);
    this.dirtyCells.set(cellKey, {
      tenantId,
      siteId,
      pvHourMs,
      reason,
      markedAtMs: nowMs,
      dirtyCount: (prev?.dirtyCount ?? 0) + 1,
    });
  }

  public clearDirtyCell(tenantId: string, siteId: string, pvHourMs: number): void {
    this.dirtyCells.delete(makeCellCompositeKey(tenantId, siteId, pvHourMs));
  }

  /**
   * Invariant check (`store.G-1`): `pv_hour_min` MUST equal `pv_hour_max` for every PV.
   */
  public getDoublePlacementCount(): number {
    let conflicts = 0;
    for (const row of this.pvIndex.values()) {
      if (row.pvHourMinMs !== row.pvHourMaxMs) {
        conflicts += 1;
      }
    }
    return conflicts;
  }

  public getControlTotals(): LoadControlTotals {
    let sumScrollMaxPx = 0;
    let sumVisMs = 0;
    for (const st of this.pvStates.values()) {
      sumScrollMaxPx += st.scrollMaxPx;
      sumVisMs += st.visMs;
    }
    return {
      frames: this.frameLog.size,
      uniquePvs: this.pvStates.size,
      events: this.events.size,
      sumScrollMaxPx,
      sumVisMs,
    };
  }

  public getPvIndexRow(
    tenantId: string,
    siteId: string,
    pvId: string
  ): PvIndexRow | undefined {
    return this.pvIndex.get(makePvCompositeKey(tenantId, siteId, pvId));
  }

  public getPvState(
    tenantId: string,
    siteId: string,
    pvId: string
  ): MergedPvState | undefined {
    return this.pvStates.get(makePvCompositeKey(tenantId, siteId, pvId));
  }

  public getAllPvIndexRows(): readonly PvIndexRow[] {
    return Array.from(this.pvIndex.values());
  }

  public getAllPvStates(): readonly MergedPvState[] {
    return Array.from(this.pvStates.values());
  }

  public getAllFrameLogRows(): readonly FrameLogRow[] {
    return Array.from(this.frameLog.values());
  }

  public getAllEvents(): readonly MergedEventRow[] {
    return Array.from(this.events.values());
  }

  public getAllDecisions(): readonly DecisionRecord[] {
    return Array.from(this.decisions.values());
  }

  public getAllAccessObs(): readonly AccessObsRecord[] {
    return Array.from(this.accessObs.values());
  }

  public getDirtyCells(): readonly DirtyCell[] {
    return Array.from(this.dirtyCells.values());
  }

  public getCommittedManifests(): readonly LoadManifest[] {
    return [...this.committedManifests];
  }

  public getNextManifestSeq(): number {
    return this.nextManifestSeq;
  }
}

/**
 * Full R2 WAL replay (`rebuild_pv` / `store.G-4`):
 * Reconstructs every base table from immutable R2 WAL objects into a clean
 * `ShardLoader` instance without modifying live manifests.
 */
export async function replayAllFromWal(options: {
  readonly region: DataRegion;
  readonly shardId: number;
  readonly walBucket: R2BucketLike;
  readonly nowMs?: number;
  readonly chunkSize?: number;
  readonly deletionTombstones?: readonly DeletionTombstoneSpec[];
}): Promise<ReplayOutcome> {
  const replayManifestBucket = new InMemoryR2Bucket();
  const loader = new ShardLoader({
    region: options.region,
    shardId: options.shardId,
    bucket: options.walBucket,
    manifestBucket: replayManifestBucket,
  });
  await loader.loadPersistedTombstonesFromBucket(options.walBucket);
  for (const ts of options.deletionTombstones ?? []) {
    await loader.registerDeletionTombstones(ts);
  }

  const chunkSize = Math.max(1, options.chunkSize ?? 250);
  const nowMs = options.nowMs ?? Date.now();
  let walObjectsReplayed = 0;
  let totalRecordsReplayed = 0;

  while (true) {
    const res = await loader.loadPendingWalObjects(nowMs, { maxObjects: chunkSize });
    if (res.walKeysLoaded.length === 0) {
      break;
    }
    walObjectsReplayed += res.walKeysLoaded.length;
    totalRecordsReplayed += res.recordsProcessed;
  }

  return {
    loader,
    walObjectsReplayed,
    totalRecordsReplayed,
    controlTotals: loader.getControlTotals(),
    doublePlacementCount: loader.getDoublePlacementCount(),
  };
}

/**
 * Pure fast single-PV frame-schedule runner for deterministic high-scale
 * convergence simulations (100,000+ schedules in seconds).
 */
export function runPurePvSchedule(
  frames: readonly TelemetryFrame[],
  options: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly baseReceivedAtMs: number;
    readonly retentionDays: number;
  }
): {
  readonly state: MergedPvState | null;
  readonly placementCount: number;
  readonly doublePlacement: boolean;
} {
  if (frames.length === 0) {
    return { state: null, placementCount: 0, doublePlacement: false };
  }

  const first = frames[0]!;
  const placement = computeInitialPlacement({
    tenantId: options.tenantId,
    siteId: options.siteId,
    pvId: first.pv_id,
    urlId: first.url_id,
    keyVer: first.key_ver,
    profileRev: first.profile_rev,
    receivedAtMs: options.baseReceivedAtMs + first.t_mono,
    tMonoMs: first.t_mono,
    retentionDays: options.retentionDays,
  });

  const state = mergeFramesBatchIntoPvState(frames, placement);

  return {
    state,
    placementCount: 1,
    doublePlacement: false,
  };
}
