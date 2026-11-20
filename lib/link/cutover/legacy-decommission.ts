/**
 * UGOKI LINK v2 — Legacy Asset Decommission State Machine (§5.12 / §11.10 / store.G-20)
 *
 * Inventories EVERY legacy asset discovered in `docs/ugokilink/CRON_INVENTORY.md` and
 * enforces strict fail-closed prerequisite gates before draining, disabling (410 Gone),
 * or permanently decommissioning each asset:
 *
 * 1. `inngest_i5_external_heatmap`: External Inngest `heatmap-clickinsight` (~300 heavy CH queries/6h).
 *    Zero codebase dependencies -> explicitly eligible for IMMEDIATE safe stop (relieves 4.54 GiB CH OOM).
 * 2. `legacy_tag_v2`: Legacy v2 tracking tag on 5 owned sites.
 * 3. `worker_event_ingest`: `workers/event-ingest` (`ugokimap-event-ingest`).
 * 4. `worker_banner_runtime`: `workers/banner-runtime` (`ugokimap-banner-runtime`) + legacy Vercel KV delivery.
 * 5. `cron_c1_daily_site_summary`: Vercel Cron `GET /api/cron/daily-site-summary` (daily 02:00 JST).
 * 6. `cron_c2_deep_research`: Vercel Cron `GET /api/cron/deep-research` (every 5 minutes).
 * 7. `cron_c3_fusion_ingest`: Vercel Cron `GET /api/cron/fusion-ingest` (every 6 hours).
 * 8. `cron_c4_experiments_pool`: Vercel Cron `GET /api/experiments/pool` (daily 03:00 JST).
 * 9. `legacy_clickhouse_tables`: Legacy `events`, `session_page_fact`, and insert-time MVs
 *    (irreversible once dropped; requires all ingestion stopped + R2 cold snapshot + 30d soak `store.G-20`).
 */

import { getConstant } from '../../../packages/contract/ledgers';
import type { UnmetGate } from '../../../packages/contract/response';

const runInWindowConst = getConstant('ops.run_in_window_days')?.value;
export const LEGACY_DECOMMISSION_SOAK_DAYS =
  typeof runInWindowConst === 'number' ? runInWindowConst : 30;

export type LegacyAssetId =
  | 'inngest_i5_external_heatmap'
  | 'legacy_tag_v2'
  | 'worker_event_ingest'
  | 'worker_banner_runtime'
  | 'cron_c1_daily_site_summary'
  | 'cron_c2_deep_research'
  | 'cron_c3_fusion_ingest'
  | 'cron_c4_experiments_pool'
  | 'legacy_clickhouse_tables';

export type LegacyAssetKind =
  | 'external_inngest'
  | 'browser_tag'
  | 'cloudflare_worker'
  | 'vercel_cron'
  | 'clickhouse_schema';

export type LegacyAssetState =
  | 'active'
  | 'draining'
  | 'disabled_410'
  | 'decommissioned';

export interface LegacyAssetDefinition {
  readonly id: LegacyAssetId;
  readonly displayName: string;
  readonly kind: LegacyAssetKind;
  readonly location: string;
  readonly scheduleOrTrigger: string;
  readonly replacementStep: string;
  /** True only for zero-dependency external dead weight (`inngest_i5_external_heatmap`). */
  readonly immediateDecommissionEligible: boolean;
  /** True if asset can be rolled back to `active` even after reaching `decommissioned`. */
  readonly reversibleAfterDecommission: boolean;
  /** Recommended execution phase order (0 = immediate, 5 = final ClickHouse drop). */
  readonly recommendedPhase: number;
}

