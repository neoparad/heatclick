/**
 * UGOKI LINK v2 — 14-Day Subject Deletion Execution Engine (§5.7 / §5.12 / store.M5 / store.G-8)
 *
 * Drives end-to-end execution of `generateDeletionPlan(CANONICAL_SCHEMA)`:
 * 1. Schedule request & advance monotonic `deletion_epoch`
 * 2. Mask within 24 hours (`ec_member_summary` deleted FIRST, edge caches purged, active mask set)
 * 3. Lookup subject across ALL active HMAC `key_version`s (never destroy a key version while rows > 0)
 * 4. Physical purge within 5 days across every ClickHouse/Postgres table & external store in the plan,
 *    marking touched rollup cells dirty & dispatching §5.12 export-sink notifications
 * 5. Issue immutable DeletionCertificate within 14 days (raising `overdue` alert at day 10),
 *    explicitly naming every unreachable class and §5.12 external-export status
 */

import { getConstant } from '../../../packages/contract/ledgers';
import {
  assertDeletionPlanCoverage,
  CANONICAL_SCHEMA,
  computeCanonicalSubjectHmac,
  computeSubjectHmacLookupCandidates,
  generateDeletionPlan,
  type DeletionPlan,
  type DeletionTableEntry,
  type ExternalStoreDeletionSpec,
} from '../../../packages/contract/schema';

export type DeletionSubjectKind =
  | 'visitor_id'
  | 'member_hash'
  | 'external_id'
  | 'ga_client_id';

/**
 * Canonical versioned RFC 2104 HMAC-SHA256 subject identifier digest shared
 * identically across collector ingest, `/v1/optout`, and 14-day subject erasure (`H-19` / Codex #9).
 */
export function computeTenantSubjectHmac(
  secretSalt: string,
  tenantId: string,
  subjectKind: DeletionSubjectKind,
  rawSubjectValue: string
): string {
  return computeCanonicalSubjectHmac({
    tenantId,
    subjectKind,
    subjectValue: rawSubjectValue,
    secretKey: secretSalt,
  });
}

export type DeletionRequestState =
  | 'scheduled'
  | 'masked'
  | 'purged'
  | 'certified'
  | 'cancelled'
  | 'overdue';

/**
 * §5.12 Deletion status classification for external exports / customer-hosted copies.
 */
export type ExportDeletionStatus =
  | 'link_deleted_confirmed'
  | 'customer_notified_ack'
  | 'customer_notified_unconfirmed'
  | 'outside_management';

export interface TenantHmacKeyVersion {
  readonly tenantId: string;
  readonly keyVersion: number;
  readonly secretSalt: string;
  readonly status: 'active' | 'draining' | 'destroyed';
  readonly activeRowCount: number;
  readonly createdAtMs: number;
  readonly destroyedAtMs: number | null;
}

export interface KeyVersionDestructionResult {
  readonly destroyed: boolean;
  readonly tenantId: string;
  readonly keyVersion: number;
  readonly remainingRows: number;
  readonly reason: string;
}

export interface SubjectHmacVersionedCandidate {
  readonly key_version: string | number;
  readonly format: string;
  readonly hmac_hex: string;
}

export interface KeyedSubjectDigest {
  readonly keyVersion: number;
  /** Optional raw string key-version label (e.g. `'key_v1'`, `'1'`) preserved from collector candidates (Codex R3 #9). */
  readonly keyVersionLabel?: string;
  readonly hmacHex: string;
  /**
   * Canonical `v1` digest plus legacy compatibility digests (`value`, `kind:value`,
   * `tenant:kind:value`) for this key version so deletion matches both newly ingested
   * and historical rows (Codex #9).
   */
  readonly lookupCandidates?: readonly string[];
}

function parseKeyVersionNumber(keyVersion: string | number): number | null {
  const match = /^(?:(?:key_)?v)?(\d+)$/i.exec(String(keyVersion).trim());
  const version = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(version) ? version : null;
}

interface QueuedDigestPlan {
  readonly scoped: ReadonlyMap<number, KeyedSubjectDigest>;
  readonly unscoped: readonly string[];
}

