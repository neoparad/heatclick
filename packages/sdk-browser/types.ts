/**
 * UGOKI LINK v2 — Browser Measurement SDK Types (`packages/sdk-browser/types.ts`)
 *
 * Spec refs: §4.1–§4.10, §11.11 (1–3), §12.1 #4, §12.2, TEL M1–M10, A1–A5.
 */

import type {
  ActivationKind,
  BlockRegisterPayload,
  CanonicalConversionRuleSpec,
  CollectionLane,
  ConsentMode,
  ConsentPurpose,
  DomState,
  FieldRegisterPayload,
  FormRegisterPayload,
  MediaRegisterPayload,
  NavType,
  SectionRegisterPayload,
  TelemetryFrame,
  TelemetryLogItem,
} from '../contract/schema';
import type { UrlKeyV2Result, UrlKeyV2Rules } from '../contract/urlkey';

export interface BrowserSectionRegisterPayload extends SectionRegisterPayload {
  readonly gap_ms: readonly [number, number, number, number];
  readonly vel_ms: readonly [number, number, number, number];
}

export interface BrowserBlockRegisterPayload extends BlockRegisterPayload {
  readonly always_watch: boolean;
  readonly sample_pi: number;
}

export interface BrowserFieldRegisterPayload extends FieldRegisterPayload {
  readonly form_fp: string;
  readonly is_sensitive: boolean;
  readonly order_idx: number;
  readonly focus_n: number;
  readonly first_input_latency_ms: number | null;
  readonly refocus_n: number;
  readonly edit_bursts: number;
  readonly correction_bursts: number;
  readonly composition_inputs: number;
  readonly total_inputs: number;
  readonly validation_observable: boolean;
  readonly filled_ever: boolean;
}

export interface BrowserFormRegisterPayload extends FormRegisterPayload {
  readonly started: boolean;
  readonly t_first_ms: number;
  readonly blocked_submits: number;
  readonly last_field_fp: string | null;
}

export interface BrowserMediaRegisterPayload extends MediaRegisterPayload {
  readonly plays: number;
  readonly completed: boolean;
}

export interface BrowserTelemetryLogItem extends TelemetryLogItem {
  readonly x_permille?: number;
  readonly y_permille?: number;
  readonly click_count?: number;
  readonly min_interval_ms?: number;
  readonly spread_px?: number;
  readonly rage_click?: boolean;
  readonly dead_click?: boolean;
  readonly effect_bits?: number;
  readonly time_to_first_effect_bin?: 0 | 1 | 2 | 3;
  readonly section_tokens?: readonly string[];
}

export type BrowserPageStatePayload = TelemetryFrame['state'] & {
  readonly error_hashes?: readonly string[];
  readonly section_tokens?: readonly string[];
};

export interface BrowserTelemetryFrame extends TelemetryFrame {
  readonly state: BrowserPageStatePayload;
  readonly sections: readonly BrowserSectionRegisterPayload[];
  readonly blocks?: readonly BrowserBlockRegisterPayload[];
  readonly fields?: readonly BrowserFieldRegisterPayload[];
  readonly forms?: readonly BrowserFormRegisterPayload[];
  readonly media?: readonly BrowserMediaRegisterPayload[];
  readonly log_items: readonly BrowserTelemetryLogItem[];
}

export type MeasurementLane = CollectionLane;
export type MeasurementLaneInput = CollectionLane | 'custom_event';

export type RegionClass = 'JP' | 'GB' | 'FR' | 'EU_EEA' | 'US_OPTOUT' | 'UNKNOWN';
export type RegionClassInput = RegionClass | 'UK';

export type DisclosureStatus = 'verified' | 'declared' | 'missing';

export type OptOutDurability = 'origin_durable' | 'capped_7d' | 'none';

export type DegradeLevel = 0 | 1 | 2 | 3;

export const LAB_MARKER_PURPOSES = [
  'render',
  'install_probe',
  'canary_visit',
  'preflight',
  'agent_run',
  'panel',
] as const;
export type LabMarkerPurpose = (typeof LAB_MARKER_PURPOSES)[number];

