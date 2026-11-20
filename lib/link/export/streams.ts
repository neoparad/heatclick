/**
 * UGOKI LINK v2 — 4 Continuous Event Streams (`webhook`, `pubsub`, `kafka`, `kinesis`)
 *
 * Implements Master Spec §11.11 #4:
 * - Target delivery latency <= 1 min (p95)
 * - Retry queue up to 72 hours with event-ID deduplication
 * - Re-verifies consent purpose, revocation epoch, and deletion epoch on EVERY retry;
 *   immediately aborts any event older than a deletion notice!
 * - Tracks delivered/in-flight events so post-delivery deletion notices are dispatched
 *   and unconfirmable sinks are recorded explicitly as `deletion_unconfirmed`
 * - Records expired/undelivered events into the loss ledger
 * - Auto-pauses stream with explicit reason on persistent auth/availability failure
 */

import type { ConsentMode, ConsentPurpose } from '../../../packages/contract/schema';
import type { TelemetryLane } from '../../../workers/link-live';

export const STREAM_TARGETS = ['webhook', 'pubsub', 'kafka', 'kinesis'] as const;
export type StreamTargetKind = (typeof STREAM_TARGETS)[number];

export const STREAM_P95_SLA_MS = 60_000; // 1 minute (§11.11 #4)
export const STREAM_RETRY_WINDOW_MS = 72 * 3_600_000; // 72 hours (§11.11 #4)
export const DEFAULT_AUTO_PAUSE_FAILURES = 5;

export interface StreamEventEnvelope {
  readonly eventId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly subjectKey: string | null;
  readonly occurredAtMs: number;
  readonly enqueuedAtMs: number;
  readonly schemaVersion: string;
  readonly consentMode: ConsentMode;
  readonly purposesAllowed: readonly ConsentPurpose[];
  readonly revocationEpoch: number;
  readonly deletionEpoch: number;
  readonly lane: TelemetryLane;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface StreamPolicyState {
  readonly tenantId: string;
  readonly siteId: string;
  readonly currentRevocationEpoch: number;
  readonly currentDeletionEpoch: number;
  /** Any event with `occurredAtMs <= deletedBeforeMs` for this subject MUST abort! */
  readonly deletedSubjectsCutoffMs: ReadonlyMap<string, number>;
  readonly activePurposes: ReadonlySet<ConsentPurpose>;
}

export interface StreamSinkConfig {
  readonly sinkId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly target: StreamTargetKind;
  readonly requiredPurposes: readonly ConsentPurpose[];
  readonly supportsDeletionCallback: boolean;
  readonly retryWindowMs?: number;
  readonly maxConsecutiveFailures?: number;
}

export interface StreamTransportPort {
  send(
    config: StreamSinkConfig,
    event: StreamEventEnvelope
  ): Promise<{
    readonly ok: boolean;
    readonly httpStatus?: number;
    readonly errorReason?: string;
    readonly deliveredAtMs: number;
  }>;
  sendDeletionNotice?: (args: {
    readonly config: StreamSinkConfig;
    readonly subjectKey: string;
    readonly eventIds: readonly string[];
    readonly deletionEpoch: number;
    readonly notifiedAtMs: number;
  }) => Promise<{ readonly confirmed: boolean; readonly note: string }>;
}

export interface StreamLossEntry {
  readonly sinkId: string;
  readonly target: StreamTargetKind;
  readonly eventId: string;
  readonly reason: 'retry_72h_expired' | 'sla_1m_breached';
  readonly attempts: number;
  readonly ageMs: number;
  readonly recordedAtMs: number;
}

export interface PostDeliveryDeletionRecord {
  readonly sinkId: string;
  readonly subjectKey: string;
  readonly affectedEventIds: readonly string[];
  readonly status: 'notified_customer_confirmed' | 'deletion_unconfirmed';
  readonly deletionEpoch: number;
  readonly recordedAtMs: number;
  readonly note: string;
}

interface QueuedStreamItem {
  readonly event: StreamEventEnvelope;
  attempts: number;
  nextAttemptAtMs: number;
  lastError: string | null;
}

export interface StreamFlushSummary {
  readonly deliveredCount: number;
  readonly deduplicatedCount: number;
  readonly abortedPolicyOrDeletionCount: number;
  readonly retriedCount: number;
  readonly expiredToLossLedgerCount: number;
  readonly autoPaused: boolean;
  readonly pauseReason: string | null;
}

export class ContinuousStreamDispatcher {
  private readonly queue: QueuedStreamItem[] = [];
  private readonly deliveredEventIds = new Set<string>();
  private readonly deliveredBySubject = new Map<string, string[]>();
  private readonly latenciesMs: number[] = [];
  private readonly lossLedgerEntries: StreamLossEntry[] = [];
  private readonly deletionRecords: PostDeliveryDeletionRecord[] = [];

  private consecutiveFailures = 0;
  private paused = false;
  private pauseReason: string | null = null;
  private pausedAtMs: number | null = null;

  private readonly retryWindowMs: number;
  private readonly maxConsecutiveFailures: number;

