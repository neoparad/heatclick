/**
 * UGOKI LINK v2 — 束 3-D (手順 10): Origin Kit 設定・テンプレート生成器 (層 A 識別品質 + Server-Timing 橋渡し)
 *
 * 設計書 §4.5 (識別品質の層別 — 層 A) / §7.3, §7.4 / ゲート `tel.G11`:
 * - 4 ホスティング形式のテンプレート生成:
 *   1. `cloudflare_worker`
 *   2. `nextjs_middleware`
 *   3. `nginx`
 *   4. `wordpress` (設置・転送専用。WordPress 本体を記録元/DBにしない §7.3)
 * - 発行 Cookie 仕様: `HttpOnly; Secure; SameSite=Lax; Path=/`、最大寿命 **13ヶ月以下** (`<= 395日`)。
 * - `off` / `cookieless` 同意モードでは Cookie を一切発行・更新しない。
 * - 全テンプレートに `Server-Timing: ugk;desc="1.<rid>.<t>[.<mac>]"` 橋渡しヘッダ出力を含む。
 */

// ---------------------------------------------------------------------------
// Constants & Types
// ---------------------------------------------------------------------------

/** 13 months upper cap per §4.5 (395 days = 34,128,000 seconds) */
export const MAX_ORIGIN_COOKIE_MAX_AGE_SECONDS = 395 * 24 * 60 * 60

export const DEFAULT_ORIGIN_COOKIE_NAME = '__ugk_id'

export type OriginKitPlatform =
  | 'cloudflare_worker'
  | 'nextjs_middleware'
  | 'nginx'
  | 'wordpress'

export type OriginConsentMode = 'full' | 'essential_first_party' | 'cookieless' | 'off'

export interface OriginKitOptions {
  readonly tenant_id: string
  readonly site_id: string
  readonly host: string
  readonly ingest_endpoint?: string
  readonly cookie_name?: string
  /** Defaults to 395 days (13 months); throws if > 395 days */
  readonly max_age_seconds?: number
  readonly consent_mode: OriginConsentMode
  /** Cookie or header name checked by origin to confirm consent is not off/cookieless */
  readonly consent_cookie_name?: string
  readonly enable_server_timing_mac?: boolean
}

export interface OriginCookieSpec {
  readonly emitted: boolean
  readonly name: string
  readonly http_only: true
  readonly secure: true
  readonly same_site: 'Lax'
  readonly path: '/'
  readonly max_age_seconds: number
  readonly suppressed_in_modes: readonly ['off', 'cookieless']
  readonly suppression_reason: string | null
}

export interface OriginKitConfigResult {
  readonly platform: OriginKitPlatform
  readonly tenant_id: string
  readonly site_id: string
  readonly host: string
  /** §4.5 Identity Quality Stratum: 'A' when HttpOnly 1P cookie is active, 'C' when cookieless/off */
  readonly identity_quality_stratum: 'A' | 'C'
  readonly consent_mode: OriginConsentMode
  readonly cookie_spec: OriginCookieSpec
  readonly server_timing_header_format: string
  readonly consent_gating_rule: string
  readonly code_template: string
  readonly limitations: readonly string[]
}

// ---------------------------------------------------------------------------
// Runtime Cookie Header Builder (Enforces <= 13m & off/cookieless Suppression)
// ---------------------------------------------------------------------------

const VALID_COOKIE_NAME_RE = /^[A-Za-z0-9_!#$%&'*+\-.^`|~]{2,64}$/
const VALID_COOKIE_VALUE_RE = /^[A-Za-z0-9_-]{8,128}$/

export function validateOriginCookieMaxAge(maxAgeSeconds: number): number {
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new Error(`Invalid origin cookie max_age_seconds: ${maxAgeSeconds}`)
  }
  if (maxAgeSeconds > MAX_ORIGIN_COOKIE_MAX_AGE_SECONDS) {
    throw new Error(
      `Origin cookie max_age_seconds (${maxAgeSeconds}) exceeds 13-month cap (${MAX_ORIGIN_COOKIE_MAX_AGE_SECONDS})`,
    )
  }
  return maxAgeSeconds
}

