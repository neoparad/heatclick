/**
 * UGOKI LINK v2 — Delivery Expressions (A0 / A1 / A1c / A2 / A3),
 * Legal-Notice Origin Guard (§10.1), and §10.6 Non-Overridable Invariants
 */

import { canonicalJson, sha256Hex } from '@/packages/contract/response';
import { drawUniformU } from '@/lib/link/allocator';

// =========================================================================
// 1. Expression Tiers (A0 / A1 / A1c / A2 / A3)
// =========================================================================

export type ExpressionTier = 'A0' | 'A1' | 'A1c' | 'A2' | 'A3';

export type A1ComponentKind =
  | 'bar'
  | 'modal'
  | 'wizard'
  | 'launcher'
  | 'rec_list'
  | 'assistant'
  | 'coupon';

export interface A1TypedComponentSpec {
  readonly tier: 'A1';
  readonly component: A1ComponentKind;
  readonly shadowDomMode: 'closed';
  readonly viewportHeightPct?: number;
  readonly dismissible: boolean;
  readonly slots: Readonly<Record<string, string>>;
  readonly destinationUrl?: string;
}

export interface A1cDeclarativeNode {
  readonly tag: 'div' | 'span' | 'p' | 'h2' | 'h3' | 'a' | 'button' | 'ul' | 'li' | 'img';
  readonly textSlot?: string;
  readonly styles?: Readonly<Record<string, string>>;
  readonly hrefSlot?: string;
  readonly actionEvent?: string;
  readonly children?: ReadonlyArray<A1cDeclarativeNode>;
}

export interface A1cDeclarativeTreeSpec {
  readonly tier: 'A1c';
  readonly shadowDomMode: 'closed';
  readonly root: A1cDeclarativeNode;
  readonly states: ReadonlyArray<string>;
  readonly transitions: ReadonlyArray<{ readonly from: string; readonly on: string; readonly to: string }>;
  readonly values: Readonly<Record<string, string>>;
}

export type A2MutationOpKind =
  | 'replace_text'
  | 'set_attribute'
  | 'set_style'
  | 'hide'
  | 'move'
  | 'insert_element'
  | 'replace_image'
  | 'clone_affiliate_unit';

export interface A2MutationOperation {
  readonly opId: string;
  readonly kind: A2MutationOpKind;
  /** Target element/section match fingerprint (`sec_fp` / `el_fp`). */
  readonly targetMatchKey: string;
  readonly payload: Readonly<Record<string, string>>;
  /** Mandatory inverse op metadata guaranteeing full reversible rollback. */
  readonly inverseOp: {
    readonly kind: string;
    readonly restoreKey: string;
  };
  /** Required when `kind === 'clone_affiliate_unit'`: immutable registry unit ID & byte SHA-256. */
  readonly affiliateRegistryUnitId?: string;
  readonly affiliateByteSha256?: string;
}

export interface A2DeclarativePatchSpec {
  readonly tier: 'A2';
  readonly operations: ReadonlyArray<A2MutationOperation>;
}

export interface A3IsolatedFrameSpec {
  readonly tier: 'A3';
  readonly isolatedOrigin: string;
  readonly bundleHash: string;
  readonly humanApprovalId: string;
  readonly hostOwnedCloseButton: true;
  readonly hostOwnedNavigation: true;
  readonly monitorHistoryLength: true;
  readonly disclosableDataKeys: ReadonlyArray<string>;
}

export type DeliveryExpressionSpec =
  | { readonly tier: 'A0' }
  | A1TypedComponentSpec
  | A1cDeclarativeTreeSpec
  | A2DeclarativePatchSpec
  | A3IsolatedFrameSpec;

// =========================================================================
// 2. Legacy Sanitized HTML -> A1c 1:1 Converter (§10.3)
// =========================================================================

const ALLOWED_A1C_TAGS = new Set(['div', 'span', 'p', 'h2', 'h3', 'a', 'button', 'ul', 'li']);

/**
 * Converts a legacy sanitized HTML snippet 1:1 into a closed declarative A1c node tree
 * with zero raw HTML execution (`innerHTML` never used in runtime).
 */
