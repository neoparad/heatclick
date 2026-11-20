/**
 * UGOKI LINK v2 — Single Surface Execution Pipeline (REST & MCP)
 *
 * Implements Master Architecture v2 §11.5–§11.9:
 *   1. Authenticate credential (`ugk_sec`, `oauth_mcp`, `oem_exchanged`, `session_cookie`, `ugk_pub`)
 *   2. Resolve tenant/site EXCLUSIVELY from verified credential & site registry (caller-supplied tenant_id rejected -> 404)
 *   3. Enforce scope + Risk Class R0–R5 via `AuthorizationGateway` (404 foreign, 403 own-tenant missing scope)
 *   4. Enforce cost-unit rate limit (cached/sealed reads ~0–1 units)
 *   5. Execute operation against DI `SurfaceDataRepository` (NEVER fabricates dummy values; missing -> `not_collected` / `insufficient_data` / `not_entitled`)
 *   6. Serialize EVERY data response through `buildResponseEnvelope()` (`packages/contract/response` I1–I7)
 *   7. Attach API version / revision / >= 180-day `Sunset` headers
 *   8. Emit hash-chained audit entry on every call
 */

import {
  getCapabilitiesSummary,
  type CapabilitiesSummary,
  type GateStatus,
} from '@/packages/contract/ledgers';
import {
  buildResponseEnvelope,
  createDataLayerMetric,
  sha256Hex,
  wrapUntrusted,
  type EvidenceRef,
  type MeasureInput,
  type ResidencyBlock,
  type SerializedResponseEnvelope,
  type VerifiedNumericLeaf,
} from '@/packages/contract/response';
import type { ConsentMode } from '@/packages/contract/schema';
import {
  AuthorizationGateway,
  IdentityKeyRegistry,
  type FieldProvenance,
  type PasskeyAssertionInput,
  type VerifiedPrincipal,
} from '@/lib/link/auth';
import { TenantScopedQueryBuilder } from '@/lib/link/isolation';
import {
  buildApiVersionHeaders,
  buildOpenApi31Document,
  getOperationSpec,
  OPERATION_CATALOG,
  type OperationSpec,
} from './openapi';
import {
  SegmentRegistry,
  buildSegmentComparisonMeasures,
  type MlSegmentDescriptor,
  type SegmentDefinitionKind,
  type SegmentObservedMetricsRow,
  type SegmentRuleNode,
} from './segments';
import {
  GoalRegistry,
  buildDeletionCertificate,
  buildSitePrivacyDisclosure,
  evaluateNavigationPaths,
  evaluateOrderedFunnel,
  evaluateSiteUsage,
  type ConversionGoalDefinition,
  type GoalKind,
  type JourneyEventObservation,
  type SiteNotification,
  type UsageLedgerRow,
} from './journeys';

// =========================================================================
// 1. DI Data Repository Interface (Zero Dummy Data on Unconnected Store)
// =========================================================================

export interface SiteRuntimeConfig {
  readonly siteId: string;
  readonly tenantId: string;
  readonly siteName: string;
  readonly consentMode: ConsentMode;
  readonly storageRegion: string;
  readonly processingRegion: string;
  readonly monthlyQuotaPvs: number;
  readonly activeLinkGrantId?: string | null;
  readonly committedSnapshotId?: string | null;
  readonly registeredDestinationUrls?: ReadonlyArray<string>;
}

export interface SiteMetricsSnapshot {
  readonly connected: boolean;
  readonly pageViews: number | null;
  readonly conversions: number | null;
  readonly avgFocalDwellMs: number | null;
  readonly scriptBlockedShareBound?: readonly [number, number] | null;
  readonly dataThrough: string;
  readonly lagSeconds: number;
  readonly queryRefId: string;
  readonly paramsHash: string;
  readonly resultDigest: string;
  readonly collectionGen: 'v3' | 'legacy';
}

export interface FusedInsightRow {
  readonly pageId: string;
  readonly rawUrl: string;
  readonly secFp: string;
  readonly pageViews: number;
  readonly reachRate: number;
  readonly snapshotId: string;
}

export interface SurfaceDataRepository {
  getSiteConfig(siteId: string): SiteRuntimeConfig | null;
  queryMetrics(params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly segmentId?: string;
  }): SiteMetricsSnapshot | null;
  queryFusedInsights(params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly pageId?: string;
  }): ReadonlyArray<FusedInsightRow> | null;
  querySegmentMetrics(params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly segmentIds: ReadonlyArray<string>;
  }): ReadonlyArray<SegmentObservedMetricsRow> | null;
  queryJourneyEvents(params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly windowStart: string;
    readonly windowEnd: string;
  }): ReadonlyArray<JourneyEventObservation> | null;
  queryUsageRows(params: {
    readonly tenantId: string;
    readonly siteId: string;
  }): ReadonlyArray<UsageLedgerRow> | null;
  getGateOverrides?(siteId: string): Readonly<Record<string, GateStatus>>;
}

/**
 * Default safe repository used when no live ClickHouse/store adapter is connected:
 * returns `null` for data queries so every route honestly reports `not_collected`
 * instead of ever fabricating mock numbers!
 */
export class EmptyUnconnectedRepository implements SurfaceDataRepository {
  private readonly siteConfigs = new Map<string, SiteRuntimeConfig>();

  public registerSiteConfig(cfg: SiteRuntimeConfig): void {
    this.siteConfigs.set(cfg.siteId, cfg);
  }

  public getSiteConfig(siteId: string): SiteRuntimeConfig | null {
    return this.siteConfigs.get(siteId) ?? null;
  }

  public queryMetrics(): SiteMetricsSnapshot | null {
    return null;
  }

  public queryFusedInsights(): ReadonlyArray<FusedInsightRow> | null {
    return null;
  }

  public querySegmentMetrics(): ReadonlyArray<SegmentObservedMetricsRow> | null {
    return null;
  }

  public queryJourneyEvents(): ReadonlyArray<JourneyEventObservation> | null {
    return null;
  }

  public queryUsageRows(): ReadonlyArray<UsageLedgerRow> | null {
    return null;
  }
}

// =========================================================================
// 2. Cost-Unit Rate Limiter (§11.9)
// =========================================================================

export class CostUnitRateLimiter {
  private readonly buckets = new Map<string, { used: number; windowStartMs: number }>();
  private readonly windowMs: number;
  private readonly maxUnitsPerWindow: number;

  constructor(options?: { readonly windowMs?: number; readonly maxUnitsPerWindow?: number }) {
    this.windowMs = options?.windowMs ?? 60_000;
    this.maxUnitsPerWindow = options?.maxUnitsPerWindow ?? 120;
  }