function planQueuedDigests(flat: readonly string[], tagged: readonly SubjectHmacVersionedCandidate[]): QueuedDigestPlan {
  const entries = tagged.filter((c) => c && typeof c.hmac_hex === 'string' && c.hmac_hex.length > 0);
  const all = new Set([...flat, ...entries.map((c) => c.hmac_hex)]);
  const scoped = new Map<number, KeyedSubjectDigest>();
  // Earlier collectors also guessed the current version in envelopes with synthetic rotation labels.
  if (entries.some((c) => /^rotated_\d+$/.test(String(c.key_version)))) {
    return { scoped, unscoped: [...all] };
  }
  const unscoped = new Set(all);
  const ambiguous = new Set<string>();
  for (const c of entries) {
    const version = parseKeyVersionNumber(c.key_version);
    // Old collectors emitted the literal string '1' even when no version was configured.
    if (version === null || c.key_version === '1') {
      ambiguous.add(c.hmac_hex);
      continue;
    }
    const prev = scoped.get(version);
    scoped.set(version, {
      keyVersion: version,
      keyVersionLabel: String(c.key_version),
      hmacHex: c.format === 'canonical_v1' ? c.hmac_hex : prev?.hmacHex ?? c.hmac_hex,
      lookupCandidates: [...new Set([...(prev?.lookupCandidates ?? []), c.hmac_hex])],
    });
    unscoped.delete(c.hmac_hex);
  }
  return { scoped, unscoped: [...new Set([...unscoped, ...ambiguous])] };
}

/**
 * Tenant HMAC key-version registry implementing the non-destructive rotation
 * contract (`store-final.md` M8 / §5.7):
 * - Deletion lookup searches EVERY key version that still has rows (or is not destroyed)
 * - Key destruction is HARD-REFUSED while `activeRowCount > 0`
 */
export class TenantKeyVersionRegistry {
  private readonly keys = new Map<string, TenantHmacKeyVersion>();

  private keyId(tenantId: string, keyVersion: number): string {
    return `${tenantId}\u0000${keyVersion}`;
  }

  public registerKeyVersion(entry: Omit<TenantHmacKeyVersion, 'destroyedAtMs'>): void {
    const id = this.keyId(entry.tenantId, entry.keyVersion);
    if (this.keys.has(id)) {
      throw new Error(
        `HMAC key version ${entry.keyVersion} already registered for tenant ${entry.tenantId}`
      );
    }
    this.keys.set(id, { ...entry, destroyedAtMs: null });
  }

  public setActiveRowCount(
    tenantId: string,
    keyVersion: number,
    activeRowCount: number
  ): void {
    const id = this.keyId(tenantId, keyVersion);
    const existing = this.keys.get(id);
    if (!existing) {
      throw new Error(`Unknown key version ${keyVersion} for tenant ${tenantId}`);
    }
    if (existing.status === 'destroyed' && activeRowCount > 0) {
      throw new Error(
        `Cannot assign positive row count to destroyed key version ${keyVersion}`
      );
    }
    this.keys.set(id, { ...existing, activeRowCount: Math.max(0, activeRowCount) });
  }

  public getSearchableKeyVersions(tenantId: string): readonly TenantHmacKeyVersion[] {
    return Array.from(this.keys.values())
      .filter(
        (k) =>
          k.tenantId === tenantId &&
          (k.status !== 'destroyed' || k.activeRowCount > 0)
      )
      .sort((a, b) => a.keyVersion - b.keyVersion);
  }

  /**
   * Computes deterministic tenant-keyed digests across ALL searchable key
   * versions so rotated keys never miss historical rows during subject erasure.
   * Each entry includes `hmacHex` (canonical `v1`) and `lookupCandidates`
   * (canonical `v1` + legacy formats) via `computeSubjectHmacLookupCandidates`.
   */
  public computeSubjectDigestsAcrossAllVersions(
    tenantId: string,
    subjectKind: DeletionSubjectKind,
    rawSubjectValue: string
  ): readonly KeyedSubjectDigest[] {
    const versions = this.getSearchableKeyVersions(tenantId);
    return versions.map((kv) => ({
      keyVersion: kv.keyVersion,
      hmacHex: computeTenantSubjectHmac(
        kv.secretSalt,
        tenantId,
        subjectKind,
        rawSubjectValue
      ),
      lookupCandidates: computeSubjectHmacLookupCandidates({
        tenantId,
        subjectKind,
        subjectValue: rawSubjectValue,
        secretKeys: [kv.secretSalt],
      }),
    }));
  }

  /**
   * Flat deduplicated set of all canonical `v1` and legacy compatibility digests
   * across every searchable key version for this tenant.
   */
  public computeSubjectLookupCandidatesAcrossAllVersions(
    tenantId: string,
    subjectKind: DeletionSubjectKind,
    rawSubjectValue: string
  ): readonly string[] {
    const versions = this.getSearchableKeyVersions(tenantId);
    return computeSubjectHmacLookupCandidates({
      tenantId,
      subjectKind,
      subjectValue: rawSubjectValue,
      secretKeys: versions.map((kv) => kv.secretSalt),
    });
  }

