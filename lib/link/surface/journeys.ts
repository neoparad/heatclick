/**
 * UGOKI LINK v2 — Journeys (Paths & Ordered Funnels), Usage/Quota Notifications (§11.8),
 * Privacy Operations (Disclosure + 14-day Deletion, §5.9), and Goal Definitions (§11.10)
 */

import crypto from 'node:crypto';
import {
  CANONICAL_SCHEMA,
  generatePrivacyDisclosure,
  type ConsentMode,
  type DisclosureOptions,
  type PrivacyDisclosureRecord,
} from '@/packages/contract/schema';
import {
  createDataLayerMetric,
  sha256Hex,
  wrapUntrusted,
  type EvidenceRef,
  type MeasureInput,
  type UntrustedValue,
  type VerifiedNumericLeaf,
} from '@/packages/contract/response';
import { MIN_SEGMENT_CELL_K, toSuppressedBucket } from './segments';

// =========================================================================
// 1. Journeys: Ordered Funnels & Navigation Paths
// =========================================================================

export interface JourneyEventObservation {
  readonly sessionId: string;
  readonly pagePath: string;
  readonly timestampMs: number;
  readonly consentMode: ConsentMode;
}

export interface FunnelStepResult {
  readonly stepIndex: number;
  readonly pagePath: UntrustedValue;
  readonly status: 'ok' | 'suppressed' | 'not_collected';
  readonly sessions: number | null;
  readonly nBucket?: '0' | '1-4' | '5-9';
  readonly conversionFromPrev: number | null;
}

export interface FunnelEvaluationResult {
  readonly consentBlocked: boolean;
  readonly steps: ReadonlyArray<FunnelStepResult>;
  readonly measures: Readonly<Record<string, MeasureInput<VerifiedNumericLeaf>>>;
}

/**
 * Evaluates an ordered multi-step funnel within `windowSec`.
 * Under `off` or `cookieless`, cross-page session journeys cannot be linked (`tel.U13`),
 * returning `status: 'not_collected'` rather than fabricated numbers.
 * Any step with count < k (10) is suppressed (`store.G-12`).
 */