export function convertLegacySanitizedHtmlToA1c(
  sanitizedHtml: string,
  values: Readonly<Record<string, string>> = {}
): A1cDeclarativeTreeSpec {
  if (/<script\b|javascript:|on[a-z]+\s*=/i.test(sanitizedHtml)) {
    throw new Error('Legacy HTML contains forbidden executable content and cannot be converted to A1c');
  }

  const children: A1cDeclarativeNode[] = [];
  const tagRe = /<(div|span|p|h2|h3|a|button|ul|li)(?:\s+href="([^"]*)")?[^>]*>([^<]*)<\/\1>/gi;
  let match: RegExpExecArray | null;
  let slotCounter = 1;
  const extractedValues: Record<string, string> = { ...values };

  while ((match = tagRe.exec(sanitizedHtml)) !== null) {
    const tag = match[1].toLowerCase();
    if (!ALLOWED_A1C_TAGS.has(tag)) continue;
    const href = match[2];
    const text = match[3].trim();
    const slotKey = `slot_${slotCounter++}`;
    extractedValues[slotKey] = text;

    let hrefSlot: string | undefined;
    if (href && /^https:\/\//i.test(href)) {
      hrefSlot = `href_${slotCounter}`;
      extractedValues[hrefSlot] = href;
    }

    children.push({
      tag: tag as A1cDeclarativeNode['tag'],
      textSlot: slotKey,
      ...(hrefSlot ? { hrefSlot } : {}),
    });
  }

  return {
    tier: 'A1c',
    shadowDomMode: 'closed',
    root: {
      tag: 'div',
      children:
        children.length > 0
          ? children
          : [{ tag: 'p', textSlot: 'slot_fallback' }],
    },
    states: ['open', 'dismissed'],
    transitions: [{ from: 'open', on: 'close', to: 'dismissed' }],
    values:
      children.length > 0
        ? extractedValues
        : { ...extractedValues, slot_fallback: sanitizedHtml.replace(/<[^>]+>/g, '').trim() },
  };
}

// =========================================================================
// 3. Legal Mandatory Notice Runtime Ban (§10.1) & Affiliate 1-Byte Immutability
// =========================================================================

export type CampaignSemanticCategory =
  | 'cro_layout'
  | 'copy_variant'
  | 'recommendation'
  | 'legal_advertising_disclosure'
  | 'legal_consent_notice';

export interface ExpressionValidationContext {
  readonly semanticCategory: CampaignSemanticCategory;
  readonly protectedMatchKeys: ReadonlyArray<string>;
  readonly registeredAffiliateUnits?: Readonly<Record<string, { readonly byteSha256: string }>>;
  readonly registeredDestinationUrls?: ReadonlyArray<string>;
  readonly pageHasPasswordOrPaymentField?: boolean;
}

const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const ALLOWED_A1_COMPONENTS = new Set<A1ComponentKind>([
  'bar',
  'modal',
  'wizard',
  'launcher',
  'rec_list',
  'assistant',
  'coupon',
]);

const ALLOWED_A1C_NODE_TAGS = new Set<A1cDeclarativeNode['tag']>([
  'div',
  'span',
  'p',
  'h2',
  'h3',
  'a',
  'button',
  'ul',
  'li',
  'img',
]);

const ALLOWED_A2_OP_KINDS = new Set<A2MutationOpKind>([
  'replace_text',
  'set_attribute',
  'set_style',
  'hide',
  'move',
  'insert_element',
  'replace_image',
  'clone_affiliate_unit',
]);

const ALLOWED_A2_ATTRS = new Set([
  'href',
  'src',
  'alt',
  'title',
  'aria-label',
  'role',
  'data-ugk-slot',
  'data-ugk-variant',
]);

const ALLOWED_STYLE_PROPERTIES = new Set([
  'color',
  'background-color',
  'backgroundColor',
  'font-size',
  'fontSize',
  'font-weight',
  'fontWeight',
  'line-height',
  'lineHeight',
  'text-align',
  'textAlign',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'border-radius',
  'borderRadius',
  'border-color',
  'borderColor',
  'display',
  'opacity',
  'gap',
  'max-width',
  'maxWidth',
]);

const BUILT_IN_PROTECTED_REGIONS = new Set([
  'password',
  'payment',
  'advertising_disclosure',
  'consent_banner',
  'legal_notice',
]);

const AFFILIATE_HOST_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|\.)a8\.net$/i,
  /(?:^|\.)afb\.jp$/i,
  /(?:^|\.)valuecommerce\.com$/i,
  /(?:^|\.)rakuten\.co\.jp$/i,
  /(?:^|\.)moshimo\.com$/i,
  /(?:^|\.)accesstrade\.net$/i,
  /(?:^|\.)janet\.ad\.jp$/i,
  /(?:^|\.)felmat\.net$/i,
  /(?:^|\.)amazon\.(?:co\.jp|com|jp)$/i,
  /(?:^|\.)amzn\.(?:to|asia)$/i,
  /(?:^|\.)assoc-amazon\.com$/i,
];

