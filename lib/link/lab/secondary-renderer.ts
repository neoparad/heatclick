/**
 * UGOKI LINK v2 — 束 2-C (手順 5): LINK 側の第 2 描画環境アダプタ
 *
 * CRAWL 1 台依存を外すための第 2 描画エンジン抽象と、
 * 検査環境の作法強制（広告・解析・アフィリエイト登録簿ホストへの通信 0 件遮断、
 * 描画目的時の LINK 受付遮断、robots.txt 遵守＋オーナー例外）、
 * 共通区切りプログラム (`packages/contract/segmenter`) のハッシュ固定実行、
 * 数分おき 2 回描画による揺らぎ区画検出、5 階級需要に対する 2x 能力ゲート計測を提供する。
 *
 * 設計根拠:
 * - マスター設計書 v2 §6.1–§6.3, §6.5, §6.7, §11.4, §12.2, §13.2 手順 5
 * - join-final.md M1, M3, M7, R-4, R-6, R-7, R-12, R-20
 * - ゲート: `surf.second_executor`, `surf.capacity`, `join.G15`
 */

import { createHash } from 'node:crypto'

import {
  DEFAULT_PRUNE_REGISTRY,
  SEGMENTER_CONTENT_HASH,
  SEGMENTER_RULE_REVISIONS,
  classifyPrunedNode,
  parseHtmlToDom,
  segmentDocument,
  type SegDocumentLike,
  type SegElementLike,
  type SegNodeLike,
  type SegmentOptions,
  type SegmenterOutput,
} from '@/packages/contract/segmenter'
import { computeUrlKeyV2, type UrlKeyV2Result, type UrlKeyV2Rules } from '@/packages/contract/urlkey'

// ---------------------------------------------------------------------------
// Device Profiles (Real Mobile & Desktop Descriptors — §15 item 6)
// ---------------------------------------------------------------------------

export type RenderEngineKind = 'chromium' | 'webkit' | 'firefox' | 'deterministic_html'

export type DeviceClass = 'desktop' | 'mobile'

export interface LabDeviceProfile {
  readonly profile_id: string
  readonly device_class: DeviceClass
  readonly engine: RenderEngineKind
  readonly viewport: { readonly width: number; readonly height: number }
  /** join-final.md R-6: pixel ratio pinned to 1 for deterministic tiled screenshots */
  readonly device_scale_factor: 1
  readonly is_mobile: boolean
  readonly has_touch: boolean
  readonly user_agent: string
  readonly locale: string
  readonly timezone_id: string
}

export const LAB_PRODUCT_TOKEN = 'UGOKILinkLab/2.0 (+https://ugokilink.jp/lab-bot)'

