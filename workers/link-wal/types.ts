/**
 * UGOKI LINK v2 — Write-Ahead Log (WAL) Types & Pure In-Memory R2 Test Double
 *
 * Uses pure TypeScript interfaces (no @cloudflare/workers-types dependency) so
 * both Cloudflare Workers runtimes and Node/Jest unit & replay suites share the
 * exact same implementation under strict tsc checking.
 */

import type {
  CanonicalLabExclusionMeta,
  CollectionLane,
  TelemetryFrame,
} from '../../packages/contract/schema';

export const VALID_DATA_REGIONS = ['jp', 'eu', 'us'] as const;
export type DataRegion = (typeof VALID_DATA_REGIONS)[number];

/**
 * §5.12 Customer Storage Architecture Tiers:
 * - tier1_link_managed: LINK-hosted R2 WAL + ClickHouse (default)
 * - tier2_link_plus_export: LINK-hosted primary + continuous export to customer sink
 * - tier3_customer_sor: Customer-hosted storage as primary System of Record
 */
export const STORAGE_TIERS = [
  'tier1_link_managed',
  'tier2_link_plus_export',
  'tier3_customer_sor',
] as const;
export type StorageTier = (typeof STORAGE_TIERS)[number];

export interface R2Conditional {
  readonly etagMatches?: string;
  readonly etagDoesNotMatch?: string;
}

export interface R2PutOptions {
  readonly onlyIf?: R2Conditional;
  readonly customMetadata?: Readonly<Record<string, string>>;
  readonly httpMetadata?: {
    readonly contentType?: string;
  };
}

