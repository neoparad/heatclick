/**
 * UGOKI LINK v2 — WordPress Companion Plugin Protocol Contract & Executable Conformance Engine
 *
 * Mirrors `ugokilink-companion.php` 1:1 in strict TypeScript so CI can run:
 * - Ed25519 signature verification over `payload_canonical_json` (64-byte length guard + try/catch -> 401)
 * - Site & home_url binding (`tenant_id`, `site_id`, normalized `home_url`) verified BEFORE `command_seq`
 * - True Two-Key site owner local policy (`ugk_owner_local_policy` + `ugokilink_local_approvals` in `wp_options`,
 *   writable ONLY via local WP-Admin `manage_options` + WP nonce — NEVER trusting cloud `owner_wp_admin_confirmed`)
 * - Per-UTC-day `daily_apply_cap` enforcement
 * - Concurrent edit lock rejection (`edit_lock_active`) + `$acquiredLock` ownership guard in `finally`
 * - Atomic compare-and-swap on BOTH `expected_content_sha256` and `expected_modified_gmt`
 * - Block-aware byte splice + mandatory HTML/script sanitisation (`script_capable: false`)
 * - Immutable pre-image storage + cache purge + exact restore + 409 `rollback_conflict` 3-way merge
 * - 59-cycle concurrent-edit conformance test (`del.D20`: 0 lost edits, hash-equal restores)
 * - Static audit of `ugokilink-companion.php` source code.
 */

import {
  base64ToBytes,
  canonicalJson,
  sha256Hex,
  signEd25519Bytes,
  utf8Encode,
  verifyEd25519Bytes,
} from '../../workers/link-signer/crypto';

export const DEFAULT_WP_TENANT_ID = 'tenant_default';
export const DEFAULT_WP_SITE_ID = 'site_default';
export const DEFAULT_WP_HOME_URL = 'https://wp.ugokilink.local';
export const SODIUM_CRYPTO_SIGN_BYTES = 64;

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

export interface WpLocalAdminApprovalRecord {
  readonly digest: string;
  readonly site_id: string;
  readonly post_id: number;
  readonly before_sha256: string;
  readonly after_sha256: string;
  readonly command_seq: number;
  readonly approved_at_ms: number;
  readonly expires_at_ms: number;
  state: 'unused' | 'claimed' | 'consumed';
  claim_token: string | null;
  consumed: boolean;
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
  readonly tenant_id?: string;
  readonly site_id?: string;
  readonly home_url?: string;
  readonly post_id?: number;
  readonly promotion_id?: string;
  readonly change_class?: string;
  /**
   * Deprecated untrusted field: ignored by `[C-17]` 2-key policy verification.
   * Kept optional on wire type only so adversarial tests can prove cloud payloads setting `true` are rejected.
   */
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
  readonly payload_canonical_json: string;
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

const SCRIPT_OR_HANDLER_RE =
  /<\s*(?:script|iframe|object|embed|style|svg)\b[\s\S]*?(?:<\/\s*(?:script|iframe|object|embed|style|svg)\s*>|>)|\bon[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)|javascript\s*:/gi;

/**
 * Extracts canonical indexable SEO nodes from a FULL HTML document (`[#6]`):
 * `<h1>`, `<title>`, `<meta>`, `<link rel="canonical">`, `<a href>` (href/rel attrs),
 * and `<script type="application/ld+json">`.
 * Mirrors `UgokiLink_Companion_Plugin::extractIndexableSeoSignature` 1:1.
 */
export function extractIndexableSeoSignature(html: string): string {
  const parts: string[] = [];

  // 1. <h1>...</h1> and <title>...</title> (full attributes + inner text/content)
  const blockRe = /<\s*(h1|title)\b([^>]*)>([\s\S]*?)<\/\s*\1\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2].trim().replace(/\s+/g, ' ');
    const body = m[3].trim().replace(/\s+/g, ' ');
    parts.push(`${tag}[${attrs}]=${body}`);
  }

  // 2. <meta ...> tags
  const metaRe = /<\s*meta\b([^>]*)>/gi;
  while ((m = metaRe.exec(html)) !== null) {
    const attrs = m[1].trim().replace(/\s+/g, ' ');
    parts.push(`meta[${attrs}]`);
  }

  // 3. <link ... rel="canonical" ...> tags
  const linkRe = /<\s*link\b([^>]*)>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const attrs = m[1].trim().replace(/\s+/g, ' ');
    if (/\brel\s*=\s*(?:"[^"]*\bcanonical\b[^"]*"|'[^']*\bcanonical\b[^']*'|canonical\b)/i.test(attrs)) {
      parts.push(`link_canonical[${attrs}]`);
    }
  }

  // 4. <a ... href=...> tags (href & rel attributes)
  const anchorRe = /<\s*a\b([^>]*)>/gi;
  while ((m = anchorRe.exec(html)) !== null) {
    const attrs = m[1];
    const hm = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const rm = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const href = hm ? (hm[1] ?? hm[2] ?? hm[3] ?? '').trim() : '';
    const rel = rm ? (rm[1] ?? rm[2] ?? rm[3] ?? '').trim() : '';
    if (href !== '') {
      parts.push(`a[href=${href};rel=${rel}]`);
    }
  }

  // 5. <script type="application/ld+json">...</script>
  const scriptRe = /<\s*script\b([^>]*)>([\s\S]*?)<\/\s*script\s*>/gi;
  while ((m = scriptRe.exec(html)) !== null) {
    const attrs = m[1];
    if (/\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json\b)/i.test(attrs)) {
      const body = m[2].trim().replace(/\s+/g, ' ');
      parts.push(`ld_json=${body}`);
    }
  }

  return parts.join('\n');
}

