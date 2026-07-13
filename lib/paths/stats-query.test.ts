import type { ClickHouseClient } from '@clickhouse/client'

import {
  computeBranchFunnel,
  computePathSetStats,
  fetchTriggerSessions,
} from './stats-query'
import { PathSetSchema, type PathSet } from './types'

type QueryRow = Record<string, number | string>

function mockClient(responses: Array<QueryRow[] | Error>): ClickHouseClient {
  const query = jest.fn(async () => {
    const response = responses.shift()
    if (response instanceof Error) throw response
    return { json: async <T>() => (response ?? []) as T[] }
  })

  return { query } as unknown as ClickHouseClient
}

function basePathSet(overrides: Partial<PathSet> = {}): PathSet {
  return PathSetSchema.parse({
    id: '00000000-0000-4000-8000-000000000001',
    tenant_id: 'tenant_a',
    site_id: 'site_a',
    name: 'Checkout path',
    description: '',
    status: 'monitoring',
    trigger: {
      title: 'Home',
      url: '/',
      periodDays: 30,
      sessions: '—',
    },
    branches: [
      {
        id: 'branch-a',
        name: 'Product checkout',
        description: '',
        severity: 'ok',
        nodes: [
          { id: 'node-a1', step: 'A1', title: 'Products', url: '/products/*', stats: [] },
          { id: 'node-a2', step: 'A2', title: 'Cart add', url: 'conversion:cart_add', stats: [] },
        ],
        edges: [{ label: '' }],
        summary: { cvRate: '—', delta: '', deltaTone: 'pos' },
      },
    ],
    insights: [],
    isDummy: true,
    evidence_level: 'inferred',
    evidence_data: {},
    averageCvRate: '—',
    created_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z',
    created_by: 'owner@example.com',
    archived_at: null,
    ...overrides,
  })
}

describe('computeBranchFunnel', () => {
  it('binds canonical page, glob, event, and conversion steps without interpolating values', async () => {
    const client = mockClient([[{ s1: 100, s2: 80, s3: 60, s4: 20 }]])

    const result = await computeBranchFunnel(client, {
      tenantId: 'tenant_a',
      siteId: 'site_a',
      periodDays: 30,
      steps: ['/?campaign=summer#top', '/products/*', 'event:click', 'conversion:cart_add'],
    })

    expect(result.reached).toEqual([100, 80, 60, 20])
    expect(result.warnings).toEqual([])

    const query = client.query as jest.Mock
    const call = query.mock.calls[0][0]
    expect(call.query).toContain("replaceRegexpOne(url, '[?#].*$', '') = {s0_url:String}")
    expect(call.query).toContain("startsWith(replaceRegexpOne(url, '[?#].*$', ''), {s1_prefix:String})")
    expect(call.query).toContain('event_type = {s2_evt:String}')
    expect(call.query).toContain("event_type = 'conversion' AND conversion_type = {s3_cv:String}")
    expect(call.query).toContain('tenant_id = {tenant_id:String}')
    expect(call.query).toContain('site_id = {site_id:String}')
    expect(call.query).toContain('is_agent = 0')
    expect(call.query).not.toContain('cart_add')
    expect(call.query_params).toEqual({
      tenant_id: 'tenant_a',
      site_id: 'site_a',
      period_days: 30,
      window_seconds: 1800,
      s0_url: '/',
      s1_prefix: '/products/',
      s2_evt: 'click',
      s3_cv: 'cart_add',
    })
  })

  it('does not include unsupported event types in windowFunnel or return their stats', async () => {
    const client = mockClient([[{ s1: 30, s2: 5 }]])

    const result = await computeBranchFunnel(client, {
      tenantId: 'tenant_a',
      siteId: 'site_a',
      periodDays: 30,
      steps: ['/', 'event:cart_add', 'conversion:cart_add'],
    })

    expect(result.reached).toEqual([30, null, 5])
    expect(result.warnings).toEqual(["Unsupported event step 'event:cart_add'"])

    const call = (client.query as jest.Mock).mock.calls[0][0]
    expect(call.query).not.toContain('cart_add')
    expect(call.query).toContain("event_type = 'conversion' AND conversion_type = {s2_cv:String}")
    expect(call.query_params).toMatchObject({ s2_cv: 'cart_add' })
  })
})

