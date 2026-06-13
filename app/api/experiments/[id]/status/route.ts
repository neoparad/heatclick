/**
 * POST /api/experiments/[id]/status — 実験 lifecycle 遷移 (宝プロジェクト 残タスク①)
 *
 * body: { action: 'start' | 'stop' | 'archive' }
 *   - start  : draft → running。locked_at を刻み taxonomy を凍結、window から end_at を導出。
 *              **owner / admin のみ** (計測開始 = 顧客サイトでの配信開始 = publish 相当、
 *              scenarios の live 昇格 RBAC と整合)。start_at はサーバー時刻 (body から受けない)。
 *   - stop   : running → stopped。member 以上 (公開停止は member 可の中庸ポリシーと整合)。
 *   - archive: {draft, stopped} → archived。member 以上。running は先に stop (409)。
 *
 * tenant_id は JWT 由来のみ。cross-tenant は 404。状態違反は 409。
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { PostgresExperimentStore } from '@/lib/experiments/postgres-store'
import {
  ExperimentNotFoundError,
  ExperimentStateError,
  ExperimentValidationError,
  createExperimentRepository,
} from '@/lib/experiments/repository'
import { getServerSession } from '@/lib/auth/server-session'
import { canWriteScenario, normalizeRole } from '@/lib/scenarios/publish-rbac'
import { isTenantContext, resolveScenarioTenantContext } from '@/lib/scenarios/tenant-context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ParamsSchema = z.object({ id: z.string().uuid() })
const SiteIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)
const BodySchema = z.object({ action: z.enum(['start', 'stop', 'archive']) }).strict()

export async function POST(
  request: NextRequest,
  ctx: { params: { id: string } },
): Promise<NextResponse> {
  const idParse = ParamsSchema.safeParse(ctx.params)
  if (!idParse.success) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })

  const { searchParams } = new URL(request.url)
  const siteParse = SiteIdSchema.safeParse(searchParams.get('site_id') ?? undefined)
  if (!siteParse.success) {
    return NextResponse.json({ error: 'invalid_query', message: 'site_id required' }, { status: 400 })
  }

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', message: "action must be 'start' | 'stop' | 'archive'" },
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
      { error: 'forbidden', message: 'viewer は実験の状態を変更できません' },
      { status: 403 },
    )
  }
  // start = 顧客サイトでの配信・計測開始 (publish 相当) → owner/admin のみ (REQ-SEC-010 整合)。
  if (parsed.data.action === 'start' && role !== 'owner' && role !== 'admin') {
    return NextResponse.json(
      { error: 'forbidden', message: '実験の開始 (running 昇格) は owner / admin のみ' },
      { status: 403 },
    )
  }

  try {
    const repo = createExperimentRepository({ store: new PostgresExperimentStore() })
    const { tenantId, siteId } = tenantCtx
    const id = idParse.data.id
    const result =
      parsed.data.action === 'start'
        ? await repo.start(tenantId, siteId, id, new Date().toISOString())
        : parsed.data.action === 'stop'
          ? await repo.stop(tenantId, siteId, id)
          : await repo.archive(tenantId, siteId, id)
    return NextResponse.json(result, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    if (err instanceof ExperimentStateError) {
      return NextResponse.json({ error: 'invalid_state', message: err.message }, { status: 409 })
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
    console.error('[experiments status api] unhandled', err)
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
}
