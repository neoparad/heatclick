/**
 * UGOKI LINK v2 — Unified 5-Class Priority Scheduler
 *
 * Implements Master Architecture v2 §11.4, §13.2 & `surface-final.md` §7.2, §8.1:
 *   - 5 strict priority classes: `safety` > `integrity` > `identity` > `evidence` > `enrichment`
 *   - Per-class max wait time starvation guard + raw-HTML identity floor
 *   - Idempotent submit (`SHA-256(grant, plan, window, kind, targets_hash)`)
 *   - Inline (<= 50 URLs) vs bulk lane routing
 *   - Conformance-checked failover between CRAWL pool and UGOKI secondary renderer (`ugoki_br`)
 *   - Atomic credit + external-spend reservation at submit (`crawl_account` | `ugoki_ledger`)
 *   - Ed25519-signed usage receipt verification & idempotent single `crawl_passthrough` settlement
 *   - Cumulative `capacity >= 2x demand` gate evaluator (`surf.capacity`)
 */

import crypto from 'node:crypto';
import { canonicalJson, sha256Hex } from '@/packages/contract/response';
import type { LinkPayer } from '@/lib/link/linkage';
import {
  BASELINE_FULL_REFRESH_RENDER_CREDITS,
  DEFAULT_STARVATION_POLICIES,
  INLINE_LANE_MAX_URLS,
  JOB_KIND_REGISTRY,
  JOB_PRIORITY_CLASSES,
  PRIORITY_RANK,
  type CapacityGateReport,
  type CreditReservation,
  type ExecutionLane,
  type ExecutorConformance,
  type ExecutorNode,
  type JobKind,
  type JobPriorityClass,
  type PassthroughLedgerEntry,
  type PriorityDemandBreakdown,
  type ScheduledJob,
  type SignedUsageReceipt,
  type TierCapacityCheck,
} from './types';

// =========================================================================
// 1. Deterministic Key / Conformance Helpers
// =========================================================================

export function computeTargetsHash(targets: ReadonlyArray<string>): string {
  const sorted = [...targets].map((t) => t.trim()).sort();
  return sha256Hex(canonicalJson(sorted));
}

export function computeJobIdempotencyKey(params: {
  readonly grantId: string;
  readonly planId: string;
  readonly window: string;
  readonly kind: JobKind;
  readonly targetsHash: string;
}): string {
  return sha256Hex(
    canonicalJson({
      grant: params.grantId,
      plan: params.planId,
      window: params.window,
      kind: params.kind,
      targets_hash: params.targetsHash,
    })
  );
}

export function isConformanceMatch(
  actual: ExecutorConformance,
  expected: ExecutorConformance
): boolean {
  if (actual.segmenterHash !== expected.segmenterHash) return false;
  if (actual.probeBundleHash !== expected.probeBundleHash) return false;
  const aProfiles = [...actual.profileSet].sort();
  const bProfiles = [...expected.profileSet].sort();
  if (aProfiles.length !== bProfiles.length) return false;
  for (let i = 0; i < aProfiles.length; i++) {
    if (aProfiles[i] !== bProfiles[i]) return false;
  }
  return true;
}

export function signUsageReceipt(params: {
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
  readonly privateKeyPem: string;
}): SignedUsageReceipt {
  const { privateKeyPem, ...unsigned } = params;
  const signature = crypto
    .sign(null, Buffer.from(canonicalJson(unsigned), 'utf8'), privateKeyPem)
    .toString('base64url');
  return {
    ...unsigned,
    signature,
  };
}

// =========================================================================
// 2. Cumulative Capacity >= 2x Demand Gate (`surf.capacity`)
// =========================================================================

