/**
 * UGOKI LINK v2 — Mobile SDK Lifecycle, Bounded Offline Queue, Pre-Enqueue Trait Drop
 * & Consent-Downgrade Re-Filter / Immediate Wipe
 *
 * Implements Master Architecture v2 §11.11 item 5 & lane separation rules:
 *   - Screen-name-based transitions (`screen_view`) with `section_join: 'not_applicable'`
 *     and `actor_instrument: 'mobile_app_integrity'`
 *   - Drops unapproved `traits` BEFORE enqueuing into memory/disk queue ([H-16])
 *   - `setConsent` downgrades immediately purge disallowed queued events and strip identifiers
 *     (`off` wipes 100% of queued events; `cookieless` strips `vid`/`sid`/`traits` and drops
 *     identity/replay events) ([H-16])
 *   - Bounded offline queue enforcing `maxEvents`, `maxBytes`, and `maxRetentionMs` TTL with
 *     explicit loss-ledger accounting
 */

import crypto from 'node:crypto';
import {
  CANONICAL_SCHEMA,
  normalizeCollectionLane,
  type ConsentMode,
  type ConsentPurpose,
} from '@/packages/contract/schema';
import { isPiiShapedValue } from '@/packages/contract/urlkey';
import {
  DEFAULT_MOBILE_OFFLINE_CONFIG,
  type MobileDataLane,
  type MobileEnvelopeEvent,
  type MobileLossLedger,
  type MobileOfflineQueueConfig,
  type MobilePlatform,
  type MobileSegmentCallType,
} from './types';

const MOBILE_CONSENT_RANK: Readonly<Record<ConsentMode, number>> = {
  off: 0,
  cookieless: 1,
  stats_exempt: 2,
  session: 3,
  full: 4,
};

const MODE_DISALLOWED_PURPOSES: Readonly<Record<ConsentMode, ReadonlySet<ConsentPurpose>>> = {
  off: new Set<ConsentPurpose>([
    'member_link',
    'timeline',
    'page_content',
    'site_search',
    'ads',
    'automation_detection',
    'pool',
    'experiment',
    'personalise',
    'screen_replay',
  ]),
  cookieless: new Set<ConsentPurpose>(['member_link', 'timeline', 'ads', 'screen_replay']),
  stats_exempt: new Set<ConsentPurpose>([
    'member_link',
    'timeline',
    'ads',
    'pool',
    'personalise',
    'screen_replay',
  ]),
  session: new Set<ConsentPurpose>(['member_link']),
  full: new Set<ConsentPurpose>([]),
};

const COOKIELESS_STRIP_KEYS = new Set([
  'vid',
  'visitorId',
  'visitor_id',
  'sid',
  'sessionId',
  'session_id',
  'anonymousId',
  'anonymous_id',
  'userId',
  'user_id',
  'previousId',
  'previous_id',
  'groupId',
  'group_id',
  'memberHash',
  'member_hash',
  'traits',
]);

const STATS_EXEMPT_STRIP_KEYS = new Set([
  'sid',
  'sessionId',
  'session_id',
  'userId',
  'user_id',
  'previousId',
  'previous_id',
  'groupId',
  'group_id',
  'memberHash',
  'member_hash',
  'traits',
]);

const SESSION_PERSISTENT_ID_KEYS = new Set(['vid', 'visitorId', 'visitor_id']);
const MEMBER_LINK_KEYS = new Set([
  'userId',
  'user_id',
  'previousId',
  'previous_id',
  'groupId',
  'group_id',
  'memberHash',
  'member_hash',
  'traits',
]);

export interface MobileQueuePersistenceLike {
  save(events: ReadonlyArray<MobileEnvelopeEvent>): void;
  clear(): void;
}

export interface MobileRuntimeOptions {
  readonly platform: MobilePlatform;
  readonly tenantId: string;
  readonly siteId: string;
  readonly consentMode: ConsentMode;
  readonly consentPurposes: ReadonlyArray<ConsentPurpose>;
  readonly consentGeneration?: number;
  readonly allowedTraitKeys?: ReadonlyArray<string>;
  readonly offlineConfig?: Partial<MobileOfflineQueueConfig>;
  readonly online?: boolean;
  readonly persistence?: MobileQueuePersistenceLike;
  readonly onTransmit?: (batch: ReadonlyArray<MobileEnvelopeEvent>) => boolean;
}

