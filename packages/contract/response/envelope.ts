/**
 * UGOKI LINK v2 — Single Authoritative Response Envelope Serializer & Validator
 *
 * Implements §1.3, §9.10, §11.5, D-14, D-15, D-16, D-37, SUR M5:
 * - Enforces the closed 8-state measure status set (+ top-level `partial` only)
 * - Enforces the 4-tier evidence hierarchy (`planned < inferred < observed < proven`)
 * - Enforces Guards I1–I7 on every measure and every envelope:
 *   - I1: status !== 'ok' => value === null AND (unmet_gates non-empty OR reason present)
 *   - I2 (D-07R): below `proven` rejects any point estimate lift; predictive intervals require
 *     passing `sur.projection_calibrated` (Clopper-Pearson 95% LB >= 0.70, n >= 30, sites >= 3);
 *     at `proven`, point estimates require all §9.10 conditions & non-lab_randomised predicate.
 *   - I3: `proven` requires intervention ref, stored passing predicate criteria, and non-legacy gen.
 *   - I4: no confidence without non-empty confidence_basis (and confidence in [0, 1]).
 *   - I5: numeric leaves MUST arrive via `VerifiedMetricValue` brand (data layer / model registry).
 *   - I6: every evidence ref must be a complete active ref or typed tombstone (`expired` | `erased`).
 *   - I7: every external-origin string anywhere in the response MUST be wrapped in `UntrustedValue`.
 */

import { isVerifiedMetricValue, unwrapVerifiedMetricValue, type VerifiedNumericLeaf } from './brand';
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
  type MeasureInput,
  type MeasureStatus,
  type ProvenPredicateResult,
  type RequestStatus,
  type ResponseEnvelopeInput,
  type SerializedMeasureCell,
  type SerializedProjectionBlock,
  type SerializedResponseEnvelope,
  type UnmetGate,
} from './types';
import { detectUntrustedStringLeaks } from './untrusted';

const MEASURE_STATUS_SET: ReadonlySet<string> = new Set(MEASURE_STATUSES);
const EVIDENCE_LEVEL_SET: ReadonlySet<string> = new Set(EVIDENCE_LEVELS);
const PROVEN_PREDICATE_SET: ReadonlySet<string> = new Set(PROVEN_PREDICATES);

export function compareEvidenceLevels(a: EvidenceLevel, b: EvidenceLevel): number {
  return EVIDENCE_LEVEL_RANK[a] - EVIDENCE_LEVEL_RANK[b];
}

export function isEvidenceAtLeast(actual: EvidenceLevel, required: EvidenceLevel): boolean {
  return EVIDENCE_LEVEL_RANK[actual] >= EVIDENCE_LEVEL_RANK[required];
}