export function evaluateCapacityGate(params: {
  readonly measuredDailyCapacity: number;
  readonly demandByClass: PriorityDemandBreakdown;
  readonly baselineFullRefreshCredits?: number;
}): CapacityGateReport {
  const baseline = params.baselineFullRefreshCredits ?? BASELINE_FULL_REFRESH_RENDER_CREDITS;
  const tiers: TierCapacityCheck[] = [];
  let cumulative = 0;

  for (const tier of JOB_PRIORITY_CLASSES) {
    const tierDemand = Math.max(0, params.demandByClass[tier]);
    cumulative += tierDemand;
    const ratio = cumulative === 0 ? Infinity : params.measuredDailyCapacity / cumulative;
    tiers.push({
      tier,
      tierDemand,
      cumulativeDemand: cumulative,
      measuredDailyCapacity: params.measuredDailyCapacity,
      ratio,
      meets2xGate: cumulative === 0 ? true : params.measuredDailyCapacity >= 2 * cumulative,
    });
  }

  const totalDailyDemand = cumulative;
  const overallRatio = totalDailyDemand === 0 ? Infinity : params.measuredDailyCapacity / totalDailyDemand;
  // Upper 3 classes (`safety`, `integrity`, `identity`) must stay protected even during enrichment surge
  const upperClassesProtected = tiers
    .filter((t) => t.tier === 'safety' || t.tier === 'integrity' || t.tier === 'identity')
    .every((t) => t.meets2xGate);
  const allTiersMeet2xGate = tiers.every((t) => t.meets2xGate);

  return {
    gateId: 'surf.capacity',
    legacyAlias: 'sur.capacity',
    measuredDailyCapacity: params.measuredDailyCapacity,
    totalDailyDemand,
    overallRatio,
    baselineFullRefreshCredits: baseline,
    tiers,
    upperClassesProtected,
    allTiersMeet2xGate,
  };
}

// =========================================================================
// 3. Grant Budget Account
// =========================================================================

export interface GrantBudgetConfig {
  readonly grantId: string;
  readonly tenantId: string;
  readonly payer: LinkPayer;
  readonly monthlyCreditsCap: number;
  readonly dailyExternalSpendCapUsd: number;
}

interface GrantBudgetState extends GrantBudgetConfig {
  creditsReserved: number;
  creditsSettled: number;
  externalSpendReservedUsd: number;
  externalSpendSettledUsd: number;
}

// =========================================================================
// 4. Unified LINK Scheduler
// =========================================================================

export interface LinkSchedulerOptions {
  readonly expectedConformance: ExecutorConformance;
  readonly starvationMaxWaitMs?: Partial<Readonly<Record<JobPriorityClass, number>>>;
  /** Maximum bounded history entries retained in memory for completed jobs, settled receipts, and unmatched receipts (L-03). */
  readonly maxRetainedHistoryEntries?: number;
}

export interface SubmitJobInput {
  readonly grantId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly planId: string;
  readonly window: string;
  readonly kind: JobKind;
  readonly priorityClass?: JobPriorityClass;
  readonly targets: ReadonlyArray<string>;
  readonly knownUnchangedCount?: number;
  readonly estimatedExternalSpendUsd?: number;
  readonly allowRawHtmlFallback?: boolean;
  readonly preferredLane?: ExecutionLane;
  readonly now?: Date;
}

export type SubmitJobResult =
  | {
      readonly ok: true;
      readonly deduplicated: boolean;
      readonly job: ScheduledJob;
      readonly reservation: CreditReservation;
      readonly quote: {
        readonly estimatedCredits: number;
        readonly estimatedExternalSpendUsd: number;
        readonly lane: ExecutionLane;
        readonly priorityClass: JobPriorityClass;
      };
    }
  | {
      readonly ok: false;
      readonly httpStatus: 400 | 402 | 404;
      readonly code: string;
      readonly reason: string;
    };

export type DispatchResult =
  | {
      readonly dispatched: true;
      readonly job: ScheduledJob;
      readonly executorId: string;
      readonly executorKind: ExecutorNode['kind'];
      readonly failoverUsed: boolean;
      readonly rawHtmlFloorUsed: boolean;
      readonly promotedByStarvationGuard: boolean;
    }
  | {
      readonly dispatched: false;
      readonly reason: string;
    };

export type SettleReceiptResult =
  | {
      readonly ok: true;
      readonly idempotentReplay: boolean;
      readonly ledgerEntry: PassthroughLedgerEntry;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly reason: string;
    };

export class LinkScheduler {
  private readonly expectedConformance: ExecutorConformance;
  private readonly starvationMaxWaitMs: Record<JobPriorityClass, number>;
  private readonly maxRetainedHistoryEntries: number;

