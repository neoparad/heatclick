/**
 * UGOKI LINK v2 — Account Plane, Keys, Scopes, Risk Classes, Envelopes & Audit Types
 *
 * Implements Master Architecture v2 §11.1, §11.3, §11.5–§11.9 and `surface-final.md` §5.3, §5.7, §8.3.
 */

import type { MeasureStatus } from '@/packages/contract/response';

// =========================================================================
// 1. Account Hierarchy (Org -> Tenant -> Site) & Principals
// =========================================================================

export type OrgType = 'direct' | 'oem';

export type KeyEnvironment = 'live' | 'test';

export type PrincipalKind = 'human' | 'service' | 'agent';

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Fail-closed role normalization (`surf.identity_plane` / `surface-final.md` §5.3).
 * Any unknown, missing, empty, or malformed role ALWAYS maps to `viewer` (read-only).
 */
export function normalizeRole(input: unknown): Role {
  if (typeof input !== 'string') {
    return 'viewer';
  }
  const normalized = input.trim().toLowerCase();
  if (
    normalized === 'owner' ||
    normalized === 'admin' ||
    normalized === 'member' ||
    normalized === 'viewer'
  ) {
    return normalized;
  }
  return 'viewer';
}

export interface OrgRecord {
  readonly orgId: string;
  readonly type: OrgType;
  readonly name: string;
  readonly oemLegalSignoffRef?: string | null;
  readonly createdAt: string;
}

export interface TenantDelegationPolicy {
  /** Scopes an OEM parent is allowed to exercise via short-lived exchanged token. */
  readonly allowedOemScopes: ReadonlyArray<Scope>;
  /** Maximum TTL in seconds for exchanged OEM tokens (hard-capped at 900s = 15 min). */
  readonly maxExchangedTokenTtlSec: number;
  /** Whether OEM parent may enter this child tenant at all. */
  readonly allowOemAccess: boolean;
}

export interface TenantRecord {
  readonly tenantId: string;
  readonly orgId: string;
  readonly name: string;
  readonly planScopes: ReadonlyArray<Scope>;
  readonly delegationPolicy: TenantDelegationPolicy;
  /** Monotonically increasing epoch for strongly-consistent MCP OAuth revocation. */
  readonly revocationEpoch: number;
  readonly sensitiveIndustry?: boolean;
  readonly createdAt: string;
}

export interface SiteRecord {
  readonly siteId: string;
  readonly tenantId: string;
  readonly siteRef: string;
  readonly env: KeyEnvironment;
  readonly hostnames: ReadonlyArray<string>;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly createdAt: string;
}

export interface PrincipalRecord {
  readonly principalId: string;
  readonly tenantId: string;
  readonly orgId: string;
  readonly kind: PrincipalKind;
  readonly role: Role;
  readonly email?: string;
  readonly passkeyEnrolled: boolean;
  readonly allowedScopes?: ReadonlyArray<Scope>;
  readonly disabled?: boolean;
}

// =========================================================================
// 2. Exact 24 Scopes & Presets (`surface-final.md` §5.3)
// =========================================================================

export const ALL_SCOPES = [
  'analytics:read',
  'analytics:export',
  'timelines:read',
  'identifiers:read',
  'agents:read',
  'fusion:read',
  'ml:read',
  'ml:train',
  'logs:write',
  'conversions:write',
  'decisions:read',
  'decisions:write',
  'decisions:publish',
  'experiments:manage',
  'origin:apply',
  'crawl:read',
  'crawl:spend',
  'privacy:delete',
  'sites:manage',
  'connections:manage',
  'webhooks:manage',
  'keys:issue',
  'usage:read',
  'oem:manage',
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

export type ScopePreset = 'read' | 'write' | 'admin';

export const SCOPE_PRESETS: Readonly<Record<ScopePreset, ReadonlyArray<Scope>>> = {
  read: [
    'analytics:read',
    'fusion:read',
    'ml:read',
    'decisions:read',
    'crawl:read',
    'usage:read',
  ],
  write: [
    'analytics:read',
    'analytics:export',
    'agents:read',
    'fusion:read',
    'ml:read',
    'ml:train',
    'logs:write',
    'conversions:write',
    'decisions:read',
    'decisions:write',
    'decisions:publish',
    'experiments:manage',
    'crawl:read',
    'crawl:spend',
    'usage:read',
  ],
  admin: [...ALL_SCOPES],
};

export const ROLE_SCOPES: Readonly<Record<Role, ReadonlyArray<Scope>>> = {
  viewer: SCOPE_PRESETS.read,
  member: [
    ...SCOPE_PRESETS.read,
    'analytics:export',
    'agents:read',
    'logs:write',
    'conversions:write',
    'decisions:write',
    'ml:train',
  ],
  admin: ALL_SCOPES.filter((s) => s !== 'oem:manage'),
  owner: [...ALL_SCOPES],
};

/**
 * Scopes that are strictly forbidden from R3 programmatic key provisioning
 * (`surface-final.md` §5.3: "never R3–R5 scopes").
 */
export const NON_DELEGABLE_R3_TO_R5_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  'keys:issue',
  'privacy:delete',
  'sites:manage',
  'connections:manage',
  'webhooks:manage',
  'oem:manage',
  'origin:apply',
]);

