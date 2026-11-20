/**
 * UGOKI LINK v2 — Collector Worker Barrel Export (Bundles 3-A, 3-B, 3-C)
 */

export * from './types';
export {
  PROTECTED_HUMAN_PIPELINES,
  auditZeroLabLeakage,
  evaluateLabPipelineExclusion,
  filterForHumanPipeline,
  signLabMarker,
  verifyLabMarker,
  type LabExcludableRecord,
  type LabLeakageAuditResult,
  type LabMarkerVerificationResult,
  type ProtectedHumanPipeline,
} from './lab-marker';
export {
  LinkCollectorEngine,
  type CollectFrameRequestInput,
  type CollectFrameResponse,
} from './collector';
export {
  CrossLaneAggregationError,
  SEGMENT_CALL_TYPES,
  SegmentCompatIngestEngine,
  assertSingleMeasurementLane,
  serializeCustomEventForResponse,
  type SegmentCallType,
  type SegmentIncomingCall,
  type SegmentIngestDeps,
  type SegmentIngestResult,
} from './segment-compat';
export { createCollectorWorker, type CollectorWorkerDeps } from './worker';
