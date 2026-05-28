/**
 * M-Director Stage 1 (続 M-7/M-8) — Scenarios CRUD: get / update / delete
 *
 * Endpoints:
 *   GET    /api/scenarios/[id]?tenant_id=...&site_id=...
 *   PUT    /api/scenarios/[id]?tenant_id=...&site_id=...  body: UpdateScenarioInput
 *   DELETE /api/scenarios/[id]?tenant_id=...&site_id=...
 *
 * Phase 1 (続 M-7 整合):
 *   - tenant_id + site_id are required in query for all 3 verbs; later phases
 *     fold them into the resource path or JWT claim.
 *   - PUT accepts a partial body; provided keys overwrite existing fields.
 *   - DELETE is a physical KV.delete() in Phase 2; soft-delete to be added in Phase 3.
 *
 * Reference: lib/scenarios/repository.ts
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

const ParamsSchema = z.object({
  id: z.string().regex(/^[0-9a-f-]{36}$/i, 'scenario id must be UUID v4'),
})

const UpdateBodySchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).optional(),
    condition_ast: ConditionNodeSchema.optional(),
    variants: VariantsSchema.optional(),
    status: z.enum(SCENARIO_STATUSES).optional(),
    evidence_level: z.enum(EVIDENCE_LEVELS).optional(),
    evidence_data: z.record(z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'body must contain at least one field' })

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
    console.error(`[scenarios/[id] api] KV error: ${err.message}`, err.cfErrors)
    return NextResponse.json(
      { error: 'storage_error', message: 'upstream KV failure' },
      { status: 502 },
    )
  }
  // eslint-disable-next-line no-console
  console.error('[scenarios/[id] api] unhandled', err)
  return NextResponse.json({ error: 'internal_error' }, { status: 500 })
}

interface ParsedQuery {
  tenant_id: string
  site_id: string
}

function parseQueryOrError(request: NextRequest): ParsedQuery | NextResponse {
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
  return parsed.data
}

function isParsedQuery(v: ParsedQuery | NextResponse): v is ParsedQuery {
  return !(v instanceof NextResponse)
}

export async function GET(
  request: NextRequest,
  ctx: { params: { id: string } },
): Promise<NextResponse> {
  const paramsParsed = ParamsSchema.safeParse(ctx.params)
  if (!paramsParsed.success) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  }
  const q = parseQueryOrError(request)
  if (!isParsedQuery(q)) return q

  try {
    const repo = createScenarioRepository()
    const scenario = await repo.getScenario(q.tenant_id, q.site_id, paramsParsed.data.id)
    if (!scenario) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    return NextResponse.json(scenario, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return handleError(err)
  }
}

export async function PUT(
  request: NextRequest,
  ctx: { params: { id: string } },
): Promise<NextResponse> {
  const paramsParsed = ParamsSchema.safeParse(ctx.params)
  if (!paramsParsed.success) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  }
  const q = parseQueryOrError(request)
  if (!isParsedQuery(q)) return q

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const bodyParsed = UpdateBodySchema.safeParse(raw)
  if (!bodyParsed.success) {
    return NextResponse.json(
      {
        error: 'invalid_body',
        issues: bodyParsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      { status: 400 },
    )
  }

  try {
    const repo = createScenarioRepository()
    const updated = await repo.updateScenario(q.tenant_id, q.site_id, paramsParsed.data.id, bodyParsed.data)
    return NextResponse.json(updated, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return handleError(err)
  }
}

export async function DELETE(
  request: NextRequest,
  ctx: { params: { id: string } },
): Promise<NextResponse> {
  const paramsParsed = ParamsSchema.safeParse(ctx.params)
  if (!paramsParsed.success) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  }
  const q = parseQueryOrError(request)
  if (!isParsedQuery(q)) return q

  try {
    const repo = createScenarioRepository()
    const removed = await repo.deleteScenario(q.tenant_id, q.site_id, paramsParsed.data.id)
    if (!removed) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return handleError(err)
  }
}