describe('fetchTriggerSessions', () => {
  it('uses the same page condition and every required event scope filter', async () => {
    const client = mockClient([[{ sessions: 7128 }]])

    const result = await fetchTriggerSessions(client, {
      tenantId: 'tenant_a',
      siteId: 'site_a',
      periodDays: 14,
      triggerUrl: '/landing?utm=campaign#hero',
    })

    expect(result).toEqual({ sessions: 7128, warnings: [] })
    const call = (client.query as jest.Mock).mock.calls[0][0]
    expect(call.query).toContain('uniqExact(session_id) AS sessions')
    expect(call.query).toContain("event_type = 'pageview' AND replaceRegexpOne(url, '[?#].*$', '') = {s0_url:String}")
    expect(call.query).toContain('tenant_id = {tenant_id:String}')
    expect(call.query).toContain('site_id = {site_id:String}')
    expect(call.query).toContain('is_agent = 0')
    expect(call.query_params).toEqual({
      tenant_id: 'tenant_a',
      site_id: 'site_a',
      period_days: 14,
      s0_url: '/landing',
    })
  })
})

describe('computePathSetStats', () => {
  it('accepts observed_approx as a D-07 evidence level', () => {
    const result = basePathSet({ evidence_level: 'observed_approx' })

    expect(result.evidence_level).toBe('observed_approx')
  })

  it('projects observed counts, drop rates, and CV rates without mutating the source definition', async () => {
    const source = basePathSet()
    const client = mockClient([[{ sessions: 100 }], [{ s1: 100, s2: 50, s3: 10 }]])

    const result = await computePathSetStats(client, source)

    expect(source.isDummy).toBe(true)
    expect(source.trigger.sessions).toBe('—')
    expect(result.isDummy).toBe(false)
    expect(result.evidence_level).toBe('observed_approx')
    expect(result.trigger.sessions).toBe('100')
    expect(result.branches[0].nodes[0].stats).toEqual([
      { k: '通過', v: '50' },
      { k: '離脱', v: '50%', tone: 'neg' },
    ])
    expect(result.branches[0].nodes[1].stats).toEqual([
      { k: '到達', v: '10' },
      { k: 'CV率', v: '10.0%', tone: 'pos' },
    ])
    expect(result.branches[0].edges).toEqual([{ label: '通過 20%', band: 'crit' }])
    expect(result.branches[0].summary.cvRate).toBe('10.0%')
    expect(result.branches[0].severity).toBe('crit')
    expect(result.averageCvRate).toBe('10.0%')
    expect(result.evidence_data).toMatchObject({ pathStats: { statsComputed: true, warnings: [] } })
  })

  it('returns an explicitly unanalysed projection for empty data instead of retaining dummy values', async () => {
    const client = mockClient([[{ sessions: 0 }]])

    const result = await computePathSetStats(client, basePathSet())

    expect(result.isDummy).toBe(false)
    expect(result.evidence_level).toBe('planned')
    expect(result.trigger.sessions).toBe('—')
    expect(result.branches[0].nodes.every((node) => node.stats.length === 0)).toBe(true)
    expect(result.branches[0].edges).toEqual([{ label: '' }])
    expect(result.branches[0].summary.cvRate).toBe('—')
    expect(result.evidence_data).toMatchObject({
      pathStats: { statsComputed: false, reason: 'no_trigger_sessions' },
    })
  })

  it('returns an explicitly unanalysed projection when ClickHouse fails', async () => {
    const client = mockClient([new Error('ClickHouse unavailable')])

    const result = await computePathSetStats(client, basePathSet())

    expect(result.isDummy).toBe(false)
    expect(result.evidence_level).toBe('planned')
    expect(result.evidence_data).toMatchObject({
      pathStats: {
        statsComputed: false,
        reason: 'clickhouse_error',
        warnings: ['ClickHouse query failed'],
      },
    })
  })
})
