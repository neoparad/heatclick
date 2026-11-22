/**
 * Compiler-grade Closed Grammar Validator & Privacy Non-Relaxation Checker
 *
 * Enforces §10.1 Red-Team Gates 1 & 2, §6.5 Affiliate Param Table, and DEL App. A:
 * - Zero script execution paths in host customer origin (`no_online_script_path`)
 * - Closed element/attribute/style allow-lists (no `script`, `iframe`, `style`, `on*`,
 *   `javascript:`, `data:`, `url()`, `position: fixed`, `z-index`, `eval`)
 * - Protected regions untouchable by Hide/Move/SetStyle
 * - Legally required disclosures never delivered as runtime-only actions
 * - Affiliate click parameters restricted strictly to the OFFLINE-SIGNED manifest allow-list
 * - Online config cannot relax consent/privacy/protection without verified passkey signature
 */

import { CONSENT_MODE_RANK, type ConsentMode } from '../../packages/contract/schema';
import type {
  AffiliateSlotBinding,
  ClosedGrammarAction,
  ClosedGrammarOp,
  ConfigBundlePayload,
  OfflineAffiliateParamRule,
} from './types';

export const ALLOWED_INSERTABLE_TAGS: ReadonlySet<string> = new Set([
  'div', 'section', 'p', 'span', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'a', 'img', 'picture', 'source',
  'figure', 'figcaption', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins',
  'small', 'sup', 'sub', 'mark', 'abbr', 'cite', 'q', 'blockquote',
  'time', 'br', 'hr', 'wbr', 'table', 'caption', 'thead', 'tbody', 'tfoot',
  'tr', 'th', 'td', 'details', 'summary', 'button',
]);

export const FORBIDDEN_HOST_TAGS: ReadonlySet<string> = new Set([
  'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'style',
  'svg', 'math', 'template', 'form', 'input', 'select', 'textarea', 'audio', 'video',
]);

export const ALLOWED_SET_ATTR_NAMES: ReadonlySet<string> = new Set([
  'alt', 'title', 'aria-label', 'aria-describedby', 'role',
  'width', 'height', 'loading', 'decoding', 'placeholder', 'lang', 'dir', 'href',
]);

export const ALLOWED_INSERT_ATTR_NAMES: ReadonlySet<string> = new Set([
  ...ALLOWED_SET_ATTR_NAMES,
  'src',
  'id',
  'class',
  'data-ugk-slot',
]);

export const ALLOWED_STYLE_PROPERTIES: ReadonlySet<string> = new Set([
  'color', 'background-color', 'border-color', 'border-top-color', 'border-right-color',
  'border-bottom-color', 'border-left-color', 'outline-color', 'text-decoration-color',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'gap', 'row-gap', 'column-gap', 'width', 'min-width', 'max-width',
  'min-height', 'max-height', 'aspect-ratio',
  'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
  'text-align', 'text-decoration-line', 'text-transform', 'white-space',
  'word-break', 'overflow-wrap', 'text-indent', 'font-family',
  'border-width', 'border-style', 'border-radius', 'box-shadow', 'outline-width', 'outline-style',
  'display', 'flex', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-self',
  'grid-template-columns', 'float', 'clear', 'vertical-align', 'overflow', 'object-fit',
  'list-style-type', 'position', 'opacity', 'cursor', 'transition', 'transform',
]);

