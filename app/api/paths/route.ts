/**
 * 経路分析 比較セット CRUD: list + create
 *
 * Endpoints:
 *   GET  /api/paths?site_id=...
 *   POST /api/paths  body: CreatePathSetBody (site_id selects among the tenant's sites)
 *
 * REQ-SEC-004 (tenant isolation, §3.8.1):
 *   - tenant_id / user_id は getServerSession() (JWT 検証 + Layer 2 失効照合) 由来のみ
 *   - site_id は唯一の caller-controlled 入力で、JWT site_ids メンバー必須 (resolvePathTenantContext)
 *   - body の tenant_id は受け付けない
 *   - 新規作成は status='draft' 固定 (lib/paths/repository.ts createPathSet)
 *
 * 権限: viewer は作成不可 (403)。owner/admin/member は作成可 (publish 概念は paths には無い)。
 */

import { NextResponse, type NextRequest } from 'next/server'

import { getServerSession } from '@/lib/auth/server-session'
import { canWriteScenario, normalizeRole } from '@/lib/scenarios/publish-rbac'
import { CloudflareKvError } from '@/lib/scenarios/kv-storage'
import {
  PathSetNotFoundError,
  PathSetValidationError,
  createPathSetRepository,
} from '@/lib/paths/repository'
import { isPathTenantContext, resolvePathTenantContext } from '@/lib/paths/tenant-context'
import { CreatePathSetBodySchema } from '@/lib/paths/types'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SiteIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)

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
    console.error(`[paths api] KV error: ${err.message}`, err.cfErrors)
    return NextResponse.json(
      { error: 'storage_error', message: 'upstream KV failure' },
      { status: 502 },
    )
  }
  // eslint-disable-next-line no-console
  console.error('[paths api] unhandled', err)
  return NextResponse.json({ error: 'internal_error' }, { status: 500 })
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const siteParse = SiteIdSchema.safeParse(searchParams.get('site_id') ?? undefined)
  if (!siteParse.success) {
    return NextResponse.json(
      { error: 'invalid_query', message: 'site_id required' },
      { status: 400 },
    )
  }

  const ctx = await resolvePathTenantContext(request, siteParse.data)
  if (!isPathTenantContext(ctx)) return ctx

  try {
    const repo = createPathSetRepository()
    const pathSets = await repo.listPathSets(ctx.tenantId, ctx.siteId)
    return NextResponse.json(
      {
        tenant_id: ctx.tenantId,
        site_id: ctx.siteId,
        count: pathSets.length,
        pathSets,
      },
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

  const parsed = CreatePathSetBodySchema.safeParse(raw)
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

  const ctx = await resolvePathTenantContext(request, parsed.data.site_id)
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
      { error: 'forbidden', message: 'viewer は経路を作成できません' },
      { status: 403 },
    )
  }

  try {
    const repo = createPathSetRepository()
    const created = await repo.createPathSet({
      tenant_id: ctx.tenantId,
      site_id: ctx.siteId,
      name: parsed.data.name,
      description: parsed.data.description,
      trigger: parsed.data.trigger,
      branches: parsed.data.branches,
      created_by: ctx.userId,
    })
    return NextResponse.json(created, {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    return handleError(err)
  }
}
