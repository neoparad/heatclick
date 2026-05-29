/**
 * M-Director Stage 7 (続 M-12) — GET /api/scenarios/[id]/stats
 *
 * Returns impression / click / CVR stats for a scenario over a preset range.
 *
 * Query params:
 *   - tenant_id: required (defaults linkth_internal)
 *   - range: 24h | 7d | 30d (default 24h)
 *
 * Returns: ScenarioStats (see lib/scenarios/stats-query.ts)
 *   - graceful empty if scenario_match table not yet created
 *   - 404 if scenario not found
 *
 * Reference: 続 M-11 §4 (Stage 7 plan), data-model.md §3 (scenario_match schema)
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { CloudflareKvError } from '@/lib/scenarios/kv-storage'
import { ScenarioValidationError, createScenarioRepository } from '@/lib/scenarios/repository'
import { POC_SCENARIOS } from '@/lib/scenarios/poc-scenario'
import { buildPresetRange, queryScenarioStats } from '@/lib/scenarios/stats-query'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_TENANT = 'linkth_internal'
const DEFAULT_SITE = 'CIP_EcwUTHEZdIOAUqum'

const QuerySchema = z.object({
  tenant_id: z.string().regex(/^[a-z0-9_-]+$/).default(DEFAULT_TENANT),
  site_id: z.string().regex(/^[A-Za-z0-9_-]+$/).default(DEFAULT_SITE),
  range: z.enum(['24h', '7d', '30d']).default('24h'),
})

const ParamsSchema = z.object({
  id: z.string().regex(/^[0-9a-f-]{36}$/i, 'scenario id must be UUID v4'),
})

export async function GET(
  request: NextRequest,
  ctx: { params: { id: string } },
): Promise<NextResponse> {
  const paramsParsed = ParamsSchema.safeParse(ctx.params)
  if (!paramsParsed.success) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  }

  const { searchParams } = new URL(request.url)
  const queryParsed = QuerySchema.safeParse({
    tenant_id: searchParams.get('tenant_id') ?? undefined,
    site_id: searchParams.get('site_id') ?? undefined,
    range: searchParams.get('range') ?? undefined,
  })
  if (!queryParsed.success) {
    return NextResponse.json(
      {
        error: 'invalid_query',
        issues: queryParsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      { status: 400 },
    )
  }

  const { tenant_id, site_id, range } = queryParsed.data
  const scenarioId = paramsParsed.data.id

  // Verify scenario exists (KV-first then POC fallback)
  let scenarioExists = false
  try {
    const repo = createScenarioRepository()
    const found = await repo.getScenario(tenant_id, site_id, scenarioId)
    if (found) scenarioExists = true
  } catch (e) {
    if (!(e instanceof CloudflareKvError || e instanceof ScenarioValidationError)) {
      throw e
    }
  }
  if (!scenarioExists) {
    scenarioExists = POC_SCENARIOS.some(
      (s) => s.id === scenarioId && s.tenant_id === tenant_id && s.site_id === site_id,
    )
  }
  if (!scenarioExists) {
    return NextResponse.json({ error: 'scenario_not_found' }, { status: 404 })
  }

  try {
    const presetRange = buildPresetRange(range)
    const stats = await queryScenarioStats({
      tenantId: tenant_id,
      scenarioId,
      range: presetRange,
    })
    return NextResponse.json(stats, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[scenarios/[id]/stats]', e)
    return NextResponse.json({ error: 'stats_query_failed', message: (e as Error).message }, { status: 500 })
  }
}
