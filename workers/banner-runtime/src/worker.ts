/**
 * UGOKI MAP / LINKTH SaaS — Banner Runtime Worker (Phase 2A)
 *
 * Cloudflare Workers edge endpoint for banner decision.
 * Receives requests from tracking.js, resolves tenant_id, reads rule_bundle from KV,
 * matches audience, and returns a WorkerResponse JSON.
 *
 * Flow:
 *   tracking.js → GET /v1/decision?cid=&site_id=
 *                 → Worker
 *                   ├─ resolveTenant (Authorization: Bearer JWT or cookie / referer)
 *                   ├─ KV.get rules/{tenant_id}/{site_id}/active   → version pointer
 *                   ├─ KV.get rules/{tenant_id}/{site_id}/{version} → rule_bundle (JSON)
 *                   ├─ tenant_id verify (D-4 strict)
 *                   ├─ published_at staleness (>7d → fallback)
 *                   ├─ schema_version compat (mismatch → fallback)
 *                   ├─ consent_flags eval (C5 / dispatch-02 minimum gate)
 *                   ├─ KV.get member/{tenant_id}/{cid} → audience_flags
 *                   ├─ audience_membership_index lookup → candidate banner_ids
 *                   ├─ priority + match_rate_cap holdout + sensitive_category filter
 *                   └─ build WorkerResponse (with CSP nonce per-request)
 *                 → audit_events INSERT (resp.ok 検証経路 reuse 続 26)
 *
 * 重要制約 (PRD §1.3 / §2):
 *   - ClickHouse 直接 read 禁止 (C3)
 *   - cross-tenant 配信絶対禁止 (D-4)
 *   - banner_config.sensitive_category_excluded === false (未 review) かつ evidence_level === 'inferred' の banner は skip (C7、続 90 SSOT)
 *   - P95 latency ≤ 100ms (KV read 2 回で完結する設計)
 *   - gzip ≤ 20KB / main thread ≤ 50ms / CLS 0 (PRD §2 F3)
 *
 * 配備 dispatch: dispatch-05-infra-banner-worker-runtime.md (2026-05-26 起票)
 * PRD: linkscrawl/docs/banner-engine/REQUIREMENTS.md
 * Contracts SSOT: ugokimap-contracts/schemas/{rule_bundle,banner_config,member_attribute,worker_response}.schema.json
 */

import type {
  RuleBundle,
  BannerConfig,
} from './contracts-types';
import type {
  MemberAttribute,
  WorkerResponse,
} from './contracts-types';

// ── Env binding (wrangler.toml [vars] + [[kv_namespaces]] + secrets) ─────────

export interface Env {
  // KV bindings (PRD §2 F4)
  RULE_BUNDLES_KV: KVNamespace;          // rules/{tenant_id}/{site_id}/{version|active}
  MEMBER_ATTRIBUTES_KV: KVNamespace;      // member/{tenant_id}/{ga_client_id}

  // CORS + tenant guard
  ALLOWED_ORIGINS: string;                // '*' or comma-separated

  // Tenant resolution
  MAGIC_LINK_SECRET: string;              // HS256 shared with ugokimap-saas/lib/auth/magic-link.ts

  // Audit (event-ingest worker と同じ ClickHouse audit_events に書込)
  CLICKHOUSE_URL: string;                 // http://user:pass@host:port (secret)
  CLICKHOUSE_DB: string;                  // 'clickinsight'

  // Worker self-identification (audit + monitoring)
  WORKER_NAME?: string;                   // default 'ugokimap-banner-runtime'
}

// ── 定数 ─────────────────────────────────────────────────────────────────

const BANNER_RUNTIME_SCHEMA_VERSION = '0.1.0';
const STALE_BUNDLE_DAYS = 7;
const KV_MEMBER_TTL_HOURS_DEFAULT = 24 * 30; // 30 day fallback
const MAX_BANNERS_TO_EVAL = 50;              // banner_config.schema maxItems と一致

// ── Tenant ID 正規化 (event-ingest worker と完全互換) ─────────────────────

function normalizeTenantId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  const normalized = raw.normalize('NFKC').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,64}$/.test(normalized)) return null;
  return normalized;
}

