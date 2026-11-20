/**
 * UGOKI LINK v2 — Session Replay Tier 3 Entitlement, Lane Isolation & Hard Auto-Stop Guards
 *
 * Implements Master Architecture v2 §4.5, §4.6, §11.11 item 8 & Decision D-26:
 *   - Dedicated isolated lane (`lane: 'session_replay'`), excluded from standard telemetry,
 *     cross-tenant pooling, ML training, and billable PV count.
 *   - Default `not_entitled` until owner decision D-26 + legal sign-off + consent purpose `session_replay`.
 *   - Hard-blocked under `off`, `cookieless`, and `stats_exempt`.
 *   - Mandatory un-overridable auto-stop on sensitive-industry sites, minors-directed sites,
 *     and any PV containing password / payment / sensitive fields.
 *   - Member-linked PVs excluded by default unless BOTH `member_link` purpose AND explicit D-26 member approval hold.
 */

import { requireDecisionEntitled } from '@/packages/contract/ledgers';
import type { ConsentMode, ConsentPurpose } from '@/packages/contract/schema';

export const REPLAY_LANE = 'session_replay' as const;

export interface ReplayLaneIsolationContract {
  readonly lane: typeof REPLAY_LANE;
  readonly countsTowardBillablePvs: false;
  readonly billingMeter: 'replay_sessions';
  readonly allowInCrossTenantPool: false;
  readonly allowInMlTraining: false;
  readonly usesClickHouseMemory: false;
}

export const REPLAY_LANE_ISOLATION: ReplayLaneIsolationContract = Object.freeze({
  lane: REPLAY_LANE,
  countsTowardBillablePvs: false,
  billingMeter: 'replay_sessions',
  allowInCrossTenantPool: false,
  allowInMlTraining: false,
  usesClickHouseMemory: false,
});

export interface ReplaySitePolicy {
  readonly tenantId: string;
  readonly siteId: string;
  readonly siteOptInEnabled: boolean;
  readonly sensitiveIndustry: boolean;
  readonly directedAtMinors: boolean;
  readonly sampleRate: number; // [0, 1]
  readonly retentionDays: number; // default 30
  readonly d26MemberReplayApproved: boolean;
}

export interface ReplayVisitContext {
  readonly consentMode: ConsentMode;
  readonly grantedPurposes: ReadonlyArray<ConsentPurpose>;
  readonly gpcEnabled: boolean;
  readonly isMemberLinked: boolean;
  readonly hasPasswordField: boolean;
  readonly hasPaymentField: boolean;
  readonly hasSensitiveMarkedField: boolean;
  /**
   * Optional override used strictly in simulation/test drills to verify post-D-26 behavior
   * without mutating the production Decision Ledger (`D-26` defaults to `pending` -> `not_entitled`).
   */
  readonly d26ApprovedOverrideForTest?: {
    readonly approved: boolean;
    readonly legalSignedOff: boolean;
  };
}

export type ReplayEntitlementVerdict =
  | {
      readonly allowed: true;
      readonly status: 'ok';
      readonly lane: typeof REPLAY_LANE;
      readonly isolation: ReplayLaneIsolationContract;
    }
  | {
      readonly allowed: false;
      readonly status: 'not_entitled' | 'not_collected' | 'suppressed';
      readonly code:
        | 'D26_DECISION_OR_LEGAL_PENDING'
        | 'SITE_OPT_IN_DISABLED'
        | 'GPC_ENABLED'
        | 'CONSENT_MODE_FORBIDS_REPLAY'
        | 'MISSING_SESSION_REPLAY_PURPOSE'
        | 'AUTO_STOP_SENSITIVE_INDUSTRY'
        | 'AUTO_STOP_MINORS_SITE'
        | 'AUTO_STOP_SENSITIVE_PV_DISCARDED'
        | 'MEMBER_PV_EXCLUDED_BY_DEFAULT';
      readonly discardExistingBuffer: boolean;
      readonly reason: string;
      readonly requiredGateId: string;
    };

