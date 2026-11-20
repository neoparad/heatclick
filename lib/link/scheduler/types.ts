/**
 * UGOKI LINK v2 — Single 5-Class Priority Scheduler, Conformance Failover,
 * Credit Reservation / Signed Receipt Settlement & Capacity Gate Types
 *
 * Implements Master Architecture v2 §11.4, §13.2 and `surface-final.md` §7.2, §8.1.
 */

import type { RiskClass } from '@/lib/link/auth';
import type { LinkPayer } from '@/lib/link/linkage';

// =========================================================================
// 1. 5 Priority Classes (Strict Precedence)
// =========================================================================

export const JOB_PRIORITY_CLASSES = [
  'safety',
  'integrity',
  'identity',
  'evidence',
  'enrichment',
] as const;

export type JobPriorityClass = (typeof JOB_PRIORITY_CLASSES)[number];

export const PRIORITY_RANK: Readonly<Record<JobPriorityClass, number>> = {
  safety: 0,
  integrity: 1,
  identity: 2,
  evidence: 3,
  enrichment: 4,
};

export interface ClassStarvationPolicy {
  readonly priorityClass: JobPriorityClass;
  /** Maximum wait duration before a queued job is promoted to prevent starvation. */
  readonly maxWaitMs: number;
}

export const DEFAULT_STARVATION_POLICIES: Readonly<Record<JobPriorityClass, number>> = {
  safety: 30 * 1000, // 30 s
  integrity: 5 * 60 * 1000, // 5 min
  identity: 15 * 60 * 1000, // 15 min
  evidence: 60 * 60 * 1000, // 60 min
  enrichment: 6 * 60 * 60 * 1000, // 6 hours
};

/** Baseline full-refresh render credits across the 5 own sites (§13.2 / Master Architecture). */
export const BASELINE_FULL_REFRESH_RENDER_CREDITS = 9100;

/** Inline lane URL ceiling (`surface-final.md` §7.2 & §8.2). */
export const INLINE_LANE_MAX_URLS = 50;

// =========================================================================
// 2. Registered Job Kinds (`surface-final.md` §7.2)
// =========================================================================

export type JobKind =
  | 'crawl_http'
  | 'render_structure'
  | 'probe_click'
  | 'probe_defect'
  | 'a11y'
  | 'psi_lab'
  | 'serp_probe'
  | 'embed'
  | 'url_probe'
  | 'preflight_patch'
  | 'apply_patch'
  | 'fetch_revisions'
  | 'lab_agent_run'
  | 'sdk_replay';

export type ExecutionLane = 'inline' | 'bulk';

export type ExecutorKind = 'crawl_pool' | 'ugoki_br' | 'ugoki_http' | 'raw_html_floor' | 'vault_holder';

export interface JobKindSpec {
  readonly kind: JobKind;
  readonly defaultPriority: JobPriorityClass;
  readonly riskClass: RiskClass;
  readonly allowedLanes: ReadonlyArray<ExecutionLane>;
  readonly supportedExecutors: ReadonlyArray<ExecutorKind>;
  readonly requiresBrowserConformance: boolean;
  readonly supportsRawHtmlIdentityFloor: boolean;
  readonly creditsPerUnit: number;
  readonly checkRateCreditsPerUnit: number;
}