export interface R2ObjectLike {
  readonly key: string;
  readonly etag: string;
  readonly size: number;
  readonly uploaded: Date;
  readonly customMetadata?: Readonly<Record<string, string>>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2ListOptions {
  readonly prefix?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface R2ListResult {
  readonly objects: readonly R2ObjectLike[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

/**
 * Minimal Cloudflare R2Bucket-compatible interface with atomic conditional put.
 */
export interface R2BucketLike {
  put(
    key: string,
    value: string | Uint8Array | ArrayBuffer,
    options?: R2PutOptions
  ): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  list(options?: R2ListOptions): Promise<R2ListResult>;
  delete(keys: string | readonly string[]): Promise<void>;
}

export interface QueueMessageLike<T = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: T;
  ack(): void;
  retry(): void;
}

export interface QueueBatchLike<T = unknown> {
  readonly queue: string;
  readonly messages: readonly QueueMessageLike<T>[];
}

export interface TenantStorageProfile {
  readonly tenantId: string;
  readonly siteId: string;
  readonly region: DataRegion;
  readonly tier: StorageTier;
  readonly retentionDays: number;
  readonly customerExportSinkId?: string;
  readonly customerSorBucketId?: string;
}

export interface WalQueuePayload {
  readonly record_id?: string;
  readonly lane?: CollectionLane | 'standard_telemetry' | 'customer_events' | 'custom_event' | 'visual_replay' | 'replay';
  readonly tenant_id: string;
  readonly site_id: string;
  readonly storage_region: DataRegion;
  readonly shard_id: number;
  readonly received_at_ms: number;
  readonly age_ms?: number;
  readonly retention_days?: number;
  readonly storage_tier?: StorageTier;
  readonly raw_frame?: unknown;
  /** Optional alias accepted when collector sends `frame` instead of `raw_frame` (C-05). */
  readonly frame?: unknown;
  readonly edge_acked?: boolean;
  readonly lab_exclusion?: CanonicalLabExclusionMeta;
}

export interface WalRecord {
  readonly lane?: CollectionLane;
  readonly tenant_id: string;
  readonly site_id: string;
  readonly storage_region: DataRegion;
  readonly shard_id: number;
  readonly received_at_ms: number;
  readonly age_ms: number;
  readonly retention_days: number;
  readonly frame: TelemetryFrame;
  readonly frame_hash: string;
  readonly partial: boolean;
  readonly state_incomplete: boolean;
  readonly rej: readonly string[];
  readonly lab_exclusion?: CanonicalLabExclusionMeta;
}

export interface WalObject {
  readonly wal_version: 1;
  readonly region: DataRegion;
  readonly tenant_id: string;
  readonly site_id: string;
  readonly shard_id: number;
  readonly minute_utc: string;
  readonly sha256: string;
  readonly created_at_ms: number;
  readonly record_count: number;
  readonly records: readonly WalRecord[];
}

export interface EncryptedQuarantineEnvelope {
  readonly quarantine_version: 1;
  readonly encrypted: true;
  readonly alg: 'AES-256-GCM';
  readonly region: DataRegion;
  readonly tenant_id: string;
  readonly site_id: string;
  readonly shard_id: number;
  readonly received_at_ms: number;
  readonly expires_at_ms: number;
  readonly iv_b64: string;
  readonly tag_b64: string;
  readonly ciphertext_b64: string;
}

export interface QuarantineObject {
  readonly quarantine_version: 1;
  readonly region: DataRegion;
  readonly tenant_id: string;
  readonly site_id: string;
  readonly pv_id: string | null;
  readonly seq: number | null;
  readonly shard_id: number;
  readonly received_at_ms: number;
  readonly expires_at_ms: number;
  readonly reason: string;
  readonly payload_sha256: string;
  readonly sanitized_fields: Readonly<Record<string, unknown>>;
  /**
   * Non-PII structural envelope metadata preserved for re-ingestion after bug fix.
   * Strings in unexpected slots are never stored raw (only `{ type, length }`).
   */
  readonly reingest_hint?: Readonly<{
    retention_days: number;
    age_ms: number;
    storage_tier: StorageTier;
  }>;
}

export interface PostAckMissingFrame {
  readonly tenantId: string;
  readonly siteId: string;
  readonly pvId: string;
  readonly seq: number;
  readonly proofSource: 'ack_echo_seq' | 'edge_ack';
  readonly firstObservedAtMs: number;
  readonly observedFromSeq: number | null;
  readonly ageSinceObservationMs: number;
}

export interface PostAckLossReport {
  readonly evaluatedAtMs: number;
  readonly graceWindowMs: number;
  readonly totalTrackedFrames: number;
  readonly confirmedPresentCount: number;
  readonly pendingWithinGraceCount: number;
  readonly confirmedMissingCount: number;
  readonly confirmedMissing: readonly PostAckMissingFrame[];
  readonly postAckLossRate: number;
  readonly maxAllowedRate: number;
  readonly gatePassed: boolean;
}

interface StoredR2Entry {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly etag: string;
  readonly uploaded: Date;
  readonly customMetadata?: Readonly<Record<string, string>>;
}

function toBytes(value: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof value === 'string') {
    return new TextEncoder().encode(value);
  }
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  return new Uint8Array(value);
}

function computeSimpleEtag(bytes: Uint8Array, version: number): string {
  // Fast deterministic FNV-1a 64-bit-like hex tag paired with write version
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] ?? 0;
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((b + i) & 0xff), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}-${version}`;
}

function makeR2Object(entry: StoredR2Entry): R2ObjectLike {
  return {
    key: entry.key,
    etag: entry.etag,
    size: entry.bytes.byteLength,
    uploaded: entry.uploaded,
    customMetadata: entry.customMetadata,
    async text(): Promise<string> {
      return new TextDecoder().decode(entry.bytes);
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      const copy = new Uint8Array(entry.bytes.byteLength);
      copy.set(entry.bytes);
      return copy.buffer;
    },
  };
}

/**
 * Pure in-memory R2Bucket implementation supporting atomic `onlyIf` conditional
 * puts (`etagDoesNotMatch: '*'`, `etagMatches`), prefix listing, and batch delete.
 */
export class InMemoryR2Bucket implements R2BucketLike {
  private readonly store = new Map<string, StoredR2Entry>();
  private writeCounter = 0;

  public async put(
    key: string,
    value: string | Uint8Array | ArrayBuffer,
    options?: R2PutOptions
  ): Promise<R2ObjectLike | null> {
    const existing = this.store.get(key);
    const onlyIf = options?.onlyIf;

    if (onlyIf?.etagDoesNotMatch !== undefined) {
      if (onlyIf.etagDoesNotMatch === '*' && existing !== undefined) {
        return null;
      }
      if (existing !== undefined && existing.etag === onlyIf.etagDoesNotMatch) {
        return null;
      }
    }

    if (onlyIf?.etagMatches !== undefined) {
      if (existing === undefined || existing.etag !== onlyIf.etagMatches) {
        return null;
      }
    }

    const bytes = toBytes(value);
    this.writeCounter += 1;
    const entry: StoredR2Entry = {
      key,
      bytes,
      etag: computeSimpleEtag(bytes, this.writeCounter),
      uploaded: new Date(),
      customMetadata: options?.customMetadata ? { ...options.customMetadata } : undefined,
    };
    this.store.set(key, entry);
    return makeR2Object(entry);
  }

  public async get(key: string): Promise<R2ObjectLike | null> {
    const entry = this.store.get(key);
    return entry ? makeR2Object(entry) : null;
  }

  public async head(key: string): Promise<R2ObjectLike | null> {
    const entry = this.store.get(key);
    return entry ? makeR2Object(entry) : null;
  }

  public async list(options?: R2ListOptions): Promise<R2ListResult> {
    const prefix = options?.prefix ?? '';
    const limit = options?.limit ?? 1000;
    const allKeys = Array.from(this.store.keys())
      .filter((k) => k.startsWith(prefix))
      .sort();

    let startIndex = 0;
    if (options?.cursor !== undefined) {
      const parsed = Number.parseInt(options.cursor, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        startIndex = parsed;
      }
    }

    const slice = allKeys.slice(startIndex, startIndex + limit);
    const objects: R2ObjectLike[] = [];
    for (const key of slice) {
      const entry = this.store.get(key);
      if (entry) {
        objects.push(makeR2Object(entry));
      }
    }

    const nextIndex = startIndex + slice.length;
    const truncated = nextIndex < allKeys.length;
    return {
      objects,
      truncated,
      cursor: truncated ? String(nextIndex) : undefined,
    };
  }

  public async delete(keys: string | readonly string[]): Promise<void> {
    if (typeof keys === 'string') {
      this.store.delete(keys);
      return;
    }
    for (const key of keys) {
      this.store.delete(key);
    }
  }

  public size(): number {
    return this.store.size;
  }

  public keys(prefix = ''): string[] {
    return Array.from(this.store.keys())
      .filter((k) => k.startsWith(prefix))
      .sort();
  }
}
