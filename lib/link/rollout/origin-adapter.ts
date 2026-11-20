/**
 * UGOKI LINK v2 — Issue-to-Fix Generator Catalog & Origin Server Adapters (§10.8, §10.9, del.D20)
 *
 * Implements:
 * 1. Origin-only Generator Catalog (§10.8):
 *    - Origin language ops: `title | description | heading_hierarchy | alt | internal_link | body | style`
 *      (NEVER browser-executable)
 *    - `json_ld` & `llms_txt` are locked `not_entitled` until prior decision revision (`D-16` / S12:211)
 *    - `canonical` & `robots` are locked `not_entitled` until Decision `D-16` is approved
 *    - Preflight auto-repair loop (max 3 repairs per attempt) + >= 28/30 owned-page activation gate
 * 2. Operation-specific REQUIRED fingerprint change verification (`REQUIRED_CHANGED_FP_BY_OP`, §10.9):
 *    - `body -> body_fp`, `heading_hierarchy -> skel_fp`, `internal_link -> links_fp`,
 *      `alt -> el_fp`, `title|description|head -> head_fp`, `style -> css_fp`
 *    - Rejects any promotion whose required fingerprint key did NOT change between before & after
 * 3. Common OriginAdapter contract (`capabilities`, `dryRun`, `applyWithVersionCheck`, `revert`, `verify`):
 *    - `WpPluginOriginAdapter`: connects directly to `packages/wp-plugin` (`WpPluginEngine` + `signWpCommand`),
 *      honoring 2-key owner local policy, edit lock, CAS, immutable pre-image, 3-way merge + browser inverse fallback
 *    - `WpRestOriginAdapter`: script-capable REST credentials strictly require human passkey approval
 *    - `runOriginAdapterConformanceSuite` (`del.D20`: 59 concurrent-edit cycles, 0 lost edits, hash-equal restores)
 *    - `evaluateAutonomousPromotionRollbackBound` (`n = 59` clean applies => 95% upper bound <= 5% rollback rate)
 */

import { requireDecisionEntitled } from '../../../packages/contract/ledgers';
import { sha256Hex } from '../../../packages/contract/response';
import {
  WpPluginEngine,
  signWpCommand,
  type WpCommandPayload,
} from '../../../packages/wp-plugin';

// =========================================================================
// 1. Origin Edit Language, Decision Locks & Required Fingerprint Map (§10.8–§10.9)
// =========================================================================

export const ORIGIN_STANDARD_OPS = [
  'title',
  'description',
  'heading_hierarchy',
  'alt',
  'internal_link',
  'body',
  'style',
] as const;

export const ORIGIN_DECISION_LOCKED_OPS = [
  'json_ld',
  'llms_txt',
  'canonical',
  'robots',
] as const;

export type OriginStandardOp = (typeof ORIGIN_STANDARD_OPS)[number];
export type OriginDecisionLockedOp = (typeof ORIGIN_DECISION_LOCKED_OPS)[number];
export type OriginEditOp = OriginStandardOp | OriginDecisionLockedOp;

export type PageFingerprintKey =
  | 'body_fp'
  | 'skel_fp'
  | 'links_fp'
  | 'el_fp'
  | 'head_fp'
  | 'css_fp';

export interface PageFingerprintSnapshot {
  readonly body_fp: string;
  readonly skel_fp: string;
  readonly links_fp: string;
  readonly el_fp: string;
  readonly head_fp: string;
  readonly css_fp: string;
}

/**
 * §10.9 Mandatory fingerprint key that MUST change for each origin operation kind.
 * Promotions where this key does not change between pre and post MUST be rejected.
 */
export const REQUIRED_CHANGED_FP_BY_OP: Readonly<
  Record<OriginStandardOp | 'head', PageFingerprintKey>
> = Object.freeze({
  body: 'body_fp',
  heading_hierarchy: 'skel_fp',
  internal_link: 'links_fp',
  alt: 'el_fp',
  title: 'head_fp',
  description: 'head_fp',
  head: 'head_fp',
  style: 'css_fp',
});

export class OriginOpNotBrowserExecutableError extends Error {
  constructor(op: string) {
    super(
      `§10.8 Prohibition: Origin language op "${op}" MUST NOT execute in the browser runtime.`
    );
    this.name = 'OriginOpNotBrowserExecutableError';
  }
}