export const JOB_KIND_REGISTRY: Readonly<Record<JobKind, JobKindSpec>> = {
  crawl_http: {
    kind: 'crawl_http',
    defaultPriority: 'enrichment',
    riskClass: 'R1',
    allowedLanes: ['bulk'],
    supportedExecutors: ['crawl_pool'],
    requiresBrowserConformance: false,
    supportsRawHtmlIdentityFloor: true,
    creditsPerUnit: 1,
    checkRateCreditsPerUnit: 0.25,
  },
  render_structure: {
    kind: 'render_structure',
    defaultPriority: 'identity',
    riskClass: 'R1',
    allowedLanes: ['inline', 'bulk'],
    supportedExecutors: ['crawl_pool', 'ugoki_br', 'raw_html_floor'],
    requiresBrowserConformance: true,
    supportsRawHtmlIdentityFloor: true,
    creditsPerUnit: 5,
    checkRateCreditsPerUnit: 1,
  },
  probe_click: {
    kind: 'probe_click',
    defaultPriority: 'evidence',
    riskClass: 'R1',
    allowedLanes: ['inline'],
    supportedExecutors: ['crawl_pool'],
    requiresBrowserConformance: true,
    supportsRawHtmlIdentityFloor: false,
    creditsPerUnit: 6,
    checkRateCreditsPerUnit: 2,
  },
  probe_defect: {
    kind: 'probe_defect',
    defaultPriority: 'evidence',
    riskClass: 'R1',
    allowedLanes: ['inline'],
    supportedExecutors: ['crawl_pool', 'ugoki_br'],
    requiresBrowserConformance: true,
    supportsRawHtmlIdentityFloor: false,
    creditsPerUnit: 5,
    checkRateCreditsPerUnit: 1,
  },
  a11y: {
    kind: 'a11y',
    defaultPriority: 'evidence',
    riskClass: 'R1',
    allowedLanes: ['inline'],
    supportedExecutors: ['crawl_pool', 'ugoki_br'],
    requiresBrowserConformance: true,
    supportsRawHtmlIdentityFloor: false,
    creditsPerUnit: 4,
    checkRateCreditsPerUnit: 1,
  },
  psi_lab: {
    kind: 'psi_lab',
    defaultPriority: 'evidence',
    riskClass: 'R1',
    allowedLanes: ['inline'],
    supportedExecutors: ['crawl_pool', 'ugoki_http'],
    requiresBrowserConformance: false,
    supportsRawHtmlIdentityFloor: false,
    creditsPerUnit: 2,
    checkRateCreditsPerUnit: 1,
  },
  serp_probe: {
    kind: 'serp_probe',
    defaultPriority: 'evidence',
    riskClass: 'R1',
    allowedLanes: ['inline'],
    supportedExecutors: ['crawl_pool'],
    requiresBrowserConformance: false,
    supportsRawHtmlIdentityFloor: false,
    creditsPerUnit: 3,
    checkRateCreditsPerUnit: 1,
  },
  embed: {
    kind: 'embed',
    defaultPriority: 'enrichment',
    riskClass: 'R1',
    allowedLanes: ['bulk'],
    supportedExecutors: ['crawl_pool', 'ugoki_http'],
    requiresBrowserConformance: false,
    supportsRawHtmlIdentityFloor: false,
    creditsPerUnit: 1,
    checkRateCreditsPerUnit: 0.25,
  },
  url_probe: {
    kind: 'url_probe',
    defaultPriority: 'identity',
    riskClass: 'R1',
    allowedLanes: ['inline'],
    supportedExecutors: ['crawl_pool'],
    requiresBrowserConformance: false,
    supportsRawHtmlIdentityFloor: false,
    creditsPerUnit: 1,
    checkRateCreditsPerUnit: 0.5,
  },
  preflight_patch: {
    kind: 'preflight_patch',
    defaultPriority: 'safety',
    riskClass: 'R1',
    allowedLanes: ['inline'],
    supportedExecutors: ['crawl_pool', 'ugoki_br'],
    requiresBrowserConformance: true,
    supportsRawHtmlIdentityFloor: false,
    creditsPerUnit: 6,
    checkRateCreditsPerUnit: 2,
  },
  apply_patch: {
    kind: 'apply_patch',
    defaultPriority: 'safety',
    riskClass: 'R2',
    allowedLanes: ['inline'],
    supportedExecutors: ['vault_holder'],
    requiresBrowserConformance: false,
    supportsRawHtmlIdentityFloor: false,
    creditsPerUnit: 2,
    checkRateCreditsPerUnit: 1,
  },
  fetch_revisions: {
    kind: 'fetch_revisions',
    defaultPriority: 'integrity',
    riskClass: 'R2',
    allowedLanes: ['inline'],
    supportedExecutors: ['vault_holder'],
    requiresBrowserConformance: false,
    supportsRawHtmlIdentityFloor: false,
    creditsPerUnit: 1,
    checkRateCreditsPerUnit: 1,
  },
  lab_agent_run: {
    kind: 'lab_agent_run',
    defaultPriority: 'integrity',
    riskClass: 'R1',
    allowedLanes: ['bulk'],
    supportedExecutors: ['crawl_pool', 'ugoki_br'],
    requiresBrowserConformance: true,
    supportsRawHtmlIdentityFloor: false,
    creditsPerUnit: 8,
    checkRateCreditsPerUnit: 2,
  },
  sdk_replay: {
    kind: 'sdk_replay',
    defaultPriority: 'integrity',
    riskClass: 'R1',
    allowedLanes: ['bulk'],
    supportedExecutors: ['crawl_pool', 'ugoki_br'],
    requiresBrowserConformance: true,
    supportsRawHtmlIdentityFloor: false,
    creditsPerUnit: 6,
    checkRateCreditsPerUnit: 2,
  },
};