export const LEGACY_ASSETS_CATALOG: readonly LegacyAssetDefinition[] = [
  {
    id: 'inngest_i5_external_heatmap',
    displayName: 'External Inngest App (heatmap-clickinsight)',
    kind: 'external_inngest',
    location: 'https://app.inngest.com (external SaaS — 0 local repo code deps)',
    scheduleOrTrigger: 'Every 6h (~300 heavy ClickHouse queries)',
    replacementStep: 'Immediate owner pause/delete (relieves 4.54 GiB CH Code 241 OOM)',
    immediateDecommissionEligible: true,
    reversibleAfterDecommission: true,
    recommendedPhase: 0,
  },
  {
    id: 'legacy_tag_v2',
    displayName: 'Legacy v2 Tracking Tag (5 owned sites)',
    kind: 'browser_tag',
    location: 'public/v2/tracking.js & 5 site HTML embeds',
    scheduleOrTrigger: 'Browser page load',
    replacementStep: 'Step 11 parallel run -> tel.G18 ±5% convergence -> v2 LINK collector tag',
    immediateDecommissionEligible: false,
    reversibleAfterDecommission: true,
    recommendedPhase: 5,
  },
  {
    id: 'worker_event_ingest',
    displayName: 'Legacy Event Ingest Worker',
    kind: 'cloudflare_worker',
    location: 'workers/event-ingest (ugokimap-event-ingest)',
    scheduleOrTrigger: 'HTTP POST from legacy tag',
    replacementStep: 'Step 4–6 R2 WAL collector + workers/link-loader',
    immediateDecommissionEligible: false,
    reversibleAfterDecommission: true,
    recommendedPhase: 5,
  },
  {
    id: 'worker_banner_runtime',
    displayName: 'Legacy Banner Runtime Worker + Vercel KV Delivery',
    kind: 'cloudflare_worker',
    location: 'workers/banner-runtime (ugokimap-banner-runtime) + Vercel KV',
    scheduleOrTrigger: 'HTTP GET/POST banner delivery',
    replacementStep: 'Steps 18–19 new delivery runtime + strongly consistent ctl',
    immediateDecommissionEligible: false,
    reversibleAfterDecommission: true,
    recommendedPhase: 5,
  },
  {
    id: 'cron_c1_daily_site_summary',
    displayName: 'Vercel Cron C-1: daily-site-summary',
    kind: 'vercel_cron',
    location: 'GET /api/cron/daily-site-summary (vercel.json)',
    scheduleOrTrigger: '0 17 * * * (Daily 02:00 JST)',
    replacementStep: 'Step 12 5-dashboard /v1 switch + Step 17 summary artifact job',
    immediateDecommissionEligible: false,
    reversibleAfterDecommission: true,
    recommendedPhase: 5,
  },
  {
    id: 'cron_c2_deep_research',
    displayName: 'Vercel Cron C-2: deep-research',
    kind: 'vercel_cron',
    location: 'GET /api/cron/deep-research (vercel.json)',
    scheduleOrTrigger: '*/5 * * * * (Every 5 minutes)',
    replacementStep: 'Step 12 POST /v1/ask + Step 17 queued execution',
    immediateDecommissionEligible: false,
    reversibleAfterDecommission: true,
    recommendedPhase: 5,
  },
  {
    id: 'cron_c3_fusion_ingest',
    displayName: 'Vercel Cron C-3: fusion-ingest',
    kind: 'vercel_cron',
    location: 'GET /api/cron/fusion-ingest (vercel.json)',
    scheduleOrTrigger: '0 */6 * * * (Every 6 hours)',
    replacementStep: 'Step 2 single scheduler + Step 13 structural join',
    immediateDecommissionEligible: false,
    reversibleAfterDecommission: true,
    recommendedPhase: 5,
  },
  {
    id: 'cron_c4_experiments_pool',
    displayName: 'Vercel Cron C-4: experiments/pool',
    kind: 'vercel_cron',
    location: 'GET /api/experiments/pool (vercel.json)',
    scheduleOrTrigger: '0 18 * * * (Daily 03:00 JST)',
    replacementStep: 'Steps 7/20/27 unit_ledger pool (ev.G-1, ev.G-3, ev.G-10)',
    immediateDecommissionEligible: false,
    reversibleAfterDecommission: true,
    recommendedPhase: 5,
  },
  {
    id: 'legacy_clickhouse_tables',
    displayName: 'Legacy ClickHouse Tables & Insert-Time MVs',
    kind: 'clickhouse_schema',
    location: 'ClickHouse legacy events, session_page_fact, insert-time MVs',
    scheduleOrTrigger: 'Continuous storage & merge',
    replacementStep: '§5.10 legacy bridge (store.G-17) + 30d soak (store.G-20) + R2 cold snapshot',
    immediateDecommissionEligible: false,
    reversibleAfterDecommission: false,
    recommendedPhase: 6,
  },
];

