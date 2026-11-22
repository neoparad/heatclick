/**
 * UGOKI LINK v2 — Unified Response Envelope Serializer & Guards (Bundle 1-E)
 */

export * from './types';
export {
  createDataLayerMetric,
  createModelRegistryMetric,
  isVerifiedMetricValue,
  unwrapVerifiedMetricValue,
  type DataLayerAuthority,
  type MetricAuthority,
  type VerifiedNumericLeaf,
  type VerifiedMetricValue,
  type Measured,
} from './brand';
export {
  DEFAULT_UNTRUSTED_MAX_CHARS,
  HARD_CAP_UNTRUSTED_MAX_CHARS,
  UNTRUSTED_SOURCES,
  wrapUntrusted,
  isUntrustedValue,
  isStrictSafeHttpUrl,
  detectUntrustedStringLeaks,
  assertNoUntrustedStringLeaks,
  type UntrustedSource,
  type UntrustedValue,
  type WrapUntrustedOptions,
  type UntrustedLeakFinding,
} from './untrusted';
export {
  EnvelopeInvariantError,
  type EnvelopeViolation,
  type EnvelopeViolationCode,
} from './errors';
export {
  buildResponseEnvelope,
  serializeResponseEnvelope,
  validateSerializedEnvelope,
  compareEvidenceLevels,
  isEvidenceAtLeast,
  mapAreaConditionToMeasureStatus,
  type SerializedEnvelopeValidationResult,
} from './envelope';
export { sha256Hex, canonicalJson } from './sha256';
