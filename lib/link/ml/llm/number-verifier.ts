/**
 * UGOKI LINK v2 — In-House Number Verifier (Bundle 4-G, `lib/link/ml/llm/number-verifier.ts`)
 *
 * Implements §8.12 "守ること":
 * - Runs strictly IN-HOUSE (NEVER calls Jev — sending aggregate metrics to Jev violates §8.12!).
 * - Verifies that EVERY numeric claim in LLM-generated prose matches an explicit `VerifiedMetricValue`
 *   reference (`packages/contract/response`) on value, unit, period, and subject!
 * - Rejects hallucinated / ungrounded numbers, unit mismatches, period mismatches, or subject drift.
 * - Forces explicit `hypothesis` labeling on reasons & personas so observed facts and inferred
 *   hypotheses are never blurred.
 */

import {
  isVerifiedMetricValue,
  unwrapVerifiedMetricValue,
  type VerifiedMetricValue,
} from '../../../../packages/contract/response';

export interface GroundedMetricReference {
  readonly ref_id: string;
  readonly metric: VerifiedMetricValue<number>;
  readonly unit: '%' | '円' | '件' | 'ms' | '日' | '倍' | 'PV';
  readonly period_label: string; // e.g. '2026-10-21..2026-11-19'
  readonly subject_id: string; // e.g. 'site_wakegai:sec_price'
  readonly tolerance?: number; // default 0.05 for rounding
}

export interface ClaimedNumericCitation {
  readonly ref_id: string;
  readonly stated_value: number;
  readonly stated_unit: GroundedMetricReference['unit'];
  readonly stated_period_label: string;
  readonly stated_subject_id: string;
}

export interface NumberVerificationViolation {
  readonly code:
    | 'UNGROUNDED_LITERAL_NUMBER'
    | 'UNKNOWN_REF_ID'
    | 'UNVERIFIED_METRIC_BRAND'
    | 'VALUE_MISMATCH'
    | 'UNIT_MISMATCH'
    | 'PERIOD_MISMATCH'
    | 'SUBJECT_MISMATCH'
    | 'MISSING_HYPOTHESIS_LABEL';
  readonly message: string;
}

export interface ExplanationVerificationResult {
  readonly passed: boolean;
  readonly verifier_engine: 'in_house_deterministic'; // NEVER Jev!
  readonly uses_jev: false;
  readonly hypothesis_label: 'hypothesis';
  readonly verified_ref_ids: readonly string[];
  readonly violations: readonly NumberVerificationViolation[];
}

const NUMBER_TOKEN_RE = /-?\d+(?:,\d{3})*(?:\.\d+)?/g;

function extractNumbersFromProse(text: string): number[] {
  const matches = text.match(NUMBER_TOKEN_RE);
  if (!matches) return [];
  return matches
    .map((tok) => Number(tok.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
}

/**
 * Deterministically verifies LLM explanation prose + structured numeric citations against
 * branded `VerifiedMetricValue<number>` ground truth (§8.12).
 */
export function verifyExplanationNumbers(params: {
  readonly prose: string;
  readonly citations: readonly ClaimedNumericCitation[];
  readonly groundTruthRefs: readonly GroundedMetricReference[];
  readonly includesReasonOrPersona: boolean;
  readonly explicitHypothesisLabel?: 'hypothesis' | null;
}): ExplanationVerificationResult {
  const violations: NumberVerificationViolation[] = [];
  const verifiedRefIds: string[] = [];
  const refMap = new Map(params.groundTruthRefs.map((r) => [r.ref_id, r]));

  // 1. Reasons & personas MUST explicitly carry `hypothesis` label (§8.12)
  if (params.includesReasonOrPersona && params.explicitHypothesisLabel !== 'hypothesis') {
    violations.push({
      code: 'MISSING_HYPOTHESIS_LABEL',
      message: 'Reasons and cluster personas MUST be explicitly labelled as "hypothesis" (§8.12).',
    });
  }

  // 2. Verify every structured citation against its branded VerifiedMetricValue
  const groundedValues: Array<{ readonly value: number; readonly tol: number }> = [];
  for (const cite of params.citations) {
    const gt = refMap.get(cite.ref_id);
    if (!gt) {
      violations.push({
        code: 'UNKNOWN_REF_ID',
        message: `Citation references unknown metric ref_id "${cite.ref_id}"`,
      });
      continue;
    }
    if (!isVerifiedMetricValue(gt.metric)) {
      violations.push({
        code: 'UNVERIFIED_METRIC_BRAND',
        message: `Ground truth ref "${cite.ref_id}" is not a genuine VerifiedMetricValue`,
      });
      continue;
    }

    const actualValue = unwrapVerifiedMetricValue(gt.metric);
    const tol = gt.tolerance ?? 0.05;

    if (Math.abs(cite.stated_value - actualValue) > tol) {
      violations.push({
        code: 'VALUE_MISMATCH',
        message: `Ref "${cite.ref_id}": stated ${cite.stated_value} != verified ${actualValue} (tol ${tol})`,
      });
    }
    if (cite.stated_unit !== gt.unit) {
      violations.push({
        code: 'UNIT_MISMATCH',
        message: `Ref "${cite.ref_id}": stated unit "${cite.stated_unit}" != verified "${gt.unit}"`,
      });
    }
    if (cite.stated_period_label !== gt.period_label) {
      violations.push({
        code: 'PERIOD_MISMATCH',
        message: `Ref "${cite.ref_id}": stated period "${cite.stated_period_label}" != verified "${gt.period_label}"`,
      });
    }
    if (cite.stated_subject_id !== gt.subject_id) {
      violations.push({
        code: 'SUBJECT_MISMATCH',
        message: `Ref "${cite.ref_id}": stated subject "${cite.stated_subject_id}" != verified "${gt.subject_id}"`,
      });
    }

    groundedValues.push({ value: actualValue, tol });
    verifiedRefIds.push(cite.ref_id);
  }

  // 3. Scan raw prose for any ungrounded literal numbers not backed by a verified citation
  const proseNumbers = extractNumbersFromProse(params.prose);
  for (const num of proseNumbers) {
    const matched = groundedValues.some((g) => Math.abs(num - g.value) <= g.tol);
    if (!matched) {
      violations.push({
        code: 'UNGROUNDED_LITERAL_NUMBER',
        message: `Prose contains ungrounded number ${num} with no matching VerifiedMetricValue citation`,
      });
    }
  }

  return {
    passed: violations.length === 0,
    verifier_engine: 'in_house_deterministic',
    uses_jev: false,
    hypothesis_label: 'hypothesis',
    verified_ref_ids: verifiedRefIds,
    violations,
  };
}
