/**
 * /api/scenarios/dry-run-preview server boundary checks (2026-06-07)
 *
 * AST semantic validation を route layer で強制していることを固定する
 * (Codex T2 dual review 指摘 E 反映)。
 *
 * runDryRunPreview は ClickHouse を叩くため jest.mock で no-op に置換。
 */

import { NextRequest } from 'next/server'

jest.mock('@/lib/scenarios/dry-run-preview', () => ({
  runDryRunPreview: jest.fn(async () => ({
    period: { startDate: '2026-06-01', endDate: '2026-06-07', days: 7 },
    totalSessions: 0,
    matchedSessions: 0,
    matchRate: 0,
    daily: [],
    sampleMatches: [],
    unsupportedFields: [],
    evidenceLevel: 'inferred' as const,
    queryMs: 1,
  })),
}))

jest.mock('@/lib/llm/chat-rate-limit', () => ({
  checkChatRateLimit: jest.fn(async () => ({
    allowed: true,
    remaining: 59,
    resetTime: Date.now() + 3600000,
    limit: 60,
  })),
}))

import { POST } from './route'
import { runDryRunPreview } from '@/lib/scenarios/dry-run-preview'

const URL_BASE = 'https://app.example.com/api/scenarios/dry-run-preview'

function makeRequest(
  body: unknown,
  headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tenant-id': 'tenant_a',
    'x-site-ids': 'CIP_site_a',
    'x-user-id': 'user_1',
  },
): NextRequest {
  return new NextRequest(URL_BASE, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('POST /api/scenarios/dry-run-preview — boundary checks', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('rejects body without site_id', async () => {
    const res = await POST(makeRequest({ condition_ast: { op: 'AND', children: [{ op: 'EQ', field: 'utm_source', value: 'x' }] } }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('INVALID_BODY')
  })

  it('rejects AST exceeding max depth (semantic validation)', async () => {
    // depth = 6 → MAX_DEPTH=5 を超える
    let inner: { op: 'AND'; children: unknown[] } = { op: 'AND', children: [{ op: 'EQ', field: 'utm_source', value: 'x' }] }
    for (let i = 0; i < 6; i++) {
      inner = { op: 'AND', children: [inner] }
    }
    const res = await POST(
      makeRequest({
        site_id: 'CIP_site_a',
        condition_ast: inner,
      }),
    )
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('INVALID_CONDITION_AST')
    expect(json.error.message).toMatch(/depth/i)
    expect(runDryRunPreview).not.toHaveBeenCalled()
  })

  it('rejects AST exceeding max leaves (semantic validation)', async () => {
    const leaves = Array.from({ length: 30 }).map(() => ({
      op: 'EQ' as const,
      field: 'utm_source',
      value: 'x',
    }))
    // depth=2 (root + leaves) なので depth は OK、leaf 数 = 30 (上限) はギリギリ通る → 30 leaf x 2 group で 60 leaves に
    const groupA = { op: 'AND' as const, children: leaves }
    const groupB = { op: 'AND' as const, children: leaves }
    const tooManyLeaves = { op: 'AND' as const, children: [groupA, groupB] }
    const res = await POST(
      makeRequest({
        site_id: 'CIP_site_a',
        condition_ast: tooManyLeaves,
      }),
    )
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('INVALID_CONDITION_AST')
    expect(json.error.message).toMatch(/leaf/i)
    expect(runDryRunPreview).not.toHaveBeenCalled()
  })

  it('rejects AST with unsupported field (semantic validation)', async () => {
    const res = await POST(
      makeRequest({
        site_id: 'CIP_site_a',
        condition_ast: {
          op: 'AND',
          children: [{ op: 'EQ', field: 'unknown_field_xxx', value: 'x' }],
        },
      }),
    )
    // unknown field は Zod レベルで通る (LeafComparisonSchema は field を z.string().min(1).max(64))。
    // validateConditionAst で isAllowedField チェック → "unsupported_field" error。
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('INVALID_CONDITION_AST')
    expect(json.error.message).toMatch(/not allowed|allowed/i)
    expect(runDryRunPreview).not.toHaveBeenCalled()
  })

  it('rejects when tenant header missing (REQ-SEC-004)', async () => {
    const res = await POST(
      makeRequest(
        {
          site_id: 'CIP_site_a',
          condition_ast: { op: 'AND', children: [{ op: 'EQ', field: 'utm_source', value: 'x' }] },
        },
        { 'content-type': 'application/json', 'x-site-ids': 'CIP_site_a' },
      ),
    )
    expect(res.status).toBe(401)
    expect(runDryRunPreview).not.toHaveBeenCalled()
  })

  it('rejects when site_id is not in JWT site_ids (IDOR guard)', async () => {
    const res = await POST(
      makeRequest(
        {
          site_id: 'CIP_other_site',
          condition_ast: { op: 'AND', children: [{ op: 'EQ', field: 'utm_source', value: 'x' }] },
        },
        {
          'content-type': 'application/json',
          'x-tenant-id': 'tenant_a',
          'x-site-ids': 'CIP_site_a',
          'x-user-id': 'user_1',
        },
      ),
    )
    expect(res.status).toBe(403)
    expect(runDryRunPreview).not.toHaveBeenCalled()
  })

  it('accepts valid AST + tenant + site and returns 200', async () => {
    const res = await POST(
      makeRequest({
        site_id: 'CIP_site_a',
        condition_ast: {
          op: 'AND',
          children: [
            { op: 'EQ', field: 'is_first_visit', value: true },
            { op: 'GTE', field: 'session_duration_sec', value: 60 },
          ],
        },
        days: 7,
      }),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(runDryRunPreview).toHaveBeenCalledTimes(1)
    expect(runDryRunPreview).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_a', siteId: 'CIP_site_a', days: 7 }),
    )
  })
})
