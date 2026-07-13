/**
 * 経路分析 比較セット CRUD: get + update + delete (by id)
 *
 * Endpoints:
 *   GET    /api/paths/[id]?site_id=...
 *   PUT    /api/paths/[id]?site_id=...   body: UpdatePathSetBody (partial)
 *   DELETE /api/paths/[id]?site_id=...
 *
 * REQ-SEC-004: tenant は JWT 由来、site_id は JWT site_ids メンバー必須。row 所有権は
 * repository が再検証 (PathSetNotFoundError → 404)。viewer は書込み/削除不可 (403)。
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { getServerSession } from '@/lib/auth/server-session'
import { getClickHouseClient } from '@/lib/clickhouse'
import { computePathSetStats, markPathSetStatsUnavailable } from '@/lib/paths/stats-query'
import { canWriteScenario, normalizeRole } from '@/lib/scenarios/publish-rbac'
import { CloudflareKvError } from '@/lib/scenarios/kv-storage'
import {
  PathSetNotFoundError,
  PathSetValidationError,
  createPathSetRepository,
} from '@/lib/paths/repository'
import { isPathTenantContext, resolvePathTenantContext } from '@/lib/paths/tenant-context'
import { PATHSET_STATUSES, PathBranchSchema, PathTriggerSchema } from '@/lib/paths/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SiteIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)

const UpdateBodySchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).optional(),
    status: z.enum(PATHSET_STATUSES).optional(),
    trigger: PathTriggerSchema.optional(),
    branches: z.array(PathBranchSchema).min(1).max(8).optional(),
  })
  .strict()

function readSiteId(request: NextRequest): string | null {
  const v = new URL(request.url).searchParams.get('site_id')
  const parsed = SiteIdSchema.safeParse(v ?? undefined)
  return parsed.success ? parsed.data : null
}

function handleError(err: unknown): NextResponse {
  if (err instanceof PathSetValidationError) {
    return NextResponse.json(
      { error: 'validation_failed', message: err.message, issues: err.issues },
      { status: 400 },
    )
  }
  if (err instanceof PathSetNotFoundError) {
    return NextResponse.json({ error: 'not_found', message: err.message }, { status: 404 })
  }
  if (err instanceof CloudflareKvError) {
    // eslint-disable-next-line no-console
    console.error(`[paths/[id] api] KV error: ${err.message}`, err.cfErrors)
    return NextResponse.json(
      { error: 'storage_error', message: 'upstream KV failure' },
      { status: 502 },
    )
  }
  // eslint-disable-next-line no-console
  console.error('[paths/[id] api] unhandled', err)
  return NextResponse.json({ error: 'internal_error' }, { status: 500 })
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const siteId = readSiteId(request)
  if (!siteId) {
    return NextResponse.json(
      { error: 'invalid_query', message: 'site_id required' },
      { status: 400 },
    )
  }
  const ctx = await resolvePathTenantContext(request, siteId)
  if (!isPathTenantContext(ctx)) return ctx

  try {
    const repo = createPathSetRepository()
    const found = await repo.getPathSet(ctx.tenantId, ctx.siteId, params.id)
    if (!found) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    let pathSet = found
    if (!found.isDummy) {
      try {
        pathSet = await computePathSetStats(getClickHouseClient('analytics_reader'), found)
      } catch {
        // The definition is still useful, but callers must see that live stats were not computed.
        console.error('[paths/[id] api] path stats client initialization failed')
        pathSet = markPathSetStatsUnavailable(found, 'clickhouse_error')
      }
    }
    return NextResponse.json(pathSet, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    return handleError(err)
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const siteId = readSiteId(request)
  if (!siteId) {
    return NextResponse.json(
      { error: 'invalid_query', message: 'site_id required' },
      { status: 400 },
    )
  }

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = UpdateBodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid_body',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      { status: 400 },
    )
  }

  const ctx = await resolvePathTenantContext(request, siteId)
  if (!isPathTenantContext(ctx)) return ctx

  const session = await getServerSession()
  if (!session) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'session required' },
      { status: 401 },
    )
  }
  const role = normalizeRole(session.user.role)
  if (!canWriteScenario(role)) {
    return NextResponse.json(
      { error: 'forbidden', message: 'viewer は経路を更新できません' },
      { status: 403 },
    )
  }

  try {
    const repo = createPathSetRepository()
    const updated = await repo.updatePathSet(ctx.tenantId, ctx.siteId, params.id, parsed.data)
    return NextResponse.json(updated, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    return handleError(err)
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const siteId = readSiteId(request)
  if (!siteId) {
    return NextResponse.json(
      { error: 'invalid_query', message: 'site_id required' },
      { status: 400 },
    )
  }
  const ctx = await resolvePathTenantContext(request, siteId)
  if (!isPathTenantContext(ctx)) return ctx

  const session = await getServerSession()
  if (!session) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'session required' },
      { status: 401 },
    )
  }
  const role = normalizeRole(session.user.role)
  if (!canWriteScenario(role)) {
    return NextResponse.json(
      { error: 'forbidden', message: 'viewer は経路を削除できません' },
      { status: 403 },
    )
  }

  try {
    const repo = createPathSetRepository()
    const existed = await repo.deletePathSet(ctx.tenantId, ctx.siteId, params.id)
    if (!existed) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    return NextResponse.json({ deleted: true, id: params.id }, { status: 200 })
  } catch (err) {
    return handleError(err)
  }
}
