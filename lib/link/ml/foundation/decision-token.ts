/**
 * UGOKI LINK v2 — ML Foundation: Signed Decision Token & Training-Row Integrity (`lib/link/ml/foundation/decision-token.ts`)
 *
 * Implements §8.2, ML M2:
 * - Signs & verifies `decision_token` (`dtk`) binding `(tenant_id, site_id, pv_id, unit_id,
 *   decision_no, issued_at_ms, arm_id, propensity, bundle_hash)`.
 * - Filters rows so ONLY cryptographically valid token rows enter ML training, OPE, and verdicts.
 * - Enforces hard reward caps:
 *   1. Max 1 outcome per `(decision_token, label_key)`
 *   2. Max 1 rewarded outcome per `(unit_id, label_key, utc_day)`
 * - Measures per-PV decision sequence gap rate (`missing_decision_ordinals / expected_ordinals`).
 * - Supports counterfactual trigger logging for `control` / `holdout` / `no_show` units in the
 *   exact same schema as shown treatment arms (§8.2).
 */

import { hmacSha256Hex } from '../../allocator/hmac';

export interface DecisionTokenClaims {
  readonly tenant_id: string;
  readonly site_id: string;
  readonly pv_id: string;
  readonly unit_id: string;
  readonly decision_no: number; // 1-based monotonic ordinal within PV
  readonly issued_at_ms: number;
  readonly arm_id: string;
  readonly propensity: number;
  readonly bundle_hash: string;
  /** True when control/holdout/no_show recorded at counterfactual trigger point (§8.2). */
  readonly is_counterfactual_no_show: boolean;
}

export interface SignedDecisionToken {
  readonly claims: DecisionTokenClaims;
  readonly token: string; // `dtk1.<32-hex-hmac>`
}

function canonicalTokenInput(c: DecisionTokenClaims): string {
  return [
    'ugk-dtk/1',
    c.tenant_id,
    c.site_id,
    c.pv_id,
    c.unit_id,
    String(c.decision_no),
    String(c.issued_at_ms),
    c.arm_id,
    c.propensity.toFixed(6),
    c.bundle_hash,
    c.is_counterfactual_no_show ? '1' : '0',
  ].join('|');
}

export function issueDecisionToken(
  claims: DecisionTokenClaims,
  secret: string
): SignedDecisionToken {
  if (!Number.isInteger(claims.decision_no) || claims.decision_no < 1) {
    throw new Error(`decision_no must be an integer >= 1, got ${claims.decision_no}`);
  }
  if (!Number.isFinite(claims.propensity) || claims.propensity <= 0 || claims.propensity > 1) {
    throw new Error(`propensity must be in (0, 1], got ${claims.propensity}`);
  }
  const mac = hmacSha256Hex(secret, canonicalTokenInput(claims)).slice(0, 32);
  return {
    claims,
    token: `dtk1.${mac}`,
  };
}

export function verifyDecisionToken(
  signed: SignedDecisionToken,
  secret: string
): boolean {
  if (!signed.token || !signed.token.startsWith('dtk1.')) return false;
  const expected = `dtk1.${hmacSha256Hex(secret, canonicalTokenInput(signed.claims)).slice(0, 32)}`;
  return signed.token === expected;
}

export interface DecisionOutcomeRow {
  readonly signed_token: SignedDecisionToken;
  readonly label_key: string;
  readonly outcome_value: number;
  readonly occurred_at_ms: number;
}

export interface FilteredTrainingRowsResult {
  readonly valid_rows: readonly DecisionOutcomeRow[];
  readonly rejected_invalid_token_count: number;
  readonly rejected_duplicate_token_label_count: number;
  readonly rejected_unit_daily_cap_count: number;
  readonly counterfactual_row_count: number;
}

/**
 * Filters raw decision+outcome rows into clean ML training/evaluation rows (§8.2):
 * - Rejects any row with invalid or tampered `decision_token`.
 * - Enforces <= 1 outcome per `(decision_token, label_key)`.
 * - Enforces <= 1 rewarded outcome per `(unit_id, label_key, UTC day)`.
 * - Preserves counterfactual `control`/`holdout`/`no_show` trigger rows on equal footing.
 */
export function filterTokenValidTrainingRows(
  rows: readonly DecisionOutcomeRow[],
  secret: string
): FilteredTrainingRowsResult {
  const validRows: DecisionOutcomeRow[] = [];
  const seenTokenLabel = new Set<string>();
  const seenUnitLabelDay = new Set<string>();

  let rejectedInvalidToken = 0;
  let rejectedDupTokenLabel = 0;
  let rejectedUnitDailyCap = 0;
  let counterfactualCount = 0;

  for (const row of rows) {
    if (!verifyDecisionToken(row.signed_token, secret)) {
      rejectedInvalidToken += 1;
      continue;
    }

    const c = row.signed_token.claims;
    const tokenLabelKey = `${row.signed_token.token}|${row.label_key}`;
    if (seenTokenLabel.has(tokenLabelKey)) {
      rejectedDupTokenLabel += 1;
      continue;
    }

    const utcDay = Math.floor(row.occurred_at_ms / 86_400_000);
    const unitDayKey = `${c.tenant_id}|${c.site_id}|${c.unit_id}|${row.label_key}|${utcDay}`;
    if (row.outcome_value > 0 && seenUnitLabelDay.has(unitDayKey)) {
      rejectedUnitDailyCap += 1;
      continue;
    }

    seenTokenLabel.add(tokenLabelKey);
    if (row.outcome_value > 0) {
      seenUnitLabelDay.add(unitDayKey);
    }
    if (c.is_counterfactual_no_show) {
      counterfactualCount += 1;
    }
    validRows.push(row);
  }

  return {
    valid_rows: validRows,
    rejected_invalid_token_count: rejectedInvalidToken,
    rejected_duplicate_token_label_count: rejectedDupTokenLabel,
    rejected_unit_daily_cap_count: rejectedUnitDailyCap,
    counterfactual_row_count: counterfactualCount,
  };
}

export interface DecisionGapRateReport {
  readonly total_pvs: number;
  readonly expected_decisions: number;
  readonly observed_decisions: number;
  readonly missing_decisions: number;
  readonly gap_rate: number;
}

/**
 * Computes decision sequence gap rate across PVs (`decision_no` 1..maxSeq per PV, §8.2).
 */
export function computeDecisionGapRate(
  decisions: ReadonlyArray<{ readonly pv_id: string; readonly decision_no: number }>
): DecisionGapRateReport {
  const byPv = new Map<string, Set<number>>();
  for (const d of decisions) {
    if (!Number.isInteger(d.decision_no) || d.decision_no < 1) continue;
    let set = byPv.get(d.pv_id);
    if (!set) {
      set = new Set<number>();
      byPv.set(d.pv_id, set);
    }
    set.add(d.decision_no);
  }

  let expected = 0;
  let observed = 0;
  for (const ordinals of byPv.values()) {
    let maxOrd = 0;
    for (const n of ordinals) {
      if (n > maxOrd) maxOrd = n;
    }
    expected += maxOrd;
    observed += ordinals.size;
  }

  const missing = Math.max(0, expected - observed);
  return {
    total_pvs: byPv.size,
    expected_decisions: expected,
    observed_decisions: observed,
    missing_decisions: missing,
    gap_rate: expected > 0 ? missing / expected : 0,
  };
}
