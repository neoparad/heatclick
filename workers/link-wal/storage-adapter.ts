/**
 * UGOKI LINK v2 — Storage Abstraction Layer (§5.12 Tiers 1/2/3 & Decision 29 Region Tagging)
 *
 * Isolates all WAL/quarantine object storage behind a single region-pinned
 * adapter boundary so tenants can select:
 * - Tier 1: LINK-hosted R2 WAL + ClickHouse (`tier1_link_managed`)
 * - Tier 2: LINK-hosted primary + continuous export sink (`tier2_link_plus_export`)
 * - Tier 3: Customer-hosted System of Record (`tier3_customer_sor`)
 */

import {
  canonicalJsonStringify,
  sha256Hex,
} from '../../packages/contract/schema';
import {
  VALID_DATA_REGIONS,
  type DataRegion,
  type R2BucketLike,
  type R2ListResult,
  type R2ObjectLike,
  type R2PutOptions,
  type StorageTier,
} from './types';

export const R2_MAX_DELETE_BATCH = 1000;

/**
 * Deletes R2 objects in sequential chunks of at most `R2_MAX_DELETE_BATCH` (1,000) keys
 * so multi-page deletion sweeps never exceed R2's 1,000-key batch limit (Codex R2 #13).
 */
export async function deleteKeysInChunks(
  bucket: R2BucketLike,
  keys: string | readonly string[],
  maxBatchSize = R2_MAX_DELETE_BATCH
): Promise<void> {
  if (typeof keys === 'string') {
    await bucket.delete(keys);
    return;
  }
  if (keys.length === 0) return;
  const chunkSize = Math.max(1, Math.min(R2_MAX_DELETE_BATCH, Math.floor(maxBatchSize)));
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    await bucket.delete(chunk);
  }
}

export function computeExportIdempotencyKey(sinkId: string, walKey: string): string {
  return sha256Hex(`${sinkId}\u0000${walKey}`);
}

export interface ExportNotificationReceipt {
  readonly exportBatchId: string;
  readonly sinkId: string;
  readonly region: DataRegion;
  readonly walKey: string;
  readonly idempotencyKey?: string;
  readonly tenantIds: readonly string[];
  readonly deletionEpoch: number;
  readonly exportedAtMs: number;
}

export interface ExportSinkPort {
  readonly sinkId: string;
  readonly region: DataRegion;
  writeExportBatch(args: {
    readonly walKey: string;
    readonly body: string;
    readonly tenantIds: readonly string[];
    readonly deletionEpoch: number;
    readonly exportedAtMs: number;
    readonly idempotencyKey: string;
  }): Promise<ExportNotificationReceipt>;
}

export interface StorageAdapterDescriptor {
  readonly tier: StorageTier;
  readonly region: DataRegion;
  readonly linkRetainsPrimaryCopy: boolean;
  readonly continuousExportSinkId: string | null;
  readonly customerSorBucketId: string | null;
}

export interface WalPutOutcome {
  readonly key: string;
  readonly written: boolean;
  readonly deduped: boolean;
  readonly region: DataRegion;
  readonly tier: StorageTier;
  readonly exportReceipt: ExportNotificationReceipt | null;
}

export interface StorageTierAdapter {
  readonly descriptor: StorageAdapterDescriptor;
  putWalImmutable(args: {
    readonly key: string;
    readonly body: string;
    readonly tenantIds: readonly string[];
    readonly deletionEpoch: number;
    readonly nowMs: number;
    readonly customMetadata?: Readonly<Record<string, string>>;
  }): Promise<WalPutOutcome>;
  putQuarantineObject(
    key: string,
    body: string,
    customMetadata?: Readonly<Record<string, string>>
  ): Promise<R2ObjectLike | null>;
  getObject(key: string): Promise<R2ObjectLike | null>;
  listObjects(prefix: string, limit?: number, cursor?: string): Promise<R2ListResult>;
  deleteObjects(keys: string | readonly string[]): Promise<void>;
}

