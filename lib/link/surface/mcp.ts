/**
 * UGOKI LINK v2 — MCP Server Generated Directly from Single OpenAPI Contract (§11.7)
 *
 * Implements Master Architecture v2 §11.7, §11.10 & `surface-final.md` §5.4:
 *   - Generates EVERY MCP tool directly from `OPERATION_CATALOG` (zero cap on total tools)
 *   - Client-family eager display limits + `tools/search` & `tools/enable` progressive discovery
 *   - High-risk tools (R2, R3, R4, R5) are ALWAYS exposed as distinct individual tools
 *   - Includes conversion goal management (`upsertGoal`, `listGoals`, `deleteGoal`, R1)
 *   - Enforces item content provenance (`approved_asset` / `own_page_quote` / `checked_generated` / `free_text` -> mandatory human approval)
 *     and registered link destination table validation
 *   - Routes every MCP invocation through the exact same `SurfacePipeline` as REST
 */

import type { FieldProvenance, RiskClass } from '@/lib/link/auth';
import { OPERATION_CATALOG, type OperationSpec } from './openapi';
import type { SurfaceExecutionResult, SurfaceInvocation, SurfacePipeline } from './pipeline';

// =========================================================================
// 1. Client Display Limits & Residual Risk Disclosure (§11.7)
// =========================================================================

export type McpClientFamily = 'claude_desktop' | 'cursor' | 'chatgpt' | 'generic_mcp';

/**
 * Initial per-client eager tool display caps (to be tuned by `surf.mcp_eager_set` evals).
 * Deferred tools remain discoverable via `searchTools()` and `enableTool()`.
 */
export const MCP_CLIENT_EAGER_LIMITS: Readonly<Record<McpClientFamily, number>> = {
  claude_desktop: 14,
  cursor: 12,
  chatgpt: 10,
  generic_mcp: 8,
};

export const MCP_AUTONOMY_RESIDUAL_RISK_NOTICE =
  'Residual risk (§11.7): A steered agent can choose which pre-approved asset to show on which in-envelope page; maximum impact is strictly bounded by the envelope exposure budget and conversions-at-risk cap. Free-text fields and unregistered link destinations always require human passkey approval.';

export interface McpToolDefinition {
  readonly name: string;
  readonly operationId: string;
  readonly description: string;
  readonly riskClass: RiskClass;
  readonly individualHighRiskTool: boolean;
  readonly requiredScope: string | null;
  readonly costUnits: number;
  readonly eagerPriority: number;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly residualRiskNotice?: string;
}

const HIGH_RISK_SET: ReadonlySet<RiskClass> = new Set(['R2', 'R3', 'R4', 'R5']);

export function isHighRiskClass(riskClass: RiskClass): boolean {
  return HIGH_RISK_SET.has(riskClass);
}

/**
 * Converts the single OpenAPI `OPERATION_CATALOG` into the complete MCP tool catalogue.
 * Never imposes a hard cap on total tool count (§11.7).
 */
export function generateMcpToolsFromOpenApi(
  catalog: ReadonlyArray<OperationSpec> = OPERATION_CATALOG
): ReadonlyArray<McpToolDefinition> {
  return catalog
    .filter((op) => op.exposeInMcp)
    .map((op) => {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const p of op.params) {
        properties[p.name] = { type: p.type, description: p.description };
        if (p.required) required.push(p.name);
      }

      if (op.requestBodySchema && typeof op.requestBodySchema.properties === 'object') {
        Object.assign(properties, op.requestBodySchema.properties as Record<string, unknown>);
        if (Array.isArray(op.requestBodySchema.required)) {
          for (const r of op.requestBodySchema.required) {
            if (typeof r === 'string' && !required.includes(r)) {
              required.push(r);
            }
          }
        }
      }

      if (op.riskClass === 'R1') {
        properties.idempotencyKey = {
          type: 'string',
          description: 'Required Idempotency-Key (>= 8 chars) for R1 write safety',
        };
        if (!required.includes('idempotencyKey')) required.push('idempotencyKey');
      }

      const highRisk = isHighRiskClass(op.riskClass);

      return {
        name: `ugokilink_${op.operationId}`,
        operationId: op.operationId,
        description: `[${op.riskClass}] ${op.summary}. ${op.description}`,
        riskClass: op.riskClass,
        individualHighRiskTool: highRisk,
        requiredScope: op.requiredScope ?? null,
        costUnits: op.costUnits,
        eagerPriority: op.mcpEagerPriority,
        inputSchema: {
          type: 'object',
          properties,
          required,
          additionalProperties: false,
        },
        ...(highRisk ? { residualRiskNotice: MCP_AUTONOMY_RESIDUAL_RISK_NOTICE } : {}),
      };
    });
}