  public consume(
    key: string,
    costUnits: number,
    now: Date = new Date()
  ): { readonly allowed: boolean; readonly remaining: number; readonly retryAfterSec: number } {
    if (costUnits <= 0) {
      return { allowed: true, remaining: this.maxUnitsPerWindow, retryAfterSec: 0 };
    }
    const nowMs = now.getTime();
    let bucket = this.buckets.get(key);
    if (!bucket || nowMs - bucket.windowStartMs >= this.windowMs) {
      bucket = { used: 0, windowStartMs: nowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.used + costUnits > this.maxUnitsPerWindow) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil((bucket.windowStartMs + this.windowMs - nowMs) / 1000)
      );
      return {
        allowed: false,
        remaining: Math.max(0, this.maxUnitsPerWindow - bucket.used),
        retryAfterSec,
      };
    }
    bucket.used += costUnits;
    return {
      allowed: true,
      remaining: Math.max(0, this.maxUnitsPerWindow - bucket.used),
      retryAfterSec: 0,
    };
  }
}

// =========================================================================
// 3. Capabilities Projection (`available | not_entitled | not_collected | gated`)
// =========================================================================

export type CapabilityAvailability = 'available' | 'not_entitled' | 'not_collected' | 'gated';

export interface OperationCapabilityItem {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly riskClass: string;
  readonly availability: CapabilityAvailability;
  readonly reason: string;
  readonly unlockCondition: string;
}

export interface SiteCapabilitiesPayload {
  readonly siteId: string;
  readonly consentMode: ConsentMode;
  readonly operations: ReadonlyArray<OperationCapabilityItem>;
  readonly gateLedgerSummary: CapabilitiesSummary;
}

export function computeSiteCapabilities(params: {
  readonly site: SiteRuntimeConfig;
  readonly principal: VerifiedPrincipal;
  readonly gateOverrides?: Readonly<Record<string, GateStatus>>;
  readonly now?: Date;
}): SiteCapabilitiesPayload {
  const nowIso = (params.now ?? new Date()).toISOString();
  const gateLedgerSummary = getCapabilitiesSummary({
    siteId: params.site.siteId,
    statusOverrides: params.gateOverrides,
    now: nowIso,
  });

  const operations: OperationCapabilityItem[] = OPERATION_CATALOG.map((op) => {
    if (op.requiredScope && !params.principal.effectiveScopes.has(op.requiredScope)) {
      return {
        operationId: op.operationId,
        method: op.method,
        path: op.path,
        riskClass: op.riskClass,
        availability: 'not_entitled',
        reason: `Missing required scope "${op.requiredScope}"`,
        unlockCondition: `Grant scope "${op.requiredScope}" via tenant plan, principal role, and key scope`,
      };
    }

    if (params.site.consentMode === 'off' && (op.tag === 'analytics' || op.tag === 'journeys' || op.tag === 'segments')) {
      return {
        operationId: op.operationId,
        method: op.method,
        path: op.path,
        riskClass: op.riskClass,
        availability: 'not_collected',
        reason: 'Site consent mode is "off"; human behaviour metrics are not collected',
        unlockCondition: 'Publish verified disclosure record (tel.G12) and advance site consent mode above "off"',
      };
    }

    if (op.operationId === 'queryJourneys' && params.site.consentMode === 'cookieless') {
      return {
        operationId: op.operationId,
        method: op.method,
        path: op.path,
        riskClass: op.riskClass,
        availability: 'not_collected',
        reason: 'Cross-page session funnels/paths are unavailable under cookieless mode (tel.U13)',
        unlockCondition: 'Enable consent mode "session", "stats_exempt", or "full" (tel.G10 / D-01)',
      };
    }

    if (
      op.operationId === 'querySiteFusedInsights' &&
      (!params.site.activeLinkGrantId || !params.site.committedSnapshotId)
    ) {
      return {
        operationId: op.operationId,
        method: op.method,
        path: op.path,
        riskClass: op.riskClass,
        availability: 'gated',
        reason: 'Requires active CRAWL link grant and committed structure snapshot (surf.fused_endpoints)',
        unlockCondition: 'Activate surf.link_grant_active and commit at least one structure snapshot',
      };
    }

    if (op.riskClass === 'R2' || op.riskClass === 'R5') {
      return {
        operationId: op.operationId,
        method: op.method,
        path: op.path,
        riskClass: op.riskClass,
        availability: 'gated',
        reason: `Risk class ${op.riskClass} requires human passkey approval or active autonomy envelope`,
        unlockCondition:
          op.riskClass === 'R5'
            ? 'Authenticate via interactive console session + WebAuthn passkey UV'
            : 'Provide passkey approval record or active autonomy envelope + sender-constrained credential',
      };
    }

    return {
      operationId: op.operationId,
      method: op.method,
      path: op.path,
      riskClass: op.riskClass,
      availability: 'available',
      reason: 'Ready',
      unlockCondition: 'None',
    };
  });

  return {
    siteId: params.site.siteId,
    consentMode: params.site.consentMode,
    operations,
    gateLedgerSummary,
  };
}

// =========================================================================
// 4. Unified Surface Pipeline (`SurfacePipeline`)
// =========================================================================

export interface SurfaceInvocation {
  readonly operationId: string;
  readonly channel: 'rest' | 'mcp';
  /** Raw bearer token (`ugk_sec_*`, `ugk_oauth_*`, `ugk_oemx_*`, `ugk_pub_*`) OR pre-verified session principal. */
  readonly bearerToken?: string;
  readonly sessionPrincipal?: VerifiedPrincipal;
  readonly clientIp?: string;
  readonly dpopThumbprint?: string;
  /** Caller-supplied `tenant_id` (if any) — strictly rejected on foreign mismatch -> 404 + audit. */
  readonly callerSuppliedTenantId?: string;
  readonly siteId?: string;
  readonly idempotencyKey?: string;
  readonly requestedRevision?: string | null;
  readonly deprecatedSunsetIso?: string | null;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly passkeyApprovalId?: string;
  readonly passkeyAssertion?: PasskeyAssertionInput;
  readonly autonomyEnvelopeId?: string;
  readonly fieldProvenance?: ReadonlyArray<FieldProvenance>;
  readonly now?: Date;
}

export interface SurfaceExecutionResult {
  readonly httpStatus: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly envelope?: SerializedResponseEnvelope;
  readonly rawBody?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly approvalUrl?: string;
    readonly auditEntryId?: string;
  };
}