  private readonly budgets = new Map<string, GrantBudgetState>();
  private readonly executors = new Map<string, ExecutorNode>();
  private readonly jobsById = new Map<string, ScheduledJob>();
  private readonly jobIdByIdempotencyKey = new Map<string, string>();
  private readonly reservations = new Map<string, CreditReservation>();
  private readonly settledReceipts = new Map<string, PassthroughLedgerEntry>();
  private readonly unmatchedReceipts: SignedUsageReceipt[] = [];

  constructor(options: LinkSchedulerOptions) {
    this.expectedConformance = options.expectedConformance;
    this.starvationMaxWaitMs = {
      ...DEFAULT_STARVATION_POLICIES,
      ...(options.starvationMaxWaitMs ?? {}),
    };
    this.maxRetainedHistoryEntries = Math.max(16, options.maxRetainedHistoryEntries ?? 10_000);
  }

  private evictBoundedHistoryIfNeeded(): void {
    if (this.jobsById.size >= this.maxRetainedHistoryEntries) {
      for (const [jid, j] of this.jobsById.entries()) {
        if (j.state === 'completed' || j.state === 'failed') {
          this.jobsById.delete(jid);
          this.jobIdByIdempotencyKey.delete(j.idempotencyKey);
          this.reservations.delete(j.reservationId);
          break;
        }
      }
    }
    if (this.jobIdByIdempotencyKey.size >= this.maxRetainedHistoryEntries) {
      const oldestIdem = this.jobIdByIdempotencyKey.keys().next().value;
      if (oldestIdem !== undefined) {
        this.jobIdByIdempotencyKey.delete(oldestIdem);
      }
    }
    if (this.reservations.size >= this.maxRetainedHistoryEntries) {
      for (const [rid, r] of this.reservations.entries()) {
        if (r.status === 'settled') {
          this.reservations.delete(rid);
          break;
        }
      }
    }
    while (this.settledReceipts.size > this.maxRetainedHistoryEntries) {
      const oldestReceiptId = this.settledReceipts.keys().next().value;
      if (oldestReceiptId === undefined) break;
      this.settledReceipts.delete(oldestReceiptId);
    }
    while (this.unmatchedReceipts.length > this.maxRetainedHistoryEntries) {
      this.unmatchedReceipts.shift();
    }
  }

  // ---- Setup: Budgets & Executors ----

  public registerGrantBudget(config: GrantBudgetConfig): void {
    this.budgets.set(config.grantId, {
      ...config,
      creditsReserved: 0,
      creditsSettled: 0,
      externalSpendReservedUsd: 0,
      externalSpendSettledUsd: 0,
    });
  }

  public getGrantBudgetSnapshot(grantId: string): {
    readonly monthlyCreditsCap: number;
    readonly creditsReserved: number;
    readonly creditsSettled: number;
    readonly creditsAvailable: number;
    readonly dailyExternalSpendCapUsd: number;
    readonly externalSpendReservedUsd: number;
    readonly externalSpendSettledUsd: number;
  } | undefined {
    const b = this.budgets.get(grantId);
    if (!b) return undefined;
    return {
      monthlyCreditsCap: b.monthlyCreditsCap,
      creditsReserved: b.creditsReserved,
      creditsSettled: b.creditsSettled,
      creditsAvailable: Math.max(0, b.monthlyCreditsCap - b.creditsReserved - b.creditsSettled),
      dailyExternalSpendCapUsd: b.dailyExternalSpendCapUsd,
      externalSpendReservedUsd: b.externalSpendReservedUsd,
      externalSpendSettledUsd: b.externalSpendSettledUsd,
    };
  }

  public registerExecutor(executor: ExecutorNode): void {
    this.executors.set(executor.executorId, executor);
  }

  public setExecutorHealth(executorId: string, healthy: boolean): void {
    const ex = this.executors.get(executorId);
    if (ex) {
      ex.healthy = healthy;
    }
  }

  public getJob(jobId: string): ScheduledJob | undefined {
    return this.jobsById.get(jobId);
  }

  public getLedgerEntries(): ReadonlyArray<PassthroughLedgerEntry> {
    return [...this.settledReceipts.values()];
  }

  public getUnmatchedReceiptCount(): number {
    return this.unmatchedReceipts.length;
  }

