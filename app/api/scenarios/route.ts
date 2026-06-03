/**
 * M-Director Stage 1 (続 M-7/M-8) — Scenarios CRUD: list + create
 *
 * Endpoints:
 *   GET  /api/scenarios?site_id=...
 *   POST /api/scenarios  body: CreateScenarioInput (site_id selects among the tenant's sites)
 *
 * REQ-SEC-004 (tenant isolation, §3.8.1):
 *   - tenant_id is derived ONLY from the middleware-injected, JWT-verified `x-tenant-id`
 *     header. Any tenant_id in the body/query is IGNORED (no `linkth_internal` default).
 *   - site_id is the only caller-controlled selector and MUST be a member of the JWT's
 *     `x-site-ids`; otherwise 403.
 *   - created_by is read from the JWT-verified `x-user-id` header.
 *
 * Reference:
 *   - lib/scenarios/tenant-context.ts (JWT-derived tenant context)
 *   - lib/scenarios/repository.ts (CRUD ops + Zod validate + sanitize + audit)
 *   - app/api/heatmap/screenshot/route.ts (same x-tenant-id / x-site-ids pattern)
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import {
  HtmlSanitizationError,
  ScenarioNotFoundError,
  ScenarioValidationError,
  createScenarioRepository,
} from '@/lib/scenarios/repository'
import { CloudflareKvError } from '@/lib/scenarios/kv-storage'
import { ConditionNodeSchema, VariantsSchema, SCENARIO_STATUSES, EVIDENCE_LEVELS } from '@/lib/scenarios/types'
import { isTenantContext, resolveScenarioTenantContext } from '@/lib/scenarios/tenant-context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SiteIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)

// tenant_id is NOT accepted from the body — it is derived from the JWT. site_id is validated
// against the JWT's site_ids in resolveScenarioTenantContext (here it is only shape-checked).
const CreateBodySchema = z.object({
  site_id: SiteIdSchema,
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  condition_ast: ConditionNodeSchema,
  variants: VariantsSchema,
  status: z.enum(SCENARIO_STATUSES).optional(),
  evidence_level: z.enum(EVIDENCE_LEVELS).optional(),
  evidence_data: z.record(z.unknown()).optional(),
})

function handleError(err: unknown): NextResponse {
  if (err instanceof HtmlSanitizationError) {
    return NextResponse.json(
      { error: 'unsafe_html', reason: err.reason, message: err.message },
      { status: 400 },
    )
  }
  if (err instanceof ScenarioValidationError) {
    return NextResponse.json(
      { error: 'validation_failed', message: err.message, issues: err.issues },
      { status: 400 },
    )
  }
  if (err instanceof ScenarioNotFoundError) {
    return NextResponse.json({ error: 'not_found', message: err.message }, { status: 404 })
  }
  if (err instanceof CloudflareKvError) {
    // eslint-disable-next-line no-console
    console.error(`[scenarios api] KV error: ${err.message}`, err.cfErrors)
    return NextResponse.json(
      { error: 'storage_error', message: 'upstream KV failure' },
      { status: 502 },
    )
  }
  // eslint-disable-next-line no-console
  console.error('[scenarios api] unhandled', err)
  return NextResponse.json({ error: 'internal_error' }, { status: 500 })
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const siteParse = SiteIdSchema.safeParse(searchParams.get('site_id') ?? undefined)
  if (!siteParse.success) {
    return NextResponse.json({ error: 'invalid_query', message: 'site_id required' }, { status: 400 })
  }

  // tenant_id from JWT header; site_id must be in JWT site_ids (REQ-SEC-004).
  const ctx = resolveScenarioTenantContext(request, siteParse.data)
  if (!isTenantContext(ctx)) return ctx

  try {
    const repo = createScenarioRepository()
    const scenarios = await repo.listScenarios(ctx.tenantId, ctx.siteId)
    return NextResponse.json(
      { tenant_id: ctx.tenantId, site_id: ctx.siteId, count: scenarios.length, scenarios },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    return handleError(err)
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = CreateBodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid_body',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      { status: 400 },
    )
  }

  // tenant_id from JWT header; body site_id must be in JWT site_ids (REQ-SEC-004).
  const ctx = resolveScenarioTenantContext(request, parsed.data.site_id)
  if (!isTenantContext(ctx)) return ctx

  try {
    const repo = createScenarioRepository()
    const created = await repo.createScenario({
      name: parsed.data.name,
      description: parsed.data.description,
      condition_ast: parsed.data.condition_ast,
      variants: parsed.data.variants,
      status: parsed.data.status,
      evidence_level: parsed.data.evidence_level,
      evidence_data: parsed.data.evidence_data,
      tenant_id: ctx.tenantId,
      site_id: ctx.siteId,
      created_by: ctx.userId,
    })
    return NextResponse.json(created, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return handleError(err)
  }
}
