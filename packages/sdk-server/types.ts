/**
 * UGOKI LINK v2 — 8-Language Server SDK Generator & Common Conformance Types (§11.11 item 9)
 */

export const SDK_LANGUAGES = [
  'typescript',
  'python',
  'go',
  'java',
  'ruby',
  'php',
  'dotnet',
  'rust',
] as const;

export type SdkLanguage = (typeof SDK_LANGUAGES)[number];

export const SEGMENT_CALL_TYPES = [
  'identify',
  'page',
  'screen',
  'track',
  'group',
  'alias',
] as const;

export type SegmentCallType = (typeof SEGMENT_CALL_TYPES)[number];

export interface SdkGeneratedFile {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}

export interface GeneratedSdkArtifact {
  readonly language: SdkLanguage;
  readonly contractSchemaVersion: string;
  readonly openapiContractSha256: string;
  readonly files: ReadonlyArray<SdkGeneratedFile>;
  readonly manifestSha256: string;
}

export interface FeatureFlagArm {
  readonly value: string;
  readonly weight: number;
}

export interface FeatureFlagConfig {
  readonly flagKey: string;
  readonly saltKey: string;
  readonly safeValue: string;
  readonly arms: ReadonlyArray<FeatureFlagArm>;
}

export interface SignedConfigBundle {
  readonly bundleId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly flags: ReadonlyArray<FeatureFlagConfig>;
  readonly issuedAtMs: number;
  readonly signatureHex: string;
}

export interface SignedDisplayLease {
  readonly leaseId: string;
  readonly siteId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly signatureHex: string;
}

export interface FlagEvaluationResult {
  readonly flagKey: string;
  readonly value: string;
  readonly fallback: boolean;
  readonly reason:
    | 'assigned'
    | 'lease_expired_safe_fallback'
    | 'invalid_signature_safe_fallback'
    | 'actor_blind_violation_safe_fallback'
    | 'unknown_flag_safe_fallback';
  readonly uniformDraw?: number;
}

export interface AllocatorConformanceVector {
  readonly key: string;
  readonly unitId: string;
  readonly expectedU: number;
  readonly expectedHexPrefix8: string;
}

export interface Ed25519ConformanceVector {
  readonly publicKeyHex: string;
  readonly message: string;
  readonly signatureHex: string;
  readonly expectedValid: boolean;
}

export interface SegmentConformanceVector {
  readonly callType: SegmentCallType;
  readonly input: Readonly<Record<string, unknown>>;
  readonly expectedPayload: Readonly<Record<string, unknown>>;
}

export interface FlagConformanceVector {
  readonly name: string;
  readonly publicKeyHex: string;
  readonly bundle: SignedConfigBundle;
  readonly lease: SignedDisplayLease;
  readonly flagKey: string;
  readonly unitId: string;
  readonly nowMs: number;
  readonly extraInputKeys?: ReadonlyArray<string>;
  readonly expected: FlagEvaluationResult;
}

export interface ConformanceVectorBundle {
  readonly contractSchemaVersion: string;
  readonly openapiContractSha256: string;
  readonly allocatorVectors: ReadonlyArray<AllocatorConformanceVector>;
  readonly ed25519Vectors: ReadonlyArray<Ed25519ConformanceVector>;
  readonly segmentVectors: ReadonlyArray<SegmentConformanceVector>;
  readonly flagVectors: ReadonlyArray<FlagConformanceVector>;
}

export type RuntimeExecutionStatus =
  | 'live_subprocess_passed'
  | 'live_subprocess_failed'
  | 'static_verified_runtime_absent';

export interface LanguageConformanceReport {
  readonly language: SdkLanguage;
  readonly runtimeDetected: boolean;
  readonly runtimeStatus: RuntimeExecutionStatus;
  readonly staticContractPassed: boolean;
  readonly allocatorDiscrepancies: number;
  readonly ed25519Discrepancies: number;
  readonly segmentDiscrepancies: number;
  readonly flagDiscrepancies: number;
  readonly totalDiscrepancies: number;
  readonly details: ReadonlyArray<string>;
}

export interface MultiLanguageConformanceSummary {
  readonly contractSchemaVersion: string;
  readonly openapiContractSha256: string;
  readonly languagesChecked: number;
  readonly liveExecutedLanguages: ReadonlyArray<SdkLanguage>;
  readonly staticOnlyLanguages: ReadonlyArray<SdkLanguage>;
  readonly totalDiscrepancies: number;
  readonly allPassed: boolean;
  readonly reports: ReadonlyArray<LanguageConformanceReport>;
}
