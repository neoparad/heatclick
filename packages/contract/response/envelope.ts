/**
 * UGOKI LINK v2 — Single Authoritative Response Envelope Serializer & Validator
 *
 * Implements §1.3, §9.10, §11.5, D-09, D-14, D-15, D-16, D-37, SUR M5:
 * - Enforces the closed 8-state measure status set (+ top-level `partial` only)
 * - Enforces the 4-tier evidence hierarchy (`planned < inferred < observed < proven`)
 * - Enforces Guards I1–I7 on every measure and every envelope:
 *   - I1: status !== 'ok' => value === null AND unmet_gates.length >= 1;
 *     `invalid | suppressed | not_collected` additionally require `interval === null` and `point_estimate === null`.
 *   - I2 (D-07R / D-09): below `proven` rejects any point estimate lift; predictive intervals when
 *     D-09 is unresolved (or below `proven`) require passing `sur.projection_calibrated`
 *     (Clopper-Pearson 95% LB >= 0.70, n >= 30, sites >= 3, gate_passed === true);
 *     at `proven`, point estimates require all §9.10 conditions & non-lab_randomised predicate.
 *   - I3: `proven` requires active non-tombstoned intervention ref, stored passing predicate criteria
 *     (`integrity_status === 'pass'`, finite numeric gates), and non-legacy gen.
 *   - I4: no confidence without non-empty confidence_basis (and finite confidence in [0, 1]).
 *   - I5: numeric leaves in measures AND `data` MUST arrive via `VerifiedMetricValue` WeakSet brand.
 *   - I6: every evidence ref must be a complete active ref or typed tombstone (`expired` | `erased`).
 *   - I7: every external-origin string anywhere in the response MUST be wrapped in `UntrustedValue`.
 */

import { requireDecisionEntitled } from '../ledgers';
import {
  assertValidNumericLeaf,
  isVerifiedMetricValue,
  unwrapVerifiedMetricValue,
  type VerifiedNumericLeaf,
} from './brand';
import {
  EnvelopeInvariantError,
  type EnvelopeViolation,
} from './errors';
import { canonicalJson } from './sha256';
import {
  EVIDENCE_LEVEL_RANK,
  EVIDENCE_LEVELS,
  MEASURE_STATUSES,
  PROVEN_PREDICATES,
  type EvidenceBlock,
  type EvidenceLevel,
  type EvidenceRef,
  type IntervalBlock,
  type MeasureInput,
  type MeasureStatus,
  type ProvenPredicateResult,
  type RequestStatus,
  type ResponseEnvelopeInput,
  type SampleBlock,
  type SerializedMeasureCell,
  type SerializedProjectionBlock,
  type SerializedResponseEnvelope,
  type UnmetGate,
} from './types';
import { detectUntrustedStringLeaks, isUntrustedValue } from './untrusted';

const MEASURE_STATUS_SET: ReadonlySet<string> = new Set(MEASURE_STATUSES);
const EVIDENCE_LEVEL_SET: ReadonlySet<string> = new Set(EVIDENCE_LEVELS);
const PROVEN_PREDICATE_SET: ReadonlySet<string> = new Set(PROVEN_PREDICATES);
const NULL_INTERVAL_AND_ESTIMATE_STATUSES: ReadonlySet<MeasureStatus> = new Set<MeasureStatus>([
  'invalid',
  'suppressed',
  'not_collected',
]);

export function compareEvidenceLevels(a: EvidenceLevel, b: EvidenceLevel): number {
  return EVIDENCE_LEVEL_RANK[a] - EVIDENCE_LEVEL_RANK[b];
}

export function isEvidenceAtLeast(actual: EvidenceLevel, required: EvidenceLevel): boolean {
  return EVIDENCE_LEVEL_RANK[actual] >= EVIDENCE_LEVEL_RANK[required];
}

