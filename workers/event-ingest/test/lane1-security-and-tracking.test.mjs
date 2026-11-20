/**
 * Unit tests for Lane 1 Tracking & Edge Ingest Security enhancements:
 *   - Task 1: resolveTenant reverse lookup when event.tenant_id is omitted + public/tracking.js tenant_id & visitor_id
 *   - Task 2: _detectAgent() multi-signal calibration (no false positives on Mac Safari / no_conn; strong vs weak signals)
 *   - Task 3: document_height & robust element_selector / element_tag in public/tracking.js
 *   - Task 4: Origin/Referer/Host verification + Isolate sliding-window rate limiter (600 req/min per site_id+client_ip)
 *
 * Usage:
 *   cd ugokimap-saas/workers/event-ingest
 *   node --test test/lane1-security-and-tracking.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import worker, { __TEST_ONLY__ } from '../src/worker.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACKING_JS_PATH = path.resolve(__dirname, '../../../public/tracking.js');

const {
  resolveTenant,
  checkRateLimit,
  isHostAllowedForSite,
  verifyRequestOriginAndHost,
  SITE_TENANT_CACHE,
  SITE_HOST_CACHE,
  HOST_TENANTS_CACHE,
  RATE_LIMIT_BUCKETS,
} = __TEST_ONLY__;

const ENV = {
  CLICKHOUSE_URL: 'http://user:pass@clickhouse.test:8123',
  CLICKHOUSE_DB: 'clickinsight',
  BATCH_SIZE: '50',
  FLUSH_INTERVAL_MS: '5000',
  MAGIC_LINK_SECRET: 'test-secret-'.padEnd(40, 'x'),
};

const SITE_VALID = {
  site: 'CIP_lane1_valid',
  tenant: 't_lane1_tenant',
  host: 'example.com',
  url: 'https://www.example.com/',
};

let fetchCalls = [];

function installFetchMock() {
  globalThis.fetch = async (url, init) => {
    const u = decodeURIComponent(String(url));
    fetchCalls.push({ url: u, body: init?.body ? String(init.body) : '' });
    if (u.includes('SELECT tenant_id, url FROM sites')) {
      const siteId = u.match(/param_site_id=([^&]+)/)?.[1];
      if (siteId === SITE_VALID.site) {
        return new Response(JSON.stringify({ tenant_id: SITE_VALID.tenant, url: SITE_VALID.url }) + '\n');
      }
      if (siteId === 'CIP_legacy_site') {
        return new Response(JSON.stringify({ tenant_id: '__legacy__', url: 'https://legacy.example.com' }) + '\n');
      }
      return new Response('', { status: 200 });
    }
    if (u.includes('uniqExact(tenant_id)')) {
      return new Response(JSON.stringify({ tenants: '1' }) + '\n');
    }
    return new Response('', { status: 200 });
  };
}

function makeCtx() {
  const pending = [];
  return {
    ctx: { waitUntil: (p) => pending.push(p), passThroughOnException() {} },
    flush: () => Promise.all(pending),
  };
}

beforeEach(() => {
  fetchCalls = [];
  installFetchMock();
  SITE_TENANT_CACHE.clear();
  SITE_HOST_CACHE.clear();
  HOST_TENANTS_CACHE.clear();
  RATE_LIMIT_BUCKETS.clear();
});

// ── Task 1: resolveTenant reverse lookup when tenant_id is omitted ─────

test('Task 1: resolveTenant looks up tenant_id from clickinsight.sites when event.tenant_id is omitted or empty', async () => {
  const req = new Request('https://ugokimap-event-ingest.linkth.workers.dev/api/track', { method: 'POST' });

  // 1) tenant_id omitted
  const r1 = await resolveTenant(req, { site_id: SITE_VALID.site, event_type: 'pageview' }, ENV);
  assert.equal(r1.ok, true);
  if (r1.ok) {
    assert.equal(r1.tenant_id, SITE_VALID.tenant);
    assert.equal(r1.source, 'site_lookup');
  }

  // 2) tenant_id empty string (cached hit)
  const r2 = await resolveTenant(req, { site_id: SITE_VALID.site, tenant_id: '   ', event_type: 'click' }, ENV);
  assert.equal(r2.ok, true);
  if (r2.ok) {
    assert.equal(r2.tenant_id, SITE_VALID.tenant);
    assert.equal(r2.source, 'site_lookup');
  }
});

test('Task 1: resolveTenant rejects unregistered site_id when tenant_id is omitted', async () => {
  const req = new Request('https://ugokimap-event-ingest.linkth.workers.dev/api/track', { method: 'POST' });
  const r = await resolveTenant(req, { site_id: 'CIP_unknown_999', event_type: 'pageview' }, ENV);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'site_not_registered');
  }
});

test('Task 1: Worker POST /api/track accepts v1 event without tenant_id via site_id lookup and populates tenant_id', async () => {
  const { ctx, flush } = makeCtx();
  const req = new Request('https://ugokimap-event-ingest.linkth.workers.dev/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://www.example.com' },
    body: JSON.stringify({
      events: [
        {
          id: 'ev-1',
          site_id: SITE_VALID.site,
          event_type: 'pageview',
          url: 'https://www.example.com/landing',
        },
      ],
    }),
  });
  const res = await worker.fetch(req, ENV, ctx);
  await flush();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.received, 1);
  assert.equal(body.dropped, 0);

  const insertCall = fetchCalls.find((c) => c.url.includes('INSERT INTO events '));
  assert.ok(insertCall, 'events table INSERT should be called');
  const inserted = JSON.parse(insertCall.body.trim());
  assert.equal(inserted.tenant_id, SITE_VALID.tenant);
});

// ── Task 4-1: Origin / Host verification ──────────────────────────────

test('Task 4-1: isHostAllowedForSite matches exact host, www variant, subdomains, and localhost dev', () => {
  assert.equal(isHostAllowedForSite('example.com', 'example.com'), true);
  assert.equal(isHostAllowedForSite('www.example.com', 'example.com'), true);
  assert.equal(isHostAllowedForSite('example.com', 'www.example.com'), true);
  assert.equal(isHostAllowedForSite('shop.example.com', 'www.example.com'), true);
  assert.equal(isHostAllowedForSite('localhost', 'example.com', true), true);
  assert.equal(isHostAllowedForSite('127.0.0.1', 'example.com', true), true);
  assert.equal(isHostAllowedForSite('localhost', 'localhost', false), true);
  assert.equal(isHostAllowedForSite('evil-example.com', 'example.com'), false);
  assert.equal(isHostAllowedForSite('attacker.com', 'example.com'), false);
});

test('Task 4-1: verifyRequestOriginAndHost blocks mismatched Origin or Referer against registered site host', () => {
  const badOriginReq = new Request('https://ugokimap-event-ingest.linkth.workers.dev/api/track', {
    method: 'POST',
    headers: { Origin: 'https://evil.attacker.example' },
  });
  const r1 = verifyRequestOriginAndHost(badOriginReq, [{ url: 'https://example.com/' }], 'example.com');
  assert.equal(r1.ok, false);

  const badRefererReq = new Request('https://ugokimap-event-ingest.linkth.workers.dev/api/track', {
    method: 'POST',
    headers: { Referer: 'https://phishing.site/page' },
  });
  const r2 = verifyRequestOriginAndHost(badRefererReq, [{ url: 'https://example.com/' }], 'example.com');
  assert.equal(r2.ok, false);

  const goodSubdomainReq = new Request('https://ugokimap-event-ingest.linkth.workers.dev/api/track', {
    method: 'POST',
    headers: { Origin: 'https://lp.example.com' },
  });
  const r3 = verifyRequestOriginAndHost(goodSubdomainReq, [{ url: 'https://lp.example.com/offer' }], 'www.example.com');
  assert.equal(r3.ok, true);

  const localhostReq = new Request('https://ugokimap-event-ingest.linkth.workers.dev/api/track', {
    method: 'POST',
    headers: { Origin: 'http://localhost:3000', 'x-ugoki-dev-localhost': '1' },
  });
  const r4 = verifyRequestOriginAndHost(localhostReq, [{ url: 'http://localhost:3000/test' }], 'example.com');
  assert.equal(r4.ok, true);
});

test('Task 4-1: Worker returns 403 origin_mismatch when Origin header does not match registered site URL', async () => {
  const { ctx, flush } = makeCtx();
  const req = new Request('https://ugokimap-event-ingest.linkth.workers.dev/api/track', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://malicious-competitor.org',
    },
    body: JSON.stringify({
      events: [
        {
          site_id: SITE_VALID.site,
          tenant_id: SITE_VALID.tenant,
          event_type: 'pageview',
          url: 'https://example.com/',
        },
      ],
    }),
  });
  const res = await worker.fetch(req, ENV, ctx);
  await flush();
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'origin_mismatch');
});

// ── Task 4-2: Sliding Window Rate Limiter ─────────────────────────────

test('Task 4-2: checkRateLimit allows up to 600 batches/min per (site_id, client_ip) and blocks 601st with 429', async () => {
  const now = 1_700_000_000_000;
  for (let i = 1; i <= 600; i++) {
    const r = checkRateLimit(SITE_VALID.site, '203.0.113.50', now + i * 10);
    assert.equal(r.allowed, true, `request #${i} should be allowed`);
  }
  const blocked = checkRateLimit(SITE_VALID.site, '203.0.113.50', now + 6010);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);

  // Different IP for same site is unaffected
  const otherIp = checkRateLimit(SITE_VALID.site, '203.0.113.51', now + 6010);
  assert.equal(otherIp.allowed, true);
});

test('Task 4-2: Worker returns 429 rate_limited when (site_id, client_ip) exceeds 600 requests/min', async () => {
  const ip = '198.51.100.77';
  const now = Date.now();
  for (let i = 0; i < 600; i++) {
    checkRateLimit(SITE_VALID.site, ip, now);
  }

  const { ctx } = makeCtx();
  const req = new Request('https://ugokimap-event-ingest.linkth.workers.dev/api/track', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'cf-connecting-ip': ip,
      Origin: 'https://www.example.com',
    },
    body: JSON.stringify({
      events: [{ site_id: SITE_VALID.site, tenant_id: SITE_VALID.tenant, event_type: 'pageview', url: 'https://www.example.com/' }],
    }),
  });
  const res = await worker.fetch(req, ENV, ctx);
  assert.equal(res.status, 429);
  assert.ok(res.headers.get('retry-after'));
  const body = await res.json();
  assert.equal(body.error, 'rate_limited');
});

// ── Task 1, 2, 3: public/tracking.js VM evaluation tests ──────────────

function runTrackingJsInVm({
  userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  webdriver = false,
  pluginsLength = 0, // Mac Safari often has 0 plugins
  hasConnection = false, // Safari has no navigator.connection
  languages = ['ja-JP', 'ja'],
  hasChromeObj = false,
  innerWidth = 1440,
  innerHeight = 900,
  scrollHeight = 3200,
  tenantIdAttr = 't_demo_tenant',
  siteIdAttr = 'CIP_demo_site',
  webglAvailable = true,
  phantomGlobals = {},
  scriptPath = TRACKING_JS_PATH,
  locationHref = 'https://www.example.com/products?utm_source=google',
  referrer = 'https://www.google.com/',
  imgElements = [],
} = {}) {
  const code = fs.readFileSync(scriptPath, 'utf8');
  const beacons = [];
  const listeners = {};

  const scriptEl = {
    src: 'https://ugokimap.example.com/tracking.js',
    dataset: {},
    getAttribute(name) {
      if (name === 'data-site-id') return siteIdAttr;
      if (name === 'data-tenant-id') return tenantIdAttr;
      if (name === 'data-extensions') return 'none';
      return null;
    },
  };

  const storage = new Map();
  const sessionStore = new Map();
  let cookieStr = '';

  const nav = {
    userAgent,
    webdriver,
    plugins: { length: pluginsLength },
    languages,
    sendBeacon(url, blob) {
      beacons.push({ url, blob });
      return true;
    },
  };
  if (hasConnection) {
    nav.connection = { effectiveType: '4g' };
  }

  const doc = {
    currentScript: scriptEl,
    readyState: 'complete',
    title: 'Test Page',
    referrer,
    hidden: false,
    get cookie() { return cookieStr; },
    set cookie(val) {
      const kv = String(val).split(';')[0];
      const [k, v] = kv.split('=');
      cookieStr = `${k}=${v}`;
    },
    documentElement: { clientWidth: innerWidth, clientHeight: innerHeight, scrollHeight },
    body: { scrollHeight },
    head: { appendChild() {} },
    querySelectorAll(sel) {
      if (sel === 'img') return imgElements;
      if (typeof sel === 'string' && sel.startsWith('h1')) return [];
      return [scriptEl];
    },
    querySelector() { return scriptEl; },
    addEventListener(type, fn) { listeners[type] = fn; },
    createElement(tag) {
      if (tag === 'canvas') {
        return {
          getContext() {
            if (!webglAvailable) return null;
            return {
              getExtension() { return null; },
              getParameter() { return 'ANGLE (Apple, Apple M2)'; },
            };
          },
        };
      }
      return {};
    },
  };

  const parsedLoc = new URL(locationHref);
  const win = {
    location: { href: locationHref, search: parsedLoc.search, origin: parsedLoc.origin, protocol: parsedLoc.protocol, hostname: parsedLoc.hostname },
    innerWidth,
    innerHeight,
    scrollY: 120,
    pageYOffset: 120,
    screen: { width: innerWidth, height: innerHeight },
    navigator: nav,
    document: doc,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    sessionStorage: {
      getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
      setItem: (k, v) => sessionStore.set(k, String(v)),
    },
    addEventListener(type, fn) { listeners['win_' + type] = fn; },
    ...phantomGlobals,
  };
  if (hasChromeObj) win.chrome = { runtime: {} };

  const sandbox = {
    window: win,
    document: doc,
    navigator: nav,
    location: win.location,
    screen: win.screen,
    localStorage: win.localStorage,
    sessionStorage: win.sessionStorage,
    URL,
    URLSearchParams,
    Blob: class FakeBlob {
      constructor(parts) { this.text = parts.join(''); }
    },
    CSS: { escape: (s) => String(s) },
    console,
    setTimeout: (fn) => { Promise.resolve().then(fn); return 1; },
    clearTimeout: () => {},
    fetch: async () => ({ ok: true }),
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  if (win.ClickInsight && typeof win.ClickInsight.flush === 'function') {
    win.ClickInsight.flush();
  }

  const getEvents = () => {
    if (win.ClickInsight && typeof win.ClickInsight.flush === 'function') {
      win.ClickInsight.flush();
    }
    return beacons.flatMap((b) => JSON.parse(b.blob.text).events);
  };
  return { win, doc, listeners, get parsedEvents() { return getEvents(); } };
}

test('Task 1 & 2 & 3: Mac Safari human user (plugins=0, no navigator.connection) is NOT flagged as AI agent (is_agent=0) and includes tenant_id, visitor_id, document_height', () => {
  const { parsedEvents } = runTrackingJsInVm({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    pluginsLength: 0,
    hasConnection: false,
    tenantIdAttr: 't_safari_tenant',
    siteIdAttr: 'CIP_safari_site',
    scrollHeight: 4500,
  });

  assert.ok(parsedEvents.length >= 1, 'pageview event should be queued and flushed');
  const pv = parsedEvents[0];
  assert.equal(pv.site_id, 'CIP_safari_site');
  assert.equal(pv.tenant_id, 't_safari_tenant');
  assert.ok(typeof pv.visitor_id === 'string' && pv.visitor_id.length >= 8, 'visitor_id must be present');
  assert.equal(pv.visitor_id, pv.user_id, 'visitor_id and user_id should align on 1st party ID');
  assert.equal(pv.document_height, 4500, 'document_height must be sent');
  assert.equal(pv.is_agent, 0, 'Mac Safari with 0 plugins & no connection must NOT false-positive as agent');
});

test('Task 2: Explicit AI bot UA (ClaudeBot, GPTBot, ChatGPT-User, PerplexityBot) triggers is_agent=1', () => {
  for (const [ua, expectedType] of [
    ['Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'ClaudeBot'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1', 'GPTBot'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0', 'OAI-SearchBot'],
    ['Mozilla/5.0 (compatible; Perplexity-User/1.0)', 'Perplexity-User'],
  ]) {
    const { parsedEvents } = runTrackingJsInVm({ userAgent: ua });
    assert.equal(parsedEvents[0].is_agent, 1, `UA ${ua} should be detected as agent`);
    assert.equal(parsedEvents[0].agent_type.toLowerCase(), expectedType.toLowerCase());
  }
});

test('Task 2: navigator.webdriver=true or multiple weak signals (>=2) triggers is_agent=1', () => {
  // 1) Strong signal: webdriver = true
  const wd = runTrackingJsInVm({ webdriver: true });
  assert.equal(wd.parsedEvents[0].is_agent, 1);
  assert.equal(wd.parsedEvents[0].agent_type, 'webdriver');

  // 2) 2 weak signals: zero_screen + empty languages + no_webgl
  const multiWeak = runTrackingJsInVm({
    innerWidth: 0,
    innerHeight: 0,
    languages: [],
    webglAvailable: false,
  });
  assert.equal(multiWeak.parsedEvents[0].is_agent, 1);
  assert.equal(multiWeak.parsedEvents[0].agent_type, 'heuristic_multi');
});

test('Task 3: Click tracker sends document_height, element_selector, section_selector, and handles SVG/TextNode targets safely', () => {
  const ctx = runTrackingJsInVm({ scrollHeight: 5120 });
  const { doc, listeners } = ctx;

  const sectionEl = {
    nodeType: 1,
    tagName: 'SECTION',
    id: 'pricing-table',
    parentElement: doc.body,
    children: [],
    getAttribute: () => null,
  };
  const btnEl = {
    nodeType: 1,
    tagName: 'BUTTON',
    id: '',
    className: { baseVal: 'svg-btn-class' }, // simulate SVGAnimatedString
    textContent: '  今すぐ申し込む  ',
    parentElement: sectionEl,
    getAttribute: (attr) => (attr === 'data-track-id' ? 'cta-main' : null),
    getBoundingClientRect: () => ({ left: 100, top: 250 }),
    closest: (sel) => (sel.includes('section') ? sectionEl : null),
  };
  sectionEl.children = [btnEl];

  // Simulate clicking a text node inside the button
  const textNodeTarget = {
    nodeType: 3,
    parentElement: btnEl,
  };

  listeners.click({ target: textNodeTarget, clientX: 140, clientY: 270 });

  const clickEv = ctx.parsedEvents.find((e) => e.event_type === 'click');
  assert.ok(clickEv, 'click event should be recorded');
  assert.equal(clickEv.document_height, 5120);
  assert.equal(clickEv.element_tag, 'button');
  assert.equal(clickEv.element_tag_name, 'button');
  assert.equal(clickEv.element_class_name, 'svg-btn-class');
  assert.match(clickEv.element_selector, /#pricing-table>button/);
  assert.equal(clickEv.section_selector, '#pricing-table');
});

// ── Security Hygiene Hotfix Verification ──────────────────────────────

test('Hygiene 1 & 2: Both tracking.js and v2/tracking.js synchronously redact PII query params in url & referrer without locking img.alt setter', () => {
  const v2Path = path.resolve(__dirname, '../../../public/v2/tracking.js');
  for (const sp of [TRACKING_JS_PATH, v2Path]) {
    const imgEl = {
      tagName: 'IMG',
      alt: 'initial-alt',
      getAttribute(attr) { return attr === 'alt' ? this.alt : 'https://www.example.com/hero.jpg?token=imgsecret'; },
    };
    const ctx = runTrackingJsInVm({
      scriptPath: sp,
      locationHref: 'https://www.example.com/thanks?email=taro%40example.com&token=abc123secret&utm_source=google&id=42',
      referrer: 'https://partner.example.org/auth?reset_token=xyz999&camp=spring',
      imgElements: [imgEl],
    });

    const pv = ctx.parsedEvents.find((e) => e.event_type === 'pageview');
    assert.ok(pv, `pageview emitted for ${sp}`);
    assert.doesNotMatch(pv.url, /taro|abc123secret/, 'sensitive query values must be redacted from page url');
    assert.match(pv.url, /utm_source=google/, 'UTM params must remain intact');
    assert.match(pv.url, /id=42/, 'non-sensitive query params must remain intact');
    assert.doesNotMatch(pv.referrer, /xyz999/, 'sensitive query values must be redacted from referrer');
    assert.match(pv.referrer, /camp=spring/, 'non-sensitive referrer params must remain intact');

    // Verify host site JS can still dynamically mutate img.alt (no noop setter lock)
    imgEl.alt = 'updated-by-host-carousel';
    assert.equal(imgEl.alt, 'updated-by-host-carousel', `img.alt setter must remain mutable for ${sp}`);
  }
});

test('Hygiene 3: Unused public/recording.js and public/track.js are removed from public directory', () => {
  assert.equal(fs.existsSync(path.resolve(__dirname, '../../../public/recording.js')), false);
  assert.equal(fs.existsSync(path.resolve(__dirname, '../../../public/track.js')), false);
});

test('Hygiene 4A: Worker rejects headerless curl POST (missing Origin, Referer, and Sec-Fetch-Site) against registered site host', async () => {
  const { ctx, flush } = makeCtx();
  const req = new Request('https://ugokimap-event-ingest.linkth.workers.dev/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      events: [
        {
          site_id: SITE_VALID.site,
          tenant_id: SITE_VALID.tenant,
          event_type: 'pageview',
          url: 'https://www.example.com/',
        },
      ],
    }),
  });
  const res = await worker.fetch(req, ENV, ctx);
  await flush();
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'origin_mismatch');
});

test('Hygiene 4B: lib/llm/hybrid-query.ts has zero unparameterized pageUrl SQL string literals', () => {
  const hqSource = fs.readFileSync(path.resolve(__dirname, '../../../lib/llm/hybrid-query.ts'), 'utf8');
  assert.doesNotMatch(hqSource, /'\$\{params\.pageUrl\}'/, 'params.pageUrl must never be interpolated as a SQL string literal');
});