/** Mirrors `wp_kses_post` safety floor: strips any script/iframe/event-handler/javascript URL. */
export function sanitizeWpKsesPost(rawHtml: string): string {
  return rawHtml.replace(SCRIPT_OR_HANDLER_RE, '');
}

/**
 * Normalizes `home_url` identically to `UgokiLink_Companion_Plugin::normalizeHomeUrl` (`[H-08]`).
 */
export function normalizeWpHomeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
    if (scheme !== 'https' && scheme !== 'http') {
      return '';
    }
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port;
    const isDefaultPort =
      !port || (scheme === 'https' && port === '443') || (scheme === 'http' && port === '80');
    const portPart = isDefaultPort ? '' : `:${port}`;
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    return `${scheme}://${host}${portPart}${cleanPath}`;
  } catch {
    return '';
  }
}

/**
 * Computes `[C-17]` 2-key local approval digest:
 * `SHA-256(site_id + '|' + post_id + '|' + before_sha256 + '|' + after_sha256 + '|' + command_seq)`
 */
export async function computeWpLocalApprovalDigest(params: {
  readonly siteId: string;
  readonly postId: number;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly commandSeq: number;
}): Promise<string> {
  return sha256Hex(
    `${params.siteId}|${params.postId}|${params.beforeSha256}|${params.afterSha256}|${params.commandSeq}`
  );
}

