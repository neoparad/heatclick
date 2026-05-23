/**
 * B-1 (decisions.md L275 続 14 / L162 続 15 §4.4 BR1) — data-tenant-id 必須化テスト
 *
 * tracking.js (public/v2/tracking.js) の tenant_id 解決と sendBeacon 抑止動作を検証。
 *
 * Runtime: Node 20+ built-in test runner (node:test)。
 * Run: `node --test tests/unit/tracking-tenant-id.test.js`
 *
 * Jest 互換性: describe/test/it シグネチャ + node:assert は Jest expect の subset で
 * 表現可能。将来 jest-environment-jsdom 配備後は本 file を Jest preset 経由で実行可。
 *
 * jest-environment-jsdom 未配備のため vm.runInContext で最小 DOM mock を構築し、
 * tracking.js IIFE を sandbox 評価する方式を採用。dependency 追加なし。
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const assert = require('node:assert/strict')

const TRACKING_JS_PATH = path.join(__dirname, '..', '..', 'public', 'v2', 'tracking.js')
const TRACKING_JS = fs.readFileSync(TRACKING_JS_PATH, 'utf-8')

/**
 * Build a minimal browser-like sandbox and execute tracking.js IIFE inside it.
 * Returns the captured side effects (console.error calls, sendBeacon calls, fetch calls,
 * and the final config snapshot exposed via window for assertion convenience).
 */
function runTracking({
  scriptAttrs = {},
  scriptSrc = 'https://cdn.example.com/v2/tracking.js',
  windowSiteId,
  windowTenantId,
  emitInitialPageview = false,
} = {}) {
  const consoleErrors = []
  const beaconCalls = []
  const fetchCalls = []

  // Mock script element used as document.currentScript and as the result of
  // document.querySelectorAll('script[src*="tracking.js"]').
  const scriptEl = {
    src: scriptSrc,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(scriptAttrs, name) ? scriptAttrs[name] : null
    },
    dataset: {},
  }

  const allScripts = [scriptEl]

  const makeStorage = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      clear: () => m.clear(),
    }
  }

  const noop = () => {}

  const documentMock = {
    currentScript: scriptEl,
    querySelector: (sel) => {
      if (sel === 'script[data-site-id]' || sel === 'script[data-tenant-id]') {
        return scriptEl
      }
      return null
    },
    querySelectorAll: (_sel) => allScripts,
    cookie: '',
    hidden: false,
    visibilityState: 'visible',
    referrer: '',
    title: 'test',
    addEventListener: noop,
    removeEventListener: noop,
    body: { addEventListener: noop, removeEventListener: noop, scrollHeight: 1000, clientHeight: 800 },
    documentElement: { scrollTop: 0, scrollHeight: 1000, clientHeight: 800 },
    head: { appendChild: noop, removeChild: noop },
    createElement: () => ({ addEventListener: noop, style: {}, set onerror(_v) {}, get onerror() { return null } }),
    getElementsByTagName: () => [],
  }

  const navigatorMock = {
    userAgent: 'NodeTestRunner/20 (no-browser)',
    language: 'ja',
    languages: ['ja', 'en'],
    sendBeacon(url, data) {
      beaconCalls.push({ url, data })
      return true
    },
    doNotTrack: null,
    cookieEnabled: true,
    platform: 'node',
    hardwareConcurrency: 4,
    maxTouchPoints: 0,
    connection: { effectiveType: '4g' },
  }

  const windowMock = {
    location: {
      href: 'https://example.com/landing',
      origin: 'https://example.com',
      pathname: '/landing',
      hostname: 'example.com',
      search: '',
      hash: '',
    },
    history: { pushState: noop, replaceState: noop },
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    pageXOffset: 0,
    pageYOffset: 0,
    devicePixelRatio: 1,
    addEventListener: noop,
    removeEventListener: noop,
    Blob: function MockBlob(parts) {
      this.parts = parts
    },
    URL,
    URLSearchParams,
    fetch: (url, init) => {
      fetchCalls.push({ url, init })
      return Promise.resolve({ ok: true })
    },
    setTimeout: noop,
    clearTimeout: noop,
    setInterval: noop,
    clearInterval: noop,
    requestAnimationFrame: noop,
    cancelAnimationFrame: noop,
    requestIdleCallback: noop,
    cancelIdleCallback: noop,
    console: {
      error: (...args) => consoleErrors.push(args.map(String).join(' ')),
      warn: noop,
      log: noop,
      info: noop,
      debug: noop,
    },
    CLICKINSIGHT_SITE_ID: windowSiteId,
    CLICKINSIGHT_TENANT_ID: windowTenantId,
    CLICKINSIGHT_API_URL: undefined,
    CLICKINSIGHT_DEBUG: false,
    CLICKINSIGHT_REQUIRE_CONSENT: false,
    CLICKINSIGHT_EXTENSIONS: 'none',
    crypto: { getRandomValues: (arr) => arr.fill(0) },
    performance: { now: () => 0, timing: {} },
    IntersectionObserver: function MockIO() { return { observe: noop, unobserve: noop, disconnect: noop } },
    MutationObserver: function MockMO() { return { observe: noop, disconnect: noop, takeRecords: () => [] } },
    PerformanceObserver: function MockPO() { return { observe: noop, disconnect: noop } },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    ResizeObserver: function MockRO() { return { observe: noop, disconnect: noop } },
  }

  const sandbox = {
    document: documentMock,
    window: windowMock,
    navigator: navigatorMock,
    sessionStorage: makeStorage(),
    localStorage: makeStorage(),
    console: windowMock.console,
    fetch: windowMock.fetch,
    setTimeout: noop,
    clearTimeout: noop,
    setInterval: noop,
    clearInterval: noop,
    Blob: windowMock.Blob,
    URL,
    URLSearchParams,
    CSS: { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
    crypto: windowMock.crypto,
    performance: windowMock.performance,
    IntersectionObserver: windowMock.IntersectionObserver,
    MutationObserver: windowMock.MutationObserver,
    PerformanceObserver: windowMock.PerformanceObserver,
    Math,
    Date,
    JSON,
    Promise,
    Error,
    Object,
    Array,
    String,
    Number,
    Boolean,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    // Expose `globalThis` so the IIFE can find browser globals as bare identifiers.
    globalThis: undefined,
  }
  // Cross-wire so window/global access patterns both work.
  windowMock.document = documentMock
  windowMock.navigator = navigatorMock
  windowMock.sessionStorage = sandbox.sessionStorage
  windowMock.localStorage = sandbox.localStorage
  sandbox.globalThis = sandbox

  vm.createContext(sandbox)

  let runtimeError
  try {
    vm.runInContext(TRACKING_JS, sandbox, { timeout: 1500 })
  } catch (err) {
    runtimeError = err
  }

  return { consoleErrors, beaconCalls, fetchCalls, sandbox, runtimeError }
}

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

