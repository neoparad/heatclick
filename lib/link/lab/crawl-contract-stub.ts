/**
 * UGOKI LINK v2 — 束 2-C (手順 5): CRAWL 契約準拠スタブ代役 & HTTP 契約クライアント抽象
 *
 * 実装計画 §6 に従い、別リポジトリである LINKTH CRAWL の変更を待たずに波 3〜波 7 を
 * 実装・検証できるよう、設計書 §11.2 / §11.3 / §15 準拠の契約を正確に返すテスト代役を提供する。
 *
 * 原則:
 * - 本番経路では `CrawlContractClient` インターフェース越しに実 CRAWL HTTP クライアントへ差し替える
 * - 見本データ（ダミー値・合成スコア）の自動生成を厳禁とし、未登録 URL は必ず `not_crawled` / `not_collected` を返す
 * - すべての時刻は UTC ISO-8601、未計測は必ず `null`（0 埋め禁止）
 * - CRAWL 側は生 URL を返し、URL キー算出 (`urlkey/2`) は LINK 側で行う (§6.4 / R-19)
 * - 軽い取得でも登録済みアフィリエイトホストへの転送・リクエストを厳禁とする (§6.5 / R-9)
 */

import {
  createHash,
  createHmac,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto'

import {
  SEGMENTER_CONTENT_HASH,
  segmentHtml,
  type SegmenterOutput,
} from '@/packages/contract/segmenter'
import { computeUrlKeyV2, type UrlKeyV2Rules } from '@/packages/contract/urlkey'

import {
  DEFAULT_LAB_BLOCKLIST,
  DEVICE_PROFILES,
  DeterministicHtmlRenderDriver,
  SecondaryLabRenderer,
  evaluateLabNetworkRequest,
  isFullRenderJobClass,
  type DeterministicPageFixture,
  type ForcedVariantSpec,
  type LabBlocklistRegistry,
  type LabDeviceProfile,
  type RenderJobClass,
  type RenderPageResult,
} from './secondary-renderer'
import {
  LabSnapshotStore,
  createSnapshotFromRender,
  type ImmutableStructureSnapshot,
  type SnapshotIdentityKey,
} from './snapshot-store'

// ---------------------------------------------------------------------------
// Contract Types (§11.2, §11.3, §15 items 5–11, join-final.md R-5..R-12)
// ---------------------------------------------------------------------------

export const CRAWL_CONTRACT_VERSION = 'crawl-contract/2' as const
export const MAX_URL_PROBE_BATCH = 200
export const MAX_STRUCTURE_RENDER_BATCH = 50

export type IssueLocusClass = 'element' | 'section' | 'page' | 'site'

export type IssueInputFamily =
  | 'skel_fp'
  | 'body_fp'
  | 'head_fp'
  | 'links_fp'
  | 'res_fp'
  | 'css_fp'
  | 'el_fp'
  | 'headers_asof'

export const DEFAULT_STUB_GRANT_SECRET = 'stub-local-test-signing-key'

export interface LinkGrantAssertion {
  readonly link_grant_id: string
  /** Optional tenant/site binding included in canonical cryptographic signature payload when present */
  readonly tenant_id?: string
  readonly site_id?: string
  /** Issued at UTC ISO-8601; lifetime must be <= 300s (§11.2 / R-2) */
  readonly issued_at: string
  readonly expires_at: string
  readonly scopes: readonly ('structure:identity' | 'structure:render' | 'url:probe' | 'probe:run')[]
  readonly host_patterns: readonly string[]
  readonly signature: string
}

export interface UrlProbeEntry {
  readonly raw_url: string
  readonly final_url: string | null
  readonly url_key_v2: string
  readonly status: 'ok' | 'not_crawled' | 'blocked_affiliate_redirect' | 'http_error'
  readonly http_status: number | null
  readonly redirect_chain: readonly { readonly from: string; readonly to: string; readonly status: number }[]
  readonly declared_canonical: string | null
  readonly etag: string | null
  readonly last_modified: string | null
  readonly cms_modified_at: string | null
  readonly raw_html_fingerprints: {
    readonly segmenter_hash: string
    readonly skel_fp: string | null
    readonly head_fp: string | null
    readonly links_fp_combined: string | null
    readonly res_fp: string | null
    readonly css_fp: string | null
  } | null
  readonly affiliate_requests_sent: number
}

export interface UrlProbeRequest {
  readonly tenant_id: string
  readonly site_id: string
  readonly link_grant: LinkGrantAssertion
  readonly urls: readonly string[]
  readonly url_rules?: UrlKeyV2Rules
}

export interface UrlProbeResponse {
  readonly probed_at: string
  readonly contract_ver: typeof CRAWL_CONTRACT_VERSION
  readonly results: readonly UrlProbeEntry[]
}

export interface StructureRenderBatchRequest {
  readonly tenant_id: string
  readonly site_id: string
  readonly link_grant: LinkGrantAssertion
  readonly urls: readonly string[]
  readonly job_class: RenderJobClass
  readonly profiles?: readonly LabDeviceProfile[]
  readonly variant?: ForcedVariantSpec | null
  readonly paired?: boolean
  readonly idempotency_key: string
  readonly url_rules?: UrlKeyV2Rules
}

export interface StructureRenderBatchResponse {
  readonly job_id: string
  readonly idempotency_key: string
  readonly rendered_at: string
  readonly contract_ver: typeof CRAWL_CONTRACT_VERSION
  readonly segmenter_hash: string
  readonly results: readonly RenderPageResult[]
}

export type LabProbeKind = 'click' | 'defect' | 'a11y' | 'conversion_rule'

export interface LabProbeFinding {
  readonly finding_id: string
  readonly probe_kind: LabProbeKind
  readonly severity: 'info' | 'warn' | 'error'
  readonly code: string
  readonly el_fp: string | null
  readonly sec_fp: string | null
  readonly reproducible: boolean
  readonly detail: string
}

export interface LabProbeRequest {
  readonly tenant_id: string
  readonly site_id: string
  readonly link_grant: LinkGrantAssertion
  readonly url: string
  readonly probe_kind: LabProbeKind
  readonly target_el_fps?: readonly string[]
  readonly target_sec_fps?: readonly string[]
  readonly conversion_href_pattern?: string
}

export interface LabProbeResponse {
  readonly status: 'ok' | 'not_collected'
  readonly reason: string | null
  readonly probed_at: string
  readonly url_key_v2: string
  readonly segmenter_hash: string
  readonly findings: readonly LabProbeFinding[]
}

export interface CatalogIssueRow {
  readonly issue_id: string
  readonly issue_type: string
  readonly locus: {
    readonly class: IssueLocusClass
    readonly el_fp: string | null
    readonly sec_fp: string | null
    readonly url_key_v2: string
  }
  readonly input_family: IssueInputFamily
  readonly expected_symptom: readonly string[]
  readonly status: 'open' | 'resolved'
  readonly detected_at: string
}

export interface SnapshotExportNotification {
  readonly event_id: string
  readonly seq: number
  readonly snapshot_id: string
  readonly content_hash: string
  readonly emitted_at: string
  readonly signature_hmac: string
}

export interface ImmutableSnapshotExportResponse {
  readonly status: 'ok' | 'not_collected'
  readonly reason: string | null
  readonly snapshot: ImmutableStructureSnapshot | null
  readonly notification: SnapshotExportNotification | null
}

/**
 * CRAWL 契約クライアントの単一インターフェース。
 * 本番実装 (`HttpCrawlContractClient`) とテスト代役 (`DeterministicCrawlContractStub`) の双方で満たす。
 */
export interface CrawlContractClient {
  readonly is_stub: boolean
  readonly contract_ver: typeof CRAWL_CONTRACT_VERSION
  probeUrls(request: UrlProbeRequest): Promise<UrlProbeResponse>
  renderStructure(request: StructureRenderBatchRequest): Promise<StructureRenderBatchResponse>
  runProbe(request: LabProbeRequest): Promise<LabProbeResponse>
  listIssuesWithLoci(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly link_grant: LinkGrantAssertion
    readonly url: string
  }): Promise<{ readonly status: 'ok' | 'not_collected'; readonly issues: readonly CatalogIssueRow[] }>
  exportImmutableSnapshot(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly page_id: string
    readonly link_grant: LinkGrantAssertion
    readonly url: string
    readonly source_job_id: string
    readonly analysis_gen?: number
    readonly export_gen?: number
    readonly job_class?: RenderJobClass
    readonly is_pre_change_baseline?: boolean
  }): Promise<ImmutableSnapshotExportResponse>
}

