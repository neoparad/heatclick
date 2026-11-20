jest.mock('@/lib/auth/server-session')
jest.mock('@/lib/clickhouse')
jest.mock('@/lib/cv-journey/query')
jest.mock('@/lib/monitoring/dummy-fallback-counter')

import { getServerSession } from '@/lib/auth/server-session'
import { getClickHouseClient } from '@/lib/clickhouse'
import { DEFAULT_FUNNEL } from '@/lib/cv-journey/funnel-config'
import { buildDummyData } from '@/lib/cv-journey/fixtures'
import { buildFunnelData } from '@/lib/cv-journey/query'
import { recordDummyFallback } from '@/lib/monitoring/dummy-fallback-counter'

import { GET } from './route'

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>
const mockGetClickHouseClient = getClickHouseClient as jest.MockedFunction<typeof getClickHouseClient>
const mockBuildFunnelData = buildFunnelData as jest.MockedFunction<typeof buildFunnelData>
const mockRecordDummyFallback = recordDummyFallback as jest.MockedFunction<typeof recordDummyFallback>

const originalForcedDummy = process.env.CV_JOURNEY_DUMMY_ONLY

function request(extraQuery = ''): Request {
  return new Request(`https://app.example.com/api/cv-journey?site_id=CIP_test${extraQuery}`)
}

describe('GET /api/cv-journey Wave 0 not_collected contract', () => {
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

  it('returns status=not_collected with empty funnel data (never dummy) when ClickHouse throws', async () => {
    mockBuildFunnelData.mockRejectedValue(new Error('ClickHouse unavailable'))

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.status).toBe('not_collected')
    expect(body.meta.dataSource).toBe('not_collected')
    expect(body.data.steps).toEqual([])
    expect(body.data.sources).toEqual([])
    expect(body.data.totals.totalSessions).toBe(0)
    expect(mockRecordDummyFallback).toHaveBeenCalledWith('cv-journey')
  })

  it('ignores CV_JOURNEY_DUMMY_ONLY=1 in production route and queries ClickHouse instead of returning dummy data', async () => {
    process.env.CV_JOURNEY_DUMMY_ONLY = '1'
    mockBuildFunnelData.mockRejectedValue(new Error('ClickHouse unavailable'))

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.status).toBe('not_collected')
    expect(body.meta.dataSource).toBe('not_collected')
    expect(body.data.steps).toEqual([])
    expect(mockBuildFunnelData).toHaveBeenCalled()
  })

  // ── 期間正規化: クエリ条件と meta.periodDays の一致 ──

  it('日付未指定は 7 日ウィンドウへ正規化してクエリし、meta.periodDays と一致する', async () => {
    mockBuildFunnelData.mockResolvedValue({ data: buildDummyData(DEFAULT_FUNNEL), warnings: [] })

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.meta.dataSource).toBe('clickhouse_events')
    expect(body.meta.periodDays).toBe(7)

    const args = mockBuildFunnelData.mock.calls[0][0]
    expect(args.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(args.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const spanDays = (Date.parse(args.endDate!) - Date.parse(args.startDate!)) / 86_400_000
    expect(spanDays).toBe(6) // 両端含み 7 日
  })

  it('明示指定した日付はそのまま渡り、periodDays は両端含みで一致する', async () => {
    mockBuildFunnelData.mockResolvedValue({ data: buildDummyData(DEFAULT_FUNNEL), warnings: [] })

    const response = await GET(request('&start_date=2026-07-01&end_date=2026-07-07'))
    const body = await response.json()

    const args = mockBuildFunnelData.mock.calls[0][0]
    expect(args.startDate).toBe('2026-07-01')
    expect(args.endDate).toBe('2026-07-07')
    expect(body.meta.periodDays).toBe(7)
  })
})
