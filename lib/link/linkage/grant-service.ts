/**
 * UGOKI LINK v2 — Link Grant Service (Explicit N:M Pairing, Shared Domain Proof,
 * Ed25519 Per-Call Assertions, Hourly Re-Verification & Two-Sided Revocation)
 *
 * Key security invariants (`surface-final.md` §5.2, §7.1, §9.1):
 *   1. NEVER auto-link accounts solely because both verified the same domain.
 *   2. Domain proof (`_ugokilink.<host>` DNS TXT or `/.well-known/ugokilink-verification.txt`)
 *      must be independently verified < 24 h by BOTH UGOKI and CRAWL under SSRF guard.
 *   3. Supports all 3 binding paths: `pairing` (single-use 128-bit code, 10m TTL, max 7d pending),
 *      `oauth` (PKCE S256, `federation.link`), and `provisioned` (`federated` account).
 *   4. Per-call Ed25519 assertion `{iss, aud, sub: grant_id, epoch, exp <= 300s, jti, req_hash}`
 *      with JTI replay cache; owner `(tenant_id, site_id, crawl_account_ref)` resolved strictly
 *      from the grant record (caller-supplied owner IDs rejected!).
 *   5. Hourly recheck: 2 consecutive authoritative negatives -> `suspended`; transient errors -> 72h grace.
 *   6. Either side revoke bumps `epoch`, invalidates assertions immediately (<= 300s SLA),
 *      and emits an Ed25519-signed purge receipt.
 */

import crypto from 'node:crypto';
import { canonicalJson, sha256Hex } from '@/packages/contract/response';
import {
  generateEd25519KeyPair,
  verifyPkceS256,
  type Ed25519KeyPair,
  type PasskeyAssertionInput,
  type VerifiedPrincipal,
  computeActionAndDiffHash,
} from '@/lib/link/auth';
import type {
  BindingPath,
  CrawlAccountSummary,
  DomainProofCheckResult,
  FederationAssertionPayload,
  FederationScope,
  LinkGrant,
  LinkGrantCaps,
  LinkPayer,
  PairingCodeRecord,
  RecheckReport,
  SignedPurgeReceipt,
  VerifyFederationCallResult,
} from './types';

// =========================================================================
// 1. Constants & Domain / SSRF Guards
// =========================================================================

/** Freshness ceiling for independent domain proofs at activation: 24 hours. */
export const PROOF_FRESHNESS_MAX_MS = 24 * 60 * 60 * 1000;

/** Pairing code TTL: 10 minutes (re-mintable while pending up to 7 days). */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const PAIRING_PENDING_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** Max Ed25519 federation assertion TTL: 300 seconds (`surface-final.md` §5.2). */
export const MAX_FEDERATION_ASSERTION_TTL_SEC = 300;

/** Authoritative negative threshold for suspension: 2 consecutive checks. */
export const AUTHORITATIVE_NEGATIVE_SUSPEND_THRESHOLD = 2;

/** Grace period for transient DNS / lookup failures: 72 hours. */
export const TRANSIENT_ERROR_GRACE_MS = 72 * 60 * 60 * 1000;

/** Revocation federation propagation SLA: 300 seconds. */
export const REVOCATION_FEDERATION_SLA_MS = 300 * 1000;

export function formatDnsTxtProofRecord(host: string, proofToken: string): {
  readonly recordName: string;
  readonly recordType: 'TXT';
  readonly recordValue: string;
  readonly recommendedTtlSec: number;
} {
  const normalizedHost = host.trim().toLowerCase().replace(/\.$/, '');
  return {
    recordName: `_ugokilink.${normalizedHost}`,
    recordType: 'TXT',
    recordValue: `v=ugokilink1; token=${proofToken}`,
    recommendedTtlSec: 300,
  };
}

export function formatWellKnownProofPath(): string {
  return '/.well-known/ugokilink-verification.txt';
}