  /**
   * Refuses to destroy any key version while rows referencing it still exist (`activeRowCount > 0`).
   */
  public tryDestroyKeyVersion(
    tenantId: string,
    keyVersion: number,
    nowMs = Date.now()
  ): KeyVersionDestructionResult {
    const id = this.keyId(tenantId, keyVersion);
    const existing = this.keys.get(id);
    if (!existing) {
      return {
        destroyed: false,
        tenantId,
        keyVersion,
        remainingRows: 0,
        reason: 'key_version_not_found',
      };
    }

    if (existing.activeRowCount > 0) {
      return {
        destroyed: false,
        tenantId,
        keyVersion,
        remainingRows: existing.activeRowCount,
        reason: `refused_rows_still_present: ${existing.activeRowCount} row(s) still reference key_version=${keyVersion}`,
      };
    }

    this.keys.set(id, {
      ...existing,
      status: 'destroyed',
      destroyedAtMs: nowMs,
    });

    return {
      destroyed: true,
      tenantId,
      keyVersion,
      remainingRows: 0,
      reason: 'destroyed_zero_remaining_rows',
    };
  }
}

export interface ResolvedSubjectKeys {
  readonly visitorKeys: readonly string[];
  readonly sessionKeys: readonly string[];
  readonly pvIds: readonly string[];
  readonly reqUids: readonly string[];
  readonly unitIds: readonly string[];
  readonly touchedPvHoursMs: readonly number[];
  readonly matchedKeyVersions: readonly number[];
}

export interface TableDeletionResult {
  readonly tableName: string;
  readonly store: 'clickhouse' | 'postgres';
  readonly deletionStrategy: DeletionTableEntry['deletionStrategy'];
  readonly matchedRows: number;
  readonly deletedRows: number;
  readonly rollupRebuildTriggered: boolean;
}

export interface ExternalStoreDeletionResult {
  readonly storeId: string;
  readonly storeKind: ExternalStoreDeletionSpec['storeKind'];
  readonly priorityOrder: number;
  readonly deletedObjects: number;
  readonly status: 'deleted' | 'expired_or_empty' | 'invalidated_by_epoch';
}

export interface ExportSinkDeletionNotification {
  readonly sinkId: string;
  readonly status: ExportDeletionStatus;
  readonly notifiedAtMs: number | null;
  readonly ackedAtMs: number | null;
  readonly deletionEpoch: number;
  readonly note: string;
}

export interface DeletionStoreAdapter {
  resolveSubjectKeys(args: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly subjectKind: DeletionSubjectKind;
    readonly rawSubjectValue: string | null;
    readonly keyedDigests: readonly KeyedSubjectDigest[];
  }): Promise<ResolvedSubjectKeys>;

  maskSubjectImmediate(args: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly requestId: string;
    readonly keyedDigests: readonly KeyedSubjectDigest[];
    readonly deletionEpoch: number;
  }): Promise<{
    readonly ecMemberSummaryDeleted: number;
    readonly edgeCacheKeysPurged: number;
  }>;

  purgeTable(args: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly table: DeletionTableEntry;
    readonly resolvedKeys: ResolvedSubjectKeys;
    readonly keyedDigests: readonly KeyedSubjectDigest[];
    readonly deletionEpoch: number;
  }): Promise<{ readonly matchedRows: number; readonly deletedRows: number }>;

  purgeExternalStore(args: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly storeSpec: ExternalStoreDeletionSpec;
    readonly resolvedKeys: ResolvedSubjectKeys;
    readonly deletionEpoch: number;
  }): Promise<{
    readonly deletedObjects: number;
    readonly status: ExternalStoreDeletionResult['status'];
  }>;

  markRollupHoursDirty(args: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly pvHoursMs: readonly number[];
    readonly nowMs: number;
  }): Promise<void>;

  notifyCustomerExportSinks(args: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly requestId: string;
    readonly deletionEpoch: number;
    readonly nowMs: number;
  }): Promise<readonly ExportSinkDeletionNotification[]>;
}

export interface DownstreamDeletionSinks {
  purgeLiveDurableObject?(args: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly unitIds: readonly string[];
    readonly pvIds: readonly string[];
    readonly keyedDigests: readonly KeyedSubjectDigest[];
    readonly deletionEpoch: number;
    readonly nowMs: number;
  }): Promise<number> | number;

  purgeContinuousStreams?(args: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly keyedDigests: readonly KeyedSubjectDigest[];
    readonly deletionEpoch: number;
    readonly nowMs: number;
  }): Promise<number> | number;

  purgeEcOrderSummary?(args: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly resolvedKeys: ResolvedSubjectKeys;
    readonly keyedDigests: readonly KeyedSubjectDigest[];
    readonly deletionEpoch: number;
    readonly nowMs: number;
  }): Promise<number> | number;

  purgeHeatmapCache?(args: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly pvHoursMs: readonly number[];
    readonly deletionEpoch: number;
    readonly nowMs: number;
  }): Promise<number> | number;

  purgeAskAndMlFeatureCache?(args: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly deletionEpoch: number;
    readonly nowMs: number;
  }): Promise<number> | number;

  registerWalReplayTombstones?(args: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly pvIds: readonly string[];
    readonly keyedDigests: readonly KeyedSubjectDigest[];
    readonly deletionEpoch: number;
    readonly purgedAtMs: number;
  }): Promise<void> | void;
}

