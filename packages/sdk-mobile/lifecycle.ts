/**
 * UGOKI LINK v2 — Mobile SDK Lifecycle, Bounded Offline Queue & Immediate Consent-Revocation Wipe
 *
 * Implements Master Architecture v2 §11.11 item 5 & lane separation rules:
 *   - Screen-name-based transitions (`screen_view`) with `section_join: 'not_applicable'`
 *     and `actor_instrument: 'mobile_app_integrity'`
 *   - Background transition immediately halts active screen timers & flushes permitted buffered frames
 *   - Bounded offline queue enforcing `maxEvents`, `maxBytes`, and `maxRetentionMs` TTL with
 *     explicit loss-ledger accounting (no silent drops)
 *   - Consent revocation (`revokeConsent()` / mode `'off'`) IMMEDIATELY zeroes the offline queue
 *     WITHOUT transmitting a single queued event
 *   - Enforces consent-mode × purpose matrix (`identify`/`alias`/`group` require `member_link` and are
 *     blocked in `off`, `cookieless`, and `stats_exempt`)
 */

import crypto from 'node:crypto';
import { CANONICAL_SCHEMA, type ConsentMode, type ConsentPurpose } from '@/packages/contract/schema';
import {
  DEFAULT_MOBILE_OFFLINE_CONFIG,
  type MobileDataLane,
  type MobileEnvelopeEvent,
  type MobileLossLedger,
  type MobileOfflineQueueConfig,
  type MobilePlatform,
  type MobileSegmentCallType,
} from './types';

export interface MobileRuntimeOptions {
  readonly platform: MobilePlatform;
  readonly tenantId: string;
  readonly siteId: string;
  readonly consentMode: ConsentMode;
  readonly consentPurposes: ReadonlyArray<ConsentPurpose>;
  readonly consentGeneration?: number;
  readonly offlineConfig?: Partial<MobileOfflineQueueConfig>;
  readonly online?: boolean;
  readonly onTransmit?: (batch: ReadonlyArray<MobileEnvelopeEvent>) => boolean;
}

export class MobileSdkSessionRuntime {
  public readonly platform: MobilePlatform;
  public readonly tenantId: string;
  public readonly siteId: string;

  private consentMode: ConsentMode;
  private consentPurposes: Set<ConsentPurpose>;
  private consentGeneration: number;
  private readonly offlineConfig: MobileOfflineQueueConfig;
  private online: boolean;
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
    this.consentPurposes = new Set(opts.consentPurposes);
    this.consentGeneration = opts.consentGeneration ?? 1;
    this.offlineConfig = {
      ...DEFAULT_MOBILE_OFFLINE_CONFIG,
      ...(opts.offlineConfig ?? {}),
    };
    this.online = opts.online ?? true;
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

  public getQueuedBytes(): number {
    return this.queuedBytes;
  }

  public getTransmittedEvents(): ReadonlyArray<MobileEnvelopeEvent> {
    return [...this.transmittedEvents];
  }

  public getLossLedger(): Readonly<MobileLossLedger> {
    return { ...this.lossLedger };
  }

  public setOnline(online: boolean, nowMs: number = Date.now()): number {
    this.online = online;
    if (online) {
      return this.flush(nowMs);
    }
    return 0;
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

    return { wipedQueuedEvents: wiped, transmittedDuringWipe: 0 };
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
   * with strict consent-mode × purpose enforcement (§11.11 lane separation).
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
    readonly lane: MobileDataLane;
    readonly callType: MobileSegmentCallType | 'screen_view';
    readonly screenName: string | null;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly nowMs: number;
  }): MobileEnvelopeEvent | null {
    if (this.consentMode === 'off') {
      this.lossLedger.rejectedConsentMode += 1;
      return null;
    }

    this.pruneExpiredOffline(params.nowMs);

    const eventId = `mob_${crypto.randomBytes(8).toString('hex')}`;
    const base = {
      eventId,
      platform: this.platform,
      lane: params.lane,
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
      payload: params.payload,
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
    return batch.length;
  }
}