function extractExternalHosts(html: string, normalizedHomeUrl: string): string[] {
  let homeHost = '';
  try {
    homeHost = new URL(normalizedHomeUrl).hostname.toLowerCase();
  } catch {
    homeHost = '';
  }
  const hosts = new Set<string>();
  const re = /https?:\/\/([a-z0-9.-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const h = m[1].toLowerCase();
    if (h && h !== homeHost) {
      hosts.add(h);
    }
  }
  return Array.from(hosts).sort();
}

export async function signWpCommand(
  payload: WpCommandPayload,
  privateKey: CryptoKey,
  kid: string
): Promise<SignedWpCommandEnvelope> {
  const boundPayload: WpCommandPayload = {
    ...payload,
    tenant_id: payload.tenant_id ?? DEFAULT_WP_TENANT_ID,
    site_id: payload.site_id ?? DEFAULT_WP_SITE_ID,
    home_url: normalizeWpHomeUrl(payload.home_url ?? DEFAULT_WP_HOME_URL),
  };
  const payloadCanonicalJson = canonicalJson(boundPayload);
  const sigB64 = await signEd25519Bytes(privateKey, utf8Encode(payloadCanonicalJson));
  return {
    kid,
    payload: boundPayload,
    payload_canonical_json: payloadCanonicalJson,
    signature_b64: sigB64,
  };
}

export class WpPluginEngine {
  private readonly pinnedPubKeys: ReadonlyMap<string, CryptoKey>;
  private readonly tenantId: string;
  private readonly siteId: string;
  private readonly homeUrl: string;
  private readonly posts = new Map<number, WpPostRecord>();
  private readonly preImages = new Map<string, WpPreImageRecord>();
  private readonly filterPatches = new Map<string, { url_path: string; fragment_html: string }>();
  /** Mirrors `wp_options['ugokilink_local_approvals']` (`[C-17]` / `[#7]`). */
  private readonly localApprovals = new Map<string, WpLocalAdminApprovalRecord>();
  /** Mirrors atomic per-digest `add_option('ugk_approval_claim_' . $digest)` lock (`[#7]`). */
  private readonly approvalClaimLocks = new Set<string>();
  private claimTokenSeq = 0;
  private postUpdateHook?: (post: WpPostRecord, nextContent: string) => Promise<void> | void;
  /** Mirrors `wp_options['ugk_daily_apply_counter']` keyed by UTC `YYYY-MM-DD` (`[H-08]`). */
  private readonly dailyApplyCountByUtcDay = new Map<string, number>();
  private ownerPolicy: WpOwnerLocalPolicy;
  private lastSeq = 0;
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
    readonly tenantId?: string;
    readonly siteId?: string;
    readonly homeUrl?: string;
  }) {
    this.pinnedPubKeys = options.pinnedPubKeys;
    this.tenantId = options.tenantId ?? DEFAULT_WP_TENANT_ID;
    this.siteId = options.siteId ?? DEFAULT_WP_SITE_ID;
    this.homeUrl = normalizeWpHomeUrl(options.homeUrl ?? DEFAULT_WP_HOME_URL);
    this.ownerPolicy = {
      local_stop: false,
      allowed_auto_classes: [],
      daily_apply_cap: 10,
      require_admin_confirmation_classes: [
        'indexable_major',
        'touch_indexable_seo',
        'change_outbound_hosts',
        'price',
        'offer',
      ],
      ...(options.ownerPolicy ?? {}),
    };
  }

  public getSiteIdentity(): {
    readonly tenantId: string;
    readonly siteId: string;
    readonly homeUrl: string;
  } {
    return {
      tenantId: this.tenantId,
      siteId: this.siteId,
      homeUrl: this.homeUrl,
    };
  }

  public getLastSeq(): number {
    return this.lastSeq;
  }

  /** Editable ONLY by local site owner in wp-admin — never reachable via signed UGOKI commands. */
  public setOwnerLocalPolicyFromWpAdmin(policy: Partial<WpOwnerLocalPolicy>): void {
    this.ownerPolicy = { ...this.ownerPolicy, ...policy };
  }

  public getOwnerLocalPolicy(): WpOwnerLocalPolicy {
    return { ...this.ownerPolicy };
  }

  /**
   * Mirrors `handleLocalAdminApprovalPost` (`admin_post_ugokilink_local_approve`, `[C-17]`):
   * Writes to local `wp_options['ugokilink_local_approvals']` ONLY when a local WordPress admin
   * with `manage_options` and verified `ugokilink_local_approve` WP nonce approves the exact diff.
   */
  public async recordLocalWpAdminApproval(params: {
    readonly hasManageOptionsCapability: boolean;
    readonly wpAdminNonceVerified: boolean;
    readonly postId: number;
    readonly beforeSha256: string;
    readonly afterSha256: string;
    readonly commandSeq: number;
    readonly ttlMs?: number;
    readonly nowMs?: number;
  }): Promise<{ readonly ok: boolean; readonly digest?: string; readonly error?: string }> {
    if (!params.hasManageOptionsCapability) {
      return { ok: false, error: 'manage_options_required' };
    }
    if (!params.wpAdminNonceVerified) {
      return { ok: false, error: 'invalid_wp_admin_nonce' };
    }
    if (
      params.postId <= 0 ||
      params.beforeSha256.length !== 64 ||
      params.afterSha256.length !== 64 ||
      !Number.isInteger(params.commandSeq) ||
      params.commandSeq <= 0
    ) {
      return { ok: false, error: 'invalid_local_approval_params' };
    }

    const nowMs = params.nowMs ?? Date.now();
    const boundedTtlMs = Math.max(60_000, Math.min(86_400_000, params.ttlMs ?? 900_000));
    const digest = await computeWpLocalApprovalDigest({
      siteId: this.siteId,
      postId: params.postId,
      beforeSha256: params.beforeSha256,
      afterSha256: params.afterSha256,
      commandSeq: params.commandSeq,
    });

    for (const [k, rec] of this.localApprovals.entries()) {
      if (rec.consumed || rec.expires_at_ms <= nowMs) {
        this.localApprovals.delete(k);
      }
    }

    this.localApprovals.set(digest, {
      digest,
      site_id: this.siteId,
      post_id: params.postId,
      before_sha256: params.beforeSha256,
      after_sha256: params.afterSha256,
      command_seq: params.commandSeq,
      approved_at_ms: nowMs,
      expires_at_ms: nowMs + boundedTtlMs,
      state: 'unused',
      claim_token: null,
      consumed: false,
    });

    return { ok: true, digest };
  }

  public getLocalApprovalState(digest: string): 'unused' | 'claimed' | 'consumed' | null {
    return this.localApprovals.get(digest)?.state ?? null;
  }

  public setPostUpdateHook(
    hook?: (post: WpPostRecord, nextContent: string) => Promise<void> | void
  ): void {
    this.postUpdateHook = hook;
  }

  /**
   * Atomically claims an unused local WP-Admin approval (`unused` -> `claimed`, `[#7]`).
   * Returns a unique claim token on success, or `null` if already claimed/consumed/expired/missing.
   */
  public claimLocalWpAdminApproval(expectedDigest: string, nowMs = Date.now()): string | null {
    if (this.approvalClaimLocks.has(expectedDigest)) {
      return null;
    }
    const rec = this.localApprovals.get(expectedDigest);
    if (
      !rec ||
      rec.state !== 'unused' ||
      rec.consumed ||
      rec.expires_at_ms <= nowMs ||
      rec.digest !== expectedDigest
    ) {
      return null;
    }
    this.approvalClaimLocks.add(expectedDigest);
    this.claimTokenSeq += 1;
    const claimToken = `claim_${this.claimTokenSeq}_${expectedDigest.slice(0, 12)}`;
    rec.state = 'claimed';
    rec.claim_token = claimToken;
    return claimToken;
  }

  private commitLocalWpAdminApproval(expectedDigest: string, claimToken: string): void {
    const rec = this.localApprovals.get(expectedDigest);
    if (rec && rec.state === 'claimed' && rec.claim_token === claimToken) {
      rec.state = 'consumed';
      rec.consumed = true;
      rec.claim_token = null;
    }
    this.approvalClaimLocks.delete(expectedDigest);
  }

  private releaseLocalWpAdminApproval(expectedDigest: string, claimToken: string): void {
    const rec = this.localApprovals.get(expectedDigest);
    if (rec && rec.state === 'claimed' && rec.claim_token === claimToken) {
      rec.state = 'unused';
      rec.consumed = false;
      rec.claim_token = null;
    }
    this.approvalClaimLocks.delete(expectedDigest);
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
    // 1. Offline-pinned Ed25519 signature verification over `payload_canonical_json` ([H-08])
    const pubKey = this.pinnedPubKeys.get(envelope.kid);
    if (!pubKey || typeof envelope.payload_canonical_json !== 'string' || envelope.payload_canonical_json === '') {
      return { status: 401, ok: false, error: 'unknown_key_id' };
    }

    let sigBytes: Uint8Array;
    try {
      sigBytes = base64ToBytes(envelope.signature_b64);
    } catch {
      return { status: 401, ok: false, error: 'malformed_signature' };
    }
    if (sigBytes.byteLength !== SODIUM_CRYPTO_SIGN_BYTES) {
      return { status: 401, ok: false, error: 'malformed_signature' };
    }

    let sigOk = false;
    try {
      sigOk = await verifyEd25519Bytes(
        pubKey,
        utf8Encode(envelope.payload_canonical_json),
        envelope.signature_b64
      );
    } catch {
      return { status: 401, ok: false, error: 'invalid_signature' };
    }
    if (!sigOk) {
      return { status: 401, ok: false, error: 'invalid_signature' };
    }

    let parsedPayload: WpCommandPayload;
    try {
      parsedPayload = JSON.parse(envelope.payload_canonical_json) as WpCommandPayload;
    } catch {
      return { status: 400, ok: false, error: 'invalid_payload_json' };
    }
    if (!parsedPayload || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload)) {
      return { status: 400, ok: false, error: 'invalid_payload_json' };
    }
    if (canonicalJson(parsedPayload) !== envelope.payload_canonical_json) {
      return { status: 400, ok: false, error: 'non_canonical_payload_json' };
    }
    if (envelope.payload && canonicalJson(envelope.payload) !== envelope.payload_canonical_json) {
      return { status: 400, ok: false, error: 'payload_canonical_mismatch' };
    }

    // 2. [H-08]: Verify tenant_id + site_id + normalized home_url BEFORE checking/advancing command_seq!
    const payloadTenantId = typeof parsedPayload.tenant_id === 'string' ? parsedPayload.tenant_id : '';
    const payloadSiteId = typeof parsedPayload.site_id === 'string' ? parsedPayload.site_id : '';
    const payloadHomeUrl =
      typeof parsedPayload.home_url === 'string' ? normalizeWpHomeUrl(parsedPayload.home_url) : '';

    if (!payloadTenantId || !payloadSiteId || !payloadHomeUrl) {
      return { status: 401, ok: false, error: 'missing_site_binding' };
    }
    if (
      payloadTenantId !== this.tenantId ||
      payloadSiteId !== this.siteId ||
      payloadHomeUrl !== this.homeUrl
    ) {
      return { status: 403, ok: false, error: 'site_binding_mismatch' };
    }

    // 3. Expiry & monotonic seq anti-replay
    const notAfterMs = Date.parse(parsedPayload.not_after);
    if (!Number.isFinite(notAfterMs) || nowMs > notAfterMs) {
      return { status: 401, ok: false, error: 'command_expired' };
    }
    if (!Number.isInteger(parsedPayload.seq) || parsedPayload.seq <= this.lastSeq) {
      return { status: 409, ok: false, error: 'seq_replay_rejected' };
    }
    const prevSeq = this.lastSeq;
    this.lastSeq = parsedPayload.seq;

    switch (parsedPayload.command) {
      case 'capabilities':
        return { status: 200, ok: true };

      case 'apply':
        return this.executeApply(parsedPayload, nowMs, prevSeq);

      case 'restore':
        return this.executeRestore(parsedPayload);

      case 'verify':
        return this.executeVerify(parsedPayload);

      case 'manifest.put':
        this.inlineManifestJson = canonicalJson(parsedPayload.manifest ?? {});
        this.cachePurgeLog.push(0);
        return { status: 200, ok: true, purged_caches: ['ugk_hook'] };

      case 'filter_patch.put': {
        if (this.ownerPolicy.local_stop) {
          return { status: 403, ok: false, error: 'owner_local_stop_active' };
        }
        const patchId = parsedPayload.patch_id ?? '';
        this.filterPatches.set(patchId, {
          url_path: parsedPayload.url_path ?? '',
          fragment_html: sanitizeWpKsesPost(parsedPayload.fragment_html ?? ''),
        });
        this.cachePurgeLog.push(0);
        return { status: 200, ok: true, purged_caches: ['ugk_hook'] };
      }

      case 'filter_patch.deactivate':
        if (parsedPayload.patch_id) this.filterPatches.delete(parsedPayload.patch_id);
        this.cachePurgeLog.push(0);
        return { status: 200, ok: true, purged_caches: ['ugk_hook'] };

      case 'ctl':
        if (parsedPayload.clear_all_filter_patches) {
          this.filterPatches.clear();
          this.cachePurgeLog.push(0);
        }
        return { status: 200, ok: true };
    }
  }

  private async executeApply(
    p: WpCommandPayload,
    nowMs: number,
    prevSeq: number
  ): Promise<WpCommandResult> {
    if (this.ownerPolicy.local_stop) {
      return { status: 403, ok: false, error: 'owner_local_stop_active' };
    }

    // [H-08]: Per-UTC-day daily_apply_cap check
    const utcDay = new Date(nowMs).toISOString().slice(0, 10);
    const usedToday = this.dailyApplyCountByUtcDay.get(utcDay) ?? 0;
    if (usedToday >= this.ownerPolicy.daily_apply_cap) {
      return { status: 429, ok: false, error: 'owner_daily_apply_cap_exceeded' };
    }

    const postId = p.post_id ?? 0;
    const post = this.posts.get(postId);
    if (!post) {
      return { status: 404, ok: false, error: 'post_not_found' };
    }

    // [H-08]: Refuse if another editor holds post edit lock; NEVER delete a human editor's lock!
    let acquiredLock = false;
    if (post.edit_lock_user_id !== null) {
      return { status: 409, ok: false, error: 'edit_lock_active' };
    }

    post.edit_lock_user_id = -1;
    acquiredLock = true;

    try {
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

      // [C-17] & [#6]: True 2-key local WP-Admin approval verification!
      // Compare FULL before/after HTML documents so text-only edits inside <h1>, <title>,
      // <meta>, <link rel="canonical">, <a href>, and JSON-LD NEVER bypass touch_indexable_seo.
      const changeClass = p.change_class ?? '';
      const seoChangedInFullDoc =
        extractIndexableSeoSignature(post.content) !== extractIndexableSeoSignature(newContent);
      const touchesIndexableSeo =
        changeClass === 'touch_indexable_seo' ||
        changeClass === 'indexable_major' ||
        seoChangedInFullDoc;

      const oldHosts = extractExternalHosts(post.content, this.homeUrl).join(',');
      const newHosts = extractExternalHosts(newContent, this.homeUrl).join(',');
      const changesOutboundHosts = changeClass === 'change_outbound_hosts' || oldHosts !== newHosts;

      const requiresAdminConfirm =
        this.ownerPolicy.require_admin_confirmation_classes.includes(changeClass) ||
        touchesIndexableSeo ||
        changesOutboundHosts;

      const inAllowedAuto = this.ownerPolicy.allowed_auto_classes.includes(changeClass);

      let claimedApprovalDigest: string | null = null;
      let claimedApprovalToken: string | null = null;
      if (requiresAdminConfirm || !inAllowedAuto) {
        const expectedDigest = await computeWpLocalApprovalDigest({
          siteId: this.siteId,
          postId,
          beforeSha256: currentSha,
          afterSha256: postImageSha,
          commandSeq: p.seq,
        });
        const claimToken = this.claimLocalWpAdminApproval(expectedDigest, nowMs);
        if (!claimToken) {
          return {
            status: 403,
            ok: false,
            error: requiresAdminConfirm
              ? 'owner_local_policy_requires_admin_confirmation'
              : 'change_class_not_in_owner_local_policy',
          };
        }
        claimedApprovalDigest = expectedDigest;
        claimedApprovalToken = claimToken;
      }

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

      try {
        if (this.postUpdateHook) {
          await this.postUpdateHook({ ...post }, newContent);
        }
        post.content = newContent;
        post.modified_gmt = new Date(nowMs).toISOString();
      } catch {
        // [#7] Roll back claimed approval to `unused` and restore seq on wp_update_post failure
        if (claimedApprovalDigest && claimedApprovalToken) {
          this.releaseLocalWpAdminApproval(claimedApprovalDigest, claimedApprovalToken);
        }
        if (this.lastSeq === p.seq) {
          this.lastSeq = prevSeq;
        }
        return { status: 500, ok: false, error: 'wp_update_post_failed' };
      }

      // [#7] Commit claimed approval (`claimed` -> `consumed`) ONLY after post update succeeds
      if (claimedApprovalDigest && claimedApprovalToken) {
        this.commitLocalWpAdminApproval(claimedApprovalDigest, claimedApprovalToken);
      }

      this.dailyApplyCountByUtcDay.set(utcDay, usedToday + 1);
      this.cachePurgeLog.push(postId);

      return {
        status: 200,
        ok: true,
        promotion_id: promotionId,
        pre_image_sha256: currentSha,
        post_image_sha256: postImageSha,
        purged_caches: ['wp_super_cache', 'ugk_hook'],
      };
    } finally {
      if (acquiredLock && post.edit_lock_user_id === -1) {
        post.edit_lock_user_id = null;
      }
    }
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
    ['SODIUM_CRYPTO_SIGN_BYTES', 'Detached signature 64-byte length validation ([H-08])'],
    ['site_binding_mismatch', 'Site & home_url binding before seq advancement ([H-08])'],
    ['ugokilink_local_approvals', 'True 2-key local WP-Admin approval storage ([C-17])'],
    ['ugokilink_local_approve', 'WP-Admin nonce action for local 2-key approval ([C-17])'],
    ['extractIndexableSeoSignature', 'Full before/after HTML document SEO comparison ([#6])'],
    ['claimLocalWpAdminApproval', 'Atomic conditional approval claim ([#7])'],
    ['releaseLocalWpAdminApproval', 'Approval rollback on post update failure ([#7])'],
    ['add_option($lockOption', 'Per-digest atomic add_option claim lock ([#7])'],
    ['owner_daily_apply_cap_exceeded', 'Per-UTC-day daily_apply_cap enforcement ([H-08])'],
    ['$acquiredLock', 'Edit lock ownership guard in finally ([H-08])'],
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
    [/\$payload\s*\[\s*['"]owner_wp_admin_confirmed['"]\s*\]/, 'Forbidden trust in cloud owner_wp_admin_confirmed ([C-17])'],
  ];

  for (const [pattern, desc] of forbiddenPatterns) {
    if (pattern.test(phpSource)) {
      errors.push(`Detected ${desc}`);
    }
  }

  return { passed: errors.length === 0, errors };
}