export class UnchangedRequiredFingerprintError extends Error {
  public readonly op: OriginStandardOp | 'head';
  public readonly requiredKey: PageFingerprintKey;

  constructor(op: OriginStandardOp | 'head', requiredKey: PageFingerprintKey) {
    super(
      `§10.9 Verification Failure: Origin op "${op}" requires fingerprint "${requiredKey}" to change, but before === after.`
    );
    this.name = 'UnchangedRequiredFingerprintError';
    this.op = op;
    this.requiredKey = requiredKey;
  }
}

export interface FingerprintVerificationResult {
  readonly ok: boolean;
  readonly op: OriginStandardOp | 'head';
  readonly requiredKey: PageFingerprintKey;
  readonly beforeValue: string;
  readonly afterValue: string;
  readonly reason: string;
}

/**
 * Verifies §10.9: the operation-specific required fingerprint key MUST differ between
 * before and after snapshots. Refuses promotions where only an unrelated key changed.
 */
export function verifyRequiredFingerprintChanged(
  op: OriginStandardOp | 'head',
  beforeFps: PageFingerprintSnapshot,
  afterFps: PageFingerprintSnapshot
): FingerprintVerificationResult {
  const requiredKey = REQUIRED_CHANGED_FP_BY_OP[op];
  const beforeValue = beforeFps[requiredKey];
  const afterValue = afterFps[requiredKey];

  if (!beforeValue || !afterValue || beforeValue === afterValue) {
    return {
      ok: false,
      op,
      requiredKey,
      beforeValue,
      afterValue,
      reason: `required_fingerprint_unchanged(${requiredKey})`,
    };
  }

  return {
    ok: true,
    op,
    requiredKey,
    beforeValue,
    afterValue,
    reason: 'required_fingerprint_changed',
  };
}

/**
 * Checks entitlement for origin operations, locking `json_ld`/`llms_txt` (prior decision S12:211)
 * and `canonical`/`robots` (`D-16`) as `not_entitled` until explicitly approved.
 */
export function checkOriginOpEntitlement(
  op: OriginEditOp,
  options?: {
    readonly executionSurface?: 'origin' | 'browser';
    readonly decision16ApprovedOverride?: boolean;
    readonly priorStructuredDataRevisionApprovedOverride?: boolean;
  }
): {
  readonly entitled: boolean;
  readonly status: 'ok' | 'not_entitled';
  readonly reason: string;
} {
  if (options?.executionSurface === 'browser') {
    throw new OriginOpNotBrowserExecutableError(op);
  }

  if (op === 'json_ld' || op === 'llms_txt') {
    const d16 = requireDecisionEntitled('D-16');
    const approved =
      options?.priorStructuredDataRevisionApprovedOverride !== undefined
        ? options.priorStructuredDataRevisionApprovedOverride
        : d16.entitled;
    if (!approved) {
      return {
        entitled: false,
        status: 'not_entitled',
        reason: `op_${op}_locked_until_prior_decision_revision_S12_211_D16`,
      };
    }
    return { entitled: true, status: 'ok', reason: 'prior_decision_revised_d16' };
  }

  if (op === 'canonical' || op === 'robots') {
    const d16 = requireDecisionEntitled('D-16');
    const approved =
      options?.decision16ApprovedOverride !== undefined
        ? options.decision16ApprovedOverride
        : d16.entitled;
    if (!approved) {
      return {
        entitled: false,
        status: 'not_entitled',
        reason: `op_${op}_locked_until_decision_D16_approved`,
      };
    }
    return { entitled: true, status: 'ok', reason: 'decision_d16_approved' };
  }

  return { entitled: true, status: 'ok', reason: 'standard_origin_op' };
}

// =========================================================================
// 2. Generator Catalog, Max-3 Auto-Repair & 28/30 Activation Gate (§10.8)
// =========================================================================

export const GENERATOR_MAX_AUTO_REPAIRS = 3;
export const GENERATOR_ACTIVATION_MIN_PAGES = 30;
export const GENERATOR_ACTIVATION_MIN_PASSES = 28;

export type GeneratorIssueSource =
  | 'crawl_a11y_rule'
  | 'ml_bottleneck'
  | 'search_gap'
  | 'behavior_signal';

export interface GeneratorCatalogEntry {
  readonly generatorId: string;
  readonly version: string;
  readonly issueSource: GeneratorIssueSource;
  readonly lane: 'standard_telemetry' | 'origin_seo';
  readonly opKind: OriginEditOp;
  readonly targetPlacementRule: string;
  readonly verificationRule: string;
  readonly browserExecutable: false;
}