export function evaluateOrderedFunnel(params: {
  readonly siteConsentMode: ConsentMode;
  readonly steps: ReadonlyArray<string>;
  readonly events: ReadonlyArray<JourneyEventObservation>;
  readonly windowSec: number;
  readonly queryRef: EvidenceRef;
  readonly minCellK?: number;
}): FunnelEvaluationResult {
  const minK = params.minCellK ?? MIN_SEGMENT_CELL_K;
  const measures: Record<string, MeasureInput<VerifiedNumericLeaf>> = {};

  // `off` and `cookieless` cannot link cross-page/cross-tab sessions (tel.U13)
  if (params.siteConsentMode === 'off' || params.siteConsentMode === 'cookieless') {
    const blockedSteps: FunnelStepResult[] = params.steps.map((p, idx) => {
      const mKey = `funnel_step_${idx}_sessions`;
      measures[mKey] = {
        value: null,
        unit: 'sessions',
        status: 'not_collected',
        reason: `Cross-page session funnel unavailable under consent mode "${params.siteConsentMode}" (tel.U13)`,
        evidence: {
          level: 'observed',
          exactness: 'exact',
          criteria: [],
          refs: [params.queryRef],
          scope: `funnel:step_${idx}`,
        },
        sample: null,
        interval: null,
        unmet_gates: [
          {
            id: 'tel.G10',
            required: 'session',
            observed: params.siteConsentMode,
            unlock: 'Enable consent mode session, stats_exempt, or full with jurisdiction sign-off',
            reason: 'consent_mode_forbids_session_linking',
          },
        ],
      };
      return {
        stepIndex: idx,
        pagePath: wrapUntrusted(p, 'url'),
        status: 'not_collected',
        sessions: null,
        conversionFromPrev: null,
      };
    });
    return { consentBlocked: true, steps: blockedSteps, measures };
  }

  // Group events by session and sort chronologically
  const bySession = new Map<string, JourneyEventObservation[]>();
  for (const ev of params.events) {
    if (ev.consentMode === 'off' || ev.consentMode === 'cookieless') continue;
    const arr = bySession.get(ev.sessionId) ?? [];
    arr.push(ev);
    bySession.set(ev.sessionId, arr);
  }
  for (const arr of bySession.values()) {
    arr.sort((a, b) => a.timestampMs - b.timestampMs);
  }

  const windowMs = Math.max(1, params.windowSec) * 1000;
  const stepCounts = new Array<number>(params.steps.length).fill(0);

  for (const arr of bySession.values()) {
    let firstTs = -1;
    let stepIdx = 0;
    for (const ev of arr) {
      if (stepIdx >= params.steps.length) break;
      if (ev.pagePath === params.steps[stepIdx]) {
        if (stepIdx === 0) {
          firstTs = ev.timestampMs;
          stepCounts[0] += 1;
          stepIdx = 1;
        } else if (ev.timestampMs - firstTs <= windowMs) {
          stepCounts[stepIdx] += 1;
          stepIdx += 1;
        }
      }
    }
  }

  const stepResults: FunnelStepResult[] = [];
  for (let i = 0; i < params.steps.length; i++) {
    const count = stepCounts[i];
    const mKey = `funnel_step_${i}_sessions`;

    if (count < minK) {
      stepResults.push({
        stepIndex: i,
        pagePath: wrapUntrusted(params.steps[i], 'url'),
        status: 'suppressed',
        sessions: null,
        nBucket: toSuppressedBucket(count),
        conversionFromPrev: null,
      });
      measures[mKey] = {
        value: null,
        unit: 'sessions',
        status: 'suppressed',
        reason: `Funnel step ${i} below privacy threshold k=${minK}`,
        evidence: {
          level: 'observed',
          exactness: 'exact',
          criteria: [],
          refs: [params.queryRef],
          scope: `funnel:step_${i}`,
        },
        sample: null,
        interval: null,
        unmet_gates: [
          {
            id: 'store.G-12',
            required: minK,
            observed: toSuppressedBucket(count),
            unlock: `Accumulate >= ${minK} sessions reaching step ${i}`,
            reason: 'min_cell',
          },
        ],
      };
    } else {
      const prev = i === 0 ? count : stepCounts[i - 1];
      const rate = prev >= minK && prev > 0 ? Number((count / prev).toFixed(6)) : null;
      stepResults.push({
        stepIndex: i,
        pagePath: wrapUntrusted(params.steps[i], 'url'),
        status: 'ok',
        sessions: count,
        conversionFromPrev: rate,
      });
      measures[mKey] = {
        value: createDataLayerMetric(count, params.queryRef.ref_id, {
          authority: 'data_layer',
          createdAt: 'issued_at' in params.queryRef && params.queryRef.issued_at ? params.queryRef.issued_at : undefined,
        }),
        unit: 'sessions',
        status: 'ok',
        evidence: {
          level: 'observed',
          exactness: 'exact',
          criteria: [],
          refs: [params.queryRef],
          scope: `funnel:step_${i}`,
        },
        sample: { n: count, unit_kind: 'session' },
        interval: null,
        unmet_gates: [],
      };
    }
  }

  return { consentBlocked: false, steps: stepResults, measures };
}

export interface PathTransitionEdge {
  readonly fromPath: UntrustedValue;
  readonly toPath: UntrustedValue;
  readonly status: 'ok' | 'suppressed';
  readonly transitions: number | null;
  readonly nBucket?: '0' | '1-4' | '5-9';
}

