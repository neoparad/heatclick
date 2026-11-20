/**
 * Wave 0 (束 0-A 止血) 回帰テスト:
 *   1. テナント指定抜けクエリ全件に `tenant_id = {tenant_id:String}` が必須バインドされること
 *   2. 本番APIルートおよびクライアントが ClickHouse / 外部API 未接続・0件時に
 *      見本データ（ダミー退避・合成行）を一切返さず `not_collected` + 空データを返すこと
 *   3. 本番APIルート (`app/api/**`) が mock / fixture モジュールを import しないこと
 */

jest.mock('@/lib/aiseo/active-site')
jest.mock('@/lib/auth/server-session')
jest.mock('@/lib/clickhouse')
jest.mock('@/lib/monitoring/dummy-fallback-counter')

import fs from 'node:fs'
import path from 'node:path'
import type { ClickHouseClient } from '@clickhouse/client'
import { NextRequest } from 'next/server'

import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { getServerSession } from '@/lib/auth/server-session'
import { getClickHouseClient } from '@/lib/clickhouse'
import { recordDummyFallback } from '@/lib/monitoring/dummy-fallback-counter'

import { GET as getSiteDoc } from '@/app/api/site-doc/route'
import { GET as getPerformance } from '@/app/api/performance/route'
import { GET as getFusionUrlSummary } from '@/app/api/fusion/url-summary/route'
import { GET as getHeatmap } from '@/app/api/heatmap/route'
import { GET as getHeatmapAgentInsights } from '@/app/api/heatmap/agent-insights/route'
import { GET as getAiseoAcquisition } from '@/app/api/aiseo/acquisition/route'
import { GET as getAiseoOverview } from '@/app/api/aiseo/overview/route'
import { GET as getMlInsights } from '@/app/api/ml/insights/route'
import { GET as getCvJourney } from '@/app/api/cv-journey/route'
import { GET as getAnalytics } from '@/app/api/analytics/route'
import { GET as getVisitRisk } from '@/app/api/visit-risk/route'
import { GET as getJourney } from '@/app/api/journey/route'
import { GET as getSeoAccess } from '@/app/api/seo/access/route'
import { GET as getSeoSitemap } from '@/app/api/seo/sitemap/route'
import { GET as getSeoInternalLinks } from '@/app/api/seo/internal-links/route'

import { analyzeCrawlerPageAcquisition } from '@/lib/aiseo/crawler-acquisition'
import { queryClickHouseAiTraffic } from '@/lib/aiseo/ga4-ai-traffic'
import { loadInternalLinkProposals } from '@/lib/aiseo/internal-link-loader'
import {
  buildAgentHybridInsights,
} from '@/lib/heatmap/agent-heatmap-client'
import {
  fetchAgentBehaviorSummary,
  fetchAgentHeatmapPoints,
} from '@/lib/heatmap/agent-heatmap-server'
import { buildHeatmapViewModel } from '@/lib/heatmap/view-model'
import { resolveHeatmapDisplayState } from '@/lib/heatmap/display-state'
import { MOCKUP_VIEW_MODEL } from '@/lib/fixtures/heatmap-mockup'
import {
  getAioCitationDiff,
  getPerformanceFusion,
  getSiteDocAudit,
  getUrlFusionMl,
  runFusionAnswerEngine,
} from '@/lib/linkscrawl/client'

const mockRequireActiveTenantSite = requireActiveTenantSite as jest.MockedFunction<
  typeof requireActiveTenantSite
>
const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>
const mockGetClickHouseClient = getClickHouseClient as jest.MockedFunction<
  typeof getClickHouseClient
>
const mockRecordDummyFallback = recordDummyFallback as jest.MockedFunction<
  typeof recordDummyFallback
>

const TENANT_ID = 'tenant_wave0_guard'
const SITE_ID = 'CIP_wave0_site'
const TEST_URL = 'https://example.com/pricing'