const RESERVED_LEGACY_TENANTS = new Set<string>(['__legacy__', '__unknown__']);

// ── UUID v4 generator (audit_correlation_id + CSP nonce) ────────────────

function uuidv4(): string {
  // Cloudflare Workers の crypto.randomUUID() は v4 を返す。
  // workers-types ではこれが常に存在するため、直接呼ぶ (古い runtime fallback は不要)。
  return crypto.randomUUID();
}

function generateCspNonce(): string {
  // CSP nonce は base64url 形式 16 byte (PRD §2 F3 / dispatch-02 §3)
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── b64url decode (JWT 用、event-ingest と完全互換) ──────────────────────

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

async function verifyJwtHs256(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  try {
    const header = JSON.parse(b64urlDecode(headerB64));
    if (header.alg !== 'HS256') return null;
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
    const payload = JSON.parse(b64urlDecode(payloadB64)) as Record<string, unknown>;
    if (typeof payload.exp !== 'number' || !isFinite(payload.exp)) return null;
    const nowSec = Date.now() / 1000;
    if (nowSec > payload.exp) return null;
    if (payload.nbf !== undefined) {
      if (typeof payload.nbf !== 'number' || !isFinite(payload.nbf)) return null;
      if (nowSec < payload.nbf) return null;
    }
    if (payload.iat !== undefined) {
      if (typeof payload.iat !== 'number' || !isFinite(payload.iat)) return null;
      if (payload.iat > nowSec + 30) return null;
    }
    return payload;
  } catch {
    return null;
  }
}

// ── Tenant 解決 (本 worker は GA cid ベースなので JWT or Referer/Origin 由来) ──

interface TenantResolved {
  ok: true;
  tenant_id: string;
  source: 'jwt' | 'query' | 'referer';
}
interface TenantRejected {
  ok: false;
  reason: 'jwt_invalid' | 'tenant_id_missing' | 'tenant_id_invalid' | 'legacy_tenant_blocked';
  detail: string;
}

async function resolveTenantForBanner(
  request: Request,
  url: URL,
  env: Env,
): Promise<TenantResolved | TenantRejected> {
  // (a) Authorization Bearer JWT 経路 (SaaS dashboard preview / B-to-B)
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
        return { ok: false, reason: 'legacy_tenant_blocked', detail: 'JWT claims reserved tenant_id' };
      }
      return { ok: true, tenant_id: tid, source: 'jwt' };
    }
  }

  // (b) ?tenant_id=... query string (tracking.js v2 expected default)
  const qTenant = url.searchParams.get('tenant_id');
  const fromQuery = normalizeTenantId(qTenant);
  if (fromQuery && !RESERVED_LEGACY_TENANTS.has(fromQuery)) {
    return { ok: true, tenant_id: fromQuery, source: 'query' };
  }

  // (c) Referer の hostname → tenant 推定はやらない (D-4: 物理隔離は KV key prefix のみ、
  // hostname → tenant の mapping は将来 sites table 経由で実装、Phase 2A では query 必須化)

  return {
    ok: false,
    reason: 'tenant_id_missing',
    detail: 'tenant_id absent in query string (Bearer JWT also not supplied)',
  };
}

// ── KV read with cross-tenant guard (D-4) ────────────────────────────────

interface KvBundleResult {
  ok: true;
  bundle: RuleBundle;
  version: string;
}
interface KvBundleMiss {
  ok: false;
  reason: 'active_missing' | 'bundle_missing' | 'tenant_mismatch' | 'parse_error' | 'stale' | 'schema_mismatch';
  detail: string;
  fallback_default_banner_id?: string | null;
  fallback_action?: 'no_op' | 'show_default_banner';
}

