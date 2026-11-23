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
export const DEFAULT_WP_PENDING_COMMAND_LEASE_MS = 30_000;

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

export interface WpPendingCommandJournalRecord {
  readonly command_seq: number;
  readonly post_id: number;
  readonly approval_digest: string | null;
  readonly claim_token: string | null;
  readonly expected_after_sha256: string;
  readonly prev_seq: number;
  readonly lease_token: string;
  readonly lease_expires_at_ms: number;
  status: 'in_progress';
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
 * Quote-aware HTML attribute parser (`[#6]`):
 * Properly tracks single- and double-quoted attribute values so `>` inside quotes never
 * terminates a tag or splits an attribute value. Returns `{ ok: false }` on malformed/unclosed quotes.
 */
function parseHtmlAttributesQuoteAware(rawAttrs: string): {
  readonly ok: boolean;
  readonly attrs: ReadonlyMap<string, string>;
  readonly canonical: string;
} {
  const attrs = new Map<string, string>();
  const parts: string[] = [];
  const len = rawAttrs.length;
  let i = 0;

  while (i < len) {
    while (i < len && (rawAttrs[i] === ' ' || rawAttrs[i] === '\t' || rawAttrs[i] === '\n' || rawAttrs[i] === '\r' || rawAttrs[i] === '/')) {
      i += 1;
    }
    if (i >= len) break;

    const nameStart = i;
    while (
      i < len &&
      rawAttrs[i] !== '=' &&
      rawAttrs[i] !== ' ' &&
      rawAttrs[i] !== '\t' &&
      rawAttrs[i] !== '\n' &&
      rawAttrs[i] !== '\r' &&
      rawAttrs[i] !== '/' &&
      rawAttrs[i] !== '>'
    ) {
      if (rawAttrs[i] === '"' || rawAttrs[i] === "'" || rawAttrs[i] === '<') {
        return { ok: false, attrs, canonical: '' };
      }
      i += 1;
    }
    const name = rawAttrs.slice(nameStart, i).toLowerCase();
    if (!name) {
      return { ok: false, attrs, canonical: '' };
    }

    while (i < len && (rawAttrs[i] === ' ' || rawAttrs[i] === '\t' || rawAttrs[i] === '\n' || rawAttrs[i] === '\r')) {
      i += 1;
    }

    let value = '';
    if (i < len && rawAttrs[i] === '=') {
      i += 1;
      while (i < len && (rawAttrs[i] === ' ' || rawAttrs[i] === '\t' || rawAttrs[i] === '\n' || rawAttrs[i] === '\r')) {
        i += 1;
      }
      if (i >= len) {
        return { ok: false, attrs, canonical: '' };
      }
      const ch = rawAttrs[i];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i += 1;
        const valStart = i;
        while (i < len && rawAttrs[i] !== quote) {
          i += 1;
        }
        if (i >= len) {
          // Unclosed quoted attribute value -> fail closed
          return { ok: false, attrs, canonical: '' };
        }
        value = rawAttrs.slice(valStart, i);
        i += 1; // consume closing quote
      } else {
        const valStart = i;
        while (
          i < len &&
          rawAttrs[i] !== ' ' &&
          rawAttrs[i] !== '\t' &&
          rawAttrs[i] !== '\n' &&
          rawAttrs[i] !== '\r' &&
          rawAttrs[i] !== '>'
        ) {
          if (rawAttrs[i] === '"' || rawAttrs[i] === "'" || rawAttrs[i] === '<') {
            return { ok: false, attrs, canonical: '' };
          }
          i += 1;
        }
        value = rawAttrs.slice(valStart, i);
      }
    }

    if (!attrs.has(name)) {
      attrs.set(name, value);
    }
    parts.push(`${name}="${value.trim().replace(/\s+/g, ' ')}"`);
  }

  return { ok: true, attrs, canonical: parts.join(' ') };
}

function findClosingTagQuoteAware(
  html: string,
  tagName: string,
  fromIndex: number
): { readonly contentEnd: number; readonly tagEnd: number } | null {
  const re = new RegExp(`<\\s*\\/\\s*${tagName}\\s*>`, 'gi');
  re.lastIndex = fromIndex;
  const m = re.exec(html);
  if (!m) return null;
  return { contentEnd: m.index, tagEnd: m.index + m[0].length };
}

