/**
 * Unit tests for middleware fireAuditAsync resp.ok 検証 (Reviewer R7-3 + Director 続 34 §5.4)
 *
 * 起点: Reviewer 続 33 R7-3「middleware fireAuditAsync resp.ok 未検証で silent」
 * 修正: Infra 続 35 Step 5 で middleware.ts L156-213 に resp.ok check + structured console.error
 *       fire-and-forget 契約維持のため .then chain 内で完結 (await しない)
 *
 * Strategy: fireAuditAsync の fetch .then/.catch chain を本 test 内に等価実装し、
 *           middleware.ts と機能 contract を 1:1 で再現することで間接検証する。
 *           完全 E2E は Playwright (tests/e2e/middleware-audit.spec.ts) で実施 (Sprint 5 想定)。
 *
 * Usage:
 *   cd ugokimap-saas
 *   node --test tests/unit/middleware-audit-resp-ok.test.mjs
 *
 * Node 20+ 必須
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── 等価実装 (middleware.ts L202-231 と同一 contract) ──

/**
 * 等価実装: middleware.ts fireAuditAsync の fetch .then/.catch chain
 *
 * 差分:
 *   - row 構築 / parseClickHouseEnv / event 構築は省略 (本 test では fetch 後段 chain のみ verify)
 *   - logger は引数注入 (console spy 代替)
 *   - fire-and-forget 契約検証のため Promise 返却 = caller が await 可能 (test 内のみ)
 *     production middleware は本 promise を await しないため latency 影響なし
 */
function fireAuditAsyncCore({ insertUrl, authHeader, body, action, resource, logger }) {
  return fetch(insertUrl, {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
  })
    .then(async (resp) => {
      if (!resp.ok) {
        const respText = await resp.text().catch(() => '');
        const truncated = respText.slice(0, 256);
        logger.error(
          `[middleware audit] INSERT non-ok: ${action} ${resource} ` +
            `status=${resp.status} statusText=${resp.statusText} body_head="${truncated}"`,
        );
      }
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : 'unknown';
      logger.error(
        `[middleware audit] INSERT network error: ${action} ${resource} (${msg})`,
      );
    });
}

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

const FAKE_URL =
  'http://localhost:8123/?database=clickinsight&query=INSERT%20INTO%20audit_events%20FORMAT%20JSONEachRow';
const FAKE_AUTH = 'Basic ZGVmYXVsdDpSVm5tcE5ZSW9PWWlVeFZVUDRRSnJTM1Mw';
const FAKE_BODY = JSON.stringify({ tenant_id: '__unknown__', action: 'request.api-public' }) + '\n';

// ── tests ──

test('resp.ok=true → logger.error 呼ばない', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => fakeResponse({ ok: true });
  try {
    const logger = spyLogger();
    await fireAuditAsyncCore({
      insertUrl: FAKE_URL,
      authHeader: FAKE_AUTH,
      body: FAKE_BODY,
      action: 'request.api-public',
      resource: '/api/track',
      logger,
    });
    assert.equal(logger.errors.length, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('resp.ok=false (HTTP 401) → "INSERT non-ok" + action / resource / status / body_head', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    fakeResponse({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      body: 'Code: 516. DB::Exception: default: Authentication failed.',
    });
  try {
    const logger = spyLogger();
    await fireAuditAsyncCore({
      insertUrl: FAKE_URL,
      authHeader: FAKE_AUTH,
      body: FAKE_BODY,
      action: 'auth.api.invalid_token',
      resource: '/api/sites/list',
      logger,
    });
    assert.equal(logger.errors.length, 1);
    const msg = logger.errors[0];
    assert.match(msg, /\[middleware audit\] INSERT non-ok:/);
    assert.match(msg, /auth\.api\.invalid_token/);
    assert.match(msg, /\/api\/sites\/list/);
    assert.match(msg, /status=401/);
    assert.match(msg, /body_head="Code: 516/);
    assert.doesNotMatch(msg, /Basic Z/, 'log に Authorization header 含まない');
    assert.doesNotMatch(msg, /password|RVnmpNYIoOYi/, 'log に credentials 含まない');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('resp.ok=false で長 body → 256 文字 truncate + action / resource 維持', async () => {
  const origFetch = globalThis.fetch;
  const longBody = 'A'.repeat(2048);
  globalThis.fetch = async () =>
    fakeResponse({ ok: false, status: 500, statusText: 'ISE', body: longBody });
  try {
    const logger = spyLogger();
    await fireAuditAsyncCore({
      insertUrl: FAKE_URL,
      authHeader: FAKE_AUTH,
      body: FAKE_BODY,
      action: 'api.get',
      resource: '/api/heatmap',
      logger,
    });
    const msg = logger.errors[0];
    const bodyHeadMatch = msg.match(/body_head="(.*)"/);
    assert.ok(bodyHeadMatch);
    assert.equal(bodyHeadMatch[1].length, 256);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('network error → "INSERT network error" + action / resource / err message', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNRESET');
  };
  try {
    const logger = spyLogger();
    await fireAuditAsyncCore({
      insertUrl: FAKE_URL,
      authHeader: FAKE_AUTH,
      body: FAKE_BODY,
      action: 'auth.api.cross_tenant_attempted',
      resource: '/api/sites/forbidden',
      logger,
    });
    assert.equal(logger.errors.length, 1);
    const msg = logger.errors[0];
    assert.match(msg, /\[middleware audit\] INSERT network error:/);
    assert.match(msg, /auth\.api\.cross_tenant_attempted/);
    assert.match(msg, /\/api\/sites\/forbidden/);
    assert.match(msg, /\(ECONNRESET\)/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('fire-and-forget 契約: fetch await なしでも resp.ok 検証は実行', async () => {
  // production caller (middleware.ts) は本 fireAuditAsync 戻り値 = void、await しない
  // 本 test は .then chain が独立で実行されることを verify (await=microtask 待ち)
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return fakeResponse({ ok: false, status: 500, statusText: 'ISE', body: 'err' });
  };
  try {
    const logger = spyLogger();
    // caller は戻り値 await しないが、test 内で microtask 待ち
    const promise = fireAuditAsyncCore({
      insertUrl: FAKE_URL,
      authHeader: FAKE_AUTH,
      body: FAKE_BODY,
      action: 'api.post',
      resource: '/api/x',
      logger,
    });
    // promise が即時 return されることを確認 (caller 経路 = void)
    assert.ok(promise instanceof Promise);
    // microtask 順序待ち (await で chain 完了確認)
    await promise;
    assert.equal(fetchCalls, 1);
    assert.equal(logger.errors.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});