export interface LegacyDecommissionEvidence {
  /** `tel.G18`: Step 11 5-site parallel run converged within ±5%. */
  readonly telG18CalibratedWithin5Pct: boolean;
  /** Step 12: all 5 internal dashboards reading `/v1` APIs with `surf.envelope` pass. */
  readonly internal5DashboardsSwitchedToV1: boolean;
  /** `store.G-17`: §5.10 strict-order legacy bridge complete & verified. */
  readonly legacyDataBridgeCompleted: boolean;
  /** `store.G-2`: post-ack loss <= 0.01% verified across soak window. */
  readonly storeG2PostAckLoss30dGreen: boolean;
  /** `store.G-7`: 3-way reconcile (ledger vs R2 vs CH) clean across soak window. */
  readonly storeG7Reconcile30dGreen: boolean;
  /** `store.G-8`: 0 OOM / Code 241 incidents on dedicated 8 GiB CH node across soak window. */
  readonly storeG8NoOom30dGreen: boolean;
  /** Consecutive incident-free days observed on the v2 store (`store.G-20` requires >= 30). */
  readonly newStoreIncidentFreeConsecutiveDays: number;
  /** Rollback drill verified on staging/owner checklist before mutating legacy production routes. */
  readonly rollbackDrillVerified: boolean;

  // Per-asset replacement gates
  /** Required before decommissioning C-1 (`daily-site-summary`). */
  readonly step17SummaryArtifactGreen?: boolean;
  /** Required before decommissioning C-2 (`deep-research`): 0 pending legacy `analysis_jobs`. */
  readonly analysisJobsPendingZero?: boolean;
  /** Required before decommissioning C-3 (`fusion-ingest`): Step 13 structural join green. */
  readonly step13StructuralJoinGreen?: boolean;
  /** Required before decommissioning C-4 (`experiments/pool`): `ev.G-10` unit_ledger pool active. */
  readonly evG10UnitLedgerPoolActive?: boolean;
  /** Required before decommissioning `worker_banner_runtime`: Steps 18–19 runtime cut over. */
  readonly step18_19DeliveryRuntimeCutoverComplete?: boolean;
  /** Required before dropping `legacy_clickhouse_tables`: verified R2 cold archive backup exists. */
  readonly coldArchiveSnapshotVerified?: boolean;
}

export interface LegacyAssetReadiness {
  readonly assetId: LegacyAssetId;
  readonly currentState: LegacyAssetState;
  readonly canTransitionForward: boolean;
  readonly storeG20Passed: boolean;
  readonly blockingPrerequisites: readonly string[];
  readonly unmetGates: readonly UnmetGate[];
}

export interface LegacyTransitionRecord {
  readonly assetId: LegacyAssetId;
  readonly fromState: LegacyAssetState;
  readonly toState: LegacyAssetState;
  readonly timestampIso: string;
  readonly kind: 'forward' | 'rollback';
  readonly note: string;
}

export interface LegacyTransitionResult {
  readonly ok: boolean;
  readonly assetId: LegacyAssetId;
  readonly previousState: LegacyAssetState;
  readonly currentState: LegacyAssetState;
  readonly reason: string;
  readonly blockingPrerequisites: readonly string[];
}

const FORWARD_TRANSITIONS: Readonly<
  Record<LegacyAssetState, readonly LegacyAssetState[]>
> = {
  active: ['draining'],
  draining: ['disabled_410'],
  disabled_410: ['decommissioned'],
  decommissioned: [],
};

function getAssetDef(assetId: LegacyAssetId): LegacyAssetDefinition {
  const def = LEGACY_ASSETS_CATALOG.find((a) => a.id === assetId);
  if (!def) {
    throw new Error(`Unknown legacy asset: ${assetId}`);
  }
  return def;
}

/**
 * Evaluates whether `store.G-20` (30 consecutive incident-free days with `store.G-2`,
 * `store.G-7`, and `store.G-8` all green) is satisfied.
 */