function isPassingProvenPredicate(c: ProvenPredicateResult): boolean {
  if (!PROVEN_PREDICATE_SET.has(c.predicate)) return false;
  if (!c.passed) return false;
  if (!c.allocator_logged_before_outcomes) return false;
  if (!c.prereg_locked) return false;
  if (c.integrity_status === 'fail') return false;
  if (!c.decision_rule_passed) return false;
  if (
    typeof c.randomisation_audit_p !== 'number' ||
    typeof c.alpha !== 'number' ||
    c.randomisation_audit_p > c.alpha
  ) {
    return false;
  }
  if (c.predicate !== 'lab_randomised') {
    if (typeof c.duration_days !== 'number' || c.duration_days < 14) return false;
    if (c.platform_canary_passed !== true) return false;
  }
  return true;
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

function resolveUnmetGates(
  measure: MeasureInput<VerifiedNumericLeaf>,
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

function validateCommonEnvelopeMetadata(
  input: Pick<
    ResponseEnvelopeInput,
    'window' | 'freshness' | 'coverage' | 'lineage' | 'residency'
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
    input.freshness.lag_s < 0
  ) {
    violations.push({
      code: 'MISSING_REQUIRED_METADATA',
      path: 'freshness',
      message: 'freshness.data_through and non-negative freshness.lag_s are required',
    });
  }
  if (
    !input.coverage ||
    typeof input.coverage.ratio !== 'number' ||
    input.coverage.ratio < 0 ||
    input.coverage.ratio > 1 ||
    typeof input.coverage.denominator_n !== 'number' ||
    input.coverage.denominator_n < 0
  ) {
    violations.push({
      code: 'MISSING_REQUIRED_METADATA',
      path: 'coverage',
      message: 'coverage.ratio in [0, 1] and non-negative coverage.denominator_n are required',
    });
  }
  if (!input.lineage || !input.lineage.schema_version?.trim()) {
    violations.push({
      code: 'MISSING_REQUIRED_METADATA',
      path: 'lineage',
      message: 'lineage.schema_version and lineage.collection_gen are required',
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
        message: `confidence must be in [0, 1], got ${String(evidence.confidence)}`,
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

  // Guard I6: Every ref resolves or is a typed tombstone
  for (let i = 0; i < evidence.refs.length; i++) {
    validateEvidenceRef(evidence.refs[i], `${path}.refs[${i}]`, violations);
  }

  // Guard I3: `proven` requires intervention ref, stored passing criteria, and non-legacy gen
  if (evidence.level === 'proven') {
    if (collectionGen === 'legacy') {
      violations.push({
        code: 'LEGACY_CANNOT_BE_PROVEN',
        path: `${path}.level`,
        message: 'Legacy collection_gen data is capped at observed and may never be marked proven (D-14)',
      });
    }

    const hasInterventionRef = evidence.refs.some((r) => r.kind === 'intervention');
    if (!hasInterventionRef) {
      violations.push({
        code: 'PROVEN_REQUIRES_INTERVENTION_REF',
        path: `${path}.refs`,
        message: 'Evidence level "proven" requires at least one intervention reference (Invariant I3)',
      });
    }

    const hasPassingCriteria = evidence.criteria.some(isPassingProvenPredicate);
    if (!hasPassingCriteria) {
      violations.push({
        code: 'PROVEN_REQUIRES_PASSING_CRITERIA',
        path: `${path}.criteria`,
        message:
          'Evidence level "proven" requires at least one passing stored predicate result (Allocator pre-logged, prereg locked, integrity != fail, decision rule passed, p <= alpha, and >=14d + canary for non-lab predicates)',
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
  const level = measure.evidence.level;

  // Below `proven`, an explicit lift projection measure cannot serve an ok numeric value
  if (measure.is_lift_projection && measure.status === 'ok' && !isEvidenceAtLeast(level, 'proven')) {
    violations.push({
      code: 'POINT_ESTIMATE_FORBIDDEN_BELOW_PROVEN',
      path,
      message: `Point-estimate lift measure is forbidden at evidence level "${level}" (< proven, D-07R / §9.10)`,
    });
  }

  if (!proj) {
    return undefined;
  }

  // Predictive interval calibration check (D-07R / SUR §5.6)
  if (proj.predictive_interval !== undefined && proj.predictive_interval !== null) {
    const pi = proj.predictive_interval;
    if (pi.lower > pi.upper || pi.level <= 0 || pi.level >= 1) {
      violations.push({
        code: 'INVALID_SAMPLE_OR_INTERVAL',
        path: `${path}.projection.predictive_interval`,
        message: 'predictive_interval must satisfy lower <= upper and 0 < level < 1',
      });
    }
    if (!isEvidenceAtLeast(level, 'proven')) {
      const cal = pi.calibration;
      const calibratedOk =
        cal !== undefined &&
        cal.gate_passed === true &&
        cal.clopper_pearson_lower_95 >= 0.7 &&
        cal.resolved_interventions >= 30 &&
        cal.sites >= 3;
      if (!calibratedOk) {
        violations.push({
          code: 'UNCALIBRATED_PROJECTION_INTERVAL',
          path: `${path}.projection.predictive_interval`,
          message:
            'Predictive interval below proven requires passing sur.projection_calibrated (95% Clopper-Pearson LB >= 0.70, >= 30 resolved interventions, >= 3 sites)',
        });
      }
    }
  }

  let unwrappedPointEstimate: number | null | undefined = undefined;
  if (proj.point_estimate !== undefined && proj.point_estimate !== null) {
    if (!isEvidenceAtLeast(level, 'proven')) {
      violations.push({
        code: 'POINT_ESTIMATE_FORBIDDEN_BELOW_PROVEN',
        path: `${path}.projection.point_estimate`,
        message: `Point estimate lift is strictly forbidden below "proven" (got "${level}", D-07R / §9.10)`,
      });
    } else {
      // At `proven`, check brand (I5) AND all §9.10 serving conditions
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
      } else if (typeof proj.point_estimate === 'number') {
        unwrappedPointEstimate = proj.point_estimate;
      }

      const hasVisitorOrPageProvenPredicate = measure.evidence.criteria.some(
        (c) => c.predicate !== 'lab_randomised' && isPassingProvenPredicate(c)
      );
      const cond = proj.point_estimate_conditions;
      const conditionsMet =
        hasVisitorOrPageProvenPredicate &&
        measure.evidence.validity === 'valid' &&
        cond !== undefined &&
        cond !== null &&
        cond.skeptical_lower_bound > 0 &&
        (cond.planned_n_reached || cond.holdback_confirmed) &&
        cond.guardrails_verified;

      if (!conditionsMet) {
        violations.push({
          code: 'PROVEN_POINT_ESTIMATE_CONDITIONS_UNMET',
          path: `${path}.projection.point_estimate`,
          message:
            'Point estimate at proven requires non-lab_randomised passing predicate, validity="valid", skeptical_lower_bound > 0, (planned_n_reached || holdback_confirmed), and guardrails_verified=true (§9.10)',
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

    // Guard I1 & I5: Status/Value & Branded Metric enforcement
    let serializedValue: VerifiedNumericLeaf | null = null;
    if (measure.status !== 'ok') {
      if (measure.value !== null && measure.value !== undefined) {
        violations.push({
          code: 'NON_OK_MUST_HAVE_NULL_VALUE',
          path: `${path}.value`,
          message: `Measure with status "${measure.status}" must have value: null (Invariant I1)`,
        });
      }
      const hasReason = typeof measure.reason === 'string' && measure.reason.trim().length > 0;
      if (unmetGates.length === 0 && !hasReason) {
        violations.push({
          code: 'NON_OK_REQUIRES_UNMET_GATE_OR_REASON',
          path: `${path}.unmet_gates`,
          message: `Measure with status "${measure.status}" must include at least one unmet gate or non-empty reason (Invariant I1)`,
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

      if (
        !measure.sample ||
        typeof measure.sample.n !== 'number' ||
        !Number.isInteger(measure.sample.n) ||
        measure.sample.n < 0
      ) {
        violations.push({
          code: 'INVALID_SAMPLE_OR_INTERVAL',
          path: `${path}.sample`,
          message: 'Measure with status "ok" must provide a non-negative integer sample.n (§1.3)',
        });
      }
    }

    // Interval sanity check when provided
    if (measure.interval !== null && measure.interval !== undefined) {
      if (
        typeof measure.interval.lower !== 'number' ||
        typeof measure.interval.upper !== 'number' ||
        !Number.isFinite(measure.interval.lower) ||
        !Number.isFinite(measure.interval.upper) ||
        measure.interval.lower > measure.interval.upper ||
        measure.interval.level <= 0 ||
        measure.interval.level >= 1
      ) {
        violations.push({
          code: 'INVALID_SAMPLE_OR_INTERVAL',
          path: `${path}.interval`,
          message: 'interval must have finite lower <= upper and level in (0, 1)',
        });
      }
    }

    // Guards I3, I4, I6 on EvidenceBlock
    validateEvidenceBlock(
      measure.evidence,
      input.lineage.collection_gen,
      `${path}.evidence`,
      violations
    );

    // Guard I2 (D-07R) on Projection
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
    ...(input.data !== undefined ? { data: input.data } : {}),
    ...(input.quality !== undefined ? { quality: input.quality } : {}),
    ...(input.measurement !== undefined ? { measurement: input.measurement } : {}),
    ...(input.join_quality !== undefined ? { join_quality: input.join_quality } : {}),
    ...(input.experiment !== undefined ? { experiment: input.experiment } : {}),
    ...(input.capture !== undefined ? { capture: input.capture } : {}),
    ...(input.policy !== undefined ? { policy: input.policy } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.preflight !== undefined ? { preflight: input.preflight } : {}),
  };

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
      const rawStatus = cell.status as string;
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

      const unmet = cell.unmet_gates ?? cell.gates?.unmet ?? [];
      if (cell.unmet_gates && cell.gates?.unmet) {
        if (canonicalJson(cell.unmet_gates) !== canonicalJson(cell.gates.unmet)) {
          violations.push({
            code: 'UNMET_GATES_MISMATCH',
            path,
            message: 'unmet_gates and gates.unmet diverge',
          });
        }
      }

      if (cell.status !== 'ok') {
        if (cell.value !== null) {
          violations.push({
            code: 'NON_OK_MUST_HAVE_NULL_VALUE',
            path: `${path}.value`,
            message: `Non-ok status "${cell.status}" requires value: null`,
          });
        }
        const hasReason = typeof cell.reason === 'string' && cell.reason.trim().length > 0;
        if (unmet.length === 0 && !hasReason) {
          violations.push({
            code: 'NON_OK_REQUIRES_UNMET_GATE_OR_REASON',
            path: `${path}.unmet_gates`,
            message: `Non-ok status "${cell.status}" requires unmet_gates or reason`,
          });
        }
      } else if (cell.value === null || cell.value === undefined) {
        violations.push({
          code: 'OK_REQUIRES_NON_NULL_VALUE',
          path: `${path}.value`,
          message: 'ok measure must carry a non-null value',
        });
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