// =========================================================================
// 2. Content Item Provenance & Link Destination Table Guard (§11.7)
// =========================================================================

export type McpItemProvenance =
  | 'approved_asset'
  | 'own_page_quote'
  | 'checked_generated'
  | 'free_text';

export interface McpContentSubmissionItem {
  readonly fieldName: string;
  readonly provenance: McpItemProvenance;
  readonly assetOrSectionRef?: string;
  readonly destinationUrl?: string;
}

export interface ProvenanceCheckResult {
  readonly ok: boolean;
  readonly requiresHumanApproval: boolean;
  readonly mappedFieldProvenance: ReadonlyArray<FieldProvenance>;
  readonly violations: ReadonlyArray<string>;
}

export function validateMcpContentProvenance(params: {
  readonly items: ReadonlyArray<McpContentSubmissionItem>;
  readonly registeredDestinationUrls: ReadonlyArray<string>;
}): ProvenanceCheckResult {
  const registered = new Set(params.registeredDestinationUrls.map((u) => u.trim()));
  const mapped: FieldProvenance[] = [];
  const violations: string[] = [];
  let requiresHumanApproval = false;

  for (const item of params.items) {
    switch (item.provenance) {
      case 'approved_asset':
        if (!item.assetOrSectionRef) {
          violations.push(`Field "${item.fieldName}" claims approved_asset without assetOrSectionRef`);
        }
        mapped.push('copy_library');
        break;
      case 'own_page_quote':
        if (!item.assetOrSectionRef) {
          violations.push(`Field "${item.fieldName}" claims own_page_quote without server section ref`);
        }
        mapped.push('copy_library');
        break;
      case 'checked_generated':
        mapped.push('generated_checked');
        break;
      case 'free_text':
        // Free-text ALWAYS routes to mandatory human passkey approval (`'open'` provenance)
        requiresHumanApproval = true;
        mapped.push('open');
        break;
    }

    if (item.destinationUrl !== undefined) {
      if (!registered.has(item.destinationUrl.trim())) {
        violations.push(
          `UNREGISTERED_LINK_DESTINATION: "${item.destinationUrl}" on field "${item.fieldName}" is not in the site's registered link table`
        );
      }
    }
  }

  return {
    ok: violations.length === 0,
    requiresHumanApproval,
    mappedFieldProvenance: mapped,
    violations,
  };
}

// =========================================================================
// 3. MCP Server Router (Eager + Search/Enable Discovery + Single Pipeline)
// =========================================================================

export class LinkMcpServer {
  private readonly pipeline: SurfacePipeline;
  private readonly allTools: ReadonlyArray<McpToolDefinition>;
  private readonly toolByName = new Map<string, McpToolDefinition>();
  /** Per-session enabled deferred tool names (`clientSessionId -> Set<toolName>`). */
  private readonly enabledDeferred = new Map<string, Set<string>>();

  constructor(pipeline: SurfacePipeline, catalog: ReadonlyArray<OperationSpec> = OPERATION_CATALOG) {
    this.pipeline = pipeline;
    this.allTools = generateMcpToolsFromOpenApi(catalog);
    for (const tool of this.allTools) {
      this.toolByName.set(tool.name, tool);
    }
  }

  public getAllToolCount(): number {
    return this.allTools.length;
  }

  public getTool(name: string): McpToolDefinition | undefined {
    return this.toolByName.get(name);
  }

