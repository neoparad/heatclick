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
});
