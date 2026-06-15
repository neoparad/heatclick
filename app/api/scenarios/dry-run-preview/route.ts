/**
 * POST /api/scenarios/dry-run-preview — 条件 AST の過去 events 再生 (M-Director Phase 2、2026-06-07)
 *
 * "この条件で過去 N 日にどれだけ session がマッチしたか" を返す server endpoint。
 * Owner / Marketer が scenario を保存する前に「効果がありそうか」を見るための insight 表示用。
 *
 * §3.8.1 / REQ-SEC-004: tenant_id は JWT 由来、site_id は JWT の site_ids 内のみ許可。
 * body から tenant_id を取らず、site_id は許可リスト照合する。
 *
 * Rate limit: NL→AST と同じ chat bucket (60 req/h/tenant) を共有。
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { checkChatRateLimit } from '@/lib/llm/chat-rate-limit'
import { runDryRunPreview } from '@/lib/scenarios/dry-run-preview'
import { resolveScenarioTenantContext } from '@/lib/scenarios/tenant-context'
import { ConditionNodeSchema, validateConditionAst } from '@/lib/scenarios/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SiteIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)

const BodySchema = z.object({
  site_id: SiteIdSchema,
  condition_ast: ConditionNodeSchema,
  days: z.number().int().min(1).max(30).optional(),
})

interface SuccessResponse {
  success: true
  data: Awaited<ReturnType<typeof runDryRunPreview>>
}

interface ErrorResponse {
  success: false
  error: { code: string; message: string }
}

export async function POST(request: NextRequest): Promise<NextResponse<SuccessResponse | ErrorResponse>> {
  // ── body parse ──
  let parsedBody: z.infer<typeof BodySchema>
  try {
    const raw = (await request.json()) as unknown
    parsedBody = BodySchema.parse(raw)
  } catch {
    return NextResponse.json<ErrorResponse>(
      { success: false, error: { code: 'INVALID_BODY', message: 'site_id + condition_ast は必須' } },
      { status: 400 },
    )
  }

  // Zod shape validation だけでは不十分。scenario persistence が要求する
  // semantic 制約 (allowed fields, max depth, max leaves) を server boundary で強制し、
  // 改ざん POST で深い AST / 大量 leaves を 5000 session 評価させられる DoS を遮断する。
  // (Codex T2 dual review 2026-06-07 指摘 E 反映)
  const astErrors = validateConditionAst(parsedBody.condition_ast)
  if (astErrors.length > 0) {
    return NextResponse.json<ErrorResponse>(
      {
        success: false,
        error: {
          code: 'INVALID_CONDITION_AST',
          message: astErrors.map((e) => e.message).join('; '),
        },
      },
      { status: 400 },
    )
  }

  // ── tenant + site 照合 (REQ-SEC-126: getServerSession 経由・失効照合済み。async) ──
  const tenantResult = await resolveScenarioTenantContext(request, parsedBody.site_id)
  if (tenantResult instanceof NextResponse) {
    return tenantResult as NextResponse<ErrorResponse>
  }

  // ── rate limit ──
  const rl = await checkChatRateLimit(tenantResult.tenantId)
  if (!rl.allowed) {
    const res = NextResponse.json<ErrorResponse>(
      { success: false, error: { code: 'RATE_LIMITED', message: 'hourly limit reached' } },
      { status: 429 },
    )
    res.headers.set('X-RateLimit-Limit', String(rl.limit))
    res.headers.set('X-RateLimit-Remaining', String(rl.remaining))
    res.headers.set('X-RateLimit-Reset', String(rl.resetTime))
    return res
  }

  // ── 実行 ──
  try {
    const result = await runDryRunPreview({
      tenantId: tenantResult.tenantId,
      siteId: tenantResult.siteId,
      conditionAst: parsedBody.condition_ast,
      days: parsedBody.days,
    })
    return NextResponse.json<SuccessResponse>({ success: true, data: result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    console.error(`[scenarios/dry-run-preview] internal error: ${msg}`)
    return NextResponse.json<ErrorResponse>(
      { success: false, error: { code: 'INTERNAL', message: '集計に失敗しました。時間をおいてお試しください。' } },
      { status: 500 },
    )
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST' } },
    { status: 405 },
  )
}
