/**
 * Unit tests: Cloudflare Browser Rendering provider + provider selection.
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: Cloudflare Browser Rendering provider swap
 *
 * 検証:
 *   - buildCloudflareBRRequestBody の request body shape (viewport / screenshotOptions / gotoOptions)
 *   - fetchFromCloudflareBR が binary JPEG から dimension を抽出し bytes を返す
 *   - captureScreenshot の provider 選択 (CF config 有 → cloudflare、無 → microlink fallback)
 *   - 429 / non-200 / JSON-not-image を ScreenshotProviderError にマップ
 */

import {
  CAPTURE_WIDTH_FOR_DEVICE,
  ScreenshotProviderError,
  buildCloudflareBRRequestBody,
  captureScreenshot,
  fetchFromCloudflareBR,
  getCloudflareBRConfig,
  type CloudflareBRConfig,
} from './screenshot-provider'

const CF_CONFIG: CloudflareBRConfig = {
  accountId: 'acct-123',
  apiToken: 'cf-token-xyz',
}

/** SOI + SOF0 で width/height を持つ最小 JPEG を作る。 */
function makeJpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ])
}

function jpegResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes as BodyInit, {
    status,
    headers: { 'content-type': 'image/jpeg' },
  })
}

describe('buildCloudflareBRRequestBody', () => {
  it('uses the device CSS width as viewport.width and deviceScaleFactor=1 (overlay 整合)', () => {
    const body = buildCloudflareBRRequestBody({
      pageUrl: 'https://bihadashop.jp/entry/tirtir',
      device: 'pc',
    })
    expect(body.url).toBe('https://bihadashop.jp/entry/tirtir')
    expect(body.viewport.width).toBe(CAPTURE_WIDTH_FOR_DEVICE.pc) // 1280
    // DPR=1 → naturalWidth == referenceWidth、Microlink 経路と座標一致する
    expect(body.viewport.deviceScaleFactor).toBe(1)
  })

  it('requests a full-page jpeg with quality + networkidle0 goto', () => {
    const body = buildCloudflareBRRequestBody({ pageUrl: 'https://example.com/', device: 'sp' })
    expect(body.viewport.width).toBe(CAPTURE_WIDTH_FOR_DEVICE.sp) // 390
    expect(body.screenshotOptions.fullPage).toBe(true)
    expect(body.screenshotOptions.type).toBe('jpeg')
    expect(typeof body.screenshotOptions.quality).toBe('number')
    expect(body.gotoOptions.waitUntil).toBe('networkidle0')
    expect(body.gotoOptions.timeout).toBeGreaterThanOrEqual(30_000)
  })

  it('builds different viewport widths per device', () => {
    expect(buildCloudflareBRRequestBody({ pageUrl: 'https://e.com/', device: 'tab' }).viewport.width)
      .toBe(820)
  })
})

