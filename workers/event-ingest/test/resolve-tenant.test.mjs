/**
 * Unit tests for resolveTenant / verifyJwtHs256 / normalizeTenantId / parseClickHouseEnv
 *
 * B-2 Step 4 (Fix-6 整合) + HIGH 4 件修正 (Infra 続 19、Reviewer 続 12 起票)
 *   - H-1: exp 必須 numeric + nbf/iat 検証 (perpetual token 攻撃防御)
 *   - H-2: parseClickHouseEnv で credentials を URL から排除、Basic Auth ヘッダ生成
 *   - H-3: normalizeTenantId (NFKC + trim + lowercase + allowlist) で __LEGACY__ / ＿＿legacy 等の bypass 防御
 *   - H-4: cache negative entry / lookup dedupe (handler-level、本 unit test では cacheStore(null) で間接検証)
 *
 * Usage:
 *   cd ugokimap-saas/workers/event-ingest
 *   node --test test/resolve-tenant.test.mjs
 *
 * Node 20+ 必須 (node:test + Web Crypto API + 動的 import + globalThis.fetch override)
 *
 * 注意: src/worker.ts は TypeScript なので本テストは "transpile-less" 戦略を採らない。
 *       代わりに resolveTenant のコア動作を等価実装 (mjs) で再現、worker.ts と
 *       機能 contract を 1:1 で再現することで間接検証する。
 *       完全 E2E は test-worker.mjs (wrangler dev 経由) で実施。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── 等価実装 (worker.ts と同一仕様) ────────────────────────────────

function b64urlDecode(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('binary');
}
function b64urlEncode(input) {
  const bin = typeof input === 'string' ? input : String.fromCharCode(...input);
  return Buffer.from(bin, 'binary').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(s) {
  const bin = b64urlDecode(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function signHs256(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = b64urlEncode(JSON.stringify(header));
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, enc.encode(`${headerB64}.${payloadB64}`)),
  );
  return `${headerB64}.${payloadB64}.${b64urlEncode(sig)}`;
}

// H-1: exp 必須、nbf 未来 reject、iat 30s+ 未来 reject
async function verifyJwtHs256(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  try {
    const headerJson = JSON.parse(b64urlDecode(headerB64));
    if (headerJson.alg !== 'HS256') return null;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    const sig = b64urlToBytes(sigB64);
    const signed = enc.encode(`${headerB64}.${payloadB64}`);
    const valid = await crypto.subtle.verify('HMAC', key, sig, signed);
    if (!valid) return null;
    const payload = JSON.parse(b64urlDecode(payloadB64));
    // H-1: exp 必須 numeric
    if (typeof payload.exp !== 'number' || !isFinite(payload.exp)) return null;
    const nowSec = Date.now() / 1000;
    if (nowSec > payload.exp) return null;
    // H-1: nbf 未来 reject
    if (payload.nbf !== undefined) {
      if (typeof payload.nbf !== 'number' || !isFinite(payload.nbf)) return null;
      if (nowSec < payload.nbf) return null;
    }
    // H-1: iat 30s+ 未来 reject
    if (payload.iat !== undefined) {
      if (typeof payload.iat !== 'number' || !isFinite(payload.iat)) return null;
      if (payload.iat > nowSec + 30) return null;
    }
    return payload;
  } catch {
    return null;
  }
}

// H-3: normalizeTenantId (NFKC + trim + lowercase + allowlist)
function normalizeTenantId(raw) {
  if (typeof raw !== 'string') return null;
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  const normalized = raw.normalize('NFKC').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,64}$/.test(normalized)) return null;
  return normalized;
}
const RESERVED_LEGACY_TENANTS = new Set(['__legacy__']);

// H-2: parseClickHouseEnv (URL parser、credentials 排除、Basic Auth header)
function parseClickHouseEnv(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { baseUrl: raw, authHeader: 'Basic ' + Buffer.from('default:').toString('base64') };
  }
  const user = decodeURIComponent(u.username) || 'default';
  const password = decodeURIComponent(u.password) || '';
  u.username = '';
  u.password = '';
  const baseUrl = `${u.protocol}//${u.host}`;
  const authHeader = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  return { baseUrl, authHeader };
}

// H-4: cache with negative entry
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
function cacheLookup(site_id) {
  const entry = cache.get(site_id);
  if (!entry) return { hit: false };
  if (Date.now() > entry.expires_at) {
    cache.delete(site_id);
    return { hit: false };
  }
  return { hit: true, tenant_id: entry.tenant_id };
}
function cacheStore(site_id, tenant_id) {
  cache.set(site_id, { tenant_id, expires_at: Date.now() + CACHE_TTL_MS });
}

function makeFetchMock(siteTenantMap) {
  return async (url) => {
    const u = new URL(url);
    const siteParam = u.searchParams.get('param_site_id') ?? '';
    const tenant = siteTenantMap[siteParam];
    if (tenant) {
      return {
        ok: true,
        text: async () => JSON.stringify({ tenant_id: tenant }) + '\n',
      };
    }
    return { ok: true, text: async () => '' };
  };
}

async function lookupTenantBySiteId(fetchImpl, env, site_id) {
  const cached = cacheLookup(site_id);
  if (cached.hit) return cached.tenant_id;
  const { baseUrl, authHeader } = parseClickHouseEnv(env.CLICKHOUSE_URL);
  const queryUrl = `${baseUrl}/?param_site_id=${encodeURIComponent(site_id)}`;
  const resp = await fetchImpl(queryUrl, { headers: { Authorization: authHeader } });
  if (!resp.ok) return null;
  const text = await resp.text();
  if (!text.trim()) {
    cacheStore(site_id, null);
    return null;
  }
  try {
    const row = JSON.parse(text.split('\n').find((l) => l.trim().length > 0));
    if (typeof row.tenant_id !== 'string' || !row.tenant_id) {
      cacheStore(site_id, null);
      return null;
    }
    const canonical = normalizeTenantId(row.tenant_id);
    if (canonical === null) {
      cacheStore(site_id, null);
      return null;
    }
    cacheStore(site_id, canonical);
    return canonical;
  } catch {
    return null;
  }
}

async function resolveTenant(fetchImpl, request, event, env) {
  const authz = request.headers.get('authorization');
  if (authz && authz.toLowerCase().startsWith('bearer ')) {
    const token = authz.slice(7).trim();
    if (token && env.MAGIC_LINK_SECRET) {
      const payload = await verifyJwtHs256(token, env.MAGIC_LINK_SECRET);
      if (!payload) return { ok: false, reason: 'jwt_invalid' };
      const tid = normalizeTenantId(payload.tenant_id);
      if (tid === null) return { ok: false, reason: 'tenant_id_missing' };
      if (RESERVED_LEGACY_TENANTS.has(tid)) return { ok: false, reason: 'legacy_tenant_blocked' };
      return { ok: true, tenant_id: tid, source: 'jwt' };
    }
  }
  const site_id = typeof event.site_id === 'string' ? event.site_id : '';
  if (!site_id) return { ok: false, reason: 'site_id_missing' };
  const claimed = normalizeTenantId(event.tenant_id);
  if (claimed === null) return { ok: false, reason: 'tenant_id_missing' };
  if (RESERVED_LEGACY_TENANTS.has(claimed)) return { ok: false, reason: 'legacy_tenant_blocked' };
  const expected = await lookupTenantBySiteId(fetchImpl, env, site_id);
  if (expected === null) return { ok: false, reason: 'site_tenant_mismatch' };
  if (expected !== claimed) return { ok: false, reason: 'site_tenant_mismatch' };
  return { ok: true, tenant_id: claimed, source: 'tracking_js' };
}

// ── Fixtures ────────────────────────────────────────────────────────

const SECRET = 'test-magic-link-secret-deadbeef-cafebabe';
const env = { MAGIC_LINK_SECRET: SECRET, CLICKHOUSE_URL: 'http://u:p@example.com:8123' };
const siteMap = {
  TEST_b2_site_valid: 't_test_b2',
  TEST_b2_site_other: 't_other_tenant',
};
const fetchMock = makeFetchMock(siteMap);

function req(headers = {}) {
  return new Request('http://localhost/api/track', { method: 'POST', headers });
}

// ──────────────────────────────────────────────────────────────────
// Fix-6 baseline 5 ケース (続 16 で起票、本続 19 で normalize/exp 強化)
// ──────────────────────────────────────────────────────────────────

test('Fix-6 (a) valid JWT resolves tenant_id from claim', async () => {
  cache.clear();
  const token = await signHs256(
    { tenant_id: 't_test_b2', exp: Math.floor(Date.now() / 1000) + 600 },
    SECRET,
  );
  const r = await resolveTenant(
    fetchMock, req({ authorization: `Bearer ${token}` }),
    { site_id: 'TEST_b2_site_valid', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, true);
  assert.equal(r.tenant_id, 't_test_b2');
  assert.equal(r.source, 'jwt');
});

test('Fix-6 (b) tampered JWT signature fails verify', async () => {
  cache.clear();
  const r = await resolveTenant(
    fetchMock, req({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJ0ZW5hbnRfaWQiOiJ0X3hheCJ9.invalidsig' }),
    { site_id: 'TEST_b2_site_valid', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'jwt_invalid');
});

test('Fix-6 (c) site_tenant_mismatch (claimed differs from sites lookup)', async () => {
  cache.clear();
  const r = await resolveTenant(
    fetchMock, req(),
    { site_id: 'TEST_b2_site_valid', tenant_id: 't_wrong_tenant_b2', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'site_tenant_mismatch');
});

test('Fix-6 (d) tenant_id missing (no JWT, no event.tenant_id)', async () => {
  cache.clear();
  const r = await resolveTenant(
    fetchMock, req(),
    { site_id: 'TEST_b2_site_valid', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tenant_id_missing');
});

test('Fix-6 (e) __legacy__ via tracking_js is blocked', async () => {
  cache.clear();
  const r = await resolveTenant(
    fetchMock, req(),
    { site_id: 'TEST_b2_site_valid', tenant_id: '__legacy__', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'legacy_tenant_blocked');
});

// ──────────────────────────────────────────────────────────────────
// H-1 (jwt-exp-optional-perpetual) - perpetual token 攻撃防御
// ──────────────────────────────────────────────────────────────────

test('H-1 (a) JWT without exp claim is rejected (perpetual token attack)', async () => {
  cache.clear();
  const token = await signHs256({ tenant_id: 't_test_b2' /* exp 欠落 */ }, SECRET);
  const r = await resolveTenant(
    fetchMock, req({ authorization: `Bearer ${token}` }),
    { site_id: 'TEST_b2_site_valid', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'jwt_invalid', 'exp missing → reject');
});

