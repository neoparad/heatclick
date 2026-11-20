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

  describe('buildAgentHybridInsights (Wave 0: no fabricated fallback synthesis)', () => {
    it('returns not_collected with zeroed summary and empty arrays when no live ClickHouse data exists', () => {
      const insights = buildAgentHybridInsights({
        siteId: 'ugokimap-demo',
        pageUrl: 'https://ugokimap.jp/pricing',
        agentSubtype: 'all',
      })

      expect(insights.status).toBe('not_collected')
      expect(insights.reason).toBeTruthy()
      expect(insights.siteId).toBe('ugokimap-demo')
      expect(insights.agentSubtype).toBe('all')
      expect(insights.summary.dataSource).toBe('not_collected')
      expect(insights.summary.totalAgentSessions).toBe(0)
      expect(insights.summary.totalAgentClicks).toBe(0)
      expect(insights.summary.totalDeadClicks).toBe(0)
      expect(insights.summary.totalRageClicks).toBe(0)
      expect(insights.summary.avgScrollDepthPct).toBe(0)
      expect(insights.summary.targetedCtas).toEqual([])
      expect(insights.summary.topAgentTypes).toEqual([])
      expect(insights.frictionHotspots).toEqual([])
      expect(insights.crawlerSectionOverlays).toEqual([])
      expect(insights.subtypeCounts).toEqual({
        all: 0,
        webdriver: 0,
        headless: 0,
        ai_user_agent: 0,
        heuristic_multi: 0,
      })
    })

    it('builds live insights strictly from observed rawPoints and rawSummary without fabricated hotspots or overlays', () => {
      const withLive = buildAgentHybridInsights({
        siteId: 'ugokimap-demo',
        pageUrl: '/features',
        agentSubtype: 'webdriver',
        rawSummary: {
          totalAgentSessions: 14,
          totalAgentClicks: 31,
          totalDeadClicks: 7,
          totalRageClicks: 2,
          avgScrollDepthPct: 62,
          dataSource: 'clickhouse_live',
        },
        rawPoints: [
          {
            x: 420,
            y: 800,
            count: 7,
            sessions: 5,
            selector: 'div.live-custom-toggle',
            eventType: 'dead_click',
          },
        ],
      })

      expect(withLive.status).toBe('ok')
      expect(withLive.summary.dataSource).toBe('clickhouse_live')
      expect(withLive.summary.totalAgentSessions).toBe(14)
      expect(withLive.frictionHotspots).toHaveLength(1)
      expect(withLive.frictionHotspots[0]?.selector).toBe('div.live-custom-toggle')
      expect(withLive.frictionHotspots[0]?.deadClickCount).toBe(7)
      expect(withLive.crawlerSectionOverlays).toEqual([])
      expect(withLive.subtypeCounts.webdriver).toBe(14)
    })
  })
})