test('B-1: tracking.js refuses to start when data-tenant-id is missing (silent drop)', () => {
  const result = runTracking({
    scriptAttrs: { 'data-site-id': 'site_demo' },
    // data-tenant-id intentionally omitted, no fallback
  })

  // Expect a console.error mentioning tenant
  const tenantErrors = result.consoleErrors.filter((line) => /Tenant ID is required/.test(line))
  assert.ok(
    tenantErrors.length >= 1,
    `Expected a "Tenant ID is required" console.error, got: ${JSON.stringify(result.consoleErrors)}`
  )

  // No sendBeacon should have been invoked at start-up (IIFE returned early)
  assert.equal(result.beaconCalls.length, 0, 'sendBeacon must not run when data-tenant-id is absent')
  assert.equal(result.fetchCalls.length, 0, 'fetch fallback must not run either')
})

test('B-1: tracking.js refuses to start when data-site-id is missing (existing contract preserved)', () => {
  const result = runTracking({
    scriptAttrs: { 'data-tenant-id': 'linkth_internal' },
    // data-site-id intentionally omitted
  })

  const siteErrors = result.consoleErrors.filter((line) => /Site ID is required/.test(line))
  assert.ok(
    siteErrors.length >= 1,
    'Pre-existing site-id required contract must still error when site-id is absent'
  )
  assert.equal(result.beaconCalls.length, 0)
})

test('B-1: tracking.js accepts data-tenant-id from script attribute', () => {
  const result = runTracking({
    scriptAttrs: { 'data-site-id': 'site_demo', 'data-tenant-id': 'linkth_internal' },
  })

  const tenantErrors = result.consoleErrors.filter((line) => /Tenant ID is required/.test(line))
  assert.equal(
    tenantErrors.length,
    0,
    `Did not expect tenant error when data-tenant-id is set, got: ${JSON.stringify(result.consoleErrors)}`
  )
  assert.equal(result.runtimeError, undefined, `Unexpected runtime error: ${result.runtimeError}`)
})

test('B-1: tracking.js accepts tenant_id via query string on script src (クエリ string 代替)', () => {
  const result = runTracking({
    scriptAttrs: { 'data-site-id': 'site_demo' }, // no data-tenant-id attribute
    scriptSrc: 'https://cdn.example.com/v2/tracking.js?tenant_id=linkth_internal',
  })

  const tenantErrors = result.consoleErrors.filter((line) => /Tenant ID is required/.test(line))
  assert.equal(
    tenantErrors.length,
    0,
    `Did not expect tenant error when ?tenant_id= is present on script src, got: ${JSON.stringify(result.consoleErrors)}`
  )
})

test('B-1: tracking.js accepts window.CLICKINSIGHT_TENANT_ID global fallback', () => {
  const result = runTracking({
    scriptAttrs: { 'data-site-id': 'site_demo' },
    windowTenantId: 'linkth_internal',
  })

  const tenantErrors = result.consoleErrors.filter((line) => /Tenant ID is required/.test(line))
  assert.equal(
    tenantErrors.length,
    0,
    'window.CLICKINSIGHT_TENANT_ID should satisfy the requirement'
  )
})

test('B-1: empty string data-tenant-id is treated as missing (silent drop)', () => {
  const result = runTracking({
    scriptAttrs: { 'data-site-id': 'site_demo', 'data-tenant-id': '' },
  })

  const tenantErrors = result.consoleErrors.filter((line) => /Tenant ID is required/.test(line))
  assert.ok(
    tenantErrors.length >= 1,
    'Empty data-tenant-id must trigger the required-error path (続 14 R3 空文字書込防止)'
  )
  assert.equal(result.beaconCalls.length, 0)
})