export interface DownstreamPurgeSummary {
  readonly liveDoUnitsPurged: number;
  readonly continuousStreamItemsPurged: number;
  readonly ecOrderSummariesPurged: number;
  readonly heatmapCacheEntriesPurged: number;
  readonly askAndMlCacheEntriesPurged: number;
  readonly walReplayTombstonesRegistered: boolean;
}

export interface DeletionCertificate {
  readonly certificateVersion: 1;
  readonly requestId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly subjectKind: DeletionSubjectKind;
  readonly deletionEpoch: number;
  readonly planContentSha256: string;
  readonly requestedAtMs: number;
  readonly maskedAtMs: number;
  readonly purgedAtMs: number;
  readonly certifiedAtMs: number;
  readonly sla: {
    readonly maskedWithin24h: boolean;
    readonly purgedWithin5d: boolean;
    readonly certifiedWithin14d: boolean;
  };
  readonly keyVersionsSearched: readonly number[];
  readonly totalMatchedRows: number;
  readonly totalDeletedRows: number;
  readonly tableResults: readonly TableDeletionResult[];
  readonly externalStoreResults: readonly ExternalStoreDeletionResult[];
  readonly exportNotifications: readonly ExportSinkDeletionNotification[];
  readonly unreachableClasses: DeletionPlan['unreachableClasses'];
  readonly downstreamPurgeSummary?: DownstreamPurgeSummary;
}

export interface DeletionRequestRecord {
  readonly requestId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly subjectKind: DeletionSubjectKind;
  /**
   * Cleared to `null` once certificate is issued (audit receipt retained without raw digest).
   */
  readonly subjectDigestRedacted: boolean;
  readonly state: DeletionRequestState;
  readonly deletionEpoch: number;
  readonly requestedAtMs: number;
  readonly maskDeadlineMs: number;
  readonly purgeDeadlineMs: number;
  readonly backupDeadlineMs: number;
  readonly overdueAlertAtMs: number;
  readonly certDeadlineMs: number;
  readonly maskedAtMs: number | null;
  readonly purgedAtMs: number | null;
  readonly certifiedAtMs: number | null;
  readonly certificate: DeletionCertificate | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface InternalRequestState {
  record: DeletionRequestRecord;
  rawSubjectValue: string | null;
  queuedDigestPlan: QueuedDigestPlan | null;
  keyedDigests: readonly KeyedSubjectDigest[];
  ecMemberDeleted: number;
  edgeCachePurged: number;
  tableResults: readonly TableDeletionResult[];
  externalStoreResults: readonly ExternalStoreDeletionResult[];
  exportNotifications: readonly ExportSinkDeletionNotification[];
  keyVersionsSearched: readonly number[];
  downstreamSummary: {
    liveDoUnitsPurged: number;
    continuousStreamItemsPurged: number;
    ecOrderSummariesPurged: number;
    heatmapCacheEntriesPurged: number;
    askAndMlCacheEntriesPurged: number;
    walReplayTombstonesRegistered: boolean;
  };
}

export class DeletionExecutionEngine {
  public readonly plan: DeletionPlan;
  private readonly requests = new Map<string, InternalRequestState>();
  private deletionEpochCounter = 0;

  private readonly maskHours: number;
  private readonly purgeDays: number;
  private readonly backupDays: number;
  private readonly overdueAlertDay: number;
  private readonly certDays: number;

  public constructor(
    private readonly storeAdapter: DeletionStoreAdapter,
    private readonly keyRegistry: TenantKeyVersionRegistry,
    private readonly downstreamSinks?: DownstreamDeletionSinks
  ) {
    this.plan = generateDeletionPlan(CANONICAL_SCHEMA);
    assertDeletionPlanCoverage(CANONICAL_SCHEMA, this.plan);

    const maskConst = getConstant('store.deletion_mask_hours');
    const purgeConst = getConstant('store.deletion_purge_days');
    const certConst = getConstant('store.deletion_cert_days');

    this.maskHours =
      typeof maskConst?.value === 'number'
        ? maskConst.value
        : this.plan.deadlines.maskedWithinHours;
    this.purgeDays =
      typeof purgeConst?.value === 'number'
        ? purgeConst.value
        : this.plan.deadlines.purgedWithinDays;
    this.backupDays = this.plan.deadlines.backupExpiryDays;
    this.overdueAlertDay = this.plan.deadlines.overdueAlertDay;
    this.certDays =
      typeof certConst?.value === 'number'
        ? certConst.value
        : this.plan.deadlines.certifiedWithinDays;
  }