// =========================================================================
// 3. Risk Classes R0–R5 (`surface-final.md` §5.3)
// =========================================================================

export const RISK_CLASSES = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export const FAIL_SAFE_STOP_ACTIONS = [
  'pause',
  'kill',
  'suspend',
  'revoke',
  'narrow',
] as const;
export type FailSafeStopAction = (typeof FAIL_SAFE_STOP_ACTIONS)[number];

export type FieldProvenance =
  | 'closed_enum'
  | 'copy_library'
  | 'link_table'
  | 'generated_checked'
  | 'open';

// =========================================================================
// 4. Credential Kinds & Key Records
// =========================================================================

export type CredentialKind =
  | 'ugk_pub'
  | 'ugk_sec'
  | 'ugk_edge'
  | 'ugk_oem'
  | 'oem_exchanged'
  | 'oauth_mcp'
  | 'session_cookie'
  | 'federation_assertion';

export type EdgeKeyPurpose = 'handoff_header' | 'log_shipper';

export const ALLOWED_EDGE_KEY_PURPOSES: ReadonlySet<string> = new Set<EdgeKeyPurpose>([
  'handoff_header',
  'log_shipper',
]);

export const FORBIDDEN_EDGE_KEY_PURPOSES: ReadonlySet<string> = new Set<string>([
  'decrypt',
  'decryption',
  'pseudonymize',
  'pseudonymization',
  'reidentify',
]);

export interface KeyConstraints {
  /** If defined and non-empty, restricts the credential to these site IDs only. */
  readonly siteIds?: ReadonlyArray<string>;
  /** IPv4 exact or CIDR allowlist (e.g. `203.0.113.0/24` or `203.0.113.10`). */
  readonly allowedCidrs?: ReadonlyArray<string>;
  /** Hard expiration timestamp (ISO-8601). */
  readonly expiresAt?: string;
  /** Rate tier identifier derived from 10x replay. */
  readonly rateTier?: 'standard' | 'elevated' | 'bulk';
  /** Daily credit ceiling for crawl/compute spend. */
  readonly dailyCreditsCap?: number;
  /** Daily publish count ceiling. */
  readonly dailyPublishesCap?: number;
  /** Daily privacy deletion subject ceiling before human approval is required. */
  readonly dailyDeleteSubjectsCap?: number;
  /** Sender-constrained key thumbprint (mTLS cert thumbprint or DPoP JKT). */
  readonly senderConstrainedThumbprint?: string;
}

export interface SecretKeyRecord {
  readonly keyId: string;
  readonly kid: string;
  readonly prefix: string;
  readonly env: KeyEnvironment;
  readonly tenantId: string;
  readonly orgId: string;
  readonly principalId: string;
  /** Stored ONLY as HMAC-SHA256(pepper_v, rawSecret) — raw secret is never persisted. */
  readonly secretHash: string;
  readonly pepperVersion: string;
  readonly scopes: ReadonlyArray<Scope>;
  readonly constraints: KeyConstraints;
  readonly createdAt: string;
  readonly revokedAt?: string;
  /** Non-null during rotation overlap (<= 7 days). */
  readonly rotatedUntil?: string;
  readonly supersededByKeyId?: string;
}

