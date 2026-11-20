import {
  ALL_SCOPES,
  AuthorizationGateway,
  EdgeKeyForbiddenPurposeError,
  IdentityKeyRegistry,
  MAX_OEM_EXCHANGED_TTL_SEC,
  SCOPE_PRESETS,
  computeActionAndDiffHash,
  computePkceS256Challenge,
  computeSmokeUnitsRequired,
  generateEd25519KeyPair,
  normalizeRole,
  verifyPublicKeyStateless,
  type VerifiedPrincipal,
} from './index';

function buildFixture() {
  const pubSigningPair = generateEd25519KeyPair('v1');
  const registry = new IdentityKeyRegistry({
    pepperVersion: 'pep_v1',
    pepperSecret: 'super-secret-pepper-value-for-tests-001',
    publicKeySigningPair: pubSigningPair,
  });

  const now = new Date('2026-11-20T12:00:00Z');

  registry.registerOrg({
    orgId: 'org_direct',
    type: 'direct',
    name: 'Direct Media Inc.',
    createdAt: now.toISOString(),
  });
  registry.registerOrg({
    orgId: 'org_oem',
    type: 'oem',
    name: 'Agency OEM Partners',
    oemLegalSignoffRef: 'LEGAL-OEM-001',
    createdAt: now.toISOString(),
  });

  registry.registerTenant({
    tenantId: 'tenant_a',
    orgId: 'org_direct',
    name: 'Tenant A',
    planScopes: [...ALL_SCOPES],
    delegationPolicy: {
      allowedOemScopes: [],
      maxExchangedTokenTtlSec: 0,
      allowOemAccess: false,
    },
    revocationEpoch: 1,
    createdAt: now.toISOString(),
  });

  registry.registerTenant({
    tenantId: 'tenant_b',
    orgId: 'org_direct',
    name: 'Tenant B',
    planScopes: [...SCOPE_PRESETS.write],
    delegationPolicy: {
      allowedOemScopes: [],
      maxExchangedTokenTtlSec: 0,
      allowOemAccess: false,
    },
    revocationEpoch: 1,
    createdAt: now.toISOString(),
  });

  registry.registerTenant({
    tenantId: 'tenant_oem_mgmt',
    orgId: 'org_oem',
    name: 'OEM Management',
    planScopes: ['oem:manage', 'usage:read'],
    delegationPolicy: {
      allowedOemScopes: [],
      maxExchangedTokenTtlSec: 0,
      allowOemAccess: false,
    },
    revocationEpoch: 1,
    createdAt: now.toISOString(),
  });

  registry.registerTenant({
    tenantId: 'tenant_oem_child',
    orgId: 'org_oem',
    name: 'OEM Child Tenant',
    planScopes: [...SCOPE_PRESETS.write, 'privacy:delete'],
    delegationPolicy: {
      allowedOemScopes: ['analytics:read', 'decisions:read', 'privacy:delete'],
      maxExchangedTokenTtlSec: 900,
      allowOemAccess: true,
    },
    revocationEpoch: 1,
    createdAt: now.toISOString(),
  });

  registry.registerSite({
    siteId: 'site_a1',
    tenantId: 'tenant_a',
    siteRef: 'siteA1_ref',
    env: 'live',
    hostnames: ['example-a.jp'],
    allowedOrigins: ['https://example-a.jp'],
    createdAt: now.toISOString(),
  });

  registry.registerSite({
    siteId: 'site_a2',
    tenantId: 'tenant_a',
    siteRef: 'siteA2_ref',
    env: 'live',
    hostnames: ['shop.example-a.jp'],
    allowedOrigins: ['https://shop.example-a.jp'],
    createdAt: now.toISOString(),
  });

  registry.registerPrincipal({
    principalId: 'user_owner_a',
    tenantId: 'tenant_a',
    orgId: 'org_direct',
    kind: 'human',
    role: 'owner',
    passkeyEnrolled: true,
  });

  registry.registerPrincipal({
    principalId: 'agent_a',
    tenantId: 'tenant_a',
    orgId: 'org_direct',
    kind: 'agent',
    role: 'admin',
    passkeyEnrolled: false,
  });

  registry.registerPrincipal({
    principalId: 'user_mystery_role',
    tenantId: 'tenant_a',
    orgId: 'org_direct',
    kind: 'human',
    role: 'super_root_legacy_role',
    passkeyEnrolled: false,
  });

  const gateway = new AuthorizationGateway();

  const ownerSessionPrincipal: VerifiedPrincipal = {
    credentialKind: 'session_cookie',
    credentialId: 'sess_owner_a',
    tenantId: 'tenant_a',
    orgId: 'org_direct',
    allowedSiteIds: null,
    principalKind: 'human',
    principalId: 'user_owner_a',
    role: 'owner',
    effectiveScopes: new Set(ALL_SCOPES),
    senderConstrained: true,
    passkeyVerified: true,
    passkeyVerifiedAt: now.toISOString(),
  };

  return { registry, gateway, now, ownerSessionPrincipal };
}