  public getCurrentDeletionEpoch(): number {
    return this.deletionEpochCounter;
  }

  private resolveRequestDigests(
    tenantId: string,
    kind: DeletionSubjectKind,
    raw: string | null,
    plan: QueuedDigestPlan
  ): readonly KeyedSubjectDigest[] {
    const computed = raw === null ? [] : this.keyRegistry.computeSubjectDigestsAcrossAllVersions(tenantId, kind, raw);
    const fromRaw = new Map(computed.map((d) => [d.keyVersion, d] as const));
    const searchable = this.keyRegistry.getSearchableKeyVersions(tenantId).map((v) => v.keyVersion);
    if (plan.unscoped.length > 0 && searchable.length === 0) {
      throw new Error('Unversioned deletion candidates require a searchable tenant key version');
    }
    const versions = new Set([...fromRaw.keys(), ...plan.scoped.keys(), ...(plan.unscoped.length ? searchable : [])]);
    if (versions.size === 0) throw new Error('No searchable key version for deletion');
    return [...versions].sort((a, b) => a - b).map((keyVersion) => {
      const derived = fromRaw.get(keyVersion);
      const tagged = plan.scoped.get(keyVersion);
      const candidates = [...new Set([
        ...(derived?.lookupCandidates ?? []),
        ...(tagged?.lookupCandidates ?? []),
        ...(searchable.includes(keyVersion) ? plan.unscoped : []),
      ])];
      return {
        keyVersion,
        ...(tagged ? { keyVersionLabel: tagged.keyVersionLabel } : {}),
        hmacHex: derived?.hmacHex ?? tagged?.hmacHex ?? candidates[0]!,
        lookupCandidates: candidates,
      };
    });
  }

  public scheduleRequest(args: {
    readonly requestId: string;
    readonly tenantId: string;
    readonly siteId: string;
    readonly subjectKind: DeletionSubjectKind;
    readonly rawSubjectValue?: string;
    readonly subjectHmac?: string | null;
    readonly subjectHmacCandidates?: readonly string[];
    readonly subject_hmac_candidates?: readonly string[];
    readonly subjectHmacVersionedCandidates?: readonly SubjectHmacVersionedCandidate[];
    readonly subject_hmac_versioned_candidates?: readonly SubjectHmacVersionedCandidate[];
    readonly requestedAtMs?: number;
  }): DeletionRequestRecord {
    if (this.requests.has(args.requestId)) {
      throw new Error(`Deletion request "${args.requestId}" already exists`);
    }
    if (!this.plan.acceptedSubjects.includes(args.subjectKind)) {
      throw new Error(`Unsupported subject_kind: ${args.subjectKind}`);
    }

    const rawSubject = typeof args.rawSubjectValue === 'string' && args.rawSubjectValue.length > 0
      ? args.rawSubjectValue : null;
    const flat = [args.subjectHmac, ...(args.subjectHmacCandidates ?? args.subject_hmac_candidates ?? [])]
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    const plan = planQueuedDigests(flat, args.subjectHmacVersionedCandidates ?? args.subject_hmac_versioned_candidates ?? []);
    if (rawSubject === null && plan.scoped.size === 0 && plan.unscoped.length === 0) {
      throw new Error('Deletion request requires either rawSubjectValue or non-empty subjectHmacCandidates');
    }
    const keyedDigests = this.resolveRequestDigests(args.tenantId, args.subjectKind, rawSubject, plan);
    const keyVersionsSearched = keyedDigests.map((d) => d.keyVersion);
    const requestedAtMs = args.requestedAtMs ?? Date.now();
    this.deletionEpochCounter += 1;
    const deletionEpoch = this.deletionEpochCounter;

    const record: DeletionRequestRecord = {
      requestId: args.requestId,
      tenantId: args.tenantId,
      siteId: args.siteId,
      subjectKind: args.subjectKind,
      subjectDigestRedacted: false,
      state: 'scheduled',
      deletionEpoch,
      requestedAtMs,
      maskDeadlineMs: requestedAtMs + this.maskHours * HOUR_MS,
      purgeDeadlineMs: requestedAtMs + this.purgeDays * DAY_MS,
      backupDeadlineMs: requestedAtMs + this.backupDays * DAY_MS,
      overdueAlertAtMs: requestedAtMs + this.overdueAlertDay * DAY_MS,
      certDeadlineMs: requestedAtMs + this.certDays * DAY_MS,
      maskedAtMs: null,
      purgedAtMs: null,
      certifiedAtMs: null,
      certificate: null,
    };

    this.requests.set(args.requestId, {
      record,
      rawSubjectValue: rawSubject,
      queuedDigestPlan: plan,
      keyedDigests,
      ecMemberDeleted: 0,
      edgeCachePurged: 0,
      tableResults: [],
      externalStoreResults: [],
      exportNotifications: [],
      keyVersionsSearched,
      downstreamSummary: {
        liveDoUnitsPurged: 0,
        continuousStreamItemsPurged: 0,
        ecOrderSummariesPurged: 0,
        heatmapCacheEntriesPurged: 0,
        askAndMlCacheEntriesPurged: 0,
        walReplayTombstonesRegistered: false,
      },
    });

    return record;
  }

