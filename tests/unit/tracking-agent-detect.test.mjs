/**
 * Client-side bot detection (_detectAgent in public/v2/tracking.js) — regression guard.
 *
 * 背景 (2026-09-25 Jev shadow 評価、797 セッション):
 *   直近 30 日の全セッションの 53% が is_agent=1 になっていた。原因は `plugins_empty` 信号で、
 *   Android Chrome / Samsung Browser / iOS Safari は仕様上 navigator.plugins が常に空のため、
 *   普通のモバイル訪問者が bot 扱いされ heatmap / cv-journey / experiments の is_agent=0 フィルタ
 *   から丸ごと落ちていた。あわせて Facebook 広告クローラー `meta-externalads/1.1` が UA リストに
 *   無く素通りしていた。
 *
 * このテストが保証すること:
 *   1. モバイル UA (Android / iPhone) では plugins が空でも is_agent=0
 *   2. デスクトップ UA で plugins が空なら従来どおり is_agent=1 (headless の主要シグナルを維持)
 *   3. meta-externalads UA は is_agent=1 / agent_type='meta-externalads'
 *   4. agent_signals には plugins_empty の観測値がそのまま残る (観測性は落とさない)
 *
 * Runtime: node:test + vm.runInContext sandbox (tests/unit/tracking-tenant-id.test.js と同方式)。
 * Run: `node --test tests/unit/tracking-agent-detect.test.mjs`
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TRACKING_JS = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'v2', 'tracking.js'), 'utf-8')

const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/30.0 Chrome/146.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  metaAds: 'meta-externalads/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
}

/** Run tracking.js in a sandbox, emit one event, flush, return the first beacon event. */
function detectWith({ userAgent, plugins = [], hasChromeObject = true }) {
  const beaconCalls = []
  const noop = () => {}
  const scriptEl = {
    src: 'https://cdn.example.com/v2/tracking.js',
    getAttribute: (n) => ({ 'data-site-id': 'site_demo', 'data-tenant-id': 'linkth_internal' })[n] ?? null,
    dataset: {},
  }
  const makeStorage = () => {
    const m = new Map()
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }
  }
  const documentMock = {
    currentScript: scriptEl,
    querySelector: (sel) => (sel === 'script[data-site-id]' || sel === 'script[data-tenant-id]' ? scriptEl : null),
    querySelectorAll: () => [scriptEl],
    cookie: '', hidden: false, visibilityState: 'visible', referrer: '', title: 'test', readyState: 'complete',
    addEventListener: noop, removeEventListener: noop,
    body: { addEventListener: noop, removeEventListener: noop, scrollHeight: 1000, clientHeight: 800 },
    documentElement: { scrollTop: 0, scrollHeight: 1000, clientHeight: 800 },
    head: { appendChild: noop, removeChild: noop },
    createElement: () => ({ addEventListener: noop, style: {}, set onerror(_v) {}, get onerror() { return null } }),
    getElementsByTagName: () => [],
  }
  const navigatorMock = {
    userAgent, language: 'ja', languages: ['ja', 'en'], plugins,
    sendBeacon(url, data) { beaconCalls.push({ url, data }); return true },
    doNotTrack: null, cookieEnabled: true, platform: 'node', hardwareConcurrency: 4, maxTouchPoints: 0,
    connection: { effectiveType: '4g' },
  }
  const windowMock = {
    location: { href: 'https://example.com/landing', origin: 'https://example.com', pathname: '/landing', hostname: 'example.com', search: '', hash: '' },
    history: { pushState: noop, replaceState: noop },
    innerWidth: 390, innerHeight: 844, scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0, devicePixelRatio: 1,
    addEventListener: noop, removeEventListener: noop,
    Blob: function MockBlob(parts) { this.parts = parts },
    URL, URLSearchParams,
    fetch: () => Promise.resolve({ ok: true }),
    setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
    requestAnimationFrame: noop, cancelAnimationFrame: noop, requestIdleCallback: noop, cancelIdleCallback: noop,
    console: { error: noop, warn: noop, log: noop, info: noop, debug: noop },
    CLICKINSIGHT_EXTENSIONS: 'none', CLICKINSIGHT_DEBUG: false, CLICKINSIGHT_REQUIRE_CONSENT: false,
    crypto: { getRandomValues: (arr) => arr.fill(0) },
    performance: { now: () => 0, timing: {} },
    IntersectionObserver: function MockIO() { return { observe: noop, unobserve: noop, disconnect: noop } },
    MutationObserver: function MockMO() { return { observe: noop, disconnect: noop, takeRecords: () => [] } },
    PerformanceObserver: function MockPO() { return { observe: noop, disconnect: noop } },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    ResizeObserver: function MockRO() { return { observe: noop, disconnect: noop } },
  }
  if (hasChromeObject) windowMock.chrome = { runtime: { sendMessage: noop } }
  const sandbox = {
    document: documentMock, window: windowMock, navigator: navigatorMock,
    sessionStorage: makeStorage(), localStorage: makeStorage(),
    console: windowMock.console, fetch: windowMock.fetch,
    setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
    Blob: windowMock.Blob, URL, URLSearchParams,
    CSS: { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
    crypto: windowMock.crypto, performance: windowMock.performance,
    IntersectionObserver: windowMock.IntersectionObserver, MutationObserver: windowMock.MutationObserver,
    PerformanceObserver: windowMock.PerformanceObserver,
    Navigator: function Navigator() {},
    Math, Date, JSON, Promise, Error, Object, Array, String, Number, Boolean,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    globalThis: undefined,
  }
  windowMock.document = documentMock
  windowMock.navigator = navigatorMock
  windowMock.sessionStorage = sandbox.sessionStorage
  windowMock.localStorage = sandbox.localStorage
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(TRACKING_JS, sandbox, { timeout: 1500 })

  const api = windowMock.ClickInsight
  assert.ok(api && typeof api.track === 'function', 'ClickInsight API must be exposed')
  api.track({ event_type: 'pageview' })
  api.flush()
  assert.ok(beaconCalls.length >= 1, 'flush must send a beacon')
  const body = JSON.parse(beaconCalls[0].data.parts[0])
  const ev = body.events.find((e) => e.event_type === 'pageview') ?? body.events[0]
  return { ...ev, signals: JSON.parse(ev.agent_signals) }
}

