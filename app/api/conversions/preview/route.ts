/**
 * CV定義 保存前プレビュー (ドライラン)
 *
 * docs/cv/CV_DEFINITIONS_DESIGN.md §5 / §6 フォームUX-4
 *
 * POST /api/conversions/preview?site_id=...&periodDays=...   body: { trigger, scope? }
 *
 * KVには一切書き込まず、指定した trigger/scope が期間内で何セッション一致するかを
 * computeCvStats の単発実行で返す。「この条件だと直近N日でMセッションがCVになります」表示用。
 *
 * レート制限: tenant単位 30回/分 (Redis fixed-window、magic-link と同パターン。fail-open)。
 * 権限: viewer は不可 (定義の作成/更新権限が無いのにプレビューだけ許すのは筋が悪い)。
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { getServerSession } from '@/lib/auth/server-session'
import { getClickHouseClient } from '@/lib/clickhouse'
import { redis } from '@/lib/redis'
import { canWriteScenario, normalizeRole } from '@/lib/scenarios/publish-rbac'
import {
  CV_STATS_DEFAULT_PERIOD_DAYS,
  CV_STATS_MAX_PERIOD_DAYS,
  computeCvStats,
} from '@/lib/conversions/stats-query'
import { isCvTenantContext, resolveCvTenantContext } from '@/lib/conversions/tenant-context'
import { cvScopeSchema, cvTriggerSchema } from '@/lib/conversions/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SiteIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)

const PeriodDaysSchema = z.coerce.number().int().min(1).max(CV_STATS_MAX_PERIOD_DAYS)

const PreviewBodySchema = z
  .object({
    trigger: cvTriggerSchema,
    scope: cvScopeSchema.optional(),
  })
  .strict()

const PREVIEW_RATE_LIMIT_PER_MIN = 30

async function isPreviewRateLimited(tenantId: string): Promise<boolean> {
  try {
    const client = redis()
    const key = `conversions:preview:rl:1m:${tenantId}`
    const count = await client.incr(key)
    if (count === 1) await client.expire(key, 60)
    return count > PREVIEW_RATE_LIMIT_PER_MIN
  } catch {
    // Redis 不達時は fail-open (UX優先、preview は non-persistent read-only なので許容)
    return false
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
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

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = PreviewBodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid_body',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      { status: 400 },
    )
  }

  const ctx = await resolveCvTenantContext(request, siteParse.data)
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
      { error: 'forbidden', message: 'viewer はプレビューできません' },
      { status: 403 },
    )
  }

  if (await isPreviewRateLimited(ctx.tenantId)) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'too many preview requests' },
      { status: 429 },
    )
  }

  try {
    const result = await computeCvStats(
      getClickHouseClient('analytics_reader'),
      [{ id: 'preview', cvKey: '__preview__', trigger: parsed.data.trigger, scope: parsed.data.scope }],
      { tenantId: ctx.tenantId, siteId: ctx.siteId, periodDays: periodDaysParse.data },
    )
    const row = result.rows[0]
    return NextResponse.json(
      {
        statsComputed: result.statsComputed,
        ...(result.reason ? { reason: result.reason } : {}),
        periodDays: periodDaysParse.data,
        cvSessions: row?.cvSessions ?? 0,
        cvEvents: row?.cvEvents ?? 0,
        supported: row?.supported ?? true,
        ...(row?.reason ? { unsupportedReason: row.reason } : {}),
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[conversions/preview api] unhandled', err)
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