  /**
   * Phase 1 (<=24h): Immediately deletes `ec_member_summary` first, purges edge
   * caches, and activates subject masking so reads stop returning subject data.
   */
  public async executeMaskPhase(
    requestId: string,
    nowMs = Date.now()
  ): Promise<DeletionRequestRecord> {
    const internal = this.requireRequest(requestId);
    if (internal.record.state !== 'scheduled' && internal.record.state !== 'overdue') {
      throw new Error(
        `Cannot execute mask phase from state "${internal.record.state}"`
      );
    }

    const maskOutcome = await this.storeAdapter.maskSubjectImmediate({
      tenantId: internal.record.tenantId,
      siteId: internal.record.siteId,
      requestId,
      keyedDigests: internal.keyedDigests,
      deletionEpoch: internal.record.deletionEpoch,
    });

    if (this.downstreamSinks?.purgeLiveDurableObject) {
      const n = await this.downstreamSinks.purgeLiveDurableObject({
        tenantId: internal.record.tenantId,
        siteId: internal.record.siteId,
        unitIds: [],
        pvIds: [],
        keyedDigests: internal.keyedDigests,
        deletionEpoch: internal.record.deletionEpoch,
        nowMs,
      });
      internal.downstreamSummary.liveDoUnitsPurged += n;
    }
    if (this.downstreamSinks?.purgeContinuousStreams) {
      const n = await this.downstreamSinks.purgeContinuousStreams({
        tenantId: internal.record.tenantId,
        siteId: internal.record.siteId,
        keyedDigests: internal.keyedDigests,
        deletionEpoch: internal.record.deletionEpoch,
        nowMs,
      });
      internal.downstreamSummary.continuousStreamItemsPurged += n;
    }

    internal.ecMemberDeleted = maskOutcome.ecMemberSummaryDeleted;
    internal.edgeCachePurged = maskOutcome.edgeCacheKeysPurged;
    internal.record = {
      ...internal.record,
      state: 'masked',
      maskedAtMs: nowMs,
    };
    return internal.record;
  }

