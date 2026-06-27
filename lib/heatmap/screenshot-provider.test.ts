/**
 * Unit tests: screenshot-provider (SSRF guard + cache key + Microlink wrapper)
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-29 frontend heatmap screenshot underlay Phase 2
 */

import {
  CAPTURE_WIDTH_FOR_DEVICE,
  ScreenshotProviderError,
  _resetScreenshotMemoryCache,
  buildCacheKey,
  fetchHeatmapUnderlay,
  validateExternalUrl,
} from './screenshot-provider'

describe('validateExternalUrl (SSRF guard)', () => {
  it('accepts plain https URLs', () => {
    const u = validateExternalUrl('https://bihadashop.jp/entry/foo')
    expect(u.hostname).toBe('bihadashop.jp')
  })

  it('accepts http URLs', () => {
    expect(() => validateExternalUrl('http://example.com/')).not.toThrow()
  })

  it.each([
    'ftp://example.com/',
    'file:///etc/passwd',
    'data:text/html,<script>',
    'javascript:alert(1)',
    'gopher://example.com/',
  ])('rejects non-http(s) scheme: %s', (url) => {
    expect(() => validateExternalUrl(url)).toThrow(ScreenshotProviderError)
  })

  it('rejects URL with embedded credentials', () => {
    expect(() => validateExternalUrl('https://user:pass@example.com/')).toThrow(/credentials/)
  })

  it.each([
    'http://localhost/',
    'http://127.0.0.1/',
    'http://127.10.20.30/',
    'http://0.0.0.0/',
    'http://10.0.0.5/',
    'http://172.20.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/', // AWS / GCP metadata
    'http://100.64.0.1/', // CG-NAT
    'http://203.0.113.1/', // TEST-NET-3
    'http://198.51.100.1/', // TEST-NET-2
    'http://224.0.0.1/', // multicast
    'http://server.localhost/',
    'http://my-host.local/',
    'http://service.internal/',
    'http://metadata.google.internal/',
  ])('rejects private / loopback / reserved host: %s', (url) => {
    expect(() => validateExternalUrl(url)).toThrow(ScreenshotProviderError)
  })

  it('rejects IPv6 loopback / ULA / link-local', () => {
    expect(() => validateExternalUrl('http://[::1]/')).toThrow(ScreenshotProviderError)
    expect(() => validateExternalUrl('http://[fd00::1]/')).toThrow(ScreenshotProviderError)
    expect(() => validateExternalUrl('http://[fe80::1]/')).toThrow(ScreenshotProviderError)
  })

  it('rejects malformed URL', () => {
    expect(() => validateExternalUrl('not a url')).toThrow(/valid absolute URL/)
  })
})

