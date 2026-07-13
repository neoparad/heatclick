jest.mock('@/lib/clickhouse')
jest.mock('@/lib/paths/stats-query')
jest.mock('@/lib/paths/tenant-context')
jest.mock('@/lib/paths/repository', () => {
  const actual = jest.requireActual('@/lib/paths/repository')
  return { ...actual, createPathSetRepository: jest.fn() }
})

import type { NextRequest } from 'next/server'

import { getClickHouseClient } from '@/lib/clickhouse'
import { createPathSetRepository } from '@/lib/paths/repository'
import { computePathSetStats, markPathSetStatsUnavailable } from '@/lib/paths/stats-query'
import { isPathTenantContext, resolvePathTenantContext } from '@/lib/paths/tenant-context'
import { PathSetSchema, type PathSet } from '@/lib/paths/types'

import { GET } from './route'

const mockGetClickHouseClient = getClickHouseClient as jest.MockedFunction<typeof getClickHouseClient>
const mockCreatePathSetRepository = createPathSetRepository as jest.MockedFunction<
  typeof createPathSetRepository
>
const mockComputePathSetStats = computePathSetStats as jest.MockedFunction<typeof computePathSetStats>
const mockMarkPathSetStatsUnavailable = markPathSetStatsUnavailable as jest.MockedFunction<
  typeof markPathSetStatsUnavailable
>
const mockResolvePathTenantContext = resolvePathTenantContext as jest.MockedFunction<
  typeof resolvePathTenantContext
>
const mockIsPathTenantContext = isPathTenantContext as jest.MockedFunction<typeof isPathTenantContext>

const PATHSET_ID = '00000000-0000-4000-8000-000000000001'

function pathSet(overrides: Partial<PathSet> = {}): PathSet {
  return PathSetSchema.parse({
    id: PATHSET_ID,
    tenant_id: 'tenant_a',
    site_id: 'CIP_site_a',
    name: 'Checkout path',
    description: '',
    status: 'monitoring',
    trigger: { title: 'Home', url: '/', periodDays: 30, sessions: '—' },
    branches: [
      {
        id: 'A',
        name: 'A',
        description: '',
        severity: 'ok',
        nodes: [{ id: 'A1', step: 'CV', title: 'Thanks', url: '/thanks/', stats: [] }],
        edges: [],
        summary: { cvRate: '—', delta: '', deltaTone: 'pos' },
      },
    ],
    insights: [],
    isDummy: false,
    evidence_level: 'planned',
    evidence_data: {},
    averageCvRate: '—',
    created_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z',
    created_by: 'owner@example.com',
    archived_at: null,
    ...overrides,
  })
}

function request(): NextRequest {
  return {
    url: `https://app.example.com/api/paths/${PATHSET_ID}?site_id=CIP_site_a`,
  } as NextRequest
}

describe('GET /api/paths/[id]', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    mockIsPathTenantContext.mockReturnValue(true)
    mockResolvePathTenantContext.mockResolvedValue({
      tenantId: 'tenant_a',
      siteId: 'CIP_site_a',
      siteIds: ['CIP_site_a'],
      userId: 'user_a',
    })
  })

  it('returns a compute-on-read stats projection without writing it back to KV', async () => {
    const definition = pathSet()
    const computed = pathSet({
      isDummy: false,
      evidence_level: 'observed_approx',
      trigger: { ...definition.trigger, sessions: '100' },
      evidence_data: { pathStats: { statsComputed: true, warnings: [] } },
    })
    const getPathSet = jest.fn().mockResolvedValue(definition)
    const client = {} as ReturnType<typeof getClickHouseClient>

    mockCreatePathSetRepository.mockReturnValue({ getPathSet } as ReturnType<typeof createPathSetRepository>)
    mockGetClickHouseClient.mockReturnValue(client)
    mockComputePathSetStats.mockResolvedValue(computed)

    const response = await GET(request(), { params: { id: PATHSET_ID } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(computed)
    expect(getPathSet).toHaveBeenCalledWith('tenant_a', 'CIP_site_a', PATHSET_ID)
    expect(mockGetClickHouseClient).toHaveBeenCalledWith('analytics_reader')
    expect(mockComputePathSetStats).toHaveBeenCalledWith(client, definition)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('returns a visible unanalysed projection when ClickHouse client creation fails', async () => {
    const definition = pathSet()
    const unavailable = pathSet({
      evidence_data: {
        pathStats: {
          statsComputed: false,
          reason: 'clickhouse_error',
          warnings: ['ClickHouse query failed'],
        },
      },
    })

    mockCreatePathSetRepository.mockReturnValue({
      getPathSet: jest.fn().mockResolvedValue(definition),
    } as ReturnType<typeof createPathSetRepository>)
    mockGetClickHouseClient.mockImplementation(() => {
      throw new Error('missing read-only credentials')
    })
    mockMarkPathSetStatsUnavailable.mockReturnValue(unavailable)

    const response = await GET(request(), { params: { id: PATHSET_ID } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(unavailable)
    expect(mockComputePathSetStats).not.toHaveBeenCalled()
    expect(mockMarkPathSetStatsUnavailable).toHaveBeenCalledWith(definition, 'clickhouse_error')
  })

  it('does not initialize ClickHouse when the scoped path set is not found', async () => {
    mockCreatePathSetRepository.mockReturnValue({
      getPathSet: jest.fn().mockResolvedValue(null),
    } as ReturnType<typeof createPathSetRepository>)

    const response = await GET(request(), { params: { id: PATHSET_ID } })

    expect(response.status).toBe(404)
    expect(mockGetClickHouseClient).not.toHaveBeenCalled()
  })
})