export interface SurfacePipelineDependencies {
  readonly keyRegistry: IdentityKeyRegistry;
  readonly gateway?: AuthorizationGateway;
  readonly queryBuilder?: TenantScopedQueryBuilder;
  readonly repository: SurfaceDataRepository;
  readonly segments?: SegmentRegistry;
  readonly goals?: GoalRegistry;
  readonly rateLimiter?: CostUnitRateLimiter;
  readonly askHandler?: (ctx: {
    readonly principal: VerifiedPrincipal;
    readonly site: SiteRuntimeConfig;
    readonly body: Readonly<Record<string, unknown>>;
    readonly now: Date;
  }) => SurfaceExecutionResult;
}

export class SurfacePipeline {
  public readonly keyRegistry: IdentityKeyRegistry;
  public readonly gateway: AuthorizationGateway;
  public readonly queryBuilder: TenantScopedQueryBuilder;
  public readonly repository: SurfaceDataRepository;
  public readonly segments: SegmentRegistry;
  public readonly goals: GoalRegistry;
  public readonly rateLimiter: CostUnitRateLimiter;
  private readonly askHandler?: SurfacePipelineDependencies['askHandler'];
  private readonly notificationsBySite = new Map<string, SiteNotification[]>();

  constructor(deps: SurfacePipelineDependencies) {
    this.keyRegistry = deps.keyRegistry;
    this.gateway = deps.gateway ?? new AuthorizationGateway();
    this.queryBuilder = deps.queryBuilder ?? new TenantScopedQueryBuilder();
    this.repository = deps.repository;
    this.segments = deps.segments ?? new SegmentRegistry();
    this.goals = deps.goals ?? new GoalRegistry();
    this.rateLimiter = deps.rateLimiter ?? new CostUnitRateLimiter();
    this.askHandler = deps.askHandler;
  }

  public addNotification(notification: SiteNotification): void {
    const key = `${notification.tenantId}:${notification.siteId}`;
    const list = this.notificationsBySite.get(key) ?? [];
    list.push(notification);
    this.notificationsBySite.set(key, list);
  }

