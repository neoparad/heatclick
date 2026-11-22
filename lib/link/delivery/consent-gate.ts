/**
 * UGOKI LINK v2 — Delivery Consent Gate ([H-09])
 *
 * Enforces non-escalation when `siteDefault === 'off'` (hard site kill / measurement & delivery off):
 * CMP consent signals (`cmpResolved`) MUST NEVER escalate effective consent above `'off'`
 * unless the signed site bundle explicitly sets `allowCmpOptInFromDefaultOff === true`.
 */

import type { ExpressionTier } from './expressions';

export type DeliveryConsentMode = 'off' | 'cookieless' | 'essential_1p' | 'full';

const CONSENT_MODE_RANK: Readonly<Record<DeliveryConsentMode, number>> = {
  off: 0,
  cookieless: 1,
  essential_1p: 2,
  full: 3,
};

export interface DeliveryConsentGateInput {
  readonly siteDefault: DeliveryConsentMode;
  readonly cmpResolved?: DeliveryConsentMode;
  readonly loaderDataCap?: DeliveryConsentMode;
  /**
   * Must be explicitly `true` in the signed bundle (after privacy-relaxation approval)
   * before CMP opt-in is permitted to escalate a `siteDefault === 'off'` site.
   */
  readonly allowCmpOptInFromDefaultOff?: boolean;
  readonly requestedExpressionTier?: ExpressionTier;
}

export interface DeliveryConsentGateVerdict {
  readonly effectiveConsentMode: DeliveryConsentMode;
  readonly allowDelivery: boolean;
  readonly maxAllowedTier: ExpressionTier;
  readonly escalatedFromDefaultOff: boolean;
  readonly reason:
    | 'loader_data_cap_off'
    | 'site_default_off_locked'
    | 'effective_consent_off'
    | 'tier_permitted'
    | 'tier_blocked_by_consent';
}

function isValidConsentMode(value: unknown): value is DeliveryConsentMode {
  return (
    value === 'off' ||
    value === 'cookieless' ||
    value === 'essential_1p' ||
    value === 'full'
  );
}

/**
 * Resolves effective consent mode for runtime delivery, failing closed to `'off'`
 * on invalid inputs, `loaderDataCap === 'off'`, or `siteDefault === 'off'` without
 * explicit signed opt-in permission (`allowCmpOptInFromDefaultOff === true`).
 */
export function resolveDeliveryConsentMode(
  siteDefault: DeliveryConsentMode,
  cmpResolved?: DeliveryConsentMode,
  loaderDataCap?: DeliveryConsentMode,
  options?: { readonly allowCmpOptInFromDefaultOff?: boolean }
): DeliveryConsentMode {
  if (!isValidConsentMode(siteDefault)) {
    return 'off';
  }
  if (loaderDataCap !== undefined && !isValidConsentMode(loaderDataCap)) {
    return 'off';
  }
  if (cmpResolved !== undefined && !isValidConsentMode(cmpResolved)) {
    return 'off';
  }

  if (loaderDataCap === 'off') {
    return 'off';
  }

  // [H-09]: Hard site kill/off (`siteDefault === 'off'`) NEVER escalates via CMP
  // unless explicitly authorized in the signed bundle.
  if (siteDefault === 'off' && options?.allowCmpOptInFromDefaultOff !== true) {
    return 'off';
  }

  const base: DeliveryConsentMode = cmpResolved !== undefined ? cmpResolved : siteDefault;
  if (loaderDataCap === undefined) {
    return base;
  }
  return CONSENT_MODE_RANK[base] <= CONSENT_MODE_RANK[loaderDataCap] ? base : loaderDataCap;
}

/**
 * Evaluates full delivery consent gate including expression-tier eligibility.
 */
export function resolveDeliveryConsentGate(
  input: DeliveryConsentGateInput
): DeliveryConsentGateVerdict {
  if (input.loaderDataCap === 'off') {
    return {
      effectiveConsentMode: 'off',
      allowDelivery: false,
      maxAllowedTier: 'A0',
      escalatedFromDefaultOff: false,
      reason: 'loader_data_cap_off',
    };
  }

  if (input.siteDefault === 'off' && input.allowCmpOptInFromDefaultOff !== true) {
    return {
      effectiveConsentMode: 'off',
      allowDelivery: false,
      maxAllowedTier: 'A0',
      escalatedFromDefaultOff: false,
      reason: 'site_default_off_locked',
    };
  }

  const effective = resolveDeliveryConsentMode(
    input.siteDefault,
    input.cmpResolved,
    input.loaderDataCap,
    { allowCmpOptInFromDefaultOff: input.allowCmpOptInFromDefaultOff }
  );

  if (effective === 'off') {
    return {
      effectiveConsentMode: 'off',
      allowDelivery: false,
      maxAllowedTier: 'A0',
      escalatedFromDefaultOff: false,
      reason: 'effective_consent_off',
    };
  }

  // Under cookieless, cross-origin A3 frames are disallowed; A0/A1/A1c/A2 stateless/1P-free expressions only.
  const maxAllowedTier: ExpressionTier = effective === 'cookieless' ? 'A2' : 'A3';
  const escalatedFromDefaultOff = input.siteDefault === 'off' && CONSENT_MODE_RANK[effective] > 0;

  if (
    input.requestedExpressionTier === 'A3' &&
    effective === 'cookieless'
  ) {
    return {
      effectiveConsentMode: effective,
      allowDelivery: false,
      maxAllowedTier,
      escalatedFromDefaultOff,
      reason: 'tier_blocked_by_consent',
    };
  }

  return {
    effectiveConsentMode: effective,
    allowDelivery: true,
    maxAllowedTier,
    escalatedFromDefaultOff,
    reason: 'tier_permitted',
  };
}