function isNonEmptyStringArray(arr: readonly string[]): boolean {
  return (
    Array.isArray(arr) &&
    arr.length > 0 &&
    arr.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
}

function isPassingProvenPredicate(c: ProvenPredicateResult): boolean {
  if (!c || typeof c !== 'object') return false;
  if (!PROVEN_PREDICATE_SET.has(c.predicate)) return false;
  if (c.passed !== true) return false;
  if (c.tombstoned === true) return false;
  if (c.allocator_logged_before_outcomes !== true) return false;
  if (c.prereg_locked !== true) return false;
  if (c.integrity_status !== 'pass') return false;
  if (c.decision_rule_passed !== true) return false;
  if (typeof c.evaluated_at !== 'string' || c.evaluated_at.trim().length === 0) return false;

  if (
    typeof c.randomisation_audit_p !== 'number' ||
    !Number.isFinite(c.randomisation_audit_p) ||
    c.randomisation_audit_p < 0 ||
    c.randomisation_audit_p > 1 ||
    typeof c.alpha !== 'number' ||
    !Number.isFinite(c.alpha) ||
    c.alpha <= 0 ||
    c.alpha >= 1 ||
    c.randomisation_audit_p > c.alpha
  ) {
    return false;
  }

  if (c.sr_mismatch_p !== undefined) {
    if (
      typeof c.sr_mismatch_p !== 'number' ||
      !Number.isFinite(c.sr_mismatch_p) ||
      c.sr_mismatch_p < 0.001 ||
      c.sr_mismatch_p > 1
    ) {
      return false;
    }
  }

  if (c.effect_ci_excludes_zero !== undefined && c.effect_ci_excludes_zero !== true) {
    return false;
  }
  if (c.placebo_pass !== undefined && c.placebo_pass !== true) {
    return false;
  }
  if (c.pre_exposure_balance_pass !== undefined && c.pre_exposure_balance_pass !== true) {
    return false;
  }

  if (c.duration_days !== undefined) {
    if (typeof c.duration_days !== 'number' || !Number.isFinite(c.duration_days) || c.duration_days < 0) {
      return false;
    }
  }
  if (c.observation_days !== undefined) {
    if (typeof c.observation_days !== 'number' || !Number.isFinite(c.observation_days) || c.observation_days < 0) {
      return false;
    }
  }

  if (c.predicate !== 'lab_randomised') {
    const effectiveDays = c.observation_days ?? c.duration_days;
    if (typeof effectiveDays !== 'number' || !Number.isFinite(effectiveDays) || effectiveDays < 14) {
      return false;
    }
    if (c.duration_days !== undefined && c.duration_days < 14) return false;
    if (c.observation_days !== undefined && c.observation_days < 14) return false;
    if (c.platform_canary_passed !== true) return false;
  }

  if (c.query_refs !== undefined && !isNonEmptyStringArray(c.query_refs)) {
    return false;
  }
  if (c.artifact_refs !== undefined && !isNonEmptyStringArray(c.artifact_refs)) {
    return false;
  }

  return true;
}

function isTombstonedEvidenceRef(ref: EvidenceRef): boolean {
  if (!ref || typeof ref !== 'object') return false;
  if ('tombstone' in ref && ref.tombstone !== undefined) return true;
  if ((ref as { readonly tombstoned?: unknown }).tombstoned === true) return true;
  return false;
}

function validateEvidenceRef(
  ref: EvidenceRef,
  path: string,
  violations: EnvelopeViolation[]
): void {
  if (!ref || typeof ref !== 'object') {
    violations.push({
      code: 'INVALID_EVIDENCE_REF',
      path,
      message: 'Evidence ref must be an object',
    });
    return;
  }
  if (typeof ref.ref_id !== 'string' || ref.ref_id.trim().length === 0) {
    violations.push({
      code: 'INVALID_EVIDENCE_REF',
      path: `${path}.ref_id`,
      message: 'Evidence ref requires a non-empty ref_id',
    });
  }
  if ('tombstone' in ref && ref.tombstone !== undefined) {
    const t = ref.tombstone;
    if (
      !t ||
      (t.reason !== 'expired' && t.reason !== 'erased') ||
      typeof t.tombstoned_at !== 'string' ||
      t.tombstoned_at.trim().length === 0
    ) {
      violations.push({
        code: 'INVALID_EVIDENCE_REF',
        path: `${path}.tombstone`,
        message: 'Tombstoned evidence ref must specify reason ("expired" | "erased") and tombstoned_at',
      });
    }
    return;
  }
  if ((ref as { readonly tombstoned?: unknown }).tombstoned === true) {
    violations.push({
      code: 'INVALID_EVIDENCE_REF',
      path,
      message: 'Tombstoned evidence ref must carry a typed tombstone object',
    });
    return;
  }

  // Active ref requires complete resolution metadata (SUR §5.6 I6)
  if (
    typeof ref.params_hash !== 'string' ||
    ref.params_hash.trim().length === 0 ||
    typeof ref.result_digest !== 'string' ||
    ref.result_digest.trim().length === 0 ||
    typeof ref.issued_at !== 'string' ||
    ref.issued_at.trim().length === 0 ||
    typeof ref.valid_until !== 'string' ||
    ref.valid_until.trim().length === 0 ||
    typeof ref.kid !== 'string' ||
    ref.kid.trim().length === 0
  ) {
    violations.push({
      code: 'INVALID_EVIDENCE_REF',
      path,
      message: 'Active evidence ref must include params_hash, result_digest, issued_at, valid_until, and kid',
    });
  }
}

function validateUnmetGatesEntries(
  gates: readonly UnmetGate[],
  path: string,
  violations: EnvelopeViolation[]
): void {
  if (!Array.isArray(gates)) {
    violations.push({
      code: 'NON_OK_REQUIRES_UNMET_GATE_OR_REASON',
      path,
      message: 'unmet_gates must be an array',
    });
    return;
  }
  for (let i = 0; i < gates.length; i++) {
    const g = gates[i];
    const gPath = `${path}[${i}]`;
    if (
      !g ||
      typeof g !== 'object' ||
      typeof g.id !== 'string' ||
      g.id.trim().length === 0 ||
      typeof g.unlock !== 'string' ||
      g.unlock.trim().length === 0
    ) {
      violations.push({
        code: 'NON_OK_REQUIRES_UNMET_GATE_OR_REASON',
        path: gPath,
        message: 'Each UnmetGate requires non-empty id and unlock strings',
      });
      continue;
    }
    if (typeof g.required === 'number' && !Number.isFinite(g.required)) {
      violations.push({
        code: 'INVALID_SAMPLE_OR_INTERVAL',
        path: `${gPath}.required`,
        message: 'UnmetGate.required must be finite when numeric',
      });
    }
    if (typeof g.observed === 'number' && !Number.isFinite(g.observed)) {
      violations.push({
        code: 'INVALID_SAMPLE_OR_INTERVAL',
        path: `${gPath}.observed`,
        message: 'UnmetGate.observed must be finite when numeric',
      });
    }
    if (g.eta !== undefined && g.eta !== null) {
      if (
        typeof g.eta.min_days !== 'number' ||
        !Number.isFinite(g.eta.min_days) ||
        typeof g.eta.max_days !== 'number' ||
        !Number.isFinite(g.eta.max_days) ||
        g.eta.min_days < 0 ||
        g.eta.min_days > g.eta.max_days
      ) {
        violations.push({
          code: 'INVALID_SAMPLE_OR_INTERVAL',
          path: `${gPath}.eta`,
          message: 'UnmetGate.eta requires finite 0 <= min_days <= max_days',
        });
      }
    }
  }
}

function resolveUnmetGates(
  measure: Pick<MeasureInput<VerifiedNumericLeaf>, 'unmet_gates' | 'gates'>,
  path: string,
  violations: EnvelopeViolation[]
): readonly UnmetGate[] {
  const direct = measure.unmet_gates;
  const nested = measure.gates?.unmet;

  if (direct !== undefined && nested !== undefined) {
    if (canonicalJson(direct) !== canonicalJson(nested)) {
      violations.push({
        code: 'UNMET_GATES_MISMATCH',
        path,
        message: 'Both unmet_gates and gates.unmet were provided with conflicting entries',
      });
    }
    return direct;
  }
  return direct ?? nested ?? [];
}

function validateSampleBlock(
  sample: SampleBlock | null | undefined,
  status: MeasureStatus,
  path: string,
  violations: EnvelopeViolation[]
): void {
  if (status === 'ok') {
    if (
      !sample ||
      typeof sample !== 'object' ||
      typeof sample.n !== 'number' ||
      !Number.isInteger(sample.n) ||
      sample.n < 0
    ) {
      violations.push({
        code: 'INVALID_SAMPLE_OR_INTERVAL',
        path,
        message: 'Measure with status "ok" must provide a non-negative integer sample.n (§1.3)',
      });
      return;
    }
  } else if (sample !== null && sample !== undefined) {
    if (
      typeof sample !== 'object' ||
      typeof sample.n !== 'number' ||
      !Number.isInteger(sample.n) ||
      sample.n < 0
    ) {
      violations.push({
        code: 'INVALID_SAMPLE_OR_INTERVAL',
        path,
        message: 'sample.n must be a non-negative integer when sample is provided',
      });
      return;
    }
  }

  if (sample && sample.effective_n !== undefined) {
    if (
      typeof sample.effective_n !== 'number' ||
      !Number.isFinite(sample.effective_n) ||
      sample.effective_n < 0
    ) {
      violations.push({
        code: 'INVALID_SAMPLE_OR_INTERVAL',
        path: `${path}.effective_n`,
        message: 'sample.effective_n must be a finite non-negative number',
      });
    }
  }
}

function validateIntervalBlock(
  interval: IntervalBlock | null | undefined,
  status: MeasureStatus,
  path: string,
  violations: EnvelopeViolation[]
): void {
  if (NULL_INTERVAL_AND_ESTIMATE_STATUSES.has(status)) {
    if (interval !== null) {
      violations.push({
        code: 'INVALID_SAMPLE_OR_INTERVAL',
        path,
        message: `Measure with status "${status}" must have interval: null`,
      });
    }
    return;
  }

  if (interval !== null && interval !== undefined) {
    if (
      typeof interval !== 'object' ||
      typeof interval.lower !== 'number' ||
      typeof interval.upper !== 'number' ||
      typeof interval.level !== 'number' ||
      !Number.isFinite(interval.lower) ||
      !Number.isFinite(interval.upper) ||
      !Number.isFinite(interval.level) ||
      interval.lower > interval.upper ||
      interval.level <= 0 ||
      interval.level >= 1
    ) {
      violations.push({
        code: 'INVALID_SAMPLE_OR_INTERVAL',
        path,
        message: 'interval must have finite lower <= upper and level in (0, 1)',
      });
    }
  }
}

function validateCommonEnvelopeMetadata(
  input: Pick<
    ResponseEnvelopeInput,
    'window' | 'freshness' | 'coverage' | 'lineage' | 'residency' | 'usage'
  >,
  violations: EnvelopeViolation[]
): void {
  if (!input.window || !input.window.start?.trim() || !input.window.end?.trim()) {
    violations.push({
      code: 'MISSING_REQUIRED_METADATA',
      path: 'window',
      message: 'window.start and window.end are required',
    });
  }
  if (
    !input.freshness ||
    !input.freshness.data_through?.trim() ||
    typeof input.freshness.lag_s !== 'number' ||
    !Number.isFinite(input.freshness.lag_s) ||
    input.freshness.lag_s < 0 ||
    (input.freshness.client_lag_s !== undefined &&
      (!Number.isFinite(input.freshness.client_lag_s) || input.freshness.client_lag_s < 0)) ||
    (input.freshness.pipeline_lag_s !== undefined &&
      (!Number.isFinite(input.freshness.pipeline_lag_s) || input.freshness.pipeline_lag_s < 0))
  ) {
    violations.push({
      code: 'MISSING_REQUIRED_METADATA',
      path: 'freshness',
      message: 'freshness.data_through and finite non-negative freshness.lag_s are required',
    });
  }
  if (
    !input.coverage ||
    typeof input.coverage.ratio !== 'number' ||
    !Number.isFinite(input.coverage.ratio) ||
    input.coverage.ratio < 0 ||
    input.coverage.ratio > 1 ||
    typeof input.coverage.denominator_n !== 'number' ||
    !Number.isFinite(input.coverage.denominator_n) ||
    input.coverage.denominator_n < 0 ||
    (input.coverage.sampling_rate !== undefined &&
      (!Number.isFinite(input.coverage.sampling_rate) ||
        input.coverage.sampling_rate < 0 ||
        input.coverage.sampling_rate > 1)) ||
    (input.coverage.excluded_share !== undefined &&
      (!Number.isFinite(input.coverage.excluded_share) ||
        input.coverage.excluded_share < 0 ||
        input.coverage.excluded_share > 1))
  ) {
    violations.push({
      code: 'MISSING_REQUIRED_METADATA',
      path: 'coverage',
      message: 'finite coverage.ratio in [0, 1] and finite non-negative coverage.denominator_n are required',
    });
  }
  if (
    !input.lineage ||
    !input.lineage.schema_version?.trim() ||
    (input.lineage.collection_gen !== 'v3' && input.lineage.collection_gen !== 'legacy') ||
    typeof input.lineage.def_ver !== 'number' ||
    !Number.isFinite(input.lineage.def_ver)
  ) {
    violations.push({
      code: 'MISSING_REQUIRED_METADATA',
      path: 'lineage',
      message: 'lineage.schema_version, finite lineage.def_ver, and lineage.collection_gen are required',
    });
  }
  if (
    !input.residency ||
    !input.residency.storage_region?.trim() ||
    !input.residency.processing_region?.trim()
  ) {
    violations.push({
      code: 'MISSING_REQUIRED_METADATA',
      path: 'residency',
      message: 'residency.storage_region and residency.processing_region are required (§11.11.13)',
    });
  }
  if (input.usage !== undefined) {
    if (
      typeof input.usage.cost_units !== 'number' ||
      !Number.isFinite(input.usage.cost_units) ||
      input.usage.cost_units < 0 ||
      (input.usage.remaining_quota !== undefined &&
        input.usage.remaining_quota !== null &&
        !Number.isFinite(input.usage.remaining_quota))
    ) {
      violations.push({
        code: 'INVALID_SAMPLE_OR_INTERVAL',
        path: 'usage',
        message: 'usage.cost_units and remaining_quota must be finite numbers',
      });
    }
  }
}

function validateEvidenceBlock(
  evidence: EvidenceBlock,
  collectionGen: 'v3' | 'legacy',
  path: string,
  violations: EnvelopeViolation[]
): void {
  if (!evidence || !EVIDENCE_LEVEL_SET.has(evidence.level)) {
    violations.push({
      code: 'INVALID_EVIDENCE_LEVEL',
      path: `${path}.level`,
      message: `Invalid evidence level "${String(evidence?.level)}"; must be one of planned | inferred | observed | proven`,
    });
    return;
  }

  // Guard I4: No confidence without basis
  if (evidence.confidence !== undefined && evidence.confidence !== null) {
    if (
      typeof evidence.confidence !== 'number' ||
      !Number.isFinite(evidence.confidence) ||
      evidence.confidence < 0 ||
      evidence.confidence > 1
    ) {
      violations.push({
        code: 'INVALID_CONFIDENCE_RANGE',
        path: `${path}.confidence`,
        message: `confidence must be finite and in [0, 1], got ${String(evidence.confidence)}`,
      });
    }
    if (
      typeof evidence.confidence_basis !== 'string' ||
      evidence.confidence_basis.trim().length === 0
    ) {
      violations.push({
        code: 'CONFIDENCE_REQUIRES_BASIS',
        path: `${path}.confidence_basis`,
        message: 'confidence requires a non-empty confidence_basis (Invariant I4)',
      });
    }
  }

  if (evidence.pooling_weight !== undefined && !Number.isFinite(evidence.pooling_weight)) {
    violations.push({
      code: 'INVALID_SAMPLE_OR_INTERVAL',
      path: `${path}.pooling_weight`,
      message: 'evidence.pooling_weight must be finite',
    });
  }

  if (!Array.isArray(evidence.refs)) {
    violations.push({
      code: 'INVALID_EVIDENCE_REF',
      path: `${path}.refs`,
      message: 'evidence.refs must be an array',
    });
    return;
  }

  // Guard I6: Every ref resolves or is a typed tombstone
  for (let i = 0; i < evidence.refs.length; i++) {
    validateEvidenceRef(evidence.refs[i], `${path}.refs[${i}]`, violations);
  }

  // Guard I3: `proven` requires active non-tombstoned intervention ref, passing criteria, and non-legacy gen
  if (evidence.level === 'proven') {
    if (collectionGen === 'legacy') {
      violations.push({
        code: 'LEGACY_CANNOT_BE_PROVEN',
        path: `${path}.level`,
        message: 'Legacy collection_gen data is capped at observed and may never be marked proven (D-14)',
      });
    }

    if (evidence.refs.length === 0) {
      violations.push({
        code: 'PROVEN_REQUIRES_INTERVENTION_REF',
        path: `${path}.refs`,
        message: 'Evidence level "proven" requires non-empty active evidence references (Invariant I3)',
      });
    }

    const hasTombstoneOnProven = evidence.refs.some(isTombstonedEvidenceRef);
    if (hasTombstoneOnProven) {
      violations.push({
        code: 'INVALID_EVIDENCE_REF',
        path: `${path}.refs`,
        message: 'Evidence level "proven" cannot rely on tombstoned evidence references (Invariant I3)',
      });
    }

    const hasActiveInterventionRef = evidence.refs.some(
      (r) => r && r.kind === 'intervention' && !isTombstonedEvidenceRef(r)
    );
    if (!hasActiveInterventionRef) {
      violations.push({
        code: 'PROVEN_REQUIRES_INTERVENTION_REF',
        path: `${path}.refs`,
        message: 'Evidence level "proven" requires at least one active non-tombstoned intervention reference (Invariant I3)',
      });
    }

    const hasPassingCriteria =
      Array.isArray(evidence.criteria) && evidence.criteria.some(isPassingProvenPredicate);
    if (!hasPassingCriteria) {
      violations.push({
        code: 'PROVEN_REQUIRES_PASSING_CRITERIA',
        path: `${path}.criteria`,
        message:
          'Evidence level "proven" requires at least one passing stored predicate result (Allocator pre-logged, prereg locked, integrity === "pass", finite p <= alpha, non-tombstoned, and >=14d + canary for non-lab predicates)',
      });
    }
  }
}

function validateAndSerializeProjection(
  measure: MeasureInput<VerifiedNumericLeaf>,
  path: string,
  violations: EnvelopeViolation[],
  requireBrand: boolean
): SerializedProjectionBlock | undefined {
  const proj = measure.projection;
  const level = measure.evidence?.level;
  const validLevel = Boolean(level && EVIDENCE_LEVEL_SET.has(level));

  // Below `proven`, an explicit lift projection measure cannot serve an ok numeric value
  if (
    measure.is_lift_projection &&
    measure.status === 'ok' &&
    validLevel &&
    !isEvidenceAtLeast(level, 'proven')
  ) {
    violations.push({
      code: 'POINT_ESTIMATE_FORBIDDEN_BELOW_PROVEN',
      path,
      message: `Point-estimate lift measure is forbidden at evidence level "${level}" (< proven, D-07R / §9.10)`,
    });
  }

  if (!proj) {
    return undefined;
  }

  // Statuses `invalid`, `suppressed`, `not_collected` strictly require `point_estimate === null` when projection is present
  if (NULL_INTERVAL_AND_ESTIMATE_STATUSES.has(measure.status)) {
    if (proj.point_estimate !== null) {
      violations.push({
        code: 'NON_OK_MUST_HAVE_NULL_VALUE',
        path: `${path}.projection.point_estimate`,
        message: `Measure with status "${measure.status}" requires projection.point_estimate === null`,
      });
    }
  } else if (measure.status !== 'ok' && proj.point_estimate !== undefined && proj.point_estimate !== null) {
    violations.push({
      code: 'NON_OK_MUST_HAVE_NULL_VALUE',
      path: `${path}.projection.point_estimate`,
      message: `Non-ok measure with status "${measure.status}" must not carry a non-null point_estimate`,
    });
  }

  // Predictive interval calibration & D-09 lock check (D-07R / D-09 / SUR §5.6)
  if (proj.predictive_interval !== undefined && proj.predictive_interval !== null) {
    const pi = proj.predictive_interval;
    if (
      typeof pi.lower !== 'number' ||
      typeof pi.upper !== 'number' ||
      typeof pi.level !== 'number' ||
      !Number.isFinite(pi.lower) ||
      !Number.isFinite(pi.upper) ||
      !Number.isFinite(pi.level) ||
      pi.lower > pi.upper ||
      pi.level <= 0 ||
      pi.level >= 1 ||
      typeof pi.basis !== 'string' ||
      pi.basis.trim().length === 0
    ) {
      violations.push({
        code: 'INVALID_SAMPLE_OR_INTERVAL',
        path: `${path}.projection.predictive_interval`,
        message: 'predictive_interval must satisfy finite lower <= upper, 0 < level < 1, and non-empty basis',
      });
    }

    const d09Check = requireDecisionEntitled('D-09', { enforceLegalSignOff: false });
    const requiresExplicitCalibrationGate =
      !d09Check.entitled || !validLevel || !isEvidenceAtLeast(level, 'proven');

    if (requiresExplicitCalibrationGate) {
      const cal = pi.calibration;
      const hasValidGateTag =
        cal !== undefined &&
        cal !== null &&
        typeof cal.gate_id === 'string' &&
        (cal.gate_id.startsWith('sur.projection_calibrated') ||
          cal.gate_id.startsWith('surf.projection_calibrated'));
      const calibratedOk =
        hasValidGateTag &&
        cal.gate_passed === true &&
        typeof cal.clopper_pearson_lower_95 === 'number' &&
        Number.isFinite(cal.clopper_pearson_lower_95) &&
        cal.clopper_pearson_lower_95 >= 0.7 &&
        cal.clopper_pearson_lower_95 <= 1 &&
        typeof cal.resolved_interventions === 'number' &&
        Number.isInteger(cal.resolved_interventions) &&
        cal.resolved_interventions >= 30 &&
        typeof cal.sites === 'number' &&
        Number.isInteger(cal.sites) &&
        cal.sites >= 3 &&
        typeof cal.scope === 'string' &&
        cal.scope.trim().length > 0;
      if (!calibratedOk) {
        violations.push({
          code: 'UNCALIBRATED_PROJECTION_INTERVAL',
          path: `${path}.projection.predictive_interval`,
          message:
            'Predictive interval requires passing sur.projection_calibrated gate (95% Clopper-Pearson LB >= 0.70, >= 30 resolved interventions, >= 3 sites, gate_passed: true) while D-09 is unresolved or evidence < proven',
        });
      }
    }
  }

  let unwrappedPointEstimate: number | null | undefined = undefined;
  if (proj.point_estimate !== undefined && proj.point_estimate !== null) {
    if (!validLevel || !isEvidenceAtLeast(level, 'proven')) {
      violations.push({
        code: 'POINT_ESTIMATE_FORBIDDEN_BELOW_PROVEN',
        path: `${path}.projection.point_estimate`,
        message: `Point estimate lift is strictly forbidden below "proven" (got "${String(level)}", D-07R / §9.10)`,
      });
    } else {
      // At `proven`, check brand (I5) / finite number AND all §9.10 serving conditions
      if (requireBrand) {
        if (!isVerifiedMetricValue(proj.point_estimate) || typeof proj.point_estimate.value !== 'number') {
          violations.push({
            code: 'UNVERIFIED_METRIC_VALUE',
            path: `${path}.projection.point_estimate`,
            message: 'projection.point_estimate must be minted via VerifiedMetricValue (Invariant I5)',
          });
        } else {
          unwrappedPointEstimate = unwrapVerifiedMetricValue(proj.point_estimate);
        }
      } else {
        const rawEst: unknown = proj.point_estimate;
        if (typeof rawEst !== 'number' || !Number.isFinite(rawEst)) {
          violations.push({
            code: 'UNVERIFIED_METRIC_VALUE',
            path: `${path}.projection.point_estimate`,
            message: 'Serialized projection.point_estimate must be a finite number or null',
          });
        } else {
          unwrappedPointEstimate = rawEst;
        }
      }

      const hasVisitorOrPageProvenPredicate =
        Array.isArray(measure.evidence.criteria) &&
        measure.evidence.criteria.some(
          (c) => c.predicate !== 'lab_randomised' && isPassingProvenPredicate(c)
        );
      const cond = proj.point_estimate_conditions;
      const conditionsMet =
        hasVisitorOrPageProvenPredicate &&
        measure.evidence.validity === 'valid' &&
        cond !== undefined &&
        cond !== null &&
        typeof cond.skeptical_lower_bound === 'number' &&
        Number.isFinite(cond.skeptical_lower_bound) &&
        cond.skeptical_lower_bound > 0 &&
        (cond.planned_n_reached === true || cond.holdback_confirmed === true) &&
        cond.guardrails_verified === true;

      if (!conditionsMet) {
        violations.push({
          code: 'PROVEN_POINT_ESTIMATE_CONDITIONS_UNMET',
          path: `${path}.projection.point_estimate`,
          message:
            'Point estimate at proven requires non-lab_randomised passing predicate, validity="valid", finite skeptical_lower_bound > 0, (planned_n_reached || holdback_confirmed), and guardrails_verified=true (§9.10)',
        });
      }
    }
  } else if (proj.point_estimate === null) {
    unwrappedPointEstimate = null;
  }

  return {
    ...(proj.impact_band !== undefined ? { impact_band: proj.impact_band } : {}),
    ...(proj.presentation !== undefined ? { presentation: proj.presentation } : {}),
    ...(proj.predictive_interval !== undefined
      ? { predictive_interval: proj.predictive_interval }
      : {}),
    ...(unwrappedPointEstimate !== undefined
      ? { point_estimate: unwrappedPointEstimate }
      : {}),
    ...(proj.point_estimate_conditions !== undefined
      ? { point_estimate_conditions: proj.point_estimate_conditions }
      : {}),
  };
}

/**
 * Recursively validates `input.data` under Invariant I5:
 * - Rejects raw unbranded numbers, `NaN`, and `Infinity` anywhere inside `input.data`.
 * - Unwraps legitimate `VerifiedMetricValue` leaves into plain JSON numbers for serialization.
 * - Preserves intact `UntrustedValue` containers untouched.
 */
function validateAndUnwrapDataPayload(
  node: unknown,
  path: string,
  violations: EnvelopeViolation[],
  visited = new WeakSet<object>()
): unknown {
  if (node === null || node === undefined) {
    return node;
  }
  if (typeof node === 'number') {
    violations.push({
      code: 'UNVERIFIED_METRIC_VALUE',
      path,
      message: `Raw unbranded numeric value (${String(node)}) inside data payload violates Invariant I5; wrap in VerifiedMetricValue`,
    });
    return node;
  }
  if (typeof node === 'string' || typeof node === 'boolean') {
    return node;
  }
  if (typeof node !== 'object') {
    violations.push({
      code: 'UNVERIFIED_METRIC_VALUE',
      path,
      message: `Unsupported value of type ${typeof node} inside data payload`,
    });
    return null;
  }

  if (isVerifiedMetricValue(node)) {
    return unwrapVerifiedMetricValue(node);
  }
  if (isUntrustedValue(node)) {
    return node;
  }

  if (visited.has(node)) {
    return node;
  }
  visited.add(node);

  if (Array.isArray(node)) {
    return node.map((item, idx) =>
      validateAndUnwrapDataPayload(item, `${path}[${idx}]`, violations, visited)
    );
  }

  const rec = node as Record<string, unknown>;
  // Leave malformed untrusted containers intact so Guard I7 reports UNTRUSTED_STRING_LEAK as well
  if ('__untrusted' in rec || '__ugk_untrusted' in rec) {
    return rec;
  }

  const proto = Object.getPrototypeOf(rec);
  if (proto !== Object.prototype && proto !== null) {
    violations.push({
      code: 'UNVERIFIED_METRIC_VALUE',
      path,
      message: `Non-plain object prototype in data payload at ${path}`,
    });
  }

  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(rec)) {
    if (typeof key !== 'string') {
      violations.push({
        code: 'UNVERIFIED_METRIC_VALUE',
        path: `${path}[${String(key)}]`,
        message: `Symbol key ${String(key)} is forbidden inside data payload`,
      });
      continue;
    }
    out[key] = validateAndUnwrapDataPayload(rec[key], `${path}.${key}`, violations, visited);
  }
  return out;
}