async function readRuleBundleFromKv(
  env: Env,
  tenant_id: string,
  site_id: string,
): Promise<KvBundleResult | KvBundleMiss> {
  const activeKey = `rules/${tenant_id}/${site_id}/active`;
  const versionPointer = await env.RULE_BUNDLES_KV.get(activeKey, 'text');
  if (!versionPointer) {
    return { ok: false, reason: 'active_missing', detail: `KV miss: ${activeKey}` };
  }
  const trimmedVersion = versionPointer.trim();
  if (!/^[0-9]{14}-[a-z0-9]{6}$/.test(trimmedVersion)) {
    return { ok: false, reason: 'active_missing', detail: `active pointer malformed: ${trimmedVersion}` };
  }

  const bundleKey = `rules/${tenant_id}/${site_id}/${trimmedVersion}`;
  const bundleJson = await env.RULE_BUNDLES_KV.get(bundleKey, 'text');
  if (!bundleJson) {
    return { ok: false, reason: 'bundle_missing', detail: `KV miss: ${bundleKey}` };
  }

  let bundle: RuleBundle;
  try {
    bundle = JSON.parse(bundleJson) as RuleBundle;
  } catch (e) {
    return { ok: false, reason: 'parse_error', detail: `JSON.parse failed: ${String(e)}` };
  }

  // D-4 strict cross-tenant guard: bundle.tenant_id must match URL-derived tenant_id
  if (bundle.tenant_id !== tenant_id) {
    return {
      ok: false,
      reason: 'tenant_mismatch',
      detail: `bundle.tenant_id=${bundle.tenant_id} != request tenant_id=${tenant_id}`,
    };
  }
  if (bundle.site_id !== site_id) {
    // site_id mismatch も同様に拒否 (KV key と bundle 内 site_id 不一致 = data corruption)
    return {
      ok: false,
      reason: 'tenant_mismatch',
      detail: `bundle.site_id=${bundle.site_id} != request site_id=${site_id}`,
    };
  }

  // staleness check (published_at + 7 day)
  const publishedAtMs = Date.parse(bundle.published_at);
  if (Number.isFinite(publishedAtMs)) {
    const ageMs = Date.now() - publishedAtMs;
    if (ageMs > STALE_BUNDLE_DAYS * 24 * 60 * 60 * 1000) {
      return {
        ok: false,
        reason: 'stale',
        detail: `bundle is ${Math.floor(ageMs / (24 * 3600 * 1000))} days old (max ${STALE_BUNDLE_DAYS})`,
        fallback_action: bundle.fallback?.action,
        fallback_default_banner_id: bundle.fallback?.default_banner_id ?? null,
      };
    }
  }

  // schema_version compatibility (Phase 2A は厳密 match、Phase 2B 以降で semver gen)
  if (bundle.schema_version !== BANNER_RUNTIME_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'schema_mismatch',
      detail: `bundle.schema_version=${bundle.schema_version} != worker ${BANNER_RUNTIME_SCHEMA_VERSION}`,
      fallback_action: bundle.fallback?.action,
      fallback_default_banner_id: bundle.fallback?.default_banner_id ?? null,
    };
  }

  return { ok: true, bundle, version: trimmedVersion };
}

async function readMemberAttribute(
  env: Env,
  tenant_id: string,
  cid: string,
): Promise<MemberAttribute | null> {
  const key = `member/${tenant_id}/${cid}`;
  const raw = await env.MEMBER_ATTRIBUTES_KV.get(key, 'text');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MemberAttribute;
  } catch {
    return null;
  }
}

// ── Audience match + holdout + sensitive filter ───────────────────────────

function audienceMatches(
  banner: BannerConfig,
  memberFlags: string[],
): boolean {
  const targeting = banner.audience_targeting;
  if (!targeting) return false;
  const op = targeting.operator;
  const ids = Array.isArray(targeting.audience_ids) ? targeting.audience_ids : [];
  const excludeIds = Array.isArray(targeting.exclude_audience_ids) ? targeting.exclude_audience_ids : [];

  // exclude wins (always)
  for (const ex of excludeIds) {
    if (memberFlags.includes(ex)) return false;
  }

  if (op === 'NONE') return true;
  if (ids.length === 0) return op === 'OR' ? false : true; // empty AND = vacuously true, OR empty = false
  if (op === 'AND') return ids.every((id) => memberFlags.includes(id));
  if (op === 'OR') return ids.some((id) => memberFlags.includes(id));
  return false;
}

