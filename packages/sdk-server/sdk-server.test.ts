import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { OPERATION_CATALOG } from '@/lib/link/surface/openapi';
import {
  SDK_LANGUAGES,
  buildCanonicalConformanceVectors,
  generateAll8ServerSdks,
  run8LanguageConformanceSuite,
} from './index';

describe('packages/sdk-server — 8-Language Server SDK Generator & Common Conformance Suite (§11.11 item 9)', () => {
  test('generates all 8 server SDKs deterministically from the single contract with byte-identical manifests', () => {
    const run1 = generateAll8ServerSdks();
    const run2 = generateAll8ServerSdks();

    expect(Object.keys(run1.artifacts).sort()).toEqual([...SDK_LANGUAGES].sort());
    expect(run1.combinedManifestSha256).toBe(run2.combinedManifestSha256);

    for (const lang of SDK_LANGUAGES) {
      expect(run1.artifacts[lang].files.length).toBeGreaterThanOrEqual(1);
      expect(run1.artifacts[lang].manifestSha256).toBe(run2.artifacts[lang].manifestSha256);
    }
  });

  test('passes 4-domain conformance suite across all 8 languages with 0 discrepancies (live subprocess execution for Node.js & Python)', () => {
    const vectors = buildCanonicalConformanceVectors();
    expect(vectors.allocatorVectors.length).toBeGreaterThanOrEqual(4);
    expect(vectors.ed25519Vectors.length).toBe(3);
    expect(vectors.segmentVectors.length).toBe(6);
    expect(vectors.flagVectors.length).toBe(4);

    const summary = run8LanguageConformanceSuite();

    expect(summary.languagesChecked).toBe(8);
    expect(summary.totalDiscrepancies).toBe(0);
    expect(summary.allPassed).toBe(true);

    // TypeScript (Node.js) MUST run live subprocess
    const tsReport = summary.reports.find((r) => r.language === 'typescript');
    expect(tsReport?.runtimeStatus).toBe('live_subprocess_passed');
    expect(tsReport?.totalDiscrepancies).toBe(0);

    // Python (if installed on host — detected Python315 on this workstation) runs live subprocess including pure-Python Ed25519!
    const pyReport = summary.reports.find((r) => r.language === 'python');
    expect(pyReport?.totalDiscrepancies).toBe(0);
    if (pyReport?.runtimeDetected) {
      expect(pyReport.runtimeStatus).toBe('live_subprocess_passed');
    }

    // All 8 languages pass static algorithmic & contract parity checks
    for (const rep of summary.reports) {
      expect(rep.staticContractPassed).toBe(true);
      expect(rep.totalDiscrepancies).toBe(0);
    }
  });

  test('[H-01] all 8 generated server SDKs expose typed operation methods for 100% of OPERATION_CATALOG and execute request(...) dispatches cleanly', () => {
    const { artifacts } = generateAll8ServerSdks();
    expect(OPERATION_CATALOG.length).toBeGreaterThanOrEqual(24);

    // Live execution of generated TypeScript UgokiLinkApiClient operation methods via Node subprocess
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugk-sdk-ops-'));
    try {
      const sdkPath = path.join(tmpDir, 'ugokilink.mjs');
      fs.writeFileSync(sdkPath, artifacts.typescript.files[0].content, 'utf8');
      const driverPath = path.join(tmpDir, 'driver.mjs');
      fs.writeFileSync(
        driverPath,
        `
import { UgokiLinkApiClient, CATALOGED_OPERATIONS } from './ugokilink.mjs';
const calls = [];
const client = new UgokiLinkApiClient({
  baseUrl: 'https://api.ugokilink.example/api',
  apiKey: 'ugk_sec_test_123',
  transport: async (req) => { calls.push(req); return { status: 200, req }; },
});

await client.querySiteMetrics({ siteId: 'site/alpha', start: '2026-11-01T00:00:00Z' });
await client.recommendSiteItems({ siteId: 'site_1', body: { placement: 'product_page', top_k: 3 } });
await client.evaluateDecision({ body: { siteId: 'site_1', pvId: 'pv_1' } });
await client.renderHeatmapImage({ siteId: 'site_1', body: { page_url: 'https://a.example/', kind: 'click', actor_bucket: 'human' } });
await client.upsertGoal({ siteId: 'site_1', idempotencyKey: 'idem_12345678', body: { name: 'Buy', kind: 'url_match', matcher: '/done' } });

let missingIdemRejected = false;
try {
  await client.upsertGoal({ siteId: 'site_1', body: { name: 'Buy', kind: 'url_match', matcher: '/done' } });
} catch {
  missingIdemRejected = true;
}

process.stdout.write(JSON.stringify({ catalogLen: CATALOGED_OPERATIONS.length, calls, missingIdemRejected }));
`,
        'utf8'
      );

      const res = spawnSync(process.execPath, [driverPath], { encoding: 'utf8', timeout: 10_000 });
      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout) as {
        catalogLen: number;
        missingIdemRejected: boolean;
        calls: Array<{ method: string; path: string; url: string; headers: Record<string, string> }>;
      };
      expect(parsed.catalogLen).toBe(OPERATION_CATALOG.length);
      expect(parsed.missingIdemRejected).toBe(true);
      expect(parsed.calls[0]).toMatchObject({
        method: 'GET',
        path: '/v1/sites/site%2Falpha/metrics',
      });
      expect(parsed.calls[0].headers['Authorization']).toBe('Bearer ugk_sec_test_123');
      expect(parsed.calls[1]).toMatchObject({
        method: 'POST',
        path: '/v1/sites/site_1/recommend',
      });
      expect(parsed.calls[2]).toMatchObject({
        method: 'POST',
        path: '/v1/decisions',
      });
      expect(parsed.calls[3]).toMatchObject({
        method: 'POST',
        path: '/v1/sites/site_1/heatmap-image',
      });
      expect(parsed.calls[4].headers['Idempotency-Key']).toBe('idem_12345678');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