/**
 * Recursively ensures every numeric value anywhere in a serialized envelope is finite (`!NaN`, `!Infinity`).
 */
function assertAllNumbersFinite(
  node: unknown,
  path: string,
  violations: EnvelopeViolation[],
  visited = new WeakSet<object>()
): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'number') {
    if (!Number.isFinite(node)) {
      violations.push({
        code: 'INVALID_SAMPLE_OR_INTERVAL',
        path,
        message: `Non-finite numeric value (${String(node)}) is forbidden in serialized envelope`,
      });
    }
    return;
  }
  if (typeof node !== 'object') return;
  if (visited.has(node)) return;
  visited.add(node);

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      assertAllNumbersFinite(node[i], `${path}[${i}]`, violations, visited);
    }
    return;
  }

  const rec = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(rec)) {
    assertAllNumbersFinite(v, `${path}.${k}`, violations, visited);
  }
}

function deriveTopLevelStatus(
  measureStatuses: readonly MeasureStatus[],
  defaultEmptyStatus: MeasureStatus = 'not_collected'
): RequestStatus {
  if (measureStatuses.length === 0) {
    return defaultEmptyStatus;
  }
  const first = measureStatuses[0];
  for (let i = 1; i < measureStatuses.length; i++) {
    if (measureStatuses[i] !== first) {
      return 'partial';
    }
  }
  return first;
}