describe('fetchFromCloudflareBR', () => {
  it('POSTs to the BR endpoint with bearer auth + json body, returns bytes + dimensions', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const jpeg = makeJpeg(1280, 9000)
    const fakeFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input)
      capturedInit = init
      return jpegResponse(jpeg)
    }

    const out = await fetchFromCloudflareBR({
      pageUrl: 'https://bihadashop.jp/p',
      device: 'pc',
      config: CF_CONFIG,
      fetchImpl: fakeFetch,
    })

    expect(capturedUrl).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-123/browser-rendering/screenshot',
    )
    expect(capturedInit?.method).toBe('POST')
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer cf-token-xyz')
    expect(headers['content-type']).toBe('application/json')
    const sentBody = JSON.parse(String(capturedInit?.body)) as { url: string }
    expect(sentBody.url).toBe('https://bihadashop.jp/p')

    // dimension は bytes から抽出される
    expect(out.naturalWidth).toBe(1280)
    expect(out.naturalHeight).toBe(9000)
    expect(out.contentType).toBe('image/jpeg')
    expect(out.bytes).toEqual(jpeg)
  })

  it('falls back to viewport width / *2 when bytes are not a parseable image', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(new Uint8Array([0x01, 0x02, 0x03]) as BodyInit, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    const out = await fetchFromCloudflareBR({
      pageUrl: 'https://example.com/',
      device: 'pc',
      config: CF_CONFIG,
      fetchImpl: fakeFetch,
    })
    expect(out.naturalWidth).toBe(1280) // fallback = viewport width
    expect(out.naturalHeight).toBe(2560) // fallback = width * 2
  })

  it('maps HTTP 429 to PROVIDER_RATE_LIMITED', async () => {
    const fakeFetch: typeof fetch = async () => new Response('rate', { status: 429 })
    await expect(
      fetchFromCloudflareBR({
        pageUrl: 'https://example.com/',
        device: 'pc',
        config: CF_CONFIG,
        fetchImpl: fakeFetch,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' })
  })

  it('maps non-200 (with CF JSON error) to PROVIDER_ERROR including message', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: 'invalid url' }] }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    await expect(
      fetchFromCloudflareBR({
        pageUrl: 'https://example.com/',
        device: 'pc',
        config: CF_CONFIG,
        fetchImpl: fakeFetch,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })

  it('rejects a 200 JSON body (CF returned error as image-less JSON)', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: 'boom' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    await expect(
      fetchFromCloudflareBR({
        pageUrl: 'https://example.com/',
        device: 'pc',
        config: CF_CONFIG,
        fetchImpl: fakeFetch,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })

  it('rejects an empty 200 image body', async () => {
    const fakeFetch: typeof fetch = async () => jpegResponse(new Uint8Array())
    await expect(
      fetchFromCloudflareBR({
        pageUrl: 'https://example.com/',
        device: 'pc',
        config: CF_CONFIG,
        fetchImpl: fakeFetch,
      }),
    ).rejects.toBeInstanceOf(ScreenshotProviderError)
  })
})

describe('captureScreenshot — provider selection', () => {
  it('uses Cloudflare when cloudflareConfig is provided (provider=cloudflare, data: imageUrl)', async () => {
    const jpeg = makeJpeg(1280, 7777)
    const fakeFetch: typeof fetch = async () => jpegResponse(jpeg)
    const { capture, image } = await captureScreenshot({
      tenantId: 't1',
      siteId: 's1',
      pageUrl: 'https://bihadashop.jp/p',
      device: 'pc',
      fetchImpl: fakeFetch,
      cloudflareConfig: CF_CONFIG,
    })
    expect(capture.provider).toBe('cloudflare')
    expect(capture.naturalWidth).toBe(1280)
    expect(capture.naturalHeight).toBe(7777)
    expect(capture.viewportWidth).toBe(1280)
    // degrade 経路で <img> が使えるよう imageUrl は data: URL
    expect(capture.imageUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(image.bytes).toEqual(jpeg)
    expect(image.contentType).toBe('image/jpeg')
  })

  it('falls back to Microlink when cloudflareConfig is null', async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input)
      if (url.startsWith('https://api.microlink.io')) {
        return new Response(
          JSON.stringify({
            status: 'success',
            data: { screenshot: { url: 'https://cdn.microlink.io/x.jpg', width: 1280, height: 4000 } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      // CDN image fetch
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]) as BodyInit, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    const { capture } = await captureScreenshot({
      tenantId: 't1',
      siteId: 's1',
      pageUrl: 'https://bihadashop.jp/p',
      device: 'pc',
      fetchImpl: fakeFetch,
      cloudflareConfig: null,
    })
    expect(capture.provider).toBe('microlink')
    expect(capture.imageUrl).toBe('https://cdn.microlink.io/x.jpg')
  })
})

describe('getCloudflareBRConfig — env resolution', () => {
  const ORIGINAL = { ...process.env }
  afterEach(() => {
    process.env = { ...ORIGINAL }
  })

  it('returns null when token is missing', () => {
    delete process.env.CLOUDFLARE_API_TOKEN
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct'
    expect(getCloudflareBRConfig()).toBeNull()
  })

  it('returns null when both account ids are missing', () => {
    process.env.CLOUDFLARE_API_TOKEN = 'tok'
    delete process.env.CLOUDFLARE_ACCOUNT_ID
    delete process.env.R2_ACCOUNT_ID
    expect(getCloudflareBRConfig()).toBeNull()
  })

  it('resolves with dedicated CLOUDFLARE_ACCOUNT_ID', () => {
    process.env.CLOUDFLARE_API_TOKEN = 'tok'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'cf-acct'
    expect(getCloudflareBRConfig()).toEqual({ accountId: 'cf-acct', apiToken: 'tok' })
  })

  it('falls back to R2_ACCOUNT_ID when CLOUDFLARE_ACCOUNT_ID is unset', () => {
    process.env.CLOUDFLARE_API_TOKEN = 'tok'
    delete process.env.CLOUDFLARE_ACCOUNT_ID
    process.env.R2_ACCOUNT_ID = 'r2-acct'
    expect(getCloudflareBRConfig()).toEqual({ accountId: 'r2-acct', apiToken: 'tok' })
  })
})
