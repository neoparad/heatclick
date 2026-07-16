/**
 * CV定義 CRUD: list + create
 *
 * docs/cv/CV_DEFINITIONS_DESIGN.md §5
 *
 * Endpoints:
 *   GET  /api/conversions?site_id=...&periodDays=...   (既定30, 1-365)
 *   POST /api/conversions?  body: CreateCvDefinitionBody (site_id は body に埋め込み)
 *
 * REQ-SEC-004 (tenant isolation, §3.8.1):
 *   - tenant_id / user_id は getServerSession() 由来のみ
 *   - site_id は唯一の caller-controlled 入力で、JWT site_ids メンバー必須 (resolveCvTenantContext)
 *
 * GET は compute-on-read で各定義の cvSessions/cvEvents を1スキャンで付与する
 * (computeCvStats — 定義ごとにクエリを撃たない)。CH失敗時は定義のみ返し statsComputed:false
 * を可視化する (捏造しない・dummyに落とさない)。
 *
 * 権限: viewer は作成不可 (403)。owner/admin/member は作成可。
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
  createCvDefinitionRepository,
} from '@/lib/conversions/repository'
import {
  CV_STATS_DEFAULT_PERIOD_DAYS,
  CV_STATS_MAX_PERIOD_DAYS,
  computeCvStats,
} from '@/lib/conversions/stats-query'
import { isCvTenantContext, resolveCvTenantContext } from '@/lib/conversions/tenant-context'
import { createCvDefinitionBodySchema } from '@/lib/conversions/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SiteIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)

const PeriodDaysSchema = z.coerce.number().int().min(1).max(CV_STATS_MAX_PERIOD_DAYS)

const CreateBodySchema = createCvDefinitionBodySchema.extend({ site_id: SiteIdSchema })

function handleError(err: unknown): NextResponse {
  if (err instanceof CvDefinitionValidationError) {
    return NextResponse.json(
      { error: 'validation_failed', message: err.message, issues: err.issues },
      { status: 400 },
    )
  }
  if (err instanceof CvDefinitionLimitExceededError) {
    return NextResponse.json({ error: 'limit_exceeded', message: err.message }, { status: 409 })
  }
  if (err instanceof CvDefinitionNotFoundError) {
    return NextResponse.json({ error: 'not_found', message: err.message }, { status: 404 })
  }
  if (err instanceof CloudflareKvError) {
    // eslint-disable-next-line no-console
    console.error(`[conversions api] KV error: ${err.message}`, err.cfErrors)
    return NextResponse.json(
      { error: 'storage_error', message: 'upstream KV failure' },
      { status: 502 },
    )
  }
  // eslint-disable-next-line no-console
  console.error('[conversions api] unhandled', err)
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
  const periodDaysParse = PeriodDaysSchema.safeParse(
    searchParams.get('periodDays') ?? CV_STATS_DEFAULT_PERIOD_DAYS,
  )
  if (!periodDaysParse.success) {
    return NextResponse.json(
      { error: 'invalid_query', message: `periodDays must be an integer from 1 to ${CV_STATS_MAX_PERIOD_DAYS}` },
      { status: 400 },
    )
  }

  const ctx = await resolveCvTenantContext(request, siteParse.data)
  if (!isCvTenantContext(ctx)) return ctx

  try {
    const repo = createCvDefinitionRepository()
    const definitions = await repo.listCvDefinitions(ctx.tenantId, ctx.siteId)

    let statsComputed = true
    let statsReason: string | undefined
    let statsById = new Map<
      string,
      { cvSessions: number; cvEvents: number; supported: boolean; reason?: string }
    >()

    if (definitions.length > 0) {
      const result = await computeCvStats(
        getClickHouseClient('analytics_reader'),
        definitions.map((d) => ({ id: d.id, cvKey: d.cvKey, trigger: d.trigger, scope: d.scope })),
        { tenantId: ctx.tenantId, siteId: ctx.siteId, periodDays: periodDaysParse.data },
      )
      statsComputed = result.statsComputed
      statsReason = result.reason
      statsById = new Map(result.rows.map((r) => [r.defId, r]))
    }

    return NextResponse.json(
      {
        tenant_id: ctx.tenantId,
        site_id: ctx.siteId,
        periodDays: periodDaysParse.data,
        statsComputed,
        ...(statsReason ? { statsReason } : {}),
        count: definitions.length,
        definitions: definitions.map((d) => ({
          ...d,
          stats: statsById.get(d.id) ?? { cvSessions: 0, cvEvents: 0, supported: true },
        })),
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

  const ctx = await resolveCvTenantContext(request, parsed.data.site_id)
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
      { error: 'forbidden', message: 'viewer はCV定義を作成できません' },
      { status: 403 },
    )
  }

  try {
    const repo = createCvDefinitionRepository()
    const created = await repo.createCvDefinition({
      tenant_id: ctx.tenantId,
      site_id: ctx.siteId,
      name: parsed.data.name,
      cvKey: parsed.data.cvKey,
      description: parsed.data.description,
      enabled: parsed.data.enabled,
      trigger: parsed.data.trigger,
      scope: parsed.data.scope,
      value: parsed.data.value,
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
