/**
 * UGOKI MAP / LINKTH SaaS — Event Ingest Worker
 *
 * Cloudflare Workers edge endpoint for tracking events.
 * Receives events from tracking.js, resolves tenant_id, buffers them,
 * and batch-inserts into ClickHouse.
 *
 * Flow:
 *   tracking.js → POST /api/track → Worker (resolveTenant → buffer) → ClickHouse HTTP INSERT
 *
 * 履歴:
 *   - B-2 Step 1-5 (Infra 続 16): ugokimap → ugokimap-saas 流用 + tenant_id 統合 + resolveTenant + audit_events
 *   - HIGH 4 件修正 (Infra 続 19、Reviewer 続 12 起票):
 *       H-1 jwt-exp-optional-perpetual    : verifyJwtHs256 で exp 必須 numeric + nbf/iat 検証
 *       H-2 clickhouse-creds-in-query     : URL query から user/password 排除、Authorization: Basic ヘッダに切替
 *       H-3 legacy-tenant-not-normalized  : normalizeTenantId (NFKC + trim + lowercase + allowlist regex)
 *       H-4 audit-burst-subrequest-limit  : payload events 上限 50 + request-local dedupe + negative cache + audit batch
 *   - MEDIUM 修正 同時統合: M-1 pickColumns tenant_id INSERT-境界 assert / M-3 parseClickHouseUrl URL parser
 */

export interface Env {
  // ClickHouse access
  CLICKHOUSE_URL: string;        // e.g., http://user:pass@host:port (secret 経由)
  CLICKHOUSE_DB: string;          // 'clickinsight'
  ALLOWED_ORIGINS: string;        // '*' or comma-separated
  BATCH_SIZE: string;             // unused in current impl, reserved
  FLUSH_INTERVAL_MS: string;      // unused in current impl, reserved

  // tenant resolution (B-2 Step 3)
  MAGIC_LINK_SECRET: string;      // shared with ugokimap-saas/lib/auth/magic-link.ts (HS256)
  // 注意: SITES_KV (Cloudflare KV) は Phase 2 で追加 (Fix-5)、Phase 1 は in-memory cache 流用
}

// ── H-4 限界値 ──────────────────────────────────────────────────────

/** payload.events 上限。Cloudflare Workers Free=50 sub-req、Paid=10k、waitUntil=30s total */
const MAX_EVENTS_PER_REQUEST = 50;

// ── Event type → table routing ──────────────────────────────────────

const BEHAVIOR_TYPES = new Set([
  'text_copy', 'scroll_reversal', 'tab_return',
  'browser_back', 'pinch_zoom', 'cta_hover',
]);

const FORM_TYPES = new Set([
  'form_view', 'form_field_focus', 'form_field_blur',
  'form_submit', 'form_abandon',
]);

const VIDEO_TYPES = new Set([
  'video_play', 'video_pause', 'video_complete',
  'video_milestone', 'video_summary',
]);

// ── ClickHouse column definitions per table ─────────────────────────
//
// B-2 Fix-1: 全 9 配列の先頭に 'tenant_id' を追加。
// ClickHouse INSERT FORMAT JSONEachRow 経路で routeEvent 後段の pickColumns が
// tenant_id を保持できるようにする (resolveTenant で event.tenant_id を注入済前提)。

const EVENTS_COLUMNS = [
  'tenant_id',
  'id', 'site_id', 'session_id', 'user_id', 'event_type', 'timestamp',
  'url', 'referrer', 'user_agent', 'viewport_width', 'viewport_height',
  'element_tag_name', 'element_id', 'element_class_name', 'element_text',
  'element_href', 'click_x', 'click_y', 'scroll_y', 'scroll_percentage',
  'read_y', 'read_duration', 'event_revenue',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'conversion_type', 'conversion_value',
  'search_query', 'device_type', 'ga_client_id', 'external_id',
  'element_selector', 'sequence_id',
  'previous_url', 'navigation_trigger',
  'is_agent', 'agent_type', 'agent_signals',
  'http_user_agent_raw', 'http_accept', 'http_accept_language',
  'http_accept_encoding', 'http_range', 'http_if_modified_since',
  'http_sec_fetch_site', 'http_sec_fetch_mode', 'http_sec_fetch_dest',
  'http_sec_fetch_user', 'http_referer',
] as const;

const BEHAVIOR_COLUMNS = [
  'tenant_id',
  'id', 'site_id', 'session_id', 'page_url', 'event_type',
  'copied_text', 'copied_length', 'copy_y',
  'reversal_count', 'final_scroll_y',
  'away_duration_ms', 'tab_switch_count', 'return_scroll_y',
  'from_url', 'scroll_y_at_back', 'scroll_depth_at_back',
  'zoom_scale', 'zoom_y', 'target_tag', 'target_src', 'target_alt',
  'pinch_zoom_count', 'hover_duration_ms', 'hover_y', 'hover_clicked',
  'element_path', 'element_text', 'device_type',
] as const;

