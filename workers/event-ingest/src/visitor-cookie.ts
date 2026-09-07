/**
 * visitor_id (`__ugk_vid`) の第一者 Set-Cookie 化 — 純関数モジュール
 *
 * 設計書: docs/tracking/FIRST_PARTY_VID_DESIGN_2026-08-16.md (v3) §3-1
 *
 * 背景: `__ugk_vid` は tracking.js が document.cookie で発行しており、Safari ITP により
 * 実質7日で失効する。顧客サイトのパスプロキシ (同一オリジン) 経由で Worker が同名・
 * 同スコープ (host-only, Path=/) の Set-Cookie を返すと、既存 Cookie がサーバー発行に
 * 置換され ITP 免除へ昇格する (値は変わらないため識別子の連続性は保たれる)。
 *
 * このモジュールは I/O を持たず、handler (worker.ts) から呼ばれる。
 * テスト: test/visitor-cookie.test.mjs (Node 24 の TS type-stripping で直接 import)。
 *
 * セキュリティ上の不変条件 (設計書 §3-1 / §4):
 *   - Cookie 由来値・payload 由来値の**両方**を同一 regex で検証する。payload は Origin
 *     検証も認証も無い公開 POST から誰でも送れるため、無検証で Set-Cookie に書くと
 *     Cookie 属性注入 (`;` 等) や任意 ID の固定化に直結する
 *   - 同名 Cookie が複数届いた場合は Cookie 由来値を採用しない (優先順が環境依存で、
 *     cookie tossing の吸収口でもある)
 *   - Domain 属性は付けない (host-only)。付けると既存 JS Cookie と別 Cookie として
 *     共存し、同名置換 (昇格) が成立しない
 *   - HttpOnly は付けない (scenario-runtime.js が document.cookie から読む)
 *   - SameSite=Lax を None に緩めない (cross-site からの Cookie 付き偽造の唯一の防御)
 *   - **Cookie 由来 vid の採用と Set-Cookie 発行は「第一者束縛」が成立した場合のみ**
 *     (v4、Codex round2 HIGH): Lax は same-site (兄弟サブドメイン) からの送信を防がない。
 *     攻撃者が顧客の兄弟サブドメインから顧客プロキシへ「攻撃者自身の site_id/tenant_id」を
 *     送ると、被害者の Cookie が同乗し、Worker が被害者 vid を攻撃者テナントの行に書く。
 *     対策 = isFirstPartyBound: (1) Sec-Fetch-Site: same-origin (ブラウザ付与、ページ JS から
 *     偽装不可、same-site を除外) かつ (2) プロキシが転送した元ホスト == payload の site が
 *     登録しているホスト、かつ (3) accepted events が単一 site_id。
 */

export const VISITOR_ID_COOKIE = '__ugk_vid';

/** Cookie 値・payload 値の共通形式。tracking.js の _genId() 出力 (UUID 系) を包含する。 */
export const VISITOR_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** 400 日 (rfc6265bis の Max-Age 上限)。 */
export const VISITOR_ID_MAX_AGE_SEC = 34_560_000;

export type VisitorIdSource = 'cookie' | 'payload' | 'mint';

export function isValidVisitorId(value: unknown): value is string {
  return typeof value === 'string' && VISITOR_ID_RE.test(value);
}

export interface ParsedVisitorIdCookie {
  /** 検証パス済みの単一値。欠落 / 重複 / 不正形式はすべて null。 */
  value: string | null;
  /** 同名 Cookie が 2 個以上あった (cookie tossing 等) */
  duplicate: boolean;
  /** 同名 Cookie は 1 個だったが形式不正だった */
  invalid: boolean;
}

/**
 * Cookie リクエストヘッダから `__ugk_vid` を取り出す。
 * 値は検証済みのものだけ返す。ヘッダの生値は呼び元も含め一切ログしないこと。
 */
export function parseVisitorIdCookie(cookieHeader: string | null | undefined): ParsedVisitorIdCookie {
  if (!cookieHeader) return { value: null, duplicate: false, invalid: false };

  const found: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== VISITOR_ID_COOKIE) continue;
    found.push(part.slice(eq + 1).trim());
  }

  if (found.length === 0) return { value: null, duplicate: false, invalid: false };
  if (found.length > 1) return { value: null, duplicate: true, invalid: false };

  const raw = found[0];
  if (!isValidVisitorId(raw)) return { value: null, duplicate: false, invalid: true };
  return { value: raw, duplicate: false, invalid: false };
}

export interface CanonicalVisitorId {
  vid: string;
  source: VisitorIdSource;
}

/**
 * 正準 visitor_id の決定 (設計書 §3-1 step 3)。優先順:
 *   1. Cookie の `__ugk_vid` (単一・検証パス)
 *   2. payload の `visitor_id` (検証パス) — 既存 JS 発行値の移行時連続性を担保
 *   3. 新規 mint
 * どのソースの値も検証を通らなければ採用しない。
 */
