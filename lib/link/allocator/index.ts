/**
 * UGOKI LINK v2 — Single Actor-Blind Allocator, Planning Sheet & 3-Tier Metric Contract (`lib/link/allocator`)
 */

export * from './types';
export {
  hmacSha256Bytes,
  hmacSha256Hex,
  drawUniformU,
  deriveDecisionId,
} from './hmac';
export {
  ActorBlindViolationError,
  assertActorBlindInput,
  computeHoldoutEpoch,
  evaluateHoldoutBits,
  allocateDecision,
  chiSquareSurvivalPValue,
  evaluateSrmIntegrity,
  type SrmIntegrityResult,
} from './allocator';
export {
  PLANNER_CONSTANTS,
  computeTwoProportionNPerArm,
  getMeasurementStageUsableShare,
  planExperiment,
  planSdkWeightTest,
  type PlannerTestMode,
  type ExperimentPlanInput,
  type ExperimentScheduleRow,
  type ExperimentPlanOutput,
  type SdkWeightTestPlanInput,
  type SdkWeightTestPlanOutput,
} from './planner';
export {
  MAX_SITE_CONVERSION_RULES,
  CANONICAL_LABEL_KEYS,
  METRIC_LEVELS,
  formatSiteRuleRef,
  formatLabelRef,
  computeMetricDefinitionHash,
  createLockedMetricDefinition,
  validateMetricContractHierarchy,
  type CanonicalLabelKey,
  type MetricLevel,
  type SiteConversionRule,
  type LabelContract,
  type MetricDefinition,
  type MetricContractValidationResult,
} from './contracts';