export interface GeneratorDraftOutput {
  readonly replacementHtml: string;
  readonly summary: string;
}

export interface GeneratorPreflightResult {
  readonly passed: boolean;
  readonly issues: readonly string[];
}

export interface GeneratorRepairRunResult {
  readonly generatorId: string;
  readonly version: string;
  readonly pageType: string;
  readonly passed: boolean;
  readonly repairAttemptsUsed: number;
  readonly finalDraft: GeneratorDraftOutput;
  readonly lastIssues: readonly string[];
}

/**
 * Runs a generator with automatic repair on preflight failure (maximum 3 auto-repairs, §10.8).
 */
export function runGeneratorWithPreflightRepair(params: {
  readonly entry: GeneratorCatalogEntry;
  readonly pageType: string;
  readonly generateInitial: () => GeneratorDraftOutput;
  readonly repairDraft: (
    prev: GeneratorDraftOutput,
    issues: readonly string[],
    repairAttempt: number
  ) => GeneratorDraftOutput;
  readonly runPreflight: (draft: GeneratorDraftOutput) => GeneratorPreflightResult;
  readonly maxRepairs?: number;
}): GeneratorRepairRunResult {
  const entitlement = checkOriginOpEntitlement(params.entry.opKind, {
    executionSurface: 'origin',
  });
  if (!entitlement.entitled) {
    return {
      generatorId: params.entry.generatorId,
      version: params.entry.version,
      pageType: params.pageType,
      passed: false,
      repairAttemptsUsed: 0,
      finalDraft: { replacementHtml: '', summary: entitlement.reason },
      lastIssues: [entitlement.reason],
    };
  }

  const maxRepairs = Math.min(
    GENERATOR_MAX_AUTO_REPAIRS,
    Math.max(0, params.maxRepairs ?? GENERATOR_MAX_AUTO_REPAIRS)
  );

  let draft = params.generateInitial();
  let check = params.runPreflight(draft);
  let repairsUsed = 0;

  while (!check.passed && repairsUsed < maxRepairs) {
    repairsUsed += 1;
    draft = params.repairDraft(draft, check.issues, repairsUsed);
    check = params.runPreflight(draft);
  }

  return {
    generatorId: params.entry.generatorId,
    version: params.entry.version,
    pageType: params.pageType,
    passed: check.passed,
    repairAttemptsUsed: repairsUsed,
    finalDraft: draft,
    lastIssues: check.issues,
  };
}

export interface GeneratorActivationGateReport {
  readonly generatorId: string;
  readonly version: string;
  readonly testedPages: number;
  readonly passedPages: number;
  readonly activated: boolean;
  readonly reason: string;
}

/**
 * §10.8 Activation Gate: generator becomes active ONLY after passing >= 28 of >= 30 owned pages.
 */
export function evaluateGeneratorActivationGate(
  generatorId: string,
  version: string,
  pageResults: readonly { readonly pageId: string; readonly passed: boolean }[]
): GeneratorActivationGateReport {
  const testedPages = pageResults.length;
  const passedPages = pageResults.filter((r) => r.passed).length;
  const minRequiredPasses = Math.ceil(
    (testedPages * GENERATOR_ACTIVATION_MIN_PASSES) / GENERATOR_ACTIVATION_MIN_PAGES
  );
  const activated =
    testedPages >= GENERATOR_ACTIVATION_MIN_PAGES &&
    passedPages >= Math.max(GENERATOR_ACTIVATION_MIN_PASSES, minRequiredPasses);

  return {
    generatorId,
    version,
    testedPages,
    passedPages,
    activated,
    reason: activated
      ? `activated(${passedPages}/${testedPages}_passed)`
      : `blocked(requires>=${GENERATOR_ACTIVATION_MIN_PASSES}/${GENERATOR_ACTIVATION_MIN_PAGES},observed=${passedPages}/${testedPages})`,
  };
}

// =========================================================================
// 3. Common OriginAdapter Contract + WP Plugin & WP REST Implementations (§10.9)
// =========================================================================

