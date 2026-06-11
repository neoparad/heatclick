/**
 * 宝プロジェクト — pool pipeline の Postgres 実装 (M5)
 *
 * ⚠️ SECURITY — cross-tenant 読み出しについて:
 *   PostgresPoolableSource.listPoolable() は本リポジトリで **唯一の正当な cross-tenant SELECT**
 *   (横断プール pipeline 専用、§3.8.1 の意図的な例外)。条件は pool_opt_in = true (同意済み) かつ
 *   running/stopped のみ。**tenant スコープの API ハンドラから絶対に呼ばないこと** — 呼び出しは
 *   pool 再計算 pipeline (app/api/experiments/pool, owner/admin gate) に限る。
 *   出力の使途も (site, arm) 集計 → DL+KH のみで、行データがテナント外へ出ることはない。
 */

import { experimentsQuery } from './db'
import type { PoolableExperimentSource, PoolCellUpsert, PoolCellWriteStore } from './pool-aggregate'
import { ExperimentSchema, type Experiment } from './types'
import type { PrimaryMetric } from './taxonomy'

interface PoolableRow {
  id: string
  tenant_id: string
  site_id: string
  name: string
  url_pattern: string
  intervention_type: string
  page_type: string
  industry: string
  device: string
  primary_metric: string
  window_code: string
  status: string
  start_at: Date | string | null
  end_at: Date | string | null
  salt_version: number
  pool_opt_in: boolean
  k_anonymity_min: number
  created_by: string
  locked_at: Date | string | null
  stopped_at: Date | string | null
  archived_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

function toIso(v: Date | string | null): string | null {
  if (v === null) return null
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString()
}

function rowToExperiment(row: PoolableRow): Experiment {
  return ExperimentSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    name: row.name,
    url_pattern: row.url_pattern,
    taxonomy: {
      intervention_type: row.intervention_type,
      page_type: row.page_type,
      industry: row.industry,
      device: row.device,
      primary_metric: row.primary_metric,
      window: row.window_code,
    },
    status: row.status,
    dates: { start_at: toIso(row.start_at), end_at: toIso(row.end_at) },
    salt_version: row.salt_version,
    consent: { pool_opt_in: row.pool_opt_in, k_anonymity_min: row.k_anonymity_min },
    created_at: toIso(row.created_at) as string,
    updated_at: toIso(row.updated_at) as string,
    created_by: row.created_by,
    locked_at: toIso(row.locked_at),
    stopped_at: toIso(row.stopped_at),
    archived_at: toIso(row.archived_at),
  })
}

export class PostgresPoolableSource implements PoolableExperimentSource {
  async listPoolable(): Promise<Experiment[]> {
    // cross-tenant (上記 SECURITY 注記)。同意済み + 計測 window が確定している実験のみ。
    const rows = await experimentsQuery<PoolableRow>(
      `SELECT id, tenant_id, site_id, name, url_pattern,
              intervention_type, page_type, industry, device, primary_metric, window_code,
              status, start_at, end_at, salt_version, pool_opt_in, k_anonymity_min,
              created_by, locked_at, stopped_at, archived_at, created_at, updated_at
         FROM experiments
        WHERE pool_opt_in = true
          AND status IN ('running', 'stopped')
          AND start_at IS NOT NULL AND end_at IS NOT NULL`,
    )
    return rows.map(rowToExperiment)
  }
}

export class PostgresPoolCellStore implements PoolCellWriteStore {
  async upsert(row: PoolCellUpsert): Promise<void> {
    await experimentsQuery(
      `INSERT INTO experiment_pool_cells (
         cell_key, intervention_type, page_type, industry, device, primary_metric,
         k_sites, total_sessions, pooled_log_rr, ci_low, ci_high, tau2, i2,
         meets_k50, method, computed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'DL+KH',now())
       ON CONFLICT (cell_key, primary_metric) DO UPDATE SET
         k_sites = EXCLUDED.k_sites,
         total_sessions = EXCLUDED.total_sessions,
         pooled_log_rr = EXCLUDED.pooled_log_rr,
         ci_low = EXCLUDED.ci_low,
         ci_high = EXCLUDED.ci_high,
         tau2 = EXCLUDED.tau2,
         i2 = EXCLUDED.i2,
         meets_k50 = EXCLUDED.meets_k50,
         method = EXCLUDED.method,
         computed_at = now()`,
      [
        row.cell_key,
        row.intervention_type,
        row.page_type,
        row.industry,
        row.device,
        row.primary_metric,
        row.k_sites,
        row.total_sessions,
        row.pooled_log_rr,
        row.ci_low,
        row.ci_high,
        row.tau2,
        row.i2,
        row.meets_k50,
      ],
    )
  }

  async remove(cellKeyValue: string, primaryMetric: PrimaryMetric): Promise<boolean> {
    const rows = await experimentsQuery<{ cell_key: string }>(
      `DELETE FROM experiment_pool_cells
        WHERE cell_key = $1 AND primary_metric = $2
        RETURNING cell_key`,
      [cellKeyValue, primaryMetric],
    )
    return rows.length > 0
  }
}