  // ---- Submit with Idempotency-Key & Atomic Credit Reservation ----

  public submitJob(input: SubmitJobInput): SubmitJobResult {
    const now = input.now ?? new Date();
    const spec = JOB_KIND_REGISTRY[input.kind];
    if (!spec) {
      return { ok: false, httpStatus: 400, code: 'UNKNOWN_JOB_KIND', reason: `Unknown job kind: ${input.kind}` };
    }
    if (input.targets.length === 0) {
      return { ok: false, httpStatus: 400, code: 'EMPTY_TARGETS', reason: 'Job must specify at least 1 target' };
    }

    const budget = this.budgets.get(input.grantId);
    if (!budget || budget.tenantId !== input.tenantId) {
      return {
        ok: false,
        httpStatus: 404,
        code: 'GRANT_BUDGET_NOT_FOUND',
        reason: 'No active grant budget registered for grantId',
      };
    }

    const targetsHash = computeTargetsHash(input.targets);
    const idempotencyKey = computeJobIdempotencyKey({
      grantId: input.grantId,
      planId: input.planId,
      window: input.window,
      kind: input.kind,
      targetsHash,
    });

    // Idempotent deduplication: return existing job without double-reserving credits!
    const existingJobId = this.jobIdByIdempotencyKey.get(idempotencyKey);
    if (existingJobId) {
      const existingJob = this.jobsById.get(existingJobId)!;
      const existingRes = this.reservations.get(existingJob.reservationId)!;
      return {
        ok: true,
        deduplicated: true,
        job: existingJob,
        reservation: existingRes,
        quote: {
          estimatedCredits: existingRes.reservedCredits,
          estimatedExternalSpendUsd: existingRes.reservedExternalSpendUsd,
          lane: existingJob.lane,
          priorityClass: existingJob.priorityClass,
        },
      };
    }

    // Determine lane (inline <= 50 URLs when allowed, otherwise bulk)
    let lane: ExecutionLane;
    if (input.preferredLane && spec.allowedLanes.includes(input.preferredLane)) {
      if (input.preferredLane === 'inline' && input.targets.length > INLINE_LANE_MAX_URLS) {
        if (spec.allowedLanes.includes('bulk')) {
          lane = 'bulk';
        } else {
          return {
            ok: false,
            httpStatus: 400,
            code: 'INLINE_URL_LIMIT_EXCEEDED',
            reason: `Kind "${input.kind}" supports inline lane only (max ${INLINE_LANE_MAX_URLS} URLs, got ${input.targets.length})`,
          };
        }
      } else {
        lane = input.preferredLane;
      }
    } else if (spec.allowedLanes.includes('inline') && input.targets.length <= INLINE_LANE_MAX_URLS) {
      lane = 'inline';
    } else if (spec.allowedLanes.includes('bulk')) {
      lane = 'bulk';
    } else {
      return {
        ok: false,
        httpStatus: 400,
        code: 'INLINE_URL_LIMIT_EXCEEDED',
        reason: `Kind "${input.kind}" supports inline lane only (max ${INLINE_LANE_MAX_URLS} URLs, got ${input.targets.length})`,
      };
    }

    // Calculate credit quote (accounting for `known[]` short-circuit check rate)
    const knownCount = Math.min(Math.max(0, input.knownUnchangedCount ?? 0), input.targets.length);
    const fullCount = input.targets.length - knownCount;
    const estimatedCredits =
      fullCount * spec.creditsPerUnit + knownCount * spec.checkRateCreditsPerUnit;
    const estimatedExternalSpendUsd = Math.max(0, input.estimatedExternalSpendUsd ?? 0);

    // Atomic fail-closed budget check
    if (budget.creditsReserved + budget.creditsSettled + estimatedCredits > budget.monthlyCreditsCap) {
      return {
        ok: false,
        httpStatus: 402,
        code: 'CREDIT_CAP_EXCEEDED',
        reason: `Grant ${input.grantId} monthly credit cap (${budget.monthlyCreditsCap}) exceeded`,
      };
    }
    if (
      budget.externalSpendReservedUsd + budget.externalSpendSettledUsd + estimatedExternalSpendUsd >
      budget.dailyExternalSpendCapUsd
    ) {
      return {
        ok: false,
        httpStatus: 402,
        code: 'EXTERNAL_SPEND_CAP_EXCEEDED',
        reason: `Grant ${input.grantId} daily external spend cap ($${budget.dailyExternalSpendCapUsd}) exceeded`,
      };
    }

    const priorityClass = input.priorityClass ?? spec.defaultPriority;
    const jobId = `job_${crypto.randomBytes(8).toString('hex')}`;
    const reservationId = `rsv_${crypto.randomBytes(8).toString('hex')}`;
    const scheduleHash = sha256Hex(
      canonicalJson({
        idempotencyKey,
        priorityClass,
        lane,
        conformance: this.expectedConformance,
        estimatedCredits,
      })
    );

    // Reserve budget atomically
    budget.creditsReserved += estimatedCredits;
    budget.externalSpendReservedUsd += estimatedExternalSpendUsd;

    const reservation: CreditReservation = {
      reservationId,
      jobId,
      grantId: input.grantId,
      tenantId: input.tenantId,
      payer: budget.payer,
      reservedCredits: estimatedCredits,
      reservedExternalSpendUsd: estimatedExternalSpendUsd,
      status: 'reserved',
      createdAt: now.toISOString(),
    };

    const job: ScheduledJob = {
      jobId,
      idempotencyKey,
      grantId: input.grantId,
      tenantId: input.tenantId,
      siteId: input.siteId,
      planId: input.planId,
      window: input.window,
      kind: input.kind,
      priorityClass,
      lane,
      targets: [...input.targets],
      targetsHash,
      knownUnchangedCount: knownCount,
      payer: budget.payer,
      allowRawHtmlFallback: input.allowRawHtmlFallback ?? spec.supportsRawHtmlIdentityFloor,
      reservationId,
      scheduleHash,
      state: 'queued',
      submittedAt: now.toISOString(),
    };

    this.evictBoundedHistoryIfNeeded();
    this.reservations.set(reservationId, reservation);
    this.jobsById.set(jobId, job);
    this.jobIdByIdempotencyKey.set(idempotencyKey, jobId);

    return {
      ok: true,
      deduplicated: false,
      job,
      reservation,
      quote: {
        estimatedCredits,
        estimatedExternalSpendUsd,
        lane,
        priorityClass,
      },
    };
  }