  public constructor(
    public readonly config: StreamSinkConfig,
    private readonly transport: StreamTransportPort
  ) {
    this.retryWindowMs = config.retryWindowMs ?? STREAM_RETRY_WINDOW_MS;
    this.maxConsecutiveFailures =
      config.maxConsecutiveFailures ?? DEFAULT_AUTO_PAUSE_FAILURES;
  }

  public enqueue(event: StreamEventEnvelope): {
    readonly queued: boolean;
    readonly reason?: string;
  } {
    if (
      event.tenantId !== this.config.tenantId ||
      event.siteId !== this.config.siteId
    ) {
      return { queued: false, reason: 'tenant_or_site_mismatch' };
    }
    if (this.deliveredEventIds.has(event.eventId)) {
      return { queued: false, reason: 'duplicate_event_id' };
    }
    if (this.queue.some((q) => q.event.eventId === event.eventId)) {
      return { queued: false, reason: 'already_queued' };
    }
    this.queue.push({
      event,
      attempts: 0,
      nextAttemptAtMs: event.enqueuedAtMs,
      lastError: null,
    });
    return { queued: true };
  }

  public isPaused(): boolean {
    return this.paused;
  }

  public getPauseStatus(): {
    readonly paused: boolean;
    readonly pauseReason: string | null;
    readonly pausedAtMs: number | null;
  } {
    return {
      paused: this.paused,
      pauseReason: this.pauseReason,
      pausedAtMs: this.pausedAtMs,
    };
  }

  public resume(): void {
    this.paused = false;
    this.pauseReason = null;
    this.pausedAtMs = null;
    this.consecutiveFailures = 0;
  }

  private checkPolicyBeforeAttempt(
    event: StreamEventEnvelope,
    policy: StreamPolicyState
  ): { readonly allowed: boolean; readonly reason?: string } {
    if (event.consentMode === 'off') {
      return { allowed: false, reason: 'consent_mode_off' };
    }
    if (event.revocationEpoch < policy.currentRevocationEpoch) {
      return { allowed: false, reason: 'aborted_revocation_epoch_superseded' };
    }
    if (event.deletionEpoch < policy.currentDeletionEpoch) {
      return { allowed: false, reason: 'aborted_deletion_epoch_superseded' };
    }
    if (event.subjectKey !== null) {
      const deletedCutoff = policy.deletedSubjectsCutoffMs.get(event.subjectKey);
      if (deletedCutoff !== undefined && event.occurredAtMs <= deletedCutoff) {
        return { allowed: false, reason: 'aborted_older_than_deletion_notice' };
      }
    }
    for (const reqPurpose of this.config.requiredPurposes) {
      if (
        !event.purposesAllowed.includes(reqPurpose) ||
        !policy.activePurposes.has(reqPurpose)
      ) {
        return { allowed: false, reason: `aborted_missing_purpose:${reqPurpose}` };
      }
    }
    return { allowed: true };
  }

