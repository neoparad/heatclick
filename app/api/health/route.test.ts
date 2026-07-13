/**
 * Unit tests: app/api/health/route.ts (続137 P0-α1)
 *
 * Codex review MEDIUM (2026-07-12): 「ping失敗時にfreshnessを呼ばない」「freshness失敗時の
 * null fallback」「stale時のoverall degraded」を route レベルで固定する。
 */

jest.mock('@/lib/clickhouse')
jest.mock('@/lib/monitoring/ingest-freshness')
jest.mock('@/lib/monitoring/dummy-fallback-counter')
jest.mock('@/lib/heatmap/screenshot-provider')

import { getClickHouseClient } from '@/lib/clickhouse'
import { getIngestFreshnessSummary } from '@/lib/monitoring/ingest-freshness'
import { getRecentDummyFallbacks } from '@/lib/monitoring/dummy-fallback-counter'
import { getCloudflareBRConfig, getScreenshotWorkerConfig } from '@/lib/heatmap/screenshot-provider'

import { GET } from './route'

const mockGetClickHouseClient = getClickHouseClient as jest.MockedFunction<
  typeof getClickHouseClient
>
const mockGetIngestFreshnessSummary = getIngestFreshnessSummary as jest.MockedFunction<
  typeof getIngestFreshnessSummary
>
const mockGetRecentDummyFallbacks = getRecentDummyFallbacks as jest.MockedFunction<
  typeof getRecentDummyFallbacks
>
const mockGetScreenshotWorkerConfig = getScreenshotWorkerConfig as jest.MockedFunction<
  typeof getScreenshotWorkerConfig
>
const mockGetCloudflareBRConfig = getCloudflareBRConfig as jest.MockedFunction<
  typeof getCloudflareBRConfig
>

function fakeChClient(pingImpl: () => Promise<unknown>) {
  return {
    query: jest.fn(async () => ({
      json: pingImpl,
    })),
  } as unknown as ReturnType<typeof getClickHouseClient>
}

