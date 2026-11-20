import type { ClickHouseClient } from '@clickhouse/client'
import {
  aggregateAiTrafficRows,
  classifyAiTrafficSource,
  getAiseoOverview,
  queryClickHouseAiTraffic,
  type RawTrafficEventRow,
} from './ga4-ai-traffic'

describe('lib/aiseo/ga4-ai-traffic (AI Referral Traffic × AIO Citation Diff × Semantic Audit)', () => {
  it('accurately classifies ChatGPT, Perplexity, Gemini, Claude, Microsoft Copilot, Google AI Overview / SGE, and Organic Search', () => {
    expect(
      classifyAiTrafficSource({ referrer: 'https://chatgpt.com/c/1234' }).aiSource,
    ).toBe('ChatGPT')
    expect(
      classifyAiTrafficSource({ referrer: 'https://chat.openai.com/', utmSource: 'chatgpt.com' })
        .aiSource,
    ).toBe('ChatGPT')
    expect(
      classifyAiTrafficSource({ referrer: 'https://www.perplexity.ai/search?q=seo' }).aiSource,
    ).toBe('Perplexity')
    expect(
      classifyAiTrafficSource({ referrer: 'https://gemini.google.com/app' }).aiSource,
    ).toBe('Gemini')
    expect(
      classifyAiTrafficSource({ referrer: 'https://claude.ai/chat/abc' }).aiSource,
    ).toBe('Claude')
    expect(
      classifyAiTrafficSource({ referrer: 'https://copilot.microsoft.com/' }).aiSource,
    ).toBe('Microsoft Copilot')
    expect(
      classifyAiTrafficSource({
        referrer: 'https://www.google.com/',
        utmSource: 'google_aio',
        utmMedium: 'ai_overview',
      }).aiSource,
    ).toBe('Google AI Overview / SGE')
    expect(
      classifyAiTrafficSource({
        referrer: 'https://www.google.com/',
        url: 'https://example.com/guide',
      }).channel,
    ).toBe('organic_search')
  })

  it('aggregates AI source sessions and computes CVR multiplier vs. human organic search without fabricating unmeasured fields', () => {
    const sampleRows: RawTrafficEventRow[] = [
      {
        url: 'https://example.com/entry/a',
        referrer: 'https://chatgpt.com/',
        sessions: 200,
        conversions: 10, // 5.0% CVR
      },
      {
        url: 'https://example.com/entry/a',
        referrer: 'https://perplexity.ai/',
        sessions: 100,
        conversions: 5, // 5.0% CVR
      },
      {
        url: 'https://example.com/entry/a',
        referrer: 'https://www.google.com/',
        utmMedium: 'organic',
        sessions: 1000,
        conversions: 20, // 2.0% CVR
      },
    ]

    const result = aggregateAiTrafficRows(sampleRows)
    expect(result.totalAiSessions).toBe(300)
    expect(result.totalAiConversions).toBe(15)
    expect(result.aiCvr).toBeCloseTo(0.05, 4)
    expect(result.organicSearchSessions).toBe(1000)
    expect(result.organicSearchCvr).toBeCloseTo(0.02, 4)
    expect(result.aiVsOrganicCvrMultiplier).toBeCloseTo(2.5, 2)
    const activeSources = result.bySource.filter((s) => s.sessions > 0)
    expect(activeSources.length).toBeGreaterThanOrEqual(2)
    expect(result.bySource[0].source).toBe('ChatGPT')
    expect(result.bySource[0].sessions).toBe(200)
    // Unmeasured fields must remain null rather than fabricated from index
    expect(result.topLandingUrls[0].semanticScore).toBeNull()
    expect(result.topLandingUrls[0].aioCitedCount).toBeNull()
  })

  it('binds tenant_id in ClickHouse SQL and fails closed to not_collected when tenantId is missing', async () => {
    const queryMock = jest.fn().mockResolvedValue({
      json: async () => [
        {
          url: 'https://example.com/entry/a',
          referrer: 'https://chatgpt.com/',
          sessions: 12,
          conversions: 2,
        },
      ],
    })
    const fakeCh = { query: queryMock } as unknown as ClickHouseClient

    const blocked = await queryClickHouseAiTraffic({
      clickhouse: fakeCh,
      siteId: 'site-1',
      days: 30,
    })
    expect(blocked.status).toBe('not_collected')
    expect(blocked.source).toBe('not_collected')
    expect(queryMock).not.toHaveBeenCalled()

    const live = await queryClickHouseAiTraffic({
      clickhouse: fakeCh,
      tenantId: 'tenant-alpha',
      siteId: 'site-1',
      days: 30,
    })
    expect(live.status).toBe('ok')
    expect(live.source).toBe('live')
    expect(live.report.totalAiSessions).toBe(12)
    expect(queryMock).toHaveBeenCalledTimes(1)
    const callArg = queryMock.mock.calls[0][0] as {
      query: string
      query_params: Record<string, unknown>
    }
    expect(callArg.query).toContain('tenant_id = {tenant_id:String}')
    expect(callArg.query_params.tenant_id).toBe('tenant-alpha')
  })

  it('returns not_collected with zeroed metrics (no synthesized AI traffic rows) when ClickHouse and LINKTH CRAWL are unavailable', async () => {
    const report = await getAiseoOverview({
      tenantId: 'tenant-1',
      siteId: 'site-1',
      host: 'link-th.com',
      url: 'https://link-th.com/entry/internal-link-optimization',
      days: 30,
    })

    expect(report.status).toBe('not_collected')
    expect(report.source).toBe('not_collected')
    expect(report.reason).toBeTruthy()
    expect(report.siteId).toBe('site-1')
    expect(report.aiTraffic.totalAiSessions).toBe(0)
    expect(report.aiTraffic.totalAiConversions).toBe(0)
    expect(report.aiTraffic.organicSearchSessions).toBe(0)
    expect(report.aiTraffic.topLandingUrls).toEqual([])
    expect(report.aioCitationDiff.diffs).toEqual([])
    expect(report.aioCitationDiff.competitorGapCount).toBe(0)
    expect(report.semanticAudit.items).toEqual([])
    expect(report.confidence.level).toBe('insufficient')
  })
})