interface CapturedQuery {
  query: string
  query_params?: Record<string, unknown>
}

const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'CLICKHOUSE_URL',
  'CLICKHOUSE_PASSWORD',
  'HEATMAP_CURSOR_SECRET',
  'HEATMAP_DUMMY_ONLY',
  'CV_JOURNEY_DUMMY_ONLY',
  'LINKSCRAWL_API_URL',
  'LINKSCRAWL_API_KEY',
  'LINKSCRAWL_DATA_ROOT',
  'AIRECEIPT_COLLECTOR_URL',
  'AIRECEIPT_READ_KEY',
  'AIRECEIPT_SITE_ID',
  'AIRECEIPT_INSTALL_ID',
  'AIRECEIPT_INSTALL_KEY',
  'GSC_SA_KEY_JSON',
  'GSC_SA_KEY_FILE',
  'AUTH_DATABASE_URL',
  'DATABASE_URL',
]

function makeActiveTenantSite() {
  return {
    ctx: {
      tenant_id: TENANT_ID,
      user_id: 'user_wave0',
      email: 'wave0@example.com',
      plan: 'growth' as const,
      site_ids: [SITE_ID],
      role: 'owner' as const,
    },
    site: {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      siteName: 'Wave0 Test Site',
      siteUrl: 'https://example.com',
      canonicalHost: 'example.com',
      linkscrawlHost: null,
      linkscrawlJobId: null,
      aireceiptSiteId: null,
      aireceiptInstallId: null,
      gscProperty: null,
      gscSitemapUrl: null,
      cfZoneId: null,
    },
  }
}