  /**
   * Lists visible tools for a given client family & session:
   *   - Respects per-client eager cap for R0/R1 tools
   *   - ALWAYS keeps every high-risk (R2+) tool exposed individually (never collapsed!)
   *   - Includes any deferred tools explicitly enabled via `enableTool()`
   */
  public listVisibleTools(params: {
    readonly clientFamily: McpClientFamily;
    readonly sessionId?: string;
  }): {
    readonly visibleTools: ReadonlyArray<McpToolDefinition>;
    readonly deferredCount: number;
    readonly totalRegistered: number;
  } {
    const cap = MCP_CLIENT_EAGER_LIMITS[params.clientFamily];
    const enabledSet = params.sessionId ? this.enabledDeferred.get(params.sessionId) : undefined;

    const highRiskTools = this.allTools.filter((t) => t.individualHighRiskTool);
    const lowRiskSorted = this.allTools
      .filter((t) => !t.individualHighRiskTool)
      .sort((a, b) => a.eagerPriority - b.eagerPriority);

    const lowRiskSlots = Math.max(1, cap - highRiskTools.length);
    const eagerLowRisk = lowRiskSorted.slice(0, lowRiskSlots);
    const extraEnabled = lowRiskSorted
      .slice(lowRiskSlots)
      .filter((t) => enabledSet?.has(t.name));

    const visible = [...eagerLowRisk, ...extraEnabled, ...highRiskTools];
    return {
      visibleTools: visible,
      deferredCount: this.allTools.length - visible.length,
      totalRegistered: this.allTools.length,
    };
  }

  /**
   * Progressive tool discovery: searches across ALL registered tools (including deferred ones).
   */
  public searchTools(query: string): ReadonlyArray<McpToolDefinition> {
    const q = query.trim().toLowerCase();
    if (!q) return [...this.allTools];
    return this.allTools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.operationId.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
    );
  }

  /**
   * Enables a deferred tool for the current MCP session so it appears in subsequent `tools/list`.
   */
  public enableTool(sessionId: string, toolName: string): { readonly ok: boolean; readonly reason?: string } {
    if (!this.toolByName.has(toolName)) {
      return { ok: false, reason: `Unknown MCP tool: ${toolName}` };
    }
    const set = this.enabledDeferred.get(sessionId) ?? new Set<string>();
    set.add(toolName);
    this.enabledDeferred.set(sessionId, set);
    return { ok: true };
  }

  /**
   * Executes an MCP tool call through the exact same `SurfacePipeline` as REST,
   * adding MCP item provenance & link destination table checks for publishing tools.
   */
  public callTool(params: {
    readonly toolName: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly bearerToken?: string;
    readonly sessionPrincipal?: SurfaceInvocation['sessionPrincipal'];
    readonly dpopThumbprint?: string;
    readonly clientIp?: string;
    readonly now?: Date;
  }): SurfaceExecutionResult {
    const tool = this.toolByName.get(params.toolName);
    if (!tool) {
      return {
        httpStatus: 404,
        headers: {},
        error: { code: 'MCP_TOOL_NOT_FOUND', message: `Unknown MCP tool: ${params.toolName}` },
      };
    }

    const args = params.arguments ?? {};
    const siteId = typeof args.siteId === 'string' ? args.siteId : undefined;
    const callerSuppliedTenantId =
      typeof args.tenantId === 'string'
        ? args.tenantId
        : typeof args.tenant_id === 'string'
          ? args.tenant_id
          : undefined;

    // Provenance & registered link table check when content items are submitted
    let mappedFieldProvenance: ReadonlyArray<FieldProvenance> | undefined;
    if (Array.isArray(args.contentItems) && siteId) {
      const siteCfg = this.pipeline.repository.getSiteConfig(siteId);
      const registeredDestinations = siteCfg?.registeredDestinationUrls ?? [];
      const check = validateMcpContentProvenance({
        items: args.contentItems as ReadonlyArray<McpContentSubmissionItem>,
        registeredDestinationUrls: registeredDestinations,
      });
      if (!check.ok) {
        return {
          httpStatus: 400,
          headers: {},
          error: {
            code: 'MCP_PROVENANCE_OR_LINK_TABLE_VIOLATION',
            message: check.violations.join('; '),
          },
        };
      }
      mappedFieldProvenance = check.mappedFieldProvenance;
    }

    return this.pipeline.execute({
      operationId: tool.operationId,
      channel: 'mcp',
      bearerToken: params.bearerToken,
      sessionPrincipal: params.sessionPrincipal,
      dpopThumbprint: params.dpopThumbprint,
      clientIp: params.clientIp,
      callerSuppliedTenantId,
      siteId,
      idempotencyKey: typeof args.idempotencyKey === 'string' ? args.idempotencyKey : undefined,
      params: args,
      body: args,
      passkeyApprovalId: typeof args.passkeyApprovalId === 'string' ? args.passkeyApprovalId : undefined,
      autonomyEnvelopeId:
        typeof args.autonomyEnvelopeId === 'string' ? args.autonomyEnvelopeId : undefined,
      fieldProvenance: mappedFieldProvenance,
      now: params.now,
    });
  }
}