export function isValidDataRegion(value: unknown): value is DataRegion {
  return (
    typeof value === 'string' &&
    (VALID_DATA_REGIONS as readonly string[]).includes(value)
  );
}

/**
 * Decision 29 (D-29) residency boundary check.
 * Rejects any cross-region write attempt before bytes touch storage.
 */
export function assertRegionPinned(
  expectedRegion: DataRegion,
  actualRegion: unknown
): asserts actualRegion is DataRegion {
  if (!isValidDataRegion(actualRegion)) {
    throw new Error(`Invalid storage_region "${String(actualRegion)}" (expected one of ${VALID_DATA_REGIONS.join(', ')})`);
  }
  if (actualRegion !== expectedRegion) {
    throw new Error(
      `Data residency violation (D-29): writer pinned to region "${expectedRegion}" cannot accept "${actualRegion}"`
    );
  }
}

export function formatUtcMinuteBucket(timestampMs: number): string {
  const d = new Date(timestampMs);
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const min = d.getUTCMinutes().toString().padStart(2, '0');
  return `${yyyy}${mm}${dd}T${hh}${min}Z`;
}

export function formatUtcDayBucket(timestampMs: number): string {
  const d = new Date(timestampMs);
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export class CrossTenantWalViolationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CrossTenantWalViolationError';
  }
}

export function assertSingleTenantWalBatch(
  walKey: string,
  body: string,
  tenantIds: readonly string[],
  boundScope?: { readonly tenantId: string; readonly siteId?: string }
): void {
  if (tenantIds.length !== 1) {
    throw new CrossTenantWalViolationError(
      `Cross-tenant WAL batch rejected on "${walKey}": expected exactly 1 tenantId, got [${tenantIds.join(', ')}] (C-15)`
    );
  }
  const expectedTenant = boundScope?.tenantId ?? tenantIds[0]!;
  if (tenantIds[0] !== expectedTenant) {
    throw new CrossTenantWalViolationError(
      `Tenant mismatch on WAL write "${walKey}": adapter bound to "${expectedTenant}", got "${tenantIds[0]}" (C-15)`
    );
  }

  let parsed: {
    readonly tenant_id?: string;
    readonly site_id?: string;
    readonly records?: ReadonlyArray<{ readonly tenant_id?: string; readonly site_id?: string }>;
  };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new CrossTenantWalViolationError(`Malformed WAL JSON body on "${walKey}"`);
  }

  if (parsed.tenant_id !== undefined && parsed.tenant_id !== expectedTenant) {
    throw new CrossTenantWalViolationError(
      `WAL object header tenant_id "${parsed.tenant_id}" mismatches expected "${expectedTenant}" on "${walKey}"`
    );
  }
  if (boundScope?.siteId && parsed.site_id !== undefined && parsed.site_id !== boundScope.siteId) {
    throw new CrossTenantWalViolationError(
      `WAL object header site_id "${parsed.site_id}" mismatches bound site "${boundScope.siteId}" on "${walKey}"`
    );
  }

  if (Array.isArray(parsed.records)) {
    for (const rec of parsed.records) {
      if (rec.tenant_id !== expectedTenant) {
        throw new CrossTenantWalViolationError(
          `Mixed-tenant record ("${String(rec.tenant_id)}" !== "${expectedTenant}") blocked in WAL "${walKey}" (C-15)`
        );
      }
      if (boundScope?.siteId && rec.site_id !== boundScope.siteId) {
        throw new CrossTenantWalViolationError(
          `Mixed-site record ("${String(rec.site_id)}" !== "${boundScope.siteId}") blocked in WAL "${walKey}" (C-15)`
        );
      }
    }
  }
}

export function formatWalObjectKey(
  region: DataRegion,
  shardId: number,
  tenantId: string,
  siteId: string,
  minuteUtc: string,
  sha256: string
): string {
  const shardPadded = Math.max(0, Math.floor(shardId)).toString().padStart(4, '0');
  return `wal/${region}/${shardPadded}/${tenantId}/${siteId}/${minuteUtc}/${sha256}.json`;
}

