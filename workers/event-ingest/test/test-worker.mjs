/**
 * Integration test for ugokimap-saas-event-ingest Worker
 *
 * B-2 拡張版: D-tenant-audit-001-04 Fix-6 5 ケース (tenant 解決) を末尾に追加。
 *
 * Usage:
 *   1. Start worker: cd workers/event-ingest && npx wrangler dev
 *      環境変数 (.dev.vars or wrangler secret put):
 *        CLICKHOUSE_URL=http://user:pass@localhost:8123  (要 SSH tunnel)
 *        MAGIC_LINK_SECRET=<ugokimap-saas/lib/auth/magic-link.ts と同値>
 *   2. SSH tunnel: ssh -f -N -i ~/.ssh/id_ed25519_hetzner2 -L 8123:127.0.0.1:8123 root@159.69.95.59
 *   3. Run test:   node test/test-worker.mjs
 *
 * Fix-6 case prerequisites (Hetzner ClickHouse 側に事前投入必要):
 *   INSERT INTO clickinsight.sites (site_id, tenant_id) VALUES
 *     ('TEST_b2_site_valid', 't_test_b2'),
 *     ('TEST_b2_site_other', 't_other_tenant');
 */

const WORKER_URL = process.env.WORKER_URL || 'http://localhost:8787';
const MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || '';
const results = [];

function assert(name, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  results.push({ name, status, detail });
  console.log(`  ${condition ? 'OK' : 'XX'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── HS256 JWT signer (Fix-6 case (a) 用) ───────────────────────────

function b64urlEncode(input) {
  const bin = typeof input === 'string' ? input : String.fromCharCode(...input);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signHs256(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = b64urlEncode(JSON.stringify(header));
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const data = `${headerB64}.${payloadB64}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
  const sigB64 = b64urlEncode(sig);
  return `${data}.${sigB64}`;
}

// ── Existing baseline tests ─────────────────────────────────────────

async function testHealthCheck() {
  console.log('\n── Health Check ──');
  const resp = await fetch(`${WORKER_URL}/health`);
  const body = await resp.json();
  assert('GET /health returns 200', resp.status === 200);
  assert('Health response has status:ok', body.status === 'ok');
}

async function testCORSPreflight() {
  console.log('\n── CORS Preflight ──');
  const resp = await fetch(`${WORKER_URL}/api/track`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://example.com' },
  });
  assert('OPTIONS returns 204', resp.status === 204);
  assert('CORS Allow-Origin present', !!resp.headers.get('Access-Control-Allow-Origin'));
  assert('CORS Allow-Methods includes POST', resp.headers.get('Access-Control-Allow-Methods')?.includes('POST'));
  assert('CORS Allow-Headers includes Authorization',
    resp.headers.get('Access-Control-Allow-Headers')?.includes('Authorization'));
}

async function testInvalidPayload() {
  console.log('\n── Invalid Payloads ──');

  const r1 = await fetch(`${WORKER_URL}/api/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json',
  });
  assert('Invalid JSON returns 400', r1.status === 400);

  const r2 = await fetch(`${WORKER_URL}/api/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ foo: 'bar' }),
  });
  assert('Missing site_id/event_type returns 400', r2.status === 400);

  const r3 = await fetch(`${WORKER_URL}/api/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [] }),
  });
  assert('Empty events array returns 400', r3.status === 400);
}

async function testNotFound() {
  console.log('\n── 404 Routes ──');
  const r1 = await fetch(`${WORKER_URL}/api/other`);
  assert('Unknown path returns 404', r1.status === 404);

  const r2 = await fetch(`${WORKER_URL}/api/track`);
  assert('GET /api/track returns 404', r2.status === 404);
}

// ── B-2 Fix-6: tenant 解決 5 ケース ────────────────────────────────

async function fix6_case_a_valid_jwt() {
  console.log('\n── Fix-6 (a) 有効 JWT → tenant_id OK ──');
  if (!MAGIC_LINK_SECRET) {
    assert('SKIP: MAGIC_LINK_SECRET env unset', false, 'set MAGIC_LINK_SECRET env to run');
    return;
  }
  const token = await signHs256({
    tenant_id: 't_test_b2',
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
    sub: 'test-user@example.com',
  }, MAGIC_LINK_SECRET);

  const event = {
    id: crypto.randomUUID(),
    site_id: 'TEST_b2_site_valid',
    session_id: 'test-session-fix6a',
    event_type: 'pageview',
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    url: 'https://example.com/test',
  };
  const resp = await fetch(`${WORKER_URL}/api/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events: [event] }),
  });
  const body = await resp.json();
  assert('(a) returns 200', resp.status === 200);
  assert('(a) accepted 1 event', body.received === 1);
  assert('(a) 0 dropped', (body.dropped ?? 0) === 0);
}