// FNV-1a 32-bit hash for deterministic holdout (no PII leak, fast on edge)
function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function passesHoldout(cid: string, banner_id: string, cap: number | null | undefined): boolean {
  if (cap === null || cap === undefined) return true;
  if (cap <= 0) return false;
  if (cap >= 1) return true;
  const bucket = fnv1aHash(`${cid}|${banner_id}`) / 0xffffffff; // 0.0 .. 1.0
  return bucket < cap;
}

function shouldSkipSensitive(banner: BannerConfig): boolean {
  // canonical SSOT (続 90 確定):
  //   schemas/banner_config.schema.json description + privacy-csp-perf-gate §1.3
  //   excluded === false (未 review 既定値) AND evidence_level === 'inferred' → skip
  //   excluded === true (Marketer manual review 済) → 配信可 (inferred でも)
  // schema default: false を尊重、undefined も未 review と同等に扱う (??false で正規化)
  // PRD §2 F1 step 11 + C7 は続 90 + dispatch-07 で本 SSOT に整合化 patch 済
  const excluded = banner.sensitive_category_excluded ?? false;
  if (excluded === false && banner.evidence_level === 'inferred') return true;
  return false;
}

// ── Consent gate (C5 / dispatch-02 privacy-csp-perf-gate §1.1) ────────────
//
// SSOT: linkscrawl/docs/banner-engine/privacy-csp-perf-gate.md §1.1
//   personalization === false → consent_denied (reason: personalization_not_opted_in)
//   ads             === false → consent_denied (reason: ads_not_opted_in)
//   analytics は別系統 (event tracking 用)、本 gate では banner 抑止 trigger にしない。
//
// bundle.consent_flags  = publish 時の sitewide default
// member.consent        = 個別 opt-out 反映 (GTM dataLayer / cookie fallback / BQ sync)
// 両者の AND (どちらかが false → denied)。

interface ConsentDecision {
  allowed: boolean;
  reason?: 'personalization_not_opted_in' | 'ads_not_opted_in' | 'consent_flags_missing';
}

function evaluateConsent(
  bundle: RuleBundle,
  member: MemberAttribute | null,
): ConsentDecision {
  // CRITICAL fail-closed (続 95 A-C1 / 続 96 dispatch-11 §1):
  //   bundle.consent_flags undefined / partial → deny with consent_flags_missing.
  //   旧実装は default allow に倒れ legacy/malformed bundle で consent gate bypass の hole。
  const bundleFlags = bundle.consent_flags;
  if (
    !bundleFlags ||
    typeof bundleFlags.personalization !== 'boolean' ||
    typeof bundleFlags.ads !== 'boolean'
  ) {
    return { allowed: false, reason: 'consent_flags_missing' };
  }

  const memberFlags = member?.consent;
  const personalization = bundleFlags.personalization && (memberFlags?.personalization ?? true);
  const ads = bundleFlags.ads && (memberFlags?.ads ?? true);

  if (!personalization) return { allowed: false, reason: 'personalization_not_opted_in' };
  if (!ads) return { allowed: false, reason: 'ads_not_opted_in' };
  return { allowed: true };
}

// ── Decision pipeline ────────────────────────────────────────────────────

interface DecisionContext {
  tenant_id: string;
  site_id: string;
  cid: string | null;
  audit_correlation_id: string;
  nonce: string;
}

function buildResponse(
  ctx: DecisionContext,
  status: WorkerResponse['status'],
  banner: BannerConfig | null,
  options?: {
    bundle_version?: string;
    matched_audience_ids?: string[];
    debug?: boolean;
    evidence_level?: BannerConfig['evidence_level'];
  },
): WorkerResponse {
  const decision: WorkerResponse['decision'] = banner
    ? {
        banner_id: banner.banner_id,
        template_id: banner.display.template_id,
        content_variables: banner.display.content_variables ?? {},
        css_class: banner.display.css_class ?? null,
        nonce: ctx.nonce,
      }
    : {
        banner_id: null,
        template_id: null,
        content_variables: {},
        css_class: null,
        nonce: ctx.nonce,
      };

  const resp: WorkerResponse = {
    status,
    tenant_id: ctx.tenant_id,
    site_id: ctx.site_id,
    ga_client_id: ctx.cid,
    decision,
    served_at: new Date().toISOString(),
    audit_correlation_id: ctx.audit_correlation_id,
    evidence_level: options?.evidence_level ?? (banner ? banner.evidence_level ?? null : null),
  };
  if (options?.debug) {
    resp.debug = {
      matched_audience_ids: options.matched_audience_ids ?? [],
      bundle_version: options.bundle_version ?? null,
      lookup_ms: null,
    };
  }
  return resp;
}