  private resolvePrincipal(inv: SurfaceInvocation, now: Date):
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
      return this.keyRegistry.verifySecretKey(raw, {
        clientIp: inv.clientIp,
        siteId: inv.siteId,
        senderThumbprint: inv.dpopThumbprint,
        now,
      });
    }
    if (raw.startsWith('ugk_oauth_')) {
      return this.keyRegistry.verifyMcpOAuthToken(raw, {
        dpopThumbprint: inv.dpopThumbprint,
        now,
      });
    }
    if (raw.startsWith('ugk_oemx_')) {
      return this.keyRegistry.verifyOemExchangedToken(raw, {
        senderThumbprint: inv.dpopThumbprint,
        now,
      });
    }
    if (raw.startsWith('ugk_oem_')) {
      return this.keyRegistry.verifyOemManagementKey(raw, now);
    }
    if (raw.startsWith('ugk_pub_')) {
      return this.keyRegistry.verifyPublicKeyToPrincipal(raw);
    }
    return { ok: false, httpStatus: 401, code: 'UNSUPPORTED_CREDENTIAL', reason: 'Unrecognized credential prefix' };
  }

  public execute(inv: SurfaceInvocation): SurfaceExecutionResult {
    const now = inv.now ?? new Date();
    const versionHeaders = buildApiVersionHeaders({
      requestedRevision: inv.requestedRevision,
      deprecatedSunsetIso: inv.deprecatedSunsetIso,
      now,
    });

    const op = getOperationSpec(inv.operationId);
    if (!op) {
      return {
        httpStatus: 404,
        headers: versionHeaders,
        error: { code: 'UNKNOWN_OPERATION', message: `Unknown operationId: ${inv.operationId}` },
      };
    }

    // OpenAPI spec document is public metadata (cost 0)
    if (op.operationId === 'getOpenApiSpec') {
      return {
        httpStatus: 200,
        headers: versionHeaders,
        rawBody: buildOpenApi31Document(),
      };
    }

    // Step 1: Authenticate credential
    const authRes = this.resolvePrincipal(inv, now);
    if (!authRes.ok) {
      return {
        httpStatus: authRes.httpStatus,
        headers: versionHeaders,
        error: { code: authRes.code, message: authRes.reason },
      };
    }
    const principal = authRes.principal;

    // Step 2: Resolve target site server-side (never trusting caller tenant_id!)
    const targetSiteId =
      inv.siteId ??
      (typeof inv.body?.siteId === 'string' ? inv.body.siteId : undefined) ??
      (typeof inv.params?.siteId === 'string' ? inv.params.siteId : undefined);

    if (!targetSiteId) {
      return {
        httpStatus: 400,
        headers: versionHeaders,
        error: { code: 'MISSING_SITE_ID', message: 'siteId is required' },
      };
    }

    const siteCfg = this.repository.getSiteConfig(targetSiteId);
    const resourceTenantId = siteCfg ? siteCfg.tenantId : '__nonexistent_tenant__';

    // Step 3: Unified Authorization Gateway (foreign tenant -> 404 + audit, own missing scope -> 403, R0–R5)
    const authz = this.gateway.authorize({
      principal,
      action: op.operationId,
      riskClass: op.riskClass,
      requiredScope: op.requiredScope,
      resource: {
        type: 'site',
        id: targetSiteId,
        tenantId: resourceTenantId,
        siteId: targetSiteId,
      },
      callerSuppliedTenantId: inv.callerSuppliedTenantId,
      idempotencyKey: inv.idempotencyKey,
      renderedDiff: inv.body,
      passkeyApprovalId: inv.passkeyApprovalId,
      passkeyAssertion: inv.passkeyAssertion,
      autonomyEnvelopeId: inv.autonomyEnvelopeId,
      fieldProvenance: inv.fieldProvenance,
      destruction:
        op.operationId === 'createDeletionRequest' && inv.body
          ? {
              scope: (inv.body.scope as 'subject' | 'site' | 'tenant') ?? 'subject',
              subjectIds: Array.isArray(inv.body.subjectIds)
                ? (inv.body.subjectIds as string[])
                : undefined,
              reason: typeof inv.body.reason === 'string' ? inv.body.reason : 'privacy_request',
            }
          : undefined,
      now,
    });

    if (!authz.allowed) {
      return {
        httpStatus: authz.httpStatus,
        headers: versionHeaders,
        error: {
          code: authz.code,
          message: authz.reason,
          approvalUrl: authz.approvalUrl,
          auditEntryId: authz.auditEntryId,
        },
      };
    }

    if (!siteCfg) {
      return {
        httpStatus: 404,
        headers: versionHeaders,
        error: { code: 'NOT_FOUND', message: 'Site not found', auditEntryId: authz.auditEntryId },
      };
    }

    // Step 4: Cost-unit rate limiter (§11.9)
    const rateCheck = this.rateLimiter.consume(
      `${principal.tenantId}:${principal.credentialId}`,
      op.costUnits,
      now
    );
    if (!rateCheck.allowed) {
      return {
        httpStatus: 429,
        headers: {
          ...versionHeaders,
          'Retry-After': String(rateCheck.retryAfterSec),
          'X-UGOKI-Cost-Units-Remaining': String(rateCheck.remaining),
        },
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Cost-unit rate limit exceeded for operation ${op.operationId} (cost=${op.costUnits})`,
          auditEntryId: authz.auditEntryId,
        },
      };
    }

    // Step 5: Check isolation hold (503) on primary table for analytics reads
    if (
      (op.tag === 'analytics' || op.tag === 'journeys' || op.tag === 'segments') &&
      this.queryBuilder.isTableHeld('rollup_page_hourly')
    ) {
      return {
        httpStatus: 503,
        headers: versionHeaders,
        error: {
          code: 'TABLE_ISOLATION_HOLD_503',
          message: 'Serving temporarily paused due to isolation watchdog incident F-01',
          auditEntryId: authz.auditEntryId,
        },
      };
    }

    const enrichedHeaders: Record<string, string> = {
      ...versionHeaders,
      'X-UGOKI-Cost-Units': String(op.costUnits),
      'X-UGOKI-Cost-Units-Remaining': String(rateCheck.remaining),
      'X-UGOKI-Audit-Id': authz.auditEntryId,
    };

    // Step 6: Execute operation and serialize through single `buildResponseEnvelope` (I1–I7)
    return this.dispatchOperation(op, principal, siteCfg, inv, authz, enrichedHeaders, now);
  }

  private defaultResidency(site: SiteRuntimeConfig): ResidencyBlock {
    return {
      storage_region: site.storageRegion,
      processing_region: site.processingRegion,
    };
  }

  private defaultWindow(inv: SurfaceInvocation, now: Date): { readonly start: string; readonly end: string } {
    const end =
      typeof inv.params?.end === 'string' && inv.params.end
        ? inv.params.end
        : now.toISOString();
    const start =
      typeof inv.params?.start === 'string' && inv.params.start
        ? inv.params.start
        : new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString();
    return { start, end };
  }

  private dispatchOperation(
    op: OperationSpec,
    principal: VerifiedPrincipal,
    site: SiteRuntimeConfig,
    inv: SurfaceInvocation,
    authz: { readonly auditEntryId: string; readonly destructionRequest?: { readonly requestId: string; readonly undoToken: string; readonly undoWindowEndsAt: string; readonly state: 'scheduled' } },
    headers: Readonly<Record<string, string>>,
    now: Date
  ): SurfaceExecutionResult {
    const nowIso = now.toISOString();
    const window = this.defaultWindow(inv, now);
    const residency = this.defaultResidency(site);
    const usageBlock = { cost_units: op.costUnits, meter: 'api_cost_units' };

    const makeRef = (kind: EvidenceRef['kind'], seed: string): EvidenceRef => ({
      ref_id: `ref_${sha256Hex(`${site.tenantId}:${site.siteId}:${seed}`).slice(0, 16)}`,
      kind,
      params_hash: sha256Hex(`${op.operationId}:${site.siteId}:${window.start}:${window.end}`),
      watermarks: { as_of: nowIso },
      result_digest: sha256Hex(seed),
      issued_at: nowIso,
      valid_until: new Date(now.getTime() + 24 * 3600_000).toISOString(),
      kid: 'surface_v1',
    });

    switch (op.operationId) {
      case 'getSiteCapabilities': {
        const cap = computeSiteCapabilities({
          site,
          principal,
          gateOverrides: this.repository.getGateOverrides?.(site.siteId),
          now,
        });
        const envelope = buildResponseEnvelope({
          window,
          freshness: { data_through: nowIso, lag_s: 0, sources: { ledger: nowIso }, stale: false },
          coverage: { ratio: 1, denominator_n: cap.operations.length },
          lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
          residency,
          usage: usageBlock,
          default_empty_status: 'ok',
          measures: {
            available_operations: {
              value: createDataLayerMetric(
                cap.operations.filter((o) => o.availability === 'available').length,
                `cap:${site.siteId}`,
                { authority: 'data_layer', createdAt: nowIso }
              ),
              unit: 'operations',
              status: 'ok',
              evidence: {
                level: 'observed',
                exactness: 'exact',
                criteria: [],
                refs: [makeRef('ledger', `cap:${site.siteId}`)],
                scope: `site:${site.siteId}`,
              },
              sample: { n: cap.operations.length, unit_kind: 'operation' },
              interval: null,
            },
          },
          data: cap,
        });
        return { httpStatus: 200, headers, envelope };
      }

      case 'querySiteMetrics': {
        const ref = makeRef('query', `metrics:${site.siteId}:${window.start}:${window.end}`);

        // Consent mode `off` -> never fabricate metrics; honestly return `not_collected`
        if (site.consentMode === 'off') {
          const envelope = buildResponseEnvelope({
            window,
            freshness: { data_through: nowIso, lag_s: 0, sources: {}, stale: false },
            coverage: { ratio: 0, denominator_n: 0 },
            lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
            residency,
            usage: usageBlock,
            measures: {
              page_views: {
                value: null,
                unit: 'page_views',
                status: 'not_collected',
                reason: 'Site consent mode is off; behaviour telemetry is not collected',
                evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
                sample: null,
                interval: null,
                unmet_gates: [{ id: 'tel.G10', required: 'cookieless', observed: 'off', unlock: 'Enable consent mode >= cookieless and disclosure tel.G12' }],
              },
            },
          });
          return { httpStatus: 200, headers, envelope };
        }

        // Validate SQL through TenantScopedQueryBuilder (Layer A AST lint)
        this.queryBuilder.build(principal, {
          sql: `SELECT page_id, sum(pv_count) FROM rollup_page_hourly WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND pv_hour >= {start:DateTime} AND pv_hour < {end:DateTime} GROUP BY page_id`,
          siteId: site.siteId,
          params: { start: window.start, end: window.end },
        });

        const snap = this.repository.queryMetrics({
          tenantId: principal.tenantId,
          siteId: site.siteId,
          windowStart: window.start,
          windowEnd: window.end,
          segmentId: typeof inv.params?.segmentId === 'string' ? inv.params.segmentId : undefined,
        });

        if (!snap || !snap.connected || snap.pageViews === null) {
          const envelope = buildResponseEnvelope({
            window,
            freshness: { data_through: nowIso, lag_s: 0, sources: {}, stale: true },
            coverage: { ratio: 0, denominator_n: 0 },
            lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
            residency,
            usage: usageBlock,
            measures: {
              page_views: {
                value: null,
                unit: 'page_views',
                status: 'not_collected',
                reason: 'No behaviour telemetry rows stored for requested window',
                evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
                sample: null,
                interval: null,
                unmet_gates: [{ id: 'store.G-7', required: 1, observed: 0, unlock: 'Collect and seal hourly rollups for this site' }],
              },
              conversions: {
                value: null,
                unit: 'conversions',
                status: 'not_collected',
                reason: 'No conversion rows stored for requested window',
                evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
                sample: null,
                interval: null,
                unmet_gates: [{ id: 'tel.G17', required: 1, observed: 0, unlock: 'Configure conversion goals and collect events' }],
              },
            },
          });
          return { httpStatus: 200, headers, envelope };
        }

        const qRef: EvidenceRef = {
          ref_id: snap.queryRefId,
          kind: 'query',
          params_hash: snap.paramsHash,
          watermarks: { sealed_through: snap.dataThrough },
          result_digest: snap.resultDigest,
          issued_at: nowIso,
          valid_until: new Date(now.getTime() + 24 * 3600_000).toISOString(),
          kid: 'surface_v1',
        };

        const measures: Record<string, MeasureInput<VerifiedNumericLeaf>> = {
          page_views: {
            value: createDataLayerMetric(snap.pageViews, snap.queryRefId, {
              authority: 'sealed_rollup',
              createdAt: snap.dataThrough,
            }),
            unit: 'page_views',
            status: 'ok',
            evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [qRef], scope: `site:${site.siteId}` },
            sample: { n: snap.pageViews, unit_kind: 'page_view' },
            interval: null,
          },
          conversions:
            snap.conversions !== null
              ? {
                  value: createDataLayerMetric(snap.conversions, snap.queryRefId, {
                    authority: 'sealed_rollup',
                    createdAt: snap.dataThrough,
                  }),
                  unit: 'conversions',
                  status: 'ok',
                  evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [qRef], scope: `site:${site.siteId}` },
                  sample: { n: snap.pageViews, unit_kind: 'page_view' },
                  interval: null,
                }
              : {
                  value: null,
                  unit: 'conversions',
                  status: 'not_collected',
                  reason: 'Conversions not yet configured or collected',
                  evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [qRef], scope: `site:${site.siteId}` },
                  sample: null,
                  interval: null,
                  unmet_gates: [{ id: 'tel.G17', required: 1, observed: 0, unlock: 'Define goals via POST /v1/sites/{siteId}/goals' }],
                },
          focal_dwell_ms:
            snap.avgFocalDwellMs !== null
              ? {
                  value: createDataLayerMetric(snap.avgFocalDwellMs, snap.queryRefId, {
                    authority: 'sealed_rollup',
                    createdAt: snap.dataThrough,
                  }),
                  unit: 'ms',
                  status: 'ok',
                  evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [qRef], scope: `site:${site.siteId}` },
                  sample: { n: snap.pageViews, unit_kind: 'page_view' },
                  interval: null,
                }
              : {
                  value: null,
                  unit: 'ms',
                  status: 'not_collected',
                  reason: 'Focal dwell proxy not collected for window',
                  evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [qRef], scope: `site:${site.siteId}` },
                  sample: null,
                  interval: null,
                  unmet_gates: [{ id: 'tel.G5', required: 1, observed: 0, unlock: 'Enable v3 section focal dwell telemetry' }],
                },
        };

        const envelope = buildResponseEnvelope({
          window,
          freshness: {
            data_through: snap.dataThrough,
            lag_s: snap.lagSeconds,
            sources: { rollup_page_hourly: snap.dataThrough },
            stale: snap.lagSeconds > 3600,
          },
          coverage: { ratio: 1, denominator_n: snap.pageViews },
          lineage: { schema_version: '2.0', def_ver: 1, collection_gen: snap.collectionGen },
          residency,
          usage: usageBlock,
          quality: { source: 'sealed', exactness: 'exact', collection_gen: snap.collectionGen },
          measures,
        });
        return { httpStatus: 200, headers, envelope };
      }

      case 'querySiteFusedInsights': {
        const ref = makeRef('snapshot', `fused:${site.siteId}`);
        if (!site.activeLinkGrantId || !site.committedSnapshotId) {
          const envelope = buildResponseEnvelope({
            window,
            freshness: { data_through: nowIso, lag_s: 0, sources: {}, stale: false },
            coverage: { ratio: 0, denominator_n: 0 },
            lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
            residency,
            usage: usageBlock,
            measures: {
              fused_sections: {
                value: null,
                unit: 'sections',
                status: 'not_entitled',
                reason: 'Fused insights require active link grant and committed CRAWL structure snapshot',
                evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
                sample: null,
                interval: null,
                unmet_gates: [
                  {
                    id: 'surf.fused_endpoints',
                    required: 1,
                    observed: 0,
                    unlock: 'Activate surf.link_grant_active and commit snapshot in registry',
                  },
                ],
              },
            },
          });
          return { httpStatus: 200, headers, envelope };
        }

        const rows = this.repository.queryFusedInsights({
          tenantId: principal.tenantId,
          siteId: site.siteId,
          pageId: typeof inv.params?.pageId === 'string' ? inv.params.pageId : undefined,
        });
        if (!rows || rows.length === 0) {
          const envelope = buildResponseEnvelope({
            window,
            freshness: { data_through: nowIso, lag_s: 0, sources: {}, stale: false },
            coverage: { ratio: 0, denominator_n: 0 },
            lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
            residency,
            usage: usageBlock,
            measures: {
              fused_sections: {
                value: null,
                unit: 'sections',
                status: 'not_collected',
                reason: 'No joined structure x behaviour rows found',
                evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
                sample: null,
                interval: null,
                unmet_gates: [{ id: 'join.G4', required: 1, observed: 0, unlock: 'Complete structure x behaviour join for this site' }],
              },
            },
          });
          return { httpStatus: 200, headers, envelope };
        }

        // Wrap every external URL in UntrustedValue (Invariant I7!)
        const safeRows = rows.map((r) => ({
          pageId: r.pageId,
          pageUrl: wrapUntrusted(r.rawUrl, 'url'),
          secFp: r.secFp,
          pageViews: r.pageViews,
          reachRate: r.reachRate,
          snapshotId: r.snapshotId,
        }));

        const envelope = buildResponseEnvelope({
          window,
          freshness: { data_through: nowIso, lag_s: 0, sources: { snapshot: site.committedSnapshotId }, stale: false },
          coverage: { ratio: 1, denominator_n: rows.length },
          lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
          residency,
          usage: usageBlock,
          measures: {
            fused_sections: {
              value: createDataLayerMetric(rows.length, ref.ref_id, { authority: 'data_layer', createdAt: nowIso }),
              unit: 'sections',
              status: 'ok',
              evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
              sample: { n: rows.length, unit_kind: 'section' },
              interval: null,
            },
          },
          data: { rows: safeRows },
        });
        return { httpStatus: 200, headers, envelope };
      }

      case 'listSegments': {
        const list = this.segments.listForSite(principal.tenantId, site.siteId);
        const ref = makeRef('ledger', `segments:${site.siteId}`);
        const envelope = buildResponseEnvelope({
          window,
          freshness: { data_through: nowIso, lag_s: 0, sources: { segments: nowIso }, stale: false },
          coverage: { ratio: 1, denominator_n: list.length },
          lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
          residency,
          usage: usageBlock,
          measures: {
            registered_segments: {
              value: createDataLayerMetric(list.length, ref.ref_id, { authority: 'data_layer', createdAt: nowIso }),
              unit: 'segments',
              status: 'ok',
              evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
              sample: { n: list.length, unit_kind: 'segment' },
              interval: null,
            },
          },
          data: { segments: list },
        });
        return { httpStatus: 200, headers, envelope };
      }

      case 'createSegment': {
        const body = inv.body ?? {};
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const kind = (body.kind as SegmentDefinitionKind | undefined) ?? 'rule';
        if (!name) {
          return { httpStatus: 400, headers, error: { code: 'INVALID_SEGMENT', message: 'Segment name is required' } };
        }
        const created = this.segments.register({
          tenantId: principal.tenantId,
          siteId: site.siteId,
          segmentId: typeof body.segmentId === 'string' ? body.segmentId : undefined,
          name,
          description: typeof body.description === 'string' ? body.description : undefined,
          kind,
          rule: body.rule as SegmentRuleNode | undefined,
          mlDescriptor: body.mlDescriptor as MlSegmentDescriptor | undefined,
          createdByPrincipalId: principal.principalId,
          now,
        });
        const ref = makeRef('ledger', `seg:${created.segmentId}:v${created.version}`);
        const envelope = buildResponseEnvelope({
          window,
          freshness: { data_through: nowIso, lag_s: 0, sources: { segments: nowIso }, stale: false },
          coverage: { ratio: 1, denominator_n: 1 },
          lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
          residency,
          usage: usageBlock,
          measures: {
            segment_version: {
              value: createDataLayerMetric(created.version, ref.ref_id, { authority: 'data_layer', createdAt: nowIso }),
              unit: 'version',
              status: 'ok',
              evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `segment:${created.segmentId}` },
              sample: { n: 1, unit_kind: 'version' },
              interval: null,
            },
          },
          data: { segment: created },
        });
        return { httpStatus: 200, headers, envelope };
      }

      case 'compareSegments': {
        const segmentIds = Array.isArray(inv.body?.segmentIds)
          ? (inv.body.segmentIds as string[])
          : [];
        const rows = this.repository.querySegmentMetrics({
          tenantId: principal.tenantId,
          siteId: site.siteId,
          segmentIds,
        });
        const ref = makeRef('query', `seg_compare:${site.siteId}:${segmentIds.join(',')}`);
        if (!rows || rows.length === 0) {
          const envelope = buildResponseEnvelope({
            window,
            freshness: { data_through: nowIso, lag_s: 0, sources: {}, stale: false },
            coverage: { ratio: 0, denominator_n: 0 },
            lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
            residency,
            usage: usageBlock,
            measures: {
              segment_comparison: {
                value: null,
                unit: 'segments',
                status: 'not_collected',
                reason: 'No observed segment metrics stored for requested segmentIds',
                evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
                sample: null,
                interval: null,
                unmet_gates: [{ id: 'store.G-7', required: 1, observed: 0, unlock: 'Collect telemetry and materialize segment rollups' }],
              },
            },
          });
          return { httpStatus: 200, headers, envelope };
        }

        const comparison = buildSegmentComparisonMeasures(rows);
        const envelope = buildResponseEnvelope({
          window,
          freshness: { data_through: nowIso, lag_s: 0, sources: { segments: nowIso }, stale: false },
          coverage: { ratio: 1, denominator_n: rows.length },
          lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
          residency,
          usage: usageBlock,
          measures: comparison.measures,
          data: { suppressedSegments: comparison.suppressedSegments },
        });
        return { httpStatus: 200, headers, envelope };
      }

      case 'queryJourneys': {
        const ref = makeRef('query', `journeys:${site.siteId}:${window.start}:${window.end}`);
        const rawEvents = this.repository.queryJourneyEvents({
          tenantId: principal.tenantId,
          siteId: site.siteId,
          windowStart: window.start,
          windowEnd: window.end,
        });
        const steps = Array.isArray(inv.params?.steps)
          ? (inv.params.steps as string[])
          : typeof inv.params?.steps === 'string' && inv.params.steps.length > 0
            ? inv.params.steps.split(',')
            : ['/', '/pricing', '/signup'];
        const windowSec = typeof inv.params?.windowSec === 'number' ? inv.params.windowSec : 1800;

        if (!rawEvents) {
          const envelope = buildResponseEnvelope({
            window,
            freshness: { data_through: nowIso, lag_s: 0, sources: {}, stale: false },
            coverage: { ratio: 0, denominator_n: 0 },
            lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
            residency,
            usage: usageBlock,
            measures: {
              journey_sessions: {
                value: null,
                unit: 'sessions',
                status: 'not_collected',
                reason: 'No journey event stream connected for this site',
                evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
                sample: null,
                interval: null,
                unmet_gates: [{ id: 'store.G-7', required: 1, observed: 0, unlock: 'Collect session-linked page views' }],
              },
            },
          });
          return { httpStatus: 200, headers, envelope };
        }

        const funnel = evaluateOrderedFunnel({
          siteConsentMode: site.consentMode,
          steps,
          events: rawEvents,
          windowSec,
          queryRef: ref,
        });
        const paths = evaluateNavigationPaths({
          siteConsentMode: site.consentMode,
          events: rawEvents,
        });

        const envelope = buildResponseEnvelope({
          window,
          freshness: { data_through: nowIso, lag_s: 0, sources: { journeys: nowIso }, stale: false },
          coverage: { ratio: funnel.consentBlocked ? 0 : 1, denominator_n: rawEvents.length },
          lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
          residency,
          usage: usageBlock,
          measures: funnel.measures,
          data: {
            consentBlocked: funnel.consentBlocked,
            funnelSteps: funnel.steps,
            pathEdges: paths.edges,
          },
        });
        return { httpStatus: 200, headers, envelope };
      }

      case 'getUsage': {
        const ref = makeRef('ledger', `usage:${site.siteId}`);
        const rows = this.repository.queryUsageRows({
          tenantId: principal.tenantId,
          siteId: site.siteId,
        });
        if (!rows) {
          const envelope = buildResponseEnvelope({
            window,
            freshness: { data_through: nowIso, lag_s: 0, sources: {}, stale: false },
            coverage: { ratio: 0, denominator_n: 0 },
            lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
            residency,
            usage: usageBlock,
            measures: {
              billable_pvs: {
                value: null,
                unit: 'page_views',
                status: 'not_collected',
                reason: 'Usage append-only ledger not yet connected',
                evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
                sample: null,
                interval: null,
                unmet_gates: [{ id: 'surf.trust_metering', required: 1, observed: 0, unlock: 'Connect append-only usage ledger' }],
              },
            },
          });
          return { httpStatus: 200, headers, envelope };
        }

        const summary = evaluateSiteUsage({
          tenantId: principal.tenantId,
          siteId: site.siteId,
          monthlyQuotaPvs: site.monthlyQuotaPvs,
          rows,
          now,
        });
        const envelope = buildResponseEnvelope({
          window,
          freshness: { data_through: nowIso, lag_s: 0, sources: { usage_ledger: nowIso }, stale: false },
          coverage: { ratio: 1, denominator_n: rows.length },
          lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
          residency,
          usage: usageBlock,
          measures: {
            billable_pvs: {
              value: createDataLayerMetric(summary.billablePvs, ref.ref_id, { authority: 'data_layer', createdAt: nowIso }),
              unit: 'page_views',
              status: 'ok',
              evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
              sample: { n: rows.length, unit_kind: 'ledger_row' },
              interval: null,
            },
            utilization_pct: {
              value: createDataLayerMetric(summary.utilizationPct, ref.ref_id, { authority: 'data_layer', createdAt: nowIso }),
              unit: 'percent',
              status: 'ok',
              evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
              sample: { n: rows.length, unit_kind: 'ledger_row' },
              interval: null,
            },
          },
          data: summary,
        });
        return { httpStatus: 200, headers, envelope };
      }

      case 'listNotifications': {
        const ref = makeRef('ledger', `notif:${site.siteId}`);
        const stored = this.notificationsBySite.get(`${principal.tenantId}:${site.siteId}`) ?? [];
        const usageRows = this.repository.queryUsageRows({ tenantId: principal.tenantId, siteId: site.siteId });
        const usageAlerts = usageRows
          ? evaluateSiteUsage({
              tenantId: principal.tenantId,
              siteId: site.siteId,
              monthlyQuotaPvs: site.monthlyQuotaPvs,
              rows: usageRows,
              now,
            }).alerts
          : [];
        const all = [...stored, ...usageAlerts];
        const envelope = buildResponseEnvelope({
          window,
          freshness: { data_through: nowIso, lag_s: 0, sources: { notifications: nowIso }, stale: false },
          coverage: { ratio: 1, denominator_n: all.length },
          lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
          residency,
          usage: usageBlock,
          measures: {
            active_notifications: {
              value: createDataLayerMetric(all.length, ref.ref_id, { authority: 'data_layer', createdAt: nowIso }),
              unit: 'notifications',
              status: 'ok',
              evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
              sample: { n: all.length, unit_kind: 'notification' },
              interval: null,
            },
          },
          data: { notifications: all },
        });
        return { httpStatus: 200, headers, envelope };
      }

      case 'getPrivacyDisclosure': {
        const requestId = typeof inv.params?.requestId === 'string' ? inv.params.requestId : undefined;
        const ref = makeRef('ledger', `privacy:${site.siteId}`);
        if (requestId) {
          const rec = this.gateway.getDestructionRequest(requestId);
          if (!rec || rec.tenantId !== principal.tenantId) {
            return { httpStatus: 404, headers, error: { code: 'NOT_FOUND', message: 'Deletion request not found' } };
          }
          const cert = buildDeletionCertificate({
            requestId: rec.requestId,
            tenantId: rec.tenantId,
            siteId: site.siteId,
            scope: rec.scope,
            state: rec.state,
            scheduledAt: rec.scheduledAt,
            now,
          });
          const envelope = buildResponseEnvelope({
            window,
            freshness: { data_through: nowIso, lag_s: 0, sources: { privacy: nowIso }, stale: false },
            coverage: { ratio: 1, denominator_n: 1 },
            lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
            residency,
            usage: usageBlock,
            measures: {
              sla_days_limit: {
                value: createDataLayerMetric(14, ref.ref_id, { authority: 'data_layer', createdAt: nowIso }),
                unit: 'days',
                status: 'ok',
                evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `deletion:${requestId}` },
                sample: { n: 1, unit_kind: 'request' },
                interval: null,
              },
            },
            data: { certificate: cert },
          });
          return { httpStatus: 200, headers, envelope };
        }

        const disclosure = buildSitePrivacyDisclosure({ siteName: site.siteName });
        const envelope = buildResponseEnvelope({
          window,
          freshness: { data_through: nowIso, lag_s: 0, sources: { contract_schema: nowIso }, stale: false },
          coverage: { ratio: 1, denominator_n: disclosure.transmittedItems.length },
          lineage: { schema_version: disclosure.schemaVersion, def_ver: 1, collection_gen: 'v3' },
          residency,
          usage: usageBlock,
          measures: {
            transmitted_item_count: {
              value: createDataLayerMetric(disclosure.transmittedItems.length, ref.ref_id, {
                authority: 'data_layer',
                createdAt: nowIso,
              }),
              unit: 'fields',
              status: 'ok',
              evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
              sample: { n: disclosure.transmittedItems.length, unit_kind: 'field' },
              interval: null,
            },
          },
          data: { disclosure },
        });
        return { httpStatus: 200, headers, envelope };
      }

      case 'createDeletionRequest': {
        const ref = makeRef('ledger', `delete:${site.siteId}:${authz.destructionRequest?.requestId ?? 'none'}`);
        const envelope = buildResponseEnvelope({
          window,
          freshness: { data_through: nowIso, lag_s: 0, sources: { privacy: nowIso }, stale: false },
          coverage: { ratio: 1, denominator_n: 1 },
          lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
          residency,
          usage: usageBlock,
          measures: {
            deletion_scheduled: {
              value: null,
              unit: 'requests',
              status: 'pending',
              reason: 'Two-phase 14-day deletion scheduled within undo window',
              evidence: { level: 'planned', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
              sample: null,
              interval: null,
              unmet_gates: [{ id: 'surf.deletion', required: 1, observed: 0, unlock: 'Complete daily mask (<=24h), purge (<=7d), and certify (<=14d)' }],
            },
          },
          data: { deletionRequest: authz.destructionRequest },
        });
        return { httpStatus: 202, headers, envelope };
      }

      case 'listGoals': {
        const list = this.goals.list(principal.tenantId, site.siteId);
        const ref = makeRef('ledger', `goals:${site.siteId}`);
        const envelope = buildResponseEnvelope({
          window,
          freshness: { data_through: nowIso, lag_s: 0, sources: { goals: nowIso }, stale: false },
          coverage: { ratio: 1, denominator_n: list.length },
          lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
          residency,
          usage: usageBlock,
          measures: {
            configured_goals: {
              value: createDataLayerMetric(list.length, ref.ref_id, { authority: 'data_layer', createdAt: nowIso }),
              unit: 'goals',
              status: 'ok',
              evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
              sample: { n: list.length, unit_kind: 'goal' },
              interval: null,
            },
          },
          data: { goals: list },
        });
        return { httpStatus: 200, headers, envelope };
      }

      case 'upsertGoal': {
        const body = inv.body ?? {};
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const kind = (body.kind as GoalKind | undefined) ?? 'url_match';
        const matcher = typeof body.matcher === 'string' ? body.matcher.trim() : '';
        if (!name || !matcher) {
          return { httpStatus: 400, headers, error: { code: 'INVALID_GOAL', message: 'name and matcher are required' } };
        }
        const goal: ConversionGoalDefinition = this.goals.upsert({
          tenantId: principal.tenantId,
          siteId: site.siteId,
          goalId: typeof body.goalId === 'string' ? body.goalId : undefined,
          name,
          kind,
          matcher,
          valueYen: typeof body.valueYen === 'number' ? body.valueYen : null,
          updatedByPrincipalId: principal.principalId,
          now,
        });
        const ref = makeRef('ledger', `goal:${goal.goalId}:v${goal.version}`);
        const envelope = buildResponseEnvelope({
          window,
          freshness: { data_through: nowIso, lag_s: 0, sources: { goals: nowIso }, stale: false },
          coverage: { ratio: 1, denominator_n: 1 },
          lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
          residency,
          usage: usageBlock,
          measures: {
            goal_version: {
              value: createDataLayerMetric(goal.version, ref.ref_id, { authority: 'data_layer', createdAt: nowIso }),
              unit: 'version',
              status: 'ok',
              evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `goal:${goal.goalId}` },
              sample: { n: 1, unit_kind: 'version' },
              interval: null,
            },
          },
          data: { goal },
        });
        return { httpStatus: 200, headers, envelope };
      }

      case 'deleteGoal': {
        const goalId =
          typeof inv.params?.goalId === 'string'
            ? inv.params.goalId
            : typeof inv.body?.goalId === 'string'
              ? inv.body.goalId
              : '';
        if (!goalId) {
          return { httpStatus: 400, headers, error: { code: 'MISSING_GOAL_ID', message: 'goalId is required' } };
        }
        const deleted = this.goals.softDelete(principal.tenantId, site.siteId, goalId, principal.principalId, now);
        if (!deleted) {
          return { httpStatus: 404, headers, error: { code: 'NOT_FOUND', message: 'Goal not found' } };
        }
        const ref = makeRef('ledger', `goal_del:${goalId}`);
        const envelope = buildResponseEnvelope({
          window,
          freshness: { data_through: nowIso, lag_s: 0, sources: { goals: nowIso }, stale: false },
          coverage: { ratio: 1, denominator_n: 1 },
          lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
          residency,
          usage: usageBlock,
          measures: {
            goals_deleted: {
              value: createDataLayerMetric(1, ref.ref_id, { authority: 'data_layer', createdAt: nowIso }),
              unit: 'goals',
              status: 'ok',
              evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `goal:${goalId}` },
              sample: { n: 1, unit_kind: 'goal' },
              interval: null,
            },
          },
          data: { deletedGoalId: goalId },
        });
        return { httpStatus: 200, headers, envelope };
      }

      case 'askNaturalLanguage': {
        if (!this.askHandler) {
          const ref = makeRef('query', `ask_unwired:${site.siteId}`);
          const envelope = buildResponseEnvelope({
            window,
            freshness: { data_through: nowIso, lag_s: 0, sources: {}, stale: false },
            coverage: { ratio: 0, denominator_n: 0 },
            lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
            residency,
            usage: usageBlock,
            measures: {
              ask_result: {
                value: null,
                unit: 'answers',
                status: 'not_entitled',
                reason: 'Ask planner service not attached',
                evidence: { level: 'planned', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
                sample: null,
                interval: null,
                unmet_gates: [{ id: 'surf.ask_accuracy', required: 1000, observed: 0, unlock: 'Attach self-hosted AskService and pass 1,000-question eval' }],
              },
            },
          });
          return { httpStatus: 200, headers, envelope };
        }
        const res = this.askHandler({
          principal,
          site,
          body: inv.body ?? {},
          now,
        });
        return {
          ...res,
          headers: { ...headers, ...res.headers },
        };
      }

      case 'publishDecision':
      case 'applyOriginPatch':
      case 'manageLinkGrant': {
        const ref = makeRef('ledger', `${op.operationId}:${site.siteId}`);
        const envelope = buildResponseEnvelope({
          window,
          freshness: { data_through: nowIso, lag_s: 0, sources: { control_plane: nowIso }, stale: false },
          coverage: { ratio: 1, denominator_n: 1 },
          lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
          residency,
          usage: usageBlock,
          measures: {
            operation_authorized: {
              value: createDataLayerMetric(1, ref.ref_id, { authority: 'data_layer', createdAt: nowIso }),
              unit: 'operations',
              status: 'ok',
              evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${site.siteId}` },
              sample: { n: 1, unit_kind: 'operation' },
              interval: null,
            },
          },
          data: { operationId: op.operationId, siteId: site.siteId, auditEntryId: authz.auditEntryId },
        });
        return { httpStatus: 200, headers, envelope };
      }

      default:
        return {
          httpStatus: 404,
          headers,
          error: { code: 'OPERATION_NOT_IMPLEMENTED', message: `Operation ${op.operationId} not handled` },
        };
    }
  }
}