// ---------------------------------------------------------------------------
// Link Grant Assertion Signer & Cryptographic Validator (§11.2 / R-2)
// ---------------------------------------------------------------------------

export function canonicalizeLinkGrantPayload(
  grant: Omit<LinkGrantAssertion, 'signature'>,
): string {
  return JSON.stringify({
    v: 'link-grant/2',
    link_grant_id: grant.link_grant_id,
    tenant_id: grant.tenant_id ?? null,
    site_id: grant.site_id ?? null,
    issued_at: grant.issued_at,
    expires_at: grant.expires_at,
    scopes: [...grant.scopes].sort(),
    host_patterns: [...grant.host_patterns].map((p) => p.trim().toLowerCase()).sort(),
  })
}

export function signLinkGrantAssertion(
  grantWithoutSig: Omit<LinkGrantAssertion, 'signature'>,
  key?:
    | { readonly kind: 'hmac'; readonly secret: string | Buffer }
    | { readonly kind: 'ed25519'; readonly privateKey: KeyObject },
): LinkGrantAssertion {
  const payload = canonicalizeLinkGrantPayload(grantWithoutSig)
  let signature: string
  if (key?.kind === 'ed25519') {
    const sigBuf = cryptoSign(null, Buffer.from(payload, 'utf8'), key.privateKey)
    signature = `ed25519:${sigBuf.toString('base64')}`
  } else {
    const secret = key?.kind === 'hmac' ? key.secret : DEFAULT_STUB_GRANT_SECRET
    const macHex = createHmac('sha256', secret).update(payload, 'utf8').digest('hex')
    signature = `hmac-sha256:${macHex}`
  }
  return Object.freeze({
    ...grantWithoutSig,
    signature,
  })
}