/**
 * 実行時に `Set-Cookie` ヘッダ文字列を生成する。
 * - `off` / `cookieless` / 未確定同意 (`consent_resolved === false` または `'unresolved'` / `'pending'`) では
 *   必ず `null` を返し、同意確定前の持続 Cookie 発行を物理防止する (§4.5)。
 */
export function buildOriginCookieSetHeader(params: {
  readonly consent_mode: OriginConsentMode | 'unresolved' | 'pending'
  readonly consent_resolved?: boolean
  readonly cookie_value: string
  readonly cookie_name?: string
  readonly max_age_seconds?: number
}): string | null {
  if (params.consent_resolved === false) {
    return null
  }
  if (params.consent_mode !== 'full' && params.consent_mode !== 'essential_first_party') {
    return null
  }
  const name = params.cookie_name ?? DEFAULT_ORIGIN_COOKIE_NAME
  if (!VALID_COOKIE_NAME_RE.test(name)) {
    throw new Error(`Invalid cookie_name: "${name}"`)
  }
  if (!VALID_COOKIE_VALUE_RE.test(params.cookie_value)) {
    throw new Error('Invalid cookie_value format')
  }
  const maxAge = validateOriginCookieMaxAge(
    params.max_age_seconds ?? MAX_ORIGIN_COOKIE_MAX_AGE_SECONDS,
  )
  return `${name}=${params.cookie_value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
}

// ---------------------------------------------------------------------------
// Platform Template Generators
// ---------------------------------------------------------------------------

export function generateOriginKitConfig(
  platform: OriginKitPlatform,
  options: OriginKitOptions,
): OriginKitConfigResult {
  if (!options.tenant_id.trim() || !options.site_id.trim() || !options.host.trim()) {
    throw new Error('tenant_id, site_id, and host are required for Origin Kit generation')
  }

  const cookieName = options.cookie_name ?? DEFAULT_ORIGIN_COOKIE_NAME
  if (!VALID_COOKIE_NAME_RE.test(cookieName)) {
    throw new Error(`Invalid cookie_name: "${cookieName}"`)
  }
  const maxAge = validateOriginCookieMaxAge(
    options.max_age_seconds ?? MAX_ORIGIN_COOKIE_MAX_AGE_SECONDS,
  )
  const consentCookie = options.consent_cookie_name ?? '__ugk_consent'
  const ingestEndpoint = options.ingest_endpoint ?? 'https://ingest.ugokilink.jp/v2/logs'
  const useMac = options.enable_server_timing_mac ?? true

  const cookieEmitted = options.consent_mode !== 'off' && options.consent_mode !== 'cookieless'
  const cookieSpec: OriginCookieSpec = Object.freeze({
    emitted: cookieEmitted,
    name: cookieName,
    http_only: true,
    secure: true,
    same_site: 'Lax',
    path: '/',
    max_age_seconds: maxAge,
    suppressed_in_modes: Object.freeze(['off', 'cookieless'] as const),
    suppression_reason: cookieEmitted
      ? null
      : `Cookie issuance strictly suppressed in consent_mode="${options.consent_mode}" (§4.5)`,
  })

  const serverTimingFormat = useMac
    ? 'Server-Timing: ugk;desc="1.<rid>.<unix_sec>.<hmac64_hex>"'
    : 'Server-Timing: ugk;desc="1.<rid>.<unix_sec>"'

  const consentGatingRule =
    `Emit ${cookieName} (HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}) ONLY when ` +
    `consent_mode is neither "off" nor "cookieless" AND explicit resolved ${consentCookie} cookie is "full" or "essential_first_party" (never pre-consent; never echo ${cookieName} or UGK_EDGE_SECRET in Server-Timing).`

  let codeTemplate: string
  let limitations: string[]

  switch (platform) {
    case 'cloudflare_worker':
      codeTemplate = renderCloudflareWorkerTemplate({
        tenantId: options.tenant_id,
        siteId: options.site_id,
        cookieName,
        maxAge,
        consentMode: options.consent_mode,
        consentCookie,
        ingestEndpoint,
        cookieEmitted,
        useMac,
      })
      limitations = [
        'Requires Worker route bound to document paths on the first-party hostname.',
        'Do not cache Set-Cookie or per-request Server-Timing headers across visitors at CDN layer.',
      ]
      break

    case 'nextjs_middleware':
      codeTemplate = renderNextjsMiddlewareTemplate({
        tenantId: options.tenant_id,
        siteId: options.site_id,
        cookieName,
        maxAge,
        consentMode: options.consent_mode,
        consentCookie,
        cookieEmitted,
        useMac,
      })
      limitations = [
        'Static CDN-cached pages bypass middleware unless dynamic/edge execution is enabled.',
        'Shared CDN front-cache reuse is automatically flagged via shared_cache handoff detection.',
      ]
      break

    case 'nginx':
      codeTemplate = renderNginxTemplate({
        tenantId: options.tenant_id,
        siteId: options.site_id,
        cookieName,
        maxAge,
        consentMode: options.consent_mode,
        consentCookie,
        cookieEmitted,
      })
      limitations = [
        'Requires $request_id (Nginx >= 1.11.0) and trusted real_ip_header attestation (Origin-Forgery Probe act.G5).',
        'If behind a reverse proxy or CDN, configure set_real_ip_from strictly to proxy CIDRs only.',
      ]
      break

    case 'wordpress':
      codeTemplate = renderWordpressTemplate({
        tenantId: options.tenant_id,
        siteId: options.site_id,
        cookieName,
        maxAge,
        consentMode: options.consent_mode,
        consentCookie,
        cookieEmitted,
      })
      limitations = [
        'WordPress plugin is installer/header-emitter/shipper ONLY — never a system of record (no analytics tables in WP DB, §7.3).',
        'Full-page cache HITs (LiteSpeed/WP Rocket/Cloudflare APO) bypass PHP; Server-Timing handoff automatically detects shared_cache.',
      ]
      break
  }

  return Object.freeze({
    platform,
    tenant_id: options.tenant_id,
    site_id: options.site_id,
    host: options.host.toLowerCase(),
    identity_quality_stratum: cookieEmitted ? 'A' : 'C',
    consent_mode: options.consent_mode,
    cookie_spec: cookieSpec,
    server_timing_header_format: serverTimingFormat,
    consent_gating_rule: consentGatingRule,
    code_template: codeTemplate,
    limitations: Object.freeze(limitations),
  })
}

interface TemplateVars {
  readonly tenantId: string
  readonly siteId: string
  readonly cookieName: string
  readonly maxAge: number
  readonly consentMode: OriginConsentMode
  readonly consentCookie: string
  readonly ingestEndpoint?: string
  readonly cookieEmitted: boolean
  readonly useMac?: boolean
}

function renderCloudflareWorkerTemplate(v: TemplateVars): string {
  const cookieBlock = v.cookieEmitted
    ? `    const consent = getCookie(request, '${v.consentCookie}');
    if ((consent === 'full' || consent === 'essential_first_party') && !getCookie(request, '${v.cookieName}')) {
      const uid = crypto.randomUUID().replace(/-/g, '');
      headers.append('Set-Cookie', \`${v.cookieName}=\${uid}; Path=/; Max-Age=${v.maxAge}; HttpOnly; Secure; SameSite=Lax\`);
    }`
    : `    // Consent mode is "${v.consentMode}": first-party cookie issuance is strictly suppressed (§4.5).`

  const macLine = v.useMac
    ? `    const mac = await signHmac16(env.UGK_EDGE_SECRET, \`1|\${rid}|\${ts}|\${url.hostname.toLowerCase()}|\${url.pathname}\`);
    headers.append('Server-Timing', \`ugk;desc="1.\${rid}.\${ts}.\${mac}"\`);`
    : `    headers.append('Server-Timing', \`ugk;desc="1.\${rid}.\${ts}"\`);`

  return `// UGOKI LINK v2 Origin Kit — Cloudflare Worker (tenant=${v.tenantId}, site=${v.siteId})
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const response = await fetch(request);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return response;

    const rid = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    const ts = Math.floor(Date.now() / 1000);
    const headers = new Headers(response.headers);
${macLine}
${cookieBlock}

    ctx.waitUntil(shipObservation(env, '${v.ingestEndpoint}', {
      tenant_id: '${v.tenantId}', site_id: '${v.siteId}',
      request_id: rid, observed_at: new Date(ts * 1000).toISOString(),
      host: url.hostname, path: url.pathname, method: request.method,
      status: response.status, client_ip: request.headers.get('cf-connecting-ip'),
      user_agent: request.headers.get('user-agent'),
    }));
    return new Response(response.body, { status: response.status, headers });
  },
};`
}

function renderNextjsMiddlewareTemplate(v: TemplateVars): string {
  const cookieBlock = v.cookieEmitted
    ? `  const consent = request.cookies.get('${v.consentCookie}')?.value
  if ((consent === 'full' || consent === 'essential_first_party') && !request.cookies.get('${v.cookieName}')) {
    const uid = crypto.randomUUID().replace(/-/g, '')
    response.cookies.set('${v.cookieName}', uid, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: ${v.maxAge},
    })
  }`
    : `  // Consent mode is "${v.consentMode}": first-party cookie issuance is strictly suppressed (§4.5).`

  const timingVal = v.useMac
    ? `ugk;desc="1.\${rid}.\${ts}.\${mac}"`
    : `ugk;desc="1.\${rid}.\${ts}"`

  return `// UGOKI LINK v2 Origin Kit — Next.js Middleware (tenant=${v.tenantId}, site=${v.siteId})
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  const response = NextResponse.next()
  const rid = crypto.randomUUID().replace(/-/g, '').slice(0, 24)
  const ts = Math.floor(Date.now() / 1000)
${v.useMac ? `  const mac = await computeEdgeMac16(process.env.UGK_EDGE_SECRET ?? '', \`1|\${rid}|\${ts}|\${request.nextUrl.hostname}|\${request.nextUrl.pathname}\`)\n` : ''}  response.headers.append('Server-Timing', \`${timingVal}\`)
${cookieBlock}
  return response
}`
}

function renderNginxTemplate(v: TemplateVars): string {
  const cookieLines = v.cookieEmitted
    ? `# Consent-gated HttpOnly 1P cookie (strictly suppressed until ${v.consentCookie} is explicitly "full" or "essential_first_party";
# NEVER reuse $request_id for ${v.cookieName} so Server-Timing never leaks the HttpOnly visitor cookie to JS!)
map $cookie_${v.consentCookie} $ugk_cookie_allowed {
    default 0;
    "full" 1;
    "essential_first_party" 1;
}
# $ugk_cookie_uid MUST be populated from an independent CSPRNG source (e.g. njs/Lua CSPRNG or upstream X-Ugk-New-Uid), NEVER $request_id
map "$ugk_cookie_allowed:$cookie_${v.cookieName}:$ugk_cookie_uid" $ugk_set_cookie {
    "~^1::([A-Za-z0-9_-]{16,64})$" "${v.cookieName}=$1; Path=/; Max-Age=${v.maxAge}; HttpOnly; Secure; SameSite=Lax";
    default "";
}
add_header Set-Cookie $ugk_set_cookie always;`
    : `# Consent mode is "${v.consentMode}": Set-Cookie strictly suppressed (§4.5).`

  return `# UGOKI LINK v2 Origin Kit — Nginx (tenant=${v.tenantId}, site=${v.siteId})
# Server-Timing handoff for 1-to-1 document join (carries ONLY per-request $request_id and $msec; never cookies or secrets)
add_header Server-Timing 'ugk;desc="1.$request_id.$msec"' always;
${cookieLines}`
}

function renderWordpressTemplate(v: TemplateVars): string {
  const cookieBlock = v.cookieEmitted
    ? `    $consent = $_COOKIE['${v.consentCookie}'] ?? null;
    if (($consent === 'full' || $consent === 'essential_first_party') && empty($_COOKIE['${v.cookieName}'])) {
        $uid = bin2hex(random_bytes(16));
        setcookie('${v.cookieName}', $uid, [
            'expires'  => time() + ${v.maxAge},
            'path'     => '/',
            'secure'   => true,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }`
    : `    // Consent mode is "${v.consentMode}": first-party cookie issuance is strictly suppressed (§4.5).`

  return `<?php
// UGOKI LINK v2 Origin Kit — WordPress (Installer/Header-Emitter ONLY; no WP DB storage §7.3)
// tenant=${v.tenantId}, site=${v.siteId}
add_action('send_headers', function () {
    if (is_admin() || headers_sent()) return;
    $rid = bin2hex(random_bytes(12));
    $ts  = time();
    header('Server-Timing: ugk;desc="1.' . $rid . '.' . $ts . '"', false);
${cookieBlock}
});`
}
