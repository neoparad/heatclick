/**
 * UGOKI LINK v2 — Wave 6 (Bundle 6-D.4 + [H-02]): Unified `POST /v1/recommend` &
 * `POST /v1/sites/{siteId}/recommend` Service & MCP Tool Descriptor
 * (`lib/link/models/recommend-service.ts`)
 *
 * Implements Master Architecture v2 §8.5, §8.13 (3–6), §10.11, §11.5–§11.7 & `[H-02]`:
 * - Routes every call through `IdentityKeyRegistry` + `AuthorizationGateway` + `CostUnitRateLimiter`.
 * - Rejects unknown/unregistered `siteId` (`siteCfg === null`) and cross-tenant probes with HTTP 404
 *   (NEVER 200 OK!) + hash-chained audit log entry.
 * - Enforces strict browser (`ugk_pub_*`) input lockdown:
 *   - Always forces `caller_channel = 'browser'`.
 *   - Rejects/ignores caller-supplied `candidates`, `ec_candidates`, `article_candidates`,
 *     `gross_margin`, `server_only_gross_margin`, `in_stock`, `available`, and `consent_granted`
 *     overrides (HTTP 403 `BROWSER_INPUT_OVERRIDE_FORBIDDEN`).
 *   - Resolves catalog candidates, gross margin, stock/availability, and site consent bounds
 *     STRICTLY from server-side registered catalog & `SiteRuntimeConfig`.
 * - Serializes EVERY data response through `buildResponseEnvelope()` (`packages/contract/response` I1–I7),
 *   wrapping every external-origin string in `UntrustedValue` and every numeric leaf in `VerifiedMetricValue`.
 */

import {
  buildResponseEnvelope,
  canonicalJson,
  createDataLayerMetric,
  createModelRegistryMetric,
  sha256Hex,
  wrapUntrusted,
  type EvidenceRef,
  type MeasureInput,
  type SerializedResponseEnvelope,
  type UntrustedValue,
  type VerifiedMetricValue,
  type VerifiedNumericLeaf,
} from '../../../packages/contract/response';
import type { VerifiedPrincipal } from '../auth';
import type { EcMemberSummaryStore } from '../revenue/ec-member-store';
import {
  buildApiVersionHeaders,
  getSurfaceRuntimeContext,
  type McpToolDefinition,
  type SurfacePipeline,
} from '../surface';
import {
  assertNoEcConfidentialLeak,
  MemberProofRequiredError,
  runEcRecommendation,
  type EcCandidateProduct,
  type EcMemberProofToken,
  type EcPlacement,
  type EcServerDecisionLog,
} from './recommend/ec-recommender';
import {
  rerankCandidatesInBrowser,
  sampleFullPlackettLuceOrdering,
  scoreCandidateByRung,
  type DisplayProbMethod,
  type RecommendCandidateItem,
  type RecommenderRung,
} from './recommend/recommender';

// =========================================================================
// 1. MCP Tool Definition (Matches `lib/link/surface/mcp.ts`)
// =========================================================================

export const RECOMMEND_MCP_TOOL_DEF: McpToolDefinition = {
  name: 'ugokilink_recommendItems',
  operationId: 'recommendItems',
  description:
    '[R0] Serve EC or content recommendations with pre-draw exclusions, full-set Plackett-Luce probability preservation, dual-consent member join, and zero confidential leakage.',
  riskClass: 'R0',
  individualHighRiskTool: false,
  requiredScope: 'decisions:read',
  costUnits: 1,
  eagerPriority: 40,
  inputSchema: {
    type: 'object',
    required: ['site_id', 'placement'],
    properties: {
      site_id: { type: 'string', description: 'Target site identifier owned by the authenticated tenant' },
      placement: {
        type: 'string',
        enum: ['product_page', 'cart', 'home', 'post_purchase', 'article'],
        description: 'Recommendation surface placement',
      },
      top_k: { type: 'integer', minimum: 1, maximum: 50, default: 6 },
      seed_key: { type: 'string', description: 'Deterministic per-impression seed key for Plackett-Luce draw' },
      temperature: { type: 'number', minimum: 0.05, maximum: 5.0, default: 1.0 },
      cart_product_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Current cart product IDs (cart exclusion works without personalisation consent)',
      },
      last_second_sold_out_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional last-second sold-out product IDs dropped from full-set Plackett-Luce ordering',
      },
      caller_channel: {
        type: 'string',
        enum: ['ec_server_direct', 'browser'],
        description: 'EC server direct call vs browser call (ugk_pub credentials are always forced to browser)',
      },
      member_key: {
        type: 'string',
        description: 'EC server direct member_key (forbidden for browser callers without signed proof)',
      },
      member_proof_token: {
        type: 'object',
        description: 'EC-server-signed session/purpose/expiry member proof token for browser callers',
      },
      session_id: { type: 'string' },
      consent_member_link: { type: 'boolean' },
      consent_personalisation: { type: 'boolean' },
      rung: {
        type: 'string',
        enum: [
          'R0_hybrid_baseline',
          'R1_lambdamart_challenger',
          'R1_5_coread_projection_challenger',
          'R2_two_tower_sequential_challenger',
        ],
      },
    },
  },
};

