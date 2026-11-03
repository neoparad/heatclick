import {
  confidenceReason,
  deriveSignals,
  groupConfidence,
  scoreConfidence,
  summarizeConfidence,
  withConfidence,
} from './confidence'
import {
  deriveRisk,
  detectBurst,
  groupUnknownUA,
  guessKind,
  profileBlankUA,
  unknownFlags,
} from './risk'
import { buildJourneys, fmtDuration, summarizeJourneys } from './journey'
import { checkDeclarationFiles, looksLikeCoverageGap } from './declaration-files'
import { buildCollectorAuthHeaders, collectorConfigured } from './collector'
import { generateMockAnalytics, generateMockJourney, generateMockVisitRisk } from './mock'

describe('lib/aiseo/confidence', () => {
  it('scores 0 signals as insufficient, 1 signal as suspected, >=2 distinct signal kinds as confirmed', () => {
    expect(scoreConfidence([])).toBe('insufficient')
    expect(scoreConfidence([{ kind: 'identity' }, { kind: 'identity' }])).toBe('suspected')
    expect(scoreConfidence([{ kind: 'behavior_target' }, { kind: 'behavior_tempo' }])).toBe(
      'confirmed',
    )
  })

  it('keeps spoof at suspected because S9 network/crypto verification is not yet connected', () => {
    const flags = withConfidence([{ type: 'spoof', severity: 'high', agent: 'GPTBot', hits: 10 }])
    expect(flags[0].confidence).toBe('suspected')
    expect(flags[0].confidence_reason).toContain('1系統のみ')
  })

  it('promotes scan_probe on empty UA with high 404 rate to confirmed (2 independent signal kinds)', () => {
    const signals = deriveSignals(
      { type: 'scan_probe', agent: '(空UA)' },
      { blank: { notFoundRate: 0.75, burst: null } },
    )
    expect(signals.map((s) => s.kind)).toEqual(['behavior_target', 'behavior_tempo'])
    expect(scoreConfidence(signals)).toBe('confirmed')
  })

  it('treats empty UA unknown_ua flag as insufficient (absence of UA is not a positive signal)', () => {
    const flags = withConfidence([{ type: 'unknown_ua', agent: '(空UA)', hits: 20 }])
    expect(flags[0].confidence).toBe('insufficient')
    expect(confidenceReason(flags[0], flags[0].signals)).toContain('1系統も揃っていない')
  })

  it('summarizes confidence counts and percentages and computes groupConfidence consistently', () => {
    const mock = generateMockVisitRisk()
    const blank = profileBlankUA(mock.unknown_events)
    const refined = [
      ...mock.flags.filter((f) => f.type !== 'unknown_ua'),
      ...unknownFlags(mock.unknown_events),
    ]
    const withConf = withConfidence(refined, { blank })
    const summary = summarizeConfidence(withConf)
    expect(summary.total).toBe(withConf.length)
    expect(summary.confirmed + summary.suspected + summary.insufficient).toBe(summary.total)

    const groups = groupUnknownUA(mock.unknown_events)
    const emptyGroup = groups.find((g) => g.raw_ua === '')
    expect(groupConfidence(emptyGroup)).toBe('confirmed')
  })
})

describe('lib/aiseo/risk', () => {
  it('derives spoof, overcollection, unknown_ua, and pending robots flags', () => {
    const mock = generateMockVisitRisk()
    expect(mock.summary.spoof_count).toBe(1)
    expect(mock.summary.overcollection_count).toBe(1)
    expect(mock.flags.some((f) => f.type === 'robots' && f.status === 'enrichment待ち')).toBe(true)
  })

  it('detects bursts and profiles blank UA cohorts', () => {
    const burst = detectBurst([1000, 2000, 3000, 4000, 90000], 10000)
    expect(burst).not.toBeNull()
    expect(burst?.count).toBe(4)

    const mock = generateMockVisitRisk()
    const profile = profileBlankUA(mock.unknown_events)
    expect(profile).not.toBeNull()
    expect(profile?.verdict).toBe('機械的な脆弱性スキャン')
  })

  it('guesses UA kind for known crawlers, python scripts, and custom bots', () => {
    expect(guessKind('Mozilla/5.0 (compatible; AhrefsBot/7.0)')).toContain('既知クローラー: AhrefsBot')
    expect(guessKind('python-requests/2.31.0')).toBe('Pythonスクリプト')
    expect(guessKind('Mozilla/5.0 (compatible; CustomSpider/1.0)')).toContain('自称ボット(未登録): CustomSpider')
  })
})

describe('lib/aiseo/journey & declaration-files', () => {
  it('groups agent events into sessions by 30-min gap', () => {
    const mock = generateMockJourney()
    const gptSessions = buildJourneys(mock.events, 'GPTBot')
    expect(gptSessions.length).toBe(1)
    expect(gptSessions[0].pages).toBe(6)

    const chatSessions = buildJourneys(mock.events, 'ChatGPT-User')
    expect(chatSessions.length).toBe(2)
    const sum = summarizeJourneys(chatSessions)
    expect(sum.sessionCount).toBe(2)
    expect(sum.totalPages).toBe(5)
    expect(fmtDuration(75000)).toBe('1分15秒')
  })

  it('checks declaration file hits and control coverage gap', () => {
    const mock = generateMockAnalytics()
    const checked = checkDeclarationFiles(mock.urls.urls)
    const robots = checked.find((c) => c.path === '/robots.txt')
    expect(robots?.hit).toBe(true)
    expect(looksLikeCoverageGap(checked)).toBe(false)
    expect(looksLikeCoverageGap(checkDeclarationFiles([]))).toBe(true)
  })
})

describe('lib/aiseo/collector', () => {
  it('builds saas-read headers bound to siteId when readKey and siteId are provided', () => {
    const readKey = Buffer.alloc(32, 9).toString('base64')
    expect(
      collectorConfigured({
        baseUrl: 'https://collector.example',
        readKey,
        siteId: 'site_bihada',
      }),
    ).toBe(true)

    const headers = buildCollectorAuthHeaders('/v0/analytics/urls', {
      baseUrl: 'https://collector.example',
      readKey,
      siteId: 'site_bihada',
      ts: '1700000000000',
    })
    expect(headers['X-Aireceipt-Principal']).toBe('saas-read')
    expect(headers['X-Aireceipt-Site']).toBe('site_bihada')
    expect(headers['X-Aireceipt-Ts']).toBe('1700000000000')
    expect(headers['X-Aireceipt-Sig']).toBeTruthy()
  })

  it('falls back to X-Aireceipt-Install when only installId and installKey are provided', () => {
    const installKey = Buffer.alloc(32, 5).toString('base64')
    const headers = buildCollectorAuthHeaders('/v0/analytics/urls', {
      baseUrl: 'https://collector.example',
      installId: 'inst_123',
      installKey,
      ts: '1700000000000',
    })
    expect(headers['X-Aireceipt-Install']).toBe('inst_123')
    expect(headers['X-Aireceipt-Principal']).toBeUndefined()
  })
})
