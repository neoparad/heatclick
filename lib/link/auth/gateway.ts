/**
 * UGOKI LINK v2 — Unified Authorization Gateway, Risk Classes R0–R5,
 * Human Passkey Approval, Autonomy Envelopes, Two-Phase Destruction & Hash-Chained Audit Log
 *
 * Implements Master Architecture v2 §11.3, §11.5–§11.9 and `surface-final.md` §5.3, §5.7, §5.9, §8.3.
 */

import crypto from 'node:crypto';
import { canonicalJson, sha256Hex } from '@/packages/contract/response';
import {
  FAIL_SAFE_STOP_ACTIONS,
  NON_DELEGABLE_R3_TO_R5_SCOPES,
  type AuditLogEntry,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type AutonomyEnvelope,
  type DestructionRequestRecord,
  type DestructionScope,
  type FieldProvenance,
  type PasskeyApprovalRecord,
  type PasskeyAssertionInput,
  type Scope,
  type VerifiedPrincipal,
} from './types';

// =========================================================================
// 1. Constants
// =========================================================================

/** Maximum age for a fresh WebAuthn passkey assertion on interactive R5 calls: 5 minutes. */
export const MAX_PASSKEY_ASSERTION_AGE_MS = 5 * 60 * 1000;

/** Maximum lifetime for a single-use human approval record: 24 hours. */
export const MAX_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Default smoke failure bound ε = 0.01 → N_smoke = ceil(3 / 0.01) = 300 exposed units (del.D17). */
export const MAX_SMOKE_EPSILON = 0.01;

/** Undo window for subject-level deletion (next daily batch <= 24h). */
export const SUBJECT_UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Undo window for site/tenant destruction or retention shortening (7 days). */
export const SITE_OR_TENANT_UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function computeSmokeUnitsRequired(epsilon: number): number {
  const clamped = Math.min(Math.max(epsilon, 1e-6), MAX_SMOKE_EPSILON);
  return Math.ceil(3 / clamped);
}

export function computeActionAndDiffHash(action: string, renderedDiff: unknown): {
  readonly actionHash: string;
  readonly renderedDiffHash: string;
  readonly combinedHash: string;
} {
  const actionHash = sha256Hex(action);
  const renderedDiffHash = sha256Hex(canonicalJson(renderedDiff ?? null));
  const combinedHash = sha256Hex(`${actionHash}:${renderedDiffHash}`);
  return { actionHash, renderedDiffHash, combinedHash };
}

// =========================================================================
// 2. Hash-Chained Append-Only Audit Log Store
// =========================================================================

const GENESIS_HASH = '0'.repeat(64);

export class AuditLogStore {
  private readonly entries: AuditLogEntry[] = [];

  public append(
    input: Omit<AuditLogEntry, 'auditId' | 'seq' | 'prevHash' | 'entryHash'>
  ): AuditLogEntry {
    const seq = this.entries.length + 1;
    const prevHash = this.entries.length > 0 ? this.entries[this.entries.length - 1].entryHash : GENESIS_HASH;
    const auditId = `aud_${seq.toString().padStart(8, '0')}_${crypto.randomBytes(4).toString('hex')}`;

    const material = canonicalJson({
      auditId,
      seq,
      timestamp: input.timestamp,
      prevHash,
      tenantId: input.tenantId,
      targetTenantId: input.targetTenantId,
      principalId: input.principalId,
      credentialKind: input.credentialKind,
      credentialId: input.credentialId,
      action: input.action,
      riskClass: input.riskClass,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      outcome: input.outcome,
      reason: input.reason,
      metadata: input.metadata ?? null,
    });
    const entryHash = sha256Hex(material);

    const entry: AuditLogEntry = {
      ...input,
      auditId,
      seq,
      prevHash,
      entryHash,
    };
    this.entries.push(entry);
    return entry;
  }

  public getAll(): ReadonlyArray<AuditLogEntry> {
    return [...this.entries];
  }

  public getForTenant(tenantId: string): ReadonlyArray<AuditLogEntry> {
    return this.entries.filter((e) => e.tenantId === tenantId || e.targetTenantId === tenantId);
  }

  public verifyChain(): { readonly valid: boolean; readonly brokenAtSeq?: number; readonly reason?: string } {
    let expectedPrev = GENESIS_HASH;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.seq !== i + 1) {
        return { valid: false, brokenAtSeq: e.seq, reason: 'SEQUENCE_DISCONTINUITY' };
      }
      if (e.prevHash !== expectedPrev) {
        return { valid: false, brokenAtSeq: e.seq, reason: 'PREV_HASH_MISMATCH' };
      }
      const recomputed = sha256Hex(
        canonicalJson({
          auditId: e.auditId,
          seq: e.seq,
          timestamp: e.timestamp,
          prevHash: e.prevHash,
          tenantId: e.tenantId,
          targetTenantId: e.targetTenantId,
          principalId: e.principalId,
          credentialKind: e.credentialKind,
          credentialId: e.credentialId,
          action: e.action,
          riskClass: e.riskClass,
          resourceType: e.resourceType,
          resourceId: e.resourceId,
          outcome: e.outcome,
          reason: e.reason,
          metadata: e.metadata ?? null,
        })
      );
      if (recomputed !== e.entryHash) {
        return { valid: false, brokenAtSeq: e.seq, reason: 'ENTRY_HASH_TAMPERED' };
      }
      expectedPrev = e.entryHash;
    }
    return { valid: true };
  }
}

// =========================================================================
// 3. Unified Authorization Gateway (R0–R5, 404 Foreign / 403 Own)
// =========================================================================

export interface AuthorizationGatewayOptions {
  readonly auditLog?: AuditLogStore;
  readonly approvalBaseUrl?: string;
  readonly failSafeStopMaxPerMinute?: number;
  /** Maximum bounded entries per in-memory state map before oldest/expired eviction (L-03). */
  readonly maxStateMapEntries?: number;
}

function setBoundedMap<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number,
  canEvictFirst?: (entry: V) => boolean
): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxEntries) {
    let evicted = false;
    if (canEvictFirst) {
      for (const [k, v] of map.entries()) {
        if (canEvictFirst(v)) {
          map.delete(k);
          evicted = true;
          break;
        }
      }
    }
    if (!evicted) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) {
        map.delete(oldestKey);
      }
    }
  }
  map.set(key, value);
}