test('Android Chrome with empty navigator.plugins is NOT flagged as agent', () => {
  const ev = detectWith({ userAgent: UA.androidChrome, plugins: [] })
  assert.equal(ev.is_agent, 0, `agent_signals=${ev.agent_signals}`)
  assert.equal(ev.agent_type, '')
})

test('Samsung Browser with empty navigator.plugins is NOT flagged as agent', () => {
  const ev = detectWith({ userAgent: UA.samsung, plugins: [] })
  assert.equal(ev.is_agent, 0, `agent_signals=${ev.agent_signals}`)
})

test('iPhone Safari with empty navigator.plugins is NOT flagged as agent', () => {
  const ev = detectWith({ userAgent: UA.iphone, plugins: [] })
  assert.equal(ev.is_agent, 0, `agent_signals=${ev.agent_signals}`)
})

test('agent_signals still records plugins_empty=true on mobile (observability preserved)', () => {
  const ev = detectWith({ userAgent: UA.androidChrome, plugins: [] })
  assert.equal(ev.signals.plugins_empty, true)
})

test('desktop Chrome with empty navigator.plugins IS still flagged (headless signal kept)', () => {
  const ev = detectWith({ userAgent: UA.desktopChrome, plugins: [] })
  assert.equal(ev.is_agent, 1)
  assert.equal(ev.agent_type, 'unknown')
})

test('desktop Chrome with plugins present is NOT flagged', () => {
  const ev = detectWith({ userAgent: UA.desktopChrome, plugins: [{ name: 'PDF Viewer' }] })
  assert.equal(ev.is_agent, 0, `agent_signals=${ev.agent_signals}`)
})

test('meta-externalads (Facebook ads crawler) IS flagged with its UA name', () => {
  const ev = detectWith({ userAgent: UA.metaAds, plugins: [{ name: 'x' }] })
  assert.equal(ev.is_agent, 1)
  assert.equal(ev.agent_type, 'meta-externalads')
})