async function fix6_case_b_invalid_jwt() {
  console.log('\n── Fix-6 (b) 無効 JWT → 401 ──');
  // 署名部だけ意図的に破壊
  const tamperedToken = 'eyJhbGciOiJIUzI1NiJ9.eyJ0ZW5hbnRfaWQiOiJ0X3Rlc3RfYjIifQ.invalidsig';
  const event = {
    id: crypto.randomUUID(),
    site_id: 'TEST_b2_site_valid',
    session_id: 'test-session-fix6b',
    event_type: 'pageview',
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
  const resp = await fetch(`${WORKER_URL}/api/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tamperedToken}` },
    body: JSON.stringify({ events: [event] }),
  });
  assert('(b) returns 401', resp.status === 401);
  const body = await resp.json();
  assert('(b) reason is jwt_invalid', body.reason === 'jwt_invalid');
}

async function fix6_case_c_site_tenant_mismatch() {
  console.log('\n── Fix-6 (c) site_id 不一致 → 200 silent drop ──');
  // event.tenant_id を WRONG にして sites lookup mismatch を誘発
  const event = {
    id: crypto.randomUUID(),
    site_id: 'TEST_b2_site_valid',           // sites table 上は tenant_id='t_test_b2'
    tenant_id: 't_wrong_tenant_b2',          // tracking.js 偽装
    session_id: 'test-session-fix6c',
    event_type: 'pageview',
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
  const resp = await fetch(`${WORKER_URL}/api/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [event] }),
  });
  const body = await resp.json();
  assert('(c) returns 200 (silent drop)', resp.status === 200);
  assert('(c) accepted 0 events', body.received === 0);
  assert('(c) dropped 1 event', body.dropped === 1);
}

async function fix6_case_d_tenant_id_missing() {
  console.log('\n── Fix-6 (d) tenant_id 欠落 → silent drop ──');
  // 認証なし + event.tenant_id なし
  const event = {
    id: crypto.randomUUID(),
    site_id: 'TEST_b2_site_valid',
    session_id: 'test-session-fix6d',
    event_type: 'pageview',
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
  const resp = await fetch(`${WORKER_URL}/api/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [event] }),
  });
  const body = await resp.json();
  assert('(d) returns 200 (silent drop)', resp.status === 200);
  assert('(d) accepted 0 events', body.received === 0);
  assert('(d) dropped 1 event', body.dropped === 1);
}

async function fix6_case_e_legacy_tenant_blocked() {
  console.log('\n── Fix-6 (e) __legacy__ 流入 → cross-tenant 拒否 ──');
  const event = {
    id: crypto.randomUUID(),
    site_id: 'TEST_b2_site_valid',
    tenant_id: '__legacy__',
    session_id: 'test-session-fix6e',
    event_type: 'pageview',
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
  const resp = await fetch(`${WORKER_URL}/api/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [event] }),
  });
  const body = await resp.json();
  assert('(e) returns 200 (silent drop)', resp.status === 200);
  assert('(e) accepted 0 events', body.received === 0);
  assert('(e) dropped 1 event', body.dropped === 1);
}

// ── Run all tests ───────────────────────────────────────────────────

async function main() {
  console.log(`\nTesting Worker at ${WORKER_URL}\n`);

  try {
    await testHealthCheck();
    await testCORSPreflight();
    await testInvalidPayload();
    await testNotFound();
    // B-2 Fix-6 5 ケース (Hetzner ClickHouse + sites table seed 必要)
    await fix6_case_a_valid_jwt();
    await fix6_case_b_invalid_jwt();
    await fix6_case_c_site_tenant_mismatch();
    await fix6_case_d_tenant_id_missing();
    await fix6_case_e_legacy_tenant_blocked();
  } catch (err) {
    console.error('\nTest error:', err.message);
    if (err.cause?.code === 'ECONNREFUSED') {
      console.error('   → Worker not running. Start with: npx wrangler dev');
    }
    process.exit(1);
  }

  console.log('\n── Summary ──');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`  ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\n  Failed:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`    XX ${r.name}`));
    process.exit(1);
  }

  console.log('\nAll tests passed!\n');
}

main();