export function resolveCanonicalVisitorId(input: {
  cookieHeader: string | null | undefined;
  payloadVisitorId: unknown;
  mint?: () => string;
}): CanonicalVisitorId {
  const fromCookie = parseVisitorIdCookie(input.cookieHeader);
  if (fromCookie.value !== null) return { vid: fromCookie.value, source: 'cookie' };

  if (isValidVisitorId(input.payloadVisitorId)) {
    return { vid: input.payloadVisitorId, source: 'payload' };
  }

  const mint = input.mint ?? (() => crypto.randomUUID());
  return { vid: mint(), source: 'mint' };
}

/**
 * Set-Cookie ヘッダ値。属性は tracking.js の JS 発行 Cookie と同スコープ
 * (host-only / Path=/ / SameSite=Lax / Secure) に揃え、同名置換が成立するようにする。
 * `vid` は呼び元で検証済みであることが前提だが、防御的にここでも検証し、
 * 不正なら例外にする (属性注入の最終防御)。
 */
export function buildVisitorIdSetCookie(vid: string): string {
  if (!isValidVisitorId(vid)) {
    throw new Error('buildVisitorIdSetCookie: vid failed format validation');
  }
  return (
    `${VISITOR_ID_COOKIE}=${vid}` +
    `; Max-Age=${VISITOR_ID_MAX_AGE_SEC}` +
    '; Path=/' +
    '; Secure' +
    '; SameSite=Lax'
  );
}

/**
 * accepted events から payload 側の visitor_id 候補を 1 つ選ぶ (最初の検証パス値)。
 * 1 リクエストは 1 ブラウザ由来なので通常は全イベント同一値。
 */
export function pickPayloadVisitorId(events: ReadonlyArray<Record<string, unknown>>): string | null {
  for (const e of events) {
    if (isValidVisitorId(e.visitor_id)) return e.visitor_id;
  }
  return null;
}

// ── 第一者束縛 (v4、Codex round2 HIGH 対応) ─────────────────────────

/**
 * ホスト名の正準化: 小文字化・ポート除去・末尾ドット除去・IDN は punycode 化。
 * 不正な値は null。`URL` を経由することで検証も兼ねる。
 */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length === 0 || s.length > 253) return null;
  let hostname: string;
  try {
    hostname = new URL('https://' + s).hostname;
  } catch {
    return null;
  }
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(h)) return null;
  return h;
}

/** sites.url (例 "https://customer.com/") から登録ホストを得る。 */
export function hostFromUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    return normalizeHost(new URL(raw).hostname);
  } catch {
    return null;
  }
}

/**
 * プロキシが転送した元ホスト。`X-Forwarded-Host` は多段プロキシで "a, b" になりうるため
 * 先頭 (最初にリクエストを受けたホスト) を採用する。
 */
export function firstForwardedHost(header: string | null | undefined): string | null {
  if (!header) return null;
  const first = header.split(',')[0];
  return normalizeHost(first);
}

/** accepted events の site_id が単一ならそれを返す。混在・欠落は null (束縛しない)。 */
export function pickSingleSiteId(events: ReadonlyArray<Record<string, unknown>>): string | null {
  let siteId: string | null = null;
  for (const e of events) {
    if (typeof e.site_id !== 'string' || e.site_id.length === 0) return null;
    if (siteId === null) siteId = e.site_id;
    else if (siteId !== e.site_id) return null;
  }
  return siteId;
}

export interface FirstPartyBindingInput {
  /** ブラウザ付与の Fetch Metadata。ページ JS からは偽装不可。プロキシが転送する必要あり。 */
  secFetchSite: string | null | undefined;
  /** プロキシが転送した元ホスト (X-Forwarded-Host)。 */
  forwardedHost: string | null | undefined;
  /** payload の site_id が sites テーブルに登録しているホスト (hostFromUrl)。null = 不明。 */
  registeredHost: string | null;
}

/**
 * Cookie 由来 vid を採用し Set-Cookie を返してよいか。
 *
 * 全条件を満たす場合のみ true:
 *   1. Sec-Fetch-Site === 'same-origin' — 送信元ページとリクエスト先が同一オリジン。
 *      兄弟サブドメイン (same-site) や cross-site は除外。ヘッダ欠落 (旧ブラウザ / プロキシが
 *      転送しない) も除外 = fail closed
 *   2. 転送元ホストと登録ホストが正準化後に完全一致
 *   3. 登録ホストが解決できている
 *
 * false の場合、呼び元は payload の visitor_id をそのまま流し、Set-Cookie を返さない
 * (被害者 Cookie の上書き = 固定化も起きない)。同一オリジンの任意スクリプトは
 * document.cookie を直接読めるため、同一オリジンが原理的な信頼境界であり、
 * この判定はその境界に一致させたもの。
 */
export function isFirstPartyBound(input: FirstPartyBindingInput): boolean {
  if (input.secFetchSite !== 'same-origin') return false;
  if (input.registeredHost === null) return false;
  const forwarded = firstForwardedHost(input.forwardedHost);
  if (forwarded === null) return false;
  return forwarded === input.registeredHost;
}
