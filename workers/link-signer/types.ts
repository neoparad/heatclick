/**
 * UGOKI LINK v2 — Signer Service & Unified Signed Config Bundle Types
 *
 * Strictly uses Web Standard API types (no `@cloudflare/workers-types` dependency)
 * so root `npx tsc --noEmit` (`strict: true`) passes cleanly across Node and Workers.
 *
 * Spec refs: §3.1, §4.2, §6.5, §10.1–§10.6, D-23, DEL M1 / M3 / App. A / App. H.
 */

import type { ConsentMode, ConsentPurpose, UrlParamClass } from '../../packages/contract/schema';

export type TrustMode = 'pinned' | 'evergreen';
export type BundleSection = 'measure' | 'capture' | 'deliver' | 'models';
export type SigningAlgorithm = 'Ed25519' | 'ECDSA-P256';

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface PublicKeyJwkLike {
  readonly kty: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
  readonly key_ops?: readonly string[];
  readonly ext?: boolean;
}

export interface PinnedScriptArtifact {
  readonly url: string;
  readonly sri: string; // 'sha256-<base64>'
  readonly sha256: string; // 64-char hex
  readonly bytes_gzip: number;
}

export interface OnlineSigningKeyEntry {
  readonly kid: string;
  readonly algorithm: SigningAlgorithm;
  readonly public_key_jwk: PublicKeyJwkLike;
  readonly status: 'active' | 'retired';
  readonly valid_until: string; // ISO UTC
}

export interface ApproverPasskeyEntry {
  readonly kid: string;
  readonly approver_id: string;
  readonly public_key_jwk: PublicKeyJwkLike;
}

/**
 * §6.5 / A-15R: Affiliate click-time publisher parameters are OFFLINE-SIGNED inside
 * the release manifest so compromised online keys can NEVER redirect commissions.
 */
export interface OfflineAffiliateParamRule {
  readonly network_id: string;
  readonly allowed_params: readonly string[];
  readonly overwrite_existing: false;
}

export interface ReleaseManifestPayload {
  readonly manifest_seq: number;
  readonly issued_at: string; // ISO UTC
  readonly not_after: string; // ISO UTC, MUST be <= issued_at + 30 days
  readonly resign_due_at: string; // ISO UTC, issued_at + 14 days
  readonly abi: number;
  readonly min_config_seq: number; // Anti-replay floor for config bundles (§10.1)
  readonly artifacts: {
    readonly measure_core: PinnedScriptArtifact;
    readonly segmenter: PinnedScriptArtifact;
    readonly deliver_core: PinnedScriptArtifact;
    readonly census_empty_file: {
      readonly url: string;
      readonly sri: string;
      readonly sha256: string;
    };
  };
  readonly online_signing_keys: readonly OnlineSigningKeyEntry[];
  readonly approver_passkey_pubkeys: readonly ApproverPasskeyEntry[];
  readonly affiliate_param_allowlist: readonly OfflineAffiliateParamRule[];
}

export interface DetachedSignature {
  readonly kid: string;
  readonly alg: SigningAlgorithm;
  readonly sig_b64: string;
}

export interface SignedReleaseManifest {
  readonly payload: ReleaseManifestPayload;
  readonly payload_sha256: string;
  readonly signature: DetachedSignature; // Offline release key signature
}

// =========================================================================
// Closed Action Grammar (DEL App. A — zero executable JS in customer origin)
// =========================================================================

export type HostActionRung = 'A0' | 'A1' | 'A1c' | 'A2';

export type ClosedOpKind =
  | 'SetText'
  | 'SetAttr'
  | 'SetStyle'
  | 'AddClass'
  | 'Hide'
  | 'Move'
  | 'InsertNode'
  | 'ReplaceImage'
  | 'Mount';

export interface ClosedGrammarOp {
  readonly op: ClosedOpKind;
  readonly anchor_id: string;
  readonly target_region_tag?: string;
  readonly text?: string;
  readonly attr_name?: string;
  readonly attr_value?: string;
  readonly style_props?: Readonly<Record<string, string>>;
  readonly class_name?: string;
  readonly insert_tag?: string;
  readonly insert_attrs?: Readonly<Record<string, string>>;
  readonly insert_position?: 'before' | 'after' | 'prepend' | 'append';
  readonly image_src?: string;
  readonly image_alt?: string;
  readonly image_width?: number;
  readonly image_height?: number;
  readonly component_kind?:
    | 'bar'
    | 'modal'
    | 'slide_in'
    | 'inline_card'
    | 'launcher'
    | 'wizard'
    | 'rec_list'
    | 'assistant'
    | 'coupon';
}

export interface ClosedGrammarAction {
  readonly action_id: string;
  readonly rung: HostActionRung;
  readonly is_legally_required_disclosure?: boolean;
  readonly content_hash: string;
  readonly seo_class: 'non_indexable' | 'indexable_minor' | 'indexable_major';
  readonly k_class: 'K1' | 'K2' | 'K2p' | 'K3';
  readonly ops: readonly ClosedGrammarOp[];
}