  // ---- Dispatch Next Job (5-Class Priority + Starvation Guard + Conformance Failover) ----

  public dispatchNext(now: Date = new Date()): DispatchResult {
    const queued = [...this.jobsById.values()].filter((j) => j.state === 'queued');
    if (queued.length === 0) {
      return { dispatched: false, reason: 'QUEUE_EMPTY' };
    }

    const nowMs = now.getTime();

    // Order candidates:
    //   1. `safety` ALWAYS runs first (never delayed by lower-class starvation promotions).
    //   2. Among non-safety jobs, check starvation guard: any job whose wait >= class maxWaitMs
    //      is promoted ahead of non-starved jobs (ordered by highest overdue ratio, then priority).
    //   3. Otherwise strict 5-class priority rank (safety < integrity < identity < evidence < enrichment),
    //      then FIFO by `submittedAt`.
    const scored = queued.map((job) => {
      const waitMs = Math.max(0, nowMs - new Date(job.submittedAt).getTime());
      const maxWait = this.starvationMaxWaitMs[job.priorityClass];
      const starved = job.priorityClass !== 'safety' && waitMs >= maxWait;
      const overdueRatio = maxWait > 0 ? waitMs / maxWait : 0;
      return { job, waitMs, starved, overdueRatio };
    });

    scored.sort((a, b) => {
      const aSafety = a.job.priorityClass === 'safety';
      const bSafety = b.job.priorityClass === 'safety';
      if (aSafety !== bSafety) return aSafety ? -1 : 1;

      if (a.starved !== b.starved) return a.starved ? -1 : 1;
      if (a.starved && b.starved && a.overdueRatio !== b.overdueRatio) {
        return b.overdueRatio - a.overdueRatio;
      }

      const rankDiff = PRIORITY_RANK[a.job.priorityClass] - PRIORITY_RANK[b.job.priorityClass];
      if (rankDiff !== 0) return rankDiff;

      return new Date(a.job.submittedAt).getTime() - new Date(b.job.submittedAt).getTime();
    });

    // Try each candidate in strict priority order to find an eligible conformant executor
    for (const candidate of scored) {
      const pick = this.selectExecutorForJob(candidate.job);
      if (!pick) {
        continue;
      }

      pick.executor.currentInFlight += 1;
      candidate.job.state = 'dispatched';
      candidate.job.dispatchedAt = now.toISOString();
      candidate.job.assignedExecutorId = pick.executor.executorId;
      candidate.job.assignedExecutorKind = pick.executor.kind;
      candidate.job.promotedByStarvationGuard = candidate.starved;
      candidate.job.usedRawHtmlFloor = pick.rawHtmlFloorUsed;

      return {
        dispatched: true,
        job: candidate.job,
        executorId: pick.executor.executorId,
        executorKind: pick.executor.kind,
        failoverUsed: pick.failoverUsed,
        rawHtmlFloorUsed: pick.rawHtmlFloorUsed,
        promotedByStarvationGuard: candidate.starved,
      };
    }

    return {
      dispatched: false,
      reason: 'NO_CONFORMANT_OR_AVAILABLE_EXECUTOR',
    };
  }

