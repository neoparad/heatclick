import {
  AGENT_SUBTYPE_OPTIONS,
  buildAgentHybridInsights,
  parseAgentSubtype,
} from './agent-heatmap-client'

describe('lib/heatmap/agent-heatmap-client', () => {
  describe('parseAgentSubtype', () => {
    it('parses valid subtypes and falls back to all for unknown values', () => {
      expect(parseAgentSubtype('all')).toBe('all')
      expect(parseAgentSubtype('webdriver')).toBe('webdriver')
      expect(parseAgentSubtype('headless')).toBe('headless')
      expect(parseAgentSubtype('ai_user_agent')).toBe('ai_user_agent')
      expect(parseAgentSubtype('heuristic_multi')).toBe('heuristic_multi')
      expect(parseAgentSubtype('invalid_subtype')).toBe('all')
      expect(parseAgentSubtype(null)).toBe('all')
      expect(parseAgentSubtype(undefined)).toBe('all')
    })

    it('exports AGENT_SUBTYPE_OPTIONS with all 5 subtype keys', () => {
      expect(AGENT_SUBTYPE_OPTIONS.map((o) => o.key)).toEqual([
        'all',
        'webdriver',
        'headless',
        'ai_user_agent',
        'heuristic_multi',
      ])
    })
  })

  describe('buildAgentHybridInsights', () => {
    it('returns full summary, frictionHotspots, and crawlerSectionOverlays for /pricing', () => {
      const insights = buildAgentHybridInsights({
        siteId: 'ugokimap-demo',
        pageUrl: 'https://ugokimap.jp/pricing',
        agentSubtype: 'all',
      })

      expect(insights.siteId).toBe('ugokimap-demo')
      expect(insights.agentSubtype).toBe('all')
      expect(insights.summary.totalAgentSessions).toBeGreaterThan(0)
      expect(insights.summary.totalAgentClicks).toBeGreaterThan(0)
      expect(insights.summary.totalDeadClicks).toBeGreaterThan(0)
      expect(insights.summary.avgScrollDepthPct).toBeGreaterThan(0)
      expect(insights.summary.avgScrollDepthPct).toBeLessThanOrEqual(100)
      expect(insights.summary.targetedCtas.length).toBeGreaterThan(0)

      // Friction hotspots
      expect(insights.frictionHotspots.length).toBeGreaterThan(0)
      for (const h of insights.frictionHotspots) {
        expect(h.label).toBeTruthy()
        expect(h.selector).toBeTruthy()
        expect(h.deadClickCount).toBeGreaterThan(0)
        expect(h.fixRecommendation).toBeTruthy()
      }

      // HTTP crawler section overlays
      expect(insights.crawlerSectionOverlays.length).toBeGreaterThan(0)
      const statuses = insights.crawlerSectionOverlays.map((s) => s.httpCrawlerStatus)
      expect(statuses).toContain('extracted')
      expect(statuses).toContain('csr_blind_spot')

      // Subtype counts
      expect(insights.subtypeCounts.all).toBe(insights.summary.totalAgentSessions)
      expect(insights.subtypeCounts.webdriver).toBeGreaterThan(0)
      expect(insights.subtypeCounts.headless).toBeGreaterThan(0)
      expect(insights.subtypeCounts.ai_user_agent).toBeGreaterThan(0)
    })

    it('filters frictionHotspots and adjusts session counts when agentSubtype is specified', () => {
      const allInsights = buildAgentHybridInsights({
        siteId: 'ugokimap-demo',
        pageUrl: '/pricing',
        agentSubtype: 'all',
      })
      const webdriverInsights = buildAgentHybridInsights({
        siteId: 'ugokimap-demo',
        pageUrl: '/pricing',
        agentSubtype: 'webdriver',
      })
      const aiUaInsights = buildAgentHybridInsights({
        siteId: 'ugokimap-demo',
        pageUrl: '/pricing',
        agentSubtype: 'ai_user_agent',
      })

      expect(webdriverInsights.summary.totalAgentSessions).toBeLessThan(
        allInsights.summary.totalAgentSessions,
      )
      expect(
        webdriverInsights.frictionHotspots.every((h) =>
          h.agentTypes.some((a) => a.includes('Playwright')),
        ),
      ).toBe(true)
      expect(
        aiUaInsights.frictionHotspots.every((h) =>
          h.agentTypes.some((a) => a.includes('ChatGPT') || a.includes('Perplexity')),
        ),
      ).toBe(true)
    })

    it('merges rawPoints when live dead_click points are provided', () => {
      const withLive = buildAgentHybridInsights({
        siteId: 'ugokimap-demo',
        pageUrl: '/features',
        agentSubtype: 'all',
        rawPoints: [
          {
            x: 420,
            y: 800,
            value: 150,
            count: 150,
            selector: 'div.live-custom-toggle',
            eventType: 'dead_click',
          },
        ],
      })

      expect(withLive.frictionHotspots[0]?.selector).toBe('div.live-custom-toggle')
      expect(withLive.frictionHotspots[0]?.deadClickCount).toBeGreaterThanOrEqual(150)
    })
  })
})
