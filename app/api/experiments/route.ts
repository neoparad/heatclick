/**
 * /api/experiments — 標準実験 CRUD: list + create (宝プロジェクト 残タスク①)
 *
 * Endpoints:
 *   GET  /api/experiments?site_id=...
 *   POST /api/experiments  body: { site_id, name, url_pattern, taxonomy, pool_opt_in? }
 *
 * セキュリティ (§3.8.1 / REQ-SEC-004 同型):
 *   - middleware classify: api-tenant (JWT 必須)。tenant_id は JWT 由来のみ
 *     (resolveScenarioTenantContext、Layer2 失効照合込み)。body/query の tenant は無視。
 *   - site_id は JWT の site_ids メンバー必須 (403)。
 *   - RBAC: create は canWriteScenario (viewer 不可)。新規は常に status='draft'
 *     (repository が強制。running 昇格は /status の action='start'、owner/admin のみ)。
 *   - taxonomy は固定 enum (Zod LockedTaxonomySchema) — 自由記述は構造的に不可能。
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { PostgresExperimentStore } from '@/lib/experiments/postgres-store'
import {
  ExperimentValidationError,
  createExperimentRepository,
} from '@/lib/experiments/repository'
import { LockedTaxonomySchema } from '@/lib/experiments/types'
import { getServerSession } from '@/lib/auth/server-session'
import { canWriteScenario, normalizeRole } from '@/lib/scenarios/publish-rbac'
import { isTenantContext, resolveScenarioTenantContext } from '@/lib/scenarios/tenant-context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SiteIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)

const CreateBodySchema = z.object({
  site_id: SiteIdSchema,
  name: z.string().min(1).max(255),
  url_pattern: z.string().min(1).max(512).regex(/^\/[^\s]*$/),
  taxonomy: LockedTaxonomySchema,
  pool_opt_in: z.boolean().optional().default(false),
})

function makeRepo() {
  return createExperimentRepository({ store: new PostgresExperimentStore() })
}

function handleError(err: unknown): NextResponse {
  if (err instanceof ExperimentValidationError) {
    return NextResponse.json(
      { error: 'validation_failed', message: err.message, issues: err.issues },
      { status: 400 },
    )
  }
  // Postgres 不通 / registry 未配備 (dev 環境等) は 503 (内部詳細は出さない)。
  // eslint-disable-next-line no-console
  console.error('[experiments api] unhandled', err)
  return NextResponse.json({ error: 'unavailable' }, { status: 503 })
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const siteParse = SiteIdSchema.safeParse(searchParams.get('site_id') ?? undefined)
  if (!siteParse.success) {
    return NextResponse.json({ error: 'invalid_query', message: 'site_id required' }, { status: 400 })
  }

  const ctx = await resolveScenarioTenantContext(request, siteParse.data)
  if (!isTenantContext(ctx)) return ctx

  try {
    const experiments = await makeRepo().list(ctx.tenantId, ctx.siteId)
    return NextResponse.json(
      { tenant_id: ctx.tenantId, site_id: ctx.siteId, count: experiments.length, experiments },
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

  const ctx = await resolveScenarioTenantContext(request, parsed.data.site_id)
  if (!isTenantContext(ctx)) return ctx

  const session = await getServerSession()
  if (!session) {
    return NextResponse.json({ error: 'unauthorized', message: 'session required' }, { status: 401 })
  }
  const role = normalizeRole(session.user.role)
  if (!canWriteScenario(role)) {
    return NextResponse.json(
      { error: 'forbidden', message: 'viewer は実験を作成できません' },
      { status: 403 },
    )
  }

  try {
    const created = await makeRepo().create({
      tenant_id: ctx.tenantId,
      site_id: ctx.siteId,
      name: parsed.data.name,
      url_pattern: parsed.data.url_pattern,
      taxonomy: parsed.data.taxonomy,
      consent: { pool_opt_in: parsed.data.pool_opt_in, k_anonymity_min: 50 },
      created_by: ctx.userId,
    })
    return NextResponse.json(created, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return handleError(err)
  }
}
