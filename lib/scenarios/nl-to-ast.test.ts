/**
 * lib/scenarios/nl-to-ast.test.ts — NL→AST unit tests (stub mode only、2026-06-07)
 *
 * LLM (ai-gateway) 経路は実 API 呼出を伴うため本 file ではテストしない。
 * stub の決定性 + finalizeResult の正規化 + 制約 (空入力/長すぎ/Zod 整合) のみ検証。
 */

import {
  NL_INPUT_MAX_CHARS,
  NlInputError,
  naturalLanguageToConditionAst,
  __test__,
} from './nl-to-ast'
import { ConditionNodeSchema, validateConditionAst } from './types'

const { localKeywordStub, finalizeResult, makeFlatSchema, buildSystemPrompt } = __test__

describe('naturalLanguageToConditionAst (stub mode)', () => {
  beforeAll(() => {
    // LLM_PROVIDER_MODE 未設定 → stub 経路を確実にする
    delete process.env.LLM_PROVIDER_MODE
    delete process.env.AI_GATEWAY_API_KEY
  })

  it('rejects empty input', async () => {
    await expect(naturalLanguageToConditionAst('')).rejects.toBeInstanceOf(NlInputError)
    await expect(naturalLanguageToConditionAst('   ')).rejects.toBeInstanceOf(NlInputError)
  })

  it('rejects too long input', async () => {
    const tooLong = 'a'.repeat(NL_INPUT_MAX_CHARS + 1)
    await expect(naturalLanguageToConditionAst(tooLong)).rejects.toBeInstanceOf(NlInputError)
  })

  it('returns stub result with valid AST for unknown input', async () => {
    const result = await naturalLanguageToConditionAst('意味不明な要件 12345')
    expect(result.source).toBe('stub')
    expect(result.evidence_level).toBe('inferred')
    expect(result.confidence).toBe('low')
    // 必ず最低 1 leaf を返す (空 AST にしない)
    expect(result.ast.children.length).toBeGreaterThanOrEqual(1)
    // Zod validate も通る
    const parsed = ConditionNodeSchema.safeParse(result.ast)
    expect(parsed.success).toBe(true)
    // user に「抽出できなかった」を伝える warning がある
    expect(result.warnings.some((w) => w.includes('開発モード') || w.includes('Visual Builder'))).toBe(true)
  })

  it('extracts is_first_visit + session_duration_sec + visited_paths from JP keywords', async () => {
    const result = await naturalLanguageToConditionAst(
      '初回訪問で 2 分以上いてカートに行ってないユーザー',
    )
    const leaves = result.ast.children
    expect(leaves.length).toBeGreaterThanOrEqual(3)
    // 初回訪問
    expect(leaves).toContainEqual(
      expect.objectContaining({ field: 'is_first_visit', op: 'EQ', value: true }),
    )
    // 2 分以上 → 120 秒以上
    expect(leaves).toContainEqual(
      expect.objectContaining({ field: 'session_duration_sec', op: 'GTE', value: 120 }),
    )
    // カート未訪問
    expect(leaves).toContainEqual(
      expect.objectContaining({ field: 'visited_paths', op: 'NOT_VISITED', value: '/cart' }),
    )
    // group_op は AND (デフォルト)
    expect(result.ast.op).toBe('AND')
  })

  it('switches group_op to OR on "または"', async () => {
    const result = await naturalLanguageToConditionAst('モバイル または PC ユーザー')
    expect(result.ast.op).toBe('OR')
  })

  it('produces device_type=mobile from "スマホ"', async () => {
    const result = await naturalLanguageToConditionAst('スマホで来た人')
    expect(result.ast.children).toContainEqual(
      expect.objectContaining({ field: 'device_type', value: 'mobile' }),
    )
  })

  it('always passes ConditionNodeSchema + validateConditionAst', async () => {
    const samples = [
      '初回訪問で 1 分以上のオーガニック流入ユーザー',
      'リピーター かつ カートまで行った人',
      'モバイル PC タブレット 全部',
      'なんでもいい',
    ]
    for (const text of samples) {
      const result = await naturalLanguageToConditionAst(text)
      expect(ConditionNodeSchema.safeParse(result.ast).success).toBe(true)
      expect(validateConditionAst(result.ast)).toEqual([])
    }
  })
})

