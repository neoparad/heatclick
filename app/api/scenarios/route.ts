/**
 * M-Director Stage 1 (続 M-7/M-8) — Scenarios CRUD: list + create
 *
 * Endpoints:
 *   GET  /api/scenarios?tenant_id=...&site_id=...
 *   POST /api/scenarios  body: CreateScenarioInput (tenant_id + site_id inline)
 *
 * Phase 1 (続 M-7 整合):
 *   - tenant_id is enforced from query/body; later phases inject from JWT middleware.
 *   - created_by is read from `x-user-id` header; defaults to 'system' for now.
 *   - tenant_id default = 'linkth_internal' if query omitted.
 *
 * Reference:
 *   - lib/scenarios/repository.ts (CRUD ops + Zod validate + audit)
 *   - app/api/scenarios/runtime/route.ts (continued runtime read path, unchanged)
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import {
  ScenarioNotFoundError,
  ScenarioValidationError,
  createScenarioRepository,
} from '@/lib/scenarios/repository'
import { CloudflareKvError } from '@/lib/scenarios/kv-storage'
import { ConditionNodeSchema, VariantsSchema, SCENARIO_STATUSES, EVIDENCE_LEVELS } from '@/lib/scenarios/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_TENANT = 'linkth_internal'

const QuerySchema = z.object({
  tenant_id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/).default(DEFAULT_TENANT),
  site_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
})

const CreateBodySchema = z.object({
  tenant_id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/).default(DEFAULT_TENANT),
  site_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  condition_ast: ConditionNodeSchema,
  variants: VariantsSchema,
  status: z.enum(SCENARIO_STATUSES).optional(),
  evidence_level: z.enum(EVIDENCE_LEVELS).optional(),
  evidence_data: z.record(z.unknown()).optional(),
})

function userIdFromRequest(req: NextRequest): string {
  return req.headers.get('x-user-id') ?? 'system'
}

function handleError(err: unknown): NextResponse {
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
  const parsed = QuerySchema.safeParse({
    tenant_id: searchParams.get('tenant_id') ?? undefined,
    site_id: searchParams.get('site_id') ?? undefined,
  })
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid_query',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      { status: 400 },
    )
  }
  const { tenant_id, site_id } = parsed.data

  try {
    const repo = createScenarioRepository()
    const scenarios = await repo.listScenarios(tenant_id, site_id)
    return NextResponse.json(
      { tenant_id, site_id, count: scenarios.length, scenarios },
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

  try {
    const repo = createScenarioRepository()
    const created = await repo.createScenario({
      ...parsed.data,
      created_by: userIdFromRequest(request),
    })
    return NextResponse.json(created, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return handleError(err)
  }
}
