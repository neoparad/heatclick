/**
 * Handler-level tests: POST /api/track の Set-Cookie 発行条件 (実 worker.ts を直接 import)
 *
 * 設計書: docs/tracking/FIRST_PARTY_VID_DESIGN_2026-08-16.md v5 §3-1 / §6
 *   - **第一者束縛**: Sec-Fetch-Site: same-origin × X-Forwarded-Host == sites.url のホスト ×
 *     単一 site_id × **サイト登録テナント == accepted のテナント (v5、JWT 経路対策)** ×
 *     **同一ホストを他テナントが登録していない (v5)** の場合のみ Cookie 由来 vid を採用し
 *     Set-Cookie を返す。未束縛ならイベントは payload のまま、Set-Cookie なし
 *   - accepted event が 1 件以上ある 200 応答 **のみ** Set-Cookie (400 / 全件 drop では返さない)
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

const MAGIC_LINK_SECRET = 'test-secret-'.padEnd(40, 'x');
const ENV = {
  CLICKHOUSE_URL: 'http://user:pass@clickhouse.test:8123',
  CLICKHOUSE_DB: 'clickinsight',
  BATCH_SIZE: '50',
  FLUSH_INTERVAL_MS: '5000',
  MAGIC_LINK_SECRET,
};

// 被害者 (顧客) サイト、攻撃者が別途正規登録したサイト、同一ホストを 2 テナントが登録した構成
const VICTIM = { site: 'CIP_victim_site', tenant: 't_victim', host: 'customer.example', url: 'https://customer.example/' };
const ATTACKER = { site: 'CIP_attacker_site', tenant: 't_attacker', host: 'attacker.example', url: 'https://attacker.example/' };
const SHARED_A = { site: 'CIP_shared_a', tenant: 't_shared_a', host: 'shared.example', url: 'https://shared.example/' };
const SHARED_B = { site: 'CIP_shared_b', tenant: 't_shared_b', host: 'shared.example', url: 'https://shared.example/blog' };
const NO_URL_SITE = { site: 'CIP_nourl_site', tenant: 't_nourl' };
const UNREGISTERED_SITE = 'CIP_unregistered_site';

const SITES = [VICTIM, ATTACKER, SHARED_A, SHARED_B];
const TENANTS_PER_HOST = SITES.reduce((m, s) => {
  m.set(s.host, (m.get(s.host) ?? new Set()).add(s.tenant));
  return m;
}, new Map());

const OK_VID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const COOKIE_VID = 'cookie00-1111-2222-3333-444444444444';
const VICTIM_VID = 'victim00-1111-2222-3333-444444444444';
const SECRET_SENTINEL = 'CUSTOMER_SESSION_TOKEN_SENTINEL_9f3a';

/** 第一者束縛が成立するヘッダ (顧客ページ → 顧客プロキシ → Worker) */
const BOUND_HEADERS = { 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-Host': VICTIM.host };

let fetchCalls;
let errorLogs;

function installFetchMock() {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const decoded = decodeURIComponent(u);
    fetchCalls.push({ url: decoded, body: init && init.body ? String(init.body) : '' });
    if (decoded.includes('SELECT tenant_id, url FROM sites')) {
      const siteId = decoded.match(/param_site_id=([^&]+)/)?.[1];
      const site = SITES.find((s) => s.site === siteId);
      if (site) return new Response(JSON.stringify({ tenant_id: site.tenant, url: site.url }) + '\n');
      if (siteId === NO_URL_SITE.site) return new Response(JSON.stringify({ tenant_id: NO_URL_SITE.tenant }) + '\n');
      return new Response('', { status: 200 }); // unregistered
    }
    if (decoded.includes('uniqExact(tenant_id)')) {
      const host = decoded.match(/param_host=([^&]+)/)?.[1];
      const n = TENANTS_PER_HOST.get(host)?.size ?? 0;
      // ClickHouse の既定は 64bit 整数を文字列で返す — その形を模す
      return new Response(JSON.stringify({ tenants: String(n) }) + '\n');
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
    site_id: VICTIM.site,
    tenant_id: VICTIM.tenant,
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

async function send({ events, headers }) {
  const { ctx, flush } = makeCtx();
  const res = await worker.fetch(trackRequest({ body: { events }, headers }), ENV, ctx);
  await flush();
  return res;
}

// ── HS256 JWT (worker.ts verifyJwtHs256 と同じ契約: alg=HS256, exp 必須, iat は +30s 以内) ──
function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function signJwt(claims, secret = MAGIC_LINK_SECRET) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ iat: now, exp: now + 3600, ...claims }));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