export interface AffiliateSlotBinding {
  readonly network_id: string;
  readonly param_name: string;
  readonly slot_code: string;
}

export interface ConfigShardRef {
  readonly shard_id: string;
  readonly url_scope: string;
  readonly sha256: string;
  readonly bytes_gzip: number;
}

export interface ModelArtifactRef {
  readonly model_id: string;
  readonly version: string;
  readonly sha256: string;
  readonly bytes_gzip: number;
  readonly format: 'int_tree_table_v1';
}

export interface ConversionRuleSpec {
  readonly cv_key: string;
  readonly rule_ver: number;
  readonly match_kind: 'selector' | 'href_prefix' | 'el_fp';
  readonly match_value: string;
}

export interface RelaxationPasskeyApproval {
  readonly approver_kid: string;
  readonly prev_seq: number;
  readonly next_seq?: number;
  readonly diff_sha256: string;
  readonly sig_b64: string;
}

export interface ConfigBundlePayload {
  readonly aud: {
    readonly tenant_id: string;
    readonly site_id: string;
  };
  readonly seq: number;
  readonly abi: number;
  readonly issued_at: string;
  readonly not_after: string; // MUST be <= issued_at + 24h (§10.1 / DEL M1)
  readonly measure: {
    readonly site_default_consent: ConsentMode;
    readonly allow_cmp_opt_in_from_default_off?: boolean;
    readonly allowed_purposes: readonly ConsentPurpose[];
    readonly param_classes: Readonly<Record<string, UrlParamClass>>;
    readonly protected_regions: readonly string[];
    readonly private_regions: readonly string[];
    readonly conversion_rules: readonly ConversionRuleSpec[];
    readonly sampling_rates: Readonly<Record<string, number>>;
    readonly relaxation_approval?: RelaxationPasskeyApproval;
  };
  readonly capture: {
    readonly feed_version: string;
    readonly daily_seal_kid: string;
    readonly capture_rules: readonly string[];
  };
  readonly deliver: {
    readonly actions: readonly ClosedGrammarAction[];
    readonly affiliate_slot_bindings: readonly AffiliateSlotBinding[];
    readonly shards: readonly ConfigShardRef[];
  };
  readonly models: {
    readonly batch_snapshot_id: string;
    readonly artifacts: readonly ModelArtifactRef[];
  };
}

export interface SignedConfigBundle {
  readonly payload: ConfigBundlePayload;
  readonly bundle_hash: string; // SHA-256 of canonical JSON payload
  readonly signatures: readonly DetachedSignature[];
}

/**
 * Online loader data payload (`GET /l/{key}.json`, §4.2 / D-23).
 * Data-only: can ONLY tighten consent, stop rendering, or coarsen sampling.
 */
export interface LoaderDataPayload {
  readonly site_ref: string;
  readonly region_class: 'JP' | 'GB' | 'FR' | 'EU_EEA' | 'US_OPTOUT' | 'UNKNOWN';
  readonly region_consent_cap: ConsentMode;
  readonly kill_bits: number;
  readonly stop_deliver: boolean;
  readonly coarsen_factor: number; // >= 1
  readonly active_config_seq: number;
  readonly ctl_digest: string;
  readonly server_time_ms: number;
}

export type ManifestAlertLevel = 'none' | '50%' | '70%' | '85%' | 'expired';

export interface ManifestVerificationResult {
  readonly valid: boolean;
  readonly signatureValid: boolean;
  readonly expired: boolean;
  readonly downgraded: boolean;
  readonly alertLevel: ManifestAlertLevel;
  readonly deliverAllowed: boolean;
  readonly measureAllowed: boolean;
  readonly manifestStale: boolean;
  readonly errors: readonly string[];
}

export interface BundleSectionRuntimeState {
  readonly measure: {
    readonly enabled: boolean;
    readonly configStale: boolean;
    readonly fallbackToMinimalStub: boolean;
  };
  readonly capture: {
    readonly enabled: boolean;
    readonly unverifiableStaleEvidence: boolean;
  };
  readonly deliver: {
    readonly enabled: boolean;
    readonly unmetGate?: string;
  };
  readonly models: {
    readonly enabled: boolean;
    readonly fallbackReason?: string;
  };
}

export interface BundleVerificationResult {
  readonly valid: boolean;
  readonly expired: boolean;
  readonly sectionState: BundleSectionRuntimeState;
  readonly errors: readonly string[];
}

export interface BundleStateRecord {
  readonly bundle: SignedConfigBundle;
  readonly versionToken: string;
}

/**
 * Authoritative compare-and-swap (CAS) store for `(tenant_id, site_id)` current ConfigBundle.
 * Prevents caller-supplied `previousBundle` spoofing or omission on the Signer Service (§10.1 / C-18).
 */
export interface BundleStateStore {
  getCurrent(tenantId: string, siteId: string): Promise<BundleStateRecord | null>;
  compareAndSwap(params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly expectedVersionToken: string | null;
    readonly nextBundle: SignedConfigBundle;
  }): Promise<{ readonly committed: boolean; readonly current: BundleStateRecord | null }>;
}