export function evaluateNavigationPaths(params: {
  readonly siteConsentMode: ConsentMode;
  readonly events: ReadonlyArray<JourneyEventObservation>;
  readonly minCellK?: number;
}): { readonly consentBlocked: boolean; readonly edges: ReadonlyArray<PathTransitionEdge> } {
  if (params.siteConsentMode === 'off' || params.siteConsentMode === 'cookieless') {
    return { consentBlocked: true, edges: [] };
  }
  const minK = params.minCellK ?? MIN_SEGMENT_CELL_K;
  const bySession = new Map<string, JourneyEventObservation[]>();
  for (const ev of params.events) {
    if (ev.consentMode === 'off' || ev.consentMode === 'cookieless') continue;
    const arr = bySession.get(ev.sessionId) ?? [];
    arr.push(ev);
    bySession.set(ev.sessionId, arr);
  }

  const edgeCounts = new Map<string, { from: string; to: string; count: number }>();
  for (const arr of bySession.values()) {
    arr.sort((a, b) => a.timestampMs - b.timestampMs);
    for (let i = 0; i + 1 < arr.length; i++) {
      const from = arr[i].pagePath;
      const to = arr[i + 1].pagePath;
      if (from === to) continue;
      const key = `${from}\u0000${to}`;
      const existing = edgeCounts.get(key) ?? { from, to, count: 0 };
      existing.count += 1;
      edgeCounts.set(key, existing);
    }
  }

  const edges: PathTransitionEdge[] = [...edgeCounts.values()]
    .sort((a, b) => b.count - a.count)
    .map((e) =>
      e.count < minK
        ? {
            fromPath: wrapUntrusted(e.from, 'url'),
            toPath: wrapUntrusted(e.to, 'url'),
            status: 'suppressed' as const,
            transitions: null,
            nBucket: toSuppressedBucket(e.count),
          }
        : {
            fromPath: wrapUntrusted(e.from, 'url'),
            toPath: wrapUntrusted(e.to, 'url'),
            status: 'ok' as const,
            transitions: e.count,
          }
    );

  return { consentBlocked: false, edges };
}

// =========================================================================
// 2. Usage Metering, 80/100/120% Notifications & `count_only` Over-Quota (§11.8)
// =========================================================================

export type TrustTier = 'none' | 'continuity' | 'edge_attested' | 'origin_attested';

export interface UsageLedgerRow {
  readonly rowId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly saved: boolean;
  readonly trustTier: TrustTier;
  readonly quarantined: boolean;
  readonly isLabOrCanary: boolean;
  readonly occurredAt: string;
}

export type CollectionModeTag =
  | 'standard'
  | 'over_quota_count_only'
  | 'comparison_arm_minimal';

export interface SiteNotification {
  readonly notificationId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly kind: 'quota_80' | 'quota_100' | 'quota_120' | 'deletion_day10_warning' | 'isolation_hold_f01';
  readonly severity: 'info' | 'warning' | 'critical';
  readonly message: string;
  readonly createdAt: string;
}

export interface SiteUsageSummary {
  readonly tenantId: string;
  readonly siteId: string;
  readonly monthlyQuotaPvs: number;
  readonly billablePvs: number;
  readonly ignoredUnverifiedOrQuarantinedPvs: number;
  readonly utilizationPct: number;
  /** Over-quota NEVER returns 402 to browser or drops PVs; degrades unit to `over_quota_count_only`! */
  readonly collectionModeTag: CollectionModeTag;
  /** Explicitly distinct from the SDK weight-test minimal comparison arm. */
  readonly distinctFromComparisonArmMinimal: true;
  readonly pvThinningForbidden: true;
  readonly browserHttp402Forbidden: true;
  readonly alerts: ReadonlyArray<SiteNotification>;
}

const TRUST_BILLABLE: ReadonlySet<TrustTier> = new Set([
  'continuity',
  'edge_attested',
  'origin_attested',
]);