const IMAGE_VISIBILITY_COLUMNS = [
  'tenant_id',
  'id', 'site_id', 'session_id', 'page_url',
  'image_src', 'image_alt', 'image_width', 'image_height',
  'visible_duration_ms', 'max_visible_ratio',
  'viewport_position', 'element_y', 'device_type',
] as const;

const FORM_COLUMNS = [
  'tenant_id',
  'id', 'site_id', 'session_id', 'page_url', 'event_type',
  'form_id', 'form_action', 'form_method',
  'field_name', 'field_type', 'field_label',
  'focus_duration_ms', 'field_order', 'total_fields',
  'filled_fields', 'time_to_submit_ms', 'device_type',
] as const;

const VIDEO_COLUMNS = [
  'tenant_id',
  'id', 'site_id', 'session_id', 'page_url', 'event_type',
  'video_src', 'video_title', 'video_duration',
  'current_time', 'progress_percent',
  'play_count', 'pause_count', 'total_watch_time_ms',
  'milestone', 'device_type',
] as const;

const ELEMENT_VISIBILITY_COLUMNS = [
  'tenant_id',
  'id', 'site_id', 'session_id', 'page_url',
  'element_selector', 'element_tag', 'element_text', 'element_y',
  'visible_duration_ms', 'max_visible_ratio',
  'element_clicked', 'device_type',
] as const;

const SCROLL_TIMELINE_COLUMNS = [
  'tenant_id',
  'site_id', 'session_id', 'page_url', 'timestamp',
  'scroll_y', 'scroll_percentage', 'viewport_height',
  'direction', 'speed', 'dwell_ms', 'device_type',
] as const;

const ELEMENT_VISIBILITY_V2_COLUMNS = [
  'tenant_id',
  'id', 'site_id', 'session_id', 'page_url',
  'element_selector', 'element_tag', 'element_text', 'element_href',
  'element_y', 'visible_duration_ms', 'max_visible_ratio',
  'first_visible_at', 'element_clicked',
  'is_cta', 'is_above_fold', 'device_type', 'viewport_height',
] as const;

const WEB_VITALS_COLUMNS = [
  'tenant_id',
  'id', 'site_id', 'session_id', 'page_url',
  'lcp_ms', 'lcp_element', 'cls_score', 'inp_ms',
  'ttfb_ms', 'fcp_ms', 'connection_type', 'downlink_mbps',
  'rtt_ms', 'device_type',
] as const;

// ── Routing logic ───────────────────────────────────────────────────

interface RouteTarget {
  table: string;
  columns: readonly string[];
}

function routeEvent(eventType: string): RouteTarget {
  if (BEHAVIOR_TYPES.has(eventType)) {
    return { table: 'behavior_signals', columns: BEHAVIOR_COLUMNS };
  }
  if (eventType === 'image_visibility') {
    return { table: 'image_visibility', columns: IMAGE_VISIBILITY_COLUMNS };
  }
  if (FORM_TYPES.has(eventType)) {
    return { table: 'form_interactions', columns: FORM_COLUMNS };
  }
  if (VIDEO_TYPES.has(eventType)) {
    return { table: 'video_events', columns: VIDEO_COLUMNS };
  }
  if (eventType === 'element_visibility') {
    return { table: 'element_visibility', columns: ELEMENT_VISIBILITY_COLUMNS };
  }
  if (eventType === 'scroll_timeline') {
    return { table: 'scroll_timeline', columns: SCROLL_TIMELINE_COLUMNS };
  }
  if (eventType === 'element_visibility_v2') {
    return { table: 'element_visibility_v2', columns: ELEMENT_VISIBILITY_V2_COLUMNS };
  }
  if (eventType === 'web_vitals') {
    return { table: 'web_vitals', columns: WEB_VITALS_COLUMNS };
  }
  return { table: 'events', columns: EVENTS_COLUMNS };
}

// ── H-3: tenant_id 正規化 (NFKC + trim + lowercase + allowlist) ─────

/**
 * normalizeTenantId: tenant_id を canonical 形式に正規化し、allowlist に照合
 *
 * 攻撃面:
 *   - '__LEGACY__' (case 変動) / '__legacy__ ' (trailing space) /
 *     '＿＿legacy...' (NFKC 等価文字、全角アンダースコア) / null byte 混入 → bypass
 *
 * 戻り値:
 *   - string : canonical 化された tenant_id (Unicode NFKC + trim + lowercase)
 *   - null   : allowlist regex に違反 (空文字 / 長すぎ / 不正文字 / null byte 等)
 */
function normalizeTenantId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // null byte / control char を含む文字列は即拒否 (Unicode normalize でも消えない)
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  // NFKC 等価変換 (全角 / 半角 / 互換文字を統一)
  const normalized = raw.normalize('NFKC').trim().toLowerCase();
  // allowlist: 英数 + アンダースコア + ハイフン、1-64 文字
  if (!/^[a-z0-9_-]{1,64}$/.test(normalized)) return null;
  return normalized;
}

