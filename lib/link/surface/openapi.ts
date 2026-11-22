/**
 * UGOKI LINK v2 — Single Authoritative OpenAPI 3.1 Contract & Version/Rate Specification
 *
 * Implements Master Architecture v2 §11.5–§11.10 & `surface-final.md` §5.3–§5.5:
 *   - Single source of truth for REST `/v1/*`, MCP tool generation, and 8-language Server SDK generation
 *   - Date-based API revisions with per-key pinning and >= 180-day `Sunset` deprecation notices
 *   - Cost-unit rate weights per operation (cached/sealed reads ~0–1, heavy queries 4–8)
 *   - Every operation description audited against `UNKNOWABLES_LEDGER` (`tel.M9`)
 */

import { auditCatalogDescriptions, type UnknowableAuditResult } from '@/packages/contract/ledgers';
import { canonicalJson, sha256Hex } from '@/packages/contract/response';
import type { RiskClass, Scope } from '@/lib/link/auth';

export const API_MAJOR_VERSION = 'v1';
export const CURRENT_API_REVISION = '2026-11-20';
export const SUPPORTED_API_REVISIONS: ReadonlyArray<string> = ['2026-11-20'];

/** Minimum notice period before deprecating/retiring a revision: 180 days (§11.9). */
export const DEPRECATION_SUNSET_MIN_DAYS = 180;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface OperationParamSpec {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly required: boolean;
  readonly type: 'string' | 'integer' | 'boolean';
  readonly description: string;
}

export interface OperationSpec {
  readonly operationId: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary: string;
  readonly description: string;
  readonly tag:
    | 'meta'
    | 'capabilities'
    | 'analytics'
    | 'segments'
    | 'journeys'
    | 'usage'
    | 'privacy'
    | 'goals'
    | 'ask'
    | 'decisions'
    | 'federation';
  readonly riskClass: RiskClass;
  readonly requiredScope?: Scope;
  /** Cost units charged to the tenant/key rate bucket (0 for cached/static meta). */
  readonly costUnits: number;
  /** Whether this operation is exposed in the MCP server catalogue. */
  readonly exposeInMcp: boolean;
  /** Whether MCP clients should show this tool eagerly (subject to client limit). */
  readonly mcpEagerPriority: number;
  /** Unknowables limit IDs acknowledged by this operation (`tel.M9`). */
  readonly declaredLimitIds: ReadonlyArray<string>;
  readonly params: ReadonlyArray<OperationParamSpec>;
  readonly requestBodySchema?: Readonly<Record<string, unknown>>;
}

