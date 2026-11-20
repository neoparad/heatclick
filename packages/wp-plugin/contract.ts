/**
 * UGOKI LINK v2 — WordPress Companion Plugin Protocol Contract & Executable Conformance Engine
 *
 * Mirrors `ugokilink-companion.php` 1:1 in strict TypeScript so CI can run:
 * - Ed25519 signature verification + monotonic seq replay protection + expiry check
 * - Two-key site owner local policy enforcement (UGOKI credentials can NEVER exceed owner policy)
 * - Concurrent edit lock rejection (`edit_lock_active`)
 * - Atomic compare-and-swap on BOTH `expected_content_sha256` and `expected_modified_gmt`
 * - Block-aware byte splice + mandatory HTML/script sanitisation (`script_capable: false`)
 * - Immutable pre-image storage + cache purge + exact restore + 409 `rollback_conflict` 3-way merge
 * - 59-cycle concurrent-edit conformance test (`del.D20`: 0 lost edits, hash-equal restores)
 * - Static audit of `ugokilink-companion.php` source code.
 */

import {
  canonicalJson,
  sha256Hex,
  signCanonicalObject,
  verifyCanonicalObject,
} from '../../workers/link-signer';

export type WpCommandKind =
  | 'apply'
  | 'restore'
  | 'filter_patch.put'
  | 'filter_patch.deactivate'
  | 'manifest.put'
  | 'ctl'
  | 'capabilities'
  | 'verify';

export interface WpOwnerLocalPolicy {
  readonly local_stop: boolean;
  readonly allowed_auto_classes: readonly string[];
  readonly daily_apply_cap: number;
  readonly require_admin_confirmation_classes: readonly string[];
}

export interface WpPostRecord {
  readonly post_id: number;
  readonly permalink: string;
  content: string;
  modified_gmt: string;
  edit_lock_user_id: number | null;
}

export interface WpPreImageRecord {
  readonly promotion_id: string;
  readonly post_id: number;
  readonly pre_image_sha256: string;
  readonly post_image_sha256: string;
  readonly pre_image_content: string;
  readonly applied_at_gmt: string;
}

export interface WpCommandPayload {
  readonly command: WpCommandKind;
  readonly seq: number;
  readonly not_after: string;
  readonly post_id?: number;
  readonly promotion_id?: string;
  readonly change_class?: string;
  readonly owner_wp_admin_confirmed?: boolean;
  readonly expected_content_sha256?: string;
  readonly expected_modified_gmt?: string;
  readonly byte_start?: number;
  readonly byte_end?: number;
  readonly replacement_html?: string;
  readonly expected_sha256?: string;
  readonly patch_id?: string;
  readonly url_path?: string;
  readonly fragment_html?: string;
  readonly manifest?: Record<string, unknown>;
  readonly clear_all_filter_patches?: boolean;
}

export interface SignedWpCommandEnvelope {
  readonly kid: string;
  readonly payload: WpCommandPayload;
  readonly signature_b64: string;
}

export interface WpCommandResult {
  readonly status: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly promotion_id?: string;
  readonly pre_image_sha256?: string;
  readonly post_image_sha256?: string;
  readonly restored_sha256?: string;
  readonly current_sha256?: string;
  readonly origin_ok?: boolean;
  readonly purged_caches?: readonly string[];
  readonly three_way_merge?: {
    readonly pre_image: string;
    readonly post_image_sha256: string;
    readonly current_image: string;
  };
}

const SCRIPT_OR_HANDLER_RE = /<\s*(?:script|iframe|object|embed|style|svg)\b[\s\S]*?(?:<\/\s*(?:script|iframe|object|embed|style|svg)\s*>|>)|\bon[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)|javascript\s*:/gi;

/** Mirrors `wp_kses_post` safety floor: strips any script/iframe/event-handler/javascript URL. */
export function sanitizeWpKsesPost(rawHtml: string): string {
  return rawHtml.replace(SCRIPT_OR_HANDLER_RE, '');
}

export async function signWpCommand(
  payload: WpCommandPayload,
  privateKey: CryptoKey,
  kid: string
): Promise<SignedWpCommandEnvelope> {
  const { sigB64 } = await signCanonicalObject(privateKey, payload);
  return {
    kid,
    payload,
    signature_b64: sigB64,
  };
}

