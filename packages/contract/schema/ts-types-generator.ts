/**
 * Generator #4: Deterministic TypeScript API Type Definition Generator
 *
 * Generates standalone `.ts` type definitions directly from the single
 * authoritative ContractSchema so REST, SDK, MCP, and Worker code share
 * one exact vocabulary without manual drift (§3.1 / §4.7 / TEL M7).
 */

import { canonicalJsonStringify, sha256Hex } from './hash';
import { assertValidContractSchema } from './invariants';
import {
  ACTIVATION_KINDS,
  ACTOR_CLASSES,
  ADDRESS_CLASSES,
  CONSENT_MODES,
  CONSENT_PURPOSES,
  CONSENT_TIERS,
  DOM_STATES,
  EXPOSURE_KINDS,
  EXPOSURE_REASONS,
  FRAME_CLASSES,
  FRAME_TRANSPORTS,
  HANDOFF_STATES,
  IDENTITY_ASSURANCES,
  IDENTITY_QUALITIES,
  LOG_ITEM_KINDS,
  MEASUREMENT_ARMS,
  MERGE_CLASSES,
  NAV_TYPES,
  PII_CLASSES,
  REVENUE_GRAINS,
  TRAFFIC_CLASSES,
  TRUST_LEVELS,
  UNIT_KINDS,
  URL_PARAM_CLASSES,
  VERIFICATION_RESULTS,
  type ContractSchema,
  type FieldDataType,
  type FieldSpec,
} from './types';

function toTsUnion(name: string, values: readonly (string | number)[]): string {
  const rendered = values
    .map((v) => (typeof v === 'string' ? `'${v}'` : String(v)))
    .join(' | ');
  return `export type ${name} = ${rendered};`;
}

function fieldTypeToTs(field: FieldSpec): string {
  if (field.type === 'enum' && field.enumValues && field.enumValues.length > 0) {
    return field.enumValues.map((v) => `'${v}'`).join(' | ');
  }
  const map: Record<FieldDataType, string> = {
    uint8: 'number',
    uint16: 'number',
    uint32: 'number',
    uint64: 'string',
    int32: 'number',
    int64: 'string',
    float32: 'number',
    float64: 'number',
    bool: 'boolean',
    hex128: 'string',
    hex64: 'string',
    hex48: 'string',
    hex40: 'string',
    hex32: 'string',
    enum: 'string',
    string_closed: 'string',
    uint32_array: 'readonly number[]',
    map_u64_u32: 'Readonly<Record<string, number>>',
    map_u64_u64: 'Readonly<Record<string, string>>',
    bytes: 'Uint8Array | string',
    timestamp_ms: 'number',
    date: 'string',
  };
  const base = map[field.type];
  if (field.carriesSeqPair) {
    return `{ readonly value: ${field.nullable ? `${base} | null` : base}; readonly seq: number }`;
  }
  return field.nullable ? `${base} | null` : base;
}

function renderInterface(name: string, fields: readonly FieldSpec[]): string {
  const sorted = [...fields].sort((a, b) => a.tag - b.tag);
  const lines: string[] = [`export interface ${name} {`];
  for (const field of sorted) {
    const opt = field.required ? '' : '?';
    lines.push(
      `  /** [tag=${field.tag}] [merge=${field.merge}] [pii=${field.piiClass}] ${field.disclosure.enLabel} */`
    );
    lines.push(`  readonly ${field.name}${opt}: ${fieldTypeToTs(field)};`);
  }
  lines.push('}');
  return lines.join('\n');
}

export interface GeneratedTsTypesArtifact {
  readonly schemaVersion: string;
  readonly source: string;
  readonly sha256: string;
}