export function isStoreG20Satisfied(evidence: LegacyDecommissionEvidence): boolean {
  return (
    evidence.storeG2PostAckLoss30dGreen &&
    evidence.storeG7Reconcile30dGreen &&
    evidence.storeG8NoOom30dGreen &&
    evidence.newStoreIncidentFreeConsecutiveDays >= LEGACY_DECOMMISSION_SOAK_DAYS
  );
}

/**
 * Stateful, fail-closed controller for staged legacy decommission (`store.G-20`).
 */
export class LegacyDecommissionController {
  private readonly states = new Map<LegacyAssetId, LegacyAssetState>();
  private readonly history: LegacyTransitionRecord[] = [];

  constructor(
    initialStates?: Partial<Record<LegacyAssetId, LegacyAssetState>>
  ) {
    for (const asset of LEGACY_ASSETS_CATALOG) {
      this.states.set(asset.id, initialStates?.[asset.id] ?? 'active');
    }
  }

  getAssetState(assetId: LegacyAssetId): LegacyAssetState {
    return this.states.get(assetId) ?? 'active';
  }

  getAllStates(): Readonly<Record<LegacyAssetId, LegacyAssetState>> {
    const out = {} as Record<LegacyAssetId, LegacyAssetState>;
    for (const asset of LEGACY_ASSETS_CATALOG) {
      out[asset.id] = this.getAssetState(asset.id);
    }
    return out;
  }

  getTransitionLog(): readonly LegacyTransitionRecord[] {
    return [...this.history];
  }

