import {
  ALL_SCOPES,
  computeActionAndDiffHash,
  type PasskeyApprovalRecord,
  type VerifiedPrincipal,
} from '../auth';
import {
  DEFAULT_JP_EMBEDDING_CANDIDATES,
  DeterministicJapaneseTestEmbedder,
  runJapaneseEmbeddingSelectionBenchmark,
} from '../search/jp-embeddings';
import {
  AgentStopController,
  CrossTenantPoolingLedger,
  ProhibitedPoolingLaneError,
  RowLevelPoolingProhibitedError,
  SingleUsePasskeyApprovalVerifier,
  bindJapaneseEmbeddingArtifact,
  createSealedAutonomyEnvelope,
  evaluateAndSignAgentPublish,
  evaluateEnvelopePublishAllowance,
  evaluateHoldoutClaimValidity,
  evaluateHoldoutCumulativeEffects,
  evaluateTabularFoundationModelEligibility,
  runAgentHijackSuite,
  verifyGeneratedCheckedCopy,
  verifySealedEnvelopeIntegrity,
  type IndependentEntailmentChecker,
  type IsolatedCopyGenerator,
  type SourceSectionRecord,
} from './index';

function makeHumanOwner(overrides: Partial<VerifiedPrincipal> = {}): VerifiedPrincipal {
  return {
    credentialKind: 'session_cookie',
    credentialId: 'sess_owner_1',
    tenantId: 'ten_1',
    orgId: 'org_1',
    allowedSiteIds: null,
    principalKind: 'human',
    principalId: 'usr_owner_1',
    role: 'owner',
    effectiveScopes: new Set(ALL_SCOPES),
    senderConstrained: true,
    passkeyVerified: true,
    passkeyVerifiedAt: '2026-11-20T11:55:00Z',
    ...overrides,
  };
}

function makeAgentPrincipal(id: string, tenantId = 'ten_1'): VerifiedPrincipal {
  return {
    credentialKind: 'oauth_mcp',
    credentialId: `tok_${id}`,
    tenantId,
    orgId: 'org_1',
    allowedSiteIds: ['site_1'],
    principalKind: 'agent',
    principalId: id,
    role: 'member',
    effectiveScopes: new Set(['decisions:read', 'decisions:write', 'decisions:publish']),
    senderConstrained: true,
    passkeyVerified: false,
  };
}

