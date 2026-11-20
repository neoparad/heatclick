# UGOKI LINK v2 — Production Cutover & Legacy Decommission Runbook

> **Execution Authority**: Owner-only (`docs/proposals/2026-11-19-ugokilink-master-architecture-v2.md` §2 / §5.10–§5.12 / §11.10).
> AI agents NEVER execute production deploys, ClickHouse DDL, Vercel Cron removals, or secret rotations.
> Every gate below is backed by executable code in `lib/link/cutover/`, `lib/link/migration/`, `lib/link/oem/`, and `lib/link/residency/`.

---

## 0. Master Prerequisite & Gate Matrix

Do **NOT** proceed to Phase 5 (legacy decommission) until every mandatory gate below is **PASS**:

| Gate ID | Requirement | Verification Module | Status Check |
| :--- | :--- | :--- | :--- |
| `tel.G17` | 11-class loss ledger active across all 5 owned sites (`L1`–`L11`) | `lib/link/migration/loss-ledger.ts` | 0 unclassified loss buckets |
| `tel.G18` | Step 11 5-site parallel run converged within **±5%** on PV, sessions, clicks, and conversions | `lib/link/migration/calibration.ts` | `evaluateCalibrationGate()` PASS on all 5 sites |
| `store.G-2` | Post-ack loss **≤ 0.01%** (95% upper bound) for **30 consecutive UTC days** | `workers/link-wal/`, `lib/link/store/` | `storeG2PostAckLoss30dGreen === true` |
| `store.G-7` | 3-way reconcile (Collector Ledger ↔ R2 WAL ↔ ClickHouse) exact match for **30 consecutive UTC days** | `lib/link/store/reconcile.ts` | `storeG7Reconcile30dGreen === true` |
| `store.G-8` | **0 OOM / Code 241** incidents on dedicated 8 GiB ClickHouse node for **30 consecutive UTC days** | Dedicated CH metrics + `lib/link/store/` | `storeG8NoOom30dGreen === true` |
| `store.G-14` | Direct R2 shadow write matches Queue path 100% (count + content hash) with `rollP95Sec <= 60s` for **30 consecutive UTC days** | `lib/link/cutover/direct-path-shadow.ts` | `evaluateDirectPathShadowGate().canCutoverToDirectPath === true` |
| `store.G-17` | §5.10 legacy data bridge completed in strict irreversible order | `lib/link/migration/legacy-bridge.ts` | `legacyDataBridgeCompleted === true` |
| `store.G-20` | All 9 legacy assets cleanly drained, 410-disabled, and decommissioned after 30d soak | `lib/link/cutover/legacy-decommission.ts` | `controller.evaluateCutoverCompletion().allLegacyDecommissioned === true` |
| `surf.G1`–`surf.G4` | Tenant isolation 4 gates + 404 Matrix + 30d 2-tenant canary (required before admitting external tenants) | `lib/link/isolation/`, `lib/link/oem/external-tenant-gate.ts` | `evaluateExternalTenantReadiness().readyToAdmitExternalTenants === true` |

---

## Phase 0 — Immediate Zero-Risk Relief (External Inngest `I-5`)

**Target**: External Inngest app `heatmap-clickinsight` (`warm-heatmap-cache`, ~300 heavy ClickHouse queries every 6h; documented in `docs/ugokilink/CRON_INVENTORY.md` §2.2).
**Why immediate**: Zero code references exist in `ugokimap-saas` (`app/api/inngest` does not exist), and stopping it immediately relieves OOM (Code 241) pressure on the legacy 4.54 GiB ClickHouse node.

1. Log in to `https://app.inngest.com` as owner.
2. Locate the legacy app **`heatmap-clickinsight`**.
3. Pause all scheduled functions (verify `warm-heatmap-cache` stops firing) and wait 12 hours to confirm zero regressions on any of the 5 owned sites.
4. Delete the `heatmap-clickinsight` app in Inngest.
5. Record transition `inngest_i5_external_heatmap: active -> decommissioned` in `LegacyDecommissionController`.

---