  /**
   * Evaluates all prerequisite gates for decommissioning a specific legacy asset.
   */
  evaluateAssetReadiness(
    assetId: LegacyAssetId,
    evidence: LegacyDecommissionEvidence
  ): LegacyAssetReadiness {
    const def = getAssetDef(assetId);
    const currentState = this.getAssetState(assetId);
    const storeG20Passed = isStoreG20Satisfied(evidence);

    // Special case: External Inngest `heatmap-clickinsight` (I-5) has 0 repo dependencies
    // and is approved for immediate safe stop in CRON_INVENTORY.md.
    if (def.immediateDecommissionEligible) {
      return {
        assetId,
        currentState,
        canTransitionForward: currentState !== 'decommissioned',
        storeG20Passed,
        blockingPrerequisites: [],
        unmetGates: [],
      };
    }

    const blocking: string[] = [];
    const unmetGates: UnmetGate[] = [];

    if (!evidence.telG18CalibratedWithin5Pct) {
      blocking.push('tel.G18_parallel_run_not_converged_within_5pct');
      unmetGates.push({
        id: 'tel.G18',
        required: '5-site parallel run calibrated within ±5%',
        observed: 'not converged',
        unlock: 'Complete Step 11 5-site parallel run and verify ±5% calibration',
        reason: 'parallel_run_not_converged',
      });
    }

    if (!evidence.internal5DashboardsSwitchedToV1) {
      blocking.push('internal_5_dashboards_not_switched_to_v1');
      unmetGates.push({
        id: 'surf.internal_5_dashboards_v1',
        required: 'All 5 internal dashboards reading /v1 APIs with surf.envelope green',
        observed: 'still reading legacy paths',
        unlock: 'Cut over all 5 internal dashboards to /v1 endpoints (§11.10)',
        reason: 'dashboards_on_legacy',
      });
    }

    if (!evidence.legacyDataBridgeCompleted) {
      blocking.push('store.G-17_legacy_data_bridge_incomplete');
      unmetGates.push({
        id: 'store.G-17',
        required: '§5.10 strict-order legacy data bridge completed and verified',
        observed: 'incomplete',
        unlock: 'Run §5.10 legacy bridge (fold -> drop -> conversion rules -> strip -> reconstruct)',
        reason: 'legacy_bridge_incomplete',
      });
    }

    if (!storeG20Passed) {
      const remaining = Math.max(
        0,
        LEGACY_DECOMMISSION_SOAK_DAYS -
          Math.max(0, evidence.newStoreIncidentFreeConsecutiveDays)
      );
      const failedSubGates: string[] = [];
      if (!evidence.storeG2PostAckLoss30dGreen) failedSubGates.push('store.G-2');
      if (!evidence.storeG7Reconcile30dGreen) failedSubGates.push('store.G-7');
      if (!evidence.storeG8NoOom30dGreen) failedSubGates.push('store.G-8');
      if (evidence.newStoreIncidentFreeConsecutiveDays < LEGACY_DECOMMISSION_SOAK_DAYS) {
        failedSubGates.push(
          `soak_days=${evidence.newStoreIncidentFreeConsecutiveDays}/${LEGACY_DECOMMISSION_SOAK_DAYS}`
        );
      }
      blocking.push(`store.G-20_30d_soak_unmet(${failedSubGates.join(',')})`);
      unmetGates.push({
        id: 'store.G-20',
        required: `>= ${LEGACY_DECOMMISSION_SOAK_DAYS} consecutive incident-free days with store.G-2, store.G-7, store.G-8 green`,
        observed: failedSubGates.join(', '),
        unlock: `Complete ${remaining} remaining clean soak day(s) with store.G-2, G-7, G-8 passing`,
        reason: 'soak_30d_incomplete',
        ...(remaining > 0 ? { eta: { min_days: remaining, max_days: remaining } } : {}),
      });
    }

    if (!evidence.rollbackDrillVerified) {
      blocking.push('rollback_drill_not_verified');
      unmetGates.push({
        id: 'ops.rollback_drill',
        required: 'Verified emergency rollback procedure before mutating legacy routes',
        observed: 'not verified',
        unlock: 'Execute and record rollback drill per docs/ugokilink/CUTOVER_RUNBOOK.md',
        reason: 'rollback_drill_unverified',
      });
    }

    // Asset-specific prerequisites
    switch (assetId) {
      case 'worker_banner_runtime':
        if (!evidence.step18_19DeliveryRuntimeCutoverComplete) {
          blocking.push('step18_19_delivery_runtime_cutover_incomplete');
        }
        break;
      case 'cron_c1_daily_site_summary':
        if (!evidence.step17SummaryArtifactGreen) {
          blocking.push('step17_summary_artifact_job_not_green');
        }
        break;
      case 'cron_c2_deep_research':
        if (!evidence.analysisJobsPendingZero) {
          blocking.push('legacy_analysis_jobs_pending_nonzero');
        }
        break;
      case 'cron_c3_fusion_ingest':
        if (!evidence.step13StructuralJoinGreen) {
          blocking.push('step13_structural_join_not_green');
        }
        break;
      case 'cron_c4_experiments_pool':
        if (!evidence.evG10UnitLedgerPoolActive) {
          blocking.push('ev.G-10_unit_ledger_pool_not_active');
        }
        break;
      case 'legacy_clickhouse_tables': {
        // Cannot touch legacy ClickHouse tables while legacy writers/crons are still active
        const writerIds: LegacyAssetId[] = [
          'legacy_tag_v2',
          'worker_event_ingest',
          'cron_c1_daily_site_summary',
          'cron_c2_deep_research',
          'cron_c3_fusion_ingest',
          'cron_c4_experiments_pool',
        ];
        const activeWriters = writerIds.filter(
          (id) => this.getAssetState(id) !== 'decommissioned'
        );
        if (activeWriters.length > 0) {
          blocking.push(
            `legacy_writers_not_decommissioned(${activeWriters.join(',')})`
          );
        }
        if (!evidence.coldArchiveSnapshotVerified) {
          blocking.push('r2_cold_archive_snapshot_not_verified');
        }
        break;
      }
      case 'legacy_tag_v2':
      case 'worker_event_ingest':
        // Covered by global prerequisites above
        break;
    }

    return {
      assetId,
      currentState,
      canTransitionForward:
        currentState !== 'decommissioned' && blocking.length === 0,
      storeG20Passed,
      blockingPrerequisites: blocking,
      unmetGates,
    };
  }

