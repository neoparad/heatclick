import { generateKeyPairSync } from 'node:crypto'

import {
  SEGMENTER_CONTENT_HASH,
  segmentHtml,
} from '@/packages/contract/segmenter'
import {
  isUntrustedValue,
  validateSerializedEnvelope,
} from '@/packages/contract/response'

import {
  CRAWL_CONTRACT_VERSION,
  DEFAULT_LAB_BLOCKLIST,
  DEVICE_PROFILES,
  DeterministicCrawlContractStub,
  DeterministicHtmlRenderDriver,
  ImmutableSnapshotError,
  LabSnapshotStore,
  SecondaryLabRenderer,
  allocateSectionUid,
  assertNotStubInProduction,
  assertValidLinkGrant,
  computeDailyRenderCapacity,
  createPlaywrightRenderDriver,
  createSnapshotFromRender,
  evaluateLabNetworkRequest,
  evaluateRenderCapacityGate,
  evaluateRobotsTxt,
  resolveSectionLineage,
  runOperabilityAudit,
  signLinkGrantAssertion,
  type LinkGrantAssertion,
  type PlaywrightLikeBrowser,
  type PlaywrightLikeRoute,
} from './index'

const FIXED_NOW = new Date('2026-11-20T12:00:00.000Z')

function makeValidGrant(
  scopes: LinkGrantAssertion['scopes'] = [
    'structure:identity',
    'structure:render',
    'url:probe',
    'probe:run',
  ],
): LinkGrantAssertion {
  return signLinkGrantAssertion({
    link_grant_id: 'grant_site_bihada_01',
    tenant_id: 'tenant_1',
    site_id: 'site_bihada',
    issued_at: '2026-11-20T11:58:00.000Z',
    expires_at: '2026-11-20T12:03:00.000Z', // 300s lifetime
    scopes,
    host_patterns: ['bihadashop.jp'],
  })
}

const SAMPLE_ARTICLE_HTML = `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>敏感肌向け化粧水おすすめ比較 | bihadashop.jp</title>
    <meta name="description" content="皮膚科医監修の化粧水比較ガイド">
    <link rel="canonical" href="https://bihadashop.jp/column/lotion-guide">
    <link rel="stylesheet" href="/assets/main.css?v=3">
    <script src="/assets/app.js?ver=9"></script>
  </head>
  <body>
    <header><a href="https://bihadashop.jp/">ホーム</a></header>
    <main>
      <article>
        <h1>敏感肌向け化粧水おすすめ比較</h1>
        <p>乾燥や刺激が気になる敏感肌に向けた選び方を解説します。</p>
        <h2>成分のチェックポイント</h2>
        <p>ヒト型セラミドやナイアシンアミド配合の処方を選びましょう。</p>
        <h3>避けたい添加物</h3>
        <ul>
          <li>高濃度エタノール</li>
          <li>合成香料・合成着色料</li>
        </ul>
        <h2>おすすめ商品リンク</h2>
        <p>
          <a href="https://px.a8.net/svt/ejp?a8mat=TEST001" data-lab-rect="24,420,220,48">公式サイトで詳しく見る</a>
        </p>
        <form action="/newsletter" method="POST">
          <label for="nl-email">メールアドレス</label>
          <input id="nl-email" name="email" type="email" data-lab-rect="24,520,280,44">
          <button type="submit" data-lab-rect="24,580,160,44">登録する</button>
        </form>
      </article>
    </main>
    <footer><a href="https://bihadashop.jp/privacy">プライバシー</a></footer>
  </body>
</html>`

