/**
 * UGOKI LINK v2 — Human-Authored Autonomous Envelope (§10.10, §11.6)
 *
 * Implements:
 * - Human-authored, content-hash sealed autonomous operational envelope (tamper-evident)
 * - Enforces scope, cost budget, exposure headcount ceiling (`maxExposedUnits`),
 *   conversions-at-risk ceiling (`maxConversionsAtRisk`), smoke sample size `ceil(3/ε)` (>= 300)
 * - Strictly prohibits percentage-ramp rollout as a safety condition (§11.6)
 * - Automatically halts all new display authorizations when business guardrail freshness expires
 * - Explicitly attaches the residual risk disclosure (§10.10 / §11.7)
 */

import {
  AuthorizationGateway,
  MAX_SMOKE_EPSILON,
  NON_DELEGABLE_R3_TO_R5_SCOPES,
  computeSmokeUnitsRequired,
  type AutonomyEnvelope,
  type FieldProvenance,
  type PasskeyAssertionInput,
  type Scope,
  type VerifiedPrincipal,
} from '../auth';
import { canonicalJson, sha256Hex } from '../../../packages/contract/response';

export const DEFAULT_MAX_GUARDRAIL_STALENESS_SEC = 3600; // 1 hour

export interface HumanAuthoredEnvelopeSpec {
  readonly tenantId: string;
  readonly siteId: string;
  readonly allowedActions: readonly string[];
  readonly allowedScopes: readonly Scope[];
  readonly allowedPagePatterns: readonly string[];
  readonly allowedFieldProvenance: readonly Exclude<FieldProvenance, 'open'>[];
  readonly maxCostUnits: number;
  /** Maximum exposed headcount / units allowed under this envelope (§11.6). */
  readonly maxExposedUnits: number;
  /** Maximum conversions placed at risk before automatic halt (§11.6). */
  readonly maxConversionsAtRisk: number;
  /** Smoke failure rate bound ε (<= 0.01 -> N_smoke = ceil(3/ε) >= 300). */
  readonly smokeEpsilon?: number;
  /** Maximum allowed staleness of business guardrail metrics before auto-halt (seconds). */
  readonly maxGuardrailStalenessSec?: number;
  readonly terminatingEvents: readonly string[];
  readonly reviewByIso: string;
  readonly allowGeneratedCopy?: boolean;
  readonly generatedCopyGateOpen?: boolean;
  /**
   * §11.6: Percentage rollout MUST NEVER be used as a safety condition.
   * Supplying `true` is rejected unconditionally at authoring time.
   */
  readonly percentageRampAsSafetyGate?: boolean;
}

export interface SealedAutonomyEnvelope {
  readonly envelopeId: string;
  readonly spec: HumanAuthoredEnvelopeSpec;
  readonly contentHash: string;
  readonly authorPrincipalId: string;
  readonly authorRole: 'owner' | 'admin';
  readonly createdAtIso: string;
  readonly smokeUnitsRequired: number;
  readonly residualRiskStatement: string;
  costUnitsUsed: number;
  exposedUnitsUsed: number;
  conversionsAtRiskUsed: number;
  smokeUnitsObserved: number;
  smokeFailuresObserved: number;
  active: boolean;
  terminatedReason?: string;
  /** Optional underlying auth gateway envelope record when registered with AuthorizationGateway. */
  readonly gatewayEnvelope?: AutonomyEnvelope;
}

export interface BusinessGuardrailSnapshot {
  readonly lastCheckedAtIso: string;
  readonly allGuardrailsHealthy: boolean;
  readonly breachedGuardrails?: readonly string[];
}

export interface EnvelopeAuthorizationCheck {
  readonly allowed: boolean;
  readonly reason: string;
  readonly code: string;
  readonly remainingExposedUnits: number;
  readonly remainingConversionsAtRisk: number;
  readonly remainingCostUnits: number;
  readonly autoStoppedForStaleGuardrails: boolean;
}

function canonicalEnvelopeMaterial(spec: HumanAuthoredEnvelopeSpec): string {
  return canonicalJson({
    tenantId: spec.tenantId,
    siteId: spec.siteId,
    allowedActions: [...spec.allowedActions].sort(),
    allowedScopes: [...spec.allowedScopes].sort(),
    allowedPagePatterns: [...spec.allowedPagePatterns].sort(),
    allowedFieldProvenance: [...spec.allowedFieldProvenance].sort(),
    maxCostUnits: spec.maxCostUnits,
    maxExposedUnits: spec.maxExposedUnits,
    maxConversionsAtRisk: spec.maxConversionsAtRisk,
    smokeEpsilon: spec.smokeEpsilon ?? MAX_SMOKE_EPSILON,
    maxGuardrailStalenessSec:
      spec.maxGuardrailStalenessSec ?? DEFAULT_MAX_GUARDRAIL_STALENESS_SEC,
    terminatingEvents: [...spec.terminatingEvents].sort(),
    reviewByIso: spec.reviewByIso,
    allowGeneratedCopy: Boolean(spec.allowGeneratedCopy),
    generatedCopyGateOpen: Boolean(spec.generatedCopyGateOpen),
  });
}