export const OPERATION_CATALOG: ReadonlyArray<OperationSpec> = [
  {
    operationId: 'getOpenApiSpec',
    method: 'GET',
    path: '/v1/openapi',
    summary: 'Get canonical UGOKI LINK v1 OpenAPI 3.1 specification',
    description:
      'Returns the single OpenAPI 3.1 contract shared by REST, MCP tool generation, and the 8-language server SDK generator.',
    tag: 'meta',
    riskClass: 'R0',
    costUnits: 0,
    exposeInMcp: false,
    mcpEagerPriority: 99,
    declaredLimitIds: [],
    params: [],
  },
  {
    operationId: 'listMcpTools',
    method: 'GET',
    path: '/v1/mcp',
    summary: 'List visible MCP tools for the authenticated caller session',
    description:
      'Authenticates the Bearer credential and returns visible MCP tool definitions derived from the single OpenAPI contract for the caller tenant and principal session.',
    tag: 'meta',
    riskClass: 'R0',
    requiredScope: 'analytics:read',
    costUnits: 1,
    exposeInMcp: false,
    mcpEagerPriority: 99,
    declaredLimitIds: [],
    params: [
      { name: 'clientFamily', in: 'query', required: false, type: 'string', description: 'MCP client family' },
      { name: 'sessionId', in: 'query', required: false, type: 'string', description: 'Client session identifier' },
    ],
  },
  {
    operationId: 'invokeMcpRpc',
    method: 'POST',
    path: '/v1/mcp',
    summary: 'Execute an authenticated MCP JSON-RPC method (tools/list, tools/search, tools/enable, tools/call)',
    description:
      'Authenticates the Bearer credential on every MCP method, scopes enabled tool state by tenant and principal, and routes tool execution through the unified SurfacePipeline.',
    tag: 'meta',
    riskClass: 'R0',
    requiredScope: 'analytics:read',
    costUnits: 1,
    exposeInMcp: false,
    mcpEagerPriority: 99,
    declaredLimitIds: [],
    params: [],
    requestBodySchema: {
      type: 'object',
      required: ['method'],
      properties: {
        method: { type: 'string', enum: ['tools/list', 'tools/search', 'tools/enable', 'tools/call'] },
        clientFamily: { type: 'string' },
        sessionId: { type: 'string' },
        query: { type: 'string' },
        toolName: { type: 'string' },
        arguments: { type: 'object' },
      },
    },
  },
  {
    operationId: 'getSiteCapabilities',
    method: 'GET',
    path: '/v1/sites/{siteId}/capabilities',
    summary: 'List site capabilities, gate states, and unlock conditions',
    description:
      'Returns availability status (available | not_entitled | not_collected | gated) and concrete unlock conditions for every operation and metric based on consent mode, plan, gate ledger, and owner decisions.',
    tag: 'capabilities',
    riskClass: 'R0',
    requiredScope: 'analytics:read',
    costUnits: 1,
    exposeInMcp: true,
    mcpEagerPriority: 1,
    declaredLimitIds: [],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
    ],
  },
  {
    operationId: 'querySiteMetrics',
    method: 'GET',
    path: '/v1/sites/{siteId}/metrics',
    summary: 'Query sealed and live site telemetry metrics with per-measure evidence',
    description:
      'Reads observed site metrics (page views, section focal dwell time as proxy bounded by tel.U1, conversion counts, loss ledger bounds for script-blocked visits per tel.U2) with per-measure evidence levels and unmet gates.',
    tag: 'analytics',
    riskClass: 'R0',
    requiredScope: 'analytics:read',
    costUnits: 2,
    exposeInMcp: true,
    mcpEagerPriority: 2,
    declaredLimitIds: ['tel.U1', 'tel.U2', 'tel.U3'],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
      { name: 'start', in: 'query', required: false, type: 'string', description: 'Window start ISO-8601' },
      { name: 'end', in: 'query', required: false, type: 'string', description: 'Window end ISO-8601' },
      { name: 'segmentId', in: 'query', required: false, type: 'string', description: 'Optional registered segment ID' },
    ],
  },
  {
    operationId: 'querySiteFusedInsights',
    method: 'GET',
    path: '/v1/sites/{siteId}/insights',
    summary: 'Query structure-joined page and section insights',
    description:
      'Joins observed behaviour metrics with committed CRAWL structure snapshots under active link grant gates. Before/after changes are capped at observed evidence (never causal without randomised experiment per ev.U1).',
    tag: 'analytics',
    riskClass: 'R0',
    requiredScope: 'fusion:read',
    costUnits: 4,
    exposeInMcp: true,
    mcpEagerPriority: 3,
    declaredLimitIds: ['ev.U1', 'tel.U7'],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
      { name: 'pageId', in: 'query', required: false, type: 'string', description: 'Canonical page_id filter' },
    ],
  },
  {
    operationId: 'listSegments',
    method: 'GET',
    path: '/v1/sites/{siteId}/segments',
    summary: 'List registered immutable segment definitions',
    description:
      'Returns all registered rule-based and future ML (centroid_ml / density_ml) segment definitions and their immutable versions for the site.',
    tag: 'segments',
    riskClass: 'R0',
    requiredScope: 'analytics:read',
    costUnits: 1,
    exposeInMcp: true,
    mcpEagerPriority: 4,
    declaredLimitIds: [],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
    ],
  },
  {
    operationId: 'createSegment',
    method: 'POST',
    path: '/v1/sites/{siteId}/segments',
    summary: 'Create or version a registered segment definition',
    description:
      'Creates an immutable versioned segment definition (rule, centroid_ml, or density_ml). Unknown attributes are preserved as unknown and never auto-promoted.',
    tag: 'segments',
    riskClass: 'R1',
    requiredScope: 'decisions:write',
    costUnits: 2,
    exposeInMcp: true,
    mcpEagerPriority: 10,
    declaredLimitIds: [],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
    ],
    requestBodySchema: {
      type: 'object',
      required: ['name', 'kind'],
      properties: {
        name: { type: 'string' },
        kind: { type: 'string', enum: ['rule', 'centroid_ml', 'density_ml'] },
        rule: { type: 'object' },
      },
    },
  },
  {
    operationId: 'compareSegments',
    method: 'POST',
    path: '/v1/sites/{siteId}/segments/compare',
    summary: 'Compare observed metrics across registered segments',
    description:
      'Compares site metrics across two or more registered segments with per-measure evidence levels and automatic k < 10 suppression. Segment differences are observational (observed) and not causal claims (ev.U1).',
    tag: 'segments',
    riskClass: 'R0',
    requiredScope: 'analytics:read',
    costUnits: 5,
    exposeInMcp: true,
    mcpEagerPriority: 5,
    declaredLimitIds: ['ev.U1'],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
    ],
    requestBodySchema: {
      type: 'object',
      required: ['segmentIds'],
      properties: {
        segmentIds: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    operationId: 'queryJourneys',
    method: 'GET',
    path: '/v1/sites/{siteId}/journeys',
    summary: 'Query navigation paths and ordered conversion funnels',
    description:
      'Computes ordered step funnels and page-to-page transition paths within a time window with k < 10 suppression. Under cookieless consent mode, cross-tab/cross-page session funnels report not_collected per tel.U13.',
    tag: 'journeys',
    riskClass: 'R0',
    requiredScope: 'analytics:read',
    costUnits: 5,
    exposeInMcp: true,
    mcpEagerPriority: 6,
    declaredLimitIds: ['tel.U13', 'tel.U6'],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
      { name: 'mode', in: 'query', required: false, type: 'string', description: 'path | funnel' },
    ],
  },
  {
    operationId: 'getUsage',
    method: 'GET',
    path: '/v1/sites/{siteId}/usage',
    summary: 'Get billable PV usage, quota alerts (80/100/120%), and degradation state',
    description:
      'Returns billable usage counted exclusively from saved, non-quarantined PVs at continuity trust or above, threshold notifications (80/100/120%), and count_only over-quota state distinct from minimal comparison arm.',
    tag: 'usage',
    riskClass: 'R0',
    requiredScope: 'usage:read',
    costUnits: 1,
    exposeInMcp: true,
    mcpEagerPriority: 7,
    declaredLimitIds: ['tel.U8'],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
    ],
  },
  {
    operationId: 'listNotifications',
    method: 'GET',
    path: '/v1/sites/{siteId}/notifications',
    summary: 'List usage threshold, privacy SLA, and watchdog notifications',
    description:
      'Lists structured site notifications including 80/100/120% quota alerts, day-10 deletion SLA warnings, and isolation hold incidents.',
    tag: 'usage',
    riskClass: 'R0',
    requiredScope: 'usage:read',
    costUnits: 1,
    exposeInMcp: true,
    mcpEagerPriority: 14,
    declaredLimitIds: [],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
    ],
  },
  {
    operationId: 'getPrivacyDisclosure',
    method: 'GET',
    path: '/v1/sites/{siteId}/privacy',
    summary: 'Generate external-transmission privacy disclosure record (JSON/HTML/Markdown)',
    description:
      'Returns the schema-generated Japanese external-transmission disclosure record (transmitted fields, recipient, purpose, retention, opt-out URL, and SHA-256 digest).',
    tag: 'privacy',
    riskClass: 'R0',
    requiredScope: 'analytics:read',
    costUnits: 1,
    exposeInMcp: true,
    mcpEagerPriority: 11,
    declaredLimitIds: [],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
    ],
  },
  {
    operationId: 'createDeletionRequest',
    method: 'POST',
    path: '/v1/sites/{siteId}/privacy',
    summary: 'Schedule a two-phase 14-day privacy deletion request (R4)',
    description:
      'Schedules a subject, site, or tenant deletion with undo token and 14-day certification SLA across behaviour tables, WAL, rollups, ML snapshots, and exports.',
    tag: 'privacy',
    riskClass: 'R4',
    requiredScope: 'privacy:delete',
    costUnits: 3,
    exposeInMcp: true,
    mcpEagerPriority: 12,
    declaredLimitIds: [],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
    ],
    requestBodySchema: {
      type: 'object',
      required: ['scope', 'reason'],
      properties: {
        scope: { type: 'string', enum: ['subject', 'site', 'tenant'] },
        subjectIds: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' },
      },
    },
  },
  {
    operationId: 'listGoals',
    method: 'GET',
    path: '/v1/sites/{siteId}/goals',
    summary: 'List registered conversion goal definitions',
    description:
      'Lists conversion goal definitions configured for the site (including site rules and optional GA4 synced definitions labelled observed per tel.U12).',
    tag: 'goals',
    riskClass: 'R0',
    requiredScope: 'decisions:read',
    costUnits: 1,
    exposeInMcp: true,
    mcpEagerPriority: 8,
    declaredLimitIds: ['tel.U12'],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
    ],
  },
  {
    operationId: 'upsertGoal',
    method: 'POST',
    path: '/v1/sites/{siteId}/goals',
    summary: 'Create or update a conversion goal definition (REST & MCP, R1)',
    description:
      'Creates or updates a site-local conversion goal definition (R1 self-contained write requiring Idempotency-Key). Exposed equally over REST and MCP per §11.10.',
    tag: 'goals',
    riskClass: 'R1',
    requiredScope: 'decisions:write',
    costUnits: 2,
    exposeInMcp: true,
    mcpEagerPriority: 9,
    declaredLimitIds: ['tel.U12'],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
    ],
    requestBodySchema: {
      type: 'object',
      required: ['name', 'kind', 'matcher'],
      properties: {
        goalId: { type: 'string' },
        name: { type: 'string' },
        kind: { type: 'string', enum: ['url_match', 'element_click', 'custom_event', 'ga4_sync'] },
        matcher: { type: 'string' },
        valueYen: { type: 'number' },
      },
    },
  },
  {
    operationId: 'deleteGoal',
    method: 'DELETE',
    path: '/v1/sites/{siteId}/goals',
    summary: 'Delete a conversion goal definition (R1)',
    description:
      'Soft-deletes a conversion goal definition for the site (R1 self-contained write requiring Idempotency-Key).',
    tag: 'goals',
    riskClass: 'R1',
    requiredScope: 'decisions:write',
    costUnits: 2,
    exposeInMcp: true,
    mcpEagerPriority: 15,
    declaredLimitIds: [],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
      { name: 'goalId', in: 'query', required: true, type: 'string', description: 'Goal identifier' },
    ],
  },
  {
    operationId: 'askNaturalLanguage',
    method: 'POST',
    path: '/v1/ask',
    summary: 'Ask a read-only natural-language analytics question (§11.11.11)',
    description:
      'Executes a strictly read-only natural-language query over public aggregate views using a self-hosted planner (never sent to external models or Jev). All numeric outputs reference VerifiedMetricValue results; interpretations are marked hypothesis; unknowable or forbidden queries return explicit status.',
    tag: 'ask',
    riskClass: 'R0',
    requiredScope: 'analytics:read',
    costUnits: 6,
    exposeInMcp: true,
    mcpEagerPriority: 3,
    declaredLimitIds: ['tel.U1', 'tel.U4', 'ev.U1'],
    params: [],
    requestBodySchema: {
      type: 'object',
      required: ['siteId', 'question'],
      properties: {
        siteId: { type: 'string' },
        question: { type: 'string' },
        windowStart: { type: 'string' },
        windowEnd: { type: 'string' },
      },
    },
  },
  {
    operationId: 'publishDecision',
    method: 'POST',
    path: '/v1/sites/{siteId}/decisions/publish',
    summary: 'Publish a visitor-facing delivery decision (R2 — individual MCP tool)',
    description:
      'Publishes a variant or intervention under R2 controls (requires human passkey approval or active autonomy envelope with exposure budget, verified field provenance, and registered destination links).',
    tag: 'decisions',
    riskClass: 'R2',
    requiredScope: 'decisions:publish',
    costUnits: 5,
    exposeInMcp: true,
    mcpEagerPriority: 20,
    declaredLimitIds: [],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
    ],
    requestBodySchema: {
      type: 'object',
      required: ['decisionId'],
      properties: {
        decisionId: { type: 'string' },
        passkeyApprovalId: { type: 'string' },
        autonomyEnvelopeId: { type: 'string' },
      },
    },
  },
  {
    operationId: 'applyOriginPatch',
    method: 'POST',
    path: '/v1/sites/{siteId}/origin/apply',
    summary: 'Apply an origin CMS patch (R2 — individual MCP tool)',
    description:
      'Applies an approved origin patch via the vaulted CMS adapter under R2 controls. Head, structured data, robots, and llms.txt changes remain not_entitled behind owner_decision_S12_211.',
    tag: 'decisions',
    riskClass: 'R2',
    requiredScope: 'origin:apply',
    costUnits: 8,
    exposeInMcp: true,
    mcpEagerPriority: 21,
    declaredLimitIds: [],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
    ],
  },
  {
    operationId: 'manageLinkGrant',
    method: 'POST',
    path: '/v1/sites/{siteId}/grants',
    summary: 'Create or activate a CRAWL Link Grant (R5 — interactive passkey only)',
    description:
      'Delegates a cross-product CRAWL Link Grant (R5). Rejects bearer/API/MCP credentials and returns pending with console approval URL.',
    tag: 'federation',
    riskClass: 'R5',
    requiredScope: 'connections:manage',
    costUnits: 3,
    exposeInMcp: true,
    mcpEagerPriority: 22,
    declaredLimitIds: [],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
    ],
  },
  {
    operationId: 'evaluateDecision',
    method: 'POST',
    path: '/v1/decisions',
    summary: 'Evaluate a server-side actor-blind delivery decision context',
    description:
      'Evaluates a 1-PV actor-blind allocation, single-context display lease, and voucher token against the strongly-consistent control store.',
    tag: 'decisions',
    riskClass: 'R0',
    requiredScope: 'decisions:read',
    costUnits: 1,
    exposeInMcp: true,
    mcpEagerPriority: 13,
    declaredLimitIds: [],
    params: [],
    requestBodySchema: {
      type: 'object',
      required: ['siteId'],
      properties: {
        siteId: { type: 'string' },
        pvId: { type: 'string' },
        visitorId: { type: 'string' },
        sessionId: { type: 'string' },
        consentMode: { type: 'string' },
        urlId: { type: 'string' },
        pageId: { type: 'string' },
      },
    },
  },
  {
    operationId: 'recommendItems',
    method: 'POST',
    path: '/v1/recommend',
    summary: 'Serve EC or content recommendations for a site placement',
    description:
      'Executes full-set Plackett-Luce recommendation ranking with pre-draw exclusions, signed member proof enforcement, and confidential field stripping.',
    tag: 'decisions',
    riskClass: 'R0',
    requiredScope: 'decisions:read',
    costUnits: 1,
    exposeInMcp: true,
    mcpEagerPriority: 16,
    declaredLimitIds: [],
    params: [],
    requestBodySchema: {
      type: 'object',
      required: ['site_id', 'placement'],
      properties: {
        site_id: { type: 'string' },
        placement: { type: 'string', enum: ['product_page', 'cart', 'home', 'post_purchase', 'article'] },
        top_k: { type: 'integer' },
        seed_key: { type: 'string' },
        temperature: { type: 'number' },
        cart_product_ids: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    operationId: 'recommendSiteItems',
    method: 'POST',
    path: '/v1/sites/{siteId}/recommend',
    summary: 'Serve EC or content recommendations scoped to a path siteId',
    description:
      'Executes full-set Plackett-Luce recommendation ranking for the target site with server-resolved catalog, margin, stock, and consent rules.',
    tag: 'decisions',
    riskClass: 'R0',
    requiredScope: 'decisions:read',
    costUnits: 1,
    exposeInMcp: true,
    mcpEagerPriority: 17,
    declaredLimitIds: [],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
    ],
    requestBodySchema: {
      type: 'object',
      required: ['placement'],
      properties: {
        placement: { type: 'string', enum: ['product_page', 'cart', 'home', 'post_purchase', 'article'] },
        top_k: { type: 'integer' },
        seed_key: { type: 'string' },
        temperature: { type: 'number' },
        cart_product_ids: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    operationId: 'getHeatmapArtifact',
    method: 'GET',
    path: '/v1/sites/{siteId}/heatmap-image',
    summary: 'Fetch a rendered heatmap artifact with per-request re-authentication',
    description:
      'Re-authenticates the caller and re-validates revocation and deletion epochs before returning a rendered page-version heatmap artifact (observed proxy bounded by tel.U1 and tel.U2).',
    tag: 'analytics',
    riskClass: 'R0',
    requiredScope: 'analytics:read',
    costUnits: 1,
    exposeInMcp: true,
    mcpEagerPriority: 18,
    declaredLimitIds: ['tel.U1', 'tel.U2'],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
      { name: 'artifact_id', in: 'query', required: true, type: 'string', description: 'Rendered heatmap artifact identifier' },
    ],
  },
  {
    operationId: 'renderHeatmapImage',
    method: 'POST',
    path: '/v1/sites/{siteId}/heatmap-image',
    summary: 'Render page-version and variant-split heatmap artifacts from server telemetry',
    description:
      'Renders observed page-version heatmap PNG artifacts and source aggregates from server-loaded datasets (focal dwell proxy bounded by tel.U1, script-blocked visits per tel.U2, non-causal observational slices per ev.U1).',
    tag: 'analytics',
    riskClass: 'R0',
    requiredScope: 'analytics:read',
    costUnits: 4,
    exposeInMcp: true,
    mcpEagerPriority: 19,
    declaredLimitIds: ['tel.U1', 'tel.U2', 'ev.U1'],
    params: [
      { name: 'siteId', in: 'path', required: true, type: 'string', description: 'Site identifier' },
    ],
    requestBodySchema: {
      type: 'object',
      required: ['page_url', 'kind', 'actor_bucket'],
      properties: {
        page_url: { type: 'string' },
        kind: { type: 'string' },
        actor_bucket: { type: 'string' },
        period_start: { type: 'string' },
        period_end: { type: 'string' },
        device_class: { type: 'string' },
        segment_id: { type: 'string' },
      },
    },
  },
];

const OPERATION_BY_ID = new Map<string, OperationSpec>(
  OPERATION_CATALOG.map((op) => [op.operationId, op])
);

export function getOperationSpec(operationId: string): OperationSpec | undefined {
  return OPERATION_BY_ID.get(operationId);
}

/**
 * Computes version pinning & RFC 8594 `Sunset` headers (§11.9).
 * Any deprecated revision MUST announce a `Sunset` date at least 180 days from `now`.
 */
export function buildApiVersionHeaders(params: {
  readonly requestedRevision?: string | null;
  readonly pinnedKeyRevision?: string | null;
  readonly deprecatedSunsetIso?: string | null;
  readonly now?: Date;
}): Readonly<Record<string, string>> {
  const now = params.now ?? new Date();
  const effectiveRevision =
    params.requestedRevision && SUPPORTED_API_REVISIONS.includes(params.requestedRevision)
      ? params.requestedRevision
      : params.pinnedKeyRevision && SUPPORTED_API_REVISIONS.includes(params.pinnedKeyRevision)
        ? params.pinnedKeyRevision
        : CURRENT_API_REVISION;

  const headers: Record<string, string> = {
    'X-UGOKI-API-Version': API_MAJOR_VERSION,
    'X-UGOKI-Revision': effectiveRevision,
  };

  if (params.deprecatedSunsetIso) {
    const requestedSunsetMs = new Date(params.deprecatedSunsetIso).getTime();
    const minSunsetMs = now.getTime() + DEPRECATION_SUNSET_MIN_DAYS * 24 * 60 * 60 * 1000;
    const enforcedSunset = new Date(Math.max(requestedSunsetMs, minSunsetMs));
    headers['Deprecation'] = 'true';
    headers['Sunset'] = enforcedSunset.toUTCString();
  }

  return headers;
}

/**
 * Audits all registered OpenAPI / MCP operation descriptions against `UNKNOWABLES_LEDGER` (`tel.M9`).
 */
export function auditOpenApiCatalogAgainstUnknowables(): {
  readonly passed: boolean;
  readonly totalChecked: number;
  readonly failedCount: number;
  readonly results: ReadonlyArray<UnknowableAuditResult>;
} {
  return auditCatalogDescriptions(
    OPERATION_CATALOG.map((op) => ({
      operationId: op.operationId,
      description: `${op.summary}. ${op.description}`,
      declaredLimitIds: op.declaredLimitIds,
    }))
  );
}

export interface OpenApi31Document {
  readonly openapi: '3.1.0';
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly 'x-ugoki-revision': string;
    readonly 'x-ugoki-sunset-min-days': number;
  };
  readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly components: {
    readonly securitySchemes: Readonly<Record<string, unknown>>;
  };
  readonly 'x-ugoki-contract-sha256': string;
}