/**
 * The single authoritative Response Envelope Builder.
 * Enforces ALL invariants I1–I7 and throws `EnvelopeInvariantError` on any violation.
 */
export function buildResponseEnvelope(
  input: ResponseEnvelopeInput
): SerializedResponseEnvelope {
  const violations: EnvelopeViolation[] = [];

  validateCommonEnvelopeMetadata(input, violations);

  const serializedMeasures: Record<string, SerializedMeasureCell> = {};
  const measureStatuses: MeasureStatus[] = [];

  const measureNames = Object.keys(input.measures).sort();
  for (const name of measureNames) {
    const measure = input.measures[name];
    const path = `measures.${name}`;

    // Status validation (closed 8-state set; `partial` strictly forbidden on measures)
    const rawStatus = measure.status as string;
    const isValidStatus = rawStatus !== 'partial' && MEASURE_STATUS_SET.has(rawStatus);
    if (rawStatus === 'partial') {
      violations.push({
        code: 'PARTIAL_FORBIDDEN_ON_MEASURE',
        path: `${path}.status`,
        message: '"partial" is allowed only at top-level request status, never on an individual measure (D-15)',
      });
    } else if (!MEASURE_STATUS_SET.has(rawStatus)) {
      violations.push({
        code: 'INVALID_MEASURE_STATUS',
        path: `${path}.status`,
        message: `Status "${rawStatus}" is not in the 8 allowed measure statuses`,
      });
    } else {
      measureStatuses.push(measure.status);
    }

    const unmetGates = resolveUnmetGates(measure, path, violations);
    validateUnmetGatesEntries(unmetGates, `${path}.unmet_gates`, violations);

    // Guard I1 & I5: Status/Value, mandatory unmet_gates on non-ok, & Branded Metric enforcement
    let serializedValue: VerifiedNumericLeaf | null = null;
    if (measure.status !== 'ok') {
      if (measure.value !== null && measure.value !== undefined) {
        violations.push({
          code: 'NON_OK_MUST_HAVE_NULL_VALUE',
          path: `${path}.value`,
          message: `Measure with status "${measure.status}" must have value: null (Invariant I1)`,
        });
      }
      if (unmetGates.length === 0) {
        violations.push({
          code: 'NON_OK_REQUIRES_UNMET_GATE_OR_REASON',
          path: `${path}.unmet_gates`,
          message: `Measure with status "${measure.status}" must include at least one unmet gate (unmet_gates.length >= 1, Invariant I1)`,
        });
      }
    } else {
      if (measure.value === null || measure.value === undefined) {
        violations.push({
          code: 'OK_REQUIRES_NON_NULL_VALUE',
          path: `${path}.value`,
          message: 'Measure with status "ok" must have a non-null VerifiedMetricValue',
        });
      } else if (!isVerifiedMetricValue(measure.value)) {
        violations.push({
          code: 'UNVERIFIED_METRIC_VALUE',
          path: `${path}.value`,
          message:
            'Numeric value must be minted through VerifiedMetricValue (data layer or model registry, Invariant I5)',
        });
      } else {
        serializedValue = unwrapVerifiedMetricValue(measure.value);
      }
    }

    if (isValidStatus) {
      validateSampleBlock(measure.sample, measure.status, `${path}.sample`, violations);
      validateIntervalBlock(measure.interval, measure.status, `${path}.interval`, violations);
    }

    // Guards I3, I4, I6 on EvidenceBlock
    validateEvidenceBlock(
      measure.evidence,
      input.lineage?.collection_gen ?? 'v3',
      `${path}.evidence`,
      violations
    );

    // Guard I2 (D-07R / D-09) on Projection
    const serializedProjection = validateAndSerializeProjection(
      measure,
      path,
      violations,
      true
    );

    const effectiveFreshness = measure.freshness ?? input.freshness;
    const effectiveCoverage = measure.coverage ?? input.coverage;

    serializedMeasures[name] = {
      value: serializedValue,
      unit: measure.unit,
      status: measure.status,
      ...(measure.reason !== undefined ? { reason: measure.reason } : {}),
      evidence: measure.evidence,
      sample: measure.sample,
      interval: measure.interval,
      freshness: effectiveFreshness,
      coverage: effectiveCoverage,
      ...(serializedProjection !== undefined ? { projection: serializedProjection } : {}),
      ...(measure.model !== undefined ? { model: measure.model } : {}),
      unmet_gates: unmetGates,
      gates: { unmet: unmetGates },
    };
  }

  const serializedData =
    input.data !== undefined
      ? validateAndUnwrapDataPayload(input.data, '$.data', violations)
      : undefined;

  const envelope: SerializedResponseEnvelope = {
    status: deriveTopLevelStatus(measureStatuses, input.default_empty_status ?? 'not_collected'),
    window: input.window,
    freshness: input.freshness,
    coverage: input.coverage,
    lineage: input.lineage,
    residency: input.residency,
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
    warnings: input.warnings ?? [],
    next_cursor: input.next_cursor ?? null,
    measures: serializedMeasures,
    ...(serializedData !== undefined ? { data: serializedData } : {}),
    ...(input.quality !== undefined ? { quality: input.quality } : {}),
    ...(input.measurement !== undefined ? { measurement: input.measurement } : {}),
    ...(input.join_quality !== undefined ? { join_quality: input.join_quality } : {}),
    ...(input.experiment !== undefined ? { experiment: input.experiment } : {}),
    ...(input.capture !== undefined ? { capture: input.capture } : {}),
    ...(input.policy !== undefined ? { policy: input.policy } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.preflight !== undefined ? { preflight: input.preflight } : {}),
  };

  assertAllNumbersFinite(envelope, '$', violations);

  // Guard I7: Deep scan entire response for unwrapped external-origin strings
  const untrustedLeaks = detectUntrustedStringLeaks(envelope, '$');
  for (const leak of untrustedLeaks) {
    violations.push({
      code: 'UNTRUSTED_STRING_LEAK',
      path: leak.path,
      message: leak.message,
    });
  }

  if (violations.length > 0) {
    throw new EnvelopeInvariantError(violations);
  }

  return envelope;
}