  /**
   * Processes due events in the retry queue, re-verifying purpose, revocation,
   * and deletion state BEFORE every send/retry attempt.
   */
  public async flush(
    policy: StreamPolicyState,
    nowMs = Date.now()
  ): Promise<StreamFlushSummary> {
    if (this.paused) {
      return {
        deliveredCount: 0,
        deduplicatedCount: 0,
        abortedPolicyOrDeletionCount: 0,
        retriedCount: 0,
        expiredToLossLedgerCount: 0,
        autoPaused: true,
        pauseReason: this.pauseReason,
      };
    }

    let deliveredCount = 0;
    let deduplicatedCount = 0;
    let abortedPolicyOrDeletionCount = 0;
    let retriedCount = 0;
    let expiredToLossLedgerCount = 0;

    const remaining: QueuedStreamItem[] = [];

    for (let i = 0; i < this.queue.length; i += 1) {
      const item = this.queue[i]!;
      const ev = item.event;

      if (this.deliveredEventIds.has(ev.eventId)) {
        deduplicatedCount += 1;
        continue;
      }

      // Check 72-hour retry expiry -> evict & record in loss ledger
      const ageMs = Math.max(0, nowMs - ev.enqueuedAtMs);
      if (ageMs > this.retryWindowMs) {
        expiredToLossLedgerCount += 1;
        this.lossLedgerEntries.push({
          sinkId: this.config.sinkId,
          target: this.config.target,
          eventId: ev.eventId,
          reason: 'retry_72h_expired',
          attempts: item.attempts,
          ageMs,
          recordedAtMs: nowMs,
        });
        continue;
      }

      // Mandatory per-attempt re-verification of purpose, revocation, and deletion epoch!
      const policyCheck = this.checkPolicyBeforeAttempt(ev, policy);
      if (!policyCheck.allowed) {
        abortedPolicyOrDeletionCount += 1;
        continue;
      }

      if (this.paused || item.nextAttemptAtMs > nowMs) {
        remaining.push(item);
        continue;
      }

      item.attempts += 1;
      const res = await this.transport.send(this.config, ev);

      if (res.ok) {
        this.consecutiveFailures = 0;
        this.deliveredEventIds.add(ev.eventId);
        deliveredCount += 1;

        if (ev.subjectKey !== null) {
          const list = this.deliveredBySubject.get(ev.subjectKey) ?? [];
          list.push(ev.eventId);
          this.deliveredBySubject.set(ev.subjectKey, list);
        }

        const latencyMs = Math.max(0, res.deliveredAtMs - ev.occurredAtMs);
        this.latenciesMs.push(latencyMs);
        if (latencyMs > STREAM_P95_SLA_MS) {
          this.lossLedgerEntries.push({
            sinkId: this.config.sinkId,
            target: this.config.target,
            eventId: ev.eventId,
            reason: 'sla_1m_breached',
            attempts: item.attempts,
            ageMs: latencyMs,
            recordedAtMs: res.deliveredAtMs,
          });
        }
      } else {
        this.consecutiveFailures += 1;
        item.lastError = res.errorReason ?? `http_${res.httpStatus ?? 'error'}`;
        // Exponential backoff capped at 15 minutes inside 72h retry window
        const backoffMs = Math.min(15 * 60_000, 1000 * Math.pow(2, item.attempts));
        item.nextAttemptAtMs = nowMs + backoffMs;
        remaining.push(item);
        retriedCount += 1;

        const isAuthFailure = res.httpStatus === 401 || res.httpStatus === 403;
        if (
          isAuthFailure ||
          this.consecutiveFailures >= this.maxConsecutiveFailures
        ) {
          this.paused = true;
          this.pausedAtMs = nowMs;
          this.pauseReason = isAuthFailure
            ? `auto_paused_auth_expired:${res.httpStatus}`
            : `auto_paused_consecutive_failures:${this.consecutiveFailures}:${item.lastError}`;
        }
      }
    }

    this.queue.length = 0;
    this.queue.push(...remaining);

    return {
      deliveredCount,
      deduplicatedCount,
      abortedPolicyOrDeletionCount,
      retriedCount,
      expiredToLossLedgerCount,
      autoPaused: this.paused,
      pauseReason: this.pauseReason,
    };
  }

  /**
   * Follows up on already-delivered or in-flight events when a deletion notice
   * arrives (§11.11 #4):
   * - Evicts any queued events for `subjectKey` older than `deletedBeforeMs`
   * - Dispatches deletion callback for already-delivered events; marks sink as
   *   `deletion_unconfirmed` whenever deletion cannot be verified!
   */
  public async handlePostDeliveryDeletion(args: {
    readonly subjectKey: string;
    readonly deletedBeforeMs: number;
    readonly deletionEpoch: number;
    readonly nowMs?: number;
  }): Promise<PostDeliveryDeletionRecord> {
    const nowMs = args.nowMs ?? Date.now();

    // Immediately drop queued unsent events older than deletion notice
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const ev = this.queue[i]!.event;
      if (
        ev.subjectKey === args.subjectKey &&
        ev.occurredAtMs <= args.deletedBeforeMs
      ) {
        this.queue.splice(i, 1);
      }
    }

    const deliveredIds = this.deliveredBySubject.get(args.subjectKey) ?? [];

    if (!this.config.supportsDeletionCallback || !this.transport.sendDeletionNotice) {
      const rec: PostDeliveryDeletionRecord = {
        sinkId: this.config.sinkId,
        subjectKey: args.subjectKey,
        affectedEventIds: [...deliveredIds],
        status: 'deletion_unconfirmed',
        deletionEpoch: args.deletionEpoch,
        recordedAtMs: nowMs,
        note: 'Sink does not expose deletion confirmation API; recorded as deletion_unconfirmed (§11.11 #4)',
      };
      this.deletionRecords.push(rec);
      return rec;
    }

    const cbRes = await this.transport.sendDeletionNotice({
      config: this.config,
      subjectKey: args.subjectKey,
      eventIds: deliveredIds,
      deletionEpoch: args.deletionEpoch,
      notifiedAtMs: nowMs,
    });

    const rec: PostDeliveryDeletionRecord = {
      sinkId: this.config.sinkId,
      subjectKey: args.subjectKey,
      affectedEventIds: [...deliveredIds],
      status: cbRes.confirmed
        ? 'notified_customer_confirmed'
        : 'deletion_unconfirmed',
      deletionEpoch: args.deletionEpoch,
      recordedAtMs: nowMs,
      note: cbRes.note,
    };
    this.deletionRecords.push(rec);
    return rec;
  }

  public getQueueDepth(): number {
    return this.queue.length;
  }

  public getLossLedgerEntries(): readonly StreamLossEntry[] {
    return [...this.lossLedgerEntries];
  }

  public getDeletionRecords(): readonly PostDeliveryDeletionRecord[] {
    return [...this.deletionRecords];
  }

  public getObservedP95LatencyMs(): number {
    if (this.latenciesMs.length === 0) return 0;
    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    return sorted[idx] ?? 0;
  }
}