  /**
   * Phase 2 (<=5d): Resolves subject keys across ALL searchable HMAC key versions,
   * executes physical purges across every deletable table & external store in
   * `DeletionPlan` order, marks affected rollup hours dirty, and dispatches
   * §5.12 customer export notifications.
   */
  public async executePhysicalPurgePhase(
    requestId: string,
    nowMs = Date.now()
  ): Promise<DeletionRequestRecord> {
    const internal = this.requireRequest(requestId);
    if (internal.record.state !== 'masked' && internal.record.state !== 'overdue') {
      throw new Error(
        `Cannot execute physical purge phase from state "${internal.record.state}" (mask phase must complete first)`
      );
    }
    if (internal.record.subjectDigestRedacted || internal.queuedDigestPlan === null) {
      throw new Error(`Subject value already redacted for request "${requestId}"`);
    }

    const keyedDigests = this.resolveRequestDigests(
      internal.record.tenantId, internal.record.subjectKind, internal.rawSubjectValue, internal.queuedDigestPlan
    );
    internal.keyedDigests = keyedDigests;
    internal.keyVersionsSearched = keyedDigests.map((d) => d.keyVersion);

    const resolvedKeys = await this.storeAdapter.resolveSubjectKeys({
      tenantId: internal.record.tenantId,
      siteId: internal.record.siteId,
      subjectKind: internal.record.subjectKind,
      rawSubjectValue: internal.rawSubjectValue,
      keyedDigests,
    });

    // Execute every deletable table entry in canonical executionOrder
    const tableResults: TableDeletionResult[] = [];
    let needsRollupRebuild = false;

    for (const table of this.plan.tableEntries) {
      if (
        table.deletionStrategy === 'not_applicable_aggregate' ||
        table.deletionStrategy === 'not_applicable_non_personal'
      ) {
        continue;
      }

      const res = await this.storeAdapter.purgeTable({
        tenantId: internal.record.tenantId,
        siteId: internal.record.siteId,
        table,
        resolvedKeys,
        keyedDigests,
        deletionEpoch: internal.record.deletionEpoch,
      });

      const triggerRebuild = table.requiresRollupRebuild && res.deletedRows > 0;
      if (triggerRebuild) {
        needsRollupRebuild = true;
      }

      tableResults.push({
        tableName: table.tableName,
        store: table.store,
        deletionStrategy: table.deletionStrategy,
        matchedRows: res.matchedRows,
        deletedRows: res.deletedRows,
        rollupRebuildTriggered: triggerRebuild,
      });
    }

    if (needsRollupRebuild && resolvedKeys.touchedPvHoursMs.length > 0) {
      await this.storeAdapter.markRollupHoursDirty({
        tenantId: internal.record.tenantId,
        siteId: internal.record.siteId,
        pvHoursMs: resolvedKeys.touchedPvHoursMs,
        nowMs,
      });
    }

    // Execute every external store entry in canonical priorityOrder
    const externalStoreResults: ExternalStoreDeletionResult[] = [];
    for (const ext of this.plan.externalStoreEntries) {
      if (ext.storeKind === 'ec_member_summary') {
        externalStoreResults.push({
          storeId: ext.id,
          storeKind: ext.storeKind,
          priorityOrder: ext.priorityOrder,
          deletedObjects: internal.ecMemberDeleted,
          status: internal.ecMemberDeleted > 0 ? 'deleted' : 'expired_or_empty',
        });
        continue;
      }
      if (ext.storeKind === 'edge_cache') {
        externalStoreResults.push({
          storeId: ext.id,
          storeKind: ext.storeKind,
          priorityOrder: ext.priorityOrder,
          deletedObjects: internal.edgeCachePurged,
          status: internal.edgeCachePurged > 0 ? 'deleted' : 'expired_or_empty',
        });
        continue;
      }

      const extRes = await this.storeAdapter.purgeExternalStore({
        tenantId: internal.record.tenantId,
        siteId: internal.record.siteId,
        storeSpec: ext,
        resolvedKeys,
        deletionEpoch: internal.record.deletionEpoch,
      });
      externalStoreResults.push({
        storeId: ext.id,
        storeKind: ext.storeKind,
        priorityOrder: ext.priorityOrder,
        deletedObjects: extRes.deletedObjects,
        status: extRes.status,
      });
    }

    const exportNotifications = await this.storeAdapter.notifyCustomerExportSinks({
      tenantId: internal.record.tenantId,
      siteId: internal.record.siteId,
      requestId,
      deletionEpoch: internal.record.deletionEpoch,
      nowMs,
    });

    if (this.downstreamSinks?.purgeLiveDurableObject) {
      const n = await this.downstreamSinks.purgeLiveDurableObject({
        tenantId: internal.record.tenantId,
        siteId: internal.record.siteId,
        unitIds: resolvedKeys.unitIds,
        pvIds: resolvedKeys.pvIds,
        keyedDigests,
        deletionEpoch: internal.record.deletionEpoch,
        nowMs,
      });
      internal.downstreamSummary.liveDoUnitsPurged += n;
    }
    if (this.downstreamSinks?.purgeEcOrderSummary) {
      const n = await this.downstreamSinks.purgeEcOrderSummary({
        tenantId: internal.record.tenantId,
        siteId: internal.record.siteId,
        resolvedKeys,
        keyedDigests,
        deletionEpoch: internal.record.deletionEpoch,
        nowMs,
      });
      internal.downstreamSummary.ecOrderSummariesPurged += n;
    }
    if (this.downstreamSinks?.purgeHeatmapCache) {
      const n = await this.downstreamSinks.purgeHeatmapCache({
        tenantId: internal.record.tenantId,
        siteId: internal.record.siteId,
        pvHoursMs: resolvedKeys.touchedPvHoursMs,
        deletionEpoch: internal.record.deletionEpoch,
        nowMs,
      });
      internal.downstreamSummary.heatmapCacheEntriesPurged += n;
    }
    if (this.downstreamSinks?.purgeAskAndMlFeatureCache) {
      const n = await this.downstreamSinks.purgeAskAndMlFeatureCache({
        tenantId: internal.record.tenantId,
        siteId: internal.record.siteId,
        deletionEpoch: internal.record.deletionEpoch,
        nowMs,
      });
      internal.downstreamSummary.askAndMlCacheEntriesPurged += n;
    }
    if (this.downstreamSinks?.registerWalReplayTombstones) {
      await this.downstreamSinks.registerWalReplayTombstones({
        tenantId: internal.record.tenantId,
        siteId: internal.record.siteId,
        pvIds: resolvedKeys.pvIds,
        keyedDigests,
        deletionEpoch: internal.record.deletionEpoch,
        purgedAtMs: nowMs,
      });
      internal.downstreamSummary.walReplayTombstonesRegistered = true;
    }

    internal.tableResults = tableResults;
    internal.externalStoreResults = externalStoreResults;
    internal.exportNotifications = exportNotifications;
    internal.record = {
      ...internal.record,
      state: 'purged',
      purgedAtMs: nowMs,
    };

    return internal.record;
  }