export const DEVICE_PROFILES: Readonly<Record<'desktop_chromium' | 'mobile_android_chromium' | 'mobile_ios_webkit', LabDeviceProfile>> =
  Object.freeze({
    desktop_chromium: Object.freeze({
      profile_id: 'desktop_chromium_1280x800',
      device_class: 'desktop',
      engine: 'chromium',
      viewport: Object.freeze({ width: 1280, height: 800 }),
      device_scale_factor: 1,
      is_mobile: false,
      has_touch: false,
      user_agent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 ${LAB_PRODUCT_TOKEN}`,
      locale: 'ja-JP',
      timezone_id: 'Asia/Tokyo',
    }),
    mobile_android_chromium: Object.freeze({
      profile_id: 'mobile_android_chromium_390x844',
      device_class: 'mobile',
      engine: 'chromium',
      viewport: Object.freeze({ width: 390, height: 844 }),
      device_scale_factor: 1,
      is_mobile: true,
      has_touch: true,
      user_agent: `Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 ${LAB_PRODUCT_TOKEN}`,
      locale: 'ja-JP',
      timezone_id: 'Asia/Tokyo',
    }),
    mobile_ios_webkit: Object.freeze({
      profile_id: 'mobile_ios_webkit_390x844',
      device_class: 'mobile',
      engine: 'webkit',
      viewport: Object.freeze({ width: 390, height: 844 }),
      device_scale_factor: 1,
      is_mobile: true,
      has_touch: true,
      user_agent: `Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 ${LAB_PRODUCT_TOKEN}`,
      locale: 'ja-JP',
      timezone_id: 'Asia/Tokyo',
    }),
  })

// ---------------------------------------------------------------------------
// Lab Network Etiquette & Blocklist (§6.5, §6.7, §12.2)
// ---------------------------------------------------------------------------

export type LabPurpose =
  | 'render'
  | 'canary_visit'
  | 'install_probe'
  | 'preflight'
  | 'agent_run'
  | 'panel'

export type NetworkDecisionAction = 'allow' | 'block'

export type NetworkDecisionReason =
  | 'allowed_target_or_asset'
  | 'allowed_collector_with_lab_token'
  | 'blocked_affiliate_host'
  | 'blocked_analytics_host'
  | 'blocked_ad_host'
  | 'blocked_collector_render_purpose'
  | 'blocked_collector_missing_lab_token'
  | 'blocked_external_redirect'
  | 'blocked_private_ip_ssrf'
  | 'blocked_non_http_scheme'

export interface LabBlocklistRegistry {
  readonly rev: string
  readonly affiliateHosts: readonly string[]
  readonly analyticsHosts: readonly string[]
  readonly adHosts: readonly string[]
  readonly collectorHosts: readonly string[]
}

/**
 * 版付き検査環境遮断一覧 (設計書 §6.5 / §6.7)。
 * アフィリエイト登録簿ホストは通信層で無条件遮断し、クリック水増し 0 件をゲート化する。
 */
export const DEFAULT_LAB_BLOCKLIST: LabBlocklistRegistry = Object.freeze({
  rev: 'lab-blocklist/1',
  affiliateHosts: Object.freeze([
    'a8.net',
    'px.a8.net',
    'afb.ne.jp',
    't.afb.ne.jp',
    'track.affiliate-b.com',
    'hb.afl.rakuten.co.jp',
    'afl.rakuten.co.jp',
    'ck.jp.ap.valuecommerce.com',
    'valuecommerce.com',
    'h.accesstrade.net',
    'accesstrade.net',
    'amzn.to',
    'amazon-adsystem.com',
    'click.linksynergy.com',
    'linksynergy.com',
    't.felmat.net',
    'felmat.net',
    'j-a-net.jp',
    'rentracks.jp',
    'af.moshimo.com',
    'moshimo.com',
    'tcs-asp.net',
    'smart-c.jp',
    'circuit.jp',
  ]),
  analyticsHosts: Object.freeze([
    'google-analytics.com',
    'analytics.google.com',
    'googletagmanager.com',
    'connect.facebook.net',
    'clarity.ms',
    'hotjar.com',
    'static.hotjar.com',
    'mixpanel.com',
    'api.segment.io',
    'cdn.segment.com',
    'plausible.io',
    'bat.bing.com',
    'analytics.tiktok.com',
    'tr.line.me',
  ]),
  adHosts: Object.freeze([
    'doubleclick.net',
    'googlesyndication.com',
    'googleadservices.com',
    'adservice.google.com',
    'pagead2.googlesyndication.com',
    'criteo.com',
    'criteo.net',
    'taboola.com',
    'outbrain.com',
    'ads-twitter.com',
    'yads.c.yimg.jp',
    'im-apps.net',
  ]),
  collectorHosts: Object.freeze([
    'collect.ugokilink.jp',
    'ingest.ugokimap.jp',
    'events.ugokilink.jp',
  ]),
})

export interface NetworkAuditEntry {
  readonly url: string
  readonly host: string
  readonly is_redirect: boolean
  readonly action: NetworkDecisionAction
  readonly reason: NetworkDecisionReason
  readonly category: 'affiliate' | 'analytics' | 'ad' | 'collector' | 'redirect' | 'ssrf' | 'target'
}

export interface NetworkDecision {
  readonly action: NetworkDecisionAction
  readonly reason: NetworkDecisionReason
  readonly category: NetworkAuditEntry['category']
  readonly host: string
}

function hostMatchesRegistry(hostname: string, list: readonly string[]): boolean {
  const low = hostname.toLowerCase().replace(/\.+$/, '')
  for (let i = 0; i < list.length; i++) {
    const entry = list[i].toLowerCase()
    if (low === entry || low.endsWith('.' + entry)) {
      return true
    }
  }
  return false
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const low = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (low === 'localhost' || low === '::1' || low.endsWith('.local') || low.endsWith('.internal')) {
    return true
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(low)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

export interface LabNetworkPolicyContext {
  readonly targetHost: string
  readonly labPurpose: LabPurpose
  readonly labToken?: string | null
  readonly blocklist?: LabBlocklistRegistry
  readonly allowPrivateHostsForTest?: boolean
  readonly allowedExternalRedirectHosts?: readonly string[]
}

/**
 * 検査環境ネットワーク層の単一遮断判定器。
 * 1) 登録済みアフィリエイトホストは無条件遮断 (`affiliate_requests_sent === 0`)
 * 2) 解析・広告ホストは無条件遮断
 * 3) LINK 受付は `labPurpose === 'render'` では遮断、その他目的は `labToken` 付きのみ許可
 * 4) 登録簿にない外部ホストへのリダイレクトは既定で追わない (§6.5)
 * 5) プライベート IP / SSRF 対象を遮断 (テスト許可フラグ除く)
 */
export function evaluateLabNetworkRequest(
  rawUrl: string,
  ctx: LabNetworkPolicyContext,
  options?: { readonly isRedirect?: boolean },
): NetworkDecision {
  const blocklist = ctx.blocklist ?? DEFAULT_LAB_BLOCKLIST
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return Object.freeze({
      action: 'block',
      reason: 'blocked_non_http_scheme',
      category: 'ssrf',
      host: '',
    })
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Object.freeze({
      action: 'block',
      reason: 'blocked_non_http_scheme',
      category: 'ssrf',
      host: parsed.hostname.toLowerCase(),
    })
  }

  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '')

  if (!ctx.allowPrivateHostsForTest && isPrivateOrLoopbackHost(host)) {
    return Object.freeze({
      action: 'block',
      reason: 'blocked_private_ip_ssrf',
      category: 'ssrf',
      host,
    })
  }

  // 1. Affiliate registry hosts: ALWAYS blocked (0 clicks / 0 impressions guarantee)
  if (hostMatchesRegistry(host, blocklist.affiliateHosts)) {
    return Object.freeze({
      action: 'block',
      reason: 'blocked_affiliate_host',
      category: 'affiliate',
      host,
    })
  }

  // 2. Analytics hosts: ALWAYS blocked
  if (hostMatchesRegistry(host, blocklist.analyticsHosts)) {
    return Object.freeze({
      action: 'block',
      reason: 'blocked_analytics_host',
      category: 'analytics',
      host,
    })
  }

  // 3. Ad hosts: ALWAYS blocked
  if (hostMatchesRegistry(host, blocklist.adHosts)) {
    return Object.freeze({
      action: 'block',
      reason: 'blocked_ad_host',
      category: 'ad',
      host,
    })
  }

  // 4. LINK Collector hosts: blocked during 'render'; allowed only with lab_token for other lab purposes
  if (hostMatchesRegistry(host, blocklist.collectorHosts)) {
    if (ctx.labPurpose === 'render') {
      return Object.freeze({
        action: 'block',
        reason: 'blocked_collector_render_purpose',
        category: 'collector',
        host,
      })
    }
    if (!ctx.labToken || ctx.labToken.trim().length === 0) {
      return Object.freeze({
        action: 'block',
        reason: 'blocked_collector_missing_lab_token',
        category: 'collector',
        host,
      })
    }
    return Object.freeze({
      action: 'allow',
      reason: 'allowed_collector_with_lab_token',
      category: 'collector',
      host,
    })
  }

  // 5. External redirects blocked by default (§6.5: 外部ホストへの転送は既定で追わない)
  const targetNorm = ctx.targetHost.toLowerCase().replace(/^www\./, '').replace(/\.+$/, '')
  const hostNorm = host.replace(/^www\./, '')
  const isSameSite = hostNorm === targetNorm || hostNorm.endsWith('.' + targetNorm)
  if (options?.isRedirect && !isSameSite) {
    const allowedExt = ctx.allowedExternalRedirectHosts ?? []
    if (!hostMatchesRegistry(host, allowedExt)) {
      return Object.freeze({
        action: 'block',
        reason: 'blocked_external_redirect',
        category: 'redirect',
        host,
      })
    }
  }

  return Object.freeze({
    action: 'allow',
    reason: 'allowed_target_or_asset',
    category: 'target',
    host,
  })
}

// ---------------------------------------------------------------------------
// RFC 9309 Full robots.txt Parser (No 4 KB truncation — §15 item 13)
// ---------------------------------------------------------------------------

export interface RobotsOverrideApproval {
  readonly approved_by_user_id: string
  readonly approved_at: string
  readonly host: string
  readonly reason: string
}

export interface RobotsCheckResult {
  readonly allowed: boolean
  readonly matched_agent_group: string | null
  readonly matched_rule: string | null
  readonly overridden_by_owner: boolean
}

const MAX_ROBOTS_BYTES = 512 * 1024 // RFC 9309 >= 500 KiB

export function evaluateRobotsTxt(
  robotsTxt: string | null,
  pathname: string,
  agentTokens: readonly string[] = ['UGOKILinkLab', 'LinkthCrawl'],
  override?: RobotsOverrideApproval | null,
  targetHost?: string,
): RobotsCheckResult {
  if (
    override &&
    targetHost &&
    override.host.toLowerCase() === targetHost.toLowerCase() &&
    override.approved_by_user_id.trim().length > 0
  ) {
    return Object.freeze({
      allowed: true,
      matched_agent_group: null,
      matched_rule: null,
      overridden_by_owner: true,
    })
  }

  if (!robotsTxt || robotsTxt.trim().length === 0) {
    return Object.freeze({
      allowed: true,
      matched_agent_group: null,
      matched_rule: null,
      overridden_by_owner: false,
    })
  }

  const bounded = robotsTxt.length > MAX_ROBOTS_BYTES ? robotsTxt.slice(0, MAX_ROBOTS_BYTES) : robotsTxt
  const lines = bounded.split(/\r?\n/)

  interface Group {
    agents: string[]
    rules: Array<{ type: 'allow' | 'disallow'; pattern: string }>
  }
  const groups: Group[] = []
  let current: Group | null = null
  let sawRuleInCurrent = false

  for (const rawLine of lines) {
    const commentIdx = rawLine.indexOf('#')
    const line = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trim()
    if (!line) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx <= 0) continue
    const field = line.slice(0, colonIdx).trim().toLowerCase()
    const value = line.slice(colonIdx + 1).trim()

    if (field === 'user-agent') {
      if (!current || sawRuleInCurrent) {
        current = { agents: [], rules: [] }
        groups.push(current)
        sawRuleInCurrent = false
      }
      if (value) current.agents.push(value.toLowerCase())
    } else if ((field === 'allow' || field === 'disallow') && current) {
      sawRuleInCurrent = true
      if (value.length > 0) {
        current.rules.push({ type: field, pattern: value })
      }
    }
  }

  const wantedAgents = agentTokens.map((a) => a.toLowerCase())
  const specificGroups = groups.filter((g) => g.agents.some((a) => wantedAgents.includes(a)))
  const wildcardGroups = groups.filter((g) => g.agents.includes('*'))
  const activeGroups = specificGroups.length > 0 ? specificGroups : wildcardGroups

  if (activeGroups.length === 0) {
    return Object.freeze({
      allowed: true,
      matched_agent_group: null,
      matched_rule: null,
      overridden_by_owner: false,
    })
  }

  const matchesRobotsPattern = (targetPath: string, pattern: string): boolean => {
    const endAnchor = pattern.endsWith('$')
    const core = endAnchor ? pattern.slice(0, -1) : pattern
    const escaped = core.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    const re = new RegExp(`^${escaped}${endAnchor ? '$' : ''}`)
    return re.test(targetPath)
  }

  let bestRule: { type: 'allow' | 'disallow'; pattern: string; groupAgent: string } | null = null
  for (const grp of activeGroups) {
    const groupAgent = grp.agents[0] ?? '*'
    for (const rule of grp.rules) {
      if (!matchesRobotsPattern(pathname, rule.pattern)) continue
      if (
        bestRule === null ||
        rule.pattern.length > bestRule.pattern.length ||
        (rule.pattern.length === bestRule.pattern.length && rule.type === 'allow')
      ) {
        bestRule = { type: rule.type, pattern: rule.pattern, groupAgent }
      }
    }
  }

  if (!bestRule) {
    return Object.freeze({
      allowed: true,
      matched_agent_group: activeGroups[0].agents[0] ?? '*',
      matched_rule: null,
      overridden_by_owner: false,
    })
  }

  return Object.freeze({
    allowed: bestRule.type === 'allow',
    matched_agent_group: bestRule.groupAgent,
    matched_rule: `${bestRule.type}: ${bestRule.pattern}`,
    overridden_by_owner: false,
  })
}

// ---------------------------------------------------------------------------
// Render Job Types, Geometry, Computed Styles & Screenshot Metadata
// ---------------------------------------------------------------------------

export type RenderJobClass = 'id_only' | 'full'

export type LabRenderTerminalStatus =
  | 'ok'
  | 'robots_blocked'
  | 'bot_blocked'
  | 'auth_wall'
  | 'timeout'
  | 'render_failed'

export interface ForcedVariantSpec {
  readonly variant_set_key: string
  readonly forced_arms: Readonly<Record<string, string>>
  readonly action_hash: string
}

export interface ElementRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ComputedCtaStyle {
  readonly color: string | null
  readonly background_color: string | null
  readonly font_size_px: number | null
  readonly font_weight: string | null
  readonly display: string | null
  readonly position: string | null
}

export interface RenderedSectionGeometry {
  readonly sec_fp: string
  /** Unmeasured must be null, NEVER 0 (§11.3 / R-12) */
  readonly top_px: number | null
  readonly height_px: number | null
  readonly top_frac: number | null
  readonly height_frac: number | null
}

export interface RenderedElementDetails {
  readonly el_fp: string
  readonly kind: string
  readonly region: 'root' | 'chrome'
  readonly sec_fp: string | null
  readonly slot_id: string
  readonly tag_name: string
  readonly is_native_control: boolean
  readonly role: string | null
  readonly accessible_name: string | null
  readonly has_label_binding: boolean
  readonly focusable: boolean
  readonly aria_hidden: boolean
  readonly disabled: boolean
  readonly href: string | null
  readonly dest_key_static: string | null
  readonly is_affiliate_link: boolean
  /** Geometry/style fields are strictly null on id_only renders (NEVER 0) */
  readonly rect: ElementRect | null
  readonly occluded: boolean | null
  readonly hover_only_reveal: boolean | null
  readonly pointer_events_none: boolean | null
  readonly computed_style: ComputedCtaStyle | null
}

export interface ScreenshotMeta {
  /** Key includes profile & variant so desktop and mobile never overwrite each other (§15 item 6) */
  readonly storage_key: string
  readonly width_px: number
  readonly height_px: number
  readonly pixel_ratio: 1
  readonly tile_count: number
  readonly perceptual_hash: string
  readonly known_differences: readonly string[]
}

export interface RenderPageRequest {
  readonly tenant_id: string
  readonly site_id: string
  readonly url: string
  readonly job_class: RenderJobClass
  readonly profile: LabDeviceProfile
  readonly lab_purpose?: LabPurpose
  readonly lab_token?: string | null
  readonly variant?: ForcedVariantSpec | null
  readonly robots_txt?: string | null
  readonly robots_override?: RobotsOverrideApproval | null
  readonly url_rules?: UrlKeyV2Rules
  readonly segment_options?: SegmentOptions
  readonly blocklist?: LabBlocklistRegistry
  readonly allow_private_hosts_for_test?: boolean
}

export interface RenderPageResult {
  readonly tenant_id: string
  readonly site_id: string
  readonly status: LabRenderTerminalStatus
  readonly unlock: string | null
  readonly rendered_at: string
  readonly job_class: RenderJobClass
  readonly executor_id: string
  readonly profile: LabDeviceProfile
  readonly variant_set_key: string
  readonly raw_url: string
  readonly final_url: string
  readonly url_key_result: UrlKeyV2Result
  readonly segmenter_hash: string
  readonly rule_revisions: typeof SEGMENTER_RULE_REVISIONS
  readonly segmenter_output: SegmenterOutput | null
  /** Unmeasured geometry/screenshot/probe fields are strictly null (NEVER 0) */
  readonly doc_h_px: number | null
  readonly section_geometries: readonly RenderedSectionGeometry[] | null
  readonly element_details: readonly RenderedElementDetails[]
  readonly screenshot: ScreenshotMeta | null
  readonly render_duration_ms: number | null
  readonly egress_audit: {
    readonly total_requests_evaluated: number
    readonly allowed_count: number
    readonly blocked_count: number
    readonly affiliate_requests_sent: number
    readonly affiliate_requests_blocked: number
    readonly collector_requests_blocked: number
    readonly entries: readonly NetworkAuditEntry[]
  }
  readonly known_lab_differences: readonly string[]
}

// ---------------------------------------------------------------------------
// Driver Interface (Playwright Adapter + Deterministic HTML/DOM CI Runner)
// ---------------------------------------------------------------------------

export interface DriverCapturedPage {
  readonly status: LabRenderTerminalStatus
  readonly final_url: string
  readonly document: SegDocumentLike | null
  /** Full-render only; null for id_only */
  readonly doc_h_px: number | null
  readonly section_geometries: readonly RenderedSectionGeometry[] | null
  readonly element_geometry_by_el_fp: Readonly<
    Record<
      string,
      {
        readonly rect: ElementRect | null
        readonly occluded: boolean | null
        readonly hover_only_reveal: boolean | null
        readonly pointer_events_none: boolean | null
        readonly computed_style: ComputedCtaStyle | null
      }
    >
  > | null
  readonly screenshot_bytes_digest: string | null
  readonly duration_ms: number | null
  readonly subresource_requests: readonly { readonly url: string; readonly is_redirect?: boolean }[]
}

export interface RenderDriver {
  readonly executor_id: string
  render(
    request: RenderPageRequest,
    evaluateRequest: (url: string, opts?: { readonly isRedirect?: boolean }) => NetworkDecision,
  ): Promise<DriverCapturedPage>
}

// ---------------------------------------------------------------------------
// Playwright Driver Adapter (Plug-in seam for headless Chromium/WebKit/Firefox)
// ---------------------------------------------------------------------------

export interface PlaywrightLikeRoute {
  request(): { url(): string; isNavigationRequest(): boolean }
  abort(errorCode?: string): Promise<void>
  continue(overrides?: { headers?: Record<string, string> }): Promise<void>
}

export interface PlaywrightLikePage {
  setViewportSize(size: { width: number; height: number }): Promise<void>
  route(pattern: string, handler: (route: PlaywrightLikeRoute) => Promise<void> | void): Promise<void>
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<{ status(): number; url(): string } | null>
  content(): Promise<string>
  evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>
  screenshot?(options?: { fullPage?: boolean }): Promise<Uint8Array>
  close(): Promise<void>
}

export interface PlaywrightLikeContext {
  newPage(): Promise<PlaywrightLikePage>
  close(): Promise<void>
}

export interface PlaywrightLikeBrowser {
  newContext(options: {
    viewport: { width: number; height: number }
    deviceScaleFactor: number
    isMobile: boolean
    hasTouch: boolean
    userAgent: string
    locale: string
    timezoneId: string
  }): Promise<PlaywrightLikeContext>
}

/**
 * 実 Playwright ブラウザへ接続するための第 2 描画ドライバアダプタ。
 * すべてのネットワーク要求を `page.route` で `evaluateLabNetworkRequest` へ通し、
 * アフィリエイト・広告・解析・描画時受付を通信層で完全遮断する。
 */
export function createPlaywrightRenderDriver(
  getBrowser: (engine: RenderEngineKind) => Promise<PlaywrightLikeBrowser>,
  executorId = 'ugoki-second-executor-playwright/1',
): RenderDriver {
  return {
    executor_id: executorId,
    async render(request, evaluateRequest): Promise<DriverCapturedPage> {
      const started = Date.now()
      const browser = await getBrowser(request.profile.engine)
      const context = await browser.newContext({
        viewport: request.profile.viewport,
        deviceScaleFactor: request.profile.device_scale_factor,
        isMobile: request.profile.is_mobile,
        hasTouch: request.profile.has_touch,
        userAgent: request.profile.user_agent,
        locale: request.profile.locale,
        timezoneId: request.profile.timezone_id,
      })

      const seenRequests: Array<{ url: string; is_redirect?: boolean }> = []

      try {
        const page = await context.newPage()
        await page.route('**/*', async (route) => {
          const reqUrl = route.request().url()
          seenRequests.push({ url: reqUrl })
          const decision = evaluateRequest(reqUrl)
          if (decision.action === 'block') {
            await route.abort('blockedbyclient')
          } else {
            await route.continue()
          }
        })

        const response = await page.goto(request.url, { waitUntil: 'networkidle', timeout: 25_000 })
        const httpStatus = response ? response.status() : 0
        if (httpStatus === 401 || httpStatus === 403) {
          return {
            status: httpStatus === 401 ? 'auth_wall' : 'bot_blocked',
            final_url: response?.url() ?? request.url,
            document: null,
            doc_h_px: null,
            section_geometries: null,
            element_geometry_by_el_fp: null,
            screenshot_bytes_digest: null,
            duration_ms: Date.now() - started,
            subresource_requests: seenRequests,
          }
        }

        const html = await page.content()
        const doc = parseHtmlToDom(html)
        const finalUrl = response?.url() ?? request.url

        if (request.job_class === 'id_only') {
          return {
            status: 'ok',
            final_url: finalUrl,
            document: doc,
            doc_h_px: null,
            section_geometries: null,
            element_geometry_by_el_fp: null,
            screenshot_bytes_digest: null,
            duration_ms: Date.now() - started,
            subresource_requests: seenRequests,
          }
        }

        const docHeight = await page.evaluate<number>(() => {
          return typeof document !== 'undefined' && document.documentElement
            ? document.documentElement.scrollHeight
            : 0
        })
        const shotBytes = page.screenshot ? await page.screenshot({ fullPage: true }) : null
        const shotDigest = shotBytes
          ? createHash('sha256').update(shotBytes).digest('hex')
          : null

        return {
          status: 'ok',
          final_url: finalUrl,
          document: doc,
          doc_h_px: docHeight > 0 ? docHeight : null,
          section_geometries: null,
          element_geometry_by_el_fp: null,
          screenshot_bytes_digest: shotDigest,
          duration_ms: Date.now() - started,
          subresource_requests: seenRequests,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message.toLowerCase() : ''
        return {
          status: msg.includes('timeout') ? 'timeout' : 'render_failed',
          final_url: request.url,
          document: null,
          doc_h_px: null,
          section_geometries: null,
          element_geometry_by_el_fp: null,
          screenshot_bytes_digest: null,
          duration_ms: Date.now() - started,
          subresource_requests: seenRequests,
        }
      } finally {
        await context.close()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Deterministic HTML/DOM CI Runner (Zero-Network, Reproducible Lab Executor)
// ---------------------------------------------------------------------------

export interface DeterministicPageFixture {
  readonly html: string
  readonly final_url?: string
  readonly status?: LabRenderTerminalStatus
  /** Simulated subresource URLs that the page would request (tested against LabNetworkPolicy) */
  readonly subresource_urls?: readonly (string | { readonly url: string; readonly is_redirect?: boolean })[]
  /** Explicit geometry overrides for full renders (keyed by el_fp or ordinal) */
  readonly doc_h_px?: number | null
  readonly element_geometry_by_el_fp?: Readonly<
    Record<
      string,
      {
        readonly rect: ElementRect | null
        readonly occluded: boolean | null
        readonly hover_only_reveal: boolean | null
        readonly pointer_events_none: boolean | null
        readonly computed_style: ComputedCtaStyle | null
      }
    >
  >
  /** Optional hook to mutate HTML on forced variant renders */
  readonly variant_html_by_key?: Readonly<Record<string, string>>
  /** Optional sequence of HTML payloads returned on successive renders (for paired volatility tests) */
  readonly sequential_htmls?: readonly string[]
}

export class DeterministicHtmlRenderDriver implements RenderDriver {
  readonly executor_id = 'ugoki-second-executor-deterministic/1'
  private readonly pages = new Map<string, DeterministicPageFixture>()
  private readonly callCounts = new Map<string, number>()

  registerPage(url: string, fixture: DeterministicPageFixture): void {
    this.pages.set(url, fixture)
  }

  async render(
    request: RenderPageRequest,
    evaluateRequest: (url: string, opts?: { readonly isRedirect?: boolean }) => NetworkDecision,
  ): Promise<DriverCapturedPage> {
    const fixture = this.pages.get(request.url)
    if (!fixture) {
      return {
        status: 'render_failed',
        final_url: request.url,
        document: null,
        doc_h_px: null,
        section_geometries: null,
        element_geometry_by_el_fp: null,
        screenshot_bytes_digest: null,
        duration_ms: null,
        subresource_requests: [],
      }
    }

    // Evaluate document request itself & every subresource through LabNetworkPolicy
    const subReqs: Array<{ url: string; is_redirect?: boolean }> = [{ url: request.url }]
    const mainDecision = evaluateRequest(request.url)
    if (mainDecision.action === 'block') {
      return {
        status: 'render_failed',
        final_url: request.url,
        document: null,
        doc_h_px: null,
        section_geometries: null,
        element_geometry_by_el_fp: null,
        screenshot_bytes_digest: null,
        duration_ms: null,
        subresource_requests: subReqs,
      }
    }

    for (const item of fixture.subresource_urls ?? []) {
      const sub = typeof item === 'string' ? { url: item } : item
      subReqs.push(sub)
      evaluateRequest(sub.url, { isRedirect: sub.is_redirect })
    }

    if (fixture.status && fixture.status !== 'ok') {
      return {
        status: fixture.status,
        final_url: fixture.final_url ?? request.url,
        document: null,
        doc_h_px: null,
        section_geometries: null,
        element_geometry_by_el_fp: null,
        screenshot_bytes_digest: null,
        duration_ms: null,
        subresource_requests: subReqs,
      }
    }

    const callIdx = this.callCounts.get(request.url) ?? 0
    this.callCounts.set(request.url, callIdx + 1)

    let html = fixture.html
    if (request.variant && fixture.variant_html_by_key?.[request.variant.variant_set_key]) {
      html = fixture.variant_html_by_key[request.variant.variant_set_key]
    } else if (fixture.sequential_htmls && fixture.sequential_htmls.length > 0) {
      html = fixture.sequential_htmls[Math.min(callIdx, fixture.sequential_htmls.length - 1)]
    }

    const doc = parseHtmlToDom(html)

    // Also inspect all <a href>, <img src>, <script src>, <link href>, <iframe src> in HTML
    // as potential subresource fetches (excluding <a href>, which aren't auto-fetched on render)
    const walkResourceUrls = (node: SegNodeLike): void => {
      if (node.nodeType === 1) {
        const el = node as SegElementLike
        const tag = el.tagName.toUpperCase()
        const rawRef =
          tag === 'SCRIPT' || tag === 'IMG' || tag === 'IFRAME'
            ? el.getAttribute('src')
            : tag === 'LINK'
              ? el.getAttribute('href')
              : null
        if (rawRef && /^https?:\/\//i.test(rawRef.trim())) {
          const trimmed = rawRef.trim()
          if (!subReqs.some((r) => r.url === trimmed)) {
            subReqs.push({ url: trimmed })
            evaluateRequest(trimmed)
          }
        }
      }
      for (let i = 0; i < node.childNodes.length; i++) walkResourceUrls(node.childNodes[i])
    }
    walkResourceUrls(doc)

    if (request.job_class === 'id_only') {
      return {
        status: 'ok',
        final_url: fixture.final_url ?? request.url,
        document: doc,
        doc_h_px: null,
        section_geometries: null,
        element_geometry_by_el_fp: null,
        screenshot_bytes_digest: null,
        duration_ms: 120,
        subresource_requests: subReqs,
      }
    }

    // Full render: derive deterministic geometry when provided or from explicit data-ugk-rect attrs
    const seg = segmentDocument(doc, { url: request.url, ...request.segment_options })
    const docH = fixture.doc_h_px ?? (seg.sections.length > 0 ? Math.max(request.profile.viewport.height, seg.sections.length * 420) : request.profile.viewport.height)

    const sectionGeoms: RenderedSectionGeometry[] = seg.sections.map((s, idx) => {
      const secH = Math.round(docH / Math.max(seg.sections.length, 1))
      const top = idx * secH
      return Object.freeze({
        sec_fp: s.sec_fp,
        top_px: top,
        height_px: secH,
        top_frac: Number((top / docH).toFixed(6)),
        height_frac: Number((secH / docH).toFixed(6)),
      })
    })

    const shotDigest = createHash('sha256')
      .update(
        JSON.stringify({
          url: fixture.final_url ?? request.url,
          profile_id: request.profile.profile_id,
          variant_set_key: request.variant?.variant_set_key ?? '0',
          skel_fp: seg.skel_fp,
          css_fp: seg.css_fp,
          doc_h: docH,
        }),
      )
      .digest('hex')

    return {
      status: 'ok',
      final_url: fixture.final_url ?? request.url,
      document: doc,
      doc_h_px: docH,
      section_geometries: Object.freeze(sectionGeoms),
      element_geometry_by_el_fp: fixture.element_geometry_by_el_fp ?? null,
      screenshot_bytes_digest: shotDigest,
      duration_ms: 480,
      subresource_requests: subReqs,
    }
  }
}

// ---------------------------------------------------------------------------
// DOM Element Metadata Extraction (for Operability Audit & Probes)
// ---------------------------------------------------------------------------

const NATIVE_INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'])

function parseInlineRectAttr(el: SegElementLike): ElementRect | null {
  const raw = el.getAttribute('data-lab-rect')
  if (!raw) return null
  const parts = raw.split(',').map((p) => Number(p.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  return Object.freeze({ x: parts[0], y: parts[1], width: parts[2], height: parts[3] })
}

function parseInlineStyleProp(styleAttr: string | null, prop: string): string | null {
  if (!styleAttr) return null
  const target = prop.toLowerCase()
  for (const decl of styleAttr.split(';')) {
    const colon = decl.indexOf(':')
    if (colon <= 0) continue
    if (decl.slice(0, colon).trim().toLowerCase() === target) {
      return decl.slice(colon + 1).trim()
    }
  }
  return null
}

function extractInteractiveDomNodes(
  doc: SegDocumentLike,
  segOut: SegmenterOutput,
  jobClass: RenderJobClass,
  geomOverrides: DriverCapturedPage['element_geometry_by_el_fp'],
  blocklist: LabBlocklistRegistry,
): readonly RenderedElementDetails[] {
  // Build <label for> index
  const labelFor = new Map<string, string>()
  const collectLabels = (node: SegNodeLike): void => {
    if (node.nodeType === 1) {
      const el = node as SegElementLike
      if (el.tagName.toUpperCase() === 'LABEL') {
        const f = el.getAttribute('for')
        if (f) {
          const t = getDirectTextRecursive(el).trim()
          if (t) labelFor.set(f, t)
        }
      }
    }
    for (let i = 0; i < node.childNodes.length; i++) collectLabels(node.childNodes[i])
  }
  collectLabels(doc)

  // Collect matching non-pruned DOM nodes in document order for link/button/field/media
  const domElements: Array<{ readonly el: SegElementLike; readonly inChrome: boolean }> = []
  const collectNodes = (node: SegNodeLike, inChrome: boolean): void => {
    if (node.nodeType === 1) {
      const el = node as SegElementLike
      if (classifyPrunedNode(el, DEFAULT_PRUNE_REGISTRY) !== null) return
      const tag = el.tagName.toUpperCase()
      const role = (el.getAttribute('role') ?? '').trim().toLowerCase()
      const nextChrome =
        inChrome ||
        tag === 'HEADER' ||
        tag === 'FOOTER' ||
        tag === 'ASIDE' ||
        tag === 'NAV' ||
        role === 'banner' ||
        role === 'contentinfo' ||
        role === 'complementary'
      if (
        (tag === 'A' && el.hasAttribute('href')) ||
        tag === 'BUTTON' ||
        role === 'button' ||
        tag === 'INPUT' ||
        tag === 'SELECT' ||
        tag === 'TEXTAREA' ||
        tag === 'IMG' ||
        tag === 'TABLE' ||
        tag === 'VIDEO' ||
        tag === 'IFRAME'
      ) {
        domElements.push({ el, inChrome: nextChrome })
      }
      for (let i = 0; i < node.childNodes.length; i++) collectNodes(node.childNodes[i], nextChrome)
      return
    }
    for (let i = 0; i < node.childNodes.length; i++) collectNodes(node.childNodes[i], inChrome)
  }
  collectNodes(doc, false)

  const usedDomIndices = new Set<number>()
  const detailsWithOrder: Array<{ readonly domOrder: number; readonly detail: RenderedElementDetails }> = []

  const matchKind = (el: SegElementLike, kind: string): boolean => {
    const tag = el.tagName.toUpperCase()
    const role = (el.getAttribute('role') ?? '').trim().toLowerCase()
    const inputType = tag === 'INPUT' ? (el.getAttribute('type') ?? 'text').toLowerCase() : ''
    if (kind === 'link') return tag === 'A' && el.hasAttribute('href')
    if (kind === 'button') {
      return (
        tag === 'BUTTON' ||
        role === 'button' ||
        (tag === 'INPUT' && ['submit', 'button', 'reset'].includes(inputType))
      )
    }
    if (kind === 'field') {
      return (
        (tag === 'INPUT' && !['hidden', 'submit', 'button', 'reset'].includes(inputType)) ||
        tag === 'SELECT' ||
        tag === 'TEXTAREA'
      )
    }
    if (kind === 'image') return tag === 'IMG'
    if (kind === 'table') return tag === 'TABLE'
    if (kind === 'video') return tag === 'VIDEO'
    if (kind === 'iframe') return tag === 'IFRAME'
    return false
  }

  let autoY = 120
  const buildDetail = (
    matchedDom: SegElementLike | null,
    meta: {
      readonly el_fp: string
      readonly kind: string
      readonly region: 'root' | 'chrome'
      readonly sec_fp: string | null
      readonly slot_id: string
      readonly dest_key_static: string | null
    },
  ): RenderedElementDetails => {
    const tagName = matchedDom ? matchedDom.tagName.toUpperCase() : meta.kind.toUpperCase()
    const isNative = NATIVE_INTERACTIVE_TAGS.has(tagName)
    const rawRole = matchedDom?.getAttribute('role')?.trim().toLowerCase() ?? null
    const implicitRole =
      tagName === 'A'
        ? 'link'
        : tagName === 'BUTTON'
          ? 'button'
          : tagName === 'INPUT'
            ? 'textbox'
            : tagName === 'SELECT'
              ? 'combobox'
              : tagName === 'TEXTAREA'
                ? 'textbox'
                : tagName === 'IMG'
                  ? 'img'
                  : tagName === 'TABLE'
                    ? 'table'
                    : null
    const effectiveRole = rawRole || implicitRole

    const rawId = matchedDom?.getAttribute('id') ?? ''
    const hasLabelBinding = Boolean(
      (rawId && labelFor.has(rawId)) ||
        matchedDom?.getAttribute('aria-label')?.trim() ||
        matchedDom?.getAttribute('aria-labelledby')?.trim(),
    )
    const textContent = matchedDom ? getDirectTextRecursive(matchedDom).trim() : ''
    const ariaLabel = matchedDom?.getAttribute('aria-label')?.trim() ?? ''
    const imgAlt = matchedDom?.getAttribute('alt')?.trim() ?? ''
    const labelText = rawId ? (labelFor.get(rawId) ?? '') : ''
    const accessibleName = ariaLabel || labelText || textContent || imgAlt || null

    const tabIndexRaw = matchedDom?.getAttribute('tabindex')
    const tabIndexNum = tabIndexRaw !== null && tabIndexRaw !== undefined ? Number(tabIndexRaw) : null
    const disabled = Boolean(
      matchedDom?.hasAttribute('disabled') || matchedDom?.getAttribute('aria-disabled') === 'true',
    )
    const ariaHidden = matchedDom?.getAttribute('aria-hidden') === 'true'
    const focusable =
      !disabled &&
      !ariaHidden &&
      (tabIndexNum !== null ? Number.isFinite(tabIndexNum) && tabIndexNum >= 0 : isNative)

    const href = matchedDom?.getAttribute('href') ?? null
    let isAffiliate = false
    if (href) {
      try {
        const parsedHref = new URL(href.startsWith('//') ? `https:${href}` : href)
        isAffiliate = hostMatchesRegistry(parsedHref.hostname, blocklist.affiliateHosts)
      } catch {
        isAffiliate = false
      }
    }

    const override = geomOverrides?.[meta.el_fp] ?? null
    let rect: ElementRect | null = null
    let occluded: boolean | null = null
    let hoverOnlyReveal: boolean | null = null
    let pointerEventsNone: boolean | null = null
    let computedStyle: ComputedCtaStyle | null = null

    if (jobClass === 'full') {
      const styleAttr = matchedDom?.getAttribute('style') ?? null
      const displayVal = parseInlineStyleProp(styleAttr, 'display')
      const pointerVal = parseInlineStyleProp(styleAttr, 'pointer-events')
      const posVal = parseInlineStyleProp(styleAttr, 'position')
      const colorVal = parseInlineStyleProp(styleAttr, 'color')
      const bgVal = parseInlineStyleProp(styleAttr, 'background-color')
      const fsRaw = parseInlineStyleProp(styleAttr, 'font-size')
      const fsPx = fsRaw && fsRaw.endsWith('px') ? Number.parseFloat(fsRaw) : null
      const fwVal = parseInlineStyleProp(styleAttr, 'font-weight')

      const attrRect = matchedDom ? parseInlineRectAttr(matchedDom) : null
      rect =
        override?.rect ??
        attrRect ??
        (displayVal === 'none'
          ? Object.freeze({ x: 0, y: 0, width: 0, height: 0 })
          : Object.freeze({ x: 24, y: autoY, width: 180, height: 44 }))
      autoY += 64

      occluded =
        override?.occluded ?? (matchedDom?.getAttribute('data-lab-occluded') === 'true' ? true : false)
      hoverOnlyReveal =
        override?.hover_only_reveal ??
        (matchedDom?.getAttribute('data-lab-hover-only') === 'true' ? true : false)
      pointerEventsNone =
        override?.pointer_events_none ?? (pointerVal?.toLowerCase() === 'none' ? true : false)

      computedStyle =
        override?.computed_style ??
        Object.freeze({
          color: colorVal,
          background_color: bgVal,
          font_size_px: fsPx !== null && Number.isFinite(fsPx) ? fsPx : null,
          font_weight: fwVal,
          display: displayVal,
          position: posVal,
        })
    }

    return Object.freeze({
      el_fp: meta.el_fp,
      kind: meta.kind,
      region: meta.region,
      sec_fp: meta.sec_fp,
      slot_id: meta.slot_id,
      tag_name: tagName,
      is_native_control: isNative,
      role: effectiveRole,
      accessible_name: accessibleName,
      has_label_binding: hasLabelBinding,
      focusable,
      aria_hidden: ariaHidden,
      disabled,
      href,
      dest_key_static: meta.dest_key_static,
      is_affiliate_link: isAffiliate,
      rect,
      occluded,
      hover_only_reveal: hoverOnlyReveal,
      pointer_events_none: pointerEventsNone,
      computed_style: computedStyle,
    })
  }

  for (const segEl of segOut.elements) {
    let matchedDom: SegElementLike | null = null
    let matchedIdx = Number.MAX_SAFE_INTEGER
    for (let i = 0; i < domElements.length; i++) {
      if (usedDomIndices.has(i)) continue
      const entry = domElements[i]
      const expectedChrome = segEl.region === 'chrome'
      if (entry.inChrome !== expectedChrome) continue
      if (matchKind(entry.el, segEl.kind)) {
        matchedDom = entry.el
        matchedIdx = i
        usedDomIndices.add(i)
        break
      }
    }
    if (!matchedDom) {
      for (let i = 0; i < domElements.length; i++) {
        if (usedDomIndices.has(i)) continue
        if (matchKind(domElements[i].el, segEl.kind)) {
          matchedDom = domElements[i].el
          matchedIdx = i
          usedDomIndices.add(i)
          break
        }
      }
    }

    detailsWithOrder.push({
      domOrder: matchedIdx,
      detail: buildDetail(matchedDom, {
        el_fp: segEl.el_fp,
        kind: segEl.kind,
        region: segEl.region,
        sec_fp: segEl.sec_fp,
        slot_id: segEl.slot_id,
        dest_key_static: segEl.dest_key_static ?? null,
      }),
    })
  }

  // Also surface any interactive controls skipped by empty-text paragraph pruning
  // (e.g., nameless <a href="javascript:void(0)"></a> inside an otherwise empty <p>)
  // so Operability Audit (§7.6 Instrument A) never misses broken nameless CTAs.
  for (let i = 0; i < domElements.length; i++) {
    if (usedDomIndices.has(i)) continue
    const { el, inChrome } = domElements[i]
    const tag = el.tagName.toUpperCase()
    const role = (el.getAttribute('role') ?? '').trim().toLowerCase()
    const inputType = tag === 'INPUT' ? (el.getAttribute('type') ?? 'text').toLowerCase() : ''
    let kind: string | null = null
    if (tag === 'A' && el.hasAttribute('href')) kind = 'link'
    else if (
      tag === 'BUTTON' ||
      role === 'button' ||
      (tag === 'INPUT' && ['submit', 'button', 'reset'].includes(inputType))
    ) {
      kind = 'button'
    } else if (
      (tag === 'INPUT' && !['hidden', 'submit', 'button', 'reset'].includes(inputType)) ||
      tag === 'SELECT' ||
      tag === 'TEXTAREA'
    ) {
      kind = 'field'
    }
    if (!kind) continue

    const region: 'root' | 'chrome' = inChrome ? 'chrome' : 'root'
    const fallbackElFp = createHash('sha256')
      .update(`lab_orphan_el|${kind}|${region}|${el.getAttribute('href') ?? ''}|${i}`, 'utf8')
      .digest('hex')
      .slice(0, 12)
    const fallbackSlotId = createHash('sha256')
      .update(`lab_orphan_slot|${fallbackElFp}|${i}`, 'utf8')
      .digest('hex')
      .slice(0, 12)
    detailsWithOrder.push({
      domOrder: i,
      detail: buildDetail(el, {
        el_fp: fallbackElFp,
        kind,
        region,
        sec_fp: segOut.sections[0]?.sec_fp ?? null,
        slot_id: fallbackSlotId,
        dest_key_static: null,
      }),
    })
  }

  detailsWithOrder.sort((a, b) => a.domOrder - b.domOrder)
  return Object.freeze(detailsWithOrder.map((d) => d.detail))
}

function getDirectTextRecursive(node: SegNodeLike): string {
  if (node.nodeType === 3) return node.nodeValue ?? ''
  let out = ''
  for (let i = 0; i < node.childNodes.length; i++) {
    out += getDirectTextRecursive(node.childNodes[i])
  }
  return out
}

// ---------------------------------------------------------------------------
// Paired Volatility Detection (数分おき 2 回描画 — §6.3 / join-final.md M3)
// ---------------------------------------------------------------------------

export interface PairedVolatilityResult {
  readonly tenant_id: string
  readonly site_id: string
  readonly url_key_v2: string
  readonly pass_a: RenderPageResult
  readonly pass_b: RenderPageResult
  readonly skel_stable: boolean
  readonly css_volatile: boolean
  /** Sections that appeared/disappeared or changed body_fp between paired fresh renders */
  readonly volatile_sections: readonly string[]
  /** Blocks that changed blk_fp or text_hash between paired fresh renders */
  readonly volatile_blocks: readonly string[]
}

// ---------------------------------------------------------------------------
// 5-Class Cumulative Render Capacity Gate (§11.4 / surf.capacity)
// ---------------------------------------------------------------------------

export const SCHEDULER_PRIORITY_CLASSES = [
  'safety',
  'integrity',
  'identity',
  'evidence',
  'enrichment',
] as const

export type SchedulerPriorityClass = (typeof SCHEDULER_PRIORITY_CLASSES)[number]

export type FiveClassDailyDemand = Readonly<Record<SchedulerPriorityClass, number>>

export interface ClassCapacityEvaluation {
  readonly priority_class: SchedulerPriorityClass
  readonly class_demand_per_day: number
  readonly cumulative_demand_per_day: number
  readonly capacity_to_demand_ratio: number
  /** Top-down cumulative admission: lower class overflow never halts higher classes (§11.4) */
  readonly admitted: boolean
}

export interface RenderCapacityGateEvaluation {
  readonly gate_id: 'surf.capacity'
  readonly measured_renders_per_day: number
  readonly total_demand_per_day: number
  readonly overall_ratio: number
  readonly required_ratio: 2
  readonly gate_passed: boolean
  readonly classes: readonly ClassCapacityEvaluation[]
}

/**
 * 1 日の描画能力と 5 階級需要の積み上げ比較 (設計書 §11.4 / ゲート `surf.capacity`)。
 * 優先順 `safety > integrity > identity > evidence > enrichment` に累積需要を積み上げ、
 * 各階級までの累積需要に対し `measured_renders_per_day >= 2 * cumulative_demand` を判定する。
 */
export function evaluateRenderCapacityGate(
  measuredRendersPerDay: number,
  demand: FiveClassDailyDemand,
): RenderCapacityGateEvaluation {
  if (!Number.isFinite(measuredRendersPerDay) || measuredRendersPerDay < 0) {
    throw new RangeError('measuredRendersPerDay must be a finite non-negative number')
  }

  let cumulative = 0
  const classes: ClassCapacityEvaluation[] = []

  for (const cls of SCHEDULER_PRIORITY_CLASSES) {
    const d = demand[cls]
    if (!Number.isFinite(d) || d < 0) {
      throw new RangeError(`Demand for class "${cls}" must be a finite non-negative number`)
    }
    cumulative += d
    const ratio = cumulative === 0 ? Number.POSITIVE_INFINITY : measuredRendersPerDay / cumulative
    classes.push(
      Object.freeze({
        priority_class: cls,
        class_demand_per_day: d,
        cumulative_demand_per_day: cumulative,
        capacity_to_demand_ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(4)) : 999999,
        admitted: ratio >= 2,
      }),
    )
  }

  const overallRatio = cumulative === 0 ? 999999 : Number((measuredRendersPerDay / cumulative).toFixed(4))
  return Object.freeze({
    gate_id: 'surf.capacity',
    measured_renders_per_day: measuredRendersPerDay,
    total_demand_per_day: cumulative,
    overall_ratio: overallRatio,
    required_ratio: 2,
    gate_passed: classes.every((c) => c.admitted),
    classes: Object.freeze(classes),
  })
}

/**
 * ワーカー数と平均描画時間から 1 日の描画能力を算出する (join-final.md R-20)。
 */
export function computeDailyRenderCapacity(
  workerCount: number,
  secondsPerRender: number,
): number {
  if (workerCount <= 0 || secondsPerRender <= 0) return 0
  return Math.floor((workerCount * 86_400) / secondsPerRender)
}

// ---------------------------------------------------------------------------
// SecondaryLabRenderer Orchestrator
// ---------------------------------------------------------------------------

export interface SecondaryLabRendererOptions {
  readonly driver: RenderDriver
  readonly now?: () => Date
  readonly defaultBlocklist?: LabBlocklistRegistry
}

export class SecondaryLabRenderer {
  private readonly driver: RenderDriver
  private readonly now: () => Date
  private readonly defaultBlocklist: LabBlocklistRegistry
  private readonly recordedDurationsMs: number[] = []

  constructor(options: SecondaryLabRendererOptions) {
    this.driver = options.driver
    this.now = options.now ?? (() => new Date())
    this.defaultBlocklist = options.defaultBlocklist ?? DEFAULT_LAB_BLOCKLIST
  }

  getExecutorId(): string {
    return this.driver.executor_id
  }

  getMeasuredAverageRenderSeconds(): number | null {
    if (this.recordedDurationsMs.length === 0) return null
    const sum = this.recordedDurationsMs.reduce((a, b) => a + b, 0)
    return sum / this.recordedDurationsMs.length / 1000
  }

  async renderPage(request: RenderPageRequest): Promise<RenderPageResult> {
    if (!request.tenant_id?.trim() || !request.site_id?.trim()) {
      throw new Error('tenant_id and site_id are mandatory for every lab render request')
    }

    const renderedAt = this.now().toISOString()
    const urlKeyResult = computeUrlKeyV2(request.url, request.url_rules)
    const blocklist = request.blocklist ?? this.defaultBlocklist
    const labPurpose: LabPurpose = request.lab_purpose ?? 'render'
    const variantSetKey = request.variant?.variant_set_key ?? '0'

    const knownDifferences = Object.freeze([
      'ads_blocked',
      'analytics_blocked',
      'affiliate_hosts_blocked',
      'overlays_hidden_before_screenshot',
      ...(labPurpose === 'render' ? ['ugoki_collector_blocked'] : []),
    ])

    // 1. Check robots.txt BEFORE making any render network call (§6.7)
    const robots = evaluateRobotsTxt(
      request.robots_txt ?? null,
      urlKeyResult.pathname,
      ['UGOKILinkLab', 'LinkthCrawl'],
      request.robots_override ?? null,
      urlKeyResult.hostname,
    )

    if (!robots.allowed) {
      return Object.freeze({
        tenant_id: request.tenant_id,
        site_id: request.site_id,
        status: 'robots_blocked',
        unlock: `Owner allows UGOKILinkLab in robots.txt or records a verified robots_override for ${urlKeyResult.hostname}`,
        rendered_at: renderedAt,
        job_class: request.job_class,
        executor_id: this.driver.executor_id,
        profile: request.profile,
        variant_set_key: variantSetKey,
        raw_url: request.url,
        final_url: request.url,
        url_key_result: urlKeyResult,
        segmenter_hash: SEGMENTER_CONTENT_HASH,
        rule_revisions: SEGMENTER_RULE_REVISIONS,
        segmenter_output: null,
        doc_h_px: null,
        section_geometries: null,
        element_details: Object.freeze([]),
        screenshot: null,
        render_duration_ms: null,
        egress_audit: Object.freeze({
          total_requests_evaluated: 0,
          allowed_count: 0,
          blocked_count: 0,
          affiliate_requests_sent: 0,
          affiliate_requests_blocked: 0,
          collector_requests_blocked: 0,
          entries: Object.freeze([]),
        }),
        known_lab_differences: knownDifferences,
      })
    }

    // 2. Network interceptor with full egress audit
    const auditEntries: NetworkAuditEntry[] = []
    let allowedCount = 0
    let blockedCount = 0
    let affiliateSent = 0
    let affiliateBlocked = 0
    let collectorBlocked = 0

    const policyCtx: LabNetworkPolicyContext = {
      targetHost: urlKeyResult.hostname,
      labPurpose,
      labToken: request.lab_token ?? null,
      blocklist,
      allowPrivateHostsForTest: request.allow_private_hosts_for_test,
    }

    const evaluateRequest = (
      reqUrl: string,
      opts?: { readonly isRedirect?: boolean },
    ): NetworkDecision => {
      const decision = evaluateLabNetworkRequest(reqUrl, policyCtx, opts)
      if (decision.action === 'allow') {
        allowedCount++
        if (decision.category === 'affiliate') affiliateSent++
      } else {
        blockedCount++
        if (decision.category === 'affiliate') affiliateBlocked++
        if (decision.category === 'collector') collectorBlocked++
      }
      auditEntries.push(
        Object.freeze({
          url: reqUrl,
          host: decision.host,
          is_redirect: opts?.isRedirect ?? false,
          action: decision.action,
          reason: decision.reason,
          category: decision.category,
        }),
      )
      return decision
    }

    // 3. Execute render driver
    const captured = await this.driver.render(request, evaluateRequest)
    if (captured.duration_ms !== null && captured.duration_ms >= 0) {
      this.recordedDurationsMs.push(captured.duration_ms)
    }

    const egressAudit = Object.freeze({
      total_requests_evaluated: auditEntries.length,
      allowed_count: allowedCount,
      blocked_count: blockedCount,
      affiliate_requests_sent: affiliateSent,
      affiliate_requests_blocked: affiliateBlocked,
      collector_requests_blocked: collectorBlocked,
      entries: Object.freeze(auditEntries),
    })

    if (captured.status !== 'ok' || !captured.document) {
      const unlockMap: Record<Exclude<LabRenderTerminalStatus, 'ok'>, string> = {
        robots_blocked: 'Owner allows UGOKILinkLab in robots.txt or records a verified override',
        bot_blocked: 'Allow-list UGOKI/CRAWL published egress IP feed in WAF/CDN',
        auth_wall: 'Configure owner lab_pass after SSRF gap closure, or enable k-anonymous text escrow',
        timeout: 'Retry within per-site render budget or inspect slow origin response',
        render_failed: 'Inspect origin availability and retry render job',
      }
      return Object.freeze({
        tenant_id: request.tenant_id,
        site_id: request.site_id,
        status: captured.status,
        unlock: captured.status === 'ok' ? 'Document capture returned empty DOM' : unlockMap[captured.status],
        rendered_at: renderedAt,
        job_class: request.job_class,
        executor_id: this.driver.executor_id,
        profile: request.profile,
        variant_set_key: variantSetKey,
        raw_url: request.url,
        final_url: captured.final_url,
        url_key_result: urlKeyResult,
        segmenter_hash: SEGMENTER_CONTENT_HASH,
        rule_revisions: SEGMENTER_RULE_REVISIONS,
        segmenter_output: null,
        doc_h_px: null,
        section_geometries: null,
        element_details: Object.freeze([]),
        screenshot: null,
        render_duration_ms: captured.duration_ms,
        egress_audit: egressAudit,
        known_lab_differences: knownDifferences,
      })
    }

    // 4. Run pinned shared segmenter (`packages/contract/segmenter`)
    const segOut = segmentDocument(captured.document, {
      url: captured.final_url,
      ...request.segment_options,
    })

    const elementDetails = extractInteractiveDomNodes(
      captured.document,
      segOut,
      request.job_class,
      request.job_class === 'full' ? captured.element_geometry_by_el_fp : null,
      blocklist,
    )

    // 5. Screenshot metadata (full render only; strictly null for id_only)
    let screenshot: ScreenshotMeta | null = null
    if (request.job_class === 'full' && captured.doc_h_px !== null && captured.screenshot_bytes_digest) {
      const tileHeight = request.profile.viewport.height
      const tileCount = Math.max(1, Math.ceil(captured.doc_h_px / tileHeight))
      const storageKey = `screenshots/${request.tenant_id}/${request.site_id}/${urlKeyResult.url_id_hex}/${request.profile.profile_id}/v_${variantSetKey}/${captured.screenshot_bytes_digest.slice(0, 16)}.png`
      screenshot = Object.freeze({
        storage_key: storageKey,
        width_px: request.profile.viewport.width,
        height_px: captured.doc_h_px,
        pixel_ratio: 1,
        tile_count: tileCount,
        perceptual_hash: captured.screenshot_bytes_digest.slice(0, 16),
        known_differences: knownDifferences,
      })
    }

    return Object.freeze({
      tenant_id: request.tenant_id,
      site_id: request.site_id,
      status: 'ok',
      unlock: null,
      rendered_at: renderedAt,
      job_class: request.job_class,
      executor_id: this.driver.executor_id,
      profile: request.profile,
      variant_set_key: variantSetKey,
      raw_url: request.url,
      final_url: captured.final_url,
      url_key_result: urlKeyResult,
      segmenter_hash: segOut.segmenter_hash,
      rule_revisions: segOut.rule_revisions,
      segmenter_output: segOut,
      doc_h_px: request.job_class === 'full' ? captured.doc_h_px : null,
      section_geometries: request.job_class === 'full' ? captured.section_geometries : null,
      element_details: elementDetails,
      screenshot,
      render_duration_ms: captured.duration_ms,
      egress_audit: egressAudit,
      known_lab_differences: knownDifferences,
    })
  }

  /**
   * 数分おきの 2 回描画による動的揺らぎ区画・ブロック・CSS の学習 (§6.3 / join-final.md M3)。
   */
  async renderPairedVolatility(request: RenderPageRequest): Promise<PairedVolatilityResult> {
    const passA = await this.renderPage(request)
    const passB = await this.renderPage(request)

    const volatileSections = new Set<string>()
    const volatileBlocks = new Set<string>()

    const segA = passA.segmenter_output
    const segB = passB.segmenter_output

    if (segA && segB) {
      const mapA = new Map(segA.sections.map((s) => [s.sec_fp, s]))
      const mapB = new Map(segB.sections.map((s) => [s.sec_fp, s]))

      for (const [secFp, sA] of mapA.entries()) {
        const sB = mapB.get(secFp)
        if (!sB || sA.body_fp !== sB.body_fp) {
          volatileSections.add(secFp)
        }
        if (sB) {
          const blkA = new Map(sA.blocks.map((b) => [b.blk_fp, b.text_hash]))
          const blkB = new Map(sB.blocks.map((b) => [b.blk_fp, b.text_hash]))
          for (const [bfp, hA] of blkA.entries()) {
            if (blkB.get(bfp) !== hA) volatileBlocks.add(bfp)
          }
          for (const bfp of blkB.keys()) {
            if (!blkA.has(bfp)) volatileBlocks.add(bfp)
          }
        }
      }
      for (const secFp of mapB.keys()) {
        if (!mapA.has(secFp)) volatileSections.add(secFp)
      }
    }

    const skelStable =
      segA !== null && segB !== null && segA.skel_fp !== null && segA.skel_fp === segB.skel_fp
    const cssVolatile =
      segA !== null && segB !== null && segA.css_fp !== null && segA.css_fp !== segB.css_fp

    return Object.freeze({
      tenant_id: request.tenant_id,
      site_id: request.site_id,
      url_key_v2: passA.url_key_result.url_key_v2,
      pass_a: passA,
      pass_b: passB,
      skel_stable: skelStable,
      css_volatile: cssVolatile,
      volatile_sections: Object.freeze(Array.from(volatileSections).sort()),
      volatile_blocks: Object.freeze(Array.from(volatileBlocks).sort()),
    })
  }
}