describe('GET /api/health', () => {
  const originalForcedDummy = process.env.CV_JOURNEY_DUMMY_ONLY

  beforeEach(() => {
    jest.resetAllMocks()
    delete process.env.CV_JOURNEY_DUMMY_ONLY
    mockGetScreenshotWorkerConfig.mockReturnValue({
      workerUrl: 'https://worker.example',
      workerToken: 'tok',
    })
    mockGetCloudflareBRConfig.mockReturnValue(null)
    mockGetRecentDummyFallbacks.mockResolvedValue({ count: 0, checked: true, windowHours: 6 })
  })

  afterAll(() => {
    if (originalForcedDummy === undefined) {
      delete process.env.CV_JOURNEY_DUMMY_ONLY
    } else {
      process.env.CV_JOURNEY_DUMMY_ONLY = originalForcedDummy
    }
  })

  it('ping失敗時はfreshnessクエリを呼ばずunhealthy/degradedを返す (fail-fast)', async () => {
    mockGetClickHouseClient.mockReturnValue(fakeChClient(() => Promise.reject(new Error('down'))))

    const res = await GET()
    const body = await res.json()

    expect(mockGetIngestFreshnessSummary).not.toHaveBeenCalled()
    expect(body.health.clickhouse).toBe('unhealthy')
    expect(body.health.ingest).toEqual({
      ok: false,
      checked: false,
      totalSites: null,
      activeSites: null,
      staleSites: null,
      neverActiveSites: null,
      thresholdHours: null,
    })
    expect(body.health.overall).toBe('degraded')
    expect(body.status).toBe('degraded')
  })

  it('freshnessクエリが失敗したらnullフォールバックにし、健全性チェック自体は落ちない', async () => {
    mockGetClickHouseClient.mockReturnValue(fakeChClient(() => Promise.resolve([])))
    mockGetIngestFreshnessSummary.mockRejectedValue(new Error('CH freshness query failed'))

    const res = await GET()
    const body = await res.json()

    expect(body.health.clickhouse).toBe('healthy')
    expect(body.health.ingest.checked).toBe(false)
    expect(body.health.ingest.ok).toBe(false)
    expect(body.health.overall).toBe('degraded') // ingest未確認は degraded 扱い
  })

  it('全サイトfresh (staleSites=0) ならoverall healthy', async () => {
    mockGetClickHouseClient.mockReturnValue(fakeChClient(() => Promise.resolve([])))
    mockGetIngestFreshnessSummary.mockResolvedValue({
      totalSites: 4,
      activeSites: 4,
      staleSites: 0,
      neverActiveSites: 0,
      thresholdHours: 6,
      ok: true,
    })

    const res = await GET()
    const body = await res.json()

    expect(body.health.ingest).toEqual({
      ok: true,
      checked: true,
      totalSites: 4,
      activeSites: 4,
      staleSites: 0,
      neverActiveSites: 0,
      thresholdHours: 6,
    })
    expect(body.health.overall).toBe('healthy')
    expect(body.status).toBe('ok')
  })

  it('1サイトでもstaleならoverall degradedになる', async () => {
    mockGetClickHouseClient.mockReturnValue(fakeChClient(() => Promise.resolve([])))
    mockGetIngestFreshnessSummary.mockResolvedValue({
      totalSites: 4,
      activeSites: 3,
      staleSites: 1,
      neverActiveSites: 0,
      thresholdHours: 6,
      ok: false,
    })

    const res = await GET()
    const body = await res.json()

    expect(body.health.ingest.staleSites).toBe(1)
    expect(body.health.overall).toBe('degraded')
    expect(body.status).toBe('degraded')
  })

  it('レスポンスに site_id / tracking_id / tenant_id 等の個別情報を一切含めない', async () => {
    mockGetClickHouseClient.mockReturnValue(fakeChClient(() => Promise.resolve([])))
    mockGetIngestFreshnessSummary.mockResolvedValue({
      totalSites: 1,
      activeSites: 0,
      staleSites: 1,
      neverActiveSites: 0,
      thresholdHours: 6,
      ok: false,
    })

    const res = await GET()
    const raw = await res.text()

    expect(raw).not.toMatch(/CIP_/) // site_id/tracking_id の慣用prefix
    expect(raw).not.toContain('tenant_id')
    expect(raw).not.toContain('site_id')
    expect(raw).not.toContain('tracking_id')
  })

  it('screenshot worker未設定時はexpectedProvider=microlink-fallback', async () => {
    mockGetClickHouseClient.mockReturnValue(fakeChClient(() => Promise.resolve([])))
    mockGetIngestFreshnessSummary.mockResolvedValue({
      totalSites: 0,
      activeSites: 0,
      staleSites: 0,
      neverActiveSites: 0,
      thresholdHours: 6,
      ok: true,
    })
    mockGetScreenshotWorkerConfig.mockReturnValue(null)

    const res = await GET()
    const body = await res.json()

    expect(body.health.screenshot.expectedProvider).toBe('microlink-fallback')
  })

  it('recent dummy fallbackがあればoverall degradedにする', async () => {
    mockGetClickHouseClient.mockReturnValue(fakeChClient(() => Promise.resolve([])))
    mockGetIngestFreshnessSummary.mockResolvedValue({
      totalSites: 4,
      activeSites: 4,
      staleSites: 0,
      neverActiveSites: 0,
      thresholdHours: 6,
      ok: true,
    })
    mockGetRecentDummyFallbacks.mockResolvedValue({ count: 2, checked: true, windowHours: 6 })

    const response = await GET()
    const body = await response.json()

    expect(body.health.cvJourney).toEqual({
      recentDummyFallbacks: 2,
      checked: true,
      windowHours: 6,
      forcedDummyMode: false,
      ok: false,
    })
    expect(body.health.overall).toBe('degraded')
  })

  it('forced dummy modeならfallback件数が0でもoverall degradedにする', async () => {
    process.env.CV_JOURNEY_DUMMY_ONLY = '1'
    mockGetClickHouseClient.mockReturnValue(fakeChClient(() => Promise.resolve([])))
    mockGetIngestFreshnessSummary.mockResolvedValue({
      totalSites: 4,
      activeSites: 4,
      staleSites: 0,
      neverActiveSites: 0,
      thresholdHours: 6,
      ok: true,
    })

    const response = await GET()
    const body = await response.json()

    expect(body.health.cvJourney.forcedDummyMode).toBe(true)
    expect(body.health.overall).toBe('degraded')
  })

  it('Redis未確認だけではoverall degradedにしない', async () => {
    mockGetClickHouseClient.mockReturnValue(fakeChClient(() => Promise.resolve([])))
    mockGetIngestFreshnessSummary.mockResolvedValue({
      totalSites: 4,
      activeSites: 4,
      staleSites: 0,
      neverActiveSites: 0,
      thresholdHours: 6,
      ok: true,
    })
    mockGetRecentDummyFallbacks.mockResolvedValue({ count: 0, checked: false, windowHours: 6 })

    const response = await GET()
    const body = await response.json()

    expect(body.health.cvJourney).toEqual({
      recentDummyFallbacks: null,
      checked: false,
      windowHours: 6,
      forcedDummyMode: false,
      ok: false,
    })
    expect(body.health.overall).toBe('healthy')
  })
})
