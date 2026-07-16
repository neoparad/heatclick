/**
 * CV定義 CRUD: get + update + delete (by id)
 *
 * docs/cv/CV_DEFINITIONS_DESIGN.md §5
 *
 * Endpoints:
 *   GET    /api/conversions/[id]?site_id=...&periodDays=...
 *   PUT    /api/conversions/[id]?site_id=...   body: partial update (+ optional `version` for
 *          best-effort 楽観ロック — 不一致は 409 version_conflict)
 *   DELETE /api/conversions/[id]?site_id=...
 *
 * REQ-SEC-004: tenant は JWT 由来、site_id は JWT site_ids メンバー必須。row 所有権は
 * repository が再検証 (CvDefinitionNotFoundError → 404)。viewer は書込み/削除不可 (403)。
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { getServerSession } from '@/lib/auth/server-session'
import { getClickHouseClient } from '@/lib/clickhouse'
import { canWriteScenario, normalizeRole } from '@/lib/scenarios/publish-rbac'
import { CloudflareKvError } from '@/lib/scenarios/kv-storage'
import {
  CvDefinitionLimitExceededError,
  CvDefinitionNotFoundError,
  CvDefinitionValidationError,
  CvDefinitionVersionConflictError,
  createCvDefinitionRepository,
} from '@/lib/conversions/repository'
import {
  CV_STATS_DEFAULT_PERIOD_DAYS,
  CV_STATS_MAX_PERIOD_DAYS,
  computeCvStats,
} from '@/lib/conversions/stats-query'
import { isCvTenantContext, resolveCvTenantContext } from '@/lib/conversions/tenant-context'
import { CV_KEY_PATTERN, cvScopeSchema, cvTriggerSchema, cvValueSchema } from '@/lib/conversions/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SiteIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)

const PeriodDaysSchema = z.coerce.number().int().min(1).max(CV_STATS_MAX_PERIOD_DAYS)

const UpdateBodySchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    cvKey: z.string().regex(CV_KEY_PATTERN).optional(),
    description: z.string().max(500).optional(),
    enabled: z.boolean().optional(),
    trigger: cvTriggerSchema.optional(),
    scope: cvScopeSchema.optional(),
    value: cvValueSchema.optional(),
    /** best-effort 楽観ロック。指定時 KV 上の現行 version と不一致なら 409 */
    version: z.number().int().min(1).optional(),
  })
  .strict()

function readSiteId(request: NextRequest): string | null {
  const v = new URL(request.url).searchParams.get('site_id')
  const parsed = SiteIdSchema.safeParse(v ?? undefined)
  return parsed.success ? parsed.data : null
}

function handleError(err: unknown): NextResponse {
  if (err instanceof CvDefinitionValidationError) {
    return NextResponse.json(
      { error: 'validation_failed', message: err.message, issues: err.issues },
      { status: 400 },
    )
  }
  if (err instanceof CvDefinitionVersionConflictError) {
    return NextResponse.json({ error: 'version_conflict', message: err.message }, { status: 409 })
  }
  if (err instanceof CvDefinitionLimitExceededError) {
    return NextResponse.json({ error: 'limit_exceeded', message: err.message }, { status: 409 })
  }
  if (err instanceof CvDefinitionNotFoundError) {
    return NextResponse.json({ error: 'not_found', message: err.message }, { status: 404 })
  }
  if (err instanceof CloudflareKvError) {
    // eslint-disable-next-line no-console
    console.error(`[conversions/[id] api] KV error: ${err.message}`, err.cfErrors)
    return NextResponse.json(
      { error: 'storage_error', message: 'upstream KV failure' },
      { status: 502 },
    )
  }
  // eslint-disable-next-line no-console
  console.error('[conversions/[id] api] unhandled', err)
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
  const { searchParams } = new URL(request.url)
  const periodDaysParse = PeriodDaysSchema.safeParse(
    searchParams.get('periodDays') ?? CV_STATS_DEFAULT_PERIOD_DAYS,
  )
  if (!periodDaysParse.success) {
    return NextResponse.json(
      { error: 'invalid_query', message: `periodDays must be an integer from 1 to ${CV_STATS_MAX_PERIOD_DAYS}` },
      { status: 400 },
    )
  }

  const ctx = await resolveCvTenantContext(request, siteId)
  if (!isCvTenantContext(ctx)) return ctx

  try {
    const repo = createCvDefinitionRepository()
    const found = await repo.getCvDefinition(ctx.tenantId, ctx.siteId, params.id)
    if (!found) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }

    let stats: { cvSessions: number; cvEvents: number; supported: boolean; reason?: string } = {
      cvSessions: 0,
      cvEvents: 0,
      supported: true,
    }
    let statsComputed = true
    let statsReason: string | undefined
    try {
      const result = await computeCvStats(
        getClickHouseClient('analytics_reader'),
        [{ id: found.id, cvKey: found.cvKey, trigger: found.trigger, scope: found.scope }],
        { tenantId: ctx.tenantId, siteId: ctx.siteId, periodDays: periodDaysParse.data },
      )
      statsComputed = result.statsComputed
      statsReason = result.reason
      stats = result.rows[0] ?? stats
    } catch {
      // getClickHouseClient 自体が throw するケース (env未設定等)。定義は返すが統計は未計算にする。
      statsComputed = false
      statsReason = 'clickhouse_client_init_failed'
      // eslint-disable-next-line no-console
      console.error('[conversions/[id] api] stats client initialization failed')
    }

    return NextResponse.json(
      {
        ...found,
        periodDays: periodDaysParse.data,
        statsComputed,
        ...(statsReason ? { statsReason } : {}),
        stats,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    )
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
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      { status: 400 },
    )
  }

  const ctx = await resolveCvTenantContext(request, siteId)
  if (!isCvTenantContext(ctx)) return ctx

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
      { error: 'forbidden', message: 'viewer はCV定義を更新できません' },
      { status: 403 },
    )
  }

  const { version: expectedVersion, ...patch } = parsed.data

  try {
    const repo = createCvDefinitionRepository()
    const updated = await repo.updateCvDefinition(ctx.tenantId, ctx.siteId, params.id, patch, {
      expectedVersion,
    })
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
  const ctx = await resolveCvTenantContext(request, siteId)
  if (!isCvTenantContext(ctx)) return ctx

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
      { error: 'forbidden', message: 'viewer はCV定義を削除できません' },
      { status: 403 },
    )
  }

  try {
    const repo = createCvDefinitionRepository()
    const existed = await repo.deleteCvDefinition(ctx.tenantId, ctx.siteId, params.id)
    if (!existed) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    return NextResponse.json({ deleted: true, id: params.id }, { status: 200 })
  } catch (err) {
    return handleError(err)
  }
}