// ── audit_events INSERT (event-ingest worker と同じ pattern、resp.ok 検証経路 reuse) ─

interface ParsedClickHouseEnv {
  baseUrl: string;
  authHeader: string;
}

function parseClickHouseEnv(raw: string): ParsedClickHouseEnv {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { baseUrl: raw, authHeader: 'Basic ' + btoa('default:') };
  }
  const user = decodeURIComponent(u.username) || 'default';
  const password = decodeURIComponent(u.password) || '';
  u.username = '';
  u.password = '';
  const baseUrl = `${u.protocol}//${u.host}`;
  const authHeader = 'Basic ' + btoa(`${user}:${password}`);
  return { baseUrl, authHeader };
}

function anonymizeIp(ip: string | null): string {
  if (!ip) return '';
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts.slice(0, 4).join(':') + '::';
  }
  return '';
}

// 続 96 dispatch-11 §5: audit naming 統一 (`banner.*` prefix)。
//   `banner.deletion_processed` は declare-only で emit point なし → 削除。
//   publish job 側 (`kv.member_tombstone` / `kv.tenant_purge`) は `banner.*` に rename (audit.py + cli.py)。
//   `banner.sensitive_category_blocked` を §3 で新規 emit (shouldSkipSensitive 経由)。
type AuditAction =
  | 'banner.serve'
  | 'banner.no_match'
  | 'banner.consent_denied'
  | 'banner.fallback'
  | 'banner.error'
  | 'banner.cross_tenant_blocked'
  | 'banner.sensitive_category_blocked'
  | 'banner.member_tombstone'
  | 'banner.tenant_purge';

interface AuditRow {
  tenant_id: string;
  action: AuditAction;
  resource: string;             // banner_id or site_id
  audit_correlation_id: string;
  reason?: string;
  detail?: string;
}

async function emitAuditEvent(
  env: Env,
  request: Request,
  row: AuditRow,
): Promise<void> {
  if (!env.CLICKHOUSE_URL) return; // dev / test mode で url 未設定なら skip
  const { baseUrl, authHeader } = parseClickHouseEnv(env.CLICKHOUSE_URL);
  const ipAnon = anonymizeIp(request.headers.get('cf-connecting-ip'));
  const ua = (request.headers.get('user-agent') ?? '').slice(0, 256);
  const requestId = request.headers.get('cf-ray') ?? '';

  const body =
    JSON.stringify({
      tenant_id: row.tenant_id,
      user_id: '',
      action: row.action,
      resource: row.resource,
      ip_anonymized: ipAnon,
      user_agent: ua,
      request_id: requestId,
      response_status: 200,
      plan_tier: 'Growth',
      metadata: JSON.stringify({
        audit_correlation_id: row.audit_correlation_id,
        reason: row.reason ?? null,
        detail: (row.detail ?? '').slice(0, 500),
        worker: env.WORKER_NAME ?? 'ugokimap-banner-runtime',
      }),
    }) + '\n';

  const insertUrl =
    `${baseUrl}/?database=${encodeURIComponent(env.CLICKHOUSE_DB)}` +
    `&query=${encodeURIComponent('INSERT INTO audit_events FORMAT JSONEachRow')}` +
    `&input_format_skip_unknown_fields=1`;

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
      const respText = await resp.text().catch(() => '');
      console.error(
        `[banner-runtime audit non-ok] status=${resp.status} statusText=${resp.statusText} ` +
          `action=${row.action} body_head="${respText.slice(0, 256)}"`,
      );
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown';
    console.error(`[banner-runtime audit network error] action=${row.action} err=${msg}`);
  }
}