export function computeSealedEnvelopeHash(spec: HumanAuthoredEnvelopeSpec): string {
  return sha256Hex(canonicalEnvelopeMaterial(spec));
}

/**
 * Verifies that a sealed envelope's spec has not been tampered with since human authoring.
 */
export function verifySealedEnvelopeIntegrity(
  envelope: SealedAutonomyEnvelope
): boolean {
  return computeSealedEnvelopeHash(envelope.spec) === envelope.contentHash;
}

/**
 * Authors and seals an immutable-hash Autonomous Envelope (§10.10 / §11.6).
 * Only interactive human owner/admin sessions may author an envelope; agents and
 * percentage-ramp safety conditions are rejected.
 */
export function createSealedAutonomyEnvelope(params: {
  readonly author: VerifiedPrincipal;
  readonly spec: HumanAuthoredEnvelopeSpec;
  readonly nowIso?: string;
  readonly gateway?: AuthorizationGateway;
  readonly passkeyAssertion?: PasskeyAssertionInput;
}):
  | { readonly ok: true; readonly envelope: SealedAutonomyEnvelope }
  | { readonly ok: false; readonly code: string; readonly reason: string } {
  const nowIso = params.nowIso ?? new Date().toISOString();

  // Strictly human interactive owner/admin authoring (§11.6)
  if (
    params.author.principalKind !== 'human' ||
    params.author.credentialKind !== 'session_cookie' ||
    !params.author.passkeyVerified
  ) {
    return {
      ok: false,
      code: 'HUMAN_INTERACTIVE_PASSKEY_REQUIRED',
      reason:
        'Autonomous envelopes can ONLY be authored by a passkey-verified human console session',
    };
  }
  if (params.author.role !== 'owner' && params.author.role !== 'admin') {
    return {
      ok: false,
      code: 'AUTHOR_ROLE_INSUFFICIENT',
      reason: 'Only owner or admin may author autonomous envelopes',
    };
  }
  if (params.author.tenantId !== params.spec.tenantId) {
    return {
      ok: false,
      code: 'CROSS_TENANT_AUTHOR_FORBIDDEN',
      reason: 'Author tenantId must match envelope tenantId',
    };
  }

  // §11.6: Percentage rollout MUST NEVER be accepted as a safety gate
  if (params.spec.percentageRampAsSafetyGate === true) {
    return {
      ok: false,
      code: 'PERCENTAGE_ROLLOUT_PROHIBITED_AS_SAFETY_GATE',
      reason:
        'Percentage ramp rollout cannot serve as a safety condition (§11.6); specify maxExposedUnits, maxConversionsAtRisk, and smokeEpsilon instead',
    };
  }

  // Disallow R3-R5 scopes inside any autonomous envelope
  for (const s of params.spec.allowedScopes) {
    if (NON_DELEGABLE_R3_TO_R5_SCOPES.has(s)) {
      return {
        ok: false,
        code: 'NON_DELEGABLE_SCOPE',
        reason: `Scope "${s}" (R3–R5) cannot be delegated inside an autonomous envelope`,
      };
    }
  }

  if (
    params.spec.maxCostUnits <= 0 ||
    params.spec.maxExposedUnits <= 0 ||
    params.spec.maxConversionsAtRisk <= 0
  ) {
    return {
      ok: false,
      code: 'INVALID_BUDGET_BOUNDS',
      reason: 'maxCostUnits, maxExposedUnits, and maxConversionsAtRisk must all be > 0',
    };
  }

  const smokeEpsilon = params.spec.smokeEpsilon ?? MAX_SMOKE_EPSILON;
  if (smokeEpsilon <= 0 || smokeEpsilon > MAX_SMOKE_EPSILON) {
    return {
      ok: false,
      code: 'INVALID_SMOKE_EPSILON',
      reason: `smokeEpsilon must be in (0, ${MAX_SMOKE_EPSILON}] (cannot relax N_smoke >= 300 floor)`,
    };
  }

  const normalizedSpec: HumanAuthoredEnvelopeSpec = {
    ...params.spec,
    smokeEpsilon,
    maxGuardrailStalenessSec:
      params.spec.maxGuardrailStalenessSec ?? DEFAULT_MAX_GUARDRAIL_STALENESS_SEC,
    percentageRampAsSafetyGate: false,
  };

  let gatewayEnvelope: AutonomyEnvelope | undefined;
  if (params.gateway && params.passkeyAssertion) {
    const gwRes = params.gateway.registerAutonomyEnvelope({
      principal: params.author,
      passkeyAssertion: params.passkeyAssertion,
      siteId: normalizedSpec.siteId,
      allowedActions: normalizedSpec.allowedActions,
      allowedScopes: normalizedSpec.allowedScopes,
      allowedFieldProvenance: normalizedSpec.allowedFieldProvenance,
      maxExposedUnits: normalizedSpec.maxExposedUnits,
      maxConversionsAtRisk: normalizedSpec.maxConversionsAtRisk,
      smokeEpsilon,
      terminatingEvents: normalizedSpec.terminatingEvents,
      reviewBy: normalizedSpec.reviewByIso,
      allowGeneratedCopy: normalizedSpec.allowGeneratedCopy,
      generatedCopyGateOpen: normalizedSpec.generatedCopyGateOpen,
      now: new Date(nowIso),
    });
    if (!gwRes.ok) {
      return { ok: false, code: gwRes.code, reason: gwRes.reason };
    }
    gatewayEnvelope = gwRes.envelope;
  }

  const contentHash = computeSealedEnvelopeHash(normalizedSpec);
  const smokeUnitsRequired = computeSmokeUnitsRequired(smokeEpsilon);

  return {
    ok: true,
    envelope: {
      envelopeId: gatewayEnvelope?.envelopeId ?? `env_${contentHash.slice(0, 16)}`,
      spec: normalizedSpec,
      contentHash,
      authorPrincipalId: params.author.principalId,
      authorRole: params.author.role,
      createdAtIso: nowIso,
      smokeUnitsRequired,
      residualRiskStatement: `Residual risk (§10.10/§11.7): Inside this envelope, a deceived agent's choices among approved assets and allowed pages are authorized operations. Blast radius is strictly bounded by maxExposedUnits=${normalizedSpec.maxExposedUnits} and maxConversionsAtRisk=${normalizedSpec.maxConversionsAtRisk}.`,
      costUnitsUsed: 0,
      exposedUnitsUsed: 0,
      conversionsAtRiskUsed: 0,
      smokeUnitsObserved: 0,
      smokeFailuresObserved: 0,
      active: true,
      gatewayEnvelope,
    },
  };
}