export class AuthorizationGateway {
  public readonly auditLog: AuditLogStore;
  private readonly approvalBaseUrl: string;
  private readonly failSafeStopMaxPerMinute: number;
  private readonly maxStateMapEntries: number;

  private readonly approvals = new Map<string, PasskeyApprovalRecord>();
  private readonly envelopes = new Map<string, AutonomyEnvelope>();
  private readonly destructions = new Map<string, DestructionRequestRecord>();
  private readonly stopRateLog = new Map<string, number[]>();
  private readonly dailySubjectDeleteCounts = new Map<string, number>();
  private readonly consumedAssertionIds = new Map<string, number>();

  constructor(options: AuthorizationGatewayOptions = {}) {
    this.auditLog = options.auditLog ?? new AuditLogStore();
    this.approvalBaseUrl = options.approvalBaseUrl ?? 'https://console.ugokilink.invalid/approvals';
    this.failSafeStopMaxPerMinute = options.failSafeStopMaxPerMinute ?? 30;
    this.maxStateMapEntries = Math.max(16, options.maxStateMapEntries ?? 10_000);
  }

  // ---- Interactive Passkey Approval Minting (Rejects Bearer/API/MCP!) ----

  public createPasskeyApproval(params: {
    readonly principal: VerifiedPrincipal;
    readonly siteId: string;
    readonly action: string;
    readonly renderedDiff: unknown;
    readonly passkeyAssertion: PasskeyAssertionInput;
    readonly ttlMs?: number;
    readonly now?: Date;
  }):
    | { readonly ok: true; readonly approval: PasskeyApprovalRecord }
    | { readonly ok: false; readonly httpStatus: 401 | 403; readonly code: string; readonly reason: string } {
    const now = params.now ?? new Date();

    // Strictly reject bearer / API / MCP / OEM / federation credentials!
    if (params.principal.credentialKind !== 'session_cookie') {
      return {
        ok: false,
        httpStatus: 403,
        code: 'BEARER_CREDENTIAL_REJECTED',
        reason: 'Passkey approval requires an interactive console session cookie; bearer/API/MCP credentials are rejected',
      };
    }

    if (params.principal.role !== 'owner' && params.principal.role !== 'admin') {
      return {
        ok: false,
        httpStatus: 403,
        code: 'APPROVER_ROLE_INSUFFICIENT',
        reason: 'Only owner or admin principals may issue passkey approvals',
      };
    }

    const { actionHash, renderedDiffHash, combinedHash } = computeActionAndDiffHash(
      params.action,
      params.renderedDiff
    );

    const assertionCheck = this.verifyPasskeyAssertion(params.passkeyAssertion, combinedHash, now);
    if (!assertionCheck.ok) {
      return {
        ok: false,
        httpStatus: 401,
        code: assertionCheck.code,
        reason: assertionCheck.reason,
      };
    }

    const ttlMs = Math.min(Math.max(60_000, params.ttlMs ?? MAX_APPROVAL_TTL_MS), MAX_APPROVAL_TTL_MS);
    const approvalId = `apr_${crypto.randomBytes(10).toString('hex')}`;

    const record: PasskeyApprovalRecord = {
      approvalId,
      tenantId: params.principal.tenantId,
      siteId: params.siteId,
      approverPrincipalId: params.principal.principalId,
      approverRole: params.principal.role,
      action: params.action,
      actionHash,
      renderedDiffHash,
      webauthnCredentialId: params.passkeyAssertion.credentialId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    setBoundedMap(
      this.approvals,
      approvalId,
      record,
      this.maxStateMapEntries,
      (v) => Boolean(v.consumedAt) || Date.parse(v.expiresAt) <= now.getTime()
    );

    this.auditLog.append({
      timestamp: now.toISOString(),
      tenantId: params.principal.tenantId,
      targetTenantId: params.principal.tenantId,
      principalId: params.principal.principalId,
      credentialKind: params.principal.credentialKind,
      credentialId: params.principal.credentialId,
      action: `approval.create:${params.action}`,
      riskClass: 'R5',
      resourceType: 'approval',
      resourceId: approvalId,
      outcome: 'allow',
      reason: 'Interactive passkey approval recorded',
      metadata: { actionHash, renderedDiffHash, siteId: params.siteId },
    });

    return { ok: true, approval: record };
  }

  // ---- Autonomy Envelope Registration (R5 — Human-Authored Only) ----

  public registerAutonomyEnvelope(params: {
    readonly principal: VerifiedPrincipal;
    readonly passkeyAssertion: PasskeyAssertionInput;
    readonly siteId: string;
    readonly allowedActions: ReadonlyArray<string>;
    readonly allowedScopes: ReadonlyArray<Scope>;
    readonly allowedFieldProvenance: ReadonlyArray<Exclude<FieldProvenance, 'open'>>;
    readonly maxExposedUnits: number;
    readonly maxConversionsAtRisk: number;
    readonly smokeEpsilon?: number;
    readonly terminatingEvents: ReadonlyArray<string>;
    readonly reviewBy: string;
    readonly allowGeneratedCopy?: boolean;
    readonly generatedCopyGateOpen?: boolean;
    readonly now?: Date;
  }):
    | { readonly ok: true; readonly envelope: AutonomyEnvelope }
    | { readonly ok: false; readonly httpStatus: 400 | 401 | 403; readonly code: string; readonly reason: string } {
    const now = params.now ?? new Date();

    if (params.principal.credentialKind !== 'session_cookie') {
      return {
        ok: false,
        httpStatus: 403,
        code: 'INTERACTIVE_PASSKEY_REQUIRED',
        reason: 'Autonomy envelopes are R5 and can only be authored via interactive session + passkey',
      };
    }

    if (params.principal.role !== 'owner' && params.principal.role !== 'admin') {
      return {
        ok: false,
        httpStatus: 403,
        code: 'APPROVER_ROLE_INSUFFICIENT',
        reason: 'Only owner or admin may author autonomy envelopes',
      };
    }

    // Disallow R3-R5 scopes inside an autonomy envelope
    for (const s of params.allowedScopes) {
      if (NON_DELEGABLE_R3_TO_R5_SCOPES.has(s)) {
        return {
          ok: false,
          httpStatus: 400,
          code: 'NON_AUTONOMOUS_SCOPE',
          reason: `Scope "${s}" cannot be delegated to an autonomy envelope`,
        };
      }
    }

    if (params.maxExposedUnits <= 0 || params.maxConversionsAtRisk <= 0) {
      return {
        ok: false,
        httpStatus: 400,
        code: 'INVALID_EXPOSURE_BUDGET',
        reason: 'Exposure budget and conversions-at-risk caps must be positive',
      };
    }

    const smokeEpsilon = params.smokeEpsilon ?? MAX_SMOKE_EPSILON;
    if (smokeEpsilon <= 0 || smokeEpsilon > MAX_SMOKE_EPSILON) {
      return {
        ok: false,
        httpStatus: 400,
        code: 'INVALID_SMOKE_EPSILON',
        reason: `Smoke epsilon must be in (0, ${MAX_SMOKE_EPSILON}] (cannot loosen safety floor)`,
      };
    }

    const canonicalSpec = {
      tenantId: params.principal.tenantId,
      siteId: params.siteId,
      allowedActions: [...params.allowedActions].sort(),
      allowedScopes: [...params.allowedScopes].sort(),
      allowedFieldProvenance: [...params.allowedFieldProvenance].sort(),
      maxExposedUnits: params.maxExposedUnits,
      maxConversionsAtRisk: params.maxConversionsAtRisk,
      smokeEpsilon,
      terminatingEvents: [...params.terminatingEvents].sort(),
      reviewBy: params.reviewBy,
      allowGeneratedCopy: Boolean(params.allowGeneratedCopy),
    };
    const contentHash = sha256Hex(canonicalJson(canonicalSpec));
    const { combinedHash } = computeActionAndDiffHash('envelope.create', canonicalSpec);

    const assertionCheck = this.verifyPasskeyAssertion(params.passkeyAssertion, combinedHash, now);
    if (!assertionCheck.ok) {
      return {
        ok: false,
        httpStatus: 401,
        code: assertionCheck.code,
        reason: assertionCheck.reason,
      };
    }

    const envelopeId = `env_${crypto.randomBytes(8).toString('hex')}`;
    const envelope: AutonomyEnvelope = {
      envelopeId,
      tenantId: params.principal.tenantId,
      siteId: params.siteId,
      authorPrincipalId: params.principal.principalId,
      authorApprovalId: `r5_${params.passkeyAssertion.credentialId}`,
      contentHash,
      allowedActions: [...params.allowedActions],
      allowedScopes: [...params.allowedScopes],
      allowedFieldProvenance: [...params.allowedFieldProvenance],
      maxExposedUnits: params.maxExposedUnits,
      exposedUnitsUsed: 0,
      maxConversionsAtRisk: params.maxConversionsAtRisk,
      conversionsAtRiskUsed: 0,
      smokeEpsilon,
      smokeUnitsObserved: 0,
      smokeFailuresObserved: 0,
      terminatingEvents: [...params.terminatingEvents],
      reviewBy: params.reviewBy,
      allowGeneratedCopy: Boolean(params.allowGeneratedCopy),
      generatedCopyGateOpen: Boolean(params.generatedCopyGateOpen),
      active: true,
    };

    setBoundedMap(
      this.envelopes,
      envelopeId,
      envelope,
      this.maxStateMapEntries,
      (v) => !v.active || Boolean(v.terminatedBy)
    );
    return { ok: true, envelope };
  }

  public recordEnvelopeSmokeProgress(
    envelopeId: string,
    units: number,
    failures: number
  ): AutonomyEnvelope {
    const env = this.envelopes.get(envelopeId);
    if (!env) throw new Error(`Unknown envelope: ${envelopeId}`);
    env.smokeUnitsObserved += Math.max(0, units);
    env.smokeFailuresObserved += Math.max(0, failures);
    if (failures > 0) {
      env.active = false;
      env.terminatedBy = 'smoke_failure';
      env.terminatedAt = new Date().toISOString();
    }
    return env;
  }

  public triggerEnvelopeTerminatingEvent(
    envelopeId: string,
    eventName: string,
    now: Date = new Date()
  ): boolean {
    const env = this.envelopes.get(envelopeId);
    if (!env) return false;
    if (env.terminatingEvents.includes(eventName) || eventName === 'kill_switch') {
      env.active = false;
      env.terminatedBy = eventName;
      env.terminatedAt = now.toISOString();
      return true;
    }
    return false;
  }

  public getEnvelope(envelopeId: string): AutonomyEnvelope | undefined {
    return this.envelopes.get(envelopeId);
  }

  // ---- R4 Destruction Cancellation (Undo Window) ----

  public cancelDestruction(
    requestId: string,
    tenantId: string,
    undoToken: string,
    now: Date = new Date()
  ): { readonly ok: boolean; readonly code: string; readonly reason: string } {
    const rec = this.destructions.get(requestId);
    if (!rec || rec.tenantId !== tenantId) {
      return { ok: false, code: 'NOT_FOUND', reason: 'Destruction request not found' };
    }
    if (rec.state !== 'scheduled') {
      return { ok: false, code: 'INVALID_STATE', reason: `Cannot cancel request in state ${rec.state}` };
    }
    if (new Date(rec.undoWindowEndsAt).getTime() <= now.getTime()) {
      return { ok: false, code: 'UNDO_WINDOW_EXPIRED', reason: 'Undo window has closed' };
    }
    if (sha256Hex(undoToken) !== rec.undoTokenHash) {
      return { ok: false, code: 'INVALID_UNDO_TOKEN', reason: 'Undo token does not match' };
    }
    rec.state = 'cancelled';
    rec.cancelledAt = now.toISOString();
    return { ok: true, code: 'CANCELLED', reason: 'Destruction request cancelled within undo window' };
  }

  public getDestructionRequest(requestId: string): DestructionRequestRecord | undefined {
    return this.destructions.get(requestId);
  }

  // ---- Main Authorization Entry Point ----

  public authorize(req: AuthorizationRequest): AuthorizationDecision {
    const now = req.now ?? new Date();
    const { principal, resource } = req;

    // 1. Foreign tenant check FIRST -> ALWAYS 404 + audit row (`surface-final.md` §5.3 & §8.3).
    // Also detect caller-supplied tenant_id tampering attempts targeting a foreign tenant.
    if (
      resource.tenantId !== principal.tenantId ||
      (req.callerSuppliedTenantId !== undefined && req.callerSuppliedTenantId !== principal.tenantId)
    ) {
      const targetTenant =
        resource.tenantId !== principal.tenantId
          ? resource.tenantId
          : (req.callerSuppliedTenantId ?? resource.tenantId);
      const entry = this.auditLog.append({
        timestamp: now.toISOString(),
        tenantId: principal.tenantId,
        targetTenantId: targetTenant,
        principalId: principal.principalId,
        credentialKind: principal.credentialKind,
        credentialId: principal.credentialId,
        action: req.action,
        riskClass: req.riskClass,
        resourceType: resource.type,
        resourceId: resource.id,
        outcome: 'deny_404',
        reason: 'FOREIGN_TENANT_ACCESS_BLOCKED',
        metadata: {
          callerSuppliedTenantId: req.callerSuppliedTenantId ?? null,
        },
      });
      return {
        allowed: false,
        httpStatus: 404,
        code: 'NOT_FOUND',
        measureStatus: 'not_entitled',
        reason: 'Resource not found',
        auditEntryId: entry.auditId,
      };
    }

    // 2. Site constraint check (e.g., `ugk_pub` or site-scoped `ugk_sec`)
    if (principal.allowedSiteIds !== null && resource.siteId) {
      if (!principal.allowedSiteIds.includes(resource.siteId)) {
        // For ugk_pub, a foreign site ref even inside same tenant must not leak -> 403/404.
        // Own-tenant site outside key constraint -> 403.
        const entry = this.auditLog.append({
          timestamp: now.toISOString(),
          tenantId: principal.tenantId,
          targetTenantId: resource.tenantId,
          principalId: principal.principalId,
          credentialKind: principal.credentialKind,
          credentialId: principal.credentialId,
          action: req.action,
          riskClass: req.riskClass,
          resourceType: resource.type,
          resourceId: resource.id,
          outcome: 'deny_403',
          reason: 'SITE_NOT_IN_CREDENTIAL_ALLOWLIST',
        });
        return {
          allowed: false,
          httpStatus: 403,
          code: 'FORBIDDEN_SITE_SCOPE',
          measureStatus: 'not_entitled',
          reason: 'Credential is restricted to other sites within this tenant',
          auditEntryId: entry.auditId,
        };
      }
    }

    // 3. Credential-kind plane guards
    if (principal.credentialKind === 'ugk_pub') {
      const allowedPubAction = req.action === 'ingest' || req.action === 'decision';
      if (!allowedPubAction) {
        const entry = this.auditLog.append({
          timestamp: now.toISOString(),
          tenantId: principal.tenantId,
          targetTenantId: resource.tenantId,
          principalId: principal.principalId,
          credentialKind: principal.credentialKind,
          credentialId: principal.credentialId,
          action: req.action,
          riskClass: req.riskClass,
          resourceType: resource.type,
          resourceId: resource.id,
          outcome: 'deny_403',
          reason: 'PUBLIC_KEY_ONLY_FOR_INGEST_AND_DECISION',
        });
        return {
          allowed: false,
          httpStatus: 403,
          code: 'PUBLIC_KEY_OPERATION_FORBIDDEN',
          measureStatus: 'not_entitled',
          reason: 'ugk_pub_* credentials are limited to ingest and decision calls for their own site',
          auditEntryId: entry.auditId,
        };
      }
    }

    if (principal.credentialKind === 'ugk_oem' && !req.action.startsWith('oem.')) {
      const entry = this.auditLog.append({
        timestamp: now.toISOString(),
        tenantId: principal.tenantId,
        targetTenantId: resource.tenantId,
        principalId: principal.principalId,
        credentialKind: principal.credentialKind,
        credentialId: principal.credentialId,
        action: req.action,
        riskClass: req.riskClass,
        resourceType: resource.type,
        resourceId: resource.id,
        outcome: 'deny_403',
        reason: 'OEM_KEY_MANAGEMENT_PLANE_ONLY',
      });
      return {
        allowed: false,
        httpStatus: 403,
        code: 'OEM_EXCHANGE_REQUIRED',
        measureStatus: 'not_entitled',
        reason: 'ugk_oem_* keys operate on the management plane only; exchange for a <=15m child token to act inside a tenant',
        auditEntryId: entry.auditId,
      };
    }

    if (principal.credentialKind === 'ugk_edge') {
      const entry = this.auditLog.append({
        timestamp: now.toISOString(),
        tenantId: principal.tenantId,
        targetTenantId: resource.tenantId,
        principalId: principal.principalId,
        credentialKind: principal.credentialKind,
        credentialId: principal.credentialId,
        action: req.action,
        riskClass: req.riskClass,
        resourceType: resource.type,
        resourceId: resource.id,
        outcome: 'deny_403',
        reason: 'EDGE_KEY_NOT_FOR_CONTROL_API',
      });
      return {
        allowed: false,
        httpStatus: 403,
        code: 'EDGE_KEY_FORBIDDEN',
        measureStatus: 'not_entitled',
        reason: 'ugk_edge_* keys are exclusively for HMAC hand-off headers and log shippers',
        auditEntryId: entry.auditId,
      };
    }

    // 4. Own-tenant scope check -> 403 if insufficient
    if (req.requiredScope && !principal.effectiveScopes.has(req.requiredScope)) {
      const entry = this.auditLog.append({
        timestamp: now.toISOString(),
        tenantId: principal.tenantId,
        targetTenantId: resource.tenantId,
        principalId: principal.principalId,
        credentialKind: principal.credentialKind,
        credentialId: principal.credentialId,
        action: req.action,
        riskClass: req.riskClass,
        resourceType: resource.type,
        resourceId: resource.id,
        outcome: 'deny_403',
        reason: `MISSING_SCOPE:${req.requiredScope}`,
      });
      return {
        allowed: false,
        httpStatus: 403,
        code: 'INSUFFICIENT_SCOPE',
        measureStatus: 'not_entitled',
        reason: `Missing required scope: ${req.requiredScope}`,
        auditEntryId: entry.auditId,
      };
    }

    // 5. Risk Class Enforcement (R0–R5)
    switch (req.riskClass) {
      case 'R0':
        return this.allow(req, now, 'R0_READ_ALLOWED');

      case 'R1':
        return this.enforceR1(req, now);

      case 'R2':
        return this.enforceR2(req, now);

      case 'R3':
        return this.enforceR3(req, now);

      case 'R4':
        return this.enforceR4(req, now);

      case 'R5':
        return this.enforceR5(req, now);
    }
  }

  private enforceR1(req: AuthorizationRequest, now: Date): AuthorizationDecision {
    if (!req.idempotencyKey || req.idempotencyKey.trim().length < 8) {
      const entry = this.auditLog.append({
        timestamp: now.toISOString(),
        tenantId: req.principal.tenantId,
        targetTenantId: req.resource.tenantId,
        principalId: req.principal.principalId,
        credentialKind: req.principal.credentialKind,
        credentialId: req.principal.credentialId,
        action: req.action,
        riskClass: 'R1',
        resourceType: req.resource.type,
        resourceId: req.resource.id,
        outcome: 'deny_400',
        reason: 'IDEMPOTENCY_KEY_REQUIRED',
      });
      return {
        allowed: false,
        httpStatus: 400,
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        measureStatus: 'invalid',
        reason: 'R1 operations require an Idempotency-Key (>= 8 chars)',
        auditEntryId: entry.auditId,
      };
    }

    const isStop =
      req.isFailSafeStop ||
      (FAIL_SAFE_STOP_ACTIONS as ReadonlyArray<string>).some((s) => req.action.endsWith(s));
    if (isStop) {
      const key = `${req.principal.tenantId}:${req.principal.credentialId}`;
      const cutoff = now.getTime() - 60_000;
      const recent = (this.stopRateLog.get(key) ?? []).filter((ts) => ts > cutoff);
      if (recent.length >= this.failSafeStopMaxPerMinute) {
        const entry = this.auditLog.append({
          timestamp: now.toISOString(),
          tenantId: req.principal.tenantId,
          targetTenantId: req.resource.tenantId,
          principalId: req.principal.principalId,
          credentialKind: req.principal.credentialKind,
          credentialId: req.principal.credentialId,
          action: req.action,
          riskClass: 'R1',
          resourceType: req.resource.type,
          resourceId: req.resource.id,
          outcome: 'deny_429',
          reason: 'FAIL_SAFE_STOP_RATE_LIMITED',
        });
        return {
          allowed: false,
          httpStatus: 429,
          code: 'STOP_RATE_LIMITED',
          measureStatus: 'pending',
          reason: 'Fail-safe stop rate limit exceeded',
          auditEntryId: entry.auditId,
        };
      }
      recent.push(now.getTime());
      setBoundedMap(this.stopRateLog, key, recent, this.maxStateMapEntries);
      return this.allow(req, now, 'R1_FAIL_SAFE_STOP_ALLOWED');
    }

    return this.allow(req, now, 'R1_DRAFT_ALLOWED');
  }

  private consumeVerifiedPasskeyApproval(
    req: AuthorizationRequest,
    approvalId: string,
    actionPayload: unknown,
    now: Date,
    approvalUrl: string
  ):
    | { readonly ok: true; readonly approval: PasskeyApprovalRecord }
    | { readonly ok: false; readonly decision: AuthorizationDecision } {
    const { actionHash, renderedDiffHash } = computeActionAndDiffHash(req.action, actionPayload);
    const apr = this.approvals.get(approvalId);
    if (
      !apr ||
      apr.tenantId !== req.principal.tenantId ||
      (req.resource.siteId && apr.siteId !== '*' && apr.siteId !== req.resource.siteId)
    ) {
      return { ok: false, decision: this.denyPending(req, now, 'APPROVAL_NOT_FOUND', approvalUrl) };
    }
    if (apr.consumedAt) {
      return {
        ok: false,
        decision: this.denyPending(req, now, 'APPROVAL_ALREADY_CONSUMED', approvalUrl),
      };
    }
    if (new Date(apr.expiresAt).getTime() <= now.getTime()) {
      return { ok: false, decision: this.denyPending(req, now, 'APPROVAL_EXPIRED', approvalUrl) };
    }
    if (apr.actionHash !== actionHash || apr.renderedDiffHash !== renderedDiffHash) {
      return {
        ok: false,
        decision: this.denyPending(req, now, 'APPROVAL_DIFF_MISMATCH', approvalUrl),
      };
    }
    apr.consumedAt = now.toISOString();
    return { ok: true, approval: apr };
  }

  private enforceR2(req: AuthorizationRequest, now: Date): AuthorizationDecision {
    const { renderedDiffHash } = computeActionAndDiffHash(req.action, req.renderedDiff);
    const approvalUrl = `${this.approvalBaseUrl}?tenant=${encodeURIComponent(req.principal.tenantId)}&action=${encodeURIComponent(req.action)}&diff=${renderedDiffHash.slice(0, 16)}`;

    // Path A: Valid single-use human passkey approval record
    if (req.passkeyApprovalId) {
      const consumed = this.consumeVerifiedPasskeyApproval(
        req,
        req.passkeyApprovalId,
        req.renderedDiff,
        now,
        approvalUrl
      );
      if (!consumed.ok) {
        return consumed.decision;
      }
      return this.allow(req, now, 'R2_APPROVED_BY_PASSKEY', {
        approvalId: consumed.approval.approvalId,
      });
    }

    // Path B: Active Autonomy Envelope + sender-constrained credential
    if (req.autonomyEnvelopeId) {
      const env = this.envelopes.get(req.autonomyEnvelopeId);
      if (
        !env ||
        env.tenantId !== req.principal.tenantId ||
        (req.resource.siteId && env.siteId !== req.resource.siteId)
      ) {
        return this.denyPending(req, now, 'ENVELOPE_NOT_FOUND', approvalUrl);
      }
      if (!env.active || env.terminatedBy) {
        return this.denyPending(req, now, `ENVELOPE_TERMINATED:${env.terminatedBy ?? 'inactive'}`, approvalUrl);
      }
      if (new Date(env.reviewBy).getTime() <= now.getTime()) {
        return this.denyPending(req, now, 'ENVELOPE_REVIEW_OVERDUE', approvalUrl);
      }
      if (!req.principal.senderConstrained) {
        return this.denyPending(req, now, 'SENDER_CONSTRAINED_CREDENTIAL_REQUIRED', approvalUrl);
      }
      if (!env.allowedActions.includes(req.action)) {
        return this.denyPending(req, now, 'ACTION_OUTSIDE_ENVELOPE', approvalUrl);
      }
      if (req.requiredScope && !env.allowedScopes.includes(req.requiredScope)) {
        return this.denyPending(req, now, 'SCOPE_OUTSIDE_ENVELOPE', approvalUrl);
      }

      // Non-overridable safety rule 1: No `open` provenance field without human approval
      const provenances = req.fieldProvenance ?? [];
      for (const p of provenances) {
        if (p === 'open') {
          return this.denyPending(req, now, 'OPEN_FIELD_REQUIRES_HUMAN_APPROVAL', approvalUrl);
        }
        if (p === 'generated_checked' && (!env.allowGeneratedCopy || !env.generatedCopyGateOpen)) {
          return this.denyPending(req, now, 'GENERATED_COPY_AUTONOMY_GATE_CLOSED', approvalUrl);
        }
        if (!env.allowedFieldProvenance.includes(p)) {
          return this.denyPending(req, now, `FIELD_PROVENANCE_NOT_IN_ENVELOPE:${p}`, approvalUrl);
        }
      }

      // Non-overridable safety rule 2: Price or offer terms require legal_signoff_ref
      if (req.touchesPriceOrOffer && !req.legalSignoffRef) {
        return this.denyPending(req, now, 'PRICE_OR_OFFER_REQUIRES_LEGAL_SIGNOFF', approvalUrl);
      }

      // Smoke phase gate: N = ceil(3 / epsilon) before full-envelope rollout
      const requiredSmoke = computeSmokeUnitsRequired(env.smokeEpsilon);
      if (!req.smokePhase && (env.smokeUnitsObserved < requiredSmoke || env.smokeFailuresObserved > 0)) {
        return this.denyPending(
          req,
          now,
          `SMOKE_PHASE_INCOMPLETE:${env.smokeUnitsObserved}/${requiredSmoke}`,
          approvalUrl
        );
      }

      // Exposure budget check
      const reqUnits = req.requestedExposedUnits ?? 0;
      const reqConvRisk = req.requestedConversionsAtRisk ?? 0;
      if (env.exposedUnitsUsed + reqUnits > env.maxExposedUnits) {
        return this.denyPending(req, now, 'ENVELOPE_EXPOSURE_BUDGET_EXCEEDED', approvalUrl);
      }
      if (env.conversionsAtRiskUsed + reqConvRisk > env.maxConversionsAtRisk) {
        return this.denyPending(req, now, 'ENVELOPE_CONVERSION_RISK_BUDGET_EXCEEDED', approvalUrl);
      }

      env.exposedUnitsUsed += reqUnits;
      env.conversionsAtRiskUsed += reqConvRisk;
      return this.allow(req, now, 'R2_ALLOWED_BY_AUTONOMY_ENVELOPE', {
        envelopeId: env.envelopeId,
        exposedUnitsUsed: env.exposedUnitsUsed,
        conversionsAtRiskUsed: env.conversionsAtRiskUsed,
      });
    }

    // Neither approval nor active envelope -> return pending + approval URL
    return this.denyPending(req, now, 'R2_APPROVAL_OR_ENVELOPE_REQUIRED', approvalUrl);
  }

  private enforceR3(req: AuthorizationRequest, now: Date): AuthorizationDecision {
    const pt = req.provisionTarget;
    if (!pt) {
      return this.deny403(req, now, 'PROVISION_TARGET_REQUIRED', 'R3 provisioning requires explicit target metadata');
    }

    // Never self-issuance (`surface-final.md` §5.3)
    if (pt.targetPrincipalId === req.principal.principalId) {
      return this.deny403(req, now, 'R3_SELF_ISSUANCE_FORBIDDEN', 'A principal may never provision credentials for itself');
    }

    // Never R3-R5 scopes
    for (const s of pt.requestedScopes) {
      if (NON_DELEGABLE_R3_TO_R5_SCOPES.has(s)) {
        return this.deny403(
          req,
          now,
          'R3_FORBIDDEN_HIGH_RISK_SCOPE',
          `Scope "${s}" (R3–R5) cannot be provisioned programmatically`
        );
      }
      if (!pt.issuerDelegableScopes.includes(s)) {
        return this.deny403(
          req,
          now,
          'R3_SCOPE_EXCEEDS_ISSUER_DELEGABLE',
          `Requested scope "${s}" exceeds issuer delegable set`
        );
      }
      if (pt.childPolicyAllowedScopes && !pt.childPolicyAllowedScopes.includes(s)) {
        return this.deny403(
          req,
          now,
          'R3_SCOPE_EXCEEDS_CHILD_POLICY',
          `Requested scope "${s}" exceeds child delegation policy`
        );
      }
    }

    const entry = this.auditLog.append({
      timestamp: now.toISOString(),
      tenantId: req.principal.tenantId,
      targetTenantId: req.resource.tenantId,
      principalId: req.principal.principalId,
      credentialKind: req.principal.credentialKind,
      credentialId: req.principal.credentialId,
      action: req.action,
      riskClass: 'R3',
      resourceType: req.resource.type,
      resourceId: req.resource.id,
      outcome: 'allow',
      reason: 'R3_SEALED_PROVISION_ALLOWED',
      metadata: {
        targetPrincipalId: pt.targetPrincipalId,
        grantedScopeCount: pt.requestedScopes.length,
        sealed: true,
      },
    });
    return {
      allowed: true,
      httpStatus: 200,
      code: 'OK_SEALED',
      measureStatus: 'ok',
      reason: 'R3 sealed provisioning authorized',
      auditEntryId: entry.auditId,
      sealed: true,
    };
  }

  private enforceR4(req: AuthorizationRequest, now: Date): AuthorizationDecision {
    const dest = req.destruction;
    if (!dest) {
      return this.deny403(req, now, 'DESTRUCTION_SPEC_REQUIRED', 'R4 destruction requires scope and reason');
    }

    const diffPayload = req.renderedDiff !== undefined ? req.renderedDiff : dest;
    const { combinedHash, renderedDiffHash } = computeActionAndDiffHash(req.action, diffPayload);
    const approvalUrl = `${this.approvalBaseUrl}?tenant=${encodeURIComponent(req.principal.tenantId)}&action=${encodeURIComponent(req.action)}&diff=${renderedDiffHash.slice(0, 16)}`;

    const subjectCount = dest.subjectIds?.length ?? 0;
    const dayUtc = now.toISOString().slice(0, 10);
    const dailyKey = `${req.principal.tenantId}\u0000${req.principal.credentialId}\u0000${dayUtc}`;
    const usedToday = this.dailySubjectDeleteCounts.get(dailyKey) ?? 0;
    const dailyCap = req.principal.constraints?.dailyDeleteSubjectsCap;

    const overDailySubjectCap =
      dest.scope === 'subject' &&
      dailyCap !== undefined &&
      usedToday + subjectCount > dailyCap;

    const isSiteOrTenantDestruction = dest.scope === 'site' || dest.scope === 'tenant';
    const requiresVerifiedPasskey =
      isSiteOrTenantDestruction || overDailySubjectCap || req.passkeyApprovalId !== undefined;

    if (requiresVerifiedPasskey) {
      if (req.passkeyApprovalId !== undefined) {
        if (!req.passkeyApprovalId.trim()) {
          return this.denyPending(req, now, 'APPROVAL_NOT_FOUND', approvalUrl);
        }
        const consumed = this.consumeVerifiedPasskeyApproval(
          req,
          req.passkeyApprovalId,
          diffPayload,
          now,
          approvalUrl
        );
        if (!consumed.ok) {
          return consumed.decision;
        }
      } else if (
        req.principal.credentialKind === 'session_cookie' &&
        (req.principal.role === 'owner' || req.principal.role === 'admin') &&
        req.passkeyAssertion
      ) {
        const assertionCheck = this.verifyPasskeyAssertion(req.passkeyAssertion, combinedHash, now);
        if (!assertionCheck.ok) {
          return this.denyPending(req, now, assertionCheck.code, approvalUrl);
        }
      } else {
        const pendingCode = overDailySubjectCap
          ? 'R4_BULK_DELETION_EXCEEDS_KEY_CAP'
          : 'R4_SITE_TENANT_DESTRUCTION_REQUIRES_APPROVAL';
        return this.denyPending(req, now, pendingCode, approvalUrl);
      }
    }

    if (dest.scope === 'subject' && subjectCount > 0) {
      setBoundedMap(
        this.dailySubjectDeleteCounts,
        dailyKey,
        usedToday + subjectCount,
        this.maxStateMapEntries
      );
    }

    const requestId = `del_${crypto.randomBytes(10).toString('hex')}`;
    const undoToken = `undo_${crypto.randomBytes(16).toString('base64url')}`;
    const windowMs = this.undoWindowForScope(dest.scope);
    const undoWindowEndsAt = new Date(now.getTime() + windowMs).toISOString();

    const record: DestructionRequestRecord = {
      requestId,
      tenantId: req.principal.tenantId,
      siteId: req.resource.siteId,
      scope: dest.scope,
      subjectIds: dest.subjectIds ? [...dest.subjectIds] : undefined,
      reason: dest.reason,
      undoTokenHash: sha256Hex(undoToken),
      state: 'scheduled',
      scheduledAt: now.toISOString(),
      undoWindowEndsAt,
    };
    setBoundedMap(
      this.destructions,
      requestId,
      record,
      this.maxStateMapEntries,
      (v) => v.state !== 'scheduled' || Date.parse(v.undoWindowEndsAt) <= now.getTime()
    );

    const entry = this.auditLog.append({
      timestamp: now.toISOString(),
      tenantId: req.principal.tenantId,
      targetTenantId: req.resource.tenantId,
      principalId: req.principal.principalId,
      credentialKind: req.principal.credentialKind,
      credentialId: req.principal.credentialId,
      action: req.action,
      riskClass: 'R4',
      resourceType: req.resource.type,
      resourceId: requestId,
      outcome: 'allow',
      reason: 'R4_TWO_PHASE_SCHEDULED',
      metadata: { scope: dest.scope, undoWindowEndsAt, subjectCount },
    });

    return {
      allowed: true,
      httpStatus: 202,
      code: 'SCHEDULED_TWO_PHASE',
      measureStatus: 'pending',
      reason: 'Two-phase destruction scheduled; undo token issued for rollback window',
      auditEntryId: entry.auditId,
      destructionRequest: {
        requestId,
        undoToken,
        undoWindowEndsAt,
        state: 'scheduled',
      },
    };
  }

  private enforceR5(req: AuthorizationRequest, now: Date): AuthorizationDecision {
    const { combinedHash, renderedDiffHash } = computeActionAndDiffHash(req.action, req.renderedDiff);
    const approvalUrl = `${this.approvalBaseUrl}?tenant=${encodeURIComponent(req.principal.tenantId)}&action=${encodeURIComponent(req.action)}&diff=${renderedDiffHash.slice(0, 16)}`;

    // R5 MUST be interactive session cookie + fresh WebAuthn passkey UV; bearer/API/MCP ALWAYS rejected!
    if (req.principal.credentialKind !== 'session_cookie') {
      const entry = this.auditLog.append({
        timestamp: now.toISOString(),
        tenantId: req.principal.tenantId,
        targetTenantId: req.resource.tenantId,
        principalId: req.principal.principalId,
        credentialKind: req.principal.credentialKind,
        credentialId: req.principal.credentialId,
        action: req.action,
        riskClass: 'R5',
        resourceType: req.resource.type,
        resourceId: req.resource.id,
        outcome: 'pending_approval',
        reason: 'R5_BEARER_REJECTED_INTERACTIVE_PASSKEY_REQUIRED',
      });
      return {
        allowed: false,
        httpStatus: 403,
        code: 'INTERACTIVE_PASSKEY_REQUIRED',
        measureStatus: 'pending',
        reason: 'R5 delegation requires an interactive console session and fresh WebAuthn passkey verification; API/MCP/bearer tokens are rejected',
        approvalUrl,
        auditEntryId: entry.auditId,
      };
    }

    if (req.principal.role !== 'owner' && req.principal.role !== 'admin') {
      return this.deny403(
        req,
        now,
        'R5_ROLE_INSUFFICIENT',
        'R5 delegation requires owner or admin role'
      );
    }

    if (!req.passkeyAssertion) {
      return this.denyPending(req, now, 'R5_PASSKEY_ASSERTION_MISSING', approvalUrl);
    }

    const assertionCheck = this.verifyPasskeyAssertion(req.passkeyAssertion, combinedHash, now);
    if (!assertionCheck.ok) {
      const entry = this.auditLog.append({
        timestamp: now.toISOString(),
        tenantId: req.principal.tenantId,
        targetTenantId: req.resource.tenantId,
        principalId: req.principal.principalId,
        credentialKind: req.principal.credentialKind,
        credentialId: req.principal.credentialId,
        action: req.action,
        riskClass: 'R5',
        resourceType: req.resource.type,
        resourceId: req.resource.id,
        outcome: 'deny_401',
        reason: assertionCheck.code,
      });
      return {
        allowed: false,
        httpStatus: 401,
        code: assertionCheck.code,
        measureStatus: 'pending',
        reason: assertionCheck.reason,
        approvalUrl,
        auditEntryId: entry.auditId,
      };
    }

    return this.allow(req, now, 'R5_PASSKEY_VERIFIED');
  }

  private verifyPasskeyAssertion(
    assertion: PasskeyAssertionInput,
    expectedCombinedHash: string,
    now: Date
  ): { readonly ok: true } | { readonly ok: false; readonly code: string; readonly reason: string } {
    if (!assertion.signatureVerified) {
      return { ok: false, code: 'PASSKEY_SIGNATURE_INVALID', reason: 'WebAuthn signature not verified' };
    }
    if (!assertion.userVerification) {
      return { ok: false, code: 'PASSKEY_UV_REQUIRED', reason: 'WebAuthn User Verification (UV) bit must be true' };
    }
    const ageMs = now.getTime() - new Date(assertion.assertedAt).getTime();
    if (ageMs < -30_000 || ageMs > MAX_PASSKEY_ASSERTION_AGE_MS) {
      return { ok: false, code: 'PASSKEY_ASSERTION_STALE', reason: 'Passkey assertion must be fresh (<= 5 min)' };
    }
    if (assertion.signedChallengeHash !== expectedCombinedHash) {
      return {
        ok: false,
        code: 'PASSKEY_CHALLENGE_MISMATCH',
        reason: 'Passkey assertion does not cover hash(action, rendered_diff)',
      };
    }
    const replayKey = `${assertion.credentialId}\u0000${assertion.signedChallengeHash}\u0000${assertion.assertedAt}`;
    if (this.consumedAssertionIds.has(replayKey)) {
      return {
        ok: false,
        code: 'PASSKEY_ASSERTION_REPLAYED',
        reason: 'Passkey assertion has already been consumed',
      };
    }
    setBoundedMap(this.consumedAssertionIds, replayKey, now.getTime(), this.maxStateMapEntries);
    return { ok: true };
  }

  private undoWindowForScope(scope: DestructionScope): number {
    return scope === 'subject' ? SUBJECT_UNDO_WINDOW_MS : SITE_OR_TENANT_UNDO_WINDOW_MS;
  }

  private allow(
    req: AuthorizationRequest,
    now: Date,
    reason: string,
    metadata?: Readonly<Record<string, unknown>>
  ): AuthorizationDecision {
    const entry = this.auditLog.append({
      timestamp: now.toISOString(),
      tenantId: req.principal.tenantId,
      targetTenantId: req.resource.tenantId,
      principalId: req.principal.principalId,
      credentialKind: req.principal.credentialKind,
      credentialId: req.principal.credentialId,
      action: req.action,
      riskClass: req.riskClass,
      resourceType: req.resource.type,
      resourceId: req.resource.id,
      outcome: 'allow',
      reason,
      metadata,
    });
    return {
      allowed: true,
      httpStatus: 200,
      code: 'OK',
      measureStatus: 'ok',
      reason,
      auditEntryId: entry.auditId,
    };
  }

  private deny403(
    req: AuthorizationRequest,
    now: Date,
    code: string,
    reason: string
  ): AuthorizationDecision {
    const entry = this.auditLog.append({
      timestamp: now.toISOString(),
      tenantId: req.principal.tenantId,
      targetTenantId: req.resource.tenantId,
      principalId: req.principal.principalId,
      credentialKind: req.principal.credentialKind,
      credentialId: req.principal.credentialId,
      action: req.action,
      riskClass: req.riskClass,
      resourceType: req.resource.type,
      resourceId: req.resource.id,
      outcome: 'deny_403',
      reason: code,
    });
    return {
      allowed: false,
      httpStatus: 403,
      code,
      measureStatus: 'not_entitled',
      reason,
      auditEntryId: entry.auditId,
    };
  }

  private denyPending(
    req: AuthorizationRequest,
    now: Date,
    code: string,
    approvalUrl: string
  ): AuthorizationDecision {
    const entry = this.auditLog.append({
      timestamp: now.toISOString(),
      tenantId: req.principal.tenantId,
      targetTenantId: req.resource.tenantId,
      principalId: req.principal.principalId,
      credentialKind: req.principal.credentialKind,
      credentialId: req.principal.credentialId,
      action: req.action,
      riskClass: req.riskClass,
      resourceType: req.resource.type,
      resourceId: req.resource.id,
      outcome: 'pending_approval',
      reason: code,
      metadata: { approvalUrl },
    });
    return {
      allowed: false,
      httpStatus: 202,
      code,
      measureStatus: 'pending',
      reason: `Human passkey approval required (${code})`,
      approvalUrl,
      auditEntryId: entry.auditId,
    };
  }
}