  private selectExecutorForJob(job: ScheduledJob): {
    readonly executor: ExecutorNode;
    readonly failoverUsed: boolean;
    readonly rawHtmlFloorUsed: boolean;
  } | null {
    const spec = JOB_KIND_REGISTRY[job.kind];
    const all = [...this.executors.values()];

    const isEligible = (ex: ExecutorNode, kindAllowed: boolean): boolean => {
      if (!kindAllowed) return false;
      if (!ex.healthy) return false;
      if (ex.currentInFlight >= ex.maxConcurrency) return false;
      if (!ex.supportedJobKinds.includes(job.kind)) return false;
      if (spec.requiresBrowserConformance && ex.kind !== 'raw_html_floor') {
        if (!isConformanceMatch(ex.conformance, this.expectedConformance)) {
          return false;
        }
      }
      return true;
    };

    // Primary order: prefer `crawl_pool` (or `vault_holder` for apply/revisions)
    const primaryKind = spec.supportedExecutors[0];
    const primary = all.find((ex) => ex.kind === primaryKind && isEligible(ex, true));
    if (primary) {
      return { executor: primary, failoverUsed: false, rawHtmlFloorUsed: false };
    }

    // Secondary failover: e.g. `ugoki_br` or `ugoki_http` (strictly conformance-verified!)
    for (const fallbackKind of spec.supportedExecutors.slice(1)) {
      if (fallbackKind === 'raw_html_floor') continue;
      const secondary = all.find((ex) => ex.kind === fallbackKind && isEligible(ex, true));
      if (secondary) {
        return { executor: secondary, failoverUsed: true, rawHtmlFloorUsed: false };
      }
    }

    // Raw-HTML identity floor when browser renderers are saturated (`identity` class protection)
    if (
      spec.supportsRawHtmlIdentityFloor &&
      job.allowRawHtmlFallback &&
      (job.priorityClass === 'identity' || job.priorityClass === 'safety')
    ) {
      const rawFloor = all.find(
        (ex) =>
          ex.kind === 'raw_html_floor' &&
          ex.healthy &&
          ex.currentInFlight < ex.maxConcurrency &&
          ex.supportedJobKinds.includes(job.kind) &&
          ex.conformance.segmenterHash === this.expectedConformance.segmenterHash
      );
      if (rawFloor) {
        return { executor: rawFloor, failoverUsed: true, rawHtmlFloorUsed: true };
      }
    }

    return null;
  }

  // ---- Ed25519-Signed Receipt Verification & Idempotent `crawl_passthrough` Settlement ----