export function formatQuarantineObjectKey(
  region: DataRegion,
  tenantId: string,
  siteId: string,
  dayUtc: string,
  sha256: string
): string {
  return `quarantine/${region}/${tenantId}/${siteId}/${dayUtc}/${sha256}.json`;
}

export function formatExportReceiptKey(
  region: DataRegion,
  tenantId: string,
  siteId: string,
  walKey: string,
  sinkId?: string
): string {
  const keyDigest = sinkId
    ? computeExportIdempotencyKey(sinkId, walKey)
    : sha256Hex(walKey);
  return `export-receipts/${region}/${tenantId}/${siteId}/${keyDigest}.json`;
}

/**
 * Tier 1: LINK-managed primary R2 bucket in the pinned region.
 */
export class LinkManagedStorageAdapter implements StorageTierAdapter {
  public readonly descriptor: StorageAdapterDescriptor;

  public constructor(
    private readonly bucket: R2BucketLike,
    region: DataRegion
  ) {
    this.descriptor = {
      tier: 'tier1_link_managed',
      region,
      linkRetainsPrimaryCopy: true,
      continuousExportSinkId: null,
      customerSorBucketId: null,
    };
  }

  public async putWalImmutable(args: {
    readonly key: string;
    readonly body: string;
    readonly tenantIds: readonly string[];
    readonly deletionEpoch: number;
    readonly nowMs: number;
    readonly customMetadata?: Readonly<Record<string, string>>;
  }): Promise<WalPutOutcome> {
    const putOpts: R2PutOptions = {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        ...args.customMetadata,
        storage_region: this.descriptor.region,
        storage_tier: this.descriptor.tier,
        deletion_epoch: String(args.deletionEpoch),
      },
    };
    const obj = await this.bucket.put(args.key, args.body, putOpts);
    return {
      key: args.key,
      written: obj !== null,
      deduped: obj === null,
      region: this.descriptor.region,
      tier: this.descriptor.tier,
      exportReceipt: null,
    };
  }

  public async putQuarantineObject(
    key: string,
    body: string,
    customMetadata?: Readonly<Record<string, string>>
  ): Promise<R2ObjectLike | null> {
    return this.bucket.put(key, body, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        ...customMetadata,
        storage_region: this.descriptor.region,
        storage_tier: this.descriptor.tier,
      },
    });
  }

  public async getObject(key: string): Promise<R2ObjectLike | null> {
    return this.bucket.get(key);
  }

  public async listObjects(prefix: string, limit = 1000, cursor?: string): Promise<R2ListResult> {
    return this.bucket.list({ prefix, limit, cursor });
  }

  public async deleteObjects(keys: string | readonly string[]): Promise<void> {
    await deleteKeysInChunks(this.bucket, keys);
  }
}

/**
 * Tier 2: LINK-managed primary + continuous export to customer sink (§5.12).
 */
export class LinkPlusExportStorageAdapter implements StorageTierAdapter {
  public readonly descriptor: StorageAdapterDescriptor;
  private readonly primary: LinkManagedStorageAdapter;
  private readonly receiptBucket: R2BucketLike;

  public constructor(
    primaryBucket: R2BucketLike,
    private readonly exportSink: ExportSinkPort,
    region: DataRegion,
    private readonly boundScope?: { readonly tenantId: string; readonly siteId?: string },
    receiptBucket?: R2BucketLike
  ) {
    assertRegionPinned(region, exportSink.region);
    this.primary = new LinkManagedStorageAdapter(primaryBucket, region);
    this.receiptBucket = receiptBucket ?? primaryBucket;
    this.descriptor = {
      tier: 'tier2_link_plus_export',
      region,
      linkRetainsPrimaryCopy: true,
      continuousExportSinkId: exportSink.sinkId,
      customerSorBucketId: null,
    };
  }

  private extractSiteId(body: string): string | null {
    try {
      const parsed = JSON.parse(body) as { readonly site_id?: unknown };
      return typeof parsed.site_id === 'string' && parsed.site_id.length > 0
        ? parsed.site_id
        : null;
    } catch {
      return null;
    }
  }

