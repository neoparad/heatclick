/**
 * lib/scenarios/dry-run-preview.test.ts — dry-run preview unit tests (2026-06-07)
 *
 * ClickHouse 呼出は mock し、row → EvaluationContext 変換と評価ロジックの正しさを検証。
 */

import { listUnsupportedFields, runDryRunPreview, __test__ } from './dry-run-preview'
import type { ConditionNode } from './types'

const { rowToEvaluationContext, parseUrl, parseHost, normalizeDevice, utcDateString } = __test__

describe('parseUrl', () => {
  it('extracts pathname + search for absolute URLs', () => {
    expect(parseUrl('https://wakegai.jp/column/x?ref=email#frag')).toEqual({
      pathname: '/column/x',
      search: '?ref=email',
    })
  })

  it('handles relative URLs against synthetic base', () => {
    expect(parseUrl('/products/abc')).toEqual({
      pathname: '/products/abc',
      search: '',
    })
  })

  it('returns empty for falsy input', () => {
    expect(parseUrl('')).toEqual({ pathname: '', search: '' })
  })
})

describe('parseHost', () => {
  it('extracts host from absolute URL', () => {
    expect(parseHost('https://google.com/search?q=x')).toBe('google.com')
  })

  it('returns empty for relative or invalid', () => {
    expect(parseHost('/foo')).toBe('')
    expect(parseHost('not a url')).toBe('')
    expect(parseHost('')).toBe('')
  })
})

describe('normalizeDevice', () => {
  it('passes through known devices', () => {
    expect(normalizeDevice('desktop')).toBe('desktop')
    expect(normalizeDevice('mobile')).toBe('mobile')
    expect(normalizeDevice('tablet')).toBe('tablet')
  })

  it('coerces unknown / empty to "unknown"', () => {
    expect(normalizeDevice('smart-fridge')).toBe('unknown')
    expect(normalizeDevice('')).toBe('unknown')
  })
})

describe('utcDateString', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(utcDateString(Date.UTC(2026, 5, 7, 12, 0, 0))).toBe('2026-06-07')
    expect(utcDateString(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01')
  })
})

describe('rowToEvaluationContext', () => {
  it('builds valid EvaluationContext with tenant/site override', () => {
    const ctx = rowToEvaluationContext(
      {
        visitor_id: 'v_abc',
        session_id: 's_xyz',
        is_first_visit: 1,
        session_duration_sec: 125,
        page_views_in_session: 3,
        device_type: 'mobile',
        utm_source: 'google',
        utm_medium: 'organic',
        utm_campaign: '',
        is_agent: 0,
        hour_of_day: 14,
        referrer: 'https://google.com/search?q=x',
        last_url: 'https://example.com/cart?step=2',
        visited_paths: ['/home', '/cart'],
      },
      'tenant_a',
      'site_x',
    )
    expect(ctx.tenant_id).toBe('tenant_a')
    expect(ctx.site_id).toBe('site_x')
    expect(ctx.is_first_visit).toBe(true)
    expect(ctx.session_duration_sec).toBe(125)
    expect(ctx.url_path).toBe('/cart')
    expect(ctx.url_query).toBe('?step=2')
    expect(ctx.referrer_host).toBe('google.com')
    expect(ctx.device_type).toBe('mobile')
    expect(ctx.visited_paths).toEqual(['/home', '/cart'])
    expect(ctx.scroll_depth_max_pct).toBe(0)
    expect(ctx.cart_value).toBe(0)
    expect(ctx.language).toBe('')
  })

  it('treats null/undefined utm fields as empty strings', () => {
    const ctx = rowToEvaluationContext(
      {
        visitor_id: '',
        session_id: 's_1',
        is_first_visit: 0,
        session_duration_sec: 0,
        page_views_in_session: 0,
        device_type: '',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        is_agent: 0,
        hour_of_day: 0,
        referrer: '',
        last_url: '',
        visited_paths: [],
      },
      'tenant_a',
      'site_x',
    )
    expect(ctx.utm_source).toBe('')
    expect(ctx.utm_medium).toBe('')
    expect(ctx.device_type).toBe('unknown')
  })
})

describe('listUnsupportedFields', () => {
  it('detects scroll_depth_max_pct / cart_value / language', () => {
    const ast: ConditionNode = {
      op: 'AND',
      children: [
        { op: 'GTE', field: 'session_duration_sec', value: 60 },
        { op: 'GTE', field: 'scroll_depth_max_pct', value: 50 },
        { op: 'GTE', field: 'cart_value', value: 1000 },
        { op: 'EQ', field: 'language', value: 'ja' },
      ],
    }
    const unsupported = listUnsupportedFields(ast)
    expect(unsupported.sort()).toEqual(['cart_value', 'language', 'scroll_depth_max_pct'])
  })

  it('returns empty for fully supported AST', () => {
    const ast: ConditionNode = {
      op: 'AND',
      children: [
        { op: 'EQ', field: 'is_first_visit', value: true },
        { op: 'EQ', field: 'device_type', value: 'mobile' },
        { op: 'NOT_VISITED', field: 'visited_paths', value: '/cart' },
      ],
    }
    expect(listUnsupportedFields(ast)).toEqual([])
  })
})

// ── ClickHouse-mocked integration of runDryRunPreview ──────────────────────

interface MockRow {
  session_id: string
  visitor_id: string
  day: string
  is_first_visit: number
  session_duration_sec: number
  page_views_in_session: number
  device_type: string
  utm_source: string
  utm_medium: string
  utm_campaign: string
  is_agent: number
  hour_of_day: number
  referrer: string
  last_url: string
  visited_paths: string[]
}