function filterAllowedPurposes(
  mode: ConsentMode,
  purposes: ReadonlyArray<ConsentPurpose>
): Set<ConsentPurpose> {
  const disallowed = MODE_DISALLOWED_PURPOSES[mode];
  const out = new Set<ConsentPurpose>();
  for (const p of purposes) {
    if (!disallowed.has(p)) {
      out.add(p);
    }
  }
  return out;
}

function sanitizePayloadForConsentAndTraits(
  rawPayload: Readonly<Record<string, unknown>>,
  mode: ConsentMode,
  purposes: ReadonlySet<ConsentPurpose>,
  allowedTraitKeys: ReadonlySet<string>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const hasMemberLink = purposes.has('member_link');

  for (const [key, val] of Object.entries(rawPayload)) {
    if (mode === 'cookieless' && COOKIELESS_STRIP_KEYS.has(key)) {
      continue;
    }
    if (mode === 'stats_exempt' && STATS_EXEMPT_STRIP_KEYS.has(key)) {
      continue;
    }
    if (mode === 'session' && SESSION_PERSISTENT_ID_KEYS.has(key)) {
      continue;
    }
    if (!hasMemberLink && MEMBER_LINK_KEYS.has(key)) {
      continue;
    }

    if (key === 'traits') {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const cleanTraits: Record<string, string | number | boolean> = {};
        let droppedTraitsCount = 0;
        for (const [tk, tv] of Object.entries(val as Record<string, unknown>)) {
          if (!allowedTraitKeys.has(tk)) {
            droppedTraitsCount += 1;
            continue;
          }
          if (typeof tv === 'string') {
            if (isPiiShapedValue(tv)) {
              droppedTraitsCount += 1;
              continue;
            }
            cleanTraits[tk] = tv;
          } else if (typeof tv === 'number' && Number.isFinite(tv)) {
            cleanTraits[tk] = tv;
          } else if (typeof tv === 'boolean') {
            cleanTraits[tk] = tv;
          } else {
            droppedTraitsCount += 1;
          }
        }
        if (Object.keys(cleanTraits).length > 0) {
          sanitized.traits = cleanTraits;
        }
        if (droppedTraitsCount > 0) {
          sanitized.droppedTraitsCount = droppedTraitsCount;
        }
      }
      continue;
    }

    sanitized[key] = val;
  }

  return sanitized;
}

export class MobileSdkSessionRuntime {
  public readonly platform: MobilePlatform;
  public readonly tenantId: string;
  public readonly siteId: string;

  private consentMode: ConsentMode;
  private consentPurposes: Set<ConsentPurpose>;
  private consentGeneration: number;
  private readonly allowedTraitKeys: ReadonlySet<string>;
  private readonly offlineConfig: MobileOfflineQueueConfig;
  private online: boolean;
  private readonly persistence?: MobileQueuePersistenceLike;
  private readonly onTransmit?: (batch: ReadonlyArray<MobileEnvelopeEvent>) => boolean;

  private activeScreenName: string | null = null;
  private screenStartedAtMs: number | null = null;
  private inBackground = false;

  private queue: MobileEnvelopeEvent[] = [];
  private queuedBytes = 0;
  private transmittedEvents: MobileEnvelopeEvent[] = [];

  private readonly lossLedger: MobileLossLedger = {
    droppedExpired: 0,
    droppedOverflow: 0,
    droppedRevokedConsent: 0,
    rejectedConsentMode: 0,
  };

  constructor(opts: MobileRuntimeOptions) {
    this.platform = opts.platform;
    this.tenantId = opts.tenantId;
    this.siteId = opts.siteId;
    this.consentMode = opts.consentMode;
    this.consentPurposes = filterAllowedPurposes(opts.consentMode, opts.consentPurposes);
    this.consentGeneration = opts.consentGeneration ?? 1;
    this.allowedTraitKeys = new Set(opts.allowedTraitKeys ?? []);
    this.offlineConfig = {
      ...DEFAULT_MOBILE_OFFLINE_CONFIG,
      ...(opts.offlineConfig ?? {}),
    };
    this.online = opts.online ?? true;
    this.persistence = opts.persistence;
    this.onTransmit = opts.onTransmit;
  }

