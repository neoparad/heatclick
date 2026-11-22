/**
 * UGOKI LINK v2 — Key Lifecycle, Stateless Ed25519 Public Keys, HMAC Secret Keys,
 * HKDF Edge Keys, OEM Token Exchange, and MCP OAuth 2.1 (PKCE + Epoch Revocation)
 *
 * Implements Master Architecture v2 §11.1, §11.6–§11.7 and `surface-final.md` §5.3, §5.4, §8.3.
 */

import crypto from 'node:crypto';
import {
  ALLOWED_EDGE_KEY_PURPOSES,
  FORBIDDEN_EDGE_KEY_PURPOSES,
  ROLE_SCOPES,
  SCOPE_PRESETS,
  normalizeRole,
  type EdgeKeyPurpose,
  type EdgeKeyRecord,
  type KeyConstraints,
  type KeyEnvironment,
  type McpOAuthTokenRecord,
  type OemExchangedTokenClaims,
  type OemKeyRecord,
  type OrgRecord,
  type PrincipalRecord,
  type PublicKeyVerificationResult,
  type Scope,
  type SecretKeyRecord,
  type SiteRecord,
  type TenantRecord,
  type VerifiedPrincipal,
} from './types';

// =========================================================================
// 1. Constants & Helpers
// =========================================================================

/** Maximum overlap window for rotated secret keys: 7 days (surface-final.md §5.3). */
export const MAX_KEY_ROTATION_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum lifetime for OEM child exchanged tokens: 15 minutes (surface-final.md §5.3). */
export const MAX_OEM_EXCHANGED_TTL_SEC = 15 * 60;

/** Maximum lifetime for MCP OAuth 2.1 access tokens: 1 hour (surface-final.md §5.4). */
export const MAX_MCP_OAUTH_TTL_SEC = 60 * 60;

const PUB_KEY_PATTERN = /^ugk_pub_(live|test)_([a-zA-Z0-9_-]{3,64})\.(v[0-9]+)\.([A-Za-z0-9_-]+)$/;

export interface Ed25519KeyPair {
  readonly kid: string;
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
}

export function generateEd25519KeyPair(kid = `k_${crypto.randomBytes(6).toString('hex')}`): Ed25519KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    kid,
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
  };
}

export function hmacSecretHash(rawSecret: string, pepper: string): string {
  return crypto.createHmac('sha256', pepper).update(rawSecret, 'utf8').digest('hex');
}

export function constantTimeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length || a.length % 2 !== 0) {
    return false;
  }
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function intersectScopes(
  ...scopeLists: ReadonlyArray<ReadonlyArray<Scope>>
): Scope[] {
  if (scopeLists.length === 0) return [];
  const [first, ...rest] = scopeLists;
  let current = new Set<Scope>(first);
  for (const list of rest) {
    const next = new Set<Scope>(list);
    current = new Set([...current].filter((s) => next.has(s)));
  }
  return [...current];
}

function parseIpv4ToUint32(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    acc = ((acc << 8) | n) >>> 0;
  }
  return acc;
}

export function isIpInCidrList(ip: string, cidrs: ReadonlyArray<string>): boolean {
  const ipNum = parseIpv4ToUint32(ip);
  if (ipNum === null) return false;
  for (const entry of cidrs) {
    const [networkStr, prefixStr] = entry.split('/');
    const netNum = parseIpv4ToUint32(networkStr);
    if (netNum === null) continue;
    if (prefixStr === undefined) {
      if (ipNum === netNum) return true;
      continue;
    }
    const prefix = Number(prefixStr);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) continue;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((ipNum & mask) === (netNum & mask)) {
      return true;
    }
  }
  return false;
}

// =========================================================================
// 2. Key Kind 1: `ugk_pub_{env}_{site_ref}.{ver}.{sig}` (Stateless Ed25519)
// =========================================================================

export function mintPublicKey(params: {
  readonly env: KeyEnvironment;
  readonly siteRef: string;
  readonly version: string;
  readonly privateKeyPem: string;
}): string {
  if (!/^[a-zA-Z0-9_-]{3,64}$/.test(params.siteRef)) {
    throw new Error(`Invalid siteRef format: ${params.siteRef}`);
  }
  if (!/^v[0-9]+$/.test(params.version)) {
    throw new Error(`Invalid public key version format: ${params.version}`);
  }
  const payload = `ugk_pub_${params.env}_${params.siteRef}.${params.version}`;
  const signature = crypto
    .sign(null, Buffer.from(payload, 'utf8'), params.privateKeyPem)
    .toString('base64url');
  return `${payload}.${signature}`;
}

/**
 * Stateless, zero-I/O verification of `ugk_pub_{env}_{site_ref}.{ver}.{sig}`.
 * Safe for edge workers on every ingest and decision call.
 */
export function verifyPublicKeyStateless(
  rawKey: string,
  publicKeysByVersion: Readonly<Record<string, string>>
): PublicKeyVerificationResult {
  const match = PUB_KEY_PATTERN.exec(rawKey.trim());
  if (!match) {
    return { valid: false, reason: 'MALFORMED_PUBLIC_KEY' };
  }
  const env = match[1] as KeyEnvironment;
  const siteRef = match[2];
  const version = match[3];
  const sigB64 = match[4];

  const pubKeyPem = publicKeysByVersion[version];
  if (!pubKeyPem) {
    return { valid: false, reason: 'UNKNOWN_PUBLIC_KEY_VERSION' };
  }

  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(sigB64, 'base64url');
  } catch {
    return { valid: false, reason: 'INVALID_SIGNATURE_ENCODING' };
  }

  const payload = `ugk_pub_${env}_${siteRef}.${version}`;
  try {
    const ok = crypto.verify(null, Buffer.from(payload, 'utf8'), pubKeyPem, sigBytes);
    if (!ok) {
      return { valid: false, reason: 'INVALID_ED25519_SIGNATURE' };
    }
  } catch {
    return { valid: false, reason: 'SIGNATURE_VERIFICATION_ERROR' };
  }

  return {
    valid: true,
    env,
    siteRef,
    version,
    allowedOperations: ['ingest', 'decision'],
  };
}

