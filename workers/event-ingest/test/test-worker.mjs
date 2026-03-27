/**
 * Integration test for ugokimap-event-ingest Worker
 *
 * Usage:
 *   1. Start worker: cd workers/event-ingest && npx wrangler dev
 *   2. Run test:     node test/test-worker.mjs
 *
 * For ClickHouse integration test, ensure SSH tunnel is active:
 *   ssh -f -N -i ~/.ssh/id_ed25519_hetzner2 -L 8123:127.0.0.1:8123 root@159.69.95.59
 */

const WORKER_URL = process.env.WORKER_URL || 'http://localhost:8787';
const results = [];

function assert(name, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  results.push({ name, status, detail });
  console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

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

async function testSingleEvent() {
  console.log('\n── Single Event ──');
  const event = {
    id: crypto.randomUUID(),
    site_id: 'TEST_worker_dev',
    session_id: 'test-session-001',
    event_type: 'pageview',
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    url: 'https://example.com/test',
    referrer: '',
    user_agent: 'WorkerTest/1.0',
    viewport_width: 1920,
    viewport_height: 1080,
    device_type: 'desktop',
    sequence_id: 1,
  };

  const resp = await fetch(`${WORKER_URL}/api/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [event] }),
  });
  const body = await resp.json();
  assert('Single event returns 200', resp.status === 200);
  assert('Response has success:true', body.success === true);
  assert('Received count is 1', body.received === 1);
}

async function testBatchEvents() {
  console.log('\n── Batch Events (mixed types) ──');
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const events = [
    {
      id: crypto.randomUUID(),
      site_id: 'TEST_worker_dev',
      session_id: 'test-session-002',
      event_type: 'pageview',
      timestamp: now,
      url: 'https://example.com/page1',
      user_agent: 'WorkerTest/1.0',
      viewport_width: 1920,
      viewport_height: 1080,
      device_type: 'desktop',
      sequence_id: 1,
    },
    {
      id: crypto.randomUUID(),
      site_id: 'TEST_worker_dev',
      session_id: 'test-session-002',
      event_type: 'click',
      timestamp: now,
      url: 'https://example.com/page1',
      user_agent: 'WorkerTest/1.0',
      viewport_width: 1920,
      viewport_height: 1080,
      click_x: 500,
      click_y: 300,
      element_tag_name: 'a',
      element_href: 'https://example.com/link',
      element_selector: 'a.cta-button',
      device_type: 'desktop',
      sequence_id: 2,
    },
    {
      id: crypto.randomUUID(),
      site_id: 'TEST_worker_dev',
      session_id: 'test-session-002',
      event_type: 'scroll',
      timestamp: now,
      url: 'https://example.com/page1',
      user_agent: 'WorkerTest/1.0',
      viewport_width: 1920,
      viewport_height: 1080,
      scroll_y: 800,
      scroll_percentage: 45,
      device_type: 'desktop',
      sequence_id: 3,
    },
    {
      id: crypto.randomUUID(),
      site_id: 'TEST_worker_dev',
      session_id: 'test-session-002',
      event_type: 'dead_click',
      timestamp: now,
      url: 'https://example.com/page1',
      user_agent: 'WorkerTest/1.0',
      viewport_width: 1920,
      viewport_height: 1080,
      click_x: 200,
      click_y: 600,
      element_tag_name: 'div',
      element_selector: 'div.hero-image',
      device_type: 'desktop',
      sequence_id: 4,
    },
  ];

  const resp = await fetch(`${WORKER_URL}/api/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  });
  const body = await resp.json();
  assert('Batch returns 200', resp.status === 200);
  assert('Received count is 4', body.received === 4);
}

async function testNotFound() {
  console.log('\n── 404 Routes ──');
  const r1 = await fetch(`${WORKER_URL}/api/other`);
  assert('Unknown path returns 404', r1.status === 404);

  const r2 = await fetch(`${WORKER_URL}/api/track`);
  assert('GET /api/track returns 404', r2.status === 404);
}

// ── Run all tests ───────────────────────────────────────────────────

async function main() {
  console.log(`\n🧪 Testing Worker at ${WORKER_URL}\n`);

  try {
    await testHealthCheck();
    await testCORSPreflight();
    await testInvalidPayload();
    await testSingleEvent();
    await testBatchEvents();
    await testNotFound();
  } catch (err) {
    console.error('\n💥 Test error:', err.message);
    if (err.cause?.code === 'ECONNREFUSED') {
      console.error('   → Worker not running. Start with: npx wrangler dev');
    }
    process.exit(1);
  }

  console.log('\n── Summary ──');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`  ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\n  Failed:');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`    ❌ ${r.name}`));
    process.exit(1);
  }

  console.log('\n✅ All tests passed!\n');
}

main();