export function evaluateReplayEntitlement(
  site: ReplaySitePolicy,
  visit: ReplayVisitContext
): ReplayEntitlementVerdict {
  // 1. Check D-26 owner ruling + legal sign-off (default closed -> not_entitled)
  if (visit.d26ApprovedOverrideForTest) {
    if (!visit.d26ApprovedOverrideForTest.approved || !visit.d26ApprovedOverrideForTest.legalSignedOff) {
      return {
        allowed: false,
        status: 'not_entitled',
        code: 'D26_DECISION_OR_LEGAL_PENDING',
        discardExistingBuffer: true,
        reason: 'Decision D-26 and legal sign-off are required before enabling Tier-3 visual replay',
        requiredGateId: 'surf.replay_zero_leak',
      };
    }
  } else {
    const decision = requireDecisionEntitled('D-26', { enforceLegalSignOff: true });
    if (!decision.entitled) {
      return {
        allowed: false,
        status: 'not_entitled',
        code: 'D26_DECISION_OR_LEGAL_PENDING',
        discardExistingBuffer: true,
        reason: decision.message,
        requiredGateId: 'surf.replay_zero_leak',
      };
    }
  }

  // 2. Hard un-overridable auto-stops (sensitive industry, minors, password/payment/sensitive PV)
  if (site.sensitiveIndustry) {
    return {
      allowed: false,
      status: 'not_entitled',
      code: 'AUTO_STOP_SENSITIVE_INDUSTRY',
      discardExistingBuffer: true,
      reason: 'Tier-3 replay is permanently disabled on sensitive-industry sites (§11.11.8)',
      requiredGateId: 'surf.replay_zero_leak',
    };
  }

  if (site.directedAtMinors) {
    return {
      allowed: false,
      status: 'not_entitled',
      code: 'AUTO_STOP_MINORS_SITE',
      discardExistingBuffer: true,
      reason: 'Tier-3 replay is permanently disabled on minors-directed sites (§11.11.8)',
      requiredGateId: 'surf.replay_zero_leak',
    };
  }

  if (visit.hasPasswordField || visit.hasPaymentField || visit.hasSensitiveMarkedField) {
    return {
      allowed: false,
      status: 'suppressed',
      code: 'AUTO_STOP_SENSITIVE_PV_DISCARDED',
      discardExistingBuffer: true,
      reason: 'Page view contains password, payment, or sensitive-marked fields; recording halted and buffer discarded',
      requiredGateId: 'surf.replay_zero_leak',
    };
  }

  // 3. Site opt-in & GPC respect
  if (!site.siteOptInEnabled) {
    return {
      allowed: false,
      status: 'not_collected',
      code: 'SITE_OPT_IN_DISABLED',
      discardExistingBuffer: true,
      reason: 'Site has not opted in to Tier-3 replay',
      requiredGateId: 'surf.replay_zero_leak',
    };
  }

  if (visit.gpcEnabled) {
    return {
      allowed: false,
      status: 'not_collected',
      code: 'GPC_ENABLED',
      discardExistingBuffer: true,
      reason: 'Global Privacy Control (GPC) signal disables Tier-3 replay',
      requiredGateId: 'tel.G10',
    };
  }

  // 4. Consent mode check (`off`, `cookieless`, `stats_exempt` strictly forbidden!)
  if (
    visit.consentMode === 'off' ||
    visit.consentMode === 'cookieless' ||
    visit.consentMode === 'stats_exempt'
  ) {
    return {
      allowed: false,
      status: 'not_collected',
      code: 'CONSENT_MODE_FORBIDS_REPLAY',
      discardExistingBuffer: true,
      reason: `Consent mode "${visit.consentMode}" does not permit individual Tier-3 replay`,
      requiredGateId: 'tel.G10',
    };
  }

  // 5. Dedicated consent purpose `screen_replay` (canonical ConsentPurpose in contract/schema) required
  if (!visit.grantedPurposes.includes('screen_replay')) {
    return {
      allowed: false,
      status: 'not_collected',
      code: 'MISSING_SESSION_REPLAY_PURPOSE',
      discardExistingBuffer: true,
      reason: 'Consent purpose "screen_replay" is not granted for this visit',
      requiredGateId: 'tel.G10',
    };
  }

  // 6. Member-linked PVs excluded by default unless BOTH `member_link` AND explicit D-26 member approval
  if (visit.isMemberLinked) {
    if (!visit.grantedPurposes.includes('member_link') || !site.d26MemberReplayApproved) {
      return {
        allowed: false,
        status: 'not_entitled',
        code: 'MEMBER_PV_EXCLUDED_BY_DEFAULT',
        discardExistingBuffer: true,
        reason:
          'Member-linked PVs are excluded from replay by default; requires both consent purpose "member_link" and explicit D-26 member-replay approval',
        requiredGateId: 'surf.replay_zero_leak',
      };
    }
  }

  return {
    allowed: true,
    status: 'ok',
    lane: REPLAY_LANE,
    isolation: REPLAY_LANE_ISOLATION,
  };
}