function hostMatchesGrantPattern(hostname: string, pattern: string): boolean {
  const h = hostname.trim().toLowerCase()
  const p = pattern.trim().toLowerCase()
  if (!h || !p) return false
  if (p.startsWith('*.')) {
    const suffix = p.slice(1) // ".example.jp"
    return h.endsWith(suffix) && h.length > suffix.length
  }
  return h === p
}

export interface LinkGrantVerificationContext {
  readonly tenant_id?: string
  readonly site_id?: string
  readonly target_urls?: readonly string[]
  readonly hmac_secret?: string | Buffer
  readonly ed25519_public_key?: KeyObject | null
}

export function assertValidLinkGrant(
  grant: LinkGrantAssertion,
  requiredScope: LinkGrantAssertion['scopes'][number],
  now: Date,
  context?: LinkGrantVerificationContext,
): void {
  if (!grant.link_grant_id?.trim() || !grant.signature?.trim()) {
    throw new Error('LinkGrantAssertion requires link_grant_id and signature')
  }
  const issuedMs = Date.parse(grant.issued_at)
  const expiresMs = Date.parse(grant.expires_at)
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)) {
    throw new Error('LinkGrantAssertion timestamps must be valid UTC ISO-8601')
  }
  if (expiresMs <= issuedMs) {
    throw new Error('LinkGrantAssertion expires_at must be strictly after issued_at')
  }
  if (expiresMs - issuedMs > 300_000) {
    throw new Error('LinkGrantAssertion lifetime must not exceed 300 seconds (§11.2 / R-2)')
  }
  if (now.getTime() > expiresMs) {
    throw new Error('LinkGrantAssertion has expired')
  }
  if (now.getTime() < issuedMs - 60_000) {
    throw new Error('LinkGrantAssertion is not yet valid (issued_at in the future)')
  }
  if (!grant.scopes.includes(requiredScope)) {
    throw new Error(`LinkGrantAssertion missing required scope "${requiredScope}"`)
  }
  if (!Array.isArray(grant.host_patterns) || grant.host_patterns.length === 0) {
    throw new Error('LinkGrantAssertion requires at least one host_pattern')
  }

  if (grant.tenant_id !== undefined && context?.tenant_id !== undefined && grant.tenant_id !== context.tenant_id) {
    throw new Error('LinkGrantAssertion tenant_id mismatch')
  }
  if (grant.site_id !== undefined && context?.site_id !== undefined && grant.site_id !== context.site_id) {
    throw new Error('LinkGrantAssertion site_id mismatch')
  }

  if (context?.target_urls && context.target_urls.length > 0) {
    for (const rawUrl of context.target_urls) {
      let host: string
      try {
        host = new URL(rawUrl).hostname.toLowerCase()
      } catch {
        throw new Error(`Invalid target URL "${rawUrl}" for LinkGrantAssertion host check`)
      }
      if (!grant.host_patterns.some((pat) => hostMatchesGrantPattern(host, pat))) {
        throw new Error(
          `LinkGrantAssertion host_patterns do not authorize target host "${host}"`,
        )
      }
    }
  }

  // Cryptographic signature verification (Ed25519 or HMAC-SHA256)
  const payload = canonicalizeLinkGrantPayload(grant)
  const sig = grant.signature.trim()
  if (sig.startsWith('ed25519:')) {
    if (!context?.ed25519_public_key) {
      throw new Error('LinkGrantAssertion Ed25519 signature cannot be verified without public key')
    }
    const b64 = sig.slice('ed25519:'.length)
    let verified = false
    try {
      verified = cryptoVerify(
        null,
        Buffer.from(payload, 'utf8'),
        context.ed25519_public_key,
        Buffer.from(b64, 'base64'),
      )
    } catch {
      verified = false
    }
    if (!verified) {
      throw new Error('LinkGrantAssertion cryptographic signature verification failed (Ed25519)')
    }
    return
  }

  if (sig.startsWith('hmac-sha256:')) {
    const providedHex = sig.slice('hmac-sha256:'.length)
    const secret = context?.hmac_secret ?? DEFAULT_STUB_GRANT_SECRET
    const expectedHex = createHmac('sha256', secret).update(payload, 'utf8').digest('hex')
    const a = Buffer.from(providedHex, 'utf8')
    const b = Buffer.from(expectedHex, 'utf8')
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error('LinkGrantAssertion cryptographic signature verification failed (HMAC)')
    }
    return
  }

  throw new Error('LinkGrantAssertion signature format invalid or unverified')
}

