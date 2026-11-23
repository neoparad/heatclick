import crypto from 'node:crypto';
import {
  ALL_SCOPES,
  AuthorizationGateway,
  DpopReplayCache,
  EdgeKeyForbiddenPurposeError,
  IdentityKeyRegistry,
  InMemoryDpopReplayStore,
  MAX_OEM_EXCHANGED_TTL_SEC,
  SCOPE_PRESETS,
  computeActionAndDiffHash,
  computeJwkThumbprint,
  computePkceS256Challenge,
  computeSmokeUnitsRequired,
  createDpopProofJwt,
  generateEd25519KeyPair,
  normalizeRole,
  verifyDpopProofJwt,
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

    // Correct verifier succeeds (TTL clamped to <= 3600s) with real RFC 7638 DPoP JKT binding
    const dpopPair = crypto.generateKeyPairSync('ed25519');
    const dpopPublicJwk = dpopPair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const dpopJkt = computeJwkThumbprint(dpopPublicJwk);
    const issued = registry.issueMcpOAuthToken({
      tenantId: 'tenant_a',
      principalId: 'agent_a',
      clientId: 'claude_desktop',
      scopes: ['analytics:read', 'decisions:publish'],
      codeVerifier: verifier,
      expectedCodeChallengeS256: challenge,
      ttlSec: 7200,
      dpopThumbprint: dpopJkt,
      now,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const t30m = new Date(now.getTime() + 30 * 60 * 1000);
    const validProof = createDpopProofJwt({
      alg: 'EdDSA',
      publicJwk: dpopPublicJwk,
      privateKey: dpopPair.privateKey,
      htm: 'POST',
      htu: 'https://api.ugokilink.example/api/v1/mcp',
      accessToken: issued.accessToken,
      now: t30m,
    });
    const validNow = registry.verifyMcpOAuthToken(issued.accessToken, {
      dpopProof: validProof,
      httpMethod: 'POST',
      httpUri: 'https://api.ugokilink.example/api/v1/mcp',
      now: t30m,
    });
    expect(validNow.ok).toBe(true);
    if (validNow.ok) expect(validNow.principal.senderConstrained).toBe(true);

    // Expired after 61 min
    const t61m = new Date(now.getTime() + 61 * 60 * 1000);
    const expiredProof = createDpopProofJwt({
      alg: 'EdDSA',
      publicJwk: dpopPublicJwk,
      privateKey: dpopPair.privateKey,
      htm: 'POST',
      htu: 'https://api.ugokilink.example/api/v1/mcp',
      accessToken: issued.accessToken,
      now: t61m,
    });
    const expired = registry.verifyMcpOAuthToken(issued.accessToken, {
      dpopProof: expiredProof,
      httpMethod: 'POST',
      httpUri: 'https://api.ugokilink.example/api/v1/mcp',
      now: t61m,
    });
    expect(expired.ok).toBe(false);

    // Epoch revocation invalidates token immediately even while unexpired
    registry.bumpTenantRevocationEpoch('tenant_a');
    const t1s = new Date(now.getTime() + 1000);
    const revokeCheckProof = createDpopProofJwt({
      alg: 'EdDSA',
      publicJwk: dpopPublicJwk,
      privateKey: dpopPair.privateKey,
      htm: 'POST',
      htu: 'https://api.ugokilink.example/api/v1/mcp',
      accessToken: issued.accessToken,
      now: t1s,
    });
    const revoked = registry.verifyMcpOAuthToken(issued.accessToken, {
      dpopProof: revokeCheckProof,
      httpMethod: 'POST',
      httpUri: 'https://api.ugokilink.example/api/v1/mcp',
      now: t1s,
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
      mtlsThumbprint: 'mtls_thumb_agent_a',
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

  test('Wave 8 Regressions (C-13, H-24, L-03): R4 rejects bogus passkeyApprovalId, enforces cumulative daily subject delete cap, requires verified passkey on site/tenant wipe, cascades OEM key revocation, and bounds state maps', () => {
    const { registry, gateway, now, ownerSessionPrincipal } = buildFixture();
    const { rawKey } = registry.issueSecretKey({
      tenantId: 'tenant_a',
      principalId: 'agent_a',
      scopes: ['privacy:delete', 'sites:manage'],
      constraints: {
        senderConstrainedThumbprint: 'mtls_del',
        dailyDeleteSubjectsCap: 3,
      },
      now,
    });
    const ver = registry.verifySecretKey(rawKey, { mtlsThumbprint: 'mtls_del', now });
    expect(ver.ok).toBe(true);
    if (!ver.ok) return;

    // C-13a: Cumulative daily subject delete cap across calls (2 subjects ok, +2 subjects = 4 > 3 -> rejected unless real passkey approval!)
    const firstDel = gateway.authorize({
      principal: ver.principal,
      action: 'privacy.delete',
      riskClass: 'R4',
      requiredScope: 'privacy:delete',
      resource: { type: 'site', id: 'site_a1', tenantId: 'tenant_a', siteId: 'site_a1' },
      destruction: { scope: 'subject', subjectIds: ['u1', 'u2'], reason: 'req1' },
      now,
    });
    expect(firstDel.allowed).toBe(true);

    // Bogus passkeyApprovalId: "dummy" MUST NOT bypass daily cap!
    const bogusBypass = gateway.authorize({
      principal: ver.principal,
      action: 'privacy.delete',
      riskClass: 'R4',
      requiredScope: 'privacy:delete',
      resource: { type: 'site', id: 'site_a1', tenantId: 'tenant_a', siteId: 'site_a1' },
      passkeyApprovalId: 'dummy',
      destruction: { scope: 'subject', subjectIds: ['u3', 'u4'], reason: 'req2' },
      now,
    });
    expect(bogusBypass.allowed).toBe(false);
    expect(bogusBypass.code).toBe('APPROVAL_NOT_FOUND');

    // C-13b: Site/tenant destruction ALWAYS requires verified single-use passkey approval even without daily cap
    const siteWipeNoPasskey = gateway.authorize({
      principal: ver.principal,
      action: 'sites.destroy',
      riskClass: 'R4',
      requiredScope: 'sites:manage',
      resource: { type: 'site', id: 'site_a1', tenantId: 'tenant_a', siteId: 'site_a1' },
      destruction: { scope: 'site', reason: 'wipe attempt' },
      now,
    });
    expect(siteWipeNoPasskey.allowed).toBe(false);

    const wipeDiff = { scope: 'site', siteId: 'site_a1' };
    const wipeApr = gateway.createPasskeyApproval({
      principal: ownerSessionPrincipal,
      siteId: 'site_a1',
      action: 'sites.destroy',
      renderedDiff: wipeDiff,
      passkeyAssertion: {
        credentialId: 'pk_owner_wipe',
        userVerification: true,
        signedChallengeHash: computeActionAndDiffHash('sites.destroy', wipeDiff).combinedHash,
        assertedAt: now.toISOString(),
        signatureVerified: true,
      },
      now,
    });
    expect(wipeApr.ok).toBe(true);
    if (!wipeApr.ok) return;

    const siteWipeApproved = gateway.authorize({
      principal: ver.principal,
      action: 'sites.destroy',
      riskClass: 'R4',
      requiredScope: 'sites:manage',
      resource: { type: 'site', id: 'site_a1', tenantId: 'tenant_a', siteId: 'site_a1' },
      renderedDiff: wipeDiff,
      passkeyApprovalId: wipeApr.approval.approvalId,
      destruction: { scope: 'site', reason: 'approved wipe' },
      now,
    });
    expect(siteWipeApproved.allowed).toBe(true);

    // H-24: Revoking parent OEM key immediately invalidates already-exchanged child token!
    const { rawKey: oemKey, record: oemRec } = registry.issueOemKey({
      orgId: 'org_oem',
      managementTenantId: 'tenant_oem_mgmt',
      delegableScopes: ['analytics:read'],
      now,
    });
    const ex = registry.exchangeOemTokenForChild({
      rawOemKey: oemKey,
      childTenantId: 'tenant_oem_child',
      actorSub: 'op_1',
      requestedScopes: ['analytics:read'],
      now,
    });
    expect(ex.ok).toBe(true);
    if (!ex.ok) return;
    expect(registry.verifyOemExchangedToken(ex.token, { now }).ok).toBe(true);
    expect(registry.revokeOemKey(oemRec.keyId)).toEqual({
      revoked: true,
      invalidatedChildTokens: 1,
    });
    expect(registry.verifyOemExchangedToken(ex.token, { now }).ok).toBe(false);

    // L-03: Bounded gateway state maps evict expired/oldest entries without throwing
    const smallGateway = new AuthorizationGateway({ maxStateMapEntries: 4 });
    for (let i = 0; i < 10; i += 1) {
      const r = smallGateway.authorize({
        principal: ver.principal,
        action: 'decisions.kill',
        riskClass: 'R1',
        requiredScope: 'sites:manage',
        idempotencyKey: `idem_bound_${i}`,
        resource: { type: 'site', id: 'site_a1', tenantId: 'tenant_a', siteId: 'site_a1' },
        now: new Date(now.getTime() + i * 1000),
      });
      expect(r.allowed).toBe(true);
    }
  });

  test('Wave 9 Regressions (#2, #25): RFC 9449 DPoP proof verification (EdDSA & ES256) blocks missing proof, wrong htm/htu/iat/jti/ath & private JWK; Passkey approval verify vs consume stays non-destructive until commit', () => {
    const { registry, gateway, now, ownerSessionPrincipal } = buildFixture();

    // ---- #2: RFC 9449 DPoP Proof-of-Possession ----
    const edPair = crypto.generateKeyPairSync('ed25519');
    const edPubJwk = edPair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const edJkt = computeJwkThumbprint(edPubJwk);

    const ecPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ecPubJwk = ecPair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const ecJkt = computeJwkThumbprint(ecPubJwk);

    const verifier = 'v'.repeat(48);
    const challenge = computePkceS256Challenge(verifier);
    const issued = registry.issueMcpOAuthToken({
      tenantId: 'tenant_a',
      principalId: 'agent_a',
      clientId: 'claude_desktop',
      scopes: ['analytics:read', 'decisions:publish'],
      codeVerifier: verifier,
      expectedCodeChallengeS256: challenge,
      dpopThumbprint: edJkt,
      now,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const uri = 'https://api.ugokilink.example/api/v1/sites/site_a1/metrics';

    // (a) Missing DPoP proof (e.g., bare x-dpop-jkt without signed proof) fails closed with 401
    const noProof = registry.verifyMcpOAuthToken(issued.accessToken, { now });
    expect(noProof.ok).toBe(false);
    if (!noProof.ok) {
      expect(noProof.httpStatus).toBe(401);
      expect(noProof.code).toBe('DPOP_PROOF_REQUIRED');
    }

    // (b1) Wrong htm -> fails closed
    const badHtmProof = createDpopProofJwt({
      alg: 'EdDSA',
      publicJwk: edPubJwk,
      privateKey: edPair.privateKey,
      htm: 'DELETE',
      htu: uri,
      accessToken: issued.accessToken,
      now,
    });
    const badHtmRes = registry.verifyMcpOAuthToken(issued.accessToken, {
      dpopProof: badHtmProof,
      httpMethod: 'GET',
      httpUri: uri,
      now,
    });
    expect(badHtmRes.ok).toBe(false);
    if (!badHtmRes.ok) expect(badHtmRes.code).toBe('DPOP_HTM_MISMATCH');

    // (b2) Wrong htu -> fails closed
    const badHtuProof = createDpopProofJwt({
      alg: 'EdDSA',
      publicJwk: edPubJwk,
      privateKey: edPair.privateKey,
      htm: 'GET',
      htu: 'https://api.ugokilink.example/api/v1/sites/site_other/metrics',
      accessToken: issued.accessToken,
      now,
    });
    const badHtuRes = registry.verifyMcpOAuthToken(issued.accessToken, {
      dpopProof: badHtuProof,
      httpMethod: 'GET',
      httpUri: uri,
      now,
    });
    expect(badHtuRes.ok).toBe(false);
    if (!badHtuRes.ok) expect(badHtuRes.code).toBe('DPOP_HTU_MISMATCH');

    // (b3) Expired iat (> 60s skew) -> fails closed
    const staleProof = createDpopProofJwt({
      alg: 'EdDSA',
      publicJwk: edPubJwk,
      privateKey: edPair.privateKey,
      htm: 'GET',
      htu: uri,
      accessToken: issued.accessToken,
      iat: Math.floor(now.getTime() / 1000) - 120,
    });
    const staleRes = registry.verifyMcpOAuthToken(issued.accessToken, {
      dpopProof: staleProof,
      httpMethod: 'GET',
      httpUri: uri,
      now,
    });
    expect(staleRes.ok).toBe(false);
    if (!staleRes.ok) expect(staleRes.code).toBe('DPOP_IAT_OUT_OF_RANGE');

    // (b4) Wrong ath -> fails closed
    const badAthProof = createDpopProofJwt({
      alg: 'EdDSA',
      publicJwk: edPubJwk,
      privateKey: edPair.privateKey,
      htm: 'GET',
      htu: uri,
      accessToken: 'wrong_token_value',
      now,
    });
    const badAthRes = registry.verifyMcpOAuthToken(issued.accessToken, {
      dpopProof: badAthProof,
      httpMethod: 'GET',
      httpUri: uri,
      now,
    });
    expect(badAthRes.ok).toBe(false);
    if (!badAthRes.ok) expect(badAthRes.code).toBe('DPOP_ATH_MISMATCH');

    // (b5) Private key parameter embedded in header.jwk -> fails closed
    const privJwk = edPair.privateKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const privLeakProof = createDpopProofJwt({
      alg: 'EdDSA',
      publicJwk: privJwk,
      privateKey: edPair.privateKey,
      htm: 'GET',
      htu: uri,
      accessToken: issued.accessToken,
      now,
    });
    const privLeakRes = verifyDpopProofJwt({
      dpopProof: privLeakProof,
      httpMethod: 'GET',
      httpUri: uri,
      accessToken: issued.accessToken,
      replayCache: new DpopReplayCache(),
      now,
    });
    expect(privLeakRes.ok).toBe(false);
    if (!privLeakRes.ok) expect(privLeakRes.code).toBe('DPOP_PRIVATE_JWK_FORBIDDEN');

    // (c1) Genuine signed EdDSA DPoP proof succeeds (ignoring query string in request URI)
    const goodEdProof = createDpopProofJwt({
      alg: 'EdDSA',
      publicJwk: edPubJwk,
      privateKey: edPair.privateKey,
      htm: 'GET',
      htu: uri,
      accessToken: issued.accessToken,
      jti: 'jti_unique_ed_001',
      now,
    });
    const okEdRes = registry.verifyMcpOAuthToken(issued.accessToken, {
      dpopProof: goodEdProof,
      httpMethod: 'GET',
      httpUri: `${uri}?window=7d`,
      now,
    });
    expect(okEdRes.ok).toBe(true);
    if (okEdRes.ok) expect(okEdRes.principal.senderConstrained).toBe(true);

    // (b6) Replaying the exact same jti -> fails closed!
    const replayRes = registry.verifyMcpOAuthToken(issued.accessToken, {
      dpopProof: goodEdProof,
      httpMethod: 'GET',
      httpUri: uri,
      now,
    });
    expect(replayRes.ok).toBe(false);
    if (!replayRes.ok) expect(replayRes.code).toBe('DPOP_JTI_REPLAYED');

    // (c2) Genuine signed ES256 DPoP proof also succeeds
    const goodEcProof = createDpopProofJwt({
      alg: 'ES256',
      publicJwk: ecPubJwk,
      privateKey: ecPair.privateKey,
      htm: 'POST',
      htu: uri,
      accessToken: issued.accessToken,
      now,
    });
    const okEcRes = verifyDpopProofJwt({
      dpopProof: goodEcProof,
      httpMethod: 'POST',
      httpUri: uri,
      accessToken: issued.accessToken,
      expectedJkt: ecJkt,
      replayCache: new DpopReplayCache(),
      now,
    });
    expect(okEcRes.ok).toBe(true);

    // ---- #25: verifyPasskeyApproval (read-only) vs consumePasskeyApproval (atomic) ----
    const diff = { ruleId: 'rule_99', action: 'publish' };
    const { combinedHash } = computeActionAndDiffHash('publishDecision', diff);
    const createdApr = gateway.createPasskeyApproval({
      principal: ownerSessionPrincipal,
      siteId: 'site_a1',
      action: 'publishDecision',
      renderedDiff: diff,
      passkeyAssertion: {
        credentialId: 'webauthn_owner_25',
        userVerification: true,
        signedChallengeHash: combinedHash,
        assertedAt: now.toISOString(),
        signatureVerified: true,
      },
      now,
    });
    expect(createdApr.ok).toBe(true);
    if (!createdApr.ok) return;

    // Read-only verifyPasskeyApproval does NOT consume the approval
    const roCheck1 = gateway.verifyPasskeyApproval({
      approvalId: createdApr.approval.approvalId,
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      action: 'publishDecision',
      actionPayload: diff,
      now,
    });
    expect(roCheck1.ok).toBe(true);
    expect(createdApr.approval.consumedAt).toBeUndefined();

    // Deferred authorize() also does NOT consume the approval
    const deferredAuthz = gateway.authorize({
      principal: ownerSessionPrincipal,
      action: 'publishDecision',
      riskClass: 'R2',
      requiredScope: 'decisions:publish',
      resource: { type: 'site', id: 'site_a1', tenantId: 'tenant_a', siteId: 'site_a1' },
      renderedDiff: diff,
      passkeyApprovalId: createdApr.approval.approvalId,
      deferApprovalConsumption: true,
      now,
    });
    expect(deferredAuthz.allowed).toBe(true);
    expect(deferredAuthz.pendingApprovalConsumption?.approvalId).toBe(createdApr.approval.approvalId);
    expect(createdApr.approval.consumedAt).toBeUndefined();

    // Atomic consumePasskeyApproval consumes once and blocks second consume
    const consume1 = gateway.consumePasskeyApproval({
      approvalId: createdApr.approval.approvalId,
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      action: 'publishDecision',
      actionPayload: diff,
      now,
    });
    expect(consume1.ok).toBe(true);
    expect(createdApr.approval.consumedAt).toBeDefined();

    const consume2 = gateway.consumePasskeyApproval({
      approvalId: createdApr.approval.approvalId,
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      action: 'publishDecision',
      actionPayload: diff,
      now,
    });
    expect(consume2.ok).toBe(false);
    if (!consume2.ok) expect(consume2.code).toBe('APPROVAL_ALREADY_CONSUMED');
  });

  test('Wave 10 production DPoP requires an explicitly configured replay store', () => {
    const env = jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
    try {
      const pair = crypto.generateKeyPairSync('ed25519');
      const uri = 'https://example.test/metrics';
      const proof = createDpopProofJwt({
        alg: 'EdDSA', publicJwk: pair.publicKey.export({ format: 'jwk' }),
        privateKey: pair.privateKey, htm: 'GET', htu: uri,
      });
      expect(verifyDpopProofJwt({ dpopProof: proof, httpMethod: 'GET', httpUri: uri }))
        .toMatchObject({ ok: false, httpStatus: 503, code: 'DPOP_REPLAY_STORE_UNAVAILABLE' });
    } finally {
      env.restore();
    }
  });

  test('Wave 10 Regression (#2 Auth): shared DpopReplayStore blocks cross-instance jti replay and fails closed (503) on saturation without evicting unexpired entries', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    const sharedStore = new InMemoryDpopReplayStore({ maxEntries: 2 });

    const setupRegistry = () => {
      const reg = new IdentityKeyRegistry({
        pepperVersion: 'pep_v1',
        pepperSecret: 'shared-store-pepper-001',
        dpopReplayStore: sharedStore,
      });
      reg.registerOrg({ orgId: 'org_1', type: 'direct', name: 'Org 1', createdAt: now.toISOString() });
      reg.registerTenant({
        tenantId: 'tenant_a',
        orgId: 'org_1',
        name: 'Tenant A',
        planScopes: ALL_SCOPES,
        delegationPolicy: { allowedScopes: ALL_SCOPES, maxExchangedTokenTtlSec: 3600 },
        createdAt: now.toISOString(),
      });
      reg.registerPrincipal({
        principalId: 'agent_a',
        tenantId: 'tenant_a',
        orgId: 'org_1',
        kind: 'agent',
        role: 'operator',
        passkeyEnrolled: false,
      });
      return reg;
    };

    // Two separate IdentityKeyRegistry instances sharing ONE DpopReplayStore
    const reg1 = setupRegistry();
    const reg2 = setupRegistry();

    const edPair = crypto.generateKeyPairSync('ed25519');
    const edPubJwk = edPair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const edJkt = computeJwkThumbprint(edPubJwk);
    const uri = 'https://api.ugokilink.example/api/v1/sites/site_a1/metrics';

    const k1 = reg1.issueSecretKey({
      tenantId: 'tenant_a',
      principalId: 'agent_a',
      scopes: ['analytics:read'],
      constraints: { senderConstrainedThumbprint: edJkt },
      now,
    });
    const k2 = reg2.issueSecretKey({
      tenantId: 'tenant_a',
      principalId: 'agent_a',
      scopes: ['analytics:read'],
      constraints: { senderConstrainedThumbprint: edJkt },
      now,
    });

    // (a) Proof with jti_shared_1 succeeds on reg1; replaying same jti on reg2 is REJECTED!
    const proof1ForReg1 = createDpopProofJwt({
      alg: 'EdDSA',
      publicJwk: edPubJwk,
      privateKey: edPair.privateKey,
      htm: 'GET',
      htu: uri,
      accessToken: k1.rawKey,
      jti: 'jti_shared_1',
      now,
    });
    const res1 = reg1.verifySecretKey(k1.rawKey, {
      dpopProof: proof1ForReg1,
      httpMethod: 'GET',
      httpUri: uri,
      now,
    });
    expect(res1.ok).toBe(true);

    const proof1ReplayedOnReg2 = createDpopProofJwt({
      alg: 'EdDSA',
      publicJwk: edPubJwk,
      privateKey: edPair.privateKey,
      htm: 'GET',
      htu: uri,
      accessToken: k2.rawKey,
      jti: 'jti_shared_1',
      now,
    });
    const replayOnReg2 = reg2.verifySecretKey(k2.rawKey, {
      dpopProof: proof1ReplayedOnReg2,
      httpMethod: 'GET',
      httpUri: uri,
      now,
    });
    expect(replayOnReg2.ok).toBe(false);
    if (!replayOnReg2.ok) {
      expect(replayOnReg2.httpStatus).toBe(401);
      expect(replayOnReg2.code).toBe('DPOP_JTI_REPLAYED');
    }

    // (b) Fill the 2-entry store with a second unexpired jti (`jti_shared_2`) -> succeeds
    const proof2 = createDpopProofJwt({
      alg: 'EdDSA',
      publicJwk: edPubJwk,
      privateKey: edPair.privateKey,
      htm: 'GET',
      htu: uri,
      accessToken: k2.rawKey,
      jti: 'jti_shared_2',
      now,
    });
    expect(
      reg2.verifySecretKey(k2.rawKey, {
        dpopProof: proof2,
        httpMethod: 'GET',
        httpUri: uri,
        now,
      }).ok
    ).toBe(true);
    expect(sharedStore.size()).toBe(2);

    // 3rd distinct jti while store is full with unexpired entries MUST fail closed (HTTP 503)
    // and MUST NOT evict unexpired `jti_shared_1` or `jti_shared_2`!
    const proof3 = createDpopProofJwt({
      alg: 'EdDSA',
      publicJwk: edPubJwk,
      privateKey: edPair.privateKey,
      htm: 'GET',
      htu: uri,
      accessToken: k2.rawKey,
      jti: 'jti_shared_3',
      now,
    });
    const saturatedRes = reg2.verifySecretKey(k2.rawKey, {
      dpopProof: proof3,
      httpMethod: 'GET',
      httpUri: uri,
      now,
    });
    expect(saturatedRes.ok).toBe(false);
    if (!saturatedRes.ok) {
      expect(saturatedRes.httpStatus).toBe(503);
      expect(saturatedRes.code).toBe('DPOP_REPLAY_STORE_SATURATED');
    }

    // Confirm unexpired `jti_shared_1` was NEVER evicted and is still rejected as replayed
    const stillReplayed = reg1.verifySecretKey(k1.rawKey, {
      dpopProof: proof1ForReg1,
      httpMethod: 'GET',
      httpUri: uri,
      now,
    });
    expect(stillReplayed.ok).toBe(false);
    if (!stillReplayed.ok) {
      expect(stillReplayed.httpStatus).toBe(401);
      expect(stillReplayed.code).toBe('DPOP_JTI_REPLAYED');
    }
  });
});