/**
 * Quote-aware HTML tag/attribute scanner extracting canonical indexable SEO nodes from a FULL HTML
 * document (`[#6]`): `<h1>`, `<title>`, `<meta>`, `<link rel="canonical">`, `<a href>` (href/rel),
 * and `<script type="application/ld+json">`.
 *
 * Returns `null` if HTML is unparseable or contains unclosed tags/quotes/comments/blocks so callers
 * FAIL CLOSED by requiring local WP 2-key approval!
 * Mirrors `UgokiLink_Companion_Plugin::extractIndexableSeoSignature` 1:1.
 */
export function extractIndexableSeoSignature(html: string): string | null {
  const parts: string[] = [];
  const len = html.length;
  let i = 0;

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;

    // HTML comment <!-- ... -->
    if (html.startsWith('<!--', lt)) {
      const commentEnd = html.indexOf('-->', lt + 4);
      if (commentEnd === -1) return null;
      i = commentEnd + 3;
      continue;
    }

    // Declaration / PI (<!DOCTYPE ...> or <?...?>)
    if (lt + 1 < len && (html[lt + 1] === '!' || html[lt + 1] === '?')) {
      let j = lt + 2;
      let q: '"' | "'" | null = null;
      while (j < len) {
        const ch = html[j];
        if (q !== null) {
          if (ch === q) q = null;
        } else if (ch === '"' || ch === "'") {
          q = ch;
        } else if (ch === '>') {
          break;
        }
        j += 1;
      }
      if (j >= len || q !== null) return null;
      i = j + 1;
      continue;
    }

    // Parse optional whitespace, optional '/', then ASCII tag name
    let p = lt + 1;
    while (p < len && (html[p] === ' ' || html[p] === '\t' || html[p] === '\n' || html[p] === '\r')) {
      p += 1;
    }
    const isClosing = p < len && html[p] === '/';
    if (isClosing) {
      p += 1;
      while (p < len && (html[p] === ' ' || html[p] === '\t' || html[p] === '\n' || html[p] === '\r')) {
        p += 1;
      }
    }

    const nameStart = p;
    if (p < len && /[a-zA-Z]/.test(html[p])) {
      p += 1;
      while (p < len && /[a-zA-Z0-9:-]/.test(html[p])) {
        p += 1;
      }
    } else {
      // Bare '<' in text content (not a tag)
      i = lt + 1;
      continue;
    }

    const tagName = html.slice(nameStart, p).toLowerCase();

    // Must be followed by whitespace, '/', or '>' (otherwise bare '<' in text, or EOF = unclosed tag)
    if (p >= len) return null;
    const afterName = html[p];
    if (
      afterName !== '>' &&
      afterName !== '/' &&
      afterName !== ' ' &&
      afterName !== '\t' &&
      afterName !== '\n' &&
      afterName !== '\r'
    ) {
      i = lt + 1;
      continue;
    }

    // Scan to unquoted closing '>' tracking single/double quotes!
    const attrStart = p;
    let j = p;
    let quote: '"' | "'" | null = null;
    while (j < len) {
      const ch = html[j];
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j += 1;
    }
    if (j >= len || quote !== null) {
      // Unclosed tag or unclosed attribute quote -> fail closed!
      return null;
    }

    if (isClosing) {
      i = j + 1;
      continue;
    }

    let rawAttrs = html.slice(attrStart, j).trim();
    if (
      rawAttrs === '/' ||
      (rawAttrs.length >= 2 &&
        rawAttrs.endsWith('/') &&
        /[ \t\n\r]/.test(rawAttrs[rawAttrs.length - 2]))
    ) {
      rawAttrs = rawAttrs.slice(0, -1).trim();
    }
    const parsedAttrs = parseHtmlAttributesQuoteAware(rawAttrs);
    if (!parsedAttrs.ok) {
      return null;
    }

    if (tagName === 'h1' || tagName === 'title') {
      const close = findClosingTagQuoteAware(html, tagName, j + 1);
      if (!close) return null;
      const body = html.slice(j + 1, close.contentEnd).trim().replace(/\s+/g, ' ');
      parts.push(`${tagName}[${parsedAttrs.canonical}]=${body}`);
      i = close.tagEnd;
      continue;
    }

    if (tagName === 'meta') {
      parts.push(`meta[${parsedAttrs.canonical}]`);
      i = j + 1;
      continue;
    }

    if (tagName === 'link') {
      const rel = parsedAttrs.attrs.get('rel') ?? '';
      if (/\bcanonical\b/i.test(rel)) {
        parts.push(`link_canonical[${parsedAttrs.canonical}]`);
      }
      i = j + 1;
      continue;
    }

    if (tagName === 'a') {
      const href = (parsedAttrs.attrs.get('href') ?? '').trim();
      const rel = (parsedAttrs.attrs.get('rel') ?? '').trim();
      if (href !== '') {
        parts.push(`a[href=${href};rel=${rel}]`);
      }
      i = j + 1;
      continue;
    }

    if (tagName === 'script') {
      const close = findClosingTagQuoteAware(html, 'script', j + 1);
      if (!close) return null;
      const type = (parsedAttrs.attrs.get('type') ?? '').trim().toLowerCase();
      if (type === 'application/ld+json') {
        const body = html.slice(j + 1, close.contentEnd).trim().replace(/\s+/g, ' ');
        parts.push(`ld_json=${body}`);
      }
      i = close.tagEnd;
      continue;
    }

    i = j + 1;
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
  /** Mirrors `wp_options['ugk_pending_command_journal']` for crash-safe approval reconciliation (`[#7]`). */
  private readonly pendingCommandJournal = new Map<number, WpPendingCommandJournalRecord>();
  private claimTokenSeq = 0;
  private leaseTokenSeq = 0;
  private postUpdateHook?: (post: WpPostRecord, nextContent: string) => Promise<void> | void;
  private afterPostUpdateBeforeCommitHook?: (post: WpPostRecord, nextContent: string) => Promise<void> | void;
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

  public setAfterPostUpdateBeforeCommitHook(
    hook?: (post: WpPostRecord, nextContent: string) => Promise<void> | void
  ): void {
    this.afterPostUpdateBeforeCommitHook = hook;
  }

  public getPendingCommandJournal(): readonly WpPendingCommandJournalRecord[] {
    return Array.from(this.pendingCommandJournal.values()).map((r) => ({ ...r }));
  }

  /**
   * Reconciles expired `in_progress` pending-command journal entries left behind by a crash between
   * `wp_update_post` and approval commit (`[#7]`):
   * - If an `in_progress` entry's lease is STILL ACTIVE (`nowMs < lease_expires_at_ms`), DO NOT roll
   *   it back or release its approval; return `{ blockedByInFlight: true }` so concurrent callers fail
   *   closed with HTTP `409 command_in_flight`.
   * - For expired leases (`nowMs >= lease_expires_at_ms`):
   *   - If `sha256(post.content) === expected_after_sha256`, finishes committing `claimed -> consumed`
   *     and clears the journal entry so the approval can never be reused.
   *   - Otherwise releases `claimed -> unused`, conditionally rolls back `lastSeq` ONLY if
   *     `this.lastSeq === entry.command_seq` (CAS — never clobbering a concurrent newer `seq`), and
   *     clears the journal entry.
   */
  public async reconcilePendingCommands(nowMs = Date.now()): Promise<{
    readonly blockedByInFlight: boolean;
    readonly reconciledCount: number;
  }> {
    if (this.pendingCommandJournal.size === 0) {
      return { blockedByInFlight: false, reconciledCount: 0 };
    }

    let blockedByInFlight = false;
    let reconciledCount = 0;

    for (const [cmdSeq, entry] of Array.from(this.pendingCommandJournal.entries())) {
      if (entry.status !== 'in_progress') continue;
      if (entry.lease_expires_at_ms > 0 && nowMs < entry.lease_expires_at_ms) {
        blockedByInFlight = true;
        continue;
      }

      const post = this.posts.get(entry.post_id);
      const currentSha = post ? await sha256Hex(post.content) : null;

      if (currentSha !== null && currentSha === entry.expected_after_sha256) {
        if (entry.approval_digest && entry.claim_token) {
          this.commitLocalWpAdminApproval(entry.approval_digest, entry.claim_token);
        }
      } else {
        if (entry.approval_digest && entry.claim_token) {
          this.releaseLocalWpAdminApproval(entry.approval_digest, entry.claim_token);
        }
        if (this.lastSeq === entry.command_seq) {
          this.lastSeq = entry.prev_seq;
        }
      }

      this.pendingCommandJournal.delete(cmdSeq);
      reconciledCount += 1;
    }

    return { blockedByInFlight, reconciledCount };
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
    // 0. [#7] Reconcile expired pending-command journal records; reject concurrent requests while an active lease is in flight
    const reconcile = await this.reconcilePendingCommands(nowMs);
    if (reconcile.blockedByInFlight) {
      return { status: 409, ok: false, error: 'command_in_flight' };
    }

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
      // Compare FULL before/after HTML documents using quote-aware HTML scanning (fail-closed if null!).
      const changeClass = p.change_class ?? '';
      const beforeSeoSig = extractIndexableSeoSignature(post.content);
      const afterSeoSig = extractIndexableSeoSignature(newContent);
      const seoChangedInFullDoc =
        beforeSeoSig === null || afterSeoSig === null || beforeSeoSig !== afterSeoSig;
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

      // [#7] Write recoverable pending-command journal record with active lease BEFORE wp_update_post
      this.leaseTokenSeq += 1;
      this.pendingCommandJournal.set(p.seq, {
        command_seq: p.seq,
        post_id: postId,
        approval_digest: claimedApprovalDigest,
        claim_token: claimedApprovalToken,
        expected_after_sha256: postImageSha,
        prev_seq: prevSeq,
        lease_token: `lease_${p.seq}_${this.leaseTokenSeq}`,
        lease_expires_at_ms: nowMs + DEFAULT_WP_PENDING_COMMAND_LEASE_MS,
        status: 'in_progress',
      });

      try {
        if (this.postUpdateHook) {
          await this.postUpdateHook({ ...post }, newContent);
        }
        post.content = newContent;
        post.modified_gmt = new Date(nowMs).toISOString();
      } catch {
        // [#7] Roll back claimed approval to `unused`, conditionally CAS-rollback seq, and clear journal
        if (claimedApprovalDigest && claimedApprovalToken) {
          this.releaseLocalWpAdminApproval(claimedApprovalDigest, claimedApprovalToken);
        }
        if (this.lastSeq === p.seq) {
          this.lastSeq = prevSeq;
        }
        this.pendingCommandJournal.delete(p.seq);
        return { status: 500, ok: false, error: 'wp_update_post_failed' };
      }

      // Optional test hook to simulate a process crash AFTER post update and BEFORE approval commit
      if (this.afterPostUpdateBeforeCommitHook) {
        await this.afterPostUpdateBeforeCommitHook({ ...post }, newContent);
      }

      // [#7] Commit claimed approval (`claimed` -> `consumed`) ONLY after post update succeeds, then clear journal
      if (claimedApprovalDigest && claimedApprovalToken) {
        this.commitLocalWpAdminApproval(claimedApprovalDigest, claimedApprovalToken);
      }
      this.pendingCommandJournal.delete(p.seq);

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
    ['parseHtmlAttributesQuoteAware', 'Quote-aware HTML tag/attribute scanner ([#6])'],
    ['claimLocalWpAdminApproval', 'Atomic conditional approval claim ([#7])'],
    ['releaseLocalWpAdminApproval', 'Approval rollback on post update failure ([#7])'],
    ['reconcilePendingCommands', 'Recoverable pending-command journal reconciliation ([#7])'],
    ['OPTION_PENDING_JOURNAL', 'Pending-command journal option storage ([#7])'],
    ['lease_expires_at_ms', 'Active in-flight command lease expiration timestamp ([#7])'],
    ['lease_token', 'Active in-flight command lease token ([#7])'],
    ['command_in_flight', 'HTTP 409 command_in_flight rejection while lease is active ([#7])'],
    ['WHERE option_name = %s AND option_value = %s', 'Single atomic conditional SQL seq rollback ([#7])'],
    ['wp_cache_delete', 'Options cache invalidation after atomic conditional SQL seq rollback ([#7])'],
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