describe('lib/link/autonomy/autonomous-envelope (§10.10, §11.6)', () => {
  test('seals human envelope with contentHash, bans percentage-ramp safety, detects tampering, and auto-stops on stale guardrails', () => {
    const owner = makeHumanOwner();

    // Percentage ramp safety gate MUST be rejected (§11.6)
    const badRamp = createSealedAutonomyEnvelope({
      author: owner,
      spec: {
        tenantId: 'ten_1',
        siteId: 'site_1',
        allowedActions: ['delivery.publish_banner'],
        allowedScopes: ['decisions:publish'],
        allowedPagePatterns: ['/articles/*'],
        allowedFieldProvenance: ['closed_enum', 'copy_library'],
        maxCostUnits: 50,
        maxExposedUnits: 2730,
        maxConversionsAtRisk: 55,
        terminatingEvents: ['kill_switch'],
        reviewByIso: '2026-12-20T00:00:00Z',
        percentageRampAsSafetyGate: true,
      },
      nowIso: '2026-11-20T12:00:00Z',
    });
    expect(badRamp.ok).toBe(false);
    if (!badRamp.ok) {
      expect(badRamp.code).toBe('PERCENTAGE_ROLLOUT_PROHIBITED_AS_SAFETY_GATE');
    }

    // Valid human-authored envelope
    const created = createSealedAutonomyEnvelope({
      author: owner,
      spec: {
        tenantId: 'ten_1',
        siteId: 'site_1',
        allowedActions: ['delivery.publish_banner'],
        allowedScopes: ['decisions:publish'],
        allowedPagePatterns: ['/articles/*'],
        allowedFieldProvenance: ['closed_enum', 'copy_library', 'generated_checked'],
        maxCostUnits: 100,
        maxExposedUnits: 2730,
        maxConversionsAtRisk: 55,
        smokeEpsilon: 0.01,
        maxGuardrailStalenessSec: 1800,
        terminatingEvents: ['kill_switch'],
        reviewByIso: '2026-12-20T00:00:00Z',
        allowGeneratedCopy: true,
        generatedCopyGateOpen: true,
      },
      nowIso: '2026-11-20T12:00:00Z',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const env = created.envelope;
    expect(env.smokeUnitsRequired).toBe(300); // ceil(3 / 0.01)
    expect(verifySealedEnvelopeIntegrity(env)).toBe(true);

    // Business guardrail freshness expiry auto-stops new displays
    const stale = evaluateEnvelopePublishAllowance({
      envelope: env,
      action: 'delivery.publish_banner',
      pagePath: '/articles/seo-guide',
      requestedExposedUnits: 200,
      requestedConversionsAtRisk: 4,
      requestedCostUnits: 5,
      isSmokePhase: true,
      guardrails: {
        lastCheckedAtIso: '2026-11-20T11:00:00Z', // 60 min old > 30 min max
        allGuardrailsHealthy: true,
      },
      nowIso: '2026-11-20T12:00:00Z',
    });
    expect(stale.allowed).toBe(false);
    expect(stale.autoStoppedForStaleGuardrails).toBe(true);
    expect(stale.code).toBe('BUSINESS_GUARDRAIL_STALE_AUTO_STOP');
  });
});

describe('lib/link/autonomy/agent-publisher (§10.10, §11.7 — 1,000+ Hijack Suite & Asymmetric Stop)', () => {
  test('guarantees 0 unapproved open fields reach signing, verifies checked generated copy, and passes 1,040-attack hijack suite across 2 clients (>=400 each)', () => {
    const owner = makeHumanOwner();
    const created = createSealedAutonomyEnvelope({
      author: owner,
      spec: {
        tenantId: 'ten_1',
        siteId: 'site_1',
        allowedActions: ['delivery.publish_banner'],
        allowedScopes: ['decisions:publish'],
        allowedPagePatterns: ['/articles/*'],
        allowedFieldProvenance: ['closed_enum', 'copy_library', 'generated_checked'],
        maxCostUnits: 100,
        maxExposedUnits: 2730,
        maxConversionsAtRisk: 55,
        smokeEpsilon: 0.01,
        maxGuardrailStalenessSec: 3600,
        terminatingEvents: ['kill_switch'],
        reviewByIso: '2026-12-20T00:00:00Z',
        allowGeneratedCopy: true,
        generatedCopyGateOpen: true,
      },
      nowIso: '2026-11-20T12:00:00Z',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const envelope = created.envelope;

    // 1. Checked generated copy: grounded passes; hallucinated price/URL fails; regulated industry blocked
    const source: SourceSectionRecord = {
      ticketId: 'tkt_01',
      sectionId: 'sec_price',
      verifiedOwnSiteText: 'UGOKIプランは月額980円で開始できます。',
      approvedAssetTokens: ['UGOKI', '980円'],
    };
    const goodGen: IsolatedCopyGenerator = {
      hasTools: false,
      generate: () => 'UGOKIプランは月額980円から始められます。',
    };
    const badGen: IsolatedCopyGenerator = {
      hasTools: false,
      generate: () => 'UGOKIプランは今だけ500円！https://evil.invalid へ',
    };
    const entChecker: IndependentEntailmentChecker = {
      checkEntailment: ({ hypothesis }) => ({
        entailed: hypothesis.includes('980円'),
        score: hypothesis.includes('980円') ? 0.94 : 0.12,
        contradiction: !hypothesis.includes('980円'),
      }),
    };

    expect(
      verifyGeneratedCheckedCopy({
        source,
        instructionKind: 'clarify_cta',
        generator: goodGen,
        entailmentChecker: entChecker,
        sensitiveIndustry: false,
      }).passed
    ).toBe(true);

    const hallucinated = verifyGeneratedCheckedCopy({
      source,
      instructionKind: 'clarify_cta',
      generator: badGen,
      entailmentChecker: entChecker,
      sensitiveIndustry: false,
    });
    expect(hallucinated.passed).toBe(false);
    expect(
      hallucinated.failedChecks.some((c) => c.startsWith('ungrounded_url'))
    ).toBe(true);

    const regulated = verifyGeneratedCheckedCopy({
      source,
      instructionKind: 'clarify_cta',
      generator: goodGen,
      entailmentChecker: entChecker,
      sensitiveIndustry: true,
    });
    expect(regulated.passed).toBe(false);
    expect(regulated.failedChecks).toContain('regulated_industry_requires_human_approval');

    // 2. Open field without human approval is blocked; WITH exact diff-hash human passkey approval succeeds
    const openFieldsPayload = {
      pagePath: '/articles/guide',
      bundleTier: 'A1' as const,
      fields: [
        { name: 'headline', provenance: 'open_free_text' as const, value: '新しい見出し' },
      ],
    };
    const blockedOpen = evaluateAndSignAgentPublish(
      {
        requestId: 'req_open_1',
        clientId: 'mcp_client_a',
        agentPrincipalId: 'agent_1',
        action: 'delivery.publish_banner',
        ...openFieldsPayload,
        requestedExposedUnits: 100,
        requestedConversionsAtRisk: 2,
        requestedCostUnits: 1,
        isSmokePhase: true,
      },
      {
        envelope,
        guardrails: { lastCheckedAtIso: '2026-11-20T11:55:00Z', allGuardrailsHealthy: true },
        sensitiveIndustry: false,
        preflightPassed: true,
        section106Passed: true,
        approvedServerLookupIds: new Set(['sec_hero']),
        approvedAssetRefs: new Set(['asset_banner_01']),
        sourceTickets: new Map([[source.ticketId, source]]),
        nowIso: '2026-11-20T12:00:00Z',
      }
    );
    expect(blockedOpen.signed).toBe(false);
    expect(blockedOpen.status).toBe('requires_human_approval');

    const hashes = computeActionAndDiffHash('delivery.publish_banner', openFieldsPayload);
    const humanApproval: PasskeyApprovalRecord = {
      approvalId: 'apr_human_1',
      tenantId: 'ten_1',
      siteId: 'site_1',
      approverPrincipalId: owner.principalId,
      approverRole: 'owner',
      action: 'delivery.publish_banner',
      actionHash: hashes.actionHash,
      renderedDiffHash: hashes.renderedDiffHash,
      webauthnCredentialId: 'cred_yubikey_1',
      createdAt: '2026-11-20T11:58:00Z',
      expiresAt: '2026-11-21T11:58:00Z',
    };
    const gatewayVerifier = new SingleUsePasskeyApprovalVerifier({
      requireRegisteredApproval: true,
    });
    gatewayVerifier.registerApproval(humanApproval);

    const approvedOpen = evaluateAndSignAgentPublish(
      {
        requestId: 'req_open_2',
        clientId: 'mcp_client_a',
        agentPrincipalId: 'agent_1',
        action: 'delivery.publish_banner',
        ...openFieldsPayload,
        requestedExposedUnits: 100,
        requestedConversionsAtRisk: 2,
        requestedCostUnits: 1,
        isSmokePhase: true,
        humanApproval,
      },
      {
        envelope,
        guardrails: { lastCheckedAtIso: '2026-11-20T11:55:00Z', allGuardrailsHealthy: true },
        sensitiveIndustry: false,
        preflightPassed: true,
        section106Passed: true,
        approvedServerLookupIds: new Set(['sec_hero']),
        approvedAssetRefs: new Set(['asset_banner_01']),
        sourceTickets: new Map([[source.ticketId, source]]),
        passkeyApprovalVerifier: gatewayVerifier,
        nowIso: '2026-11-20T12:00:00Z',
      }
    );
    expect(approvedOpen.signed).toBe(true);
    expect(approvedOpen.code).toBe('SIGNED_WITH_HUMAN_PASSKEY_APPROVAL');

    // 3. Full 1,040-attack hijack suite across 2 distinct MCP clients (>= 400 each) => 0 out-of-envelope publishes!
    const hijackReport = runAgentHijackSuite({
      baseEnvelope: envelope,
      clientIds: ['mcp_client_a', 'mcp_client_b'],
      attacksPerClient: 520,
      nowIso: '2026-11-20T12:00:00Z',
    });
    expect(hijackReport.passed).toBe(true);
    expect(hijackReport.totalAttacks).toBe(1040);
    expect(hijackReport.perClientCounts['mcp_client_a']).toBe(520);
    expect(hijackReport.perClientCounts['mcp_client_b']).toBe(520);
    expect(hijackReport.outOfEnvelopePublishes).toBe(0);
    expect(hijackReport.unapprovedOpenFieldsSigned).toBe(0);
  });

  test('[C-16] fails closed on unknown provenance, non-primitive/HTML payloads, self-declared allowedValues, mechanical URL/price/consent smuggling, and replayed/stale passkey approvals', () => {
    const owner = makeHumanOwner();
    const created = createSealedAutonomyEnvelope({
      author: owner,
      spec: {
        tenantId: 'ten_1',
        siteId: 'site_1',
        allowedActions: ['delivery.publish_banner'],
        allowedScopes: ['decisions:publish'],
        allowedPagePatterns: ['/articles/*'],
        allowedFieldProvenance: ['closed_enum', 'copy_library'],
        maxCostUnits: 100,
        maxExposedUnits: 2730,
        maxConversionsAtRisk: 55,
        smokeEpsilon: 0.01,
        maxGuardrailStalenessSec: 3600,
        terminatingEvents: ['kill_switch'],
        reviewByIso: '2026-12-20T00:00:00Z',
      },
      nowIso: '2026-11-20T12:00:00Z',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const envelope = created.envelope;

    const verifier = new SingleUsePasskeyApprovalVerifier({ requireRegisteredApproval: true });
    const baseCtx = {
      envelope,
      guardrails: { lastCheckedAtIso: '2026-11-20T11:55:00Z', allGuardrailsHealthy: true },
      sensitiveIndustry: false,
      preflightPassed: true,
      section106Passed: true,
      approvedServerLookupIds: new Set(['sec_hero']),
      approvedAssetRefs: new Set(['asset_banner_01']),
      sourceTickets: new Map(),
      slotCatalog: {
        theme: { slotName: 'theme', provenance: 'closed_enum' as const, allowedValues: ['light', 'dark'] },
        headline: { slotName: 'headline', provenance: 'open_free_text' as const },
      },
      passkeyApprovalVerifier: verifier,
      nowIso: '2026-11-20T12:00:00Z',
    };

    // 1. Unknown provenance MUST fail closed immediately in default branch
    const unknownProv = evaluateAndSignAgentPublish(
      {
        requestId: 'req_c16_unknown_prov',
        clientId: 'mcp_a',
        agentPrincipalId: 'agent_1',
        action: 'delivery.publish_banner',
        pagePath: '/articles/guide',
        bundleTier: 'A1',
        fields: [{ name: 'theme', provenance: 'forged_provenance' as 'closed_enum', value: 'light' }],
        requestedExposedUnits: 50,
        requestedConversionsAtRisk: 1,
        requestedCostUnits: 1,
        isSmokePhase: true,
      },
      { ...baseCtx, slotCatalog: undefined }
    );
    expect(unknownProv.signed).toBe(false);
    expect(unknownProv.code).toBe('UNKNOWN_OR_UNREGISTERED_PROVENANCE');

    // 2. Non-primitive object/array or HTML/script payload MUST fail closed
    const objVal = evaluateAndSignAgentPublish(
      {
        requestId: 'req_c16_obj',
        clientId: 'mcp_a',
        agentPrincipalId: 'agent_1',
        action: 'delivery.publish_banner',
        pagePath: '/articles/guide',
        bundleTier: 'A1',
        fields: [{ name: 'theme', provenance: 'closed_enum', value: { evil: 1 } as unknown as string }],
        requestedExposedUnits: 50,
        requestedConversionsAtRisk: 1,
        requestedCostUnits: 1,
        isSmokePhase: true,
      },
      baseCtx
    );
    expect(objVal.signed).toBe(false);
    expect(objVal.code).toBe('NON_PRIMITIVE_SLOT_VALUE_FORBIDDEN');

    const htmlVal = evaluateAndSignAgentPublish(
      {
        requestId: 'req_c16_html',
        clientId: 'mcp_a',
        agentPrincipalId: 'agent_1',
        action: 'delivery.publish_banner',
        pagePath: '/articles/guide',
        bundleTier: 'A1',
        fields: [{ name: 'headline', provenance: 'open_free_text', value: '<b>Injected</b><script>x()</script>' }],
        requestedExposedUnits: 50,
        requestedConversionsAtRisk: 1,
        requestedCostUnits: 1,
        isSmokePhase: true,
      },
      baseCtx
    );
    expect(htmlVal.signed).toBe(false);
    expect(htmlVal.code).toBe('HTML_OR_SCRIPT_PAYLOAD_FORBIDDEN');

    // 3. Agent self-declared `allowedValues` ignored when server slotCatalog restricts to ['light', 'dark']
    const selfAllowlist = evaluateAndSignAgentPublish(
      {
        requestId: 'req_c16_self_enum',
        clientId: 'mcp_a',
        agentPrincipalId: 'agent_1',
        action: 'delivery.publish_banner',
        pagePath: '/articles/guide',
        bundleTier: 'A1',
        fields: [
          {
            name: 'theme',
            provenance: 'closed_enum',
            value: 'neon_override',
            allowedValues: ['neon_override'],
          },
        ],
        requestedExposedUnits: 50,
        requestedConversionsAtRisk: 1,
        requestedCostUnits: 1,
        isSmokePhase: true,
      },
      baseCtx
    );
    expect(selfAllowlist.signed).toBe(false);
    expect(selfAllowlist.code).toBe('CLOSED_ENUM_VIOLATION');

    // 4. Mechanical URL / price / consent detection blocks autonomous publish even with self-declared booleans = false
    const smuggledPriceAndUrl = evaluateAndSignAgentPublish(
      {
        requestId: 'req_c16_mech',
        clientId: 'mcp_a',
        agentPrincipalId: 'agent_1',
        action: 'delivery.publish_banner',
        pagePath: '/articles/guide',
        bundleTier: 'A1',
        fields: [{ name: 'theme', provenance: 'closed_enum', value: 'light' }],
        operations: [{ op: 'SetText', text: '特別価格 ¥1,980 (50% OFF) https://other-host.example/deal' }],
        touchesDestination: false,
        touchesHost: false,
        touchesOfferCondition: false,
        changesPrice: false,
        relaxesPrivacy: false,
        requestedExposedUnits: 50,
        requestedConversionsAtRisk: 1,
        requestedCostUnits: 1,
        isSmokePhase: true,
      },
      baseCtx
    );
    expect(smuggledPriceAndUrl.signed).toBe(false);
    expect(smuggledPriceAndUrl.status).toBe('requires_human_approval');

    // 5. Passkey approval must be registered, fresh <= 5 min, and single-use consumed (replay fails closed!)
    const candidatePayload = {
      pagePath: '/articles/guide',
      bundleTier: 'A1' as const,
      fields: [{ name: 'headline', provenance: 'open_free_text' as const, value: '安全な見出し' }],
    };
    const hashes = computeActionAndDiffHash('delivery.publish_banner', candidatePayload);

    // Stale approval (created 10 minutes ago > 5 min window) -> rejected
    const staleApproval: PasskeyApprovalRecord = {
      approvalId: 'apr_stale_10m',
      tenantId: 'ten_1',
      siteId: 'site_1',
      approverPrincipalId: owner.principalId,
      approverRole: 'owner',
      action: 'delivery.publish_banner',
      actionHash: hashes.actionHash,
      renderedDiffHash: hashes.renderedDiffHash,
      webauthnCredentialId: 'cred_1',
      createdAt: '2026-11-20T11:49:00Z',
      expiresAt: '2026-11-20T12:30:00Z',
    };
    verifier.registerApproval(staleApproval);
    const staleRes = evaluateAndSignAgentPublish(
      {
        requestId: 'req_c16_stale_apr',
        clientId: 'mcp_a',
        agentPrincipalId: 'agent_1',
        action: 'delivery.publish_banner',
        ...candidatePayload,
        requestedExposedUnits: 50,
        requestedConversionsAtRisk: 1,
        requestedCostUnits: 1,
        isSmokePhase: true,
        humanApproval: staleApproval,
      },
      baseCtx
    );
    expect(staleRes.signed).toBe(false);
    expect(staleRes.code).toBe('INVALID_OR_MISMATCHED_HUMAN_APPROVAL');

    // Fresh approval (created 1 minute ago) -> 1st use signs; 2nd replay FAILS CLOSED!
    const freshApproval: PasskeyApprovalRecord = {
      ...staleApproval,
      approvalId: 'apr_fresh_1m',
      createdAt: '2026-11-20T11:59:00Z',
    };
    verifier.registerApproval(freshApproval);

    const firstUse = evaluateAndSignAgentPublish(
      {
        requestId: 'req_c16_apr_1',
        clientId: 'mcp_a',
        agentPrincipalId: 'agent_1',
        action: 'delivery.publish_banner',
        ...candidatePayload,
        requestedExposedUnits: 50,
        requestedConversionsAtRisk: 1,
        requestedCostUnits: 1,
        isSmokePhase: true,
        humanApproval: freshApproval,
      },
      baseCtx
    );
    expect(firstUse.signed).toBe(true);

    const replayUse = evaluateAndSignAgentPublish(
      {
        requestId: 'req_c16_apr_replay',
        clientId: 'mcp_a',
        agentPrincipalId: 'agent_1',
        action: 'delivery.publish_banner',
        ...candidatePayload,
        requestedExposedUnits: 50,
        requestedConversionsAtRisk: 1,
        requestedCostUnits: 1,
        isSmokePhase: true,
        humanApproval: freshApproval,
      },
      baseCtx
    );
    expect(replayUse.signed).toBe(false);
    expect(replayUse.code).toBe('INVALID_OR_MISMATCHED_HUMAN_APPROVAL');
    expect(replayUse.reason).toContain('approval_already_consumed');
  });

  test('[#3] fails closed with APPROVAL_VERIFIER_REQUIRED when human approval verifier is uninjected', () => {
    const owner = makeHumanOwner();
    const created = createSealedAutonomyEnvelope({
      author: owner,
      spec: {
        tenantId: 'ten_1',
        siteId: 'site_1',
        allowedActions: ['delivery.publish_banner'],
        allowedScopes: ['decisions:publish'],
        allowedPagePatterns: ['/articles/*'],
        allowedFieldProvenance: ['closed_enum', 'copy_library'],
        maxCostUnits: 100,
        maxExposedUnits: 2730,
        maxConversionsAtRisk: 55,
        smokeEpsilon: 0.01,
        maxGuardrailStalenessSec: 3600,
        terminatingEvents: ['kill_switch'],
        reviewByIso: '2026-12-20T00:00:00Z',
      },
      nowIso: '2026-11-20T12:00:00Z',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const candidatePayload = {
      pagePath: '/articles/guide',
      bundleTier: 'A1' as const,
      fields: [{ name: 'headline', provenance: 'open_free_text' as const, value: 'Forged open text' }],
    };
    const hashes = computeActionAndDiffHash('delivery.publish_banner', candidatePayload);
    const callerSuppliedApproval: PasskeyApprovalRecord = {
      approvalId: 'apr_unregistered_forged',
      tenantId: 'ten_1',
      siteId: 'site_1',
      approverPrincipalId: owner.principalId,
      approverRole: 'owner',
      action: 'delivery.publish_banner',
      actionHash: hashes.actionHash,
      renderedDiffHash: hashes.renderedDiffHash,
      webauthnCredentialId: 'cred_fake_1',
      createdAt: '2026-11-20T11:59:00Z',
      expiresAt: '2026-11-20T12:30:00Z',
    };

    const res = evaluateAndSignAgentPublish(
      {
        requestId: 'req_missing_verifier',
        clientId: 'mcp_a',
        agentPrincipalId: 'agent_1',
        action: 'delivery.publish_banner',
        ...candidatePayload,
        requestedExposedUnits: 50,
        requestedConversionsAtRisk: 1,
        requestedCostUnits: 1,
        isSmokePhase: true,
        humanApproval: callerSuppliedApproval,
      },
      {
        envelope: created.envelope,
        guardrails: { lastCheckedAtIso: '2026-11-20T11:55:00Z', allGuardrailsHealthy: true },
        sensitiveIndustry: false,
        preflightPassed: true,
        section106Passed: true,
        approvedServerLookupIds: new Set(['sec_hero']),
        approvedAssetRefs: new Set(['asset_banner_01']),
        sourceTickets: new Map(),
        nowIso: '2026-11-20T12:00:00Z',
      }
    );
    expect(res.signed).toBe(false);
    expect(res.status).toBe('rejected');
    expect(res.code).toBe('APPROVAL_VERIFIER_REQUIRED');
  });

  test('[#4] rejects catalog enum field whose provenance is excluded from owner AutonomyEnvelope allowedFieldProvenance', () => {
    const owner = makeHumanOwner();
    // Owner sealed envelope permits ONLY `copy_library`, EXCLUDING `closed_enum`!
    const created = createSealedAutonomyEnvelope({
      author: owner,
      spec: {
        tenantId: 'ten_1',
        siteId: 'site_1',
        allowedActions: ['delivery.publish_banner'],
        allowedScopes: ['decisions:publish'],
        allowedPagePatterns: ['/articles/*'],
        allowedFieldProvenance: ['copy_library'],
        maxCostUnits: 100,
        maxExposedUnits: 2730,
        maxConversionsAtRisk: 55,
        smokeEpsilon: 0.01,
        maxGuardrailStalenessSec: 3600,
        terminatingEvents: ['kill_switch'],
        reviewByIso: '2026-12-20T00:00:00Z',
      },
      nowIso: '2026-11-20T12:00:00Z',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const decision = evaluateAndSignAgentPublish(
      {
        requestId: 'req_enum_excluded_by_envelope',
        clientId: 'mcp_a',
        agentPrincipalId: 'agent_1',
        action: 'delivery.publish_banner',
        pagePath: '/articles/guide',
        bundleTier: 'A1',
        fields: [{ name: 'theme', provenance: 'closed_enum', value: 'light' }],
        requestedExposedUnits: 50,
        requestedConversionsAtRisk: 1,
        requestedCostUnits: 1,
        isSmokePhase: true,
      },
      {
        envelope: created.envelope,
        guardrails: { lastCheckedAtIso: '2026-11-20T11:55:00Z', allGuardrailsHealthy: true },
        sensitiveIndustry: false,
        preflightPassed: true,
        section106Passed: true,
        approvedServerLookupIds: new Set(['sec_hero']),
        approvedAssetRefs: new Set(['asset_banner_01']),
        sourceTickets: new Map(),
        slotCatalog: {
          theme: {
            slotName: 'theme',
            provenance: 'closed_enum',
            allowedValues: ['light', 'dark'],
          },
        },
        nowIso: '2026-11-20T12:00:00Z',
      }
    );

    expect(decision.signed).toBe(false);
    expect(decision.status).toBe('rejected');
    expect(decision.code).toBe('FIELD_PROVENANCE_NOT_ALLOWED_IN_ENVELOPE');
  });

  test('asymmetric stop authority: site resumes after 60 min while named interventions stay stopped until human release; whole-tenant stop requires human or 2 principals', () => {
    const stopCtl = new AgentStopController();
    const agentA = makeAgentPrincipal('agent_a');
    const agentB = makeAgentPrincipal('agent_b');
    const humanOwner = makeHumanOwner();

    stopCtl.registerPublish('pub_1', agentA.principalId);
    expect(stopCtl.agentStopOwnPublish(agentA.principalId, 'pub_1').ok).toBe(true);
    expect(stopCtl.isPublishStopped('pub_1')).toBe(true);

    // Pause site with requested 180 min -> clamped to 60 min max
    const pause = stopCtl.agentPauseSite({
      agentPrincipalId: agentA.principalId,
      siteId: 'site_1',
      namedInterventionIds: ['int_suspect_cta'],
      requestedDurationMin: 180,
      nowIso: '2026-11-20T12:00:00Z',
    });
    expect(pause.effectiveDurationMin).toBe(60);

    // At +30 min: both site and named intervention are paused
    const at30m = stopCtl.evaluateSitePauseState('site_1', '2026-11-20T12:30:00Z');
    expect(at30m.sitePaused).toBe(true);
    expect(at30m.stillStoppedNamedInterventions).toContain('int_suspect_cta');

    // At +61 min without human decision: site AUTO-RESUMES, but named intervention STAYS STOPPED!
    const at61m = stopCtl.evaluateSitePauseState('site_1', '2026-11-20T13:01:00Z');
    expect(at61m.sitePaused).toBe(false);
    expect(at61m.siteAutoResumedAfter60m).toBe(true);
    expect(at61m.stillStoppedNamedInterventions).toContain('int_suspect_cta');

    // Agent cannot release its named intervention; human owner CAN
    expect(stopCtl.humanReleaseNamedIntervention(agentA, 'int_suspect_cta').ok).toBe(false);
    expect(stopCtl.humanReleaseNamedIntervention(humanOwner, 'int_suspect_cta').ok).toBe(true);
    expect(
      stopCtl.evaluateSitePauseState('site_1', '2026-11-20T13:05:00Z')
        .stillStoppedNamedInterventions
    ).toHaveLength(0);

    // Single agent CANNOT stop whole tenant; 2 distinct principals CAN
    expect(
      stopCtl.stopWholeTenant({ tenantId: 'ten_1', primaryPrincipal: agentA }).ok
    ).toBe(false);
    expect(
      stopCtl.stopWholeTenant({
        tenantId: 'ten_1',
        primaryPrincipal: agentA,
        coSigningPrincipal: agentB,
      }).ok
    ).toBe(true);
    expect(stopCtl.isTenantStopped('ten_1')).toBe(true);
  });
});

describe('lib/link/autonomy/holdout-claims (§9.8)', () => {
  test('computes 4-bit holdout cumulative effects with 81.45% unheld share & power disclosure, and auto-expires claims at 180d or body_fp change while stripping point estimate', () => {
    const report = evaluateHoldoutCumulativeEffects({
      holdoutConfig: {
        global: 0.05,
        overlay: 0.05,
        patch: 0.05,
        recs: 0.05,
        epochWeeks: 26,
        epochOriginMs: Date.UTC(2026, 0, 1),
      },
      nowMs: Date.UTC(2026, 10, 20),
      siteCount: 5,
      slices: [
        { bit: 'global', exposedUnits: 40000, exposedConversions: 920, heldOutUnits: 2100, heldOutConversions: 42 },
        { bit: 'overlay', exposedUnits: 40000, exposedConversions: 880, heldOutUnits: 2100, heldOutConversions: 42 },
        { bit: 'patch', exposedUnits: 40000, exposedConversions: 860, heldOutUnits: 2100, heldOutConversions: 42 },
        { bit: 'recs', exposedUnits: 40000, exposedConversions: 850, heldOutUnits: 2100, heldOutConversions: 42 },
      ],
    });
    expect(report.unheldOutShare).toBeCloseTo(0.814506, 5);
    expect(report.powerLimitations.singleSite26wMdePct).toBe(24);
    expect(report.powerLimitations.fiveSite26wMdePct).toBe(11);
    expect(report.powerLimitations.holdoutAloneCompletesMeasurement).toBe(false);

    const baseClaim = {
      claimId: 'clm_01',
      interventionRef: {
        ref_id: 'int_ref_01',
        kind: 'intervention' as const,
        params_hash: 'h_params',
        watermarks: { ch: '2026-06-01T00:00:00Z' },
        result_digest: 'h_res',
        issued_at: '2026-05-01T00:00:00Z',
        valid_until: '2026-12-31T00:00:00Z',
        kid: 'kid_1',
      },
      evidenceLevel: 'proven' as const,
      provenPredicate: {
        predicate: 'visitor_randomised' as const,
        passed: true,
        allocator_logged_before_outcomes: true,
        prereg_locked: true,
        integrity_status: 'pass' as const,
        decision_rule_passed: true,
        randomisation_audit_p: 0.008,
        alpha: 0.05,
        duration_days: 21,
        platform_canary_passed: true,
        evaluated_at: '2026-05-01T00:00:00Z',
      },
      testedBodyFp: 'body_fp_v1',
      establishedAtIso: '2026-05-01T00:00:00Z',
      lastHoldbackVerifiedAtIso: '2026-05-01T00:00:00Z',
      holdbackConsistent: true,
      rawObservedLift: 0.14,
      ciLower95: 0.05,
      ciUpper95: 0.23,
      sampleN: 12000,
      skepticalLowerBound: 0.04,
      plannedNReached: true,
      guardrailsVerified: true,
      projectedPointEstimate: 0.11,
    };

    // Valid within 180 days & matching body_fp -> point_estimate retained
    const active = evaluateHoldoutClaimValidity({
      claim: baseClaim,
      currentBodyFp: 'body_fp_v1',
      nowIso: '2026-07-01T00:00:00Z',
    });
    expect(active.validity).toBe('valid');
    expect(active.pointEstimate).toBe(0.11);
    expect(active.envelope.measures.holdout_cumulative_lift.projection?.point_estimate).toBe(0.11);

    // Expired after > 180 days -> evidenceLevel stays `proven`, point_estimate stripped to null!
    const expiredTtl = evaluateHoldoutClaimValidity({
      claim: baseClaim,
      currentBodyFp: 'body_fp_v1',
      nowIso: '2026-11-20T00:00:00Z',
    });
    expect(expiredTtl.validity).toBe('expired');
    expect(expiredTtl.evidenceLevel).toBe('proven');
    expect(expiredTtl.pointEstimate).toBeNull();
    expect(expiredTtl.pointEstimateStripped).toBe(true);
    expect(expiredTtl.envelope.measures.holdout_cumulative_lift.projection?.point_estimate).toBeNull();

    // Expired immediately when body_fp changes -> evidenceLevel stays `proven`, point_estimate stripped!
    const expiredFp = evaluateHoldoutClaimValidity({
      claim: baseClaim,
      currentBodyFp: 'body_fp_v2_edited',
      nowIso: '2026-05-15T00:00:00Z',
    });
    expect(expiredFp.validity).toBe('expired');
    expect(expiredFp.evidenceLevel).toBe('proven');
    expect(expiredFp.pointEstimate).toBeNull();
    expect(expiredFp.expiryReasons[0]).toContain('tested_body_fp_changed');
  });
});

describe('lib/link/autonomy/federation-pooling (§8.7, §9.7, §11.11)', () => {
  test('rejects non-standard lanes & raw rows, returns insufficient_data for 1 tenant, enforces 5/10-tenant & <=1/3 caps, 14d opt-out retrain, tabular FM gate, and connects 4-E JP embeddings', async () => {
    const ledger = new CrossTenantPoolingLedger();

    // Reject custom_event & session_replay lanes immediately
    expect(() =>
      ledger.releaseExperimentSummaryRow({
        releaseId: 'rel_bad_lane',
        evaluatedAtIso: '2026-11-20T00:00:00Z',
        contributions: [
          {
            tenantId: 't1',
            originLane: 'custom_event',
            explicitOptIn: true,
            controlUnits: 100,
            treatmentUnits: 100,
            effectEstimate: 0.1,
            standardError: 0.02,
          },
        ],
      })
    ).toThrow(ProhibitedPoolingLaneError);

    expect(() =>
      ledger.releaseFederatedLearningAggregate({
        releaseId: 'fed_bad_lane',
        evaluatedAtIso: '2026-11-20T00:00:00Z',
        contributions: [
          {
            tenantId: 't1',
            originLane: 'session_replay',
            explicitOptIn: true,
            splitId: 'sp_1',
            units: 100,
            gradientSum: [1, 2],
            baselineRate: 0.03,
          },
        ],
      })
    ).toThrow(ProhibitedPoolingLaneError);

    // Reject raw row pooling
    expect(() =>
      ledger.releaseExperimentSummaryRow({
        releaseId: 'rel_raw_rows',
        evaluatedAtIso: '2026-11-20T00:00:00Z',
        contributions: [
          {
            tenantId: 't1',
            originLane: 'standard_telemetry',
            containsRawRows: true,
            explicitOptIn: true,
            controlUnits: 100,
            treatmentUnits: 100,
            effectEstimate: 0.1,
            standardError: 0.02,
          },
        ],
      })
    ).toThrow(RowLevelPoolingProhibitedError);

    // Single tenant MUST return `insufficient_data`
    const singleTenant = ledger.releaseExperimentSummaryRow({
      releaseId: 'rel_single',
      evaluatedAtIso: '2026-11-20T00:00:00Z',
      contributions: [
        {
          tenantId: 'ten_only_one',
          originLane: 'standard_telemetry',
          explicitOptIn: true,
          controlUnits: 500,
          treatmentUnits: 500,
          effectEstimate: 0.12,
          standardError: 0.02,
        },
      ],
    });
    expect(singleTenant.status).toBe('insufficient_data');

    // 5 tenants with one dominant whale tenant -> weight capped at <= 1/3; requires D-23 approval
    const fiveTenants = [1, 2, 3, 4, 5].map((i) => ({
      tenantId: `t_${i}`,
      originLane: 'standard_telemetry' as const,
      explicitOptIn: true,
      controlUnits: i === 1 ? 50000 : 100,
      treatmentUnits: i === 1 ? 50000 : 100,
      effectEstimate: 0.1,
      standardError: 0.03,
    }));
    const lockedD23 = ledger.releaseExperimentSummaryRow({
      releaseId: 'rel_locked_d23',
      evaluatedAtIso: '2026-11-20T00:00:00Z',
      contributions: fiveTenants,
    });
    expect(lockedD23.status).toBe('not_entitled');

    const released5 = ledger.releaseExperimentSummaryRow({
      releaseId: 'rel_ok_5',
      evaluatedAtIso: '2026-11-20T00:00:00Z',
      contributions: fiveTenants,
      decision23Approved: true,
      decision23LegalSignedOff: true,
    });
    expect(released5.status).toBe('ok');
    expect(released5.maxSingleTenantWeight).toBeLessThanOrEqual(1 / 3 + 1e-6);

    // Federation requires >= 10 tenants, per split >= 5 tenants & >= 50 units, NEVER publishes CATE
    const tenTenantsFed = Array.from({ length: 10 }, (_, i) => ({
      tenantId: `tf_${i + 1}`,
      originLane: 'standard_telemetry' as const,
      explicitOptIn: true,
      splitId: 'split_article',
      units: i === 0 ? 10000 : 60,
      gradientSum: [0.5 * (i + 1), -0.2 * (i + 1)],
      baselineRate: 0.025,
    }));
    const fedOk = ledger.releaseFederatedLearningAggregate({
      releaseId: 'fed_ok_10',
      evaluatedAtIso: '2026-11-20T00:00:00Z',
      contributions: tenTenantsFed,
      decision23Approved: true,
      decision23LegalSignedOff: true,
    });
    expect(fedOk.status).toBe('ok');
    expect(fedOk.visitorCatePublished).toBe(false);
    expect(fedOk.publishedPriorStartingWeights).toHaveLength(2);
    expect(fedOk.ledgerRow.maxTenantWeight).toBeLessThanOrEqual(1 / 3 + 1e-6);

    // Tenant opt-out triggers mandatory 14-day retrain deadline
    const optOut = ledger.recordTenantOptOut('tf_1', '2026-11-01T00:00:00Z');
    expect(optOut.retrainRequired).toBe(true);
    expect(optOut.retrainDeadlineIso).toBe('2026-11-15T00:00:00.000Z');
    expect(ledger.getOptOutRetrainStatus('tf_1', '2026-11-16T00:00:00Z').overdue).toBe(true);

    // Tabular Foundation Model gate (<=10,000 rows, 200..5,000 positives, verified commercial license)
    expect(
      evaluateTabularFoundationModelEligibility({
        modelId: 'tabpfn-commercial',
        licenseSpdx: 'Apache-2.0',
        commercialLicenseVerified: true,
        rowCount: 8000,
        positiveCount: 450,
      }).eligible
    ).toBe(true);
    expect(
      evaluateTabularFoundationModelEligibility({
        modelId: 'tabpfn-commercial',
        licenseSpdx: 'Apache-2.0',
        commercialLicenseVerified: true,
        rowCount: 15000,
        positiveCount: 450,
      }).eligible
    ).toBe(false);

    // Connect 4-E Japanese open embedding selection artifact (`lib/link/search/jp-embeddings.ts`)
    const providers = DEFAULT_JP_EMBEDDING_CANDIDATES.slice(0, 2).map(
      (spec, idx) =>
        new DeterministicJapaneseTestEmbedder(spec, {
          semantic_weight: idx === 0 ? 3.0 : 1.0,
          noise_level: idx === 0 ? 0.01 : 0.4,
        })
    );
    const selectedEmb = await runJapaneseEmbeddingSelectionBenchmark({
      providers,
      evaluated_at: '2026-11-20T00:00:00Z',
      suite: {
        suite_version: 'jp_v1',
        retrieval_cases: [
          {
            query: '料金プランと月額費用',
            relevant_section_id: 's_price',
            sections: [
              { id: 's_price', text: '月額料金プランと価格一覧' },
              { id: 's_cancel', text: '解約と退会の手続き方法' },
            ],
          },
        ],
        synonym_clusters: [
          { cluster_id: 'c_price', texts: ['月額料金', 'プラン費用'] },
          { cluster_id: 'c_cancel', texts: ['解約方法', '退会手続き'] },
        ],
        page_type_prototypes: [
          { page_type: 'pricing', text: '月額料金とプラン価格' },
          { page_type: 'faq', text: 'よくある質問と解約手続き' },
        ],
        page_type_test_cases: [
          { page_type: 'pricing', text: '費用と税込プラン一覧' },
        ],
      },
    });
    const boundEmb = bindJapaneseEmbeddingArtifact(selectedEmb);
    expect(boundEmb.bound).toBe(true);
    expect(boundEmb.modelId).toBe(selectedEmb.selected_model_id);
  });
});