// =========================================================================
// 3. Executor Conformance & Pool Model
// =========================================================================

export interface ExecutorConformance {
  readonly segmenterHash: string;
  readonly profileSet: ReadonlyArray<string>;
  readonly probeBundleHash: string;
}

export interface ExecutorNode {
  readonly executorId: string;
  readonly kind: ExecutorKind;
  readonly supportedJobKinds: ReadonlyArray<JobKind>;
  readonly conformance: ExecutorConformance;
  readonly publicKeyPem: string;
  readonly signerKid: string;
  readonly maxConcurrency: number;
  readonly dailyRenderCapacity: number;
  healthy: boolean;
  currentInFlight: number;
}

// =========================================================================
// 4. Scheduled Job, Budget Reservation & Signed Usage Receipt
// =========================================================================

export type JobState = 'queued' | 'dispatched' | 'completed' | 'failed' | 'cancelled';

export interface CreditReservation {
  readonly reservationId: string;
  readonly jobId: string;
  readonly grantId: string;
  readonly tenantId: string;
  readonly payer: LinkPayer;
  readonly reservedCredits: number;
  readonly reservedExternalSpendUsd: number;
  status: 'reserved' | 'settled' | 'released';
  readonly createdAt: string;
  settledAt?: string;
}

export interface SignedUsageReceipt {
  readonly receiptId: string;
  readonly jobId: string;
  readonly grantId: string;
  readonly executorId: string;
  readonly kind: JobKind;
  readonly units: number;
  readonly credits: number;
  readonly externalSpendUsd: number;
  readonly scheduleHash: string;
  readonly issuedAt: string;
  readonly signerKid: string;
  readonly signature: string;
}

export interface PassthroughLedgerEntry {
  readonly ledgerEntryId: string;
  readonly lineType: 'crawl_passthrough';
  readonly receiptId: string;
  readonly jobId: string;
  readonly grantId: string;
  readonly tenantId: string;
  readonly payer: LinkPayer;
  readonly kind: JobKind;
  readonly units: number;
  readonly creditsCharged: number;
  readonly creditsReleased: number;
  readonly externalSpendUsd: number;
  readonly scheduleHash: string;
  readonly settledAt: string;
}

export interface ScheduledJob {
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly grantId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly planId: string;
  readonly window: string;
  readonly kind: JobKind;
  readonly priorityClass: JobPriorityClass;
  readonly lane: ExecutionLane;
  readonly targets: ReadonlyArray<string>;
  readonly targetsHash: string;
  readonly knownUnchangedCount: number;
  readonly payer: LinkPayer;
  readonly allowRawHtmlFallback: boolean;
  readonly reservationId: string;
  readonly scheduleHash: string;
  state: JobState;
  readonly submittedAt: string;
  dispatchedAt?: string;
  completedAt?: string;
  assignedExecutorId?: string;
  assignedExecutorKind?: ExecutorKind;
  promotedByStarvationGuard?: boolean;
  usedRawHtmlFloor?: boolean;
}

// =========================================================================
// 5. Capacity Gate (`surf.capacity` — >= 2x Cumulative Demand)
// =========================================================================

export interface PriorityDemandBreakdown {
  readonly safety: number;
  readonly integrity: number;
  readonly identity: number;
  readonly evidence: number;
  readonly enrichment: number;
}

export interface TierCapacityCheck {
  readonly tier: JobPriorityClass;
  readonly tierDemand: number;
  readonly cumulativeDemand: number;
  readonly measuredDailyCapacity: number;
  readonly ratio: number;
  readonly meets2xGate: boolean;
}

export interface CapacityGateReport {
  readonly gateId: 'surf.capacity';
  readonly legacyAlias: 'sur.capacity';
  readonly measuredDailyCapacity: number;
  readonly totalDailyDemand: number;
  readonly overallRatio: number;
  readonly baselineFullRefreshCredits: number;
  readonly tiers: ReadonlyArray<TierCapacityCheck>;
  readonly upperClassesProtected: boolean;
  readonly allTiersMeet2xGate: boolean;
}
