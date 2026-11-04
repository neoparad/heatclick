import {
  aggregateAiTrafficRows,
  classifyAiTrafficSource,
  getAiseoOverview,
  type RawTrafficEventRow,
} from './ga4-ai-traffic'

describe('lib/aiseo/ga4-ai-traffic (GA4 AI Referral Traffic × AIO Citation Diff × 16-Item Semantic Audit)', () => {
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

  it('aggregates AI source sessions and computes CVR multiplier vs. human organic search', () => {
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
  })

  it('builds complete AiseoOverviewResponse joining GA4 AI traffic, AIO citation diff, and 16-item semantic audit', async () => {
    const report = await getAiseoOverview({
      siteId: 'site-1',
      host: 'link-th.com',
      url: 'https://link-th.com/entry/internal-link-optimization',
      days: 30,
    })

    expect(report.siteId).toBe('site-1')
    expect(report.aiTraffic.totalAiSessions).toBeGreaterThan(0)
    expect(report.aiTraffic.aiCvr).toBeGreaterThan(report.aiTraffic.organicSearchCvr)
    expect(report.aiTraffic.aiVsOrganicCvrMultiplier).toBeGreaterThan(1.5)

    // AI sources include ChatGPT, Perplexity, Gemini, Claude, Microsoft Copilot, Google AI Overview / SGE
    const sources = report.aiTraffic.bySource.map((s) => s.source)
    expect(sources).toContain('ChatGPT')
    expect(sources).toContain('Perplexity')
    expect(sources).toContain('Gemini')
    expect(sources).toContain('Claude')
    expect(sources).toContain('Microsoft Copilot')
    expect(sources).toContain('Google AI Overview / SGE')

    // Top landing URLs & AIO citation diff & 16-item semantic audit
    expect(report.aiTraffic.topLandingUrls.length).toBeGreaterThanOrEqual(3)
    expect(report.aioCitationDiff.diffs.length).toBeGreaterThanOrEqual(2)
    expect(report.aioCitationDiff.competitorGapCount).toBeGreaterThanOrEqual(1)
    expect(report.semanticAudit.items).toHaveLength(16)
    expect(report.confidence.level).toBe('confirmed')
  })
})