/**
 * SSRF IP guard for well-known file proof checks (`surface-final.md` §7.1 #5 & §9.1).
 * Rejects loopback, private RFC1918, link-local / cloud metadata, and IPv6 local addresses.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase();
  if (
    trimmed === 'localhost' ||
    trimmed === '::1' ||
    trimmed.startsWith('fe80:') ||
    trimmed.startsWith('fc') ||
    trimmed.startsWith('fd') ||
    trimmed === '0.0.0.0'
  ) {
    return true;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(trimmed);
  if (!m) return true; // Fail closed on unparseable IP
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // AWS/GCP/Cloudflare metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 0 || a >= 224) return true;
  return false;
}

export function validateProofCheckAgainstSsrf(check: DomainProofCheckResult): {
  readonly ok: boolean;
  readonly reason?: string;
} {
  if (check.method === 'well_known_file') {
    if (check.redirectHops !== undefined && check.redirectHops > 1) {
      return {
        ok: false,
        reason: 'SSRF guard: at most 1 same-registrable-domain redirect is allowed for well-known file proof',
      };
    }
    if (check.resolvedIp && isPrivateOrReservedIp(check.resolvedIp)) {
      return {
        ok: false,
        reason: `SSRF guard: resolved IP ${check.resolvedIp} is private/reserved`,
      };
    }
  }
  return { ok: true };
}

export function isHostMatchedByPatterns(host: string, patterns: ReadonlyArray<string>): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '');
  for (const rawPattern of patterns) {
    const p = rawPattern.trim().toLowerCase().replace(/\.$/, '');
    if (p === normalized) return true;
    if (p.startsWith('*.')) {
      const suffix = p.slice(2);
      if (normalized.endsWith(`.${suffix}`) && normalized.length > suffix.length + 1) {
        return true;
      }
    }
  }
  return false;
}

export function computeFederationRequestHash(params: {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}): string {
  const canonicalBody = params.body === undefined ? '' : canonicalJson(params.body);
  return sha256Hex(`${params.method.toUpperCase()}\n${params.path}\n${canonicalBody}`);
}

// =========================================================================
// 2. LinkGrantService
// =========================================================================

export interface LinkGrantServiceOptions {
  readonly ugokiSigningPair?: Ed25519KeyPair;
  readonly crawlSigningPair?: Ed25519KeyPair;
  readonly ugokiIssuer?: string;
  readonly crawlAudience?: string;
}

export class LinkGrantService {
  private readonly grants = new Map<string, LinkGrant>();
  private readonly pairingCodes = new Map<string, PairingCodeRecord>();
  private readonly seenJtis = new Map<string, number>(); // jti -> expMs

  public readonly ugokiSigningPair: Ed25519KeyPair;
  public readonly crawlSigningPair: Ed25519KeyPair;
  private readonly ugokiIssuer: string;
  private readonly crawlAudience: string;

  constructor(options: LinkGrantServiceOptions = {}) {
    this.ugokiSigningPair = options.ugokiSigningPair ?? generateEd25519KeyPair('ugoki_fed_v1');
    this.crawlSigningPair = options.crawlSigningPair ?? generateEd25519KeyPair('crawl_fed_v1');
    this.ugokiIssuer = options.ugokiIssuer ?? 'https://api.ugokilink.internal';
    this.crawlAudience = options.crawlAudience ?? 'https://crawl.ugokilink.internal/federation/v1';
  }

  public getGrant(grantId: string): LinkGrant | undefined {
    return this.grants.get(grantId);
  }

  public listGrantsForSite(tenantId: string, siteId: string): ReadonlyArray<LinkGrant> {
    return [...this.grants.values()].filter(
      (g) => g.tenantId === tenantId && g.siteId === siteId
    );
  }

  /**
   * Explicitly forbids automatic linking on matching verified domains (`surface-final.md` §5.2 & §11.2).
   */
  public attemptAutoLinkByMatchingDomain(_params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly crawlAccountRef: string;
    readonly host: string;
  }): { readonly ok: false; readonly code: 'AUTO_LINK_FORBIDDEN'; readonly reason: string } {
    return {
      ok: false,
      code: 'AUTO_LINK_FORBIDDEN',
      reason:
        'UGOKI and CRAWL must NEVER auto-link solely on matching verified domains; an explicit two-sided LinkGrant with passkey approval is mandatory',
    };
  }

  // ---- Step 1: Create Draft Link Grant (R5 initiated by UGOKI owner/admin) ----

  public createDraftGrant(params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly primaryHost: string;
    readonly hostPatterns: ReadonlyArray<string>;
    readonly scopes?: ReadonlyArray<FederationScope>;
    readonly payer: LinkPayer;
    readonly caps: LinkGrantCaps;
    readonly bindingPath: BindingPath;
    readonly purgeOnRevoke?: boolean;
    readonly reviewBy: string;
    readonly now?: Date;
  }): LinkGrant {
    const now = params.now ?? new Date();
    const grantId = `lgr_${crypto.randomBytes(10).toString('hex')}`;
    const proofToken = `ugk_proof_${crypto.randomBytes(16).toString('hex')}`;

    const grant: LinkGrant = {
      grantId,
      tenantId: params.tenantId,
      siteId: params.siteId,
      primaryHost: params.primaryHost.trim().toLowerCase(),
      hostPatterns: params.hostPatterns.map((p) => p.trim().toLowerCase()),
      scopes: params.scopes ? [...params.scopes] : ['structure.read', 'crawl.run', 'render.run'],
      payer: params.payer,
      caps: { ...params.caps },
      bindingPath: params.bindingPath,
      proofToken,
      purgeOnRevoke: params.purgeOnRevoke ?? true,
      reviewBy: params.reviewBy,
      state: 'draft',
      epoch: 0,
      consecutiveAuthoritativeNegatives: 0,
      createdAt: now.toISOString(),
    };

    this.grants.set(grantId, grant);
    return grant;
  }

  // ---- Step 2: Independent Domain Proof Verification (UGOKI side & CRAWL side) ----

  public recordSideDomainProof(params: {
    readonly grantId: string;
    readonly side: 'ugoki' | 'crawl';
    readonly check: DomainProofCheckResult;
  }): { readonly ok: boolean; readonly code: string; readonly reason: string } {
    const grant = this.grants.get(params.grantId);
    if (!grant) {
      return { ok: false, code: 'GRANT_NOT_FOUND', reason: 'Link grant not found' };
    }
    if (grant.state === 'revoked') {
      return { ok: false, code: 'GRANT_REVOKED', reason: 'Cannot verify proof on a revoked grant' };
    }
    const ssrf = validateProofCheckAgainstSsrf(params.check);
    if (!ssrf.ok) {
      return { ok: false, code: 'SSRF_GUARD_BLOCKED', reason: ssrf.reason ?? 'SSRF check failed' };
    }
    if (!isHostMatchedByPatterns(params.check.host, [grant.primaryHost, ...grant.hostPatterns])) {
      return { ok: false, code: 'HOST_MISMATCH', reason: `Checked host ${params.check.host} does not match grant host` };
    }
    if (params.check.outcome !== 'verified' || params.check.observedToken !== grant.proofToken) {
      return {
        ok: false,
        code: 'PROOF_NOT_VERIFIED',
        reason: `Domain proof failed verification (${params.check.outcome})`,
      };
    }

    if (params.side === 'ugoki') {
      grant.ugokiProofCheckedAt = params.check.checkedAt;
      if (grant.state === 'draft') {
        grant.state = 'pending_binding';
      }
    } else {
      grant.crawlProofCheckedAt = params.check.checkedAt;
    }

    return { ok: true, code: 'PROOF_RECORDED', reason: `${params.side} domain proof verified` };
  }

  // ---- Step 3A: Binding Path 1 — Pairing Code (128-bit, single-use, 10m TTL, max 7d pending) ----

  public mintPairingCode(
    grantId: string,
    now: Date = new Date()
  ): { readonly ok: true; readonly pairingCode: string; readonly expiresAt: string } | { readonly ok: false; readonly code: string; readonly reason: string } {
    const grant = this.grants.get(grantId);
    if (!grant) return { ok: false, code: 'GRANT_NOT_FOUND', reason: 'Grant not found' };
    if (grant.bindingPath !== 'pairing') {
      return { ok: false, code: 'WRONG_BINDING_PATH', reason: `Grant uses binding path ${grant.bindingPath}, not pairing` };
    }
    if (!grant.ugokiProofCheckedAt || !this.isProofFresh(grant.ugokiProofCheckedAt, now)) {
      return {
        ok: false,
        code: 'UGOKI_PROOF_NOT_FRESH',
        reason: 'UGOKI must verify the shared domain proof (< 24h) before minting a pairing code',
      };
    }
    if (now.getTime() - new Date(grant.createdAt).getTime() > PAIRING_PENDING_MAX_MS) {
      return {
        ok: false,
        code: 'PAIRING_PENDING_WINDOW_EXCEEDED',
        reason: 'Pairing codes cannot be re-minted after 7 days in pending state',
      };
    }

    // 128-bit single-use pairing code
    const pairingCode = `ugk_pair_${crypto.randomBytes(16).toString('base64url')}`;
    const codeHash = sha256Hex(pairingCode);
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS).toISOString();

    this.pairingCodes.set(codeHash, {
      codeHash,
      grantId: grant.grantId,
      issuedAt: now.toISOString(),
      expiresAt,
    });
    grant.state = 'pending_binding';

    return { ok: true, pairingCode, expiresAt };
  }

  public redeemPairingCode(params: {
    readonly pairingCode: string;
    readonly crawlAccount: CrawlAccountSummary;
    readonly crawlProofCheck: DomainProofCheckResult;
    readonly now?: Date;
  }): { readonly ok: true; readonly grant: LinkGrant } | { readonly ok: false; readonly code: string; readonly reason: string } {
    const now = params.now ?? new Date();
    const codeHash = sha256Hex(params.pairingCode.trim());
    const rec = this.pairingCodes.get(codeHash);
    if (!rec) {
      return { ok: false, code: 'INVALID_PAIRING_CODE', reason: 'Pairing code not recognized' };
    }
    if (rec.consumedAt) {
      return { ok: false, code: 'PAIRING_CODE_ALREADY_USED', reason: 'Pairing code is single-use' };
    }
    if (new Date(rec.expiresAt).getTime() <= now.getTime()) {
      return { ok: false, code: 'PAIRING_CODE_EXPIRED', reason: 'Pairing code expired (10 min limit)' };
    }

    const grant = this.grants.get(rec.grantId);
    if (!grant || grant.state === 'revoked') {
      return { ok: false, code: 'GRANT_UNAVAILABLE', reason: 'Grant unavailable' };
    }

    const proofRes = this.recordSideDomainProof({
      grantId: grant.grantId,
      side: 'crawl',
      check: params.crawlProofCheck,
    });
    if (!proofRes.ok) {
      return { ok: false, code: proofRes.code, reason: proofRes.reason };
    }

    rec.consumedAt = now.toISOString();
    grant.crawlAccountRef = params.crawlAccount.crawlAccountRef;
    grant.crawlAccountSummary = params.crawlAccount;
    grant.state = 'pending_approval';

    return { ok: true, grant };
  }

  // ---- Step 3B: Binding Path 2 — OAuth PKCE (`federation.link`) ----

  public completeOAuthBinding(params: {
    readonly grantId: string;
    readonly grantedOAuthScope: string;
    readonly codeVerifier: string;
    readonly expectedCodeChallengeS256: string;
    readonly crawlAccount: CrawlAccountSummary;
    readonly crawlProofCheck: DomainProofCheckResult;
    readonly consentConfirmed: boolean;
  }): { readonly ok: true; readonly grant: LinkGrant } | { readonly ok: false; readonly code: string; readonly reason: string } {
    const grant = this.grants.get(params.grantId);
    if (!grant) return { ok: false, code: 'GRANT_NOT_FOUND', reason: 'Grant not found' };
    if (grant.bindingPath !== 'oauth') {
      return { ok: false, code: 'WRONG_BINDING_PATH', reason: `Grant uses ${grant.bindingPath}, not oauth` };
    }
    if (params.grantedOAuthScope !== 'federation.link') {
      return { ok: false, code: 'INVALID_OAUTH_SCOPE', reason: 'OAuth binding requires scope federation.link' };
    }
    if (!params.consentConfirmed) {
      return { ok: false, code: 'CONSENT_NOT_CONFIRMED', reason: 'Consent screen listing hosts, scopes, and caps must be confirmed' };
    }
    if (!verifyPkceS256(params.codeVerifier, params.expectedCodeChallengeS256)) {
      return { ok: false, code: 'INVALID_PKCE_VERIFIER', reason: 'PKCE S256 verification failed' };
    }

    const proofRes = this.recordSideDomainProof({
      grantId: grant.grantId,
      side: 'crawl',
      check: params.crawlProofCheck,
    });
    if (!proofRes.ok) {
      return { ok: false, code: proofRes.code, reason: proofRes.reason };
    }

    grant.crawlAccountRef = params.crawlAccount.crawlAccountRef;
    grant.crawlAccountSummary = params.crawlAccount;
    grant.state = 'pending_approval';
    return { ok: true, grant };
  }

  // ---- Step 3C: Binding Path 3 — Provisioned Federated Account ----

  public completeProvisionedBinding(params: {
    readonly grantId: string;
    readonly provisionedCrawlAccountRef: string;
    readonly crawlProofCheck: DomainProofCheckResult;
    readonly now?: Date;
  }): { readonly ok: true; readonly grant: LinkGrant } | { readonly ok: false; readonly code: string; readonly reason: string } {
    const grant = this.grants.get(params.grantId);
    if (!grant) return { ok: false, code: 'GRANT_NOT_FOUND', reason: 'Grant not found' };
    if (grant.bindingPath !== 'provisioned') {
      return { ok: false, code: 'WRONG_BINDING_PATH', reason: `Grant uses ${grant.bindingPath}, not provisioned` };
    }
    if (grant.payer !== 'ugoki_ledger') {
      return {
        ok: false,
        code: 'PROVISIONED_REQUIRES_UGOKI_LEDGER_PAYER',
        reason: 'Provisioned federated CRAWL accounts carry no own allowance and must use payer = ugoki_ledger',
      };
    }

    const proofRes = this.recordSideDomainProof({
      grantId: grant.grantId,
      side: 'crawl',
      check: params.crawlProofCheck,
    });
    if (!proofRes.ok) {
      return { ok: false, code: proofRes.code, reason: proofRes.reason };
    }

    grant.crawlAccountRef = params.provisionedCrawlAccountRef;
    grant.crawlAccountSummary = {
      crawlAccountRef: params.provisionedCrawlAccountRef,
      label: `Federated account for ${grant.siteId}`,
      verifiedEmailDomain: grant.primaryHost,
      accountAgeDays: 0,
      delegatedMonthlyCreditCap: grant.caps.monthlyCreditsCap,
      plan: 'federated',
    };
    grant.state = 'pending_approval';
    return { ok: true, grant };
  }

  // ---- Step 4: Final Human Passkey Approval -> `active`, `epoch = 1` ----

  public approveAndActivateGrant(params: {
    readonly grantId: string;
    readonly principal: VerifiedPrincipal;
    readonly passkeyAssertion: PasskeyAssertionInput;
    readonly now?: Date;
  }): { readonly ok: true; readonly grant: LinkGrant } | { readonly ok: false; readonly httpStatus: 401 | 403 | 404 | 409; readonly code: string; readonly reason: string } {
    const now = params.now ?? new Date();
    const grant = this.grants.get(params.grantId);
    if (!grant || grant.tenantId !== params.principal.tenantId) {
      return { ok: false, httpStatus: 404, code: 'NOT_FOUND', reason: 'Grant not found' };
    }

    // R5 interactive passkey enforcement: bearer / API / MCP tokens rejected
    if (params.principal.credentialKind !== 'session_cookie') {
      return {
        ok: false,
        httpStatus: 403,
        code: 'INTERACTIVE_PASSKEY_REQUIRED',
        reason: 'Activating a link grant is R5 and requires an interactive session + passkey',
      };
    }
    if (params.principal.role !== 'owner' && params.principal.role !== 'admin') {
      return {
        ok: false,
        httpStatus: 403,
        code: 'APPROVER_ROLE_INSUFFICIENT',
        reason: 'Only owner or admin may activate a link grant',
      };
    }

    if (grant.state !== 'pending_approval' || !grant.crawlAccountRef) {
      return {
        ok: false,
        httpStatus: 409,
        code: 'GRANT_NOT_READY_FOR_ACTIVATION',
        reason: `Grant must complete account binding before activation (current state: ${grant.state})`,
      };
    }

    // Both independent proofs MUST be < 24h fresh at activation!
    if (
      !grant.ugokiProofCheckedAt ||
      !grant.crawlProofCheckedAt ||
      !this.isProofFresh(grant.ugokiProofCheckedAt, now) ||
      !this.isProofFresh(grant.crawlProofCheckedAt, now)
    ) {
      return {
        ok: false,
        httpStatus: 409,
        code: 'BOTH_DOMAIN_PROOFS_MUST_BE_UNDER_24H',
        reason: 'Both UGOKI and CRAWL independent domain proofs must be fresh (< 24h) at activation',
      };
    }

    const approvalDiff = {
      grantId: grant.grantId,
      siteId: grant.siteId,
      crawlAccountRef: grant.crawlAccountRef,
      hostPatterns: grant.hostPatterns,
      scopes: grant.scopes,
      caps: grant.caps,
    };
    const { combinedHash } = computeActionAndDiffHash('link_grant.activate', approvalDiff);
    if (
      !params.passkeyAssertion.signatureVerified ||
      !params.passkeyAssertion.userVerification ||
      params.passkeyAssertion.signedChallengeHash !== combinedHash
    ) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'INVALID_PASSKEY_ASSERTION',
        reason: 'Passkey UV assertion failed or did not cover link grant diff',
      };
    }

    grant.state = 'active';
    grant.epoch = Math.max(1, grant.epoch + 1);
    grant.activatedAt = now.toISOString();
    grant.consecutiveAuthoritativeNegatives = 0;
    grant.firstTransientErrorAt = undefined;

    return { ok: true, grant };
  }

  // ---- Step 5: Per-Call Ed25519 Signed Assertions & Server-Side Resolution ----

  public signFederationAssertion(params: {
    readonly grantId: string;
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
    readonly ttlSec?: number;
    readonly now?: Date;
  }): { readonly token: string; readonly payload: FederationAssertionPayload } {
    const grant = this.grants.get(params.grantId);
    if (!grant) throw new Error(`Unknown grant: ${params.grantId}`);
    if (grant.state !== 'active') {
      throw new Error(`Cannot sign assertion for non-active grant ${params.grantId} (${grant.state})`);
    }

    const now = params.now ?? new Date();
    const ttlSec = Math.min(Math.max(1, params.ttlSec ?? MAX_FEDERATION_ASSERTION_TTL_SEC), MAX_FEDERATION_ASSERTION_TTL_SEC);
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + ttlSec;

    const payload: FederationAssertionPayload = {
      iss: this.ugokiIssuer,
      aud: this.crawlAudience,
      sub: grant.grantId,
      epoch: grant.epoch,
      iat,
      exp,
      jti: `jti_${crypto.randomBytes(16).toString('hex')}`,
      req_hash: computeFederationRequestHash({
        method: params.method,
        path: params.path,
        body: params.body,
      }),
    };

    const headerB64 = Buffer.from(
      JSON.stringify({ alg: 'EdDSA', typ: 'ugokilink-fed+jwt', kid: this.ugokiSigningPair.kid }),
      'utf8'
    ).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signingInput = `${headerB64}.${payloadB64}`;
    const sigB64 = crypto
      .sign(null, Buffer.from(signingInput, 'utf8'), this.ugokiSigningPair.privateKeyPem)
      .toString('base64url');

    return { token: `${signingInput}.${sigB64}`, payload };
  }

  /**
   * Verifies a per-call Ed25519 federation assertion and resolves `(tenantId, siteId, crawlAccountRef)`
   * strictly from the stored grant. Rejects caller-supplied owner overrides, expired/long-TTL tokens,
   * replayed JTIs, mismatched request hashes, stale epochs, and out-of-grant hosts.
   */
  public verifyFederationCall(params: {
    readonly assertionToken: string;
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
    readonly targetHost?: string;
    readonly requiredScope?: FederationScope;
    /** Any owner identifier injected by caller in query/body/header — MUST be rejected! */
    readonly callerSuppliedOwnerIds?: {
      readonly tenantId?: string;
      readonly siteId?: string;
      readonly crawlUserId?: string;
    };
    readonly now?: Date;
  }): VerifyFederationCallResult {
    const now = params.now ?? new Date();
    const nowSec = Math.floor(now.getTime() / 1000);

    // 0. Reject caller-supplied owner IDs unconditionally (`surface-final.md` §9.1 BOLA defense)
    if (
      params.callerSuppliedOwnerIds &&
      (params.callerSuppliedOwnerIds.tenantId !== undefined ||
        params.callerSuppliedOwnerIds.siteId !== undefined ||
        params.callerSuppliedOwnerIds.crawlUserId !== undefined)
    ) {
      return {
        ok: false,
        httpStatus: 400,
        code: 'CALLER_OWNER_ID_FORBIDDEN',
        reason: 'Caller-supplied tenant_id/site_id/user_id parameters are forbidden on federation endpoints; owner is resolved solely from the signed grant assertion',
      };
    }

    const parts = params.assertionToken.trim().split('.');
    if (parts.length !== 3) {
      return { ok: false, httpStatus: 401, code: 'MALFORMED_ASSERTION', reason: 'Assertion must have 3 dot-separated parts' };
    }
    const [headerB64, payloadB64, sigB64] = parts;
    const signingInput = `${headerB64}.${payloadB64}`;

    let sigOk = false;
    try {
      sigOk = crypto.verify(
        null,
        Buffer.from(signingInput, 'utf8'),
        this.ugokiSigningPair.publicKeyPem,
        Buffer.from(sigB64, 'base64url')
      );
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      return { ok: false, httpStatus: 401, code: 'INVALID_ASSERTION_SIGNATURE', reason: 'Ed25519 signature verification failed' };
    }

    let payload: FederationAssertionPayload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as FederationAssertionPayload;
    } catch {
      return { ok: false, httpStatus: 401, code: 'INVALID_ASSERTION_PAYLOAD', reason: 'Failed to decode assertion JSON' };
    }

    if (payload.iss !== this.ugokiIssuer || payload.aud !== this.crawlAudience) {
      return { ok: false, httpStatus: 401, code: 'ASSERTION_ISS_AUD_MISMATCH', reason: 'Invalid issuer or audience' };
    }

    if (payload.exp - payload.iat > MAX_FEDERATION_ASSERTION_TTL_SEC || payload.exp <= payload.iat) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'ASSERTION_TTL_EXCEEDS_300S',
        reason: 'Federation assertion lifetime must not exceed 300 seconds',
      };
    }

    if (nowSec >= payload.exp) {
      return { ok: false, httpStatus: 401, code: 'ASSERTION_EXPIRED', reason: 'Federation assertion has expired' };
    }

    // Request hash binding check
    const expectedReqHash = computeFederationRequestHash({
      method: params.method,
      path: params.path,
      body: params.body,
    });
    if (payload.req_hash !== expectedReqHash) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'ASSERTION_REQ_HASH_MISMATCH',
        reason: 'Assertion req_hash does not match incoming HTTP request',
      };
    }

    // Prune expired JTIs and enforce replay protection
    const nowMs = now.getTime();
    for (const [jti, expMs] of this.seenJtis.entries()) {
      if (expMs <= nowMs) this.seenJtis.delete(jti);
    }
    if (this.seenJtis.has(payload.jti)) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'ASSERTION_REPLAY_DETECTED',
        reason: 'Federation assertion jti has already been used',
      };
    }

    // Look up grant strictly from `payload.sub`
    const grant = this.grants.get(payload.sub);
    if (!grant) {
      return { ok: false, httpStatus: 404, code: 'GRANT_NOT_FOUND', reason: 'Link grant not found' };
    }
    if (grant.state !== 'active' || !grant.crawlAccountRef) {
      return {
        ok: false,
        httpStatus: 403,
        code: `GRANT_NOT_ACTIVE:${grant.state}`,
        reason: `Link grant is ${grant.state}`,
      };
    }
    if (payload.epoch !== grant.epoch) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'GRANT_EPOCH_STALE',
        reason: `Assertion epoch ${payload.epoch} does not match current grant epoch ${grant.epoch}`,
      };
    }

    if (params.requiredScope && !grant.scopes.includes(params.requiredScope)) {
      return {
        ok: false,
        httpStatus: 403,
        code: 'GRANT_SCOPE_INSUFFICIENT',
        reason: `Grant does not include scope "${params.requiredScope}"`,
      };
    }

    if (params.targetHost && !isHostMatchedByPatterns(params.targetHost, grant.hostPatterns)) {
      return {
        ok: false,
        httpStatus: 403,
        code: 'HOST_OUT_OF_GRANT',
        reason: `Host "${params.targetHost}" is outside grant host_patterns`,
      };
    }

    // Mark JTI consumed
    this.seenJtis.set(payload.jti, payload.exp * 1000);

    return {
      ok: true,
      grantId: grant.grantId,
      tenantId: grant.tenantId,
      siteId: grant.siteId,
      crawlAccountRef: grant.crawlAccountRef,
      hostPatterns: grant.hostPatterns,
      scopes: grant.scopes,
      payer: grant.payer,
      caps: grant.caps,
      epoch: grant.epoch,
      jti: payload.jti,
    };
  }

  // ---- Step 6: Hourly Re-Verification State Machine ----

  /**
   * Processes one hourly domain-proof re-verification tick:
   *   - `verified` -> resets failure counters; restores proof-suspended grants to `active`.
   *   - `authoritative_negative` -> increments counter; >= 2 consecutive -> `suspended`.
   *   - `transient_error` -> retains `active` for up to 72h grace; > 72h -> `suspended`.
   */
  public processHourlyRecheck(
    grantId: string,
    check: DomainProofCheckResult,
    now: Date = new Date()
  ): RecheckReport {
    const grant = this.grants.get(grantId);
    if (!grant) {
      throw new Error(`Unknown grant: ${grantId}`);
    }
    const previousState = grant.state;
    const checkedAt = check.checkedAt || now.toISOString();

    if (grant.state === 'revoked') {
      return {
        grantId,
        previousState,
        nextState: 'revoked',
        outcome: check.outcome,
        consecutiveAuthoritativeNegatives: grant.consecutiveAuthoritativeNegatives,
        transientGraceElapsedHours: 0,
        reason: 'Revoked grants are never re-activated by recheck',
        checkedAt,
      };
    }

    const ssrf = validateProofCheckAgainstSsrf(check);
    const effectiveOutcome =
      !ssrf.ok
        ? 'authoritative_negative'
        : check.outcome === 'verified' && check.observedToken !== grant.proofToken
          ? 'authoritative_negative'
          : check.outcome;

    if (effectiveOutcome === 'verified') {
      grant.ugokiProofCheckedAt = checkedAt;
      grant.consecutiveAuthoritativeNegatives = 0;
      grant.firstTransientErrorAt = undefined;
      if (grant.state === 'suspended') {
        grant.state = 'active';
        grant.suspendedReason = undefined;
        grant.suspendedAt = undefined;
      }
      return {
        grantId,
        previousState,
        nextState: grant.state,
        outcome: 'verified',
        consecutiveAuthoritativeNegatives: 0,
        transientGraceElapsedHours: 0,
        reason: 'Domain proof verified',
        checkedAt,
      };
    }

    if (effectiveOutcome === 'authoritative_negative') {
      grant.consecutiveAuthoritativeNegatives += 1;
      grant.firstTransientErrorAt = undefined;
      if (grant.consecutiveAuthoritativeNegatives >= AUTHORITATIVE_NEGATIVE_SUSPEND_THRESHOLD) {
        grant.state = 'suspended';
        grant.suspendedReason = 'proof_missing_2_consecutive_authoritative_negatives';
        grant.suspendedAt = checkedAt;
        return {
          grantId,
          previousState,
          nextState: 'suspended',
          outcome: 'authoritative_negative',
          consecutiveAuthoritativeNegatives: grant.consecutiveAuthoritativeNegatives,
          transientGraceElapsedHours: 0,
          reason: 'Suspended after 2 consecutive authoritative negative proof checks',
          checkedAt,
        };
      }
      return {
        grantId,
        previousState,
        nextState: grant.state,
        outcome: 'authoritative_negative',
        consecutiveAuthoritativeNegatives: grant.consecutiveAuthoritativeNegatives,
        transientGraceElapsedHours: 0,
        reason: 'Recorded 1st authoritative negative; waiting for confirmation on next hourly check',
        checkedAt,
      };
    }

    // Transient lookup failure -> up to 72 hours grace
    if (!grant.firstTransientErrorAt) {
      grant.firstTransientErrorAt = checkedAt;
    }
    const elapsedMs = now.getTime() - new Date(grant.firstTransientErrorAt).getTime();
    const elapsedHours = Math.max(0, elapsedMs / (60 * 60 * 1000));

    if (elapsedMs > TRANSIENT_ERROR_GRACE_MS) {
      grant.state = 'suspended';
      grant.suspendedReason = 'transient_lookup_grace_72h_exceeded';
      grant.suspendedAt = checkedAt;
      return {
        grantId,
        previousState,
        nextState: 'suspended',
        outcome: 'transient_error',
        consecutiveAuthoritativeNegatives: grant.consecutiveAuthoritativeNegatives,
        transientGraceElapsedHours: elapsedHours,
        reason: 'Suspended: transient proof lookup failures exceeded 72-hour grace period',
        checkedAt,
      };
    }

    return {
      grantId,
      previousState,
      nextState: grant.state,
      outcome: 'transient_error',
      consecutiveAuthoritativeNegatives: grant.consecutiveAuthoritativeNegatives,
      transientGraceElapsedHours: elapsedHours,
      reason: `Transient lookup error within 72h grace (${elapsedHours.toFixed(1)}h elapsed)`,
      checkedAt,
    };
  }

  // ---- Step 7: Two-Sided Revocation + Ed25519 Signed Purge Receipt ----

  public revokeGrant(params: {
    readonly grantId: string;
    readonly revokedBy: 'ugoki' | 'crawl';
    readonly reason: string;
    readonly purgedDatasets?: ReadonlyArray<string>;
    readonly now?: Date;
  }): SignedPurgeReceipt {
    const now = params.now ?? new Date();
    const grant = this.grants.get(params.grantId);
    if (!grant) {
      throw new Error(`Unknown grant: ${params.grantId}`);
    }

    grant.state = 'revoked';
    grant.epoch += 1;
    grant.revokedAt = now.toISOString();
    grant.revokedBy = params.revokedBy;
    grant.revocationReason = params.reason;

    const effectiveBy = new Date(now.getTime() + REVOCATION_FEDERATION_SLA_MS).toISOString();
    const receiptId = `prg_${crypto.randomBytes(10).toString('hex')}`;
    const purgedDatasets = grant.purgeOnRevoke
      ? (params.purgedDatasets ?? ['behavior_page_agg', 'proxy_cache', 'snapshot_staging'])
      : [];

    const signingPair = params.revokedBy === 'crawl' ? this.crawlSigningPair : this.ugokiSigningPair;
    const unsignedReceipt = {
      receiptId,
      grantId: grant.grantId,
      tenantId: grant.tenantId,
      siteId: grant.siteId,
      crawlAccountRef: grant.crawlAccountRef ?? null,
      revokedBy: params.revokedBy,
      revokedAt: grant.revokedAt,
      effectiveBy,
      epoch: grant.epoch,
      purgeOnRevoke: grant.purgeOnRevoke,
      purgedDatasets,
      signerKid: signingPair.kid,
    };
    const signature = crypto
      .sign(null, Buffer.from(canonicalJson(unsignedReceipt), 'utf8'), signingPair.privateKeyPem)
      .toString('base64url');

    return {
      ...unsignedReceipt,
      signature,
    };
  }

  public verifyPurgeReceipt(receipt: SignedPurgeReceipt): boolean {
    const publicKeyPem =
      receipt.signerKid === this.crawlSigningPair.kid
        ? this.crawlSigningPair.publicKeyPem
        : receipt.signerKid === this.ugokiSigningPair.kid
          ? this.ugokiSigningPair.publicKeyPem
          : null;
    if (!publicKeyPem) return false;

    const { signature, ...unsigned } = receipt;
    try {
      return crypto.verify(
        null,
        Buffer.from(canonicalJson(unsigned), 'utf8'),
        publicKeyPem,
        Buffer.from(signature, 'base64url')
      );
    } catch {
      return false;
    }
  }

  private isProofFresh(checkedAtIso: string, now: Date): boolean {
    const ageMs = now.getTime() - new Date(checkedAtIso).getTime();
    return ageMs >= -60_000 && ageMs <= PROOF_FRESHNESS_MAX_MS;
  }
}