/**
 * Deterministically builds the single OpenAPI 3.1.0 document consumed by REST docs,
 * MCP tool generation, and the 8-language server SDK generator.
 */
export function buildOpenApi31Document(): OpenApi31Document {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const op of OPERATION_CATALOG) {
    if (!paths[op.path]) {
      paths[op.path] = {};
    }
    const methodKey = op.method.toLowerCase();
    paths[op.path][methodKey] = {
      operationId: op.operationId,
      tags: [op.tag],
      summary: op.summary,
      description: op.description,
      'x-ugoki-risk-class': op.riskClass,
      'x-ugoki-scope': op.requiredScope ?? null,
      'x-ugoki-cost-units': op.costUnits,
      'x-ugoki-expose-in-mcp': op.exposeInMcp,
      'x-ugoki-limits': op.declaredLimitIds,
      parameters: op.params.map((p) => ({
        name: p.name,
        in: p.in,
        required: p.required,
        description: p.description,
        schema: { type: p.type },
      })),
      ...(op.requestBodySchema
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: op.requestBodySchema,
                },
              },
            },
          }
        : {}),
      responses: {
        '200': { description: 'Unified UGOKI LINK v2 Response Envelope (I1–I7)' },
        '202': { description: 'Pending human passkey approval or scheduled two-phase destruction' },
        '403': { description: 'Own-tenant insufficient scope or interactive passkey required' },
        '404': { description: 'Resource not found (always returned for foreign-tenant IDs + audit row)' },
        '429': { description: 'Cost-unit rate limit exceeded' },
        '503': { description: 'Table under isolation_hold due to watchdog incident F-01' },
      },
    };
  }

  const core = {
    openapi: '3.1.0' as const,
    info: {
      title: 'UGOKI LINK v2 Surface API',
      version: `1.0.0-${CURRENT_API_REVISION}`,
      'x-ugoki-revision': CURRENT_API_REVISION,
      'x-ugoki-sunset-min-days': DEPRECATION_SUNSET_MIN_DAYS,
    },
    paths,
    components: {
      securitySchemes: {
        ugkSecretKey: { type: 'http', scheme: 'bearer', bearerFormat: 'ugk_sec_*' },
        mcpOAuth21: { type: 'oauth2', description: 'MCP OAuth 2.1 with PKCE S256 (1h TTL, epoch revocation)' },
        consoleSessionCookie: { type: 'apiKey', in: 'cookie', name: 'ugk_session' },
      },
    },
  };

  return {
    ...core,
    'x-ugoki-contract-sha256': sha256Hex(canonicalJson(core)),
  };
}
