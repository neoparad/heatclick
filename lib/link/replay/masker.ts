/**
 * UGOKI LINK v2 — Pre-Transmission Client-Side Replay Masking Engine (§11.11 item 8)
 *
 * Runs strictly BEFORE serialization/transmission in the browser or mobile client:
 *   - Default policy = MASK ALL:
 *       * All text nodes replaced with uniform width-bucketed block fills (no characters, no exact length leak)
 *       * All `<input>`, `<textarea>`, `<select>`, `[contenteditable]` values & placeholders stripped
 *       * All images & videos replaced with bounding rectangles ONLY (src/srcset/poster/alt/title removed)
 *       * All URLs, hrefs, query strings, data-* attributes, and inline CSS url()/content:/--vars sanitized
 *       * Input-reactive DOM nodes (`inputBound`) forced masked even inside allowlists
 *   - Approved allowlist (`MaskAllowlistConfig`):
 *       * Only explicitly approved non-sensitive container IDs/selectors reveal static text
 *       * HARD FLOOR (UNBREAKABLE): inputs, passwords, payment fields, `data-ugk-sensitive`,
 *         `aria-sensitive`, and sensitive field names can NEVER be unmasked even if inside an allowlist!
 *   - Unreproducible regions (`canvas`, `cross_origin_iframe`, `closed_shadow_dom`, `video`)
 *     are recorded strictly as bounding boxes and enumerated in `unreproducibleRegions[]`.
 */

import { canonicalJson, sha256Hex } from '@/packages/contract/response';

export type ReplayDomNodeKind =
  | 'element'
  | 'text'
  | 'input'
  | 'media'
  | 'canvas'
  | 'cross_origin_iframe'
  | 'closed_shadow_dom';

export interface ReplayRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RawReplayDomNode {
  readonly nodeId: string;
  readonly kind: ReplayDomNodeKind;
  readonly tagName: string;
  readonly selectorPath?: string;
  readonly allowlistKey?: string;
  readonly rect: ReplayRect;
  readonly textContent?: string;
  readonly inputValue?: string;
  readonly inputType?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly inlineStyle?: string;
  /** True when this node mirrors or reacts dynamically to user form input. */
  readonly inputReactive?: boolean;
  readonly children?: ReadonlyArray<RawReplayDomNode>;
}

export interface MaskAllowlistConfig {
  readonly maskConfigVersion: string;
  readonly approvalId: string | null;
  /** Approved container `allowlistKey` values permitted to reveal non-sensitive static text. */
  readonly allowedKeys: ReadonlyArray<string>;
}

export const DEFAULT_MASK_ALL_CONFIG: MaskAllowlistConfig = Object.freeze({
  maskConfigVersion: 'mask-all-v1',
  approvalId: null,
  allowedKeys: [],
});

export interface MaskedReplayNode {
  readonly nodeId: string;
  readonly kind: ReplayDomNodeKind;
  readonly tagName: string;
  readonly rect: ReplayRect;
  readonly masked: boolean;
  readonly textBlock?: string;
  readonly safeAttributes: Readonly<Record<string, string>>;
  readonly safeStyle?: string;
  readonly boxOnlyPlaceholder?: 'media' | 'canvas' | 'cross_origin_iframe' | 'closed_shadow_dom';
  readonly children: ReadonlyArray<MaskedReplayNode>;
}

export interface UnreproducibleRegion {
  readonly nodeId: string;
  readonly kind: 'canvas' | 'cross_origin_iframe' | 'closed_shadow_dom' | 'video';
  readonly rect: ReplayRect;
  readonly disclosureNote: string;
}

export interface MaskedReplaySnapshot {
  readonly maskConfigVersion: string;
  readonly root: MaskedReplayNode;
  readonly unreproducibleRegions: ReadonlyArray<UnreproducibleRegion>;
  readonly maskedStateSha256: string;
  readonly detectedSensitiveFieldOnPage: boolean;
}

const INPUT_TAGS = new Set(['input', 'textarea', 'select', 'option']);
const MEDIA_TAGS = new Set(['img', 'picture', 'source', 'video', 'audio', 'object', 'embed']);

const SENSITIVE_NAME_RE =
  /(pass|pwd|secret|token|card|cc-|cc_|cvv|cvc|csc|expir|iban|ssn|mynumber|bank|credit|billing|payment|pin|otp|2fa|auth|email|mail|tel|phone|address|birth|dob|name)/i;

