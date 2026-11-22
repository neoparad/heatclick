/**
 * UGOKI LINK v2 — Browser Measurement SDK Core Engine (`packages/sdk-browser/sdk.ts`)
 *
 * Implements §4.1–§4.10, §11.8, §12.1 #4, TEL M1–M10:
 * - Memory-only 128-bit random `pv_id` (NEVER stored in Cookie/Storage)
 * - Convergent cumulative registers + `seq` + state checksum `chk`
 * - Delta frames during normal flushes; `hidden` & `deferred` ALWAYS `full: true`
 * - Standalone ~17B placement fields in EVERY frame (`url_id`, `key_ver`, `profile_rev`,
 *   `dim_tuple_code`, `live_word`, `key_degraded`)
 * - Flush triggers: `first`, `change` (2s debounce, 10s max wait, x1.5 backoff to 30s),
 *   closed-loop adaptive `heartbeat` (`clamp(0.02 * E / L_upper, 2, 30)` s),
 *   `hidden` (`visibilitychange` & `pagehide` — ZERO `unload`/`beforeunload` listeners!),
 *   `resume`, `idle` (60s), `online`, `critical` (pointerdown prepare + immediate send + retry),
 *   `deferred` (`fetchLater` armed on Chromium with 30 min `activateAfter`)
 * - 16 KiB hidden/critical/deferred budget, 48 KiB visible budget, 512B minimal beacon fallback + WAL
 * - 5-mode consent resolution BEFORE any storage touch (`GuardedStorageAdapter`) + immediate
 *   cookie/storage/WAL/fetchLater purge on consent downgrade or `optOut()` ([H-11])
 * - `private_scope` zero-linkable-key enforcement (`vid`/`sid`/`mid_hash`/tokens stripped, [H-11])
 * - SPA soft-navigation (`pushState` / `popstate` / route change) `skelFp` recomputation &
 *   per-PV register reset ([L-01])
 * - Lab marker integration: `render` blocks telemetry completely; outbound links routed to lab sink
 * - `ugk.state()` read-only snapshot for Delivery Runtime; `ugk.optOut()`; `ugk.identify(hex)`
 */

import {
  CANONICAL_SCHEMA,
  CODEC_VERSION,
  computeFrameChecksum,
  createSdkFrameCodec,
  sha256Hex,
  type ConsentMode,
  type ConsentPurpose,
  type DomState,
  type FrameClass,
  type FrameTransport,
  type NavType,
  type TelemetryFrame,
} from '../contract/schema';
import { segmentHtml } from '../contract/segmenter';
import { computeUrlKeyV2, type UrlKeyV2Result } from '../contract/urlkey';
import { BehaviourCaptureEngine } from './behaviour';
import { CONSENT_MODE_RANK, GuardedStorageAdapter, resolveBrowserConsent } from './consent';
import { isActiveLabMarker, shouldBlockTelemetryForLabPurpose } from './lab-sink';
import type {
  BlockGeometryInput,
  BrowserSdkConfig,
  ClickEventInput,
  CollectorAckPayload,
  ConsentResolutionResult,
  FormErrorInput,
  FormFocusInput,
  FormInteractionInput,
  PageFingerprintSnapshot,
  ReadOnlySdkStateSnapshot,
  SectionGeometryInput,
  SoftNavigationOptions,
} from './types';

const HIDDEN_MAX_BYTES = 16 * 1024;
const MINIMAL_BEACON_MAX_BYTES = 512;
const FETCH_LATER_ACTIVATE_AFTER_MS = 30 * 60 * 1000; // 30 min (TEL M2)
const MAX_IN_MEMORY_WAL_FRAMES = 8;
const WAL_TAB_KEY = 'ugk_wal_tab_v1';
const WAL_VISIT_KEY = 'ugk_wal_visit_v1';
const HEX_IDENTIFY_RE = /^[0-9a-f]{32,128}$/i;

/**
 * Closed-loop adaptive heartbeat interval (TEL M2 / §4.2):
 * `h = clamp(0.02 * meanEngagedSec / terminalLossUpper, 2, 30)` seconds.
 */