function clearCaches() {
  __TEST_ONLY__.SITE_TENANT_CACHE.clear();
  __TEST_ONLY__.SITE_HOST_CACHE.clear();
  __TEST_ONLY__.HOST_TENANTS_CACHE.clear();
}

beforeEach(() => {
  fetchCalls = [];
  errorLogs = [];
  installFetchMock();
  clearCaches();
  console.error = (...args) => { errorLogs.push(args.map(String).join(' ')); };
});

// ── 束縛成立時 (正規の第一者経路) ─────────────────────────────────────

test('bound + no Cookie → 200 + Set-Cookie with payload vid + Cache-Control no-store', async () => {
  const res = await send({ events: [event({ visitor_id: OK_VID })], headers: BOUND_HEADERS });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), `${VISITOR_ID_COOKIE}=${OK_VID}; Max-Age=34560000; Path=/; Secure; SameSite=Lax`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(insertedRows()[0].visitor_id, OK_VID);
});

test('bound + valid Cookie overrides payload vid in both Set-Cookie and the inserted row', async () => {
  const res = await send({
    events: [event({ visitor_id: OK_VID })],
    headers: { ...BOUND_HEADERS, Cookie: `${VISITOR_ID_COOKIE}=${COOKIE_VID}` },
  });
  assert.match(res.headers.get('set-cookie'), new RegExp(`^${VISITOR_ID_COOKIE}=${COOKIE_VID};`));
  assert.equal(insertedRows()[0].visitor_id, COOKIE_VID);
});

test('bound + malicious payload visitor_id → not echoed; minted vid used; is_first_visit forced true', async () => {
  const evil = 'abcdefgh; Domain=evil.com';
  const res = await send({ events: [event({ visitor_id: evil, is_first_visit: false })], headers: BOUND_HEADERS });
  const sc = res.headers.get('set-cookie');
  assert.ok(sc);
  assert.doesNotMatch(sc, /evil\.com|Domain=/i);
  const minted = sc.match(new RegExp(`^${VISITOR_ID_COOKIE}=([^;]+);`))[1];
  assert.match(minted, VISITOR_ID_RE);
  const row = insertedRows()[0];
  assert.equal(row.visitor_id, minted);
  assert.equal(row.is_first_visit, true, 'server-minted id must be recorded as a first visit');
});

test('bound + duplicate __ugk_vid cookies → cookie ignored, payload vid used', async () => {
  const res = await send({
    events: [event({ visitor_id: OK_VID })],
    headers: { ...BOUND_HEADERS, Cookie: `${VISITOR_ID_COOKIE}=${COOKIE_VID}; ${VISITOR_ID_COOKIE}=zzzzzzzz-tossed` },
  });
  assert.match(res.headers.get('set-cookie'), new RegExp(`^${VISITOR_ID_COOKIE}=${OK_VID};`));
});

test('bound: X-Forwarded-Host tolerates case, port, trailing dot and multi-hop list', async () => {
  for (const xfh of ['CUSTOMER.example', 'customer.example:443', 'customer.example.', 'customer.example, proxy.internal']) {
    clearCaches();
    fetchCalls = [];
    const res = await send({
      events: [event({ visitor_id: OK_VID })],
      headers: { 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-Host': xfh },
    });
    assert.ok(res.headers.get('set-cookie'), `should be bound for X-Forwarded-Host=${JSON.stringify(xfh)}`);
  }
});

test('bound via JWT path (victim tenant JWT + victim site): host cache is cold → lookup runs → Set-Cookie', async () => {
  const jwt = await signJwt({ tenant_id: VICTIM.tenant });
  const res = await send({
    events: [event({ visitor_id: OK_VID })],
    headers: { ...BOUND_HEADERS, Authorization: `Bearer ${jwt}`, Cookie: `${VISITOR_ID_COOKIE}=${COOKIE_VID}` },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), new RegExp(`^${VISITOR_ID_COOKIE}=${COOKIE_VID};`));
  assert.equal(insertedRows()[0].tenant_id, VICTIM.tenant);
  assert.equal(insertedRows()[0].visitor_id, COOKIE_VID);
});

// ── 束縛不成立 (Codex round2 HIGH: same-site 兄弟サブドメイン) ────────

test('ATTACK (round2 HIGH): sibling-subdomain beacon with attacker site through victim proxy → victim vid must NOT reach attacker tenant, no Set-Cookie', async () => {
  const res = await send({
    events: [event({ site_id: ATTACKER.site, tenant_id: ATTACKER.tenant, visitor_id: OK_VID })],
    headers: { 'Sec-Fetch-Site': 'same-site', 'X-Forwarded-Host': VICTIM.host, Cookie: `${VISITOR_ID_COOKIE}=${VICTIM_VID}` },
  });
  assert.equal(res.status, 200);
  const rows = insertedRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenant_id, ATTACKER.tenant);
  assert.notEqual(rows[0].visitor_id, VICTIM_VID, 'victim cookie vid must not be written into attacker tenant');
  assert.equal(rows[0].visitor_id, OK_VID, 'unbound → payload vid passes through unchanged');
  assert.equal(res.headers.get('set-cookie'), null, 'unbound → no Set-Cookie (no fixation of the victim cookie)');
});