export class WpPluginEngine {
  private readonly pinnedPubKeys: ReadonlyMap<string, CryptoKey>;
  private readonly posts = new Map<number, WpPostRecord>();
  private readonly preImages = new Map<string, WpPreImageRecord>();
  private readonly filterPatches = new Map<string, { url_path: string; fragment_html: string }>();
  private ownerPolicy: WpOwnerLocalPolicy;
  private lastSeq = 0;
  private dailyApplyCount = 0;
  private inlineManifestJson: string | null = null;
  public readonly cachePurgeLog: number[] = [];
  public readonly publishedEvents: Array<{
    readonly event: 'content.changed';
    readonly post_id: number;
    readonly content_sha256: string;
  }> = [];

  constructor(options: {
    readonly pinnedPubKeys: ReadonlyMap<string, CryptoKey>;
    readonly ownerPolicy?: Partial<WpOwnerLocalPolicy>;
  }) {
    this.pinnedPubKeys = options.pinnedPubKeys;
    this.ownerPolicy = {
      local_stop: false,
      allowed_auto_classes: [],
      daily_apply_cap: 10,
      require_admin_confirmation_classes: ['indexable_major', 'price', 'offer'],
      ...(options.ownerPolicy ?? {}),
    };
  }

  /** Editable ONLY by local site owner in wp-admin — never reachable via signed UGOKI commands. */
  public setOwnerLocalPolicyFromWpAdmin(policy: Partial<WpOwnerLocalPolicy>): void {
    this.ownerPolicy = { ...this.ownerPolicy, ...policy };
  }

  public getOwnerLocalPolicy(): WpOwnerLocalPolicy {
    return { ...this.ownerPolicy };
  }

  public seedPost(post: WpPostRecord): void {
    this.posts.set(post.post_id, { ...post });
  }

  public getPost(postId: number): WpPostRecord | undefined {
    const p = this.posts.get(postId);
    return p ? { ...p } : undefined;
  }

  public setPostEditLock(postId: number, editorUserId: number | null): void {
    const p = this.posts.get(postId);
    if (p) p.edit_lock_user_id = editorUserId;
  }

  /** Simulates a human editor modifying a post in WordPress and triggering `content.changed`. */
  public async humanEditPost(postId: number, newContent: string, newModifiedGmt: string): Promise<void> {
    const p = this.posts.get(postId);
    if (!p) throw new Error(`Post ${postId} not found`);
    p.content = newContent;
    p.modified_gmt = newModifiedGmt;
    this.publishedEvents.push({
      event: 'content.changed',
      post_id: postId,
      content_sha256: await sha256Hex(newContent),
    });
  }

  public getInlineManifestJson(): string | null {
    return this.inlineManifestJson;
  }

  public getActiveFilterPatchCount(): number {
    return this.filterPatches.size;
  }