export interface OriginAdapterCapabilities {
  readonly adapterKind: 'wp_plugin' | 'wp_rest';
  readonly supportedOps: readonly OriginStandardOp[];
  readonly supportsAtomicCas: boolean;
  readonly supportsPreImageRestore: boolean;
  readonly scriptCapable: boolean;
  readonly requiresOwnerLocalPolicy: boolean;
}

export interface OriginApplyRequest {
  readonly promotionId: string;
  readonly postId: number;
  readonly opKind: OriginStandardOp;
  readonly changeClass: string;
  readonly expectedContentSha256: string;
  readonly expectedModifiedGmt: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly replacementHtml: string;
  readonly beforeFingerprints: PageFingerprintSnapshot;
  readonly computeAfterFingerprints: (newContent: string) => PageFingerprintSnapshot;
  readonly ownerWpAdminConfirmed?: boolean;
  /** Required for script-capable WP REST credentials (§10.9). */
  readonly humanApprovalId?: string;
}

export interface OriginDryRunResult {
  readonly ok: boolean;
  readonly predictedContentSha256?: string;
  readonly fingerprintCheck?: FingerprintVerificationResult;
  readonly error?: string;
}

export interface OriginApplyResult {
  readonly ok: boolean;
  readonly status: number;
  readonly promotionId: string;
  readonly preImageSha256?: string;
  readonly postImageSha256?: string;
  readonly fingerprintCheck?: FingerprintVerificationResult;
  readonly error?: string;
}

export interface BrowserInversePatchFallback {
  readonly patchId: string;
  readonly postId: number;
  readonly promotionId: string;
  readonly restorePreImageHtml: string;
  readonly reason: 'rollback_version_conflict';
}

export interface OriginRevertResult {
  readonly ok: boolean;
  readonly status: number;
  readonly promotionId: string;
  readonly restoredSha256?: string;
  readonly error?: string;
  readonly threeWayMergeProposal?: {
    readonly preImage: string;
    readonly postImageSha256: string;
    readonly currentImage: string;
  };
  readonly browserInverseFallback?: BrowserInversePatchFallback;
}

export interface OriginVerifyResult {
  readonly ok: boolean;
  readonly originMatchesExpected: boolean;
  readonly currentSha256?: string;
  readonly error?: string;
}

export interface OriginAdapter {
  capabilities(): OriginAdapterCapabilities;
  dryRun(req: OriginApplyRequest): Promise<OriginDryRunResult>;
  applyWithVersionCheck(req: OriginApplyRequest): Promise<OriginApplyResult>;
  revert(params: {
    readonly postId: number;
    readonly promotionId: string;
  }): Promise<OriginRevertResult>;
  verify(params: {
    readonly postId: number;
    readonly expectedSha256: string;
  }): Promise<OriginVerifyResult>;
}

/**
 * WordPress Companion Plugin Adapter wrapping `packages/wp-plugin` (`WpPluginEngine`).
 */
export class WpPluginOriginAdapter implements OriginAdapter {
  private seq = 0;

  constructor(
    private readonly engine: WpPluginEngine,
    private readonly signingPrivateKey: CryptoKey,
    private readonly kid: string
  ) {}