// =========================================================================
// 3. Key Kind 3: `ugk_edge_*` Purpose-Derived HMAC Keys
// =========================================================================

export class EdgeKeyForbiddenPurposeError extends Error {
  public readonly purpose: string;
  constructor(purpose: string) {
    super(
      `Edge key purpose "${purpose}" is strictly forbidden: ugk_edge_* must never hold decryption or pseudonymization keys.`
    );
    this.name = 'EdgeKeyForbiddenPurposeError';
    this.purpose = purpose;
  }
}

export function deriveEdgePurposeKey(
  edgeKey: EdgeKeyRecord,
  purpose: string,
  now: Date = new Date()
): Buffer {
  if (edgeKey.revokedAt && new Date(edgeKey.revokedAt).getTime() <= now.getTime()) {
    throw new Error(`Edge key ${edgeKey.keyId} is revoked`);
  }
  const normalized = purpose.trim().toLowerCase();
  if (FORBIDDEN_EDGE_KEY_PURPOSES.has(normalized) || !ALLOWED_EDGE_KEY_PURPOSES.has(normalized)) {
    throw new EdgeKeyForbiddenPurposeError(purpose);
  }
  if (!edgeKey.allowedPurposes.includes(normalized as EdgeKeyPurpose)) {
    throw new EdgeKeyForbiddenPurposeError(purpose);
  }

  const ikm = Buffer.from(edgeKey.keyMaterialHex, 'hex');
  const salt = Buffer.from(`ugokilink:edge:${edgeKey.tenantId}:${edgeKey.siteId}`, 'utf8');
  const info = Buffer.from(`purpose:${normalized}:v1`, 'utf8');
  const derived = crypto.hkdfSync('sha256', ikm, salt, info, 32);
  return Buffer.from(derived);
}

// =========================================================================
// 4. PKCE S256 Helper for MCP OAuth 2.1
// =========================================================================

export function computePkceS256Challenge(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
}

