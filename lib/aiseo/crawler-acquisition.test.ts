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

  describe('analyzeCrawlerPageAcquisition', () => {
    it('returns full SSR/CSR acquisition & missed content report for /pricing', async () => {
      const report = await analyzeCrawlerPageAcquisition({
        siteId: 'ugokimap-demo',
        url: 'https://ugokimap.jp/pricing',
      })

      expect(report.siteId).toBe('ugokimap-demo')
      expect(report.url).toContain('/pricing')
      expect(report.ssrVisibilityScore).toBeGreaterThanOrEqual(0)
      expect(report.ssrVisibilityScore).toBeLessThanOrEqual(100)
      expect(report.semanticAuditSummary.citationReadinessScore).toBeGreaterThanOrEqual(0)
      expect(report.crawlerAccessSummary.length).toBeGreaterThanOrEqual(4)

      // Bots include GPTBot, ClaudeBot, PerplexityBot
      const botNames = report.crawlerAccessSummary.map((b) => b.botName)
      expect(botNames).toContain('GPTBot')
      expect(botNames).toContain('ClaudeBot')
      expect(botNames).toContain('PerplexityBot')

      // Acquired content includes title, JSON-LD, headingChunks
      expect(report.acquiredContent.title).toBeTruthy()
      expect(report.acquiredContent.jsonLdSchemas.length).toBeGreaterThan(0)
      expect(report.acquiredContent.headingChunks.length).toBeGreaterThan(0)
      expect(report.acquiredContent.extractedInternalLinksCount).toBeGreaterThan(0)

      // Missed CSR sections have reasons, impact levels, and copyable remediation patches
      expect(report.missedContent.csrHiddenSections.length).toBeGreaterThan(0)
      for (const missed of report.missedContent.csrHiddenSections) {
        expect(missed.sectionName).toBeTruthy()
        expect(missed.selector).toBeTruthy()
        expect(missed.missedInformationSummary).toBeTruthy()
        expect(missed.remediationPatch.length).toBeGreaterThan(20)
        expect(['high', 'medium', 'low']).toContain(missed.impactLevel)
      }
    })

    it('detects 100% SSR visibility with zero missed sections for machine-readable files (/robots.txt)', async () => {
      const report = await analyzeCrawlerPageAcquisition({
        siteId: 'ugokimap-demo',
        url: '/robots.txt',
      })

      expect(report.url).toContain('/robots.txt')
      expect(report.ssrVisibilityScore).toBe(100)
      expect(report.missedContent.csrHiddenSections).toHaveLength(0)
      expect(report.crawlerAccessSummary.every((b) => b.extractionStatus === 'full_ssr')).toBe(
        true,
      )
    })

    it('supports beauty/editorial product URLs (/entry/...) with Product & FAQ JSON-LD diagnostics', async () => {
      const report = await analyzeCrawlerPageAcquisition({
        siteId: 'Default',
        url: 'https://bihadashop.jp/entry/tirtir-cushion-foundation',
      })

      expect(report.url).toContain('/entry/tirtir-cushion-foundation')
      const schemaTypes = report.acquiredContent.jsonLdSchemas.map((s) => s.type)
      expect(schemaTypes).toContain('Product')
      expect(report.missedContent.csrHiddenSections.length).toBeGreaterThan(0)
    })
  })
})
