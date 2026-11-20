/**
 * UGOKI LINK v2 — Isolated Replay Player Sandbox, Dedicated `replay:view` Access Control
 * & Summary-Only MCP Projection (§11.11 item 8)
 *
 * Security invariants:
 *   1. Cross-origin isolated iframe with STRICT empty `sandbox=""` (blocks scripts, forms,
 *      top-navigation, same-origin, popups) + locked CSP (`default-src 'none'; script-src 'none'; connect-src 'none'`).
 *   2. HTML renderer physically removes `<script>`, `on*` handlers, `javascript:`/`data:` URLs,
 *      and external resource loads.
 *   3. Dedicated permission `replay:view` + hash-chained audit row on every view;
 *      THIRD PARTIES (CRAWL federation accounts, OEM parents, public keys) are PHYSICALLY REFUSED.
 *   4. MCP receives ONLY summaries & markers wrapped in `UntrustedValue` — NEVER raw replay DOM!
 */

import { wrapUntrusted, type UntrustedValue } from '@/packages/contract/response';
import type { AuditLogStore, VerifiedPrincipal } from '@/lib/link/auth';
import type { MaskedReplayNode, MaskedReplaySnapshot, UnreproducibleRegion } from './masker';

export const REPLAY_SANDBOX_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

export const REPLAY_VIEW_PERMISSION = 'replay:view' as const;

const THIRD_PARTY_FORBIDDEN_CREDENTIALS = new Set([
  'ugk_oem',
  'oem_exchanged',
  'federation_assertion',
  'ugk_pub',
  'ugk_edge',
]);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ALLOWED_RENDER_TAGS = new Set([
  'div',
  'span',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'nav',
  'aside',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'button',
  'a',
  'label',
  'table',
  'tr',
  'td',
  'th',
]);

function renderNodeToSafeHtml(node: MaskedReplayNode): string {
  if (node.boxOnlyPlaceholder) {
    const label = escapeHtml(`[${node.boxOnlyPlaceholder.toUpperCase()}_PLACEHOLDER]`);
    return `<div data-placeholder="${escapeHtml(node.boxOnlyPlaceholder)}" style="width:${Math.max(0, Math.round(node.rect.width))}px;height:${Math.max(0, Math.round(node.rect.height))}px;background-color:#e5e7eb;border:1px dashed #6b7280">${label}</div>`;
  }

  if (node.kind === 'input') {
    return `<div data-masked-input="true" style="width:${Math.max(0, Math.round(node.rect.width))}px;height:${Math.max(0, Math.round(node.rect.height))}px;background-color:#d1d5db">[REDACTED_INPUT]</div>`;
  }

  if (node.kind === 'text') {
    return escapeHtml(node.textBlock ?? '');
  }

  const rawTag = node.tagName.toLowerCase();
  const safeTag = ALLOWED_RENDER_TAGS.has(rawTag) ? rawTag : 'div';
  const styleAttr = node.safeStyle ? ` style="${escapeHtml(node.safeStyle)}"` : '';
  const innerText = node.textBlock ? escapeHtml(node.textBlock) : '';
  const innerChildren = node.children.map(renderNodeToSafeHtml).join('');
  return `<${safeTag}${styleAttr}>${innerText}${innerChildren}</${safeTag}>`;
}

export interface IsolatedReplayRenderBundle {
  readonly iframeSandboxAttr: '';
  readonly cspHeader: string;
  readonly srcDocHtml: string;
  readonly unreproducibleRegions: ReadonlyArray<UnreproducibleRegion>;
}

/**
 * Generates an isolated cross-origin replay document with strict `sandbox=""` and locked CSP.
 */
export function buildIsolatedReplayFrame(snapshot: MaskedReplaySnapshot): IsolatedReplayRenderBundle {
  const bodyHtml = renderNodeToSafeHtml(snapshot.root);
  const srcDocHtml = [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(REPLAY_SANDBOX_CSP)}">`,
    '</head>',
    '<body>',
    bodyHtml,
    '</body>',
    '</html>',
  ].join('');

  return {
    iframeSandboxAttr: '',
    cspHeader: REPLAY_SANDBOX_CSP,
    srcDocHtml,
    unreproducibleRegions: snapshot.unreproducibleRegions,
  };
}

/**
 * Verifies that an isolated replay frame contains zero scripts, zero event handlers,
 * zero external loads, zero `javascript:` URLs, empty `sandbox=""`, and locked CSP.
 */
export function verifySandboxFrameSafety(bundle: IsolatedReplayRenderBundle): {
  readonly safe: boolean;
  readonly violations: ReadonlyArray<string>;
} {
  const violations: string[] = [];
  if (bundle.iframeSandboxAttr !== '') {
    violations.push('iframe sandbox attribute must be strictly empty ("")');
  }
  if (!bundle.cspHeader.includes("script-src 'none'") || !bundle.cspHeader.includes("connect-src 'none'")) {
    violations.push('CSP must enforce script-src none and connect-src none');
  }
  if (/<script\b/i.test(bundle.srcDocHtml)) {
    violations.push('Detected forbidden <script> tag in replay HTML');
  }
  if (/\son[a-z]+\s*=/i.test(bundle.srcDocHtml)) {
    violations.push('Detected forbidden inline event handler attribute (on*=)');
  }
  if (/javascript:|data:text\/html/i.test(bundle.srcDocHtml)) {
    violations.push('Detected forbidden javascript: or data:text/html URI');
  }
  if (/<form\b|<iframe\b|<object\b|<embed\b/i.test(bundle.srcDocHtml)) {
    violations.push('Detected forbidden interactive/embedded element (<form>/<iframe>/<object>)');
  }
  if (/https?:\/\//i.test(bundle.srcDocHtml)) {
    violations.push('Detected external HTTP(S) URL reference inside isolated replay document');
  }
  return { safe: violations.length === 0, violations };
}

