/**
 * UGOKI LINK v2 — Main Collector Engine (`workers/link-collector/collector.ts`)
 *
 * Implements §4.1, §4.4, §4.5, §6.4, §11.8, §12.1 #4, §12.2, TEL M1 / M4:
 * - Resolves `(tenant_id, site_id)` STRICTLY from `ugk_pub_*` publishable key (never body)
 * - Lab Marker gate: `render` blocks ingest; all 6 lab purposes excluded from human & billing pipelines
 * - Partial acceptance via `createIngestValidator(CANONICAL_SCHEMA)` (single bad field dropped/clamped,
 *   envelope error -> sanitized quarantine with `{type, length}` for string-in-int-slot)
 * - Collector URL-key idempotency check & malformed URL safe quarantine via `verifyUrlKeyIdempotency` ([C-08])
 * - Constant-time >=128-bit MAC + ±5m skew check on edge handoff headers & 30m TTL on `pv_token` ([C-04])
 * - Server-derived IPv4 `/24` & IPv6 `/48` network-prefix canonicalizer ([C-04])
 * - Canonical WAL Queue Envelope (`storage_region`, `shard_id` 0..63, `raw_frame`, `edge_acked`,
 *   `retention_days`, `storage_tier`) & non-blocking `liveTailSink` fanout ([C-05])
 * - Bounded TTL/LRU `ackLedgerStore` for cross-instance `post_ack_loss`, surge, and prefix maps ([M-02])
 */

import { hmacSha256Hex } from '../../lib/link/allocator';
import {
  CANONICAL_SCHEMA,
  DATA_REGIONS,
  STORAGE_TIERS,
  canonicalJsonStringify,
  computeFrameChecksum,
  createIngestValidator,
  createSdkFrameCodec,
  sha256Hex,
  utf8ToBytes,
  type DataRegion,
  type SanitizedQuarantineRecord,
  type StorageTier,
  type TelemetryFrame,
  type TrustLevel,
} from '../../packages/contract/schema';
import { UrlKeyError, verifyUrlKeyIdempotency } from '../../packages/contract/urlkey';
import { evaluateLabPipelineExclusion, verifyLabMarker } from './lab-marker';
import type {
  AckLedgerStoreLike,
  BillingMode,
  CollectorAckResponse,
  CollectorDeps,
  LabMarkerToken,
  PersistedCollectorRecord,
  PostAckLossEntry,
  SiteKeyRegistration,
} from './types';

const POST_ACK_LOSS_WINDOW_MS = 10 * 60 * 1000; // 10 minutes (§4.1 / TEL M1)
const PV_TOKEN_MAX_TTL_MS = 30 * 60 * 1000; // 30 minutes ([C-04])
const PV_TOKEN_FUTURE_SKEW_MS = 60 * 1000; // +60s clock skew allowance ([C-04])
const HANDOFF_SKEW_MAX_MS = 5 * 60 * 1000; // ±5 minutes ([C-04])
const DEFAULT_MAP_MAX_ENTRIES = 50_000; // Bounded map cap ([M-02])
const DEFAULT_MAP_TTL_MS = 15 * 60 * 1000; // 15-minute TTL sweep ([M-02])
const DEFAULT_RETENTION_DAYS = 395; // 13 months default site retention
const DEFAULT_SURGE_MULTIPLIER = 3.0;
const DEFAULT_UNVERIFIED_PREFIX_CAP = 500;
const DEFAULT_UNKNOWN_IP_DAILY_CAP = 5;
const DEFAULT_ORIGIN_ATTESTED_PREFIX_CAP = 5000;

const HEX_MAC_MIN32_RE = /^[0-9a-f]{32,64}$/i;
const DIGITS_ONLY_RE = /^\d{1,16}$/;

/**
 * Constant-time hex digest comparison ([C-04]).
 * Requires both strings to be valid even-length hex in `[32, 64]` chars (`>= 128` bits)
 * and compares every byte without early exit.
 */
export function constantTimeHexEqual(candidateHex: string, expectedHex: string): boolean {
  if (
    typeof candidateHex !== 'string' ||
    typeof expectedHex !== 'string' ||
    candidateHex.length !== expectedHex.length ||
    candidateHex.length < 32 ||
    candidateHex.length > 64 ||
    candidateHex.length % 2 !== 0 ||
    !HEX_MAC_MIN32_RE.test(candidateHex) ||
    !HEX_MAC_MIN32_RE.test(expectedHex)
  ) {
    return false;
  }
  const a = candidateHex.toLowerCase();
  const b = expectedHex.toLowerCase();
  let diff = 0;
  for (let i = 0; i < a.length; i += 2) {
    const byteA = parseInt(a.slice(i, i + 2), 16);
    const byteB = parseInt(b.slice(i, i + 2), 16);
    diff |= byteA ^ byteB;
  }
  return diff === 0;
}

function parseStrictIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return [nums[0], nums[1], nums[2], nums[3]];
}

function expandIpv6Hextets(rawIp: string): number[] | null {
  // Strip optional zone id (%eth0) if present
  const zoneIdx = rawIp.indexOf('%');
  const ip = zoneIdx >= 0 ? rawIp.slice(0, zoneIdx) : rawIp;
  if (!ip.includes(':')) return null;

  // Handle embedded IPv4 tail (e.g. ::ffff:203.0.113.42)
  let working = ip;
  const lastColon = working.lastIndexOf(':');
  const tail = working.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseStrictIpv4Octets(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const doubleColonParts = working.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (side.length === 0) return [];
    const groups = side.split(':');
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  if (doubleColonParts.length === 1) {
    const full = parseSide(doubleColonParts[0]);
    return full && full.length === 8 ? full : null;
  }

  const left = parseSide(doubleColonParts[0]);
  const right = parseSide(doubleColonParts[1]);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

/**
 * Server-side network-prefix canonicalizer from trusted edge `CF-Connecting-IP` ([C-04]).
 * - IPv4 -> `a.b.c.0/24`
 * - IPv4-mapped IPv6 (`::ffff:a.b.c.d`) -> `a.b.c.0/24`
 * - IPv6 -> canonical lowercase `/48` (`xxxx:xxxx:xxxx::/48`)
 * - Missing or malformed -> `'unknown_ip'` (subject to conservative daily cap)
 */
export function deriveServerNetworkPrefix(cfConnectingIp: string | null | undefined): string {
  if (!cfConnectingIp || typeof cfConnectingIp !== 'string') {
    return 'unknown_ip';
  }
  let trimmed = cfConnectingIp.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    return 'unknown_ip';
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    trimmed = trimmed.slice(1, -1);
  }

  const v4 = parseStrictIpv4Octets(trimmed);
  if (v4) {
    return `${v4[0]}.${v4[1]}.${v4[2]}.0/24`;
  }

  const v6 = expandIpv6Hextets(trimmed);
  if (v6) {
    // IPv4-mapped IPv6 ::ffff:w.x.y.z
    const isV4Mapped =
      v6[0] === 0 &&
      v6[1] === 0 &&
      v6[2] === 0 &&
      v6[3] === 0 &&
      v6[4] === 0 &&
      v6[5] === 0xffff;
    if (isV4Mapped) {
      const a = (v6[6] >> 8) & 0xff;
      const b = v6[6] & 0xff;
      const c = (v6[7] >> 8) & 0xff;
      return `${a}.${b}.${c}.0/24`;
    }
    const h0 = v6[0].toString(16).padStart(4, '0');
    const h1 = v6[1].toString(16).padStart(4, '0');
    const h2 = v6[2].toString(16).padStart(4, '0');
    return `${h0}:${h1}:${h2}::/48`;
  }

  return 'unknown_ip';
}

/**
 * Issues a timestamped >=128-bit HMAC edge handoff header `${reqUid}.${issuedAtMs}.${macHex}` ([C-04]).
 */
export function issueEdgeHandoffHeader(
  reqUid: string,
  edgeHandoffMacKey: string,
  issuedAtMs: number,
  macHexLength = 32
): string {
  const safeLen = Math.max(32, Math.min(64, macHexLength % 2 === 0 ? macHexLength : macHexLength + 1));
  const ts = Math.trunc(issuedAtMs);
  const mac = hmacSha256Hex(edgeHandoffMacKey, `handoff/1|${reqUid}|${ts}`).slice(0, safeLen);
  return `${reqUid}.${ts}.${mac}`;
}

/**
 * Deterministically assigns `shard_id` in `0..63` from `${tenantId}:${siteId}:${pvId}` ([C-05]).
 */
export function computeDeterministicWalShardId(
  tenantId: string,
  siteId: string,
  pvId: string
): number {
  const digestPrefix = sha256Hex(`${tenantId}:${siteId}:${pvId}`).slice(0, 8);
  return (parseInt(digestPrefix, 16) >>> 0) % 64;
}

/**
 * Bounded TTL + LRU map preventing unbounded Worker memory growth ([M-02]).
 */
export class BoundedTtlLruMap<V> {
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;
  private readonly store = new Map<string, { value: V; expiresAtMs: number }>();

  constructor(maxEntries = DEFAULT_MAP_MAX_ENTRIES, defaultTtlMs = DEFAULT_MAP_TTL_MS) {
    this.maxEntries = Math.max(1, Math.trunc(maxEntries));
    this.defaultTtlMs = Math.max(1_000, Math.trunc(defaultTtlMs));
  }

  public get size(): number {
    return this.store.size;
  }

  public sweepExpired(nowMs: number): number {
    let removed = 0;
    for (const [k, entry] of this.store) {
      if (nowMs > entry.expiresAtMs) {
        this.store.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  public get(key: string, nowMs: number): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (nowMs > entry.expiresAtMs) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh LRU position
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  public set(key: string, value: V, nowMs: number, ttlMs?: number): void {
    const effectiveTtl = ttlMs ?? this.defaultTtlMs;
    const expiresAtMs = nowMs + effectiveTtl;

    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      // Sweep expired entries first; if still full, evict oldest LRU entry
      this.sweepExpired(nowMs);
      while (this.store.size >= this.maxEntries) {
        const oldestKey = this.store.keys().next().value;
        if (oldestKey === undefined) break;
        this.store.delete(oldestKey);
      }
    }

    this.store.set(key, { value, expiresAtMs });
  }
}

export interface SharedAckLedgerOptions {
  readonly maxEntries?: number;
  readonly ackTtlMs?: number;
  readonly surgeTtlMs?: number;
  readonly prefixTtlMs?: number;
}

/**
 * Injectable bounded TTL/LRU store that can be shared across Worker instances (or backed
 * by KV/DO in production via `AckLedgerStoreLike`) so multi-instance deployments detect
 * `post_ack_loss` across instances while keeping memory strictly bounded ([M-02]).
 */
export class SharedInMemoryAckLedgerStore implements AckLedgerStoreLike {
  public readonly ackedFrames: BoundedTtlLruMap<number>;
  public readonly siteHourCounts: BoundedTtlLruMap<number>;
  public readonly prefixDayBillableCounts: BoundedTtlLruMap<number>;
  private readonly losses = new Map<string, PostAckLossEntry>();
  private readonly maxEntries: number;

  constructor(options?: SharedAckLedgerOptions) {
    const maxEntries = options?.maxEntries ?? DEFAULT_MAP_MAX_ENTRIES;
    this.maxEntries = Math.max(1, maxEntries);
    this.ackedFrames = new BoundedTtlLruMap<number>(
      maxEntries,
      options?.ackTtlMs ?? DEFAULT_MAP_TTL_MS
    );
    this.siteHourCounts = new BoundedTtlLruMap<number>(
      maxEntries,
      options?.surgeTtlMs ?? DEFAULT_MAP_TTL_MS
    );
    this.prefixDayBillableCounts = new BoundedTtlLruMap<number>(
      maxEntries,
      options?.prefixTtlMs ?? DEFAULT_MAP_TTL_MS
    );
  }

  public recordAck(pvId: string, seq: number, ackedAtMs: number): void {
    this.ackedFrames.set(`${pvId}:${seq}`, ackedAtMs, ackedAtMs);
  }

  public getAckedAt(pvId: string, seq: number, nowMs: number): number | undefined {
    return this.ackedFrames.get(`${pvId}:${seq}`, nowMs);
  }

  public incrementSiteHour(hourKey: string, nowMs: number): number {
    const next = (this.siteHourCounts.get(hourKey, nowMs) ?? 0) + 1;
    this.siteHourCounts.set(hourKey, next, nowMs);
    return next;
  }

  public getPrefixDayCount(prefixDayKey: string, nowMs: number): number {
    return this.prefixDayBillableCounts.get(prefixDayKey, nowMs) ?? 0;
  }

  public incrementPrefixDayCount(prefixDayKey: string, nowMs: number): number {
    const next = (this.prefixDayBillableCounts.get(prefixDayKey, nowMs) ?? 0) + 1;
    this.prefixDayBillableCounts.set(prefixDayKey, next, nowMs);
    return next;
  }

  public recordPostAckLoss(entry: PostAckLossEntry): void {
    const key = `${entry.pv_id}:${entry.echoed_seq}`;
    if (this.losses.has(key)) return;
    if (this.losses.size >= this.maxEntries) {
      const oldest = this.losses.keys().next().value;
      if (oldest !== undefined) this.losses.delete(oldest);
    }
    this.losses.set(key, entry);
  }

  public getPostAckLosses(): readonly PostAckLossEntry[] {
    return Array.from(this.losses.values());
  }
}

export interface CollectFrameRequestInput {
  readonly publishableKey: string;
  /** Either raw `ugk-bin/1` bytes OR parsed JSON object. */
  readonly body: Uint8Array | Record<string, unknown>;
  readonly networkPrefix: string; // server-derived IPv4 /24, IPv6 /48, or 'unknown_ip'
  readonly handoffHeader?: string | null;
  readonly originAttestToken?: string | null;
  readonly labMarker?: LabMarkerToken | null;
  readonly pvStartServerMs?: number;
}

export interface CollectFrameResponse {
  readonly status: number;
  readonly ack: CollectorAckResponse | null;
  readonly error?: string;
  readonly persistedRecord?: PersistedCollectorRecord;
}

function resolveDataRegion(raw?: DataRegion): DataRegion {
  if (raw && (DATA_REGIONS as readonly string[]).includes(raw)) {
    return raw;
  }
  return 'jp';
}

function resolveStorageTier(raw?: StorageTier): StorageTier {
  if (raw && (STORAGE_TIERS as readonly string[]).includes(raw)) {
    return raw;
  }
  return 'tier1_link_managed';
}

export class LinkCollectorEngine {
  private readonly deps: CollectorDeps;
  private readonly validator = createIngestValidator(CANONICAL_SCHEMA);
  private readonly codec = createSdkFrameCodec(CANONICAL_SCHEMA);
  private readonly nowMs: () => number;
  private readonly ledger: AckLedgerStoreLike;
  public readonly postAckLosses: PostAckLossEntry[] = [];

  constructor(deps: CollectorDeps) {
    this.deps = deps;
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.ledger = deps.ackLedgerStore ?? new SharedInMemoryAckLedgerStore();
  }

  public getAckLedgerStore(): AckLedgerStoreLike {
    return this.ledger;
  }

  /**
   * Issues a 30-minute time-bounded PV continuity token `${pv_id}.${issuedAtMs}.${mac32}` ([C-04]).
   */
  public issuePvContinuityToken(
    tenantId: string,
    siteId: string,
    pvId: string,
    issuedAtMs = this.nowMs()
  ): string {
    const ts = Math.trunc(issuedAtMs);
    const mac32 = hmacSha256Hex(
      this.deps.continuityTokenSecret,
      `pv_token/2|${tenantId}|${siteId}|${pvId}|${ts}`
    ).slice(0, 32);
    return `${pvId}.${ts}.${mac32}`;
  }

  /**
   * Verifies PV continuity token MAC (`>= 32` hex, constant-time) AND strict 30-minute TTL ([C-04]).
   */
  public verifyPvContinuityToken(
    token: string | null | undefined,
    tenantId: string,
    siteId: string,
    pvId: string,
    now = this.nowMs()
  ): boolean {
    if (!token || typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [tokenPvId, tsStr, macHex] = parts;
    if (!tokenPvId || tokenPvId !== pvId || !DIGITS_ONLY_RE.test(tsStr)) {
      return false;
    }
    if (!HEX_MAC_MIN32_RE.test(macHex) || macHex.length % 2 !== 0) {
      return false;
    }
    const issuedAtMs = Number(tsStr);
    if (!Number.isSafeInteger(issuedAtMs)) return false;
    if (issuedAtMs > now + PV_TOKEN_FUTURE_SKEW_MS) return false;
    if (now - issuedAtMs > PV_TOKEN_MAX_TTL_MS) return false;

    const fullMac = hmacSha256Hex(
      this.deps.continuityTokenSecret,
      `pv_token/2|${tenantId}|${siteId}|${pvId}|${issuedAtMs}`
    );
    const expected = fullMac.slice(0, macHex.length);
    return constantTimeHexEqual(macHex, expected);
  }

  public issueEdgeHandoffHeader(
    reqUid: string,
    site: SiteKeyRegistration,
    issuedAtMs = this.nowMs(),
    macHexLength = 32
  ): string | null {
    if (!site.edgeHandoffMacKey) return null;
    return issueEdgeHandoffHeader(reqUid, site.edgeHandoffMacKey, issuedAtMs, macHexLength);
  }

  /**
   * Verifies edge handoff header `${reqUid}.${issuedAtMs}.${macHex}` ([C-04]):
   * - `macHex` MUST be 32..64 even-length hex chars (`>= 128-bit` MAC; 1-char / short hex rejected!)
   * - `issuedAtMs` MUST be within `±5 minutes` of `now`
   * - Full `macHex` compared in constant time (`constantTimeHexEqual`)
   */
  public verifyEdgeHandoffHeader(
    handoffHeader: string | null | undefined,
    site: SiteKeyRegistration,
    now = this.nowMs()
  ): boolean {
    if (!handoffHeader || typeof handoffHeader !== 'string' || !site.edgeHandoffMacKey) {
      return false;
    }
    const parts = handoffHeader.split('.');
    if (parts.length !== 3) return false;
    const [reqUid, tsStr, macHex] = parts;
    if (!reqUid || !DIGITS_ONLY_RE.test(tsStr)) return false;
    if (!HEX_MAC_MIN32_RE.test(macHex) || macHex.length % 2 !== 0) {
      return false;
    }
    const issuedAtMs = Number(tsStr);
    if (!Number.isSafeInteger(issuedAtMs)) return false;
    if (Math.abs(now - issuedAtMs) > HANDOFF_SKEW_MAX_MS) {
      return false;
    }

    const fullMac = hmacSha256Hex(site.edgeHandoffMacKey, `handoff/1|${reqUid}|${issuedAtMs}`);
    const expected = fullMac.slice(0, macHex.length);
    return constantTimeHexEqual(macHex, expected);
  }

  public verifyEdgeHandoffToken(
    handoffToken: string | null | undefined,
    site: SiteKeyRegistration,
    now = this.nowMs()
  ): boolean {
    return this.verifyEdgeHandoffHeader(handoffToken, site, now);
  }

  public verifyOriginAttestToken(
    token: string | null | undefined,
    site: SiteKeyRegistration,
    pvId: string
  ): boolean {
    if (!token || typeof token !== 'string' || !site.originAttestKey) return false;
    if (!token.startsWith('ok1.')) return false;
    const macHex = token.slice(4);
    if (!HEX_MAC_MIN32_RE.test(macHex) || macHex.length % 2 !== 0) return false;
    const fullExpected = hmacSha256Hex(
      site.originAttestKey,
      `origin_kit/1|${site.siteId}|${pvId}`
    );
    return constantTimeHexEqual(macHex, fullExpected.slice(0, macHex.length));
  }

  private resolveTrustLevel(
    site: SiteKeyRegistration,
    frame: TelemetryFrame,
    now: number,
    handoffHeader?: string | null,
    originAttestToken?: string | null
  ): TrustLevel {
    const handoffCandidate = handoffHeader ?? frame.handoff_token ?? null;
    if (this.verifyEdgeHandoffHeader(handoffCandidate, site, now)) {
      return 'edge_attested';
    }
    if (this.verifyOriginAttestToken(originAttestToken, site, frame.pv_id)) {
      return 'origin_attested';
    }
    if (this.verifyPvContinuityToken(frame.pv_token, site.tenantId, site.siteId, frame.pv_id, now)) {
      return 'continuity';
    }
    return 'none';
  }

  private async checkPostAckEcho(pvId: string, ackEchoSeq: number, now: number): Promise<void> {
    if (ackEchoSeq <= 0 || !this.deps.isFrameCommittedInStore) return;
    const ackedAt = await this.ledger.getAckedAt(pvId, ackEchoSeq, now);
    if (ackedAt === undefined) return;
    const elapsed = now - ackedAt;
    if (elapsed >= POST_ACK_LOSS_WINDOW_MS) {
      const committed = this.deps.isFrameCommittedInStore(pvId, ackEchoSeq);
      if (!committed) {
        const entry: PostAckLossEntry = {
          pv_id: pvId,
          echoed_seq: ackEchoSeq,
          acked_at_ms: ackedAt,
          detected_at_ms: now,
          elapsed_since_ack_ms: elapsed,
        };
        const alreadyLogged = this.postAckLosses.some(
          (e) => e.pv_id === pvId && e.echoed_seq === ackEchoSeq
        );
        if (!alreadyLogged) {
          this.postAckLosses.push(entry);
        }
        await this.ledger.recordPostAckLoss?.(entry, now);
      }
    }
  }

  /**
   * Processes a standard telemetry frame (`POST /v1/collect/events`).
   */
  public async handleTelemetryFrame(req: CollectFrameRequestInput): Promise<CollectFrameResponse> {
    const now = this.nowMs();

    // 1. Resolve (tenant_id, site_id) STRICTLY from publishable key (§11.1)
    const site = this.deps.sitesByPublishableKey.get(req.publishableKey);
    if (!site) {
      return { status: 401, ack: null, error: 'unknown_publishable_key' };
    }

    // 2. Verify Lab Marker early: `render` blocks ingestion completely (§12.2)
    const labVerification = verifyLabMarker(
      req.labMarker,
      site.siteId,
      this.deps.labMarkerSecret,
      now
    );
    if (labVerification.valid && labVerification.marker?.purpose === 'render') {
      return { status: 403, ack: null, error: 'lab_render_ingest_blocked' };
    }

    // 3. Decode binary `ugk-bin/1` or accept JSON object
    let rawObj: unknown;
    if (req.body instanceof Uint8Array) {
      try {
        rawObj = this.codec.decodeFrame(req.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'invalid_binary_frame';
        await this.deps.r2QuarantineBucket.put(
          `quarantine/${site.tenantId}/${site.siteId}/${now}_decode.json`,
          JSON.stringify({ reason: msg, byteLength: req.body.byteLength })
        );
        return { status: 400, ack: null, error: `decode_error:${msg}` };
      }
    } else {
      rawObj = req.body;
    }

    // 4. Contract ingest validation with Partial Acceptance (`packages/contract/schema`)
    const valRes = this.validator.validateIngestFrame(rawObj, {
      serverNowMs: now,
      pvStartServerMs: req.pvStartServerMs,
      walAllowanceMs: 5000,
    });

    if (!valRes.accepted || !valRes.sanitizedFrame) {
      if (valRes.quarantineRecord) {
        const qKey = `quarantine/${site.tenantId}/${site.siteId}/${now}_${valRes.quarantineRecord.payloadSha256.slice(0, 12)}.json`;
        await this.deps.r2QuarantineBucket.put(
          qKey,
          canonicalJsonStringify(valRes.quarantineRecord),
          { customMetadata: { reason: valRes.quarantineRecord.reason, retention_days: '7' } }
        );
        this.deps.onQuarantine?.(valRes.quarantineRecord, site.tenantId, site.siteId);
      }
      return {
        status: 400,
        ack: null,
        error: valRes.quarantineRecord?.reason ?? 'envelope_rejected',
      };
    }

    let frame: TelemetryFrame = valRes.sanitizedFrame;

    // 5. Evaluate Lab Marker exclusion flags (also fail-closed on frame.lab_run_id)
    const labExclusion = evaluateLabPipelineExclusion({
      verifiedMarker: labVerification.valid ? labVerification.marker : null,
      frameLabRunId: frame.lab_run_id,
    });

    // 6. Collector-side URL key idempotency check & safe malformed-URL quarantine (§6.4 / [C-08])
    let urlCheck: ReturnType<typeof verifyUrlKeyIdempotency>;
    try {
      urlCheck = verifyUrlKeyIdempotency(frame.state.page_url_key, site.urlRules);
    } catch (err) {
      const errCode = err instanceof UrlKeyError ? 'URLKEY_REJECTED' : 'INVALID_URL_KEY';
      const rawUrlByteLength = utf8ToBytes(String(frame.state.page_url_key ?? '')).length;
      const payloadSha256 = sha256Hex(
        `urlkey_quarantine|${site.tenantId}|${site.siteId}|${frame.pv_id}|${frame.seq}|${now}`
      );
      // Sanitized quarantine record: ZERO raw URL, query parameters, or credentials persisted!
      const sanitizedUrlQuarantine = {
        reason: `invalid_page_url_key:${errCode}`,
        receivedAtMs: now,
        payloadSha256,
        pv_id: frame.pv_id,
        seq: frame.seq,
        sanitizedStructure: {
          page_url_key: { type: 'string', length: rawUrlByteLength },
        },
      } as unknown as SanitizedQuarantineRecord;

      const qKey = `quarantine/${site.tenantId}/${site.siteId}/${now}_${payloadSha256.slice(0, 12)}.json`;
      await this.deps.r2QuarantineBucket.put(
        qKey,
        canonicalJsonStringify(sanitizedUrlQuarantine),
        { customMetadata: { reason: `invalid_page_url_key:${errCode}`, retention_days: '7' } }
      );
      this.deps.onQuarantine?.(sanitizedUrlQuarantine, site.tenantId, site.siteId);
      return {
        status: 400,
        ack: null,
        error: `invalid_page_url_key:${errCode}`,
      };
    }

    const urlKeyIdempotent =
      urlCheck.idempotent && urlCheck.first.url_id === frame.url_id;
    const rejList: string[] = [...valRes.rej];
    if (!urlKeyIdempotent) {
      rejList.push('flag:url_key_idempotency_mismatch');
    }

    // [C-08]: ALWAYS persist ONLY canonical `url_key_v2` and its `url_id` — NEVER raw input URL!
    const canonicalState =
      frame.state.page_url_key === urlCheck.first.url_key_v2
        ? frame.state
        : {
            ...frame.state,
            page_url_key: urlCheck.first.url_key_v2,
          };

    // [H-11]: On `private_scope` pages, strip all person/cross-PV linkable keys before persistence!
    const isPrivateScope = canonicalState.dom_state === 'private_scope';
    const rehashedMember =
      !isPrivateScope && frame.member_hash && frame.purposes.includes('member_link')
        ? hmacSha256Hex(site.tenantMemberHashKey, frame.member_hash)
        : null;

    const canonicalChk =
      canonicalState === frame.state
        ? frame.chk
        : computeFrameChecksum({
            state: canonicalState,
            sections: frame.sections,
            blocks: frame.blocks,
            fields: frame.fields,
            forms: frame.forms,
            media: frame.media,
            log_items: frame.log_items,
          });

    frame = {
      ...frame,
      url_id: urlCheck.first.url_id,
      key_degraded: frame.key_degraded || urlCheck.first.key_degraded,
      cont_of: isPrivateScope ? null : frame.cont_of,
      pv_token: isPrivateScope ? null : frame.pv_token,
      handoff_token: isPrivateScope ? null : frame.handoff_token,
      visitor_id: isPrivateScope ? null : frame.visitor_id,
      session_id: isPrivateScope ? null : frame.session_id,
      member_hash: rehashedMember,
      state: canonicalState,
      chk: canonicalChk,
    };

    // 8. Check post-ack loss via echoed seq (§4.1 / TEL M1 / [M-02])
    await this.checkPostAckEcho(frame.pv_id, frame.ack_echo_seq, now);

    // 9. Determine Trust Level & issue 30-min continuity token (§4.4 / [C-04])
    const trustLevel = this.resolveTrustLevel(
      site,
      valRes.sanitizedFrame,
      now,
      req.handoffHeader,
      req.originAttestToken
    );
    const issuedPvToken = isPrivateScope
      ? null
      : this.issuePvContinuityToken(site.tenantId, site.siteId, frame.pv_id, now);

    // 10. Surge Circuit Breaker (§11.8): 28d same-hour baseline
    // Verified (`edge_attested` / `origin_attested`) traffic is NEVER held!
    const hourBucket = Math.floor(now / 3_600_000);
    const hourKey = `${site.siteId}:${hourBucket}`;
    const nextHourCount = await this.ledger.incrementSiteHour(hourKey, now);

    const surgeThreshold = Math.max(
      1,
      Math.floor(site.baseline28dHourVolume * (site.surgeMultiplier ?? DEFAULT_SURGE_MULTIPLIER))
    );
    const isVerifiedOriginOrEdge =
      trustLevel === 'edge_attested' || trustLevel === 'origin_attested';
    const isSurgeHold = !isVerifiedOriginOrEdge && nextHourCount > surgeThreshold;

    // 11. Daily scoped network-prefix hash & billing cap (§4.4 / §11.8 / [C-04])
    const effectivePrefix =
      req.networkPrefix && req.networkPrefix.trim().length > 0
        ? req.networkPrefix.trim()
        : 'unknown_ip';
    const isUnknownIp = effectivePrefix === 'unknown_ip';
    const dayBucket = Math.floor(now / 86_400_000);
    const prefixHash = hmacSha256Hex(
      `${this.deps.continuityTokenSecret}:prefix_cap:${dayBucket}`,
      `${site.siteId}:${effectivePrefix}`
    ).slice(0, 24);
    const prefixDayKey = `${site.siteId}:${dayBucket}:${prefixHash}`;
    const prefixCount = await this.ledger.getPrefixDayCount(prefixDayKey, now);

    // Billing mode: over quota NEVER returns 402 & NEVER drops PVs — shifts to `over_quota_count_only`!
    const billingMode: BillingMode = site.overBillingQuota ? 'over_quota_count_only' : 'normal';

    let billable = false;
    if (!labExclusion.exclude_billing && !isSurgeHold && trustLevel !== 'none') {
      if (trustLevel === 'edge_attested') {
        billable = true;
      } else if (trustLevel === 'origin_attested') {
        const cap = isUnknownIp
          ? Math.min(site.unknownIpDailyCap ?? DEFAULT_UNKNOWN_IP_DAILY_CAP, 10)
          : (site.originAttestedPrefixDailyCap ?? DEFAULT_ORIGIN_ATTESTED_PREFIX_CAP);
        if (prefixCount < cap) {
          billable = true;
          await this.ledger.incrementPrefixDayCount(prefixDayKey, now);
        }
      } else {
        // continuity
        const cap = isUnknownIp
          ? Math.min(site.unknownIpDailyCap ?? DEFAULT_UNKNOWN_IP_DAILY_CAP, 10)
          : (site.prefixDailyCap ?? DEFAULT_UNVERIFIED_PREFIX_CAP);
        if (prefixCount < cap) {
          billable = true;
          await this.ledger.incrementPrefixDayCount(prefixDayKey, now);
        }
      }
    }

    const recordId = sha256Hex(`${site.tenantId}:${site.siteId}:${frame.pv_id}:${frame.seq}`).slice(
      0,
      32
    );
    const storageRegion = resolveDataRegion(site.storageRegion);
    const storageTier = resolveStorageTier(site.storageTier);
    const retentionDays =
      typeof site.retentionDays === 'number' && site.retentionDays >= 1
        ? Math.trunc(site.retentionDays)
        : DEFAULT_RETENTION_DAYS;
    const shardId = computeDeterministicWalShardId(site.tenantId, site.siteId, frame.pv_id);

    const record: PersistedCollectorRecord = {
      record_id: recordId,
      lane: 'standard',
      tenant_id: site.tenantId,
      site_id: site.siteId,
      storage_region: storageRegion,
      shard_id: shardId,
      received_at_ms: now,
      pv_id: frame.pv_id,
      seq: frame.seq,
      url_id: urlCheck.first.url_id,
      url_key_idempotent: urlKeyIdempotent,
      trust_level: trustLevel,
      billing_mode: billingMode,
      billable,
      held: isSurgeHold,
      edge_acked: !isSurgeHold,
      spilled_to_r2: false,
      state_incomplete: valRes.stateIncomplete,
      partial_accepted: valRes.partial,
      rej: rejList,
      network_prefix_hash: prefixHash,
      retention_days: retentionDays,
      storage_tier: storageTier,
      lab_exclusion: labExclusion,
      eligible_for_cross_tenant_pool: !labExclusion.is_lab_traffic,
      eligible_for_standard_pv_billing: billable,
      raw_frame: frame,
      frame,
    };

    // 12. If surged & unverified -> route to replayable hold lane AND DO NOT return saved ACK (§11.8)!
    if (isSurgeHold) {
      const holdKey = `hold/${site.tenantId}/${site.siteId}/${hourBucket}/${recordId}.json`;
      await this.deps.r2HoldBucket.put(holdKey, canonicalJsonStringify(record), {
        customMetadata: { reason: 'surge_unverified_hold' },
      });
      return {
        status: 202,
        ack: {
          ok: true,
          accepted_saved: false, // §11.8: MUST NOT answer "saved" for held traffic!
          held: true,
          lane: 'standard',
          seq: frame.seq,
          i_hw: -1, // Do not acknowledge log items so SDK knows they are unconfirmed
          srv_t: now,
          pv_token: issuedPvToken,
          need: [],
          rej: [...rejList, 'hold:surge_circuit_breaker'],
          kill: 0,
          h: 15,
          billing_mode: billingMode,
          trust_level: trustLevel,
          spilled_to_r2: false,
          url_key_idempotent: urlKeyIdempotent,
          lab_excluded: labExclusion.is_lab_traffic,
        },
        persistedRecord: record,
      };
    }

    // 13. Ack-after-Enqueue -> R2 Spill fallback -> 503 only if BOTH fail (§4.1 / TEL M1)
    let spilledToR2 = false;
    try {
      await this.deps.mainQueue.send(record);
    } catch {
      // Queue refused/throttled: spill to R2 first!
      const spilledRecord: PersistedCollectorRecord = {
        ...record,
        spilled_to_r2: true,
      };
      try {
        const spillKey = `spill/${site.tenantId}/${site.siteId}/${now}_${recordId}.json`;
        await this.deps.r2SpillBucket.put(spillKey, canonicalJsonStringify(spilledRecord), {
          customMetadata: { reason: 'queue_refusal_spill' },
        });
        spilledToR2 = true;
      } catch {
        // ONLY when BOTH Queue and R2 fail -> 503 with NO ACK!
        return {
          status: 503,
          ack: null,
          error: 'queue_and_spill_unavailable',
        };
      }
    }

    // Record successful ACK timestamp for 10-minute post-ack loss verification ([M-02])
    await this.ledger.recordAck(frame.pv_id, frame.seq, now);

    // [C-05]: Non-blocking asynchronous fanout of non-lab, consented frames to `link-live` DO sink!
    if (this.deps.liveTailSink && !labExclusion.is_lab_traffic && frame.consent_mode !== 'off') {
      try {
        void Promise.resolve(
          this.deps.liveTailSink.publishLiveFrame({
            tenantId: site.tenantId,
            siteId: site.siteId,
            pvId: frame.pv_id,
            receivedAtMs: now,
            lane: 'standard',
            labExcluded: false,
            frame,
          })
        ).catch(() => {
          // Best-effort live tail: NEVER impact durable ACK!
        });
      } catch {
        // Synchronous throw from sink ignored so ACK is never blocked
      }
    }

    const finalRecord: PersistedCollectorRecord = spilledToR2
      ? { ...record, spilled_to_r2: true }
      : record;

    return {
      status: 200,
      ack: {
        ok: true,
        accepted_saved: true,
        held: false,
        lane: 'standard',
        seq: frame.seq,
        i_hw: valRes.ackHints.i_hw,
        srv_t: now,
        pv_token: issuedPvToken,
        need: [],
        rej: rejList,
        kill: 0,
        h: 10,
        billing_mode: billingMode,
        trust_level: trustLevel,
        spilled_to_r2: spilledToR2,
        url_key_idempotent: urlKeyIdempotent,
        lab_excluded: labExclusion.is_lab_traffic,
      },
      persistedRecord: finalRecord,
    };
  }
}
