/**
 * 宝プロジェクト — PostgresExperimentStore (本番 store impl, Supabase 相乗り)
 *
 * - 全 query で tenant_id を WHERE に含める (§3.8.1)。get/list は tenant+site スコープ。
 * - domain Experiment ↔ flat columns のマッピングは本 module に閉じ込める。
 * - taxonomy enum の検証は ExperimentSchema.parse (row→domain 時にも再検証 = 破損行を fail-loud)。
 */

import { experimentsQuery } from './db'
import { type ExperimentStore } from './repository'
import { ExperimentSchema, type Experiment } from './types'

interface ExperimentRow {
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

const SELECT_COLS = `
  id, tenant_id, site_id, name, url_pattern,
  intervention_type, page_type, industry, device, primary_metric, window_code,
  status, start_at, end_at, salt_version, pool_opt_in, k_anonymity_min,
  created_by, locked_at, stopped_at, archived_at, created_at, updated_at
`

export class PostgresExperimentStore implements ExperimentStore {
  async insert(row: Experiment): Promise<void> {
    await experimentsQuery(
      `INSERT INTO experiments (
         id, tenant_id, site_id, name, url_pattern,
         intervention_type, page_type, industry, device, primary_metric, window_code,
         status, start_at, end_at, salt_version, pool_opt_in, k_anonymity_min,
         created_by, locked_at, stopped_at, archived_at, created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
       )`,
      insertValues(row),
    )
  }

  async getById(tenantId: string, siteId: string, id: string): Promise<Experiment | null> {
    const rows = await experimentsQuery<ExperimentRow>(
      `SELECT ${SELECT_COLS} FROM experiments
        WHERE id = $1 AND tenant_id = $2 AND site_id = $3 LIMIT 1`,
      [id, tenantId, siteId],
    )
    const row = rows[0]
    return row ? rowToExperiment(row) : null
  }

  async listByTenantSite(tenantId: string, siteId: string): Promise<Experiment[]> {
    const rows = await experimentsQuery<ExperimentRow>(
      `SELECT ${SELECT_COLS} FROM experiments
        WHERE tenant_id = $1 AND site_id = $2
        ORDER BY created_at DESC`,
      [tenantId, siteId],
    )
    return rows.map(rowToExperiment)
  }

  async update(row: Experiment): Promise<void> {
    // id / tenant_id / site_id / created_by / created_at は不変。tenant+site スコープで UPDATE。
    await experimentsQuery(
      `UPDATE experiments SET
         name = $4, url_pattern = $5,
         intervention_type = $6, page_type = $7, industry = $8, device = $9,
         primary_metric = $10, window_code = $11, status = $12,
         start_at = $13, end_at = $14, salt_version = $15,
         pool_opt_in = $16, k_anonymity_min = $17,
         locked_at = $18, stopped_at = $19, archived_at = $20, updated_at = $21
       WHERE id = $1 AND tenant_id = $2 AND site_id = $3`,
      updateValues(row),
    )
  }
}

function insertValues(row: Experiment): ReadonlyArray<unknown> {
  return [
    row.id,
    row.tenant_id,
    row.site_id,
    row.name,
    row.url_pattern,
    row.taxonomy.intervention_type,
    row.taxonomy.page_type,
    row.taxonomy.industry,
    row.taxonomy.device,
    row.taxonomy.primary_metric,
    row.taxonomy.window,
    row.status,
    row.dates.start_at,
    row.dates.end_at,
    row.salt_version,
    row.consent.pool_opt_in,
    row.consent.k_anonymity_min,
    row.created_by,
    row.locked_at,
    row.stopped_at,
    row.archived_at,
    row.created_at,
    row.updated_at,
  ]
}

function updateValues(row: Experiment): ReadonlyArray<unknown> {
  return [
    row.id,
    row.tenant_id,
    row.site_id,
    row.name,
    row.url_pattern,
    row.taxonomy.intervention_type,
    row.taxonomy.page_type,
    row.taxonomy.industry,
    row.taxonomy.device,
    row.taxonomy.primary_metric,
    row.taxonomy.window,
    row.status,
    row.dates.start_at,
    row.dates.end_at,
    row.salt_version,
    row.consent.pool_opt_in,
    row.consent.k_anonymity_min,
    row.locked_at,
    row.stopped_at,
    row.archived_at,
    row.updated_at,
  ]
}

function toIso(v: Date | string | null): string | null {
  if (v === null) return null
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString()
}

function rowToExperiment(row: ExperimentRow): Experiment {
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