  public async putWalImmutable(args: {
    readonly key: string;
    readonly body: string;
    readonly tenantIds: readonly string[];
    readonly deletionEpoch: number;
    readonly nowMs: number;
    readonly customMetadata?: Readonly<Record<string, string>>;
  }): Promise<WalPutOutcome> {
    assertSingleTenantWalBatch(args.key, args.body, args.tenantIds, this.boundScope);
    const primaryRes = await this.primary.putWalImmutable({
      ...args,
      customMetadata: {
        ...args.customMetadata,
        storage_tier: this.descriptor.tier,
        export_sink_id: this.exportSink.sinkId,
      },
    });

    const tenantId = args.tenantIds[0]!;
    const siteId =
      args.customMetadata?.site_id ??
      this.boundScope?.siteId ??
      this.extractSiteId(args.body) ??
      '_default_site';
    const idempotencyKey = computeExportIdempotencyKey(this.exportSink.sinkId, args.key);
    const receiptKey = formatExportReceiptKey(
      this.descriptor.region,
      tenantId,
      siteId,
      args.key,
      this.exportSink.sinkId
    );
    const legacyReceiptKey = formatExportReceiptKey(
      this.descriptor.region,
      tenantId,
      siteId,
      args.key
    );

    // Codex #12 / R3 #12: Always check durable export receipt even when primary was already written
    // (`primaryRes.written === false`), and check BOTH the sink-scoped receipt key AND the legacy
    // receipt key (`export-receipts/{region}/{tenantId}/{siteId}/{sha256Hex(walKey)}.json`) so
    // WALs already exported under the legacy receipt format are never re-exported!
    const existingReceipt =
      (await this.receiptBucket.get(receiptKey)) ??
      (await this.receiptBucket.get(legacyReceiptKey));
    if (existingReceipt !== null) {
      return {
        ...primaryRes,
        tier: this.descriptor.tier,
        exportReceipt: null,
      };
    }

    const rawExportReceipt = await this.exportSink.writeExportBatch({
      walKey: args.key,
      body: args.body,
      tenantIds: args.tenantIds,
      deletionEpoch: args.deletionEpoch,
      exportedAtMs: args.nowMs,
      idempotencyKey,
    });
    const exportReceipt: ExportNotificationReceipt = {
      ...rawExportReceipt,
      idempotencyKey: rawExportReceipt.idempotencyKey ?? idempotencyKey,
    };

    await this.receiptBucket.put(receiptKey, canonicalJsonStringify(exportReceipt), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        storage_region: this.descriptor.region,
        tenant_id: tenantId,
        site_id: siteId,
        wal_key: args.key,
        export_sink_id: this.exportSink.sinkId,
        export_batch_id: exportReceipt.exportBatchId,
        idempotency_key: idempotencyKey,
      },
    });

    return {
      ...primaryRes,
      tier: this.descriptor.tier,
      exportReceipt,
    };
  }

  public async putQuarantineObject(
    key: string,
    body: string,
    customMetadata?: Readonly<Record<string, string>>
  ): Promise<R2ObjectLike | null> {
    return this.primary.putQuarantineObject(key, body, {
      ...customMetadata,
      storage_tier: this.descriptor.tier,
    });
  }

  public async getObject(key: string): Promise<R2ObjectLike | null> {
    return this.primary.getObject(key);
  }

  public async listObjects(prefix: string, limit = 1000, cursor?: string): Promise<R2ListResult> {
    return this.primary.listObjects(prefix, limit, cursor);
  }

  public async deleteObjects(keys: string | readonly string[]): Promise<void> {
    await this.primary.deleteObjects(keys);
  }
}

/**
 * Tier 3: Customer-hosted storage as System of Record (§5.12).
 * Primary WAL objects are written directly into the customer's region-pinned
 * bucket; LINK retains zero long-term primary copy.
 */
export class CustomerSorStorageAdapter implements StorageTierAdapter {
  public readonly descriptor: StorageAdapterDescriptor;