// ── CORS helpers ──────────────────────────────────────────────────────────

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS;
  const respOrigin = allowed === '*' || allowed === undefined ? '*' : origin || '*';
  return {
    'Access-Control-Allow-Origin': respOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// ── Main fetch handler ────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);

    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(
        JSON.stringify({ status: 'ok', worker: env.WORKER_NAME ?? 'ugokimap-banner-runtime' }),
        { headers: { ...cors, 'Content-Type': 'application/json' } },
      );
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname !== '/v1/decision' || request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    return handleDecision(request, url, env, ctx, cors);
  },
};

async function handleDecision(
  request: Request,
  url: URL,
  env: Env,
  execCtx: ExecutionContext,
  cors: Record<string, string>,
): Promise<Response> {
  const cid = url.searchParams.get('cid');
  const site_id = url.searchParams.get('site_id');

  const audit_correlation_id = uuidv4();
  const nonce = generateCspNonce();

  // (1) Required params
  if (!site_id) {
    return new Response(
      JSON.stringify({ error: 'site_id required' }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(site_id)) {
    return new Response(
      JSON.stringify({ error: 'site_id must be UUID' }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }

  // (2) Resolve tenant_id
  const tres = await resolveTenantForBanner(request, url, env);
  if (!tres.ok) {
    if (tres.reason === 'jwt_invalid') {
      return new Response(
        JSON.stringify({ error: 'unauthorized', reason: tres.reason, detail: tres.detail }),
        { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({ error: 'tenant_id_required', reason: tres.reason, detail: tres.detail }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }
  const tenant_id = tres.tenant_id;
  const ctx: DecisionContext = { tenant_id, site_id, cid, audit_correlation_id, nonce };

  // (3) Read rule_bundle from KV
  const kv = await readRuleBundleFromKv(env, tenant_id, site_id);
  if (!kv.ok) {
    // cross-tenant 検知は最も厳しい扱い (audit + error)
    if (kv.reason === 'tenant_mismatch') {
      execCtx.waitUntil(
        emitAuditEvent(env, request, {
          tenant_id,
          action: 'banner.cross_tenant_blocked',
          resource: site_id,
          audit_correlation_id,
          reason: kv.reason,
          detail: kv.detail,
        }),
      );
      const resp = buildResponse(ctx, 'error', null);
      return jsonResponse(resp, 403, cors, nonce);
    }

    // stale / schema_mismatch → fallback.action 評価
    if (kv.reason === 'stale' || kv.reason === 'schema_mismatch') {
      const resp = buildResponse(ctx, 'fallback', null);
      execCtx.waitUntil(
        emitAuditEvent(env, request, {
          tenant_id,
          action: 'banner.fallback',
          resource: site_id,
          audit_correlation_id,
          reason: kv.reason,
          detail: kv.detail,
        }),
      );
      return jsonResponse(resp, 200, cors, nonce);
    }

    // active_missing / bundle_missing / parse_error → no banner, status=fallback (no_op default)
    const resp = buildResponse(ctx, 'fallback', null);
    execCtx.waitUntil(
      emitAuditEvent(env, request, {
        tenant_id,
        action: 'banner.fallback',
        resource: site_id,
        audit_correlation_id,
        reason: kv.reason,
        detail: kv.detail,
      }),
    );
    return jsonResponse(resp, 200, cors, nonce);
  }

  const bundle = kv.bundle;

  // (4) Read member attribute (D-1 削除済 cid は KV miss = empty audience)
  const member = cid ? await readMemberAttribute(env, tenant_id, cid) : null;

  // (5) Consent gate
  const consent = evaluateConsent(bundle, member);
  if (!consent.allowed) {
    const resp = buildResponse(ctx, 'consent_denied', null);
    execCtx.waitUntil(
      emitAuditEvent(env, request, {
        tenant_id,
        action: 'banner.consent_denied',
        resource: site_id,
        audit_correlation_id,
        reason: consent.reason,
      }),
    );
    return jsonResponse(resp, 200, cors, nonce);
  }

  // (6) Audience match: priority 順走査
  const memberFlags = member?.audience_flags ?? [];
  const banners = (bundle.banners ?? []).slice(0, MAX_BANNERS_TO_EVAL);
  const matchedAudienceIds: string[] = [];
  let chosen: BannerConfig | null = null;

  for (const banner of banners) {
    if (banner.status !== 'active') continue;
    if (shouldSkipSensitive(banner)) {
      // 続 96 dispatch-11 §3 (C-W1): silent skip ではなく audit emit、production 観測可能化。
      // payload: banner_id + evidence_level + sensitive_category_excluded (??false 正規化前)。
      execCtx.waitUntil(
        emitAuditEvent(env, request, {
          tenant_id,
          action: 'banner.sensitive_category_blocked',
          resource: banner.banner_id,
          audit_correlation_id,
          reason: 'inferred_blocked',
          detail: JSON.stringify({
            evidence_level: banner.evidence_level,
            sensitive_category_excluded: banner.sensitive_category_excluded ?? false,
          }),
        }),
      );
      continue;
    }
    if (!audienceMatches(banner, memberFlags)) continue;
    // holdout (match_rate_cap)
    const cap = banner.audience_targeting.match_rate_cap ?? null;
    if (cid && !passesHoldout(cid, banner.banner_id, cap)) continue;
    // schedule 制約 (PRD §2 / banner_config.schedule.starts_at/ends_at)
    if (banner.schedule) {
      const nowMs = Date.now();
      if (banner.schedule.starts_at) {
        const startMs = Date.parse(banner.schedule.starts_at);
        if (Number.isFinite(startMs) && nowMs < startMs) continue;
      }
      if (banner.schedule.ends_at) {
        const endMs = Date.parse(banner.schedule.ends_at);
        if (Number.isFinite(endMs) && nowMs > endMs) continue;
      }
    }
    // matched audience ids for debug
    for (const a of banner.audience_targeting.audience_ids ?? []) {
      if (memberFlags.includes(a)) matchedAudienceIds.push(a);
    }
    chosen = banner;
    break;
  }

  if (!chosen) {
    const resp = buildResponse(ctx, 'no_match', null, {
      bundle_version: kv.version,
      matched_audience_ids: matchedAudienceIds,
    });
    execCtx.waitUntil(
      emitAuditEvent(env, request, {
        tenant_id,
        action: 'banner.no_match',
        resource: site_id,
        audit_correlation_id,
      }),
    );
    return jsonResponse(resp, 200, cors, nonce);
  }

  // (7) Build OK response
  const resp = buildResponse(ctx, 'ok', chosen, {
    bundle_version: kv.version,
    matched_audience_ids: matchedAudienceIds,
    evidence_level: chosen.evidence_level,
  });
  execCtx.waitUntil(
    emitAuditEvent(env, request, {
      tenant_id,
      action: 'banner.serve',
      resource: chosen.banner_id,
      audit_correlation_id,
    }),
  );
  return jsonResponse(resp, 200, cors, nonce);
}

function jsonResponse(
  body: WorkerResponse,
  status: number,
  cors: Record<string, string>,
  nonce: string,
): Response {
  // CSP nonce を Content-Security-Policy header に乗せる
  // 顧客サイトの policy は customer-side、本 worker response 自体は API なので
  // Frontend (tracking.js) が `<style nonce="...">` / `<script nonce="...">` 描画時に再利用する
  const headers: Record<string, string> = {
    ...cors,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'X-Banner-Nonce': nonce, // 重複だが Frontend が header 経由で読みたい場合のため
  };
  return new Response(JSON.stringify(body), { status, headers });
}

// ── exports for unit test (test/*.test.mjs から import) ───────────────────

export const __test_only__ = {
  normalizeTenantId,
  verifyJwtHs256,
  audienceMatches,
  passesHoldout,
  shouldSkipSensitive,
  evaluateConsent,
  resolveTenantForBanner,
  readRuleBundleFromKv,
  readMemberAttribute,
  handleDecision,
  uuidv4,
  generateCspNonce,
  BANNER_RUNTIME_SCHEMA_VERSION,
  STALE_BUNDLE_DAYS,
};