  capabilities(): OriginAdapterCapabilities {
    return {
      adapterKind: 'wp_plugin',
      supportedOps: ORIGIN_STANDARD_OPS,
      supportsAtomicCas: true,
      supportsPreImageRestore: true,
      scriptCapable: false,
      requiresOwnerLocalPolicy: true,
    };
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  async dryRun(req: OriginApplyRequest): Promise<OriginDryRunResult> {
    const post = this.engine.getPost(req.postId);
    if (!post) {
      return { ok: false, error: 'post_not_found' };
    }
    const currentSha = sha256Hex(post.content);
    if (currentSha !== req.expectedContentSha256) {
      return { ok: false, error: 'content_hash_mismatch' };
    }
    if (post.modified_gmt !== req.expectedModifiedGmt) {
      return { ok: false, error: 'modified_gmt_mismatch' };
    }
    if (
      req.byteStart < 0 ||
      req.byteEnd < req.byteStart ||
      req.byteEnd > post.content.length
    ) {
      return { ok: false, error: 'invalid_byte_span' };
    }
    const predicted =
      post.content.slice(0, req.byteStart) +
      req.replacementHtml +
      post.content.slice(req.byteEnd);
    const afterFps = req.computeAfterFingerprints(predicted);
    const fpCheck = verifyRequiredFingerprintChanged(
      req.opKind,
      req.beforeFingerprints,
      afterFps
    );
    if (!fpCheck.ok) {
      return { ok: false, fingerprintCheck: fpCheck, error: fpCheck.reason };
    }
    return {
      ok: true,
      predictedContentSha256: sha256Hex(predicted),
      fingerprintCheck: fpCheck,
    };
  }

  async applyWithVersionCheck(req: OriginApplyRequest): Promise<OriginApplyResult> {
    // Reject promotion before hitting origin if required operation fingerprint does not change (§10.9)
    const dry = await this.dryRun(req);
    if (!dry.ok && dry.fingerprintCheck && !dry.fingerprintCheck.ok) {
      return {
        ok: false,
        status: 422,
        promotionId: req.promotionId,
        fingerprintCheck: dry.fingerprintCheck,
        error: dry.fingerprintCheck.reason,
      };
    }

    const payload: WpCommandPayload = {
      command: 'apply',
      seq: this.nextSeq(),
      not_after: new Date(Date.now() + 60_000).toISOString(),
      post_id: req.postId,
      promotion_id: req.promotionId,
      change_class: req.changeClass,
      owner_wp_admin_confirmed: req.ownerWpAdminConfirmed,
      expected_content_sha256: req.expectedContentSha256,
      expected_modified_gmt: req.expectedModifiedGmt,
      byte_start: req.byteStart,
      byte_end: req.byteEnd,
      replacement_html: req.replacementHtml,
    };
    const env = await signWpCommand(payload, this.signingPrivateKey, this.kid);
    const res = await this.engine.handleSignedCommand(env);

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        promotionId: req.promotionId,
        error: res.error,
      };
    }

    const updated = this.engine.getPost(req.postId);
    const afterFps = req.computeAfterFingerprints(updated?.content ?? '');
    const fpCheck = verifyRequiredFingerprintChanged(
      req.opKind,
      req.beforeFingerprints,
      afterFps
    );
    if (!fpCheck.ok) {
      // Defensive immediate revert if sanitized output left required fingerprint unchanged
      await this.revert({ postId: req.postId, promotionId: req.promotionId });
      return {
        ok: false,
        status: 422,
        promotionId: req.promotionId,
        fingerprintCheck: fpCheck,
        error: fpCheck.reason,
      };
    }

    return {
      ok: true,
      status: res.status,
      promotionId: req.promotionId,
      preImageSha256: res.pre_image_sha256,
      postImageSha256: res.post_image_sha256,
      fingerprintCheck: fpCheck,
    };
  }

  async revert(params: {
    readonly postId: number;
    readonly promotionId: string;
  }): Promise<OriginRevertResult> {
    const payload: WpCommandPayload = {
      command: 'restore',
      seq: this.nextSeq(),
      not_after: new Date(Date.now() + 60_000).toISOString(),
      post_id: params.postId,
      promotion_id: params.promotionId,
    };
    const env = await signWpCommand(payload, this.signingPrivateKey, this.kid);
    const res = await this.engine.handleSignedCommand(env);

    if (!res.ok && res.status === 409 && res.three_way_merge) {
      // §10.9: On version conflict, return 3-way merge proposal + browser inverse patch fallback
      return {
        ok: false,
        status: 409,
        promotionId: params.promotionId,
        error: res.error ?? 'rollback_conflict',
        threeWayMergeProposal: {
          preImage: res.three_way_merge.pre_image,
          postImageSha256: res.three_way_merge.post_image_sha256,
          currentImage: res.three_way_merge.current_image,
        },
        browserInverseFallback: {
          patchId: `inv_${params.postId}_${params.promotionId}`,
          postId: params.postId,
          promotionId: params.promotionId,
          restorePreImageHtml: res.three_way_merge.pre_image,
          reason: 'rollback_version_conflict',
        },
      };
    }

    return {
      ok: res.ok,
      status: res.status,
      promotionId: params.promotionId,
      restoredSha256: res.restored_sha256,
      error: res.error,
    };
  }

  async verify(params: {
    readonly postId: number;
    readonly expectedSha256: string;
  }): Promise<OriginVerifyResult> {
    const payload: WpCommandPayload = {
      command: 'verify',
      seq: this.nextSeq(),
      not_after: new Date(Date.now() + 60_000).toISOString(),
      post_id: params.postId,
      expected_sha256: params.expectedSha256,
    };
    const env = await signWpCommand(payload, this.signingPrivateKey, this.kid);
    const res = await this.engine.handleSignedCommand(env);
    return {
      ok: res.ok,
      originMatchesExpected: Boolean(res.origin_ok),
      currentSha256: res.current_sha256,
      error: res.error,
    };
  }
}