// =========================================================================
// 2. DI Catalog Provider & Runtime Config
// =========================================================================

export interface RecommendCatalogProvider {
  getEcCandidates(params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly placement: EcPlacement;
  }): readonly EcCandidateProduct[] | null;
  getContentCandidates?(params: {
    readonly tenantId: string;
    readonly siteId: string;
  }): readonly RecommendCandidateItem[] | null;
}

export interface RecommendRuntimeConfig {
  readonly catalogProvider?: RecommendCatalogProvider;
  readonly ecMemberStore?: EcMemberSummaryStore;
  readonly ecServerProofSecret?: string;
  /** Optional server-verified per-session/site consent resolver for browser callers. */
  readonly resolveBrowserConsent?: (params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly sessionId?: string;
  }) => { readonly memberLink: boolean; readonly personalisation: boolean } | null;
  readonly onServerDecisionLog?: (entry: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly placement: EcPlacement;
    readonly log: EcServerDecisionLog;
  }) => void;
}

let activeRecommendConfig: RecommendRuntimeConfig = {};

export function getRecommendRuntimeConfig(): RecommendRuntimeConfig {
  return activeRecommendConfig;
}

export function setRecommendRuntimeConfig(cfg: RecommendRuntimeConfig): void {
  activeRecommendConfig = cfg;
}

// =========================================================================
// 3. Request & Response Types
// =========================================================================

export interface RecommendInvocation {
  readonly channel: 'rest' | 'mcp';
  readonly bearerToken?: string;
  readonly sessionPrincipal?: VerifiedPrincipal;
  readonly clientIp?: string;
  readonly dpopProof?: string;
  readonly httpMethod?: string;
  readonly httpUri?: string;
  readonly mtlsThumbprint?: string;
  readonly callerSuppliedTenantId?: string;
  readonly requestedRevision?: string | null;
  readonly body: Readonly<Record<string, unknown>>;
  readonly pipeline?: SurfacePipeline;
  readonly config?: RecommendRuntimeConfig;
  readonly now?: Date;
}

export interface RecommendExecutionResult {
  readonly httpStatus: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly envelope?: SerializedResponseEnvelope;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly auditEntryId?: string;
  };
}

interface SafeSerializedEcItem {
  readonly product_id: string;
  readonly rank: VerifiedMetricValue<number>;
  readonly title: UntrustedValue;
  readonly product_url: UntrustedValue;
  readonly image_url: UntrustedValue | null;
  readonly hide_price: boolean;
  readonly price: VerifiedMetricValue<number> | null;
  readonly currency: string | null;
  readonly category: UntrustedValue;
  readonly brand: UntrustedValue | null;
}

interface SafeSerializedArticleItem {
  readonly item_id: string;
  readonly kind: RecommendCandidateItem['kind'];
  readonly rank: VerifiedMetricValue<number>;
  readonly title: UntrustedValue;
  readonly url: UntrustedValue;
  readonly display_prob: VerifiedMetricValue<number>;
  readonly display_prob_method: DisplayProbMethod;
  readonly slot_cond_prob: VerifiedMetricValue<number>;
  readonly click_only_evidence: boolean;
}

// =========================================================================
// 4. Helpers
// =========================================================================

const VALID_PLACEMENTS: ReadonlySet<string> = new Set([
  'product_page',
  'cart',
  'home',
  'post_purchase',
  'article',
]);

/**
 * Keys that publishable browser keys (`ugk_pub_*`) are strictly forbidden from supplying (`[H-02]`).
 * Catalog items, gross margin, stock/availability, and consent overrides MUST come from server config.
 */
const FORBIDDEN_BROWSER_OVERRIDE_KEYS: ReadonlyArray<string> = [
  'candidates',
  'ec_candidates',
  'article_candidates',
  'gross_margin',
  'server_only_gross_margin',
  'in_stock',
  'available',
  'consent_granted',
];