  public getConsentState(): {
    readonly mode: ConsentMode;
    readonly purposes: ReadonlyArray<ConsentPurpose>;
    readonly generation: number;
  } {
    return {
      mode: this.consentMode,
      purposes: [...this.consentPurposes],
      generation: this.consentGeneration,
    };
  }

  public isInBackground(): boolean {
    return this.inBackground;
  }

  public getActiveScreenName(): string | null {
    return this.activeScreenName;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  public getQueuedEvents(): ReadonlyArray<MobileEnvelopeEvent> {
    return [...this.queue];
  }

  public getQueuedBytes(): number {
    return this.queuedBytes;
  }

  public getTransmittedEvents(): ReadonlyArray<MobileEnvelopeEvent> {
    return [...this.transmittedEvents];
  }

  public getLossLedger(): Readonly<MobileLossLedger> {
    return { ...this.lossLedger };
  }

  private syncPersistence(): void {
    if (!this.persistence) return;
    if (this.consentMode === 'off' || this.consentMode === 'cookieless' || this.queue.length === 0) {
      this.persistence.clear();
    } else {
      this.persistence.save([...this.queue]);
    }
  }

  public setOnline(online: boolean, nowMs: number = Date.now()): number {
    this.online = online;
    if (online) {
      return this.flush(nowMs);
    }
    return 0;
  }

  /**
   * Updates consent dynamically ([H-16]):
   * - Switching to `'off'` immediately wipes 100% of queued events from memory + disk with zero send.
   * - Downgrading (`full` -> `session` / `stats_exempt` / `cookieless` or revoking purposes)
   *   immediately purges queued events that require higher consent (`identify`/`group`/`alias`/replay)
   *   and strips disallowed identifiers (`vid`/`sid`/`traits`) from remaining queued events!
   */
  public setConsent(
    nextMode: ConsentMode,
    nextPurposes: ReadonlyArray<ConsentPurpose> = []
  ): { readonly purgedCount: number; readonly remainingCount: number } {
    if (nextMode === 'off') {
      const wipe = this.revokeConsent();
      return { purgedCount: wipe.wipedQueuedEvents, remainingCount: 0 };
    }

    const prevMode = this.consentMode;
    const prevPurposes = new Set(this.consentPurposes);
    const filteredPurposes = filterAllowedPurposes(nextMode, nextPurposes);

    const isDowngrade =
      MOBILE_CONSENT_RANK[nextMode] < MOBILE_CONSENT_RANK[prevMode] ||
      [...prevPurposes].some((p) => !filteredPurposes.has(p));

    this.consentMode = nextMode;
    this.consentPurposes = filteredPurposes;
    this.consentGeneration += 1;

    if (!isDowngrade || this.queue.length === 0) {
      this.syncPersistence();
      return { purgedCount: 0, remainingCount: this.queue.length };
    }

    const kept: MobileEnvelopeEvent[] = [];
    let purgedCount = 0;
    let totalBytes = 0;

    for (const ev of this.queue) {
      const isIdentityCall =
        ev.callType === 'identify' || ev.callType === 'alias' || ev.callType === 'group';
      if (
        isIdentityCall &&
        (nextMode === 'cookieless' ||
          nextMode === 'stats_exempt' ||
          !filteredPurposes.has('member_link'))
      ) {
        purgedCount += 1;
        this.lossLedger.droppedRevokedConsent += 1;
        continue;
      }

      if (
        ev.lane === 'screen_replay' &&
        ((nextMode !== 'full' && nextMode !== 'session') || !filteredPurposes.has('screen_replay'))
      ) {
        purgedCount += 1;
        this.lossLedger.droppedRevokedConsent += 1;
        continue;
      }

      const scrubbedPayload = sanitizePayloadForConsentAndTraits(
        ev.payload,
        nextMode,
        filteredPurposes,
        this.allowedTraitKeys
      );
      const updatedBase = {
        ...ev,
        consentMode: nextMode,
        consentPurposes: [...filteredPurposes],
        consentGeneration: this.consentGeneration,
        payload: scrubbedPayload,
      };
      const { serializedBytes: _oldBytes, ...withoutBytes } = updatedBase;
      void _oldBytes;
      const newBytes = Buffer.byteLength(JSON.stringify(withoutBytes), 'utf8');
      kept.push({ ...withoutBytes, serializedBytes: newBytes });
      totalBytes += newBytes;
    }

    this.queue = kept;
    this.queuedBytes = totalBytes;
    this.syncPersistence();

    return { purgedCount, remainingCount: this.queue.length };
  }

  /**
   * Immediately revokes consent: switches to `'off'`, bumps consent generation,
   * halts active timers, and WIPES ALL buffered offline events WITHOUT transmitting any!
   */
  public revokeConsent(): { readonly wipedQueuedEvents: number; readonly transmittedDuringWipe: 0 } {
    this.consentMode = 'off';
    this.consentPurposes.clear();
    this.consentGeneration += 1;
    this.activeScreenName = null;
    this.screenStartedAtMs = null;

    const wiped = this.queue.length;
    this.lossLedger.droppedRevokedConsent += wiped;
    this.queue = [];
    this.queuedBytes = 0;
    this.persistence?.clear();

    return { wipedQueuedEvents: wiped, transmittedDuringWipe: 0 };
  }

  public optOut(): { readonly wipedQueuedEvents: number; readonly transmittedDuringWipe: 0 } {
    return this.revokeConsent();
  }

  /**
   * Records a screen transition (`screen_view`) keyed by `screenName`.
   */
  public recordScreenTransition(screenName: string, nowMs: number = Date.now()): MobileEnvelopeEvent | null {
    if (this.inBackground) {
      this.inBackground = false;
    }

    const previousScreen = this.activeScreenName;
    const prevDwellMs =
      previousScreen !== null && this.screenStartedAtMs !== null
        ? Math.max(0, nowMs - this.screenStartedAtMs)
        : 0;

    this.activeScreenName = screenName;
    this.screenStartedAtMs = nowMs;

    return this.enqueueEvent({
      lane: 'standard',
      callType: 'screen_view',
      screenName,
      payload: {
        screenName,
        previousScreen,
        previousDwellMs: prevDwellMs,
      },
      nowMs,
    });
  }

  /**
   * OS Background lifecycle hook (`didEnterBackground` / `onStop` / `AppState=background` / `AppLifecycleState.paused`).
   * Immediately stops active screen timer, records elapsed foreground dwell, and flushes if online.
   */
  public onEnterBackground(nowMs: number = Date.now()): {
    readonly stoppedScreen: string | null;
    readonly elapsedForegroundMs: number;
    readonly flushedCount: number;
  } {
    const stoppedScreen = this.activeScreenName;
    const elapsedForegroundMs =
      stoppedScreen !== null && this.screenStartedAtMs !== null
        ? Math.max(0, nowMs - this.screenStartedAtMs)
        : 0;

    this.inBackground = true;
    this.screenStartedAtMs = null;

    if (stoppedScreen !== null && this.consentMode !== 'off') {
      this.enqueueEvent({
        lane: 'standard',
        callType: 'screen_view',
        screenName: stoppedScreen,
        payload: {
          lifecycle: 'background_pause',
          screenName: stoppedScreen,
          engagedForegroundMs: elapsedForegroundMs,
        },
        nowMs,
      });
    }

    const flushedCount = this.online ? this.flush(nowMs) : 0;
    return { stoppedScreen, elapsedForegroundMs, flushedCount };
  }

  /**
   * Segment-compatible 6 call types (`identify`, `page`, `screen`, `track`, `group`, `alias`)
   * with strict consent-mode × purpose enforcement & pre-enqueue unapproved `traits` drop (§11.11 / [H-16]).
   */
  public recordSegmentCall(
    callType: MobileSegmentCallType,
    payload: Readonly<Record<string, unknown>>,
    nowMs: number = Date.now()
  ): MobileEnvelopeEvent | null {
    // Cross-visit identity calls (`identify`, `alias`, `group`) require `member_link`
    // and NEVER run under `off`, `cookieless`, or `stats_exempt` (§11.11).
    if (callType === 'identify' || callType === 'alias' || callType === 'group') {
      if (
        this.consentMode === 'off' ||
        this.consentMode === 'cookieless' ||
        this.consentMode === 'stats_exempt' ||
        !this.consentPurposes.has('member_link')
      ) {
        this.lossLedger.rejectedConsentMode += 1;
        return null;
      }
    }

    const screenName =
      typeof payload.name === 'string' && (callType === 'screen' || callType === 'page')
        ? payload.name
        : this.activeScreenName;

    return this.enqueueEvent({
      lane: 'customer_defined',
      callType,
      screenName,
      payload,
      nowMs,
    });
  }

  private enqueueEvent(params: {
    readonly lane: MobileDataLane | 'session_replay' | 'custom_event';
    readonly callType: MobileSegmentCallType | 'screen_view';
    readonly screenName: string | null;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly nowMs: number;
  }): MobileEnvelopeEvent | null {
    if (this.consentMode === 'off') {
      this.lossLedger.rejectedConsentMode += 1;
      return null;
    }

    const canonicalLane = normalizeCollectionLane(params.lane);
    if (!canonicalLane) {
      return null;
    }

    this.pruneExpiredOffline(params.nowMs);

    // [H-16] Drop unapproved `traits` and disallowed consent identifiers BEFORE enqueuing to memory or disk!
    const sanitizedPayload = sanitizePayloadForConsentAndTraits(
      params.payload,
      this.consentMode,
      this.consentPurposes,
      this.allowedTraitKeys
    );

    const eventId = `mob_${crypto.randomBytes(8).toString('hex')}`;
    const base = {
      eventId,
      platform: this.platform,
      lane: canonicalLane,
      callType: params.callType,
      tenantId: this.tenantId,
      siteId: this.siteId,
      schemaVersion: CANONICAL_SCHEMA.meta.schemaVersion,
      screenName: params.screenName,
      section_join: 'not_applicable' as const,
      actor_instrument: 'mobile_app_integrity' as const,
      consentMode: this.consentMode,
      consentPurposes: [...this.consentPurposes],
      consentGeneration: this.consentGeneration,
      occurredAtMs: params.nowMs,
      payload: sanitizedPayload,
    };
    const serializedBytes = Buffer.byteLength(JSON.stringify(base), 'utf8');
    const event: MobileEnvelopeEvent = { ...base, serializedBytes };

    // Single item larger than total offline byte cap cannot be stored
    if (serializedBytes > this.offlineConfig.maxBytes) {
      this.lossLedger.droppedOverflow += 1;
      return null;
    }

    // Evict oldest FIFO until both maxEvents and maxBytes are satisfied
    while (
      this.queue.length >= this.offlineConfig.maxEvents ||
      this.queuedBytes + serializedBytes > this.offlineConfig.maxBytes
    ) {
      const evicted = this.queue.shift();
      if (!evicted) break;
      this.queuedBytes = Math.max(0, this.queuedBytes - evicted.serializedBytes);
      this.lossLedger.droppedOverflow += 1;
    }

    this.queue.push(event);
    this.queuedBytes += serializedBytes;
    this.syncPersistence();

    return event;
  }

  public pruneExpiredOffline(nowMs: number = Date.now()): number {
    let pruned = 0;
    const cutoff = nowMs - this.offlineConfig.maxRetentionMs;
    while (this.queue.length > 0 && this.queue[0].occurredAtMs < cutoff) {
      const expired = this.queue.shift()!;
      this.queuedBytes = Math.max(0, this.queuedBytes - expired.serializedBytes);
      this.lossLedger.droppedExpired += 1;
      pruned += 1;
    }
    if (pruned > 0) {
      this.syncPersistence();
    }
    return pruned;
  }

  public flush(nowMs: number = Date.now()): number {
    if (!this.online || this.consentMode === 'off') {
      return 0;
    }
    this.pruneExpiredOffline(nowMs);
    if (this.queue.length === 0) return 0;

    const batch = [...this.queue];
    const ok = this.onTransmit ? this.onTransmit(batch) : true;
    if (!ok) {
      return 0;
    }

    this.transmittedEvents.push(...batch);
    this.queue = [];
    this.queuedBytes = 0;
    this.syncPersistence();
    return batch.length;
  }
}