// =========================================================================
// Dedicated `replay:view` Access Control (Zero OEM / Zero CRAWL Access)
// =========================================================================

export function authorizeReplayView(params: {
  readonly principal: VerifiedPrincipal;
  readonly hasReplayViewPermission: boolean;
  readonly targetTenantId: string;
  readonly targetSiteId: string;
  readonly replayHandle: string;
  readonly auditLog: AuditLogStore;
  readonly now?: Date;
}): { readonly allowed: boolean; readonly httpStatus: 200 | 403 | 404; readonly code: string; readonly auditEntryId: string } {
  const nowIso = (params.now ?? new Date()).toISOString();

  // Foreign tenant -> ALWAYS 404 + audit
  if (params.targetTenantId !== params.principal.tenantId) {
    const entry = params.auditLog.append({
      timestamp: nowIso,
      tenantId: params.principal.tenantId,
      targetTenantId: params.targetTenantId,
      principalId: params.principal.principalId,
      credentialKind: params.principal.credentialKind,
      credentialId: params.principal.credentialId,
      action: 'replay.view',
      riskClass: 'R0',
      resourceType: 'replay',
      resourceId: params.replayHandle,
      outcome: 'deny_404',
      reason: 'FOREIGN_TENANT_REPLAY_404',
    });
    return { allowed: false, httpStatus: 404, code: 'NOT_FOUND', auditEntryId: entry.auditId };
  }

  // Strictly block OEM parents, CRAWL federation accounts, public/edge keys (§11.11.8)
  if (THIRD_PARTY_FORBIDDEN_CREDENTIALS.has(params.principal.credentialKind) || params.principal.act !== undefined) {
    const entry = params.auditLog.append({
      timestamp: nowIso,
      tenantId: params.principal.tenantId,
      targetTenantId: params.targetTenantId,
      principalId: params.principal.principalId,
      credentialKind: params.principal.credentialKind,
      credentialId: params.principal.credentialId,
      action: 'replay.view',
      riskClass: 'R0',
      resourceType: 'replay',
      resourceId: params.replayHandle,
      outcome: 'deny_403',
      reason: 'REPLAY_THIRD_PARTY_FORBIDDEN',
    });
    return { allowed: false, httpStatus: 403, code: 'REPLAY_THIRD_PARTY_FORBIDDEN', auditEntryId: entry.auditId };
  }

  if (!params.hasReplayViewPermission) {
    const entry = params.auditLog.append({
      timestamp: nowIso,
      tenantId: params.principal.tenantId,
      targetTenantId: params.targetTenantId,
      principalId: params.principal.principalId,
      credentialKind: params.principal.credentialKind,
      credentialId: params.principal.credentialId,
      action: 'replay.view',
      riskClass: 'R0',
      resourceType: 'replay',
      resourceId: params.replayHandle,
      outcome: 'deny_403',
      reason: 'MISSING_REPLAY_VIEW_PERMISSION',
    });
    return { allowed: false, httpStatus: 403, code: 'MISSING_REPLAY_VIEW_PERMISSION', auditEntryId: entry.auditId };
  }

  const entry = params.auditLog.append({
    timestamp: nowIso,
    tenantId: params.principal.tenantId,
    targetTenantId: params.targetTenantId,
    principalId: params.principal.principalId,
    credentialKind: params.principal.credentialKind,
    credentialId: params.principal.credentialId,
    action: 'replay.view',
    riskClass: 'R0',
    resourceType: 'replay',
    resourceId: params.replayHandle,
    outcome: 'allow',
    reason: 'REPLAY_VIEW_AUTHORIZED',
    metadata: { siteId: params.targetSiteId },
  });
  return { allowed: true, httpStatus: 200, code: 'OK', auditEntryId: entry.auditId };
}

// =========================================================================
// MCP Summary-Only Replay Projection (NEVER Returns Raw DOM!)
// =========================================================================

export interface McpReplaySummary {
  readonly handle: string;
  readonly containsRawDom: false;
  readonly nodeCount: number;
  readonly maskedNodeCount: number;
  readonly unreproducibleRegions: ReadonlyArray<{
    readonly kind: UnreproducibleRegion['kind'];
    readonly disclosureNote: UntrustedValue;
  }>;
  readonly summaryNote: UntrustedValue;
}

function countNodes(node: MaskedReplayNode): { total: number; masked: number } {
  let total = 1;
  let masked = node.masked ? 1 : 0;
  for (const child of node.children) {
    const sub = countNodes(child);
    total += sub.total;
    masked += sub.masked;
  }
  return { total, masked };
}

export function buildMcpReplaySummary(
  handle: string,
  snapshot: MaskedReplaySnapshot
): McpReplaySummary {
  const counts = countNodes(snapshot.root);
  return {
    handle,
    containsRawDom: false,
    nodeCount: counts.total,
    maskedNodeCount: counts.masked,
    unreproducibleRegions: snapshot.unreproducibleRegions.map((r) => ({
      kind: r.kind,
      disclosureNote: wrapUntrusted(r.disclosureNote, 'page_content'),
    })),
    summaryNote: wrapUntrusted(
      `Replay handle ${handle}: ${counts.total} structural nodes (${counts.masked} masked), ${snapshot.unreproducibleRegions.length} unreproducible region(s). Raw DOM withheld from MCP per §11.11.8.`,
      'page_content'
    ),
  };
}
