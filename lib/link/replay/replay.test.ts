import crypto from 'node:crypto';
import { AuditLogStore, type VerifiedPrincipal } from '@/lib/link/auth';
import { isUntrustedValue } from '@/packages/contract/response';
import {
  DEFAULT_MASK_ALL_CONFIG,
  REPLAY_LANE_ISOLATION,
  ReplayObjectStore,
  authorizeReplayView,
  buildIsolatedReplayFrame,
  buildMcpReplaySummary,
  createCrawlReferenceTextOverlay,
  decideReplayEncoding,
  evaluateReplayEntitlement,
  maskReplayDomTree,
  runReplayZeroLeakCanaryGate,
  shouldLazyLoadReplayRecorder,
  verifySandboxFrameSafety,
  type ReplaySitePolicy,
} from './index';

const BASE_SITE: ReplaySitePolicy = {
  tenantId: 'tenant_a',
  siteId: 'site_a1',
  siteOptInEnabled: true,
  sensitiveIndustry: false,
  directedAtMinors: false,
  sampleRate: 1.0,
  retentionDays: 30,
  d26MemberReplayApproved: false,
};

const APPROVED_D26 = { approved: true, legalSignedOff: true };

describe('lib/link/replay — Tier-3 Session Replay Entitlement, Masking, Baseline Diff, Object Store, Sandbox & Zero-Leak Canary Gate', () => {
  test('defaults to not_entitled until D-26 + legal sign-off, enforces lane isolation, blocks off/cookieless/stats_exempt, and auto-stops sensitive/minors/password/payment/member PVs', () => {
    expect(REPLAY_LANE_ISOLATION.lane).toBe('session_replay');
    expect(REPLAY_LANE_ISOLATION.countsTowardBillablePvs).toBe(false);
    expect(REPLAY_LANE_ISOLATION.allowInCrossTenantPool).toBe(false);
    expect(REPLAY_LANE_ISOLATION.allowInMlTraining).toBe(false);
    expect(REPLAY_LANE_ISOLATION.usesClickHouseMemory).toBe(false);

    // Real ledger D-26 is pending -> MUST fail closed as `not_entitled`!
    const defaultClosed = evaluateReplayEntitlement(BASE_SITE, {
      consentMode: 'full',
      grantedPurposes: ['page_content', 'screen_replay'],
      gpcEnabled: false,
      isMemberLinked: false,
      hasPasswordField: false,
      hasPaymentField: false,
      hasSensitiveMarkedField: false,
    });
    expect(defaultClosed.allowed).toBe(false);
    if (!defaultClosed.allowed) {
      expect(defaultClosed.status).toBe('not_entitled');
      expect(defaultClosed.code).toBe('D26_DECISION_OR_LEGAL_PENDING');
    }

    // With simulated D-26 approval: off / cookieless / stats_exempt are STILL blocked
    for (const badMode of ['off', 'cookieless', 'stats_exempt'] as const) {
      const r = evaluateReplayEntitlement(BASE_SITE, {
        consentMode: badMode,
        grantedPurposes: ['screen_replay'],
        gpcEnabled: false,
        isMemberLinked: false,
        hasPasswordField: false,
        hasPaymentField: false,
        hasSensitiveMarkedField: false,
        d26ApprovedOverrideForTest: APPROVED_D26,
      });
      expect(r.allowed).toBe(false);
      if (!r.allowed) expect(r.code).toBe('CONSENT_MODE_FORBIDS_REPLAY');
    }

    // Hard auto-stops: sensitive industry, minors, password/payment PV, member PV without member_link + D-26 member approval
    expect(
      evaluateReplayEntitlement(
        { ...BASE_SITE, sensitiveIndustry: true },
        {
          consentMode: 'full',
          grantedPurposes: ['screen_replay'],
          gpcEnabled: false,
          isMemberLinked: false,
          hasPasswordField: false,
          hasPaymentField: false,
          hasSensitiveMarkedField: false,
          d26ApprovedOverrideForTest: APPROVED_D26,
        }
      ).allowed
    ).toBe(false);

    expect(
      evaluateReplayEntitlement(
        { ...BASE_SITE, directedAtMinors: true },
        {
          consentMode: 'full',
          grantedPurposes: ['screen_replay'],
          gpcEnabled: false,
          isMemberLinked: false,
          hasPasswordField: false,
          hasPaymentField: false,
          hasSensitiveMarkedField: false,
          d26ApprovedOverrideForTest: APPROVED_D26,
        }
      ).allowed
    ).toBe(false);

    const passwordStop = evaluateReplayEntitlement(BASE_SITE, {
      consentMode: 'full',
      grantedPurposes: ['screen_replay'],
      gpcEnabled: false,
      isMemberLinked: false,
      hasPasswordField: true,
      hasPaymentField: false,
      hasSensitiveMarkedField: false,
      d26ApprovedOverrideForTest: APPROVED_D26,
    });
    expect(passwordStop.allowed).toBe(false);
    if (!passwordStop.allowed) {
      expect(passwordStop.code).toBe('AUTO_STOP_SENSITIVE_PV_DISCARDED');
      expect(passwordStop.discardExistingBuffer).toBe(true);
    }

    const memberExcluded = evaluateReplayEntitlement(BASE_SITE, {
      consentMode: 'full',
      grantedPurposes: ['screen_replay', 'member_link'],
      gpcEnabled: false,
      isMemberLinked: true,
      hasPasswordField: false,
      hasPaymentField: false,
      hasSensitiveMarkedField: false,
      d26ApprovedOverrideForTest: APPROVED_D26,
    });
    expect(memberExcluded.allowed).toBe(false);
    if (!memberExcluded.allowed) expect(memberExcluded.code).toBe('MEMBER_PV_EXCLUDED_BY_DEFAULT');

    // Valid anonymous visit with D-26 + full + session_replay -> allowed
    const ok = evaluateReplayEntitlement(BASE_SITE, {
      consentMode: 'full',
      grantedPurposes: ['page_content', 'screen_replay'],
      gpcEnabled: false,
      isMemberLinked: false,
      hasPasswordField: false,
      hasPaymentField: false,
      hasSensitiveMarkedField: false,
      d26ApprovedOverrideForTest: APPROVED_D26,
    });
    expect(ok.allowed).toBe(true);
  });

  test('CRAWL baseline requires all 5 tuple fields to emit delta; any mismatch switches to full_masked_snapshot; public text overlay marked reference_not_recorded', () => {
    const baseTuple = {
      skelFp: 'skel_123',
      maskedInitialStateHash: 'hash_abc',
      assetVersion: 'assets_v9',
      activeVariantSetHash: 'vars_001',
      maskConfigVersion: 'mask-all-v1',
    };

    const match = decideReplayEncoding(baseTuple, { ...baseTuple, snapshotId: 'snap_1' });
    expect(match.encoding).toBe('delta');
    expect(match.matched).toBe(true);
    expect(match.baselineSnapshotId).toBe('snap_1');

    // Same skelFp but changed maskConfigVersion -> MUST fall back to full_masked_snapshot!
    const mismatch = decideReplayEncoding(
      { ...baseTuple, maskConfigVersion: 'mask-allow-v2' },
      { ...baseTuple, snapshotId: 'snap_1' }
    );
    expect(mismatch.encoding).toBe('full_masked_snapshot');
    expect(mismatch.matched).toBe(false);
    expect(mismatch.mismatchedFields).toEqual(['maskConfigVersion']);

    // Reference public text overlay strictly distinguished from recorded session data & wrapped in UntrustedValue
    const overlay = createCrawlReferenceTextOverlay({
      crawlSnapshotId: 'snap_1',
      sectionFp: 'sec_hero',
      publicText: 'Welcome to our public landing page',
    });
    expect(overlay.overlayKind).toBe('reference_not_recorded');
    expect(overlay.recordedInSession).toBe(false);
    expect(isUntrustedValue(overlay.publicText)).toBe(true);
  });

  test('Object-storage-only store enforces lazy loading, >=50-PV k-anon selection, disposable handles, and 14-day deletion purge', () => {
    const store = new ReplayObjectStore();
    const key = crypto.randomBytes(32);
    const now = new Date('2026-11-20T12:00:00Z');

    // Lazy loader skips when sampleRate = 0
    expect(
      shouldLazyLoadReplayRecorder({
        site: { ...BASE_SITE, sampleRate: 0 },
        visit: {
          consentMode: 'full',
          grantedPurposes: ['screen_replay'],
          gpcEnabled: false,
          isMemberLinked: false,
          hasPasswordField: false,
          hasPaymentField: false,
          hasSensitiveMarkedField: false,
          d26ApprovedOverrideForTest: APPROVED_D26,
        },
        pvId: 'pv_1',
        samplingSalt: 'salt_1',
      }).loadRecorder
    ).toBe(false);

    const masked = maskReplayDomTree(
      {
        nodeId: 'root',
        kind: 'element',
        tagName: 'div',
        rect: { x: 0, y: 0, width: 800, height: 600 },
        textContent: 'Confidential',
      },
      DEFAULT_MASK_ALL_CONFIG
    );

    const meta = store.putReplay({
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      subjectKeyHash: 'subj_hash_001',
      snapshot: masked,
      encoding: 'full_masked_snapshot',
      tenantKey32Bytes: key,
      keyVersion: 'tk_v1',
      now,
    });
    expect(meta.storageBackend).toBe('object_storage_r2');
    expect(meta.usesClickHouseMemory).toBe(false);
    expect(store.countBillableReplaySessions('tenant_a', 'site_a1')).toBe(1);

    // Filter matching < 50 PVs -> suppressed
    const tooSmall = store.selectReplaysForFilter({
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      matchedFilterPvCount: 49,
      now,
    });
    expect(tooSmall.ok).toBe(false);
    if (!tooSmall.ok) expect(tooSmall.code).toBe('FILTER_BELOW_50_PV_FLOOR');

    // Filter matching >= 50 PVs -> returns disposable handle (different per answer!)
    const sel1 = store.selectReplaysForFilter({
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      matchedFilterPvCount: 50,
      now,
    });
    const sel2 = store.selectReplaysForFilter({
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      matchedFilterPvCount: 50,
      now,
    });
    expect(sel1.ok).toBe(true);
    expect(sel2.ok).toBe(true);
    if (!sel1.ok || !sel2.ok) return;
    expect(sel1.handles[0].handle).not.toBe(sel2.handles[0].handle);

    // Fetch works for own tenant, fails 404 for foreign tenant
    expect(
      store.fetchByHandle({
        handle: sel1.handles[0].handle,
        tenantId: 'tenant_a',
        siteId: 'site_a1',
        tenantKey32Bytes: key,
        now,
      }).ok
    ).toBe(true);
    expect(
      store.fetchByHandle({
        handle: sel1.handles[0].handle,
        tenantId: 'tenant_b',
        siteId: 'site_a1',
        tenantKey32Bytes: key,
        now,
      }).ok
    ).toBe(false);

    // 14-day deletion purge physically removes object and invalidates handle
    const purge = store.purgeSubjectReplays('tenant_a', 'subj_hash_001', now);
    expect(purge.purgedReplayIds).toEqual([meta.replayId]);
    expect(purge.residualObjects).toBe(0);
    expect(
      store.fetchByHandle({
        handle: sel1.handles[0].handle,
        tenantId: 'tenant_a',
        siteId: 'site_a1',
        tenantKey32Bytes: key,
        now,
      }).ok
    ).toBe(false);
  });

  test('Isolated sandbox HTML enforces empty sandbox="", strict CSP, replay:view auth (blocking OEM & CRAWL), and MCP summary-only UntrustedValue output', () => {
    const masked = maskReplayDomTree(
      {
        nodeId: 'root',
        kind: 'element',
        tagName: 'div',
        rect: { x: 0, y: 0, width: 1000, height: 800 },
        children: [
          {
            nodeId: 'c1',
            kind: 'canvas',
            tagName: 'canvas',
            rect: { x: 0, y: 0, width: 200, height: 100 },
          },
          {
            nodeId: 's1',
            kind: 'element',
            tagName: 'script',
            rect: { x: 0, y: 0, width: 0, height: 0 },
            textContent: 'alert("xss")',
          },
        ],
      },
      DEFAULT_MASK_ALL_CONFIG
    );

    const frame = buildIsolatedReplayFrame(masked);
    const safety = verifySandboxFrameSafety(frame);
    expect(safety.safe).toBe(true);
    expect(safety.violations).toEqual([]);

    const auditLog = new AuditLogStore();
    const ownHuman: VerifiedPrincipal = {
      credentialKind: 'session_cookie',
      credentialId: 'sess_1',
      tenantId: 'tenant_a',
      orgId: 'org_a',
      allowedSiteIds: null,
      principalKind: 'human',
      principalId: 'user_a',
      role: 'admin',
      effectiveScopes: new Set(['analytics:read']),
      senderConstrained: true,
      passkeyVerified: true,
    };

    // Allowed for own human with `replay:view`
    expect(
      authorizeReplayView({
        principal: ownHuman,
        hasReplayViewPermission: true,
        targetTenantId: 'tenant_a',
        targetSiteId: 'site_a1',
        replayHandle: 'rph_1',
        auditLog,
      }).allowed
    ).toBe(true);

    // Denied 403 for OEM exchanged token even inside child tenant!
    const oemParent: VerifiedPrincipal = {
      ...ownHuman,
      credentialKind: 'oem_exchanged',
      act: { sub: 'oem_op', oemKeyId: 'oem_1', managementTenantId: 'tenant_oem' },
    };
    const oemRes = authorizeReplayView({
      principal: oemParent,
      hasReplayViewPermission: true,
      targetTenantId: 'tenant_a',
      targetSiteId: 'site_a1',
      replayHandle: 'rph_1',
      auditLog,
    });
    expect(oemRes.allowed).toBe(false);
    expect(oemRes.code).toBe('REPLAY_THIRD_PARTY_FORBIDDEN');

    // Denied 403 for CRAWL federation assertion
    const crawlFed: VerifiedPrincipal = { ...ownHuman, credentialKind: 'federation_assertion' };
    expect(
      authorizeReplayView({
        principal: crawlFed,
        hasReplayViewPermission: true,
        targetTenantId: 'tenant_a',
        targetSiteId: 'site_a1',
        replayHandle: 'rph_1',
        auditLog,
      }).code
    ).toBe('REPLAY_THIRD_PARTY_FORBIDDEN');

    // Foreign tenant -> 404
    expect(
      authorizeReplayView({
        principal: ownHuman,
        hasReplayViewPermission: true,
        targetTenantId: 'tenant_b',
        targetSiteId: 'site_b1',
        replayHandle: 'rph_1',
        auditLog,
      }).httpStatus
    ).toBe(404);
    expect(auditLog.verifyChain().valid).toBe(true);

    // MCP summary never includes raw DOM and wraps notes in UntrustedValue
    const mcpSummary = buildMcpReplaySummary('rph_1', masked);
    expect(mcpSummary.containsRawDom).toBe(false);
    expect(isUntrustedValue(mcpSummary.summaryNote)).toBe(true);
    expect(mcpSummary.unreproducibleRegions).toHaveLength(1);
    expect(isUntrustedValue(mcpSummary.unreproducibleRegions[0].disclosureNote)).toBe(true);
  });

  test('Post-decrypt + post-decompress zero-leak canary gate (surf.replay_zero_leak) passes with 0 recoverable canaries in BOTH default and partial-allowlist modes', () => {
    const report = runReplayZeroLeakCanaryGate();
    expect(report.gateId).toBe('surf.replay_zero_leak');
    expect(report.ledgerRegistered).toBe(true);
    expect(report.defaultModeLeakedCanaries).toEqual([]);
    expect(report.allowlistModeLeakedCanaries).toEqual([]);
    expect(report.allowlistedSafeTextPreserved).toBe(true);
    expect(report.totalLeaks).toBe(0);
    expect(report.passed).toBe(true);
  });
});