// ---------------------------------------------------------------------------
// Production Guard Helper
// ---------------------------------------------------------------------------

export function assertNotStubInProduction(
  client: CrawlContractClient,
  env: { readonly nodeEnv?: string; readonly allowStub?: boolean } = {},
): void {
  if (client.is_stub && env.nodeEnv === 'production' && !env.allowStub) {
    throw new Error(
      'DeterministicCrawlContractStub is forbidden in production paths; wire HttpCrawlContractClient instead',
    )
  }
}

// ---------------------------------------------------------------------------
// Seeded Page Record for Deterministic Test Double (Zero Dummy Fallbacks!)
// ---------------------------------------------------------------------------

export interface StubSeededPage {
  readonly url: string
  readonly html: string
  readonly http_status?: number
  readonly redirect_chain?: readonly { readonly from: string; readonly to: string; readonly status: number }[]
  readonly etag?: string | null
  readonly last_modified?: string | null
  readonly cms_modified_at?: string | null
  readonly robots_txt?: string | null
  readonly fixture?: Partial<DeterministicPageFixture>
}

export class DeterministicCrawlContractStub implements CrawlContractClient {
  readonly is_stub = true
  readonly contract_ver = CRAWL_CONTRACT_VERSION

  private readonly driver = new DeterministicHtmlRenderDriver()
  private readonly renderer: SecondaryLabRenderer
  private readonly snapshotStore: LabSnapshotStore
  private readonly pages = new Map<string, StubSeededPage>()
  private readonly blocklist: LabBlocklistRegistry
  private readonly now: () => Date
  private readonly webhookSecret: string
  private readonly grantPublicKey: KeyObject | null
  private eventSeq = 0

  constructor(options?: {
    readonly now?: () => Date
    readonly blocklist?: LabBlocklistRegistry
    readonly snapshotStore?: LabSnapshotStore
    readonly webhookSecret?: string
    readonly grantPublicKey?: KeyObject | null
  }) {
    this.now = options?.now ?? (() => new Date())
    this.blocklist = options?.blocklist ?? DEFAULT_LAB_BLOCKLIST
    this.snapshotStore = options?.snapshotStore ?? new LabSnapshotStore()
    this.webhookSecret = options?.webhookSecret ?? DEFAULT_STUB_GRANT_SECRET
    this.grantPublicKey = options?.grantPublicKey ?? null
    this.renderer = new SecondaryLabRenderer({
      driver: this.driver,
      now: this.now,
      defaultBlocklist: this.blocklist,
    })
  }

  private verifyGrant(
    grant: LinkGrantAssertion,
    requiredScope: LinkGrantAssertion['scopes'][number],
    nowDate: Date,
    tenantId: string,
    siteId: string,
    targetUrls: readonly string[],
  ): void {
    assertValidLinkGrant(grant, requiredScope, nowDate, {
      tenant_id: tenantId,
      site_id: siteId,
      target_urls: targetUrls,
      hmac_secret: this.webhookSecret,
      ed25519_public_key: this.grantPublicKey,
    })
  }

  getSnapshotStore(): LabSnapshotStore {
    return this.snapshotStore
  }

  seedPage(page: StubSeededPage): void {
    this.pages.set(page.url, page)
    this.driver.registerPage(page.url, {
      html: page.html,
      final_url: page.url,
      ...page.fixture,
    })
  }

