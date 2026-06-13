/**
 * M-Director Stage 7 (続 M-12) — GET /api/scenarios/[id]/stats
 *
 * Returns impression / click / CVR stats for a scenario over a preset range.
 *
 * Query params:
 *   - site_id: **required** — JWT の site_ids に含まれるものだけ許可 (REQ-SEC-004)
 *   - range: 24h | 7d | 30d (default 24h)
 *
 * Returns: ScenarioStats (see lib/scenarios/stats-query.ts)
 *   - graceful empty if scenario_match table not yet created
 *   - 404 if scenario not found
 *
 * 続134 (CRITICAL fix): tenant_id は **getServerSession 経由** (resolveScenarioTenantContext)
 *   でのみ取得し、クエリの tenant_id は受け付けない。旧実装はクエリ tenant_id/site_id を
 *   無検証で repo/CH に渡し、`site_id` 省略時に既定値へ落ちる cross-tenant IDOR があった
 *   (REQ-SEC-004/126 違反)。隣の [id]/route.ts と同じ tenant 解決パターンに統一。
 *
 * Reference: 続 M-11 §4 (Stage 7 plan), data-model.md §3 (scenario_match schema)
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { CloudflareKvError } from '@/lib/scenarios/kv-storage'
import { ScenarioValidationError, createScenarioRepository } from '@/lib/scenarios/repository'
import { POC_SCENARIOS } from '@/lib/scenarios/poc-scenario'
import { buildPresetRange, queryScenarioStats } from '@/lib/scenarios/stats-query'
import {
  isTenantContext,
  resolveScenarioTenantContext,
} from '@/lib/scenarios/tenant-context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// site_id は唯一の caller-controlled selector。tenant は session 由来 (クエリ tenant_id は廃止)。
const SiteIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)

const QuerySchema = z.object({
  range: z.enum(['24h', '7d', '30d']).default('24h'),
})

const ParamsSchema = z.object({
  id: z.string().regex(/^[0-9a-f-]{36}$/i, 'scenario id must be UUID v4'),
})

export async function GET(
  request: NextRequest,
  routeCtx: { params: { id: string } },
): Promise<NextResponse> {
  const paramsParsed = ParamsSchema.safeParse(routeCtx.params)
  if (!paramsParsed.success) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  }

  const { searchParams } = new URL(request.url)
  const siteParse = SiteIdSchema.safeParse(searchParams.get('site_id') ?? undefined)
  if (!siteParse.success) {
    return NextResponse.json(
      { error: 'invalid_query', message: 'site_id required' },
      { status: 400 },
    )
  }
  const queryParsed = QuerySchema.safeParse({
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

  // tenant/site は session から解決 (401 if no session / 403 if site not in tenant / 400 if malformed)
  const ctx = await resolveScenarioTenantContext(request, siteParse.data)
  if (!isTenantContext(ctx)) return ctx

  const { range } = queryParsed.data
  const scenarioId = paramsParsed.data.id

  // Verify scenario exists (KV-first then POC fallback) — tenant/site は session 由来のみ
  let scenarioExists = false
  try {
    const repo = createScenarioRepository()
    const found = await repo.getScenario(ctx.tenantId, ctx.siteId, scenarioId)
    if (found) scenarioExists = true
  } catch (e) {
    if (!(e instanceof CloudflareKvError || e instanceof ScenarioValidationError)) {
      throw e
    }
  }
  if (!scenarioExists) {
    scenarioExists = POC_SCENARIOS.some(
      (s) => s.id === scenarioId && s.tenant_id === ctx.tenantId && s.site_id === ctx.siteId,
    )
  }
  if (!scenarioExists) {
    return NextResponse.json({ error: 'scenario_not_found' }, { status: 404 })
  }

  try {
    const presetRange = buildPresetRange(range)
    const stats = await queryScenarioStats({
      tenantId: ctx.tenantId,
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