## Phase 1 — Step 11 Parallel Run & `tel.G18` ±5% Convergence

**Goal**: Run the UGOKI LINK v2 tag and collector **alongside** the legacy v2 tag on all 5 owned sites without altering legacy production ingestion or dashboards.

1. Verify dedicated 8 GiB ClickHouse node is provisioned (`migrations/link/` applied; never write v2 tables onto the legacy 4.54 GiB server).
2. Deploy `workers/link-wal`, `workers/link-loader`, and `workers/link-live` to Cloudflare Workers (`ap-northeast-1` / JP storage pin verified via `lib/link/residency/residency-auditor.ts`).
3. Enable parallel v2 tag injection on the 5 owned sites (`lib/link/migration/parallel-run.ts` — keeps legacy `public/v2/tracking.js` intact).
4. Run daily 11-class loss ledger (`L1`–`L11`) and legacy-vs-v2 reconciliation (`lib/link/migration/calibration.ts`).
5. **Exit Criterion (`tel.G18`)**:
   - All 5 sites show legacy vs v2 variance within **±5%** on PV, sessions, clicks, and conversions after accounting for documented loss classes (`L1`–`L11`).
   - Do **not** remove legacy tags yet.

---

## Phase 2 — Direct R2 Shadow Path (`store.G-14`), Queue Sharding & §5.11 Replica Check

**Goal**: Validate the Direct R2 (`Pipelines`) path in shadow mode before eliminating Cloudflare Queues overhead, and verify scaling / replica triggers.

1. Enable shadow writes from the collector to Direct R2 while keeping Cloudflare Queues as the authoritative ingestion path.
2. Record daily parity metrics (`ledgeredFrames`, `queueIngestedFrames`, `directR2IngestedFrames`, `contentHashMatch`, `rollP95Sec`) into `evaluateDirectPathShadowGate()`.
3. **Cutover Criterion (`store.G-14`)**:
   - **30 consecutive UTC calendar days** with `countDiff === 0`, `contentHashMatch === true`, and `rollP95Sec <= 60s`.
   - Any single-day mismatch or `rollP95Sec > 60s` resets the 30-day streak to 0.
4. **Queue Sharding Check (§5.11)**:
   - Run `calculateQueueShardPlan({ scaleMultiplier, peakBurstMultiplier })`.
   - At 1000× scale with 10× burst (`5,050 msg/s > 5,000 msg/s` per-queue limit), provision `>= 2` shards (`link-ingest-shard-0`, `link-ingest-shard-1`, …) routed deterministically via `assignQueueShard(tenantId, siteId, shardCount)` until Direct R2 cutover completes.
5. **ClickHouse Read-Replica 3-Condition Check (§5.11)**:
   - Run `evaluateReplicaAdditionConditions(...)` monthly and before Step 29 external tenant launch:
     - **Condition ①**: `measuredRtoSec > maxAutonomousWatchdogIntervalSec`
     - **Condition ②**: Maintenance lane (builder + deletion) utilization `> 50%` for `>= 7` consecutive UTC days
     - **Condition ③**: `measuredRtoSec >= publishedAvailabilityErrorBudgetSec`
   - If **any one** condition triggers, provision a warm ClickHouse read replica before proceeding.

---

## Phase 3 — Internal 5 Dashboards Cutover to `/v1` APIs (§11.10)

**Goal**: Switch all 5 internal dashboards from legacy ClickHouse / Supabase queries to `/v1/*` APIs backed by the v2 store.

1. Verify `surf.envelope` contract tests pass for all `/v1/*` endpoints (including `residency` block from `lib/link/residency/residency-auditor.ts`).
2. Cut over each of the 5 internal dashboards one by one (canary site first, then remaining 4 owned sites):
   - Overview / Pageviews & Sessions → `/v1/metrics` + `/v1/live`
   - Heatmaps / Structural Join → `/v1/heatmaps` (with `join.drift_g_max <= 0.08`)
   - AI Ask / Deep Research → `POST /v1/ask` (queued execution; replaces Cron C-2)
   - Experiments / Evidence → `/v1/experiments` (backed by `unit_ledger`; replaces Cron C-4)
   - Daily Summary / Executive Digest → Step 17 summary artifact endpoint (replaces Cron C-1)
