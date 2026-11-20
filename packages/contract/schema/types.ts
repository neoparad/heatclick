/**
 * UGOKI LINK v2 — Single-Schema Contract Meta-Types
 *
 * Authoritative vocabulary aligned with:
 * - Master Architecture v2 (§3.1, §4.1–§4.7, §5.1–§5.7, §6.1–§6.7, §11.11)
 * - Telemetry Final (M1–M10, A1–A7)
 * - Consistency Definitions (D-1 – D-40)
 * - Store Final (M1–M8, A1, A8)
 */

export const CODEC_VERSION = 'ugk-bin/1' as const;
export type CodecVersion = typeof CODEC_VERSION;

export const CONSENT_MODES = [
  'off',
  'cookieless',
  'stats_exempt',
  'session',
  'full',
] as const;
export type ConsentMode = (typeof CONSENT_MODES)[number];

export const CONSENT_TIERS = ['T0', 'T1', 'T2'] as const;
export type ConsentTier = (typeof CONSENT_TIERS)[number];

export const CONSENT_PURPOSES = [
  'member_link',
  'timeline',
  'page_content',
  'site_search',
  'ads',
  'automation_detection',
  'pool',
  'experiment',
  'personalise',
  'screen_replay',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const JURISDICTIONS = [
  'JP',
  'GB',
  'FR',
  'EU_EEA',
  'US_OPTOUT',
  'UNKNOWN',
] as const;
export type JurisdictionCode = (typeof JURISDICTIONS)[number];

export const COLLECTION_LANES = [
  'standard',
  'customer_defined',
  'screen_replay',
] as const;
export type CollectionLane = (typeof COLLECTION_LANES)[number];

export const RETENTION_GRID_MONTHS = [
  1, 2, 3, 6, 9, 12, 13, 18, 24, 30, 36,
] as const;
export type RetentionGridMonths = (typeof RETENTION_GRID_MONTHS)[number];

export type RetentionPolicy =
  | 'site_class'
  | '30d_timeline'
  | '7d_quarantine'
  | '48h_wal'
  | '35d_access_t'
  | '30d_sealed_address_key'
  | '72h_optin_address_key'
  | '2d_live_tail'
  | 'tenant_lifetime'
  | 'audit_min_1y'
  | 'long_lived_generalised';

export const PII_CLASSES = [
  'none',
  'network_pseudonym',
  'pv_linkable',
  'session_id',
  'visitor_id',
  'member_hash',
  'external_id',
  'sealed_address',
  'raw_ua_bot_only',
  'escrow_quorum',
  'site_search_quorum',
  'customer_attribute',
] as const;
export type PiiClass = (typeof PII_CLASSES)[number];

export const PERSON_LINKABLE_PII_CLASSES: ReadonlySet<PiiClass> = new Set<PiiClass>([
  'pv_linkable',
  'session_id',
  'visitor_id',
  'member_hash',
  'external_id',
  'sealed_address',
  'customer_attribute',
]);

export function isPersonLinkablePii(piiClass: PiiClass): boolean {
  return PERSON_LINKABLE_PII_CLASSES.has(piiClass);
}

export const MERGE_CLASSES = [
  'max',
  'min',
  'maxMap',
  'minMap',
  'bitOr',
  'bitmap',
  'argMax_seq',
  'log_identity',
  'immutable_first',
  'none',
] as const;
export type MergeClass = (typeof MERGE_CLASSES)[number];

export const MONOTONE_REQUIRED_MERGE_CLASSES: ReadonlySet<MergeClass> =
  new Set<MergeClass>(['max', 'maxMap', 'bitOr']);

export const FIELD_DATA_TYPES = [
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'int32',
  'int64',
  'float32',
  'float64',
  'bool',
  'hex128',
  'hex64',
  'hex48',
  'hex40',
  'hex32',
  'enum',
  'string_closed',
  'uint32_array',
  'map_u64_u32',
  'map_u64_u64',
  'bytes',
  'timestamp_ms',
  'date',
] as const;
export type FieldDataType = (typeof FIELD_DATA_TYPES)[number];

export type OnInvalidAction = 'drop_flag' | 'clamp_flag' | 'reject_envelope';

/**
 * Closed list of string slots allowed by contract (TEL A3 + §4.3 + D-6).
 * Default-deny: any string slot outside this closed list is rejected at CI and runtime.
 */
export const STRING_SLOT_IDS = [
  'page_url_key',
  'internal_referrer_key',
  'transition_target_key',
  'external_referrer_key',
  'dest_key_click',
  'campaign_param',
  'conversion_enum_id',
  'identify_hex',
  'site_search_term',
  'page_content_escrow',
  'user_agent_header',
  'ec_product_id',
  'actor_registry_id',
  'opaque_system_id',
] as const;
export type StringSlotId = (typeof STRING_SLOT_IDS)[number];

export const URL_PARAM_CLASSES = [
  'content',
  'noise',
  'user_input',
  'unknown',
] as const;
export type UrlParamClass = (typeof URL_PARAM_CLASSES)[number];

export const FRAME_CLASSES = [
  'first',
  'change',
  'heartbeat',
  'hidden',
  'resume',
  'idle',
  'critical',
  'deferred',
  'audit',
  'recovered',
] as const;
export type FrameClass = (typeof FRAME_CLASSES)[number];

export const HIDDEN_BUDGET_FRAME_CLASSES: ReadonlySet<FrameClass> =
  new Set<FrameClass>(['hidden', 'critical', 'deferred']);

export const FULL_REQUIRED_FRAME_CLASSES: ReadonlySet<FrameClass> =
  new Set<FrameClass>(['hidden', 'deferred']);

export const FRAME_TRANSPORTS = [
  'fetch',
  'beacon',
  'later',
  'wal_tab',
  'wal_visit',
] as const;
export type FrameTransport = (typeof FRAME_TRANSPORTS)[number];

export const NAV_TYPES = [
  'navigate',
  'reload',
  'back_forward',
  'restore',
  'prerender',
  'soft',
  'resume',
] as const;
export type NavType = (typeof NAV_TYPES)[number];

export const TRUST_LEVELS = [
  'edge_attested',
  'origin_attested',
  'continuity',
  'none',
] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const HANDOFF_STATES = [
  'fresh',
  'reused',
  'shared_cache',
  'inherited',
  'time_keyed',
  'pending',
  'absent',
] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

export const IDENTITY_QUALITIES = ['A', 'B', 'C'] as const;
export type IdentityQuality = (typeof IDENTITY_QUALITIES)[number];

export const ACTOR_CLASSES = [
  'human_presumed',
  'crawler_verified',
  'fetcher_verified',
  'hosted_agent_verified',
  'bot_claimed',
  'claim_refuted',
  'automation_explicit',
  'automation_inferred',
  'no_script_client',
  'own_instrument',
  'unknown',
] as const;
export type ActorClass = (typeof ACTOR_CLASSES)[number];

export const TRAFFIC_CLASSES = ['public', 'internal', 'panel', 'lab'] as const;
export type TrafficClass = (typeof TRAFFIC_CLASSES)[number];

export const IDENTITY_ASSURANCES = [
  'crypto',
  'crypto_domain',
  'network',
  'asn_consistent',
  'declared_only',
  'refuted',
  'model',
  'none',
] as const;
export type IdentityAssurance = (typeof IDENTITY_ASSURANCES)[number];

export const VERIFICATION_RESULTS = [
  'verified',
  'verified_operator',
  'verified_retro',
  'refuted',
  'feed_miss',
  'late_published',
  'unverifiable_no_method',
  'unverifiable_no_client_ip',
  'unverifiable_ip_untrusted',
  'unverifiable_stale_evidence',
] as const;
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

export const DOM_STATES = [
  'ok',
  'private_scope',
  'translated',
  'norm_mismatch',
  'cap_hit',
  'degraded',
] as const;
export type DomState = (typeof DOM_STATES)[number];

export const UNIT_KINDS = [
  'visitor',
  'session',
  'page_view',
  'impression',
  'page',
  'page_cluster',
  'lab_run',
] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export const EXPOSURE_KINDS = [
  'trigger',
  'render',
  'visible',
  'suppressed',
  'probe',
] as const;
export type ExposureKind = (typeof EXPOSURE_KINDS)[number];

export const EXPOSURE_REASONS = [
  'suppressed_preflight',
  'suppressed_prerender',
  'suppressed_lease',
  'suppressed_arbitration',
  'suppressed_policy',
  'suppressed_cap',
  'suppressed_consent',
  'anchor_drift',
  'ended_by_edit',
  'framework_conflict',
  'late_visible',
  'timeout_control',
  'blocked_csp',
  'edge_skipped',
  'render_failed',
  'pass',
  'fail',
] as const;
export type ExposureReason = (typeof EXPOSURE_REASONS)[number];

export const ADDRESS_CLASSES = ['E', 'T', 'P'] as const;
export type AddressClass = (typeof ADDRESS_CLASSES)[number];

export const LOG_ITEM_KINDS = [
  'activation',
  'conversion',
  'exposure',
  'anchor_jump',
  'reread_transition',
  'section_tokens',
  'table_revision',
  'internal_activation',
  'multi_click_burst',
  'timeline_chunk',
] as const;
export type LogItemKind = (typeof LOG_ITEM_KINDS)[number];

export const ACTIVATION_KINDS = [
  'click',
  'auxclick',
  'keyboard',
  'new_tab_inferred',
  'frame_blur_proxy',
  'tel_link',
  'mailto_link',
] as const;
export type ActivationKind = (typeof ACTIVATION_KINDS)[number];

export const REVENUE_GRAINS = [
  'slot_param',
  'click_nonce',
  'preset_id',
  'order_detail',
  'time_match',
  'program_split',
  'none',
] as const;
export type RevenueGrain = (typeof REVENUE_GRAINS)[number];

export const MEASUREMENT_ARMS = [
  'v2',
  'v3',
  'both',
  'stub',
  'lite',
  'full',
  'audit',
] as const;
export type MeasurementArm = (typeof MEASUREMENT_ARMS)[number];

export type FieldDomain =
  | 'envelope'
  | 'page_state'
  | 'section_register'
  | 'block_register'
  | 'field_register'
  | 'form_register'
  | 'media_register'
  | 'vitals_register'
  | 'agent_stats'
  | 'log_item'
  | 'decision_record'
  | 'exposure_record'
  | 'feature_record'
  | 'access_obs'
  | 'access_verdict'
  | 'handoff'
  | 'control_plane';

export const BEHAVIOUR_REGISTER_DOMAINS: ReadonlySet<FieldDomain> =
  new Set<FieldDomain>([
    'section_register',
    'block_register',
    'field_register',
    'form_register',
    'media_register',
    'vitals_register',
    'agent_stats',
  ]);

export interface StaticFieldBounds {
  readonly min?: number;
  readonly max?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
}

export interface FieldDisclosureMeta {
  readonly jaLabel: string;
  readonly enLabel: string;
  readonly purposeJa: string;
  readonly recipientKind:
    | 'ugokilink_first_party'
    | 'ugokilink_processor'
    | 'customer_origin'
    | 'authorized_third_party';
  readonly transmittedFromBrowser: boolean;
}

export interface FieldSpec {
  readonly tag: number;
  readonly name: string;
  readonly domain: FieldDomain;
  readonly type: FieldDataType;
  readonly enumValues?: readonly string[];
  readonly stringSlot?: StringSlotId;
  readonly required: boolean;
  readonly nullable?: boolean;
  readonly staticBounds?: StaticFieldBounds;
  readonly dynamicBound?: 'elapsed_ms' | 'rate_per_sec' | 'none';
  readonly onInvalid: OnInvalidAction;
  readonly merge: MergeClass;
  readonly monotoneProof?: string;
  readonly carriesSeqPair?: boolean;
  readonly piiClass: PiiClass;
  readonly deletable: boolean;
  readonly consentMin: ConsentMode;
  readonly requiredPurposes: readonly ConsentPurpose[];
  readonly retentionPolicy: RetentionPolicy;
  readonly lane: CollectionLane;
  readonly disclosure: FieldDisclosureMeta;
  readonly clickhouseType: string;
  readonly postgresType?: string;
  readonly tables: readonly string[];
  readonly mlFeatureCandidate?: boolean;
}

export interface ConsentModeSpec {
  readonly mode: ConsentMode;
  readonly tier: ConsentTier;
  readonly allowsBrowserStorage: boolean;
  readonly allowsTelemetryFrames: boolean;
  readonly allowedUnitKinds: readonly UnitKind[];
  readonly disallowedPurposes: readonly ConsentPurpose[];
  readonly maxIdentifierMonths: number;
  readonly summaryJa: string;
}

export interface ConsentPurposeSpec {
  readonly purpose: ConsentPurpose;
  readonly defaultEnabled: boolean;
  readonly minMode: ConsentMode;
  readonly requiresLegalSignoff: boolean;
  readonly requiresOwnerDecision?: string;
  readonly lane: CollectionLane;
  readonly labelJa: string;
  readonly descriptionJa: string;
}

export interface JurisdictionRow {
  readonly jurisdiction: JurisdictionCode;
  readonly labelJa: string;
  readonly defaultModeBeforeSignoff: ConsentMode;
  readonly proposedDefaultModeAfterSignoff: ConsentMode;
  readonly privacySignalBeforeSignoff: ConsentMode | 'no_pool_ads_identify';
  readonly privacySignalAfterSignoff: ConsentMode | 'no_pool_ads_identify';
  readonly legalSignedOff: boolean;
  readonly requiresOwnerScopeDecision: boolean;
  readonly legalBasisJa: string;
}

export interface StringSlotSpec {
  readonly id: StringSlotId;
  readonly contentRule: string;
  readonly control: string;
  readonly maxLength: number;
  readonly allowedInBehaviourFrame: boolean;
  readonly requiredPurposes: readonly ConsentPurpose[];
  readonly quorumRequired?: { readonly minPvs: number; readonly minPrefixes: number };
}

export interface TableColumnSpec {
  readonly name: string;
  readonly fieldRef?: string;
  readonly clickhouseType?: string;
  readonly postgresType?: string;
  readonly nullable?: boolean;
  readonly defaultExpr?: string;
  readonly piiClass: PiiClass;
  readonly deletable: boolean;
  readonly merge?: MergeClass;
  readonly comment: string;
}

export type ClickHouseEngine =
  | 'ReplacingMergeTree'
  | 'AggregatingMergeTree'
  | 'MergeTree';

export type DeletionStrategy =
  | 'by_pv_key'
  | 'by_visitor_key'
  | 'by_session_key'
  | 'by_unit_key'
  | 'by_req_uid'
  | 'by_subject_row'
  | 'quarantine_7d_delete'
  | 'not_applicable_aggregate'
  | 'not_applicable_non_personal';

export interface TableSpec {
  readonly name: string;
  readonly store: 'clickhouse' | 'postgres';
  readonly engine: ClickHouseEngine | 'postgres';
  readonly versionColumn?: string;
  readonly tenantScoped: boolean;
  readonly siteScoped: boolean;
  readonly orderBy: readonly string[];
  readonly partitionBy?: string;
  readonly ttlExpr?: string;
  readonly indexGranularity?: number;
  readonly primaryKey?: readonly string[];
  readonly indexes?: readonly string[];
  readonly retentionPolicy: RetentionPolicy;
  readonly deletionStrategy: DeletionStrategy;
  readonly deletionLookupPath?: string;
  readonly requiresRollupRebuild: boolean;
  readonly requiresCachePurge: boolean;
  readonly isTimelineTable?: boolean;
  readonly hasMaterializedView?: boolean;
  readonly hasProjection?: boolean;
  readonly columns: readonly TableColumnSpec[];
  readonly description: string;
}

export interface ExternalStoreDeletionSpec {
  readonly id: string;
  readonly storeKind: 'r2_wal' | 'r2_segments' | 'quarantine' | 'abuse_hold' | 'export_manifest' | 'edge_cache' | 'ml_extract' | 'ec_member_summary';
  readonly locationPattern: string;
  readonly retentionPolicy: RetentionPolicy;
  readonly deletionAction: string;
  readonly maxDeadlineDays: number;
  readonly priorityOrder: number;
}

export interface FrameBudgetSpec {
  readonly hiddenMaxBytes: number;
  readonly visibleMaxBytes: number;
  readonly gzipThresholdBytes: number;
  readonly inflateMaxBytes: number;
  readonly firstFrameTargetBytes: number;
  readonly minimalFallbackBytes: number;
}

export interface DeletionDeadlineSpec {
  readonly maskedWithinHours: number;
  readonly purgedWithinDays: number;
  readonly backupExpiryDays: number;
  readonly overdueAlertDay: number;
  readonly certifiedWithinDays: number;
  readonly undoWindowDays: number;
}

export interface ContractMeta {
  readonly schemaVersion: string;
  readonly wireVersion: number;
  readonly codecVersion: CodecVersion;
  readonly contractMajor: number;
}

export interface ContractSchema {
  readonly meta: ContractMeta;
  readonly consentModes: readonly ConsentModeSpec[];
  readonly purposes: readonly ConsentPurposeSpec[];
  readonly jurisdictionMatrix: readonly JurisdictionRow[];
  readonly stringSlots: readonly StringSlotSpec[];
  readonly forbiddenBehaviourFieldNames: readonly string[];
  readonly frameLimits: FrameBudgetSpec;
  readonly retentionGridMonths: readonly RetentionGridMonths[];
  readonly defaultRetentionMonths: RetentionGridMonths;
  readonly deletionDeadlines: DeletionDeadlineSpec;
  readonly fields: readonly FieldSpec[];
  readonly tables: readonly TableSpec[];
  readonly externalStores: readonly ExternalStoreDeletionSpec[];
  readonly unreachableDeletionClasses: readonly {
    readonly code: string;
    readonly labelJa: string;
    readonly reasonJa: string;
  }[];
}

export function consentModeToTier(mode: ConsentMode): ConsentTier {
  if (mode === 'off') return 'T0';
  if (mode === 'cookieless') return 'T1';
  return 'T2';
}

export const CONSENT_MODE_RANK: Readonly<Record<ConsentMode, number>> = {
  off: 0,
  cookieless: 1,
  stats_exempt: 2,
  session: 3,
  full: 4,
};