  async probeUrls(request: UrlProbeRequest): Promise<UrlProbeResponse> {
    if (!request.tenant_id?.trim() || !request.site_id?.trim()) {
      throw new Error('tenant_id and site_id are required')
    }
    const nowDate = this.now()
    this.verifyGrant(
      request.link_grant,
      'url:probe',
      nowDate,
      request.tenant_id,
      request.site_id,
      request.urls,
    )

    if (request.urls.length > MAX_URL_PROBE_BATCH) {
      throw new Error(`url:probe accepts at most ${MAX_URL_PROBE_BATCH} URLs per call (R-9)`)
    }

    const results: UrlProbeEntry[] = []

    for (const rawUrl of request.urls) {
      const urlKey = computeUrlKeyV2(rawUrl, request.url_rules)
      const seeded = this.pages.get(rawUrl)

      // NEVER return dummy/synthetic data for unseeded URLs
      if (!seeded) {
        results.push(
          Object.freeze({
            raw_url: rawUrl,
            final_url: null,
            url_key_v2: urlKey.url_key_v2,
            status: 'not_crawled',
            http_status: null,
            redirect_chain: Object.freeze([]),
            declared_canonical: null,
            etag: null,
            last_modified: null,
            cms_modified_at: null,
            raw_html_fingerprints: null,
            affiliate_requests_sent: 0,
          }),
        )
        continue
      }

      // Check redirect chain against affiliate blocklist (§6.5 / R-9)
      const safeRedirects: Array<{ readonly from: string; readonly to: string; readonly status: number }> = []
      let blockedAffiliateRedirect = false
      for (const hop of seeded.redirect_chain ?? []) {
        const decision = evaluateLabNetworkRequest(
          hop.to,
          {
            targetHost: urlKey.hostname,
            labPurpose: 'render',
            blocklist: this.blocklist,
          },
          { isRedirect: true },
        )
        if (decision.category === 'affiliate' || decision.action === 'block') {
          blockedAffiliateRedirect = true
          break
        }
        safeRedirects.push(Object.freeze({ ...hop }))
      }

      if (blockedAffiliateRedirect) {
        results.push(
          Object.freeze({
            raw_url: rawUrl,
            final_url: null,
            url_key_v2: urlKey.url_key_v2,
            status: 'blocked_affiliate_redirect',
            http_status: null,
            redirect_chain: Object.freeze(safeRedirects),
            declared_canonical: null,
            etag: null,
            last_modified: null,
            cms_modified_at: null,
            raw_html_fingerprints: null,
            affiliate_requests_sent: 0,
          }),
        )
        continue
      }

      const httpStatus = seeded.http_status ?? 200
      if (httpStatus >= 400) {
        results.push(
          Object.freeze({
            raw_url: rawUrl,
            final_url: rawUrl,
            url_key_v2: urlKey.url_key_v2,
            status: 'http_error',
            http_status: httpStatus,
            redirect_chain: Object.freeze(safeRedirects),
            declared_canonical: null,
            etag: seeded.etag ?? null,
            last_modified: seeded.last_modified ?? null,
            cms_modified_at: seeded.cms_modified_at ?? null,
            raw_html_fingerprints: null,
            affiliate_requests_sent: 0,
          }),
        )
        continue
      }

      const segOut: SegmenterOutput = segmentHtml(seeded.html, { url: rawUrl })
      const canonicalMatch = /<link[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*href=["']([^"']+)["']/i.exec(
        seeded.html,
      )

      results.push(
        Object.freeze({
          raw_url: rawUrl,
          final_url: safeRedirects.length > 0 ? safeRedirects[safeRedirects.length - 1].to : rawUrl,
          url_key_v2: urlKey.url_key_v2,
          status: 'ok',
          http_status: httpStatus,
          redirect_chain: Object.freeze(safeRedirects),
          declared_canonical: canonicalMatch ? canonicalMatch[1] : null,
          etag: seeded.etag ?? null,
          last_modified: seeded.last_modified ?? null,
          cms_modified_at: seeded.cms_modified_at ?? null,
          raw_html_fingerprints: Object.freeze({
            segmenter_hash: segOut.segmenter_hash,
            skel_fp: segOut.skel_fp,
            head_fp: segOut.head_fp,
            links_fp_combined: segOut.links_fp?.combined ?? null,
            res_fp: segOut.res_fp,
            css_fp: segOut.css_fp,
          }),
          affiliate_requests_sent: 0,
        }),
      )
    }

    return Object.freeze({
      probed_at: nowDate.toISOString(),
      contract_ver: CRAWL_CONTRACT_VERSION,
      results: Object.freeze(results),
    })
  }

  async renderStructure(request: StructureRenderBatchRequest): Promise<StructureRenderBatchResponse> {
    if (!request.tenant_id?.trim() || !request.site_id?.trim()) {
      throw new Error('tenant_id and site_id are required')
    }
    const nowDate = this.now()
    this.verifyGrant(
      request.link_grant,
      'structure:render',
      nowDate,
      request.tenant_id,
      request.site_id,
      request.urls,
    )

    if (request.urls.length > MAX_STRUCTURE_RENDER_BATCH) {
      throw new Error(`structure:render accepts at most ${MAX_STRUCTURE_RENDER_BATCH} URLs per call (R-6)`)
    }

    const profiles = request.profiles && request.profiles.length > 0 ? request.profiles : [DEVICE_PROFILES.desktop_chromium]
    const results: RenderPageResult[] = []

    for (const url of request.urls) {
      const seeded = this.pages.get(url)
      for (const profile of profiles) {
        const res = await this.renderer.renderPage({
          tenant_id: request.tenant_id,
          site_id: request.site_id,
          url,
          job_class: request.job_class,
          profile,
          variant: request.variant ?? null,
          robots_txt: seeded?.robots_txt ?? null,
          url_rules: request.url_rules,
        })
        results.push(res)
      }
    }

    const jobId = `job_${createHash('sha256')
      .update(`${request.tenant_id}|${request.site_id}|${request.idempotency_key}`, 'utf8')
      .digest('hex')
      .slice(0, 16)}`

    return Object.freeze({
      job_id: jobId,
      idempotency_key: request.idempotency_key,
      rendered_at: nowDate.toISOString(),
      contract_ver: CRAWL_CONTRACT_VERSION,
      segmenter_hash: SEGMENTER_CONTENT_HASH,
      results: Object.freeze(results),
    })
  }

  async runProbe(request: LabProbeRequest): Promise<LabProbeResponse> {
    if (!request.tenant_id?.trim() || !request.site_id?.trim()) {
      throw new Error('tenant_id and site_id are required')
    }
    const nowDate = this.now()
    this.verifyGrant(
      request.link_grant,
      'probe:run',
      nowDate,
      request.tenant_id,
      request.site_id,
      [request.url],
    )

    const urlKey = computeUrlKeyV2(request.url)
    const seeded = this.pages.get(request.url)
    if (!seeded) {
      return Object.freeze({
        status: 'not_collected',
        reason: 'not_crawled',
        probed_at: nowDate.toISOString(),
        url_key_v2: urlKey.url_key_v2,
        segmenter_hash: SEGMENTER_CONTENT_HASH,
        findings: Object.freeze([]),
      })
    }

    const rendered = await this.renderer.renderPage({
      tenant_id: request.tenant_id,
      site_id: request.site_id,
      url: request.url,
      job_class: 'full',
      profile: DEVICE_PROFILES.desktop_chromium,
      robots_txt: seeded.robots_txt ?? null,
    })

    if (rendered.status !== 'ok') {
      return Object.freeze({
        status: 'not_collected',
        reason: rendered.status,
        probed_at: nowDate.toISOString(),
        url_key_v2: urlKey.url_key_v2,
        segmenter_hash: SEGMENTER_CONTENT_HASH,
        findings: Object.freeze([]),
      })
    }

    const targetElSet = request.target_el_fps ? new Set(request.target_el_fps) : null
    const targetSecSet = request.target_sec_fps ? new Set(request.target_sec_fps) : null
    const findings: LabProbeFinding[] = []

    const filteredElements = rendered.element_details.filter((el) => {
      if (targetElSet && !targetElSet.has(el.el_fp)) return false
      if (targetSecSet && (!el.sec_fp || !targetSecSet.has(el.sec_fp))) return false
      return true
    })

    for (const el of filteredElements) {
      if (request.probe_kind === 'click') {
        const isDeadLink =
          el.kind === 'link' && (!el.href || el.href.trim() === '#' || /^javascript:/i.test(el.href.trim()))
        const isBlockedClick = el.pointer_events_none === true || el.disabled || el.occluded === true
        if (isDeadLink || isBlockedClick) {
          findings.push(
            Object.freeze({
              finding_id: `probe_click_${el.el_fp}`,
              probe_kind: 'click',
              severity: 'error',
              code: isDeadLink ? 'dead_link_target' : 'unclickable_element',
              el_fp: el.el_fp,
              sec_fp: el.sec_fp,
              reproducible: true,
              detail: isDeadLink ? 'Link has empty or javascript: href' : 'Element is disabled, occluded, or pointer-events:none',
            }),
          )
        }
      } else if (request.probe_kind === 'a11y') {
        if (!el.accessible_name) {
          findings.push(
            Object.freeze({
              finding_id: `probe_a11y_name_${el.el_fp}`,
              probe_kind: 'a11y',
              severity: 'error',
              code: 'missing_accessible_name',
              el_fp: el.el_fp,
              sec_fp: el.sec_fp,
              reproducible: true,
              detail: `Interactive ${el.kind} lacks an accessible name`,
            }),
          )
        }
      } else if (request.probe_kind === 'defect') {
        if (el.rect && (el.rect.width < 24 || el.rect.height < 24)) {
          findings.push(
            Object.freeze({
              finding_id: `probe_defect_tap_${el.el_fp}`,
              probe_kind: 'defect',
              severity: 'warn',
              code: 'small_tap_target',
              el_fp: el.el_fp,
              sec_fp: el.sec_fp,
              reproducible: true,
              detail: `Tap target ${el.rect.width}x${el.rect.height}px is below 24x24px minimum`,
            }),
          )
        }
      } else if (request.probe_kind === 'conversion_rule') {
        const pattern = request.conversion_href_pattern
        const matchesConversion =
          el.is_affiliate_link || (Boolean(pattern) && Boolean(el.href && el.href.includes(pattern!)))
        if (matchesConversion) {
          findings.push(
            Object.freeze({
              finding_id: `probe_conv_${el.el_fp}`,
              probe_kind: 'conversion_rule',
              severity: 'info',
              code: 'conversion_target_matched',
              el_fp: el.el_fp,
              sec_fp: el.sec_fp,
              reproducible: true,
              detail: 'Conversion rule target matched rendered element',
            }),
          )
        }
      }
    }

    return Object.freeze({
      status: 'ok',
      reason: null,
      probed_at: nowDate.toISOString(),
      url_key_v2: urlKey.url_key_v2,
      segmenter_hash: rendered.segmenter_hash,
      findings: Object.freeze(findings),
    })
  }

  async listIssuesWithLoci(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly link_grant: LinkGrantAssertion
    readonly url: string
  }): Promise<{ readonly status: 'ok' | 'not_collected'; readonly issues: readonly CatalogIssueRow[] }> {
    if (!params.tenant_id?.trim() || !params.site_id?.trim()) {
      throw new Error('tenant_id and site_id are required')
    }
    const nowDate = this.now()
    this.verifyGrant(
      params.link_grant,
      'structure:identity',
      nowDate,
      params.tenant_id,
      params.site_id,
      [params.url],
    )

    const urlKey = computeUrlKeyV2(params.url)
    const seeded = this.pages.get(params.url)
    if (!seeded) {
      return Object.freeze({ status: 'not_collected', issues: Object.freeze([]) })
    }

    const rendered = await this.renderer.renderPage({
      tenant_id: params.tenant_id,
      site_id: params.site_id,
      url: params.url,
      job_class: 'full',
      profile: DEVICE_PROFILES.desktop_chromium,
      robots_txt: seeded.robots_txt ?? null,
    })

    if (rendered.status !== 'ok') {
      return Object.freeze({ status: 'not_collected', issues: Object.freeze([]) })
    }

    const issues: CatalogIssueRow[] = []

    // Page-level head issue check (e.g. missing meta description)
    if (!/<meta[^>]*name=["']description["'][^>]*>/i.test(seeded.html)) {
      issues.push(
        Object.freeze({
          issue_id: `iss_head_desc_${urlKey.url_id_hex}`,
          issue_type: 'missing_meta_description',
          locus: Object.freeze({
            class: 'page',
            el_fp: null,
            sec_fp: null,
            url_key_v2: urlKey.url_key_v2,
          }),
          input_family: 'head_fp',
          expected_symptom: Object.freeze(['low_serp_ctr']),
          status: 'open',
          detected_at: nowDate.toISOString(),
        }),
      )
    }

    // Element-level issues keyed by exact el_fp & sec_fp (never empty strings!)
    for (const el of rendered.element_details) {
      if ((el.kind === 'link' || el.kind === 'button') && !el.accessible_name) {
        issues.push(
          Object.freeze({
            issue_id: `iss_a11y_${el.el_fp}`,
            issue_type: 'interactive_missing_accessible_name',
            locus: Object.freeze({
              class: 'element',
              el_fp: el.el_fp,
              sec_fp: el.sec_fp,
              url_key_v2: urlKey.url_key_v2,
            }),
            input_family: 'el_fp',
            expected_symptom: Object.freeze(['agent_click_failure', 'low_cta_ctr']),
            status: 'open',
            detected_at: nowDate.toISOString(),
          }),
        )
      }
    }

    // Section-level issues (e.g. duplicate positional headings)
    for (const sec of rendered.segmenter_output?.sections ?? []) {
      if (sec.positional) {
        issues.push(
          Object.freeze({
            issue_id: `iss_sec_dup_${sec.sec_fp}`,
            issue_type: 'duplicate_section_heading',
            locus: Object.freeze({
              class: 'section',
              el_fp: null,
              sec_fp: sec.sec_fp,
              url_key_v2: urlKey.url_key_v2,
            }),
            input_family: 'skel_fp',
            expected_symptom: Object.freeze(['ambiguous_navigation']),
            status: 'open',
            detected_at: nowDate.toISOString(),
          }),
        )
      }
    }

    // Natural deterministic sort order (§15 item 11)
    issues.sort((a, b) => a.issue_id.localeCompare(b.issue_id))
    return Object.freeze({ status: 'ok', issues: Object.freeze(issues) })
  }

  async exportImmutableSnapshot(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly page_id: string
    readonly link_grant: LinkGrantAssertion
    readonly url: string
    readonly source_job_id: string
    readonly analysis_gen?: number
    readonly export_gen?: number
    readonly job_class?: RenderJobClass
    readonly is_pre_change_baseline?: boolean
  }): Promise<ImmutableSnapshotExportResponse> {
    if (!params.tenant_id?.trim() || !params.site_id?.trim()) {
      throw new Error('tenant_id and site_id are required')
    }
    const nowDate = this.now()
    this.verifyGrant(
      params.link_grant,
      'structure:render',
      nowDate,
      params.tenant_id,
      params.site_id,
      [params.url],
    )

    const seeded = this.pages.get(params.url)
    if (!seeded) {
      return Object.freeze({
        status: 'not_collected',
        reason: 'not_crawled',
        snapshot: null,
        notification: null,
      })
    }

    const jobClass = params.job_class ?? 'full'
    const renderRes = await this.renderer.renderPage({
      tenant_id: params.tenant_id,
      site_id: params.site_id,
      url: params.url,
      job_class: jobClass,
      profile: DEVICE_PROFILES.desktop_chromium,
      robots_txt: seeded.robots_txt ?? null,
    })

    if (renderRes.status !== 'ok') {
      return Object.freeze({
        status: 'not_collected',
        reason: renderRes.status,
        snapshot: null,
        notification: null,
      })
    }

    const identityKey: SnapshotIdentityKey = {
      link_grant_id: params.link_grant.link_grant_id,
      producer: 'linkth_crawl',
      source_job_id: params.source_job_id,
      analysis_gen: params.analysis_gen ?? 1,
      export_gen: params.export_gen ?? 1,
      dataset_kind: isFullRenderJobClass(jobClass)
        ? 'structure_snapshot_v2'
        : 'structure_identity_v1',
      contract_ver: CRAWL_CONTRACT_VERSION,
    }

    const snapshot = createSnapshotFromRender({
      render: renderRes,
      page_id: params.page_id,
      identity_key: identityKey,
      recorded_at: nowDate.toISOString(),
      is_pre_change_baseline: params.is_pre_change_baseline ?? false,
      baseline_reason: params.is_pre_change_baseline ? 'pre_change_baseline_capture' : null,
    })

    this.snapshotStore.confirmVersionByLab(snapshot)

    this.eventSeq++
    const emittedAt = nowDate.toISOString()
    const eventId = `evt_${createHash('sha256')
      .update(`${snapshot.snapshot_id}|${this.eventSeq}`, 'utf8')
      .digest('hex')
      .slice(0, 16)}`
    const signatureHmac = createHmac('sha256', this.webhookSecret)
      .update(`${eventId}|${this.eventSeq}|${snapshot.snapshot_id}|${snapshot.content_hash}|${emittedAt}`)
      .digest('hex')

    const notification: SnapshotExportNotification = Object.freeze({
      event_id: eventId,
      seq: this.eventSeq,
      snapshot_id: snapshot.snapshot_id,
      content_hash: snapshot.content_hash,
      emitted_at: emittedAt,
      signature_hmac: signatureHmac,
    })

    return Object.freeze({
      status: 'ok',
      reason: null,
      snapshot,
      notification,
    })
  }
}