function mockClient(rows: MockRow[]): import('@clickhouse/client').ClickHouseClient {
  const fakeQuery = jest.fn(async () => ({
    json: async <T>() => rows as unknown as T[],
  }))
  // 最低限の型互換 (実 client は他にも method を持つが本テストでは query しか叩かない)
  return { query: fakeQuery } as unknown as import('@clickhouse/client').ClickHouseClient
}

describe('runDryRunPreview (integration with mocked ClickHouse)', () => {
  const ast: ConditionNode = {
    op: 'AND',
    children: [
      { op: 'EQ', field: 'is_first_visit', value: true },
      { op: 'GTE', field: 'session_duration_sec', value: 60 },
      { op: 'NOT_VISITED', field: 'visited_paths', value: '/cart' },
    ],
  }

  it('matches sessions that satisfy the AST', async () => {
    const rows: MockRow[] = [
      // matched: 初回 + 90s + /cart 未訪問
      {
        session_id: 's1',
        visitor_id: 'v1',
        day: '2026-06-05',
        is_first_visit: 1,
        session_duration_sec: 90,
        page_views_in_session: 2,
        device_type: 'mobile',
        utm_source: 'google',
        utm_medium: 'organic',
        utm_campaign: '',
        is_agent: 0,
        hour_of_day: 10,
        referrer: '',
        last_url: 'https://x.com/home',
        visited_paths: ['/home', '/about'],
      },
      // matched: 初回 + 200s + /cart 未訪問
      {
        session_id: 's2',
        visitor_id: 'v2',
        day: '2026-06-06',
        is_first_visit: 1,
        session_duration_sec: 200,
        page_views_in_session: 5,
        device_type: 'desktop',
        utm_source: 'yahoo',
        utm_medium: 'cpc',
        utm_campaign: 'spring',
        is_agent: 0,
        hour_of_day: 15,
        referrer: 'https://yahoo.co.jp',
        last_url: 'https://x.com/products',
        visited_paths: ['/home', '/products'],
      },
      // NOT matched: リピーター
      {
        session_id: 's3',
        visitor_id: 'v3',
        day: '2026-06-06',
        is_first_visit: 0,
        session_duration_sec: 300,
        page_views_in_session: 10,
        device_type: 'desktop',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        is_agent: 0,
        hour_of_day: 20,
        referrer: '',
        last_url: 'https://x.com/home',
        visited_paths: ['/home'],
      },
      // NOT matched: 初回だが /cart 訪問済
      {
        session_id: 's4',
        visitor_id: 'v4',
        day: '2026-06-06',
        is_first_visit: 1,
        session_duration_sec: 70,
        page_views_in_session: 3,
        device_type: 'mobile',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        is_agent: 0,
        hour_of_day: 21,
        referrer: '',
        last_url: 'https://x.com/cart',
        visited_paths: ['/home', '/products', '/cart'],
      },
    ]

    const result = await runDryRunPreview(
      { tenantId: 't_a', siteId: 'site_x', conditionAst: ast, days: 7 },
      mockClient(rows),
    )

    expect(result.totalSessions).toBe(4)
    expect(result.matchedSessions).toBe(2)
    expect(result.matchRate).toBeCloseTo(0.5, 5)
    expect(result.sampleMatches.length).toBe(2)
    expect(result.sampleMatches.map((s) => s.sessionId).sort()).toEqual(['s1', 's2'])
    expect(result.evidenceLevel).toBe('inferred')
    expect(result.unsupportedFields).toEqual([])
  })

  it('returns zero matched with empty sample when no row qualifies', async () => {
    const rows: MockRow[] = [
      {
        session_id: 's_x',
        visitor_id: '',
        day: '2026-06-06',
        is_first_visit: 0,
        session_duration_sec: 10,
        page_views_in_session: 1,
        device_type: 'desktop',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        is_agent: 0,
        hour_of_day: 0,
        referrer: '',
        last_url: '',
        visited_paths: [],
      },
    ]
    const result = await runDryRunPreview(
      { tenantId: 't_a', siteId: 'site_x', conditionAst: ast, days: 7 },
      mockClient(rows),
    )
    expect(result.matchedSessions).toBe(0)
    expect(result.matchRate).toBe(0)
    expect(result.sampleMatches).toEqual([])
  })

  it('propagates unsupportedFields when AST uses cart_value / scroll_depth_max_pct', async () => {
    const astWithUnsupported: ConditionNode = {
      op: 'OR',
      children: [
        { op: 'GTE', field: 'cart_value', value: 1000 },
        { op: 'GTE', field: 'scroll_depth_max_pct', value: 80 },
      ],
    }
    const result = await runDryRunPreview(
      { tenantId: 't_a', siteId: 'site_x', conditionAst: astWithUnsupported, days: 7 },
      mockClient([]),
    )
    expect(result.unsupportedFields.sort()).toEqual(['cart_value', 'scroll_depth_max_pct'])
  })

  it('clamps days to 1..30', async () => {
    const r1 = await runDryRunPreview(
      { tenantId: 't_a', siteId: 'site_x', conditionAst: ast, days: 999 },
      mockClient([]),
    )
    expect(r1.period.days).toBe(30)
    const r2 = await runDryRunPreview(
      { tenantId: 't_a', siteId: 'site_x', conditionAst: ast, days: 0 },
      mockClient([]),
    )
    expect(r2.period.days).toBe(1)
  })
})