/** `__legacy__` 等の予約 tenant_id を新規流入で拒否するための sentinel set */
const RESERVED_LEGACY_TENANTS = new Set<string>(['__legacy__']);

// ── Codex B-4 §6 SSOT: tenant resolution ────────────────────────────

type DropReason =
  | 'jwt_invalid'
  | 'tenant_id_missing'
  | 'site_id_missing'
  | 'site_tenant_mismatch'
  | 'legacy_tenant_blocked'
  | 'payload_too_large';   // H-4: events > MAX_EVENTS_PER_REQUEST

interface TenantResolution {
  ok: true;
  tenant_id: string;
  source: 'jwt' | 'tracking_js';
}
interface TenantRejection {
  ok: false;
  reason: DropReason;
  detail: string;
}

// ── H-4: in-memory cache for sites lookup (with negative caching) ───

/**
 * Cloudflare Workers の isolate は短命だが、同一 isolate 内では維持される。
 * Phase 1 dogfood 規模 (5-10 サイト) では十分。Phase 2 で Workers KV / D1 に移行 (Fix-5)。
 *
 * H-4: negative cache 追加。未登録 site_id を ttl 5min cache し、burst attack で
 * 100 unique unregistered site_id が来ても lookup は最大 100 → 0/ttl 後 100 で済む。
 */
interface CacheEntry {
  tenant_id: string | null;   // null = negative cache (未登録 site)
  expires_at: number;
}
const SITE_TENANT_CACHE = new Map<string, CacheEntry>();
const SITE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分

function cacheLookup(site_id: string): { hit: false } | { hit: true; tenant_id: string | null } {
  const entry = SITE_TENANT_CACHE.get(site_id);
  if (!entry) return { hit: false };
  if (Date.now() > entry.expires_at) {
    SITE_TENANT_CACHE.delete(site_id);
    return { hit: false };
  }
  return { hit: true, tenant_id: entry.tenant_id };
}

function cacheStore(site_id: string, tenant_id: string | null): void {
  SITE_TENANT_CACHE.set(site_id, {
    tenant_id,
    expires_at: Date.now() + SITE_CACHE_TTL_MS,
  });
}

// ── M-3 + H-2: ClickHouse URL / credential parsing ──────────────────

/**
 * Parse CLICKHOUSE_URL using WHATWG URL parser (M-3 regex 脆弱性修正)
 * Returns { baseUrl, authHeader } — credentials は **絶対に URL query に乗せない** (H-2)
 *
 * Accepts forms:
 *   - http://user:pass@host:port/    → Basic Auth ヘッダ生成
 *   - http://host:port/              → default user / empty password
 */
function parseClickHouseEnv(raw: string): { baseUrl: string; authHeader: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // 解析失敗時は raw を baseUrl 扱い、default user
    return { baseUrl: raw, authHeader: 'Basic ' + btoa('default:') };
  }
  const user = decodeURIComponent(u.username) || 'default';
  const password = decodeURIComponent(u.password) || '';
  // strip credentials from URL → baseUrl ('https://host:port' 形式)
  u.username = '';
  u.password = '';
  // pathname / search / hash は除外、protocol://host[:port] のみ
  const baseUrl = `${u.protocol}//${u.host}`;
  const authHeader = 'Basic ' + btoa(`${user}:${password}`);
  return { baseUrl, authHeader };
}

// ── ClickHouse lookup: sites.tenant_id ──────────────────────────────

/**
 * ClickHouse `clickinsight.sites` lookup: site_id → tenant_id
 * H-2: Basic Auth header 経由、URL query に credential 一切乗せない
 * H-4: dedupe cache を caller (resolveTenants) から受け取り、request 内 1 回のみ実行
 *
 * 戻り値:
 *   - string  : tenant_id 解決成功
 *   - null    : site_id が sites table に存在しない (negative cache 投入済)
 */
