/**
 * Structured invariant violation errors for the UGOKI LINK v2 Response Envelope.
 */

export type EnvelopeViolationCode =
  | 'INVALID_MEASURE_STATUS'
  | 'PARTIAL_FORBIDDEN_ON_MEASURE'
  | 'INVALID_REQUEST_STATUS'
  | 'INVALID_EVIDENCE_LEVEL'
  | 'NON_OK_MUST_HAVE_NULL_VALUE'
  | 'NON_OK_REQUIRES_UNMET_GATE_OR_REASON'
  | 'OK_REQUIRES_NON_NULL_VALUE'
  | 'UNVERIFIED_METRIC_VALUE'
  | 'POINT_ESTIMATE_FORBIDDEN_BELOW_PROVEN'
  | 'UNCALIBRATED_PROJECTION_INTERVAL'
  | 'PROVEN_POINT_ESTIMATE_CONDITIONS_UNMET'
  | 'PROVEN_REQUIRES_INTERVENTION_REF'
  | 'PROVEN_REQUIRES_PASSING_CRITERIA'
  | 'LEGACY_CANNOT_BE_PROVEN'
  | 'CONFIDENCE_REQUIRES_BASIS'
  | 'INVALID_CONFIDENCE_RANGE'
  | 'INVALID_EVIDENCE_REF'
  | 'UNTRUSTED_STRING_LEAK'
  | 'MISSING_REQUIRED_METADATA'
  | 'UNMET_GATES_MISMATCH'
  | 'INVALID_SAMPLE_OR_INTERVAL';

export interface EnvelopeViolation {
  readonly code: EnvelopeViolationCode;
  readonly path: string;
  readonly message: string;
}

export class EnvelopeInvariantError extends Error {
  public readonly violations: readonly EnvelopeViolation[];

  constructor(
    violations: readonly EnvelopeViolation[],
    context = 'UGOKI LINK response envelope invariant violation'
  ) {
    const detail = violations.map((v) => `[${v.code}] ${v.path}: ${v.message}`).join('; ');
    super(`${context}: ${detail}`);
    this.name = 'EnvelopeInvariantError';
    this.violations = violations;
  }
}