describe('Wave 0 (束 0-A 止血): tenant_id 必須バインド & 見本データ完全除去 → not_collected', () => {
  let consoleErrorSpy: jest.SpyInstance
  let consoleInfoSpy: jest.SpyInstance

  beforeAll(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
  })

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
  })

  beforeEach(() => {
    jest.resetAllMocks()
    for (const key of ENV_KEYS) {
      delete process.env[key]
    }
    process.env.HEATMAP_CURSOR_SECRET = 'wave0-test-secret-key-at-least-32-chars'

    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})

    mockRequireActiveTenantSite.mockResolvedValue(
      makeActiveTenantSite() as Awaited<ReturnType<typeof requireActiveTenantSite>>,
    )
    mockGetServerSession.mockResolvedValue({
      tenant_id: TENANT_ID,
      user_id: 'user_wave0',
      role: 'owner',
      user: {
        sub: 'user_wave0',
        tenant_id: TENANT_ID,
        site_ids: [SITE_ID],
        email: 'wave0@example.com',
      },
    } as Awaited<ReturnType<typeof getServerSession>>)
    mockRecordDummyFallback.mockResolvedValue()
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
    consoleInfoSpy.mockRestore()
  })

  describe('1. テナント指定の無いクエリ修正 — 全件で tenant_id = {tenant_id:String} バインド必須', () => {
    function createCapturingCh(rows: unknown[] = []) {
      const captured: CapturedQuery[] = []
      const ch = {
        query: jest.fn(async (args: CapturedQuery) => {
          captured.push(args)
          return { json: async () => rows }
        }),
      } as unknown as ClickHouseClient
      return { ch, captured }
    }

    it('app/api/site-doc/route.ts binds tenant_id from verified session', async () => {
      process.env.CLICKHOUSE_URL = 'http://ch.local:8123'
      process.env.CLICKHOUSE_PASSWORD = 'test-password'
      const { ch, captured } = createCapturingCh([])
      mockGetClickHouseClient.mockReturnValue(ch)

      const req = new NextRequest(
        `https://app.example.com/api/site-doc?url=${encodeURIComponent(TEST_URL)}`,
      )
      const res = await getSiteDoc(req)
      expect(res.status).toBe(200)
      expect(captured).toHaveLength(1)
      expect(captured[0].query).toContain('tenant_id = {tenant_id:String}')
      expect(captured[0].query_params?.tenant_id).toBe(TENANT_ID)
      expect(captured[0].query_params?.site_id).toBe(SITE_ID)
    })

    it('app/api/performance/route.ts binds tenant_id from verified session', async () => {
      process.env.CLICKHOUSE_URL = 'http://ch.local:8123'
      process.env.CLICKHOUSE_PASSWORD = 'test-password'
      const { ch, captured } = createCapturingCh([])
      mockGetClickHouseClient.mockReturnValue(ch)

      const req = new NextRequest(
        `https://app.example.com/api/performance?url=${encodeURIComponent(TEST_URL)}`,
      )
      const res = await getPerformance(req)
      expect(res.status).toBe(200)
      expect(captured).toHaveLength(1)
      expect(captured[0].query).toContain('tenant_id = {tenant_id:String}')
      expect(captured[0].query_params?.tenant_id).toBe(TENANT_ID)
      expect(captured[0].query_params?.site_id).toBe(SITE_ID)
    })

    it('app/api/fusion/url-summary/route.ts binds tenant_id from verified session', async () => {
      process.env.CLICKHOUSE_URL = 'http://ch.local:8123'
      process.env.CLICKHOUSE_PASSWORD = 'test-password'
      const { ch, captured } = createCapturingCh([])
      mockGetClickHouseClient.mockReturnValue(ch)

      const req = new NextRequest(
        `https://app.example.com/api/fusion/url-summary?url=${encodeURIComponent(TEST_URL)}`,
      )
      const res = await getFusionUrlSummary(req)
      expect(res.status).toBe(200)
      expect(captured).toHaveLength(1)
      expect(captured[0].query).toContain('tenant_id = {tenant_id:String}')
      expect(captured[0].query_params?.tenant_id).toBe(TENANT_ID)
      expect(captured[0].query_params?.site_id).toBe(SITE_ID)
    })

    it('lib/aiseo/crawler-acquisition.ts binds tenant_id and fails closed when omitted', async () => {
      const { ch, captured } = createCapturingCh([])

      const blocked = await analyzeCrawlerPageAcquisition({
        siteId: SITE_ID,
        url: TEST_URL,
        clickhouse: ch,
      })
      expect(blocked.status).toBe('not_collected')
      expect(captured).toHaveLength(0)

      await analyzeCrawlerPageAcquisition({
        tenantId: TENANT_ID,
        siteId: SITE_ID,
        url: TEST_URL,
        clickhouse: ch,
      })
      expect(captured).toHaveLength(1)
      expect(captured[0].query).toContain('tenant_id = {tenant_id:String}')
      expect(captured[0].query_params?.tenant_id).toBe(TENANT_ID)
      expect(captured[0].query_params?.site_id).toBe(SITE_ID)
    })

    it('lib/aiseo/ga4-ai-traffic.ts binds tenant_id and fails closed when omitted', async () => {
      const { ch, captured } = createCapturingCh([])

      const blocked = await queryClickHouseAiTraffic({
        clickhouse: ch,
        siteId: SITE_ID,
        days: 30,
      })
      expect(blocked.status).toBe('not_collected')
      expect(captured).toHaveLength(0)

      await queryClickHouseAiTraffic({
        clickhouse: ch,
        tenantId: TENANT_ID,
        siteId: SITE_ID,
        days: 30,
      })
      expect(captured).toHaveLength(1)
      expect(captured[0].query).toContain('tenant_id = {tenant_id:String}')
      expect(captured[0].query_params?.tenant_id).toBe(TENANT_ID)
      expect(captured[0].query_params?.site_id).toBe(SITE_ID)
    })

    it('lib/heatmap/agent-heatmap-client.ts unconditionally binds tenant_id and fails closed without it', async () => {
      const { ch, captured } = createCapturingCh([])

      // Missing / default tenantId must fail closed (0 queries)
      expect(
        await fetchAgentHeatmapPoints({ siteId: SITE_ID, pageUrl: TEST_URL, clickhouse: ch }),
      ).toEqual([])
      expect(
        await fetchAgentBehaviorSummary({
          tenantId: 'default',
          siteId: SITE_ID,
          pageUrl: TEST_URL,
          clickhouse: ch,
        }),
      ).toBeNull()
      expect(captured).toHaveLength(0)

      // Valid tenantId must unconditionally bind tenant_id = {tenant_id:String}
      await fetchAgentHeatmapPoints({
        tenantId: TENANT_ID,
        siteId: SITE_ID,
        pageUrl: TEST_URL,
        clickhouse: ch,
      })
      await fetchAgentBehaviorSummary({
        tenantId: TENANT_ID,
        siteId: SITE_ID,
        pageUrl: TEST_URL,
        clickhouse: ch,
      })
      expect(captured).toHaveLength(2)
      for (const q of captured) {
        expect(q.query).toContain('tenant_id = {tenant_id:String}')
        expect(q.query_params?.tenant_id).toBe(TENANT_ID)
      }
    })
  })

  describe('2. 本番経路の見本データ完全除去 → ClickHouse/外部API未接続・0件時は not_collected', () => {
    it('GET /api/fusion/url-summary returns not_collected and empty planes (never demo-calibrated)', async () => {
      const req = new NextRequest(
        `https://app.example.com/api/fusion/url-summary?url=${encodeURIComponent(TEST_URL)}`,
      )
      const res = await getFusionUrlSummary(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.status).toBe('not_collected')
      expect(body.reason).toBeTruthy()
      expect(body.sources).toEqual({
        behavior: 'not_collected',
        structure: 'not_collected',
        seo: 'not_collected',
        ai: 'not_collected',
      })
      expect(body.behavior.sessions).toBe(0)
      expect(body.structure.lcpMs).toBe(0)
      expect(body.gsc.clicks).toBe(0)
      expect(body.ai.totalVisits).toBe(0)
      expect(body.sections).toEqual([])
      expect(body.diagnoses).toEqual([])
    })

    it('GET /api/heatmap returns not_collected with empty points (never dummy_lcg) when ClickHouse fails or HEATMAP_DUMMY_ONLY=1', async () => {
      process.env.HEATMAP_DUMMY_ONLY = '1'
      mockGetClickHouseClient.mockImplementation(() => {
        throw new Error('ClickHouse offline')
      })

      const req = new Request(
        `https://app.example.com/api/heatmap?site_id=${SITE_ID}&page_url=${encodeURIComponent(TEST_URL)}&heatmap_type=click`,
      )
      const res = await getHeatmap(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)
      expect(body.status).toBe('not_collected')
      expect(body.meta.data_source).toBe('not_collected')
      expect(body.meta.data_source).not.toBe('dummy_lcg')
      expect(body.data.next_cursor).toBeNull()
      expect(body.data.tiles[0].points).toEqual([])
    })

    it('heatmap view-model & display-state treat data_source=not_collected as empty (never MOCKUP_VIEW_MODEL)', () => {
      const vm = buildHeatmapViewModel({
        tiles: [{ y_start: 0, y_end: 2400, points: [], truncated: false }],
        meta: {
          tile_size: 2400,
          page_height_estimate: 66_000,
          cached: false,
          cache_ttl_sec: 0,
          query_hash: 'test',
          data_source: 'not_collected',
          status: 'not_collected',
        },
      })
      expect(vm).not.toBe(MOCKUP_VIEW_MODEL)
      expect(vm.blobs).toEqual([])
      expect(vm.tags).toEqual([])

      expect(
        resolveHeatmapDisplayState({
          dataSource: 'not_collected',
          blobCount: 0,
          tagCount: 0,
          bandCount: 0,
          tileCount: 1,
          loading: false,
          error: null,
        }),
      ).toBe('real-empty')
    })

    it('GET /api/heatmap/agent-insights & buildAgentHybridInsights return not_collected without synthetic hotspots', async () => {
      const req = new Request(
        `https://app.example.com/api/heatmap/agent-insights?site_id=${SITE_ID}&url=${encodeURIComponent(TEST_URL)}`,
      )
      const res = await getHeatmapAgentInsights(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.status).toBe('not_collected')
      expect(body.data.summary.dataSource).toBe('not_collected')
      expect(body.data.summary.totalAgentSessions).toBe(0)
      expect(body.data.frictionHotspots).toEqual([])
      expect(body.data.crawlerSectionOverlays).toEqual([])

      const direct = buildAgentHybridInsights({ siteId: SITE_ID, pageUrl: TEST_URL })
      expect(direct.status).toBe('not_collected')
      expect(direct.summary.dataSource).toBe('not_collected')
    })

    it('GET /api/aiseo/acquisition returns not_collected (never estimated GPTBot rows)', async () => {
      const req = new Request(
        `https://app.example.com/api/aiseo/acquisition?site_id=${SITE_ID}&url=${encodeURIComponent(TEST_URL)}`,
      )
      const res = await getAiseoAcquisition(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.status).toBe('not_collected')
      expect(body.data.status).toBe('not_collected')
      expect(body.data.dataSource).toBe('not_collected')
      expect(body.data.crawlerAccessSummary).toEqual([])
      expect(body.data.ssrVisibilityScore).toBe(0)
    })

    it('GET /api/aiseo/overview returns not_collected (never synthesized AI traffic)', async () => {
      const req = new NextRequest(
        `https://app.example.com/api/aiseo/overview?url=${encodeURIComponent(TEST_URL)}`,
      )
      const res = await getAiseoOverview(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.status).toBe('not_collected')
      expect(body.source).toBe('not_collected')
      expect(body.aiTraffic.totalAiSessions).toBe(0)
      expect(body.aiTraffic.topLandingUrls).toEqual([])
      expect(body.aioCitationDiff.diffs).toEqual([])
    })

    it('GET /api/ml/insights returns explicit status=not_collected and source=not_collected with null/empty ML fields', async () => {
      const req = new NextRequest(
        `https://app.example.com/api/ml/insights?url=${encodeURIComponent(TEST_URL)}`,
      )
      const res = await getMlInsights(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.ok).toBe(true)
      expect(body.status).toBe('not_collected')
      expect(body.source).toBe('not_collected')
      expect(body.reason).toBeTruthy()
      expect(body.data.bottleneckAttribution).toBeNull()
      expect(body.data.scrollSurvival).toBeNull()
      expect(body.data.semanticLinks).toEqual([])
    })

    it('lib/linkscrawl/client returns not_collected across all 5 BFF methods when offline', async () => {
      const [doc, perf, ml, aio, chat] = await Promise.all([
        getSiteDocAudit({ siteId: SITE_ID, url: TEST_URL }),
        getPerformanceFusion({ siteId: SITE_ID, url: TEST_URL }),
        getUrlFusionMl({ siteId: SITE_ID, url: TEST_URL }),
        getAioCitationDiff({ siteId: SITE_ID, url: TEST_URL }),
        runFusionAnswerEngine({ siteId: SITE_ID, url: TEST_URL, message: 'test' }),
      ])

      for (const r of [doc, perf, ml, aio, chat]) {
        expect(r.status).toBe('not_collected')
        expect(r.source).toBe('not_collected')
        expect(r.reason).toBeTruthy()
      }
      expect(doc.totalDetectionRules).toBe(0)
      expect(perf.behaviorCvLossFusion.estimatedMonthlyLostRevenueJpy).toBe(0)
      expect(ml.cvrPrediction.featureCountUsed).toBe(0)
      expect(aio.diffs).toEqual([])
      expect(chat.citations).toEqual([])
    })

    it('GET /api/cv-journey returns not_collected when ClickHouse fails (never dummy)', async () => {
      mockGetClickHouseClient.mockImplementation(() => {
        throw new Error('CH unreachable')
      })
      const req = new Request(`https://app.example.com/api/cv-journey?site_id=${SITE_ID}`)
      const res = await getCvJourney(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.status).toBe('not_collected')
      expect(body.meta.dataSource).toBe('not_collected')
      expect(body.data.steps).toEqual([])
      expect(body.data.totals.totalSessions).toBe(0)
    })

    it('collector / GSC / linkscrawl API routes & internal-link-loader return not_collected when unconfigured', async () => {
      const [
        analyticsRes,
        visitRiskRes,
        journeyRes,
        seoAccessRes,
        seoSitemapRes,
        seoLinksRes,
        linkBatch,
      ] = await Promise.all([
        getAnalytics(new Request('https://app.example.com/api/analytics')),
        getVisitRisk(new Request('https://app.example.com/api/visit-risk')),
        getJourney(new Request('https://app.example.com/api/journey')),
        getSeoAccess(new NextRequest('https://app.example.com/api/seo/access')),
        getSeoSitemap(new NextRequest('https://app.example.com/api/seo/sitemap')),
        getSeoInternalLinks(new NextRequest('https://app.example.com/api/seo/internal-links')),
        loadInternalLinkProposals({ tenantId: TENANT_ID, siteId: SITE_ID }),
      ])

      for (const res of [
        analyticsRes,
        visitRiskRes,
        journeyRes,
        seoAccessRes,
        seoSitemapRes,
        seoLinksRes,
      ]) {
        const body = await res.json()
        expect(res.status).toBe(200)
        expect(body.status).toBe('not_collected')
        expect(body.source).toBe('not_collected')
        expect(body.reason).toBeTruthy()
      }

      expect(linkBatch.status).toBe('not_collected')
      expect(linkBatch.source).toBe('not_collected')
      expect(linkBatch.proposals).toEqual([])
    })
  })

  describe('3. 静的ガード: 本番 API ルート (`app/api/**`) に見本モジュール import・旧ダミー識別子が残存しないこと', () => {
    function collectRouteFiles(dir: string): string[] {
      const out: string[] = []
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          out.push(...collectRouteFiles(full))
        } else if (entry.isFile() && entry.name === 'route.ts') {
          out.push(full)
        }
      }
      return out
    }

    it('no app/api/**/route.ts imports mock/fixture modules or emits legacy synthetic source tags', () => {
      const apiRoot = path.join(process.cwd(), 'app', 'api')
      const routeFiles = collectRouteFiles(apiRoot)
      expect(routeFiles.length).toBeGreaterThan(20)

      const forbiddenPatterns = [
        /from\s+['"]@\/lib\/aiseo\/mock['"]/,
        /from\s+['"]@\/lib\/seo\/mock['"]/,
        /from\s+['"]@\/lib\/cv-journey\/fixtures['"]/,
        /\bbuildFusionDatasetForUrl\b/,
        /'fallback_synthesized'/,
        /'demo-calibrated'/,
        /'deterministic_hybrid'/,
        /'clickhouse_plus_heuristic'/,
        /'dummy_lcg'/,
      ]

      const violations: string[] = []
      for (const file of routeFiles) {
        const rel = path.relative(process.cwd(), file)
        const rawSrc = fs.readFileSync(file, 'utf8')
        // Strip block and line comments so explanatory docstrings do not trigger false positives
        const codeOnly = rawSrc
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/[^\n]*/g, '')
        for (const pat of forbiddenPatterns) {
          if (pat.test(codeOnly)) {
            violations.push(`${rel} matched ${pat}`)
          }
        }
      }

      expect(violations).toEqual([])
    })
  })
})
