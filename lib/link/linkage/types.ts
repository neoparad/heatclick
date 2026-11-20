/**
 * UGOKI LINK v2 — Explicit N:M Link Grant & CRAWL Federation Types
 *
 * Implements Master Architecture v2 §11.2, §11.7 and `surface-final.md` §5.2, §7.1, §9.1.
 */

export type BindingPath = 'pairing' | 'oauth' | 'provisioned';

export type LinkGrantState =
  | 'draft'
  | 'pending_binding'
  | 'pending_approval'
  | 'active'
  | 'suspended'
  | 'revoked';

export type LinkPayer = 'crawl_account' | 'ugoki_ledger';

export type FederationScope =
  | 'structure.read'
  | 'crawl.run'
  | 'render.run'
  | 'probe.run'
  | 'serp.run'
  | 'behavior.export'
  | 'origin.apply';

export type DomainProofMethod = 'dns_txt' | 'well_known_file';

export type ProofCheckOutcome = 'verified' | 'authoritative_negative' | 'transient_error';

export interface DomainProofCheckResult {
  readonly host: string;
  readonly method: DomainProofMethod;
  readonly outcome: ProofCheckOutcome;
  readonly observedToken?: string;
  readonly checkedAt: string;
  readonly redirectHops?: number;
  readonly resolvedIp?: string;
  readonly reason?: string;
}

export interface CrawlAccountSummary {
  readonly crawlAccountRef: string;
  readonly label: string;
  readonly verifiedEmailDomain: string;
  readonly accountAgeDays: number;
  readonly delegatedMonthlyCreditCap: number;
  readonly plan: 'standard' | 'pro' | 'agency' | 'federated';
}

export interface LinkGrantCaps {
  readonly monthlyCreditsCap: number;
  readonly dailyExternalSpendCapUsd: number;
  readonly maxConcurrentJobs: number;
  readonly maxUrlsPerInlineJob: number;
}

export interface PairingCodeRecord {
  readonly codeHash: string;
  readonly grantId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  consumedAt?: string;
}

export interface LinkGrant {
  readonly grantId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly primaryHost: string;
  readonly hostPatterns: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<FederationScope>;
  readonly payer: LinkPayer;
  readonly caps: LinkGrantCaps;
  readonly bindingPath: BindingPath;
  readonly proofToken: string;
  readonly purgeOnRevoke: boolean;
  readonly reviewBy: string;
  state: LinkGrantState;
  epoch: number;
  crawlAccountRef?: string;
  crawlAccountSummary?: CrawlAccountSummary;
  ugokiProofCheckedAt?: string;
  crawlProofCheckedAt?: string;
  consecutiveAuthoritativeNegatives: number;
  firstTransientErrorAt?: string;
  suspendedReason?: string;
  suspendedAt?: string;
  activatedAt?: string;
  revokedAt?: string;
  revokedBy?: 'ugoki' | 'crawl';
  revocationReason?: string;
  readonly createdAt: string;
}

export interface FederationAssertionPayload {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string; // grant_id
  readonly epoch: number;
  readonly iat: number; // unix seconds
  readonly exp: number; // unix seconds (exp - iat <= 300)
  readonly jti: string;
  readonly req_hash: string;
}

export interface VerifiedFederationCall {
  readonly ok: true;
  readonly grantId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly crawlAccountRef: string;
  readonly hostPatterns: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<FederationScope>;
  readonly payer: LinkPayer;
  readonly caps: LinkGrantCaps;
  readonly epoch: number;
  readonly jti: string;
}

export interface RejectedFederationCall {
  readonly ok: false;
  readonly httpStatus: 400 | 401 | 403 | 404;
  readonly code: string;
  readonly reason: string;
}

export type VerifyFederationCallResult = VerifiedFederationCall | RejectedFederationCall;

export interface RecheckReport {
  readonly grantId: string;
  readonly previousState: LinkGrantState;
  readonly nextState: LinkGrantState;
  readonly outcome: ProofCheckOutcome;
  readonly consecutiveAuthoritativeNegatives: number;
  readonly transientGraceElapsedHours: number;
  readonly reason: string;
  readonly checkedAt: string;
}

export interface SignedPurgeReceipt {
  readonly receiptId: string;
  readonly grantId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly crawlAccountRef: string | null;
  readonly revokedBy: 'ugoki' | 'crawl';
  readonly revokedAt: string;
  readonly effectiveBy: string;
  readonly epoch: number;
  readonly purgeOnRevoke: boolean;
  readonly purgedDatasets: ReadonlyArray<string>;
  readonly signerKid: string;
  readonly signature: string;
}