function resolvePrincipal(
  pipeline: SurfacePipeline,
  inv: RecommendInvocation,
  siteId: string | undefined,
  now: Date
):
  | { readonly ok: true; readonly principal: VerifiedPrincipal }
  | { readonly ok: false; readonly httpStatus: number; readonly code: string; readonly reason: string } {
  if (inv.sessionPrincipal) {
    return { ok: true, principal: inv.sessionPrincipal };
  }
  const raw = inv.bearerToken?.trim();
  if (!raw) {
    return { ok: false, httpStatus: 401, code: 'MISSING_CREDENTIAL', reason: 'Authorization credential required' };
  }
  if (raw.startsWith('ugk_sec_')) {
    return pipeline.keyRegistry.verifySecretKey(raw, {
      clientIp: inv.clientIp,
      siteId,
      dpopProof: inv.dpopProof,
      httpMethod: inv.httpMethod,
      httpUri: inv.httpUri,
      mtlsThumbprint: inv.mtlsThumbprint,
      now,
    });
  }
  if (raw.startsWith('ugk_oauth_')) {
    return pipeline.keyRegistry.verifyMcpOAuthToken(raw, {
      dpopProof: inv.dpopProof,
      httpMethod: inv.httpMethod,
      httpUri: inv.httpUri,
      now,
    });
  }
  if (raw.startsWith('ugk_oemx_')) {
    return pipeline.keyRegistry.verifyOemExchangedToken(raw, {
      dpopProof: inv.dpopProof,
      httpMethod: inv.httpMethod,
      httpUri: inv.httpUri,
      mtlsThumbprint: inv.mtlsThumbprint,
      now,
    });
  }
  if (raw.startsWith('ugk_pub_')) {
    return pipeline.keyRegistry.verifyPublicKeyToPrincipal(raw);
  }
  return { ok: false, httpStatus: 401, code: 'UNSUPPORTED_CREDENTIAL', reason: 'Unrecognized credential prefix' };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

function asProofToken(value: unknown): EcMemberProofToken | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (
    typeof r.tenant_id !== 'string' ||
    typeof r.site_id !== 'string' ||
    typeof r.member_key !== 'string' ||
    typeof r.session_id !== 'string' ||
    r.purpose !== 'recommend' ||
    typeof r.expires_at_ms !== 'number' ||
    typeof r.signature_hex !== 'string'
  ) {
    return null;
  }
  return {
    tenant_id: r.tenant_id,
    site_id: r.site_id,
    member_key: r.member_key,
    session_id: r.session_id,
    purpose: 'recommend',
    expires_at_ms: r.expires_at_ms,
    signature_hex: r.signature_hex,
  };
}

function makeActiveRef(params: {
  readonly refId: string;
  readonly kind: EvidenceRef['kind'];
  readonly payload: unknown;
  readonly issuedAt: string;
  readonly validUntil: string;
}): EvidenceRef {
  return {
    ref_id: params.refId,
    kind: params.kind,
    params_hash: sha256Hex(canonicalJson(params.payload)),
    watermarks: { recommend_engine: params.issuedAt },
    result_digest: sha256Hex(`${params.refId}:${params.issuedAt}`),
    issued_at: params.issuedAt,
    valid_until: params.validUntil,
    kid: 'recommend_k1',
  };
}

// =========================================================================
// 5. Core Unified Executor (`POST /v1/recommend`, `POST /v1/sites/{siteId}/recommend`, & MCP)
// =========================================================================