export function verifyPkceS256(codeVerifier: string, expectedChallenge: string): boolean {
  if (codeVerifier.length < 43 || codeVerifier.length > 128) {
    return false;
  }
  const actual = computePkceS256Challenge(codeVerifier);
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expectedChallenge, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// =========================================================================
// 5. Unified Identity & Key Registry (Postgres-backed contract in memory)
// =========================================================================

export interface SecretKeyVerifyContext {
  readonly clientIp?: string;
  readonly siteId?: string;
  readonly requestedCredits?: number;
  readonly requestedPublishes?: number;
  readonly senderThumbprint?: string;
  readonly now?: Date;
}

export type VerifyCredentialResult =
  | { readonly ok: true; readonly principal: VerifiedPrincipal }
  | {
      readonly ok: false;
      readonly httpStatus: 401 | 403 | 429;
      readonly code: string;
      readonly reason: string;
    };

interface UsageCounter {
  credits: number;
  publishes: number;
  dayKey: string;
}

export class IdentityKeyRegistry {
  private readonly orgs = new Map<string, OrgRecord>();
  private readonly tenants = new Map<string, TenantRecord>();
  private readonly sites = new Map<string, SiteRecord>();
  private readonly sitesByRef = new Map<string, SiteRecord>();
  private readonly principals = new Map<string, PrincipalRecord>();

  private readonly peppers = new Map<string, string>();
  private activePepperVersion: string;

  private readonly secretKeys = new Map<string, SecretKeyRecord>();
  private readonly edgeKeys = new Map<string, EdgeKeyRecord>();
  private readonly oemKeys = new Map<string, OemKeyRecord>();
  private readonly exchangedTokens = new Map<string, OemExchangedTokenClaims>();
  private readonly oauthTokens = new Map<string, McpOAuthTokenRecord>();
  private readonly dailyUsage = new Map<string, UsageCounter>();

  private readonly publicKeySigningPairs = new Map<string, Ed25519KeyPair>();
  private readonly oemSigningPair: Ed25519KeyPair;

  constructor(options: {
    readonly pepperVersion: string;
    readonly pepperSecret: string;
    readonly publicKeySigningPair?: Ed25519KeyPair;
    readonly oemSigningPair?: Ed25519KeyPair;
  }) {
    this.activePepperVersion = options.pepperVersion;
    this.peppers.set(options.pepperVersion, options.pepperSecret);
    const pubPair = options.publicKeySigningPair ?? generateEd25519KeyPair('v1');
    this.publicKeySigningPairs.set(pubPair.kid, pubPair);
    this.oemSigningPair = options.oemSigningPair ?? generateEd25519KeyPair('oem_v1');
  }

  // ---- Pepper & Org/Tenant/Site/Principal Registration ----

  public addPepper(version: string, secret: string, makeActive = true): void {
    this.peppers.set(version, secret);
    if (makeActive) {
      this.activePepperVersion = version;
    }
  }

  public registerOrg(org: OrgRecord): void {
    this.orgs.set(org.orgId, org);
  }

  public registerTenant(tenant: TenantRecord): void {
    if (!this.orgs.has(tenant.orgId)) {
      throw new Error(`Org ${tenant.orgId} must be registered before tenant ${tenant.tenantId}`);
    }
    this.tenants.set(tenant.tenantId, {
      ...tenant,
      delegationPolicy: {
        ...tenant.delegationPolicy,
        maxExchangedTokenTtlSec: Math.min(
          tenant.delegationPolicy.maxExchangedTokenTtlSec,
          MAX_OEM_EXCHANGED_TTL_SEC
        ),
      },
    });
  }

  public registerSite(site: SiteRecord): void {
    if (!this.tenants.has(site.tenantId)) {
      throw new Error(`Tenant ${site.tenantId} must be registered before site ${site.siteId}`);
    }
    this.sites.set(site.siteId, site);
    this.sitesByRef.set(`${site.env}:${site.siteRef}`, site);
  }

  public registerPrincipal(principal: Omit<PrincipalRecord, 'role'> & { readonly role: unknown }): PrincipalRecord {
    if (!this.tenants.has(principal.tenantId)) {
      throw new Error(`Tenant ${principal.tenantId} not registered`);
    }
    const normalized: PrincipalRecord = {
      ...principal,
      role: normalizeRole(principal.role),
    };
    this.principals.set(normalized.principalId, normalized);
    return normalized;
  }

  public getTenant(tenantId: string): TenantRecord | undefined {
    return this.tenants.get(tenantId);
  }

  public getSite(siteId: string): SiteRecord | undefined {
    return this.sites.get(siteId);
  }

  public getPrincipal(principalId: string): PrincipalRecord | undefined {
    return this.principals.get(principalId);
  }

  public getPublicKeysByVersion(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [ver, pair] of this.publicKeySigningPairs.entries()) {
      out[ver] = pair.publicKeyPem;
    }
    return out;
  }

  // ---- 1. Public Key (`ugk_pub_*`) ----

  public issuePublicKey(siteId: string, version = 'v1'): string {
    const site = this.sites.get(siteId);
    if (!site) {
      throw new Error(`Unknown site: ${siteId}`);
    }
    const pair = this.publicKeySigningPairs.get(version);
    if (!pair) {
      throw new Error(`Unknown signing key version: ${version}`);
    }
    return mintPublicKey({
      env: site.env,
      siteRef: site.siteRef,
      version,
      privateKeyPem: pair.privateKeyPem,
    });
  }

  public verifyPublicKeyToPrincipal(rawKey: string): VerifyCredentialResult {
    const verified = verifyPublicKeyStateless(rawKey, this.getPublicKeysByVersion());
    if (!verified.valid || !verified.env || !verified.siteRef) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'INVALID_PUBLIC_KEY',
        reason: verified.reason ?? 'Invalid public key',
      };
    }
    const site = this.sitesByRef.get(`${verified.env}:${verified.siteRef}`);
    if (!site) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'UNKNOWN_SITE_REF',
        reason: `No registered site for ${verified.env}:${verified.siteRef}`,
      };
    }
    const tenant = this.tenants.get(site.tenantId);
    if (!tenant) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'UNKNOWN_TENANT',
        reason: 'Site tenant not found',
      };
    }
    return {
      ok: true,
      principal: {
        credentialKind: 'ugk_pub',
        credentialId: `pub:${site.siteRef}:${verified.version}`,
        tenantId: site.tenantId,
        orgId: tenant.orgId,
        allowedSiteIds: [site.siteId],
        principalKind: 'service',
        principalId: `public_tag:${site.siteId}`,
        role: 'viewer',
        effectiveScopes: new Set<Scope>(['logs:write', 'decisions:read']),
        senderConstrained: false,
        passkeyVerified: false,
      },
    };
  }

  // ---- 2. Secret API Key (`ugk_sec_*`) ----

  public issueSecretKey(params: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly env?: KeyEnvironment;
    /** Default is read-only (`SCOPE_PRESETS.read`) per `surface-final.md` §5.3. */
    readonly scopes?: ReadonlyArray<Scope>;
    readonly constraints?: KeyConstraints;
    readonly now?: Date;
  }): { readonly rawKey: string; readonly record: SecretKeyRecord } {
    const tenant = this.tenants.get(params.tenantId);
    if (!tenant) throw new Error(`Unknown tenant: ${params.tenantId}`);
    const principal = this.principals.get(params.principalId);
    if (!principal || principal.tenantId !== params.tenantId) {
      throw new Error(`Principal ${params.principalId} does not belong to tenant ${params.tenantId}`);
    }

    const env = params.env ?? 'live';
    const keyId = `key_${crypto.randomBytes(8).toString('hex')}`;
    const kid = `kid_${crypto.randomBytes(4).toString('hex')}`;
    const secretPart = crypto.randomBytes(24).toString('base64url');
    const rawKey = `ugk_sec_${env}_${keyId}_${secretPart}`;
    const prefix = rawKey.slice(0, 20);

    const pepper = this.peppers.get(this.activePepperVersion);
    if (!pepper) throw new Error('Active pepper missing');

    const record: SecretKeyRecord = {
      keyId,
      kid,
      prefix,
      env,
      tenantId: tenant.tenantId,
      orgId: tenant.orgId,
      principalId: principal.principalId,
      secretHash: hmacSecretHash(rawKey, pepper),
      pepperVersion: this.activePepperVersion,
      scopes: params.scopes ? [...params.scopes] : [...SCOPE_PRESETS.read],
      constraints: params.constraints ?? {},
      createdAt: (params.now ?? new Date()).toISOString(),
    };

    this.secretKeys.set(keyId, record);
    return { rawKey, record };
  }

  public rotateSecretKey(
    keyId: string,
    overlapMs: number = MAX_KEY_ROTATION_OVERLAP_MS,
    now: Date = new Date()
  ): { readonly rawKey: string; readonly newRecord: SecretKeyRecord; readonly oldRecord: SecretKeyRecord } {
    const existing = this.secretKeys.get(keyId);
    if (!existing) throw new Error(`Unknown key: ${keyId}`);
    if (existing.revokedAt) throw new Error(`Cannot rotate revoked key: ${keyId}`);

    const clampedOverlap = Math.min(Math.max(0, overlapMs), MAX_KEY_ROTATION_OVERLAP_MS);
    const issued = this.issueSecretKey({
      tenantId: existing.tenantId,
      principalId: existing.principalId,
      env: existing.env,
      scopes: existing.scopes,
      constraints: existing.constraints,
      now,
    });

    const updatedOld: SecretKeyRecord = {
      ...existing,
      rotatedUntil: new Date(now.getTime() + clampedOverlap).toISOString(),
      supersededByKeyId: issued.record.keyId,
    };
    this.secretKeys.set(keyId, updatedOld);

    return {
      rawKey: issued.rawKey,
      newRecord: issued.record,
      oldRecord: updatedOld,
    };
  }

  public revokeSecretKey(keyId: string, now: Date = new Date()): void {
    const existing = this.secretKeys.get(keyId);
    if (!existing) return;
    this.secretKeys.set(keyId, {
      ...existing,
      revokedAt: now.toISOString(),
    });
  }

  public getSecretKeyRecord(keyId: string): SecretKeyRecord | undefined {
    return this.secretKeys.get(keyId);
  }

  public verifySecretKey(rawKey: string, ctx: SecretKeyVerifyContext = {}): VerifyCredentialResult {
    const now = ctx.now ?? new Date();
    const match = /^ugk_sec_(live|test)_(key_[a-f0-9]{16})_([A-Za-z0-9_-]+)$/.exec(rawKey.trim());
    if (!match) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'INVALID_SECRET_KEY_FORMAT',
        reason: 'Malformed ugk_sec_* key',
      };
    }

    const keyId = match[2];
    const record = this.secretKeys.get(keyId);
    if (!record) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'UNKNOWN_SECRET_KEY',
        reason: 'Secret key not found',
      };
    }

    const pepper = this.peppers.get(record.pepperVersion);
    if (!pepper) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'PEPPER_UNAVAILABLE',
        reason: 'Key pepper version unavailable',
      };
    }

    const expectedHash = hmacSecretHash(rawKey.trim(), pepper);
    if (!constantTimeHexEquals(expectedHash, record.secretHash)) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'INVALID_SECRET_KEY',
        reason: 'Key digest mismatch',
      };
    }

    if (record.revokedAt && new Date(record.revokedAt).getTime() <= now.getTime()) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'KEY_REVOKED',
        reason: 'Secret key has been revoked',
      };
    }

    if (record.rotatedUntil && new Date(record.rotatedUntil).getTime() <= now.getTime()) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'KEY_ROTATION_EXPIRED',
        reason: 'Rotated key overlap window has ended',
      };
    }

    if (record.constraints.expiresAt && new Date(record.constraints.expiresAt).getTime() <= now.getTime()) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'KEY_EXPIRED',
        reason: 'Secret key has expired',
      };
    }

    if (record.constraints.allowedCidrs && record.constraints.allowedCidrs.length > 0) {
      if (!ctx.clientIp || !isIpInCidrList(ctx.clientIp, record.constraints.allowedCidrs)) {
        return {
          ok: false,
          httpStatus: 403,
          code: 'IP_NOT_ALLOWED',
          reason: 'Client IP outside key CIDR allowlist',
        };
      }
    }

    if (record.constraints.siteIds && record.constraints.siteIds.length > 0 && ctx.siteId) {
      if (!record.constraints.siteIds.includes(ctx.siteId)) {
        return {
          ok: false,
          httpStatus: 403,
          code: 'SITE_OUT_OF_KEY_CONSTRAINT',
          reason: 'Key is not permitted for the target site',
        };
      }
    }

    // Daily caps enforcement
    const dayKey = now.toISOString().slice(0, 10);
    const usage = this.getOrResetUsage(record.keyId, dayKey);
    const reqCredits = ctx.requestedCredits ?? 0;
    const reqPublishes = ctx.requestedPublishes ?? 0;

    if (
      record.constraints.dailyCreditsCap !== undefined &&
      usage.credits + reqCredits > record.constraints.dailyCreditsCap
    ) {
      return {
        ok: false,
        httpStatus: 429,
        code: 'DAILY_CREDITS_CAP_EXCEEDED',
        reason: 'Secret key daily credits cap exceeded',
      };
    }
    if (
      record.constraints.dailyPublishesCap !== undefined &&
      usage.publishes + reqPublishes > record.constraints.dailyPublishesCap
    ) {
      return {
        ok: false,
        httpStatus: 429,
        code: 'DAILY_PUBLISHES_CAP_EXCEEDED',
        reason: 'Secret key daily publishes cap exceeded',
      };
    }

    const tenant = this.tenants.get(record.tenantId);
    const principal = this.principals.get(record.principalId);
    if (!tenant || !principal || principal.disabled) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'PRINCIPAL_OR_TENANT_INACTIVE',
        reason: 'Principal or tenant is inactive',
      };
    }

    // Effective scope = key ∩ principal ∩ plan (`surface-final.md` §5.3)
    const principalScopes = principal.allowedScopes
      ? intersectScopes(ROLE_SCOPES[principal.role], principal.allowedScopes)
      : ROLE_SCOPES[principal.role];
    const effective = intersectScopes(record.scopes, principalScopes, tenant.planScopes);

    // Sender constraint verification (mTLS / DPoP thumbprint match)
    const senderConstrained = Boolean(
      record.constraints.senderConstrainedThumbprint &&
        ctx.senderThumbprint &&
        record.constraints.senderConstrainedThumbprint === ctx.senderThumbprint
    );

    if (reqCredits > 0) usage.credits += reqCredits;
    if (reqPublishes > 0) usage.publishes += reqPublishes;

    return {
      ok: true,
      principal: {
        credentialKind: 'ugk_sec',
        credentialId: record.keyId,
        tenantId: tenant.tenantId,
        orgId: tenant.orgId,
        allowedSiteIds: record.constraints.siteIds ? [...record.constraints.siteIds] : null,
        principalKind: principal.kind,
        principalId: principal.principalId,
        role: principal.role,
        effectiveScopes: new Set<Scope>(effective),
        senderConstrained,
        passkeyVerified: false,
        constraints: record.constraints,
      },
    };
  }

  private getOrResetUsage(keyId: string, dayKey: string): UsageCounter {
    const existing = this.dailyUsage.get(keyId);
    if (existing && existing.dayKey === dayKey) {
      return existing;
    }
    const fresh: UsageCounter = { credits: 0, publishes: 0, dayKey };
    this.dailyUsage.set(keyId, fresh);
    return fresh;
  }

  // ---- 3. Edge Key (`ugk_edge_*`) ----

  public issueEdgeKey(params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly env?: KeyEnvironment;
    readonly allowedPurposes?: ReadonlyArray<EdgeKeyPurpose>;
    readonly now?: Date;
  }): { readonly rawKey: string; readonly record: EdgeKeyRecord } {
    const site = this.sites.get(params.siteId);
    if (!site || site.tenantId !== params.tenantId) {
      throw new Error(`Site ${params.siteId} does not belong to tenant ${params.tenantId}`);
    }
    const env = params.env ?? site.env;
    const keyId = `edge_${crypto.randomBytes(8).toString('hex')}`;
    const keyMaterialHex = crypto.randomBytes(32).toString('hex');
    const rawKey = `ugk_edge_${env}_${keyId}_${keyMaterialHex}`;

    const record: EdgeKeyRecord = {
      keyId,
      tenantId: params.tenantId,
      siteId: params.siteId,
      env,
      keyMaterialHex,
      allowedPurposes: params.allowedPurposes ?? ['handoff_header', 'log_shipper'],
      createdAt: (params.now ?? new Date()).toISOString(),
    };

    this.edgeKeys.set(keyId, record);
    return { rawKey, record };
  }

  public deriveEdgeKey(keyId: string, purpose: string, now: Date = new Date()): Buffer {
    const record = this.edgeKeys.get(keyId);
    if (!record) {
      throw new Error(`Unknown edge key: ${keyId}`);
    }
    return deriveEdgePurposeKey(record, purpose, now);
  }

  public revokeEdgeKey(keyId: string, now: Date = new Date()): void {
    const existing = this.edgeKeys.get(keyId);
    if (!existing) return;
    this.edgeKeys.set(keyId, { ...existing, revokedAt: now.toISOString() });
  }

  // ---- 4. OEM Management Key (`ugk_oem_*`) & <=15m Child Exchange ----

  public issueOemKey(params: {
    readonly orgId: string;
    readonly managementTenantId: string;
    readonly delegableScopes: ReadonlyArray<Scope>;
    readonly now?: Date;
  }): { readonly rawKey: string; readonly record: OemKeyRecord } {
    const org = this.orgs.get(params.orgId);
    if (!org || org.type !== 'oem') {
      throw new Error(`Org ${params.orgId} is not an OEM organisation`);
    }
    const mgmtTenant = this.tenants.get(params.managementTenantId);
    if (!mgmtTenant || mgmtTenant.orgId !== params.orgId) {
      throw new Error(`Management tenant ${params.managementTenantId} does not belong to org ${params.orgId}`);
    }

    const keyId = `oem_${crypto.randomBytes(8).toString('hex')}`;
    const kid = `oemkid_${crypto.randomBytes(4).toString('hex')}`;
    const secretPart = crypto.randomBytes(24).toString('base64url');
    const rawKey = `ugk_oem_live_${keyId}_${secretPart}`;
    const pepper = this.peppers.get(this.activePepperVersion);
    if (!pepper) throw new Error('Active pepper missing');

    const record: OemKeyRecord = {
      keyId,
      kid,
      orgId: params.orgId,
      managementTenantId: params.managementTenantId,
      secretHash: hmacSecretHash(rawKey, pepper),
      pepperVersion: this.activePepperVersion,
      delegableScopes: [...params.delegableScopes],
      createdAt: (params.now ?? new Date()).toISOString(),
    };
    this.oemKeys.set(keyId, record);
    return { rawKey, record };
  }

  /**
   * Immediately revokes an OEM management key AND cascades revocation to all
   * outstanding `ugk_oemx_*` child exchanged tokens derived from it (H-24).
   */
  public revokeOemKey(
    keyId: string,
    now: Date = new Date()
  ): { readonly revoked: boolean; readonly invalidatedChildTokens: number } {
    const record = this.oemKeys.get(keyId);
    if (!record) {
      return { revoked: false, invalidatedChildTokens: 0 };
    }
    (record as { revokedAt?: string }).revokedAt = now.toISOString();
    let invalidated = 0;
    for (const [jti, claims] of this.exchangedTokens.entries()) {
      if (claims.act.oemKeyId === keyId) {
        this.exchangedTokens.delete(jti);
        invalidated += 1;
      }
    }
    return { revoked: true, invalidatedChildTokens: invalidated };
  }

  /**
   * Immediately revokes OEM delegation on a child tenant AND invalidates all
   * outstanding `ugk_oemx_*` tokens targeting that child tenant (H-24).
   */
  public revokeOemChildRelationship(childTenantId: string): {
    readonly revoked: boolean;
    readonly invalidatedChildTokens: number;
  } {
    const child = this.tenants.get(childTenantId);
    if (!child) {
      return { revoked: false, invalidatedChildTokens: 0 };
    }
    this.tenants.set(childTenantId, {
      ...child,
      delegationPolicy: {
        ...child.delegationPolicy,
        allowOemAccess: false,
      },
      revocationEpoch: child.revocationEpoch + 1,
    });
    let invalidated = 0;
    for (const [jti, claims] of this.exchangedTokens.entries()) {
      if (claims.childTenantId === childTenantId) {
        this.exchangedTokens.delete(jti);
        invalidated += 1;
      }
    }
    return { revoked: true, invalidatedChildTokens: invalidated };
  }

  public verifyOemManagementKey(rawKey: string, now: Date = new Date()): VerifyCredentialResult {
    const match = /^ugk_oem_live_(oem_[a-f0-9]{16})_([A-Za-z0-9_-]+)$/.exec(rawKey.trim());
    if (!match) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'INVALID_OEM_KEY_FORMAT',
        reason: 'Malformed ugk_oem_* key',
      };
    }
    const keyId = match[1];
    const record = this.oemKeys.get(keyId);
    if (!record) {
      return { ok: false, httpStatus: 401, code: 'UNKNOWN_OEM_KEY', reason: 'OEM key not found' };
    }
    const pepper = this.peppers.get(record.pepperVersion);
    if (!pepper || !constantTimeHexEquals(hmacSecretHash(rawKey.trim(), pepper), record.secretHash)) {
      return { ok: false, httpStatus: 401, code: 'INVALID_OEM_KEY', reason: 'OEM key digest mismatch' };
    }
    if (record.revokedAt && new Date(record.revokedAt).getTime() <= now.getTime()) {
      return { ok: false, httpStatus: 401, code: 'OEM_KEY_REVOKED', reason: 'OEM key revoked' };
    }

    return {
      ok: true,
      principal: {
        credentialKind: 'ugk_oem',
        credentialId: record.keyId,
        tenantId: record.managementTenantId,
        orgId: record.orgId,
        allowedSiteIds: null,
        principalKind: 'service',
        principalId: `oem_mgmt:${record.keyId}`,
        role: 'admin',
        effectiveScopes: new Set<Scope>(['oem:manage', 'usage:read']),
        senderConstrained: false,
        passkeyVerified: false,
      },
    };
  }

  /**
   * Exchanges an OEM management key for a short-lived (<= 15 min) child-tenant token
   * carrying an `act` claim and scopes intersected with the child's `delegation_policy`.
   */
  public exchangeOemTokenForChild(params: {
    readonly rawOemKey: string;
    readonly childTenantId: string;
    readonly actorSub: string;
    readonly requestedScopes: ReadonlyArray<Scope>;
    readonly requestedTtlSec?: number;
    readonly senderConstrainedThumbprint?: string;
    readonly now?: Date;
  }):
    | { readonly ok: true; readonly token: string; readonly claims: OemExchangedTokenClaims }
    | { readonly ok: false; readonly httpStatus: 401 | 403 | 404; readonly code: string; readonly reason: string } {
    const now = params.now ?? new Date();
    const verified = this.verifyOemManagementKey(params.rawOemKey, now);
    if (!verified.ok) {
      return {
        ok: false,
        httpStatus: verified.httpStatus === 429 ? 403 : verified.httpStatus,
        code: verified.code,
        reason: verified.reason,
      };
    }

    const oemRecord = this.oemKeys.get(verified.principal.credentialId);
    if (!oemRecord) {
      return { ok: false, httpStatus: 401, code: 'UNKNOWN_OEM_KEY', reason: 'OEM key record missing' };
    }

    const childTenant = this.tenants.get(params.childTenantId);
    if (!childTenant || childTenant.orgId !== oemRecord.orgId) {
      // Cross-org / unknown child tenant returns 404 (never reveals existence)
      return {
        ok: false,
        httpStatus: 404,
        code: 'NOT_FOUND',
        reason: 'Child tenant not found within OEM organisation',
      };
    }

    if (!childTenant.delegationPolicy.allowOemAccess) {
      return {
        ok: false,
        httpStatus: 403,
        code: 'OEM_DELEGATION_DISABLED',
        reason: 'Child tenant delegation policy forbids OEM access',
      };
    }

    // Clamp TTL strictly to <= min(15 min, child policy max)
    const maxTtl = Math.min(
      MAX_OEM_EXCHANGED_TTL_SEC,
      childTenant.delegationPolicy.maxExchangedTokenTtlSec
    );
    const ttlSec = Math.min(Math.max(1, params.requestedTtlSec ?? maxTtl), maxTtl);

    // Scopes MUST be subset of requested ∩ oem.delegable ∩ child.delegationPolicy ∩ child.planScopes
    const grantedScopes = intersectScopes(
      params.requestedScopes,
      oemRecord.delegableScopes,
      childTenant.delegationPolicy.allowedOemScopes,
      childTenant.planScopes
    );

    if (grantedScopes.length === 0) {
      return {
        ok: false,
        httpStatus: 403,
        code: 'NO_DELEGABLE_SCOPES',
        reason: 'Intersection of requested scopes with child delegation policy is empty',
      };
    }

    const jti = `oemx_${crypto.randomBytes(12).toString('hex')}`;
    const claims: OemExchangedTokenClaims = {
      jti,
      orgId: oemRecord.orgId,
      childTenantId: childTenant.tenantId,
      act: {
        sub: params.actorSub,
        oemKeyId: oemRecord.keyId,
        managementTenantId: oemRecord.managementTenantId,
      },
      scopes: grantedScopes,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSec * 1000).toISOString(),
      senderConstrainedThumbprint: params.senderConstrainedThumbprint,
    };

    const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const sigB64 = crypto
      .sign(null, Buffer.from(payloadB64, 'utf8'), this.oemSigningPair.privateKeyPem)
      .toString('base64url');
    const token = `ugk_oemx_${payloadB64}.${sigB64}`;

    this.exchangedTokens.set(jti, claims);
    return { ok: true, token, claims };
  }

  public verifyOemExchangedToken(
    rawToken: string,
    ctx: { readonly senderThumbprint?: string; readonly now?: Date } = {}
  ): VerifyCredentialResult {
    const now = ctx.now ?? new Date();
    if (!rawToken.startsWith('ugk_oemx_')) {
      return { ok: false, httpStatus: 401, code: 'INVALID_OEM_TOKEN', reason: 'Invalid token prefix' };
    }
    const rest = rawToken.slice('ugk_oemx_'.length);
    const dotIdx = rest.indexOf('.');
    if (dotIdx <= 0) {
      return { ok: false, httpStatus: 401, code: 'INVALID_OEM_TOKEN', reason: 'Malformed token' };
    }
    const payloadB64 = rest.slice(0, dotIdx);
    const sigB64 = rest.slice(dotIdx + 1);

    let sigOk = false;
    try {
      sigOk = crypto.verify(
        null,
        Buffer.from(payloadB64, 'utf8'),
        this.oemSigningPair.publicKeyPem,
        Buffer.from(sigB64, 'base64url')
      );
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      return { ok: false, httpStatus: 401, code: 'INVALID_OEM_TOKEN_SIG', reason: 'Signature invalid' };
    }

    let claims: OemExchangedTokenClaims;
    try {
      claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as OemExchangedTokenClaims;
    } catch {
      return { ok: false, httpStatus: 401, code: 'INVALID_OEM_TOKEN_PAYLOAD', reason: 'Corrupt claims' };
    }

    if (!this.exchangedTokens.has(claims.jti)) {
      return { ok: false, httpStatus: 401, code: 'OEM_TOKEN_REVOKED', reason: 'Token not active' };
    }
    if (new Date(claims.expiresAt).getTime() <= now.getTime()) {
      this.exchangedTokens.delete(claims.jti);
      return { ok: false, httpStatus: 401, code: 'OEM_TOKEN_EXPIRED', reason: 'Exchanged OEM token expired' };
    }
    const durationSec =
      (new Date(claims.expiresAt).getTime() - new Date(claims.issuedAt).getTime()) / 1000;
    if (durationSec > MAX_OEM_EXCHANGED_TTL_SEC) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'OEM_TOKEN_TTL_VIOLATION',
        reason: 'Exchanged OEM token exceeds 15-minute maximum TTL',
      };
    }

    // Re-verify parent OEM management key exists and has NOT been revoked (H-24)
    const parentOemKey = this.oemKeys.get(claims.act.oemKeyId);
    if (
      !parentOemKey ||
      parentOemKey.orgId !== claims.orgId ||
      (parentOemKey.revokedAt && new Date(parentOemKey.revokedAt).getTime() <= now.getTime())
    ) {
      this.exchangedTokens.delete(claims.jti);
      return {
        ok: false,
        httpStatus: 401,
        code: 'OEM_PARENT_KEY_REVOKED',
        reason: 'Parent OEM key has been revoked; child exchanged token invalidated',
      };
    }

    const childTenant = this.tenants.get(claims.childTenantId);
    if (
      !childTenant ||
      childTenant.orgId !== parentOemKey.orgId ||
      !childTenant.delegationPolicy.allowOemAccess
    ) {
      this.exchangedTokens.delete(claims.jti);
      return {
        ok: false,
        httpStatus: 403,
        code: 'OEM_DELEGATION_REVOKED',
        reason: 'Child tenant delegation policy no longer permits OEM access',
      };
    }

    const effective = intersectScopes(
      claims.scopes,
      parentOemKey.delegableScopes,
      childTenant.delegationPolicy.allowedOemScopes,
      childTenant.planScopes
    );
    const senderConstrained = Boolean(
      claims.senderConstrainedThumbprint &&
        ctx.senderThumbprint &&
        claims.senderConstrainedThumbprint === ctx.senderThumbprint
    );

    return {
      ok: true,
      principal: {
        credentialKind: 'oem_exchanged',
        credentialId: claims.jti,
        tenantId: claims.childTenantId,
        orgId: claims.orgId,
        allowedSiteIds: null,
        principalKind: 'service',
        principalId: claims.act.sub,
        role: 'member',
        effectiveScopes: new Set<Scope>(effective),
        senderConstrained,
        passkeyVerified: false,
        act: claims.act,
      },
    };
  }

  // ---- 5. MCP OAuth 2.1 (PKCE S256, <= 1h TTL, Epoch Revocation) ----

  public issueMcpOAuthToken(params: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly clientId: string;
    readonly scopes: ReadonlyArray<Scope>;
    readonly codeVerifier: string;
    readonly expectedCodeChallengeS256: string;
    readonly ttlSec?: number;
    readonly dpopThumbprint?: string;
    readonly now?: Date;
  }):
    | { readonly ok: true; readonly accessToken: string; readonly record: McpOAuthTokenRecord }
    | { readonly ok: false; readonly httpStatus: 400 | 401; readonly code: string; readonly reason: string } {
    if (!verifyPkceS256(params.codeVerifier, params.expectedCodeChallengeS256)) {
      return {
        ok: false,
        httpStatus: 400,
        code: 'INVALID_PKCE_VERIFIER',
        reason: 'PKCE S256 code_verifier failed verification',
      };
    }

    const tenant = this.tenants.get(params.tenantId);
    const principal = this.principals.get(params.principalId);
    if (!tenant || !principal || principal.tenantId !== tenant.tenantId || principal.disabled) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'INVALID_PRINCIPAL',
        reason: 'Tenant or principal unavailable',
      };
    }

    const now = params.now ?? new Date();
    const ttlSec = Math.min(Math.max(60, params.ttlSec ?? MAX_MCP_OAUTH_TTL_SEC), MAX_MCP_OAUTH_TTL_SEC);
    const tokenId = `mcp_${crypto.randomBytes(8).toString('hex')}`;
    const accessToken = `ugk_oauth_${tokenId}_${crypto.randomBytes(24).toString('base64url')}`;
    const pepper = this.peppers.get(this.activePepperVersion);
    if (!pepper) throw new Error('Active pepper missing');

    const record: McpOAuthTokenRecord = {
      tokenId,
      tokenHash: hmacSecretHash(accessToken, pepper),
      tenantId: tenant.tenantId,
      orgId: tenant.orgId,
      principalId: principal.principalId,
      clientId: params.clientId,
      scopes: [...params.scopes],
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSec * 1000).toISOString(),
      tenantEpoch: tenant.revocationEpoch,
      dpopThumbprint: params.dpopThumbprint,
    };

    this.oauthTokens.set(tokenId, record);
    return { ok: true, accessToken, record };
  }

  /**
   * Strongly-consistent revocation push: bumping the tenant's revocation epoch
   * immediately invalidates all previously issued MCP OAuth tokens for that tenant.
   */
  public bumpTenantRevocationEpoch(tenantId: string): number {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) throw new Error(`Unknown tenant: ${tenantId}`);
    const nextEpoch = tenant.revocationEpoch + 1;
    this.tenants.set(tenantId, { ...tenant, revocationEpoch: nextEpoch });
    return nextEpoch;
  }

  public verifyMcpOAuthToken(
    accessToken: string,
    ctx: { readonly dpopThumbprint?: string; readonly now?: Date } = {}
  ): VerifyCredentialResult {
    const now = ctx.now ?? new Date();
    const match = /^ugk_oauth_(mcp_[a-f0-9]{16})_([A-Za-z0-9_-]+)$/.exec(accessToken.trim());
    if (!match) {
      return { ok: false, httpStatus: 401, code: 'INVALID_OAUTH_TOKEN', reason: 'Malformed MCP OAuth token' };
    }
    const tokenId = match[1];
    const record = this.oauthTokens.get(tokenId);
    if (!record) {
      return { ok: false, httpStatus: 401, code: 'UNKNOWN_OAUTH_TOKEN', reason: 'Token not found' };
    }

    // Check against active/known peppers
    let matchedHash = false;
    for (const pepper of this.peppers.values()) {
      if (constantTimeHexEquals(hmacSecretHash(accessToken.trim(), pepper), record.tokenHash)) {
        matchedHash = true;
        break;
      }
    }
    if (!matchedHash) {
      return { ok: false, httpStatus: 401, code: 'INVALID_OAUTH_TOKEN', reason: 'Token hash mismatch' };
    }

    if (record.revokedAt && new Date(record.revokedAt).getTime() <= now.getTime()) {
      return { ok: false, httpStatus: 401, code: 'OAUTH_TOKEN_REVOKED', reason: 'OAuth token revoked' };
    }
    if (new Date(record.expiresAt).getTime() <= now.getTime()) {
      return { ok: false, httpStatus: 401, code: 'OAUTH_TOKEN_EXPIRED', reason: 'OAuth token expired (1h limit)' };
    }

    const tenant = this.tenants.get(record.tenantId);
    const principal = this.principals.get(record.principalId);
    if (!tenant || !principal || principal.disabled) {
      return { ok: false, httpStatus: 401, code: 'PRINCIPAL_INACTIVE', reason: 'Tenant or principal inactive' };
    }

    // Strongly-consistent epoch revocation check
    if (record.tenantEpoch !== tenant.revocationEpoch) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'OAUTH_REVOCATION_EPOCH_MISMATCH',
        reason: 'Token invalidated by tenant revocation epoch bump',
      };
    }

    const principalScopes = principal.allowedScopes
      ? intersectScopes(ROLE_SCOPES[principal.role], principal.allowedScopes)
      : ROLE_SCOPES[principal.role];
    const effective = intersectScopes(record.scopes, principalScopes, tenant.planScopes);

    const senderConstrained = Boolean(
      record.dpopThumbprint && ctx.dpopThumbprint && record.dpopThumbprint === ctx.dpopThumbprint
    );

    return {
      ok: true,
      principal: {
        credentialKind: 'oauth_mcp',
        credentialId: record.tokenId,
        tenantId: tenant.tenantId,
        orgId: tenant.orgId,
        allowedSiteIds: null,
        principalKind: principal.kind,
        principalId: principal.principalId,
        role: principal.role,
        effectiveScopes: new Set<Scope>(effective),
        senderConstrained,
        passkeyVerified: false,
      },
    };
  }
}
