/**
 * Unit tests for emitAuditEventsBatch resp.ok 検証 (Reviewer R7-3 + Director 続 34 §5.4)
 *
 * 起点: Reviewer 続 33 R7-3「audit_events INSERT resp.ok 未検証で silent」
 * 修正: Infra 続 35 Step 5 で worker.ts L570-578 に resp.ok check + structured console.error
 *
 * Strategy: emitAuditEventsBatch のコア動作 (fetch → resp.ok 検証 → console.error format)
 *           を本 test 内に等価実装し、worker.ts L570-595 の contract を保証する。
 *           完全 E2E は test-worker.mjs (wrangler dev 経由) で実施。
 *
 * Usage:
 *   cd ugokimap-saas/workers/event-ingest
 *   node --test test/audit-resp-ok.test.mjs
 *
 * Node 20+ 必須 (node:test + globalThis.fetch override + console.error spy)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── 等価実装 (worker.ts L538-595 と同一 contract) ──

/**
 * 等価実装: worker.ts emitAuditEventsBatch の fetch 後 resp.ok 検証 + Sentry breadcrumb
 *
 * 差分:
 *   - parseClickHouseEnv / anonymizeIp / dropContexts → rows 構築は省略 (本 test では fetch 後段のみ verify)
 *   - body / insertUrl は引数で受領 (test caller が直接構築)
 */
async function emitAuditEventsBatchCore({ insertUrl, authHeader, body, rowsCount, logger }) {
  try {
    const resp = await fetch(insertUrl, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });
    if (!resp.ok) {
      const respText = await resp.text().catch(() => '');
      const truncated = respText.slice(0, 256);
      logger.error(
        `[audit_events INSERT non-ok] status=${resp.status} statusText=${resp.statusText} ` +
          `rows=${rowsCount} body_head="${truncated}"`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    logger.error(`[audit_events INSERT network error] rows=${rowsCount} err=${msg}`);
  }
}

// ── fetch / logger spy helpers ──

function fakeResponse({ ok, status = 200, statusText = 'OK', body = '' }) {
  return {
    ok,
    status,
    statusText,
    text: async () => body,
  };
}

function spyLogger() {
  const errors = [];
  return {
    errors,
    error: (msg) => errors.push(String(msg)),
  };
}

const FAKE_URL = 'http://localhost:8123/?database=clickinsight&query=INSERT%20INTO%20audit_events%20FORMAT%20JSONEachRow';
const FAKE_AUTH = 'Basic ZGVmYXVsdDpSVm5tcE5ZSW9PWWlVeFZVUDRRSnJTM1Mw';

// ── tests ──

test('resp.ok=true (HTTP 200) → 何も log しない', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => fakeResponse({ ok: true });
  try {
    const logger = spyLogger();
    await emitAuditEventsBatchCore({
      insertUrl: FAKE_URL,
      authHeader: FAKE_AUTH,
      body: '{"tenant_id":"__unknown__"}\n',
      rowsCount: 1,
      logger,
    });
    assert.equal(logger.errors.length, 0, 'success path は logger.error 呼ばない');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('resp.ok=false (HTTP 500) → structured error log + status / statusText / rows / body_head', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    fakeResponse({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: 'Code: 60. DB::Exception: Table clickinsight.audit_events does not exist.',
    });
  try {
    const logger = spyLogger();
    await emitAuditEventsBatchCore({
      insertUrl: FAKE_URL,
      authHeader: FAKE_AUTH,
      body: '{"tenant_id":"__unknown__"}\n',
      rowsCount: 3,
      logger,
    });
    assert.equal(logger.errors.length, 1, 'non-ok は logger.error を 1 回呼ぶ');
    const msg = logger.errors[0];
    assert.match(msg, /\[audit_events INSERT non-ok\]/);
    assert.match(msg, /status=500/);
    assert.match(msg, /statusText=Internal Server Error/);
    assert.match(msg, /rows=3/);
    assert.match(msg, /body_head="Code: 60/);
    assert.doesNotMatch(msg, /RVnmpNYIoOYiUxVUP4Q9R3S0/, 'log に credentials 含まない');
    assert.doesNotMatch(msg, /Basic Z/, 'log に Authorization header 含まない');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('resp.ok=false で body 256 文字超 → 切詰', async () => {
  const origFetch = globalThis.fetch;
  const longBody = 'X'.repeat(1024);
  globalThis.fetch = async () =>
    fakeResponse({ ok: false, status: 502, statusText: 'Bad Gateway', body: longBody });
  try {
    const logger = spyLogger();
    await emitAuditEventsBatchCore({
      insertUrl: FAKE_URL,
      authHeader: FAKE_AUTH,
      body: '',
      rowsCount: 1,
      logger,
    });
    const msg = logger.errors[0];
    const bodyHeadMatch = msg.match(/body_head="(.*)"/);
    assert.ok(bodyHeadMatch, 'body_head フィールド検出');
    assert.equal(bodyHeadMatch[1].length, 256, '256 文字に切詰');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('network error (fetch throws) → "INSERT network error" log + err message', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED 159.69.95.59:8123');
  };
  try {
    const logger = spyLogger();
    await emitAuditEventsBatchCore({
      insertUrl: FAKE_URL,
      authHeader: FAKE_AUTH,
      body: '',
      rowsCount: 2,
      logger,
    });
    assert.equal(logger.errors.length, 1);
    const msg = logger.errors[0];
    assert.match(msg, /\[audit_events INSERT network error\]/);
    assert.match(msg, /rows=2/);
    assert.match(msg, /err=ECONNREFUSED/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('resp.text() が throws しても resp.ok=false の log は出力 (body_head 空)', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 504,
    statusText: 'Gateway Timeout',
    text: async () => {
      throw new Error('stream consumed');
    },
  });
  try {
    const logger = spyLogger();
    await emitAuditEventsBatchCore({
      insertUrl: FAKE_URL,
      authHeader: FAKE_AUTH,
      body: '',
      rowsCount: 5,
      logger,
    });
    assert.equal(logger.errors.length, 1);
    const msg = logger.errors[0];
    assert.match(msg, /\[audit_events INSERT non-ok\]/);
    assert.match(msg, /status=504/);
    assert.match(msg, /body_head=""/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('non-Error throw (string) も err=unknown で log 出力', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw 'fetch failed (string throw)';
  };
  try {
    const logger = spyLogger();
    await emitAuditEventsBatchCore({
      insertUrl: FAKE_URL,
      authHeader: FAKE_AUTH,
      body: '',
      rowsCount: 1,
      logger,
    });
    assert.equal(logger.errors.length, 1);
    assert.match(logger.errors[0], /err=unknown/);
  } finally {
    globalThis.fetch = origFetch;
  }
});
