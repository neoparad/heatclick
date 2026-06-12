/**
 * POST /api/scenarios/nl-to-ast — 自然言語 → 条件 AST 変換 (M-Director Phase 2、2026-06-07)
 *
 * scenario 新規作成画面の自然言語入力 box から呼ばれる server endpoint。
 * Claude Haiku 4.5 (Vercel AI Gateway 経由) で flat AST を生成、TS 側で CompositeNode 化。
 *
 * §3.8.1 / REQ-SEC-004 整合:
 *   - tenant_id / site_id は middleware 注入 JWT 由来 (request body は無視)
 *   - LLM には tenant_id / site_id / 顧客データを渡さない (lib/scenarios/nl-to-ast.ts 厳守)
 *   - 出力 AST は server-side で Zod validate (ConditionNodeSchema)
 *   - Evidence Level は常に 'inferred' (D-07)
 *
 * Rate limit: chat と同じ tenant あたり 60 req/h を共有 (LLM コスト面で安全側)。
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { checkChatRateLimit } from '@/lib/llm/chat-rate-limit'
import {
  NL_INPUT_MAX_CHARS,
  NlInputError,
  naturalLanguageToConditionAst,
  type NlToAstResult,
} from '@/lib/scenarios/nl-to-ast'
import { validateConditionAst, ConditionNodeSchema } from '@/lib/scenarios/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const BodySchema = z.object({
  text: z.string().min(1).max(NL_INPUT_MAX_CHARS),
})

interface SuccessResponse {
  success: true
  data: NlToAstResult & {
    validation: { errors: ReturnType<typeof validateConditionAst> }
  }
}

interface ErrorResponse {
  success: false
  error: { code: string; message: string }
}

export async function POST(request: NextRequest): Promise<NextResponse<SuccessResponse | ErrorResponse>> {
  // ── tenant resolution (JWT 由来のみ、body の tenant_id 完全無視) ──
  const tenantId = request.headers.get('x-tenant-id')
  if (!tenantId) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAUTHORIZED', message: 'tenant context missing' } },
      { status: 401 },
    )
  }

  // ── rate limit ──
  const rl = await checkChatRateLimit(tenantId)
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

  // ── body parse ──
  let parsedBody: z.infer<typeof BodySchema>
  try {
    const raw = (await request.json()) as unknown
    parsedBody = BodySchema.parse(raw)
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_BODY', message: 'text field is required (1-500 chars)' } },
      { status: 400 },
    )
  }

  // ── nl → ast ──
  try {
    const result = await naturalLanguageToConditionAst(parsedBody.text)

    // double check: returned AST must pass Zod schema (catches LLM hallucinations the
    // generateObject schema somehow missed).
    const zodCheck = ConditionNodeSchema.safeParse(result.ast)
    if (!zodCheck.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_AST_OUTPUT',
            message: 'LLM の出力が schema を満たしませんでした。再試行してください。',
          },
        },
        { status: 422 },
      )
    }

    const validation = validateConditionAst(result.ast)

    return NextResponse.json({
      success: true,
      data: {
        ...result,
        validation: { errors: validation },
      },
    })
  } catch (err) {
    if (err instanceof NlInputError) {
      return NextResponse.json(
        { success: false, error: { code: err.code === 'empty' ? 'INVALID_BODY' : 'TOO_LONG', message: err.message } },
        { status: 400 },
      )
    }
    const msg = err instanceof Error ? err.message : 'unknown'
    console.error(`[scenarios/nl-to-ast] internal error: ${msg}`)
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL', message: '変換に失敗しました。時間をおいてお試しください。' } },
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