3. Verify zero legacy API calls remain in browser Network tab and Vercel logs for 72 hours.
4. Record `internal5DashboardsSwitchedToV1 = true`.

---

## Phase 4 — §5.10 Legacy Data Bridge (`store.G-17`)

**Goal**: Migrate required historical data from the legacy ClickHouse cluster into the dedicated 8 GiB v2 ClickHouse cluster in the **strict irreversible order** mandated by §5.10 (`lib/link/migration/legacy-bridge.ts`).

> **CRITICAL ORDER WARNING**: Never reorder Steps 1–5 below. Running conversion rules after stripping click strings permanently destroys attribution; skipping `k = 50` rare-value folding leaks PII into v2 historical tables.

1. Export a verified immutable **cold archive snapshot** of legacy `events` and `session_page_fact` to R2 (`coldArchiveSnapshotVerified = true`).
2. Execute `lib/link/migration/legacy-bridge.ts` pipeline in strict order:
   1. **Fold rare values (`k = 50`)** on high-cardinality dimensions.
   2. **Drop** prohibited raw fields (`IP`, raw `UA`, raw cookies).
   3. **Apply conversion rules on click strings** (`gclid`, `fbclid`, `utm_*`, etc.) while click strings still exist.
   4. **Strip click strings** irreversibly after conversion flags are materialized.
   5. **Reconstruct** v2 canonical fact rows and load into dedicated 8 GiB ClickHouse via the single maintenance lane (`768 MiB` memory ceiling).
3. Verify row counts, conversion totals, and zero prohibited PII columns (`store.G-17` PASS).

---

## Phase 5 — Staged Legacy Asset Decommission (`store.G-20`)

**Gate Check**: Confirm **30 consecutive incident-free days** on the v2 store (`store.G-2`, `store.G-7`, `store.G-8` all green), `tel.G18` PASS, all 5 dashboards on `/v1`, `store.G-17` PASS, and Rollback Drill (Phase 6) verified.

For every asset below, execute strictly through `active -> draining -> disabled_410 -> decommissioned` using `LegacyDecommissionController`:

### 5.1 Legacy v2 Tracking Tag (`legacy_tag_v2`)
1. `draining`: Remove legacy `public/v2/tracking.js` `<script>` tag from 1 canary site; monitor 48h.
2. `disabled_410`: Remove legacy tag from remaining 4 owned sites; return `410 Gone` for legacy script URL if no external embeds remain.
3. `decommissioned`: Archive legacy tag file.

### 5.2 Legacy Event Ingest Worker (`worker_event_ingest`)
1. `draining`: Confirm traffic to `workers/event-ingest` (`ugokimap-event-ingest`) drops to ~0 req/min after §5.1.
2. `disabled_410`: Deploy `410 Gone` stub route on `ugokimap-event-ingest` for 7 days to detect any forgotten embedded legacy tags.
3. `decommissioned`: `wrangler delete ugokimap-event-ingest` and archive `workers/event-ingest/`.

### 5.3 Legacy Banner Runtime + Vercel KV (`worker_banner_runtime`)
- **Extra prerequisite**: Steps 18–19 new delivery runtime + strongly consistent `ctl` cut over (`step18_19DeliveryRuntimeCutoverComplete = true`).
1. `draining`: Route 100% of banner requests to new delivery runtime; confirm `workers/banner-runtime` hits 0.
2. `disabled_410`: Return `410 Gone` on `ugokimap-banner-runtime` for 7 days.
3. `decommissioned`: Delete `ugokimap-banner-runtime` worker and decommission legacy Vercel KV namespace.