export function executeRecommendRequest(inv: RecommendInvocation): RecommendExecutionResult {
  const now = inv.now ?? new Date();
  const nowIso = now.toISOString();
  const validUntilIso = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const pipeline = inv.pipeline ?? getSurfaceRuntimeContext().pipeline;
  const cfg = inv.config ?? activeRecommendConfig;
  const body = inv.body;

  const baseHeaders: Record<string, string> = {
    'Cache-Control': 'no-store',
    ...buildApiVersionHeaders({ requestedRevision: inv.requestedRevision, now }),
  };

  const siteId =
    typeof body.site_id === 'string' && body.site_id.trim().length > 0
      ? body.site_id.trim()
      : typeof body.siteId === 'string' && body.siteId.trim().length > 0
        ? body.siteId.trim()
        : undefined;

  // 1. Authenticate credential via IdentityKeyRegistry
  const auth = resolvePrincipal(pipeline, inv, siteId, now);
  if (!auth.ok) {
    return {
      httpStatus: auth.httpStatus,
      headers: baseHeaders,
      error: { code: auth.code, message: auth.reason },
    };
  }
  const principal = auth.principal;

  const callerTenant =
    inv.callerSuppliedTenantId ??
    (typeof body.tenant_id === 'string' ? body.tenant_id : undefined) ??
    (typeof body.tenantId === 'string' ? body.tenantId : undefined);

  if (!siteId) {
    if (callerTenant && callerTenant !== principal.tenantId) {
      return {
        httpStatus: 404,
        headers: baseHeaders,
        error: { code: 'RESOURCE_NOT_FOUND', message: 'Requested resource not found' },
      };
    }
    return {
      httpStatus: 400,
      headers: baseHeaders,
      error: { code: 'MISSING_SITE_ID', message: 'site_id is required' },
    };
  }

  // 2. Look up server-registered site config & authorize via unified AuthorizationGateway ([H-02])
  //    Unknown `siteCfg === null` OR foreign `siteCfg.tenantId !== principal.tenantId` OR foreign
  //    `callerSuppliedTenantId` ALWAYS fails closed with 404 (NEVER 200 OK!).
  const siteCfg = pipeline.repository.getSiteConfig(siteId);
  const requiredScope =
    principal.effectiveScopes.has('ml:read') && !principal.effectiveScopes.has('decisions:read')
      ? 'ml:read'
      : 'decisions:read';

  const isBrowserPublicKey = principal.credentialKind === 'ugk_pub';

  const authz = pipeline.gateway.authorize({
    principal,
    action: 'recommendItems',
    riskClass: 'R0',
    requiredScope,
    resource: {
      type: 'site',
      id: siteId,
      tenantId: siteCfg ? siteCfg.tenantId : '__nonexistent_tenant__',
      siteId,
    },
    callerSuppliedTenantId: callerTenant,
    now,
  });

  // Note: `/v1/recommend` and `/v1/sites/{siteId}/recommend` explicitly support `ugk_pub_*`
  // browser calls under strict [H-02] input lockdown while general SurfacePipeline management
  // endpoints block `ugk_pub_*` with `PUBLIC_KEY_OPERATION_FORBIDDEN`. Enforce full site, tenant,
  // allowedSiteIds, and scope isolation even when gateway blocks generic `ugk_pub` actions.
  if (isBrowserPublicKey && !authz.allowed && authz.code === 'PUBLIC_KEY_OPERATION_FORBIDDEN') {
    if (
      !siteCfg ||
      siteCfg.tenantId !== principal.tenantId ||
      (callerTenant !== undefined && callerTenant !== principal.tenantId) ||
      (principal.allowedSiteIds !== null && !principal.allowedSiteIds.includes(siteId))
    ) {
      const denyAudit = pipeline.gateway.auditLog.append({
        timestamp: nowIso,
        tenantId: principal.tenantId,
        targetTenantId: callerTenant ?? siteCfg?.tenantId ?? '__nonexistent_tenant__',
        principalId: principal.principalId,
        credentialKind: principal.credentialKind,
        credentialId: principal.credentialId,
        action: 'recommendItems',
        riskClass: 'R0',
        resourceType: 'site',
        resourceId: siteId,
        outcome: 'deny_404',
        reason: 'BROWSER_KEY_FOREIGN_OR_UNKNOWN_SITE',
        metadata: { channel: inv.channel },
      });
      return {
        httpStatus: 404,
        headers: baseHeaders,
        error: {
          code: 'SITE_NOT_FOUND',
          message: 'Site not found',
          auditEntryId: denyAudit.auditId,
        },
      };
    }
    if (!principal.effectiveScopes.has('decisions:read') && !principal.effectiveScopes.has('ml:read')) {
      return {
        httpStatus: 403,
        headers: baseHeaders,
        error: {
          code: 'INSUFFICIENT_SCOPE',
          message: 'Requires decisions:read or ml:read scope',
          auditEntryId: authz.auditEntryId,
        },
      };
    }
  } else if (!authz.allowed || !siteCfg) {
    return {
      httpStatus: authz.allowed ? 404 : authz.httpStatus,
      headers: baseHeaders,
      error: {
        code: authz.allowed ? 'SITE_NOT_FOUND' : authz.code,
        message: authz.allowed ? 'Site not found' : authz.reason,
        auditEntryId: authz.auditEntryId,
      },
    };
  }

  // 3. Browser (`ugk_pub_*`) Input Lockdown ([H-02]):
  //    Publishable browser keys CANNOT supply catalog candidates, gross margin, stock/availability,
  //    or `consent_granted` overrides! Checked BEFORE consuming valid-request rate units.
  if (isBrowserPublicKey) {
    for (const forbiddenKey of FORBIDDEN_BROWSER_OVERRIDE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(body, forbiddenKey) && body[forbiddenKey] !== undefined) {
        pipeline.gateway.auditLog.append({
          timestamp: nowIso,
          tenantId: principal.tenantId,
          targetTenantId: principal.tenantId,
          principalId: principal.principalId,
          credentialKind: principal.credentialKind,
          credentialId: principal.credentialId,
          action: 'recommendItems',
          riskClass: 'R0',
          resourceType: 'site',
          resourceId: siteId,
          outcome: 'deny_403',
          reason: `BROWSER_INPUT_OVERRIDE_FORBIDDEN:${forbiddenKey}`,
          metadata: { channel: inv.channel, forbiddenKey },
        });
        return {
          httpStatus: 403,
          headers: baseHeaders,
          error: {
            code: 'BROWSER_INPUT_OVERRIDE_FORBIDDEN',
            message: `Publishable browser keys (ugk_pub_*) cannot supply "${forbiddenKey}"; catalog, margin, stock, and consent are resolved strictly server-side`,
            auditEntryId: authz.auditEntryId,
          },
        };
      }
    }
  }

  // 4. Enforce per-key/IP cost-unit rate limiter ([H-02])
  const rateKey = `recommend:${principal.tenantId}:${principal.credentialId}:${inv.clientIp ?? 'no_ip'}`;
  const rate = pipeline.rateLimiter.consume(rateKey, RECOMMEND_MCP_TOOL_DEF.costUnits, now);
  if (!rate.allowed) {
    return {
      httpStatus: 429,
      headers: {
        ...baseHeaders,
        'Retry-After': String(rate.retryAfterSec),
        'X-UGOKI-Cost-Units-Remaining': String(rate.remaining),
      },
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Recommendation cost-unit rate limit exceeded',
        auditEntryId: authz.auditEntryId,
      },
    };
  }

  const responseHeaders: Record<string, string> = {
    ...baseHeaders,
    'X-UGOKI-Cost-Units': String(RECOMMEND_MCP_TOOL_DEF.costUnits),
    'X-UGOKI-Cost-Units-Remaining': String(rate.remaining),
    'X-UGOKI-Audit-Id': authz.auditEntryId,
  };

  // 5. Validate placement & parameters
  const rawPlacement = typeof body.placement === 'string' ? body.placement.trim() : '';
  if (!VALID_PLACEMENTS.has(rawPlacement)) {
    return {
      httpStatus: 400,
      headers: responseHeaders,
      error: {
        code: 'INVALID_PLACEMENT',
        message: 'placement must be one of product_page | cart | home | post_purchase | article',
      },
    };
  }
  const placement = rawPlacement as EcPlacement;

  const topKRaw = typeof body.top_k === 'number' && Number.isFinite(body.top_k) ? Math.floor(body.top_k) : 6;
  const topK = Math.max(1, Math.min(50, topKRaw));
  const temperature =
    typeof body.temperature === 'number' && Number.isFinite(body.temperature) && body.temperature > 0
      ? Math.min(5, Math.max(0.05, body.temperature))
      : 1.0;
  const seedKey =
    typeof body.seed_key === 'string' && body.seed_key.trim().length > 0
      ? body.seed_key.trim()
      : `rec_${principal.tenantId}_${siteId}_${now.getTime()}`;

  const storageRegion = siteCfg.storageRegion;
  const processingRegion = siteCfg.processingRegion;

  // Force browser channel whenever caller authenticates with a public browser key (`ugk_pub_*`)
  const requestedChannel =
    body.caller_channel === 'ec_server_direct' ? 'ec_server_direct' : 'browser';
  const effectiveCallerChannel: 'ec_server_direct' | 'browser' = isBrowserPublicKey
    ? 'browser'
    : requestedChannel;

  // If site consent mode is 'off' and caller is browser, do not join personalisation or session features
  const siteAllowsPersonalisation = siteCfg.consentMode === 'full';

  // 6. Content / Article Placement Path
  if (placement === 'article') {
    const contentCandidates =
      cfg.catalogProvider?.getContentCandidates?.({
        tenantId: principal.tenantId,
        siteId,
      }) ??
      (!isBrowserPublicKey && Array.isArray(body.article_candidates)
        ? (body.article_candidates as readonly RecommendCandidateItem[])
        : null);

    if (!contentCandidates || contentCandidates.length === 0) {
      const ref = makeActiveRef({
        refId: `rec_empty_${siteId}`,
        kind: 'query',
        payload: { siteId, placement },
        issuedAt: nowIso,
        validUntil: validUntilIso,
      });
      const envelope = buildResponseEnvelope({
        window: { start: nowIso, end: nowIso },
        freshness: { data_through: nowIso, lag_s: 0, sources: { catalog: 'unconnected' }, stale: false },
        coverage: { ratio: 0, denominator_n: 0 },
        lineage: { schema_version: '2.0', def_ver: 2, collection_gen: 'v3' },
        residency: { storage_region: storageRegion, processing_region: processingRegion },
        measures: {
          items_returned: {
            value: null,
            unit: 'count',
            status: 'not_collected',
            reason: 'No article recommendation catalog connected for this site',
            evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${siteId}` },
            sample: null,
            interval: null,
            unmet_gates: [
              {
                id: 'rec.content_catalog_connected',
                required: 1,
                observed: 0,
                unlock: 'Connect CRAWL page index or content catalog provider for this site',
              },
            ],
          },
        },
        data: { placement, items: [] },
        policy: { version: 'rec_content_v1', fallback_reason: 'catalog_not_connected' },
      });
      return { httpStatus: 200, headers: responseHeaders, envelope };
    }

    const rawRung = typeof body.rung === 'string' ? body.rung : 'R0_hybrid_baseline';
    const rung: RecommenderRung =
      rawRung === 'R1_lambdamart_challenger' ||
      rawRung === 'R1_5_coread_projection_challenger' ||
      rawRung === 'R2_two_tower_sequential_challenger'
        ? rawRung
        : 'R0_hybrid_baseline';

    const sessionEmbedding =
      siteCfg.consentMode !== 'off' && Array.isArray(body.session_embedding)
        ? body.session_embedding.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
        : undefined;

    const ref = makeActiveRef({
      refId: `rec_art_${siteId}_${sha256Hex(seedKey).slice(0, 8)}`,
      kind: 'model',
      payload: { siteId, placement, rung, topK, temperature },
      issuedAt: nowIso,
      validUntil: validUntilIso,
    });

    let safeArticleItems: SafeSerializedArticleItem[];

    if (effectiveCallerChannel === 'browser' && sessionEmbedding && sessionEmbedding.length > 0) {
      const reranked = rerankCandidatesInBrowser({
        candidates: contentCandidates,
        sessionInterestVector: sessionEmbedding,
        topK,
        seedKey,
        temperature,
      });
      safeArticleItems = reranked.shown.map((entry, idx) => ({
        item_id: entry.item.item.item_id,
        kind: entry.item.item.kind,
        rank: createDataLayerMetric(entry.rank, `${ref.ref_id}:rank:${idx}`, { createdAt: nowIso }),
        title: wrapUntrusted(entry.item.item.title, 'page_content'),
        url: wrapUntrusted(entry.item.item.url_key_v2, 'url'),
        display_prob: createModelRegistryMetric(entry.display_prob, `${ref.ref_id}:prob:${idx}`, {
          createdAt: nowIso,
        }),
        display_prob_method: entry.display_prob_method,
        slot_cond_prob: createModelRegistryMetric(
          entry.slot_cond_prob,
          `${ref.ref_id}:slot_cond_prob:${idx}`,
          { createdAt: nowIso }
        ),
        click_only_evidence: !entry.item.item.value_terms,
      }));
    } else {
      const scored = contentCandidates.map((item) => {
        const res = scoreCandidateByRung({
          item,
          rung,
          sessionVector: sessionEmbedding,
        });
        return {
          id: item.item_id,
          weight: Math.max(1e-6, res.score),
          item,
          click_only_evidence: res.yen_value ? res.yen_value.click_only_evidence : true,
        };
      });

      const plOrdering = sampleFullPlackettLuceOrdering(scored, seedKey, temperature, topK);
      safeArticleItems = plOrdering.slice(0, topK).map((entry, idx) => ({
        item_id: entry.item.item.item_id,
        kind: entry.item.item.kind,
        rank: createDataLayerMetric(entry.rank, `${ref.ref_id}:rank:${idx}`, { createdAt: nowIso }),
        title: wrapUntrusted(entry.item.item.title, 'page_content'),
        url: wrapUntrusted(entry.item.item.url_key_v2, 'url'),
        display_prob: createModelRegistryMetric(entry.display_prob, `${ref.ref_id}:prob:${idx}`, {
          createdAt: nowIso,
        }),
        display_prob_method: entry.display_prob_method,
        slot_cond_prob: createModelRegistryMetric(
          entry.slot_cond_prob,
          `${ref.ref_id}:slot_cond_prob:${idx}`,
          { createdAt: nowIso }
        ),
        click_only_evidence: entry.item.click_only_evidence,
      }));
    }

    const measures: Record<string, MeasureInput<VerifiedNumericLeaf>> = {
      items_returned: {
        value: createDataLayerMetric(safeArticleItems.length, ref.ref_id, { createdAt: nowIso }),
        unit: 'count',
        status: 'ok',
        evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${siteId}` },
        sample: { n: contentCandidates.length, unit_kind: 'candidate_item' },
        interval: null,
      },
      exploration_temperature: {
        value: createModelRegistryMetric(temperature, ref.ref_id, { createdAt: nowIso }),
        unit: 'scalar',
        status: 'ok',
        evidence: { level: 'inferred', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${siteId}` },
        sample: { n: contentCandidates.length, unit_kind: 'candidate_item' },
        interval: null,
      },
    };

    const envelope = buildResponseEnvelope({
      window: { start: nowIso, end: nowIso },
      freshness: { data_through: nowIso, lag_s: 0, sources: { content_catalog: nowIso }, stale: false },
      coverage: { ratio: 1, denominator_n: contentCandidates.length },
      lineage: { schema_version: '2.0', def_ver: 2, collection_gen: 'v3' },
      residency: { storage_region: storageRegion, processing_region: processingRegion },
      measures,
      data: {
        placement,
        rung,
        items: safeArticleItems,
      },
      model: {
        id: rung,
        version: 'wave6_v1',
        trained_at: nowIso,
        status: rung === 'R0_hybrid_baseline' ? 'champion' : 'challenger',
      },
      policy: { version: 'rec_plackett_luce_v1', fallback_reason: null },
    });

    assertNoEcConfidentialLeak(envelope);
    return { httpStatus: 200, headers: responseHeaders, envelope };
  }

  // 7. E-Commerce Placement Path (`product_page | cart | home | post_purchase`)
  //    For `ugk_pub_*`, candidates/margin/stock come EXCLUSIVELY from server-registered `catalogProvider`!
  const ecCandidates =
    cfg.catalogProvider?.getEcCandidates({
      tenantId: principal.tenantId,
      siteId,
      placement,
    }) ??
    (!isBrowserPublicKey && Array.isArray(body.ec_candidates)
      ? (body.ec_candidates as readonly EcCandidateProduct[])
      : null);

  if (!ecCandidates || ecCandidates.length === 0) {
    const ref = makeActiveRef({
      refId: `rec_ec_empty_${siteId}`,
      kind: 'query',
      payload: { siteId, placement },
      issuedAt: nowIso,
      validUntil: validUntilIso,
    });
    const envelope = buildResponseEnvelope({
      window: { start: nowIso, end: nowIso },
      freshness: { data_through: nowIso, lag_s: 0, sources: { ec_catalog: 'unconnected' }, stale: false },
      coverage: { ratio: 0, denominator_n: 0 },
      lineage: { schema_version: '2.0', def_ver: 2, collection_gen: 'v3' },
      residency: { storage_region: storageRegion, processing_region: processingRegion },
      measures: {
        items_returned: {
          value: null,
          unit: 'count',
          status: 'not_collected',
          reason: 'No EC product catalog connected for this site',
          evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${siteId}` },
          sample: null,
          interval: null,
          unmet_gates: [
            {
              id: 'rec.ec_catalog_connected',
              required: 1,
              observed: 0,
              unlock: 'Connect EC product feed (Shopify / CSV / API) via Wave 4-D EcCatalogService',
            },
          ],
        },
      },
      data: { placement, items: [] },
      policy: { version: 'ec_rec_v1', fallback_reason: 'ec_catalog_not_connected' },
    });
    return { httpStatus: 200, headers: responseHeaders, envelope };
  }

  const cartProductIds = asStringArray(body.cart_product_ids);
  // Browser callers cannot force arbitrary server items out-of-stock to manipulate rankings ([H-02])
  const lastSecondSoldOutIds = isBrowserPublicKey ? [] : asStringArray(body.last_second_sold_out_ids);
  const directMemberKey =
    typeof body.member_key === 'string' && body.member_key.trim().length > 0
      ? body.member_key.trim()
      : null;
  const rawBrowserHash =
    typeof body.raw_member_hash === 'string' && body.raw_member_hash.trim().length > 0
      ? body.raw_member_hash.trim()
      : effectiveCallerChannel === 'browser' && directMemberKey
        ? directMemberKey
        : null;
  const proofToken = asProofToken(body.member_proof_token);
  const browserSessionId =
    typeof body.session_id === 'string' ? body.session_id.trim() : undefined;

  // Resolve consent strictly bounded by server-side site consent config ([H-02])
  let effectiveConsentMemberLink: boolean;
  let effectiveConsentPersonalisation: boolean;
  if (isBrowserPublicKey) {
    const serverConsent = cfg.resolveBrowserConsent?.({
      tenantId: principal.tenantId,
      siteId,
      sessionId: browserSessionId,
    });
    if (serverConsent) {
      effectiveConsentMemberLink = siteAllowsPersonalisation && serverConsent.memberLink;
      effectiveConsentPersonalisation = siteAllowsPersonalisation && serverConsent.personalisation;
    } else {
      // Without explicit server-side consent grant resolver, browser keys CANNOT self-escalate
      // member_link or personalisation consent!
      effectiveConsentMemberLink = false;
      effectiveConsentPersonalisation = false;
    }
  } else {
    effectiveConsentMemberLink = siteAllowsPersonalisation && body.consent_member_link === true;
    effectiveConsentPersonalisation = siteAllowsPersonalisation && body.consent_personalisation === true;
  }

  let ecOutput;
  try {
    ecOutput = runEcRecommendation({
      tenant_id: principal.tenantId,
      site_id: siteId,
      placement,
      caller_channel: effectiveCallerChannel,
      candidates: ecCandidates,
      top_k: topK,
      cart_product_ids: cartProductIds,
      seed_key: seedKey,
      temperature,
      now_iso: nowIso,
      last_second_sold_out_ids: lastSecondSoldOutIds,
      member_store: cfg.ecMemberStore,
      direct_server_member_key: effectiveCallerChannel === 'ec_server_direct' ? directMemberKey : null,
      browser_member_proof: proofToken,
      browser_session_id: browserSessionId,
      ec_server_proof_secret: cfg.ecServerProofSecret,
      raw_browser_member_hash: rawBrowserHash,
      consent_member_link: effectiveConsentMemberLink,
      consent_personalisation: effectiveConsentPersonalisation,
      member_lookup_timed_out: !isBrowserPublicKey && body.member_lookup_timed_out === true,
    });
  } catch (err) {
    if (err instanceof MemberProofRequiredError) {
      return {
        httpStatus: 403,
        headers: responseHeaders,
        error: {
          code: 'MEMBER_PROOF_REQUIRED',
          message:
            'Browser callers cannot pass raw member keys or hashes; provide an EC-server-signed proof token',
          auditEntryId: authz.auditEntryId,
        },
      };
    }
    throw err;
  }

  // Emit full OPE decision log strictly to server-side sink (NEVER returned in HTTP response!)
  if (cfg.onServerDecisionLog) {
    cfg.onServerDecisionLog({
      tenantId: principal.tenantId,
      siteId,
      placement,
      log: ecOutput.server_decision_log,
    });
  }

  const ref = makeActiveRef({
    refId: `rec_ec_${siteId}_${sha256Hex(seedKey).slice(0, 8)}`,
    kind: 'model',
    payload: { siteId, placement, topK, temperature, ruleVer: ecOutput.server_decision_log.exclusion_rule_ver },
    issuedAt: nowIso,
    validUntil: validUntilIso,
  });

  const safeItems: SafeSerializedEcItem[] = ecOutput.browser_items.map((item, idx) => ({
    product_id: item.product_id,
    rank: createDataLayerMetric(item.rank, `${ref.ref_id}:rank:${idx}`, { createdAt: nowIso }),
    title: wrapUntrusted(item.title, 'page_content'),
    product_url: wrapUntrusted(item.product_url_key_v2, 'url'),
    image_url: item.image_url ? wrapUntrusted(item.image_url, 'url') : null,
    hide_price: item.hide_price,
    price:
      item.hide_price || item.price === null
        ? null
        : createDataLayerMetric(item.price, `${ref.ref_id}:price:${idx}`, { createdAt: nowIso }),
    currency: item.hide_price ? null : item.currency,
    category: wrapUntrusted(item.category, 'page_content'),
    brand: item.brand ? wrapUntrusted(item.brand, 'page_content') : null,
  }));

  const envelope = buildResponseEnvelope({
    window: { start: nowIso, end: nowIso },
    freshness: { data_through: nowIso, lag_s: 0, sources: { ec_catalog: nowIso }, stale: false },
    coverage: { ratio: 1, denominator_n: ecCandidates.length },
    lineage: { schema_version: '2.0', def_ver: 2, collection_gen: 'v3' },
    residency: { storage_region: storageRegion, processing_region: processingRegion },
    measures: {
      items_returned: {
        value: createDataLayerMetric(safeItems.length, ref.ref_id, { createdAt: nowIso }),
        unit: 'count',
        status: 'ok',
        evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${siteId}` },
        sample: { n: ecCandidates.length, unit_kind: 'ec_product' },
        interval: null,
      },
      exploration_temperature: {
        value: createModelRegistryMetric(temperature, ref.ref_id, { createdAt: nowIso }),
        unit: 'scalar',
        status: 'ok',
        evidence: { level: 'inferred', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${siteId}` },
        sample: { n: ecCandidates.length, unit_kind: 'ec_product' },
        interval: null,
      },
    },
    data: {
      placement,
      items: safeItems,
    },
    model: {
      id: 'ec_full_plackett_luce_v1',
      version: ecOutput.server_decision_log.exclusion_rule_ver,
      trained_at: nowIso,
      status: 'champion',
    },
    policy: {
      version: ecOutput.server_decision_log.exclusion_rule_ver,
      fallback_reason: ecOutput.server_decision_log.member_fallback_reason,
    },
  });

  // Final defense-in-depth gate: verify ZERO gross margin, member history, boost deltas, or exclusion reasons leaked!
  assertNoEcConfidentialLeak(envelope);

  pipeline.gateway.auditLog.append({
    timestamp: nowIso,
    tenantId: principal.tenantId,
    targetTenantId: principal.tenantId,
    principalId: principal.principalId,
    credentialKind: principal.credentialKind,
    credentialId: principal.credentialId,
    action: 'recommendItems',
    riskClass: 'R0',
    resourceType: 'site',
    resourceId: siteId,
    outcome: 'allow',
    reason: 'OK',
    metadata: {
      channel: inv.channel,
      placement,
      items_returned: safeItems.length,
    },
  });

  return {
    httpStatus: 200,
    headers: responseHeaders,
    envelope,
  };
}

/**
 * Invokes `ugokilink_recommendItems` over the MCP channel through the exact same pipeline.
 */
export function callRecommendMcpTool(params: {
  readonly bearerToken?: string;
  readonly sessionPrincipal?: VerifiedPrincipal;
  readonly dpopProof?: string;
  readonly httpMethod?: string;
  readonly httpUri?: string;
  readonly mtlsThumbprint?: string;
  readonly clientIp?: string;
  readonly callerSuppliedTenantId?: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly pipeline?: SurfacePipeline;
  readonly config?: RecommendRuntimeConfig;
  readonly now?: Date;
}): RecommendExecutionResult {
  return executeRecommendRequest({
    channel: 'mcp',
    bearerToken: params.bearerToken,
    sessionPrincipal: params.sessionPrincipal,
    dpopProof: params.dpopProof,
    httpMethod: params.httpMethod,
    httpUri: params.httpUri,
    mtlsThumbprint: params.mtlsThumbprint,
    clientIp: params.clientIp,
    callerSuppliedTenantId: params.callerSuppliedTenantId,
    body: params.arguments,
    pipeline: params.pipeline,
    config: params.config,
    now: params.now,
  });
}