  public settleUsageReceipt(
    receipt: SignedUsageReceipt,
    now: Date = new Date()
  ): SettleReceiptResult {
    // 1. Idempotent replay check
    const alreadySettled = this.settledReceipts.get(receipt.receiptId);
    if (alreadySettled) {
      return { ok: true, idempotentReplay: true, ledgerEntry: alreadySettled };
    }

    // 2. Verify job & executor exist (never allow unmatched receipts into ledger!)
    const job = this.jobsById.get(receipt.jobId);
    const executor = this.executors.get(receipt.executorId);
    if (!job || !executor || job.grantId !== receipt.grantId) {
      this.unmatchedReceipts.push(receipt);
      this.evictBoundedHistoryIfNeeded();
      return {
        ok: false,
        code: 'UNMATCHED_RECEIPT',
        reason: `Receipt ${receipt.receiptId} does not match a known job/grant/executor`,
      };
    }

    // 3. Verify Ed25519 signature over canonical receipt payload
    const { signature, ...unsigned } = receipt;
    let sigOk = false;
    try {
      sigOk =
        executor.signerKid === receipt.signerKid &&
        crypto.verify(
          null,
          Buffer.from(canonicalJson(unsigned), 'utf8'),
          executor.publicKeyPem,
          Buffer.from(signature, 'base64url')
        );
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      return {
        ok: false,
        code: 'INVALID_RECEIPT_SIGNATURE',
        reason: `Ed25519 verification failed for receipt ${receipt.receiptId}`,
      };
    }

    // 4. Verify schedule_hash binding
    if (receipt.scheduleHash !== job.scheduleHash) {
      return {
        ok: false,
        code: 'SCHEDULE_HASH_MISMATCH',
        reason: 'Receipt schedule_hash does not match dispatched job schedule_hash',
      };
    }

    const reservation = this.reservations.get(job.reservationId);
    const budget = this.budgets.get(job.grantId);
    if (!reservation || !budget) {
      return { ok: false, code: 'RESERVATION_MISSING', reason: 'Reservation or budget record missing' };
    }

    // Prevent double-settlement via different receiptId for the same job
    if (reservation.status === 'settled') {
      return {
        ok: false,
        code: 'JOB_ALREADY_SETTLED',
        reason: `Job ${job.jobId} reservation is already settled under a previous receipt`,
      };
    }

    // 5. Release reservation and settle exact usage onto single `crawl_passthrough` line
    budget.creditsReserved = Math.max(0, budget.creditsReserved - reservation.reservedCredits);
    budget.externalSpendReservedUsd = Math.max(
      0,
      budget.externalSpendReservedUsd - reservation.reservedExternalSpendUsd
    );

    budget.creditsSettled += receipt.credits;
    budget.externalSpendSettledUsd += receipt.externalSpendUsd;

    const creditsReleased = Math.max(0, reservation.reservedCredits - receipt.credits);
    const settledAt = now.toISOString();

    reservation.status = 'settled';
    reservation.settledAt = settledAt;

    job.state = 'completed';
    job.completedAt = settledAt;
    if (executor.currentInFlight > 0) {
      executor.currentInFlight -= 1;
    }

    const ledgerEntry: PassthroughLedgerEntry = {
      ledgerEntryId: `ldg_${crypto.randomBytes(8).toString('hex')}`,
      lineType: 'crawl_passthrough',
      receiptId: receipt.receiptId,
      jobId: job.jobId,
      grantId: job.grantId,
      tenantId: job.tenantId,
      payer: job.payer,
      kind: receipt.kind,
      units: receipt.units,
      creditsCharged: receipt.credits,
      creditsReleased,
      externalSpendUsd: receipt.externalSpendUsd,
      scheduleHash: receipt.scheduleHash,
      settledAt,
    };

    this.settledReceipts.set(receipt.receiptId, ledgerEntry);
    this.evictBoundedHistoryIfNeeded();
    return { ok: true, idempotentReplay: false, ledgerEntry };
  }

  /**
   * Computes measured daily render capacity across all healthy conformant executors
   * and evaluates the cumulative `capacity >= 2x demand` gate (`surf.capacity`).
   */
  public evaluateFleetCapacityGate(demandByClass: PriorityDemandBreakdown): CapacityGateReport {
    let measuredDailyCapacity = 0;
    for (const ex of this.executors.values()) {
      if (
        ex.healthy &&
        ex.kind !== 'raw_html_floor' &&
        isConformanceMatch(ex.conformance, this.expectedConformance)
      ) {
        measuredDailyCapacity += ex.dailyRenderCapacity;
      }
    }
    return evaluateCapacityGate({
      measuredDailyCapacity,
      demandByClass,
    });
  }
}
