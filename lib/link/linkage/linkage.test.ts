import {
  ALL_SCOPES,
  computeActionAndDiffHash,
  computePkceS256Challenge,
  type VerifiedPrincipal,
} from '@/lib/link/auth';
import {
  LinkGrantService,
  formatDnsTxtProofRecord,
  isPrivateOrReservedIp,
  type CrawlAccountSummary,
} from './index';

const OWNER_SESSION: VerifiedPrincipal = {
  credentialKind: 'session_cookie',
  credentialId: 'sess_owner_a',
  tenantId: 'tenant_a',
  orgId: 'org_a',
  allowedSiteIds: null,
  principalKind: 'human',
  principalId: 'owner_a',
  role: 'owner',
  effectiveScopes: new Set(ALL_SCOPES),
  senderConstrained: true,
  passkeyVerified: true,
};

const CRAWL_ACCOUNT: CrawlAccountSummary = {
  crawlAccountRef: 'crawl_usr_9981',
  label: 'Acme SEO Team',
  verifiedEmailDomain: 'example-a.jp',
  accountAgeDays: 420,
  delegatedMonthlyCreditCap: 50000,
  plan: 'pro',
};

function makeActivationPasskey(grant: {
  grantId: string;
  siteId: string;
  crawlAccountRef?: string;
  hostPatterns: ReadonlyArray<string>;
  scopes: ReadonlyArray<string>;
  caps: unknown;
}, now: Date) {
  const diff = {
    grantId: grant.grantId,
    siteId: grant.siteId,
    crawlAccountRef: grant.crawlAccountRef,
    hostPatterns: grant.hostPatterns,
    scopes: grant.scopes,
    caps: grant.caps,
  };
  return {
    credentialId: 'webauthn_owner_a',
    userVerification: true,
    signedChallengeHash: computeActionAndDiffHash('link_grant.activate', diff).combinedHash,
    assertedAt: now.toISOString(),
    signatureVerified: true,
  };
}