export function evaluateSiteUsage(params: {
  readonly tenantId: string;
  readonly siteId: string;
  readonly monthlyQuotaPvs: number;
  readonly rows: ReadonlyArray<UsageLedgerRow>;
  readonly now?: Date;
}): SiteUsageSummary {
  const nowIso = (params.now ?? new Date()).toISOString();
  let billablePvs = 0;
  let ignored = 0;

  for (const r of params.rows) {
    if (r.tenantId !== params.tenantId || r.siteId !== params.siteId) continue;
    // §11.8: Count ONLY saved, non-quarantined, non-lab PVs at continuity trust or higher!
    if (r.saved && !r.quarantined && !r.isLabOrCanary && TRUST_BILLABLE.has(r.trustTier)) {
      billablePvs += 1;
    } else {
      ignored += 1;
    }
  }

  const quota = Math.max(1, params.monthlyQuotaPvs);
  const utilizationPct = Number(((billablePvs / quota) * 100).toFixed(2));
  const alerts: SiteNotification[] = [];

  if (utilizationPct >= 80) {
    alerts.push({
      notificationId: `ntf_${sha256Hex(`${params.siteId}:quota_80`).slice(0, 12)}`,
      tenantId: params.tenantId,
      siteId: params.siteId,
      kind: 'quota_80',
      severity: 'info',
      message: `Billable PV usage reached ${utilizationPct}% (>= 80% threshold)`,
      createdAt: nowIso,
    });
  }
  if (utilizationPct >= 100) {
    alerts.push({
      notificationId: `ntf_${sha256Hex(`${params.siteId}:quota_100`).slice(0, 12)}`,
      tenantId: params.tenantId,
      siteId: params.siteId,
      kind: 'quota_100',
      severity: 'warning',
      message: `Billable PV usage reached ${utilizationPct}% (>= 100%): unit collection downgraded to over_quota_count_only (no PV thinning, no browser 402)`,
      createdAt: nowIso,
    });
  }
  if (utilizationPct >= 120) {
    alerts.push({
      notificationId: `ntf_${sha256Hex(`${params.siteId}:quota_120`).slice(0, 12)}`,
      tenantId: params.tenantId,
      siteId: params.siteId,
      kind: 'quota_120',
      severity: 'critical',
      message: `Billable PV usage reached ${utilizationPct}% (>= 120% critical threshold)`,
      createdAt: nowIso,
    });
  }

  return {
    tenantId: params.tenantId,
    siteId: params.siteId,
    monthlyQuotaPvs: quota,
    billablePvs,
    ignoredUnverifiedOrQuarantinedPvs: ignored,
    utilizationPct,
    collectionModeTag: utilizationPct >= 100 ? 'over_quota_count_only' : 'standard',
    distinctFromComparisonArmMinimal: true,
    pvThinningForbidden: true,
    browserHttp402Forbidden: true,
    alerts,
  };
}

// =========================================================================
// 3. Privacy Operations: Disclosure & 14-Day Deletion Certificates (§5.9)
// =========================================================================

export interface DeletionCertificate {
  readonly certificateId: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly scope: 'subject' | 'site' | 'tenant';
  readonly state: 'scheduled' | 'masked' | 'purged' | 'certified' | 'cancelled' | 'overdue';
  readonly scheduledAt: string;
  readonly deadline14dAt: string;
  readonly certifiedAt: string | null;
  readonly residualRowCount: number | null;
  readonly slaBreached: boolean;
  readonly day10WarningIssued: boolean;
  readonly certificateSha256: string;
}

export function buildSitePrivacyDisclosure(options?: DisclosureOptions): PrivacyDisclosureRecord {
  return generatePrivacyDisclosure(CANONICAL_SCHEMA, options);
}