/**
 * Checks whether a new display/publish authorization is permitted under the sealed envelope.
 * Automatically stops new display authorizations if:
 * - contentHash integrity fails (tampered envelope)
 * - envelope is inactive or past `reviewByIso`
 * - business guardrails are unhealthy OR freshness has expired (§10.10)
 * - exposure headcount, conversions-at-risk, or cost budget would be exceeded
 * - smoke phase observed any failure or full rollout requested before `ceil(3/ε)` smoke units
 */
export function evaluateEnvelopePublishAllowance(params: {
  readonly envelope: SealedAutonomyEnvelope;
  readonly action: string;
  readonly pagePath: string;
  readonly requestedExposedUnits: number;
  readonly requestedConversionsAtRisk: number;
  readonly requestedCostUnits: number;
  readonly isSmokePhase: boolean;
  readonly guardrails: BusinessGuardrailSnapshot;
  readonly nowIso: string;
}): EnvelopeAuthorizationCheck {
  const { envelope } = params;
  const remainingExposed = Math.max(
    0,
    envelope.spec.maxExposedUnits - envelope.exposedUnitsUsed
  );
  const remainingConv = Math.max(
    0,
    envelope.spec.maxConversionsAtRisk - envelope.conversionsAtRiskUsed
  );
  const remainingCost = Math.max(
    0,
    envelope.spec.maxCostUnits - envelope.costUnitsUsed
  );

  const deny = (
    code: string,
    reason: string,
    autoStoppedForStaleGuardrails = false
  ): EnvelopeAuthorizationCheck => ({
    allowed: false,
    code,
    reason,
    remainingExposedUnits: remainingExposed,
    remainingConversionsAtRisk: remainingConv,
    remainingCostUnits: remainingCost,
    autoStoppedForStaleGuardrails,
  });

  if (!verifySealedEnvelopeIntegrity(envelope)) {
    return deny(
      'ENVELOPE_HASH_TAMPERED',
      'Envelope contentHash does not match canonical specification'
    );
  }
  if (!envelope.active) {
    return deny(
      'ENVELOPE_INACTIVE',
      `Envelope terminated (${envelope.terminatedReason ?? 'inactive'})`
    );
  }
  if (Date.parse(params.nowIso) > Date.parse(envelope.spec.reviewByIso)) {
    return deny(
      'ENVELOPE_REVIEW_EXPIRED',
      `Envelope review deadline ${envelope.spec.reviewByIso} has expired`
    );
  }

  // Business guardrail freshness auto-stop (§10.10)
  const maxStaleSec =
    envelope.spec.maxGuardrailStalenessSec ?? DEFAULT_MAX_GUARDRAIL_STALENESS_SEC;
  const guardrailAgeSec =
    (Date.parse(params.nowIso) - Date.parse(params.guardrails.lastCheckedAtIso)) / 1000;
  if (!Number.isFinite(guardrailAgeSec) || guardrailAgeSec > maxStaleSec) {
    return deny(
      'BUSINESS_GUARDRAIL_STALE_AUTO_STOP',
      `Business guardrail snapshot is stale (${Math.round(guardrailAgeSec)}s > ${maxStaleSec}s); new displays auto-stopped`,
      true
    );
  }
  if (!params.guardrails.allGuardrailsHealthy) {
    return deny(
      'BUSINESS_GUARDRAIL_BREACHED',
      `Guardrail breach active: ${(params.guardrails.breachedGuardrails ?? []).join(', ')}`
    );
  }

  if (!envelope.spec.allowedActions.includes(params.action)) {
    return deny('ACTION_OUT_OF_ENVELOPE', `Action "${params.action}" not in envelope scope`);
  }

  const pageMatched = envelope.spec.allowedPagePatterns.some((pat) => {
    if (pat.endsWith('*')) {
      return params.pagePath.startsWith(pat.slice(0, -1));
    }
    return params.pagePath === pat;
  });
  if (!pageMatched) {
    return deny(
      'PAGE_OUT_OF_ENVELOPE',
      `Page "${params.pagePath}" is outside allowedPagePatterns`
    );
  }

  // Smoke failure & smoke completion gate (`N_smoke = ceil(3 / ε) >= 300`)
  if (envelope.smokeFailuresObserved > 0) {
    return deny(
      'SMOKE_FAILURES_OBSERVED',
      'Non-zero smoke failures observed; autonomous expansion halted'
    );
  }
  if (
    !params.isSmokePhase &&
    envelope.smokeUnitsObserved < envelope.smokeUnitsRequired
  ) {
    return deny(
      'SMOKE_THRESHOLD_NOT_MET',
      `Observed smoke units (${envelope.smokeUnitsObserved}) < ceil(3/ε) (${envelope.smokeUnitsRequired})`
    );
  }

  if (
    params.requestedExposedUnits <= 0 ||
    envelope.exposedUnitsUsed + params.requestedExposedUnits >
      envelope.spec.maxExposedUnits
  ) {
    return deny(
      'EXPOSURE_HEADCOUNT_BUDGET_EXCEEDED',
      `Requested exposure (${params.requestedExposedUnits}) exceeds remaining maxExposedUnits (${remainingExposed})`
    );
  }
  if (
    params.requestedConversionsAtRisk < 0 ||
    envelope.conversionsAtRiskUsed + params.requestedConversionsAtRisk >
      envelope.spec.maxConversionsAtRisk
  ) {
    return deny(
      'CONVERSIONS_AT_RISK_BUDGET_EXCEEDED',
      `Requested conversions-at-risk (${params.requestedConversionsAtRisk}) exceeds remaining cap (${remainingConv})`
    );
  }
  if (
    params.requestedCostUnits < 0 ||
    envelope.costUnitsUsed + params.requestedCostUnits > envelope.spec.maxCostUnits
  ) {
    return deny(
      'COST_BUDGET_EXCEEDED',
      `Requested cost (${params.requestedCostUnits}) exceeds remaining maxCostUnits (${remainingCost})`
    );
  }

  return {
    allowed: true,
    code: 'ALLOWED_IN_ENVELOPE',
    reason: 'Authorized within human-authored autonomous envelope',
    remainingExposedUnits: remainingExposed - params.requestedExposedUnits,
    remainingConversionsAtRisk: remainingConv - params.requestedConversionsAtRisk,
    remainingCostUnits: remainingCost - params.requestedCostUnits,
    autoStoppedForStaleGuardrails: false,
  };
}