const SAFE_STRUCTURAL_ATTRS = new Set(['role', 'dir', 'lang', 'data-ugk-sec']);

const SAFE_CSS_PROPS = new Set([
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'flex',
  'flex-direction',
  'align-items',
  'justify-content',
  'grid-template-columns',
  'gap',
  'color',
  'background-color',
  'border',
  'border-radius',
  'font-size',
  'font-weight',
  'line-height',
  'text-align',
  'opacity',
  'visibility',
  'z-index',
  'overflow',
]);

/**
 * Quantizes text length into coarse buckets so even masked block width cannot leak exact character count.
 */
function maskTextToUniformBlock(rawText: string): string {
  const len = rawText.trim().length;
  if (len === 0) return '';
  const bucket = len <= 8 ? 8 : len <= 24 ? 16 : len <= 64 ? 32 : 48;
  return '█'.repeat(bucket);
}

/**
 * Strips any CSS declaration that is not in the safe layout/color allowlist
 * or contains `url(...)`, `content`, `var(--`, quotes, or `expression(`.
 */
function sanitizeInlineStyle(rawStyle?: string): string | undefined {
  if (!rawStyle) return undefined;
  const kept: string[] = [];
  for (const decl of rawStyle.split(';')) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx <= 0) continue;
    const prop = decl.slice(0, colonIdx).trim().toLowerCase();
    const val = decl.slice(colonIdx + 1).trim();
    if (!SAFE_CSS_PROPS.has(prop)) continue;
    if (/url\s*\(|var\s*\(|expression\s*\(|["']|@import|javascript:/i.test(val)) continue;
    if (!/^[a-zA-Z0-9#.,%()_/\s-]+$/.test(val)) continue;
    kept.push(`${prop}:${val}`);
  }
  return kept.length > 0 ? kept.join(';') : undefined;
}

function isHardSensitiveNode(node: RawReplayDomNode): boolean {
  const tag = node.tagName.toLowerCase();
  if (node.kind === 'input' || INPUT_TAGS.has(tag)) return true;

  const inputType = (node.inputType ?? node.attributes?.type ?? '').toLowerCase();
  if (inputType === 'password' || inputType === 'hidden' || inputType === 'email' || inputType === 'tel') {
    return true;
  }

  const attrs = node.attributes ?? {};
  if (
    attrs['contenteditable'] !== undefined ||
    attrs['data-ugk-sensitive'] !== undefined ||
    attrs['aria-sensitive'] === 'true' ||
    attrs['data-private'] !== undefined
  ) {
    return true;
  }

  for (const key of ['name', 'id', 'autocomplete', 'class', 'data-testid']) {
    const v = attrs[key];
    if (v && SENSITIVE_NAME_RE.test(v)) {
      return true;
    }
  }

  return false;
}

function isPaymentOrPasswordNode(node: RawReplayDomNode): boolean {
  const inputType = (node.inputType ?? node.attributes?.type ?? '').toLowerCase();
  if (inputType === 'password') return true;
  const attrs = node.attributes ?? {};
  if (attrs['data-ugk-sensitive'] !== undefined || attrs['aria-sensitive'] === 'true') {
    return true;
  }
  for (const key of ['name', 'id', 'autocomplete']) {
    const v = attrs[key];
    if (v && /(pass|pwd|card|cc-|cvv|cvc|csc|iban|payment|billing)/i.test(v)) {
      return true;
    }
  }
  return false;
}

function sanitizeAttributes(attrs?: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (!attrs) return {};
  const out: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(attrs)) {
    const key = rawKey.trim().toLowerCase();
    // Only keep explicit safe structural attributes; drop href, src, alt, title, value, data-*, aria-label, on*, etc.
    if (!SAFE_STRUCTURAL_ATTRS.has(key)) continue;
    if (/^[a-zA-Z0-9_-]{1,64}$/.test(rawVal)) {
      out[key] = rawVal;
    }
  }
  return out;
}

export function maskReplayDomTree(
  rawRoot: RawReplayDomNode,
  config: MaskAllowlistConfig = DEFAULT_MASK_ALL_CONFIG
): MaskedReplaySnapshot {
  const allowedSet =
    config.approvalId !== null ? new Set(config.allowedKeys) : new Set<string>();
  const unreproducibleRegions: UnreproducibleRegion[] = [];
  let detectedSensitiveFieldOnPage = false;

  const walk = (node: RawReplayDomNode, inheritedAllowlisted: boolean, inheritedForcedMask: boolean): MaskedReplayNode => {
    const tag = node.tagName.toLowerCase();
    if (isPaymentOrPasswordNode(node)) {
      detectedSensitiveFieldOnPage = true;
    }

    const hardSensitive = isHardSensitiveNode(node) || Boolean(node.inputReactive);
    const forcedMask = inheritedForcedMask || hardSensitive;
    const isAllowlisted =
      !forcedMask &&
      (inheritedAllowlisted || (node.allowlistKey !== undefined && allowedSet.has(node.allowlistKey)));

    // Unreproducible regions -> bounding rectangle ONLY, zero internal content/children
    if (
      node.kind === 'canvas' ||
      tag === 'canvas' ||
      node.kind === 'cross_origin_iframe' ||
      tag === 'iframe' ||
      node.kind === 'closed_shadow_dom'
    ) {
      const regionKind: UnreproducibleRegion['kind'] =
        node.kind === 'canvas' || tag === 'canvas'
          ? 'canvas'
          : node.kind === 'closed_shadow_dom'
            ? 'closed_shadow_dom'
            : 'cross_origin_iframe';

      unreproducibleRegions.push({
        nodeId: node.nodeId,
        kind: regionKind,
        rect: node.rect,
        disclosureNote:
          regionKind === 'canvas'
            ? 'Canvas bitmap content is not reproducible in Tier-3 replay'
            : regionKind === 'closed_shadow_dom'
              ? 'Closed Shadow DOM subtree is not accessible or reproducible'
              : 'Cross-origin iframe content cannot be recorded under Same-Origin Policy',
      });

      return {
        nodeId: node.nodeId,
        kind: regionKind === 'canvas' ? 'canvas' : regionKind === 'closed_shadow_dom' ? 'closed_shadow_dom' : 'cross_origin_iframe',
        tagName: tag,
        rect: node.rect,
        masked: true,
        safeAttributes: {},
        boxOnlyPlaceholder: regionKind,
        children: [],
      };
    }

    // Images & videos -> bounding box ONLY (`src`, `alt`, `poster` completely dropped!)
    if (node.kind === 'media' || MEDIA_TAGS.has(tag)) {
      if (tag === 'video') {
        unreproducibleRegions.push({
          nodeId: node.nodeId,
          kind: 'video',
          rect: node.rect,
          disclosureNote: 'Video media stream is not recorded; frame placeholder shown only',
        });
      }
      return {
        nodeId: node.nodeId,
        kind: 'media',
        tagName: tag,
        rect: node.rect,
        masked: true,
        safeAttributes: {},
        boxOnlyPlaceholder: 'media',
        children: [],
      };
    }

    // Input / form elements -> ALWAYS masked regardless of allowlist (HARD FLOOR!)
    if (node.kind === 'input' || INPUT_TAGS.has(tag)) {
      return {
        nodeId: node.nodeId,
        kind: 'input',
        tagName: tag,
        rect: node.rect,
        masked: true,
        textBlock: '[REDACTED_INPUT]',
        safeAttributes: sanitizeAttributes(node.attributes),
        safeStyle: sanitizeInlineStyle(node.inlineStyle),
        children: [],
      };
    }

    // Text node
    if (node.kind === 'text') {
      const raw = node.textContent ?? '';
      return {
        nodeId: node.nodeId,
        kind: 'text',
        tagName: '#text',
        rect: node.rect,
        masked: !isAllowlisted,
        textBlock: isAllowlisted ? raw : maskTextToUniformBlock(raw),
        safeAttributes: {},
        children: [],
      };
    }

    // Standard element container
    const children = (node.children ?? []).map((child) => walk(child, isAllowlisted, forcedMask));
    const directText =
      node.textContent !== undefined
        ? isAllowlisted
          ? node.textContent
          : maskTextToUniformBlock(node.textContent)
        : undefined;

    return {
      nodeId: node.nodeId,
      kind: 'element',
      tagName: tag,
      rect: node.rect,
      masked: !isAllowlisted,
      ...(directText !== undefined ? { textBlock: directText } : {}),
      safeAttributes: sanitizeAttributes(node.attributes),
      safeStyle: sanitizeInlineStyle(node.inlineStyle),
      children,
    };
  };

  const root = walk(rawRoot, false, false);
  const maskedStateSha256 = sha256Hex(canonicalJson(root));

  return {
    maskConfigVersion: config.maskConfigVersion,
    root,
    unreproducibleRegions,
    maskedStateSha256,
    detectedSensitiveFieldOnPage,
  };
}