async function lookupTenantBySiteId(env: Env, site_id: string): Promise<string | null> {
  const cached = cacheLookup(site_id);
  if (cached.hit) return cached.tenant_id;

  const { baseUrl, authHeader } = parseClickHouseEnv(env.CLICKHOUSE_URL);
  // H-2: URL に credentials 一切乗せない。query / param のみ。
  const queryUrl = `${baseUrl}/?database=${encodeURIComponent(env.CLICKHOUSE_DB)}`
    + `&query=${encodeURIComponent(
        "SELECT tenant_id FROM sites WHERE site_id = {site_id:String} LIMIT 1 FORMAT JSONEachRow"
      )}`
    + `&param_site_id=${encodeURIComponent(site_id)}`;

  try {
    const resp = await fetch(queryUrl, {
      method: 'GET',
      headers: { Authorization: authHeader },
    });
    if (!resp.ok) {
      console.error(`sites lookup HTTP ${resp.status} for site_id=${site_id}`);
      return null;
    }
    const text = await resp.text();
    if (!text.trim()) {
      cacheStore(site_id, null); // H-4: negative cache
      return null;
    }
    const firstLine = text.split('\n').find((l) => l.trim().length > 0);
    if (!firstLine) {
      cacheStore(site_id, null);
      return null;
    }
    const row = JSON.parse(firstLine) as { tenant_id?: unknown };
    if (typeof row.tenant_id !== 'string' || row.tenant_id.length === 0) {
      cacheStore(site_id, null);
      return null;
    }
    // sites table 上の tenant_id も normalize (H-3 整合、ぶれた値の保護)
    const canonical = normalizeTenantId(row.tenant_id);
    if (canonical === null) {
      console.error(`sites table tenant_id violates allowlist: ${row.tenant_id}`);
      cacheStore(site_id, null);
      return null;
    }
    cacheStore(site_id, canonical);
    return canonical;
  } catch (e) {
    console.error(`sites lookup error for site_id=${site_id}:`, e);
    return null;
  }
}

// ── H-1: HS256 JWT verification (exp 必須化 + nbf/iat 検証) ─────────

/**
 * HS256 JWT verification using Web Crypto API.
 *
 * H-1: exp 欠落 / non-numeric の token を accept しない (perpetual token 攻撃防御)
 *      nbf 未来 / iat 30 秒以上未来も reject (clock skew 30s)
 *
 * 戻り値:
 *   - object: payload (verify 成功)
 *   - null  : 署名不正 / exp 切れ / 必須 claim 欠落 / 形式異常
 */