describe('finalizeResult (sanitization)', () => {
  it('drops unknown field with warning', () => {
    const flat = {
      group_op: 'AND' as const,
      leaves: [
        { field: 'age' as never, op: 'EQ' as const, value: 30 }, // 未収録
        { field: 'utm_source' as const, op: 'EQ' as const, value: 'google' },
      ],
      confidence: 'medium' as const,
      reasoning: 'test',
      warnings: [],
    }
    const result = finalizeResult(flat as never, 'ai-gateway')
    expect(result.ast.children.length).toBe(1)
    expect(result.ast.children[0]).toEqual(
      expect.objectContaining({ field: 'utm_source', value: 'google' }),
    )
    expect(result.warnings.some((w) => w.includes('age'))).toBe(true)
  })

  it('coerces IN value to array', () => {
    const flat = {
      group_op: 'AND' as const,
      leaves: [{ field: 'utm_source' as const, op: 'IN' as const, value: 'google, yahoo' }],
      confidence: 'high' as const,
      reasoning: 'test',
      warnings: [],
    }
    const result = finalizeResult(flat as never, 'ai-gateway')
    expect(result.ast.children[0]).toEqual(
      expect.objectContaining({ field: 'utm_source', op: 'IN', value: ['google', 'yahoo'] }),
    )
  })

  it('sets EXISTS value to empty string for AST compatibility', () => {
    const flat = {
      group_op: 'AND' as const,
      leaves: [{ field: 'utm_source' as const, op: 'EXISTS' as const, value: null }],
      confidence: 'high' as const,
      reasoning: 'test',
      warnings: [],
    }
    const result = finalizeResult(flat as never, 'ai-gateway')
    // value は undefined → finalize で '' に補正される (LeafComparison value はオプショナルではない)
    expect(result.ast.children[0]).toEqual(
      expect.objectContaining({ field: 'utm_source', op: 'EXISTS', value: '' }),
    )
  })

  it('falls back to single default leaf when all dropped', () => {
    const flat = {
      group_op: 'AND' as const,
      leaves: [{ field: 'nonexistent' as never, op: 'BOGUS' as never, value: '' }],
      confidence: 'low' as const,
      reasoning: 'test',
      warnings: [],
    }
    const result = finalizeResult(flat as never, 'ai-gateway')
    expect(result.ast.children.length).toBe(1)
    expect(result.warnings.length).toBeGreaterThanOrEqual(1)
  })
})

describe('localKeywordStub (deterministic)', () => {
  it('is idempotent for same input', () => {
    const a = localKeywordStub('初回訪問で 1 分以上')
    const b = localKeywordStub('初回訪問で 1 分以上')
    expect(a.ast).toEqual(b.ast)
    expect(a.confidence).toBe(b.confidence)
  })
})

describe('server context field rejection (Codex T1 review 2026-06-07)', () => {
  it('finalizeResult drops tenant_id / site_id / visitor_id / session_id with warnings', () => {
    const flat = {
      group_op: 'AND' as const,
      leaves: [
        { field: 'tenant_id' as never, op: 'EQ' as const, value: 'linkth_internal' },
        { field: 'site_id' as never, op: 'EQ' as const, value: 'CIP_xxx' },
        { field: 'visitor_id' as never, op: 'EQ' as const, value: 'v1' },
        { field: 'session_id' as never, op: 'EQ' as const, value: 's1' },
        { field: 'utm_source' as const, op: 'EQ' as const, value: 'google' },
      ],
      confidence: 'medium' as const,
      reasoning: 'test',
      warnings: [],
    }
    const result = finalizeResult(flat as never, 'ai-gateway')
    expect(result.ast.children.length).toBe(1)
    expect(result.ast.children[0]).toEqual(
      expect.objectContaining({ field: 'utm_source', value: 'google' }),
    )
    const dropMessages = result.warnings.join(' / ')
    expect(dropMessages).toMatch(/tenant_id/)
    expect(dropMessages).toMatch(/site_id/)
    expect(dropMessages).toMatch(/visitor_id/)
    expect(dropMessages).toMatch(/session_id/)
  })

  it('makeFlatSchema rejects tenant_id / site_id at LLM enum boundary', () => {
    const schema = makeFlatSchema()
    for (const banned of ['tenant_id', 'site_id', 'visitor_id', 'session_id']) {
      const out = schema.safeParse({
        group_op: 'AND',
        leaves: [{ field: banned, op: 'EQ', value: 'x' }],
        confidence: 'high',
        reasoning: '',
        warnings: [],
      })
      expect(out.success).toBe(false)
    }
  })

  it('buildSystemPrompt does not expose server context field names', () => {
    const prompt = buildSystemPrompt()
    for (const banned of ['tenant_id', 'site_id', 'visitor_id', 'session_id']) {
      expect(prompt).not.toContain(banned)
    }
  })
})

describe('makeFlatSchema (LLM output schema)', () => {
  it('produces a valid Zod schema with the documented shape', () => {
    const schema = makeFlatSchema()
    const ok = schema.safeParse({
      group_op: 'AND',
      leaves: [{ field: 'utm_source', op: 'EQ', value: 'google' }],
      confidence: 'high',
      reasoning: 'utm_source からの直接抽出',
      warnings: [],
    })
    expect(ok.success).toBe(true)
  })

  it('rejects unknown field', () => {
    const schema = makeFlatSchema()
    const bad = schema.safeParse({
      group_op: 'AND',
      leaves: [{ field: 'age', op: 'EQ', value: 30 }],
      confidence: 'high',
      reasoning: '',
      warnings: [],
    })
    expect(bad.success).toBe(false)
  })

  it('rejects empty leaves array', () => {
    const schema = makeFlatSchema()
    const bad = schema.safeParse({
      group_op: 'AND',
      leaves: [],
      confidence: 'low',
      reasoning: '',
      warnings: [],
    })
    expect(bad.success).toBe(false)
  })
})