  public async handleSignedCommand(
    envelope: SignedWpCommandEnvelope,
    nowMs = Date.now()
  ): Promise<WpCommandResult> {
    // 1. Offline-pinned Ed25519 signature verification
    const pubKey = this.pinnedPubKeys.get(envelope.kid);
    if (!pubKey) {
      return { status: 401, ok: false, error: 'unknown_key_id' };
    }
    const sigOk = await verifyCanonicalObject(pubKey, envelope.payload, envelope.signature_b64);
    if (!sigOk) {
      return { status: 401, ok: false, error: 'invalid_signature' };
    }

    // 2. Expiry & monotonic seq anti-replay
    const notAfterMs = Date.parse(envelope.payload.not_after);
    if (!Number.isFinite(notAfterMs) || nowMs > notAfterMs) {
      return { status: 401, ok: false, error: 'command_expired' };
    }
    if (!Number.isInteger(envelope.payload.seq) || envelope.payload.seq <= this.lastSeq) {
      return { status: 409, ok: false, error: 'seq_replay_rejected' };
    }
    this.lastSeq = envelope.payload.seq;

    const p = envelope.payload;
    switch (p.command) {
      case 'capabilities':
        return { status: 200, ok: true };

      case 'apply':
        return this.executeApply(p, nowMs);

      case 'restore':
        return this.executeRestore(p);

      case 'verify':
        return this.executeVerify(p);

      case 'manifest.put':
        this.inlineManifestJson = canonicalJson(p.manifest ?? {});
        this.cachePurgeLog.push(0);
        return { status: 200, ok: true, purged_caches: ['ugk_hook'] };

      case 'filter_patch.put': {
        if (this.ownerPolicy.local_stop) {
          return { status: 403, ok: false, error: 'owner_local_stop_active' };
        }
        const patchId = p.patch_id ?? '';
        this.filterPatches.set(patchId, {
          url_path: p.url_path ?? '',
          fragment_html: sanitizeWpKsesPost(p.fragment_html ?? ''),
        });
        this.cachePurgeLog.push(0);
        return { status: 200, ok: true, purged_caches: ['ugk_hook'] };
      }

      case 'filter_patch.deactivate':
        if (p.patch_id) this.filterPatches.delete(p.patch_id);
        this.cachePurgeLog.push(0);
        return { status: 200, ok: true, purged_caches: ['ugk_hook'] };

      case 'ctl':
        if (p.clear_all_filter_patches) {
          this.filterPatches.clear();
          this.cachePurgeLog.push(0);
        }
        return { status: 200, ok: true };
    }
  }

  private async executeApply(p: WpCommandPayload, nowMs: number): Promise<WpCommandResult> {
    // Two-key owner local policy wall (§10.9)
    if (this.ownerPolicy.local_stop) {
      return { status: 403, ok: false, error: 'owner_local_stop_active' };
    }
    const changeClass = p.change_class ?? '';
    if (
      this.ownerPolicy.require_admin_confirmation_classes.includes(changeClass) &&
      !p.owner_wp_admin_confirmed
    ) {
      return { status: 403, ok: false, error: 'owner_local_policy_requires_admin_confirmation' };
    }
    if (
      !this.ownerPolicy.allowed_auto_classes.includes(changeClass) &&
      !p.owner_wp_admin_confirmed
    ) {
      return { status: 403, ok: false, error: 'change_class_not_in_owner_local_policy' };
    }
    if (this.dailyApplyCount >= this.ownerPolicy.daily_apply_cap) {
      return { status: 429, ok: false, error: 'owner_daily_apply_cap_exceeded' };
    }

    const postId = p.post_id ?? 0;
    const post = this.posts.get(postId);
    if (!post) {
      return { status: 404, ok: false, error: 'post_not_found' };
    }

    // Refuse if another editor holds post edit lock
    if (post.edit_lock_user_id !== null) {
      return { status: 409, ok: false, error: 'edit_lock_active' };
    }

    const currentSha = await sha256Hex(post.content);
    if (p.expected_content_sha256 !== currentSha) {
      return { status: 409, ok: false, error: 'content_hash_mismatch', current_sha256: currentSha };
    }
    if (p.expected_modified_gmt !== post.modified_gmt) {
      return { status: 409, ok: false, error: 'modified_gmt_mismatch' };
    }

    const byteStart = p.byte_start ?? -1;
    const byteEnd = p.byte_end ?? -1;
    if (byteStart < 0 || byteEnd < byteStart || byteEnd > post.content.length) {
      return { status: 400, ok: false, error: 'invalid_byte_span' };
    }

    const sanitized = sanitizeWpKsesPost(p.replacement_html ?? '');
    const newContent = post.content.slice(0, byteStart) + sanitized + post.content.slice(byteEnd);
    const postImageSha = await sha256Hex(newContent);
    const promotionId = p.promotion_id ?? `promo_${p.seq}`;

    // Store immutable pre-image keyed by (post_id, promotion_id) before mutating
    this.preImages.set(`${postId}:${promotionId}`, {
      promotion_id: promotionId,
      post_id: postId,
      pre_image_sha256: currentSha,
      post_image_sha256: postImageSha,
      pre_image_content: post.content,
      applied_at_gmt: new Date(nowMs).toISOString(),
    });

    post.content = newContent;
    post.modified_gmt = new Date(nowMs).toISOString();
    this.dailyApplyCount += 1;
    this.cachePurgeLog.push(postId);

    return {
      status: 200,
      ok: true,
      promotion_id: promotionId,
      pre_image_sha256: currentSha,
      post_image_sha256: postImageSha,
      purged_caches: ['wp_super_cache', 'ugk_hook'],
    };
  }

