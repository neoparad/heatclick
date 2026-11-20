/**
 * Inngest configuration — UGOKI LINK v2 ML training & orchestration control plane.
 *
 * Wave 0-B audit (2026-11-20, Master Architecture v2 §12.4 / §13.2 Step 0):
 *   - Legacy registered jobs in this repository: 0 (confirmed `functions = []`).
 *   - Legacy commented stubs (`dataQualityCheck`, `dailyBackup`, `executeDeleteRequest`)
 *     have been removed because their responsibilities moved out of Inngest:
 *       * Data-quality & liveness checks -> independent Worker cron watchdog + Store Agent
 *         reconciliation closures 1-5 (Step 4 / Step 9; never co-located on Vercel).
 *       * ClickHouse backups             -> Store Agent inside the private database network
 *         (Step 4, `store.G-4`; never via SSH from Vercel).
 *       * Privacy deletion & purge       -> Store Agent deletion plan (`store.G-10`,
 *         mask <= 24h, physical purge <= 5d, certificate <= 14d).
 *   - Legacy external app `heatmap-clickinsight` (`warm-heatmap-cache`, etc.) on
 *     `app.inngest.com` is tracked for immediate owner Pause/Delete in `OWNER_TODO.md`.
 *
 * Future scope (Wave 4-F / Step 17, Master Architecture v2 §8.10 / §8.14):
 *   - Inngest serves exclusively as the durable control plane for per-tenant ML training
 *     concurrency, fan-out, and completion reconciliation.
 *   - Heavy training / resampling jobs execute on external compute (Cloud Run Jobs / Modal),
 *     never inside Vercel functions or on the CRAWL host.
 *
 * See `docs/ugokilink/CRON_INVENTORY.md` for the full cron & job inventory.
 */

import { Inngest } from 'inngest'

export const INNGEST_ORCHESTRATION_POLICY = {
  role: 'ml_training_control_plane_only',
  targetWave: '4-F',
  targetStep: 'Q-17',
  legacyRegisteredJobs: 0,
  disallowedWorkloads: [
    'liveness_monitoring',
    'clickhouse_ssh_backup',
    'privacy_hard_delete_worker',
    'heatmap_cache_warming',
  ],
} as const

export const inngest = new Inngest({
  id: 'ugokimap-saas',
  name: 'UGOKI LINK v2 ML Orchestrator',
  eventKey: process.env.INNGEST_EVENT_KEY,
})

/**
 * Registered Inngest functions.
 * Intentionally empty (0 legacy jobs) until Wave 4-F ML training orchestrators are added.
 */
export const functions: ReturnType<typeof inngest.createFunction>[] = []
