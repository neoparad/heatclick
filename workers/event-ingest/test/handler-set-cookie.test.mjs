/**
 * Handler-level tests: POST /api/track の Set-Cookie 発行条件 (実 worker.ts を直接 import)
 *
 * 設計書: docs/tracking/FIRST_PARTY_VID_DESIGN_2026-08-16.md v3 §3-1 step 5 / §6
 *   - accepted event が 1 件以上ある 200 応答 **のみ** Set-Cookie を返す
 *   - 400 / 全件 drop の 200 では返さない
 *   - Cookie 値 > payload 値 > mint の正準化が INSERT 行に反映される
 *   - 不正な payload visitor_id は Set-Cookie に混入しない
 *   - Cookie ヘッダの生値がログ / audit / INSERT に現れない
 *   - CORS: ACAO '*' 固定、Allow-Credentials を絶対に返さない
 *
 * ClickHouse への fetch は globalThis.fetch を差し替えて捕捉する。
 *
 * Usage:
 *   cd ugokimap-saas/workers/event-ingest
 *   node --test test/handler-set-cookie.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import worker, { __TEST_ONLY__ } from '../src/worker.ts';
import { VISITOR_ID_COOKIE, VISITOR_ID_RE } from '../src/visitor-cookie.ts';

const ENV = {
  CLICKHOUSE_URL: 'http://user:pass@clickhouse.test:8123',
  CLICKHOUSE_DB: 'clickinsight',
  BATCH_SIZE: '50',
  FLUSH_INTERVAL_MS: '5000',
  MAGIC_LINK_SECRET: 'test-secret-'.padEnd(40, 'x'),
};

const TENANT = 't_acme';
const REGISTERED_SITE = 'CIP_registered_site';
const UNREGISTERED_SITE = 'CIP_unregistered_site';
const OK_VID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const COOKIE_VID = 'cookie00-1111-2222-3333-444444444444';
const SECRET_SENTINEL = 'CUSTOMER_SESSION_TOKEN_SENTINEL_9f3a';

/** captured outbound calls (ClickHouse SELECT / INSERT) and console.error output */
let fetchCalls;
let errorLogs;

function installFetchMock() {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const decoded = decodeURIComponent(u);
    fetchCalls.push({ url: decoded, body: init && init.body ? String(init.body) : '' });
    if (decoded.includes('SELECT tenant_id FROM sites')) {
      const site = decoded.match(/param_site_id=([^&]+)/)?.[1];
      if (site === REGISTERED_SITE) return new Response(`{"tenant_id":"${TENANT}"}\n`, { status: 200 });
      return new Response('', { status: 200 }); // not registered → empty result
    }
    return new Response('', { status: 200 }); // INSERT ok
  };
}

function makeCtx() {
  const pending = [];
  return {
    ctx: { waitUntil: (p) => pending.push(p), passThroughOnException() {} },
    flush: () => Promise.all(pending),
  };
}

function trackRequest({ body, headers = {} } = {}) {
  return new Request('https://ugokimap-event-ingest.linkth.workers.dev/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function event(overrides = {}) {
  return {
    site_id: REGISTERED_SITE,
    tenant_id: TENANT,
    event_type: 'pageview',
    timestamp: new Date().toISOString(),
    url: 'https://customer.example/',
    session_id: 'sess-0001',
    ...overrides,
  };
}

function insertedRows() {
  return fetchCalls
    .filter((c) => c.url.includes('INSERT INTO events '))
    .flatMap((c) => c.body.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));
}

beforeEach(() => {
  fetchCalls = [];
  errorLogs = [];
  installFetchMock();
  __TEST_ONLY__.SITE_TENANT_CACHE.clear();
  console.error = (...args) => { errorLogs.push(args.map(String).join(' ')); };
});

// ── Set-Cookie: accepted path ────────────────────────────────────────

test('accepted event, no Cookie header → 200 + Set-Cookie with payload vid + Cache-Control no-store', async () => {
  const { ctx, flush } = makeCtx();
  const res = await worker.fetch(trackRequest({ body: { events: [event({ visitor_id: OK_VID })] } }), ENV, ctx);
  await flush();

  assert.equal(res.status, 200);
  const sc = res.headers.get('set-cookie');
  assert.ok(sc, 'Set-Cookie must be present on accepted response');
  assert.equal(sc, `${VISITOR_ID_COOKIE}=${OK_VID}; Max-Age=34560000; Path=/; Secure; SameSite=Lax`);
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const rows = insertedRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].visitor_id, OK_VID);
});

test('valid Cookie header overrides payload vid, both in Set-Cookie and in the inserted row', async () => {
  const { ctx, flush } = makeCtx();
  const res = await worker.fetch(
    trackRequest({
      body: { events: [event({ visitor_id: OK_VID })] },
      headers: { Cookie: `${VISITOR_ID_COOKIE}=${COOKIE_VID}` },
    }),
    ENV,
    ctx,
  );
  await flush();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), new RegExp(`^${VISITOR_ID_COOKIE}=${COOKIE_VID};`));
  assert.equal(insertedRows()[0].visitor_id, COOKIE_VID, 'events must be rewritten to the canonical (cookie) vid');
});