/**
 * Builds, validates, and deterministically serializes the Response Envelope to JSON.
 */
export function serializeResponseEnvelope(input: ResponseEnvelopeInput): string {
  const envelope = buildResponseEnvelope(input);
  return canonicalJson(envelope);
}

export interface SerializedEnvelopeValidationResult {
  readonly valid: boolean;
  readonly violations: readonly EnvelopeViolation[];
}

/**
 * Validates a deserialized JSON response envelope (wire boundary validator).
 * Verifies all JSON-observable invariants (8 statuses, 4 evidence levels, I1–I4, I6, I7,
 * sample, interval, point_estimate, unmet_gates, D-09 calibration, Number.isFinite,
 * top-level status derivation, residency, and untrusted string leak scan).
 */
export function validateSerializedEnvelope(
  raw: unknown
): SerializedEnvelopeValidationResult {
  const violations: EnvelopeViolation[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      valid: false,
      violations: [
        {
          code: 'MISSING_REQUIRED_METADATA',
          path: '$',
          message: 'Response envelope must be a JSON object',
        },
      ],
    };
  }

  const env = raw as SerializedResponseEnvelope;
  validateCommonEnvelopeMetadata(env, violations);
  assertAllNumbersFinite(env, '$', violations);

  if (
    typeof env.status !== 'string' ||
    (env.status !== 'partial' && !MEASURE_STATUS_SET.has(env.status))
  ) {
    violations.push({
      code: 'INVALID_REQUEST_STATUS',
      path: 'status',
      message: `Invalid top-level request status "${String(env.status)}"`,
    });
  }

  if (!env.measures || typeof env.measures !== 'object' || Array.isArray(env.measures)) {
    violations.push({
      code: 'MISSING_REQUIRED_METADATA',
      path: 'measures',
      message: 'measures record is required',
    });
  } else {
    const statuses: MeasureStatus[] = [];
    for (const [name, cell] of Object.entries(env.measures)) {
      const path = `measures.${name}`;
      if (!cell || typeof cell !== 'object') {
        violations.push({
          code: 'MISSING_REQUIRED_METADATA',
          path,
          message: 'Measure cell must be an object',
        });
        continue;
      }

      const rawStatus = cell.status as string;
      const isValidStatus = rawStatus !== 'partial' && MEASURE_STATUS_SET.has(rawStatus);
      if (rawStatus === 'partial') {
        violations.push({
          code: 'PARTIAL_FORBIDDEN_ON_MEASURE',
          path: `${path}.status`,
          message: '"partial" is forbidden on measure status',
        });
      } else if (!MEASURE_STATUS_SET.has(rawStatus)) {
        violations.push({
          code: 'INVALID_MEASURE_STATUS',
          path: `${path}.status`,
          message: `Unknown measure status "${rawStatus}"`,
        });
      } else {
        statuses.push(cell.status);
      }

      const unmet = resolveUnmetGates(
        cell as unknown as Pick<MeasureInput<VerifiedNumericLeaf>, 'unmet_gates' | 'gates'>,
        path,
        violations
      );
      validateUnmetGatesEntries(unmet, `${path}.unmet_gates`, violations);

      if (cell.status !== 'ok') {
        if (cell.value !== null) {
          violations.push({
            code: 'NON_OK_MUST_HAVE_NULL_VALUE',
            path: `${path}.value`,
            message: `Non-ok status "${cell.status}" requires value: null`,
          });
        }
        if (unmet.length === 0) {
          violations.push({
            code: 'NON_OK_REQUIRES_UNMET_GATE_OR_REASON',
            path: `${path}.unmet_gates`,
            message: `Non-ok status "${cell.status}" requires unmet_gates.length >= 1`,
          });
        }
      } else if (cell.value === null || cell.value === undefined) {
        violations.push({
          code: 'OK_REQUIRES_NON_NULL_VALUE',
          path: `${path}.value`,
          message: 'ok measure must carry a non-null value',
        });
      } else {
        try {
          assertValidNumericLeaf(cell.value, `${path}.value`);
        } catch (err) {
          violations.push({
            code: 'UNVERIFIED_METRIC_VALUE',
            path: `${path}.value`,
            message: err instanceof Error ? err.message : 'Invalid numeric leaf on ok measure',
          });
        }
      }

      if (isValidStatus) {
        validateSampleBlock(cell.sample, cell.status, `${path}.sample`, violations);
        validateIntervalBlock(cell.interval, cell.status, `${path}.interval`, violations);
      }

      validateEvidenceBlock(
        cell.evidence,
        env.lineage?.collection_gen ?? 'v3',
        `${path}.evidence`,
        violations
      );

      validateAndSerializeProjection(
        cell as unknown as MeasureInput<VerifiedNumericLeaf>,
        path,
        violations,
        false
      );
    }

    if (statuses.length > 0) {
      const expectedTopStatus = deriveTopLevelStatus(statuses);
      if (env.status !== expectedTopStatus) {
        violations.push({
          code: 'INVALID_REQUEST_STATUS',
          path: 'status',
          message: `Top-level status "${env.status}" does not match derived status "${expectedTopStatus}" from measures`,
        });
      }
    }
  }

  const leaks = detectUntrustedStringLeaks(env, '$');
  for (const leak of leaks) {
    violations.push({
      code: 'UNTRUSTED_STRING_LEAK',
      path: leak.path,
      message: leak.message,
    });
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * D-15 status normalizer: maps area-specific condition codes onto the closed 8-state
 * MeasureStatus set with canonical gate/reason metadata.
 */
export function mapAreaConditionToMeasureStatus(
  condition:
    | 'ok_zero_covered'
    | 'ok_zero_uncovered'
    | 'unobservable_by_design'
    | 'not_entitled_replay_decision'
    | 'unmet_retention_signoff'
    | 'insufficient_k_tenants'
    | 'suppressed_cell_below_k'
    | 'lab_snapshot_missing'
    | 'builder_lag'
    | 'integrity_fail'
    | 'job_in_progress'
): { readonly status: MeasureStatus; readonly gateId: string; readonly reason: string } {
  switch (condition) {
    case 'ok_zero_covered':
      return { status: 'ok', gateId: 'act.G33', reason: 'zero_with_verified_coverage' };
    case 'ok_zero_uncovered':
      return { status: 'not_collected', gateId: 'act.G33', reason: 'coverage_gate_unmet' };
    case 'unobservable_by_design':
      return { status: 'not_applicable', gateId: 'tel.U2', reason: 'unobservable_by_design' };
    case 'not_entitled_replay_decision':
      return { status: 'not_entitled', gateId: 'tel.G14', reason: 'replay_decision' };
    case 'unmet_retention_signoff':
      return { status: 'not_entitled', gateId: 'store.G-12', reason: 'retention_signoff' };
    case 'insufficient_k_tenants':
      // D-15 NEW-RULING: below K tenants -> insufficient_data (number does not exist yet)
      return { status: 'insufficient_data', gateId: 'ev.G-10', reason: 'k_tenants' };
    case 'suppressed_cell_below_k':
      // D-15 NEW-RULING: number exists, withheld by privacy threshold -> suppressed
      return { status: 'suppressed', gateId: 'store.G-12', reason: 'min_cell' };
    case 'lab_snapshot_missing':
      return { status: 'not_collected', gateId: 'join.G5', reason: 'lab_snapshot' };
    case 'builder_lag':
      return { status: 'insufficient_data', gateId: 'store.G-7', reason: 'builder_lag' };
    case 'integrity_fail':
      return { status: 'invalid', gateId: 'ev.G-3', reason: 'integrity_fail' };
    case 'job_in_progress':
      return { status: 'pending', gateId: 'sur.job', reason: 'job_in_progress' };
  }
}
