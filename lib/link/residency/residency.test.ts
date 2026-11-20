/**
 * UGOKI LINK v2 — Bundle 7-D Test Suite (`lib/link/residency`)
 *
 * Covers:
 * 1. Full data residency path catalog & auditor (§11.11 #13 / D-29):
 *    all 11 LINK-managed storage roles (incl. GPU temp files/logs separate from processing),
 *    location-hint rejection, unknown-region fail-closed, overseas edge relay zero-persistence,
 *    external processing & customer export grants, and ResponseEnvelope ResidencyBlock generation
 * 2. OSS boundary leak audit & D-28 release gating (§11.11 #12):
 *    blocks proprietary paths, proprietary imports, secret keys, unfixed weakness refs,
 *    keeps OSS release `not_entitled` until D-28 + legal sign-off
 */

import {
  auditOssExportBoundary,
  auditTenantResidencyPaths,
  buildCompliantBaselineResidencyCatalog,
  evaluateOssReleaseReadiness,
  LINK_MANAGED_STORAGE_ROLES,
  SELF_HOSTED_CAPABILITY_MATRIX,
  type DataPathCatalogEntry,
} from './index';

describe('lib/link/residency/residency-auditor (§11.11 #13 / D-29)', () => {
  test('passes when all 11 LINK storage roles are contractually pinned to JP and overseas relay verifies zero persistence', () => {
    expect(LINK_MANAGED_STORAGE_ROLES).toContain('gpu_temp_files_and_logs');
    expect(LINK_MANAGED_STORAGE_ROLES).toContain('heatmap_render_queue');

    const paths: DataPathCatalogEntry[] = [
      ...buildCompliantBaselineResidencyCatalog('jp'),
      {
        pathId: 'gpu_inference_jp',
        pathClass: 'external_processing',
        providerName: 'jp_gpu_provider',
        observedRegion: 'jp',
        verifiedViaProviderApi: true,
        contractualGuarantee: 'contractual_region_pin',
        approvedProcessingRegions: ['jp'],
        purpose: 'section_semantic_inference',
        approvedPurposes: ['section_semantic_inference'],
        retentionDeletionContractVerified: true,
      },
      {
        pathId: 'customer_bq_export_us',
        pathClass: 'customer_export',
        providerName: 'google_bigquery',
        observedRegion: 'us',
        verifiedViaProviderApi: true,
        contractualGuarantee: 'contractual_region_pin',
        customerExportGrantId: 'grant-cust-us-001',
        grantedExportRegion: 'us',
        retentionDeletionContractVerified: true,
      },
    ];

    const report = auditTenantResidencyPaths({
      tenantId: 'ten-jp-1',
      tenantContractRegion: 'jp',
      paths,
    });

    expect(report.passed).toBe(true);
    expect(report.releaseBlocked).toBe(false);
    expect(report.violations).toHaveLength(0);
    expect(report.envelopeResidency.storage_region).toBe('jp');
    expect(report.envelopeResidency.processing_regions).toContain('global_edge');
    expect(report.envelopeResidency.processing_regions).toContain('jp');
  });

  test('fails closed on location_hint_only, unknown region, region mismatch, or unverified overseas relay persistence', () => {
    const baseline = buildCompliantBaselineResidencyCatalog('jp');

    // 1. Replace r2_wal with `location_hint_only` -> MUST FAIL!
    const hintOnlyPaths = baseline.map((p) =>
      p.storageRole === 'r2_wal'
        ? { ...p, contractualGuarantee: 'location_hint_only' as const }
        : p
    );
    const hintRes = auditTenantResidencyPaths({
      tenantId: 'ten-jp-1',
      tenantContractRegion: 'jp',
      paths: hintOnlyPaths,
    });
    expect(hintRes.passed).toBe(false);
    expect(hintRes.releaseBlocked).toBe(true);
    expect(hintRes.violations.some((v) => v.code === 'LOCATION_HINT_NOT_CONTRACTUAL')).toBe(true);

    // 2. Replace backups with `unknown` -> MUST FAIL!
    const unknownPaths = baseline.map((p) =>
      p.storageRole === 'backups' ? { ...p, observedRegion: 'unknown' as const } : p
    );
    const unkRes = auditTenantResidencyPaths({
      tenantId: 'ten-jp-1',
      tenantContractRegion: 'jp',
      paths: unknownPaths,
    });
    expect(unkRes.passed).toBe(false);
    expect(unkRes.violations.some((v) => v.code === 'UNKNOWN_LOCATION')).toBe(true);

    // 3. Overseas edge relay writing to storage (`zeroPersistenceVerified: false`) -> MUST FAIL!
    const badRelayPaths = baseline.map((p) =>
      p.pathClass === 'edge_relay' ? { ...p, zeroPersistenceVerified: false } : p
    );
    const relayRes = auditTenantResidencyPaths({
      tenantId: 'ten-jp-1',
      tenantContractRegion: 'jp',
      paths: badRelayPaths,
    });
    expect(relayRes.passed).toBe(false);
    expect(relayRes.violations.some((v) => v.code === 'RELAY_PERSISTENCE_UNVERIFIED')).toBe(true);

    // 4. Missing required storage role (`gpu_temp_files_and_logs`) -> MUST FAIL!
    const missingGpuLog = baseline.filter(
      (p) => p.storageRole !== 'gpu_temp_files_and_logs'
    );
    const missingRes = auditTenantResidencyPaths({
      tenantId: 'ten-jp-1',
      tenantContractRegion: 'jp',
      paths: missingGpuLog,
    });
    expect(missingRes.passed).toBe(false);
    expect(missingRes.missingRequiredStorageRoles).toEqual(['gpu_temp_files_and_logs']);
  });
});