test('ATTACK variant: same-origin request (third-party script on victim page) carrying attacker site_id → host mismatch → not bound', async () => {
  const res = await send({
    events: [event({ site_id: ATTACKER.site, tenant_id: ATTACKER.tenant, visitor_id: OK_VID })],
    headers: { 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-Host': VICTIM.host, Cookie: `${VISITOR_ID_COOKIE}=${VICTIM_VID}` },
  });
  const rows = insertedRows();
  assert.equal(rows[0].tenant_id, ATTACKER.tenant);
  assert.notEqual(rows[0].visitor_id, VICTIM_VID);
  assert.equal(res.headers.get('set-cookie'), null);
});

// ── 束縛不成立 (Codex round3 HIGH: JWT 経路でのテナント境界) ────────────

test('ATTACK (round3 HIGH): attacker-tenant JWT + victim site_id + victim origin → registered tenant mismatch → victim vid must NOT reach attacker tenant, no Set-Cookie', async () => {
  // JWT 経路は site_id の所有を照合しないため tenant=t_attacker / site=victim_site で accepted になる。
  // 束縛は「サイト登録テナント (t_victim) == accepted テナント (t_attacker)」で拒否されること。
  const jwt = await signJwt({ tenant_id: ATTACKER.tenant });
  const res = await send({
    events: [event({ site_id: VICTIM.site, visitor_id: OK_VID })],
    headers: { ...BOUND_HEADERS, Authorization: `Bearer ${jwt}`, Cookie: `${VISITOR_ID_COOKIE}=${VICTIM_VID}` },
  });
  assert.equal(res.status, 200);
  const rows = insertedRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenant_id, ATTACKER.tenant, 'JWT path accepts the event under the JWT tenant (pre-existing behavior)');
  assert.equal(rows[0].site_id, VICTIM.site);
  assert.notEqual(rows[0].visitor_id, VICTIM_VID, 'victim cookie vid must not be adopted across the tenant boundary');
  assert.equal(rows[0].visitor_id, OK_VID);
  assert.equal(res.headers.get('set-cookie'), null);
});

// ── 束縛不成立 (Codex round3 MEDIUM: 同一ホストを複数テナントが登録) ───