export function computeAdaptiveHeartbeatSec(
  meanEngagedSec: number,
  terminalLossUpper: number,
  hasFetchLater: boolean
): number {
  if (
    !Number.isFinite(meanEngagedSec) ||
    meanEngagedSec <= 0 ||
    !Number.isFinite(terminalLossUpper) ||
    terminalLossUpper <= 0
  ) {
    return hasFetchLater ? 15 : 10;
  }
  const raw = (0.02 * meanEngagedSec) / terminalLossUpper;
  return Math.max(2, Math.min(30, Math.round(raw * 10) / 10));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function generate128BitHex(randomBytes?: (len: number) => Uint8Array): string {
  if (randomBytes) {
    return bytesToHex(randomBytes(16));
  }
  const buf = new Uint8Array(16);
  globalThis.crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

function readAmbientDocumentHtml(getter?: () => string | null): string | null {
  if (getter) {
    try {
      const html = getter();
      if (typeof html === 'string' && html.trim().length > 0) return html;
    } catch {
      // ignore getter failures
    }
  }
  try {
    const doc = (globalThis as { readonly document?: { readonly documentElement?: { readonly outerHTML?: string } } })
      .document;
    const outer = doc?.documentElement?.outerHTML;
    if (typeof outer === 'string' && outer.trim().length > 0) {
      return outer;
    }
  } catch {
    // non-DOM runtime
  }
  return null;
}

export class UgokiBrowserSdk {
  public readonly registeredLifecycleListeners: readonly string[] = [
    'visibilitychange',
    'pagehide',
    'pageshow',
    'online',
    'popstate',
    'hashchange',
  ];

  private readonly config: BrowserSdkConfig;
  private readonly codec = createSdkFrameCodec(CANONICAL_SCHEMA);
  private readonly storage: GuardedStorageAdapter;
  private readonly nowMono: () => number;
  private readonly nowWall: () => number;
  private readonly pageOrigin: string;

  private pvId: string;
  private contOf: string | null = null;
  private seq = 0;
  private visEpisode = 1;
  private lastAckedSeq = 0;
  private lastAckedLogHw = -1;
  private pvToken: string | null = null;
  private memberHash: string | null = null;
  private visitorId: string | null = null;
  private sessionId: string | null = null;
  private heartbeatSec: number;
  private changeFlushCount = 0;
  private killBits = 0;
  private billingMode: 'normal' | 'over_quota_count_only' = 'normal';
  private started = false;
  private isVisible = true;
  private urlInfo: UrlKeyV2Result;
  private currentSkelFp: string;
  private currentCssFp: string | null;
  private currentHeadFp: string | null;
  private currentDomState: DomState;
  private currentNavType: NavType;
  private consentResult: ConsentResolutionResult | null = null;
  private behaviour: BehaviourCaptureEngine;
  private activeFetchLaterHandle: { readonly activated: boolean; abort: () => void } | null = null;
  private fetchLaterAbortController: AbortController | null = null;
  private readonly inMemoryWalQueue: TelemetryFrame[] = [];

  public sentFrameCount = 0;
  public lastSentFrame: TelemetryFrame | null = null;
  public lastEncodedBytes: Uint8Array | null = null;
  public readonly ackHistory: CollectorAckPayload[] = [];

  constructor(config: BrowserSdkConfig) {
    this.config = config;
    this.nowMono = config.nowMonoMs ?? (() => Date.now());
    this.nowWall = config.nowWallMs ?? (() => Date.now());
    this.pageOrigin = new URL(config.initialUrl).origin;
    this.storage = new GuardedStorageAdapter({
      cookieJar: config.cookieJar,
      sessionStorage: config.sessionStorage,
      localStorage: config.localStorage,
    });

    // Memory-only 128-bit pv_id (NEVER written to storage/cookies)
    this.pvId = generate128BitHex(config.randomBytes);
    this.isVisible = !(config.startedHidden ?? false);
    this.heartbeatSec = config.transport.armFetchLater ? 15 : 10;
    this.urlInfo = computeUrlKeyV2(config.initialUrl, config.urlRules);
    this.currentSkelFp = config.skelFp;
    this.currentCssFp = config.cssFp ?? null;
    this.currentHeadFp = config.headFp ?? null;
    this.currentDomState = config.domState ?? 'ok';
    this.currentNavType = config.navType ?? 'navigate';
    this.behaviour = this.createBehaviourEngine();
  }

  private createBehaviourEngine(): BehaviourCaptureEngine {
    return new BehaviourCaptureEngine({
      pvId: this.pvId,
      pageOrigin: this.pageOrigin,
      viewportHeightPx: this.config.viewportHeightPx ?? 800,
      fixedTopPx: this.config.fixedTopPx ?? 0,
      fixedBottomPx: this.config.fixedBottomPx ?? 0,
      initialDocHeightPx: this.config.docHeightPx ?? 2400,
      blockSampleRate: this.config.blockSampleRate ?? 0.5,
      conversionRules: this.config.conversionRules ?? [],
      replay: this.config.replay ?? {},
      labMarker: this.config.labMarker ?? null,
      labSinkPath: this.config.labSinkPath,
    });
  }

  public getPvId(): string {
    return this.pvId;
  }

  public getConsentResolution(): ConsentResolutionResult | null {
    return this.consentResult;
  }

  public getStorageFirewall(): GuardedStorageAdapter {
    return this.storage;
  }

  public getBehaviourEngine(): BehaviourCaptureEngine {
    return this.behaviour;
  }

  public getInMemoryWalQueue(): readonly TelemetryFrame[] {
    return [...this.inMemoryWalQueue];
  }

  public getHeartbeatSec(): number {
    return this.heartbeatSec;
  }

  public getBillingMode(): 'normal' | 'over_quota_count_only' {
    return this.billingMode;
  }

  /**
   * Computes current change-debounce backoff window (§4.2 / TEL M2):
   * 2s trailing debounce, 10s max wait; after 5th change flush scales x1.5 up to 30s.
   */
  public getChangeFlushScheduleMs(): { readonly debounceMs: number; readonly maxWaitMs: number } {
    if (this.changeFlushCount < 5) {
      return { debounceMs: 2_000, maxWaitMs: 10_000 };
    }
    const mult = Math.pow(1.5, this.changeFlushCount - 4);
    return {
      debounceMs: Math.min(30_000, Math.round(2_000 * mult)),
      maxWaitMs: Math.min(30_000, Math.round(10_000 * mult)),
    };
  }

  /**
   * Resolves consent FIRST before touching any storage, recovers WAL if permitted,
   * and emits the initial `first` frame.
   */
  public async init(): Promise<ConsentResolutionResult> {
    if (this.started) {
      return this.consentResult!;
    }
    this.started = true;

    // Step 1: Resolve consent BEFORE touching cookies or web storage (tel.G10 / TEL A5 #1)
    const resolved = resolveBrowserConsent(this.config.consent);
    this.applyResolvedConsent(resolved);

    if (!resolved.telemetryAllowed) {
      return resolved;
    }

    // Step 2: Recover any pending write-ahead tail from previous PV (only if >= session & not private_scope)
    if (this.currentDomState !== 'private_scope') {
      await this.flushRecoveredWal();
    }

    // Step 3: Emit `first` frame
    await this.flush('first');

    // Step 4: Arm Chromium `fetchLater` if not already armed by first-frame ACK
    if (!this.activeFetchLaterHandle) {
      this.armDeferredFetchIfSupported();
    }

    return resolved;
  }

  private cancelArmedFetchLater(): void {
    if (this.fetchLaterAbortController) {
      this.fetchLaterAbortController.abort();
      this.fetchLaterAbortController = null;
    }
    if (this.activeFetchLaterHandle) {
      this.activeFetchLaterHandle.abort();
      this.activeFetchLaterHandle = null;
    }
  }

  private applyResolvedConsent(resolved: ConsentResolutionResult): void {
    this.consentResult = resolved;
    this.storage.setResolvedConsent(resolved);

    // On private_scope pages OR when storage is disallowed, keep zero linkable identifiers ([H-11])
    if (!resolved.storageAllowed || this.currentDomState === 'private_scope') {
      this.visitorId = null;
      this.sessionId = null;
      this.memberHash = null;
      return;
    }

    // Session cookie (30 min rolling) when mode >= session
    if (resolved.sessionStorageAllowed) {
      const existingSid = this.storage.getCookie('ugk_sid');
      if (existingSid) {
        this.sessionId = existingSid;
      } else {
        this.sessionId = generate128BitHex(this.config.randomBytes);
        this.storage.setCookie('ugk_sid', this.sessionId, 1800);
      }
    } else {
      this.sessionId = null;
    }

    // Persistent visitor cookie (<=13m) when mode === stats_exempt or full
    if (resolved.mode === 'stats_exempt' || resolved.mode === 'full') {
      const existingVid = this.storage.getCookie('ugk_vid');
      if (existingVid) {
        this.visitorId = existingVid;
      } else {
        this.visitorId = generate128BitHex(this.config.randomBytes);
        this.storage.setCookie('ugk_vid', this.visitorId, 34_128_000);
      }
    } else {
      this.visitorId = null;
    }

    if (!resolved.purposes.includes('member_link')) {
      this.memberHash = null;
    }
  }

  /**
   * Public `ugk.consent(mode, purposes)` API: updates consent dynamically ([H-11]).
   * On any consent downgrade (e.g. `full` -> `cookieless` or `off`), immediately deletes
   * disallowed first-party cookies, clears `localStorage` & `sessionStorage` keys, wipes
   * the in-memory WAL queue, and aborts any armed `fetchLater` (`AbortController.abort()`).
   */
  public consent(
    mode: ConsentMode | 'unknown',
    purposes?: readonly ConsentPurpose[]
  ): ConsentResolutionResult {
    const prevConsent = this.consentResult;
    const resolved = resolveBrowserConsent({
      ...this.config.consent,
      explicitConsentMode: mode,
      explicitPurposes: purposes ?? this.config.consent.explicitPurposes,
    });

    const isDowngrade =
      prevConsent !== null &&
      (CONSENT_MODE_RANK[resolved.mode] < CONSENT_MODE_RANK[prevConsent.mode] ||
        (prevConsent.purposes.includes('member_link') && !resolved.purposes.includes('member_link')));

    if (isDowngrade) {
      this.cancelArmedFetchLater();
      this.storage.purgeDisallowedStorage(resolved, {
        sessionWalKeys: [WAL_TAB_KEY],
        persistentWalKeys: [WAL_VISIT_KEY],
        forcePurgeAll: !resolved.storageAllowed,
      });
      this.inMemoryWalQueue.length = 0;
      if (!resolved.storageAllowed) {
        this.pvToken = null;
      }
    }

    this.applyResolvedConsent(resolved);

    if (!resolved.telemetryAllowed) {
      this.cancelArmedFetchLater();
      this.inMemoryWalQueue.length = 0;
    } else if (isDowngrade && this.started) {
      // Re-arm a clean deferred frame without pre-downgrade identifiers
      this.armDeferredFetchIfSupported();
    }

    return resolved;
  }

  /**
   * Public `ugk.optOut()` API (§4.5 / tel.G10 / [H-11]): immediately transitions to `off`,
   * aborts armed `fetchLater` via `AbortController.abort()`, deletes `ugk_vid` & `ugk_sid` cookies,
   * clears `localStorage` & `sessionStorage` WAL keys, and wipes the in-memory WAL queue.
   */
  public optOut(): ConsentResolutionResult {
    this.cancelArmedFetchLater();
    const resolved = resolveBrowserConsent({
      ...this.config.consent,
      optedOut: true,
    });
    this.storage.purgeDisallowedStorage(resolved, {
      sessionWalKeys: [WAL_TAB_KEY],
      persistentWalKeys: [WAL_VISIT_KEY],
      forcePurgeAll: true,
    });
    this.inMemoryWalQueue.length = 0;
    this.pvToken = null;
    this.contOf = null;
    this.applyResolvedConsent(resolved);
    return resolved;
  }

  /**
   * Public `ugk.identify(hex)` (§4.5 / TEL M5): accepts ONLY pre-hashed fixed-length hex
   * computed on the customer's server and requires consent purpose `member_link` (never on `private_scope`).
   */
  public identify(serverComputedHex: string): boolean {
    if (this.currentDomState === 'private_scope') {
      return false;
    }
    if (!this.consentResult || !this.consentResult.purposes.includes('member_link')) {
      return false;
    }
    if (!HEX_IDENTIFY_RE.test(serverComputedHex)) {
      return false;
    }
    this.memberHash = serverComputedHex.toLowerCase();
    return true;
  }

  /**
   * Public `ugk.convert(cvKey, ruleVer, orderRefHash?)` (§4.10 / TEL M10).
   */
  public async convert(
    cvKey: string,
    ruleVer = 1,
    orderRefHash?: string
  ): Promise<boolean> {
    if (!this.canSendTelemetry()) return false;
    const added = this.behaviour.recordExplicitConversion(
      cvKey,
      ruleVer,
      this.nowMono(),
      orderRefHash
    );
    if (added) {
      await this.flush('critical');
    }
    return added;
  }

  /**
   * Public read-only `ugk.state()` snapshot shared with Delivery Runtime (TEL A9 #9).
   */
  public state(): ReadOnlySdkStateSnapshot {
    return Object.freeze({
      pv_id: this.pvId,
      consent_mode: this.consentResult?.mode ?? 'off',
      purposes: [...(this.consentResult?.purposes ?? [])],
      url_id: this.urlInfo.url_id,
      page_url_key: this.urlInfo.url_key_v2,
      skel_fp: this.currentSkelFp,
      scroll_max_px: this.behaviour.scrollMaxPx,
      vis_ms: this.behaviour.visMs,
      degrade_level: this.behaviour.degradeLevel,
      section_dwell_ms: this.behaviour.getSectionSnapshot(),
      lab_mode_active: isActiveLabMarker(this.config.labMarker, this.nowWall()),
    });
  }

  // =========================================================================
  // Event Hooks (No `unload` / `beforeunload` listeners!)
  // =========================================================================

  public advance(params: {
    readonly scrollY: number;
    readonly docHeightPx?: number;
    readonly viewportHeightPx?: number;
    readonly sections: readonly SectionGeometryInput[];
    readonly blocks?: readonly BlockGeometryInput[];
    readonly isInputTick?: boolean;
  }): void {
    this.behaviour.advance({
      ...params,
      tMono: this.nowMono(),
      visible: this.isVisible,
      currentSeq: this.seq + 1,
    });
  }

  public recordFormFocus(input: FormFocusInput): void {
    this.behaviour.recordFormFocus(input);
  }

  public recordFormInteraction(input: FormInteractionInput): void {
    this.behaviour.recordFormInteraction(input);
  }

  public recordFormBlur(elFp: string, tMono?: number): void {
    this.behaviour.recordFormBlur(elFp, tMono ?? this.nowMono());
  }

  public recordFormError(input: FormErrorInput): void {
    this.behaviour.recordFormError(input);
  }

  public async recordFormSubmit(formFp: string, blocked = false): Promise<void> {
    this.behaviour.recordFormSubmit(formFp, this.nowMono(), blocked);
    if (!blocked && this.canSendTelemetry()) {
      await this.flush('critical');
    }
  }

  public async recordClick(input: ClickEventInput): Promise<{
    readonly effectiveHref: string | undefined;
    readonly matchedConversions: readonly string[];
  }> {
    const res = this.behaviour.recordClick(input, this.nowWall());
    if (res.isCritical && this.canSendTelemetry()) {
      await this.flush('critical');
    }
    return {
      effectiveHref: res.effectiveHref,
      matchedConversions: res.matchedConversions,
    };
  }

  public recordCopy(blkFp: string): void {
    this.behaviour.recordCopy(blkFp);
  }

  public recordMediaProgress(
    blkFp: string,
    playedMs: number,
    completed = false,
    incrementPlays = false
  ): void {
    this.behaviour.recordMediaProgress(blkFp, playedMs, completed, incrementPlays);
  }

  public recordJsError(errorName: string, lineNo: number, colNo: number): void {
    this.behaviour.recordJsError(errorName, lineNo, colNo);
  }

  public recordVital(
    kind: 'lcp_ms' | 'inp_ms' | 'cls_x1000' | 'ttfb_ms',
    value: number
  ): void {
    this.behaviour.recordVital(kind, value, this.seq + 1);
  }

  private recomputeSoftNavFingerprints(
    nextUrl: string,
    nextInfo: UrlKeyV2Result,
    options?: SoftNavigationOptions
  ): PageFingerprintSnapshot {
    if (options?.skelFp) {
      return {
        skelFp: options.skelFp,
        cssFp: options.cssFp ?? this.currentCssFp,
        headFp: options.headFp ?? this.currentHeadFp,
        domState: options.domState ?? this.config.domState ?? 'ok',
      };
    }

    if (this.config.computePageFingerprints) {
      const computed = this.config.computePageFingerprints(nextUrl, nextInfo);
      return {
        skelFp: computed.skelFp,
        cssFp: computed.cssFp ?? options?.cssFp ?? null,
        headFp: computed.headFp ?? options?.headFp ?? null,
        domState: options?.domState ?? computed.domState ?? this.config.domState ?? 'ok',
      };
    }

    const derivedSkelFp = sha256Hex(
      `ugk-spa-skel/1|${this.config.siteKey}|${nextInfo.url_key_v2}`
    ).slice(0, 16);

    const htmlCandidate = options?.html ?? readAmbientDocumentHtml(this.config.getDocumentHtml);
    if (htmlCandidate) {
      const seg = segmentHtml(htmlCandidate);
      return {
        skelFp: seg.skel_fp ?? derivedSkelFp,
        cssFp: options?.cssFp ?? seg.css_fp,
        headFp: options?.headFp ?? seg.head_fp,
        domState: options?.domState ?? seg.dom_state,
      };
    }

    // Headless fallback: deterministically derive a fresh 64-bit hex skel_fp for the new route
    return {
      skelFp: derivedSkelFp,
      cssFp: options?.cssFp ?? this.currentCssFp,
      headFp: options?.headFp ?? this.currentHeadFp,
      domState: options?.domState ?? this.config.domState ?? 'ok',
    };
  }

  /**
   * Soft navigation handler (TEL M2 / §4.2 / [L-01]):
   * - Hash-only changes emit `anchor_jump` on the CURRENT PV.
   * - Page-key (`url_key_v2`) changes (`pushState` / `popstate` / route change) flush the
   *   old PV (`hidden`), recompute `skelFp`, and reset all per-PV section/behaviour registers!
   */
  public async handleSoftNavigation(
    nextUrl: string,
    options?: SoftNavigationOptions
  ): Promise<'anchor_jump' | 'new_pv'> {
    const nextInfo = computeUrlKeyV2(nextUrl, this.config.urlRules);
    if (nextInfo.url_key_v2 === this.urlInfo.url_key_v2) {
      this.behaviour.recordAnchorJump(this.nowMono());
      return 'anchor_jump';
    }

    // Flush departing PV before opening new PV
    if (this.canSendTelemetry()) {
      await this.flush('hidden');
    }

    const nextFp = this.recomputeSoftNavFingerprints(nextUrl, nextInfo, options);

    this.pvId = generate128BitHex(this.config.randomBytes);
    this.contOf = null;
    this.seq = 0;
    this.visEpisode = 1;
    this.lastAckedSeq = 0;
    this.lastAckedLogHw = -1;
    this.pvToken = null;
    this.changeFlushCount = 0;
    this.urlInfo = nextInfo;
    this.currentSkelFp = nextFp.skelFp;
    this.currentCssFp = nextFp.cssFp ?? null;
    this.currentHeadFp = nextFp.headFp ?? null;
    this.currentDomState = nextFp.domState ?? 'ok';
    this.currentNavType = options?.navType ?? 'soft';
    this.behaviour = this.createBehaviourEngine();

    if (this.currentDomState === 'private_scope') {
      this.visitorId = null;
      this.sessionId = null;
      this.memberHash = null;
    } else if (this.consentResult) {
      this.applyResolvedConsent(this.consentResult);
    }

    if (this.canSendTelemetry()) {
      await this.flush('first');
      this.armDeferredFetchIfSupported();
    }
    return 'new_pv';
  }

  public async handlePushState(
    nextUrl: string,
    options?: SoftNavigationOptions
  ): Promise<'anchor_jump' | 'new_pv'> {
    return this.handleSoftNavigation(nextUrl, { ...options, navType: options?.navType ?? 'soft' });
  }

  public async handlePopState(
    nextUrl: string,
    options?: SoftNavigationOptions
  ): Promise<'anchor_jump' | 'new_pv'> {
    return this.handleSoftNavigation(nextUrl, {
      ...options,
      navType: options?.navType ?? 'back_forward',
    });
  }

  /**
   * Opens a continuation PV after >=30 min idle without an acknowledged frame (TEL M2).
   */
  public async openContinuation(): Promise<void> {
    const prevPvId = this.pvId;
    this.pvId = generate128BitHex(this.config.randomBytes);
    this.contOf = this.currentDomState === 'private_scope' ? null : prevPvId;
    this.seq = 0;
    this.lastAckedSeq = 0;
    this.lastAckedLogHw = -1;
    this.pvToken = null;
    this.behaviour = this.createBehaviourEngine();
    if (this.canSendTelemetry()) {
      await this.flush('resume');
    }
  }

  public async handleVisibilityHidden(): Promise<boolean> {
    this.isVisible = false;
    return this.flush('hidden');
  }

  public async handlePageHide(): Promise<boolean> {
    this.isVisible = false;
    return this.flush('hidden');
  }

  public async handleVisibilityResume(): Promise<boolean> {
    this.isVisible = true;
    this.visEpisode += 1;
    return this.flush('resume');
  }

  public async handleIdle60s(): Promise<boolean> {
    return this.flush('idle');
  }

  public async handleOnline(): Promise<boolean> {
    await this.flushRecoveredWal();
    return this.flush('change');
  }

  public updateAdaptiveHeartbeat(meanEngagedSec: number, terminalLossUpper: number): number {
    this.heartbeatSec = computeAdaptiveHeartbeatSec(
      meanEngagedSec,
      terminalLossUpper,
      Boolean(this.config.transport.armFetchLater)
    );
    return this.heartbeatSec;
  }

  // =========================================================================
  // Frame Assembly, Encoding, Size Budgets & Transport
  // =========================================================================

  private canSendTelemetry(): boolean {
    if (!this.consentResult || !this.consentResult.telemetryAllowed) return false;
    if ((this.killBits & 1) !== 0) return false;
    // §12.2: `render` lab marker blocks telemetry ingestion completely!
    if (
      isActiveLabMarker(this.config.labMarker, this.nowWall()) &&
      shouldBlockTelemetryForLabPurpose(this.config.labMarker.purpose)
    ) {
      return false;
    }
    return true;
  }

  private buildFrame(
    frameClass: FrameClass,
    transport: FrameTransport,
    forceFull: boolean
  ): TelemetryFrame {
    const resolved = this.consentResult!;
    const isFull = forceFull || frameClass === 'hidden' || frameClass === 'deferred';
    const nextSeq = this.seq + 1;
    const tMono = Math.round(this.nowMono());
    const tWall = Math.round(this.nowWall());
    const isPrivateScope = this.currentDomState === 'private_scope';

    const reg = this.behaviour.buildRegistersAndLogs({
      full: isFull,
      purposes: resolved.purposes,
      tMono,
    });

    const labActive = isActiveLabMarker(this.config.labMarker, tWall);
    const liveWord =
      ((this.visEpisode & 0xff) << 8) |
      (this.behaviour.degradeLevel & 0x3) |
      (this.billingMode === 'over_quota_count_only' ? 1 << 16 : 0);

    const state = {
      page_url_key: this.urlInfo.url_key_v2,
      nav_type: this.currentNavType,
      started_hidden: this.config.startedHidden ?? false,
      scroll_max_px: this.behaviour.scrollMaxPx,
      doc_h_first: this.behaviour.docHFirst,
      doc_h_max: this.behaviour.docHMax,
      doc_h_last: { value: this.behaviour.docHLastValue, seq: this.behaviour.docHLastSeq },
      vis_ms: this.behaviour.visMs,
      reversals: this.behaviour.reversals,
      js_error_n: this.behaviour.jsErrorN,
      ...(reg.error_hashes.length > 0 ? { error_hashes: reg.error_hashes } : {}),
      ...(reg.section_tokens.length > 0 ? { section_tokens: reg.section_tokens } : {}),
      degrade_level: this.behaviour.degradeLevel,
      dom_state: this.currentDomState,
      skel_fp: this.currentSkelFp,
      css_fp: this.currentCssFp,
      head_fp: this.currentHeadFp,
      variant_key: this.config.variantKey ?? 'default',
      sample_pi: this.behaviour.getSamplePi(),
    };

    const chk = computeFrameChecksum({
      state,
      sections: reg.sections,
      blocks: reg.blocks,
      fields: reg.fields,
      forms: reg.forms,
      media: reg.media,
      log_items: reg.log_items,
    });

    // [H-11]: Strip ALL person/cross-PV linkable keys (`vid`, `sid`, `mid_hash`, `cont_of`,
    // `pv_token`, `handoff_token`) on `private_scope` pages!
    return {
      codec_ver: CODEC_VERSION,
      schema_ver: CANONICAL_SCHEMA.meta.wireVersion,
      sdk_build: this.config.sdkBuild,
      pv_id: this.pvId,
      seq: nextSeq,
      cont_of: isPrivateScope ? null : this.contOf,
      frame_class: frameClass,
      transport,
      full: isFull,
      vis_episode: this.visEpisode,
      t_mono: tMono,
      t_wall: tWall,
      ack_echo_seq: this.lastAckedSeq,
      pv_token: isPrivateScope ? null : this.pvToken,
      consent_mode: resolved.mode,
      purposes: resolved.purposes,
      arm_bits: this.config.armBits,
      def_ver: this.config.defVer,
      url_id: this.urlInfo.url_id,
      key_ver: 2,
      profile_rev: this.config.profileRev,
      dim_tuple_code: this.config.dimTupleCode,
      live_word: liveWord,
      key_degraded: this.urlInfo.key_degraded,
      handoff_token: isPrivateScope ? null : (this.config.handoffToken ?? null),
      visitor_id: isPrivateScope || resolved.mode === 'cookieless' ? null : this.visitorId,
      session_id: isPrivateScope || resolved.mode === 'cookieless' ? null : this.sessionId,
      member_hash:
        !isPrivateScope && resolved.purposes.includes('member_link') ? this.memberHash : null,
      lab_run_id: labActive ? this.config.labMarker!.lab_run_id : null,
      chk,
      state,
      sections: reg.sections,
      ...(reg.blocks.length > 0 ? { blocks: reg.blocks } : {}),
      ...(reg.fields.length > 0 ? { fields: reg.fields } : {}),
      ...(reg.forms.length > 0 ? { forms: reg.forms } : {}),
      ...(reg.media.length > 0 ? { media: reg.media } : {}),
      ...(reg.vitals !== undefined ? { vitals: reg.vitals } : {}),
      log_items: reg.log_items,
    };
  }

  private buildMinimalBeaconFallback(frame: TelemetryFrame): TelemetryFrame {
    const minimalState = {
      ...frame.state,
    };
    const chk = computeFrameChecksum({
      state: minimalState,
      sections: [],
      log_items: [],
    });
    return {
      ...frame,
      sections: [],
      blocks: undefined,
      fields: undefined,
      forms: undefined,
      media: undefined,
      vitals: undefined,
      log_items: [],
      chk,
      state: minimalState,
    };
  }

  private encodeWithBudgetGuard(frame: TelemetryFrame): {
    readonly frame: TelemetryFrame;
    readonly bytes: Uint8Array;
  } {
    const maxBytes = this.codec.maxBytesForClass(frame.frame_class);
    try {
      const encoded = this.codec.encodeFrame(frame);
      if (encoded.byteLength <= maxBytes) {
        return { frame, bytes: encoded };
      }
    } catch {
      // Fall through to progressive coarsening
    }

    // Coarsen: drop blocks/media/fields first while keeping sections + critical logs
    const coarsened: TelemetryFrame = {
      ...frame,
      blocks: undefined,
      fields: undefined,
      forms: undefined,
      media: undefined,
      chk: computeFrameChecksum({
        state: frame.state,
        sections: frame.sections,
        log_items: frame.log_items,
      }),
    };
    try {
      const encoded = this.codec.encodeFrame(coarsened);
      if (encoded.byteLength <= maxBytes) {
        return { frame: coarsened, bytes: encoded };
      }
    } catch {
      // Fall through to minimal frame
    }

    const minimal = this.buildMinimalBeaconFallback(frame);
    const minBytes = this.codec.encodeFrame(minimal);
    return { frame: minimal, bytes: minBytes };
  }

  public armDeferredFetchIfSupported(): boolean {
    if (!this.canSendTelemetry() || !this.config.transport.armFetchLater) {
      return false;
    }
    if (this.activeFetchLaterHandle && !this.activeFetchLaterHandle.activated) {
      this.cancelArmedFetchLater();
    }
    const deferredFrame = this.buildFrame('deferred', 'later', true);
    const { frame, bytes } = this.encodeWithBudgetGuard(deferredFrame);
    if (bytes.byteLength > HIDDEN_MAX_BYTES) return false;
    const controller = new AbortController();
    this.fetchLaterAbortController = controller;
    const handle = this.config.transport.armFetchLater(
      this.config.collectorEndpoint,
      bytes,
      frame,
      FETCH_LATER_ACTIVATE_AFTER_MS,
      controller.signal
    );
    this.activeFetchLaterHandle = {
      get activated() {
        return handle.activated;
      },
      abort: () => {
        if (!controller.signal.aborted) {
          controller.abort();
        }
        handle.abort();
      },
    };
    return true;
  }

  private applyAck(ack: CollectorAckPayload): void {
    this.ackHistory.push(ack);
    if (ack.held || ack.accepted_saved === false) {
      // §11.8: held frame did NOT receive a saved confirmation — keep log items unacked!
      return;
    }
    if (ack.seq > this.lastAckedSeq) {
      this.lastAckedSeq = ack.seq;
    }
    if (ack.i_hw > this.lastAckedLogHw) {
      this.lastAckedLogHw = ack.i_hw;
      this.behaviour.acknowledgeLogItems(ack.i_hw);
    }
    if (ack.pv_token && this.currentDomState !== 'private_scope') {
      this.pvToken = ack.pv_token;
    }
    if (typeof ack.kill === 'number') {
      this.killBits = ack.kill;
    }
    if (typeof ack.h === 'number' && ack.h >= 2 && ack.h <= 30) {
      this.heartbeatSec = ack.h;
    }
    if (ack.billing_mode) {
      this.billingMode = ack.billing_mode;
    }
    this.behaviour.markRegistersClean();
    this.inMemoryWalQueue.length = 0;
    this.storage.clearSessionWal(WAL_TAB_KEY);
    this.storage.clearPersistentWal(WAL_VISIT_KEY);
  }

  private persistWalTail(frame: TelemetryFrame): void {
    // Keep bounded in-memory WAL queue for same-tab retry (wiped on consent downgrade / optOut)
    if (this.inMemoryWalQueue.length >= MAX_IN_MEMORY_WAL_FRAMES) {
      this.inMemoryWalQueue.shift();
    }
    this.inMemoryWalQueue.push(frame);

    // Never persist cross-PV WAL on private_scope pages ([H-11])
    if (this.currentDomState === 'private_scope') {
      return;
    }
    const serialized = JSON.stringify(frame);
    // N1 Write-ahead tail: sessionStorage for >= session, localStorage for full (NEVER cookieless/off!)
    this.storage.writeSessionWal(WAL_TAB_KEY, serialized);
    this.storage.writePersistentWal(WAL_VISIT_KEY, serialized);
  }

  private async flushRecoveredWal(): Promise<void> {
    if (this.currentDomState === 'private_scope') return;

    while (this.inMemoryWalQueue.length > 0 && this.canSendTelemetry()) {
      const queued = this.inMemoryWalQueue[0];
      const recoveredMem: TelemetryFrame = {
        ...queued,
        frame_class: 'recovered',
        transport: 'wal_tab',
        full: true,
      };
      const { bytes } = this.encodeWithBudgetGuard(recoveredMem);
      const ack = await this.config.transport.sendFetch(
        this.config.collectorEndpoint,
        bytes,
        recoveredMem
      );
      if (ack && !ack.held && ack.accepted_saved !== false) {
        this.inMemoryWalQueue.shift();
      } else {
        break;
      }
    }

    const rawTab = this.storage.readSessionWal(WAL_TAB_KEY);
    const rawVisit = rawTab ?? this.storage.readPersistentWal(WAL_VISIT_KEY);
    if (!rawVisit) return;

    try {
      const recovered = JSON.parse(rawVisit) as TelemetryFrame;
      const transport: FrameTransport = rawTab ? 'wal_tab' : 'wal_visit';
      const frame: TelemetryFrame = {
        ...recovered,
        frame_class: 'recovered',
        transport,
        full: true,
      };
      const { bytes } = this.encodeWithBudgetGuard(frame);
      const ack = await this.config.transport.sendFetch(this.config.collectorEndpoint, bytes, frame);
      if (ack && !ack.held && ack.accepted_saved !== false) {
        this.storage.clearSessionWal(WAL_TAB_KEY);
        this.storage.clearPersistentWal(WAL_VISIT_KEY);
      }
    } catch {
      this.storage.clearSessionWal(WAL_TAB_KEY);
    }
  }

  /**
   * Flushes a frame using the class-appropriate transport (§4.2 / TEL M2):
   * - `hidden` / `critical`: `sendBeacon` (<=16 KiB; if false -> <=512B minimal + WAL)
   * - visible (`first` / `change` / `heartbeat` / `resume` / `idle` / `audit`): `fetch` (<=48 KiB)
   */
  public async flush(frameClass: FrameClass): Promise<boolean> {
    if (!this.canSendTelemetry()) return false;
    if (frameClass === 'change' && !this.behaviour.hasDirtyState()) return false;

    const useBeacon = frameClass === 'hidden' || frameClass === 'critical';
    const transport: FrameTransport = useBeacon ? 'beacon' : 'fetch';
    const forceFull =
      frameClass === 'hidden' || frameClass === 'deferred' || frameClass === 'recovered';

    const rawFrame = this.buildFrame(frameClass, transport, forceFull);
    const { frame, bytes } = this.encodeWithBudgetGuard(rawFrame);

    this.seq = frame.seq;
    if (frameClass === 'change') {
      this.changeFlushCount += 1;
    }

    if (useBeacon) {
      const ok = this.config.transport.sendBeacon(this.config.collectorEndpoint, bytes, frame);
      this.sentFrameCount += 1;
      this.lastSentFrame = frame;
      this.lastEncodedBytes = bytes;
      if (ok) {
        return true;
      }
      // Beacon returned false (shared 64 KiB quota full): retry 512B minimal frame + WAL tail (TEL M2 / N1)
      const minimal = this.buildMinimalBeaconFallback(frame);
      const minBytes = this.codec.encodeFrame(minimal);
      let minimalSent = false;
      if (minBytes.byteLength <= MINIMAL_BEACON_MAX_BYTES) {
        minimalSent = this.config.transport.sendBeacon(
          this.config.collectorEndpoint,
          minBytes,
          minimal
        );
      }
      this.persistWalTail(frame);
      return minimalSent;
    }

    // Visible fetch transport (ACK readable, outside keepalive quota)
    const ack = await this.config.transport.sendFetch(this.config.collectorEndpoint, bytes, frame);
    this.sentFrameCount += 1;
    this.lastSentFrame = frame;
    this.lastEncodedBytes = bytes;
    if (ack) {
      this.applyAck(ack);
      this.armDeferredFetchIfSupported();
      return !ack.held && ack.accepted_saved !== false;
    }
    this.persistWalTail(frame);
    return false;
  }
}