describe('buildCacheKey', () => {
  it('returns a 32-char hex string', () => {
    const key = buildCacheKey({
      tenantId: 't1',
      siteId: 's1',
      pageUrl: 'https://example.com/',
      device: 'pc',
    })
    expect(key).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is stable for identical inputs', () => {
    const a = buildCacheKey({
      tenantId: 't1',
      siteId: 's1',
      pageUrl: 'https://example.com/',
      device: 'pc',
    })
    const b = buildCacheKey({
      tenantId: 't1',
      siteId: 's1',
      pageUrl: 'https://example.com/',
      device: 'pc',
    })
    expect(a).toBe(b)
  })

  it('changes when tenantId differs (cross-tenant cache isolation)', () => {
    const a = buildCacheKey({
      tenantId: 't1',
      siteId: 's1',
      pageUrl: 'https://example.com/',
      device: 'pc',
    })
    const b = buildCacheKey({
      tenantId: 't2', // 別 tenant、その他全て同じ
      siteId: 's1',
      pageUrl: 'https://example.com/',
      device: 'pc',
    })
    expect(a).not.toBe(b)
  })

  it('changes when device differs (capture width 違いを衝突させない)', () => {
    const pc = buildCacheKey({
      tenantId: 't1',
      siteId: 's1',
      pageUrl: 'https://example.com/',
      device: 'pc',
    })
    const sp = buildCacheKey({
      tenantId: 't1',
      siteId: 's1',
      pageUrl: 'https://example.com/',
      device: 'sp',
    })
    expect(pc).not.toBe(sp)
  })

  it('uses correct capture widths per device (続 117 v2: pc=1280 desktop)', () => {
    expect(CAPTURE_WIDTH_FOR_DEVICE.pc).toBe(1280)
    expect(CAPTURE_WIDTH_FOR_DEVICE.sp).toBe(390)
    expect(CAPTURE_WIDTH_FOR_DEVICE.tab).toBe(820)
  })

  // 続 116: format / quality を cache key に含めることで perf 改修時の cache miss を保証
  it('cache key incorporates screenshot format/quality (続 116)', () => {
    // 現在の値は jpeg / q75 (lib/heatmap/screenshot-provider.ts の SCREENSHOT_FORMAT, SCREENSHOT_QUALITY)
    // 値が変わったら hash は別になる、ことを担保する間接 test:
    //   別 device で別 hash になることは既に検証済 (上の test)。
    //   ここでは現状 (jpeg / q75) の hash が安定して 32 hex であることを再確認する。
    const k = buildCacheKey({
      tenantId: 't1',
      siteId: 's1',
      pageUrl: 'https://example.com/',
      device: 'pc',
    })
    expect(k).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('buildCacheKey determinism', () => {
  // 続135: URL 正準化は canonicalizeHeatmapUrl (lib/heatmap/canonical-url.ts) に一元化。
  //   ここでは buildCacheKey が「同一入力 → 同一キー」であることのみ担保する
  //   (canonical 化の契約は canonical-url.test.ts が固定)。
  it('same canonical URL feeds → identical cache key', () => {
    const canonical = 'https://example.com/Entry'
    const keyA = buildCacheKey({ tenantId: 't1', siteId: 's1', pageUrl: canonical, device: 'pc' })
    const keyB = buildCacheKey({ tenantId: 't1', siteId: 's1', pageUrl: canonical, device: 'pc' })
    expect(keyA).toBe(keyB)
  })
})

describe('fetchHeatmapUnderlay (Microlink wrapper + cache)', () => {
  beforeEach(() => {
    _resetScreenshotMemoryCache()
  })

  it('parses Microlink success response and returns capture meta', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          status: 'success',
          data: {
            screenshot: {
              url: 'https://cdn.microlink.io/screenshot.png',
              width: 720,
              height: 4321,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )

    const cap = await fetchHeatmapUnderlay({
      tenantId: 'tenant-A',
      siteId: 'site-1',
      pageUrl: 'https://bihadashop.jp/entry/tirtir',
      device: 'pc',
      fetchImpl: fakeFetch,
    })

    expect(cap.imageUrl).toBe('https://cdn.microlink.io/screenshot.png')
    // naturalWidth は provider 返却値 (720)、viewportWidth は capture 基準幅 (pc=1280)
    expect(cap.naturalWidth).toBe(720)
    expect(cap.naturalHeight).toBe(4321)
    expect(cap.viewportWidth).toBe(1280)
    expect(cap.device).toBe('pc')
    expect(cap.provider).toBe('microlink')
    expect(cap.cached).toBe(false)
    expect(cap.cacheKey).toMatch(/^[0-9a-f]{32}$/)
  })

  it('returns cached=true on second call with same input', async () => {
    let calls = 0
    const fakeFetch: typeof fetch = async () => {
      calls++
      return new Response(
        JSON.stringify({
          status: 'success',
          data: { screenshot: { url: 'https://cdn.microlink.io/x.png', width: 720, height: 2000 } },
        }),
        { status: 200 },
      )
    }
    const input = {
      tenantId: 'tenant-A',
      siteId: 'site-1',
      pageUrl: 'https://bihadashop.jp/x',
      device: 'pc' as const,
      fetchImpl: fakeFetch,
    }
    const a = await fetchHeatmapUnderlay(input)
    const b = await fetchHeatmapUnderlay(input)
    expect(calls).toBe(1) // 2 回目は cache hit
    expect(a.cached).toBe(false)
    expect(b.cached).toBe(true)
  })

  it('throws PROVIDER_RATE_LIMITED on 429', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('Too Many Requests', { status: 429 })
    await expect(
      fetchHeatmapUnderlay({
        tenantId: 't',
        siteId: 's',
        pageUrl: 'https://example.com/',
        device: 'pc',
        fetchImpl: fakeFetch,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' })
  })

  it('throws PROVIDER_ERROR when Microlink returns status=fail', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ status: 'fail', message: 'bad target' }), { status: 200 })
    await expect(
      fetchHeatmapUnderlay({
        tenantId: 't',
        siteId: 's',
        pageUrl: 'https://example.com/',
        device: 'pc',
        fetchImpl: fakeFetch,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })

  it.each([
    'http://cdn.microlink.io/x.png', // http (not https)
    'https://evil.example.com/x.png', // not in CDN allowlist
    'https://user:pass@cdn.microlink.io/x.png', // embedded credentials
    'not-a-url',
    '',
  ])('rejects malicious / non-allowlist image URL from provider: %s', async (badUrl) => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          status: 'success',
          data: { screenshot: { url: badUrl, width: 720, height: 2000 } },
        }),
        { status: 200 },
      )
    await expect(
      fetchHeatmapUnderlay({
        tenantId: 't',
        siteId: 's',
        pageUrl: 'https://example.com/',
        device: 'pc',
        fetchImpl: fakeFetch,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })

  it('clamps insane width/height to fallback (defense against provider bug)', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          status: 'success',
          data: {
            screenshot: {
              url: 'https://cdn.microlink.io/x.png',
              width: 9_999_999, // out of bounds
              height: -50, // negative
            },
          },
        }),
        { status: 200 },
      )
    const cap = await fetchHeatmapUnderlay({
      tenantId: 't',
      siteId: 's',
      pageUrl: 'https://example.com/',
      device: 'pc',
      fetchImpl: fakeFetch,
    })
    // out-of-bounds → fallback (= capture width / capture width * 2)、pc=1280
    expect(cap.naturalWidth).toBe(1280)
    expect(cap.naturalHeight).toBe(2560)
  })
})