async function verifyJwtHs256(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  try {
    // 1. header.alg = 'HS256' 確認
    const headerJson = JSON.parse(b64urlDecode(headerB64));
    if (headerJson.alg !== 'HS256') return null;

    // 2. signature verify
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const sig = b64urlToBytes(sigB64);
    const signed = enc.encode(`${headerB64}.${payloadB64}`);
    const valid = await crypto.subtle.verify('HMAC', key, sig, signed);
    if (!valid) return null;

    // 3. payload parse
    const payload = JSON.parse(b64urlDecode(payloadB64)) as Record<string, unknown>;

    // H-1: exp 必須 numeric (perpetual token 攻撃防御)
    if (typeof payload.exp !== 'number' || !isFinite(payload.exp)) return null;
    const nowSec = Date.now() / 1000;
    if (nowSec > payload.exp) return null;

    // H-1: nbf 未来時刻 reject (Not Before、token 有効化前)
    if (payload.nbf !== undefined) {
      if (typeof payload.nbf !== 'number' || !isFinite(payload.nbf)) return null;
      if (nowSec < payload.nbf) return null;
    }

    // H-1: iat 30s 以上未来は reject (issued-at clock skew tolerance 30s)
    if (payload.iat !== undefined) {
      if (typeof payload.iat !== 'number' || !isFinite(payload.iat)) return null;
      if (payload.iat > nowSec + 30) return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function b64urlDecode(s: string): string {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

function b64urlToBytes(s: string): Uint8Array {
  const bin = b64urlDecode(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// ── resolveTenant ──────────────────────────────────────────────────

/**
 * resolveTenant: イベント 1 件に対する tenant 解決
 *
 * 優先順 (Codex B-4 §6):
 *   1. Authorization: Bearer <JWT> → HS256 verify → tenant_id claim 抽出 + normalize
 *   2. JWT 不在/不正時、event.tenant_id (data-tenant-id from tracking.js) を normalize、
 *      site_id → clickinsight.sites lookup で (site_id, tenant_id) ペア整合確認
 *   3. 不一致 / 欠落 → TenantRejection (silent drop)
 *
 * Phase 1 制約:
 *   - '__legacy__' (NFKC 等価含む) を新規流入で拒否 (H-3)
 *   - JWT 経路は B-to-B (Phase 2) と SaaS dashboard 経由 (Sprint 3) で使用想定。
 *     dogfood tracking.js は (2) 経路がメイン
 */
async function resolveTenant(
  request: Request,
  event: Record<string, unknown>,
  env: Env,
): Promise<TenantResolution | TenantRejection> {
  // ----- 経路 (a): Authorization Bearer JWT -----
  const authz = request.headers.get('authorization');
  if (authz && authz.toLowerCase().startsWith('bearer ')) {
    const token = authz.slice(7).trim();
    if (token.length > 0) {
      if (!env.MAGIC_LINK_SECRET) {
        console.error('MAGIC_LINK_SECRET unset, cannot verify Bearer JWT');
        // secret 未設定は drop でなく経路 (b) へ fallback (運用ミスでの全件 drop 回避)
      } else {
        const payload = await verifyJwtHs256(token, env.MAGIC_LINK_SECRET);
        if (!payload) {
          return { ok: false, reason: 'jwt_invalid', detail: 'Bearer JWT verify failed' };
        }
        // H-3: normalize + allowlist 検証
        const tid = normalizeTenantId(payload.tenant_id);
        if (tid === null) {
          return {
            ok: false,
            reason: 'tenant_id_missing',
            detail: 'JWT verified but tenant_id claim absent or invalid format',
          };
        }
        if (RESERVED_LEGACY_TENANTS.has(tid)) {
          return {
            ok: false,
            reason: 'legacy_tenant_blocked',
            detail: 'JWT claims reserved tenant_id (forbidden for new ingest)',
          };
        }
        return { ok: true, tenant_id: tid, source: 'jwt' };
      }
    }
  }

  // ----- 経路 (b): event.tenant_id + sites lookup 整合 -----
  const site_id = typeof event.site_id === 'string' ? event.site_id : '';
  if (!site_id) {
    return { ok: false, reason: 'site_id_missing', detail: 'event.site_id absent' };
  }

  const claimed_tenant = normalizeTenantId(event.tenant_id);
  if (claimed_tenant === null) {
    return {
      ok: false,
      reason: 'tenant_id_missing',
      detail: 'event.tenant_id absent or invalid format (tracking.js data-tenant-id 未設定/不正?)',
    };
  }
  if (RESERVED_LEGACY_TENANTS.has(claimed_tenant)) {
    return {
      ok: false,
      reason: 'legacy_tenant_blocked',
      detail: 'event.tenant_id == __legacy__ or NFKC-equivalent (forbidden for new ingest)',
    };
  }

  const expected = await lookupTenantBySiteId(env, site_id);
  if (expected === null) {
    return {
      ok: false,
      reason: 'site_tenant_mismatch',
      detail: `site_id=${site_id} not registered in clickinsight.sites`,
    };
  }
  if (expected !== claimed_tenant) {
    return {
      ok: false,
      reason: 'site_tenant_mismatch',
      detail: `site_id=${site_id}: claimed tenant_id=${claimed_tenant} but sites table says ${expected}`,
    };
  }

  return { ok: true, tenant_id: claimed_tenant, source: 'tracking_js' };
}

// ── H-4: audit_events INSERT (batch) ────────────────────────────────

/**
 * audit_events に silent-drop を **1 INSERT で batch 書込**。H-2 H-4 統合修正:
 *   - URL query から credentials 排除 (H-2: Basic Auth header)
 *   - drop N 件あっても 1 subrequest で完了 (H-4)
 *
 * Phase 1: action='ingest.silent_drop' / response_status=200 / plan_tier='Growth' (TTL 30d) /
 *          metadata={ reason, detail } JSON
 */
async function emitAuditEventsBatch(
  env: Env,
  request: Request,
  dropContexts: { site_id: string; rejection: TenantRejection }[],
): Promise<void> {
  if (dropContexts.length === 0) return;
  const { baseUrl, authHeader } = parseClickHouseEnv(env.CLICKHOUSE_URL);
  const ipAnon = anonymizeIp(request.headers.get('cf-connecting-ip'));
  const ua = (request.headers.get('user-agent') ?? '').slice(0, 256);
  const requestId = request.headers.get('cf-ray') ?? '';

  const rows = dropContexts.map((dc) => ({
    tenant_id: '__unknown__',
    user_id: '',
    action: 'ingest.silent_drop',
    resource: dc.site_id,
    ip_anonymized: ipAnon,
    user_agent: ua,
    request_id: requestId,
    response_status: 200,
    plan_tier: 'Growth',
    metadata: JSON.stringify({
      reason: dc.rejection.reason,
      detail: dc.rejection.detail.slice(0, 500),
    }),
  }));

  const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const insertUrl = `${baseUrl}/?database=${encodeURIComponent(env.CLICKHOUSE_DB)}`
    + `&query=${encodeURIComponent('INSERT INTO audit_events FORMAT JSONEachRow')}`
    + `&input_format_skip_unknown_fields=1`;

  // Reviewer R7-3 + Director 続 34 §5.4: resp.ok 検証で silent fail 撲滅
  // (旧コード = fetch 後 resp 内容を見ず success と判断、5xx でも console.error 出ず)
  // 新コード = (1) network error catch (旧来通り) + (2) HTTP status 検証 + (3) Sentry breadcrumb
  try {
    const resp = await fetch(insertUrl, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });
    if (!resp.ok) {
      // response body は credentials を含まない (insertUrl 内には Basic Auth header のみ、URL に user:pass なし)
      // ただし response body 全体 log は CH server side で error context を含む可能性 → 256 文字制限
      const respText = await resp.text().catch(() => '');
      const truncated = respText.slice(0, 256);
      // Cloudflare Workers の Sentry SDK は console.error を breadcrumb に変換 (auto-instrumented)
      // 構造化 message で grep / dashboard で集計可能に
      console.error(
        `[audit_events INSERT non-ok] status=${resp.status} statusText=${resp.statusText} ` +
          `rows=${dropContexts.length} body_head="${truncated}"`,
      );
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown';
    console.error(`[audit_events INSERT network error] rows=${dropContexts.length} err=${msg}`);
  }
}

function anonymizeIp(ip: string | null): string {
  if (!ip) return '';
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts.slice(0, 3).join(':') + '::';
  }
  return '';
}

// ── ClickHouse batch INSERT (JSONEachRow) ───────────────────────────

/**
 * Pick only defined columns from event, dropping undefined/null for
 * non-essential fields so ClickHouse uses DEFAULT values.
 *
 * M-1: tenant_id 列は INSERT-境界で必須 assert (resolveTenant 後でも防御 in depth)
 */
function pickColumns(
  event: Record<string, unknown>,
  columns: readonly string[],
): Record<string, unknown> | null {
  const row: Record<string, unknown> = {};
  for (const col of columns) {
    const v = event[col];
    if (v !== undefined && v !== null && v !== '') {
      row[col] = v;
    }
  }
  // M-1: tenant_id 列を持つテーブルでは tenant_id 必須 (空文字 / 未設定なら row 全体 drop)
  if (columns[0] === 'tenant_id' && !row.tenant_id) return null;
  return row;
}

async function flushToClickHouse(
  env: Env,
  events: Record<string, unknown>[],
): Promise<void> {
  const { baseUrl, authHeader } = parseClickHouseEnv(env.CLICKHOUSE_URL);

  // Group events by target table
  const groups = new Map<string, { columns: readonly string[]; rows: Record<string, unknown>[] }>();

  for (const event of events) {
    const eventType = String(event.event_type || '');
    if (!event.site_id || !eventType) continue;

    if (event.url && !event.page_url) {
      event.page_url = event.url;
    }

    if (event.timestamp && typeof event.timestamp === 'string') {
      const ts = new Date(event.timestamp);
      if (!isNaN(ts.getTime())) {
        event.timestamp = ts.toISOString().replace('T', ' ').slice(0, 19);
      }
    }

    const { table, columns } = routeEvent(eventType);
    const row = pickColumns(event, columns);
    if (row === null) {
      // M-1: tenant_id 列必須なのに欠落 → INSERT スキップ (resolveTenant 後の最終防御)
      console.error(`flushToClickHouse: drop event without tenant_id (table=${table})`);
      continue;
    }
    let group = groups.get(table);
    if (!group) {
      group = { columns, rows: [] };
      groups.set(table, group);
    }
    group.rows.push(row);
  }

  const promises: Promise<void>[] = [];
  for (const [table, { rows }] of groups) {
    if (rows.length === 0) continue;
    const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    // H-2: URL から credentials 完全排除、Basic Auth ヘッダで認証
    const insertUrl = `${baseUrl}/?database=${encodeURIComponent(env.CLICKHOUSE_DB)}`
      + `&query=${encodeURIComponent(`INSERT INTO ${table} FORMAT JSONEachRow`)}`
      + `&input_format_skip_unknown_fields=1`;

    promises.push(
      fetch(insertUrl, {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
      }).then(async (resp) => {
        if (!resp.ok) {
          const text = await resp.text();
          console.error(`ClickHouse INSERT ${table} failed (${resp.status}): ${text.slice(0, 500)}`);
        } else {
          console.log(`ClickHouse INSERT ${table}: ${rows.length} rows`);
        }
      })
    );
  }

  await Promise.allSettled(promises);
}

// ── AXO Task 4: HTTP header extraction ──────────────────────────────

function extractHttpHeaders(headers: Headers): Record<string, string> {
  const REFERER_MAX = 1024;
  const TRUNC_MARK = '...[truncated]';
  const truncate = (raw: string | null, max: number): string => {
    if (!raw) return '';
    if (raw.length <= max) return raw;
    return raw.slice(0, max - TRUNC_MARK.length) + TRUNC_MARK;
  };
  return {
    http_user_agent_raw:    headers.get('user-agent') ?? '',
    http_accept:            headers.get('accept') ?? '',
    http_accept_language:   headers.get('accept-language') ?? '',
    http_accept_encoding:   headers.get('accept-encoding') ?? '',
    http_range:             headers.get('range') ?? '',
    http_if_modified_since: headers.get('if-modified-since') ?? '',
    http_sec_fetch_site:    headers.get('sec-fetch-site') ?? '',
    http_sec_fetch_mode:    headers.get('sec-fetch-mode') ?? '',
    http_sec_fetch_dest:    headers.get('sec-fetch-dest') ?? '',
    http_sec_fetch_user:    headers.get('sec-fetch-user') ?? '',
    http_referer:           truncate(headers.get('referer'), REFERER_MAX),
  };
}

const AGENT_PATTERNS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /GPTBot/i,              name: 'GPTBot' },
  { pattern: /ChatGPT-User/i,       name: 'ChatGPT-User' },
  { pattern: /ClaudeBot/i,          name: 'ClaudeBot' },
  { pattern: /Claude-Web/i,         name: 'Claude-Web' },
  { pattern: /PerplexityBot/i,      name: 'PerplexityBot' },
  { pattern: /Google-Extended/i,    name: 'Google-Extended' },
  { pattern: /Googlebot/i,          name: 'Googlebot' },
  { pattern: /Bingbot/i,            name: 'Bingbot' },
  { pattern: /Bytespider/i,         name: 'Bytespider' },
  { pattern: /CCBot/i,              name: 'CCBot' },
  { pattern: /Diffbot/i,            name: 'Diffbot' },
  { pattern: /Amazonbot/i,          name: 'Amazonbot' },
  { pattern: /Applebot-Extended/i,  name: 'Applebot-Extended' },
  { pattern: /cohere-ai/i,          name: 'cohere-ai' },
  { pattern: /Meta-ExternalAgent/i, name: 'Meta-ExternalAgent' },
  { pattern: /HeadlessChrome/i,     name: 'HeadlessChrome' },
  { pattern: /PhantomJS/i,          name: 'PhantomJS' },
  { pattern: /Playwright/i,         name: 'Playwright' },
  { pattern: /Puppeteer/i,          name: 'Puppeteer' },
];

function detectAgentFromUA(ua: string): { is_agent: number; agent_type: string } {
  if (!ua) return { is_agent: 0, agent_type: '' };
  for (const { pattern, name } of AGENT_PATTERNS) {
    if (pattern.test(ua)) {
      return { is_agent: 1, agent_type: name };
    }
  }
  return { is_agent: 0, agent_type: '' };
}

// ── CORS helpers ────────────────────────────────────────────────────

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS;
  const respOrigin = allowed === '*' ? '*' : (origin || '*');
  return {
    'Access-Control-Allow-Origin': respOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

// ── Request handler ─────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);

    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(JSON.stringify({ status: 'ok', worker: 'ugokimap-event-ingest' }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname !== '/api/track' || request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    let events: Record<string, unknown>[];
    try {
      const body = await request.json() as Record<string, unknown>;
      if (Array.isArray(body.events)) {
        events = body.events as Record<string, unknown>[];
      } else if (body.site_id && body.event_type) {
        events = [body];
      } else {
        return new Response(JSON.stringify({ error: 'Invalid payload' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // H-4: events 件数上限を最優先で enforce (DoS 防御)
    if (events.length > MAX_EVENTS_PER_REQUEST) {
      return new Response(
        JSON.stringify({
          error: 'payload_too_large',
          detail: `events count ${events.length} exceeds MAX_EVENTS_PER_REQUEST=${MAX_EVENTS_PER_REQUEST}`,
        }),
        { status: 413, headers: { ...cors, 'Content-Type': 'application/json' } },
      );
    }

    const validEvents = events.filter((e) => e.site_id && e.event_type);
    if (validEvents.length === 0) {
      return new Response(JSON.stringify({ error: 'No valid events' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // H-4: per-request dedupe map for sites lookup (同一 site_id を request 内 1 回のみ)
    const requestLookupCache = new Map<string, Promise<string | null>>();
    const getResolvedTenantForSite = (site_id: string): Promise<string | null> => {
      let p = requestLookupCache.get(site_id);
      if (!p) {
        p = lookupTenantBySiteId(env, site_id);
        requestLookupCache.set(site_id, p);
      }
      return p;
    };

    // resolveTenant の sites lookup を request-local dedupe にする間接化
    // (オリジナル resolveTenant は env から fresh fetch するため、ここで wrap し直す)
    const acceptedEvents: Record<string, unknown>[] = [];
    const dropContexts: { site_id: string; rejection: TenantRejection }[] = [];

    for (const e of validEvents) {
      const r = await resolveTenantWithDedupe(request, e, env, getResolvedTenantForSite);
      if (r.ok) {
        e.tenant_id = r.tenant_id;
        acceptedEvents.push(e);
      } else {
        if (r.reason === 'jwt_invalid') {
          return new Response(
            JSON.stringify({ error: 'unauthorized', reason: r.reason, detail: r.detail }),
            { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } },
          );
        }
        dropContexts.push({
          site_id: typeof e.site_id === 'string' ? e.site_id : '',
          rejection: r,
        });
      }
    }

    // H-4: silent drop を 1 batch INSERT で audit_events に書込 (per-drop call から変更)
    if (dropContexts.length > 0) {
      ctx.waitUntil(emitAuditEventsBatch(env, request, dropContexts));
    }

    if (acceptedEvents.length === 0) {
      return new Response(
        JSON.stringify({ success: true, received: 0, dropped: dropContexts.length }),
        { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } },
      );
    }

    // AXO Task 4: HTTPヘッダ + agent 検知
    const httpHeaders = extractHttpHeaders(request.headers);
    const serverAgent = detectAgentFromUA(httpHeaders.http_user_agent_raw);
    for (const e of acceptedEvents) {
      Object.assign(e, httpHeaders);
      if (!e.is_agent || e.is_agent === 0 || e.is_agent === '0') {
        e.is_agent = serverAgent.is_agent;
        e.agent_type = serverAgent.agent_type;
      }
    }

    ctx.waitUntil(flushToClickHouse(env, acceptedEvents));

    return new Response(
      JSON.stringify({
        success: true,
        received: acceptedEvents.length,
        dropped: dropContexts.length,
      }),
      { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  },
};

/**
 * H-4: resolveTenant の dedupe ラッパ。
 *
 * オリジナル resolveTenant の経路 (b) で呼ぶ `lookupTenantBySiteId(env, site_id)` を、
 * request-local Promise キャッシュ経由 (`getResolvedTenantForSite`) に差替える。
 * 経路 (a) JWT は dedupe 対象外 (sites lookup を呼ばない)。
 */
async function resolveTenantWithDedupe(
  request: Request,
  event: Record<string, unknown>,
  env: Env,
  getResolvedTenantForSite: (site_id: string) => Promise<string | null>,
): Promise<TenantResolution | TenantRejection> {
  const authz = request.headers.get('authorization');
  if (authz && authz.toLowerCase().startsWith('bearer ')) {
    const token = authz.slice(7).trim();
    if (token.length > 0 && env.MAGIC_LINK_SECRET) {
      const payload = await verifyJwtHs256(token, env.MAGIC_LINK_SECRET);
      if (!payload) {
        return { ok: false, reason: 'jwt_invalid', detail: 'Bearer JWT verify failed' };
      }
      const tid = normalizeTenantId(payload.tenant_id);
      if (tid === null) {
        return {
          ok: false,
          reason: 'tenant_id_missing',
          detail: 'JWT verified but tenant_id claim absent or invalid format',
        };
      }
      if (RESERVED_LEGACY_TENANTS.has(tid)) {
        return {
          ok: false,
          reason: 'legacy_tenant_blocked',
          detail: 'JWT claims reserved tenant_id (forbidden for new ingest)',
        };
      }
      return { ok: true, tenant_id: tid, source: 'jwt' };
    }
  }

  const site_id = typeof event.site_id === 'string' ? event.site_id : '';
  if (!site_id) {
    return { ok: false, reason: 'site_id_missing', detail: 'event.site_id absent' };
  }
  const claimed_tenant = normalizeTenantId(event.tenant_id);
  if (claimed_tenant === null) {
    return {
      ok: false,
      reason: 'tenant_id_missing',
      detail: 'event.tenant_id absent or invalid format',
    };
  }
  if (RESERVED_LEGACY_TENANTS.has(claimed_tenant)) {
    return {
      ok: false,
      reason: 'legacy_tenant_blocked',
      detail: 'event.tenant_id == __legacy__ or NFKC-equivalent',
    };
  }

  // H-4: dedupe 経由 (オリジナル resolveTenant の fresh fetch を request-local cache 化)
  const expected = await getResolvedTenantForSite(site_id);
  if (expected === null) {
    return {
      ok: false,
      reason: 'site_tenant_mismatch',
      detail: `site_id=${site_id} not registered in clickinsight.sites`,
    };
  }
  if (expected !== claimed_tenant) {
    return {
      ok: false,
      reason: 'site_tenant_mismatch',
      detail: `site_id=${site_id}: claimed tenant_id=${claimed_tenant} but sites table says ${expected}`,
    };
  }
  return { ok: true, tenant_id: claimed_tenant, source: 'tracking_js' };
}

// ── Exports for unit testing ────────────────────────────────────────

export const __TEST_ONLY__ = {
  resolveTenant,
  resolveTenantWithDedupe,
  verifyJwtHs256,
  lookupTenantBySiteId,
  normalizeTenantId,
  parseClickHouseEnv,
  cacheLookup,
  cacheStore,
  SITE_TENANT_CACHE,
  EVENTS_COLUMNS,
  BEHAVIOR_COLUMNS,
  IMAGE_VISIBILITY_COLUMNS,
  FORM_COLUMNS,
  VIDEO_COLUMNS,
  ELEMENT_VISIBILITY_COLUMNS,
  SCROLL_TIMELINE_COLUMNS,
  ELEMENT_VISIBILITY_V2_COLUMNS,
  WEB_VITALS_COLUMNS,
  MAX_EVENTS_PER_REQUEST,
  RESERVED_LEGACY_TENANTS,
  routeEvent,
  anonymizeIp,
  pickColumns,
};