describe('lib/link/linkage — Explicit N:M Link Grants, 3 Binding Paths, Ed25519 Assertions & Recheck/Revoke', () => {
  test('strictly forbids automatic linking on matching verified domains alone', () => {
    const svc = new LinkGrantService();
    const res = svc.attemptAutoLinkByMatchingDomain({
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      crawlAccountRef: 'crawl_usr_9981',
      host: 'example-a.jp',
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('AUTO_LINK_FORBIDDEN');
  });

  test('SSRF guard blocks private/metadata IPs and >1 redirects on well-known file proofs', () => {
    expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('10.0.0.5')).toBe(true);
    expect(isPrivateOrReservedIp('192.168.1.10')).toBe(true);
    expect(isPrivateOrReservedIp('93.184.216.34')).toBe(false);

    const svc = new LinkGrantService();
    const now = new Date('2026-11-20T12:00:00Z');
    const draft = svc.createDraftGrant({
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      primaryHost: 'example-a.jp',
      hostPatterns: ['example-a.jp', '*.example-a.jp'],
      payer: 'crawl_account',
      caps: { monthlyCreditsCap: 20000, dailyExternalSpendCapUsd: 25, maxConcurrentJobs: 5, maxUrlsPerInlineJob: 50 },
      bindingPath: 'pairing',
      reviewBy: '2027-05-20T00:00:00Z',
      now,
    });

    const metadataSsrf = svc.recordSideDomainProof({
      grantId: draft.grantId,
      side: 'ugoki',
      check: {
        host: 'example-a.jp',
        method: 'well_known_file',
        outcome: 'verified',
        observedToken: draft.proofToken,
        checkedAt: now.toISOString(),
        resolvedIp: '169.254.169.254',
      },
    });
    expect(metadataSsrf.ok).toBe(false);
    expect(metadataSsrf.code).toBe('SSRF_GUARD_BLOCKED');

    const tooManyRedirects = svc.recordSideDomainProof({
      grantId: draft.grantId,
      side: 'ugoki',
      check: {
        host: 'example-a.jp',
        method: 'well_known_file',
        outcome: 'verified',
        observedToken: draft.proofToken,
        checkedAt: now.toISOString(),
        resolvedIp: '93.184.216.34',
        redirectHops: 2,
      },
    });
    expect(tooManyRedirects.ok).toBe(false);
  });

  test('Binding path 1 (pairing): 128-bit single-use code + dual <24h proofs + R5 passkey -> active epoch=1', () => {
    const svc = new LinkGrantService();
    const now = new Date('2026-11-20T12:00:00Z');
    const draft = svc.createDraftGrant({
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      primaryHost: 'example-a.jp',
      hostPatterns: ['example-a.jp', '*.example-a.jp'],
      payer: 'crawl_account',
      caps: { monthlyCreditsCap: 20000, dailyExternalSpendCapUsd: 25, maxConcurrentJobs: 5, maxUrlsPerInlineJob: 50 },
      bindingPath: 'pairing',
      reviewBy: '2027-05-20T00:00:00Z',
      now,
    });

    const dnsRecord = formatDnsTxtProofRecord('example-a.jp', draft.proofToken);
    expect(dnsRecord.recordName).toBe('_ugokilink.example-a.jp');

    // Cannot mint pairing code before UGOKI verifies domain proof
    expect(svc.mintPairingCode(draft.grantId, now).ok).toBe(false);

    // UGOKI verifies DNS TXT proof
    expect(
      svc.recordSideDomainProof({
        grantId: draft.grantId,
        side: 'ugoki',
        check: {
          host: 'example-a.jp',
          method: 'dns_txt',
          outcome: 'verified',
          observedToken: draft.proofToken,
          checkedAt: now.toISOString(),
        },
      }).ok
    ).toBe(true);

    // Mint pairing code -> CRAWL redeems once; second redemption rejected
    const minted = svc.mintPairingCode(draft.grantId, now);
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const redeemed = svc.redeemPairingCode({
      pairingCode: minted.pairingCode,
      crawlAccount: CRAWL_ACCOUNT,
      crawlProofCheck: {
        host: 'example-a.jp',
        method: 'dns_txt',
        outcome: 'verified',
        observedToken: draft.proofToken,
        checkedAt: now.toISOString(),
      },
      now: new Date(now.getTime() + 60_000),
    });
    expect(redeemed.ok).toBe(true);
    expect(draft.state).toBe('pending_approval');

    // Replay pairing code fails (single-use)
    const replayCode = svc.redeemPairingCode({
      pairingCode: minted.pairingCode,
      crawlAccount: CRAWL_ACCOUNT,
      crawlProofCheck: {
        host: 'example-a.jp',
        method: 'dns_txt',
        outcome: 'verified',
        observedToken: draft.proofToken,
        checkedAt: now.toISOString(),
      },
      now: new Date(now.getTime() + 90_000),
    });
    expect(replayCode.ok).toBe(false);
    if (!replayCode.ok) expect(replayCode.code).toBe('PAIRING_CODE_ALREADY_USED');

    // Bearer API key CANNOT activate grant (R5 passkey required)
    const bearerActivate = svc.approveAndActivateGrant({
      grantId: draft.grantId,
      principal: { ...OWNER_SESSION, credentialKind: 'ugk_sec' },
      passkeyAssertion: makeActivationPasskey(draft, now),
      now,
    });
    expect(bearerActivate.ok).toBe(false);
    if (!bearerActivate.ok) expect(bearerActivate.httpStatus).toBe(403);

    // Stale proof (>24h) blocks activation
    const staleActivate = svc.approveAndActivateGrant({
      grantId: draft.grantId,
      principal: OWNER_SESSION,
      passkeyAssertion: makeActivationPasskey(draft, new Date(now.getTime() + 25 * 3600_000)),
      now: new Date(now.getTime() + 25 * 3600_000),
    });
    expect(staleActivate.ok).toBe(false);
    if (!staleActivate.ok) expect(staleActivate.code).toBe('BOTH_DOMAIN_PROOFS_MUST_BE_UNDER_24H');

    // Valid interactive passkey activation succeeds -> state=active, epoch=1
    const activated = svc.approveAndActivateGrant({
      grantId: draft.grantId,
      principal: OWNER_SESSION,
      passkeyAssertion: makeActivationPasskey(draft, now),
      now,
    });
    expect(activated.ok).toBe(true);
    expect(draft.state).toBe('active');
    expect(draft.epoch).toBe(1);
  });

  test('Binding paths 2 (OAuth PKCE federation.link) and 3 (provisioned ugoki_ledger) complete cleanly', () => {
    const svc = new LinkGrantService();
    const now = new Date('2026-11-20T12:00:00Z');

    // Path 2: OAuth PKCE
    const oauthGrant = svc.createDraftGrant({
      tenantId: 'tenant_a',
      siteId: 'site_a2',
      primaryHost: 'shop.example-a.jp',
      hostPatterns: ['shop.example-a.jp'],
      payer: 'crawl_account',
      caps: { monthlyCreditsCap: 10000, dailyExternalSpendCapUsd: 10, maxConcurrentJobs: 3, maxUrlsPerInlineJob: 50 },
      bindingPath: 'oauth',
      reviewBy: '2027-05-20T00:00:00Z',
      now,
    });
    svc.recordSideDomainProof({
      grantId: oauthGrant.grantId,
      side: 'ugoki',
      check: { host: 'shop.example-a.jp', method: 'dns_txt', outcome: 'verified', observedToken: oauthGrant.proofToken, checkedAt: now.toISOString() },
    });
    const verifier = 'x'.repeat(50);
    const oauthRes = svc.completeOAuthBinding({
      grantId: oauthGrant.grantId,
      grantedOAuthScope: 'federation.link',
      codeVerifier: verifier,
      expectedCodeChallengeS256: computePkceS256Challenge(verifier),
      crawlAccount: CRAWL_ACCOUNT,
      crawlProofCheck: { host: 'shop.example-a.jp', method: 'dns_txt', outcome: 'verified', observedToken: oauthGrant.proofToken, checkedAt: now.toISOString() },
      consentConfirmed: true,
    });
    expect(oauthRes.ok).toBe(true);
    expect(
      svc.approveAndActivateGrant({
        grantId: oauthGrant.grantId,
        principal: OWNER_SESSION,
        passkeyAssertion: makeActivationPasskey(oauthGrant, now),
        now,
      }).ok
    ).toBe(true);

    // Path 3: Provisioned federated account (`payer = ugoki_ledger`)
    const provGrant = svc.createDraftGrant({
      tenantId: 'tenant_a',
      siteId: 'site_a3',
      primaryHost: 'blog.example-a.jp',
      hostPatterns: ['blog.example-a.jp'],
      payer: 'ugoki_ledger',
      caps: { monthlyCreditsCap: 30000, dailyExternalSpendCapUsd: 50, maxConcurrentJobs: 5, maxUrlsPerInlineJob: 50 },
      bindingPath: 'provisioned',
      reviewBy: '2027-05-20T00:00:00Z',
      now,
    });
    svc.recordSideDomainProof({
      grantId: provGrant.grantId,
      side: 'ugoki',
      check: { host: 'blog.example-a.jp', method: 'dns_txt', outcome: 'verified', observedToken: provGrant.proofToken, checkedAt: now.toISOString() },
    });
    const provRes = svc.completeProvisionedBinding({
      grantId: provGrant.grantId,
      provisionedCrawlAccountRef: 'crawl_fed_001',
      crawlProofCheck: { host: 'blog.example-a.jp', method: 'dns_txt', outcome: 'verified', observedToken: provGrant.proofToken, checkedAt: now.toISOString() },
      now,
    });
    expect(provRes.ok).toBe(true);
    expect(provGrant.crawlAccountSummary?.plan).toBe('federated');
    expect(
      svc.approveAndActivateGrant({
        grantId: provGrant.grantId,
        principal: OWNER_SESSION,
        passkeyAssertion: makeActivationPasskey(provGrant, now),
        now,
      }).ok
    ).toBe(true);
  });

  test('Per-call Ed25519 assertion resolves owner from grant, blocks caller owner IDs, replay JTIs, body tampering, and out-of-grant hosts', () => {
    const svc = new LinkGrantService();
    const now = new Date('2026-11-20T12:00:00Z');
    const grant = svc.createDraftGrant({
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      primaryHost: 'example-a.jp',
      hostPatterns: ['example-a.jp', '*.example-a.jp'],
      scopes: ['structure.read', 'render.run'],
      payer: 'ugoki_ledger',
      caps: { monthlyCreditsCap: 10000, dailyExternalSpendCapUsd: 10, maxConcurrentJobs: 2, maxUrlsPerInlineJob: 50 },
      bindingPath: 'provisioned',
      reviewBy: '2027-05-20T00:00:00Z',
      now,
    });
    svc.recordSideDomainProof({
      grantId: grant.grantId,
      side: 'ugoki',
      check: { host: 'example-a.jp', method: 'dns_txt', outcome: 'verified', observedToken: grant.proofToken, checkedAt: now.toISOString() },
    });
    svc.completeProvisionedBinding({
      grantId: grant.grantId,
      provisionedCrawlAccountRef: 'crawl_fed_a1',
      crawlProofCheck: { host: 'example-a.jp', method: 'dns_txt', outcome: 'verified', observedToken: grant.proofToken, checkedAt: now.toISOString() },
    });
    svc.approveAndActivateGrant({
      grantId: grant.grantId,
      principal: OWNER_SESSION,
      passkeyAssertion: makeActivationPasskey(grant, now),
      now,
    });

    const body = { urls: ['https://blog.example-a.jp/post-1'] };
    const signed = svc.signFederationAssertion({
      grantId: grant.grantId,
      method: 'POST',
      path: '/federation/v1/jobs',
      body,
      ttlSec: 300,
      now,
    });

    // Rejects caller-supplied tenant_id / user_id
    const bolaAttempt = svc.verifyFederationCall({
      assertionToken: signed.token,
      method: 'POST',
      path: '/federation/v1/jobs',
      body,
      targetHost: 'blog.example-a.jp',
      callerSuppliedOwnerIds: { tenantId: 'tenant_b' },
      now,
    });
    expect(bolaAttempt.ok).toBe(false);
    if (!bolaAttempt.ok) expect(bolaAttempt.code).toBe('CALLER_OWNER_ID_FORBIDDEN');

    // Rejects modified request body (req_hash mismatch)
    const tamperedBody = svc.verifyFederationCall({
      assertionToken: signed.token,
      method: 'POST',
      path: '/federation/v1/jobs',
      body: { urls: ['https://evil.example.com/'] },
      targetHost: 'blog.example-a.jp',
      now,
    });
    expect(tamperedBody.ok).toBe(false);
    if (!tamperedBody.ok) expect(tamperedBody.code).toBe('ASSERTION_REQ_HASH_MISMATCH');

    // Rejects out-of-grant host
    const badHost = svc.verifyFederationCall({
      assertionToken: signed.token,
      method: 'POST',
      path: '/federation/v1/jobs',
      body,
      targetHost: 'other-domain.com',
      now,
    });
    expect(badHost.ok).toBe(false);
    if (!badHost.ok) expect(badHost.code).toBe('HOST_OUT_OF_GRANT');

    // Valid call resolves (tenantId, siteId, crawlAccountRef) solely from grant
    const okCall = svc.verifyFederationCall({
      assertionToken: signed.token,
      method: 'POST',
      path: '/federation/v1/jobs',
      body,
      targetHost: 'blog.example-a.jp',
      requiredScope: 'render.run',
      now,
    });
    expect(okCall.ok).toBe(true);
    if (okCall.ok) {
      expect(okCall.tenantId).toBe('tenant_a');
      expect(okCall.siteId).toBe('site_a1');
      expect(okCall.crawlAccountRef).toBe('crawl_fed_a1');
    }

    // Replaying exact same assertion is rejected by JTI cache
    const replay = svc.verifyFederationCall({
      assertionToken: signed.token,
      method: 'POST',
      path: '/federation/v1/jobs',
      body,
      targetHost: 'blog.example-a.jp',
      now: new Date(now.getTime() + 1000),
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.code).toBe('ASSERTION_REPLAY_DETECTED');
  });

  test('Hourly recheck state machine (2 consecutive authoritative negatives -> suspended; transient -> 72h grace) & two-sided revoke with signed purge receipt', () => {
    const svc = new LinkGrantService();
    const t0 = new Date('2026-11-20T12:00:00Z');
    const grant = svc.createDraftGrant({
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      primaryHost: 'example-a.jp',
      hostPatterns: ['example-a.jp'],
      payer: 'ugoki_ledger',
      caps: { monthlyCreditsCap: 10000, dailyExternalSpendCapUsd: 10, maxConcurrentJobs: 2, maxUrlsPerInlineJob: 50 },
      bindingPath: 'provisioned',
      reviewBy: '2027-05-20T00:00:00Z',
      now: t0,
    });
    svc.recordSideDomainProof({
      grantId: grant.grantId,
      side: 'ugoki',
      check: { host: 'example-a.jp', method: 'dns_txt', outcome: 'verified', observedToken: grant.proofToken, checkedAt: t0.toISOString() },
    });
    svc.completeProvisionedBinding({
      grantId: grant.grantId,
      provisionedCrawlAccountRef: 'crawl_fed_a1',
      crawlProofCheck: { host: 'example-a.jp', method: 'dns_txt', outcome: 'verified', observedToken: grant.proofToken, checkedAt: t0.toISOString() },
    });
    svc.approveAndActivateGrant({
      grantId: grant.grantId,
      principal: OWNER_SESSION,
      passkeyAssertion: makeActivationPasskey(grant, t0),
      now: t0,
    });

    // Transient DNS failure stays active within 72h grace
    const tr1 = svc.processHourlyRecheck(
      grant.grantId,
      { host: 'example-a.jp', method: 'dns_txt', outcome: 'transient_error', checkedAt: new Date(t0.getTime() + 3600_000).toISOString() },
      new Date(t0.getTime() + 3600_000)
    );
    expect(tr1.nextState).toBe('active');

    const trAt70h = svc.processHourlyRecheck(
      grant.grantId,
      { host: 'example-a.jp', method: 'dns_txt', outcome: 'transient_error', checkedAt: new Date(t0.getTime() + 70 * 3600_000).toISOString() },
      new Date(t0.getTime() + 70 * 3600_000)
    );
    expect(trAt70h.nextState).toBe('active');

    // Beyond 72h transient -> suspended
    const trAt74h = svc.processHourlyRecheck(
      grant.grantId,
      { host: 'example-a.jp', method: 'dns_txt', outcome: 'transient_error', checkedAt: new Date(t0.getTime() + 74 * 3600_000).toISOString() },
      new Date(t0.getTime() + 74 * 3600_000)
    );
    expect(trAt74h.nextState).toBe('suspended');

    // Valid proof recovers suspended grant -> active
    const recovered = svc.processHourlyRecheck(
      grant.grantId,
      { host: 'example-a.jp', method: 'dns_txt', outcome: 'verified', observedToken: grant.proofToken, checkedAt: new Date(t0.getTime() + 75 * 3600_000).toISOString() },
      new Date(t0.getTime() + 75 * 3600_000)
    );
    expect(recovered.nextState).toBe('active');

    // 1st authoritative negative -> still active; 2nd consecutive -> suspended
    const neg1 = svc.processHourlyRecheck(
      grant.grantId,
      { host: 'example-a.jp', method: 'dns_txt', outcome: 'authoritative_negative', checkedAt: new Date(t0.getTime() + 76 * 3600_000).toISOString() },
      new Date(t0.getTime() + 76 * 3600_000)
    );
    expect(neg1.nextState).toBe('active');

    const neg2 = svc.processHourlyRecheck(
      grant.grantId,
      { host: 'example-a.jp', method: 'dns_txt', outcome: 'authoritative_negative', checkedAt: new Date(t0.getTime() + 77 * 3600_000).toISOString() },
      new Date(t0.getTime() + 77 * 3600_000)
    );
    expect(neg2.nextState).toBe('suspended');

    // Sign assertion before re-activating & revoking to test epoch invalidation
    svc.processHourlyRecheck(
      grant.grantId,
      { host: 'example-a.jp', method: 'dns_txt', outcome: 'verified', observedToken: grant.proofToken, checkedAt: new Date(t0.getTime() + 78 * 3600_000).toISOString() },
      new Date(t0.getTime() + 78 * 3600_000)
    );
    const tRev = new Date(t0.getTime() + 78 * 3600_000);
    const preRevokeAssertion = svc.signFederationAssertion({
      grantId: grant.grantId,
      method: 'GET',
      path: '/federation/v1/snapshots',
      now: tRev,
    });

    // Either side (e.g. CRAWL) revokes -> bumps epoch, issues Ed25519-signed purge receipt, immediately invalidates old assertion
    const receipt = svc.revokeGrant({
      grantId: grant.grantId,
      revokedBy: 'crawl',
      reason: 'Customer unlinked in CRAWL console',
      now: tRev,
    });
    expect(grant.state).toBe('revoked');
    expect(grant.epoch).toBe(2);
    expect(receipt.purgedDatasets.length).toBeGreaterThan(0);
    expect(svc.verifyPurgeReceipt(receipt)).toBe(true);

    const postRevokeVerify = svc.verifyFederationCall({
      assertionToken: preRevokeAssertion.token,
      method: 'GET',
      path: '/federation/v1/snapshots',
      now: new Date(tRev.getTime() + 1000),
    });
    expect(postRevokeVerify.ok).toBe(false);
  });

  test('Wave 8 Regressions (H-17, H-24): blocks IPv4-mapped IPv6 hex/NAT64/6to4/octal/integer SSRF + missing well_known_file IP, and blocks stale/replayed Passkey grant activations', () => {
    // H-17: Canonical 128-bit IPv4/IPv6 SSRF parser
    expect(isPrivateOrReservedIp('::ffff:7f00:1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:a9fe:a9fe')).toBe(true);
    expect(isPrivateOrReservedIp('0:0:0:0:0:ffff:7f00:1')).toBe(true);
    expect(isPrivateOrReservedIp('64:ff9b::169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('2002:7f00:0001::1')).toBe(true);
    expect(isPrivateOrReservedIp('0177.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('2130706433')).toBe(true);
    expect(isPrivateOrReservedIp('0x7f000001')).toBe(true);
    expect(isPrivateOrReservedIp('93.184.216.34')).toBe(false);
    expect(isPrivateOrReservedIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);

    const svc = new LinkGrantService();
    const now = new Date('2026-11-20T12:00:00Z');
    const grant = svc.createDraftGrant({
      tenantId: 'tenant_a',
      siteId: 'site_ssrf',
      primaryHost: 'example-a.jp',
      hostPatterns: ['example-a.jp'],
      payer: 'ugoki_ledger',
      caps: { monthlyCreditsCap: 10000, dailyExternalSpendCapUsd: 10, maxConcurrentJobs: 2, maxUrlsPerInlineJob: 50 },
      bindingPath: 'provisioned',
      reviewBy: '2027-05-20T00:00:00Z',
      now,
    });

    // well_known_file WITHOUT resolvedIp must fail closed!
    const missingIpRes = svc.recordSideDomainProof({
      grantId: grant.grantId,
      side: 'ugoki',
      check: {
        host: 'example-a.jp',
        method: 'well_known_file',
        outcome: 'verified',
        observedToken: grant.proofToken,
        checkedAt: now.toISOString(),
      },
    });
    expect(missingIpRes.ok).toBe(false);
    if (!missingIpRes.ok) expect(missingIpRes.code).toBe('SSRF_GUARD_BLOCKED');

    // Hex IPv4-mapped IPv6 metadata IP must fail closed!
    const mappedIpRes = svc.recordSideDomainProof({
      grantId: grant.grantId,
      side: 'ugoki',
      check: {
        host: 'example-a.jp',
        method: 'well_known_file',
        outcome: 'verified',
        observedToken: grant.proofToken,
        resolvedIp: '::ffff:a9fe:a9fe',
        checkedAt: now.toISOString(),
      },
    });
    expect(mappedIpRes.ok).toBe(false);

    // Valid public IP succeeds
    expect(
      svc.recordSideDomainProof({
        grantId: grant.grantId,
        side: 'ugoki',
        check: {
          host: 'example-a.jp',
          method: 'well_known_file',
          outcome: 'verified',
          observedToken: grant.proofToken,
          resolvedIp: '93.184.216.34',
          checkedAt: now.toISOString(),
        },
      }).ok
    ).toBe(true);
    svc.completeProvisionedBinding({
      grantId: grant.grantId,
      provisionedCrawlAccountRef: 'crawl_fed_ssrf',
      crawlProofCheck: {
        host: 'example-a.jp',
        method: 'dns_txt',
        outcome: 'verified',
        observedToken: grant.proofToken,
        checkedAt: now.toISOString(),
      },
    });

    // H-24: Stale (> 5 min) Passkey assertion rejected
    const stalePk = makeActivationPasskey(grant, new Date(now.getTime() - 10 * 60_000));
    const staleRes = svc.approveAndActivateGrant({
      grantId: grant.grantId,
      principal: OWNER_SESSION,
      passkeyAssertion: stalePk,
      now,
    });
    expect(staleRes.ok).toBe(false);
    if (!staleRes.ok) expect(staleRes.code).toBe('PASSKEY_ASSERTION_STALE');

    // Fresh Passkey succeeds once, replay fails
    const freshPk = makeActivationPasskey(grant, now);
    expect(
      svc.approveAndActivateGrant({
        grantId: grant.grantId,
        principal: OWNER_SESSION,
        passkeyAssertion: freshPk,
        now,
      }).ok
    ).toBe(true);

    // Replaying exact assertion on another grant (if signedChallengeHash/credentialId reused) is tracked
    const replayAttempt = svc.approveAndActivateGrant({
      grantId: grant.grantId,
      principal: OWNER_SESSION,
      passkeyAssertion: freshPk,
      now,
    });
    expect(replayAttempt.ok).toBe(false);
  });
});