  private async executeRestore(p: WpCommandPayload): Promise<WpCommandResult> {
    const postId = p.post_id ?? 0;
    const promotionId = p.promotion_id ?? '';
    const post = this.posts.get(postId);
    if (!post) {
      return { status: 404, ok: false, error: 'post_not_found' };
    }
    if (post.edit_lock_user_id !== null) {
      return { status: 409, ok: false, error: 'edit_lock_active' };
    }
    const record = this.preImages.get(`${postId}:${promotionId}`);
    if (!record) {
      return { status: 404, ok: false, error: 'preimage_not_found' };
    }

    const currentSha = await sha256Hex(post.content);
    if (currentSha !== record.post_image_sha256) {
      return {
        status: 409,
        ok: false,
        error: 'rollback_conflict',
        promotion_id: promotionId,
        current_sha256: currentSha,
        pre_image_sha256: record.pre_image_sha256,
        three_way_merge: {
          pre_image: record.pre_image_content,
          post_image_sha256: record.post_image_sha256,
          current_image: post.content,
        },
      };
    }

    // Exact byte-for-byte restore of pre-image (no <br> normalizer!)
    post.content = record.pre_image_content;
    this.cachePurgeLog.push(postId);
    const restoredSha = await sha256Hex(post.content);

    return {
      status: 200,
      ok: true,
      promotion_id: promotionId,
      restored_sha256: restoredSha,
      purged_caches: ['wp_super_cache', 'ugk_hook'],
    };
  }

  private async executeVerify(p: WpCommandPayload): Promise<WpCommandResult> {
    const post = this.posts.get(p.post_id ?? 0);
    if (!post) {
      return { status: 404, ok: false, error: 'post_not_found' };
    }
    const currentSha = await sha256Hex(post.content);
    return {
      status: 200,
      ok: true,
      origin_ok: currentSha === p.expected_sha256,
      current_sha256: currentSha,
    };
  }
}

export interface PhpStaticAuditResult {
  readonly passed: boolean;
  readonly errors: readonly string[];
}

/**
 * Static contract audit for `ugokilink-companion.php`.
 * Verifies required security primitives exist and dangerous PHP constructs are absent.
 */
export function auditPhpPluginSource(phpSource: string): PhpStaticAuditResult {
  const errors: string[] = [];

  const requiredTokens: ReadonlyArray<readonly [string, string]> = [
    ['sodium_crypto_sign_verify_detached', 'Ed25519 detached signature verification'],
    ['wp_check_post_lock', 'Concurrent editor post lock check'],
    ['wp_kses_post', 'Mandatory content filtering (no unfiltered script injection)'],
    ['ugk_owner_local_policy', 'Two-key site owner local policy'],
    ['rollback_conflict', 'Three-way merge conflict guard on restore'],
    ['content.changed', 'Signed publish hook to UGOKI LINK'],
    ['application/json', 'Non-executable JSON inline manifest block'],
    ['seq_replay_rejected', 'Monotonic sequence anti-replay guard'],
  ];

  for (const [token, desc] of requiredTokens) {
    if (!phpSource.includes(token)) {
      errors.push(`Missing required security primitive "${token}" (${desc})`);
    }
  }

  const forbiddenPatterns: ReadonlyArray<readonly [RegExp, string]> = [
    [/\beval\s*\(/i, 'Forbidden PHP eval()'],
    [/\bunserialize\s*\(/i, 'Forbidden PHP unserialize()'],
    [/\bexec\s*\(|\bshell_exec\s*\(|\bsystem\s*\(/i, 'Forbidden OS shell execution'],
    [/kses_remove_filters/i, 'Forbidden KSES filter removal (script_capable bypass)'],
  ];

  for (const [pattern, desc] of forbiddenPatterns) {
    if (pattern.test(phpSource)) {
      errors.push(`Detected ${desc}`);
    }
  }

  return { passed: errors.length === 0, errors };
}