const FORBIDDEN_URL_SCHEME_RE = /^\s*(?:javascript|data|blob|vbscript)\s*:/i;
const FORBIDDEN_CSS_VALUE_RE = /(?:url\s*\(|expression\s*\(|@import|@font-face|var\s*\(\s*(?!\-\-ugk\-))/i;
const FORBIDDEN_POSITION_RE = /^\s*(?:fixed|sticky|absolute)\s*$/i;
const MARKUP_OR_SCRIPT_RE = /<\s*(?:script|iframe|style|svg|object|embed)\b|on[a-z]+\s*=/i;
const AFFILIATE_HOST_RE =
  /\b(?:a8\.net|afb\.jp|valuecommerce\.com|accesstrade\.net|felmat\.net|moshimo\.com|linksynergy\.com|janet\.jp|amzn\.to|amzn\.asia|assoc-amazon\.com|amazon\.(?:co\.jp|com|jp)|hb\.afl\.rakuten\.co\.jp)\b/i;
const AFFILIATE_PARAM_RE =
  /(?:[?&]|^)(?:a8mat|a8ejpredirect|afb|vc_sid|vc_ptn|tag|linkcode|moshimo|aff_id|affiliate_id|clickref)\s*=/i;
const EXTERNAL_HOST_URL_RE = /^\s*(?:https?:)?\/\/([^/?#\s]+)/i;
const FORBIDDEN_PROTO_ATTR_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function inspectDestinationOrResourceAttr(
  attrName: string,
  attrValue: string,
  path: string,
  errors: string[],
  forbidExternalHost: boolean
): void {
  if (FORBIDDEN_URL_SCHEME_RE.test(attrValue)) {
    errors.push(`${path}: ${attrName} uses forbidden URL scheme`);
  }
  if (AFFILIATE_HOST_RE.test(attrValue) || AFFILIATE_PARAM_RE.test(attrValue)) {
    errors.push(`${path}: ${attrName} cannot mutate or inject affiliate destinations/params (SSOT A-15)`);
  }
  if (forbidExternalHost) {
    const hostMatch = EXTERNAL_HOST_URL_RE.exec(attrValue);
    if (hostMatch) {
      errors.push(
        `${path}: ${attrName} cannot inject external outbound host "${hostMatch[1]}" via closed host grammar`
      );
    }
  }
}

export interface GrammarValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

function validateStyleProps(
  props: Readonly<Record<string, string>>,
  path: string,
  errors: string[]
): void {
  for (const [rawProp, rawVal] of Object.entries(props)) {
    const prop = rawProp.trim().toLowerCase();
    if (!ALLOWED_STYLE_PROPERTIES.has(prop)) {
      errors.push(`${path}: style property "${prop}" is not in DEL App. A.3 allow-list`);
      continue;
    }
    if (FORBIDDEN_CSS_VALUE_RE.test(rawVal)) {
      errors.push(`${path}.${prop}: forbidden CSS value token (url/expression/@import/non-ugk var)`);
    }
    if (prop === 'position' && FORBIDDEN_POSITION_RE.test(rawVal)) {
      errors.push(`${path}.position: "${rawVal}" is forbidden in host A2 styles (only static/relative)`);
    }
  }
}

function validateSingleOp(
  op: ClosedGrammarOp,
  protectedRegions: ReadonlySet<string>,
  path: string,
  errors: string[]
): void {
  // Floor check: protected regions cannot be hidden, moved, or restyled (§10.1 / DEL App. A.6)
  if (
    op.target_region_tag &&
    protectedRegions.has(op.target_region_tag) &&
    (op.op === 'Hide' || op.op === 'Move' || op.op === 'SetStyle')
  ) {
    errors.push(
      `${path}: op "${op.op}" cannot target protected region "${op.target_region_tag}"`
    );
  }
  if (
    protectedRegions.has(op.anchor_id) &&
    (op.op === 'Hide' || op.op === 'Move' || op.op === 'SetStyle')
  ) {
    errors.push(`${path}: op "${op.op}" cannot target protected anchor "${op.anchor_id}"`);
  }

  switch (op.op) {
    case 'SetText': {
      if (typeof op.text !== 'string') {
        errors.push(`${path}: SetText requires string text`);
      } else if (MARKUP_OR_SCRIPT_RE.test(op.text)) {
        errors.push(`${path}: SetText payload must not contain executable markup or inline handlers`);
      }
      break;
    }
    case 'SetAttr': {
      const attr = (op.attr_name ?? '').trim().toLowerCase();
      if (
        !attr ||
        FORBIDDEN_PROTO_ATTR_KEYS.has(attr) ||
        attr.startsWith('on') ||
        attr === 'style' ||
        attr === 'srcdoc'
      ) {
        errors.push(`${path}: SetAttr attribute "${attr}" is strictly forbidden`);
      } else if (!ALLOWED_SET_ATTR_NAMES.has(attr)) {
        errors.push(`${path}: SetAttr attribute "${attr}" is outside DEL App. A.2 allow-list`);
      }
      if (typeof op.attr_value === 'string') {
        inspectDestinationOrResourceAttr(
          `SetAttr.${attr}`,
          op.attr_value,
          path,
          errors,
          attr === 'href'
        );
      } else {
        errors.push(`${path}: SetAttr requires a string attr_value`);
      }
      break;
    }
    case 'SetStyle': {
      if (!op.style_props) {
        errors.push(`${path}: SetStyle requires style_props`);
      } else {
        validateStyleProps(op.style_props, `${path}.style_props`, errors);
      }
      break;
    }
    case 'AddClass': {
      if (!op.class_name || !op.class_name.startsWith('ugk-')) {
        errors.push(`${path}: AddClass class_name must use the "ugk-" prefix`);
      }
      break;
    }
    case 'InsertNode': {
      const tag = (op.insert_tag ?? '').trim().toLowerCase();
      if (FORBIDDEN_HOST_TAGS.has(tag) || !ALLOWED_INSERTABLE_TAGS.has(tag)) {
        errors.push(`${path}: InsertNode tag "${tag}" is forbidden in host customer origin`);
      }
      if (op.insert_attrs !== undefined) {
        if (op.insert_attrs === null || typeof op.insert_attrs !== 'object' || Array.isArray(op.insert_attrs)) {
          errors.push(`${path}: InsertNode insert_attrs must be a flat string dictionary`);
        } else {
          for (const rawKey of Object.getOwnPropertyNames(op.insert_attrs)) {
            if (!Object.prototype.hasOwnProperty.call(op.insert_attrs, rawKey)) continue;
            const v = (op.insert_attrs as Record<string, unknown>)[rawKey];
            const lk = rawKey.trim().toLowerCase();
            if (
              !lk ||
              FORBIDDEN_PROTO_ATTR_KEYS.has(rawKey) ||
              FORBIDDEN_PROTO_ATTR_KEYS.has(lk) ||
              lk.startsWith('on') ||
              lk === 'style' ||
              lk === 'srcdoc'
            ) {
              errors.push(`${path}: InsertNode attribute "${lk}" is strictly forbidden`);
              continue;
            }
            if (!ALLOWED_INSERT_ATTR_NAMES.has(lk)) {
              errors.push(`${path}: InsertNode attribute "${lk}" is outside closed allow-list`);
              continue;
            }
            if (typeof v !== 'string') {
              errors.push(`${path}: InsertNode attribute "${lk}" must be a primitive string (nested objects forbidden)`);
              continue;
            }
            if (lk === 'class') {
              const tokens = v.trim().split(/\s+/).filter(Boolean);
              if (tokens.some((tok) => !tok.startsWith('ugk-'))) {
                errors.push(`${path}: InsertNode class tokens must use the "ugk-" prefix`);
              }
            }
            inspectDestinationOrResourceAttr(
              `InsertNode.${lk}`,
              v,
              path,
              errors,
              tag === 'a' || lk === 'href' || lk === 'src'
            );
          }
        }
      }
      if (typeof op.text === 'string' && MARKUP_OR_SCRIPT_RE.test(op.text)) {
        errors.push(`${path}: InsertNode text must not contain executable markup or inline handlers`);
      }
      break;
    }
    case 'ReplaceImage': {
      if (!op.image_src || FORBIDDEN_URL_SCHEME_RE.test(op.image_src)) {
        errors.push(`${path}: ReplaceImage requires a safe allow-listed image_src`);
      } else {
        inspectDestinationOrResourceAttr('ReplaceImage.image_src', op.image_src, path, errors, false);
      }
      if (!op.image_alt || !op.image_width || !op.image_height) {
        errors.push(`${path}: ReplaceImage requires alt, explicit width, and explicit height`);
      }
      break;
    }
    case 'Hide':
    case 'Move':
    case 'Mount':
      break;
  }
}

export function validateClosedGrammarAction(
  action: ClosedGrammarAction,
  protectedRegions: readonly string[]
): GrammarValidationResult {
  const errors: string[] = [];
  const protectedSet = new Set([
    ...protectedRegions,
    'password',
    'payment',
    'advertising_disclosure',
    'consent_banner',
    'legal_notice',
  ]);

  // §10.1: Legally required disclosures MUST NOT depend on runtime-only delivery
  if (action.is_legally_required_disclosure) {
    errors.push(
      `action "${action.action_id}": legally required disclosure must live in origin content, never runtime-only (§10.1)`
    );
  }

  // Only closed host rungs allowed in host bundle
  if (!(['A0', 'A1', 'A1c', 'A2'] as const).includes(action.rung)) {
    errors.push(
      `action "${action.action_id}": rung "${String(action.rung)}" is not permitted in host config bundle`
    );
  }

  for (let i = 0; i < action.ops.length; i++) {
    validateSingleOp(action.ops[i], protectedSet, `action.${action.action_id}.ops[${i}]`, errors);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * §6.5 / A-15R: Validates that every online affiliate slot binding uses ONLY
 * a parameter name explicitly allow-listed in the OFFLINE-SIGNED release manifest.
 */
export function validateAffiliateBindingsAgainstOfflineAllowlist(
  bindings: readonly AffiliateSlotBinding[],
  offlineAllowlist: readonly OfflineAffiliateParamRule[]
): GrammarValidationResult {
  const errors: string[] = [];
  const allowMap = new Map<string, ReadonlySet<string>>();
  for (const rule of offlineAllowlist) {
    allowMap.set(rule.network_id, new Set(rule.allowed_params));
  }

  for (let i = 0; i < bindings.length; i++) {
    const b = bindings[i];
    const allowedParams = allowMap.get(b.network_id);
    if (!allowedParams) {
      errors.push(
        `deliver.affiliate_slot_bindings[${i}]: network "${b.network_id}" is not registered in offline-signed affiliate_param_allowlist`
      );
      continue;
    }
    if (!allowedParams.has(b.param_name)) {
      errors.push(
        `deliver.affiliate_slot_bindings[${i}]: param "${b.param_name}" is not in offline-signed allowlist for network "${b.network_id}"`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

export interface PrivacyRelaxationCheck {
  readonly isRelaxation: boolean;
  readonly reasons: readonly string[];
}

/**
 * §10.1: Detects whether `next` relaxes ANY privacy/protection control relative
 * to `prev` (consent mode raised, protected/private region removed, user_input param
 * loosened to content/noise, or new sensitive purpose added).
 * Any relaxation MUST carry a passkey signature verified against the offline manifest!
 */
export function detectPrivacyRelaxation(
  prev: ConfigBundlePayload['measure'],
  next: ConfigBundlePayload['measure']
): PrivacyRelaxationCheck {
  const reasons: string[] = [];

  if (CONSENT_MODE_RANK[next.site_default_consent] > CONSENT_MODE_RANK[prev.site_default_consent]) {
    reasons.push(
      `site_default_consent relaxed from "${prev.site_default_consent}" to "${next.site_default_consent}"`
    );
  }

  if (
    prev.allow_cmp_opt_in_from_default_off !== true &&
    next.allow_cmp_opt_in_from_default_off === true
  ) {
    reasons.push('allow_cmp_opt_in_from_default_off enabled');
  }

  const nextProtected = new Set(next.protected_regions);
  for (const reg of prev.protected_regions) {
    if (!nextProtected.has(reg)) {
      reasons.push(`protected_region "${reg}" removed`);
    }
  }

  const nextPrivate = new Set(next.private_regions);
  for (const reg of prev.private_regions) {
    if (!nextPrivate.has(reg)) {
      reasons.push(`private_region "${reg}" removed`);
    }
  }

  const prevPurposes = new Set(prev.allowed_purposes);
  for (const p of next.allowed_purposes) {
    if (!prevPurposes.has(p)) {
      reasons.push(`purpose "${p}" newly enabled`);
    }
  }

  for (const [param, prevCls] of Object.entries(prev.param_classes)) {
    const nextCls = next.param_classes[param];
    if (prevCls === 'user_input' && nextCls !== 'user_input') {
      reasons.push(`param "${param}" loosened from user_input to "${String(nextCls)}"`);
    }
  }

  return {
    isRelaxation: reasons.length > 0,
    reasons,
  };
}

/**
 * §4.2 & §4.5: Effective consent mode resolution when CMP has not answered.
 * Always picks the STRICTEST among signed site default, origin-declared region mode,
 * and online loader-data region cap — online data can NEVER raise consent above
 * site default or origin declaration!
 */
export function resolveEffectiveConsentMode(params: {
  readonly siteDefault: ConsentMode;
  readonly originDeclared?: ConsentMode;
  readonly loaderDataCap?: ConsentMode;
  readonly cmpResolved?: ConsentMode | 'unknown';
  readonly allowCmpOptInFromDefaultOff?: boolean;
  readonly minorsFlag?: boolean;
  readonly disclosureVerified: boolean;
  readonly subjectToJpExternalTransmissionRule?: boolean;
}): ConsentMode {
  if (params.cmpResolved === 'unknown') {
    return 'off';
  }

  // Hard site kill/off: CMP must NEVER escalate above 'off' unless signed bundle explicitly permits it (H-09)
  if (params.siteDefault === 'off' && params.allowCmpOptInFromDefaultOff !== true) {
    return 'off';
  }

  // Online loader emergency tightening to 'off' cannot be overridden by CMP
  if (params.loaderDataCap === 'off') {
    return 'off';
  }

  // Start with strictest of site default, origin declaration, and loader data cap
  const candidates: ConsentMode[] = [params.siteDefault];
  if (params.originDeclared !== undefined) {
    candidates.push(params.originDeclared);
  }
  if (params.loaderDataCap !== undefined) {
    candidates.push(params.loaderDataCap);
  }

  let effective: ConsentMode = candidates.reduce((strictest, current) =>
    CONSENT_MODE_RANK[current] < CONSENT_MODE_RANK[strictest] ? current : strictest
  );

  // Explicit CMP consent overrides region ladder (when siteDefault !== 'off' or allowCmpOptInFromDefaultOff === true),
  // EXCEPT minors & missing disclosure ceilings
  if (params.cmpResolved !== undefined) {
    effective = params.cmpResolved;
  }

  // Minors site caps unconditionally at cookieless (§4.5)
  if (params.minorsFlag && CONSENT_MODE_RANK[effective] > CONSENT_MODE_RANK.cookieless) {
    effective = 'cookieless';
  }

  // Missing disclosure record blocks collection (off for JP external transmission subject sites, else cookieless cap)
  if (!params.disclosureVerified) {
    const cap: ConsentMode = params.subjectToJpExternalTransmissionRule ? 'off' : 'cookieless';
    if (CONSENT_MODE_RANK[effective] > CONSENT_MODE_RANK[cap]) {
      effective = cap;
    }
  }

  return effective;
}
