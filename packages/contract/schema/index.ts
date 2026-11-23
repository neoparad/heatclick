/**
 * UGOKI LINK v2 — Single-Schema Contract & Deterministic Generators (Bundle 1-A)
 */

export * from './types';
export { CANONICAL_SCHEMA } from './canonical';
export {
  canonicalJsonStringify,
  sha256Bytes,
  sha256Hex,
  hmacSha256Bytes,
  hmacSha256Hex,
  SUBJECT_HMAC_VERSION,
  computeCanonicalSubjectHmac,
  computeSubjectHmacLookupCandidates,
  utf8ToBytes,
  bytesToUtf8,
  type CanonicalSubjectHmacVersion,
  type CanonicalSubjectHmacInput,
  type SubjectHmacLookupCandidatesInput,
} from './hash';
export {
  ContractInvariantError,
  validateContractSchema,
  assertValidContractSchema,
  isValidRetentionGridMonths,
  assertValidRetentionGridMonths,
  type SchemaInvariantResult,
  type SchemaViolation,
  type SchemaViolationCode,
} from './invariants';
export {
  createSdkFrameCodec,
  computeFrameChecksum,
  verifyFrameChecksum,
  maskUrlParams,
  toLengthBucketToken,
  type FrameChecksum,
  type SeqPairedValue,
  type SectionRegisterPayload,
  type BlockRegisterPayload,
  type FieldRegisterPayload,
  type FormRegisterPayload,
  type MediaRegisterPayload,
  type VitalsRegisterPayload,
  type PageStatePayload,
  type TelemetryLogItem,
  type TelemetryFrame,
  type UrlMaskingResult,
  type SdkFrameValidationError,
  type SdkFrameValidationResult,
  type GeneratedSdkCodec,
} from './frame-codec';
export {
  createIngestValidator,
  type FieldValidationFlag,
  type SanitizedQuarantineRecord,
  type IngestContext,
  type IngestValidationResult,
  type GeneratedIngestValidator,
} from './ingest-validator';
export {
  generateClickHouseDdl,
  generatePostgresDdl,
  type GeneratedDdlArtifact,
} from './ddl-generator';
export {
  generateTypeScriptApiTypes,
  type GeneratedTsTypesArtifact,
} from './ts-types-generator';
export {
  generatePrivacyDisclosure,
  type DisclosureOptions,
  type DisclosureTransmittedItem,
  type PrivacyDisclosureRecord,
} from './disclosure-generator';
export {
  generateDeletionPlan,
  verifyDeletionPlanCoverage,
  assertDeletionPlanCoverage,
  type DeletionTableEntry,
  type DeletionPlan,
  type DeletionCoverageResult,
} from './deletion-plan-generator';

import { generateClickHouseDdl, generatePostgresDdl, type GeneratedDdlArtifact } from './ddl-generator';
import { generateDeletionPlan, type DeletionPlan } from './deletion-plan-generator';
import {
  generatePrivacyDisclosure,
  type DisclosureOptions,
  type PrivacyDisclosureRecord,
} from './disclosure-generator';
import { createSdkFrameCodec, type GeneratedSdkCodec } from './frame-codec';
import { canonicalJsonStringify, sha256Hex } from './hash';
import { createIngestValidator, type GeneratedIngestValidator } from './ingest-validator';
import { assertValidContractSchema } from './invariants';
import {
  generateTypeScriptApiTypes,
  type GeneratedTsTypesArtifact,
} from './ts-types-generator';
import type { ContractSchema } from './types';

export interface GeneratedContractBundle {
  readonly schemaVersion: string;
  readonly sdkCodec: GeneratedSdkCodec;
  readonly ingestValidator: GeneratedIngestValidator;
  readonly clickhouseDdl: GeneratedDdlArtifact;
  readonly postgresDdl: GeneratedDdlArtifact;
  readonly typescriptTypes: GeneratedTsTypesArtifact;
  readonly privacyDisclosure: PrivacyDisclosureRecord;
  readonly deletionPlan: DeletionPlan;
  readonly manifestSha256: string;
}

/**
 * Deterministically generates all 6 contract artifacts from one authoritative schema.
 * Re-running on the same schema is guaranteed to produce byte-identical outputs
 * and an identical `manifestSha256` (zero-diff regenerate check, TEL G15).
 */
export function generateAllContractArtifacts(
  schema: ContractSchema,
  disclosureOptions?: DisclosureOptions
): GeneratedContractBundle {
  assertValidContractSchema(schema);

  const sdkCodec = createSdkFrameCodec(schema);
  const ingestValidator = createIngestValidator(schema);
  const deletionPlan = generateDeletionPlan(schema);
  const clickhouseDdl = generateClickHouseDdl(schema);
  const postgresDdl = generatePostgresDdl(schema);
  const typescriptTypes = generateTypeScriptApiTypes(schema);
  const privacyDisclosure = generatePrivacyDisclosure(schema, disclosureOptions);

  const manifestSha256 = sha256Hex(
    canonicalJsonStringify({
      schemaVersion: schema.meta.schemaVersion,
      clickhouseDdlSha256: clickhouseDdl.sha256,
      postgresDdlSha256: postgresDdl.sha256,
      typescriptTypesSha256: typescriptTypes.sha256,
      privacyDisclosureSha256: privacyDisclosure.contentSha256,
      deletionPlanSha256: deletionPlan.contentSha256,
    })
  );

  return {
    schemaVersion: schema.meta.schemaVersion,
    sdkCodec,
    ingestValidator,
    clickhouseDdl,
    postgresDdl,
    typescriptTypes,
    privacyDisclosure,
    deletionPlan,
    manifestSha256,
  };
}