  public constructor(
    private readonly customerBucket: R2BucketLike,
    customerSorBucketId: string,
    region: DataRegion,
    private readonly boundScope?: { readonly tenantId: string; readonly siteId?: string }
  ) {
    this.descriptor = {
      tier: 'tier3_customer_sor',
      region,
      linkRetainsPrimaryCopy: false,
      continuousExportSinkId: null,
      customerSorBucketId,
    };
  }

  public async putWalImmutable(args: {
    readonly key: string;
    readonly body: string;
    readonly tenantIds: readonly string[];
    readonly deletionEpoch: number;
    readonly nowMs: number;
    readonly customMetadata?: Readonly<Record<string, string>>;
  }): Promise<WalPutOutcome> {
    assertSingleTenantWalBatch(args.key, args.body, args.tenantIds, this.boundScope);
    const obj = await this.customerBucket.put(args.key, args.body, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        ...args.customMetadata,
        storage_region: this.descriptor.region,
        storage_tier: this.descriptor.tier,
        customer_sor_bucket_id: this.descriptor.customerSorBucketId ?? '',
        deletion_epoch: String(args.deletionEpoch),
      },
    });
    return {
      key: args.key,
      written: obj !== null,
      deduped: obj === null,
      region: this.descriptor.region,
      tier: this.descriptor.tier,
      exportReceipt: null,
    };
  }

  public async putQuarantineObject(
    key: string,
    body: string,
    customMetadata?: Readonly<Record<string, string>>
  ): Promise<R2ObjectLike | null> {
    return this.customerBucket.put(key, body, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        ...customMetadata,
        storage_region: this.descriptor.region,
        storage_tier: this.descriptor.tier,
      },
    });
  }

  public async getObject(key: string): Promise<R2ObjectLike | null> {
    return this.customerBucket.get(key);
  }

  public async listObjects(prefix: string, limit = 1000, cursor?: string): Promise<R2ListResult> {
    return this.customerBucket.list({ prefix, limit, cursor });
  }

  public async deleteObjects(keys: string | readonly string[]): Promise<void> {
    await deleteKeysInChunks(this.customerBucket, keys);
  }
}

/**
 * In-memory ExportSinkPort helper for Tier 2 testing and dry-run verification.
 * Deduplicates on deterministic `(sinkId, walKey)` `idempotencyKey` (Codex R2 #12).
 */
export class InMemoryExportSink implements ExportSinkPort {
  public readonly receipts: ExportNotificationReceipt[] = [];
  public readonly payloads = new Map<string, string>();
  public readonly seenIdempotencyKeys: string[] = [];
  private readonly receiptsByIdempotencyKey = new Map<string, ExportNotificationReceipt>();
  private seq = 0;

  public constructor(
    public readonly sinkId: string,
    public readonly region: DataRegion
  ) {}

  public async writeExportBatch(args: {
    readonly walKey: string;
    readonly body: string;
    readonly tenantIds: readonly string[];
    readonly deletionEpoch: number;
    readonly exportedAtMs: number;
    readonly idempotencyKey: string;
  }): Promise<ExportNotificationReceipt> {
    if (typeof args.idempotencyKey !== 'string' || args.idempotencyKey.trim().length === 0) {
      throw new Error('ExportSinkPort.writeExportBatch requires a non-empty idempotencyKey');
    }
    const idempotencyKey = args.idempotencyKey;
    this.seenIdempotencyKeys.push(idempotencyKey);

    const existing = this.receiptsByIdempotencyKey.get(idempotencyKey);
    if (existing) {
      return existing;
    }

    this.seq += 1;
    const exportBatchId = `${this.sinkId}-batch-${this.seq}`;
    this.payloads.set(args.walKey, args.body);
    const receipt: ExportNotificationReceipt = {
      exportBatchId,
      sinkId: this.sinkId,
      region: this.region,
      walKey: args.walKey,
      idempotencyKey,
      tenantIds: [...args.tenantIds],
      deletionEpoch: args.deletionEpoch,
      exportedAtMs: args.exportedAtMs,
    };
    this.receiptsByIdempotencyKey.set(idempotencyKey, receipt);
    this.receipts.push(receipt);
    return receipt;
  }
}
