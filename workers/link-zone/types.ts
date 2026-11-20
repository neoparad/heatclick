/**
 * UGOKI LINK v2 — Customer-Deployed Single Zone Worker Types (`workers/link-zone`)
 *
 * Uses Web Standard Fetch API types only (no `@cloudflare/workers-types`).
 * Spec refs: §10.1–§10.2, §12.1 #3, D-22, D-24, DEL M5 / App. H.
 */

import type { ConsentMode } from '../../packages/contract/schema';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ZoneModuleConfig {
  readonly deliver: boolean;
  readonly handoff: boolean;
  readonly origin_kit: boolean;
  readonly capture: boolean;
  readonly lab_sink: boolean;
}

export interface ZoneBudgetConfig {
  /** Max ms to wait for context fetch AFTER origin headers arrive (default 50 ms, D-24). */
  readonly contextRaceMs: number;
  /** Per-module soft CPU/wall budget caps in ms (§12.1 #3). */
  readonly deliverBudgetMs: number;
  readonly handoffBudgetMs: number;
  readonly originKitBudgetMs: number;
  readonly captureBudgetMs: number;
  /** Max HTML body size to rewrite (bytes). Larger bodies pass through untouched. */
  readonly maxRewriteBodyBytes: number;
}

export interface ZoneTextRewriteOp {
  readonly op: 'SetText';
  readonly marker_id: string;
  readonly expected_text_sha256: string;
  readonly new_text: string;
}

export interface ZoneContextResponse {
  readonly decision_id: string;
  readonly bundle_seq: number;
  readonly lease_id: string;
  readonly lease_issued_at_ms: number;
  readonly consent_mode: ConsentMode;
  readonly unit_kind: 'visitor' | 'session' | 'page_view';
  readonly draws: Readonly<Record<string, string>>;
  readonly rewrites: readonly ZoneTextRewriteOp[];
  readonly ctl_digest: string;
}

export interface ZoneObservationRecord {
  readonly req_uid: string;
  readonly tenant_id: string;
  readonly site_id: string;
  readonly path: string;
  readonly status: number;
  readonly ttfb_ms: number;
  readonly deliver_applied: boolean;
  readonly deliver_skipped_reason:
    | null
    | 'module_disabled'
    | 'passthrough_1pct_arm'
    | 'context_timeout'
    | 'budget_exceeded'
    | 'exception_fallback'
    | 'non_html'
    | 'body_too_large';
  readonly passthrough_arm: boolean;
  readonly handoff_attached: boolean;
  readonly lab_sink_applied: boolean;
  readonly budget_skips: readonly string[];
  readonly execution_order: readonly string[];
  readonly reduced_ua_family: string;
}

export interface ZoneSelfTestReport {
  readonly release_hash: string;
  readonly abi: number;
  readonly conformance_passed: boolean;
  readonly delivery_before_capture: true;
  readonly passthrough_share: number;
  readonly watchdog_remove_p95_target_s: 180;
  readonly modules: ZoneModuleConfig;
  readonly budgets: ZoneBudgetConfig;
  readonly counters: {
    readonly requests_total: number;
    readonly passthrough_count: number;
    readonly edge_skipped_count: number;
    readonly budget_skipped_count: number;
    readonly exception_fallback_count: number;
  };
}

export interface VerifiedLabToken {
  readonly run_id: string;
  readonly purpose: 'render' | 'install_probe' | 'canary_visit' | 'preflight' | 'agent_run' | 'panel';
}

export interface ZoneWorkerDeps {
  readonly tenantId: string;
  readonly siteId: string;
  readonly releaseHash: string;
  readonly abi: number;
  /** Per-site integrity secret `ugk_edge_*`; sub-keys are derived per function (D-24). */
  readonly edgeIntegritySecret: string;
  readonly modules: ZoneModuleConfig;
  readonly budgets?: Partial<ZoneBudgetConfig>;
  /** Default 0.01 (1% bypass comparison arm, `del.zone_passthrough_share`). */
  readonly passthroughShare?: number;
  /** Region echoed by customer's origin/CDN (e.g. 'JP'). */
  readonly regionClass?: string;
  /** Fetch upstream customer origin. */
  readonly fetchOrigin: FetchLike;
  /**
   * Fetch actor-blind decision context from UGOKI edge.
   * Structurally receives ONLY path, url, cookies-present boolean, and opt-out flag —
   * NEVER receives User-Agent, IP, or capture verdicts (§12.1 #3 / D-24)!
   */
  readonly fetchDecisionContext: (req: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly pathname: string;
    readonly hasConsentCookie: boolean;
    readonly optedOut: boolean;
    readonly requestSeed: string;
  }) => Promise<ZoneContextResponse | null>;
  /** Proxy `/_ugk/*` first-party requests to UGOKI collector/CDN. */
  readonly fetchUgokiFirstParty?: FetchLike;
  /** Verify optional signed `lab_token` header/param (D-21/D-22). */
  readonly verifyLabToken?: (token: string) => Promise<VerifiedLabToken | null>;
  /** Ship observation record asynchronously inside `ctx.waitUntil` (post-response). */
  readonly shipObservation: (
    record: ZoneObservationRecord,
    logIngestKeyHex: string
  ) => Promise<void>;
  /** Deterministic clock & optional per-module elapsed time simulator for testing budgets. */
  readonly nowMs?: () => number;
  readonly measureModuleMs?: (moduleName: 'deliver' | 'handoff' | 'origin_kit' | 'capture') => number;
  /** Optional deterministic request ID minting for tests. */
  readonly mintReqUid?: () => string;
}
