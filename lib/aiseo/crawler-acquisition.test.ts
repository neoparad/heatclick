import type { ClickHouseClient } from '@clickhouse/client'
import {
  analyzeCrawlerPageAcquisition,
  classifyBotFamily,
  normalizeUrlForJoin,
} from './crawler-acquisition'

describe('lib/aiseo/crawler-acquisition', () => {
  describe('normalizeUrlForJoin', () => {
    it('extracts normalized URL, matchKey, pathname, and host for cross-table joins', () => {
      const p1 = normalizeUrlForJoin('https://example.com/Pricing/?utm_source=ai')
      expect(p1.pathname).toBe('/Pricing')
      expect(p1.host).toBe('example.com')
      expect(p1.matchKey).toBe('example.com/Pricing')

      const p2 = normalizeUrlForJoin('https://example.com/')
      expect(p2.pathname).toBe('/')

      const p3 = normalizeUrlForJoin('/features/heatmap/')
      expect(p3.pathname).toBe('/features/heatmap')
      expect(p3.host).toBe('bihadashop.jp')

      const p4 = normalizeUrlForJoin('')
      expect(p4.pathname).toBe('/')
    })
  })

  describe('classifyBotFamily', () => {
    it('classifies OpenAI, Anthropic, Perplexity, and Google AI bots accurately', () => {
      expect(classifyBotFamily('GPTBot')).toBe('openai')
      expect(classifyBotFamily('OAI-SearchBot')).toBe('openai')
      expect(classifyBotFamily('ChatGPT-User')).toBe('openai')
      expect(classifyBotFamily('ClaudeBot')).toBe('anthropic')
      expect(classifyBotFamily('Claude-SearchBot')).toBe('anthropic')
      expect(classifyBotFamily('PerplexityBot')).toBe('perplexity')
      expect(classifyBotFamily('Google-Extended')).toBe('google')
      expect(classifyBotFamily('UnknownCrawler')).toBe('other')
    })
  })

  describe('analyzeCrawlerPageAcquisition (Wave 0: tenant guard & no synthetic bots)', () => {
    it('returns not_collected with empty crawlerAccessSummary and zero SSR score when no live logs exist', async () => {
      const report = await analyzeCrawlerPageAcquisition({
        tenantId: 'tenant-1',
        siteId: 'ugokimap-demo',
        url: 'https://ugokimap.jp/pricing',
        clickhouse: null,
      })

      expect(report.status).toBe('not_collected')
      expect(report.dataSource).toBe('not_collected')
      expect(report.confidence).toBe('insufficient')
      expect(report.reason).toBeTruthy()
      expect(report.siteId).toBe('ugokimap-demo')
      expect(report.url).toContain('/pricing')
      expect(report.ssrVisibilityScore).toBe(0)
      expect(report.crawlerAccessSummary).toEqual([])
      expect(report.acquiredContent.jsonLdSchemas).toEqual([])
      expect(report.acquiredContent.headingChunks).toEqual([])
      expect(report.missedContent.csrHiddenSections).toEqual([])
    })

    it('fails closed (does not query ClickHouse) when tenantId is omitted or default', async () => {
      const queryMock = jest.fn()
      const fakeCh = { query: queryMock } as unknown as ClickHouseClient

      const report = await analyzeCrawlerPageAcquisition({
        siteId: 'ugokimap-demo',
        url: 'https://ugokimap.jp/pricing',
        clickhouse: fakeCh,
      })

      expect(report.status).toBe('not_collected')
      expect(queryMock).not.toHaveBeenCalled()
    })

    it('binds tenant_id in ClickHouse SQL and returns observed bot rows when live logs exist', async () => {
      const queryMock = jest.fn().mockResolvedValue({
        json: async () => [
          {
            bot_name: 'GPTBot',
            hits: 15,
            last_seen: '2026-11-20T01:00:00Z',
            status_code: 200,
            bytes_avg: 32000,
          },
        ],
      })
      const fakeCh = { query: queryMock } as unknown as ClickHouseClient

      const report = await analyzeCrawlerPageAcquisition({
        tenantId: 'tenant-alpha',
        siteId: 'site-1',
        url: 'https://bihadashop.jp/entry/tirtir-cushion-foundation',
        clickhouse: fakeCh,
      })

      expect(report.status).toBe('ok')
      expect(report.dataSource).toBe('clickhouse_live')
      expect(report.crawlerAccessSummary).toHaveLength(1)
      expect(report.crawlerAccessSummary[0].botName).toBe('GPTBot')
      expect(report.crawlerAccessSummary[0].hits).toBe(15)

      const callArg = queryMock.mock.calls[0][0] as {
        query: string
        query_params: Record<string, unknown>
      }
      expect(callArg.query).toContain('tenant_id = {tenant_id:String}')
      expect(callArg.query_params.tenant_id).toBe('tenant-alpha')
      expect(callArg.query_params.site_id).toBe('site-1')
    })
  })
})