  /**
   * Advances a legacy asset along the decommission state machine.
   * Refuses out-of-order jumps and fails closed when any prerequisite is unmet.
   */
  transitionAsset(
    assetId: LegacyAssetId,
    targetState: LegacyAssetState,
    evidence: LegacyDecommissionEvidence,
    nowIso: string = new Date().toISOString()
  ): LegacyTransitionResult {
    const def = getAssetDef(assetId);
    const currentState = this.getAssetState(assetId);

    if (currentState === targetState) {
      return {
        ok: false,
        assetId,
        previousState: currentState,
        currentState,
        reason: 'already_in_target_state',
        blockingPrerequisites: [],
      };
    }

    // Immediate-eligible external SaaS asset (`inngest_i5_external_heatmap`) may jump straight to decommissioned
    const allowedNext = def.immediateDecommissionEligible
      ? (['draining', 'disabled_410', 'decommissioned'] as const)
      : FORWARD_TRANSITIONS[currentState];

    if (!allowedNext.includes(targetState)) {
      return {
        ok: false,
        assetId,
        previousState: currentState,
        currentState,
        reason: `invalid_state_transition(${currentState}->${targetState})`,
        blockingPrerequisites: [],
      };
    }

    const readiness = this.evaluateAssetReadiness(assetId, evidence);
    if (!readiness.canTransitionForward) {
      return {
        ok: false,
        assetId,
        previousState: currentState,
        currentState,
        reason: 'prerequisites_not_met',
        blockingPrerequisites: readiness.blockingPrerequisites,
      };
    }

    this.states.set(assetId, targetState);
    this.history.push({
      assetId,
      fromState: currentState,
      toState: targetState,
      timestampIso: nowIso,
      kind: 'forward',
      note: `Transitioned ${assetId} from ${currentState} to ${targetState}`,
    });

    return {
      ok: true,
      assetId,
      previousState: currentState,
      currentState: targetState,
      reason: 'transitioned',
      blockingPrerequisites: [],
    };
  }

  /**
   * Emergency rollback of a legacy asset back to `'active'`.
   * Always permitted from `draining` or `disabled_410`.
   * From `decommissioned`, blocked for irreversible assets (`legacy_clickhouse_tables`)
   * where operators must instead follow the R2 cold-snapshot restore runbook.
   */
  rollbackAsset(
    assetId: LegacyAssetId,
    reason: string,
    nowIso: string = new Date().toISOString()
  ): LegacyTransitionResult {
    const def = getAssetDef(assetId);
    const currentState = this.getAssetState(assetId);

    if (currentState === 'active') {
      return {
        ok: false,
        assetId,
        previousState: currentState,
        currentState,
        reason: 'already_active',
        blockingPrerequisites: [],
      };
    }

    if (
      currentState === 'decommissioned' &&
      !def.reversibleAfterDecommission
    ) {
      return {
        ok: false,
        assetId,
        previousState: currentState,
        currentState,
        reason:
          'irreversible_asset_decommissioned_use_r2_cold_snapshot_restore',
        blockingPrerequisites: ['r2_cold_snapshot_restore_required'],
      };
    }

    this.states.set(assetId, 'active');
    this.history.push({
      assetId,
      fromState: currentState,
      toState: 'active',
      timestampIso: nowIso,
      kind: 'rollback',
      note: reason,
    });

    return {
      ok: true,
      assetId,
      previousState: currentState,
      currentState: 'active',
      reason: 'rolled_back_to_active',
      blockingPrerequisites: [],
    };
  }

  /**
   * Summarizes overall legacy decommission completion across all 9 inventoried assets.
   */
  evaluateCutoverCompletion(): {
    readonly allLegacyDecommissioned: boolean;
    readonly decommissionedCount: number;
    readonly totalAssets: number;
    readonly remainingAssets: readonly {
      readonly assetId: LegacyAssetId;
      readonly state: LegacyAssetState;
    }[];
  } {
    const remaining: { assetId: LegacyAssetId; state: LegacyAssetState }[] = [];
    let decommissionedCount = 0;

    for (const asset of LEGACY_ASSETS_CATALOG) {
      const state = this.getAssetState(asset.id);
      if (state === 'decommissioned') {
        decommissionedCount += 1;
      } else {
        remaining.push({ assetId: asset.id, state });
      }
    }

    return {
      allLegacyDecommissioned: remaining.length === 0,
      decommissionedCount,
      totalAssets: LEGACY_ASSETS_CATALOG.length,
      remainingAssets: remaining,
    };
  }
}
