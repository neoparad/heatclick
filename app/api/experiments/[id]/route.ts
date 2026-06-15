/**
 * /api/experiments/[id] — 標準実験 単体取得 + 更新 (宝プロジェクト 残タスク①)
 *
 * Endpoints:
 *   GET /api/experiments/[id]?site_id=...
 *   PUT /api/experiments/[id]?site_id=...  body: { name?, url_pattern?, taxonomy?, pool_opt_in? }
 *
 * 不変条件:
 *   - tenant_id は JWT 由来のみ。cross-tenant は repository 層で null → 404。
 *   - 事前登録 lock: running 以降の taxonomy/url_pattern 変更は repository が
 *     ExperimentLockError → 409 (status の変更は /status route のみ)。
 *   - RBAC: viewer は更新不可 (403)。
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { PostgresExperimentStore } from '@/lib/experiments/postgres-store'
import {
  ExperimentLockError,
  ExperimentNotFoundError,
  ExperimentValidationError,
  createExperimentRepository,
} from '@/lib/experiments/repository'
import { LockedTaxonomySchema, RenderConfigSchema } from '@/lib/experiments/types'
import { getServerSession } from '@/lib/auth/server-session'
import { canWriteScenario, normalizeRole } from '@/lib/scenarios/publish-rbac'
import { isTenantContext, resolveScenarioTenantContext } from '@/lib/scenarios/tenant-context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ParamsSchema = z.object({ id: z.string().uuid() })
const SiteIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)

const UpdateBodySchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    url_pattern: z.string().min(1).max(512).regex(/^\/[^\s]*$/).optional(),
    taxonomy: LockedTaxonomySchema.optional(),
    pool_opt_in: z.boolean().optional(),
    // M6: locked field (running 以降の変更は repository が ExperimentLockError → 409)
    render_config: RenderConfigSchema.nullable().optional(),
  })
  .strict()

function makeRepo() {
  return createExperimentRepository({ store: new PostgresExperimentStore() })
}

function handleError(err: unknown): NextResponse {
  if (err instanceof ExperimentLockError) {
    return NextResponse.json(
      { error: 'locked', message: 'running 以降は taxonomy / url_pattern を変更できません (事前登録)' },
      { status: 409 },
    )
  }
  if (err instanceof ExperimentNotFoundError) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (err instanceof ExperimentValidationError) {
    return NextResponse.json(
      { error: 'validation_failed', message: err.message, issues: err.issues },
      { status: 400 },
    )
  }
  // eslint-disable-next-line no-console
  console.error('[experiments api] unhandled', err)
  return NextResponse.json({ error: 'unavailable' }, { status: 503 })
}

function parseCommon(request: NextRequest, params: { id: string }) {
  const idParse = ParamsSchema.safeParse(params)
  const { searchParams } = new URL(request.url)
  const siteParse = SiteIdSchema.safeParse(searchParams.get('site_id') ?? undefined)
  return { idParse, siteParse }
}

export async function GET(
  request: NextRequest,
  ctx: { params: { id: string } },
): Promise<NextResponse> {
  const { idParse, siteParse } = parseCommon(request, ctx.params)
  if (!idParse.success) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  if (!siteParse.success) {
    return NextResponse.json({ error: 'invalid_query', message: 'site_id required' }, { status: 400 })
  }

  const tenantCtx = await resolveScenarioTenantContext(request, siteParse.data)
  if (!isTenantContext(tenantCtx)) return tenantCtx

  try {
    const experiment = await makeRepo().get(tenantCtx.tenantId, tenantCtx.siteId, idParse.data.id)
    if (!experiment) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return NextResponse.json(experiment, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return handleError(err)
  }
}

export async function PUT(
  request: NextRequest,
  ctx: { params: { id: string } },
): Promise<NextResponse> {
  const { idParse, siteParse } = parseCommon(request, ctx.params)
  if (!idParse.success) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  if (!siteParse.success) {
    return NextResponse.json({ error: 'invalid_query', message: 'site_id required' }, { status: 400 })
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
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      { status: 400 },
    )
  }

  const tenantCtx = await resolveScenarioTenantContext(request, siteParse.data)
  if (!isTenantContext(tenantCtx)) return tenantCtx

  const session = await getServerSession()
  if (!session) {
    return NextResponse.json({ error: 'unauthorized', message: 'session required' }, { status: 401 })
  }
  const role = normalizeRole(session.user.role)
  if (!canWriteScenario(role)) {
    return NextResponse.json(
      { error: 'forbidden', message: 'viewer は実験を更新できません' },
      { status: 403 },
    )
  }

  try {
    const repo = makeRepo()

    // pool 同意の遷移ルール (Codex MEDIUM: 結果を見てからの遅延 opt-in はプール汚染バイアス):
    //   true → false (撤回) はいつでも可。false → true (参加) は draft のみ。
    if (parsed.data.pool_opt_in === true) {
      const existing = await repo.get(tenantCtx.tenantId, tenantCtx.siteId, idParse.data.id)
      if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 })
      if (!existing.consent.pool_opt_in && existing.status !== 'draft') {
        return NextResponse.json(
          {
            error: 'consent_locked',
            message: 'プール参加 (opt-in) は実験開始前 (draft) のみ可能です。撤回はいつでもできます。',
          },
          { status: 409 },
        )
      }
    }

    const updated = await repo.update(tenantCtx.tenantId, tenantCtx.siteId, idParse.data.id, {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.url_pattern !== undefined ? { url_pattern: parsed.data.url_pattern } : {}),
      ...(parsed.data.taxonomy !== undefined ? { taxonomy: parsed.data.taxonomy } : {}),
      ...(parsed.data.pool_opt_in !== undefined
        ? { consent: { pool_opt_in: parsed.data.pool_opt_in, k_anonymity_min: 50 } }
        : {}),
      ...(parsed.data.render_config !== undefined ? { render_config: parsed.data.render_config } : {}),
    })
    return NextResponse.json(updated, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return handleError(err)
  }
}