const AFFILIATE_PARAM_RE =
  /(?:^|[?&])(a8mat|aff_id|affiliate_id|vc_sid|scid|tag|ascsubtag|linkCode|camp|creative)=/i;

const EXECUTABLE_PAYLOAD_RE =
  /<\s*\/?\s*(script|iframe|object|embed|style|link|meta|svg|math)\b|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html|on[a-z]+\s*=/i;

const DANGEROUS_CSS_VALUE_RE =
  /url\s*\(|expression\s*\(|@import|javascript\s*:|-moz-binding|behavior\s*:/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasForbiddenAffiliateTarget(raw: string): boolean {
  if (AFFILIATE_PARAM_RE.test(raw)) {
    return true;
  }
  const urlMatch = raw.match(/(?:https?:)?\/\/[^\s"'<>]+/i);
  const candidate = urlMatch ? (urlMatch[0].startsWith('//') ? `https:${urlMatch[0]}` : urlMatch[0]) : raw;
  try {
    const parsed = new URL(candidate);
    if (AFFILIATE_HOST_PATTERNS.some((re) => re.test(parsed.hostname))) {
      return true;
    }
    if (AFFILIATE_PARAM_RE.test(parsed.search)) {
      return true;
    }
  } catch {
    // Not a full URL; query param regex already checked above.
  }
  return false;
}

function validateDestinationUrl(
  urlValue: string,
  registeredDestinationUrls: ReadonlyArray<string> | undefined,
  contextLabel: string,
  violations: string[]
): void {
  const trimmed = urlValue.trim();
  if (!trimmed || /^(?:javascript|vbscript|data):/i.test(trimmed) || trimmed.startsWith('//')) {
    violations.push(`${contextLabel}_INVALID_SCHEME: "${urlValue}" must be an explicit https:// or relative path URL`);
    return;
  }
  if (!trimmed.startsWith('/')) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:') {
        violations.push(`${contextLabel}_HTTPS_REQUIRED: "${urlValue}" must use https://`);
        return;
      }
    } catch {
      violations.push(`${contextLabel}_MALFORMED_URL: "${urlValue}" is not a valid URL`);
      return;
    }
  }
  if (hasForbiddenAffiliateTarget(trimmed)) {
    violations.push(`${contextLabel}_AFFILIATE_URL_FORBIDDEN: "${urlValue}" contains affiliate host or query parameter`);
    return;
  }
  if (registeredDestinationUrls && !registeredDestinationUrls.includes(urlValue)) {
    violations.push(`${contextLabel}_UNREGISTERED_DESTINATION: "${urlValue}" is not in registered link table`);
  }
}

function validateClosedStyleRecord(
  styles: unknown,
  contextLabel: string,
  violations: string[]
): void {
  if (!isPlainRecord(styles)) {
    violations.push(`${contextLabel}_INVALID_STYLES_OBJECT: styles must be a plain key-value record`);
    return;
  }
  for (const key of Object.keys(styles)) {
    if (!Object.prototype.hasOwnProperty.call(styles, key) || FORBIDDEN_PROTO_KEYS.has(key)) {
      violations.push(`${contextLabel}_FORBIDDEN_STYLE_KEY: "${key}" is prohibited`);
      continue;
    }
    if (!ALLOWED_STYLE_PROPERTIES.has(key)) {
      violations.push(`${contextLabel}_STYLE_PROPERTY_NOT_ALLOWLISTED: "${key}" is outside closed style grammar`);
      continue;
    }
    const val = styles[key];
    if (typeof val !== 'string' || DANGEROUS_CSS_VALUE_RE.test(val)) {
      violations.push(`${contextLabel}_DANGEROUS_STYLE_VALUE: style "${key}" contains forbidden CSS construct`);
    }
  }
}

export function validateExpressionSpec(
  spec: DeliveryExpressionSpec,
  ctx: ExpressionValidationContext
): { readonly valid: boolean; readonly violations: ReadonlyArray<string> } {
  const violations: string[] = [];

  // §10.1: Legal mandatory notices (ad disclosure / consent banner) MUST NOT rely solely on runtime delivery
  if (
    ctx.semanticCategory === 'legal_advertising_disclosure' ||
    ctx.semanticCategory === 'legal_consent_notice'
  ) {
    violations.push(
      `LEGAL_NOTICE_RUNTIME_FORBIDDEN: "${ctx.semanticCategory}" must be placed in origin HTML, never solely in runtime delivery (§10.1)`
    );
  }

  if (spec.tier === 'A1') {
    if (spec.shadowDomMode !== 'closed') {
      violations.push('A1 typed components must render inside a closed Shadow DOM');
    }
    if (!ALLOWED_A1_COMPONENTS.has(spec.component)) {
      violations.push(`A1_COMPONENT_NOT_ALLOWLISTED: "${String(spec.component)}" is not in closed A1 catalog`);
    }
    if (!isPlainRecord(spec.slots)) {
      violations.push('A1_INVALID_SLOTS: slots must be a plain string record');
    } else {
      for (const slotKey of Object.keys(spec.slots)) {
        if (!Object.prototype.hasOwnProperty.call(spec.slots, slotKey) || FORBIDDEN_PROTO_KEYS.has(slotKey)) {
          violations.push(`A1_FORBIDDEN_SLOT_KEY: "${slotKey}" is prohibited`);
          continue;
        }
        const slotVal = (spec.slots as Record<string, unknown>)[slotKey];
        if (typeof slotVal !== 'string') {
          violations.push(`A1_NON_STRING_SLOT: slot "${slotKey}" must be a primitive string`);
          continue;
        }
        if (EXECUTABLE_PAYLOAD_RE.test(slotVal)) {
          violations.push(`A1_EXECUTABLE_SLOT_FORBIDDEN: slot "${slotKey}" contains executable markup or script`);
        }
        if (hasForbiddenAffiliateTarget(slotVal)) {
          violations.push(`A1_AFFILIATE_INJECTION_FORBIDDEN: slot "${slotKey}" contains affiliate URL or parameter`);
        }
      }
    }
    if (spec.destinationUrl !== undefined) {
      validateDestinationUrl(spec.destinationUrl, ctx.registeredDestinationUrls, 'A1', violations);
    }
  }

  if (spec.tier === 'A1c') {
    if (spec.shadowDomMode !== 'closed') {
      violations.push('A1C_CLOSED_SHADOW_DOM_REQUIRED: A1c tree must render inside a closed Shadow DOM');
    }

    if (!isPlainRecord(spec.values)) {
      violations.push('A1C_INVALID_VALUES_MAP: values must be a plain string record');
    } else {
      for (const valKey of Object.keys(spec.values)) {
        if (!Object.prototype.hasOwnProperty.call(spec.values, valKey) || FORBIDDEN_PROTO_KEYS.has(valKey)) {
          violations.push(`A1C_FORBIDDEN_VALUE_KEY: "${valKey}" is prohibited`);
          continue;
        }
        const rawVal = (spec.values as Record<string, unknown>)[valKey];
        if (typeof rawVal !== 'string') {
          violations.push(`A1C_NON_STRING_VALUE: value "${valKey}" must be a string`);
          continue;
        }
        if (EXECUTABLE_PAYLOAD_RE.test(rawVal)) {
          violations.push(`A1C_EXECUTABLE_VALUE_FORBIDDEN: value "${valKey}" contains executable HTML/JS`);
        }
        if (hasForbiddenAffiliateTarget(rawVal)) {
          violations.push(`A1C_AFFILIATE_VALUE_FORBIDDEN: value "${valKey}" contains affiliate URL or parameter`);
        }
      }
    }

    const declaredStates = new Set<string>();
    if (!Array.isArray(spec.states) || spec.states.length === 0) {
      violations.push('A1C_STATES_REQUIRED: A1c state machine must declare at least one state');
    } else {
      for (const st of spec.states) {
        if (typeof st !== 'string' || st.trim().length === 0 || FORBIDDEN_PROTO_KEYS.has(st)) {
          violations.push(`A1C_INVALID_STATE_NAME: "${String(st)}" is invalid`);
        } else {
          declaredStates.add(st);
        }
      }
    }

    const declaredEvents = new Set<string>();
    if (!Array.isArray(spec.transitions)) {
      violations.push('A1C_TRANSITIONS_REQUIRED: A1c transitions must be an array');
    } else {
      for (const tr of spec.transitions) {
        if (
          !tr ||
          typeof tr.from !== 'string' ||
          typeof tr.to !== 'string' ||
          typeof tr.on !== 'string' ||
          tr.on.trim().length === 0
        ) {
          violations.push('A1C_MALFORMED_TRANSITION: transition must specify string from, on, and to');
          continue;
        }
        if (!declaredStates.has(tr.from) || !declaredStates.has(tr.to)) {
          violations.push(
            `A1C_UNDECLARED_TRANSITION_STATE: transition "${tr.from}" --(${tr.on})--> "${tr.to}" references undeclared state`
          );
        }
        declaredEvents.add(tr.on);
      }
    }

    // Iterative bounded validation of A1c declarative node tree
    if (!spec.root || typeof spec.root !== 'object') {
      violations.push('A1C_ROOT_REQUIRED: A1c root node is missing');
    } else {
      const stack: Array<{ node: A1cDeclarativeNode; depth: number }> = [{ node: spec.root, depth: 0 }];
      let visitedNodes = 0;
      const maxNodes = 256;
      const maxDepth = 16;

      while (stack.length > 0) {
        const { node, depth } = stack.pop()!;
        visitedNodes += 1;
        if (visitedNodes > maxNodes) {
          violations.push(`A1C_NODE_BUDGET_EXCEEDED: tree exceeds maximum ${maxNodes} nodes`);
          break;
        }
        if (depth > maxDepth) {
          violations.push(`A1C_DEPTH_EXCEEDED: tree exceeds maximum depth ${maxDepth}`);
          continue;
        }
        if (!ALLOWED_A1C_NODE_TAGS.has(node.tag)) {
          violations.push(`A1C_TAG_NOT_ALLOWLISTED: tag "${String(node.tag)}" is prohibited in closed A1c grammar`);
        }
        if (node.textSlot !== undefined) {
          if (
            typeof node.textSlot !== 'string' ||
            FORBIDDEN_PROTO_KEYS.has(node.textSlot) ||
            !isPlainRecord(spec.values) ||
            !Object.prototype.hasOwnProperty.call(spec.values, node.textSlot)
          ) {
            violations.push(`A1C_UNBOUND_TEXT_SLOT: textSlot "${String(node.textSlot)}" is missing in values`);
          }
        }
        if (node.hrefSlot !== undefined) {
          if (
            typeof node.hrefSlot !== 'string' ||
            FORBIDDEN_PROTO_KEYS.has(node.hrefSlot) ||
            !isPlainRecord(spec.values) ||
            !Object.prototype.hasOwnProperty.call(spec.values, node.hrefSlot)
          ) {
            violations.push(`A1C_UNBOUND_HREF_SLOT: hrefSlot "${String(node.hrefSlot)}" is missing in values`);
          } else {
            const hrefVal = spec.values[node.hrefSlot];
            if (typeof hrefVal === 'string') {
              validateDestinationUrl(hrefVal, ctx.registeredDestinationUrls, 'A1C', violations);
            }
          }
        }
        if (node.styles !== undefined) {
          validateClosedStyleRecord(node.styles, 'A1C', violations);
        }
        if (node.actionEvent !== undefined) {
          if (typeof node.actionEvent !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(node.actionEvent)) {
            violations.push(`A1C_INVALID_ACTION_EVENT: "${String(node.actionEvent)}" is invalid`);
          } else if (declaredEvents.size > 0 && !declaredEvents.has(node.actionEvent)) {
            violations.push(
              `A1C_UNDECLARED_ACTION_EVENT: actionEvent "${node.actionEvent}" has no matching transition`
            );
          }
        }
        if (node.children !== undefined) {
          if (!Array.isArray(node.children)) {
            violations.push('A1C_INVALID_CHILDREN: node.children must be an array');
          } else {
            for (let i = node.children.length - 1; i >= 0; i -= 1) {
              const child = node.children[i];
              if (!child || typeof child !== 'object') {
                violations.push('A1C_INVALID_CHILD_NODE: child must be a declarative node object');
              } else {
                stack.push({ node: child, depth: depth + 1 });
              }
            }
          }
        }
      }
    }
  }

  if (spec.tier === 'A2') {
    const protectedSet = new Set([...ctx.protectedMatchKeys, ...BUILT_IN_PROTECTED_REGIONS]);
    if (!Array.isArray(spec.operations) || spec.operations.length === 0) {
      violations.push('A2_EMPTY_OPERATIONS: A2 patch must declare at least one operation');
    } else if (spec.operations.length > 128) {
      violations.push('A2_OPERATION_BUDGET_EXCEEDED: A2 patch exceeds maximum 128 operations');
    } else {
      for (const op of spec.operations) {
        if (!op.opId || typeof op.opId !== 'string' || FORBIDDEN_PROTO_KEYS.has(op.opId)) {
          violations.push('A2_INVALID_OP_ID: every A2 operation requires a valid opId');
        }
        if (!ALLOWED_A2_OP_KINDS.has(op.kind)) {
          violations.push(`A2_OP_KIND_NOT_ALLOWLISTED: "${String(op.kind)}" is outside closed A2 grammar`);
        }
        if (
          !op.targetMatchKey ||
          typeof op.targetMatchKey !== 'string' ||
          FORBIDDEN_PROTO_KEYS.has(op.targetMatchKey)
        ) {
          violations.push(`A2_INVALID_TARGET_MATCH_KEY: operation "${op.opId}" requires a valid targetMatchKey`);
        } else if (protectedSet.has(op.targetMatchKey)) {
          violations.push(`A2_PROTECTED_REGION_FORBIDDEN: target "${op.targetMatchKey}" is protected`);
        }

        if (
          !op.inverseOp ||
          typeof op.inverseOp.kind !== 'string' ||
          op.inverseOp.kind.trim().length === 0 ||
          typeof op.inverseOp.restoreKey !== 'string' ||
          op.inverseOp.restoreKey.trim().length === 0
        ) {
          violations.push(
            `A2_INVERSE_OP_REQUIRED: operation "${op.opId}" must store an explicit inverseOp kind and restoreKey`
          );
        }

        if (!isPlainRecord(op.payload)) {
          violations.push(`A2_INVALID_PAYLOAD: operation "${op.opId}" payload must be a plain string record`);
          continue;
        }

        const payloadKeys = Object.keys(op.payload);
        for (const pKey of payloadKeys) {
          if (!Object.prototype.hasOwnProperty.call(op.payload, pKey) || FORBIDDEN_PROTO_KEYS.has(pKey)) {
            violations.push(`A2_FORBIDDEN_PAYLOAD_KEY: operation "${op.opId}" contains prohibited key "${pKey}"`);
            continue;
          }
          const pVal = (op.payload as Record<string, unknown>)[pKey];
          if (typeof pVal !== 'string') {
            violations.push(`A2_NON_STRING_PAYLOAD_VALUE: operation "${op.opId}" key "${pKey}" must be a string`);
            continue;
          }
          if (EXECUTABLE_PAYLOAD_RE.test(pVal)) {
            violations.push(
              `A2_EXECUTABLE_PAYLOAD_FORBIDDEN: operation "${op.opId}" key "${pKey}" contains executable markup/script`
            );
          }
          if (DANGEROUS_CSS_VALUE_RE.test(pVal)) {
            violations.push(
              `A2_DANGEROUS_CSS_FORBIDDEN: operation "${op.opId}" key "${pKey}" contains forbidden CSS construct`
            );
          }
          if (op.kind !== 'clone_affiliate_unit' && hasForbiddenAffiliateTarget(pVal)) {
            violations.push(
              `A2_AFFILIATE_MUTATION_FORBIDDEN: operation "${op.opId}" key "${pKey}" contains affiliate host or query parameter`
            );
          }
        }

        if (op.kind === 'set_attribute') {
          const explicitAttr = op.payload.name ?? op.payload.attr;
          if (explicitAttr !== undefined) {
            if (!ALLOWED_A2_ATTRS.has(explicitAttr) || /^on/i.test(explicitAttr)) {
              violations.push(
                `A2_ATTR_NOT_ALLOWLISTED: attribute "${explicitAttr}" in "${op.opId}" is prohibited`
              );
            }
            const attrVal = op.payload.value ?? '';
            if ((explicitAttr === 'href' || explicitAttr === 'src') && typeof attrVal === 'string') {
              validateDestinationUrl(attrVal, ctx.registeredDestinationUrls, 'A2', violations);
            }
          } else {
            for (const attrKey of payloadKeys) {
              if (!ALLOWED_A2_ATTRS.has(attrKey) || /^on/i.test(attrKey)) {
                violations.push(
                  `A2_ATTR_NOT_ALLOWLISTED: attribute "${attrKey}" in "${op.opId}" is prohibited`
                );
              }
              if (attrKey === 'href' || attrKey === 'src') {
                validateDestinationUrl(op.payload[attrKey], ctx.registeredDestinationUrls, 'A2', violations);
              }
            }
          }
        }

        if (op.kind === 'set_style') {
          validateClosedStyleRecord(op.payload, 'A2', violations);
        }

        if (op.kind === 'insert_element') {
          const tag = op.payload.tag;
          if (!tag || !ALLOWED_A1C_NODE_TAGS.has(tag as A1cDeclarativeNode['tag'])) {
            violations.push(
              `A2_INSERT_TAG_NOT_ALLOWLISTED: insert_element "${op.opId}" requires an allowlisted tag, got "${String(tag)}"`
            );
          }
          for (const k of payloadKeys) {
            if (k === 'tag' || k === 'text') continue;
            if (!ALLOWED_A2_ATTRS.has(k) || /^on/i.test(k)) {
              violations.push(
                `A2_INSERT_ATTR_NOT_ALLOWLISTED: insert_element "${op.opId}" attribute "${k}" is prohibited`
              );
            }
            if (k === 'href' || k === 'src') {
              validateDestinationUrl(op.payload[k], ctx.registeredDestinationUrls, 'A2', violations);
            }
          }
        }

        if (op.kind === 'replace_image' && op.payload.src !== undefined) {
          validateDestinationUrl(op.payload.src, ctx.registeredDestinationUrls, 'A2', violations);
        }

        if (op.kind === 'clone_affiliate_unit') {
          const reg = op.affiliateRegistryUnitId
            ? ctx.registeredAffiliateUnits?.[op.affiliateRegistryUnitId]
            : undefined;
          if (!reg || reg.byteSha256 !== op.affiliateByteSha256) {
            violations.push(
              `A2_AFFILIATE_UNIT_IMMUTABILITY_VIOLATION: affiliate slot "${op.opId}" must match registered byte SHA-256 identically`
            );
          }
          if (payloadKeys.length > 0) {
            violations.push(
              `A2_AFFILIATE_UNIT_PAYLOAD_MUTATION_FORBIDDEN: clone_affiliate_unit "${op.opId}" cannot carry mutating payload keys`
            );
          }
        }
      }
    }
  }

  if (spec.tier === 'A3') {
    if (ctx.pageHasPasswordOrPaymentField) {
      violations.push('A3_FORBIDDEN_ON_PASSWORD_OR_PAYMENT_PAGE: A3 frames cannot mount on password/payment pages (§10.3)');
    }
    if (!spec.humanApprovalId || !spec.bundleHash) {
      violations.push('A3_HUMAN_HASH_APPROVAL_REQUIRED: A3 bundle requires human hash-pinned approval');
    }
    if (!spec.hostOwnedCloseButton || !spec.hostOwnedNavigation || !spec.monitorHistoryLength) {
      violations.push('A3 requires host-owned close/navigation and history.length increment monitoring');
    }
    // Reject non-disclosable sensitive keys passed into A3
    for (const key of spec.disclosableDataKeys) {
      if (/(visitor_id|user_id|email|token|cookie|password|card|secret|ip)/i.test(key)) {
        violations.push(`A3_NON_DISCLOSABLE_KEY: "${key}" cannot be passed to cross-origin A3 frame`);
      }
    }
  }

  return { valid: violations.length === 0, violations };
}

// =========================================================================
// 4. §10.6 Non-Overridable Invariants (Search, Overlays, Stateless Draw, URL Churn)
// =========================================================================

export type IndexabilityImpact = 'non_indexable' | 'indexable_minor' | 'indexable_major';
export type RandomisationLane = 'visitor_randomised' | 'page_randomised';

export interface Section106CheckInput {
  readonly indexabilityImpact: IndexabilityImpact;
  readonly isMajorOrganicLandingPage: boolean;
  readonly lane: RandomisationLane;
  readonly plannedDurationDays: number;
  /** Number of OTHER concurrent indexable modifications active on this same URL. */
  readonly existingIndexableSourcesOnUrl: number;
  readonly maxIndexableSourcesPerUrl?: number;
  /** Overlay checks (§10.6). */
  readonly isSystemAutoOverlay: boolean;
  readonly isUserInitiatedOverlay?: boolean;
  readonly isIndexableUrl: boolean;
  readonly overlayKind?: 'modal' | 'bottom_bar' | 'inline_insert';
  readonly bottomBarViewportHeightPct?: number;
  readonly landingSignals?: {
    readonly fromSearchEngine: boolean;
    readonly hasPositiveNonSearchEvidence: boolean; // ad click ID, campaign param, non-search referrer, or prior unit
  };
}

export interface Section106Verdict {
  readonly allowed: boolean;
  readonly nonOverridable: true;
  readonly violations: ReadonlyArray<string>;
}

/**
 * Enforces §10.6 non-overridable safety invariants (cannot be bypassed by any autonomy envelope).
 */
export function validateSection106Invariants(input: Section106CheckInput): Section106Verdict {
  const violations: string[] = [];

  // 1. Indexability lane & 56-day horizon rules
  if (input.indexabilityImpact === 'indexable_major' && input.lane !== 'page_randomised') {
    violations.push(
      'S106_MAJOR_INDEXABLE_REQUIRES_PAGE_LANE: major indexable changes (title/H1/canonical/robots/structured data) must run on page_randomised lane only'
    );
  }
  if (
    input.isMajorOrganicLandingPage &&
    input.indexabilityImpact !== 'non_indexable' &&
    input.lane !== 'page_randomised'
  ) {
    violations.push(
      'S106_MAJOR_ORGANIC_PAGE_REQUIRES_PAGE_LANE: indexable changes on major organic landing pages must run on page_randomised lane'
    );
  }
  if (
    input.indexabilityImpact === 'indexable_minor' &&
    input.lane === 'visitor_randomised' &&
    input.plannedDurationDays > 56
  ) {
    violations.push(
      `S106_INDEXABLE_HORIZON_EXCEEDED: visitor_randomised indexable_minor duration ${input.plannedDurationDays}d exceeds 56-day maximum`
    );
  }

  // 2. Per-URL combined SEO churn budget
  if (input.indexabilityImpact !== 'non_indexable') {
    const cap = input.isMajorOrganicLandingPage ? 1 : (input.maxIndexableSourcesPerUrl ?? 2);
    if (input.existingIndexableSourcesOnUrl + 1 > cap) {
      violations.push(
        `S106_URL_SEO_CHURN_BUDGET_EXCEEDED: active indexable sources (${input.existingIndexableSourcesOnUrl + 1}) exceeds URL cap (${cap})`
      );
    }
  }

  // 3. Automatic overlay suppression on indexable URLs (search landings OR lacking positive non-search evidence)
  if (input.isSystemAutoOverlay && !input.isUserInitiatedOverlay && input.isIndexableUrl) {
    const restrictedLanding =
      !input.landingSignals ||
      input.landingSignals.fromSearchEngine ||
      !input.landingSignals.hasPositiveNonSearchEvidence;

    if (restrictedLanding) {
      if (input.overlayKind === 'modal' || !input.overlayKind) {
        violations.push(
          'S106_AUTO_OVERLAY_SUPPRESSED_ON_SEARCH_OR_STATELESS_LANDING: auto modal overlays forbidden on search landings or landings without positive non-search evidence'
        );
      } else if (
        input.overlayKind === 'bottom_bar' &&
        (input.bottomBarViewportHeightPct ?? 100) > 15
      ) {
        violations.push(
          `S106_BOTTOM_BAR_EXCEEDS_15VH: bottom bar height ${input.bottomBarViewportHeightPct}% exceeds 15% vh limit`
        );
      }
    }
  }

  return {
    allowed: violations.length === 0,
    nonOverridable: true,
    violations,
  };
}

/**
 * Deterministic `URL × day` stable draw for stateless (cookieless / crawler) visits (§10.6 / D-20).
 * Ensures every stateless fetch of the same URL on the same UTC day sees the exact same variant.
 */
export function drawStatelessUrlDayArm(params: {
  readonly secret: string;
  readonly experimentId: string;
  readonly urlId: string;
  readonly utcDayIso: string; // YYYY-MM-DD
  readonly statelessPolicy: 'randomise' | 'default_only';
  readonly arms: ReadonlyArray<{ readonly armId: string; readonly weight: number }>;
}): { readonly armId: string; readonly unitKey: string } {
  const unitKey = `${params.urlId}:${params.utcDayIso}`;
  if (params.statelessPolicy === 'default_only' || params.arms.length === 0) {
    return { armId: 'control', unitKey };
  }
  const u = drawUniformU(`${params.secret}:stateless:${params.experimentId}`, unitKey);
  const total = params.arms.reduce((acc, a) => acc + a.weight, 0);
  let cum = 0;
  for (const arm of params.arms) {
    cum += arm.weight / total;
    if (u < cum) {
      return { armId: arm.armId, unitKey };
    }
  }
  return { armId: params.arms[params.arms.length - 1].armId, unitKey };
}

export function hashExpressionSpec(spec: DeliveryExpressionSpec): string {
  return sha256Hex(canonicalJson(spec));
}