describe('Bundle 2-C (Step 5): Inspection Lab Environment (lib/link/lab)', () => {
  describe('1. Secondary Renderer: Segmenter Parity, Real Device Profiles & Unmeasured Nulls', () => {
    it('matches packages/contract/segmenter 100% identically across id_only and full renders (desktop + mobile)', async () => {
      const driver = new DeterministicHtmlRenderDriver()
      const url = 'https://bihadashop.jp/column/lotion-guide'
      driver.registerPage(url, { html: SAMPLE_ARTICLE_HTML })

      const renderer = new SecondaryLabRenderer({ driver, now: () => FIXED_NOW })
      const directSeg = segmentHtml(SAMPLE_ARTICLE_HTML, { url })

      const idOnlyDesktop = await renderer.renderPage({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        url,
        job_class: 'id_only',
        profile: DEVICE_PROFILES.desktop_chromium,
      })

      const fullDesktop = await renderer.renderPage({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        url,
        job_class: 'full',
        profile: DEVICE_PROFILES.desktop_chromium,
      })

      const fullMobile = await renderer.renderPage({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        url,
        job_class: 'full',
        profile: DEVICE_PROFILES.mobile_android_chromium,
      })

      const fullIosWebkit = await renderer.renderPage({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        url,
        job_class: 'full',
        profile: DEVICE_PROFILES.mobile_ios_webkit,
      })

      // 100% byte-identical segmenter output across all job classes & device profiles (surf.second_executor)
      expect(idOnlyDesktop.status).toBe('ok')
      expect(idOnlyDesktop.segmenter_hash).toBe(SEGMENTER_CONTENT_HASH)
      expect(idOnlyDesktop.segmenter_output).toEqual(directSeg)
      expect(fullDesktop.segmenter_output).toEqual(directSeg)
      expect(fullMobile.segmenter_output).toEqual(directSeg)
      expect(fullIosWebkit.segmenter_output).toEqual(directSeg)

      // Unmeasured fields on id_only MUST be strictly null (NEVER 0)
      expect(idOnlyDesktop.doc_h_px).toBeNull()
      expect(idOnlyDesktop.section_geometries).toBeNull()
      expect(idOnlyDesktop.screenshot).toBeNull()
      expect(idOnlyDesktop.element_details.length).toBeGreaterThan(0)
      for (const el of idOnlyDesktop.element_details) {
        expect(el.rect).toBeNull()
        expect(el.occluded).toBeNull()
        expect(el.hover_only_reveal).toBeNull()
        expect(el.computed_style).toBeNull()
      }

      // Real mobile profile flags & non-colliding screenshot keys (§15 item 6)
      expect(DEVICE_PROFILES.mobile_android_chromium.is_mobile).toBe(true)
      expect(DEVICE_PROFILES.mobile_android_chromium.has_touch).toBe(true)
      expect(DEVICE_PROFILES.mobile_ios_webkit.engine).toBe('webkit')
      expect(fullDesktop.screenshot).not.toBeNull()
      expect(fullMobile.screenshot).not.toBeNull()
      expect(fullDesktop.screenshot!.storage_key).not.toBe(fullMobile.screenshot!.storage_key)
      expect(fullDesktop.screenshot!.pixel_ratio).toBe(1)
    })

    it('supports Playwright driver adapter with page.route network interception & segmenter parity', async () => {
      const abortedUrls: string[] = []
      const continuedUrls: string[] = []

      const fakeBrowser: PlaywrightLikeBrowser = {
        async newContext() {
          return {
            async newPage() {
              let routeHandler: ((route: PlaywrightLikeRoute) => Promise<void> | void) | null = null
              return {
                async setViewportSize() {},
                async route(_pattern, handler) {
                  routeHandler = handler
                },
                async goto(targetUrl) {
                  const simulatedReqs = [
                    targetUrl,
                    'https://bihadashop.jp/assets/main.css?v=3',
                    'https://px.a8.net/svt/ejp?a8mat=SHOULD_BLOCK',
                    'https://www.google-analytics.com/g/collect',
                    'https://collect.ugokilink.jp/v1/frames',
                  ]
                  for (const reqUrl of simulatedReqs) {
                    if (routeHandler) {
                      await routeHandler({
                        request: () => ({ url: () => reqUrl, isNavigationRequest: () => reqUrl === targetUrl }),
                        abort: async () => {
                          abortedUrls.push(reqUrl)
                        },
                        continue: async () => {
                          continuedUrls.push(reqUrl)
                        },
                      })
                    }
                  }
                  return { status: () => 200, url: () => targetUrl }
                },
                async content() {
                  return SAMPLE_ARTICLE_HTML
                },
                async evaluate<T>() {
                  return 1840 as unknown as T
                },
                async screenshot() {
                  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
                },
                async close() {},
              }
            },
            async close() {},
          }
        },
      }

      const pwDriver = createPlaywrightRenderDriver(async () => fakeBrowser)
      const renderer = new SecondaryLabRenderer({ driver: pwDriver, now: () => FIXED_NOW })
      const url = 'https://bihadashop.jp/column/lotion-guide'
      const res = await renderer.renderPage({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        url,
        job_class: 'full',
        profile: DEVICE_PROFILES.desktop_chromium,
      })

      expect(res.status).toBe('ok')
      expect(res.segmenter_output).toEqual(segmentHtml(SAMPLE_ARTICLE_HTML, { url }))
      expect(res.egress_audit.affiliate_requests_sent).toBe(0)
      expect(res.egress_audit.affiliate_requests_blocked).toBe(1)
      expect(res.egress_audit.collector_requests_blocked).toBe(1)
      expect(abortedUrls).toContain('https://px.a8.net/svt/ejp?a8mat=SHOULD_BLOCK')
      expect(abortedUrls).toContain('https://collect.ugokilink.jp/v1/frames')
      expect(continuedUrls).toContain(url)
      expect(res.doc_h_px).toBe(1840)
    })

    it('guarantees ZERO requests to registered affiliate, analytics, ad, and render-mode collector hosts (§6.5 / §6.7)', async () => {
      const driver = new DeterministicHtmlRenderDriver()
      const url = 'https://bihadashop.jp/column/lotion-guide'
      driver.registerPage(url, {
        html: SAMPLE_ARTICLE_HTML,
        subresource_urls: [
          'https://bihadashop.jp/assets/main.css',
          'https://px.a8.net/svt/ejp?a8mat=1',
          'https://t.afb.ne.jp/click?id=2',
          'https://hb.afl.rakuten.co.jp/hgc/3',
          'https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=4',
          'https://h.accesstrade.net/sp/cc?rk=5',
          'https://www.google-analytics.com/analytics.js',
          'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
          'https://collect.ugokilink.jp/v1/frames',
          { url: 'https://unregistered-external.example/redirect', is_redirect: true },
        ],
      })

      const renderer = new SecondaryLabRenderer({ driver, now: () => FIXED_NOW })
      const res = await renderer.renderPage({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        url,
        job_class: 'id_only',
        profile: DEVICE_PROFILES.desktop_chromium,
        lab_purpose: 'render',
      })

      expect(res.status).toBe('ok')
      expect(res.egress_audit.affiliate_requests_sent).toBe(0)
      expect(res.egress_audit.affiliate_requests_blocked).toBe(5)
      expect(res.egress_audit.collector_requests_blocked).toBe(1)
      expect(
        res.egress_audit.entries.some((e) => e.reason === 'blocked_external_redirect'),
      ).toBe(true)

      // Collector policy: allowed for canary_visit ONLY when lab_token is supplied (§12.2)
      const canaryNoToken = evaluateLabNetworkRequest('https://collect.ugokilink.jp/v1/frames', {
        targetHost: 'bihadashop.jp',
        labPurpose: 'canary_visit',
        labToken: null,
      })
      expect(canaryNoToken.action).toBe('block')
      expect(canaryNoToken.reason).toBe('blocked_collector_missing_lab_token')

      const canaryWithToken = evaluateLabNetworkRequest('https://collect.ugokilink.jp/v1/frames', {
        targetHost: 'bihadashop.jp',
        labPurpose: 'canary_visit',
        labToken: 'lab_tok_signed_123',
      })
      expect(canaryWithToken.action).toBe('allow')
      expect(canaryWithToken.reason).toBe('allowed_collector_with_lab_token')

      // SSRF private IP check
      const ssrf = evaluateLabNetworkRequest('http://169.254.169.254/latest/meta-data/', {
        targetHost: 'bihadashop.jp',
        labPurpose: 'render',
      })
      expect(ssrf.action).toBe('block')
      expect(ssrf.reason).toBe('blocked_private_ip_ssrf')
    })

    it('honours full robots.txt (>4 KB) and supports owner-verified robots override (§6.7)', async () => {
      const longComments = '# ' + 'x'.repeat(5000) + '\n'
      const robotsTxt = `${longComments}
User-agent: *
Disallow: /private/
Allow: /private/public-faq

User-agent: UGOKILinkLab
Disallow: /column/lotion-guide
`
      // RFC 9309: wildcard group applies to agents without a specific group (even > 4 KB into robots.txt)
      expect(evaluateRobotsTxt(robotsTxt, '/private/secret', ['GenericBot']).allowed).toBe(false)
      expect(evaluateRobotsTxt(robotsTxt, '/private/public-faq', ['GenericBot']).allowed).toBe(true)
      // Specific group applies to UGOKILinkLab (does not merge wildcard group per RFC 9309 §2.2.1)
      expect(evaluateRobotsTxt(robotsTxt, '/column/lotion-guide', ['UGOKILinkLab']).allowed).toBe(false)
      expect(evaluateRobotsTxt(robotsTxt, '/private/secret', ['UGOKILinkLab']).allowed).toBe(true)

      const driver = new DeterministicHtmlRenderDriver()
      const url = 'https://bihadashop.jp/column/lotion-guide'
      driver.registerPage(url, { html: SAMPLE_ARTICLE_HTML })
      const renderer = new SecondaryLabRenderer({ driver, now: () => FIXED_NOW })

      const blocked = await renderer.renderPage({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        url,
        job_class: 'id_only',
        profile: DEVICE_PROFILES.desktop_chromium,
        robots_txt: robotsTxt,
      })
      expect(blocked.status).toBe('robots_blocked')
      expect(blocked.unlock).toContain('robots_override')
      expect(blocked.segmenter_output).toBeNull()

      const overridden = await renderer.renderPage({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        url,
        job_class: 'id_only',
        profile: DEVICE_PROFILES.desktop_chromium,
        robots_txt: robotsTxt,
        robots_override: {
          approved_by_user_id: 'owner_01',
          approved_at: '2026-11-20T10:00:00.000Z',
          host: 'bihadashop.jp',
          reason: 'Owner-approved lab indexing on own site',
        },
      })
      expect(overridden.status).toBe('ok')
      expect(overridden.segmenter_output?.skel_fp).not.toBeNull()
    })

    it('detects volatile sections, volatile blocks, and volatile inline CSS via paired renders (§6.3)', async () => {
      const driver = new DeterministicHtmlRenderDriver()
      const url = 'https://bihadashop.jp/live-ranking'

      const render1Html = `<html><head><style>.nonce-a { color: #111; }</style></head><body><article>
        <h2>固定の解説セクション</h2>
        <p>この本文はリクエスト間で一切変化しません。</p>
        <h2>リアルタイム人気順位</h2>
        <p>現在の閲覧者数: 42人 (12:00時点)</p>
      </article></body></html>`

      const render2Html = `<html><head><style>.nonce-b { color: #111; }</style></head><body><article>
        <h2>固定の解説セクション</h2>
        <p>この本文はリクエスト間で一切変化しません。</p>
        <h2>リアルタイム人気順位</h2>
        <p>現在の閲覧者数: 57人 (12:05時点)</p>
      </article></body></html>`

      driver.registerPage(url, {
        html: render1Html,
        sequential_htmls: [render1Html, render2Html],
      })

      const renderer = new SecondaryLabRenderer({ driver, now: () => FIXED_NOW })
      const paired = await renderer.renderPairedVolatility({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        url,
        job_class: 'id_only',
        profile: DEVICE_PROFILES.desktop_chromium,
      })

      expect(paired.skel_stable).toBe(true)
      expect(paired.css_volatile).toBe(true)
      expect(paired.volatile_sections).toHaveLength(1)
      expect(paired.volatile_blocks.length).toBeGreaterThanOrEqual(1)

      const staticSecFp = paired.pass_a.segmenter_output!.sections[0].sec_fp
      const dynamicSecFp = paired.pass_a.segmenter_output!.sections[1].sec_fp
      expect(paired.volatile_sections).toContain(dynamicSecFp)
      expect(paired.volatile_sections).not.toContain(staticSecFp)
    })

    it('renders forced experiment variants while preserving control-invariant sec_fp set (join.G17)', async () => {
      const driver = new DeterministicHtmlRenderDriver()
      const url = 'https://bihadashop.jp/column/lotion-guide'
      const variantHtml = SAMPLE_ARTICLE_HTML.replace(
        '<h2>成分のチェックポイント</h2>',
        '<h2 data-ugk-orig-text="成分のチェックポイント">プロが選ぶ3つの成分基準【2026】</h2>',
      )
      driver.registerPage(url, {
        html: SAMPLE_ARTICLE_HTML,
        variant_html_by_key: { exp_heading_b: variantHtml },
      })

      const renderer = new SecondaryLabRenderer({ driver, now: () => FIXED_NOW })
      const ctrl = await renderer.renderPage({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        url,
        job_class: 'full',
        profile: DEVICE_PROFILES.desktop_chromium,
      })
      const varB = await renderer.renderPage({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        url,
        job_class: 'full',
        profile: DEVICE_PROFILES.desktop_chromium,
        variant: {
          variant_set_key: 'exp_heading_b',
          forced_arms: { exp_1: 'B' },
          action_hash: 'act_hash_1234',
        },
      })

      expect(varB.variant_set_key).toBe('exp_heading_b')
      expect(varB.segmenter_output!.skel_fp).toBe(ctrl.segmenter_output!.skel_fp)
      expect(varB.screenshot!.storage_key).not.toBe(ctrl.screenshot!.storage_key)
    })

    it('evaluates 5-class cumulative render capacity >= 2x gate without starving upper priority classes (surf.capacity)', () => {
      const cap = computeDailyRenderCapacity(4, 25) // 4 workers * 86400 / 25 = 13,824 renders/day
      expect(cap).toBe(13_824)

      const passing = evaluateRenderCapacityGate(cap, {
        safety: 400,
        integrity: 600,
        identity: 2000,
        evidence: 1000,
        enrichment: 2000, // total 6,000 -> ratio 2.304 >= 2.0
      })
      expect(passing.gate_passed).toBe(true)
      expect(passing.overall_ratio).toBeGreaterThanOrEqual(2)
      expect(passing.classes.every((c) => c.admitted)).toBe(true)

      // Overflow in lower classes MUST NOT block safety/integrity/identity (§11.4)
      const partialOverflow = evaluateRenderCapacityGate(1000, {
        safety: 100, // cum 100 -> 10x (admitted)
        integrity: 150, // cum 250 -> 4x (admitted)
        identity: 200, // cum 450 -> 2.22x (admitted)
        evidence: 200, // cum 650 -> 1.54x (not admitted)
        enrichment: 500, // cum 1150 -> 0.87x (not admitted)
      })
      expect(partialOverflow.gate_passed).toBe(false)
      expect(partialOverflow.classes.find((c) => c.priority_class === 'safety')?.admitted).toBe(true)
      expect(partialOverflow.classes.find((c) => c.priority_class === 'integrity')?.admitted).toBe(true)
      expect(partialOverflow.classes.find((c) => c.priority_class === 'identity')?.admitted).toBe(true)
      expect(partialOverflow.classes.find((c) => c.priority_class === 'evidence')?.admitted).toBe(false)
      expect(partialOverflow.classes.find((c) => c.priority_class === 'enrichment')?.admitted).toBe(false)
    })
  })

  describe('2. Immutable Snapshot Store, Version Control Rule, Change Intervals & Section Lineage', () => {
    it('enforces candidate -> lab_confirmed control rule, immutability, tenant isolation, and 2-failure stop rule', async () => {
      const driver = new DeterministicHtmlRenderDriver()
      const url = 'https://bihadashop.jp/column/lotion-guide'
      driver.registerPage(url, { html: SAMPLE_ARTICLE_HTML })
      const renderer = new SecondaryLabRenderer({ driver, now: () => FIXED_NOW })
      const render = await renderer.renderPage({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        url,
        job_class: 'full',
        profile: DEVICE_PROFILES.desktop_chromium,
      })

      const store = new LabSnapshotStore()
      const skelFp = render.segmenter_output!.skel_fp!

      // Field proposes candidate ONLY
      const cand = store.recordFieldCandidate({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        page_id: 'page_101',
        variant_set_key: '0',
        skel_fp: skelFp,
        observed_at: '2026-11-20T11:00:00.000Z',
      })
      expect(cand.state).toBe('candidate')
      expect(cand.confirmed_at).toBeNull()

      // Lab confirms with immutable pre-change baseline snapshot
      const snap = createSnapshotFromRender({
        render,
        page_id: 'page_101',
        identity_key: {
          link_grant_id: 'grant_1',
          producer: 'ugoki_second_executor',
          source_job_id: 'job_001',
          analysis_gen: 1,
          export_gen: 1,
          dataset_kind: 'structure_snapshot_v2',
          contract_ver: CRAWL_CONTRACT_VERSION,
        },
        recorded_at: '2026-11-20T12:00:01.000Z',
        is_pre_change_baseline: true,
        baseline_reason: 'pre_experiment_capture',
      })

      const confirmed = store.confirmVersionByLab(snap)
      expect(confirmed.state).toBe('lab_confirmed')
      expect(confirmed.confirmed_snapshot_id).toBe(snap.snapshot_id)
      expect(store.getLatestPreChangeBaseline('tenant_1', 'site_bihada', 'page_101')?.snapshot_id).toBe(
        snap.snapshot_id,
      )

      // Cross-tenant isolation -> returns null
      expect(store.getSnapshot('tenant_OTHER', 'site_bihada', snap.snapshot_id)).toBeNull()

      // Immutability check: mutating content_hash under same snapshot_id throws
      expect(() =>
        store.saveSnapshot({
          ...snap,
          content_hash: '0'.repeat(64),
        }),
      ).toThrow(ImmutableSnapshotError)

      // 2 non-reproducing renders stop rule (§6.2 / join.G15)
      const miss1 = store.recordNonReproducingRender({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        page_id: 'page_101',
        variant_set_key: '0',
        skel_fp: 'deadbeef00001111',
        attempted_at: '2026-11-20T12:10:00.000Z',
      })
      expect(miss1.state).toBe('candidate')
      expect(store.shouldAllowRender('tenant_1', 'site_bihada', 'page_101', '0', 'deadbeef00001111')).toBe(
        true,
      )

      const miss2 = store.recordNonReproducingRender({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        page_id: 'page_101',
        variant_set_key: '0',
        skel_fp: 'deadbeef00001111',
        attempted_at: '2026-11-20T12:20:00.000Z',
      })
      expect(miss2.state).toBe('lab_unreproducible')
      expect(miss2.rendering_halted).toBe(true)
      expect(store.shouldAllowRender('tenant_1', 'site_bihada', 'page_101', '0', 'deadbeef00001111')).toBe(
        false,
      )
    })

    it('manages [t_lo, t_hi] change intervals, mixed windows, tightening hierarchy, and section lineage', () => {
      const store = new LabSnapshotStore()
      const interval = store.recordChangeInterval({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        page_id: 'page_101',
        variant_set_key: '0',
        old_skel_fp: 'aaaa000000000001',
        new_skel_fp: 'bbbb000000000002',
        last_seen_old: '2026-11-20T10:00:00.000Z',
        first_seen_new: '2026-11-20T12:00:00.000Z',
        source: 'field_sighting',
      })
      expect(interval.mixed_window).toBe(false)
      expect(interval.width_ms).toBe(2 * 3600 * 1000)

      // Tighten via CMS publish hook
      const tightened = store.tightenChangeInterval({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        interval_id: interval.interval_id,
        t_lo: '2026-11-20T11:15:00.000Z',
        t_hi: '2026-11-20T11:15:00.000Z',
        source: 'cms_publish_hook',
      })!
      expect(tightened.width_ms).toBe(0)
      expect(tightened.source).toBe('cms_publish_hook')

      // Crossed sightings produce mixed_window = true
      const crossed = store.recordChangeInterval({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        page_id: 'page_101',
        variant_set_key: '0',
        old_skel_fp: 'cccc000000000003',
        new_skel_fp: 'dddd000000000004',
        last_seen_old: '2026-11-20T12:30:00.000Z',
        first_seen_new: '2026-11-20T12:00:00.000Z',
        source: 'field_sighting',
      })
      expect(crossed.mixed_window).toBe(true)

      // Section lineage: unchanged sec_fp -> observed, renamed heading with same body -> inferred same section_uid!
      const uid1 = allocateSectionUid('page_101', 'sec_00000001', 0)
      const uid2 = allocateSectionUid('page_101', 'sec_00000002', 1)
      const lineage = resolveSectionLineage({
        page_id: 'page_101',
        old_sections: [
          {
            sec_fp: 'sec_00000001',
            body_fp: 'body0001',
            ordinal: 0,
            heading_text: '成分のチェックポイント',
            body_text: 'ヒト型セラミドやナイアシンアミド配合の低刺激化粧水を選ぶことが大切です。',
            section_uid: uid1,
          },
          {
            sec_fp: 'sec_00000002',
            body_fp: 'body0002',
            ordinal: 1,
            heading_text: 'おすすめ化粧水ランキング',
            body_text: '敏感肌でも毎日使いやすく保湿力が長時間持続する人気アイテムを比較しました。',
            section_uid: uid2,
          },
        ],
        new_sections: [
          {
            sec_fp: 'sec_00000001',
            body_fp: 'body0001',
            ordinal: 0,
            heading_text: '成分のチェックポイント',
            body_text: 'ヒト型セラミドやナイアシンアミド配合の低刺激化粧水を選ぶことが大切です。',
          },
          {
            sec_fp: 'sec_renamed_02',
            body_fp: 'body0002',
            ordinal: 1,
            heading_text: 'おすすめ化粧水ランキング2026',
            body_text: '敏感肌でも毎日使いやすく保湿力が長時間持続する人気アイテムを比較しました。',
          },
          {
            sec_fp: 'sec_brand_new',
            body_fp: 'body0003',
            ordinal: 2,
            heading_text: 'よくある質問',
            body_text: '送料や返品保証期間に関するよくある質問をまとめました。',
          },
        ],
      })

      const m1 = lineage.matches.find((m) => m.new_sec_fp === 'sec_00000001')!
      expect(m1.section_uid).toBe(uid1)
      expect(m1.evidence_level).toBe('observed')
      expect(m1.change_event).toBe('unchanged')

      const m2 = lineage.matches.find((m) => m.new_sec_fp === 'sec_renamed_02')!
      expect(m2.section_uid).toBe(uid2)
      expect(m2.evidence_level).toBe('inferred')
      expect(m2.change_event).toBe('heading_renamed')

      const m3 = lineage.matches.find((m) => m.new_sec_fp === 'sec_brand_new')!
      expect(m3.change_event).toBe('added')
    })
  })

  describe('3. CRAWL Contract Stub (Zero Dummy Fallbacks, Probes, Issues with Loci & Export)', () => {
    it('enforces link-grant TTL, zero dummy fallbacks, affiliate redirect blocking, probes, and signed snapshot exports', async () => {
      const stub = new DeterministicCrawlContractStub({ now: () => FIXED_NOW })
      const grant = makeValidGrant()
      const url = 'https://bihadashop.jp/column/lotion-guide'
      const affRedirectUrl = 'https://bihadashop.jp/go/a8-offer'

      stub.seedPage({
        url,
        html: SAMPLE_ARTICLE_HTML,
        etag: '"etag-v1"',
        cms_modified_at: '2026-11-19T08:00:00.000Z',
      })
      stub.seedPage({
        url: affRedirectUrl,
        html: '<html><body>redirect</body></html>',
        redirect_chain: [
          { from: affRedirectUrl, to: 'https://px.a8.net/svt/ejp?a8mat=BLOCK', status: 302 },
        ],
      })

      // Production safety guard rejects stub in production env
      expect(() => assertNotStubInProduction(stub, { nodeEnv: 'production' })).toThrow()

      // URL probe: seeded -> ok + segmenter hash parity; unseeded -> not_crawled (never dummy!); affiliate redirect -> blocked!
      const probeRes = await stub.probeUrls({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        link_grant: grant,
        urls: [url, 'https://bihadashop.jp/not-seeded', affRedirectUrl],
      })
      expect(probeRes.results[0].status).toBe('ok')
      expect(probeRes.results[0].raw_html_fingerprints?.skel_fp).toBe(
        segmentHtml(SAMPLE_ARTICLE_HTML, { url }).skel_fp,
      )
      expect(probeRes.results[1].status).toBe('not_crawled')
      expect(probeRes.results[1].raw_html_fingerprints).toBeNull()
      expect(probeRes.results[2].status).toBe('blocked_affiliate_redirect')
      expect(probeRes.results[2].affiliate_requests_sent).toBe(0)

      // Structure render batch & conversion_rule probe keyed by exact el_fp
      const batchRes = await stub.renderStructure({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        link_grant: grant,
        urls: [url],
        job_class: 'full',
        idempotency_key: 'idem_001',
      })
      expect(batchRes.results[0].segmenter_output).toEqual(segmentHtml(SAMPLE_ARTICLE_HTML, { url }))

      const convProbe = await stub.runProbe({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        link_grant: grant,
        url,
        probe_kind: 'conversion_rule',
      })
      expect(convProbe.status).toBe('ok')
      expect(convProbe.findings).toHaveLength(1)
      expect(convProbe.findings[0].code).toBe('conversion_target_matched')
      expect(convProbe.findings[0].el_fp).toMatch(/^[0-9a-f]{12}$/)

      // Immutable snapshot export + signed replayable webhook notification
      const exported = await stub.exportImmutableSnapshot({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        page_id: 'page_101',
        link_grant: grant,
        url,
        source_job_id: 'crawl_job_99',
        is_pre_change_baseline: true,
      })
      expect(exported.status).toBe('ok')
      expect(exported.snapshot?.is_pre_change_baseline).toBe(true)
      expect(exported.notification?.seq).toBe(1)
      expect(exported.notification?.signature_hmac).toMatch(/^[0-9a-f]{64}$/)

      // Issues with typed loci (no empty-string el_fp/sec_fp)
      const missingDescUrl = 'https://bihadashop.jp/bad-page'
      stub.seedPage({
        url: missingDescUrl,
        html: '<html><body><article><h2>重複</h2><a href="https://example.com/x"></a><h2>重複</h2></article></body></html>',
      })
      const issuesRes = await stub.listIssuesWithLoci({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        link_grant: grant,
        url: missingDescUrl,
      })
      expect(issuesRes.status).toBe('ok')
      expect(issuesRes.issues.some((i) => i.locus.class === 'page' && i.locus.el_fp === null)).toBe(true)
      expect(issuesRes.issues.some((i) => i.locus.class === 'element' && i.locus.el_fp !== null)).toBe(true)
      expect(issuesRes.issues.some((i) => i.locus.class === 'section' && i.locus.sec_fp !== null)).toBe(true)

      // Expired link grant (>300s or past expires_at) MUST be rejected
      await expect(
        stub.probeUrls({
          tenant_id: 'tenant_1',
          site_id: 'site_bihada',
          link_grant: {
            ...grant,
            expires_at: '2026-11-20T12:15:00.000Z', // > 300s lifetime!
          },
          urls: [url],
        }),
      ).rejects.toThrow(/300 seconds/)
    })
  })

  describe('4. Operability Audit (§7.6 Instrument A / Gate act.G19 / Unified Response Envelope)', () => {
    it('evaluates 3 channels (a11y, DOM structure, pixel/layout) at zero traffic and passes all Response Envelope Invariants I1–I7', async () => {
      const driver = new DeterministicHtmlRenderDriver()
      const url = 'https://bihadashop.jp/audit-target'
      const auditHtml = `<!DOCTYPE html>
      <html lang="ja"><head><title>Audit Target</title></head><body><main>
        <h2>CTA・フォーム検証</h2>
        <!-- 1. Fully reachable native affiliate CTA -->
        <p><a href="https://px.a8.net/svt/ejp?a8mat=GOOD" data-lab-rect="24,100,240,48">公式サイトを見る</a></p>
        <!-- 2. Unreachable on A11y (no name) & DOM (javascript: href) & Pixel (too small + occluded) -->
        <p><a href="javascript:void(0)" aria-hidden="true" data-lab-rect="24,200,12,12" data-lab-occluded="true"></a></p>
        <!-- 3. Non-native scripted div button + hover-only reveal -->
        <div role="button" data-lab-rect="24,260,120,40" data-lab-hover-only="true">購入する</div>
        <!-- 4. Unbound form input positioned offscreen -->
        <form action="/submit">
          <input name="phone" type="tel" data-lab-rect="-500,320,200,40">
        </form>
      </main></body></html>`

      driver.registerPage(url, { html: auditHtml })
      const renderer = new SecondaryLabRenderer({ driver, now: () => FIXED_NOW })

      // Full render -> 100% 3-channel coverage -> act.G19 passes, status === 'ok'
      const fullRender = await renderer.renderPage({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        url,
        job_class: 'full',
        profile: DEVICE_PROFILES.desktop_chromium,
      })

      const fullAudit = runOperabilityAudit(fullRender, { snapshot_ref_id: 'snap_audit_01' })
      expect(fullAudit.gate_act_g19_passed).toBe(true)
      expect(fullAudit.three_channel_coverage_ratio).toBe(1)
      expect(fullAudit.envelope.status).toBe('ok')
      expect(fullAudit.envelope.measures.conversion_elements_audited.value).toBe(4)
      expect(fullAudit.envelope.measures.conversion_elements_audited.evidence.level).toBe('observed')
      expect(fullAudit.envelope.measures.all_three_reachable_ratio.value).toBe(0.25) // 1 of 4 fully reachable
      expect(fullAudit.envelope.measures.unreachable_element_count.value).toBe(3)

      // Verify specific defects across all 3 channels
      const goodEl = fullAudit.elements[0]
      expect(goodEl.reachable_all_three).toBe(true)
      expect(goodEl.is_affiliate_link).toBe(true)
      expect(isUntrustedValue(goodEl.accessible_name)).toBe(true)
      expect(isUntrustedValue(goodEl.href)).toBe(true)

      const brokenLink = fullAudit.elements[1]
      expect(brokenLink.channels.a11y.defects).toContain('missing_accessible_name')
      expect(brokenLink.channels.a11y.defects).toContain('aria_hidden')
      expect(brokenLink.channels.dom.defects).toContain('missing_or_script_href')
      expect(brokenLink.channels.pixel.defects).toContain('tap_target_too_small')
      expect(brokenLink.channels.pixel.defects).toContain('occluded_by_overlay')

      const divButton = fullAudit.elements[2]
      expect(divButton.channels.dom.defects).toContain('non_native_scripted_control')
      expect(divButton.channels.pixel.defects).toContain('hover_only_reveal')

      const unboundField = fullAudit.elements[3]
      expect(unboundField.channels.dom.defects).toContain('unbound_form_label')
      expect(unboundField.channels.pixel.defects).toContain('offscreen_element')

      // Wire-level response envelope validator confirms ZERO violations (I1–I7 including UntrustedValue!)
      const validation = validateSerializedEnvelope(JSON.parse(JSON.stringify(fullAudit.envelope)))
      expect(validation.valid).toBe(true)
      expect(validation.violations).toHaveLength(0)

      // id_only render (pixel channel unmeasured) -> pixel measures MUST return not_collected + null + act.G19 unmet gate!
      const idOnlyRender = await renderer.renderPage({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        url,
        job_class: 'id_only',
        profile: DEVICE_PROFILES.desktop_chromium,
      })

      const partialAudit = runOperabilityAudit(idOnlyRender)
      expect(partialAudit.gate_act_g19_passed).toBe(false)
      expect(partialAudit.three_channel_coverage_ratio).toBe(0)
      expect(partialAudit.envelope.status).toBe('partial')
      expect(partialAudit.envelope.measures.a11y_reachable_ratio.status).toBe('ok')
      expect(partialAudit.envelope.measures.dom_reachable_ratio.status).toBe('ok')
      expect(partialAudit.envelope.measures.pixel_reachable_ratio.status).toBe('not_collected')
      expect(partialAudit.envelope.measures.pixel_reachable_ratio.value).toBeNull()
      expect(partialAudit.envelope.measures.pixel_reachable_ratio.unmet_gates[0].id).toBe('act.G19')
      expect(partialAudit.envelope.measures.all_three_reachable_ratio.status).toBe('not_collected')
      expect(partialAudit.envelope.measures.all_three_reachable_ratio.value).toBeNull()

      const partialValidation = validateSerializedEnvelope(
        JSON.parse(JSON.stringify(partialAudit.envelope)),
      )
      expect(partialValidation.valid).toBe(true)
      expect(DEFAULT_LAB_BLOCKLIST.affiliateHosts.length).toBeGreaterThanOrEqual(20)
    })
  })

  describe('5. [M-11] Cryptographic LinkGrantAssertion Verification & Canonical RenderJobClass Alignment', () => {
    it('cryptographically verifies HMAC & Ed25519 LinkGrantAssertions and enforces host_patterns, tenant/site binding, and clock skew', async () => {
      const stub = new DeterministicCrawlContractStub({
        now: () => FIXED_NOW,
        webhookSecret: 'custom-hmac-grant-secret',
      })
      const url = 'https://bihadashop.jp/column/lotion-guide'
      stub.seedPage({ url, html: SAMPLE_ARTICLE_HTML })

      const validSignedGrant = signLinkGrantAssertion(
        {
          link_grant_id: 'grant_hmac_01',
          tenant_id: 'tenant_1',
          site_id: 'site_bihada',
          issued_at: '2026-11-20T11:58:00.000Z',
          expires_at: '2026-11-20T12:02:00.000Z',
          scopes: ['url:probe', 'structure:render', 'structure:identity', 'probe:run'],
          host_patterns: ['*.bihadashop.jp', 'bihadashop.jp'],
        },
        { kind: 'hmac', secret: 'custom-hmac-grant-secret' },
      )

      const okRes = await stub.probeUrls({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        link_grant: validSignedGrant,
        urls: [url],
      })
      expect(okRes.results[0].status).toBe('ok')

      // 1) Forged unverified string signature MUST be rejected
      await expect(
        stub.probeUrls({
          tenant_id: 'tenant_1',
          site_id: 'site_bihada',
          link_grant: { ...validSignedGrant, signature: 'ed25519_sig_forged_dummy' },
          urls: [url],
        }),
      ).rejects.toThrow(/signature/)

      // 2) Post-signing payload tampering (widening host_patterns while keeping <=300s) MUST fail HMAC verification
      await expect(
        stub.probeUrls({
          tenant_id: 'tenant_1',
          site_id: 'site_bihada',
          link_grant: {
            ...validSignedGrant,
            host_patterns: ['bihadashop.jp', 'attacker.example'],
          },
          urls: ['https://attacker.example/steal'],
        }),
      ).rejects.toThrow(/signature verification failed/)

      // 3) Authorized signature used against an unauthorized target URL host MUST fail host_patterns check
      await expect(
        stub.probeUrls({
          tenant_id: 'tenant_1',
          site_id: 'site_bihada',
          link_grant: validSignedGrant,
          urls: ['https://other-unlisted-host.jp/secret'],
        }),
      ).rejects.toThrow(/host_patterns/)

      // 4) Cross-tenant / cross-site replay of a valid signed grant MUST be rejected
      await expect(
        stub.probeUrls({
          tenant_id: 'tenant_attacker',
          site_id: 'site_bihada',
          link_grant: validSignedGrant,
          urls: [url],
        }),
      ).rejects.toThrow(/tenant_id mismatch/)

      // 5) Ed25519 asymmetric signing & verification (matching key passes, wrong key fails)
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const { publicKey: wrongPublicKey } = generateKeyPairSync('ed25519')
      const edGrant = signLinkGrantAssertion(
        {
          link_grant_id: 'grant_ed25519_01',
          tenant_id: 'tenant_1',
          site_id: 'site_bihada',
          issued_at: '2026-11-20T11:59:00.000Z',
          expires_at: '2026-11-20T12:03:00.000Z',
          scopes: ['url:probe', 'structure:render'],
          host_patterns: ['bihadashop.jp'],
        },
        { kind: 'ed25519', privateKey },
      )

      expect(() =>
        assertValidLinkGrant(edGrant, 'url:probe', FIXED_NOW, {
          tenant_id: 'tenant_1',
          site_id: 'site_bihada',
          target_urls: [url],
          ed25519_public_key: publicKey,
        }),
      ).not.toThrow()

      expect(() =>
        assertValidLinkGrant(edGrant, 'url:probe', FIXED_NOW, {
          tenant_id: 'tenant_1',
          site_id: 'site_bihada',
          target_urls: [url],
          ed25519_public_key: wrongPublicKey,
        }),
      ).toThrow(/signature verification failed/)
    })

    it('supports canonical full_render and identity_render job classes identically to full and id_only across renderer and snapshot export', async () => {
      const stub = new DeterministicCrawlContractStub({ now: () => FIXED_NOW })
      const grant = makeValidGrant()
      const url = 'https://bihadashop.jp/column/lotion-guide'
      stub.seedPage({ url, html: SAMPLE_ARTICLE_HTML })

      const fullRenderExport = await stub.exportImmutableSnapshot({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        page_id: 'page_101',
        link_grant: grant,
        url,
        source_job_id: 'job_full_render_canonical',
        job_class: 'full_render',
      })
      expect(fullRenderExport.status).toBe('ok')
      expect(fullRenderExport.snapshot?.job_class).toBe('full_render')
      expect(fullRenderExport.snapshot?.identity_key.dataset_kind).toBe('structure_snapshot_v2')
      expect(fullRenderExport.snapshot?.doc_h_px).not.toBeNull()
      expect(fullRenderExport.snapshot?.section_geometries).not.toBeNull()
      expect(fullRenderExport.snapshot?.screenshot).not.toBeNull()

      const idRenderExport = await stub.exportImmutableSnapshot({
        tenant_id: 'tenant_1',
        site_id: 'site_bihada',
        page_id: 'page_101',
        link_grant: grant,
        url,
        source_job_id: 'job_identity_render_canonical',
        job_class: 'identity_render',
      })
      expect(idRenderExport.status).toBe('ok')
      expect(idRenderExport.snapshot?.job_class).toBe('identity_render')
      expect(idRenderExport.snapshot?.identity_key.dataset_kind).toBe('structure_identity_v1')
      expect(idRenderExport.snapshot?.doc_h_px).toBeNull()
      expect(idRenderExport.snapshot?.section_geometries).toBeNull()
      expect(idRenderExport.snapshot?.screenshot).toBeNull()
    })
  })
})