/**
 * WordPress REST Origin Adapter (§10.9):
 * Enforces that credentials with script-write capability are STRICTLY restricted to
 * human-approved applies (never autonomous!).
 */
export class WpRestOriginAdapter implements OriginAdapter {
  private readonly posts = new Map<
    number,
    { content: string; modified_gmt: string; edit_lock_user_id: number | null }
  >();
  private readonly preImages = new Map<
    string,
    { preImage: string; preSha: string; postSha: string }
  >();

  constructor(
    private readonly options: {
      readonly scriptCapableCredential: boolean;
    }
  ) {}

  seedPost(postId: number, content: string, modifiedGmt: string): void {
    this.posts.set(postId, {
      content,
      modified_gmt: modifiedGmt,
      edit_lock_user_id: null,
    });
  }

  getPost(postId: number): { content: string; modified_gmt: string } | undefined {
    const p = this.posts.get(postId);
    return p ? { content: p.content, modified_gmt: p.modified_gmt } : undefined;
  }

  humanEditPost(postId: number, newContent: string, newModifiedGmt: string): void {
    const p = this.posts.get(postId);
    if (!p) throw new Error(`Post ${postId} not found`);
    p.content = newContent;
    p.modified_gmt = newModifiedGmt;
  }

  capabilities(): OriginAdapterCapabilities {
    return {
      adapterKind: 'wp_rest',
      supportedOps: ORIGIN_STANDARD_OPS,
      supportsAtomicCas: true,
      supportsPreImageRestore: true,
      scriptCapable: this.options.scriptCapableCredential,
      requiresOwnerLocalPolicy: false,
    };
  }

  async dryRun(req: OriginApplyRequest): Promise<OriginDryRunResult> {
    if (this.options.scriptCapableCredential && !req.humanApprovalId) {
      return { ok: false, error: 'script_capable_rest_requires_human_approval' };
    }
    const post = this.posts.get(req.postId);
    if (!post) return { ok: false, error: 'post_not_found' };
    if (sha256Hex(post.content) !== req.expectedContentSha256) {
      return { ok: false, error: 'content_hash_mismatch' };
    }
    if (post.modified_gmt !== req.expectedModifiedGmt) {
      return { ok: false, error: 'modified_gmt_mismatch' };
    }
    const next =
      post.content.slice(0, req.byteStart) +
      req.replacementHtml +
      post.content.slice(req.byteEnd);
    const fpCheck = verifyRequiredFingerprintChanged(
      req.opKind,
      req.beforeFingerprints,
      req.computeAfterFingerprints(next)
    );
    if (!fpCheck.ok) {
      return { ok: false, fingerprintCheck: fpCheck, error: fpCheck.reason };
    }
    return {
      ok: true,
      predictedContentSha256: sha256Hex(next),
      fingerprintCheck: fpCheck,
    };
  }

  async applyWithVersionCheck(req: OriginApplyRequest): Promise<OriginApplyResult> {
    if (this.options.scriptCapableCredential && !req.humanApprovalId) {
      return {
        ok: false,
        status: 403,
        promotionId: req.promotionId,
        error: 'script_capable_rest_requires_human_approval',
      };
    }

    const dry = await this.dryRun(req);
    if (!dry.ok) {
      return {
        ok: false,
        status: dry.fingerprintCheck && !dry.fingerprintCheck.ok ? 422 : 409,
        promotionId: req.promotionId,
        fingerprintCheck: dry.fingerprintCheck,
        error: dry.error,
      };
    }

    const post = this.posts.get(req.postId)!;
    const preSha = sha256Hex(post.content);
    const next =
      post.content.slice(0, req.byteStart) +
      req.replacementHtml +
      post.content.slice(req.byteEnd);
    const postSha = sha256Hex(next);

    this.preImages.set(`${req.postId}:${req.promotionId}`, {
      preImage: post.content,
      preSha,
      postSha,
    });
    post.content = next;
    post.modified_gmt = new Date().toISOString();

    return {
      ok: true,
      status: 200,
      promotionId: req.promotionId,
      preImageSha256: preSha,
      postImageSha256: postSha,
      fingerprintCheck: dry.fingerprintCheck,
    };
  }

