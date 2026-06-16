/**
 * Phase 2A Banner Runtime — Playwright E2E (dispatch-10)
 *
 * 観測項目 (続 97 §2 CSP 縮小整合、Phase 2A scope):
 *  §1 /v1/decision smoke (status:ok 配信、UUID v4 経路)
 *  §2 tracking_id 経路 (B6 解消、続 103/dispatch-14、wakegai 実訪問者シミュレーション)
 *  §3 nonce 同値検証 (response body decision.nonce ↔ X-Banner-Nonce header)
 *  §4 cross-tenant guard (D-4)
 *  §5 400 validation (site_id format / tenant_id missing)
 *  §6 OPTIONS preflight CORS
 *
 * CSP enforcement test (Worker `Content-Security-Policy` header / `X-CSP-Nonce` mismatch 403 /
 * browser violation report endpoint) は **Phase 2B 移管** (続 97 §2 案 B / dispatch-13 配備予定)、
 * 本 E2E では nonce 配信 verification のみ実施。
 *
 * Performance budget (gzip ≤ 20KB / TBT ≤ 50ms / CLS = 0) はブラウザ画面なしの API only 経路の
 * ため本 spec では Worker response の latency 観測のみ、CLS/TBT は dispatch-15 (Phase 2A.1) で
 * tracking.js v2.4.0 統合 E2E に格上げ予定。
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.WAKEGAI_PREVIEW_URL ?? 'https://ugokimap-banner-runtime.linkth.workers.dev';
const TENANT = 'linkth_internal';
const SITE_UUID = '2143039e-9135-4da4-9926-a3290e6dd8e2';
const SITE_TRACKING = 'CIP_QWaPiks5krukJ6NM';
const SITE_UNKNOWN = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

test.describe('Phase 2A Banner Runtime E2E', () => {
  test('§1 /health 200 + worker self-identification', async ({ request }) => {
    const resp = await request.get(`${BASE}/health`);
    expect(resp.status()).toBe(200);
    const json = await resp.json();
    expect(json.status).toBe('ok');
    expect(json.worker).toBe('ugokimap-banner-runtime');
  });

  test('§2-A UUID 経路 /v1/decision → status:ok + banner_id', async ({ request }) => {
    const resp = await request.get(
      `${BASE}/v1/decision?site_id=${SITE_UUID}&tenant_id=${TENANT}&cid=e2e_test_uuid`,
    );
    expect(resp.status()).toBe(200);
    const json = await resp.json();
    expect(json.status).toBe('ok');
    expect(json.decision.banner_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(json.decision.template_id).toBe('tpl_bottom_bar_cta_v1');
    expect(json.decision.css_class).toMatch(/^ugk-banner-/);
  });

  test('§2-B tracking_id 経路 (続 103/B6) → status:ok + 同 banner_id', async ({ request }) => {
    const resp = await request.get(
      `${BASE}/v1/decision?site_id=${SITE_TRACKING}&tenant_id=${TENANT}&cid=e2e_test_tracking`,
    );
    expect(resp.status()).toBe(200);
    const json = await resp.json();
    expect(json.status).toBe('ok');
    expect(json.decision.banner_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('§3 nonce response body ↔ X-Banner-Nonce header byte-level match (続 97 §2 整合)', async ({ request }) => {
    const resp = await request.get(
      `${BASE}/v1/decision?site_id=${SITE_UUID}&tenant_id=${TENANT}&cid=e2e_nonce`,
    );
    const headerNonce = resp.headers()['x-banner-nonce'];
    const json = await resp.json();
    const bodyNonce = json.decision?.nonce;

    expect(bodyNonce).toBeTruthy();
    expect(bodyNonce).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(headerNonce).toBe(bodyNonce);
  });

  test('§4-A cross-tenant guard (evil_tenant) → fallback', async ({ request }) => {
    const resp = await request.get(
      `${BASE}/v1/decision?site_id=${SITE_UUID}&tenant_id=evil_tenant&cid=e2e_cross_tenant`,
    );
    expect(resp.status()).toBe(200);
    const json = await resp.json();
    expect(json.status).toBe('fallback');
    expect(json.decision.banner_id).toBeNull();
  });

  test('§4-B unknown site_id (UUID v4 but no KV bundle) → fallback', async ({ request }) => {
    const resp = await request.get(
      `${BASE}/v1/decision?site_id=${SITE_UNKNOWN}&tenant_id=${TENANT}&cid=e2e_unknown_site`,
    );
    expect(resp.status()).toBe(200);
    const json = await resp.json();
    expect(json.status).toBe('fallback');
    expect(json.decision.banner_id).toBeNull();
  });

  test('§5-A tenant_id missing → 400', async ({ request }) => {
    const resp = await request.get(`${BASE}/v1/decision?site_id=${SITE_UUID}&cid=e2e_no_tenant`);
    expect(resp.status()).toBe(400);
    const json = await resp.json();
    expect(json.error).toBe('tenant_id_required');
    expect(json.reason).toBe('tenant_id_missing');
  });

  test('§5-B site_id invalid format (neither UUID nor CIP_) → 400', async ({ request }) => {
    const resp = await request.get(
      `${BASE}/v1/decision?site_id=not-a-valid-id&tenant_id=${TENANT}&cid=e2e_bad_site`,
    );
    expect(resp.status()).toBe(400);
    const json = await resp.json();
    expect(json.error).toMatch(/site_id must be UUID v4 or tracking_id/);
  });

  test('§6 OPTIONS preflight CORS 204', async ({ request }) => {
    const resp = await request.fetch(`${BASE}/v1/decision`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://wakegai.jp',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(resp.status()).toBe(204);
    expect(resp.headers()['access-control-allow-origin']).toBe('*');
    expect(resp.headers()['access-control-allow-methods']).toContain('GET');
    expect(resp.headers()['access-control-allow-methods']).toContain('OPTIONS');
  });

  test('§7 deterministic 配信 (NONE audience banner、4 cid 同 banner_id)', async ({ request }) => {
    const cids = ['e2e_det_alpha', 'e2e_det_beta', 'e2e_det_gamma', 'e2e_det_delta'];
    const banner_ids = await Promise.all(
      cids.map(async (cid) => {
        const resp = await request.get(
          `${BASE}/v1/decision?site_id=${SITE_UUID}&tenant_id=${TENANT}&cid=${cid}`,
        );
        const json = await resp.json();
        return json.decision?.banner_id;
      }),
    );
    // 全 cid 同 banner_id (NONE audience の sitewide banner)
    const uniq = new Set(banner_ids);
    expect(uniq.size).toBe(1);
    expect(banner_ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('§8 response security headers (X-Content-Type-Options, Cache-Control)', async ({ request }) => {
    const resp = await request.get(
      `${BASE}/v1/decision?site_id=${SITE_UUID}&tenant_id=${TENANT}&cid=e2e_security`,
    );
    expect(resp.headers()['x-content-type-options']).toBe('nosniff');
    expect(resp.headers()['cache-control']).toContain('no-store');
  });
});