test('H-1 (b) JWT with string exp ("9999999999") is rejected (non-numeric bypass)', async () => {
  cache.clear();
  const token = await signHs256(
    { tenant_id: 't_test_b2', exp: '9999999999' /* string ではない numeric */ },
    SECRET,
  );
  const r = await resolveTenant(
    fetchMock, req({ authorization: `Bearer ${token}` }),
    { site_id: 'TEST_b2_site_valid', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'jwt_invalid', 'string exp → reject');
});

test('H-1 (c) JWT expired (exp = 1 minute ago) is rejected', async () => {
  cache.clear();
  const token = await signHs256(
    { tenant_id: 't_test_b2', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET,
  );
  const r = await resolveTenant(
    fetchMock, req({ authorization: `Bearer ${token}` }),
    { site_id: 'TEST_b2_site_valid', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'jwt_invalid');
});

test('H-1 (d) JWT with nbf in future is rejected (Not Before)', async () => {
  cache.clear();
  const token = await signHs256(
    {
      tenant_id: 't_test_b2',
      exp: Math.floor(Date.now() / 1000) + 3600,
      nbf: Math.floor(Date.now() / 1000) + 300, // 5 分後から有効
    },
    SECRET,
  );
  const r = await resolveTenant(
    fetchMock, req({ authorization: `Bearer ${token}` }),
    { site_id: 'TEST_b2_site_valid', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'jwt_invalid');
});

test('H-1 (e) JWT with iat in far future is rejected (clock skew > 30s)', async () => {
  cache.clear();
  const token = await signHs256(
    {
      tenant_id: 't_test_b2',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000) + 120, // 2 分後 issued
    },
    SECRET,
  );
  const r = await resolveTenant(
    fetchMock, req({ authorization: `Bearer ${token}` }),
    { site_id: 'TEST_b2_site_valid', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'jwt_invalid');
});

test('H-1 (f) JWT with iat slightly future (10s) is accepted (within clock skew)', async () => {
  cache.clear();
  const token = await signHs256(
    {
      tenant_id: 't_test_b2',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000) + 10, // 10 秒未来は許容
    },
    SECRET,
  );
  const r = await resolveTenant(
    fetchMock, req({ authorization: `Bearer ${token}` }),
    { site_id: 'TEST_b2_site_valid', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, true);
});

// ──────────────────────────────────────────────────────────────────
// H-3 (legacy-tenant-blocked-not-normalized) - 正規化 bypass 防御
// ──────────────────────────────────────────────────────────────────

test('H-3 (a) tenant_id "__LEGACY__" (uppercase) is normalized + blocked', async () => {
  cache.clear();
  const r = await resolveTenant(
    fetchMock, req(),
    { site_id: 'TEST_b2_site_valid', tenant_id: '__LEGACY__', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'legacy_tenant_blocked', 'uppercase __LEGACY__ → blocked');
});

test('H-3 (b) tenant_id "__legacy__  " (trailing spaces) is trimmed + blocked', async () => {
  cache.clear();
  const r = await resolveTenant(
    fetchMock, req(),
    { site_id: 'TEST_b2_site_valid', tenant_id: '__legacy__  ', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'legacy_tenant_blocked');
});

test('H-3 (c) tenant_id with NFKC-equivalent fullwidth underscores is blocked', async () => {
  cache.clear();
  // ＿＿legacy＿＿ (U+FF3F fullwidth low line) → NFKC で __legacy__
  const r = await resolveTenant(
    fetchMock, req(),
    { site_id: 'TEST_b2_site_valid', tenant_id: '＿＿legacy＿＿', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'legacy_tenant_blocked', 'NFKC equivalent → blocked');
});

test('H-3 (d) tenant_id with null byte is rejected as invalid format', async () => {
  cache.clear();
  const r = await resolveTenant(
    fetchMock, req(),
    { site_id: 'TEST_b2_site_valid', tenant_id: 't_test_b2\x00', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tenant_id_missing', 'null byte → invalid format (allowlist 違反)');
});

test('H-3 (e) tenant_id with special chars rejected (allowlist enforced)', async () => {
  cache.clear();
  const r = await resolveTenant(
    fetchMock, req(),
    { site_id: 'TEST_b2_site_valid', tenant_id: "t'or'1=1--", event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tenant_id_missing');
});

test('H-3 (f) tenant_id over 64 chars rejected (length cap)', async () => {
  cache.clear();
  const longTid = 't_' + 'a'.repeat(65);
  const r = await resolveTenant(
    fetchMock, req(),
    { site_id: 'TEST_b2_site_valid', tenant_id: longTid, event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tenant_id_missing');
});

test('H-3 (g) JWT path also normalizes "__LEGACY__" claim', async () => {
  cache.clear();
  const token = await signHs256(
    { tenant_id: '__LEGACY__', exp: Math.floor(Date.now() / 1000) + 600 }, SECRET,
  );
  const r = await resolveTenant(
    fetchMock, req({ authorization: `Bearer ${token}` }),
    { site_id: 'TEST_b2_site_valid', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'legacy_tenant_blocked');
});

test('H-3 (h) mixed case "T_TEST_B2" normalizes to lowercase and resolves OK', async () => {
  cache.clear();
  // sites table has t_test_b2 (lowercase). Mixed-case input should still resolve.
  const r = await resolveTenant(
    fetchMock, req(),
    { site_id: 'TEST_b2_site_valid', tenant_id: 'T_TEST_B2', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, true);
  assert.equal(r.tenant_id, 't_test_b2', 'lowercase canonical form');
});

// ──────────────────────────────────────────────────────────────────
// H-2 (clickhouse-creds-in-query-string) - URL credential 漏洩防御
// ──────────────────────────────────────────────────────────────────

test('H-2 (a) parseClickHouseEnv strips credentials from URL', () => {
  const out = parseClickHouseEnv('http://chuser:chpass@host.example.com:8123');
  assert.equal(out.baseUrl, 'http://host.example.com:8123');
  assert.ok(!out.baseUrl.includes('chuser'), 'user must not appear in baseUrl');
  assert.ok(!out.baseUrl.includes('chpass'), 'password must not appear in baseUrl');
  assert.match(out.authHeader, /^Basic /);
  const decoded = Buffer.from(out.authHeader.slice(6), 'base64').toString();
  assert.equal(decoded, 'chuser:chpass');
});

test('H-2 (b) parseClickHouseEnv handles password with special chars', () => {
  const pw = 'p@ss:wo/rd';
  const url = `http://u:${encodeURIComponent(pw)}@host:8123`;
  const out = parseClickHouseEnv(url);
  assert.equal(out.baseUrl, 'http://host:8123');
  const decoded = Buffer.from(out.authHeader.slice(6), 'base64').toString();
  assert.equal(decoded, `u:${pw}`, 'special chars survive round-trip via Basic Auth');
});

test('H-2 (c) parseClickHouseEnv without credentials defaults to "default" user', () => {
  const out = parseClickHouseEnv('http://host:8123');
  assert.equal(out.baseUrl, 'http://host:8123');
  const decoded = Buffer.from(out.authHeader.slice(6), 'base64').toString();
  assert.equal(decoded, 'default:');
});

// ──────────────────────────────────────────────────────────────────
// H-4 (audit-burst + lookup negative cache)
// ──────────────────────────────────────────────────────────────────

test('H-4 (a) negative cache: 2nd lookup of unregistered site avoids fetch', async () => {
  cache.clear();
  let fetchCalls = 0;
  const countingFetch = async (url) => {
    fetchCalls += 1;
    return fetchMock(url);
  };
  // 1st call: unregistered → null → negative cache 投入
  await resolveTenant(
    countingFetch, req(),
    { site_id: 'TEST_unregistered_site', tenant_id: 't_test_b2', event_type: 'pageview' }, env,
  );
  assert.equal(fetchCalls, 1);
  // 2nd call: 同じ unregistered → negative cache hit、fetch 増えない
  await resolveTenant(
    countingFetch, req(),
    { site_id: 'TEST_unregistered_site', tenant_id: 't_test_b2', event_type: 'pageview' }, env,
  );
  assert.equal(fetchCalls, 1, '2nd unregistered lookup must hit negative cache');
});

test('H-4 (b) positive cache: 2nd lookup of registered site avoids fetch', async () => {
  cache.clear();
  let fetchCalls = 0;
  const countingFetch = async (url) => {
    fetchCalls += 1;
    return fetchMock(url);
  };
  await resolveTenant(
    countingFetch, req(),
    { site_id: 'TEST_b2_site_valid', tenant_id: 't_test_b2', event_type: 'pageview' }, env,
  );
  await resolveTenant(
    countingFetch, req(),
    { site_id: 'TEST_b2_site_valid', tenant_id: 't_test_b2', event_type: 'pageview' }, env,
  );
  assert.equal(fetchCalls, 1, '2nd registered lookup must hit positive cache');
});

// ──────────────────────────────────────────────────────────────────
// 追加: 補助カバレッジ (続 16 → 続 19 の差分維持)
// ──────────────────────────────────────────────────────────────────

test('JWT verified but tenant_id claim absent → tenant_id_missing', async () => {
  cache.clear();
  const token = await signHs256(
    { sub: 'u@example.com', exp: Math.floor(Date.now() / 1000) + 600 }, SECRET,
  );
  const r = await resolveTenant(
    fetchMock, req({ authorization: `Bearer ${token}` }),
    { site_id: 'TEST_b2_site_valid', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tenant_id_missing');
});

test('tracking_js success: valid site + matching tenant_id', async () => {
  cache.clear();
  const r = await resolveTenant(
    fetchMock, req(),
    { site_id: 'TEST_b2_site_valid', tenant_id: 't_test_b2', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, true);
  assert.equal(r.tenant_id, 't_test_b2');
  assert.equal(r.source, 'tracking_js');
});

test('site_id missing → site_id_missing', async () => {
  cache.clear();
  const r = await resolveTenant(
    fetchMock, req(),
    { tenant_id: 't_test_b2', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'site_id_missing');
});

test('wrong secret JWT → jwt_invalid', async () => {
  cache.clear();
  const token = await signHs256(
    { tenant_id: 't_test_b2', exp: Math.floor(Date.now() / 1000) + 600 },
    'WRONG_SECRET_DOES_NOT_MATCH',
  );
  const r = await resolveTenant(
    fetchMock, req({ authorization: `Bearer ${token}` }),
    { site_id: 'TEST_b2_site_valid', event_type: 'pageview' }, env,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'jwt_invalid');
});
