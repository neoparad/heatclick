/**
 * UGOKI LINK v2 — Browser SDK Barrel Export (Bundles 3-A, 3-B, 3-C)
 */

export * from './types';
export {
  CONSENT_MODE_RANK,
  DEFAULT_JURISDICTION_MATRIX,
  GuardedStorageAdapter,
  minConsentMode,
  normalizeRegionClass,
  resolveBrowserConsent,
  stepDownConsentMode,
} from './consent';
export {
  DEFAULT_LAB_SINK_PATH,
  isActiveLabMarker,
  isValidLabMarkerPurpose,
  rewriteOutboundForLabSink,
  shouldBlockTelemetryForLabPurpose,
  type LabSinkRewriteResult,
} from './lab-sink';
export {
  BehaviourCaptureEngine,
  MAX_CONVERSION_RULES,
  normalizeConversionRule,
  type BehaviourEngineOptions,
  type InternalBlockState,
  type InternalFieldState,
  type InternalFormState,
  type InternalMediaState,
  type InternalSectionState,
  type MultiClickStat,
  type NoEffectClickStat,
  type NormalizedConversionRule,
  type ReplayEmissionDecision,
} from './behaviour';
export { UgokiBrowserSdk, computeAdaptiveHeartbeatSec } from './sdk';
export {
  CUSTOM_EVENT_MAX_BYTES,
  CUSTOM_EVENT_MAX_PROPERTIES,
  CUSTOM_EVENT_MAX_TYPES_PER_SITE,
  buildValidatedCustomEvent,
  containsPiiShape,
  createBrowserSegmentCompatClient,
  safeDecodePercentForPiiCheck,
  type BrowserSegmentCompatOptions,
  type CustomEventDefinition,
  type CustomEventEnvelope,
  type CustomEventValidationResult,
  type CustomPropertySchema,
  type CustomPropertyType,
  type SiteCustomEventRegistry,
  type ValidatedCustomProperty,
} from './custom-events';
export {
  generateQuickstartOnboarding,
  runQuickstartSelfDiagnostics,
  type QuickstartBundle,
  type QuickstartDiagnosticReport,
  type QuickstartOnboardingInput,
} from './quickstart';