export interface LabMarkerToken {
  readonly lab_run_id: string;
  readonly purpose: LabMarkerPurpose;
  readonly site_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly signature_b64: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CookieJarLike {
  getCookie(name: string): string | null;
  setCookie(name: string, value: string, maxAgeSec: number): void;
  deleteCookie(name: string): void;
}

export interface JurisdictionRowPolicy {
  readonly region: RegionClassInput;
  readonly defaultMode: ConsentMode;
  readonly legalSignedOff: boolean;
  readonly signedOffMode?: ConsentMode;
  readonly privacySignalAction: 'off' | 'cap_cookieless' | 'cap_session' | 'optout_sale_only';
}

export interface ConsentResolutionInput {
  /** Signed site default from Release/Config bundle. */
  readonly siteDefaultMode: ConsentMode;
  /** Region class echoed by customer's origin (or null if tag-only). Accepts `'UK'` -> `'GB'`. */
  readonly originRegionClass?: RegionClassInput | null;
  /** Region class returned by online loader data (can ONLY tighten, never raise). Accepts `'UK'` -> `'GB'`. */
  readonly loaderRegionClass?: RegionClassInput | null;
  /** Explicit consent override via `ugk.consent()` or CMP adapter (`'unknown'` -> `off`). */
  readonly explicitConsentMode?: ConsentMode | 'unknown' | null;
  /** Explicit consent purposes granted by CMP/site API. */
  readonly explicitPurposes?: readonly ConsentPurpose[];
  /** Browser Global Privacy Control / DNT signal. */
  readonly privacySignal?: boolean;
  /** Minors-directed site flag caps mode at `cookieless` (§4.5). */
  readonly minorsSite?: boolean;
  /** Disclosure verification status at declared policy URL (§4.5 / tel.G12). */
  readonly disclosureStatus: DisclosureStatus;
  /** Whether site is subject to JP external transmission regulation (default true when JP). */
  readonly jpExternalTransmissionSubject?: boolean;
  /** Whether owner/site opt-out is currently active. */
  readonly optedOut?: boolean;
  /** Durability of opt-out marker (script-only Safari 7d caps consent 1 tier lower). */
  readonly optOutDurability?: OptOutDurability;
  /** Legal sign-off status per jurisdiction row (TEL A4). Accepts `'UK'` or `'GB'`. */
  readonly jurisdictionPolicies?: Readonly<Partial<Record<RegionClassInput, JurisdictionRowPolicy>>>;
}

export interface ConsentResolutionResult {
  readonly resolved: boolean;
  readonly mode: ConsentMode;
  readonly purposes: readonly ConsentPurpose[];
  readonly effectiveRegion: RegionClass;
  readonly storageAllowed: boolean;
  readonly sessionStorageAllowed: boolean;
  readonly persistentStorageAllowed: boolean;
  readonly telemetryAllowed: boolean;
  readonly cappedReason: string | null;
}

export type ConversionPredicateKind =
  | 'id'
  | 'class'
  | 'selector'
  | 'text'
  | 'href'
  | 'href_prefix'
  | 'el_fp'
  | 'el_fp_set';

export interface PredicateConversionRuleSpec {
  readonly cv_key: string;
  readonly rule_ver?: number;
  readonly predicate_kind: ConversionPredicateKind;
  readonly predicate_value: string | readonly string[];
}

export interface MatchAliasConversionRuleSpec {
  readonly cv_key: string;
  readonly rule_ver?: number;
  readonly match_kind: ConversionPredicateKind;
  readonly match_value: string | readonly string[];
}

export type ConversionRuleSpec =
  | CanonicalConversionRuleSpec
  | PredicateConversionRuleSpec
  | MatchAliasConversionRuleSpec;

export interface SectionGeometryInput {
  readonly sec_fp: string;
  readonly topPx: number;
  readonly bottomPx: number;
}

export interface BlockGeometryInput {
  readonly blk_fp: string;
  readonly alwaysWatch: boolean;
  readonly inViewport: boolean;
}

export interface ClickEventInput {
  readonly tMono: number;
  readonly el_fp: string;
  readonly sec_fp?: string;
  readonly activation_kind: ActivationKind;
  readonly href?: string;
  readonly elementId?: string;
  readonly elementClasses?: readonly string[];
  readonly elementSelector?: string;
  /** Text used ONLY inside browser for conversion rule matching — NEVER transmitted! */
  readonly elementTextForRuleMatchOnly?: string;
  /** Element-relative position in permille [0, 1000]. Suppressed inside forms/choice/keypad. */
  readonly xPermille?: number;
  readonly yPermille?: number;
  readonly yDocPx?: number;
  /** If true, click occurred inside form / choice group / keypad -> group id only, no coords. */
  readonly insideFormOrChoiceOrKeypad?: boolean;
  readonly groupFp?: string;
  /** Optional click effect telemetry (for server-side no-effect / rage thresholding). */
  readonly effectBits?: number;
  readonly timeToFirstEffectMs?: number;
  /** Optional client-provided 16-bit order reference hash for conversion deduplication. */
  readonly orderRefHash?: string;
  /** Registered affiliate query param names allowed in dest_key_click. */
  readonly allowedDestRoleParams?: readonly string[];
}

export interface FormFocusInput {
  readonly tMono: number;
  readonly form_fp: string;
  readonly el_fp: string;
  readonly isSensitive: boolean; // password / payment field
}

export interface FormInteractionInput {
  readonly tMono: number;
  readonly form_fp: string;
  readonly el_fp: string;
  readonly isSensitive: boolean;
  readonly isComposition: boolean;
  readonly isDeletion: boolean;
  readonly becameFilled?: boolean;
}

export interface FormErrorInput {
  readonly tMono: number;
  readonly form_fp: string;
  readonly el_fp: string;
  readonly source: 'native_invalid' | 'aria_invalid' | 'error_node';
}

export interface ReplayEntitlementConfig {
  /**
   * Explicit proof that Owner Decision D-08 + legal sign-off have been recorded.
   * When omitted or false, SDK falls back to `requireDecisionEntitled('D-08')` in the
   * canonical ledger (currently `pending` -> Tier 1/2 timelines NEVER leave the browser!).
   */
  readonly ownerDecisionD08Approved?: boolean;
  readonly legalSignOffRecorded?: boolean;
  /** Sensitive industry sites NEVER emit Tier 1/2 timelines (§4.6 / TEL M6). */
  readonly sensitiveIndustrySite?: boolean;
  /** Server `need.timeline` directive requesting Tier 1/2 flush when entitled. */
  readonly serverRequestedTimeline?: boolean;
  /** Whether the run is a verified hosted agent or own lab run (unthinned trace allowed). */
  readonly isVerifiedAgentOrLabTrace?: boolean;
}

export interface CollectorAckPayload {
  readonly seq: number;
  readonly i_hw: number;
  readonly srv_t: number;
  readonly pv_token?: string | null;
  readonly need?: readonly string[];
  readonly rej?: readonly string[];
  readonly kill?: number;
  readonly h?: number;
  readonly billing_mode?: 'normal' | 'over_quota_count_only';
  readonly accepted_saved?: boolean;
  readonly held?: boolean;
}

export interface TransportHooks {
  /** Visible transport: standard `fetch` without `keepalive` (ACK readable). */
  readonly sendFetch: (
    endpoint: string,
    payload: Uint8Array,
    frame: TelemetryFrame
  ) => Promise<CollectorAckPayload | null>;
  /** Hidden / critical transport: `navigator.sendBeacon` (returns boolean). */
  readonly sendBeacon: (
    endpoint: string,
    payload: Uint8Array,
    frame: TelemetryFrame
  ) => boolean;
  /** Chromium `fetchLater` deferred-fetch hook (optional feature-detected). */
  readonly armFetchLater?: (
    endpoint: string,
    payload: Uint8Array,
    frame: TelemetryFrame,
    activateAfterMs: number,
    signal?: AbortSignal
  ) => { readonly activated: boolean; abort: () => void };
}

export interface PageFingerprintSnapshot {
  readonly skelFp: string;
  readonly cssFp?: string | null;
  readonly headFp?: string | null;
  readonly domState?: DomState;
}

export interface SoftNavigationOptions {
  readonly html?: string;
  readonly skelFp?: string;
  readonly cssFp?: string | null;
  readonly headFp?: string | null;
  readonly domState?: DomState;
  readonly navType?: NavType;
}

export interface BrowserSdkConfig {
  readonly siteKey: string;
  readonly collectorEndpoint: string;
  readonly sdkBuild: string;
  readonly defVer: number;
  readonly profileRev: number;
  readonly armBits: number;
  readonly dimTupleCode: number;
  readonly initialUrl: string;
  readonly urlRules?: UrlKeyV2Rules;
  readonly navType?: NavType;
  readonly startedHidden?: boolean;
  readonly domState?: DomState;
  readonly skelFp: string;
  readonly cssFp?: string | null;
  readonly headFp?: string | null;
  readonly variantKey?: string;
  readonly viewportHeightPx?: number;
  readonly fixedTopPx?: number;
  readonly fixedBottomPx?: number;
  readonly docHeightPx?: number;
  readonly blockSampleRate?: number; // default 0.5 for non-always-watched blocks
  readonly conversionRules?: readonly ConversionRuleSpec[];
  readonly labMarker?: LabMarkerToken | null;
  readonly labSinkPath?: string;
  readonly handoffToken?: string | null;
  readonly replay?: ReplayEntitlementConfig;
  readonly consent: ConsentResolutionInput;
  readonly cookieJar?: CookieJarLike;
  readonly sessionStorage?: StorageLike;
  readonly localStorage?: StorageLike;
  readonly transport: TransportHooks;
  readonly getDocumentHtml?: () => string | null;
  readonly computePageFingerprints?: (
    url: string,
    urlInfo: UrlKeyV2Result
  ) => PageFingerprintSnapshot;
  readonly nowMonoMs?: () => number;
  readonly nowWallMs?: () => number;
  readonly randomBytes?: (len: number) => Uint8Array;
}

export interface ReadOnlySdkStateSnapshot {
  readonly pv_id: string;
  readonly consent_mode: ConsentMode;
  readonly purposes: readonly ConsentPurpose[];
  readonly url_id: string;
  readonly page_url_key: string;
  readonly skel_fp: string;
  readonly scroll_max_px: number;
  readonly vis_ms: number;
  readonly degrade_level: DegradeLevel;
  readonly section_dwell_ms: Readonly<Record<string, number>>;
  readonly lab_mode_active: boolean;
}