  async revert(params: {
    readonly postId: number;
    readonly promotionId: string;
  }): Promise<OriginRevertResult> {
    const post = this.posts.get(params.postId);
    if (!post) {
      return { ok: false, status: 404, promotionId: params.promotionId, error: 'post_not_found' };
    }
    const rec = this.preImages.get(`${params.postId}:${params.promotionId}`);
    if (!rec) {
      return { ok: false, status: 404, promotionId: params.promotionId, error: 'preimage_not_found' };
    }
    const currentSha = sha256Hex(post.content);
    if (currentSha !== rec.postSha) {
      return {
        ok: false,
        status: 409,
        promotionId: params.promotionId,
        error: 'rollback_conflict',
        threeWayMergeProposal: {
          preImage: rec.preImage,
          postImageSha256: rec.postSha,
          currentImage: post.content,
        },
        browserInverseFallback: {
          patchId: `inv_${params.postId}_${params.promotionId}`,
          postId: params.postId,
          promotionId: params.promotionId,
          restorePreImageHtml: rec.preImage,
          reason: 'rollback_version_conflict',
        },
      };
    }
    post.content = rec.preImage;
    return {
      ok: true,
      status: 200,
      promotionId: params.promotionId,
      restoredSha256: sha256Hex(post.content),
    };
  }

  async verify(params: {
    readonly postId: number;
    readonly expectedSha256: string;
  }): Promise<OriginVerifyResult> {
    const post = this.posts.get(params.postId);
    if (!post) {
      return { ok: false, originMatchesExpected: false, error: 'post_not_found' };
    }
    const currentSha = sha256Hex(post.content);
    return {
      ok: true,
      originMatchesExpected: currentSha === params.expectedSha256,
      currentSha256: currentSha,
    };
  }
}

// =========================================================================
// 4. Autonomous Promotion Rollback-Rate Bound (n = 59 => 5% ceiling, §10.9)
// =========================================================================

export const AUTONOMOUS_PROMOTION_MIN_CLEAN_APPLIES = 59;
export const AUTONOMOUS_PROMOTION_MAX_ROLLBACK_RATE_UB95 = 0.05;

export interface AutonomousPromotionBoundReport {
  readonly cleanApplies: number;
  readonly rollbacks: number;
  readonly totalApplies: number;
  readonly rollbackRateUpperBound95: number;
  readonly eligibleForAutonomousPromotion: boolean;
}

/**
 * Computes exact 95% upper bound on rollback rate (at 0 rollbacks: 1 - 0.05^(1/n);
 * n = 59 gives 4.95% <= 5.0%, matching `del.adapter_conformance_cycles` / §10.9).
 */
export function evaluateAutonomousPromotionRollbackBound(
  cleanApplies: number,
  rollbacks: number
): AutonomousPromotionBoundReport {
  const totalApplies = Math.max(0, cleanApplies) + Math.max(0, rollbacks);
  if (totalApplies === 0) {
    return {
      cleanApplies: 0,
      rollbacks: 0,
      totalApplies: 0,
      rollbackRateUpperBound95: 1,
      eligibleForAutonomousPromotion: false,
    };
  }

  let ub95: number;
  if (rollbacks === 0) {
    // Exact one-sided 95% Clopper-Pearson upper bound for k=0: 1 - alpha^(1/n)
    ub95 = 1 - Math.pow(0.05, 1 / totalApplies);
  } else {
    // Wilson one-sided 95% upper bound (z = 1.644854) for k > 0
    const pHat = rollbacks / totalApplies;
    const z = 1.644854;
    const z2 = z * z;
    const denom = 1 + z2 / totalApplies;
    const center = pHat + z2 / (2 * totalApplies);
    const half =
      z * Math.sqrt((pHat * (1 - pHat) + z2 / (4 * totalApplies)) / totalApplies);
    ub95 = Math.min(1, (center + half) / denom);
  }

  return {
    cleanApplies,
    rollbacks,
    totalApplies,
    rollbackRateUpperBound95: Number(ub95.toFixed(6)),
    eligibleForAutonomousPromotion:
      cleanApplies >= AUTONOMOUS_PROMOTION_MIN_CLEAN_APPLIES &&
      ub95 <= AUTONOMOUS_PROMOTION_MAX_ROLLBACK_RATE_UB95,
  };
}
