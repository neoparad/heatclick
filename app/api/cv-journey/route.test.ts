jest.mock('@/lib/auth/server-session')
jest.mock('@/lib/clickhouse')
jest.mock('@/lib/cv-journey/query')
jest.mock('@/lib/monitoring/dummy-fallback-counter')

import { getServerSession } from '@/lib/auth/server-session'
import { getClickHouseClient } from '@/lib/clickhouse'
import { buildFunnelData } from '@/lib/cv-journey/query'
import { recordDummyFallback } from '@/lib/monitoring/dummy-fallback-counter'

import { GET } from './route'

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>
const mockGetClickHouseClient = getClickHouseClient as jest.MockedFunction<typeof getClickHouseClient>
const mockBuildFunnelData = buildFunnelData as jest.MockedFunction<typeof buildFunnelData>
const mockRecordDummyFallback = recordDummyFallback as jest.MockedFunction<typeof recordDummyFallback>

const originalForcedDummy = process.env.CV_JOURNEY_DUMMY_ONLY

function request(): Request {
  return new Request('https://app.example.com/api/cv-journey?site_id=CIP_test')
}

describe('GET /api/cv-journey dummy fallback observability', () => {
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    jest.resetAllMocks()
    delete process.env.CV_JOURNEY_DUMMY_ONLY
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    mockGetServerSession.mockResolvedValue({
      tenant_id: 'tenant_test',
      user_id: 'user_test',
      role: 'owner',
      user: {
        sub: 'user_test',
        tenant_id: 'tenant_test',
        site_ids: ['CIP_test'],
        email: 'test@example.com',
      },
    } as Awaited<ReturnType<typeof getServerSession>>)
    mockGetClickHouseClient.mockReturnValue({} as ReturnType<typeof getClickHouseClient>)
    mockRecordDummyFallback.mockResolvedValue()
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  afterAll(() => {
    if (originalForcedDummy === undefined) {
      delete process.env.CV_JOURNEY_DUMMY_ONLY
    } else {
      process.env.CV_JOURNEY_DUMMY_ONLY = originalForcedDummy
    }
  })

  it('records a fallback only when the ClickHouse query path throws', async () => {
    mockBuildFunnelData.mockRejectedValue(new Error('ClickHouse unavailable'))

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.meta.dataSource).toBe('dummy')
    expect(mockRecordDummyFallback).toHaveBeenCalledWith('cv-journey')
  })

  it('does not record an intentionally forced dummy response', async () => {
    process.env.CV_JOURNEY_DUMMY_ONLY = '1'

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.meta.dataSource).toBe('dummy')
    expect(mockBuildFunnelData).not.toHaveBeenCalled()
    expect(mockRecordDummyFallback).not.toHaveBeenCalled()
  })
})
