/**
 * GET /api/experiments/[id]/result — 宝プロジェクト M4b (顧客向け実験結果)
 *
 * 認証: middleware classify では /api/experiments/assign のみ api-public。本ルートは
 * api-tenant (JWT 必須)。tenant_id は **JWT 由来のみ** (resolveScenarioTenantContext、
 * REQ-SEC-126: Layer2 失効照合込み)。query の site_id は JWT の site_ids メンバー必須。
 *
 * 応答は result-view-model がサーバー側で redact 済み:
 *   - 観測値 (conversions/cvr) は min arm ≥ 2000 のときのみ
 *   - effect (logRR/SE) は含めない
 *   - pool は K≥24 (power-gate) + meets_k50 (開示ゲート) を通過したものだけ
 *
 * Query params: site_id (必須、JWT site_ids 内)
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { queryArmStats } from '@/lib/experiments/arm-stats'
import { AssignSaltMissingError, getAssignSalt } from '@/lib/experiments/assignment'
import { readDisclosablePoolCell } from '@/lib/experiments/pool-cells'
import { powerGateFromArmStats } from '@/lib/experiments/power-gate'
import { PostgresExperimentStore } from '@/lib/experiments/postgres-store'
import { createExperimentRepository } from '@/lib/experiments/repository'
import { buildExperimentResultView } from '@/lib/experiments/result-view-model'
import { isTenantContext, resolveScenarioTenantContext } from '@/lib/scenarios/tenant-context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ParamsSchema = z.object({
  id: z.string().uuid(),
})

const SiteIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)

export async function GET(
  request: NextRequest,
  ctx: { params: { id: string } },
): Promise<NextResponse> {
  const paramsParsed = ParamsSchema.safeParse(ctx.params)
  if (!paramsParsed.success) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  }

  const { searchParams } = new URL(request.url)
  const siteParsed = SiteIdSchema.safeParse(searchParams.get('site_id') ?? undefined)
  if (!siteParsed.success) {
    return NextResponse.json({ error: 'invalid_query', message: 'site_id required' }, { status: 400 })
  }

  // tenant_id は JWT 由来のみ。site_id は JWT site_ids メンバー必須 (401/400/403 はここで返る)。
  const tenantCtx = await resolveScenarioTenantContext(request, siteParsed.data)
  if (!isTenantContext(tenantCtx)) return tenantCtx

  // 実験を tenant+site スコープで取得 (cross-tenant は repository 層でも null = 404)。
  let experiment
  try {
    const repo = createExperimentRepository({ store: new PostgresExperimentStore() })
    experiment = await repo.get(tenantCtx.tenantId, tenantCtx.siteId, paramsParsed.data.id)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[experiments/result] registry unavailable: ${(e as Error).message}`)
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
  if (!experiment) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // salt: arm 再計算 (M3) に必須。未設定は 503 (assign endpoint と同方針で fail-closed)。
  let salt: string
  try {
    salt = getAssignSalt()
  } catch (e) {
    if (e instanceof AssignSaltMissingError) {
      // eslint-disable-next-line no-console
      console.error('[experiments/result] EXPERIMENT_ASSIGN_SALT not configured')
      return NextResponse.json({ error: 'unavailable' }, { status: 503 })
    }
    throw e
  }

  // arm 別計測 (M3、graceful empty 内蔵) + 開示可能な pool セル (M4b、失敗は null に倒れる)。
  // queryArmStats は未知の ClickHouse エラーを rethrow するため、ここで catch して 503 に正規化
  // (unhandled 500 で内部詳細を漏らさない。Codex M4b MEDIUM)。
  let stats
  let pool
  try {
    ;[stats, pool] = await Promise.all([
      queryArmStats({ experiment, salt }),
      readDisclosablePoolCell(experiment.taxonomy, experiment.taxonomy.primary_metric),
    ])
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[experiments/result] measurement query failed: ${(e as Error).message}`)
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }

  // 内部 reason は顧客応答に出さずサーバーログのみ (view-model が安定コードへ正規化)。
  if (stats.data_unavailable && stats.data_unavailable_reason) {
    // eslint-disable-next-line no-console
    console.warn(`[experiments/result] data unavailable (${experiment.id}): ${stats.data_unavailable_reason}`)
  }

  const verdict = powerGateFromArmStats(stats, pool)
  const view = buildExperimentResultView(experiment, stats, verdict)

  return NextResponse.json(view, { status: 200, headers: { 'Cache-Control': 'no-store' } })
}