export function generateTypeScriptApiTypes(
  schema: ContractSchema
): GeneratedTsTypesArtifact {
  assertValidContractSchema(schema);

  const schemaDigest = sha256Hex(canonicalJsonStringify(schema));
  const domains = {
    envelope: schema.fields.filter((f) => f.domain === 'envelope'),
    pageState: schema.fields.filter((f) => f.domain === 'page_state'),
    section: schema.fields.filter((f) => f.domain === 'section_register'),
    block: schema.fields.filter((f) => f.domain === 'block_register'),
    field: schema.fields.filter((f) => f.domain === 'field_register'),
    form: schema.fields.filter((f) => f.domain === 'form_register'),
    media: schema.fields.filter((f) => f.domain === 'media_register'),
    vitals: schema.fields.filter((f) => f.domain === 'vitals_register'),
    logItem: schema.fields.filter((f) => f.domain === 'log_item'),
    decision: schema.fields.filter((f) => f.domain === 'decision_record'),
    exposure: schema.fields.filter((f) => f.domain === 'exposure_record'),
    accessObs: schema.fields.filter((f) => f.domain === 'access_obs'),
    accessVerdict: schema.fields.filter((f) => f.domain === 'access_verdict'),
    handoff: schema.fields.filter((f) => f.domain === 'handoff'),
  };

  const sections: string[] = [
    '/**',
    ` * UGOKI LINK v2 — Generated TypeScript API Contract Types (v${schema.meta.schemaVersion})`,
    ` * Source Schema SHA-256: ${schemaDigest}`,
    ' * DO NOT EDIT MANUALLY. Regenerate from packages/contract/schema/canonical.ts',
    ' */',
    '',
    `export const CONTRACT_SCHEMA_VERSION = '${schema.meta.schemaVersion}' as const;`,
    `export const CONTRACT_WIRE_VERSION = ${schema.meta.wireVersion} as const;`,
    `export const CONTRACT_CODEC_VERSION = '${schema.meta.codecVersion}' as const;`,
    `export const FRAME_HIDDEN_MAX_BYTES = ${schema.frameLimits.hiddenMaxBytes} as const;`,
    `export const FRAME_VISIBLE_MAX_BYTES = ${schema.frameLimits.visibleMaxBytes} as const;`,
    '',
    toTsUnion('ApiConsentMode', CONSENT_MODES),
    toTsUnion('ApiConsentTier', CONSENT_TIERS),
    toTsUnion('ApiConsentPurpose', CONSENT_PURPOSES),
    toTsUnion('ApiFrameClass', FRAME_CLASSES),
    toTsUnion('ApiFrameTransport', FRAME_TRANSPORTS),
    toTsUnion('ApiNavType', NAV_TYPES),
    toTsUnion('ApiTrustLevel', TRUST_LEVELS),
    toTsUnion('ApiHandoffState', HANDOFF_STATES),
    toTsUnion('ApiIdentityQuality', IDENTITY_QUALITIES),
    toTsUnion('ApiActorClass', ACTOR_CLASSES),
    toTsUnion('ApiTrafficClass', TRAFFIC_CLASSES),
    toTsUnion('ApiIdentityAssurance', IDENTITY_ASSURANCES),
    toTsUnion('ApiVerificationResult', VERIFICATION_RESULTS),
    toTsUnion('ApiDomState', DOM_STATES),
    toTsUnion('ApiUnitKind', UNIT_KINDS),
    toTsUnion('ApiExposureKind', EXPOSURE_KINDS),
    toTsUnion('ApiExposureReason', EXPOSURE_REASONS),
    toTsUnion('ApiAddressClass', ADDRESS_CLASSES),
    toTsUnion('ApiLogItemKind', LOG_ITEM_KINDS),
    toTsUnion('ApiActivationKind', ACTIVATION_KINDS),
    toTsUnion('ApiRevenueGrain', REVENUE_GRAINS),
    toTsUnion('ApiMeasurementArm', MEASUREMENT_ARMS),
    toTsUnion('ApiUrlParamClass', URL_PARAM_CLASSES),
    toTsUnion('ApiPiiClass', PII_CLASSES),
    toTsUnion('ApiMergeClass', MERGE_CLASSES),
    toTsUnion(
      'ApiStringSlotId',
      schema.stringSlots.map((s) => s.id)
    ),
    toTsUnion('ApiRetentionGridMonths', schema.retentionGridMonths),
    '',
    renderInterface('ApiTelemetryFrameEnvelope', domains.envelope),
    '',
    renderInterface('ApiPageStateRegisters', domains.pageState),
    '',
    renderInterface('ApiSectionRegister', domains.section),
    '',
    renderInterface('ApiBlockRegister', domains.block),
    '',
    renderInterface('ApiFieldRegister', domains.field),
    '',
    renderInterface('ApiFormRegister', domains.form),
    '',
    renderInterface('ApiMediaRegister', domains.media),
    '',
    renderInterface('ApiVitalsRegister', domains.vitals),
    '',
    renderInterface('ApiTelemetryLogItem', domains.logItem),
    '',
    renderInterface('ApiDecisionRecord', domains.decision),
    '',
    renderInterface('ApiExposureRecord', domains.exposure),
    '',
    renderInterface('ApiAccessObservation', domains.accessObs),
    '',
    renderInterface('ApiAccessVerdict', domains.accessVerdict),
    '',
    renderInterface('ApiHandoffRecord', domains.handoff),
    '',
    'export interface ApiIngestAck {',
    '  readonly seq: number;',
    '  readonly i_hw: number;',
    '  readonly srv_t: number;',
    '  readonly pv_token: string | null;',
    '  readonly need: readonly string[];',
    '  readonly rej: readonly string[];',
    '  readonly kill: number;',
    '  readonly h: number;',
    '  readonly ctl_digest: string;',
    '}',
    '',
  ];

  const source = sections.join('\n');
  return {
    schemaVersion: schema.meta.schemaVersion,
    source,
    sha256: sha256Hex(source),
  };
}