describe('lib/link/residency/oss-prep (§11.11 #12 / D-28)', () => {
  test('catches proprietary imports, secret keys, proprietary files, and unfixed weakness refs, and blocks OSS publish until D-28 + legal sign-off', () => {
    const cleanFiles = [
      {
        relativePath: 'packages/contract/urlkey/urlkey.ts',
        content: 'export function computeUrlKeyV2(u: string) { return u; }',
      },
      {
        relativePath: 'lib/link/replay/masker.ts',
        content: 'export function maskDomNode() { return "***"; }',
      },
    ];

    // Clean audit, but D-28 is pending in ledger -> not_entitled!
    const pendingRes = evaluateOssReleaseReadiness({
      candidateFiles: cleanFiles,
      licenseId: 'Apache-2.0',
      allKnownWeaknessesFixed: true,
    });
    expect(pendingRes.boundaryAudit.passed).toBe(true);
    expect(pendingRes.releaseEntitled).toBe(false);
    expect(pendingRes.status).toBe('not_entitled');
    expect(pendingRes.licenseHeaderTemplate).toContain('SPDX-License-Identifier: Apache-2.0');

    // Self-hosted matrix explicitly lists bot rules & pooling as unsupported
    expect(
      SELF_HOSTED_CAPABILITY_MATRIX.find(
        (c) => c.capability === 'proprietary_bot_and_stealth_agent_detection_rules'
      )?.supportedInSelfHosted
    ).toBe(false);

    // With D-28 + legal approved AND all weaknesses fixed -> READY
    const unlockedRes = evaluateOssReleaseReadiness({
      candidateFiles: cleanFiles,
      licenseId: 'FSL-1.1-Apache-2.0',
      allKnownWeaknessesFixed: true,
      decision28ApprovedOverride: true,
      legalSignOffOverride: true,
    });
    expect(unlockedRes.releaseEntitled).toBe(true);
    expect(unlockedRes.status).toBe('ok');

    // Dirty OSS candidate containing proprietary import + private key + proprietary file + weakness doc ref -> BLOCKED
    const leakyAudit = auditOssExportBoundary([
      {
        relativePath: 'workers/link-collector/handler.ts',
        content: `
          import { classifyBot } from '../../lib/link/actors/bot-rules/stealth';
          const leak = '-----BEGIN PRIVATE KEY-----\\nMII...';
          // see facts/repo-saas-collection.md
        `,
      },
      {
        relativePath: 'lib/link/ml/models/champion.bin',
        content: 'binary-weights',
      },
    ]);
    expect(leakyAudit.passed).toBe(false);
    const codes = leakyAudit.findings.map((f) => f.code);
    expect(codes).toContain('PROPRIETARY_IMPORT_LEAK');
    expect(codes).toContain('SECRET_OR_KEY_LITERAL_LEAK');
    expect(codes).toContain('UNFIXED_WEAKNESS_DOC_REF');
    expect(codes).toContain('PROPRIETARY_PATH_IN_OSS_BUNDLE');
  });
});