  /**
   * Phase 3 (<=14d): Redacts subject identifier material and issues an immutable
   * `DeletionCertificate` listing matched/deleted counts, searched key versions,
   * §5.12 export notification statuses, and explicitly named unreachable classes.
   */
  public issueCertificate(
    requestId: string,
    nowMs = Date.now()
  ): DeletionCertificate {
    const internal = this.requireRequest(requestId);
    if (internal.record.state !== 'purged' && internal.record.state !== 'overdue') {
      throw new Error(
        `Cannot issue certificate from state "${internal.record.state}" (physical purge must complete first)`
      );
    }
    if (internal.record.maskedAtMs === null || internal.record.purgedAtMs === null) {
      throw new Error(`Incomplete timestamps for deletion request "${requestId}"`);
    }

    let totalMatchedRows = 0;
    let totalDeletedRows = 0;
    for (const tr of internal.tableResults) {
      totalMatchedRows += tr.matchedRows;
      totalDeletedRows += tr.deletedRows;
    }

    const certificate: DeletionCertificate = {
      certificateVersion: 1,
      requestId: internal.record.requestId,
      tenantId: internal.record.tenantId,
      siteId: internal.record.siteId,
      subjectKind: internal.record.subjectKind,
      deletionEpoch: internal.record.deletionEpoch,
      planContentSha256: this.plan.contentSha256,
      requestedAtMs: internal.record.requestedAtMs,
      maskedAtMs: internal.record.maskedAtMs,
      purgedAtMs: internal.record.purgedAtMs,
      certifiedAtMs: nowMs,
      sla: {
        maskedWithin24h:
          internal.record.maskedAtMs <= internal.record.maskDeadlineMs,
        purgedWithin5d:
          internal.record.purgedAtMs <= internal.record.purgeDeadlineMs,
        certifiedWithin14d: nowMs <= internal.record.certDeadlineMs,
      },
      keyVersionsSearched: [...internal.keyVersionsSearched],
      totalMatchedRows,
      totalDeletedRows,
      tableResults: [...internal.tableResults],
      externalStoreResults: [...internal.externalStoreResults],
      exportNotifications: [...internal.exportNotifications],
      unreachableClasses: [...this.plan.unreachableClasses],
      downstreamPurgeSummary: { ...internal.downstreamSummary },
    };

    // Redact raw subject identifier and precomputed digest candidates once certified
    internal.rawSubjectValue = null;
    internal.queuedDigestPlan = null;
    internal.keyedDigests = [];
    internal.record = {
      ...internal.record,
      subjectDigestRedacted: true,
      state: 'certified',
      certifiedAtMs: nowMs,
      certificate,
    };

    return certificate;
  }

  /**
   * Evaluates SLA deadline health; flips uncertified requests at day >= 10
   * (`overdueAlertDay`) to `'overdue'` so operations are paged before day 14.
   */
  public evaluateSlaStatus(
    requestId: string,
    nowMs = Date.now()
  ): { readonly overdueAlertRaised: boolean; readonly state: DeletionRequestState } {
    const internal = this.requireRequest(requestId);
    if (
      internal.record.state === 'certified' ||
      internal.record.state === 'cancelled'
    ) {
      return { overdueAlertRaised: false, state: internal.record.state };
    }

    if (nowMs >= internal.record.overdueAlertAtMs) {
      internal.record = { ...internal.record, state: 'overdue' };
      return { overdueAlertRaised: true, state: 'overdue' };
    }

    return { overdueAlertRaised: false, state: internal.record.state };
  }

  public getRequest(requestId: string): DeletionRequestRecord | undefined {
    return this.requests.get(requestId)?.record;
  }

  private requireRequest(requestId: string): InternalRequestState {
    const found = this.requests.get(requestId);
    if (!found) {
      throw new Error(`Unknown deletion request "${requestId}"`);
    }
    return found;
  }
}
