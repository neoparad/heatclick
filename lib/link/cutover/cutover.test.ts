import {
  LEGACY_ASSETS_CATALOG,
  LegacyDecommissionController,
  assignQueueShard,
  calculateQueueShardPlan,
  evaluateDirectPathShadowGate,
  evaluateReplicaAdditionConditions,
  type DirectPathShadowDayRecord,
  type LegacyDecommissionEvidence,
  type MaintenanceLaneDayUtilization,
} from './index';

function buildShadowDays(
  count: number,
  overrideAtIndex?: {
    index: number;
    patch: Partial<DirectPathShadowDayRecord>;
  }
): DirectPathShadowDayRecord[] {
  const startMs = Date.UTC(2026, 9, 1); // 2026-10-01
  return Array.from({ length: count }, (_, idx) => {
    const dayUtc = new Date(startMs + idx * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const base: DirectPathShadowDayRecord = {
      dayUtc,
      ledgeredFrames: 120_000,
      queueIngestedFrames: 120_000,
      directR2IngestedFrames: 120_000,
      contentHashMatch: true,
      rollP95Sec: 28,
    };
    if (overrideAtIndex && overrideAtIndex.index === idx) {
      return { ...base, ...overrideAtIndex.patch };
    }
    return base;
  });
}

function buildMaintenanceDays(
  pcts: readonly number[]
): MaintenanceLaneDayUtilization[] {
  const startMs = Date.UTC(2026, 9, 1);
  return pcts.map((utilizationPct, idx) => ({
    dayUtc: new Date(startMs + idx * 86_400_000).toISOString().slice(0, 10),
    utilizationPct,
  }));
}

function fullPassingEvidence(
  overrides: Partial<LegacyDecommissionEvidence> = {}
): LegacyDecommissionEvidence {
  return {
    telG18CalibratedWithin5Pct: true,
    internal5DashboardsSwitchedToV1: true,
    legacyDataBridgeCompleted: true,
    storeG2PostAckLoss30dGreen: true,
    storeG7Reconcile30dGreen: true,
    storeG8NoOom30dGreen: true,
    newStoreIncidentFreeConsecutiveDays: 30,
    rollbackDrillVerified: true,
    step17SummaryArtifactGreen: true,
    analysisJobsPendingZero: true,
    step13StructuralJoinGreen: true,
    evG10UnitLedgerPoolActive: true,
    step18_19DeliveryRuntimeCutoverComplete: true,
    coldArchiveSnapshotVerified: true,
    ...overrides,
  };
}

describe('lib/link/cutover/direct-path-shadow (§5.11 / store.G-14)', () => {
  test('requires 30 consecutive clean shadow days with 100% completeness, hash match, and rollP95 <= 60s', () => {
    // 29 clean days -> blocked
    const day29 = evaluateDirectPathShadowGate(buildShadowDays(29));
    expect(day29.canCutoverToDirectPath).toBe(false);
    expect(day29.consecutivePassingDays).toBe(29);
    expect(day29.unmetGate?.id).toBe('store.G-14');

    // Hash mismatch on day 20 breaks streak -> trailing streak is only 10 days -> blocked
    const hashMismatch = evaluateDirectPathShadowGate(
      buildShadowDays(30, { index: 19, patch: { contentHashMatch: false } })
    );
    expect(hashMismatch.canCutoverToDirectPath).toBe(false);
    expect(hashMismatch.consecutivePassingDays).toBe(10);
    expect(hashMismatch.failedDays[0]?.reasons).toContain('content_hash_mismatch');

    // rollP95 > 60s breaks streak -> blocked
    const slowRoll = evaluateDirectPathShadowGate(
      buildShadowDays(30, { index: 25, patch: { rollP95Sec: 61 } })
    );
    expect(slowRoll.canCutoverToDirectPath).toBe(false);
    expect(slowRoll.consecutivePassingDays).toBe(4);
    expect(slowRoll.maxObservedRollP95Sec).toBe(61);

    // 30 consecutive clean days -> unlocked
    const day30 = evaluateDirectPathShadowGate(buildShadowDays(30));
    expect(day30.canCutoverToDirectPath).toBe(true);
    expect(day30.consecutivePassingDays).toBe(30);
    expect(day30.failedDays).toHaveLength(0);
    expect(day30.unmetGate).toBeUndefined();
  });

  test('1000x × 10x burst (5,050 msg/s > 5,000) triggers multi-shard plan with deterministic routing', () => {
    const plan1000x = calculateQueueShardPlan({
      baselineMsgPerSec: 0.505,
      scaleMultiplier: 1000,
      peakBurstMultiplier: 10,
    });
    expect(plan1000x.peakMsgPerSec).toBe(5050);
    expect(plan1000x.exceedsSingleQueue).toBe(true);
    expect(plan1000x.recommendedShardCount).toBe(2);
    expect(plan1000x.monthlyCostReference.queueMonthlyUsd).toBe(1575);
    expect(plan1000x.monthlyCostReference.directR2MonthlyUsd).toBe(204);

    // Deterministic shard routing
    const a1 = assignQueueShard('tenant_alpha', 'site_01', 4);
    const a2 = assignQueueShard('tenant_alpha', 'site_01', 4);
    expect(a1.shardIndex).toBe(a2.shardIndex);
    expect(a1.shardName).toBe(`link-ingest-shard-${a1.shardIndex}`);
    expect(a1.shardIndex).toBeGreaterThanOrEqual(0);
    expect(a1.shardIndex).toBeLessThan(4);
  });

  test('evaluates all three §5.11 replica addition conditions independently', () => {
    // Baseline: none triggered
    const none = evaluateReplicaAdditionConditions({
      measuredRtoSec: 900,
      maxAutonomousWatchdogIntervalSec: 1800,
      maintenanceUtilizationHistory: buildMaintenanceDays([40, 55, 60, 52, 58, 55, 51]), // 6 consecutive >50%
      publishedAvailabilityTarget: 0.999, // 2592s monthly budget
    });
    expect(none.replicaRequired).toBe(false);
    expect(none.condition1Triggered).toBe(false);
    expect(none.condition2Triggered).toBe(false);
    expect(none.condition3Triggered).toBe(false);
    expect(none.replicaProvisioningSatisfied).toBe(true);

    // Condition ①: RTO > watchdog
    const cond1 = evaluateReplicaAdditionConditions({
      measuredRtoSec: 2000,
      maxAutonomousWatchdogIntervalSec: 1800,
      maintenanceUtilizationHistory: buildMaintenanceDays([20, 25, 30]),
      publishedAvailabilityTarget: 0.999,
    });
    expect(cond1.condition1Triggered).toBe(true);
    expect(cond1.replicaRequired).toBe(true);
    expect(cond1.replicaProvisioningSatisfied).toBe(false);

    // Condition ②: maintenance lane >50% for 7 consecutive days
    const cond2 = evaluateReplicaAdditionConditions({
      measuredRtoSec: 600,
      maxAutonomousWatchdogIntervalSec: 1800,
      maintenanceUtilizationHistory: buildMaintenanceDays([55, 60, 52, 58, 55, 51, 63]),
      publishedAvailabilityTarget: 0.999,
    });
    expect(cond2.condition2Triggered).toBe(true);
    expect(cond2.maxConsecutiveMaintenanceOver50Days).toBe(7);
    expect(cond2.replicaRequired).toBe(true);

    // Condition ③: RTO >= error budget (99.95% => 1296s)
    const cond3 = evaluateReplicaAdditionConditions({
      measuredRtoSec: 1500,
      maxAutonomousWatchdogIntervalSec: 1800,
      maintenanceUtilizationHistory: buildMaintenanceDays([20, 20]),
      publishedAvailabilityTarget: 0.9995,
      replicaAlreadyProvisioned: true,
    });
    expect(cond3.condition3Triggered).toBe(true);
    expect(cond3.availabilityErrorBudgetSec).toBe(1296);
    expect(cond3.replicaRequired).toBe(true);
    expect(cond3.replicaProvisioningSatisfied).toBe(true);
  });
});

describe('lib/link/cutover/legacy-decommission (CRON_INVENTORY.md / store.G-20)', () => {
  test('catalogs all 9 legacy assets, allows immediate stop of Inngest I-5, and blocks all others until prerequisites pass', () => {
    expect(LEGACY_ASSETS_CATALOG).toHaveLength(9);

    const controller = new LegacyDecommissionController();
    const incomplete = fullPassingEvidence({
      telG18CalibratedWithin5Pct: false,
      internal5DashboardsSwitchedToV1: false,
      newStoreIncidentFreeConsecutiveDays: 12,
    });

    // External Inngest heatmap-clickinsight (I-5) IS immediately eligible
    const i5Stop = controller.transitionAsset(
      'inngest_i5_external_heatmap',
      'decommissioned',
      incomplete,
      '2026-11-20T12:00:00Z'
    );
    expect(i5Stop.ok).toBe(true);
    expect(controller.getAssetState('inngest_i5_external_heatmap')).toBe(
      'decommissioned'
    );

    // Every other legacy asset is blocked fail-closed
    const workerAttempt = controller.transitionAsset(
      'worker_event_ingest',
      'draining',
      incomplete
    );
    expect(workerAttempt.ok).toBe(false);
    expect(workerAttempt.reason).toBe('prerequisites_not_met');
    expect(workerAttempt.blockingPrerequisites).toContain(
      'tel.G18_parallel_run_not_converged_within_5pct'
    );
    expect(workerAttempt.blockingPrerequisites).toContain(
      'internal_5_dashboards_not_switched_to_v1'
    );
    expect(
      workerAttempt.blockingPrerequisites.some((b) => b.startsWith('store.G-20'))
    ).toBe(true);
  });

  test('executes staged active -> draining -> disabled_410 -> decommissioned, enforces rollback, and protects legacy ClickHouse until writers stop', () => {
    const controller = new LegacyDecommissionController();
    const okEvidence = fullPassingEvidence();

    // Cannot skip directly from active -> decommissioned on regular assets
    const illegalJump = controller.transitionAsset(
      'cron_c2_deep_research',
      'decommissioned',
      okEvidence
    );
    expect(illegalJump.ok).toBe(false);
    expect(illegalJump.reason).toContain('invalid_state_transition');

    // Staged drain + emergency rollback test on worker_banner_runtime
    expect(
      controller.transitionAsset('worker_banner_runtime', 'draining', okEvidence).ok
    ).toBe(true);
    expect(
      controller.transitionAsset('worker_banner_runtime', 'disabled_410', okEvidence).ok
    ).toBe(true);
    const rb = controller.rollbackAsset(
      'worker_banner_runtime',
      'Elevated error rate observed during canary drain'
    );
    expect(rb.ok).toBe(true);
    expect(controller.getAssetState('worker_banner_runtime')).toBe('active');

    // Legacy ClickHouse tables CANNOT start draining while legacy writers are still active
    const chEarly = controller.transitionAsset(
      'legacy_clickhouse_tables',
      'draining',
      okEvidence
    );
    expect(chEarly.ok).toBe(false);
    expect(
      chEarly.blockingPrerequisites.some((b) =>
        b.startsWith('legacy_writers_not_decommissioned')
      )
    ).toBe(true);

    // Decommission all non-CH assets cleanly
    expect(
      controller.transitionAsset('inngest_i5_external_heatmap', 'decommissioned', okEvidence).ok
    ).toBe(true);

    const stagedIds = [
      'legacy_tag_v2',
      'worker_event_ingest',
      'worker_banner_runtime',
      'cron_c1_daily_site_summary',
      'cron_c2_deep_research',
      'cron_c3_fusion_ingest',
      'cron_c4_experiments_pool',
    ] as const;

    for (const id of stagedIds) {
      expect(controller.transitionAsset(id, 'draining', okEvidence).ok).toBe(true);
      expect(controller.transitionAsset(id, 'disabled_410', okEvidence).ok).toBe(true);
      expect(controller.transitionAsset(id, 'decommissioned', okEvidence).ok).toBe(true);
    }

    // Now legacy ClickHouse tables can be drained and decommissioned
    expect(
      controller.transitionAsset('legacy_clickhouse_tables', 'draining', okEvidence).ok
    ).toBe(true);
    expect(
      controller.transitionAsset('legacy_clickhouse_tables', 'disabled_410', okEvidence).ok
    ).toBe(true);
    expect(
      controller.transitionAsset('legacy_clickhouse_tables', 'decommissioned', okEvidence).ok
    ).toBe(true);

    // Irreversible ClickHouse drop cannot use in-place rollback
    const chRollback = controller.rollbackAsset(
      'legacy_clickhouse_tables',
      'Attempted revert after DROP'
    );
    expect(chRollback.ok).toBe(false);
    expect(chRollback.reason).toContain('r2_cold_snapshot_restore');

    const summary = controller.evaluateCutoverCompletion();
    expect(summary.allLegacyDecommissioned).toBe(true);
    expect(summary.decommissionedCount).toBe(9);
  });
});