export interface EdgeKeyRecord {
  readonly keyId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly env: KeyEnvironment;
  readonly keyMaterialHex: string;
  readonly allowedPurposes: ReadonlyArray<EdgeKeyPurpose>;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface OemKeyRecord {
  readonly keyId: string;
  readonly kid: string;
  readonly orgId: string;
  readonly managementTenantId: string;
  readonly secretHash: string;
  readonly pepperVersion: string;
  readonly delegableScopes: ReadonlyArray<Scope>;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface OemExchangedTokenClaims {
  readonly jti: string;
  readonly orgId: string;
  readonly childTenantId: string;
  readonly act: {
    readonly sub: string;
    readonly oemKeyId: string;
    readonly managementTenantId: string;
  };
  readonly scopes: ReadonlyArray<Scope>;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly senderConstrainedThumbprint?: string;
}

export interface McpOAuthTokenRecord {
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly tenantId: string;
  readonly orgId: string;
  readonly principalId: string;
  readonly clientId: string;
  readonly scopes: ReadonlyArray<Scope>;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly tenantEpoch: number;
  readonly dpopThumbprint?: string;
  readonly revokedAt?: string;
}

export interface PublicKeyVerificationResult {
  readonly valid: boolean;
  readonly env?: KeyEnvironment;
  readonly siteRef?: string;
  readonly version?: string;
  readonly allowedOperations?: ReadonlyArray<'ingest' | 'decision'>;
  readonly reason?: string;
}

// =========================================================================
// 5. Verified Server-Side Principal
// =========================================================================

export interface VerifiedPrincipal {
  readonly credentialKind: CredentialKind;
  readonly credentialId: string;
  readonly tenantId: string;
  readonly orgId: string;
  /** If non-null, access is restricted to these site IDs (e.g. `ugk_pub` or site-scoped `ugk_sec`). */
  readonly allowedSiteIds: ReadonlyArray<string> | null;
  readonly principalKind: PrincipalKind;
  readonly principalId: string;
  readonly role: Role;
  readonly effectiveScopes: ReadonlySet<Scope>;
  /** True when credential is bound via mTLS or DPoP proof-of-possession. */
  readonly senderConstrained: boolean;
  /** True ONLY for interactive browser sessions with fresh WebAuthn passkey UV. */
  readonly passkeyVerified: boolean;
  readonly passkeyVerifiedAt?: string;
  readonly act?: {
    readonly sub: string;
    readonly oemKeyId: string;
    readonly managementTenantId: string;
  };
  readonly constraints?: KeyConstraints;
}

// =========================================================================
// 6. Passkey Approvals, Autonomy Envelopes & R4 Destruction
// =========================================================================

export interface PasskeyAssertionInput {
  readonly credentialId: string;
  readonly userVerification: boolean;
  readonly signedChallengeHash: string;
  readonly assertedAt: string;
  readonly signatureVerified: boolean;
}

export interface PasskeyApprovalRecord {
  readonly approvalId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly approverPrincipalId: string;
  readonly approverRole: 'owner' | 'admin';
  readonly action: string;
  readonly actionHash: string;
  readonly renderedDiffHash: string;
  readonly webauthnCredentialId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  consumedAt?: string;
}

export interface AutonomyEnvelope {
  readonly envelopeId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly authorPrincipalId: string;
  readonly authorApprovalId: string;
  readonly contentHash: string;
  readonly allowedActions: ReadonlyArray<string>;
  readonly allowedScopes: ReadonlyArray<Scope>;
  /** Provenance classes allowed under this envelope (never includes `'open'`). */
  readonly allowedFieldProvenance: ReadonlyArray<Exclude<FieldProvenance, 'open'>>;
  /** Maximum exposed units (e.g. page views / visitors) covered by this envelope. */
  readonly maxExposedUnits: number;
  exposedUnitsUsed: number;
  /** Maximum conversions at risk before automatic halt. */
  readonly maxConversionsAtRisk: number;
  conversionsAtRiskUsed: number;
  /** Smoke failure bound ε (<= 0.01; N_smoke = ceil(3 / ε), >= 300). */
  readonly smokeEpsilon: number;
  smokeUnitsObserved: number;
  smokeFailuresObserved: number;
  /** Events that immediately terminate the envelope. */
  readonly terminatingEvents: ReadonlyArray<string>;
  terminatedBy?: string;
  terminatedAt?: string;
  /** Mandatory review deadline (ISO-8601); expired envelope blocks R2. */
  readonly reviewBy: string;
  /** If true, generated_checked copy is permitted (requires gate `surf.generated_copy_autonomy`). */
  readonly allowGeneratedCopy: boolean;
  readonly generatedCopyGateOpen?: boolean;
  active: boolean;
}

export type DestructionScope = 'subject' | 'site' | 'tenant';

export interface DestructionRequestRecord {
  readonly requestId: string;
  readonly tenantId: string;
  readonly siteId?: string;
  readonly scope: DestructionScope;
  readonly subjectIds?: ReadonlyArray<string>;
  readonly reason: string;
  readonly undoTokenHash: string;
  state: 'scheduled' | 'masked' | 'purged' | 'certified' | 'cancelled' | 'overdue';
  readonly scheduledAt: string;
  readonly undoWindowEndsAt: string;
  cancelledAt?: string;
}

// =========================================================================
// 7. Authorization Decision & Hash-Chained Audit Log
// =========================================================================

export interface AuthorizationRequest {
  readonly principal: VerifiedPrincipal;
  readonly action: string;
  readonly riskClass: RiskClass;
  readonly requiredScope?: Scope;
  /** Resource ownership resolved from server-side store (NEVER trusted from caller). */
  readonly resource: {
    readonly type: string;
    readonly id: string;
    readonly tenantId: string;
    readonly siteId?: string;
  };
  /**
   * Optional tenant_id supplied in untrusted caller input (query/body/header).
   * Used exclusively to detect and reject cross-tenant / parameter-tampering probes.
   */
  readonly callerSuppliedTenantId?: string;
  readonly idempotencyKey?: string;
  readonly isFailSafeStop?: boolean;
  readonly renderedDiff?: unknown;
  readonly passkeyApprovalId?: string;
  readonly passkeyAssertion?: PasskeyAssertionInput;
  /**
   * When true, verifies the Passkey approval read-only without marking it consumed;
   * caller MUST atomically call `consumePasskeyApproval()` after idempotency/rate-limit checks.
   */
  readonly deferApprovalConsumption?: boolean;
  /**
   * Set true ONLY when the pipeline has verified an exact idempotent replay hit in its
   * idempotency store, so a previously consumed approval matching tenant/site/action/diff
   * does not block returning the cached response.
   */
  readonly allowConsumedApprovalForReplay?: boolean;
  readonly autonomyEnvelopeId?: string;
  readonly fieldProvenance?: ReadonlyArray<FieldProvenance>;
  readonly touchesPriceOrOffer?: boolean;
  readonly legalSignoffRef?: string;
  readonly requestedExposedUnits?: number;
  readonly requestedConversionsAtRisk?: number;
  readonly smokePhase?: boolean;
  /** For R3 provisioning checks. */
  readonly provisionTarget?: {
    readonly targetPrincipalId: string;
    readonly requestedScopes: ReadonlyArray<Scope>;
    readonly issuerDelegableScopes: ReadonlyArray<Scope>;
    readonly childPolicyAllowedScopes?: ReadonlyArray<Scope>;
  };
  /** For R4 destruction requests. */
  readonly destruction?: {
    readonly scope: DestructionScope;
    readonly subjectIds?: ReadonlyArray<string>;
    readonly reason: string;
  };
  readonly now?: Date;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly httpStatus: 200 | 202 | 400 | 401 | 403 | 404 | 429;
  readonly code: string;
  readonly measureStatus: MeasureStatus;
  readonly reason: string;
  readonly approvalUrl?: string;
  readonly auditEntryId: string;
  readonly sealed?: boolean;
  /** Present when `deferApprovalConsumption: true` verified a Passkey approval read-only. */
  readonly pendingApprovalConsumption?: {
    readonly approvalId: string;
    readonly actionPayload: unknown;
  };
  readonly destructionRequest?: {
    readonly requestId: string;
    readonly undoToken: string;
    readonly undoWindowEndsAt: string;
    readonly state: 'scheduled';
  };
}

export interface AuditLogEntry {
  readonly auditId: string;
  readonly seq: number;
  readonly timestamp: string;
  readonly prevHash: string;
  readonly entryHash: string;
  readonly tenantId: string;
  readonly targetTenantId: string;
  readonly principalId: string;
  readonly credentialKind: CredentialKind;
  readonly credentialId: string;
  readonly action: string;
  readonly riskClass: RiskClass;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly outcome:
    | 'allow'
    | 'deny_400'
    | 'deny_401'
    | 'deny_403'
    | 'deny_404'
    | 'deny_429'
    | 'pending_approval';
  readonly reason: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