/**
 * 本番用 CRAWL HTTP クライアント差し替え口 (§11.2: 持ち主 ID は引数に載せず
 * 300 秒以内の署名つき連携許可申告書 `X-UGK-Link-Grant` で認証する)。
 */
export function createHttpCrawlContractClient(config: {
  readonly baseUrl: string
  readonly fetcher?: typeof fetch
}): CrawlContractClient {
  const base = config.baseUrl.replace(/\/+$/, '')
  const doFetch = config.fetcher ?? fetch

  const postSigned = async <T>(
    endpoint: string,
    grant: LinkGrantAssertion,
    body: Record<string, unknown>,
  ): Promise<T> => {
    const res = await doFetch(`${base}${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ugk-link-grant': JSON.stringify(grant),
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`CRAWL HTTP ${res.status} on ${endpoint}`)
    }
    return (await res.json()) as T
  }

  return {
    is_stub: false,
    contract_ver: CRAWL_CONTRACT_VERSION,
    async probeUrls(request) {
      return postSigned<UrlProbeResponse>('/v1/url/probe', request.link_grant, {
        urls: request.urls,
      })
    },
    async renderStructure(request) {
      return postSigned<StructureRenderBatchResponse>('/v1/structure/render', request.link_grant, {
        urls: request.urls,
        class: request.job_class,
        profiles: request.profiles,
        variant: request.variant,
        paired: request.paired ?? false,
        idempotency_key: request.idempotency_key,
      })
    },
    async runProbe(request) {
      return postSigned<LabProbeResponse>('/v1/probes/run', request.link_grant, {
        url: request.url,
        probe_kind: request.probe_kind,
        target_el_fps: request.target_el_fps,
        target_sec_fps: request.target_sec_fps,
      })
    },
    async listIssuesWithLoci(params) {
      return postSigned('/v1/issues/by-url', params.link_grant, { url: params.url })
    },
    async exportImmutableSnapshot(params) {
      return postSigned('/v1/snapshots/export', params.link_grant, {
        url: params.url,
        page_id: params.page_id,
        source_job_id: params.source_job_id,
        analysis_gen: params.analysis_gen ?? 1,
        export_gen: params.export_gen ?? 1,
        job_class: params.job_class ?? 'full',
      })
    },
  }
}