### 5.4 Legacy Vercel Crons (`C-1` through `C-4`)
Execute in order after confirming each asset's extra prerequisite:
1. **`cron_c1_daily_site_summary`** (`GET /api/cron/daily-site-summary`, `0 17 * * *`) — requires `step17SummaryArtifactGreen = true`.
2. **`cron_c2_deep_research`** (`GET /api/cron/deep-research`, `*/5 * * * *`) — requires `analysisJobsPendingZero = true` (drain legacy `analysis_jobs` table to 0 pending first).
3. **`cron_c3_fusion_ingest`** (`GET /api/cron/fusion-ingest`, `0 */6 * * *`) — requires `step13StructuralJoinGreen = true`.
4. **`cron_c4_experiments_pool`** (`GET /api/experiments/pool`, `0 18 * * *`) — requires `evG10UnitLedgerPoolActive = true`.

For each Cron:
1. `draining`: Remove its schedule entry from `vercel.json` and deploy.
2. `disabled_410`: Replace handler body with `410 Gone` (and remove `x-vercel-cron` exception from `middleware.ts` for C-4!). Observe 7 days for unexpected callers.
3. `decommissioned`: Remove legacy route file.

### 5.5 Legacy ClickHouse Tables & Insert-Time MVs (`legacy_clickhouse_tables`)
> **IRREVERSIBLE STEP**: Only permitted after ALL assets in §5.1–§5.4 are `decommissioned` AND `coldArchiveSnapshotVerified === true`.

1. `draining`: Detach insert-time Materialized Views (`DETACH VIEW ...`) and verify 7 days with zero read queries in `system.query_log`.
2. `disabled_410`: Revoke write/read grants on legacy `events` and `session_page_fact` tables; observe 7 days.
3. `decommissioned`: Verify R2 cold archive checksum one final time, then `DROP` legacy MVs and tables and decommission the 4.54 GiB legacy ClickHouse instance.

---

## Phase 6 — Emergency Rollback Procedures

Run a rehearsal drill on staging **before** Phase 5 (`rollbackDrillVerified = true`).

| Failing Phase / Asset | Trigger Condition | Rollback Action | Recovery SLA |
| :--- | :--- | :--- | :--- |
| **Phase 1 (Parallel Tag)** | INP regression `> 1.5pt` (`tel.G16`) or JS error rate spike | Toggle v2 tag kill switch off; legacy v2 tag continues uninterrupted | < 5 min |
| **Phase 2 (Direct R2 Shadow / Cutover)** | Any `countDiff !== 0`, hash mismatch, or `rollP95Sec > 60s` | Route collector primary write back to Cloudflare Queue shard(s); replay missed WAL window from R2 | < 10 min |
| **Phase 3 (Internal 5 Dashboards)** | `/v1` API error rate > 1% or schema mismatch | Flip dashboard feature flag back to legacy read adapters (legacy ClickHouse untouched during Phase 3) | < 2 min |
| **Phase 5.1–5.4 (`draining` or `disabled_410`)** | Forgotten caller hits `410 Gone` or metric drop detected | Call `controller.rollbackAsset(assetId, reason)`; re-enable Cloudflare Worker route or restore `vercel.json` Cron commit via `git revert` | < 15 min |
| **Phase 5.5 (`legacy_clickhouse_tables` in `draining`/`disabled_410`)** | Legacy consumer requires detached MV / table | `ATTACH VIEW ...` and restore grants immediately | < 5 min |
| **Phase 5.5 (`legacy_clickhouse_tables` AFTER `decommissioned`)** | Post-drop forensic or audit recovery needed | **In-place rollback impossible** (`LegacyDecommissionController` rejects it). Restore read-only instance from Phase 4 verified R2 cold archive snapshot | Measured restore RTO |

---

## Appendix — Verification Commands (Local CI & Pre-Flight)

```bash
# 1. Verify Cutover, OEM, and Residency unit & gate suites
npx jest --runTestsByPath \
  lib/link/cutover/cutover.test.ts \
  lib/link/oem/oem.test.ts \
  lib/link/residency/residency.test.ts

# 2. Verify Parallel Run, Loss Ledger, Legacy Bridge, and Calibration suites
npx jest --runTestsByPath lib/link/migration/migration.test.ts

# 3. Verify TypeScript strict compilation
npx tsc --noEmit
```