describe('lib/link/auth — Account Plane, 4 Key Kinds, OAuth 2.1, Risk Classes R0–R5 & Audit Chain', () => {
  test('contains exact 24 canonical scopes and unknown roles fail-closed to viewer', () => {
    expect(ALL_SCOPES).toHaveLength(24);
    expect(normalizeRole('owner')).toBe('owner');
    expect(normalizeRole('ADMIN')).toBe('admin');
    expect(normalizeRole('member')).toBe('member');
    expect(normalizeRole('viewer')).toBe('viewer');
    expect(normalizeRole('superuser')).toBe('viewer');
    expect(normalizeRole('')).toBe('viewer');
    expect(normalizeRole(null)).toBe('viewer');
    expect(normalizeRole(undefined)).toBe('viewer');
    expect(normalizeRole(42)).toBe('viewer');

    const { registry } = buildFixture();
    expect(registry.getPrincipal('user_mystery_role')?.role).toBe('viewer');
  });

  test('ugk_pub_* verifies statelessly with Ed25519 (zero I/O) and is restricted to ingest & decision on its site', () => {
    const { registry, gateway, now } = buildFixture();
    const pubKey = registry.issuePublicKey('site_a1', 'v1');
    expect(pubKey).toMatch(/^ugk_pub_live_siteA1_ref\.v1\./);

    // Stateless verification succeeds without registry DB lookup
    const statelessOk = verifyPublicKeyStateless(pubKey, registry.getPublicKeysByVersion());
    expect(statelessOk.valid).toBe(true);
    expect(statelessOk.siteRef).toBe('siteA1_ref');
    expect(statelessOk.allowedOperations).toEqual(['ingest', 'decision']);

    // Tampered public key fails Ed25519 signature check
    const tampered = `${pubKey.slice(0, -4)}AAAA`;
    expect(verifyPublicKeyStateless(tampered, registry.getPublicKeysByVersion()).valid).toBe(false);

    const verified = registry.verifyPublicKeyToPrincipal(pubKey);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    // Ingest on own site -> allowed
    const ingestDecision = gateway.authorize({
      principal: verified.principal,
      action: 'ingest',
      riskClass: 'R0',
      resource: { type: 'site', id: 'site_a1', tenantId: 'tenant_a', siteId: 'site_a1' },
      now,
    });
    expect(ingestDecision.allowed).toBe(true);

    // Analytics read with ugk_pub -> 403
    const readDecision = gateway.authorize({
      principal: verified.principal,
      action: 'analytics.query',
      riskClass: 'R0',
      requiredScope: 'analytics:read',
      resource: { type: 'site', id: 'site_a1', tenantId: 'tenant_a', siteId: 'site_a1' },
      now,
    });
    expect(readDecision.allowed).toBe(false);
    expect(readDecision.httpStatus).toBe(403);

    // Other site within same tenant -> 403
    const otherOwnSite = gateway.authorize({
      principal: verified.principal,
      action: 'ingest',
      riskClass: 'R0',
      resource: { type: 'site', id: 'site_a2', tenantId: 'tenant_a', siteId: 'site_a2' },
      now,
    });
    expect(otherOwnSite.allowed).toBe(false);
    expect(otherOwnSite.httpStatus).toBe(403);

    // Foreign tenant resource -> 404 + audit entry
    const foreignSite = gateway.authorize({
      principal: verified.principal,
      action: 'ingest',
      riskClass: 'R0',
      resource: { type: 'site', id: 'site_b1', tenantId: 'tenant_b', siteId: 'site_b1' },
      now,
    });
    expect(foreignSite.allowed).toBe(false);
    expect(foreignSite.httpStatus).toBe(404);
  });

  test('ugk_sec_* defaults to read-only, stores HMAC-SHA256 only, enforces constraints, effective scope = key ∩ principal ∩ plan, and <=7d rotation', () => {
    const { registry, now } = buildFixture();
    // Default scopes -> read-only
    const defaultKey = registry.issueSecretKey({
      tenantId: 'tenant_a',
      principalId: 'user_owner_a',
      now,
    });
    expect(defaultKey.record.secretHash).not.toContain(defaultKey.rawKey);
    expect(defaultKey.record.scopes).toEqual(SCOPE_PRESETS.read);

    // Effective scope intersection: unknown-role principal fails closed to viewer -> cannot get decisions:publish even if key requests it
    const constrainedKey = registry.issueSecretKey({
      tenantId: 'tenant_a',
      principalId: 'user_mystery_role',
      scopes: ['analytics:read', 'decisions:publish'],
      constraints: {
        siteIds: ['site_a1'],
        allowedCidrs: ['203.0.113.0/24'],
        expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
        dailyCreditsCap: 100,
      },
      now,
    });

    // IP outside CIDR -> 403
    const badIp = registry.verifySecretKey(constrainedKey.rawKey, {
      clientIp: '198.51.100.5',
      siteId: 'site_a1',
      now,
    });
    expect(badIp.ok).toBe(false);
    if (!badIp.ok) expect(badIp.httpStatus).toBe(403);

    // Valid IP & site -> succeeds, but effectiveScopes loses decisions:publish (viewer role!)
    const okRes = registry.verifySecretKey(constrainedKey.rawKey, {
      clientIp: '203.0.113.42',
      siteId: 'site_a1',
      requestedCredits: 60,
      now,
    });
    expect(okRes.ok).toBe(true);
    if (okRes.ok) {
      expect(okRes.principal.effectiveScopes.has('analytics:read')).toBe(true);
      expect(okRes.principal.effectiveScopes.has('decisions:publish')).toBe(false);
    }

    // Exceed daily credits cap -> 429
    const overCap = registry.verifySecretKey(constrainedKey.rawKey, {
      clientIp: '203.0.113.42',
      siteId: 'site_a1',
      requestedCredits: 50,
      now,
    });
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) expect(overCap.httpStatus).toBe(429);

    // Key rotation with 2-day overlap
    const rotated = registry.rotateSecretKey(defaultKey.record.keyId, 2 * 24 * 3600_000, now);
    expect(
      registry.verifySecretKey(defaultKey.rawKey, {
        now: new Date(now.getTime() + 24 * 3600_000),
      }).ok
    ).toBe(true);
    expect(
      registry.verifySecretKey(defaultKey.rawKey, {
        now: new Date(now.getTime() + 3 * 24 * 3600_000),
      }).ok
    ).toBe(false);
    expect(
      registry.verifySecretKey(rotated.rawKey, {
        now: new Date(now.getTime() + 3 * 24 * 3600_000),
      }).ok
    ).toBe(true);
  });

  test('ugk_edge_* derives distinct HKDF keys for handoff_header/log_shipper and strictly forbids decrypt/pseudonymize', () => {
    const { registry, now } = buildFixture();
    const { record } = registry.issueEdgeKey({
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      now,
    });

    const handoffKey = registry.deriveEdgeKey(record.keyId, 'handoff_header', now);
    const shipperKey = registry.deriveEdgeKey(record.keyId, 'log_shipper', now);
    expect(handoffKey).toHaveLength(32);
    expect(shipperKey).toHaveLength(32);
    expect(handoffKey.equals(shipperKey)).toBe(false);

    expect(() => registry.deriveEdgeKey(record.keyId, 'decrypt', now)).toThrow(
      EdgeKeyForbiddenPurposeError
    );
    expect(() => registry.deriveEdgeKey(record.keyId, 'pseudonymize', now)).toThrow(
      EdgeKeyForbiddenPurposeError
    );
  });

  test('ugk_oem_* cannot touch tenant plane directly and exchanges for <=15m act-claim token intersected with child delegation_policy', () => {
    const { registry, gateway, now } = buildFixture();
    const { rawKey: oemKey } = registry.issueOemKey({
      orgId: 'org_oem',
      managementTenantId: 'tenant_oem_mgmt',
      delegableScopes: ['analytics:read', 'decisions:publish', 'privacy:delete'],
      now,
    });

    // Direct tenant operation with ugk_oem_* -> 403 OEM_EXCHANGE_REQUIRED
    const oemVerified = registry.verifyOemManagementKey(oemKey, now);
    expect(oemVerified.ok).toBe(true);
    if (!oemVerified.ok) return;

    const directAttempt = gateway.authorize({
      principal: oemVerified.principal,
      action: 'analytics.query',
      riskClass: 'R0',
      requiredScope: 'analytics:read',
      resource: { type: 'site', id: 's1', tenantId: 'tenant_oem_mgmt' },
      now,
    });
    expect(directAttempt.allowed).toBe(false);
    expect(directAttempt.httpStatus).toBe(403);
    expect(directAttempt.code).toBe('OEM_EXCHANGE_REQUIRED');

    // Cross-org exchange -> 404 (never reveals foreign tenant)
    const crossOrg = registry.exchangeOemTokenForChild({
      rawOemKey: oemKey,
      childTenantId: 'tenant_a',
      actorSub: 'oem_operator_1',
      requestedScopes: ['analytics:read'],
      now,
    });
    expect(crossOrg.ok).toBe(false);
    if (!crossOrg.ok) expect(crossOrg.httpStatus).toBe(404);

    // Valid child exchange: requested 3600s clamped to <= 900s (15 min), scopes intersected with child delegationPolicy
    const exchanged = registry.exchangeOemTokenForChild({
      rawOemKey: oemKey,
      childTenantId: 'tenant_oem_child',
      actorSub: 'oem_operator_1',
      requestedScopes: ['analytics:read', 'decisions:publish'],
      requestedTtlSec: 3600,
      now,
    });
    expect(exchanged.ok).toBe(true);
    if (!exchanged.ok) return;

    const ttlSec =
      (new Date(exchanged.claims.expiresAt).getTime() - new Date(exchanged.claims.issuedAt).getTime()) /
      1000;
    expect(ttlSec).toBeLessThanOrEqual(MAX_OEM_EXCHANGED_TTL_SEC);
    expect(exchanged.claims.act.sub).toBe('oem_operator_1');
    expect(exchanged.claims.scopes).toEqual(['analytics:read']); // decisions:publish filtered out by child policy

    // Verify before expiry succeeds, after 16 min fails
    const okChild = registry.verifyOemExchangedToken(exchanged.token, {
      now: new Date(now.getTime() + 10 * 60 * 1000),
    });
    expect(okChild.ok).toBe(true);
    const expiredChild = registry.verifyOemExchangedToken(exchanged.token, {
      now: new Date(now.getTime() + 16 * 60 * 1000),
    });
    expect(expiredChild.ok).toBe(false);
  });

  test('MCP OAuth 2.1 enforces PKCE S256, 1h TTL, and instant strongly-consistent epoch revocation', () => {
    const { registry, now } = buildFixture();
    const verifier = 'a'.repeat(48);
    const challenge = computePkceS256Challenge(verifier);

    // Wrong verifier rejected
    const badPkce = registry.issueMcpOAuthToken({
      tenantId: 'tenant_a',
      principalId: 'agent_a',
      clientId: 'claude_desktop',
      scopes: ['analytics:read', 'decisions:publish'],
      codeVerifier: 'b'.repeat(48),
      expectedCodeChallengeS256: challenge,
      now,
    });
    expect(badPkce.ok).toBe(false);

    // Correct verifier succeeds (TTL clamped to <= 3600s)
    const issued = registry.issueMcpOAuthToken({
      tenantId: 'tenant_a',
      principalId: 'agent_a',
      clientId: 'claude_desktop',
      scopes: ['analytics:read', 'decisions:publish'],
      codeVerifier: verifier,
      expectedCodeChallengeS256: challenge,
      ttlSec: 7200,
      dpopThumbprint: 'dpop_jkt_001',
      now,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const validNow = registry.verifyMcpOAuthToken(issued.accessToken, {
      dpopThumbprint: 'dpop_jkt_001',
      now: new Date(now.getTime() + 30 * 60 * 1000),
    });
    expect(validNow.ok).toBe(true);
    if (validNow.ok) expect(validNow.principal.senderConstrained).toBe(true);

    // Expired after 61 min
    const expired = registry.verifyMcpOAuthToken(issued.accessToken, {
      dpopThumbprint: 'dpop_jkt_001',
      now: new Date(now.getTime() + 61 * 60 * 1000),
    });
    expect(expired.ok).toBe(false);

    // Epoch revocation invalidates token immediately even while unexpired
    registry.bumpTenantRevocationEpoch('tenant_a');
    const revoked = registry.verifyMcpOAuthToken(issued.accessToken, {
      dpopThumbprint: 'dpop_jkt_001',
      now: new Date(now.getTime() + 1000),
    });
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.code).toBe('OAUTH_REVOCATION_EPOCH_MISMATCH');
  });

  test('R0–R5 risk gates: 404 foreign vs 403 own, R2 passkey/envelope/smoke/budget, R3 sealed, R4 two-phase undo, R5 rejects bearer tokens, audit hash chain intact', () => {
    const { registry, gateway, now, ownerSessionPrincipal } = buildFixture();
    const { rawKey: agentSecKey } = registry.issueSecretKey({
      tenantId: 'tenant_a',
      principalId: 'agent_a',
      scopes: [
        'analytics:read',
        'decisions:write',
        'decisions:publish',
        'keys:issue',
        'privacy:delete',
        'sites:manage',
      ],
      constraints: {
        senderConstrainedThumbprint: 'mtls_thumb_agent_a',
        dailyDeleteSubjectsCap: 5,
      },
      now,
    });

    const verifiedAgent = registry.verifySecretKey(agentSecKey, {
      senderThumbprint: 'mtls_thumb_agent_a',
      now,
    });
    expect(verifiedAgent.ok).toBe(true);
    if (!verifiedAgent.ok) return;
    const agentPrincipal = verifiedAgent.principal;

    // Foreign tenant -> 404 (not 403!)
    const foreignRes = gateway.authorize({
      principal: agentPrincipal,
      action: 'analytics.query',
      riskClass: 'R0',
      requiredScope: 'analytics:read',
      resource: { type: 'site', id: 'site_b1', tenantId: 'tenant_b' },
      now,
    });
    expect(foreignRes.httpStatus).toBe(404);

    // Caller-supplied foreign tenant_id override -> 404 + audit
    const spoofedRes = gateway.authorize({
      principal: agentPrincipal,
      action: 'analytics.query',
      riskClass: 'R0',
      requiredScope: 'analytics:read',
      resource: { type: 'site', id: 'site_a1', tenantId: 'tenant_a' },
      callerSuppliedTenantId: 'tenant_b',
      now,
    });
    expect(spoofedRes.httpStatus).toBe(404);

    // Own tenant missing scope -> 403
    const missingScope = gateway.authorize({
      principal: agentPrincipal,
      action: 'origin.apply',
      riskClass: 'R2',
      requiredScope: 'origin:apply',
      resource: { type: 'site', id: 'site_a1', tenantId: 'tenant_a' },
      now,
    });
    expect(missingScope.httpStatus).toBe(403);

    // R1 without idempotency key -> 400; with idempotency key -> 200
    expect(
      gateway.authorize({
        principal: agentPrincipal,
        action: 'decisions.draft',
        riskClass: 'R1',
        requiredScope: 'decisions:write',
        resource: { type: 'decision', id: 'dec_1', tenantId: 'tenant_a', siteId: 'site_a1' },
        now,
      }).httpStatus
    ).toBe(400);

    expect(
      gateway.authorize({
        principal: agentPrincipal,
        action: 'decisions.kill',
        riskClass: 'R1',
        requiredScope: 'decisions:write',
        idempotencyKey: 'idem_kill_0001',
        isFailSafeStop: true,
        resource: { type: 'decision', id: 'dec_1', tenantId: 'tenant_a', siteId: 'site_a1' },
        now,
      }).allowed
    ).toBe(true);

    // R5 with bearer API key -> REJECTED (403 + approvalUrl)
    const bearerR5 = gateway.authorize({
      principal: agentPrincipal,
      action: 'envelope.create',
      riskClass: 'R5',
      requiredScope: 'sites:manage',
      resource: { type: 'site', id: 'site_a1', tenantId: 'tenant_a', siteId: 'site_a1' },
      renderedDiff: { maxExposedUnits: 5000 },
      now,
    });
    expect(bearerR5.allowed).toBe(false);
    expect(bearerR5.httpStatus).toBe(403);
    expect(bearerR5.code).toBe('INTERACTIVE_PASSKEY_REQUIRED');
    expect(bearerR5.approvalUrl).toBeDefined();

    // Passkey approval creation with bearer token MUST fail
    const badApr = gateway.createPasskeyApproval({
      principal: agentPrincipal,
      siteId: 'site_a1',
      action: 'decisions.publish',
      renderedDiff: { variant: 'B' },
      passkeyAssertion: {
        credentialId: 'pk_1',
        userVerification: true,
        signedChallengeHash: computeActionAndDiffHash('decisions.publish', { variant: 'B' }).combinedHash,
        assertedAt: now.toISOString(),
        signatureVerified: true,
      },
      now,
    });
    expect(badApr.ok).toBe(false);

    // R2 without approval or envelope -> pending (202) + approvalUrl
    const r2NoAuth = gateway.authorize({
      principal: agentPrincipal,
      action: 'decisions.publish',
      riskClass: 'R2',
      requiredScope: 'decisions:publish',
      resource: { type: 'decision', id: 'dec_1', tenantId: 'tenant_a', siteId: 'site_a1' },
      renderedDiff: { variant: 'B' },
      now,
    });
    expect(r2NoAuth.allowed).toBe(false);
    expect(r2NoAuth.httpStatus).toBe(202);
    expect(r2NoAuth.measureStatus).toBe('pending');
    expect(r2NoAuth.approvalUrl).toBeDefined();

    // Interactive owner creates single-use passkey approval -> R2 succeeds once, replay fails!
    const diff = { variant: 'B' };
    const aprRes = gateway.createPasskeyApproval({
      principal: ownerSessionPrincipal,
      siteId: 'site_a1',
      action: 'decisions.publish',
      renderedDiff: diff,
      passkeyAssertion: {
        credentialId: 'webauthn_owner_1',
        userVerification: true,
        signedChallengeHash: computeActionAndDiffHash('decisions.publish', diff).combinedHash,
        assertedAt: now.toISOString(),
        signatureVerified: true,
      },
      now,
    });
    expect(aprRes.ok).toBe(true);
    if (!aprRes.ok) return;

    const r2Approved = gateway.authorize({
      principal: agentPrincipal,
      action: 'decisions.publish',
      riskClass: 'R2',
      requiredScope: 'decisions:publish',
      resource: { type: 'decision', id: 'dec_1', tenantId: 'tenant_a', siteId: 'site_a1' },
      renderedDiff: diff,
      passkeyApprovalId: aprRes.approval.approvalId,
      now,
    });
    expect(r2Approved.allowed).toBe(true);

    // Reusing single-use approval fails -> pending
    const r2Replay = gateway.authorize({
      principal: agentPrincipal,
      action: 'decisions.publish',
      riskClass: 'R2',
      requiredScope: 'decisions:publish',
      resource: { type: 'decision', id: 'dec_1', tenantId: 'tenant_a', siteId: 'site_a1' },
      renderedDiff: diff,
      passkeyApprovalId: aprRes.approval.approvalId,
      now,
    });
    expect(r2Replay.allowed).toBe(false);
    expect(r2Replay.httpStatus).toBe(202);

    // Register Autonomy Envelope (R5 interactive passkey)
    const envSpec = {
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      allowedActions: ['decisions.publish'],
      allowedScopes: ['decisions:publish'],
      allowedFieldProvenance: ['closed_enum', 'copy_library'],
      maxExposedUnits: 1000,
      maxConversionsAtRisk: 20,
      smokeEpsilon: 0.01,
      terminatingEvents: ['breaker_trip', 'drift_exceeded'],
      reviewBy: new Date(now.getTime() + 30 * 24 * 3600_000).toISOString(),
      allowGeneratedCopy: false,
    };
    const envReg = gateway.registerAutonomyEnvelope({
      principal: ownerSessionPrincipal,
      passkeyAssertion: {
        credentialId: 'webauthn_owner_1',
        userVerification: true,
        signedChallengeHash: computeActionAndDiffHash('envelope.create', envSpec).combinedHash,
        assertedAt: now.toISOString(),
        signatureVerified: true,
      },
      siteId: 'site_a1',
      allowedActions: ['decisions.publish'],
      allowedScopes: ['decisions:publish'],
      allowedFieldProvenance: ['closed_enum', 'copy_library'],
      maxExposedUnits: 1000,
      maxConversionsAtRisk: 20,
      smokeEpsilon: 0.01,
      terminatingEvents: ['breaker_trip', 'drift_exceeded'],
      reviewBy: envSpec.reviewBy,
      now,
    });
    expect(envReg.ok).toBe(true);
    if (!envReg.ok) return;
    expect(computeSmokeUnitsRequired(0.01)).toBe(300);

    // Before smoke phase completes (0/300), full rollout is blocked
    const beforeSmoke = gateway.authorize({
      principal: agentPrincipal,
      action: 'decisions.publish',
      riskClass: 'R2',
      requiredScope: 'decisions:publish',
      resource: { type: 'decision', id: 'dec_2', tenantId: 'tenant_a', siteId: 'site_a1' },
      autonomyEnvelopeId: envReg.envelope.envelopeId,
      fieldProvenance: ['copy_library'],
      requestedExposedUnits: 500,
      requestedConversionsAtRisk: 5,
      now,
    });
    expect(beforeSmoke.allowed).toBe(false);

    // Complete smoke phase cleanly (300 units, 0 failures)
    gateway.recordEnvelopeSmokeProgress(envReg.envelope.envelopeId, 300, 0);

    // Non-overridable safety rule: `open` field provenance ALWAYS blocked under envelope
    const openFieldBlocked = gateway.authorize({
      principal: agentPrincipal,
      action: 'decisions.publish',
      riskClass: 'R2',
      requiredScope: 'decisions:publish',
      resource: { type: 'decision', id: 'dec_2', tenantId: 'tenant_a', siteId: 'site_a1' },
      autonomyEnvelopeId: envReg.envelope.envelopeId,
      fieldProvenance: ['open'],
      requestedExposedUnits: 200,
      requestedConversionsAtRisk: 2,
      now,
    });
    expect(openFieldBlocked.allowed).toBe(false);

    // Valid in-envelope publish succeeds and deducts exposure budget
    const inEnvelopeOk = gateway.authorize({
      principal: agentPrincipal,
      action: 'decisions.publish',
      riskClass: 'R2',
      requiredScope: 'decisions:publish',
      resource: { type: 'decision', id: 'dec_2', tenantId: 'tenant_a', siteId: 'site_a1' },
      autonomyEnvelopeId: envReg.envelope.envelopeId,
      fieldProvenance: ['copy_library'],
      requestedExposedUnits: 600,
      requestedConversionsAtRisk: 10,
      now,
    });
    expect(inEnvelopeOk.allowed).toBe(true);

    // Exceeding remaining exposure budget (600 + 500 > 1000) -> blocked
    const overBudget = gateway.authorize({
      principal: agentPrincipal,
      action: 'decisions.publish',
      riskClass: 'R2',
      requiredScope: 'decisions:publish',
      resource: { type: 'decision', id: 'dec_3', tenantId: 'tenant_a', siteId: 'site_a1' },
      autonomyEnvelopeId: envReg.envelope.envelopeId,
      fieldProvenance: ['copy_library'],
      requestedExposedUnits: 500,
      requestedConversionsAtRisk: 2,
      now,
    });
    expect(overBudget.allowed).toBe(false);

    // R3 provisioning blocks self-issuance and R3–R5 scopes, allows sealed low-risk scope
    const selfIssue = gateway.authorize({
      principal: agentPrincipal,
      action: 'keys.issue',
      riskClass: 'R3',
      requiredScope: 'keys:issue',
      resource: { type: 'key', id: 'new_k', tenantId: 'tenant_a' },
      provisionTarget: {
        targetPrincipalId: agentPrincipal.principalId,
        requestedScopes: ['analytics:read'],
        issuerDelegableScopes: ['analytics:read'],
      },
      now,
    });
    expect(selfIssue.allowed).toBe(false);
    expect(selfIssue.code).toBe('R3_SELF_ISSUANCE_FORBIDDEN');

    const highRiskIssue = gateway.authorize({
      principal: agentPrincipal,
      action: 'keys.issue',
      riskClass: 'R3',
      requiredScope: 'keys:issue',
      resource: { type: 'key', id: 'new_k', tenantId: 'tenant_a' },
      provisionTarget: {
        targetPrincipalId: 'service_worker_2',
        requestedScopes: ['privacy:delete'],
        issuerDelegableScopes: ['analytics:read', 'privacy:delete'],
      },
      now,
    });
    expect(highRiskIssue.allowed).toBe(false);
    expect(highRiskIssue.code).toBe('R3_FORBIDDEN_HIGH_RISK_SCOPE');

    const sealedProvision = gateway.authorize({
      principal: agentPrincipal,
      action: 'keys.issue',
      riskClass: 'R3',
      requiredScope: 'keys:issue',
      resource: { type: 'key', id: 'new_k', tenantId: 'tenant_a' },
      provisionTarget: {
        targetPrincipalId: 'service_worker_2',
        requestedScopes: ['analytics:read', 'fusion:read'],
        issuerDelegableScopes: ['analytics:read', 'fusion:read', 'ml:read'],
      },
      now,
    });
    expect(sealedProvision.allowed).toBe(true);
    expect(sealedProvision.sealed).toBe(true);

    // R4 two-phase destruction with undo token & cancellation
    const r4 = gateway.authorize({
      principal: agentPrincipal,
      action: 'privacy.delete',
      riskClass: 'R4',
      requiredScope: 'privacy:delete',
      resource: { type: 'site', id: 'site_a1', tenantId: 'tenant_a', siteId: 'site_a1' },
      destruction: {
        scope: 'subject',
        subjectIds: ['vis_1', 'vis_2'],
        reason: 'APPI user request',
      },
      now,
    });
    expect(r4.allowed).toBe(true);
    expect(r4.httpStatus).toBe(202);
    expect(r4.destructionRequest?.undoToken).toBeDefined();
    if (r4.destructionRequest) {
      const cancelled = gateway.cancelDestruction(
        r4.destructionRequest.requestId,
        'tenant_a',
        r4.destructionRequest.undoToken,
        new Date(now.getTime() + 60_000)
      );
      expect(cancelled.ok).toBe(true);
    }

    // Verify hash-chained append-only audit log integrity across all events
    expect(gateway.auditLog.getAll().length).toBeGreaterThanOrEqual(10);
    expect(gateway.auditLog.verifyChain()).toEqual({ valid: true });
  });
});
