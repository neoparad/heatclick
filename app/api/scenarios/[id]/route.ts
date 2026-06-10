/**
 * M-Director Stage 1 (続 M-7/M-8) — Scenarios CRUD: get / update / delete
 *
 * Endpoints:
 *   GET    /api/scenarios/[id]?site_id=...
 *   PUT    /api/scenarios/[id]?site_id=...  body: UpdateScenarioInput
 *   DELETE /api/scenarios/[id]?site_id=...
 *
 * REQ-SEC-004 (tenant isolation, §3.8.1):
 *   - tenant_id is derived ONLY from the middleware-injected, JWT-verified `x-tenant-id`
 *     header. Any tenant_id in the query is IGNORED (no `linkth_internal` default).
 *   - site_id is the only caller-controlled selector and MUST be a member of the JWT's
 *     `x-site-ids`; otherwise 403.
 *   - The repository additionally re-verifies the loaded row's tenant_id/site_id before
 *     returning/mutating/deleting (assertScenarioOwnership), so a key/data drift cannot
 *     leak across tenants.
 *
 * Reference: lib/scenarios/tenant-context.ts, lib/scenarios/repository.ts
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import {
  HtmlSanitizationError,
  ScenarioForbiddenError,
  ScenarioNotFoundError,
  ScenarioValidationError,
  createScenarioRepository,
} from '@/lib/scenarios/repository'
import { CloudflareKvError } from '@/lib/scenarios/kv-storage'
import { getServerSession } from '@/lib/auth/server-session'
import {
  canPublish,
  canTransitionToStatus,
  canWriteScenario,
  isPublishStatus,
  normalizeRole,
  patchMutatesDelivery,
} from '@/lib/scenarios/publish-rbac'
import {
  ConditionNodeSchema,
  EVIDENCE_LEVELS,
  FrequencyCapSchema,
  ScheduleSchema,
  SCENARIO_STATUSES,
  VariantsSchema,
} from '@/lib/scenarios/types'
import {
  type ScenarioTenantContext,
  isTenantContext,
  resolveScenarioTenantContext,
} from '@/lib/scenarios/tenant-context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SiteIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)

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
    // Phase 2.1 additive fields (Codex T2 dual review 指摘 A 反映)
    frequency_cap: FrequencyCapSchema.nullable().optional(),
    schedule: ScheduleSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'body must contain at least one field' })

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
  if (err instanceof ScenarioForbiddenError) {
    // REQ-SEC-010: authoritative authorize フックによる拒否 (TOCTOU close)。
    return NextResponse.json({ error: 'forbidden', message: err.message }, { status: 403 })
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

/**
 * Resolve tenant context for an [id] request: site_id from query, validated against the
 * JWT's site_ids; tenant_id from the JWT header (REQ-SEC-004).
 */
function resolveContext(request: NextRequest): ScenarioTenantContext | NextResponse {
  const { searchParams } = new URL(request.url)
  const siteParse = SiteIdSchema.safeParse(searchParams.get('site_id') ?? undefined)
  if (!siteParse.success) {
    return NextResponse.json({ error: 'invalid_query', message: 'site_id required' }, { status: 400 })
  }
  return resolveScenarioTenantContext(request, siteParse.data)
}