export function buildDeletionCertificate(params: {
  readonly requestId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly scope: 'subject' | 'site' | 'tenant';
  readonly state: DeletionCertificate['state'];
  readonly scheduledAt: string;
  readonly certifiedAt?: string | null;
  readonly residualRowCount?: number | null;
  readonly now?: Date;
}): DeletionCertificate {
  const now = params.now ?? new Date();
  const scheduledMs = new Date(params.scheduledAt).getTime();
  const deadlineMs = scheduledMs + 14 * 24 * 60 * 60 * 1000;
  const day10Ms = scheduledMs + 10 * 24 * 60 * 60 * 1000;

  const isFinished = params.state === 'certified' || params.state === 'cancelled';
  const slaBreached = !isFinished && now.getTime() > deadlineMs;
  const effectiveState = slaBreached ? 'overdue' : params.state;
  const day10WarningIssued = !isFinished && now.getTime() >= day10Ms;

  const certBody = {
    requestId: params.requestId,
    tenantId: params.tenantId,
    siteId: params.siteId,
    scope: params.scope,
    state: effectiveState,
    scheduledAt: params.scheduledAt,
    deadline14dAt: new Date(deadlineMs).toISOString(),
    certifiedAt: params.certifiedAt ?? null,
    residualRowCount: params.residualRowCount ?? null,
  };
  const certificateSha256 = sha256Hex(JSON.stringify(certBody));

  return {
    certificateId: `cert_${certificateSha256.slice(0, 16)}`,
    ...certBody,
    slaBreached,
    day10WarningIssued,
    certificateSha256,
  };
}

// =========================================================================
// 4. Conversion Goal Definitions (REST & MCP, R1 — §11.10)
// =========================================================================

export type GoalKind = 'url_match' | 'element_click' | 'custom_event' | 'ga4_sync';

export interface ConversionGoalDefinition {
  readonly goalId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly name: string;
  readonly kind: GoalKind;
  readonly matcher: string;
  readonly valueYen: number | null;
  readonly version: number;
  readonly source: 'site_config' | 'external_ga4';
  readonly deleted: boolean;
  readonly updatedAt: string;
  readonly updatedByPrincipalId: string;
}

export class GoalRegistry {
  private readonly goals = new Map<string, ConversionGoalDefinition>();

  private key(tenantId: string, siteId: string, goalId: string): string {
    return `${tenantId}:${siteId}:${goalId}`;
  }

  public upsert(params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly goalId?: string;
    readonly name: string;
    readonly kind: GoalKind;
    readonly matcher: string;
    readonly valueYen?: number | null;
    readonly updatedByPrincipalId: string;
    readonly now?: Date;
  }): ConversionGoalDefinition {
    const goalId = params.goalId ?? `goal_${crypto.randomBytes(6).toString('hex')}`;
    const k = this.key(params.tenantId, params.siteId, goalId);
    const prev = this.goals.get(k);
    const record: ConversionGoalDefinition = {
      goalId,
      tenantId: params.tenantId,
      siteId: params.siteId,
      name: params.name,
      kind: params.kind,
      matcher: params.matcher,
      valueYen: params.valueYen ?? null,
      version: prev ? prev.version + 1 : 1,
      source: params.kind === 'ga4_sync' ? 'external_ga4' : 'site_config',
      deleted: false,
      updatedAt: (params.now ?? new Date()).toISOString(),
      updatedByPrincipalId: params.updatedByPrincipalId,
    };
    this.goals.set(k, record);
    return record;
  }

  public list(tenantId: string, siteId: string): ReadonlyArray<ConversionGoalDefinition> {
    const prefix = `${tenantId}:${siteId}:`;
    const out: ConversionGoalDefinition[] = [];
    for (const [k, g] of this.goals.entries()) {
      if (k.startsWith(prefix) && !g.deleted) {
        out.push(g);
      }
    }
    return out;
  }

  public softDelete(
    tenantId: string,
    siteId: string,
    goalId: string,
    principalId: string,
    now: Date = new Date()
  ): boolean {
    const k = this.key(tenantId, siteId, goalId);
    const prev = this.goals.get(k);
    if (!prev || prev.deleted) return false;
    this.goals.set(k, {
      ...prev,
      deleted: true,
      version: prev.version + 1,
      updatedAt: now.toISOString(),
      updatedByPrincipalId: principalId,
    });
    return true;
  }
}
