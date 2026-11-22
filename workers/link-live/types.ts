/**
 * UGOKI LINK v2 — 30-Minute Edge Live Durable Object Types (`workers/link-live`)
 *
 * Pure local interfaces (no `@cloudflare/workers-types` dependency) so both
 * Cloudflare Workers Durable Objects and Node/Jest share the exact same
 * strict-TypeScript implementation.
 */

import type { CollectionLane } from '../../packages/contract/schema';
import type { DataRegion } from '../link-wal';

export const LIVE_LANES = [
  'standard_telemetry',
  'customer_events',
  'visual_replay',
] as const;
export type TelemetryLane = (typeof LIVE_LANES)[number];
export type AcceptedLiveLane = TelemetryLane | CollectionLane | 'custom_event' | 'replay';

export type LiveTrustLevel =
  | 'edge_attested'
  | 'origin_attested'
  | 'continuity'
  | 'none';

export type LabTokenPurpose =
  | 'onboarding_verify'
  | 'sdk_canary_visit'
  | 'preflight_audit'
  | 'qa_instrument';

export interface LabTokenClaims {
  readonly tokenId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly purpose: LabTokenPurpose;
  readonly runId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface LiveIngestEvent {
  readonly tenantId: string;
  readonly siteId: string;
  readonly storageRegion: DataRegion;
  readonly processingRegion: string;
  readonly lane: AcceptedLiveLane;
  /** `pv_id` for standard_telemetry, or immutable `event_id`/`replay_id` for other lanes. */
  readonly unitId: string;
  readonly urlId?: string;
  readonly receivedAtMs: number;
  readonly occurredAtMs?: number;
  readonly seq?: number;
  readonly liveWord?: number;
  readonly scrollMaxPx?: number;
  readonly visMs?: number;
  readonly trust: LiveTrustLevel;
  readonly abuseHold?: boolean;
  readonly consentMode: 'off' | 'cookieless' | 'stats_exempt' | 'session' | 'full';
  /** Present when visit originates from onboarding verification or lab instrumentation. */
  readonly labToken?: LabTokenClaims | null;
  readonly labRunId?: string | null;
  /** Source path (`collector` or `wal_heal`, §5.3). */
  readonly ingestSource?: 'collector' | 'wal_heal';
}

export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { readonly prefix?: string }): Promise<Map<string, T>>;
}

export interface DurableObjectStateLike {
  readonly id: { readonly toString: () => string };
  readonly storage: DurableObjectStorageLike;
}

export class InMemoryDurableObjectStorage implements DurableObjectStorageLike {
  private readonly data = new Map<string, unknown>();

  public async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  public async put<T = unknown>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  public async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  public async list<T = unknown>(options?: {
    readonly prefix?: string;
  }): Promise<Map<string, T>> {
    const prefix = options?.prefix ?? '';
    const out = new Map<string, T>();
    for (const [k, v] of this.data.entries()) {
      if (k.startsWith(prefix)) {
        out.set(k, v as T);
      }
    }
    return out;
  }
}

export class InMemoryDurableObjectState implements DurableObjectStateLike {
  public readonly id: { readonly toString: () => string };
  public readonly storage: InMemoryDurableObjectStorage;

  public constructor(idString = 'link-live-do-0') {
    this.id = { toString: () => idString };
    this.storage = new InMemoryDurableObjectStorage();
  }
}

export interface LiveMinuteBucketSnapshot {
  readonly minuteStartMs: number;
  readonly minuteIso: string;
  readonly standardPvs: number;
  readonly standardBillablePvs: number;
  readonly standardActiveSumVisMs: number;
  readonly customerEventsCount: number;
  readonly visualReplaysCount: number;
  readonly labExcludedCount: number;
}

export interface OnboardingVerifyVisitRecord {
  readonly tokenId: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly unitId: string;
  readonly lane: TelemetryLane;
  readonly consentMode: LiveIngestEvent['consentMode'];
  readonly occurredAtMs: number;
  readonly observedAtMs: number;
  readonly visibilityLatencyMs: number;
  readonly within60sSla: boolean;
  readonly excludedFromHumanTotals: true;
  readonly excludedFromBillablePvs: true;
}

export interface OnboardingVerifyStatus {
  readonly tenantId: string;
  readonly siteId: string;
  readonly verified: boolean;
  readonly within60sSla: boolean;
  readonly visitCount: number;
  readonly latestVisit: OnboardingVerifyVisitRecord | null;
  readonly visits: readonly OnboardingVerifyVisitRecord[];
}