export async function GET(
  request: NextRequest,
  routeCtx: { params: { id: string } },
): Promise<NextResponse> {
  const paramsParsed = ParamsSchema.safeParse(routeCtx.params)
  if (!paramsParsed.success) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  }
  const ctx = resolveContext(request)
  if (!isTenantContext(ctx)) return ctx

  try {
    const repo = createScenarioRepository()
    const scenario = await repo.getScenario(ctx.tenantId, ctx.siteId, paramsParsed.data.id)
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
  routeCtx: { params: { id: string } },
): Promise<NextResponse> {
  const paramsParsed = ParamsSchema.safeParse(routeCtx.params)
  if (!paramsParsed.success) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  }
  const ctx = resolveContext(request)
  if (!isTenantContext(ctx)) return ctx

  // REQ-SEC-010 (HIGH): publish RBAC。
  // role は JWT cookie 由来 (middleware は x-user-role を inject しないため server-session が SSOT)。
  // session / 書込み権限は body を読む前に判定する (Codex dual review LOW#3: 未認可 writer が
  // body validation の差 (400) で scenario の素性を推し量れないよう、403 を先に返す)。
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
      { error: 'forbidden', message: 'viewer は scenario を更新できません' },
      { status: 403 },
    )
  }

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

  // publish 系 status (live / preview) への遷移は Owner / Admin のみ。
  if (bodyParsed.data.status !== undefined && !canTransitionToStatus(role, bodyParsed.data.status)) {
    return NextResponse.json(
      {
        error: 'forbidden',
        message: `role=${role} は status='${bodyParsed.data.status}' への遷移権限がありません (Owner / Admin が必要)`,
      },
      { status: 403 },
    )
  }

  // REQ-SEC-010 (HIGH, Codex dual review): 非 publisher (member) は配信中 (live / preview)
  // scenario の「配信内容」(variants / condition_ast / frequency_cap / schedule) を改変できない。
  // status を変えずに live バナーの中身だけ差し替える「実質 publish」経路を server 境界で塞ぐ。
  // 編集するには先に Owner / Admin が pause / draft へ落とす必要がある。
  const guardsDelivery =
    !canPublish(role) && patchMutatesDelivery(bodyParsed.data as Record<string, unknown>)

  const repo = createScenarioRepository()
  try {
    // (1) fast-path: 編集開始時点で既に配信中なら早期 403 (UX)。
    if (guardsDelivery) {
      const current = await repo.getScenario(ctx.tenantId, ctx.siteId, paramsParsed.data.id)
      if (!current) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 })
      }
      if (isPublishStatus(current.status)) {
        return NextResponse.json(
          { error: 'forbidden', message: liveContentForbiddenMessage(role, current.status) },
          { status: 403 },
        )
      }
    }

    // (2) authoritative: updateScenario が書込みに使う read と同じ row で再判定し、preflight
    // 通過後に Owner が publish する TOCTOU を塞ぐ (Codex 再レビュー指摘)。
    const updated = await repo.updateScenario(
      ctx.tenantId,
      ctx.siteId,
      paramsParsed.data.id,
      bodyParsed.data,
      guardsDelivery
        ? {
            authorize: (existing) => {
              if (isPublishStatus(existing.status)) {
                throw new ScenarioForbiddenError(liveContentForbiddenMessage(role, existing.status))
              }
            },
          }
        : {},
    )
    return NextResponse.json(updated, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return handleError(err)
  }
}

/**
 * REQ-SEC-010: 配信中 scenario のコンテンツ改変拒否メッセージ (preflight と authorize で共有)。
 */
function liveContentForbiddenMessage(role: string, status: string): string {
  return (
    `role=${role} は配信中 (status='${status}') の scenario の配信内容を変更できません。` +
    `先に Owner / Admin が pause してから編集してください`
  )
}

export async function DELETE(
  request: NextRequest,
  routeCtx: { params: { id: string } },
): Promise<NextResponse> {
  const paramsParsed = ParamsSchema.safeParse(routeCtx.params)
  if (!paramsParsed.success) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  }
  const ctx = resolveContext(request)
  if (!isTenantContext(ctx)) return ctx

  // REQ-SEC-010 (HIGH): publish RBAC。session 不在 → 401。viewer は削除不可 (403)。
  // member / admin / owner は自テナント内の scenario を削除可。
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
      { error: 'forbidden', message: 'viewer は scenario を削除できません' },
      { status: 403 },
    )
  }

  try {
    const repo = createScenarioRepository()
    const removed = await repo.deleteScenario(ctx.tenantId, ctx.siteId, paramsParsed.data.id)
    if (!removed) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return handleError(err)
  }
}