test('malicious payload visitor_id (attribute injection) is NOT echoed; a fresh minted vid is used', async () => {
  const { ctx, flush } = makeCtx();
  const evil = 'abcdefgh; Domain=evil.com';
  const res = await worker.fetch(trackRequest({ body: { events: [event({ visitor_id: evil })] } }), ENV, ctx);
  await flush();

  assert.equal(res.status, 200);
  const sc = res.headers.get('set-cookie');
  assert.ok(sc);
  assert.doesNotMatch(sc, /evil\.com/);
  assert.doesNotMatch(sc, /Domain=/i);
  const minted = sc.match(new RegExp(`^${VISITOR_ID_COOKIE}=([^;]+);`))[1];
  assert.match(minted, VISITOR_ID_RE);
  assert.notEqual(minted, evil);
  assert.equal(insertedRows()[0].visitor_id, minted, 'row must carry the minted vid, not the attacker value');
});

test('duplicate __ugk_vid cookies → cookie ignored, payload vid used', async () => {
  const { ctx, flush } = makeCtx();
  const res = await worker.fetch(
    trackRequest({
      body: { events: [event({ visitor_id: OK_VID })] },
      headers: { Cookie: `${VISITOR_ID_COOKIE}=${COOKIE_VID}; ${VISITOR_ID_COOKIE}=zzzzzzzz-tossed` },
    }),
    ENV,
    ctx,
  );
  await flush();
  assert.match(res.headers.get('set-cookie'), new RegExp(`^${VISITOR_ID_COOKIE}=${OK_VID};`));
});

// ── Set-Cookie: must NOT be issued on non-accepted responses ─────────

test('400 (invalid JSON) → no Set-Cookie', async () => {
  const { ctx } = makeCtx();
  const res = await worker.fetch(trackRequest({ body: '{not json', headers: { Cookie: `${VISITOR_ID_COOKIE}=${COOKIE_VID}` } }), ENV, ctx);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('400 (no valid events) → no Set-Cookie', async () => {
  const { ctx } = makeCtx();
  const res = await worker.fetch(trackRequest({ body: { events: [{ foo: 'bar' }] } }), ENV, ctx);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('all events dropped (unregistered site) → 200 with received=0 and NO Set-Cookie', async () => {
  const { ctx, flush } = makeCtx();
  const res = await worker.fetch(
    trackRequest({
      body: { events: [event({ site_id: UNREGISTERED_SITE, visitor_id: OK_VID })] },
      headers: { Cookie: `${VISITOR_ID_COOKIE}=${COOKIE_VID}` },
    }),
    ENV,
    ctx,
  );
  await flush();
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.received, 0);
  assert.equal(json.dropped, 1);
  assert.equal(res.headers.get('set-cookie'), null, 'a doomed request must not be able to trigger cookie issuance');
  assert.equal(res.headers.get('cache-control'), null);
});

// ── Cookie header confidentiality ────────────────────────────────────

test('raw Cookie header never appears in console.error, audit INSERT, or events INSERT', async () => {
  const { ctx, flush } = makeCtx();
  const cookie = `sess=${SECRET_SENTINEL}; ${VISITOR_ID_COOKIE}=${COOKIE_VID}; wordpress_logged_in_x=${SECRET_SENTINEL}`;
  // one accepted + one dropped event: exercises both the events INSERT and the audit INSERT paths
  await worker.fetch(
    trackRequest({
      body: { events: [event({ visitor_id: OK_VID }), event({ site_id: UNREGISTERED_SITE })] },
      headers: { Cookie: cookie },
    }),
    ENV,
    ctx,
  );
  await flush();

  for (const call of fetchCalls) {
    assert.doesNotMatch(call.url, new RegExp(SECRET_SENTINEL));
    assert.doesNotMatch(call.body, new RegExp(SECRET_SENTINEL));
  }
  for (const line of errorLogs) {
    assert.doesNotMatch(line, new RegExp(SECRET_SENTINEL));
  }
});

// ── CORS invariants ──────────────────────────────────────────────────

test('CORS: ACAO is "*" and Allow-Credentials is never sent (OPTIONS and POST)', async () => {
  const { ctx } = makeCtx();
  const opt = await worker.fetch(
    new Request('https://ugokimap-event-ingest.linkth.workers.dev/api/track', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    }),
    ENV,
    ctx,
  );
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('access-control-allow-origin'), '*');
  assert.equal(opt.headers.get('access-control-allow-credentials'), null);

  const post = await worker.fetch(
    trackRequest({ body: { events: [event({ visitor_id: OK_VID })] }, headers: { Origin: 'https://evil.example' } }),
    ENV,
    ctx,
  );
  assert.equal(post.headers.get('access-control-allow-origin'), '*');
  assert.equal(post.headers.get('access-control-allow-credentials'), null);
});