test('host registered by two tenants → not bound for either, even when everything else matches', async () => {
  for (const s of [SHARED_A, SHARED_B]) {
    clearCaches();
    fetchCalls = [];
    const res = await send({
      events: [event({ site_id: s.site, tenant_id: s.tenant, visitor_id: OK_VID, url: s.url })],
      headers: { 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-Host': s.host, Cookie: `${VISITOR_ID_COOKIE}=${COOKIE_VID}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('set-cookie'), null, `shared host must not bind (${s.site})`);
    assert.equal(insertedRows()[0].visitor_id, OK_VID, 'cookie must not be adopted on a shared host');
  }
});

test('host-tenant count lookup failure (ClickHouse error) → fail closed, not bound', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (decodeURIComponent(String(url)).includes('uniqExact(tenant_id)')) return new Response('boom', { status: 500 });
    return realFetch(url, init);
  };
  const res = await send({ events: [event({ visitor_id: OK_VID })], headers: BOUND_HEADERS });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('host-tenant count query is only issued when the other binding conditions already hold', async () => {
  await send({ events: [event({ visitor_id: OK_VID })], headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(fetchCalls.filter((c) => c.url.includes('uniqExact(tenant_id)')).length, 0, 'no extra query for unbound requests');
  fetchCalls = [];
  await send({ events: [event({ visitor_id: OK_VID })], headers: BOUND_HEADERS });
  assert.equal(fetchCalls.filter((c) => c.url.includes('uniqExact(tenant_id)')).length, 1);
});

// ── 束縛不成立 (その他) ───────────────────────────────────────────────

test('legacy direct workers.dev call (no X-Forwarded-Host) → never bound → no Set-Cookie, events untouched', async () => {
  const res = await send({
    events: [event({ visitor_id: OK_VID })],
    headers: { 'Sec-Fetch-Site': 'cross-site', Cookie: `${VISITOR_ID_COOKIE}=${COOKIE_VID}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(res.headers.get('cache-control'), null);
  assert.equal(insertedRows()[0].visitor_id, OK_VID, 'cookie must not be adopted without binding');
});

test('missing Sec-Fetch-Site (old browser / proxy dropped it) → fail closed, no Set-Cookie', async () => {
  const res = await send({ events: [event({ visitor_id: OK_VID })], headers: { 'X-Forwarded-Host': VICTIM.host } });
  assert.equal(res.headers.get('set-cookie'), null);
});

test('forged X-Forwarded-Host that does not match the registered host → not bound', async () => {
  const res = await send({
    events: [event({ visitor_id: OK_VID })],
    headers: { 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-Host': 'evil.example' },
  });
  assert.equal(res.headers.get('set-cookie'), null);
});

test('site registered without a url → registered host unknown → not bound', async () => {
  const res = await send({
    events: [event({ site_id: NO_URL_SITE.site, tenant_id: NO_URL_SITE.tenant, visitor_id: OK_VID })],
    headers: { 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-Host': 'anything.example' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('mixed site_ids in one accepted batch → not bound', async () => {
  const res = await send({
    events: [event({ visitor_id: OK_VID }), event({ site_id: ATTACKER.site, tenant_id: ATTACKER.tenant, visitor_id: OK_VID })],
    headers: { ...BOUND_HEADERS, Cookie: `${VISITOR_ID_COOKIE}=${COOKIE_VID}` },
  });
  assert.equal(res.headers.get('set-cookie'), null);
  for (const row of insertedRows()) assert.equal(row.visitor_id, OK_VID);
});

// ── accepted 0 件の応答では発行しない ──────────────────────────────────

test('400 (invalid JSON) → no Set-Cookie', async () => {
  const { ctx } = makeCtx();
  const res = await worker.fetch(trackRequest({ body: '{not json', headers: { ...BOUND_HEADERS, Cookie: `${VISITOR_ID_COOKIE}=${COOKIE_VID}` } }), ENV, ctx);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('400 (no valid events) → no Set-Cookie', async () => {
  const { ctx } = makeCtx();
  const res = await worker.fetch(trackRequest({ body: { events: [{ foo: 'bar' }] }, headers: BOUND_HEADERS }), ENV, ctx);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('all events dropped (unregistered site) → 200 received=0 and NO Set-Cookie even when bound headers are present', async () => {
  const res = await send({
    events: [event({ site_id: UNREGISTERED_SITE, visitor_id: OK_VID })],
    headers: { ...BOUND_HEADERS, Cookie: `${VISITOR_ID_COOKIE}=${COOKIE_VID}` },
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.received, 0);
  assert.equal(json.dropped, 1);
  assert.equal(res.headers.get('set-cookie'), null);
});

// ── Cookie header confidentiality ────────────────────────────────────

test('raw Cookie header never appears in console.error, audit INSERT, or events INSERT', async () => {
  const cookie = `sess=${SECRET_SENTINEL}; ${VISITOR_ID_COOKIE}=${COOKIE_VID}; wordpress_logged_in_x=${SECRET_SENTINEL}`;
  await send({
    events: [event({ visitor_id: OK_VID }), event({ site_id: UNREGISTERED_SITE })],
    headers: { ...BOUND_HEADERS, Cookie: cookie },
  });
  for (const call of fetchCalls) {
    assert.doesNotMatch(call.url, new RegExp(SECRET_SENTINEL));
    assert.doesNotMatch(call.body, new RegExp(SECRET_SENTINEL));
  }
  for (const line of errorLogs) assert.doesNotMatch(line, new RegExp(SECRET_SENTINEL));
});

// ── CORS invariants ──────────────────────────────────────────────────

test('CORS: ACAO is "*" and Allow-Credentials is never sent (OPTIONS and POST)', async () => {
  const { ctx } = makeCtx();
  const opt = await worker.fetch(
    new Request('https://ugokimap-event-ingest.linkth.workers.dev/api/track', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }),
    ENV,
    ctx,
  );
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('access-control-allow-origin'), '*');
  assert.equal(opt.headers.get('access-control-allow-credentials'), null);

  const post = await send({ events: [event({ visitor_id: OK_VID })], headers: { Origin: 'https://evil.example' } });
  assert.equal(post.headers.get('access-control-allow-origin'), '*');
  assert.equal(post.headers.get('access-control-allow-credentials'), null);
});
